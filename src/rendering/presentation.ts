import type { Phase } from '../game/types.ts'

export function isDiceReveal(previous: Phase, current: Phase, move: number | null, tool: string | null): boolean {
  return previous === 'turnStart' && current === 'action' && move !== null && tool !== null
}

export function movementAlpha(deltaSeconds: number, speed: number): number {
  return 1 - Math.exp(-3.4 * speed * Math.min(0.05, Math.max(0, deltaSeconds)))
}
