import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGame, playRollCard, playEndCard, playSimpleTool, pushEffect, restoreGame, chooseReward } from '../src/game/engine.ts'
import { loadMatch, saveMatch, MATCH_STORAGE_KEY, type MatchInput } from '../src/storage/savedMatch.ts'
import { aiStep } from '../src/game/ai.ts'

function fixture(): MatchInput {
  const config = { mapId: 'tutorial', mechanisms: { airdrop: false, turnTimer: true }, players: [
    { name: '小骰', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
    { name: '教学机器人', isAI: true, characterId: 'robot', pieceColor: '#5f8d95', isHost: false },
  ] }
  return { config, state: createGame(config), roomCode: 'TRAIN', tutorialStep: 1, timeLeft: 42 }
}
function memory() {
  const values = new Map<string, string>()
  return { values, getStore: () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }) }
}

test('没有存档时首页正常显示，不产生警告', () => {
  assert.deepEqual(loadMatch(memory().getStore), { match: null, warning: '' })
})

test('已投骰的局面持久化后保持骰值、手牌、位置和计时，不重复发牌', () => {
  const input = fixture(), store = memory()
  playRollCard(input.state)
  const result = saveMatch(input, store.getStore, 1800000000000)
  assert.equal(result.warning, '')
  const loaded = loadMatch(store.getStore).match!
  assert.equal(loaded.savedAt, 1800000000000)
  assert.equal(loaded.timeLeft, 42)
  // JSON存档会省略可选字段的undefined，业务数据应与序列化前完全一致。
  assert.equal(JSON.stringify(loaded.state), JSON.stringify(input.state))
  const restored = restoreGame(loaded.state)
  const before = JSON.stringify(restored)
  playRollCard(restored)
  assert.equal(JSON.stringify(restored), before)
  restored.players[0].name = '临时名字'
  assert.equal(loaded.state.players[0].name, '小骰')
})

test('奖励选择中恢复后能正确领取一次', () => {
  const input = fixture(), store = memory()
  input.state.phase = 'reward'
  input.state.pendingReward = { playerId: 'human', reason: '幸运方块', options: [{ uid: 9000, toolId: 'sprint' }] }
  assert.equal(saveMatch(input, store.getStore).warning, '')
  const restored = restoreGame(loadMatch(store.getStore).match!.state)
  chooseReward(restored, 0)
  assert.equal(restored.phase, 'action')
  assert.equal(restored.players[0].hand.filter(c => c.uid === 9000).length, 1)
  chooseReward(restored, 0)
  assert.equal(restored.players[0].hand.filter(c => c.uid === 9000).length, 1)
})

test('损坏JSON、旧格式及错误嵌套状态不进入引擎，原存档仍保留', () => {
  const input = fixture(), store = memory()
  saveMatch(input, store.getStore)
  const good = store.values.get(MATCH_STORAGE_KEY)!
  const mutations = [
    (s: any) => { s.formatVersion = 999 },
    (s: any) => { s.state.players[0].cell.x = -1 },
    (s: any) => { s.state.tiles[0][0].kind = 'unknown' },
    (s: any) => { s.state.activeIndex = 8 },
    (s: any) => { s.state.players[1].id = 'human' },
    (s: any) => { s.state.players[0].hand.push({ uid: 5, toolId: 'made-up' }) },
    (s: any) => { s.state.phase = 'reward' },
    (s: any) => { s.state.dice.move = '6' },
    (s: any) => { s.state.players[0].hookLevel = -3 },
  ]
  for (const change of mutations) {
    const corrupt = JSON.parse(good); change(corrupt)
    const raw = JSON.stringify(corrupt); store.values.set(MATCH_STORAGE_KEY, raw)
    const result = loadMatch(store.getStore)
    assert.equal(result.match, null)
    assert.ok(result.warning.length > 0)
    assert.equal(store.values.get(MATCH_STORAGE_KEY), raw)
  }
  store.values.set(MATCH_STORAGE_KEY, '{bad-json')
  assert.equal(loadMatch(store.getStore).match, null)
})

test('容量不足不覆盖旧存档，禁用存储不让页面崩溃', () => {
  const store = memory();saveMatch(fixture(), store.getStore)
  const original = store.values.get(MATCH_STORAGE_KEY)
  const full = () => ({ getItem: store.getStore().getItem, setItem: () => { throw new Error('QuotaExceededError') } })
  assert.match(saveMatch(fixture(), full).warning, /未能保存/)
  assert.equal(store.values.get(MATCH_STORAGE_KEY), original)
  const blocked = () => { throw new Error('SecurityError') }
  assert.match(loadMatch(blocked).warning, /无法读取/)
  assert.match(saveMatch(fixture(), blocked).warning, /未能保存/)
})

test('恢复后新牌、实体、日志和特效序号预留到存档最大值之后', () => {
  const input = fixture()
  input.state.players[0].hand[0].uid = 800000
  input.state.pigs = [{ id: 800001, cell: { x: 2, y: 2 } }]
  input.state.logs[0].id = 800002
  input.state.effects = [{ id: 800003, kind: 'spawn', cell: { x: 0, y: 6 } }]
  const restored = restoreGame(input.state)
  playRollCard(restored)
  assert.ok(restored.players[0].hand.every(card => card.uid > 800000))
  assert.ok(restored.logs[0].id > 800002)
  restored.players[0].hand.push({ uid: 800004, toolId: 'bomb' })
  playSimpleTool(restored, 800004)
  assert.ok(restored.bombs[0].id > 800001)
  pushEffect(restored, 'spawn', { cell: { x: 1, y: 6 } })
  assert.ok(restored.effects.at(-1)!.id > 800003)
  playEndCard(restored);playEndCard(restored)
  assert.equal(restored.players[restored.activeIndex].isAI, true)
})

test('三张正式地图在每步操作后均能保存恢复，结算状态也可以重新查看', context => {
  let seed = 20261015
  context.mock.method(Math, 'random', () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  })
  for (const mapId of ['race1', 'race2', 'race3']) {
    const input = fixture(), store = memory()
    input.config.mapId = mapId
    input.config.mechanisms.airdrop = true
    input.config.players[0].characterId = 'heart'
    input.tutorialStep = -1
    input.state = createGame(input.config)
    for (let step = 0; step < 1500 && !input.state.finished; step++) {
      const current = input.state.players[input.state.activeIndex]
      const wasAI = current.isAI
      // 仅用策略驱动测试夹具中的真人动作；写入前恢复真实席位身份。
      current.isAI = true
      try { aiStep(input.state) } finally { current.isAI = wasAI }
      const result = saveMatch(input, store.getStore)
      assert.equal(result.warning, '', `${mapId} 第${step}步 ${input.state.phase}`)
      input.state = restoreGame(loadMatch(store.getStore).match!.state)
    }
    assert.equal(input.state.finished, true, `${mapId} 应能完赛`)
    assert.equal(loadMatch(store.getStore).match!.state.phase, 'finished')
  }
})
