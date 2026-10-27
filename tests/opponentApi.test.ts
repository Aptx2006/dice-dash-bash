import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createCoachServer } from '../server/index.ts'
import { createGame } from '../src/game/engine.ts'
import { createTacticalSnapshot } from '../src/game/tactical.ts'
import type { OpponentDecision } from '../src/agent/opponentTypes.ts'

function input() {
  const state = createGame({ mapId: 'tutorial', aiMode: 'cloud', players: [
    { name: '不发送的真人名', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
    { name: '机器人', isAI: true, characterId: 'robot', pieceColor: '#5f8d95', isHost: false },
  ], mechanisms: { airdrop: false, turnTimer: false } })
  state.activeIndex = 1
  state.phase = 'action'
  state.players[1].hand = [{ uid: 80001, toolId: 'move', points: 3 }]
  return { snapshot: createTacticalSnapshot(state, 'ai-1'), playerId: 'ai-1' }
}
const fallback: OpponentDecision = { runId: 'test-opponent', status: 'fallback', reason: '测试模型不可用', sourceIds: [], sources: [],
  steps: 0, elapsedMs: 0, model: 'synthetic', usage: null, events: [], fallbackReason: 'NOT_CONFIGURED' }

test('云端对手API接受当前AI匿名快照，保留降级状态且不直接执行', async () => {
  let calls = 0
  const server = createCoachServer({ opponentAgent: async (request, options) => {
    calls++
    assert.equal(request.playerId, 'ai-1')
    assert.equal(JSON.stringify(request.snapshot).includes('不发送的真人名'), false)
    assert.ok(options?.signal instanceof AbortSignal)
    return fallback
  } })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/api/agent/opponent`
  const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const task = input(), before = JSON.stringify(task)
    const response = await post(task)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).fallbackReason, 'NOT_CONFIGURED')
    assert.equal(JSON.stringify(task), before)
    assert.equal((await post({ ...task, playerId: 'human' })).status, 400)
    assert.equal((await post({ ...task, goal: '扩大预算' })).status, 400)
    assert.equal((await post({ ...task, maxSteps: 100 })).status, 400)
    assert.equal((await post({ ...task, snapshot: {} })).status, 400)
    assert.equal(calls, 1)
    const wrongRole = { ...task, snapshot: { ...task.snapshot, activeIndex: 0 } }
    assert.equal((await post(wrongRole)).status, 400)
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
