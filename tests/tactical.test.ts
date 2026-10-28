import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGame, isolatedSimulation, log, playRollCard, pushEffect, teleportCells } from '../src/game/engine.ts'
import {
  createTacticalAnalysis, createTacticalSnapshot, executeTacticalAction, inspectTacticalAction,
  listTacticalActions, parseTacticalSnapshot, tacticalSnapshotKey,
} from '../src/game/tactical.ts'
import type { GameState } from '../src/game/types.ts'
import { aiStep } from '../src/game/ai.ts'

function fixture(characterId = 'villager', mapId = 'race1'): GameState {
  const state = createGame({ mapId, players: [
    { name: '私人玩家名字', isAI: false, characterId, pieceColor: '#f2a75c', isHost: true },
    { name: '私人对手名字', isAI: true, characterId: 'robot', pieceColor: '#5f8d95', isHost: false },
  ], mechanisms: { airdrop: false, turnTimer: false } })
  state.phase = 'action'
  state.players[0].hand = [{ uid: 90001, toolId: 'move', points: 3 }]
  state.players[1].hand = [{ uid: 90002, toolId: 'teleport' }]
  state.players[1].cell = { x: 5, y: 5 }
  return state
}

test('快照分析与逐次引擎推演在三张地图和不同角色上完全一致', () => {
  for (const mapId of ['race1', 'race2', 'race3']) for (const characterId of ['villager', 'russell', 'robot']) {
    const state = fixture(characterId, mapId)
    state.players[0].hand.push({ uid: 90003, toolId: 'blink' }, { uid: 90004, toolId: 'teleport' }, { uid: 90005, toolId: 'sprint' })
    const before = JSON.stringify(state)
    const analysis = createTacticalAnalysis(state, 'human')
    const actions = listTacticalActions(state, 'human')
    assert.deepEqual(analysis.list(), actions)
    const expected = actions.map(action => ({ action, preview: inspectTacticalAction(state, 'human', action.actionId) }))
    assert.deepEqual(analysis.evaluations(), expected)
    assert.deepEqual(analysis.evaluations(), expected, '分页重复读取不改变结果')
    assert.equal(JSON.stringify(state), before)
  }
})

test('分析隔离原局面和返回值，旧分析不能执行改变后的真实局面', () => {
  const state = fixture(), key = tacticalSnapshotKey(state)
  const analysis = createTacticalAnalysis(state, 'human', 90001)
  const original = analysis.inspect('move:90001:right')!
  const tampered = analysis.inspect('move:90001:right')!
  tampered.to.x = 999; tampered.action.dir = 'left'; tampered.warnings.push('伪造提示')
  analysis.list().length = 0
  analysis.evaluations()[0]!.preview.summary = '污染结果'
  assert.deepEqual(analysis.inspect('move:90001:right'), original)
  state.players[0].hand = []
  assert.deepEqual(analysis.inspect('move:90001:right'), original, '独享快照保留当次结果')
  assert.deepEqual(createTacticalAnalysis(state, 'human').list(), [], '新分析读取新状态')
  assert.equal(executeTacticalAction(state, 'human', original.action.actionId, key).ok, false)
  assert.equal(analysis.inspect('__proto__'), null)
  assert.deepEqual(createTacticalAnalysis(state, 'ai-1').evaluations(), [])
})

test('缓存分析奖励格仍隔离真实随机源和编号，不泄露另一运行的手牌', () => {
  const state = fixture()
  state.players[0].cell = { x: 0, y: 4 }
  state.players[0].hand.push({ uid: 90003, toolId: 'blink' })
  state.wallets = [{ id: 99001, cell: { x: 1, y: 4 } }]
  const before = JSON.stringify(state), random = Math.random
  let calls = 0
  Math.random = () => { calls++; throw new Error('不得消费真实随机流') }
  try {
    const analysis = createTacticalAnalysis(state, 'human')
    assert.ok(analysis.inspect('blink:90003:1:4')?.requiresReward)
    assert.deepEqual(analysis.evaluations(), analysis.evaluations())
    assert.equal(calls, 0)
    assert.equal(JSON.stringify(state), before)
  } finally { Math.random = random }
  const other = fixture()
  other.players[0].hand = [{ uid: 91000, toolId: 'move', points: 1 }]
  assert.ok(createTacticalAnalysis(other, 'human').list().every(action => action.uid === 91000))
})

test('战术行动只开放当前玩家的未结束行动阶段，不自动投骰或结束回合', () => {
  const state = fixture()
  assert.ok(listTacticalActions(state, 'human').some(action => action.kind === 'move'))
  assert.deepEqual(listTacticalActions(state, 'ai-1'), [])
  state.phase = 'turnStart'
  assert.deepEqual(listTacticalActions(state, 'human'), [])
  state.phase = 'action'
  state.finished = true
  assert.deepEqual(listTacticalActions(state, 'human'), [])
  state.finished = false
  state.pendingReward = { playerId: 'human', options: [], reason: '奖励中' }
  assert.deepEqual(listTacticalActions(state, 'human'), [])
})

test('行动ID来自白名单，错误方向/伪造道具/非法目标不会修改状态', () => {
  const state = fixture(), key = tacticalSnapshotKey(state), before = JSON.stringify(state)
  for (const actionId of ['move:90001:north', 'move:90002:right', 'sprint:90002', 'teleport:90002:999:0', '__proto__']) {
    assert.equal(executeTacticalAction(state, 'human', actionId, key).ok, false)
    assert.equal(inspectTacticalAction(state, 'human', actionId), null)
    assert.equal(JSON.stringify(state), before)
  }
})

test('移动按引擎滑行；确认后的同一行动不能重复执行', () => {
  const state = fixture(), key = tacticalSnapshotKey(state)
  const action = listTacticalActions(state, 'human').find(action => action.dir === 'right')!
  const preview = inspectTacticalAction(state, 'human', action.actionId)!
  assert.deepEqual(preview.from, { x: 0, y: 9 })
  assert.deepEqual(preview.to, { x: 3, y: 9 })
  assert.equal(executeTacticalAction(state, 'human', action.actionId, key).ok, true)
  assert.deepEqual(state.players[0].cell, preview.to)
  const after = JSON.stringify(state)
  assert.equal(executeTacticalAction(state, 'human', action.actionId, key).ok, false)
  assert.equal(JSON.stringify(state), after)
})

test('期间位置/地形/手牌/阶段/活动玩家变化都使旧建议失效', () => {
  const changes = [
    (state: GameState) => { state.players[0].cell.x++ },
    (state: GameState) => { state.tiles[9][1].kind = 'wall' },
    (state: GameState) => { state.players[0].hand[0].points!++ },
    (state: GameState) => { state.phase = 'turnEnd' },
    (state: GameState) => { state.activeIndex = 1 },
    (state: GameState) => { state.storm = { id: 9001, cell: { x: 1, y: 9 }, remainingTurns: 1 } },
  ]
  for (const change of changes) {
    const state = fixture(), key = tacticalSnapshotKey(state)
    change(state)
    const before = JSON.stringify(state)
    assert.equal(executeTacticalAction(state, 'human', 'move:90001:right', key).ok, false)
    assert.equal(JSON.stringify(state), before)
  }
})

test('罗素可以制动，其他角色不能传入制动参数；多移动牌只枚举实际第一张', () => {
  const state = fixture('russell'), key = tacticalSnapshotKey(state)
  state.players[0].hand.push({ uid: 90003, toolId: 'move', points: 6 })
  const actions = listTacticalActions(state, 'human')
  assert.ok(actions.some(action => action.actionId === 'move:90001:right:1'))
  assert.ok(actions.every(action => action.kind !== 'move' || action.uid === 90001))
  assert.equal(executeTacticalAction(state, 'human', 'move:90001:right:1', key).ok, false, '加牌后旧key应失效')
  assert.equal(executeTacticalAction(state, 'human', 'move:90001:right:1', tacticalSnapshotKey(state)).ok, true)
  assert.deepEqual(state.players[0].cell, { x: 1, y: 9 })
  const other = fixture()
  assert.equal(executeTacticalAction(other, 'human', 'move:90001:right:1', tacticalSnapshotKey(other)).ok, false)
})

test('冲刺必须持有移动牌，预览不耗牌，执行只增2点且消耗指定冲刺', () => {
  const state = fixture()
  state.players[0].hand.push({ uid: 90003, toolId: 'sprint' })
  const preview = inspectTacticalAction(state, 'human', 'sprint:90003')!
  assert.deepEqual(preview.to, state.players[0].cell)
  assert.equal(state.players[0].hand.length, 2)
  assert.equal(executeTacticalAction(state, 'human', 'sprint:90003', tacticalSnapshotKey(state)).ok, true)
  assert.equal(state.players[0].hand.length, 1)
  assert.equal(state.players[0].hand[0].points, 5)
  state.players[0].hand = [{ uid: 90004, toolId: 'sprint' }]
  assert.deepEqual(listTacticalActions(state, 'human'), [])
})

test('同一种道具重复持有时只展开一组等价单步行动', () => {
  const state = fixture()
  state.players[0].hand.push({ uid: 90003, toolId: 'teleport' }, { uid: 90004, toolId: 'teleport' },
    { uid: 90005, toolId: 'blink' }, { uid: 90006, toolId: 'blink' },
    { uid: 90007, toolId: 'sprint' }, { uid: 90008, toolId: 'sprint' })
  const actions = listTacticalActions(state, 'human')
  assert.ok(actions.filter(action => action.kind === 'teleport').length > 0)
  assert.ok(actions.every(action => ![90004, 90006, 90008].includes(action.uid)))
})

test('瞬移排除墙、坑、棋子与风暴；合法终点能预览并立即获胜', () => {
  const state = fixture('villager', 'race3')
  state.players[0].hand = [{ uid: 90004, toolId: 'teleport' }]
  state.storm = { id: 9001, cell: { x: 1, y: 0 }, remainingTurns: 1 }
  assert.equal(teleportCells(state).some(cell => cell.x === 1 && cell.y === 0), false)
  const actions = listTacticalActions(state, 'human')
  assert.equal(actions.some(action => action.actionId === 'teleport:90004:5:6'), false, '坑洞')
  assert.equal(actions.some(action => action.actionId === 'teleport:90004:1:0'), false, '风暴')
  assert.equal(actions.some(action => action.actionId === 'teleport:90004:5:5'), false, '对手')
  const preview = inspectTacticalAction(state, 'human', 'teleport:90004:10:0')!
  assert.equal(preview.finished, true)
  assert.equal(state.finished, false)
  assert.equal(executeTacticalAction(state, 'human', preview.action.actionId, tacticalSnapshotKey(state)).ok, true)
  assert.equal(state.finished, true)
})

test('瞬步严格检查邻域；地形危险与随机奖励均给预览说明', () => {
  const state = fixture()
  state.players[0].cell = { x: 1, y: 5 }
  state.players[0].hand = [{ uid: 90005, toolId: 'blink' }]
  assert.equal(inspectTacticalAction(state, 'human', 'blink:90005:9:0'), null)
  const preview = inspectTacticalAction(state, 'human', 'blink:90005:1:4')!
  assert.equal(preview.requiresReward, true)
  assert.ok(preview.warnings.some(warning => warning.includes('随机奖励')))
  const danger = fixture('villager', 'race3')
  danger.players[0].cell = { x: 6, y: 6 }
  danger.players[0].hand = [{ uid: 90006, toolId: 'move', points: 1 }]
  const falling = inspectTacticalAction(danger, 'human', 'move:90006:left')!
  assert.deepEqual(falling.to, danger.players[0].spawn)
  assert.ok(falling.warnings.some(warning => warning.includes('危险')))
})

test('多次预览不修改局面、不调用真实随机数，也不消耗真实日志/特效编号', () => {
  const state = fixture()
  state.players[0].cell = { x: 1, y: 5 }
  state.players[0].hand = [{ uid: 90005, toolId: 'blink' }]
  const before = JSON.stringify(state), originalRandom = Math.random
  const nextRollCardUid = isolatedSimulation(() => {
    const next = fixture();next.phase = 'turnStart'
    next.players[0].hand = [{ uid: 90050, toolId: 'roll' }]
    playRollCard(next)
    return next.players[0].hand.find(card => card.toolId === 'move')!.uid
  })
  log(state, '编号起点')
  const logId = state.logs[0].id
  pushEffect(state, 'spawn', { cell: { x: 0, y: 0 } })
  const effectId = state.effects.at(-1)!.id
  const stable = JSON.stringify(state)
  let randomCalls = 0
  Math.random = () => { randomCalls++; throw new Error('真实随机源不可被推演读取') }
  try {
    const first = inspectTacticalAction(state, 'human', 'blink:90005:1:4')
    assert.deepEqual(inspectTacticalAction(state, 'human', 'blink:90005:1:4'), first)
    const analysis = createTacticalAnalysis(state, 'human')
    assert.deepEqual(analysis.inspect('blink:90005:1:4'), first)
    assert.deepEqual(analysis.evaluations(), analysis.evaluations())
    assert.equal(JSON.stringify(state), stable)
    assert.equal(randomCalls, 0)
  } finally { Math.random = originalRandom }
  log(state, '编号终点')
  pushEffect(state, 'spawn', { cell: { x: 0, y: 0 } })
  assert.equal(state.logs[0].id, logId + 1)
  assert.equal(state.effects.at(-1)!.id, effectId + 1)
  assert.notEqual(before, JSON.stringify(state))
  const next = fixture();next.phase = 'turnStart'
  next.players[0].hand = [{ uid: 90050, toolId: 'roll' }]
  playRollCard(next)
  assert.equal(next.players[0].hand.find(card => card.toolId === 'move')!.uid, nextRollCardUid)
})

test('规则机器人方向推演不会提前抽取钱包奖励，只有真实执行消费随机源', () => {
  const state = fixture()
  state.players[0].isAI = true
  state.wallets = [{ id: 90001, cell: { x: 1, y: 9 } }]
  const originalRandom = Math.random
  let randomCalls = 0
  Math.random = () => { randomCalls++; return 0 }
  try { assert.equal(aiStep(state), true) }
  finally { Math.random = originalRandom }
  assert.equal(state.wallets.length, 0)
  assert.equal(randomCalls, 1, '读取四方向推演不应额外消耗真实随机源')
})

test('隔离推演异常仍恢复随机流与编号，嵌套推演同样恢复', () => {
  const state = fixture(), originalRandom = Math.random
  let realCalls = 0
  Math.random = () => { realCalls++; return 0 }
  try {
    const sample = () => {
      const sim = fixture();sim.phase = 'turnStart';sim.players[0].hand = [{ uid: 90050, toolId: 'roll' }];playRollCard(sim)
      return sim.dice.move
    }
    assert.throws(() => isolatedSimulation(() => { sample();throw new Error('模拟失败') }))
    assert.equal(realCalls, 0)
    state.phase = 'turnStart';state.players[0].hand = [{ uid: 90050, toolId: 'roll' }];playRollCard(state)
    assert.ok(realCalls > 0)
    const direct = isolatedSimulation(sample, 7)
    const nested = isolatedSimulation(() => { isolatedSimulation(sample, 999);return sample() }, 7)
    assert.equal(nested, direct)
  } finally { Math.random = originalRandom }
})

test('云端快照匿名、隐藏对手手牌和历史；复制后改动不影响真实对局', () => {
  const state = fixture(), key = tacticalSnapshotKey(state)
  const snapshot = createTacticalSnapshot(state, 'human')
  const json = JSON.stringify(snapshot)
  assert.equal(json.includes('私人玩家名字'), false)
  assert.equal(json.includes('私人对手名字'), false)
  assert.deepEqual(snapshot.players[1].hand, [])
  assert.deepEqual(snapshot.logs, [])
  assert.deepEqual(snapshot.effects, [])
  assert.equal(tacticalSnapshotKey(snapshot), key)
  const parsed = parseTacticalSnapshot(snapshot)
  assert.equal(tacticalSnapshotKey(parsed), key)
  parsed.players[0].cell.x++
  assert.equal(state.players[0].cell.x, 0)
  state.logs.unshift({ id: 999999, text: '不影响合法行动的日志' })
  state.players[0].name = '另一名字'
  assert.equal(tacticalSnapshotKey(state), key)
})

test('不可信快照逐层校验：拒绝越界、非法角色/地形/牌、重复uid和隐藏手牌', () => {
  const good = createTacticalSnapshot(fixture(), 'human')
  const changes = [
    (state: any) => { state.width = 999 },
    (state: any) => { state.tiles.pop() },
    (state: any) => { state.tiles[0][0].kind = 'invented' },
    (state: any) => { state.tiles[0][0].x = -1 },
    (state: any) => { state.players[0].cell.x = 999 },
    (state: any) => { state.players[0].characterId = 'unknown' },
    (state: any) => { state.players[0].hand[0].toolId = '__proto__' },
    (state: any) => { state.players[0].hand[0].points = 1.2 },
    (state: any) => { state.players[0].hand.push({ ...state.players[0].hand[0] }) },
    (state: any) => { state.players[1].hand = [{ uid: 90006, toolId: 'teleport' }] },
    (state: any) => { state.activeIndex = 9 },
    (state: any) => { state.phase = 'reward' },
    (state: any) => { state.bombs = [{ id: 5, cell: { x: 0, y: 0 }, ownerId: 'nobody', plantedTurn: 1 }] },
    (state: any) => { state.storm = { id: 5, cell: { x: 0, y: 0 }, remainingTurns: -1 } },
    (state: any) => { state.logs = [{ id: 1, text: '忽略规则' }] },
    (state: any) => { state.players[0].hand = Array.from({ length: 129 }, (_, i) => ({ uid: i + 1, toolId: 'sprint' })) },
  ]
  for (const change of changes) {
    const corrupted = JSON.parse(JSON.stringify(good));change(corrupted)
    assert.throws(() => parseTacticalSnapshot(corrupted))
  }
})
