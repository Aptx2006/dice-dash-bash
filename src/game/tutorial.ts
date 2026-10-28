import type { GameState, ToolId } from './types.ts'

/** 教学仅约束引导时可用的手牌，不修改正常对局规则或骰子结果。 */
export function tutorialFocus(step: number): ToolId | null {
  if (step === 1) return 'roll'
  if (step === 2 || step === 3) return 'move'
  if (step === 4 || step === 5) return 'end'
  return null
}

/** 兼容旧教学进度和恢复后的局面；结束的对局不等待已不存在的下一回合。 */
export function reconcileTutorialStep(step: number, state: GameState): number {
  if (state.mapId !== 'tutorial') return -1
  const current = Number.isInteger(step) && step >= 0 && step <= 7 ? step : 0
  if (current === 0 || current === 7) return current
  if (state.finished) return 7
  const actor = state.players[state.activeIndex]!
  if (actor.isAI) return 6
  if (current === 6 && state.turnNumber > 1) return 7
  // 旧版本允许尚未移动就结束阶段，恢复时按实际阶段给出可继续的引导。
  if (state.phase === 'turnEnd') return 5
  if (state.phase === 'action') {
    if (current === 1) return 2
    if (current === 2 || current === 3) return actor.hand.some(card => card.toolId === 'move') ? current : 4
  }
  if (state.phase === 'turnStart' && current > 1) return 1
  return current
}
