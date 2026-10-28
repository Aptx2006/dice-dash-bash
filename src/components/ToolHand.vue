<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { GameState, PlayerState, ToolId, ToolInstance } from '../game/types.ts'
import { TOOLS } from '../game/tools.ts'
import { characterById } from '../game/characters.ts'
import { activePlayer, canUseTool } from '../game/engine.ts'
import { createCardGesture, CARD_DRAG_THRESHOLD } from '../input/cardGesture.ts'

const props = defineProps<{
  state: GameState
  canInteract: boolean
  selectedUid: number | null
  tutorialToolId?: ToolId | null
  viewerId?: string
}>()
const emit = defineEmits<{ activate: [uid: number] }>()

const actor = computed<PlayerState>(() => activePlayer(props.state))
const player = computed<PlayerState>(() => props.state.players.find(player => player.id === props.viewerId) ?? actor.value)
const character = computed(() => characterById(player.value.characterId))

const draggingUid = ref<number | null>(null)
const dragOffset = ref(0)
const gesture = createCardGesture()
let captureTarget: HTMLElement | null = null
let captureId: number | null = null
const cardsRoot = ref<HTMLElement | null>(null)
const columns = ref(4)
const page = ref(0)
const filter = ref('all')
let resizeObserver: ResizeObserver | undefined
// 投骰/结束固定显示；其余手牌分页，长局也只占一行卡牌高度。
const primaryCard = computed(() => player.value.hand.find(card => props.state.phase === 'turnStart' ? card.toolId === 'roll' : card.toolId === 'end'))
const inventory = computed(() => player.value.hand.filter(card => card.uid !== primaryCard.value?.uid).sort((a, b) => {
  const priority = (card: ToolInstance) => card.toolId === 'move' ? 0 : card.system ? 1 : 2
  return priority(a) - priority(b)
}))
const cardTypes = computed(() => [...new Set(inventory.value.map(card => card.toolId))].map(id => ({
  id, name: TOOLS[id].name, count: inventory.value.filter(card => card.toolId === id).length,
})))
const filteredCards = computed(() => inventory.value.filter(card => filter.value === 'all' || card.toolId === filter.value))
const pageSize = computed(() => Math.max(1, columns.value - (primaryCard.value ? 1 : 0)))
const pageCount = computed(() => Math.max(1, Math.ceil(filteredCards.value.length / pageSize.value)))
const visibleCards = computed(() => [...filteredCards.value.slice(page.value * pageSize.value, (page.value + 1) * pageSize.value),
  ...(primaryCard.value ? [primaryCard.value] : [])])
watch([pageCount, pageSize], () => { page.value = Math.min(page.value, pageCount.value - 1) })
watch(() => player.value.id, () => { page.value = 0; filter.value = 'all'; cancelDrag() })
watch(() => props.canInteract, allowed => { if (!allowed) cancelDrag() })
watch(() => props.state.phase, () => { page.value = 0; filter.value = 'all' })
watch(filter, () => { page.value = 0 })
watch(cardTypes, types => { if (filter.value !== 'all' && !types.some(type => type.id === filter.value)) filter.value = 'all' })
watch(() => props.selectedUid, uid => {
  if (filter.value !== 'all' && !filteredCards.value.some(card => card.uid === uid)) filter.value = 'all'
  const index = filteredCards.value.findIndex(card => card.uid === uid)
  if (index >= 0) page.value = Math.floor(index / pageSize.value)
})
function measureCards() {
  const root = cardsRoot.value, card = root?.querySelector<HTMLElement>('.tool-card')
  if (!root || !card) return
  const gap = Number.parseFloat(getComputedStyle(root).columnGap) || 8.8
  columns.value = Math.max(2, Math.floor((root.clientWidth + gap + .1) / (card.getBoundingClientRect().width + gap)))
}
onMounted(() => {
  measureCards()
  resizeObserver = new ResizeObserver(measureCards)
  if (cardsRoot.value) resizeObserver.observe(cardsRoot.value)
})

const phaseLabels: Record<string, string> = {
  turnStart: '回合开始',
  action: '行动阶段',
  turnEnd: '回合结束',
  reward: '选择奖励',
  finished: '对局结束',
}
const phaseLabel = computed(() => props.viewerId && actor.value.id !== props.viewerId && !props.state.finished
  ? `等待${actor.value.name}` : phaseLabels[props.state.phase] ?? props.state.phase)
const phaseQuiet = computed(() => !props.canInteract || player.value.isAI)

function cardClass(instance: ToolInstance) {
  const def = TOOLS[instance.toolId]
  return [
    'tool-card',
    `tool-card--${def.tone === 'system' ? 'system' : def.tone === 'move' ? 'movePlus' : def.tone}`,
    {
      selected: props.selectedUid === instance.uid,
      dragging: draggingUid.value === instance.uid,
      'tutorial-focus': props.tutorialToolId === instance.toolId,
    },
  ]
}

function cardDesc(instance: ToolInstance) {
  return TOOLS[instance.toolId].desc({ points: instance.points, length: instance.length })
}

function cardIcon(instance: ToolInstance) {
  return TOOLS[instance.toolId].icon
}

function cardName(instance: ToolInstance) {
  return TOOLS[instance.toolId].name
}

function cardEnabled(instance: ToolInstance) {
  if (!props.canInteract) return false
  if (props.state.phase === 'turnStart') {
    return ['roll', 'copy', 'prepareTow', 'leap', 'storm'].includes(instance.toolId)
  }
  if (props.state.phase === 'action') {
    return instance.toolId === 'end' || canUseTool(props.state, instance)
  }
  if (props.state.phase === 'turnEnd') {
    return instance.toolId === 'end' || canUseTool(props.state, instance)
  }
  return false
}

function onPointerDown(instance: ToolInstance, event: PointerEvent) {
  if (!cardEnabled(instance) || !gesture.start(instance.uid, event)) return
  draggingUid.value = instance.uid
  dragOffset.value = 0
  captureTarget = event.currentTarget as HTMLElement; captureId = event.pointerId
  try { captureTarget.setPointerCapture(event.pointerId) } catch { /* 窗口监听仍可处理当前指针。 */ }
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
  window.addEventListener('blur', cancelDrag)
  window.addEventListener('keydown', onDragKey)
}

function onPointerMove(event: PointerEvent) {
  const offset = gesture.move(event)
  if (offset !== null) dragOffset.value = offset
}

function onPointerUp(event: PointerEvent) {
  const result = gesture.finish(event)
  if (!result) return
  clearDrag()
  if (result.activate) emit('activate', result.uid)
}

function cancelDrag() {
  gesture.cancel(); clearDrag()
}
function onPointerCancel(event: PointerEvent) { if (gesture.cancel(event.pointerId)) clearDrag() }
function onDragKey(event: KeyboardEvent) { if (event.key === 'Escape') cancelDrag() }
function onCardClick(instance: ToolInstance, event: MouseEvent) {
  const pointerId = 'pointerId' in event && typeof event.pointerId === 'number' ? event.pointerId : undefined
  if (gesture.acceptClick(event.detail, pointerId) && cardEnabled(instance)) emit('activate', instance.uid)
}
function clearDrag() {
  try { if (captureId !== null && captureTarget?.hasPointerCapture(captureId)) captureTarget.releasePointerCapture(captureId) } catch { /* 元素可能已随阶段更新移除。 */ }
  captureId = null; captureTarget = null
  draggingUid.value = null
  dragOffset.value = 0
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  window.removeEventListener('blur', cancelDrag)
  window.removeEventListener('keydown', onDragKey)
}

function cardStyle(instance: ToolInstance) {
  return draggingUid.value === instance.uid ? { transform: `translateY(-${dragOffset.value}px)` } : undefined
}

onBeforeUnmount(() => { cancelDrag(); resizeObserver?.disconnect() })
</script>

<template>
  <div class="tool-hand" :class="{ inactive: !canInteract, 'private-hand': !!viewerId }">
    <div class="tool-hand-head">
      <div class="hand-player">
        <span class="swatch" :style="{ background: player.pieceColor }">{{ player.name.slice(0, 2) }}</span>
        <div>
          <strong>{{ player.name }}</strong>
          <small>{{ character.name }} · {{ character.title }}</small>
        </div>
      </div>
      <span class="phase-ribbon" :class="{ quiet: phaseQuiet }" title="点击牌面或向上拖出使用；需要目标的牌再选择方向或格子。">{{ phaseLabel }}</span>
      <div class="hand-dice" :aria-label="`${actor.name}最近的骰子结果`" :title="`${actor.name}最近的骰子结果`">
        <span class="die" title="移动骰">{{ state.dice.move ?? '?' }}</span>
        <span class="die tool" title="工具骰">{{ state.dice.toolName ?? '—' }}</span>
      </div>
    </div>
    <div v-if="inventory.length > pageSize || filter !== 'all'" class="hand-pagination" aria-label="手牌分页">
      <select v-model="filter" aria-label="筛选手牌" :disabled="draggingUid !== null">
        <option value="all">全部手牌</option>
        <option v-for="type in cardTypes" :key="type.id" :value="type.id">{{ type.name }} ×{{ type.count }}</option>
      </select>
      <button type="button" aria-label="上一页手牌" :disabled="page === 0 || draggingUid !== null" @click="page--">‹</button>
      <span role="status">{{ page + 1 }} / {{ pageCount }} 页 · 共{{ player.hand.length }}张 <small>点击或拖出使用</small></span>
      <button type="button" aria-label="下一页手牌" :disabled="page >= pageCount - 1 || draggingUid !== null" @click="page++">›</button>
    </div>
    <div ref="cardsRoot" class="hand-cards">
      <template v-if="player.hand.length">
        <button
          v-for="instance in visibleCards"
          :key="instance.uid"
          type="button"
          :class="cardClass(instance)"
          :style="cardStyle(instance)"
          :disabled="!cardEnabled(instance)"
          :aria-label="`使用${cardName(instance)}：${cardDesc(instance)}`"
          :title="`点击或向上拖出${cardName(instance)}：${cardDesc(instance)}`"
          @pointerdown="onPointerDown(instance, $event)"
          @click="onCardClick(instance, $event)"
          @keydown.enter.prevent="emit('activate', instance.uid)"
          @keydown.space.prevent="emit('activate', instance.uid)"
        >
          <span v-if="draggingUid === instance.uid" class="card-drag-hint">{{ dragOffset >= CARD_DRAG_THRESHOLD ? '松开使用' : '向上拖出，或放回取消' }}</span>
          <span class="tool-card__head">
            <span class="tool-card__icon">{{ cardIcon(instance) }}</span>
            <span class="tool-card__title">{{ cardName(instance) }}</span>
          </span>
          <span class="tool-card__desc">{{ cardDesc(instance) }}</span>
        </button>
      </template>
      <span v-else class="hand-empty">等待行动中……</span>
    </div>
  </div>
</template>

<style scoped>
.inactive .tool-card {
  filter: saturate(0.7);
}
.private-hand.inactive .tool-card:disabled { opacity: .8; }
.tool-hand-head { flex-wrap: wrap; }
.hand-player > div { min-width: 0; }
.hand-player strong { max-width: 12em; overflow: hidden; text-overflow: ellipsis; }
.phase-ribbon { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.hand-cards { flex-wrap: nowrap; }
.hand-cards .tool-card { max-width: calc((100% - .55rem) / 2); min-height: 122px; }
.tool-card { position: relative; }
.card-drag-hint { position: absolute; left: 50%; bottom: calc(100% + .3rem); transform: translateX(-50%); white-space: nowrap; border-radius: 8px; background: var(--navy); color: #fffaf0; padding: .3rem .5rem; font-size: .65rem; pointer-events: none; }
.hand-pagination { display: flex; justify-content: center; align-items: center; gap: .6rem; margin: -.1rem 0 .55rem; color: var(--ink-dim); font-size: .7rem; }
.hand-pagination button { width: 30px; height: 25px; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--panel); color: var(--ink); font-size: 1.1rem; }
.hand-pagination select { max-width: 100px; min-width: 0; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--panel); color: var(--ink); padding: .25rem; font-size: .7rem; }
.hand-pagination small { font-size: .62rem; margin-left: .4rem; color: var(--ink-faint); }
@media (max-width: 600px) { .hand-pagination { gap: .4rem; } .hand-pagination small { display: none; } }
@media (max-height: 500px) {
  .tool-hand { padding: .35rem .7rem .45rem; }
  .tool-hand-head { margin-bottom: .2rem; gap: .4rem; }
  .hand-player small { display: none; }
  .hand-player .swatch { width: 24px; height: 24px; }
  .hand-cards { min-height: 76px; }
  .hand-cards .tool-card { min-height: 76px; padding: .35rem .45rem; gap: .2rem; }
  .tool-card__head { gap: .3rem; }
  .tool-card__icon { width: 22px; height: 22px; font-size: .8rem; }
  .tool-card__title { font-size: .76rem; }
  .tool-card__desc { font-size: .6rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .hand-pagination { margin: .15rem 0 .3rem; }
  .hand-pagination button { height: 23px; }
}
</style>
