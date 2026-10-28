import type { IncomingMessage, ServerResponse } from 'node:http'
import { RoomManager } from './manager.ts'
import { RoomError, object, keys } from './commands.ts'

export function createRoomHandler(manager: RoomManager, reserveModel: () => boolean, releaseModel: () => void) {
  const joinWindows = new Map<string, { started: number; count: number }>()
  const send = (res: ServerResponse, status: number, body: unknown) => {
    if (res.destroyed || res.writableEnded) return
    res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body))
  }
  const token = (req: IncomingMessage) => {
    const auth = req.headers.authorization
    if (!auth || !/^Bearer [A-Za-z0-9_-]{40,64}$/.test(auth)) throw new RoomError('INVALID_SESSION', '请先加入这个房间。', 401)
    return auth.slice(7)
  }
  async function body(req: IncomingMessage) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new RoomError('INVALID_FORMAT', '请使用JSON格式。', 415)
    const buffers: Buffer[] = []; let bytes = 0
    for await (const chunk of req) {
      const buffer = Buffer.from(chunk); bytes += buffer.length
      if (bytes > 4096) throw new RoomError('TOO_LARGE', '请求内容过大。', 413)
      buffers.push(buffer)
    }
    try { return object(JSON.parse(Buffer.concat(buffers).toString('utf8'))) }
    catch { throw new RoomError('INVALID_FORMAT', '请求格式不正确。') }
  }
  return async function roomHandler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '/').split('?')[0]
    if (!path.startsWith('/api/rooms')) return false
    try {
      const match = path.match(/^\/api\/rooms(?:\/(\d{6})(?:\/(join|commands|events|suggest))?)?$/)
      if (!match) throw new RoomError('NOT_FOUND', '房间接口不存在。', 404)
      const [, id, operation] = match
      if (req.method === 'POST' && ((!id && !operation) || operation === 'join')) {
        const key = req.socket.remoteAddress ?? 'local', now = Date.now()
        let window = joinWindows.get(key)
        if (!window || now - window.started >= 60000) { window = { started: now, count: 0 }; joinWindows.set(key, window) }
        if (++window.count > 30) throw new RoomError('RATE_LIMIT', '创建或加入操作过多，请稍后重试。', 429)
        for (const [key, value] of joinWindows) if (now - value.started > 120000) joinWindows.delete(key)
        const input = await body(req)
        send(res, 200, id ? manager.join(id, input) : manager.create(input)); return true
      }
      if (!id) throw new RoomError('NOT_FOUND', '接口不存在。', 404)
      const secret = token(req)
      if (req.method === 'GET' && !operation) { send(res, 200, manager.snapshot(id, secret)); return true }
      if (req.method === 'GET' && operation === 'events') {
        manager.snapshot(id, secret)
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('X-Accel-Buffering', 'no')
        let unsubscribe: (() => void) | undefined
        const heartbeat = setInterval(() => { if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n') }, 15000)
        heartbeat.unref()
        res.once('close', () => { clearInterval(heartbeat); unsubscribe?.() })
        unsubscribe = manager.subscribe(id, secret, snapshot => {
          if (!snapshot || res.writableLength > 262144) { res.end(); return }
          if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
        })
        res.flushHeaders(); return true
      }
      if (req.method === 'POST' && operation === 'commands') {
        const input = await body(req)
        send(res, 200, { snapshot: manager.command(id, secret, input) }); return true
      }
      if (req.method === 'POST' && operation === 'suggest') {
        const input = await body(req); keys(input, ['goal'])
        if (!reserveModel()) throw new RoomError('RATE_LIMIT', 'AI服务繁忙，请稍后重试。', 429)
        const controller = new AbortController()
        res.once('close', () => { if (!res.writableEnded) controller.abort() })
        try { send(res, 200, await manager.suggest(id, secret, input.goal, controller.signal)) }
        finally { releaseModel() }
        return true
      }
      throw new RoomError('NOT_FOUND', '房间接口不存在。', 404)
    } catch (error) {
      if (error instanceof RoomError) send(res, error.status, { code: error.code, error: error.message })
      else send(res, 500, { code: 'ROOM_ERROR', error: '暂时无法完成房间操作，请重试。' })
      return true
    }
  }
}
