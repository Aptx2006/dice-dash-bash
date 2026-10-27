import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activePlayer, adjacentFreeCells, beginTurn, canUseTool, chooseReward, computeMoveTargets,
  createGame, finishPlayer, inBoard, killPlayer, knockback, playAdjacentTool, playBlinkTool, playDirectionTool,
  playLeapTool, playStormCard, playTeleportTool, playTow, resolveMoveCard,
} from '../src/game/engine.ts'
import { aiStep } from '../src/game/ai.ts'
import type { Dir, GameState, TerrainKind } from '../src/game/types.ts'

function fresh(ai = false): GameState {
  const state = createGame({ mapId: 'tutorial', players: [
    { name: '测试玩家', isAI: ai, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
    { name: '测试对手', isAI: !ai, characterId: 'villager', pieceColor: '#5f8d95', isHost: false },
  ], mechanisms: { airdrop: false, turnTimer: false } })
  state.phase = 'action'
  state.players.forEach(player => { player.hand = [] })
  state.players[1].cell = { x: 5, y: 5 }
  return state
}

test('道具入口严格匹配牌种，不能用移动牌uid施放瞬移/瞬步/飞跃/牵引', () => {
  const state = fresh()
  state.players[0].hand = [{ uid: 90001, toolId: 'move', points: 3 }]
  const before = JSON.stringify(state)
  playTeleportTool(state, 90001, { x: 6, y: 0 })
  playBlinkTool(state, 90001, { x: 1, y: 6 })
  playLeapTool(state, 90001, 'right')
  playTow(state, 90001, state.players[1].id, 'left')
  assert.equal(JSON.stringify(state), before)
})

test('牵引拒绝自己、距离外和错误方向；合法目标才会移动并扣牌', () => {
  const state = fresh()
  state.players[0].hand = [{ uid: 90001, toolId: 'tow' }]
  const before = JSON.stringify(state)
  playTow(state, 90001, state.players[0].id, 'up')
  playTow(state, 90001, state.players[1].id, 'left')
  playTow(state, 90001, state.players[1].id, 'diagonal' as Dir)
  assert.equal(JSON.stringify(state), before)
  state.players[1].cell = { x: 1, y: 6 }
  playTow(state, 90001, state.players[1].id, 'up')
  assert.deepEqual(state.players[1].cell, { x: 1, y: 4 })
  assert.equal(state.players[0].hand.length, 0)
})

test('奖励选择期间和对局结束后不能绕过道具可用检查', () => {
  for (const finished of [false, true]) {
    const state = fresh()
    state.players[0].hand = [{ uid: 90001, toolId: 'teleport' }, { uid: 90002, toolId: 'punch' }]
    if (finished) state.finished = true
    else state.pendingReward = { playerId: state.players[0].id, options: [{ uid: 90003, toolId: 'sprint' }], reason: '测试奖励' }
    const before = JSON.stringify(state)
    playTeleportTool(state, 90001, { x: 6, y: 0 })
    playDirectionTool(state, 90002, 'right')
    assert.equal(JSON.stringify(state), before)
  }
})

test('建设只允许普通空地，不能覆盖唯一终点或其他功能格', () => {
  for (const kind of ['goal', 'start', 'home', 'lucky', 'poison', 'pit', 'conveyor', 'cannon'] as TerrainKind[]) {
    const state = fresh()
    state.players[0].cell = { x: 1, y: 1 }
    const target = { x: 2, y: 1 }
    state.tiles[1][2] = { ...target, kind }
    state.players[0].hand = [{ uid: 90001, toolId: 'buildwall' }]
    assert.equal(adjacentFreeCells(state, state.players[0]).some(cell => cell.x === 2 && cell.y === 1), false)
    const before = JSON.stringify(state)
    playAdjacentTool(state, 90001, target)
    assert.equal(JSON.stringify(state), before, `${kind}不能被砌墙覆盖`)
  }
  const state = fresh()
  state.players[0].hand = [{ uid: 90001, toolId: 'buildwall' }]
  playAdjacentTool(state, 90001, { x: 1, y: 6 })
  assert.equal(state.tiles[6][1].kind, 'earthwall')
  assert.equal(state.players[0].hand.length, 0)
})

test('瞬步和飞跃落入坑洞均复活，不能站在坑洞中存活', () => {
  for (const toolId of ['blink', 'leap'] as const) {
    const state = fresh()
    state.players[0].cell = { x: 1, y: 1 }
    state.tiles[1][2].kind = 'pit'
    state.players[0].hand = [{ uid: 90001, toolId, points: 1 }]
    if (toolId === 'blink') playBlinkTool(state, 90001, { x: 2, y: 1 })
    else playLeapTool(state, 90001, 'right')
    assert.deepEqual(state.players[0].cell, state.players[0].spawn)
    assert.equal(state.players[0].hand.length, 0)
    assert.ok(state.logs.some(entry => entry.text.includes('坑洞')))
  }
})

test('回合开始爆炸将玩家击入终点时，保留finished状态不重新发牌', () => {
  const state = fresh()
  state.turnNumber = 3
  state.players[1].cell = { x: 6, y: 2 }
  state.bombs = [{ id: 90001, ownerId: state.players[0].id, plantedTurn: 1, cell: { x: 6, y: 3 } }]
  beginTurn(state)
  assert.equal(state.finished, true)
  assert.equal(state.phase, 'finished')
  assert.equal(state.players[1].finishedTurn, 3)
  assert.equal(state.players[0].hand.length, 0)
})

test('非法奖励索引不会吞掉三选一，合法索引只领取一次', () => {
  const state = fresh()
  state.phase = 'reward'
  state.pendingReward = { playerId: state.players[0].id, options: [
    { uid: 90001, toolId: 'sprint' }, { uid: 90002, toolId: 'blink' }, { uid: 90003, toolId: 'punch' },
  ], reason: '测试奖励' }
  const before = JSON.stringify(state)
  for (const index of [-1, 99, 0.5, NaN]) chooseReward(state, index)
  assert.equal(JSON.stringify(state), before)
  chooseReward(state, 1)
  chooseReward(state, 1)
  assert.equal(state.phase, 'action')
  assert.deepEqual(state.players[0].hand, [{ uid: 90002, toolId: 'blink' }])
})

test('可用性检查校验手牌归属、制衡点数及移动阶段', () => {
  const state = fresh()
  state.players[0].hand = [
    { uid: 90001, toolId: 'move', points: 1 }, { uid: 90002, toolId: 'balance', points: 1 },
    { uid: 90003, toolId: 'leap', points: 2 }, { uid: 90004, toolId: 'teleport' },
  ]
  assert.equal(canUseTool(state, { uid: 99999, toolId: 'teleport' }), false)
  assert.equal(canUseTool(state, state.players[0].hand[1]), false)
  state.players[0].hand[0].points = 2
  assert.equal(canUseTool(state, state.players[0].hand[1]), true)
  state.phase = 'turnEnd'
  assert.equal(canUseTool(state, state.players[0].hand[0]), false)
  assert.equal(canUseTool(state, state.players[0].hand[2]), false)
  assert.equal(canUseTool(state, state.players[0].hand[3]), true)
})

test('多张移动牌时选第二张按其点数移动，保留第一张及拒绝错误uid', () => {
  const state = fresh()
  state.players[0].hand = [{ uid: 90001, toolId: 'move', points: 1 }, { uid: 90002, toolId: 'move', points: 3 }]
  const paths = computeMoveTargets(state, state.players[0], 90002)
  assert.equal(paths.find(path => path.dir === 'right')!.cells.length, 3)
  const before = JSON.stringify(state)
  resolveMoveCard(state, 'right', undefined, 99999)
  resolveMoveCard(state, 'diagonal' as Dir, undefined, 90002)
  assert.equal(JSON.stringify(state), before)
  resolveMoveCard(state, 'right', undefined, 90002)
  assert.deepEqual(state.players[0].cell, { x: 3, y: 6 })
  assert.deepEqual(state.players[0].hand, [{ uid: 90001, toolId: 'move', points: 1 }])
})

test('牵引AI按推演后目标位置选择方向，能够实际阻碍对手', () => {
  const state = fresh(true)
  state.turnNumber = 3
  state.players[0].cell = { x: 3, y: 6 }
  state.players[1].cell = { x: 3, y: 5 }
  state.players[0].hand = [{ uid: 90001, toolId: 'tow' }]
  assert.equal(aiStep(state), true)
  assert.deepEqual(state.players[1].cell, { x: 1, y: 5 })
  assert.equal(state.players[0].hand.length, 0)
  assert.equal(state.phase, 'action')
})

test('方向工具没有收益时AI保留手牌，避免因评分基准不一致空放', () => {
  const state = fresh(true)
  state.turnNumber = 3
  state.players[0].hand = [{ uid: 90001, toolId: 'hook', length: 1 }]
  assert.equal(aiStep(state), true)
  assert.ok(state.players[0].hand.some(card => card.uid === 90001))
  assert.equal(state.phase, 'turnEnd')
})

test('教学机器人首轮只移动和交出回合，不靠随机瞬移提前结束教学', () => {
  const state = fresh(true)
  state.turnNumber = 2
  state.players[0].hand = [
    { uid: 90001, toolId: 'move', points: 2 }, { uid: 90002, toolId: 'teleport' },
    { uid: 90003, toolId: 'punch' }, { uid: 90004, toolId: 'bomb' },
  ]
  aiStep(state)
  assert.equal(state.finished, false)
  assert.ok(state.players[0].hand.some(card => card.uid === 90002))
  assert.equal(state.players[0].hand.some(card => card.uid === 90001), false)
  aiStep(state)
  assert.equal(state.phase, 'turnEnd')
  aiStep(state)
  assert.equal(activePlayer(state).id, state.players[1].id)
  assert.equal(state.bombs.length, 0)
  assert.equal(state.finished, false)
})

test('分数坐标不属于棋盘，风暴错误目标不崩溃且不消耗卡牌', () => {
  const state = fresh()
  state.phase = 'turnStart'
  state.players[0].hand = [{ uid: 90001, toolId: 'storm' }]
  assert.equal(inBoard(state, { x: 0.5, y: 5 }), false)
  const before = JSON.stringify(state)
  playStormCard(state, { x: 0.5, y: 5 })
  assert.equal(JSON.stringify(state), before)
})

test('移动高亮复用真实传送带推进，免费格与前一格共用已支付次数', () => {
  const state = fresh()
  state.tiles[6][1] = { x: 1, y: 6, kind: 'conveyor', dir: 'right' }
  state.players[0].hand = [{ uid: 90001, toolId: 'move', points: 2 }]
  const before = JSON.stringify(state)
  const path = computeMoveTargets(state, state.players[0]).find(target => target.dir === 'right')!
  assert.deepEqual(path.cells, [{ x: 1, y: 6 }, { x: 2, y: 6 }, { x: 3, y: 6 }])
  assert.deepEqual(path.stops, [1, 1, 2])
  assert.equal(JSON.stringify(state), before, '路径查询不能修改正式局面')
  resolveMoveCard(state, 'right')
  assert.deepEqual(state.players[0].cell, path.cells.at(-1))
})

test('经过坑洞或终点后不继续高亮后续格子', () => {
  for (const kind of ['pit', 'goal'] as const) {
    const state = fresh()
    if (kind === 'goal') state.tiles[0][6].kind = 'floor'
    state.tiles[6][1] = { x: 1, y: 6, kind }
    state.players[0].hand = [{ uid: 90001, toolId: 'move', points: 4 }]
    const path = computeMoveTargets(state, state.players[0]).find(target => target.dir === 'right')!
    assert.deepEqual(path.cells, [{ x: 1, y: 6 }])
    assert.deepEqual(path.stops, [1])
    assert.equal(state.finished, false)
    resolveMoveCard(state, 'right')
    if (kind === 'goal') assert.equal(state.finished, true)
    else assert.deepEqual(state.players[0].cell, state.players[0].spawn)
  }
})

test('罗素点击传送带免费格时以支付次数制动，实际停在该免费格', () => {
  const state = fresh()
  state.players[0].characterId = 'russell'
  state.tiles[6][1] = { x: 1, y: 6, kind: 'conveyor', dir: 'right' }
  state.players[0].hand = [{ uid: 90001, toolId: 'move', points: 3 }]
  const path = computeMoveTargets(state, state.players[0]).find(target => target.dir === 'right')!
  const freeIndex = path.cells.findIndex(cell => cell.x === 2 && cell.y === 6)
  assert.equal(freeIndex, 1)
  assert.equal(path.stops![freeIndex], 1)
  resolveMoveCard(state, 'right', path.stops![freeIndex])
  assert.deepEqual(state.players[0].cell, { x: 2, y: 6 })
})

test('土墙路径预览保留真实移动消耗且不会提前消耗墙体耐久', () => {
  const state = fresh()
  state.tiles[6][1] = { x: 1, y: 6, kind: 'earthwall', durability: 2 }
  state.players[0].hand = [{ uid: 90001, toolId: 'move', points: 3 }]
  const path = computeMoveTargets(state, state.players[0]).find(target => target.dir === 'right')!
  assert.deepEqual(path.cells, [{ x: 1, y: 6 }, { x: 2, y: 6 }])
  assert.deepEqual(path.stops, [1, 2])
  assert.equal(state.tiles[6][1].durability, 2)
  resolveMoveCard(state, 'right')
  assert.deepEqual(state.players[0].cell, { x: 2, y: 6 })
  assert.equal(state.tiles[6][1].durability, 1)
})

function rocketFinish() {
  const state = createGame({ mapId: 'race1', players: [
    { name: '火箭玩家', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
    { name: '中心目标', isAI: true, characterId: 'villager', pieceColor: '#5f8d95', isHost: false },
    { name: '旁边目标', isAI: true, characterId: 'villager', pieceColor: '#8fdfba', isHost: false },
  ], mechanisms: { airdrop: false, turnTimer: false } })
  state.phase = 'action'
  state.players.forEach(player => { player.hand = [] })
  state.players[0].cell = { x: 8, y: 4 }
  state.players[1].cell = { x: 8, y: 2 }
  state.players[2].cell = { x: 7, y: 2 }
  state.players[0].hand = [{ uid: 90001, toolId: 'rocket' }]
  playDirectionTool(state, 90001, 'up')
  return state
}

test('三人火箭中心目标先抵达终点后，旁边玩家不再受到后续爆风位移', () => {
  const state = rocketFinish()
  assert.equal(state.finished, true)
  assert.equal(state.phase, 'finished')
  assert.deepEqual(state.players[1].cell, { x: 8, y: 0 })
  assert.deepEqual(state.players[2].cell, { x: 7, y: 2 })
  assert.equal(state.players.filter(player => player.finishedTurn !== undefined).length, 1)
  assert.equal(state.players[0].hand.length, 0, '已经打出的火箭仍应消耗')
  assert.equal(state.logs.some(entry => entry.text.includes('爆炸波及')), false)
})

test('已结束对局不能追加第二胜者、复活已获胜玩家或继续击退', () => {
  const state = rocketFinish()
  const before = JSON.stringify(state)
  finishPlayer(state, state.players[2])
  killPlayer(state, state.players[1], '迟到的伤害')
  knockback(state, state.players[2], 'left', 1, '迟到的爆风')
  assert.equal(JSON.stringify(state), before)
})
