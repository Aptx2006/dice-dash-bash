import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGame, playBlinkTool, playDirectionTool, resolveMoveCard } from '../src/game/engine.ts'
import { inspectTacticalAction } from '../src/game/tactical.ts'
import type { Dir } from '../src/game/types.ts'

function fixture() {
  const state = createGame({ mapId: 'tutorial', players: [
    { name: '小骰', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
    { name: '对手', isAI: true, characterId: 'robot', pieceColor: '#5f8d95', isHost: false },
  ], mechanisms: { airdrop: false, turnTimer: false } })
  state.phase = 'action'
  state.players[1]!.cell = { x: 6, y: 5 }
  state.players[0]!.hand = [{ uid: 90001, toolId: 'move', points: 3 }, { uid: 90002, toolId: 'punch' }, { uid: 90003, toolId: 'blink' }]
  return state
}

test('实际移动和未命中攻击留下可复查的方向/位置，重复消费不生成伪行动', () => {
  const state = fixture(), before = JSON.stringify(state)
  assert.ok(inspectTacticalAction(state, 'human', 'move:90001:right'))
  assert.equal(JSON.stringify(state), before, '推演不能写入真实行动记录')
  resolveMoveCard(state, 'right', undefined, 90001)
  assert.match(state.logs[0]!.text, /小骰.*移动.*向右.*\(0,6\).*\(3,6\)/)
  const moved = JSON.stringify(state)
  resolveMoveCard(state, 'right', undefined, 90001)
  assert.equal(JSON.stringify(state), moved)
  playDirectionTool(state, 90002, 'right')
  assert.ok(!state.players[0]!.hand.some(card => card.uid === 90002))
  assert.ok(state.logs.some(entry => /小骰.*拳击.*向右/.test(entry.text)))
  const attacked = JSON.stringify(state)
  playDirectionTool(state, 90002, 'right')
  assert.equal(JSON.stringify(state), attacked)
})

test('非法方向和非法落点保持牌、棋盘和公开记录原样', () => {
  const state = fixture(), before = JSON.stringify(state)
  resolveMoveCard(state, 'north' as Dir)
  playDirectionTool(state, 90002, 'north' as Dir)
  playBlinkTool(state, 90003, { x: 6, y: 0 })
  assert.equal(JSON.stringify(state), before)
})
