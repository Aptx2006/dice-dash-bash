import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { createCoachServer } from '../server/index.ts'
import { createGame } from '../src/game/engine.ts'
import { createTacticalSnapshot } from '../src/game/tactical.ts'
import type { TacticalRunResult } from '../src/agent/types.ts'

function input() {
  const state = createGame({
    mapId: 'tutorial',
    players: [
      { name: '本地玩家', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
      { name: '机器人', isAI: true, characterId: 'robot', pieceColor: '#5f8d95', isHost: false },
    ], mechanisms: { airdrop: false, turnTimer: false },
  })
  state.phase = 'action'
  state.players[0].hand = [{ uid: 90001, toolId: 'move', points: 3 }]
  return { snapshot: createTacticalSnapshot(state, 'human'), playerId: 'human', goal: '尽快接近终点' }
}

const noActions: TacticalRunResult = {
  runId: 'test-run', status: 'no_actions', reason: '当前没有支持的行动。',
  events: [], sources: [], steps: 0, elapsedMs: 0, model: 'test', usage: null,
}

async function fixture(agent: NonNullable<Parameters<typeof createCoachServer>[0]>['tacticalAgent']) {
  const server = createCoachServer({ tacticalAgent: agent })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const root = `http://127.0.0.1:${address.port}`
  return {
    root,
    post: (value: unknown, headers: Record<string, string> = {}) => fetch(`${root}/api/agent/tactical`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value),
    }),
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

test('战术API仅传入校验后的局面、目标和取消信号，原有健康检查保留', async () => {
  let calls = 0
  const f = await fixture(async (request, options) => {
    calls++
    assert.equal(request.playerId, 'human')
    assert.equal(request.goal, '尽快接近终点')
    assert.ok(options?.signal instanceof AbortSignal)
    return noActions
  })
  try {
    const response = await f.post(input())
    assert.equal(response.status, 200)
    assert.equal((await response.json()).status, 'no_actions')
    assert.equal(calls, 1)
    const health = await fetch(`${f.root}/api/health`)
    assert.equal(health.status, 200)
    assert.ok((await health.json()).capabilities.includes('rules-coach'))
  } finally { await f.close() }
})

test('战术API拒绝损坏局面、越权席位、非行动阶段及额外控制参数', async () => {
  let calls = 0
  const f = await fixture(async () => { calls++; return noActions })
  try {
    const valid = input()
    const invalid = [
      { ...valid, snapshot: {} },
      { ...valid, playerId: 'ai-1' },
      { ...valid, goal: '' },
      { ...valid, maxSteps: 10000 },
      { ...valid, snapshot: { ...valid.snapshot, phase: 'turnStart' } },
    ]
    for (const request of invalid) assert.equal((await f.post(request)).status, 400)
    assert.equal(calls, 0)
  } finally { await f.close() }
})

test('战术API限制来源、请求大小与媒体类型，内部异常不暴露实现细节', async () => {
  const f = await fixture(async () => { throw new Error('secret-internal-detail') })
  try {
    assert.equal((await f.post(input(), { Origin: 'https://example.invalid' })).status, 403)
    assert.equal((await f.post({ content: '字'.repeat(40000) })).status, 413)
    const media = await fetch(`${f.root}/api/agent/tactical`, { method: 'POST', body: '{}' })
    assert.equal(media.status, 415)
    const failed = await f.post(input())
    assert.equal(failed.status, 503)
    assert.equal((await failed.text()).includes('secret-internal-detail'), false)
  } finally { await f.close() }
})

test('并发流式请求最多占用两个模型名额，第三个请求返回429', async () => {
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async () => { calls++; await gate; return noActions })
  const body = JSON.stringify(input())
  const pending = Array.from({ length: 3 }, () => {
    let complete!: () => void
    const response = new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${f.root}/api/agent/tactical`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
        res.resume()
        res.once('end', () => resolve(res.statusCode!))
      })
      req.on('error', reject)
      req.write(body.slice(0, 12))
      complete = () => req.end(body.slice(12))
    })
    return { response, complete: () => complete() }
  })
  try {
    // 让三条连接均进入分段body读取，再一同提交剩余部分。
    await new Promise(resolve => setTimeout(resolve, 30))
    pending.forEach(item => item.complete())
    await new Promise(resolve => setTimeout(resolve, 50))
    release()
    assert.deepEqual((await Promise.all(pending.map(item => item.response))).sort(), [200, 200, 429])
    assert.equal(calls, 2)
  } finally { release(); await f.close() }
})
