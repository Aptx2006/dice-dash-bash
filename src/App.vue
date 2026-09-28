<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue'
import HomeScreen from './components/HomeScreen.vue'
import LobbyScreen from './components/LobbyScreen.vue'
import { createGame } from './game/engine.ts'
import type { GameConfig, GameState } from './game/types.ts'

// Three.js 只在进入对局时加载，首页和大厅保持轻量。
const GameScreen = defineAsyncComponent(() => import('./components/GameScreen.vue'))

const screen = ref<'home' | 'lobby' | 'game'>('home')
const playerName = ref('')
const mapId = ref('race1')
const roomCode = ref('')
const lastConfig = ref<GameConfig | null>(null)
const state = ref<GameState | null>(null)
const tutorialMode = ref(false)

function newRoomCode(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

function onCreate(payload: { name: string; mapId: string }) {
  tutorialMode.value = false
  lastConfig.value = null
  playerName.value = payload.name
  mapId.value = payload.mapId
  roomCode.value = newRoomCode()
  screen.value = 'lobby'
}

function onJoin(payload: { name: string; code: string }) {
  // 本地原型：房间码暂作座位标识直接进大厅，联机对战后续接入
  playerName.value = payload.name
  roomCode.value = payload.code
  screen.value = 'lobby'
}

function onTutorial(payload: { name: string }) {
  const name = payload.name.trim() || '玩家'
  localStorage.setItem('dice-player-name', name)
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
  lastConfig.value = config
  state.value = createGame(config)
  screen.value = 'game'
}

function onStart(config: GameConfig) {
  lastConfig.value = config
  state.value = createGame(config)
  screen.value = 'game'
}

function onRestart() {
  if (lastConfig.value) onStart(lastConfig.value)
}

function onExit() {
  state.value = null
  if (tutorialMode.value) {
    tutorialMode.value = false
    screen.value = 'home'
  } else {
    screen.value = 'lobby'
  }
}
</script>

<template>
  <HomeScreen v-if="screen === 'home'" @create="onCreate" @join="onJoin" @tutorial="onTutorial" />
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
    :state="state"
    my-id="human"
    :tutorial="tutorialMode"
    @exit="onExit"
    @restart="onRestart"
  />
</template>
