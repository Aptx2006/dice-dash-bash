import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  activePlayer,
  chooseReward,
  createGame,
  knockback,
  nextTurn,
  playEndCard,
  playRollCard,
  playSimpleTool,
  playTeleportTool,
  resolveMoveCard,
  settlementRanking,
} from '../src/game/engine.ts'
import { aiStep } from '../src/game/ai.ts'
import type { GameConfig, GameState, ToolInstance } from '../src/game/types.ts'

function makeConfig(players: GameConfig['players'], mapId = 'race1'): GameConfig {
  return { mapId, players, mechanisms: { airdrop: false, turnTimer: false } }
}

const HUMAN = { name: '小菜', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true }
const RIVAL = { name: '威猛机器人-935号', isAI: true, characterId: 'villager', pieceColor: '#5f8d95', isHost: false }

/** 构造干净对局：action 阶段、清空手牌、对手挪开避免挡路 */
function freshState(mapId = 'race1', human = HUMAN, rival = RIVAL): GameState {
  const state = createGame(makeConfig([human, rival], mapId))
  state.phase = 'action'
  state.players[0].hand = []
  state.players[1].hand = []
  state.players[1].cell = { x: 5, y: 5 }
  return state
}

function giveMove(state: GameState, points: number): ToolInstance {
  const card: ToolInstance = { uid: 90001, toolId: 'move', points }
  state.players[0].hand.push(card)
  return card
}

test('方向滑行：直线前进指定格数', () => {
  const state = freshState()
  giveMove(state, 3)
  resolveMoveCard(state, 'right')
  assert.deepEqual(state.players[0].cell, { x: 3, y: 9 })
})

test('滑行被墙阻挡后停在墙前', () => {
  const state = freshState()
  giveMove(state, 3)
  // (0,9) 向上：(0,8)、(0,7) 可走，(0,6) 是高墙
  resolveMoveCard(state, 'up')
  assert.deepEqual(state.players[0].cell, { x: 0, y: 7 })
})

test('罗素制动：可以在中途停下', () => {
  const state = freshState('race1', { ...HUMAN, characterId: 'russell' })
  giveMove(state, 3)
  resolveMoveCard(state, 'right', 1)
  assert.deepEqual(state.players[0].cell, { x: 1, y: 9 })
})

test('掉进坑洞：回到出生点', () => {
  const state = freshState('race3')
  state.players[0].cell = { x: 6, y: 6 }
  state.players[1].cell = { x: 0, y: 3 }
  giveMove(state, 1)
  // (6,6) 向左一格是坑 (5,6)
  resolveMoveCard(state, 'left')
  assert.deepEqual(state.players[0].cell, { x: 0, y: 10 })
  assert.equal(state.finished, false)
})

test('传送带顺行：同向移动额外前进一格', () => {
  const state = freshState('race2')
  state.players[0].cell = { x: 3, y: 1 }
  state.players[1].cell = { x: 0, y: 6 }
  giveMove(state, 1)
  // (3,1) 向下到 (3,2) down 传送带，顺行 +1 到 (3,3)
  resolveMoveCard(state, 'down')
  assert.deepEqual(state.players[0].cell, { x: 3, y: 3 })
})

test('土墙：撞击消耗耐久并可穿过', () => {
  const state = freshState()
  state.players[0].cell = { x: 6, y: 5 }
  state.players[1].cell = { x: 1, y: 8 }
  giveMove(state, 3)
  // (6,5) 向上：土墙 (6,4) 消耗 2 点并穿过，再走 1 格到 (6,3)
  resolveMoveCard(state, 'up')
  assert.deepEqual(state.players[0].cell, { x: 6, y: 3 })
  assert.equal(state.tiles[4][6].durability, 1)
})

test('幸运方块：停下触发三选一奖励', () => {
  const state = freshState()
  state.players[0].cell = { x: 1, y: 5 }
  state.players[1].cell = { x: 5, y: 5 }
  giveMove(state, 1)
  resolveMoveCard(state, 'up')
  assert.equal(state.phase, 'reward')
  assert.equal(state.pendingReward?.options.length, 3)
  const handBefore = state.players[0].hand.length
  chooseReward(state, 0)
  assert.equal(state.phase, 'action')
  assert.equal(state.players[0].hand.length, handBefore + 1)
})

test('炸药：下回合开始爆炸并击退邻居', () => {
  const state = freshState()
  state.players[1].cell = { x: 0, y: 8 }
  const bomb: ToolInstance = { uid: 90002, toolId: 'bomb' }
  state.players[0].hand.push(bomb)
  playSimpleTool(state, 90002)
  assert.equal(state.bombs.length, 1)
  // 推两回合回到玩家 0，炸弹引爆
  nextTurn(state)
  nextTurn(state)
  assert.equal(state.bombs.length, 0)
  // (0,8) 被向上击退 2 格，但 (0,6) 是高墙，停在 (0,7)
  assert.deepEqual(state.players[1].cell, { x: 0, y: 7 })
})

test('击退入坑：knockback 直接判死回出生点', () => {
  const state = freshState('race3')
  state.players[1].cell = { x: 6, y: 6 }
  knockback(state, state.players[1], 'left', 1)
  assert.deepEqual(state.players[1].cell, { x: 0, y: 10 })
})

test('抵达终点：对局结束并排名第一', () => {
  const state = freshState()
  state.players[0].cell = { x: 9, y: 3 }
  giveMove(state, 3)
  resolveMoveCard(state, 'up')
  assert.deepEqual(state.players[0].cell, { x: 9, y: 0 })
  giveMove(state, 1)
  resolveMoveCard(state, 'left')
  assert.equal(state.finished, true)
  assert.equal(state.phase, 'finished')
  assert.ok(state.players[0].finishedTurn)
  const ranking = settlementRanking(state)
  assert.equal(ranking[0].player.id, state.players[0].id)
})

test('瞬移落在终点：立即结束对局', () => {
  const state = freshState('race3')
  const teleport: ToolInstance = { uid: 90003, toolId: 'teleport' }
  state.players[0].hand.push(teleport)
  playTeleportTool(state, teleport.uid, { x: 10, y: 0 })
  assert.equal(state.finished, true)
  assert.equal(state.phase, 'finished')
  assert.equal(state.players[0].finishedTurn, state.turnNumber)
})

test('系统卡生命周期：回合结束卡跨回合作废，move 库存保留', () => {
  const state = createGame(
    makeConfig([{ ...HUMAN, characterId: 'blaze' }, RIVAL]),
  )
  playRollCard(state)
  assert.equal(state.phase, 'action')
  playEndCard(state)
  assert.equal(state.phase, 'turnEnd')
  // turnEnd：end + 炸药（系统卡），move 是库存卡
  const toolIds = state.players[0].hand.map((t) => t.toolId)
  assert.ok(toolIds.includes('end'))
  assert.ok(toolIds.includes('bomb'))
  assert.ok(toolIds.includes('move'))
  nextTurn(state)
  // 玩家 0 的系统卡应被清空，move 库存保留
  const after = state.players[0].hand
  assert.equal(after.filter((t) => t.system).length, 0)
  assert.ok(after.some((t) => t.toolId === 'move'))
})

test('AI 全自动对局：三张图均能完赛且状态自洽', () => {
  const AI_PLAYERS = [
    { name: '机器人-一号', isAI: true, characterId: 'russell', pieceColor: '#f2a75c', isHost: true },
    { name: '机器人-二号', isAI: true, characterId: 'goose', pieceColor: '#5f8d95', isHost: false },
    { name: '机器人-三号', isAI: true, characterId: 'lanpen', pieceColor: '#8fdfba', isHost: false },
    { name: '机器人-四号', isAI: true, characterId: 'blaze', pieceColor: '#c9a0e8', isHost: false },
  ]
  for (const mapId of ['race1', 'race2', 'race3']) {
    const state = createGame({
      mapId,
      players: AI_PLAYERS,
      mechanisms: { airdrop: true, turnTimer: false },
    })
    let steps = 0
    while (!state.finished && steps < 4000) {
      const current = activePlayer(state)
      assert.ok(current.isAI, `${mapId}: 轮到非 AI（${current.name}）`)
      const acted = aiStep(state)
      if (!acted) break
      steps++
      assert.ok(state.activeIndex >= 0 && state.activeIndex < state.players.length)
      assert.ok(state.players.every((p) => p.cell.x >= 0 && p.cell.y >= 0), `${mapId}: 玩家越界`)
    }
    assert.equal(state.finished, true, `${mapId}: ${steps} 步内应有人抵达终点`)
    const winner = settlementRanking(state)[0]
    assert.ok(winner.player.finishedTurn, `${mapId}: 冠军必须完赛`)
  }
})
