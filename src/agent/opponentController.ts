import { activePlayer } from '../game/engine.ts'
import { aiStep } from '../game/ai.ts'
import { createTacticalSnapshot, executeTacticalAction, inspectTacticalAction, listTacticalActions, tacticalSnapshotKey } from '../game/tactical.ts'
import type { AiDecisionRecord, AiTelemetry, GameState } from '../game/types.ts'
import type { OpponentDecision } from './opponentTypes.ts'

export interface OpponentRequest { snapshot: GameState; playerId: string }
export interface OpponentStepResult { acted: boolean; decision?: AiDecisionRecord; cancelled?: boolean }
export interface OpponentControllerOptions {
  request?: (input: OpponentRequest, signal: AbortSignal) => Promise<OpponentDecision>
  /** 只允许缩小默认6秒网络等待上限，HTTP调用方不能设置此项。 */
  timeoutMs?: number
  /** 服务端通过同步入口注入房间随机流；浏览器默认沿用本地引擎。 */
  rulesStep?: typeof aiStep
  executeAction?: typeof executeTacticalAction
}

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max }
function count(value: unknown, max = 60000): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max }

/** 只接收受限的公开决策；不允许响应体成为可调用命令或直接状态补丁。 */
function validDecision(value: unknown): value is OpponentDecision {
  if (!object(value) || !['ready', 'fallback', 'cancelled'].includes(String(value.status)) || !text(value.runId, 100)
    || !text(value.reason, 2000) || !text(value.model, 100) || !count(value.steps, 4) || !count(value.elapsedMs)
    || !Array.isArray(value.sources) || value.sources.length > 20 || !Array.isArray(value.sourceIds) || value.sourceIds.length > 3
    || !Array.isArray(value.events) || value.events.length > 40) return false
  const sources = new Set<string>()
  for (const source of value.sources) {
    if (!object(source) || !text(source.id, 80) || !text(source.title, 300) || !text(source.text, 10000)
      || !text(source.source, 300) || !Array.isArray(source.sourceLines) || source.sourceLines.length !== 2
      || !source.sourceLines.every(line => count(line, 100000))) return false
    sources.add(source.id)
  }
  if (!value.sourceIds.every(id => typeof id === 'string' && /^[a-z][a-z0-9.]{0,79}$/.test(id) && sources.has(id))
    || new Set(value.sourceIds).size !== value.sourceIds.length) return false
  if (value.status === 'ready' && (!text(value.actionId, 120) || value.sourceIds.length === 0)) return false
  if (value.fallbackReason !== undefined && !text(value.fallbackReason, 80)) return false
  return true
}

async function requestOpponent(input: OpponentRequest, signal: AbortSignal): Promise<OpponentDecision> {
  const response = await fetch('/api/agent/opponent', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
  })
  if (!response.ok) throw new Error(response.status === 429 ? 'RATE_LIMIT' : 'SERVICE_UNAVAILABLE')
  const result: unknown = await response.json()
  if (!validDecision(result)) throw new Error('INVALID_RESPONSE')
  return result
}

function telemetry(state: GameState): AiTelemetry {
  return state.aiTelemetry ??= { requests: 0, modelSuccess: 0, fallbacks: 0, recent: [] }
}

/** 固定排序的降级策略：优先终点、避免死亡地形，然后缩短本步后的静态距离。 */
export function chooseFallbackAction(state: GameState, playerId: string) {
  return listTacticalActions(state, playerId).flatMap(action => {
    const preview = inspectTacticalAction(state, playerId, action.actionId)
    return preview ? [{ action, preview, dangerous: preview.warnings.some(warning => warning.includes('危险地形')) }] : []
  }).sort((a, b) => Number(b.preview.finished) - Number(a.preview.finished)
    || Number(a.dangerous) - Number(b.dangerous)
    || a.preview.distanceAfter - b.preview.distanceAfter
    || (a.action.actionId < b.action.actionId ? -1 : a.action.actionId > b.action.actionId ? 1 : 0))[0]
}

export function createOpponentController(options: OpponentControllerOptions = {}) {
  const request = options.request ?? requestOpponent
  const rulesStep = options.rulesStep ?? aiStep
  const executeAction = options.executeAction ?? executeTacticalAction
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.max(1, Math.min(6000, options.timeoutMs!)) : 6000
  let disposed = false
  let sequence = 0
  let active: { state: GameState; controller: AbortController; id: number; timedOut: boolean } | null = null
  const cancel = () => { sequence++; active?.controller.abort(); active = null }

  async function step(state: GameState, context: { signal?: AbortSignal } = {}): Promise<OpponentStepResult> {
    if (disposed || context.signal?.aborted) return { acted: false, cancelled: true }
    if (active) {
      if (active.state === state) return { acted: false }
      cancel()
    }
    const actor = activePlayer(state)
    if (state.finished || !actor?.isAI) return { acted: false }
    const stats = state.aiTelemetry
    const attempted = stats?.lastAttempt?.turnNumber === state.turnNumber && stats.lastAttempt.playerId === actor.id
    if (state.aiMode !== 'cloud' || state.phase !== 'action' || state.pendingReward || attempted
      || listTacticalActions(state, actor.id).length < 2) return { acted: rulesStep(state) }

    const expectedKey = tacticalSnapshotKey(state)
    const turnNumber = state.turnNumber, playerId = actor.id
    const input = { snapshot: createTacticalSnapshot(state, playerId), playerId }
    const counters = telemetry(state)
    // 请求前同步占位；对局自动保存后，即使刷新也不会再调用本回合的云端模型。
    counters.requests++
    counters.lastAttempt = { turnNumber, playerId }
    const current = { state, controller: new AbortController(), id: ++sequence, timedOut: false }
    active = current
    const started = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    let result: OpponentDecision | undefined
    let failure = 'SERVICE_UNAVAILABLE'
    const onAbort = () => current.controller.abort()
    context.signal?.addEventListener('abort', onAbort, { once: true })
    let stopWaiting: (() => void) | undefined
    try {
      try {
        result = await new Promise<OpponentDecision>((resolve, reject) => {
          stopWaiting = () => reject(new Error('CANCELLED'))
          current.controller.signal.addEventListener('abort', stopWaiting, { once: true })
          timer = setTimeout(() => {
            current.timedOut = true
            reject(new Error('TIMEOUT'))
            current.controller.abort()
          }, timeoutMs)
          Promise.resolve().then(() => request(input, current.controller.signal)).then(resolve, reject)
        })
        if (!validDecision(result)) { failure = 'INVALID_RESPONSE'; result = undefined }
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        failure = ['TIMEOUT', 'RATE_LIMIT', 'INVALID_RESPONSE'].includes(code) ? code : 'SERVICE_UNAVAILABLE'
      }
      if (disposed || active !== current || current.id !== sequence || context.signal?.aborted
        || (current.controller.signal.aborted && !current.timedOut)) return { acted: false, cancelled: true }
      if (state.finished || activePlayer(state).id !== playerId || !activePlayer(state).isAI || tacticalSnapshotKey(state) !== expectedKey) {
        return { acted: false, cancelled: true }
      }
      if (result?.status === 'cancelled') return { acted: false, cancelled: true }

      let record: AiDecisionRecord
      if (result?.status === 'ready') {
        const action = inspectTacticalAction(state, playerId, result.actionId!)
        const requiredSource = action?.action.kind === 'move' ? 'move.basic' : `tool.${action?.action.kind}`
        if (action && result.sourceIds.includes(requiredSource)
          && executeAction(state, playerId, result.actionId!, expectedKey).ok) {
          counters.modelSuccess++
          record = { runId: result.runId, turnNumber, playerId, mode: 'cloud', actionId: result.actionId,
            label: action.action.label, reason: result.reason.slice(0, 240), sourceIds: [...result.sourceIds], elapsedMs: Date.now() - started }
          counters.recent.unshift(record); counters.recent.length = Math.min(20, counters.recent.length)
          return { acted: true, decision: record }
        }
        failure = 'INVALID_ACTION'
      } else if (result?.status === 'fallback') failure = result.fallbackReason ?? 'MODEL_UNAVAILABLE'
      const fallback = chooseFallbackAction(state, playerId)
      const acted = fallback ? executeAction(state, playerId, fallback.action.actionId, expectedKey).ok : rulesStep(state)
      counters.fallbacks++
      record = { runId: result?.runId ?? `local-${started}-${current.id}`, turnNumber, playerId, mode: 'fallback',
        ...(fallback ? { actionId: fallback.action.actionId } : {}), label: fallback?.action.label ?? '规则策略继续行动',
        reason: '云端决策未能及时通过检查，改用规则策略继续本回合。', sourceIds: [], elapsedMs: Date.now() - started,
        fallbackReason: failure.slice(0, 80) }
      counters.recent.unshift(record); counters.recent.length = Math.min(20, counters.recent.length)
      return { acted, decision: record }
    } finally {
      clearTimeout(timer)
      context.signal?.removeEventListener('abort', onAbort)
      if (stopWaiting) current.controller.signal.removeEventListener('abort', stopWaiting)
      if (active === current) active = null
    }
  }
  return { step, cancel, dispose: () => { disposed = true; cancel() } }
}
