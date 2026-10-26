import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface KnowledgeChunk {
  id: string
  title: string
  text: string
  source: string
  sourceLines: [number, number]
  rulesVersion: string
  keywords: string[]
}

export interface RetrievalHit {
  chunk: KnowledgeChunk
  score: number
  matchedTerms: string[]
}

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const KNOWLEDGE_SOURCE = 'knowledge/rules-v1.md'
export const MIN_RETRIEVAL_SCORE = 2

/** 二级标题即完整规则；无跨标题截断、无片段重叠。 */
export function splitKnowledge(markdown: string, source = KNOWLEDGE_SOURCE): KnowledgeChunk[] {
  const cleaned = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  if (cleaned.includes('\uFFFD')) throw new Error('知识库含乱码替代字符，请核对原资料。')
  const version = cleaned.match(/^规则版本:\s*([^\n]+)$/m)?.[1].trim()
  if (!version) throw new Error('知识库缺少规则版本。')
  const lines = cleaned.split('\n')
  const headings = lines.flatMap((line, index) => /^## /.test(line) ? [index] : [])
  const ids = new Set<string>()
  const chunks: KnowledgeChunk[] = []
  for (let index = 0; index < headings.length; index++) {
    const start = headings[index], end = headings[index + 1] ?? lines.length
    const heading = lines[start].match(/^## ([a-z][a-z0-9.]+)\s*\|\s*(.+)$/)
    if (!heading || ids.has(heading[1])) throw new Error('知识库标题格式错误或规则编号重复。')
    ids.add(heading[1])
    const section = lines.slice(start + 1, end)
    const keywordLine = section.find(line => line.startsWith('关键词:'))
    const origin = section.find(line => line.startsWith('源码:'))
    const keywords = [...new Set((keywordLine?.slice(4) ?? '').split(/[，,]/).map(s => s.trim().toLowerCase()).filter(Boolean))]
    const paragraphs = section.filter(line => !/^(关键词|源码):/.test(line)).join('\n').trim()
    if (!keywords.length || !origin || !paragraphs) throw new Error(`规则${heading[1]}缺少关键词、源码依据或正文。`)
    // 保留正文来源依据，供引用展开；元数据关键词不会作为回答正文注入。
    const text = `${paragraphs}\n${origin}`
    let last = end - 1
    while (last > start && !lines[last].trim()) last--
    chunks.push({ id: heading[1], title: heading[2].trim(), text, source, sourceLines: [start + 1, last + 1], rulesVersion: version, keywords })
  }
  if (!chunks.length) throw new Error('知识库没有可索引的规则。')
  return chunks
}

export async function loadKnowledge(root = defaultRoot): Promise<KnowledgeChunk[]> {
  return splitKnowledge(await readFile(resolve(root, KNOWLEDGE_SOURCE), 'utf8'))
}

/**
 * 显式中文词组/同义词匹配，无外部Embedding依赖。
 * 关键词每次出现只记一次，去掉被更长已命中词包含的泛词；一般词组2分，4字及以上词组3分，标题命中额外1分。
 * 第一关键词为规则主体，完整命中后额外3分，避免“移动牌”等背景词挤掉“瞬移”这类直接询问的实体。
 * 只收录至少2字的词（以及完整英文标识），最低2分；没有已知规则实体就不检索。
 */
export function retrieve(chunks: KnowledgeChunk[], question: string, topK = 3): RetrievalHit[] {
  const query = question.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
  if (!query || !Number.isFinite(topK) || topK < 1) return []
  const limit = Math.min(5, Math.floor(topK))
  return chunks.map(chunk => {
    const matches = chunk.keywords.filter(keyword => {
      const term = keyword.normalize('NFKC').replace(/\s+/g, '')
      return term.length >= 2 && query.includes(term)
    })
    const matchedTerms = matches.filter(term => !matches.some(longer => longer !== term && longer.includes(term)))
    const title = chunk.title.normalize('NFKC').toLowerCase()
    const score = matchedTerms.reduce((sum, term) => sum + (term.length >= 4 ? 3 : 2) + (title.includes(term) ? 1 : 0), 0)
      + (matchedTerms.includes(chunk.keywords[0]) ? 3 : 0)
    return { chunk, score, matchedTerms }
  }).filter(hit => hit.score >= MIN_RETRIEVAL_SCORE)
    .sort((a, b) => b.score - a.score || a.chunk.id.localeCompare(b.chunk.id))
    .slice(0, limit)
}
