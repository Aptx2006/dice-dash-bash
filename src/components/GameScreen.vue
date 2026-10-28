<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BoardView from './BoardView.vue'
import ToolHand from './ToolHand.vue'
import TacticalAssistant from './TacticalAssistant.vue'
import MovementChoices from './MovementChoices.vue'
import OpponentInsight from './OpponentInsight.vue'
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
import { createOpponentController } from '../agent/opponentController.ts'
import { listTacticalActions } from '../game/tactical.ts'
import { isDiceReveal } from '../rendering/presentation.ts'
import { characterById } from '../game/characters.ts'
import { readPreference, writePreference } from '../storage/preferences.ts'
import type { RemoteGameControls, RoomCommand, RoomPresentation } from '../network/types.ts'

interface BoardViewApi {
  fitToView: () => void
}

const props = defineProps<{
  state: GameState
  myId: string
  tutorial?: boolean
  initialProgress?: { tutorialStep: number; timeLeft: number }
  saveStatus?: string
  remote?: RemoteGameControls
}>()

const emit = defineEmits<{
  exit: []
  restart: []
  checkpoint: [progress: { tutorialStep: number; timeLeft: number }]
}>()

type TargetMode = 'none' | 'slide' | 'direction' | 'cell' | 'anywhere' | 'adjacent' | 'storm' | 'player-pick' | 'player-dir'

const selectedUid = ref<number | null>(null)
const targetMode = ref<TargetMode>('none')
const towTargetId = ref<string | null>(null)
const timeLeft = ref(props.initialProgress?.timeLeft ?? 75)
const boardView = ref<BoardViewApi | null>(null)
const actionNotice = ref('')
const aiBusy = ref(false)
const thinkingPlayerName = ref('')
const opponentController = createOpponentController()
// 地图标识是教学模式的稳定判据，同时保留 prop 便于后续复用其他教学地图。
const isTutorial = computed(() => props.tutorial === true || props.state.mapId === 'tutorial')
const tutorialStep = ref(isTutorial.value ? props.initialProgress?.tutorialStep ?? 0 : -1)
watch([tutorialStep, timeLeft], ([step, seconds]) => {
  emit('checkpoint', { tutorialStep: step, timeLeft: seconds })
}, { immediate: true, flush: 'post' })

const speedOptions = [
  { value: 0.6, label: '慢速 0.6×' },
  { value: 1, label: '标准 1×' },
  { value: 1.75, label: '快速 1.75×' },
  { value: 3, label: '极速 3×' },
] as const
const savedSpeedPreference = readPreference('dice-animation-speed', '0.6')
const storageNotice = ref(savedSpeedPreference.warning)
const savedSpeed = Number(savedSpeedPreference.value)
const animationSpeed = ref(speedOptions.some((option) => option.value === savedSpeed) ? savedSpeed : 0.6)
watch(animationSpeed, (speed) => {
  storageNotice.value = writePreference('dice-animation-speed', String(speed))
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
const remotePresentations: RoomPresentation[] = []
function advanceRemotePresentation() {
  if (!props.remote || presenting.value) return
  const next = remotePresentations.shift()
  if (!next) return
  if (next.dice) showDice(next.actorName, next.dice.move, next.dice.toolName)
  else showAiCard(next.actorName, next.card, '交出回合')
}

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
    advanceRemotePresentation()
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
    advanceRemotePresentation()
  }, scaledDelay(2300))
}

watch(
  () => props.state.phase,
  (phase, previous) => {
    if (props.remote) return
    const { move, toolName } = props.state.dice
    if (!isDiceReveal(previous, phase, move, toolName)) return
    showDice(activePlayer(props.state).name, move!, toolName!)
  },
)

const TURN_SECONDS = 75

const player = computed(() => activePlayer(props.state))
const presenting = computed(() => !!dicePresentation.value || !!aiCardPresentation.value)
const canInteract = computed(() => !presenting.value && !props.state.finished && !player.value.isAI && player.value.id === props.myId
  && (!props.remote || (props.remote.connected && !props.remote.busy)))

watch(() => props.remote?.presentation?.id, () => {
  const current = props.remote?.presentation
  const event = current ? { ...current } : undefined
  if (event && !event.dice && event.phaseBefore === 'turnStart' && props.state.phase === 'action'
    && props.state.dice.move !== null && props.state.dice.toolName !== null) {
    event.dice = { move: props.state.dice.move, toolName: props.state.dice.toolName }
  }
  if (!event || (!event.dice && (event.actorId === props.myId || event.phaseBefore === 'turnStart'))) return
  remotePresentations.push({ ...event })
  if (remotePresentations.length > 24) remotePresentations.shift()
  advanceRemotePresentation()
})

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
  if (thinkingPlayerName.value) return `${thinkingPlayerName.value} 正在思考…`
  if (player.value.isAI) return `${player.value.name} 正在行动…`
  return `第 ${props.state.turnNumber} 回合 · ${player.value.name}`
})

const slideTargets = computed<MoveTarget[]>(() => {
  if (targetMode.value !== 'slide' || !selectedInstance.value) return []
  const inst = selectedInstance.value
  if (inst.toolId === 'move') return computeMoveTargets(props.state, player.value, inst.uid)
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
  actionNotice.value = ''
}

function onTacticalApplied() {
  clearSelection()
  if (isTutorial.value && tutorialStep.value >= 2 && tutorialStep.value <= 3) {
    if (!player.value.hand.some(card => card.toolId === 'move')) tutorialStep.value = 4
  }
}

function beginTargeting(instance: ToolInstance, mode: TargetMode) {
  selectedUid.value = instance.uid
  targetMode.value = mode
  towTargetId.value = null
  if (isTutorial.value && tutorialStep.value === 2 && instance.toolId === 'move') {
    tutorialStep.value = 3
  }
}

function remoteCard(uid: number, params: { dir?: Dir; target?: Cell; targetId?: string; stopAfter?: number } = {}): boolean {
  if (!props.remote) return false
  const command: RoomCommand = { type: 'card', uid, ...params }
  void props.remote.submit(command)
  return true
}

function onCardActivate(uid: number) {
  const state = props.state
  const instance = player.value.hand.find((t) => t.uid === uid)
  if (!instance || !canInteract.value) return
  actionNotice.value = ''

  if (state.phase === 'turnStart') {
    switch (instance.toolId) {
      case 'roll':
        if (remoteCard(uid)) return
        playRollCard(state)
        return
      case 'copy':
        if (remoteCard(uid)) return
        playCopyCard(state)
        return
      case 'prepareTow':
        if (remoteCard(uid)) return
        playPrepareTowCard(state)
        return
      case 'leap':
        if (remoteCard(uid)) return
        playLeapCard(state)
        return
      case 'storm':
        beginTargeting(instance, 'storm')
        return
      default:
        return
    }
  }

  if (state.phase === 'action' || state.phase === 'turnEnd') {
    switch (instance.toolId) {
      case 'move':
      case 'leap':
        beginTargeting(instance, 'slide')
        return
      case 'end':
        if (remoteCard(uid)) return
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
        if (remoteCard(uid)) return
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
      if (!target) { actionNotice.value = '请选择高亮路径，或从移动预览中选择方向。'; return }
      const stopIndex = target.cells.findIndex((c) => sameCell(c, cell))
      const canBrake = player.value.characterId === 'russell'
      clearSelection()
      if (remoteCard(inst.uid, { dir: target.dir, ...(canBrake && inst.toolId === 'move' ? { stopAfter: target.stops?.[stopIndex] ?? stopIndex + 1 } : {}) })) return
      if (inst.toolId === 'move') resolveMoveCard(state, target.dir, canBrake ? target.stops?.[stopIndex] ?? stopIndex + 1 : undefined, inst.uid)
      else playLeapTool(state, inst.uid, target.dir)
      if (isTutorial.value && tutorialStep.value === 3) tutorialStep.value = 4
      return
    }
    case 'cell':
      if (!blinkCells(state, player.value).some(c => sameCell(c, cell))) { actionNotice.value = '瞬步需要选择附近的高亮落点。'; return }
      clearSelection()
      if (remoteCard(inst.uid, { target: cell })) return
      playBlinkTool(state, inst.uid, cell)
      return
    case 'anywhere':
      if (!teleportCells(state).some(c => sameCell(c, cell))) { actionNotice.value = '该格不能作为瞬移落点，请选择高亮地块。'; return }
      clearSelection()
      if (remoteCard(inst.uid, { target: cell })) return
      playTeleportTool(state, inst.uid, cell)
      return
    case 'adjacent':
      if (!adjacentFreeCells(state, player.value).some(c => sameCell(c, cell))) { actionNotice.value = '请选择相邻的空白地块，特殊地形不能被覆盖。'; return }
      clearSelection()
      if (remoteCard(inst.uid, { target: cell })) return
      playAdjacentTool(state, inst.uid, cell)
      return
    case 'storm':
      if (!stormCells.value.some(c => sameCell(c, cell))) { actionNotice.value = '请选择3格范围内的高亮空地。'; return }
      clearSelection()
      if (remoteCard(inst.uid, { target: cell })) return
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
      if (!slideTargets.value.some(target => target.dir === dir)) { actionNotice.value = '这个方向被阻挡，请选择其他方向。'; return }
      clearSelection()
      if (remoteCard(inst.uid, { dir })) return
      if (inst.toolId === 'move') resolveMoveCard(state, dir, undefined, inst.uid)
      else playLeapTool(state, inst.uid, dir)
      if (isTutorial.value && tutorialStep.value === 3) tutorialStep.value = 4
      return
    case 'direction':
      clearSelection()
      if (remoteCard(inst.uid, { dir })) return
      playDirectionTool(state, inst.uid, dir)
      return
    case 'player-dir': {
      const targetId = towTargetId.value
      clearSelection()
      if (targetId && remoteCard(inst.uid, { targetId, dir })) return
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
    // 机器人可能在教学首轮抵达终点；结算后不再等待一个不会到来的真人回合。
    if (tutorialStep.value === 6 && props.state.finished) { tutorialStep.value = 7; return }
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
let disposed = false

function scheduleAI() {
  window.clearTimeout(aiTimer)
  if (disposed || props.remote || props.state.finished || presenting.value || aiBusy.value) return
  const current = activePlayer(props.state)
  if (!current.isAI) return
  aiTimer = window.setTimeout(async () => {
    if (disposed || presenting.value || aiBusy.value || props.state.finished || !activePlayer(props.state).isAI) return
    const actingPlayer = activePlayer(props.state)
    const phaseBefore = props.state.phase
    const handBefore = actingPlayer.hand.map((card) => ({ ...card }))
    const attempted = props.state.aiTelemetry?.lastAttempt
    const shouldThink = props.state.aiMode === 'cloud' && phaseBefore === 'action' && !props.state.pendingReward
      && !(attempted?.turnNumber === props.state.turnNumber && attempted.playerId === actingPlayer.id)
      && listTacticalActions(props.state, actingPlayer.id).length >= 2
    aiBusy.value = true
    thinkingPlayerName.value = shouldThink ? actingPlayer.name : ''
    let acted = false
    try {
      acted = (await opponentController.step(props.state)).acted
    } catch {
      // 意外的本地调度错误也不能卡住对局；正常模型失败由控制器统计并降级。
      if (!disposed && !props.state.finished && activePlayer(props.state).id === actingPlayer.id) acted = aiStep(props.state)
    } finally {
      aiBusy.value = false
      thinkingPlayerName.value = ''
    }
    if (disposed) return
    if (!acted) { scheduleAI(); return }

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

function armTimer(remaining = TURN_SECONDS) {
  window.clearInterval(tickTimer)
  if (props.remote) {
    const update = () => {
      const controls = props.remote!
      const clock = Math.max(Date.now() + controls.serverOffsetMs, controls.timerHoldUntil ?? 0)
      timeLeft.value = controls.deadlineAt === null ? TURN_SECONDS : Math.max(0, Math.ceil((controls.deadlineAt - clock) / 1000))
    }
    update(); tickTimer = window.setInterval(update, 250)
    return
  }
  timeLeft.value = remaining
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
  if (props.remote || props.state.finished) return
  clearSelection()
  timeoutTurn(props.state)
}

watch(
  () => [props.state, props.state.activeIndex, props.state.finished],
  () => armTimer(),
)
watch(() => props.remote?.deadlineAt, () => armTimer())

onMounted(() => {
  scheduleAI()
  armTimer(props.initialProgress?.timeLeft ?? TURN_SECONDS)
})

onBeforeUnmount(() => {
  disposed = true
  opponentController.dispose()
  remotePresentations.length = 0
  window.clearTimeout(aiTimer)
  window.clearInterval(tickTimer)
  window.clearTimeout(aiCardTimer)
  window.clearTimeout(diceRevealTimer)
  window.clearTimeout(diceHideTimer)
})

function onGameKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || (event.target instanceof Element && event.target.closest('input, textarea, select'))) return
  clearSelection()
}
onMounted(() => window.addEventListener('keydown', onGameKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGameKey))

function pickReward(index: number) {
  if (props.remote) { void props.remote.submit({ type: 'reward', index }); return }
  chooseReward(props.state, index)
}

const timerPercent = computed(() => `${Math.max(0, (timeLeft.value / TURN_SECONDS) * 100)}%`)
</script>

<template>
  <main class="game-shell" :class="{ 'cloud-match': state.aiMode === 'cloud' }">
    <p v-if="storageNotice" role="alert" class="app-notice">{{ storageNotice }} <button type="button" @click="storageNotice = ''">关闭提示</button></p>
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

      <div class="phase-banner" role="status" aria-live="polite">
        <strong>{{ bannerText }}</strong>
        <template v-if="!state.finished"> · {{ phaseText }}<template v-if="state.mechanisms.turnTimer && (canInteract || (remote && !player.isAI))"> · {{ timeLeft }}s</template></template>
      </div>

      <div class="game-actions">
        <label class="speed-control">
          <span>动画速度</span>
          <select v-model.number="animationSpeed" aria-label="动画速度">
            <option v-for="option in speedOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </label>
        <button type="button" class="camera-fit" @click="boardView?.fitToView()">最佳屏幕大小</button>
        <button type="button" class="game-exit" @click="emit('exit')">{{ remote ? '离开房间' : '返回首页' }}</button>
      </div>
      <p v-if="saveStatus" class="save-status" role="status" :class="{ 'save-failed': remote ? !remote.connected || !!remote.pauseReason : saveStatus !== '本局已自动保存' }">{{ saveStatus }}</p>
      <p class="camera-help">拖动平移棋盘 · 滚轮缩放 · 视角固定</p>

      <TacticalAssistant v-show="targetMode === 'none'" :state="state" :my-id="myId" :can-interact="canInteract"
        :remote="remote" @applied="onTacticalApplied" />
      <OpponentInsight v-if="!isTutorial" :state="state" :thinking="remote?.thinkingPlayerName ?? thinkingPlayerName" />

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

      <p v-if="actionNotice" class="action-notice" role="status">{{ actionNotice }}</p>
      <p v-else-if="targetingHint && selectedInstance?.toolId !== 'move'" class="targeting-hint">{{ targetingHint }}</p>

      <MovementChoices v-if="canInteract && targetMode === 'slide' && selectedInstance?.toolId === 'move'"
        :state="state" :player-id="myId" :uid="selectedInstance.uid" @choose="onDirPick" @cancel="clearSelection" />

      <nav v-if="showDirPad && selectedInstance?.toolId !== 'move'" class="dir-pad" aria-label="方向选择">
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
      :viewer-id="remote ? myId : undefined"
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
        <h2 class="settlement-title"><span>{{ ranking[0]?.player.name }}</span> <span>抵达终点</span></h2>
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
        <OpponentInsight :state="state" settlement />
        <div class="settlement-actions">
          <button v-if="!remote || remote.isHost" type="button" class="pill-button primary" @click="emit('restart')">{{ remote ? '回大厅再来一局' : '再来一局' }}</button>
          <button type="button" class="pill-button" @click="emit('exit')">{{ remote ? '离开房间' : '返回首页' }}</button>
        </div>
      </section>
    </div>
  </main>
</template>
