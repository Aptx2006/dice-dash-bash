import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RoomManager } from '../server/rooms/manager.ts'
import { RoomError } from '../server/rooms/commands.ts'
import type { RoomSession } from '../src/network/types.ts'
import type { OpponentDecision } from '../src/agent/opponentTypes.ts'
import { readRoomView } from '../src/network/client.ts'

const unavailable: OpponentDecision = { runId: 'synthetic-unavailable', status: 'fallback', reason: '合成故障', sourceIds: [], sources: [],
  steps: 0, elapsedMs: 0, model: 'test', usage: null, events: [], fallbackReason: 'NOT_CONFIGURED' }
let serial = 0
function pair(options: ConstructorParameters<typeof RoomManager>[0] = {}) {
  const manager = new RoomManager({ ...options, opponentRequest: options?.opponentRequest ?? (async () => unavailable) })
  const host = manager.create({ name: '房主', mapId: 'race1' }).session
  const guest = manager.join(host.roomId, { name: '朋友' }).session
  const offHost = manager.subscribe(host.roomId, host.token, () => {})
  const offGuest = manager.subscribe(guest.roomId, guest.token, () => {})
  const command = (who: RoomSession, command: unknown, overrides: Record<string, unknown> = {}) => manager.command(who.roomId, who.token,
    { requestId: `unit-command-${++serial}`, expectedRevision: manager.snapshot(who.roomId, who.token).revision, command, ...overrides })
  const start = () => { command(guest, { type: 'ready', ready: true }); command(host, { type: 'start' }) }
  return { manager, host, guest, command, start, offHost, offGuest }
}
function rejects(action: () => unknown, code: string) {
  assert.throws(action, (error: unknown) => error instanceof RoomError && error.code === code)
}

test('真实房间号唯一，凭证不进入房间视图，房间满员和未知房间有明确错误', () => {
  const p = pair()
  try {
    const second = p.manager.create({ name: '另一个房主', mapId: 'race2' })
    assert.notEqual(second.session.roomId, p.host.roomId)
    assert.match(p.host.roomId, /^\d{6}$/)
    const view = p.manager.snapshot(p.host.roomId, p.host.token)
    assert.equal(JSON.stringify(view).includes(p.host.token), false)
    rejects(() => p.manager.snapshot(p.host.roomId, 'bad-token'), 'INVALID_SESSION')
    rejects(() => p.manager.join('000000', { name: '访客' }), 'ROOM_NOT_FOUND')
    for (let index = 0; index < 6; index++) p.command(p.host, { type: 'add_ai' })
    rejects(() => p.manager.join(p.host.roomId, { name: '第九人' }), 'ROOM_FULL')
  } finally { p.manager.close() }
})

test('准备、房主权限和修改角色/颜色均由服务端校验，失败不产生部分修改', () => {
  const p = pair()
  try {
    rejects(() => p.command(p.guest, { type: 'configure', turnTimer: false }), 'HOST_ONLY')
    rejects(() => p.command(p.host, { type: 'start' }), 'NOT_READY')
    const before = p.manager.snapshot(p.guest.roomId, p.guest.token)
    rejects(() => p.command(p.guest, { type: 'character', characterId: 'russell', pieceColor: before.members[0].pieceColor }), 'INVALID_COMMAND')
    assert.deepEqual(p.manager.snapshot(p.guest.roomId, p.guest.token).members, before.members)
    p.command(p.guest, { type: 'ready', ready: true })
    p.command(p.host, { type: 'configure', airdrop: false })
    assert.equal(p.manager.snapshot(p.guest.roomId, p.guest.token).members.find(member => member.id === before.selfId)?.ready, false)
    rejects(() => p.command(p.host, { type: 'start' }), 'NOT_READY')
  } finally { p.manager.close() }
})

test('出牌身份、持牌、版本和幂等请求锁定权威局面，客户端不能替换棋盘', () => {
  const p = pair({ now: () => 1000 })
  try {
    p.start()
    const first = p.manager.snapshot(p.host.roomId, p.host.token), roll = first.game!.players[0].hand.find(card => card.toolId === 'roll')!
    rejects(() => p.command(p.guest, { type: 'card', uid: roll.uid }), 'NOT_YOUR_TURN')
    rejects(() => p.command(p.host, { type: 'card', uid: 99999999 }), 'CARD_NOT_OWNED')
    const request = { requestId: 'same-request-0001', expectedRevision: first.revision, command: { type: 'card', uid: roll.uid } }
    const after = p.manager.command(p.host.roomId, p.host.token, request)!
    assert.equal(after.game?.phase, 'action')
    assert.deepEqual(p.manager.command(p.host.roomId, p.host.token, request), after)
    rejects(() => p.manager.command(p.host.roomId, p.host.token, { ...request, command: { type: 'start' } }), 'REQUEST_CONFLICT')
    rejects(() => p.command(p.host, { type: 'card', uid: roll.uid }, { expectedRevision: first.revision }), 'STALE_STATE')
    rejects(() => p.command(p.host, { type: 'card', uid: roll.uid }, { state: { finished: true } }), 'INVALID_COMMAND')
    const move = after.game!.players[0].hand.find(card => card.toolId === 'move')!
    rejects(() => p.command(p.host, { type: 'card', uid: move.uid, dir: 'diagonal' }), 'INVALID_COMMAND')
    assert.equal(p.manager.snapshot(p.host.roomId, p.host.token).revision, after.revision)
    const guestView = p.manager.snapshot(p.guest.roomId, p.guest.token)
    assert.equal(guestView.game?.players[0].hand.length, 0)
    assert.equal(after.game!.players[0].hand.length > 0, true)
  } finally { p.manager.close() }
})

test('服务端回合计时推进，客户端无需自行结算超时', async () => {
  let now = 1000
  const p = pair({ now: () => now, turnMs: 100, aiDelayMs: 0, diceHoldMs: 0 })
  try {
    p.command(p.host, { type: 'configure', turnTimer: true })
    p.start()
    now += 101; await p.manager.tick()
    assert.equal(p.manager.snapshot(p.host.roomId, p.host.token).game?.activeIndex, 1)
    assert.equal(p.manager.snapshot(p.guest.roomId, p.guest.token).deadlineAt, now + 100)
  } finally { p.manager.close() }
})

test('断线超过宽限期后接管，重连恢复同一局面，不重复投骰或发牌', async () => {
  let now = 1000
  const p = pair({ now: () => now, disconnectGraceMs: 100, aiDelayMs: 0, diceHoldMs: 0 })
  try {
    p.command(p.host, { type: 'configure', turnTimer: false, airdrop: false })
    p.start(); p.offHost(); now += 101; await p.manager.tick()
    const automated = p.manager.snapshot(p.host.roomId, p.host.token)
    assert.equal(automated.members.find(member => member.id === automated.selfId)?.takeover, true)
    assert.equal(automated.game?.phase, 'action')
    const cards = automated.game!.players[0].hand
    const off = p.manager.subscribe(p.host.roomId, p.host.token, () => {})
    const resumed = p.manager.snapshot(p.host.roomId, p.host.token)
    assert.equal(resumed.gameId, automated.gameId)
    assert.equal(resumed.game!.players[0].isAI, false)
    assert.deepEqual(resumed.game!.players[0].hand, cards)
    assert.deepEqual(resumed.game?.dice, automated.game?.dice)
    off()
  } finally { p.manager.close() }
})

test('重连可取消接管中的云端请求，迟到回应不能替真人出牌', async () => {
  let now = 1000, started!: () => void
  const called = new Promise<void>(resolve => { started = resolve })
  let release!: (value: OpponentDecision) => void
  const p = pair({ now: () => now, disconnectGraceMs: 10, aiDelayMs: 0, diceHoldMs: 0,
    opponentRequest: async () => { started(); return new Promise(resolve => { release = resolve }) } })
  try {
    p.command(p.host, { type: 'configure', turnTimer: false, airdrop: false, aiMode: 'cloud' })
    p.start(); p.offHost(); now += 11; await p.manager.tick()
    const pending = p.manager.tick(); await called
    p.manager.subscribe(p.host.roomId, p.host.token, () => {})
    const resumed = p.manager.snapshot(p.host.roomId, p.host.token)
    release(unavailable); await pending
    const after = p.manager.snapshot(p.host.roomId, p.host.token)
    assert.deepEqual(after.game?.players[0].hand, resumed.game?.players[0].hand)
    assert.deepEqual(after.game?.players[0].cell, resumed.game?.players[0].cell)
    assert.equal(after.game?.players[0].isAI, false)
  } finally { p.manager.close() }
})

test('离开大厅会移交房主权限，旧凭证不能再操作或冒充新成员', () => {
  const p = pair()
  try {
    const guestId = p.manager.snapshot(p.guest.roomId, p.guest.token).selfId
    p.command(p.host, { type: 'leave' })
    assert.equal(p.manager.snapshot(p.guest.roomId, p.guest.token).hostId, guestId)
    rejects(() => p.manager.snapshot(p.host.roomId, p.host.token), 'INVALID_SESSION')
    p.command(p.guest, { type: 'add_ai' })
    assert.equal(p.manager.snapshot(p.guest.roomId, p.guest.token).members.length, 2)
  } finally { p.manager.close() }
})

test('客户端投影接受合法快照，拒绝隐藏手牌、奖励泄漏及异常演出数据', () => {
  const p = pair()
  try {
    p.start()
    const own = p.manager.snapshot(p.host.roomId, p.host.token), other = p.manager.snapshot(p.guest.roomId, p.guest.token)
    assert.equal(readRoomView(own), own)
    assert.equal(readRoomView(other), other)
    const leaked = structuredClone(other); leaked.game!.players[0].hand = own.game!.players[0].hand
    assert.throws(() => readRoomView(leaked))
    const reward = structuredClone(other)
    reward.game!.pendingReward = { playerId: 'human', options: [] }
    assert.equal(readRoomView(reward), reward)
    reward.game!.pendingReward.options = own.game!.players[0].hand
    assert.throws(() => readRoomView(reward))
    const event = structuredClone(own)
    event.presentation = { id: 1, actorId: 'human', actorName: '房主', phaseBefore: 'turnStart', dice: { move: NaN, toolName: '瞬移' } }
    assert.throws(() => readRoomView(event))
  } finally { p.manager.close() }
})

test('真人断线后AI能完整完赛，结算停止操作，房主重赛恢复大厅并清除接管状态', async () => {
  let now = 1000
  const p = pair({ now: () => now, disconnectGraceMs: 10, aiDelayMs: 0, diceHoldMs: 0 })
  try {
    p.command(p.host, { type: 'configure', turnTimer: false, airdrop: false })
    p.start(); p.offHost(); p.offGuest(); now += 11
    let view = p.manager.snapshot(p.host.roomId, p.host.token)
    for (let step = 0; step < 400 && view.status !== 'finished'; step++) {
      now += 10; await p.manager.tick(); view = p.manager.snapshot(p.host.roomId, p.host.token)
      readRoomView(view)
    }
    assert.equal(view.status, 'finished')
    assert.ok(view.game!.players.some(player => player.finishedTurn))
    const revision = view.revision
    await p.manager.tick()
    assert.equal(p.manager.snapshot(p.host.roomId, p.host.token).revision, revision)
    rejects(() => p.command(p.guest, { type: 'rematch' }), 'HOST_ONLY')
    p.manager.subscribe(p.host.roomId, p.host.token, () => {})
    p.command(p.host, { type: 'rematch' })
    const lobby = p.manager.snapshot(p.host.roomId, p.host.token)
    assert.equal(lobby.status, 'lobby'); assert.equal(lobby.game, undefined)
    assert.equal(lobby.presentation, undefined)
    assert.ok(lobby.members.every(member => !member.takeover && !member.isAI))
    assert.equal(lobby.members[1].ready, false)
  } finally { p.manager.close() }
})
