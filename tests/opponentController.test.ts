import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpponentController, chooseFallbackAction } from '../src/agent/opponentController.ts'
import type { OpponentDecision } from '../src/agent/opponentTypes.ts'
import { createGame } from '../src/game/engine.ts'
import { listTacticalActions, tacticalSnapshotKey } from '../src/game/tactical.ts'
import { validateGameConfig } from '../src/game/configValidation.ts'
import { loadMatch, saveMatch, MATCH_STORAGE_KEY } from '../src/storage/savedMatch.ts'
import type { GameConfig, GameState } from '../src/game/types.ts'
import { reactive, watch } from 'vue'

function config(mode?: 'rules' | 'cloud'): GameConfig {
  return { mapId: 'tutorial', aiMode: mode, mechanisms: { airdrop: false, turnTimer: false }, players: [
    { name: '小骰', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
    { name: '对手', isAI: true, characterId: 'villager', pieceColor: '#5f8d95', isHost: false },
  ] }
}
function position(): GameState {
  const state = createGame(config('cloud'))
  state.aiMode = 'cloud'
  state.turnNumber = 2
  state.activeIndex = 1
  state.phase = 'action'
  state.players[0].cell = { x: 6, y: 5 }
  state.players[1].hand = [{ uid: 9001, toolId: 'move', points: 3 }]
  state.dice.move = 3
  return state
}
function ready(state: GameState, actionId = listTacticalActions(state, 'ai-1').find(action => action.dir === 'right')!.actionId): OpponentDecision {
  return { runId: `test-${actionId}`, status: 'ready', actionId, reason: '沿安全方向接近终点。', sourceIds: ['move.basic'],
    sources: [{ id: 'move.basic', title: '方向移动', text: '沿指定方向滑行。', source: 'knowledge/rules-v1.md', sourceLines: [1, 4] }],
    steps: 2, elapsedMs: 100, model: 'test-model', usage: null, events: [] }
}
function unavailable(): OpponentDecision {
  return { runId: 'test-fallback', status: 'fallback', reason: '模型不可用。', sourceIds: [], sources: [],
    steps: 0, elapsedMs: 1, model: 'test-model', usage: null, events: [], fallbackReason: 'NOT_CONFIGURED' }
}
function memory() {
  const values = new Map<string, string>()
  return { values, getStore: () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }) }
}

test('云端对手正常决策只执行一次，记录摘要且同一回合不重复调用', async () => {
  const state = position()
  let calls = 0
  const controller = createOpponentController({ request: async input => {
    calls++
    assert.equal(input.playerId, 'ai-1')
    assert.equal(input.snapshot.players[0].hand.length, 0)
    assert.notEqual(input.snapshot.players[0].name, '小骰')
    return ready(state)
  } })
  const first = await controller.step(state)
  assert.equal(first.acted, true)
  assert.equal(first.decision?.mode, 'cloud')
  assert.deepEqual(state.players[1].cell, { x: 3, y: 6 })
  assert.equal(state.aiTelemetry?.requests, 1)
  assert.equal(state.aiTelemetry?.modelSuccess, 1)
  assert.equal(state.aiTelemetry?.recent[0].sourceIds[0], 'move.basic')
  await controller.step(state)
  assert.equal(calls, 1)
  assert.equal(state.phase, 'turnEnd')
  controller.dispose()
})

test('合法获胜触发界面同步取消时，已执行动作与成功统计仍完整提交', async () => {
  const state = reactive(position())
  state.players[1].hand.push({ uid: 9004, toolId: 'teleport' })
  const action = listTacticalActions(state, 'ai-1').find(item => item.kind === 'teleport' && item.target?.x === 6 && item.target.y === 0)!
  const decision = ready(state, action.actionId)
  decision.sourceIds = ['tool.teleport']
  decision.sources = [{ id: 'tool.teleport', title: '瞬移', text: '可瞬移到合法终点。', source: 'knowledge/rules-v1.md', sourceLines: [1, 4] }]
  const controller = createOpponentController({ request: async () => decision })
  const stop = watch(() => state.finished, finished => { if (finished) controller.cancel() }, { flush: 'sync' })
  try {
    const result = await controller.step(state)
    assert.equal(result.acted, true)
    assert.equal(state.finished, true)
    assert.equal(state.aiTelemetry?.modelSuccess, 1)
    assert.equal(state.aiTelemetry?.recent[0].actionId, action.actionId)
    assert.equal(state.players[1].hand.some(card => card.uid === 9004), false)
  } finally { stop(); controller.dispose() }
})

test('请求未完成期间不出牌，重复step不并发请求或抢先执行规则动作', async () => {
  const state = position(), before = tacticalSnapshotKey(state)
  let resolve!: (value: OpponentDecision) => void
  let calls = 0
  const controller = createOpponentController({ request: async () => { calls++; return new Promise(done => { resolve = done }) } })
  const pending = controller.step(state)
  await Promise.resolve()
  assert.equal(tacticalSnapshotKey(state), before)
  assert.deepEqual(await controller.step(state), { acted: false })
  assert.equal(calls, 1)
  resolve(ready(state))
  assert.equal((await pending).acted, true)
})

test('对手复盘只保留最近20条摘要，不随长对局无限增长', async () => {
  const state = position()
  const controller = createOpponentController({ request: async () => ready(state) })
  for (let index = 0; index < 25; index++) {
    state.turnNumber = index + 2
    state.phase = 'action'
    state.players[1].cell = { x: 0, y: 6 }
    state.players[1].hand = [{ uid: 10000 + index, toolId: 'move', points: 3 }]
    assert.equal((await controller.step(state)).acted, true)
  }
  assert.equal(state.aiTelemetry?.requests, 25)
  assert.equal(state.aiTelemetry?.modelSuccess, 25)
  assert.equal(state.aiTelemetry?.recent.length, 20)
  assert.equal(state.aiTelemetry?.recent[0].turnNumber, 26)
  assert.equal(state.aiTelemetry?.recent.at(-1)?.turnNumber, 7)
  assert.equal(JSON.stringify(state.aiTelemetry).includes('events'), false)
})

test('服务不可用时以确定性合法行动降级，统计一次且对局继续', async () => {
  const state = position()
  const expected = chooseFallbackAction(state, 'ai-1')!
  assert.equal(chooseFallbackAction(state, 'ai-1')!.action.actionId, expected.action.actionId)
  const controller = createOpponentController({ request: async () => unavailable() })
  const result = await controller.step(state)
  assert.equal(result.acted, true)
  assert.equal(result.decision?.mode, 'fallback')
  assert.equal(result.decision?.actionId, expected.action.actionId)
  assert.equal(result.decision?.fallbackReason, 'NOT_CONFIGURED')
  assert.equal(state.aiTelemetry?.fallbacks, 1)
  assert.equal(state.aiTelemetry?.modelSuccess, 0)
})

test('忽略Abort的挂起请求达到时限后降级，迟到回复不再执行', async () => {
  const state = position()
  let resolve!: (value: OpponentDecision) => void
  let captured: AbortSignal | undefined
  const proposal = ready(state)
  const controller = createOpponentController({ timeoutMs: 15, request: async (_input, signal) => {
    captured = signal; return new Promise(done => { resolve = done })
  } })
  const result = await controller.step(state)
  assert.equal(result.decision?.fallbackReason, 'TIMEOUT')
  assert.equal(captured?.aborted, true)
  const after = tacticalSnapshotKey(state)
  resolve(proposal)
  await Promise.resolve()
  assert.equal(tacticalSnapshotKey(state), after)
  assert.equal(state.aiTelemetry?.requests, 1)
  assert.equal(state.aiTelemetry?.fallbacks, 1)
})

test('退出取消与外部Abort均不出牌、不降级，迟到回复不能修改状态', async () => {
  for (const external of [false, true]) {
    const state = position(), before = tacticalSnapshotKey(state), signal = new AbortController()
    let resolve!: (value: OpponentDecision) => void
    const decision = ready(state)
    const controller = createOpponentController({ request: async () => new Promise(done => { resolve = done }) })
    const pending = controller.step(state, { signal: signal.signal })
    await Promise.resolve()
    if (external) signal.abort(); else controller.cancel()
    assert.equal((await pending).cancelled, true)
    resolve(decision); await Promise.resolve()
    assert.equal(tacticalSnapshotKey(state), before)
    assert.equal(state.aiTelemetry?.fallbacks, 0)
  }
})

test('请求期间局面变化，原决策与降级动作都被丢弃', async () => {
  const state = position()
  let resolve!: (value: OpponentDecision) => void
  const decision = ready(state)
  const controller = createOpponentController({ request: async () => new Promise(done => { resolve = done }) })
  const pending = controller.step(state)
  await Promise.resolve()
  state.players[1].cell = { x: 1, y: 6 }
  const changed = tacticalSnapshotKey(state)
  resolve(decision)
  assert.equal((await pending).cancelled, true)
  assert.equal(tacticalSnapshotKey(state), changed)
  assert.equal(state.aiTelemetry?.fallbacks, 0)
})

test('伪造动作或来源、网络错误、服务器取消均不会执行未经检查的模型动作', async () => {
  for (const problem of ['bad-id', 'bad-source', 'network', 'cancelled']) {
    const state = position()
    const decision = ready(state)
    if (problem === 'bad-id') decision.actionId = 'teleport:forged:6:0'
    if (problem === 'bad-source') decision.sourceIds = ['hack.fake']
    if (problem === 'cancelled') decision.status = 'cancelled'
    const controller = createOpponentController({ request: async () => {
      if (problem === 'network') throw new Error('private-upstream-body')
      return decision
    } })
    const before = tacticalSnapshotKey(state)
    const result = await controller.step(state)
    if (problem === 'cancelled') {
      assert.equal(result.cancelled, true)
      assert.equal(tacticalSnapshotKey(state), before)
    } else {
      assert.equal(result.decision?.mode, 'fallback')
      assert.equal(state.finished, false)
      assert.equal(JSON.stringify(result).includes('private-upstream-body'), false)
    }
  }
})

test('旧模式、非AI和非行动阶段沿用规则AI，不向云端泄漏状态', async () => {
  let calls = 0
  const controller = createOpponentController({ request: async () => { calls++; return unavailable() } })
  const rules = position(); delete rules.aiMode
  assert.equal((await controller.step(rules)).acted, true)
  const human = position(); human.activeIndex = 0
  assert.equal((await controller.step(human)).acted, false)
  const start = createGame(config('cloud')); start.aiMode = 'cloud'; start.activeIndex = 1
  start.players[1].hand = [{ uid: 9003, toolId: 'roll', system: true }]
  assert.equal((await controller.step(start)).acted, true)
  assert.equal(start.phase, 'action')
  assert.equal(calls, 0)
  controller.dispose()
  assert.equal((await controller.step(position())).cancelled, true)
})

test('刷新恢复保留回合请求占位，不重复请求模型，旧存档仍兼容', async () => {
  const state = position(), store = memory()
  state.aiTelemetry = { requests: 1, modelSuccess: 0, fallbacks: 0, lastAttempt: { turnNumber: 2, playerId: 'ai-1' }, recent: [] }
  const input = { config: config('cloud'), state, roomCode: 'TRAIN', tutorialStep: 6, timeLeft: 75 }
  assert.equal(saveMatch(input, store.getStore).warning, '')
  const restored = loadMatch(store.getStore).match!.state
  let calls = 0
  const controller = createOpponentController({ request: async () => { calls++; return unavailable() } })
  assert.equal((await controller.step(restored)).acted, true)
  assert.equal(calls, 0)
  const legacy = { config: config(), state: createGame(config()), roomCode: 'TRAIN', tutorialStep: 1, timeLeft: 75 }
  delete legacy.config.aiMode; delete legacy.state.aiMode
  assert.equal(saveMatch(legacy, store.getStore).warning, '')
  assert.ok(loadMatch(store.getStore).match)
})

test('存档拒绝损坏的AI模式与过长、隐藏或不一致的运行元数据', () => {
  const state = position(), store = memory()
  state.aiTelemetry = { requests: 1, modelSuccess: 0, fallbacks: 1, lastAttempt: { turnNumber: 2, playerId: 'ai-1' }, recent: [
    { runId: 'record-1', turnNumber: 2, playerId: 'ai-1', mode: 'fallback', label: '移动', reason: '规则接管', sourceIds: [], elapsedMs: 100, fallbackReason: 'TIMEOUT' },
  ] }
  assert.equal(saveMatch({ config: config('cloud'), state, roomCode: 'TRAIN', tutorialStep: 6, timeLeft: 75 }, store.getStore).warning, '')
  const good = store.values.get(MATCH_STORAGE_KEY)!
  const corruptions = [
    (saved: any) => { saved.state.aiMode = 'unknown' },
    (saved: any) => { saved.config.aiMode = 'rules' },
    (saved: any) => { saved.state.aiTelemetry.fallbacks = 2 },
    (saved: any) => { saved.state.aiTelemetry.lastAttempt.playerId = 'human' },
    (saved: any) => { saved.state.aiTelemetry.recent[0].reason = '长'.repeat(241) },
    (saved: any) => { saved.state.aiTelemetry.recent[0].rawContext = 'private' },
    (saved: any) => { saved.state.aiTelemetry.recent[0].sourceIds = ['bad source'] },
    (saved: any) => { saved.state.aiTelemetry.recent[0].mode = 'whatever' },
  ]
  for (const change of corruptions) {
    const saved = JSON.parse(good); change(saved)
    store.values.set(MATCH_STORAGE_KEY, JSON.stringify(saved))
    assert.equal(loadMatch(store.getStore).match, null)
  }
  assert.throws(() => validateGameConfig({ ...config(), aiMode: 'unknown' } as unknown as GameConfig), /模式/)
})
