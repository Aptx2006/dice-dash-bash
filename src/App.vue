<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import HomeScreen from './components/HomeScreen.vue'
import LobbyScreen from './components/LobbyScreen.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import OnlineLobby from './components/OnlineLobby.vue'
import { createGame, restoreGame } from './game/engine.ts'
import type { GameConfig, GameState } from './game/types.ts'
import { writePreference } from './storage/preferences.ts'
import { loadMatch, saveMatch, loadTutorial, saveTutorial, type SavedMatch } from './storage/savedMatch.ts'
import { loadRoomSession, saveRoomSession, roomApi, watchRoom, RoomRequestError } from './network/client.ts'
import type { RemoteGameControls, RoomCommand, RoomSession, RoomView } from './network/types.ts'

// Three.js 只在进入对局时加载，首页和大厅保持轻量。
const GameScreen = defineAsyncComponent(() => import('./components/GameScreen.vue'))

const screen = ref<'home' | 'lobby' | 'online' | 'game'>('home')
watch(screen, () => { void nextTick(() => window.scrollTo(0, 0)) })
const playerName = ref('')
const mapId = ref('race1')
const roomCode = ref('')
const lastConfig = ref<GameConfig | null>(null)
const state = ref<GameState | null>(null)
const tutorialMode = ref(false)
const loadedMatch = loadMatch()
const savedMatch = ref(loadedMatch.match)
const savedTutorial = ref(loadTutorial().match)
const appNotice = ref(loadedMatch.warning)
const gameKey = ref(0)
const progress = ref({ tutorialStep: -1, timeLeft: 75 })
const initialProgress = ref({ tutorialStep: -1, timeLeft: 75 })
const saveStatus = ref('')
const pendingConfig = ref<GameConfig | null>(null)
const exitWarning = ref(false)
const onlineSession = shallowRef<RoomSession | null>(null)
const onlineRoom = shallowRef<RoomView | null>(null)
const savedOnline = shallowRef(loadRoomSession())
const connecting = ref(false), roomConnected = ref(false), commandBusy = ref(false)
const onlineLeaveQuestion = ref(false)
let networkGeneration = 0, stopRoom: (() => void) | undefined, suggestionRevision: number | null = null
let remoteGameId = ''
const serverOffset = ref(0)
const myGameId = computed(() => onlineRoom.value?.members.find(member => member.id === onlineRoom.value?.selfId)?.gamePlayerId ?? 'human')

function applyRoom(view: RoomView) {
  const previous = onlineRoom.value
  if (previous?.id === view.id && (view.revision < previous.revision || (view.revision === previous.revision && view.syncId < previous.syncId))) return
  onlineRoom.value = view
  serverOffset.value = view.serverNow - Date.now()
  connecting.value = false
  if (view.status === 'lobby') { screen.value = 'online'; state.value = null }
  else if (view.game) {
    if (remoteGameId !== view.gameId) { gameKey.value++; remoteGameId = view.gameId!; initialProgress.value = { tutorialStep: -1, timeLeft: 75 } }
    if (!state.value || JSON.stringify(state.value) !== JSON.stringify(view.game)) state.value = view.game
    tutorialMode.value = false; screen.value = 'game'
  }
}
function detachRoom() {
  networkGeneration++; stopRoom?.(); stopRoom = undefined
  onlineSession.value = null; onlineRoom.value = null; roomConnected.value = false
  connecting.value = false; commandBusy.value = false; suggestionRevision = null; remoteGameId = ''
}
function attachRoom(session: RoomSession, snapshot: RoomView) {
  detachRoom(); const generation = networkGeneration
  onlineSession.value = session; savedOnline.value = session
  const warning = saveRoomSession(session); if (warning) appNotice.value = warning
  applyRoom(snapshot)
  stopRoom = watchRoom(session, view => { if (networkGeneration === generation) applyRoom(view) },
    connected => { if (networkGeneration === generation) roomConnected.value = connected },
    message => {
      if (networkGeneration !== generation) return
      detachRoom(); savedOnline.value = null; saveRoomSession(null); state.value = null; screen.value = 'home'; appNotice.value = message
    })
}
async function connectOnline(kind: 'create' | 'join' | 'resume', payload?: { name: string; mapId?: string; code?: string }) {
  if (connecting.value) return
  connecting.value = true; appNotice.value = ''
  const generation = networkGeneration
  try {
    if (kind === 'resume') {
      if (!savedOnline.value) return
      const snapshot = await roomApi.snapshot(savedOnline.value)
      if (generation === networkGeneration) attachRoom(savedOnline.value, snapshot)
    } else {
      const result = kind === 'create' ? await roomApi.create(payload!.name, payload!.mapId!) : await roomApi.join(payload!.code!, payload!.name)
      if (generation === networkGeneration) { writePreference('dice-player-name', payload!.name); attachRoom(result.session, result.snapshot) }
    }
  } catch (error) {
    if (generation !== networkGeneration) return
    appNotice.value = error instanceof Error ? error.message : '无法连接房间。'
    if (kind === 'resume' && error instanceof RoomRequestError && [401, 404].includes(error.status)) { savedOnline.value = null; saveRoomSession(null) }
  } finally { connecting.value = false }
}
async function sendRoomCommand(command: RoomCommand, expectedRevision = onlineRoom.value?.revision): Promise<boolean> {
  const session = onlineSession.value
  if (!session || expectedRevision === undefined || commandBusy.value || !roomConnected.value) return false
  const generation = networkGeneration
  commandBusy.value = true; appNotice.value = ''
  try {
    const view = await roomApi.command(session, expectedRevision, command)
    if (generation !== networkGeneration) return false
    if (view) applyRoom(view)
    return true
  } catch (error) {
    if (generation !== networkGeneration) return false
    appNotice.value = error instanceof Error ? error.message : '操作失败，请重试。'
    try { const latest = await roomApi.snapshot(session); if (generation === networkGeneration) applyRoom(latest) } catch { /* SSE继续重连。 */ }
    return false
  } finally { if (generation === networkGeneration) commandBusy.value = false }
}
const remoteControls = computed<RemoteGameControls | undefined>(() => {
  const room = onlineRoom.value, session = onlineSession.value
  if (!room || !session) return undefined
  return {
    roomId: room.id, hostId: room.hostId, members: room.members, isHost: room.hostId === room.selfId, revision: room.revision, connected: roomConnected.value, busy: commandBusy.value || !!room.pauseReason,
    deadlineAt: room.deadlineAt, timerHoldUntil: room.timerHoldUntil, serverOffsetMs: serverOffset.value,
    thinkingPlayerName: room.thinkingPlayerName, pauseReason: room.pauseReason, presentation: room.presentation, submit: sendRoomCommand,
    suggest: async (goal, signal) => {
      const revision = onlineRoom.value!.revision, generation = networkGeneration
      const result = await roomApi.suggest(session, goal, signal)
      if (generation !== networkGeneration || onlineRoom.value?.revision !== revision) throw new Error('局面已经改变。')
      suggestionRevision = revision; return result
    },
    applySuggestion: actionId => suggestionRevision === onlineRoom.value?.revision
      ? sendRoomCommand({ type: 'tactical', actionId }, suggestionRevision!) : Promise.resolve(false),
  }
})
async function leaveOnline() {
  const session = onlineSession.value, revision = onlineRoom.value?.revision
  onlineLeaveQuestion.value = false
  detachRoom(); savedOnline.value = null; saveRoomSession(null); state.value = null; screen.value = 'home'
  if (session && revision !== undefined) { try { await roomApi.command(session, revision, { type: 'leave' }) } catch { /* 断开的座位在宽限期后由服务器接管。 */ } }
}

function copyConfig(config: GameConfig): GameConfig {
  return { mapId: config.mapId, players: config.players.map(player => ({ ...player })), mechanisms: { ...config.mechanisms }, aiMode: config.aiMode ?? 'rules' }
}

function persistCurrentMatch(): boolean {
  if (onlineSession.value || screen.value !== 'game' || !state.value || !lastConfig.value) return true
  const input = { config: lastConfig.value, state: state.value, roomCode: roomCode.value, ...progress.value }
  const result = tutorialMode.value ? saveTutorial(input) : saveMatch(input)
  saveStatus.value = result.warning || '本局已自动保存'
  if (result.match) {
    if (tutorialMode.value) savedTutorial.value = result.match
    else savedMatch.value = result.match
  }
  return !result.warning
}

// Vue在同步规则命令结束后批量触发，避免写入发牌/领奖过程中的中间状态。
watch([state, progress], () => persistCurrentMatch(), { deep: true, flush: 'post' })
onMounted(() => window.addEventListener('pagehide', persistCurrentMatch))
onBeforeUnmount(() => window.removeEventListener('pagehide', persistCurrentMatch))
onMounted(() => { if (savedOnline.value) void connectOnline('resume') })
onBeforeUnmount(() => detachRoom())

function onResume() {
  const result = loadMatch()
  savedMatch.value = result.match
  if (!result.match) {
    appNotice.value = result.warning || '没有找到可继续的对局。'
    return
  }
  const saved = result.match.config.mapId === 'tutorial' ? loadTutorial().match ?? result.match : result.match
  restoreMatch(saved)
}

function restoreMatch(saved: SavedMatch) {
  lastConfig.value = copyConfig(saved.config)
  state.value = restoreGame(saved.state)
  roomCode.value = saved.roomCode
  playerName.value = saved.config.players[0].name
  mapId.value = saved.config.mapId
  tutorialMode.value = saved.config.mapId === 'tutorial'
  // 方向预选不属于已提交动作；恢复后让玩家重新选择移动牌。
  initialProgress.value = { tutorialStep: saved.tutorialStep === 3 ? 2 : saved.tutorialStep, timeLeft: saved.timeLeft }
  progress.value = { ...initialProgress.value }
  gameKey.value++
  screen.value = 'game'
  appNotice.value = ''
  persistCurrentMatch()
}

function newRoomCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

function onPractice(payload: { name: string; mapId: string }) {
  appNotice.value = writePreference('dice-player-name', payload.name)
  tutorialMode.value = false
  lastConfig.value = null
  playerName.value = payload.name
  mapId.value = payload.mapId
  roomCode.value = newRoomCode()
  screen.value = 'lobby'
}

function onCreate(payload: { name: string; mapId: string }) { void connectOnline('create', payload) }
function onJoin(payload: { name: string; code: string }) { void connectOnline('join', payload) }

function onTutorial(payload: { name: string }) {
  const result = loadTutorial()
  if (result.match && !result.match.state.finished && result.match.tutorialStep < 7) {
    savedTutorial.value = result.match
    restoreMatch(result.match)
    return
  }
  const name = payload.name.trim() || '玩家'
  appNotice.value = writePreference('dice-player-name', name)
  playerName.value = name
  mapId.value = 'tutorial'
  roomCode.value = 'TRAIN'
  tutorialMode.value = true
  const config: GameConfig = {
    mapId: 'tutorial',
    players: [
      {
        name,
        isAI: false,
        characterId: 'villager',
        pieceColor: '#f2a75c',
        isHost: true,
      },
      {
        name: '教学机器人',
        isAI: true,
        characterId: 'robot',
        pieceColor: '#5f8d95',
        isHost: false,
      },
    ],
    mechanisms: { airdrop: false, turnTimer: false },
  }
  onStart(config)
  if (result.warning) appNotice.value = result.warning
}

function onStart(config: GameConfig) {
  if (config.mapId !== 'tutorial' && !state.value && savedMatch.value && !savedMatch.value.state.finished) {
    pendingConfig.value = copyConfig(config)
    return
  }
  startMatch(config)
}

function startMatch(config: GameConfig) {
  try {
    const nextState = createGame(config)
    lastConfig.value = copyConfig(config)
    state.value = nextState
    tutorialMode.value = config.mapId === 'tutorial'
    initialProgress.value = { tutorialStep: tutorialMode.value ? 0 : -1, timeLeft: 75 }
    progress.value = { ...initialProgress.value }
    gameKey.value++
    screen.value = 'game'
    pendingConfig.value = null
    persistCurrentMatch()
  } catch (error) {
    appNotice.value = error instanceof Error ? error.message : '创建对局失败，请检查配置。'
  }
}

function onRestart() {
  if (onlineSession.value) { void sendRoomCommand({ type: 'rematch' }); return }
  if (lastConfig.value) startMatch(lastConfig.value)
}

function onExit() {
  if (onlineSession.value) { onlineLeaveQuestion.value = true; return }
  if (!persistCurrentMatch()) {
    exitWarning.value = true
    return
  }
  leaveGame()
}

function leaveGame() {
  exitWarning.value = false
  state.value = null
  tutorialMode.value = false
  screen.value = 'home'
}
</script>

<template>
  <p v-if="appNotice" role="alert" class="app-notice">{{ appNotice }} <button type="button" @click="appNotice = ''">关闭提示</button></p>
  <HomeScreen v-if="screen === 'home'" :saved-match="savedMatch" :tutorial-resume="!!savedTutorial && !savedTutorial.state.finished && savedTutorial.tutorialStep < 7" :busy="connecting" :online-resume="!!savedOnline"
    @resume="onResume" @create="onCreate" @join="onJoin" @tutorial="onTutorial" @practice="onPractice" @resume-online="connectOnline('resume')" />
  <OnlineLobby v-else-if="screen === 'online' && onlineRoom" :room="onlineRoom" :connected="roomConnected" :busy="commandBusy || !!onlineRoom.pauseReason"
    @command="sendRoomCommand" @leave="onlineLeaveQuestion = true" />
  <LobbyScreen
    v-else-if="screen === 'lobby'"
    :key="roomCode"
    :room-code="roomCode"
    :player-name="playerName"
    :map-id="mapId"
    :initial-config="lastConfig"
    @start="onStart"
    @back="screen = 'home'"
  />
  <GameScreen
    v-else-if="screen === 'game' && state"
    :key="gameKey"
    :state="state"
    :my-id="onlineSession ? myGameId : 'human'"
    :tutorial="tutorialMode"
    :initial-progress="initialProgress"
    :save-status="onlineSession ? onlineRoom?.pauseReason || (roomConnected ? `房间 ${onlineSession.roomId} · 实时同步` : '连接中断，正在重新连接…') : saveStatus"
    :remote="remoteControls"
    @checkpoint="progress = $event"
    @exit="onExit"
    @restart="onRestart"
  />
  <ConfirmDialog v-if="pendingConfig" title="开始新对局？"
    message="你还有一局未完成的游戏。开始新对局会替换这份存档。"
    cancel-label="保留存档" confirm-label="开始新对局"
    @cancel="pendingConfig = null" @confirm="startMatch(pendingConfig!)" />
  <ConfirmDialog v-if="exitWarning" title="这局还没有保存成功"
    message="浏览器暂时无法保存进度。现在退出会丢失尚未保存的操作。"
    cancel-label="继续游戏" confirm-label="仍然退出"
    @cancel="exitWarning = false" @confirm="leaveGame" />
  <ConfirmDialog v-if="onlineLeaveQuestion" title="离开联机房间？"
    :message="onlineRoom?.status === 'playing' ? '离开后，你的角色将由机器人接管，其他玩家可以继续对局。' : '离开后可使用房间号重新加入尚未开始的房间。'"
    cancel-label="继续留在房间" confirm-label="离开房间" @cancel="onlineLeaveQuestion = false" @confirm="leaveOnline" />
</template>
