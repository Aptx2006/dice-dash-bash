import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { callModel, modelConfig, ModelError, requestBody, type ChatConfig, type ChatMessage, type TokenUsage } from '../providers/chat.ts'
import { loadKnowledge, retrieve, type KnowledgeChunk, type RetrievalHit } from './knowledge.ts'
import { buildMessages, type AnswerMode, type PromptVersion } from './prompts.ts'

export type AnswerStatus = 'answered' | 'clarify' | 'insufficient' | 'out_of_scope' | 'unavailable'
export interface CoachOutput {
  status: AnswerStatus; answer: string; citations: string[]
  sources: { id: string; title: string; text: string; source: string; score: number }[]
  model: string | null; elapsedMs: number; usage: TokenUsage | null; requestId: string; errorCode?: string
}
interface CoachOptions { mode?: AnswerMode; version?: PromptVersion; chunks?: KnowledgeChunk[]; config?: ChatConfig; signal?: AbortSignal; extraContext?: string }

export function validateAnswer(raw: string, hits: RetrievalHit[], mode: AnswerMode): Pick<CoachOutput, 'status' | 'answer' | 'citations'> {
  let data: any
  try { data = JSON.parse(raw) } catch { throw new ModelError('INVALID_OUTPUT', '回答格式不符合要求，请重试。') }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !['answered', 'clarify', 'insufficient', 'out_of_scope'].includes(data.status)
    || typeof data.answer !== 'string' || !data.answer.trim() || data.answer.length > 260
    || !Array.isArray(data.citations) || data.citations.length > 3 || !data.citations.every((id: unknown) => typeof id === 'string')) {
    throw new ModelError('INVALID_OUTPUT', '回答格式不符合要求，请重试。')
  }
  const ids = new Set(hits.map(h => h.chunk.id))
  const citations: string[] = [...new Set<string>(data.citations)]
  if (mode === 'rag' && !hits.length && data.status === 'answered') {
    return { status: 'insufficient', answer: '当前规则资料中没有可支持该问题的依据，暂时无法确认。请补充具体规则信息。', citations: [] }
  }
  if ((mode === 'direct' && citations.length) || (data.status !== 'answered' && citations.length)
    || (mode === 'rag' && (citations.some(id => !ids.has(id)) || (data.status === 'answered' && !citations.length)))) {
    throw new ModelError('INVALID_CITATION', '回答的规则出处无法核对，请重试。')
  }
  return { status: data.status, answer: data.answer.trim(), citations }
}

export async function answerQuestion(question: string, options: CoachOptions = {}) {
  const started = performance.now(), requestId = randomUUID()
  const mode = options.mode ?? 'rag', version = options.version ?? 'v2'
  const config = options.config ?? modelConfig()
  let hits: RetrievalHit[] = [], messages: ChatMessage[] = []
  let rawContent: string | null = null, usage: TokenUsage | null = null, calls = 0, upstreamId: string | null = null, httpStatus: number | null = null
  let output: CoachOutput
  try {
    if (typeof question !== 'string' || !question.trim() || question.length > 300) throw new ModelError('INVALID_INPUT', '请输入1至300字的规则问题。')
    const chunks = options.chunks ?? await loadKnowledge()
    hits = mode === 'rag' ? retrieve(chunks, question.trim(), 3) : []
    messages = buildMessages(question.trim(), hits, mode, version, options.extraContext)
    calls = 1
    const completion = await callModel(messages, config, options.signal)
    httpStatus = 200
    rawContent = completion.content;usage = completion.usage;upstreamId = completion.requestId
    const answer = validateAnswer(completion.content, hits, mode)
    output = { ...answer, sources: hits.map(h => ({ id: h.chunk.id, title: h.chunk.title, text: h.chunk.text, source: h.chunk.source, score: h.score })),
      model: completion.model, elapsedMs: 0, usage, requestId }
  } catch (error) {
    const known = error instanceof ModelError ? error : new ModelError('KNOWLEDGE_UNAVAILABLE', '规则资料暂时不可用，请稍后重试。')
    httpStatus = known.httpStatus ?? httpStatus
    if (['NOT_CONFIGURED', 'INVALID_CONFIG', 'INVALID_INPUT', 'KNOWLEDGE_UNAVAILABLE'].includes(known.code)) calls = 0
    output = { status: 'unavailable', answer: known.message, citations: [], sources: [], model: config.model, elapsedMs: 0, usage, requestId, errorCode: known.code }
  }
  output.elapsedMs = Math.round(performance.now() - started)
  // 仅保存合成测试数据时由实验脚本写入；日常用户问题不自动写磁盘。
  let endpoint = 'invalid-config'
  try { const url = new URL(config.baseUrl);endpoint = url.origin + url.pathname } catch { /* 不记录可能带认证的原始字符串 */ }
  const trace = { requestId, mode, promptVersion: version, requestedModel: config.model, baseUrl: endpoint, httpStatus,
    retrieval: hits, messages, request: messages.length ? requestBody(messages, config) : null,
    rawContent, upstreamId, output, calls, inputCharacters: messages.reduce((n, m) => n + m.content.length, 0) }
  return { output, trace }
}
