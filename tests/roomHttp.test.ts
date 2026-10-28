import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createCoachServer } from '../server/index.ts'
import type { RoomView, RoomSession } from '../src/network/types.ts'

test('HTTP双客户端：创建、加入、SSE同步、私有投影、出牌与重复提交形成闭环', { timeout: 15000 }, async () => {
  const server = createCoachServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const controllers: AbortController[] = []
  async function post(path: string, body: unknown, session?: RoomSession) {
    const response = await fetch(`${base}/api/rooms${path}`, { method: 'POST', headers: {
      'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}),
    }, body: JSON.stringify(body) })
    return { response, data: await response.json() }
  }
  async function events(session: RoomSession) {
    const controller = new AbortController(); controllers.push(controller)
    const response = await fetch(`${base}/api/rooms/${session.roomId}/events`, { headers: { Authorization: `Bearer ${session.token}` }, signal: controller.signal })
    assert.equal(response.status, 200)
    assert.ok(response.headers.get('content-type')?.includes('text/event-stream'))
    const reader = response.body!.getReader(), decoder = new TextDecoder(); let buffer = ''
    return async (predicate: (view: RoomView) => boolean): Promise<RoomView> => {
      for (;;) {
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2)
          if (frame.startsWith('data: ')) { const view = JSON.parse(frame.slice(6)) as RoomView; if (predicate(view)) return view }
        }
        const chunk = await reader.read(); assert.equal(chunk.done, false)
        buffer += decoder.decode(chunk.value, { stream: true })
      }
    }
  }
  try {
    const created = await post('', { name: '房主甲', mapId: 'race1' })
    assert.equal(created.response.status, 200)
    const host = created.data.session as RoomSession
    const hostEvent = await events(host)
    await hostEvent(view => view.members[0].connected)
    const joined = await post(`/${host.roomId}/join`, { name: '朋友乙' })
    const guest = joined.data.session as RoomSession
    const guestEvent = await events(guest)
    const connected = await hostEvent(view => view.members.length === 2 && view.members.every(member => member.connected))
    await guestEvent(view => view.members.every(member => member.connected))
    let number = 0
    const command = (session: RoomSession, expectedRevision: number, command: unknown, requestId = `http-action-${++number}`) =>
      post(`/${session.roomId}/commands`, { expectedRevision, requestId, command }, session)
    const ready = await command(guest, connected.revision, { type: 'ready', ready: true })
    assert.equal(ready.response.status, 200)
    const started = await command(host, ready.data.snapshot.revision, { type: 'start' })
    assert.equal(started.response.status, 200)
    const hostGame = await hostEvent(view => view.status === 'playing')
    const guestGame = await guestEvent(view => view.status === 'playing')
    assert.equal(hostGame.gameId, guestGame.gameId)
    assert.equal(hostGame.game?.players[0].hand.length, 1)
    assert.equal(guestGame.game?.players[0].hand.length, 0)
    const roll = hostGame.game!.players[0].hand[0]
    const requestId = 'one-roll-only-0001'
    const rolled = await command(host, hostGame.revision, { type: 'card', uid: roll.uid }, requestId)
    assert.equal(rolled.response.status, 200)
    const guestRoll = await guestEvent(view => view.game?.phase === 'action')
    const hostRoll = await hostEvent(view => view.game?.phase === 'action')
    assert.deepEqual(hostRoll.game?.dice, guestRoll.game?.dice)
    assert.deepEqual(guestRoll.presentation?.dice, { move: hostRoll.game!.dice.move, toolName: hostRoll.game!.dice.toolName })
    assert.equal(guestRoll.game?.players[0].hand.length, 0)
    assert.ok(hostRoll.game!.players[0].hand.some(card => card.toolId === 'move'))
    const duplicate = await command(host, hostGame.revision, { type: 'card', uid: roll.uid }, requestId)
    assert.equal(duplicate.data.snapshot.revision, hostRoll.revision)
    assert.deepEqual(duplicate.data.snapshot.game.dice, hostRoll.game?.dice)
    const forbidden = await command(guest, hostRoll.revision, { type: 'card', uid: roll.uid })
    assert.equal(forbidden.data.code, 'NOT_YOUR_TURN')
    const unauthorized = await fetch(`${base}/api/rooms/${host.roomId}`)
    assert.equal(unauthorized.status, 401)
    assert.equal(JSON.stringify(guestRoll).includes(host.token), false)
  } finally {
    controllers.forEach(controller => controller.abort())
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

test('仅显式配置的局域网来源可用，陌生网页来源无法访问房间服务', async () => {
  const server = createCoachServer({ allowedOrigins: ['http://192.168.1.10:5173'] })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  try {
    for (const [origin, status] of [['http://127.0.0.1:5173', 200], ['http://192.168.1.10:5173', 200],
      ['http://192.168.1.11:5173', 403], ['https://example.com', 403], ['http://localhost.attacker.test:5173', 403]] as const) {
      const response = await fetch(`${base}/api/health`, { headers: { Origin: origin } })
      assert.equal(response.status, status, origin)
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
})
