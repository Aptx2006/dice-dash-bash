<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import HomeScreen from './components/HomeScreen.vue'
import LobbyScreen from './components/LobbyScreen.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import { createGame, restoreGame } from './game/engine.ts'
import type { GameConfig, GameState } from './game/types.ts'
import { writePreference } from './storage/preferences.ts'
import { loadMatch, saveMatch } from './storage/savedMatch.ts'

// Three.js 只在进入对局时加载，首页和大厅保持轻量。
const GameScreen = defineAsyncComponent(() => import('./components/GameScreen.vue'))

const screen = ref<'home' | 'lobby' | 'game'>('home')
const playerName = ref('')
const mapId = ref('race1')
const roomCode = ref('')
const lastConfig = ref<GameConfig | null>(null)
const state = ref<GameState | null>(null)
const tutorialMode = ref(false)
const loadedMatch = loadMatch()
const savedMatch = ref(loadedMatch.match)
const appNotice = ref(loadedMatch.warning)
const gameKey = ref(0)
const progress = ref({ tutorialStep: -1, timeLeft: 75 })
const initialProgress = ref({ tutorialStep: -1, timeLeft: 75 })
const saveStatus = ref('')
const pendingConfig = ref<GameConfig | null>(null)
const exitWarning = ref(false)

function copyConfig(config: GameConfig): GameConfig {
  return { mapId: config.mapId, players: config.players.map(player => ({ ...player })), mechanisms: { ...config.mechanisms } }
}

function persistCurrentMatch(): boolean {
  if (screen.value !== 'game' || !state.value || !lastConfig.value) return true
  const result = saveMatch({ config: lastConfig.value, state: state.value, roomCode: roomCode.value, ...progress.value })
  saveStatus.value = result.warning || '本局已自动保存'
  if (result.match) savedMatch.value = result.match
  return !result.warning
}

// Vue在同步规则命令结束后批量触发，避免写入发牌/领奖过程中的中间状态。
watch([state, progress], () => persistCurrentMatch(), { deep: true, flush: 'post' })
onMounted(() => window.addEventListener('pagehide', persistCurrentMatch))
onBeforeUnmount(() => window.removeEventListener('pagehide', persistCurrentMatch))

function onResume() {
  const result = loadMatch()
  savedMatch.value = result.match
  if (!result.match) {
    appNotice.value = result.warning || '没有找到可继续的对局。'
    return
  }
  const saved = result.match
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

function onCreate(payload: { name: string; mapId: string }) {
  appNotice.value = writePreference('dice-player-name', payload.name)
  tutorialMode.value = false
  lastConfig.value = null
  playerName.value = payload.name
  mapId.value = payload.mapId
  roomCode.value = newRoomCode()
  screen.value = 'lobby'
}

function onJoin(payload: { name: string; code: string }) {
  void payload
  appNotice.value = '联机房间尚未开放，请创建本地房间或体验教学。'
}

function onTutorial(payload: { name: string }) {
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
}

function onStart(config: GameConfig) {
  if (!state.value && savedMatch.value && !savedMatch.value.state.finished) {
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
  if (lastConfig.value) startMatch(lastConfig.value)
}

function onExit() {
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
  <HomeScreen v-if="screen === 'home'" :saved-match="savedMatch" @resume="onResume" @create="onCreate" @join="onJoin" @tutorial="onTutorial" />
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
    v-else-if="state"
    :key="gameKey"
    :state="state"
    my-id="human"
    :tutorial="tutorialMode"
    :initial-progress="initialProgress"
    :save-status="saveStatus"
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
</template>
