import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGame, playRollCard, playEndCard, resolveMoveCard, settlementRanking } from '../src/game/engine.ts'
import type { GameConfig } from '../src/game/types.ts'

export function sampleConfig(): GameConfig {
  return { mapId: 'tutorial', mechanisms: { airdrop: false, turnTimer: false }, players: [
    { name: '小骰', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
    { name: '教学机器人', isAI: true, characterId: 'robot', pieceColor: '#5f8d95', isHost: false },
  ] }
}

test('E4-01 正常初始化：双人教学局读取地图并生成独立状态', () => {
  const config=sampleConfig(), state=createGame(config)
  assert.equal(state.players.length,2)
  assert.equal(state.width,7)
  assert.equal(state.phase,'turnStart')
  state.players[0].name='临时修改'
  assert.equal(config.players[0].name,'小骰')
  assert.equal(createGame(config).players[0].name,'小骰')
})
test('E4-02 空玩家：返回明确错误而不是内部空对象异常', () => {
  assert.throws(()=>createGame({...sampleConfig(),players:[]}),/玩家人数必须为2至8人/)
})
test('E4-03 不存在的地图：拒绝静默替换', () => {
  assert.throws(()=>createGame({...sampleConfig(),mapId:'missing-map'}),/地图不存在/)
})
test('E4-04 超额玩家：拒绝第9名玩家', () => {
  const c=sampleConfig();c.players=Array.from({length:9},(_,i)=>({...c.players[0],name:`玩家${i}`}))
  assert.throws(()=>createGame(c),/玩家人数必须为2至8人/)
})
test('E4-05 空昵称：拒绝纯空白配置', () => {
  const c=sampleConfig();c.players[0].name='   '
  assert.throws(()=>createGame(c),/昵称必须为1至12个字符/)
})
test('E4-06 重复投骰：第二次调用不得重复发牌或改变结果', () => {
  const s=createGame(sampleConfig());playRollCard(s)
  const snapshot=JSON.stringify(s);playRollCard(s)
  assert.equal(JSON.stringify(s),snapshot)
})
test('E4-07 缺少移动牌：不改变局面', () => {
  const s=createGame(sampleConfig());s.phase='action';s.players[0].hand=[]
  const snapshot=JSON.stringify(s);resolveMoveCard(s,'right')
  assert.equal(JSON.stringify(s),snapshot)
})
test('E4-08 真实规则执行到终点并锁定后续行动', () => {
  const s=createGame(sampleConfig());s.phase='action'
  // 固定业务夹具：起点(0,6)，向右6格、向上6格；不直接设置终点状态。
  s.players[0].hand=[{uid:800001,toolId:'move',points:6}]
  resolveMoveCard(s,'right')
  s.players[0].hand=[{uid:800002,toolId:'move',points:6}]
  resolveMoveCard(s,'up')
  assert.equal(s.finished,true)
  assert.equal(settlementRanking(s)[0].player.name,'小骰')
  const snapshot=JSON.stringify(s);playEndCard(s);playRollCard(s);resolveMoveCard(s,'left')
  assert.equal(JSON.stringify(s),snapshot)
})
