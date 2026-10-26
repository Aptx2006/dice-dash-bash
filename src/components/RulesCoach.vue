<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

type CoachStatus = 'answered' | 'clarify' | 'insufficient' | 'out_of_scope' | 'unavailable'
interface CoachSource {
  id: string
  title: string
  text: string
  source: string
  score: number
}
interface CoachAnswer {
  status: CoachStatus
  answer: string
  citations: string[]
  sources: CoachSource[]
  elapsedMs: number
}

const question = ref('')
const loading = ref(false)
const feedback = ref('')
const answer = ref<CoachAnswer | null>(null)
const submittedQuestion = ref('')
const suggestions = ['瞬移到终点会立刻结算吗？', '一回合为什么要结束两次？']
const citedIds = computed(() => new Set(answer.value?.citations ?? []))
const statusLabels: Record<CoachStatus, string> = {
  answered: '规则解答',
  clarify: '还需要一点信息',
  insufficient: '目前资料不足',
  out_of_scope: '请询问游戏规则',
  unavailable: '暂时无法回答',
}
let requestNumber = 0
let activeController: AbortController | null = null
let timeout: ReturnType<typeof setTimeout> | undefined

function readAnswer(value: unknown): CoachAnswer {
  if (value === null || typeof value !== 'object') throw new Error('invalid-response')
  const response = value as Record<string, unknown>
  if (typeof response.status !== 'string' || !Object.hasOwn(statusLabels, response.status) ||
    typeof response.answer !== 'string' || !response.answer.trim() ||
    !Array.isArray(response.citations) || !response.citations.every(id => typeof id === 'string') ||
    !Array.isArray(response.sources)) throw new Error('invalid-response')
  const sources: CoachSource[] = response.sources.map(value => {
    if (value === null || typeof value !== 'object') throw new Error('invalid-source')
    const source = value as Record<string, unknown>
    if (typeof source.id !== 'string' || typeof source.title !== 'string' ||
      typeof source.text !== 'string' || typeof source.source !== 'string' ||
      typeof source.score !== 'number' || !Number.isFinite(source.score)) throw new Error('invalid-source')
    return { id: source.id, title: source.title, text: source.text, source: source.source, score: source.score }
  })
  const sourceIds = new Set(sources.map(source => source.id))
  if (response.citations.some(id => !sourceIds.has(id))) throw new Error('invalid-citation')
  if (response.status === 'answered' && response.citations.length === 0) throw new Error('missing-citation')
  return {
    status: response.status as CoachStatus,
    answer: response.answer,
    citations: response.citations,
    sources,
    elapsedMs: typeof response.elapsedMs === 'number' && Number.isFinite(response.elapsedMs) ? response.elapsedMs : 0,
  }
}

async function ask() {
  if (loading.value) return
  const input = question.value.trim()
  if (!input) {
    feedback.value = '先写下你想了解的规则吧。'
    return
  }
  if (input.length > 300) {
    feedback.value = '问题请控制在300字以内。'
    return
  }
  feedback.value = ''
  answer.value = null
  submittedQuestion.value = input
  loading.value = true
  const sequence = ++requestNumber
  const controller = new AbortController()
  activeController = controller
  let timedOut = false
  timeout = setTimeout(() => { timedOut = true; controller.abort() }, 35000)
  try {
    const response = await fetch('/api/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: input, mode: 'rag' }),
      signal: controller.signal,
    })
    if (sequence !== requestNumber) return
    const result = readAnswer(await response.json())
    // 服务端会用503返回已清理的额度/超时提示；保留这种完整失败结果。
    if (!response.ok && result.status !== 'unavailable') throw new Error('service-unavailable')
    if (sequence !== requestNumber) return
    answer.value = result
  } catch {
    if (sequence !== requestNumber) return
    feedback.value = timedOut ? '等待时间有些长，请稍后重试。' : '规则教练暂时没有连上，请稍后重试；你仍然可以正常游玩。'
  } finally {
    if (sequence === requestNumber) {
      clearTimeout(timeout)
      activeController = null
      loading.value = false
    }
  }
}

function cancel() {
  requestNumber++
  activeController?.abort()
  activeController = null
  clearTimeout(timeout)
  loading.value = false
  feedback.value = '已取消，可以重新提问。'
}

function pickSuggestion(value: string) {
  if (loading.value) return
  question.value = value
  feedback.value = ''
}

onBeforeUnmount(() => {
  requestNumber++
  activeController?.abort()
  clearTimeout(timeout)
})
</script>

<template>
  <details class="rules-coach">
    <summary class="rules-coach__summary">
      <span class="rules-coach__badge" aria-hidden="true">?</span>
      <span><strong>规则教练</strong><small>不确定怎么出牌？问一问，再看看规则出处。</small></span>
      <span class="rules-coach__expand" aria-hidden="true">展开</span>
    </summary>
    <div class="rules-coach__content">
      <form class="rules-coach__form" @submit.prevent="ask">
        <label for="coach-question">想了解哪条规则？</label>
        <textarea id="coach-question" v-model="question" rows="2" maxlength="300" :disabled="loading"
          placeholder="例如：瞬移到终点会立刻结算吗？" aria-describedby="coach-question-limit" />
        <div class="rules-coach__suggestions" aria-label="试试这些问题">
          <button v-for="item in suggestions" :key="item" type="button" :disabled="loading" @click="pickSuggestion(item)">{{ item }}</button>
        </div>
        <div class="rules-coach__actions">
          <small id="coach-question-limit">{{ question.length }}/300字</small>
          <button v-if="loading" type="button" class="text-button" @click="cancel">取消等待</button>
          <button type="submit" class="pill-button primary" :disabled="loading">{{ loading ? '正在查阅规则…' : '询问教练' }}</button>
        </div>
      </form>
      <p v-if="loading" class="rules-coach__feedback" role="status">正在查阅与你的问题有关的规则，请稍候。</p>
      <p v-if="feedback" class="rules-coach__feedback" role="status">{{ feedback }}</p>
      <section v-if="answer" class="rules-coach__answer" aria-live="polite" aria-label="教练回答">
        <div class="rules-coach__answer-title">
          <strong>{{ statusLabels[answer.status] }}</strong>
          <small v-if="answer.elapsedMs > 0">用时{{ (answer.elapsedMs / 1000).toFixed(1) }}秒</small>
        </div>
        <p class="rules-coach__asked">你的问题：{{ submittedQuestion }}</p>
        <p class="rules-coach__answer-text">{{ answer.answer }}</p>
        <button v-if="answer.status === 'unavailable'" type="button" class="pill-button" :disabled="loading" @click="ask">重新尝试</button>
        <div v-if="answer.sources.length" class="rules-coach__sources" aria-label="规则出处">
          <p>规则出处 · 展开查看原文</p>
          <details v-for="source in answer.sources" :key="source.id" class="rules-coach__source">
            <summary><strong>{{ source.title }}</strong><span v-if="citedIds.has(source.id)">已引用</span><code>{{ source.id }}</code></summary>
            <p>{{ source.text }}</p>
          </details>
        </div>
      </section>
    </div>
  </details>
</template>
