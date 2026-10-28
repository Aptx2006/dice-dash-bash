import type { GameState } from './types.ts'
import { executeTacticalAction, inspectTacticalAction, tacticalSnapshotKey } from './tactical.ts'

export type ConfirmationState = 'pending' | 'applied' | 'rejected' | 'expired' | 'stale'

/** 每份建议只可确认一次；仅保存在当前页面内，不随对局存档恢复。 */
export interface TacticalConfirmation {
  actionId: string
  playerId: string
  expectedSnapshotKey: string
  expiresAt: number
  status: ConfirmationState
}

export function createTacticalConfirmation(
  state: GameState,
  playerId: string,
  actionId: string,
  expectedSnapshotKey: string,
  expiresAt: number,
  now = Date.now(),
): TacticalConfirmation | null {
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now ||
    tacticalSnapshotKey(state) !== expectedSnapshotKey || !inspectTacticalAction(state, playerId, actionId)) return null
  return { actionId, playerId, expectedSnapshotKey, expiresAt: Math.min(expiresAt, now + 60_000), status: 'pending' }
}

export function authorizeTacticalConfirmation(
  confirmation: TacticalConfirmation,
  decision: 'accept' | 'reject',
  state: GameState,
  playerId: string,
  canInteract: boolean,
  now = Date.now(),
): { ok: boolean; status: ConfirmationState; message: string } {
  if (confirmation.status !== 'pending') return { ok: false, status: confirmation.status, message: '这份建议已经处理过，请重新分析。' }
  if (decision === 'reject') {
    confirmation.status = 'rejected'
    return { ok: false, status: 'rejected', message: '已放弃建议，你可以继续自己出牌。' }
  }
  if (!Number.isFinite(now) || now >= confirmation.expiresAt) {
    confirmation.status = 'expired'
    return { ok: false, status: 'expired', message: '建议已过期，请按当前局面重新分析。' }
  }
  if (!canInteract || playerId !== confirmation.playerId || tacticalSnapshotKey(state) !== confirmation.expectedSnapshotKey) {
    confirmation.status = 'stale'
    return { ok: false, status: 'stale', message: '局面已经改变，这份建议不能再执行。' }
  }
  // 先消费确认，避免重复点击或回调导致同一建议执行两次。
  confirmation.status = 'stale'
  return { ok: true, status: 'stale', message: '已确认，等待执行。' }
}

export function resolveTacticalConfirmation(
  confirmation: TacticalConfirmation,
  decision: 'accept' | 'reject',
  state: GameState,
  playerId: string,
  canInteract: boolean,
  now = Date.now(),
): { ok: boolean; status: ConfirmationState; message: string } {
  const authorization = authorizeTacticalConfirmation(confirmation, decision, state, playerId, canInteract, now)
  if (!authorization.ok) return authorization
  const result = executeTacticalAction(state, playerId, confirmation.actionId, confirmation.expectedSnapshotKey)
  if (!result.ok) return { ok: false, status: 'stale', message: result.error || '这一步目前无法执行，请重新分析。' }
  confirmation.status = 'applied'
  return { ok: true, status: 'applied', message: '已执行确认的行动。' }
}
