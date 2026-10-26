import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { answerQuestion } from './rag/coach.ts'

export function createCoachServer() {
  let active = 0
  let windowStart = Date.now(), requests = 0
  return createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    const send = (status: number, body: unknown) => { if (!res.destroyed) { res.statusCode = status;res.end(JSON.stringify(body)) } }
    const origin = req.headers.origin
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return send(403, { error: '不接受此来源的请求。' })
    if (req.url === '/api/health' && req.method === 'GET') return send(200, { ok: true, service: 'rules-coach' })
    if (req.url !== '/api/coach' || req.method !== 'POST') return send(404, { error: '接口不存在。' })
    if (Date.now() - windowStart > 600000) { windowStart = Date.now();requests = 0 }
    if (active >= 2 || requests >= 30) return send(429, { status: 'unavailable', answer: '提问较多，请稍后重试。' })
    if (!req.headers['content-type']?.startsWith('application/json')) return send(415, { error: '请使用JSON格式。' })
    const buffers: Buffer[] = []
    let bytes = 0
    try {
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > 4096) return send(413, { error: '问题过长。' })
        buffers.push(buffer)
      }
      const data = JSON.parse(Buffer.concat(buffers).toString('utf8'))
      if (!data || typeof data.question !== 'string' || !data.question.trim() || data.question.length > 300 || (data.mode && data.mode !== 'rag')) {
        return send(400, { error: '请输入1至300字的规则问题。' })
      }
      active++;requests++
      const controller = new AbortController()
      res.once('close', () => { if (!res.writableEnded) controller.abort() })
      try {
        const { output } = await answerQuestion(data.question, { mode: 'rag', signal: controller.signal })
        send(output.status === 'unavailable' ? 503 : 200, output)
      } finally { active-- }
    } catch { send(400, { error: '请求格式错误。' }) }
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.COACH_PORT || 3001)
  createCoachServer().listen(port, '127.0.0.1', () => console.log(`规则教练已启动：http://127.0.0.1:${port}`))
}
