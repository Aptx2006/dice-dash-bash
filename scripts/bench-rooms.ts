import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createCoachServer } from '../server/index.ts'
import { RoomManager } from '../server/rooms/manager.ts'
import { SqliteRoomStore } from '../server/rooms/store.ts'
import type { RoomCommand, RoomSession, RoomView } from '../src/network/types.ts'

// 独立临时SQLite、随机本机端口，绝不连接玩家房间或请求模型。
// 测量请求发出到所有本机SSE客户端收到同一版本；不包含渲染、动画或真实校园网延迟。
const directory = await mkdtemp(join(tmpdir(), 'dice-room-benchmark-'))
const manager = new RoomManager({ store: new SqliteRoomStore(join(directory, 'rooms.sqlite')), diceHoldMs: 0 })
const server = createCoachServer({ rooms: manager })
const controllers: AbortController[] = []
const tasks: Promise<void>[] = []
const samples: number[] = []
let sequence = 0, frames = 0
type Client = { session: RoomSession; latest?: RoomView; wait: (revision: number) => Promise<void> }
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}/api/rooms`
  async function post(path: string, body: unknown, session?: RoomSession) {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session.token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
    const result = await response.json()
    assert.equal(response.status, 200, result.code ?? 'HTTP错误')
    return result as { session: RoomSession; snapshot: RoomView }
  }
  async function client(session: RoomSession): Promise<Client> {
    const controller = new AbortController(); controllers.push(controller)
    const response = await fetch(`${base}/${session.roomId}/events`, {
      headers: { Authorization: `Bearer ${session.token}` }, signal: controller.signal,
    })
    assert.equal(response.status, 200)
    const waiting = new Set<() => void>()
    const item: Client = { session, wait: async revision => {
      if ((item.latest?.revision ?? -1) >= revision) return
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { waiting.delete(done); reject(new Error('SSE同步超过5秒')) }, 5000)
        const done = () => { if ((item.latest?.revision ?? -1) >= revision) { clearTimeout(timeout); waiting.delete(done); resolve() } }
        waiting.add(done); done()
      })
    } }
    tasks.push((async () => {
      const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = ''
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break
          buffer += decoder.decode(chunk.value, { stream: true })
          let end: number
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
            if (!frame.startsWith('data: ')) continue
            item.latest = JSON.parse(frame.slice(6)) as RoomView; frames++
            const own = item.latest.members.find(member => member.id === item.latest!.selfId)?.gamePlayerId
            assert.ok(item.latest.game?.players.every(player => player.id === own || player.hand.length === 0) ?? true,
              '另一玩家的私有手牌不得进入SSE')
            waiting.forEach(notify => notify())
          }
        }
      } catch (error) { if (!controller.signal.aborted) throw error }
    })())
    await item.wait(0)
    return item
  }
  async function command(actor: Client, command: RoomCommand, peers: Client[], measured = false) {
    const latest = await fetch(`${base}/${actor.session.roomId}`, { headers: { Authorization: `Bearer ${actor.session.token}` } })
    assert.equal(latest.status, 200)
    const snapshot = await latest.json() as RoomView
    const start = performance.now()
    const result = await post(`/${actor.session.roomId}/commands`, {
      expectedRevision: snapshot.revision, requestId: `benchmark-${++sequence}`, command,
    }, actor.session)
    await Promise.all(peers.map(peer => peer.wait(result.snapshot.revision)))
    if (measured) samples.push(performance.now() - start)
    return result.snapshot
  }
  const rooms: Client[][] = []
  for (let room = 0; room < 3; room++) {
    const created = await post('', { name: `房主${room}`, mapId: 'race3' })
    const peers = [await client(created.session)]
    for (let seat = 1; seat < 8; seat++) {
      const joined = await post(`/${created.session.roomId}/join`, { name: `成员${room}-${seat}` })
      peers.push(await client(joined.session))
    }
    const host = peers[0]!
    await command(host, { type: 'configure', turnTimer: false, airdrop: false, aiMode: 'rules' }, peers)
    for (const peer of peers) await command(peer, { type: 'character', characterId: 'villager' }, peers)
    for (const peer of peers.slice(1)) await command(peer, { type: 'ready', ready: true }, peers)
    await command(host, { type: 'start' }, peers)
    rooms.push(peers)
  }
  await Promise.all(rooms.map(async peers => {
    for (const actor of peers) {
      for (const toolId of ['roll', 'end', 'end']) {
        const view = actor.latest!, ownId = view.members.find(member => member.id === view.selfId)!.gamePlayerId
        const card = view.game!.players.find(player => player.id === ownId)!.hand.find(card => card.toolId === toolId)
        assert.ok(card, `缺少${toolId}牌`)
        await command(actor, { type: 'card', uid: card.uid }, peers, true)
      }
    }
  }))
  samples.sort((a, b) => a - b)
  console.log(JSON.stringify({ environment: 'loopback-same-process', rooms: 3, playersPerRoom: 8, sseClients: 24,
    commands: samples.length, receivedFrames: frames, sqlite: 'WAL + FULL', presentationHoldMs: 0,
    medianMs: +samples[Math.floor(samples.length * .5)]!.toFixed(2), p95Ms: +samples[Math.ceil(samples.length * .95) - 1]!.toFixed(2),
    maxMs: +samples.at(-1)!.toFixed(2), hiddenHandsVerified: true, campusNetworkVerified: false }))
} finally {
  controllers.forEach(controller => controller.abort())
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  const results = await Promise.allSettled(tasks)
  const target = await realpath(directory)
  assert.equal(dirname(target), await realpath(tmpdir()), '只清理本次创建的系统临时目录')
  assert.ok(basename(target).startsWith('dice-room-benchmark-'))
  await rm(target, { recursive: true, force: true })
  for (const result of results) if (result.status === 'rejected') throw result.reason
}
