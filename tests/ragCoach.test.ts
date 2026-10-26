import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request, type Server } from 'node:http'
import { callModel, ModelError, type ChatConfig, type ChatMessage } from '../server/providers/chat.ts'
import { answerQuestion, validateAnswer } from '../server/rag/coach.ts'
import { createCoachServer } from '../server/index.ts'
import type { KnowledgeChunk, RetrievalHit } from '../server/rag/knowledge.ts'

// 本文件只使用合成夹具、mock fetch和回环HTTP。不会读取密钥或调用真实云模型。
const config: ChatConfig = { baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-test-only', model: 'test-json-model', timeoutMs: 500 }
const messages: ChatMessage[] = [{ role: 'system', content: '请输出JSON对象。' }, { role: 'user', content: '瞬移到终点会结算吗？' }]
const chunk: KnowledgeChunk = {
  id: 'tool.teleport', title: '瞬移与终点结算',
  text: '瞬移可以选择合法落点；到达终点立即结束对局并结算。',
  source: 'knowledge/synthetic-test.md', sourceLines: [1, 3], rulesVersion: 'local-v1', keywords: ['瞬移', '终点', '结算'],
}
const hits: RetrievalHit[] = [{ chunk, score: 4, matchedTerms: ['瞬移', '终点'] }]
const answered = JSON.stringify({ status: 'answered', answer: '瞬移抵达终点后会立即结算。', citations: ['tool.teleport'] })

function completion(content = answered) {
  return new Response(JSON.stringify({
    id: 'synthetic-completion', model: 'test-json-model',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 },
  }), { status: 200, headers: { 'Content-Type': 'application/json', 'x-request-id': 'synthetic-request' } })
}
function modelCode(code: string) {
  return (error: unknown) => error instanceof ModelError && error.code === code
}
async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return address.port
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
async function localRequest(port: number, options: { path?: string; method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: options.path ?? '/api/coach', method: options.method ?? 'POST', headers: options.headers ?? { 'Content-Type': 'application/json' } }, res => {
      let text = ''
      res.on('data', value => { text += value.toString('utf8') })
      res.on('end', () => { try { resolve({ status: res.statusCode!, body: JSON.parse(text) }) } catch (error) { reject(error) } })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(options.body ?? JSON.stringify({ question: '瞬移到终点会结算吗？', mode: 'rag' }))
  })
}

test('模拟模型HTTP成功：保留JSON内容、Token用量和请求编号', async context => {
  let sentBody: any
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    sentBody = JSON.parse(String(init.body))
    return completion()
  })
  const result = await callModel(messages, config)
  assert.equal(result.content, answered)
  assert.equal(result.requestId, 'synthetic-request')
  assert.deepEqual(result.usage, { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 })
  assert.equal(sentBody.model, config.model)
  assert.equal(sentBody.temperature, 0)
  assert.deepEqual(sentBody.response_format, { type: 'json_object' })
})

test('RAG模块成功：检索、模型JSON、有效引用和上下文轨迹形成闭环', async context => {
  context.mock.method(globalThis, 'fetch', async () => completion())
  const result = await answerQuestion('瞬移到终点会立刻结算吗？', { config, chunks: [chunk] })
  assert.equal(result.output.status, 'answered')
  assert.deepEqual(result.output.citations, ['tool.teleport'])
  assert.equal(result.output.sources[0].text, chunk.text)
  assert.equal(result.trace.calls, 1)
  assert.match(result.trace.messages[1].content, /tool\.teleport/)
  assert.match(result.trace.messages[1].content, /用户问题/)
  assert.equal(JSON.stringify(result.trace).includes(config.apiKey), false)
})

test('输出验证拒绝错误JSON、缺失字段和过长回答', () => {
  for (const raw of ['not-json', '[]', '{}', JSON.stringify({ status: 'answered', answer: '答案', citations: 'tool.teleport' }),
    JSON.stringify({ status: 'answered', answer: '一'.repeat(261), citations: ['tool.teleport'] })]) {
    assert.throws(() => validateAnswer(raw, hits, 'rag'), modelCode('INVALID_OUTPUT'))
  }
})

test('输出验证拒绝缺引用、伪造引用，以及非回答状态或直接模型组附带引用', () => {
  for (const raw of [
    JSON.stringify({ status: 'answered', answer: '答案', citations: [] }),
    JSON.stringify({ status: 'answered', answer: '答案', citations: ['invented-rule'] }),
    JSON.stringify({ status: 'insufficient', answer: '资料不足', citations: ['tool.teleport'] }),
  ]) assert.throws(() => validateAnswer(raw, hits, 'rag'), modelCode('INVALID_CITATION'))
  assert.throws(() => validateAnswer(answered, [], 'direct'), modelCode('INVALID_CITATION'))
  assert.equal(validateAnswer(JSON.stringify({ status: 'clarify', answer: '请补充道具名称。', citations: [] }), [], 'rag').status, 'clarify')
  assert.equal(validateAnswer(JSON.stringify({ status: 'answered', answer: '直接回答', citations: [] }), [], 'direct').status, 'answered')
  assert.equal(validateAnswer(JSON.stringify({ status: 'answered', answer: '我猜积分为100。', citations: ['fake'] }), [], 'rag').status, 'insufficient')
})

test('RAG模块把模型伪造引用转为可展示失败，不放行无效答案', async context => {
  context.mock.method(globalThis, 'fetch', async () => completion(JSON.stringify({ status: 'answered', answer: '错误引用答案', citations: ['invented-rule'] })))
  const result = await answerQuestion('瞬移到终点会结算吗？', { config, chunks: [chunk] })
  assert.equal(result.output.status, 'unavailable')
  assert.equal(result.output.errorCode, 'INVALID_CITATION')
  assert.deepEqual(result.output.citations, [])
  assert.notEqual(result.output.answer, '错误引用答案')
})

test('缺少模型密钥时在发起HTTP前返回NOT_CONFIGURED', async context => {
  let requests = 0
  context.mock.method(globalThis, 'fetch', async () => { requests++; return completion() })
  await assert.rejects(callModel(messages, { ...config, apiKey: '' }), modelCode('NOT_CONFIGURED'))
  assert.equal(requests, 0)
})

test('模拟上游HTTP429：返回限流错误码，不泄露原始错误体', async context => {
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: { code: 'RateLimitExceeded', message: 'synthetic-private-upstream-details' } }), { status: 429 }))
  await assert.rejects(callModel(messages, config), (error: unknown) => {
    assert.ok(error instanceof ModelError)
    assert.equal(error.code, 'RateLimitExceeded')
    assert.equal(error.httpStatus, 429)
    assert.equal(error.message.includes('synthetic-private-upstream-details'), false)
    return true
  })
})

test('模拟上游返回无法解析的HTTP数据或截断输出时拒绝使用', async context => {
  const queue = [new Response('broken-body', { status: 200 }),
    new Response(JSON.stringify({ choices: [{ message: { content: answered }, finish_reason: 'length' }] }), { status: 200 })]
  context.mock.method(globalThis, 'fetch', async () => queue.shift()!)
  await assert.rejects(callModel(messages, config), modelCode('INVALID_RESPONSE'))
  await assert.rejects(callModel(messages, config), modelCode('INVALID_RESPONSE'))
})

test('模拟挂起的模型请求达到超时预算后返回TIMEOUT', async context => {
  // AbortSignal.timeout的计时器不会单独维持Node进程，保留短暂测试计时器。
  const keepAlive = setTimeout(() => {}, 1000)
  context.after(() => clearTimeout(keepAlive))
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    const signal = init.signal!
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  await assert.rejects(callModel(messages, { ...config, timeoutMs: 20 }), modelCode('TIMEOUT'))
})

test('用户取消请求返回CANCELLED，区别于超时', async context => {
  context.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
    const signal = init.signal!
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), 10)
  context.after(() => clearTimeout(abortTimer))
  await assert.rejects(callModel(messages, config, controller.signal), modelCode('CANCELLED'))
})

test('真实回环连接失败：已关闭端口返回CONNECTION_FAILED，不访问云端', async () => {
  const server = createServer()
  const port = await listen(server)
  await close(server)
  await assert.rejects(callModel(messages, { ...config, baseUrl: `http://127.0.0.1:${port}` }), modelCode('CONNECTION_FAILED'))
})

test('本地HTTP接口验证健康状态、JSON输入限制和外部Origin拒绝', async context => {
  const server = createCoachServer(), port = await listen(server)
  context.after(() => close(server))
  // 所有提问都在输入校验处结束；本用例不会进入真实模型调用。
  const health = await localRequest(port, { path: '/api/health', method: 'GET', body: '', headers: { Origin: 'http://localhost:5173' } })
  assert.equal(health.status, 200)
  assert.equal(health.body.ok, true)
  const external = await localRequest(port, { headers: { 'Content-Type': 'application/json', Origin: 'https://external.invalid' } })
  assert.equal(external.status, 403)
  assert.equal((await localRequest(port, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
  for (const body of ['{broken', JSON.stringify({ question: '' }), JSON.stringify({ question: ' '.repeat(8) }),
    JSON.stringify({ question: '一'.repeat(301) }), JSON.stringify({ question: 42 }),
    JSON.stringify({ question: '瞬移到终点？', mode: 'direct' })]) {
    assert.equal((await localRequest(port, { body })).status, 400)
  }
  assert.equal((await localRequest(port, { body: JSON.stringify({ question: 'q'.repeat(5000) }) })).status, 413)
  assert.equal((await localRequest(port, { path: '/missing' })).status, 404)
})
