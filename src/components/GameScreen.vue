<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BoardView from './BoardView.vue'
import ToolHand from './ToolHand.vue'
import type { Cell, Dir, GameState, ToolId, ToolInstance } from '../game/types.ts'
import { sameCell } from '../game/types.ts'
import { TOOLS } from '../game/tools.ts'
import {
  activePlayer,
  adjacentFreeCells,
  blinkCells,
  chooseReward,
  computeMoveTargets,
  inBoard,
  blocksMove,
  leapTargets,
  playerAt,
  playAdjacentTool,
  playBlinkTool,
  playCopyCard,
  playDirectionTool,
  playEndCard,
  playLeapCard,
  playLeapTool,
  playPrepareTowCard,
  playRollCard,
  playSimpleTool,
  playStormCard,
  playTeleportTool,
  playTow,
  resolveMoveCard,
  settlementRanking,
  teleportCells,
  timeoutTurn,
  towCandidates,
  type MoveTarget,
} from '../game/engine.ts'
import { aiStep } from '../game/ai.ts'
import { isDiceReveal } from '../rendering/presentation.ts'
import { characterById } from '../game/characters.ts'

interface BoardViewApi {
  fitToView: () => void
}

const props = defineProps<{
  state: GameState
  myId: string
  tutorial?: boolean
}>()

const emit = defineEmits<{
  exit: []
  restart: []
}>()

type TargetMode = 'none' | 'slide' | 'direction' | 'cell' | 'anywhere' | 'adjacent' | 'storm' | 'player-pick' | 'player-dir'

const selectedUid = ref<number | null>(null)
const targetMode = ref<TargetMode>('none')
const towTargetId = ref<string | null>(null)
const timeLeft = ref(75)
const boardView = ref<BoardViewApi | null>(null)
// 地图标识是教学模式的稳定判据，同时保留 prop 便于后续复用其他教学地图。
const isTutorial = computed(() => props.tutorial === true || props.state.mapId === 'tutorial')
const tutorialStep = ref(isTutorial.value ? 0 : -1)

const speedOptions = [
  { value: 0.6, label: '慢速 0.6×' },
  { value: 1, label: '标准 1×' },
  { value: 1.75, label: '快速 1.75×' },
  { value: 3, label: '极速 3×' },
] as const
const savedSpeed = Number(localStorage.getItem('dice-animation-speed'))
const animationSpeed = ref(speedOptions.some((option) => option.value === savedSpeed) ? savedSpeed : 0.6)
watch(animationSpeed, (speed) => {
  localStorage.setItem('dice-animation-speed', String(speed))
  scheduleAI()
})

interface CardPresentation {
  playerName: string
  icon: string
  title: string
  description: string
  nonce: number
}

interface DicePresentation {
  playerName: string
  move: number
  toolName: string
  revealed: boolean
  nonce: number
}

const aiCardPresentation = ref<CardPresentation | null>(null)
const dicePresentation = ref<DicePresentation | null>(null)
let presentationNonce = 0
let aiCardTimer: number | undefined
let diceRevealTimer: number | undefined
let diceHideTimer: number | undefined

function scaledDelay(ms: number): number {
  return Math.max(120, Math.round(ms / animationSpeed.value))
}

function showAiCard(playerName: string, card?: ToolInstance, fallback = '继续行动') {
  window.clearTimeout(aiCardTimer)
  const def = card ? TOOLS[card.toolId] : null
  aiCardPresentation.value = {
    playerName,
    icon: def?.icon ?? '⏭',
    title: def?.name ?? fallback,
    description: def?.desc({ points: card?.points, length: card?.length }) ?? '进入下一个行动阶段。',
    nonce: ++presentationNonce,
  }
  aiCardTimer = window.setTimeout(() => {
    aiCardPresentation.value = null
    scheduleAI()
  }, scaledDelay(1400))
}

function showDice(playerName: string, move: number, toolName: string) {
  window.clearTimeout(diceRevealTimer)
  window.clearTimeout(diceHideTimer)
  const nonce = ++presentationNonce
  dicePresentation.value = { playerName, move, toolName, revealed: false, nonce }
  diceRevealTimer = window.setTimeout(() => {
    if (dicePresentation.value?.nonce === nonce) dicePresentation.value.revealed = true
  }, scaledDelay(650))
  diceHideTimer = window.setTimeout(() => {
    if (dicePresentation.value?.nonce === nonce) dicePresentation.value = null
    scheduleAI()
  }, scaledDelay(2300))
}

watch(
  () => props.state.phase,
  (phase, previous) => {
    const { move, toolName } = props.state.dice
    if (!isDiceReveal(previous, phase, move, toolName)) return
    showDice(activePlayer(props.state).name, move!, toolName!)
  },
)

const TURN_SECONDS = 75

const player = computed(() => activePlayer(props.state))
const presenting = computed(() => !!dicePresentation.value || !!aiCardPresentation.value)
const canInteract = computed(() => !presenting.value && !props.state.finished && !player.value.isAI && player.value.id === props.myId)

const selectedInstance = computed<ToolInstance | null>(() => {
  if (selectedUid.value == null) return null
  return player.value.hand.find((t) => t.uid === selectedUid.value) ?? null
})

const phaseText = computed(() => {
  const state = props.state
  if (state.finished) return '对局结束'
  if (state.phase === 'reward') return '选择奖励'
  if (state.phase === 'turnStart') return '回合开始'
  if (state.phase === 'action') return '行动阶段'
  if (state.phase === 'turnEnd') return '回合结束'
  return ''
})

const tutorialCopy = computed(() => {
  const steps = [
    {
      title: '欢迎来到基础教学',
      body: '你将和教学机器人完成一轮练习。目标是率先到达旗帜所在的终点。',
      action: '开始教学',
    },
    {
      title: '第一步：投骰',
      body: '把底部的“投骰”牌向上拖出。系统会生成一张移动牌。',
    },
    {
      title: '第二步：选择移动',
      body: '把底部的“移动”牌向上拖出，进入方向选择。',
    },
    {
      title: '第三步：选择方向',
      body: '点击方向按钮。建议选择向上或向右，棋子会沿直线前进。',
    },
    {
      title: '第四步：结束行动',
      body: '移动完成后，把“结束”牌向上拖出，进入回合结束阶段。',
    },
    {
      title: '第五步：交出回合',
      body: '再次拖出“结束”牌，把行动权交给教学机器人。',
    },
    {
      title: '观察智能体行动',
      body: '教学机器人正在自动完成回合。稍等片刻，行动权会回到你手中。',
    },
    {
      title: '基础教学完成',
      body: '你已经掌握投骰、移动、结束回合和观察行动顺序。拖动棋盘可平移，滚轮可缩放。',
      action: '完成教学',
    },
  ]
  return steps[Math.max(0, tutorialStep.value)]
})

const tutorialFocusTool = computed<ToolId | null>(() => {
  if (!isTutorial.value) return null
  if (tutorialStep.value === 1) return 'roll'
  if (tutorialStep.value === 2) return 'move'
  if (tutorialStep.value === 4 || tutorialStep.value === 5) return 'end'
  return null
})

const bannerText = computed(() => {
  if (props.state.finished) return '比赛结束'
  if (player.value.isAI) return `${player.value.name} 正在行动…`
  return `第 ${props.state.turnNumber} 回合 · ${player.value.name}`
})

const slideTargets = computed<MoveTarget[]>(() => {
  if (targetMode.value !== 'slide' || !selectedInstance.value) return []
  const inst = selectedInstance.value
  if (inst.toolId === 'move') return computeMoveTargets(props.state, player.value)
  if (inst.toolId === 'leap') return leapTargets(props.state, player.value, inst.points ?? 0)
  return []
})

const stormCells = computed<Cell[]>(() => {
  if (targetMode.value !== 'storm') return []
  const state = props.state
  const cells: Cell[] = []
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const dist = Math.abs(dx) + Math.abs(dy)
      if (dist < 1 || dist > 3) continue
      const cell = { x: player.value.cell.x + dx, y: player.value.cell.y + dy }
      if (inBoard(state, cell) && !blocksMove(state, cell) && !playerAt(state, cell)) cells.push(cell)
    }
  }
  return cells
})

const highlights = computed<Cell[]>(() => {
  const state = props.state
  if (!canInteract.value || !selectedInstance.value) return []
  switch (targetMode.value) {
    case 'slide':
      return slideTargets.value.flatMap((t) => t.cells)
    case 'cell':
      return blinkCells(state, player.value)
    case 'anywhere':
      return teleportCells(state)
    case 'adjacent':
      return adjacentFreeCells(state, player.value)
    case 'storm':
      return stormCells.value
    case 'player-pick':
      return towCandidates(state).map((p) => p.cell)
    default:
      return []
  }
})

const targetingHint = computed(() => {
  if (!canInteract.value) return ''
  const inst = selectedInstance.value
  if (!inst) return ''
  const name = TOOLS[inst.toolId].name
  switch (targetMode.value) {
    case 'slide':
      return inst.toolId === 'move'
        ? `移动 ${inst.points ?? 0} 格 · 点方向滑到底，或点高亮路径${player.value.characterId === 'russell' ? '（可中途停）' : ''}`
        : `飞跃 ${inst.points ?? 0} 格 · 选择方向或落点`
    case 'direction':
      return `${name} · 选择方向`
    case 'cell':
      return `${name} · 点击高亮地块`
    case 'anywhere':
      return `${name} · 点击任意可落脚地块`
    case 'adjacent':
      return `${name} · 点击相邻空地`
    case 'storm':
      return '风暴巨剑 · 点击 3 格内的落点'
    case 'player-pick':
      return '牵引 · 点击要拉动的选手'
    case 'player-dir': {
      const target = props.state.players.find((p) => p.id === towTargetId.value)
      return `牵引 ${target?.name ?? ''} · 选择方向`
    }
    default:
      return ''
  }
})

const showDirPad = computed(
  () => canInteract.value && (targetMode.value === 'direction' || targetMode.value === 'player-dir' || targetMode.value === 'slide'),
)

const rewardVisible = computed(() => props.state.pendingReward?.playerId === props.myId && !props.state.finished)
const rewardPlayer = computed(() => props.state.players.find((p) => p.id === props.state.pendingReward?.playerId))

const ranking = computed(() => (props.state.finished ? settlementRanking(props.state) : []))

function clearSelection() {
  selectedUid.value = null
  targetMode.value = 'none'
  towTargetId.value = null
}

function beginTargeting(instance: ToolInstance, mode: TargetMode) {
  selectedUid.value = instance.uid
  targetMode.value = mode
  towTargetId.value = null
  if (isTutorial.value && tutorialStep.value === 2 && instance.toolId === 'move') {
    tutorialStep.value = 3
  }
}

function onCardActivate(uid: number) {
  const state = props.state
  const instance = player.value.hand.find((t) => t.uid === uid)
  if (!instance || !canInteract.value) return

  if (state.phase === 'turnStart') {
    switch (instance.toolId) {
      case 'roll':
        playRollCard(state)
        return
      case 'copy':
        playCopyCard(state)
        return
      case 'prepareTow':
        playPrepareTowCard(state)
        return
      case 'leap':
        playLeapCard(state)
        return
      case 'storm':
        beginTargeting(instance, 'storm')
        return
      default:
        return
    }
  }

  if (state.phase === 'action') {
    switch (instance.toolId) {
      case 'move':
      case 'leap':
        beginTargeting(instance, 'slide')
        return
      case 'end':
        playEndCard(state)
        return
      case 'blink':
        beginTargeting(instance, 'cell')
        return
      case 'teleport':
        beginTargeting(instance, 'anywhere')
        return
      case 'buildwall':
      case 'wallet':
        beginTargeting(instance, 'adjacent')
        return
      case 'tow':
        beginTargeting(instance, 'player-pick')
        return
      case 'punch':
      case 'basketball':
      case 'hook':
      case 'rocket':
        beginTargeting(instance, 'direction')
        return
      default:
        playSimpleTool(state, uid)
        return
    }
  }

  if (state.phase === 'turnEnd') {
    switch (instance.toolId) {
      case 'end':
        playEndCard(state)
        return
      case 'wallet':
      case 'buildwall':
        beginTargeting(instance, 'adjacent')
        return
      default:
        playSimpleTool(state, uid)
        return
    }
  }
}

function onCellSelect(cell: Cell) {
  const state = props.state
  const inst = selectedInstance.value
  if (!canInteract.value || !inst) return
  switch (targetMode.value) {
    case 'slide': {
      const target = slideTargets.value.find((t) => t.cells.some((c) => sameCell(c, cell)))
      if (!target) return
      const stopIndex = target.cells.findIndex((c) => sameCell(c, cell))
      const canBrake = player.value.characterId === 'russell'
      clearSelection()
      if (inst.toolId === 'move') resolveMoveCard(state, target.dir, canBrake ? stopIndex + 1 : undefined)
      else playLeapTool(state, inst.uid, target.dir)
      if (isTutorial.value && tutorialStep.value === 3) tutorialStep.value = 4
      return
    }
    case 'cell':
      clearSelection()
      playBlinkTool(state, inst.uid, cell)
      return
    case 'anywhere':
      clearSelection()
      playTeleportTool(state, inst.uid, cell)
      return
    case 'adjacent':
      clearSelection()
      playAdjacentTool(state, inst.uid, cell)
      return
    case 'storm':
      clearSelection()
      playStormCard(state, cell)
      return
    case 'player-pick': {
      const target = towCandidates(state).find((p) => sameCell(p.cell, cell))
      if (!target) return
      towTargetId.value = target.id
      targetMode.value = 'player-dir'
      return
    }
    default:
      return
  }
}

function onDirPick(dir: Dir) {
  const state = props.state
  const inst = selectedInstance.value
  if (!canInteract.value || !inst) return
  switch (targetMode.value) {
    case 'slide':
      clearSelection()
      if (inst.toolId === 'move') resolveMoveCard(state, dir)
      else playLeapTool(state, inst.uid, dir)
      if (isTutorial.value && tutorialStep.value === 3) tutorialStep.value = 4
      return
    case 'direction':
      clearSelection()
      playDirectionTool(state, inst.uid, dir)
      return
    case 'player-dir': {
      const targetId = towTargetId.value
      clearSelection()
      if (targetId) playTow(state, inst.uid, targetId, dir)
      return
    }
    default:
      return
  }
}

watch(
  () => [props.state.activeIndex, props.state.phase],
  () => clearSelection(),
)

watch(
  () => [props.state.activeIndex, props.state.phase, props.state.turnNumber] as const,
  () => {
    if (!isTutorial.value) return
    const current = activePlayer(props.state)
    if (tutorialStep.value === 1 && props.state.phase === 'action') tutorialStep.value = 2
    if (tutorialStep.value === 4 && props.state.phase === 'turnEnd') tutorialStep.value = 5
    if (tutorialStep.value === 5 && current.isAI) tutorialStep.value = 6
    if (tutorialStep.value === 6 && !current.isAI && props.state.turnNumber > 1) tutorialStep.value = 7
  },
)

watch(
  () => selectedInstance.value,
  (inst) => {
    if (!inst) {
      targetMode.value = 'none'
      towTargetId.value = null
    }
  },
)

// ====== AI 调度：每步一个动作，节奏化推进 ======
let aiTimer: number | undefined

function scheduleAI() {
  window.clearTimeout(aiTimer)
  if (props.state.finished || presenting.value) return
  const current = activePlayer(props.state)
  if (!current.isAI) return
  aiTimer = window.setTimeout(() => {
    if (presenting.value || props.state.finished || !activePlayer(props.state).isAI) return
    const actingPlayer = activePlayer(props.state)
    const phaseBefore = props.state.phase
    const handBefore = actingPlayer.hand.map((card) => ({ ...card }))
    const acted = aiStep(props.state)
    if (!acted) return

    const removedCard = handBefore.find((before) => !actingPlayer.hand.some((after) => after.uid === before.uid))
    const addedCard = actingPlayer.hand.find((after) => !handBefore.some((before) => before.uid === after.uid))
    const fallback = phaseBefore === 'turnEnd' ? '结束回合' : phaseBefore === 'reward' ? '选择奖励' : '结束阶段'
    // 投骰交给双骰面板，避免两张演出面板同时遮住棋盘。
    if (phaseBefore !== 'turnStart') showAiCard(actingPlayer.name, removedCard ?? addedCard, fallback)
    scheduleAI()
  }, scaledDelay(1550))
}

watch(
  () => [props.state, props.state.activeIndex, props.state.turnNumber, props.state.finished, presenting.value],
  () => scheduleAI(),
)

// ====== 回合计时：仅真人回合 ======
let tickTimer: number | undefined

function armTimer() {
  window.clearInterval(tickTimer)
  timeLeft.value = TURN_SECONDS
  if (!props.state.mechanisms.turnTimer || props.state.finished) return
  const current = activePlayer(props.state)
  if (current.isAI || current.id !== props.myId) return
  tickTimer = window.setInterval(() => {
    if (presenting.value) return
    timeLeft.value -= 1
    if (timeLeft.value <= 0) {
      window.clearInterval(tickTimer)
      timeoutNow()
    }
  }, 1000)
}

function timeoutNow() {
  if (props.state.finished) return
  clearSelection()
  timeoutTurn(props.state)
}

watch(
  () => [props.state, props.state.activeIndex, props.state.finished],
  () => armTimer(),
)

onMounted(() => {
  scheduleAI()
  armTimer()
})

onBeforeUnmount(() => {
  window.clearTimeout(aiTimer)
  window.clearInterval(tickTimer)
  window.clearTimeout(aiCardTimer)
  window.clearTimeout(diceRevealTimer)
  window.clearTimeout(diceHideTimer)
})

function pickReward(index: number) {
  chooseReward(props.state, index)
}

const timerPercent = computed(() => `${Math.max(0, (timeLeft.value / TURN_SECONDS) * 100)}%`)
</script>

<template>
  <main class="game-shell">
    <div class="board-wrap" :class="{ 'tutorial-board': isTutorial }">
      <BoardView
        ref="boardView"
        :state="state"
        :highlights="highlights"
        :hover-cell="null"
        :animation-speed="animationSpeed"
        @select="onCellSelect"
      />

      <div v-if="state.mechanisms.turnTimer && !state.finished" class="turn-timer" aria-hidden="true">
        <i :style="{ width: timerPercent }"></i>
      </div>

      <div class="phase-banner">
        <strong>{{ bannerText }}</strong>
        <template v-if="!state.finished"> · {{ phaseText }}<template v-if="state.mechanisms.turnTimer && canInteract"> · {{ timeLeft }}s</template></template>
      </div>

      <div class="game-actions">
        <label class="speed-control">
          <span>动画速度</span>
          <select v-model.number="animationSpeed" aria-label="动画速度">
            <option v-for="option in speedOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <button type="button" class="camera-fit" @click="boardView?.fitToView()">最佳屏幕大小</button>
        <button type="button" class="game-exit" @click="emit('exit')">退出对局</button>
      </div>
      <p class="camera-help">拖动平移棋盘 · 滚轮缩放 · 视角固定</p>

      <aside v-if="isTutorial && tutorialStep >= 0" class="tutorial-panel" aria-live="polite">
        <span class="tutorial-progress">{{ Math.min(tutorialStep + 1, 8) }} / 8</span>
        <p class="eyebrow">教学关</p>
        <h2>{{ tutorialCopy.title }}</h2>
        <p>{{ tutorialCopy.body }}</p>
        <button
          v-if="tutorialCopy.action"
          type="button"
          class="pill-button primary"
          @click="tutorialStep === 0 ? tutorialStep = 1 : emit('exit')"
        >
          {{ tutorialCopy.action }}
        </button>
      </aside>

      <div class="order-chips" aria-label="行动顺序">
        <div
          v-for="entry in state.players"
          :key="entry.id"
          class="order-chip"
          :class="{ active: entry.id === player.id && !state.finished, done: !!entry.finishedTurn }"
        >
          <span class="dot" :style="{ background: entry.pieceColor }"></span>
          {{ entry.name }}
          <small>{{ characterById(entry.characterId).name }}</small>
        </div>
      </div>

      <div class="log-panel" aria-label="行动记录">
        <ul>
          <li v-for="entry in state.logs.slice(0, 14)" :key="entry.id">{{ entry.text }}</li>
        </ul>
      </div>

      <p v-if="targetingHint" class="targeting-hint">{{ targetingHint }}</p>

      <nav v-if="showDirPad" class="dir-pad" aria-label="方向选择">
        <button type="button" style="grid-area: 1 / 2" title="上" @click="onDirPick('up')">↑</button>
        <button type="button" style="grid-area: 2 / 1" title="左" @click="onDirPick('left')">←</button>
        <button type="button" class="cancel" style="grid-area: 2 / 2" @click="clearSelection">取消</button>
        <button type="button" style="grid-area: 2 / 3" title="右" @click="onDirPick('right')">→</button>
        <button type="button" style="grid-area: 3 / 2" title="下" @click="onDirPick('down')">↓</button>
      </nav>

      <Transition name="card-play" mode="out-in">
        <section
          v-if="aiCardPresentation"
          :key="aiCardPresentation.nonce"
          class="ai-card-presentation"
          aria-live="polite"
        >
          <p>{{ aiCardPresentation.playerName }} 打出</p>
          <div class="played-card">
            <span>{{ aiCardPresentation.icon }}</span>
            <strong>{{ aiCardPresentation.title }}</strong>
            <small>{{ aiCardPresentation.description }}</small>
          </div>
        </section>
      </Transition>

      <Transition name="dice-show" mode="out-in">
        <section
          v-if="dicePresentation"
          :key="dicePresentation.nonce"
          class="dice-presentation"
          :class="{ revealed: dicePresentation.revealed }"
          aria-live="polite"
        >
          <p>{{ dicePresentation.playerName }} 投骰</p>
          <div class="dice-result move-die">
            <span class="die-face">{{ dicePresentation.revealed ? dicePresentation.move : '•' }}</span>
            <small>移动骰</small>
            <strong>{{ dicePresentation.revealed ? `${dicePresentation.move} 点` : '投掷中…' }}</strong>
          </div>
          <div class="dice-result tool-die">
            <span class="die-face">{{ dicePresentation.revealed ? '🧰' : '?' }}</span>
            <small>工具骰</small>
            <strong>{{ dicePresentation.revealed ? dicePresentation.toolName : '抽取中…' }}</strong>
          </div>
        </section>
      </Transition>
    </div>

    <ToolHand
      :state="state"
      :can-interact="canInteract"
      :selected-uid="selectedUid"
      :tutorial-tool-id="tutorialFocusTool"
      @activate="onCardActivate"
    />

    <div v-if="rewardVisible" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="选择奖励">
      <section class="modal-card reward-modal">
        <p class="eyebrow">{{ state.pendingReward!.reason }}</p>
        <h2>选一件工具</h2>
        <p class="sub">{{ rewardPlayer?.name }}，带走一件战利品吧。</p>
        <div class="reward-grid">
          <button
            v-for="(option, index) in state.pendingReward!.options"
            :key="option.uid"
            type="button"
            class="tool-card"
            @click="pickReward(index)"
          >
            <span class="tool-card__head">
              <span class="tool-card__icon">{{ TOOLS[option.toolId].icon }}</span>
              <span class="tool-card__title">{{ TOOLS[option.toolId].name }}</span>
            </span>
            <span class="tool-card__desc">{{ TOOLS[option.toolId].desc({ points: option.points, length: option.length }) }}</span>
          </button>
        </div>
      </section>
    </div>

    <div v-if="state.finished && !presenting" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="对局结算">
      <section class="modal-card settlement-card">
        <p class="crown">👑</p>
        <p class="eyebrow">对局完成</p>
        <h2>{{ ranking[0]?.player.name }} 抵达终点</h2>
        <p class="sub">第 {{ state.turnNumber }} 回合结束 · {{ state.mapLabel }}</p>
        <div class="settlement-rows">
          <div
            v-for="(row, index) in ranking"
            :key="row.player.id"
            class="settlement-row"
            :class="{ winner: index === 0 }"
          >
            <span class="rank">{{ index + 1 }}</span>
            <span class="dot" :style="{ background: row.player.pieceColor }"></span>
            <strong>{{ row.player.name }}</strong>
            <span>{{ characterById(row.player.characterId).name }}</span>
            <small>{{ row.note }}</small>
          </div>
        </div>
        <div class="settlement-actions">
          <button type="button" class="pill-button primary" @click="emit('restart')">再来一局</button>
          <button type="button" class="pill-button" @click="emit('exit')">返回大厅</button>
        </div>
      </section>
    </div>
  </main>
</template>
