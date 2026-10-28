import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { RoomManager } from '../server/rooms/manager.ts'
import { SqliteRoomStore, type RoomStore } from '../server/rooms/store.ts'
import type { RoomCheckpoint } from '../server/rooms/checkpoint.ts'
import type { RoomCommand, RoomSession } from '../src/network/types.ts'
import { readRoomView } from '../src/network/client.ts'

class MemoryStore implements RoomStore {
  records = new Map<string, RoomCheckpoint>()
  fail = false
  readAll() { return structuredClone([...this.records.values()]) }
  put(value: RoomCheckpoint) { if (this.fail) throw new Error('synthetic-disk-full'); this.records.set(value.id, structuredClone(value)) }
  remove(id: string) { if (this.fail) throw new Error('synthetic-disk-full'); this.records.delete(id) }
  close() {}
}
let serial = 0
function action(manager: RoomManager, who: RoomSession, command: RoomCommand, requestId = `persistent-test-${++serial}`, revision?: number) {
  return manager.command(who.roomId, who.token, { requestId,
    expectedRevision: revision ?? manager.snapshot(who.roomId, who.token).revision, command })!
}
function setup(manager: RoomManager) {
  const host = manager.create({ name: '重启房主', mapId: 'race1' }).session
  const guest = manager.join(host.roomId, { name: '重启朋友' }).session
  const offHost = manager.subscribe(host.roomId, host.token, () => {})
  const offGuest = manager.subscribe(host.roomId, guest.token, () => {})
  action(manager, guest, { type: 'ready', ready: true }); action(manager, host, { type: 'start' })
  return { host, guest, offHost, offGuest }
}
function use(manager: RoomManager, who: RoomSession, toolId: string) {
  const view = manager.snapshot(who.roomId, who.token), self = view.members.find(member => member.id === view.selfId)!
  const uid = view.game!.players.find(player => player.id === self.gamePlayerId)!.hand.find(card => card.toolId === toolId)!.uid
  return action(manager, who, { type: 'card', uid })
}

test('SQLite真实关闭再打开：房间、手牌、骰值、计时、幂等记录与私有投影保持', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dice-room-persistence-')), path = join(directory, 'rooms.sqlite')
  let now = 1000, manager: RoomManager | undefined
  try {
    manager = new RoomManager({ now: () => now, store: new SqliteRoomStore(path) })
    const { host, guest } = setup(manager)
    const before = manager.snapshot(host.roomId, host.token), roll = before.game!.players[0].hand[0]
    const rolled = action(manager, host, { type: 'card', uid: roll.uid }, 'durable-single-roll', before.revision)
    now += 13200; await manager.tick()
    const remaining = manager.snapshot(host.roomId, host.token).deadlineAt! - now
    manager.close(); manager = undefined; now += 5000
    const store = new SqliteRoomStore(path), records = store.readAll()
    assert.equal(JSON.stringify(records).includes(host.token), false)
    assert.equal(records[0].members[0].tokenHash.length, 64)
    manager = new RoomManager({ now: () => now, store })
    assert.ok(manager.snapshot(host.roomId, host.token).pauseReason)
    manager.subscribe(host.roomId, host.token, () => {})
    const waiting = manager.snapshot(host.roomId, host.token)
    assert.ok(waiting.pauseReason)
    assert.throws(() => use(manager!, host, 'end'), /重连/)
    manager.subscribe(guest.roomId, guest.token, () => {})
    const restored = manager.snapshot(host.roomId, host.token)
    assert.equal(restored.pauseReason, '')
    assert.equal(restored.gameId, rolled.gameId)
    assert.deepEqual(restored.game?.players[0].hand, rolled.game?.players[0].hand)
    assert.deepEqual(restored.game?.dice, rolled.game?.dice)
    assert.equal(restored.deadlineAt! - now, remaining)
    const duplicate = action(manager, host, { type: 'card', uid: roll.uid }, 'durable-single-roll', before.revision)
    assert.equal(duplicate.revision, restored.revision)
    assert.deepEqual(duplicate.game?.dice, rolled.game?.dice)
    assert.equal(manager.snapshot(guest.roomId, guest.token).game?.players[0].hand.length, 0)
    readRoomView(restored)
  } finally { manager?.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('重启继续同一私有随机序列，不重置下一位玩家的骰值和工具结果', () => {
  let now = 1000
  const store = new MemoryStore(), manager = new RoomManager({ store, now: () => now })
  const { host, guest } = setup(manager)
  use(manager, host, 'roll')
  const fork = new MemoryStore(); fork.records = structuredClone(store.records)
  const resumed = new RoomManager({ store: fork, now: () => now })
  try {
    resumed.subscribe(host.roomId, host.token, () => {}); resumed.subscribe(guest.roomId, guest.token, () => {})
    for (const instance of [manager, resumed]) { use(instance, host, 'end'); use(instance, host, 'end'); use(instance, guest, 'roll') }
    const original = manager.snapshot(guest.roomId, guest.token), restored = resumed.snapshot(guest.roomId, guest.token)
    assert.deepEqual(restored.game?.dice, original.game?.dice)
    assert.deepEqual(restored.game!.players[1].hand.map(({ toolId, points, length }) => ({ toolId, points, length })),
      original.game!.players[1].hand.map(({ toolId, points, length }) => ({ toolId, points, length })))
  } finally { manager.close(); resumed.close() }
})

test('落盘失败回退到最后提交状态并暂停，不能把未保存操作广播为成功', () => {
  const store = new MemoryStore(), manager = new RoomManager({ store })
  const { host } = setup(manager), before = manager.snapshot(host.roomId, host.token)
  try {
    store.fail = true
    assert.throws(() => use(manager, host, 'roll'), /保存失败/)
    const after = manager.snapshot(host.roomId, host.token)
    assert.deepEqual(after.game, before.game)
    assert.equal(after.revision, before.revision)
    assert.match(after.pauseReason, /暂停/)
    readRoomView(after)
    assert.throws(() => use(manager, host, 'roll'), /保存失败/)
    assert.throws(() => manager.create({ name: '不能绕过暂停', mapId: 'race1' }), /保存失败/)
  } finally { manager.close() }
  store.fail = false
  const restored = new RoomManager({ store })
  try { assert.deepEqual(restored.snapshot(host.roomId, host.token).game, before.game) } finally { restored.close() }
})

test('离开关闭与过期清理写入数据库，重启不会复活房间或旧身份', () => {
  let now = 1000
  const store = new MemoryStore(), manager = new RoomManager({ store, now: () => now })
  const closed = manager.create({ name: '主动离开', mapId: 'race1' }).session
  action(manager, closed, { type: 'leave' })
  const expired = manager.create({ name: '过期房间', mapId: 'race1' }).session
  manager.close(); now += 1800001
  const resumed = new RoomManager({ store, now: () => now })
  try {
    assert.throws(() => resumed.snapshot(closed.roomId, closed.token), /不存在/)
    assert.throws(() => resumed.snapshot(expired.roomId, expired.token), /不存在/)
    assert.equal(store.records.size, 0)
  } finally { resumed.close() }
})

test('损坏快照拒绝启动且保留原数据库，不静默重置或创建假房间', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dice-room-corrupt-')), path = join(directory, 'rooms.sqlite')
  try {
    const manager = new RoomManager({ store: new SqliteRoomStore(path) }), { host } = setup(manager)
    manager.close()
    const db = new DatabaseSync(path)
    const row = db.prepare('SELECT checkpoint FROM rooms WHERE id=?').get(host.roomId)!
    const checkpoint = JSON.parse(String(row.checkpoint)); checkpoint.game.width = 999
    const corrupted = JSON.stringify(checkpoint)
    db.prepare('UPDATE rooms SET checkpoint=? WHERE id=?').run(corrupted, host.roomId); db.close()
    assert.throws(() => new RoomManager({ store: new SqliteRoomStore(path) }), /损坏|不兼容/)
    const verify = new DatabaseSync(path)
    assert.equal(verify.prepare('SELECT checkpoint FROM rooms WHERE id=?').get(host.roomId)!.checkpoint, corrupted)
    verify.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('重启中断云端分析后记录接管，不重发本回合模型请求', async () => {
  let now = 1000, requests = 0
  const store = new MemoryStore(), seed = new RoomManager({ store, now: () => now })
  const { host, guest } = setup(seed)
  const checkpoint = store.readAll()[0]
  seed.close()
  checkpoint.config.aiMode = 'cloud'; checkpoint.game!.aiMode = 'cloud'
  checkpoint.members[0].takeover = true; checkpoint.members[0].isAI = true; checkpoint.game!.players[0].isAI = true
  checkpoint.game!.phase = 'action'; checkpoint.game!.dice = { move: 3, toolName: '瞬移' }
  checkpoint.game!.players[0].hand = [{ uid: 900000, toolId: 'move', points: 3 }, { uid: 900001, toolId: 'teleport' }, { uid: 900002, toolId: 'end', system: true }]
  checkpoint.remainingMs = null; store.put(checkpoint)
  let called!: () => void
  const started = new Promise<void>(resolve => { called = resolve })
  const manager = new RoomManager({ store, now: () => now, disconnectGraceMs: 0, opponentRequest: async () => {
    requests++; called(); return new Promise(() => {})
  } })
  const pending = manager.tick(); await started
  const copy = new MemoryStore(); copy.records = structuredClone(store.records)
  manager.close(); await pending
  const resumed = new RoomManager({ store: copy, now: () => now, disconnectGraceMs: 0, opponentRequest: async () => {
    requests++; throw new Error('不应再次请求')
  } })
  try {
    resumed.subscribe(guest.roomId, guest.token, () => {})
    const stats = resumed.snapshot(guest.roomId, guest.token).game!.aiTelemetry!
    assert.equal(stats.requests, 1); assert.equal(stats.fallbacks, 1)
    assert.equal(stats.recent[0].fallbackReason, 'SERVER_RESTART')
    await resumed.tick()
    assert.equal(requests, 1)
  } finally { resumed.close() }
})

test('同一数据库拒绝第二个写入服务，关闭后释放锁并可重新打开', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dice-room-owner-')), path = join(directory, 'rooms.sqlite')
  let first: SqliteRoomStore | undefined
  try {
    first = new SqliteRoomStore(path)
    assert.throws(() => new SqliteRoomStore(path), /其他服务/)
    first.close(); first = undefined
    const reopened = new SqliteRoomStore(path)
    assert.deepEqual(reopened.readAll(), []); reopened.close()
  } finally { first?.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('真实子进程强制退出后，从已提交WAL恢复，未调用关闭回调也不丢已确认投骰', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dice-room-crash-')), path = join(directory, 'rooms.sqlite')
  try {
    const source = `import { RoomManager } from ${JSON.stringify(new URL('../server/rooms/manager.ts', import.meta.url).href)};
import { SqliteRoomStore } from ${JSON.stringify(new URL('../server/rooms/store.ts', import.meta.url).href)};
const manager = new RoomManager({store:new SqliteRoomStore(process.argv[1])});
const {session} = manager.create({name:'崩溃恢复合成玩家',mapId:'race1'});
manager.subscribe(session.roomId,session.token,()=>{});
let n=0; const act=command=>manager.command(session.roomId,session.token,{requestId:'crash-action-'+(++n),expectedRevision:manager.snapshot(session.roomId,session.token).revision,command});
act({type:'add_ai'}); act({type:'start'});
const uid=manager.snapshot(session.roomId,session.token).game.players[0].hand[0].uid;
act({type:'card',uid});
const view=manager.snapshot(session.roomId,session.token);
process.stdout.write(JSON.stringify({session,gameId:view.gameId,dice:view.game.dice,hand:view.game.players[0].hand}),()=>process.kill(process.pid,'SIGKILL'));`
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, path], { encoding: 'utf8', windowsHide: true, timeout: 15000 })
    assert.ok(child.stdout.length > 0, child.stderr)
    const expected = JSON.parse(child.stdout)
    const manager = new RoomManager({ store: new SqliteRoomStore(path) })
    try {
      manager.subscribe(expected.session.roomId, expected.session.token, () => {})
      const restored = manager.snapshot(expected.session.roomId, expected.session.token)
      assert.equal(restored.gameId, expected.gameId)
      assert.deepEqual(restored.game?.dice, expected.dice)
      assert.deepEqual(restored.game?.players[0].hand, expected.hand)
    } finally { manager.close() }
  } finally { rmSync(directory, { recursive: true, force: true }) }
})
