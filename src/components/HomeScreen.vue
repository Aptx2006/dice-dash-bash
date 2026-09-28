<script setup lang="ts">
import { computed, ref } from 'vue'
import { MAPS, MAP_LEGEND } from '../game/maps.ts'
import { TERRAINS } from '../game/terrains.ts'
import type { TerrainKind } from '../game/types.ts'

const emit = defineEmits<{
  create: [payload: { name: string; mapId: string }]
  join: [payload: { name: string; code: string }]
  tutorial: [payload: { name: string }]
}>()

const playerName = ref(localStorage.getItem('dice-player-name') || '')
const joinCode = ref('')
const mode = ref<'race' | 'battle' | 'prank'>('race')
const mapIndex = ref(0)
const joinHint = ref('')

const map = computed(() => MAPS[mapIndex.value])

const terrainCss: Record<TerrainKind, string> = (() => {
  const out = {} as Record<TerrainKind, string>
  for (const [kind, def] of Object.entries(TERRAINS)) {
    out[kind as TerrainKind] = '#' + def.color.toString(16).padStart(6, '0')
  }
  return out
})()

function tileStyle(ch: string) {
  const entry = MAP_LEGEND[ch]
  const kind: TerrainKind = entry?.kind ?? 'floor'
  if (kind === 'floor') return { background: '#e8dcb8' }
  if (kind === 'start') return { background: '#e8dcb8', boxShadow: 'inset 0 0 0 2px #d9a441' }
  if (kind === 'goal') return { background: terrainCss.lucky, boxShadow: 'inset 0 0 0 2px #d9a441' }
  if (kind === 'conveyor') return { background: terrainCss.conveyor, color: '#2c3550', fontSize: '0.55em' }
  return { background: terrainCss[kind] }
}

function tileGlyph(ch: string): string {
  const entry = MAP_LEGEND[ch]
  if (!entry) return ''
  if (entry.kind === 'conveyor') return { left: '←', right: '→', up: '↑', down: '↓' }[entry.dir ?? 'up'] ?? ''
  if (entry.kind === 'lucky') return '?'
  return ''
}

function prevMap() {
  mapIndex.value = (mapIndex.value - 1 + MAPS.length) % MAPS.length
}

function nextMap() {
  mapIndex.value = (mapIndex.value + 1) % MAPS.length
}

function submitCreate() {
  const name = playerName.value.trim() || '玩家'
  localStorage.setItem('dice-player-name', name)
  joinHint.value = ''
  emit('create', { name, mapId: map.value.id })
}

function submitJoin() {
  const name = playerName.value.trim() || '玩家'
  const code = joinCode.value.trim().toUpperCase()
  if (code.length < 4) {
    joinHint.value = '请输入完整的房间码。'
    return
  }
  localStorage.setItem('dice-player-name', name)
  emit('join', { name, code })
}

function startTutorial() {
  const name = playerName.value.trim() || '玩家'
  emit('tutorial', { name })
}
</script>

<template>
  <main class="home-shell">
    <section class="home-hero">
      <p class="eyebrow">骰子 · 棋盘 · 一路开赛</p>
      <h1>当骰一棒</h1>
      <p class="sub">AI 决策 · 多人回合制桌游——掷骰滑行、道具乱斗，与会算计的智能体对手抢先冲线。</p>
      <nav class="mode-toggle" aria-label="模式选择">
        <button type="button" :class="{ active: mode === 'race' }" @click="mode = 'race'">竞速模式</button>
        <button type="button" :class="{ active: mode === 'battle' }" disabled title="开发中">对战模式</button>
        <button type="button" :class="{ active: mode === 'prank' }" disabled title="开发中">整蛊模式</button>
      </nav>
      <button type="button" class="tutorial-entry" @click="startTutorial">
        <span>?</span>
        <strong>第一次游玩？进入基础教学</strong>
      </button>
    </section>

    <section class="map-stage" aria-label="地图预览">
      <button type="button" class="map-arrow prev" aria-label="上一张地图" @click="prevMap">‹</button>
      <div class="map-frame">
        <div class="map-title-row">
          <strong>{{ map.label }}</strong>
          <small>{{ map.desc }}</small>
        </div>
        <div class="map-grid" :style="{ gridTemplateColumns: `repeat(${Math.max(...map.grid.map((r) => r.length))}, 1fr)` }">
          <template v-for="(row, y) in map.grid" :key="y">
            <i v-for="(ch, x) in row" :key="`${y}-${x}`" :style="tileStyle(ch)">{{ tileGlyph(ch) }}</i>
          </template>
        </div>
      </div>
      <button type="button" class="map-arrow next" aria-label="下一张地图" @click="nextMap">›</button>
    </section>

    <form class="home-form" @submit.prevent>
      <div class="home-field">
        <label for="home-name">你的昵称</label>
        <input id="home-name" v-model="playerName" maxlength="12" autocomplete="nickname" placeholder="输个响亮的名字" />
      </div>
      <button type="button" class="pill-button primary" @click="submitCreate">创建房间</button>
      <div class="home-field">
        <label for="home-join">加入房间</label>
        <input id="home-join" v-model="joinCode" class="join-code" maxlength="6" placeholder="房间码" @keyup.enter="submitJoin" />
      </div>
      <button type="button" class="pill-button" @click="submitJoin">加入</button>
    </form>
    <p v-if="joinHint" class="home-note" role="alert">{{ joinHint }}</p>
  </main>
</template>
