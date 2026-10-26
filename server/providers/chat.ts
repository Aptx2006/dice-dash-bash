export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface TokenUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number }
export interface ChatConfig { baseUrl: string; apiKey: string; model: string; timeoutMs: number }
export class ModelError extends Error {
  code: string
  httpStatus?: number
  constructor(code: string, message: string, httpStatus?: number) { super(message);this.code = code;this.httpStatus = httpStatus }
}

export function modelConfig(): ChatConfig {
  const baseUrl = process.env.LLM_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
  let host = ''
  try { host = new URL(baseUrl).hostname } catch { /* callModel返回明确配置错误 */ }
  const providerKey = host === 'api.deepseek.com' ? process.env.DEEPSEEK_API_KEY : host.endsWith('.aliyuncs.com') ? process.env.DASHSCOPE_API_KEY : ''
  return {
    baseUrl,
    apiKey: process.env.LLM_API_KEY || providerKey || '',
    model: process.env.LLM_MODEL || 'qwen3.8-flash',
    timeoutMs: 15000,
  }
}

export function requestBody(messages: ChatMessage[], config: ChatConfig) {
  let bailian = false
  try { bailian = new URL(config.baseUrl).hostname.endsWith('.aliyuncs.com') } catch { /* 日志构造不因无效URL再次抛错 */ }
  return {
    model: config.model, messages, temperature: 0, max_tokens: 600,
    stream: false, response_format: { type: 'json_object' },
    ...(bailian ? { enable_thinking: false } : {}),
  }
}

export async function callModel(messages: ChatMessage[], config = modelConfig(), signal?: AbortSignal) {
  if (!config.apiKey) throw new ModelError('NOT_CONFIGURED', '规则教练暂未配置模型服务。')
  let url: URL
  try { url = new URL(config.baseUrl) } catch { throw new ModelError('INVALID_CONFIG', '模型服务地址配置无效。') }
  if (url.username || url.password || url.search || url.hash) throw new ModelError('INVALID_CONFIG', '模型服务地址不能包含认证或查询信息。')
  if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new ModelError('INVALID_CONFIG', '模型服务地址需要使用HTTPS。')
  }
  const body = requestBody(messages, config)
  const combinedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) : AbortSignal.timeout(config.timeoutMs)
  let response: Response
  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body), signal: combinedSignal, redirect: 'error',
    })
  } catch {
    if (signal?.aborted) throw new ModelError('CANCELLED', '已取消本次提问。')
    if (combinedSignal.aborted) throw new ModelError('TIMEOUT', '规则教练响应超时，请稍后重试。')
    throw new ModelError('CONNECTION_FAILED', '规则教练暂时无法连接，请稍后重试。')
  }
  let data: any
  try { data = await response.json() }
  catch {
    if (signal?.aborted) throw new ModelError('CANCELLED', '已取消本次提问。')
    if (combinedSignal.aborted) throw new ModelError('TIMEOUT', '规则教练响应超时，请稍后重试。')
    throw new ModelError('INVALID_RESPONSE', '模型服务返回了无法识别的数据。', response.status)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ModelError('INVALID_RESPONSE', '模型服务返回了无法识别的数据。', response.status)
  if (!response.ok) {
    // 只保留服务商的短错误码，不把可能包含隐私的原始错误体转发给前端。
    const upstreamCode = typeof data.error?.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(data.error.code) ? data.error.code : `HTTP_${response.status}`
    const message = upstreamCode === 'Arrearage' ? '规则教练的模型额度暂不可用，请稍后重试。' : '规则教练服务暂不可用，请稍后重试。'
    throw new ModelError(upstreamCode, message, response.status)
  }
  const content = data.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim() || data.choices?.[0]?.finish_reason === 'length') {
    throw new ModelError('INVALID_RESPONSE', '回答未完整生成，请稍后重试。', response.status)
  }
  const usage = data.usage && ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(k => Number.isSafeInteger(data.usage[k]) && data.usage[k] >= 0)
    ? { prompt_tokens: data.usage.prompt_tokens, completion_tokens: data.usage.completion_tokens, total_tokens: data.usage.total_tokens } as TokenUsage : null
  return { content, model: typeof data.model === 'string' ? data.model : config.model, usage,
    requestId: response.headers.get('x-request-id') || data.id || null, body }
}
