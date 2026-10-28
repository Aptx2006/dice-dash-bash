export interface CardPointer { pointerId: number; clientX: number; clientY: number }
export const CARD_DRAG_THRESHOLD = 46

/** 一次主指针手势最多激活一次；拖回、取消或其他手指不能意外出牌。 */
export function createCardGesture() {
  let active: { uid: number; pointerId: number; x: number; y: number; offset: number; moved: boolean } | null = null
  let suppressClick = false
  let lastPointerId: number | null = null
  function move(event: CardPointer): number | null {
    if (!active || event.pointerId !== active.pointerId) return null
    if (Math.hypot(event.clientX - active.x, event.clientY - active.y) > 8) active.moved = true
    active.offset = Math.max(0, Math.min(90, active.y - event.clientY))
    return active.offset
  }
  return {
    start(uid: number, event: CardPointer & { button: number; isPrimary: boolean }): boolean {
      if (active || event.button !== 0 || !event.isPrimary) return false
      suppressClick = false
      lastPointerId = event.pointerId
      active = { uid, pointerId: event.pointerId, x: event.clientX, y: event.clientY, offset: 0, moved: false }
      return true
    },
    move,
    finish(event: CardPointer): { uid: number; activate: boolean } | null {
      if (!active || event.pointerId !== active.pointerId) return null
      move(event)
      const result = { uid: active.uid, activate: active.offset >= CARD_DRAG_THRESHOLD }
      suppressClick = active.moved || result.activate
      active = null
      return result
    },
    cancel(pointerId?: number): boolean {
      if (!active || (pointerId !== undefined && active.pointerId !== pointerId)) return false
      active = null; suppressClick = true
      return true
    },
    acceptClick(detail: number, pointerId?: number): boolean {
      if (active) return false
      // click的isPrimary在浏览器间不一致；只按已开始手势的指针编号排除其他手指。
      if (detail > 0 && pointerId !== undefined && pointerId > 0 && lastPointerId !== null && pointerId !== lastPointerId) return false
      const allow = !suppressClick || detail === 0
      suppressClick = false
      return allow
    },
  }
}
