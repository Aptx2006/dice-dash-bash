import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGame } from '../src/game/engine.ts'
import { listTacticalActions, tacticalSnapshotKey } from '../src/game/tactical.ts'
import { createTacticalConfirmation, resolveTacticalConfirmation } from '../src/game/tacticalConfirmation.ts'

function setup() {
  const state = createGame({
    mapId: 'tutorial', mechanisms: { airdrop: false, turnTimer: false },
    players: [
      { name: '玩家', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
      { name: '机器人', isAI: true, characterId: 'robot', pieceColor: '#5f8d95', isHost: false },
    ],
  })
  state.phase = 'action'
  state.players[0].hand = [{ uid: 90_001, toolId: 'move', points: 2 }, { uid: 90_002, toolId: 'sprint' }]
  const action = listTacticalActions(state, 'human').find(action => action.kind === 'sprint')!
  const key = tacticalSnapshotKey(state)
  const confirmation = createTacticalConfirmation(state, 'human', action.actionId, key, 61_000, 1_000)!
  assert.ok(confirmation)
  return { state, action, key, confirmation }
}

test('确认前不出牌；明确同意后执行一次，重复确认不能重复修改', () => {
  const { state, confirmation } = setup()
  assert.equal(state.players[0].hand.find(card => card.toolId === 'move')?.points, 2)
  const result = resolveTacticalConfirmation(confirmation, 'accept', state, 'human', true, 2_000)
  assert.equal(result.ok, true)
  assert.equal(result.status, 'applied')
  assert.equal(state.players[0].hand.find(card => card.toolId === 'move')?.points, 4)
  assert.equal(state.players[0].hand.some(card => card.toolId === 'sprint'), false)
  const applied = JSON.stringify(state)
  assert.equal(resolveTacticalConfirmation(confirmation, 'accept', state, 'human', true, 3_000).ok, false)
  assert.equal(JSON.stringify(state), applied)
})

test('拒绝建议不执行，拒绝后不能再同意', () => {
  const { state, confirmation } = setup()
  const before = JSON.stringify(state)
  assert.equal(resolveTacticalConfirmation(confirmation, 'reject', state, 'human', true, 2_000).status, 'rejected')
  assert.equal(resolveTacticalConfirmation(confirmation, 'accept', state, 'human', true, 3_000).ok, false)
  assert.equal(JSON.stringify(state), before)
})

test('到达60秒有效期边界即不执行', () => {
  const { state, confirmation } = setup()
  const before = JSON.stringify(state)
  const result = resolveTacticalConfirmation(confirmation, 'accept', state, 'human', true, 61_000)
  assert.equal(result.status, 'expired')
  assert.equal(result.ok, false)
  assert.equal(JSON.stringify(state), before)
})

test('局面变化后的建议不能执行，也不能部分消费手牌', () => {
  const { state, confirmation } = setup()
  state.players[0].cell = { x: 1, y: 6 }
  const changed = JSON.stringify(state)
  assert.equal(resolveTacticalConfirmation(confirmation, 'accept', state, 'human', true, 2_000).status, 'stale')
  assert.equal(JSON.stringify(state), changed)
})

test('失去交互权限或确认玩家身份不符时不执行', () => {
  for (const [playerId, canInteract] of [['human', false], ['ai-1', true]] as const) {
    const { state, confirmation } = setup()
    const before = JSON.stringify(state)
    assert.equal(resolveTacticalConfirmation(confirmation, 'accept', state, playerId, canInteract, 2_000).ok, false)
    assert.equal(JSON.stringify(state), before)
  }
})

test('创建确认时拒绝伪造行动、过期局面及无效期限，服务端期限最多收窄为60秒', () => {
  const { state, key, action } = setup()
  assert.equal(createTacticalConfirmation(state, 'human', 'invented', key, 61_000, 1_000), null)
  assert.equal(createTacticalConfirmation(state, 'human', action.actionId, `${key}stale`, 61_000, 1_000), null)
  assert.equal(createTacticalConfirmation(state, 'human', action.actionId, key, 1_000, 1_000), null)
  assert.equal(createTacticalConfirmation(state, 'human', action.actionId, key, Infinity, 1_000), null)
  assert.equal(createTacticalConfirmation(state, 'human', action.actionId, key, 500_000, 1_000)?.expiresAt, 61_000)
})
