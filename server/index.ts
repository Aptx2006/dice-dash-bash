import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { answerQuestion } from './rag/coach.ts'
import { runTacticalAgent } from './agent/harness.ts'
import { parseTacticalSnapshot } from '../src/game/tactical.ts'

export function createCoachServer(options: { tacticalAgent?: typeof runTacticalAgent } = {}) {
  let active = 0
  let windowStart = Date.now(), requests = 0
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    const send = (status: number, body: unknown) => { if (!res.destroyed) { res.statusCode = status;res.end(JSON.stringify(body)) } }
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return send(403, { error: '不接受此来源的请求。' })
    if (req.url === '/api/health' && req.method === 'GET') return send(200, { ok: true, service: 'game-ai', capabilities: ['rules-coach', 'tactical-agent'] })
    const tactical = req.url === '/api/agent/tactical'
    if ((!tactical && req.url !== '/api/coach') || req.method !== 'POST') return send(404, { error: '接口不存在。' })
    if (Date.now() - windowStart > 600000) { windowStart = Date.now();requests = 0 }
    if (active >= 2 || requests >= 30) return send(429, { error: '请求较多，请稍后重试。', status: 'unavailable', answer: '提问较多，请稍后重试。' })
    if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: '请使用JSON格式。' })
    const buffers: Buffer[] = []
    let bytes = 0
    try {
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > (tactical ? 98304 : 4096)) return send(413, { error: '请求内容过大。' })
        buffers.push(buffer)
      }
      const data = JSON.parse(Buffer.concat(buffers).toString('utf8'))
      if (!data || typeof data !== 'object' || Array.isArray(data)) return send(400, { error: '请求格式错误。' })
      let snapshot
      if (tactical) {
        if (Object.keys(data).some(key => !['snapshot', 'playerId', 'goal'].includes(key)) ||
          typeof data.playerId !== 'string' || data.playerId.length > 40 ||
          typeof data.goal !== 'string' || !data.goal.trim() || data.goal.length > 120) {
          return send(400, { error: '请输入1至120字的战术目标。' })
        }
        try { snapshot = parseTacticalSnapshot(data.snapshot) }
        catch { return send(400, { error: '对局数据无效，请回到当前对局重试。' }) }
        const current = snapshot.players[snapshot.activeIndex]
        if (current.id !== data.playerId || current.isAI || snapshot.phase !== 'action' || snapshot.finished || snapshot.pendingReward) {
          return send(400, { error: '战术助手仅在你的行动阶段可用。' })
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
        } else {
          const { output } = await answerQuestion(data.question, { mode: 'rag', signal: controller.signal })
          send(output.status === 'unavailable' ? 503 : 200, output)
        }
      } catch {
        send(503, { error: 'AI服务暂时不可用，你仍可正常游玩。' })
      } finally { active-- }
    } catch { send(400, { error: '请求格式错误。' }) }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.COACH_PORT || 3001)
  createCoachServer().listen(port, '127.0.0.1', () => console.log(`游戏AI服务已启动：http://127.0.0.1:${port}`))
}
