import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { answerQuestion } from '../server/rag/coach.ts'
import { loadKnowledge, retrieve } from '../server/rag/knowledge.ts'
import { modelConfig } from '../server/providers/chat.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const outputDir = resolve(root, 'docs/experiment5')
await mkdir(outputDir, { recursive: true })
const chunks = await loadKnowledge()
const questions = JSON.parse(await readFile(resolve(root, 'eval/rules-questions.json'), 'utf8'))
const config = modelConfig()
const mode = process.argv[2] || 'compare'
const records: unknown[] = []

async function run(id: string, question: string, settings: Parameters<typeof answerQuestion>[1]) {
  const result = await answerQuestion(question, { chunks, config, ...settings })
  records.push({ id, question, ...result.trace })
  console.log(`${id} ${settings?.mode ?? 'rag'} ${result.output.status} ${result.output.elapsedMs}ms ${result.output.errorCode ?? ''}`)
  return result
}

if (mode === 'compare') {
  for (const q of questions) for (const group of ['direct', 'rag'] as const) await run(q.id, q.question, { mode: group })
} else if (mode === 'prompt') {
  // 保持问题、检索结果和主要参数相同，仅修改系统模板。
  for (const q of questions.filter((q: any) => ['Q6', 'Q7', 'Q8'].includes(q.id))) {
    await run(`${q.id}-v1`, q.question, { mode: 'rag', version: 'v1' })
    await run(`${q.id}-v2`, q.question, { mode: 'rag', version: 'v2' })
  }
} else if (mode === 'context') {
  const q = questions.find((q: any) => q.kind === 'multi')
  const allContext = chunks.map(chunk => ({ chunk, score: 1, matchedTerms: ['全文基线'] }))
  // 全文基线与Top-k使用同一模板；后者正是服务日常采用的输入。
  const { buildMessages } = await import('../server/rag/prompts.ts')
  const { callModel, requestBody } = await import('../server/providers/chat.ts')
  const { validateAnswer } = await import('../server/rag/coach.ts')
  for (const [id, hits] of [['full', allContext], ['top3', retrieve(chunks, q.question, 3)]] as const) {
    const messages = buildMessages(q.question, hits, 'rag', 'v2')
    const start = performance.now()
    try {
      const response = await callModel(messages, config)
      const output = validateAnswer(response.content, hits, 'rag')
      records.push({ id, question: q.question, messages, request: requestBody(messages, config), inputCharacters: messages.reduce((n, m) => n + m.content.length, 0),
        rawContent: response.content, output, model: response.model, usage: response.usage, elapsedMs: Math.round(performance.now() - start), calls: 1, sources: hits.map(h => h.chunk.id) })
      console.log(`${id} answered ${Math.round(performance.now() - start)}ms`)
    } catch (error: any) {
      records.push({ id, question: q.question, messages, inputCharacters: messages.reduce((n, m) => n + m.content.length, 0), errorCode: error.code, usage: null, elapsedMs: Math.round(performance.now() - start), calls: 1 })
      console.log(`${id} unavailable ${error.code}`)
    }
  }
} else if (mode === 'failure') {
  await run('cloud-connection-check', '瞬移到终点会立刻结算吗？', { mode: 'rag' })
  await run('connection-refused', '瞬移到终点会立刻结算吗？', { mode: 'rag', config: { ...config, baseUrl: 'http://127.0.0.1:1', apiKey: 'local-fault-test', timeoutMs: 1000 } })
} else throw new Error('参数应为compare、prompt、context或failure')

const path = resolve(outputDir, `${mode}-results.json`)
await writeFile(path, JSON.stringify({ recordedAt: new Date().toISOString(), model: config.model, parameters: { temperature: 0, max_tokens: 600, enable_thinking: false }, records }, null, 2), 'utf8')
console.log(`结果已保存：docs/experiment5/${mode}-results.json`)
