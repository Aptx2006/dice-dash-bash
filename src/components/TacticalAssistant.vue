<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { GameState } from '../game/types.ts'
import type { TacticalRunEvent, TacticalRunResult, TacticalRunStatus } from '../agent/types.ts'
import { activePlayer } from '../game/engine.ts'
import { createTacticalSnapshot, inspectTacticalAction, listTacticalActions, tacticalSnapshotKey } from '../game/tactical.ts'
import { createTacticalConfirmation, resolveTacticalConfirmation, type TacticalConfirmation } from '../game/tacticalConfirmation.ts'

const props = defineProps<{ state: GameState; myId: string; canInteract: boolean }>()
const emit = defineEmits<{ applied: [] }>()
const open = ref(false)
const goal = ref('尽快接近终点')
const loading = ref(false)
const feedback = ref('')
const run = shallowRef<TacticalRunResult | null>(null)
const confirmation = ref<TacticalConfirmation | null>(null)
const now = ref(Date.now())
const goals = ['尽快接近终点', '优先避开危险', '比较可用移动方案']
const labels: Record<TacticalRunStatus, string> = {
  awaiting_confirmation: '有一个行动建议', no_actions: '暂无可分析行动', unavailable: '助手暂时不可用',
  failed: '本次分析未完成', step_limit: '已达到分析步数上限', timeout: '分析已超时', cancelled: '已取消分析',
}
let sequence = 0
let controller: AbortController | null = null
let requestTimer: ReturnType<typeof setTimeout> | undefined
let clockTimer: ReturnType<typeof setInterval> | undefined
let requestedKey = ''
const currentKey = computed(() => tacticalSnapshotKey(props.state))
const eligible = computed(() => props.canInteract && props.state.phase === 'action' && !props.state.pendingReward && activePlayer(props.state).id === props.myId)
const pending = computed(() => confirmation.value?.status === 'pending')
const inspection = computed(() => pending.value && confirmation.value
  ? inspectTacticalAction(props.state, props.myId, confirmation.value.actionId) : null)
const secondsLeft = computed(() => Math.max(0, Math.ceil(((confirmation.value?.expiresAt ?? 0) - now.value) / 1000)))
const citedSources = computed(() => run.value?.sources.filter(source => run.value?.proposal?.sourceIds.includes(source.id)) ?? [])
const availability = computed(() => {
  if (props.state.finished) return '本局已经结束，开始新对局后再来分析。'
  if (activePlayer(props.state).id !== props.myId) return '等待其他选手完成回合。'
  if (props.state.pendingReward) return '先选好奖励，再分析接下来的行动。'
  if (props.state.phase !== 'action') return '投骰进入行动阶段后，可以请助手比较下一步。'
  if (!props.canInteract) return '等待当前动画播放完毕。'
  return '分析移动、冲刺、瞬步与瞬移。你确认后才会出牌。'
})

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-response')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length <= max }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 }
function readRun(value: unknown): TacticalRunResult {
  const result = record(value)
  if (typeof result.status !== 'string' || !Object.hasOwn(labels, result.status) || !text(result.reason, 2000) ||
    !text(result.runId, 100) || !text(result.model, 100) || !count(result.steps) || !count(result.elapsedMs) ||
    !Array.isArray(result.sources) || result.sources.length > 24 || !Array.isArray(result.events) || result.events.length > 100) throw new Error('invalid-response')
  const sources = result.sources.map(value => {
    const source = record(value)
    if (!text(source.id, 100) || !text(source.title, 300) || !text(source.text, 10000) || !text(source.source, 300) ||
      !Array.isArray(source.sourceLines) || source.sourceLines.length !== 2 || !source.sourceLines.every(count)) throw new Error('invalid-source')
    return source as unknown as TacticalRunResult['sources'][number]
  })
  const events = result.events.map(value => {
    const event = record(value)
    if (!count(event.id) || !count(event.step) || !count(event.durationMs) || !text(event.time, 100) ||
      !['model', 'tool', 'validation', 'stop'].includes(String(event.kind)) || !['ok', 'error'].includes(String(event.status)) ||
      !text(event.title, 300) || !text(event.detail, 5000) || (event.toolName !== undefined && !text(event.toolName, 100)) ||
      (event.errorCode !== undefined && !text(event.errorCode, 100))) throw new Error('invalid-event')
    return event as unknown as TacticalRunEvent
  })
  let proposal: TacticalRunResult['proposal']
  if (result.status === 'awaiting_confirmation') {
    const p = record(result.proposal)
    const sourceIds = new Set(sources.map(source => source.id))
    if (!text(p.actionId, 200) || !p.actionId || !text(p.label, 300) || !text(p.reason, 2000) || !p.reason.trim() ||
      !count(p.expiresAt) || !Array.isArray(p.sourceIds) || p.sourceIds.length > 5 || !p.sourceIds.every(id => text(id, 100) && sourceIds.has(id))) throw new Error('invalid-proposal')
    proposal = p as unknown as TacticalRunResult['proposal']
  }
  let usage: TacticalRunResult['usage'] = null
  if (result.usage != null) {
    const u = record(result.usage)
    if (![u.prompt_tokens, u.completion_tokens, u.total_tokens].every(count)) throw new Error('invalid-usage')
    usage = u as unknown as TacticalRunResult['usage']
  }
  return { runId: result.runId, status: result.status as TacticalRunStatus, reason: result.reason, model: result.model,
    steps: result.steps, elapsedMs: result.elapsedMs, sources, events, proposal, usage }
}

function stopWaiting(message: string) {
  sequence++
  controller?.abort()
  controller = null
  clearTimeout(requestTimer)
  loading.value = false
  feedback.value = message
}

function discard() {
  if (!confirmation.value) return
  feedback.value = resolveTacticalConfirmation(confirmation.value, 'reject', props.state, props.myId, props.canInteract).message
}

function close() {
  if (loading.value) stopWaiting('已取消分析。')
  if (pending.value) discard()
  open.value = false
}

async function analyze() {
  if (loading.value || !eligible.value) return
  const input = goal.value.trim()
  if (!input || input.length > 120) { feedback.value = '请用1至120字描述你的目标。'; return }
  if (!listTacticalActions(props.state, props.myId).length) { feedback.value = '当前没有可分析的移动类行动，可以继续手动使用其他牌。'; return }
  if (pending.value) discard()
  run.value = null
  confirmation.value = null
  feedback.value = ''
  requestedKey = currentKey.value
  const snapshot = createTacticalSnapshot(props.state, props.myId)
  const id = ++sequence
  const activeController = new AbortController()
  controller = activeController
  loading.value = true
  let timedOut = false
  requestTimer = setTimeout(() => { timedOut = true; activeController.abort() }, 50_000)
  try {
    const response = await fetch('/api/agent/tactical', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot, playerId: props.myId, goal: input }), signal: activeController.signal,
    })
    const body: unknown = await response.json()
    if (id !== sequence) return
    if (!response.ok) {
      if (response.status === 429) throw new Error('rate-limit')
      // 后端可用非2xx返回完整、已清理的Agent失败结果。
      if (!body || typeof body !== 'object' || !Object.hasOwn(body, 'runId')) throw new Error('service-unavailable')
    }
    const result = readRun(body)
    if (requestedKey !== currentKey.value || !eligible.value) { feedback.value = '局面已经改变，请重新分析。'; return }
    run.value = result
    if (result.proposal && result.status === 'awaiting_confirmation') {
      confirmation.value = createTacticalConfirmation(props.state, props.myId, result.proposal.actionId, requestedKey, result.proposal.expiresAt)
      if (!confirmation.value) feedback.value = '建议已过期或当前无法执行，请重新分析。'
    }
  } catch (error) {
    if (id !== sequence) return
    feedback.value = timedOut ? '分析等待超时，你可以重试或继续自己出牌。'
      : error instanceof Error && error.message === 'rate-limit' ? '分析请求较多，请稍后重试。'
      : '暂时无法取得战术建议，你仍然可以继续正常出牌。'
  } finally {
    if (id === sequence) { clearTimeout(requestTimer); controller = null; loading.value = false }
  }
}

function accept() {
  if (!confirmation.value) return
  const result = resolveTacticalConfirmation(confirmation.value, 'accept', props.state, props.myId, props.canInteract)
  feedback.value = result.message
  if (result.ok) emit('applied')
}

function resultText(value: unknown): string {
  try {
    const output = JSON.stringify(value, null, 2) ?? ''
    return output.length > 1800 ? `${output.slice(0, 1800)}\n…` : output
  } catch { return '结果无法展示。' }
}

watch([currentKey, () => props.canInteract], () => {
  if ((loading.value || pending.value) && (requestedKey !== currentKey.value || !eligible.value)) {
    if (loading.value) stopWaiting('局面已经改变，已取消本次分析。')
    if (confirmation.value?.status === 'pending') { confirmation.value.status = 'stale'; feedback.value = '局面已经改变，请重新分析再执行。' }
  }
}, { flush: 'sync' })

onMounted(() => {
  clockTimer = setInterval(() => {
    now.value = Date.now()
    if (confirmation.value?.status === 'pending' && now.value >= confirmation.value.expiresAt) {
      confirmation.value.status = 'expired'
      feedback.value = '建议已过期，请按当前局面重新分析。'
    }
  }, 1000)
})
onBeforeUnmount(() => {
  sequence++
  controller?.abort()
  clearTimeout(requestTimer)
  clearInterval(clockTimer)
  if (confirmation.value?.status === 'pending') confirmation.value.status = 'rejected'
})
</script>

<template>
  <div class="tactical-assistant">
    <button class="tactical-toggle" type="button" :aria-expanded="open" aria-controls="tactical-panel" @click="open ? close() : open = true">
      <span aria-hidden="true">✦</span> 战术助手 <span v-if="loading" class="tactical-dot" aria-label="正在分析"></span>
    </button>
    <section v-if="open" id="tactical-panel" class="tactical-panel" aria-label="战术助手" @keydown.esc.prevent="close">
      <header>
        <div><small>下一步怎么走</small><h2>战术助手</h2></div>
        <button type="button" class="tactical-close" aria-label="关闭战术助手" @click="close">×</button>
      </header>
      <p class="tactical-availability">{{ availability }}</p>
      <form @submit.prevent="analyze">
        <label for="tactical-goal">这一步的目标</label>
        <div class="tactical-goals">
          <button v-for="item in goals" :key="item" type="button" :class="{ selected: goal === item }" :disabled="loading" @click="goal = item">{{ item }}</button>
        </div>
        <input id="tactical-goal" v-model="goal" maxlength="120" :disabled="loading" placeholder="例如：优先避开危险" />
        <div class="tactical-buttons">
          <button v-if="loading" type="button" @click="stopWaiting('已取消分析，你可以继续出牌。')">取消分析</button>
          <button class="tactical-primary" type="submit" :disabled="loading || !eligible">{{ loading ? '正在比较行动…' : run ? '重新分析' : '分析当前局面' }}</button>
        </div>
      </form>
      <p v-if="loading" class="tactical-feedback" role="status">正在读取局面并查阅规则，最多等待45秒。你可以取消或直接继续出牌。</p>
      <p v-if="feedback" class="tactical-feedback" role="status">{{ feedback }}</p>
      <section v-if="pending && inspection && run?.proposal" class="tactical-proposal" aria-live="polite" aria-label="待确认的行动建议">
        <div class="tactical-proposal-heading"><strong>{{ inspection.action.label }}</strong><small>{{ secondsLeft }}秒内有效</small></div>
        <p>{{ run.proposal.reason }}</p>
        <p class="tactical-preview">{{ inspection.summary }}</p>
        <p v-for="warning in inspection.warnings" :key="warning" class="tactical-warning">{{ warning }}</p>
        <p class="tactical-confirm-copy">确认后将消耗对应手牌并执行这一步。</p>
        <div class="tactical-buttons"><button type="button" @click="discard">放弃</button><button type="button" class="tactical-primary" :disabled="!eligible || !secondsLeft" @click="accept">确认执行</button></div>
      </section>
      <p v-else-if="run && !feedback" class="tactical-feedback" role="status"><strong>{{ labels[run.status] }}</strong><br />{{ run.reason }}</p>
      <div v-if="citedSources.length" class="tactical-sources">
        <details v-for="source in citedSources" :key="source.id">
          <summary>{{ source.title }} <code>{{ source.id }}</code></summary>
          <p>{{ source.text }}</p>
        </details>
      </div>
      <details v-if="run" class="tactical-trace">
        <summary>查看分析过程 · {{ run.steps }}步 · {{ (run.elapsedMs / 1000).toFixed(1) }}秒</summary>
        <small class="tactical-run-id">任务 {{ run.runId }}</small>
        <ol><li v-for="event in run.events" :key="event.id" :class="{ error: event.status === 'error' }">
          <div><strong>{{ event.title }}</strong><small>第{{ event.step }}步 · {{ event.durationMs }}ms</small></div>
          <p>{{ event.detail }}</p>
          <details v-if="event.toolName || event.result !== undefined"><summary>工具与结果</summary><code>{{ event.toolName }}</code><pre v-if="event.args">{{ resultText(event.args) }}</pre><pre v-if="event.result !== undefined">{{ resultText(event.result) }}</pre></details>
          <small v-if="event.errorCode">{{ event.errorCode }}</small>
        </li></ol>
        <small v-if="run.usage">本次共{{ run.usage.total_tokens }} tokens · {{ run.model }}</small>
      </details>
    </section>
  </div>
</template>

<style scoped>
.tactical-assistant { position: absolute; inset: 0; z-index: 7; pointer-events: none; color: var(--ink, #34384c); font-size: .8rem; }
.tactical-assistant button, .tactical-assistant input, .tactical-panel { pointer-events: auto; }
.tactical-assistant button { border: 1px solid var(--line-strong, #d7cdbd); border-radius: 10px; padding: .48rem .7rem; background: #fffaf0; color: var(--navy, #34384c); font: inherit; cursor: pointer; }
.tactical-assistant button:disabled { cursor: default; opacity: .55; }
.tactical-assistant button:focus-visible, .tactical-assistant input:focus-visible, .tactical-assistant summary:focus-visible { outline: 3px solid #c1934a; outline-offset: 2px; }
.tactical-toggle { position: absolute; right: .9rem; bottom: 3.2rem; display: flex; align-items: center; gap: .4rem; box-shadow: 0 4px 12px #302d3015; font-weight: 700 !important; }
.tactical-toggle > span:first-child { color: #af7638; }
.tactical-dot { width: 7px; height: 7px; background: #3f9a62; border-radius: 50%; }
.tactical-panel { position: absolute; right: .9rem; top: 7rem; bottom: 6.2rem; width: min(352px, calc(100% - 1.8rem)); max-height: 600px; box-sizing: border-box; padding: 1rem; overflow-y: auto; overflow-wrap: anywhere; background: rgba(255, 250, 240, .98); border: 1px solid var(--line-strong, #d7cdbd); border-radius: 16px; box-shadow: 0 12px 42px #29233026; backdrop-filter: blur(10px); }
.tactical-panel header { display: flex; align-items: flex-start; justify-content: space-between; gap: .5rem; }
.tactical-panel h2 { font-size: 1.15rem; margin: .18rem 0 .6rem; }
.tactical-panel header small { font-size: .68rem; color: #8a7154; }
.tactical-assistant .tactical-close { font-size: 1.3rem; padding: .1rem .5rem; background: transparent; border-color: transparent; line-height: 1.2; }
.tactical-availability { font-size: .75rem; line-height: 1.6; color: var(--ink-dim, #656572); margin: 0 0 .75rem; }
.tactical-panel label { display: block; font-weight: 700; margin-bottom: .5rem; }
.tactical-goals { display: flex; flex-wrap: wrap; gap: .3rem; margin-bottom: .55rem; }
.tactical-goals button { font-size: .68rem; padding: .3rem .45rem; background: #f7efdf; }
.tactical-goals button.selected { border-color: #ae8147; background: #eddbbc; }
.tactical-panel input { width: 100%; min-width: 0; box-sizing: border-box; font: inherit; background: white; color: var(--ink, #34384c); border: 1px solid #d7cdbd; border-radius: 9px; padding: .6rem; }
.tactical-buttons { display: flex; justify-content: flex-end; gap: .5rem; margin-top: .65rem; }
.tactical-assistant .tactical-primary { color: #fffaf0; background: var(--navy, #34384c); border-color: var(--navy, #34384c); font-weight: 700; }
.tactical-feedback { margin: .8rem 0 0; border-radius: 10px; padding: .65rem; background: #f0ebdf; line-height: 1.65; }
.tactical-proposal { padding: .8rem; margin-top: .8rem; border: 1px solid #b6ccb5; border-radius: 12px; background: #f0f5e9; }
.tactical-proposal-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .3rem; }
.tactical-proposal-heading strong { font-size: .88rem; }
.tactical-proposal-heading small { color: #5f765e; }
.tactical-proposal p { font-size: .76rem; line-height: 1.6; margin: .55rem 0 0; }
.tactical-preview { color: #52654e; }
.tactical-warning { color: #955d28; }
.tactical-confirm-copy { font-weight: 700; }
.tactical-sources, .tactical-trace { margin-top: .7rem; font-size: .72rem; }
.tactical-sources details { padding: .5rem 0; border-top: 1px solid #ded8c8; }
.tactical-assistant summary { cursor: pointer; line-height: 1.6; }
.tactical-sources p { line-height: 1.7; white-space: pre-wrap; margin: .4rem 0; }
.tactical-assistant code { font-size: .65rem; color: #827362; }
.tactical-trace { border-top: 1px solid #d7cdbd; padding-top: .65rem; }
.tactical-run-id { display: block; margin-top: .4rem; color: #827362; }
.tactical-trace ol { padding-left: 1rem; margin: .5rem 0; }
.tactical-trace li { padding: .45rem 0; border-bottom: 1px dashed #ded8c8; }
.tactical-trace li > div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .2rem; }
.tactical-trace li p { margin: .3rem 0; line-height: 1.5; }
.tactical-trace li.error { color: #8e4a39; }
.tactical-trace pre { max-height: 160px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: .3rem 0; font-size: .65rem; background: #ebe6d9; padding: .4rem; border-radius: 6px; }
@media (max-width: 600px) {
  .tactical-panel { top: 6rem; bottom: 6rem; padding: .8rem; }
  .tactical-toggle { right: .7rem; bottom: 3rem; font-size: .73rem !important; padding: .4rem .55rem; }
}
@media (max-height: 520px) {
  .tactical-panel { position: fixed; inset: .5rem; width: auto; max-height: none; z-index: 20; }
}
</style>
