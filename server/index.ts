import { createServer } from 'node:http'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { answerQuestion } from './rag/coach.ts'
import { runTacticalAgent } from './agent/harness.ts'
import { parseTacticalSnapshot } from '../src/game/tactical.ts'
import { runOpponentAgent } from './agent/opponent.ts'
import { RoomManager } from './rooms/manager.ts'
import { createRoomHandler } from './rooms/http.ts'
import type { RoomStore } from './rooms/store.ts'

export function createCoachServer(options: { tacticalAgent?: typeof runTacticalAgent; opponentAgent?: typeof runOpponentAgent; rooms?: RoomManager; roomStore?: RoomStore; allowedOrigins?: string[] } = {}) {
  const allowedOrigins = new Set(options.allowedOrigins ?? [])
  let active = 0
  let windowStart = Date.now(), requests = 0
  const reserveModel = () => {
    if (Date.now() - windowStart > 600000) { windowStart = Date.now(); requests = 0 }
    if (active >= 2 || requests >= 30) return false
    active++; requests++; return true
  }
  const rooms = options.rooms ?? new RoomManager({ store: options.roomStore, opponentRequest: async (task, signal) => {
    if (!reserveModel()) return { runId: randomUUID(), status: 'fallback', reason: 'AI服务繁忙，由本地策略接管。', sourceIds: [], sources: [],
      steps: 0, elapsedMs: 0, model: 'unavailable', usage: null, events: [], fallbackReason: 'RATE_LIMIT' }
    try { return await (options.opponentAgent ?? runOpponentAgent)(task, { signal }) } finally { active-- }
  } })
  const roomHandler = createRoomHandler(rooms, reserveModel, () => { active-- })
  const ticker = setInterval(() => { void rooms.tick().catch(() => { /* 单房间异常不会结束HTTP服务。 */ }) }, 150)
  ticker.unref()
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    const send = (status: number, body: unknown) => { if (!res.destroyed) { res.statusCode = status;res.end(JSON.stringify(body)) } }
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) && !allowedOrigins.has(origin)) return send(403, { error: '不接受此来源的请求。' })
    if (req.url === '/api/health' && req.method === 'GET') return send(200, { ok: true, service: 'game-ai', capabilities: ['rules-coach', 'tactical-agent', 'opponent-agent', 'online-rooms'] })
    if (await roomHandler(req, res)) return
    const tactical = req.url === '/api/agent/tactical'
    const opponent = req.url === '/api/agent/opponent'
    const agentRequest = tactical || opponent
    if ((!agentRequest && req.url !== '/api/coach') || req.method !== 'POST') return send(404, { error: '接口不存在。' })
    if (Date.now() - windowStart > 600000) { windowStart = Date.now();requests = 0 }
    if (active >= 2 || requests >= 30) return send(429, { error: '请求较多，请稍后重试。', status: 'unavailable', answer: '提问较多，请稍后重试。' })
    if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: '请使用JSON格式。' })
    const buffers: Buffer[] = []
    let bytes = 0
    try {
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > (agentRequest ? 98304 : 4096)) return send(413, { error: '请求内容过大。' })
        buffers.push(buffer)
      }
      const data = JSON.parse(Buffer.concat(buffers).toString('utf8'))
      if (!data || typeof data !== 'object' || Array.isArray(data)) return send(400, { error: '请求格式错误。' })
      let snapshot
      if (agentRequest) {
        if (Object.keys(data).some(key => !(tactical ? ['snapshot', 'playerId', 'goal'] : ['snapshot', 'playerId']).includes(key)) ||
          typeof data.playerId !== 'string' || data.playerId.length > 40 ||
          (tactical && (typeof data.goal !== 'string' || !data.goal.trim() || data.goal.length > 120))) {
          return send(400, { error: tactical ? '请输入1至120字的战术目标。' : '智能对手请求格式错误。' })
        }
        try { snapshot = parseTacticalSnapshot(data.snapshot) }
        catch { return send(400, { error: '对局数据无效，请回到当前对局重试。' }) }
        const current = snapshot.players[snapshot.activeIndex]
        if (current.id !== data.playerId || current.isAI !== opponent || snapshot.phase !== 'action' || snapshot.finished || snapshot.pendingReward) {
          return send(400, { error: tactical ? '战术助手仅在你的行动阶段可用。' : '智能对手仅分析当前机器人的行动阶段。' })
        }
      } else if (typeof data.question !== 'string' || !data.question.trim() || data.question.length > 300 || (data.mode && data.mode !== 'rag')) {
        return send(400, { error: '请输入1至300字的规则问题。' })
      }
      // 读取body期间会让出事件循环；占用模型名额前必须同步重验，避免并发请求穿透限制。
      if (Date.now() - windowStart > 600000) { windowStart = Date.now(); requests = 0 }
      if (active >= 2 || requests >= 30) return send(429, { error: '请求较多，请稍后重试。', status: 'unavailable', answer: '提问较多，请稍后重试。' })
      active++;requests++
      const controller = new AbortController()
      res.once('close', () => { if (!res.writableEnded) controller.abort() })
      try {
        if (tactical) {
          const output = await (options.tacticalAgent ?? runTacticalAgent)({ snapshot, playerId: data.playerId, goal: data.goal.trim() }, { signal: controller.signal })
          send(200, output)
        } else if (opponent) {
          const output = await (options.opponentAgent ?? runOpponentAgent)({ snapshot, playerId: data.playerId }, { signal: controller.signal })
          send(200, output)
        } else {
          const { output } = await answerQuestion(data.question, { mode: 'rag', signal: controller.signal })
          send(output.status === 'unavailable' ? 503 : 200, output)
        }
      } catch {
        send(503, { error: 'AI服务暂时不可用，你仍可正常游玩。' })
      } finally { active-- }
    } catch { send(400, { error: '请求格式错误。' }) }
  })
  const close = server.close.bind(server)
  server.close = callback => {
    clearInterval(ticker); rooms.close(); server.closeAllConnections()
    return close(callback)
  }
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.COACH_PORT || 3001)
  const allowedOrigins = (process.env.GAME_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(value => {
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && url.origin === value } catch { return false }
  })
  const { SqliteRoomStore } = await import('./rooms/store.ts')
  const roomStore = new SqliteRoomStore(process.env.GAME_ROOM_DB || fileURLToPath(new URL('../data/rooms.sqlite', import.meta.url)))
  const server = createCoachServer({ allowedOrigins, roomStore })
  const shutdown = () => server.close(() => { process.exitCode = 0 })
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
  server.listen(port, '127.0.0.1', () => console.log(`游戏AI与房间服务已启动：http://127.0.0.1:${port}（SQLite自动保存）`))
}
