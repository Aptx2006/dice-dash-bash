export type TacticalRunStatus = 'awaiting_confirmation' | 'no_actions' | 'unavailable' | 'failed' | 'step_limit' | 'timeout' | 'cancelled'

export interface TacticalSource {
  id: string
  title: string
  text: string
  source: string
  sourceLines: [number, number]
}

export interface TacticalProposal {
  actionId: string
  label: string
  reason: string
  sourceIds: string[]
  /** 仅为建议有效期；前端执行仍须比较请求时的原局面并重新检查合法性。 */
  expiresAt: number
}

export interface TacticalRunEvent {
  id: number
  time: string
  step: number
  kind: 'model' | 'tool' | 'validation' | 'stop'
  status: 'ok' | 'error'
  title: string
  detail: string
  durationMs: number
  toolName?: string
  args?: Record<string, unknown>
  result?: unknown
  errorCode?: string
}

export interface TacticalRunResult {
  runId: string
  status: TacticalRunStatus
  reason: string
  proposal?: TacticalProposal
  sources: TacticalSource[]
  events: TacticalRunEvent[]
  steps: number
  elapsedMs: number
  model: string
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null
}
