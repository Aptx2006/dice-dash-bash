import type { TacticalRunEvent, TacticalSource } from './types.ts'

/** 云端只返回建议；对局控制器必须重验局面后执行一次，失败则由规则策略接管。 */
export interface OpponentDecision {
  runId: string
  status: 'ready' | 'fallback' | 'cancelled'
  actionId?: string
  reason: string
  sourceIds: string[]
  sources: TacticalSource[]
  steps: number
  elapsedMs: number
  model: string
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null
  events: TacticalRunEvent[]
  fallbackReason?: string
}
