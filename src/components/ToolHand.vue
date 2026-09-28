<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { GameState, PlayerState, ToolId, ToolInstance } from '../game/types.ts'
import { TOOLS } from '../game/tools.ts'
import { characterById } from '../game/characters.ts'
import { activePlayer, canUseTool } from '../game/engine.ts'

const props = defineProps<{
  state: GameState
  canInteract: boolean
  selectedUid: number | null
  tutorialToolId?: ToolId | null
}>()
const emit = defineEmits<{ activate: [uid: number] }>()

const player = computed<PlayerState>(() => activePlayer(props.state))
const character = computed(() => characterById(player.value.characterId))

const draggingUid = ref<number | null>(null)
let dragStartY = 0
let dragged = false
const dragOffset = ref(0)
const DRAG_THRESHOLD = 46

const phaseLabels: Record<string, string> = {
  turnStart: '回合开始',
  action: '行动阶段',
  turnEnd: '回合结束',
  reward: '选择奖励',
  finished: '对局结束',
}
const phaseLabel = computed(() => phaseLabels[props.state.phase] ?? props.state.phase)
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
    return true
  }
  return false
}

function onPointerDown(instance: ToolInstance, event: PointerEvent) {
  if (!cardEnabled(instance)) return
  event.preventDefault()
  draggingUid.value = instance.uid
  dragStartY = event.clientY
  dragged = false
  dragOffset.value = 0
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp, { once: true })
  window.addEventListener('pointercancel', cancelDrag, { once: true })
}

function onPointerMove(event: PointerEvent) {
  if (draggingUid.value == null) return
  dragOffset.value = Math.max(0, Math.min(90, dragStartY - event.clientY))
  if (dragOffset.value >= DRAG_THRESHOLD) dragged = true
}

function onPointerUp() {
  if (draggingUid.value == null) return
  const uid = draggingUid.value
  const shouldActivate = dragged
  cancelDrag()
  if (shouldActivate) emit('activate', uid)
}

function cancelDrag() {
  draggingUid.value = null
  dragOffset.value = 0
  dragged = false
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', cancelDrag)
}

function cardStyle(instance: ToolInstance) {
  return draggingUid.value === instance.uid ? { transform: `translateY(-${dragOffset.value}px)` } : undefined
}

onBeforeUnmount(cancelDrag)
</script>

<template>
  <div class="tool-hand" :class="{ inactive: !canInteract }">
    <div class="tool-hand-head">
      <div class="hand-player">
        <span class="swatch" :style="{ background: player.pieceColor }">{{ player.name.slice(0, 2) }}</span>
        <div>
          <strong>{{ player.name }}</strong>
          <small>{{ character.name }} · {{ character.title }}</small>
        </div>
      </div>
      <span class="phase-ribbon" :class="{ quiet: phaseQuiet }">{{ phaseLabel }}</span>
      <div class="hand-dice">
        <span class="die" title="移动骰">{{ state.dice.move ?? '?' }}</span>
        <span class="die tool" title="工具骰">{{ state.dice.toolName ?? '—' }}</span>
      </div>
    </div>
    <div class="hand-cards">
      <template v-if="player.hand.length">
        <button
          v-for="instance in player.hand"
          :key="instance.uid"
          type="button"
          :class="cardClass(instance)"
          :style="cardStyle(instance)"
          :disabled="!cardEnabled(instance)"
          :aria-label="`向上拖出${cardName(instance)}：${cardDesc(instance)}`"
          @pointerdown="onPointerDown(instance, $event)"
          @keydown.enter.prevent="emit('activate', instance.uid)"
          @keydown.space.prevent="emit('activate', instance.uid)"
        >
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
</style>
