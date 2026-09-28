<script setup lang="ts">
import { computed, ref } from 'vue'
import { CHARACTERS, AI_CHARACTER, characterById } from '../game/characters.ts'
import type { GameConfig, GamePlayerConfig } from '../game/types.ts'
import { mapById } from '../game/maps.ts'
import { TOOLS } from '../game/tools.ts'

interface LobbySlot {
  key: string
  name: string
  isAI: boolean
  characterId: string
  pieceColor: string
}

const props = defineProps<{
  roomCode: string
  playerName: string
  mapId: string
  initialConfig?: GameConfig | null
}>()

const emit = defineEmits<{
  start: [config: GameConfig]
  back: []
}>()

const PIECE_COLORS = ['#f2a75c', '#5f8d95', '#8fdfba', '#c9a0e8', '#7fb8e8', '#efc66d', '#d9714f', '#a8c86a']

const savedHuman = props.initialConfig?.players.find((player) => !player.isAI)
const mySlot = ref<LobbySlot>({
  key: 'human',
  name: savedHuman?.name ?? props.playerName,
  isAI: false,
  characterId: savedHuman?.characterId ?? 'villager',
  pieceColor: savedHuman?.pieceColor ?? PIECE_COLORS[0],
})
const aiSlots = ref<LobbySlot[]>(
  (props.initialConfig?.players.filter((player) => player.isAI) ?? []).map((player, index) => ({
    key: `restored-ai-${index}`,
    name: player.name,
    isAI: true,
    characterId: player.characterId,
    pieceColor: player.pieceColor,
  })),
)
const airdrop = ref(props.initialConfig?.mechanisms.airdrop ?? true)
const turnTimer = ref(props.initialConfig?.mechanisms.turnTimer ?? true)
const pickerOpen = ref(false)

const mapDef = computed(() => mapById(props.mapId))

function nextFreeColor(used: string[]): string {
  return PIECE_COLORS.find((color) => !used.includes(color)) ?? PIECE_COLORS[0]
}

function robotName(): string {
  return `${AI_CHARACTER.name}-${Math.floor(100 + Math.random() * 900)}号`
}

function randomCharacter(exclude: string[]): string {
  const pool = CHARACTERS.filter((ch) => !exclude.includes(ch.id))
  const picked = pool[Math.floor(Math.random() * pool.length)] ?? CHARACTERS[0]
  return picked.id
}

function addAI() {
  if (aiSlots.value.length >= 7) return
  const usedColors = [mySlot.value.pieceColor, ...aiSlots.value.map((s) => s.pieceColor)]
  const usedChars = [mySlot.value.characterId, ...aiSlots.value.map((s) => s.characterId)]
  aiSlots.value.push({
    key: `ai-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    name: robotName(),
    isAI: true,
    characterId: randomCharacter(usedChars),
    pieceColor: nextFreeColor(usedColors),
  })
}

function removeAI(key: string) {
  aiSlots.value = aiSlots.value.filter((slot) => slot.key !== key)
}

function rerollAI(slot: LobbySlot) {
  const others = [mySlot.value.characterId, ...aiSlots.value.filter((s) => s.key !== slot.key).map((s) => s.characterId)]
  slot.characterId = randomCharacter(others)
}

function usedColor(color: string, exceptKey?: string): boolean {
  if (exceptKey !== mySlot.value.key && mySlot.value.pieceColor === color) return true
  return aiSlots.value.some((slot) => slot.key !== exceptKey && slot.pieceColor === color)
}

function pickColor(color: string) {
  if (usedColor(color, mySlot.value.key)) return
  mySlot.value.pieceColor = color
}

function pickCharacter(id: string) {
  mySlot.value.characterId = id
}

function associatedToolNames(characterId: string): string {
  const char = characterById(characterId)
  if (!char.associatedTools.length) return '无'
  return char.associatedTools.map((toolId) => TOOLS[toolId].name).join(' / ')
}

function startGame() {
  const players: GamePlayerConfig[] = [
    {
      name: mySlot.value.name.trim() || '玩家',
      isAI: false,
      characterId: mySlot.value.characterId,
      pieceColor: mySlot.value.pieceColor,
      isHost: true,
    },
    ...aiSlots.value.map((slot) => ({
      name: slot.name,
      isAI: true,
      characterId: slot.characterId,
      pieceColor: slot.pieceColor,
      isHost: false,
    })),
  ]
  emit('start', {
    mapId: props.mapId,
    players,
    mechanisms: { airdrop: airdrop.value, turnTimer: turnTimer.value },
  })
}

async function copyCode() {
  try {
    await navigator.clipboard.writeText(props.roomCode)
  } catch {
    /* 剪贴板不可用时静默忽略 */
  }
}

const slotsView = computed(() => [mySlot.value, ...aiSlots.value])
const emptySlots = computed(() => Math.max(0, 8 - slotsView.value.length))
</script>

<template>
  <main class="lobby-shell">
    <header class="lobby-header">
      <div class="room-brand">
        <p class="eyebrow">当骰一棒 · 竞速模式</p>
        <h2>{{ mapDef.label }}</h2>
        <div class="meta">
          <span>地图：{{ mapDef.desc }}</span>
          <span>房主：{{ mySlot.name }}</span>
        </div>
        <div class="mechanism-row">
          <button type="button" class="mechanism-toggle" :class="{ on: airdrop }" @click="airdrop = !airdrop">
            <span class="box">✓</span>骰子猪空投
          </button>
          <button type="button" class="mechanism-toggle" :class="{ on: turnTimer }" @click="turnTimer = !turnTimer">
            <span class="box">✓</span>回合计时（75秒）
          </button>
        </div>
      </div>
      <div class="room-code-panel">
        <div>
          <span class="label">房间码</span>
          <span class="code">{{ roomCode }}</span>
        </div>
        <button type="button" title="复制房间码" @click="copyCode">⧉</button>
      </div>
    </header>

    <div class="lobby-body">
      <section class="slot-grid" aria-label="玩家槽位">
        <article v-for="(slot, index) in slotsView" :key="slot.key" class="slot-card">
          <span class="slot-index">{{ index + 1 }}P</span>
          <button v-if="!slot.isAI" type="button" class="switch-btn" @click="pickerOpen = true">更换角色</button>
          <button v-else type="button" class="switch-btn" @click="rerollAI(slot)">换一个</button>
          <button v-if="slot.isAI" type="button" class="kick-btn" title="移除" @click="removeAI(slot.key)">×</button>
          <div class="slot-portrait">
            <span class="char-block" :style="{ background: characterById(slot.characterId).color }">
              {{ characterById(slot.characterId).name.slice(0, 1) }}
            </span>
          </div>
          <div class="slot-info">
            <p class="char-name">
              {{ characterById(slot.characterId).name }}
              <small>{{ characterById(slot.characterId).title }}</small>
            </p>
            <p class="char-skill">{{ characterById(slot.characterId).skill }}</p>
            <div class="slot-player">
              <span class="piece" :style="{ background: slot.pieceColor }">{{ slot.isAI ? 'AI' : '你' }}</span>
              <strong>{{ slot.name }}</strong>
            </div>
            <div class="slot-tags">
              <span v-if="!slot.isAI" class="tag-pill host">房主</span>
              <span v-else class="tag-pill">智能体</span>
              <span class="tag-pill ready">已准备</span>
            </div>
          </div>
        </article>

        <button v-for="n in emptySlots" :key="`empty-${n}`" type="button" class="slot-card empty" @click="addAI">
          + 添加AI玩家
        </button>
      </section>
    </div>

    <footer class="lobby-footer">
      <p class="status-line">当前 {{ slotsView.length }} 名选手 · 关联道具：{{ associatedToolNames(mySlot.characterId) }}</p>
      <div class="lobby-footer-actions">
        <button type="button" class="pill-button" @click="emit('back')">← 返回主页</button>
        <button type="button" class="pill-button primary" :disabled="slotsView.length < 2" @click="startGame">
          开始游戏
        </button>
      </div>
    </footer>

    <div v-if="pickerOpen" class="modal-backdrop" role="dialog" aria-modal="true" aria-label="选择角色">
      <section class="modal-card">
        <header class="modal-head">
          <h2>选择你的角色</h2>
          <button type="button" class="text-button" @click="pickerOpen = false">关闭</button>
        </header>
        <div class="character-grid">
          <button
            v-for="char in CHARACTERS"
            :key="char.id"
            type="button"
            class="character-card"
            :class="{ selected: mySlot.characterId === char.id }"
            @click="pickCharacter(char.id)"
          >
            <span class="character-portrait" :style="{ background: char.color }">{{ char.name.slice(0, 1) }}</span>
            <span class="character-copy">
              <span class="name-row"><strong>{{ char.name }}</strong><small>{{ char.title }}</small></span>
              <span class="skill">{{ char.skill }}</span>
              <span class="flavor">“{{ char.flavor }}”</span>
            </span>
          </button>
        </div>
        <p class="piece-row" aria-label="选择棋子颜色">
          <template v-for="color in PIECE_COLORS" :key="color">
            <button
              v-if="!usedColor(color, mySlot.key) || mySlot.pieceColor === color"
              type="button"
              class="piece-dot"
              :class="{ selected: mySlot.pieceColor === color }"
              :style="{ background: color }"
              :aria-label="`棋子颜色 ${color}`"
              @click="pickColor(color)"
            />
          </template>
        </p>
      </section>
    </div>
  </main>
</template>
