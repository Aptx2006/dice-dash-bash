<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RoomView, RoomCommand } from '../network/types.ts'
import { CHARACTERS, AI_CHARACTER, characterById } from '../game/characters.ts'
import { MAPS, mapById } from '../game/maps.ts'
const props = defineProps<{ room: RoomView; connected: boolean; busy: boolean }>()
const emit = defineEmits<{ command: [command: RoomCommand]; leave: [] }>()
const isHost = computed(() => props.room.hostId === props.room.selfId)
const self = computed(() => props.room.members.find(member => member.id === props.room.selfId)!)
const map = computed(() => mapById(props.room.config.mapId))
const canStart = computed(() => isHost.value && props.connected && !props.busy && props.room.members.length >= 2
  && props.room.members.every(member => member.isAI || (member.ready && member.connected)))
const notice = ref('')
const characters = [...CHARACTERS, AI_CHARACTER]
const colors = ['#f2a75c', '#5f8d95', '#8fdfba', '#c9a0e8', '#7fb8e8', '#efc66d', '#d9714f', '#a8c86a']
function setting(event: Event, field: 'mapId' | 'aiMode') {
  const value = (event.target as HTMLSelectElement).value
  if (field === 'mapId') emit('command', { type: 'configure', mapId: value })
  else emit('command', { type: 'configure', aiMode: value as 'rules' | 'cloud' })
}
async function copy(invite: boolean) {
  const text = invite ? `${window.location.origin}/?room=${props.room.id}` : props.room.id
  try { await navigator.clipboard.writeText(text); notice.value = invite ? '邀请链接已复制。' : '房间号已复制。' }
  catch { notice.value = `请手动复制：${text}` }
}
</script>

<template>
  <main class="lobby-shell online-lobby">
    <header class="lobby-header">
      <div class="room-brand">
        <p class="eyebrow">当骰一棒 · 联机房间</p>
        <h2>{{ map.label }}</h2>
        <p class="online-presence" role="status">{{ room.pauseReason || (connected ? '已连接 · 状态实时同步' : '连接中断，正在重新连接…') }}</p>
        <div class="mechanism-row">
          <label class="opponent-mode-control">地图<select :value="room.config.mapId" :disabled="!isHost || busy || !connected" aria-label="联机地图" @change="setting($event, 'mapId')"><option v-for="map in MAPS" :key="map.id" :value="map.id">{{ map.label }}</option></select></label>
          <button type="button" class="mechanism-toggle" :class="{ on: room.config.mechanisms.airdrop }" :aria-pressed="room.config.mechanisms.airdrop" :disabled="!isHost || busy || !connected" @click="emit('command', { type: 'configure', airdrop: !room.config.mechanisms.airdrop })"><span class="box">✓</span>骰子猪空投</button>
          <button type="button" class="mechanism-toggle" :class="{ on: room.config.mechanisms.turnTimer }" :aria-pressed="room.config.mechanisms.turnTimer" :disabled="!isHost || busy || !connected" @click="emit('command', { type: 'configure', turnTimer: !room.config.mechanisms.turnTimer })"><span class="box">✓</span>回合计时（75秒）</button>
          <label class="opponent-mode-control">机器人决策<select :value="room.config.aiMode" :disabled="!isHost || busy || !connected" aria-label="联机机器人决策" @change="setting($event, 'aiMode')"><option value="rules">快速策略</option><option value="cloud">云端智能体</option></select></label>
        </div>
        <p class="opponent-mode-hint">{{ isHost ? '邀请朋友加入，也可以添加机器人补位；修改规则后朋友需要重新准备。' : '选择角色并准备，等待房主开始对局。' }}</p>
      </div>
      <div class="room-code-panel">
        <div><span class="label">房间号</span><span class="code">{{ room.id }}</span></div>
        <button type="button" aria-label="复制房间号" @click="copy(false)">⧉</button>
        <button type="button" class="invite-button" @click="copy(true)">复制邀请</button>
      </div>
    </header>
    <p v-if="notice" class="online-copy-notice" role="status">{{ notice }}</p>
    <div class="lobby-body"><section class="slot-grid" aria-label="联机玩家槽位">
      <article v-for="(member, index) in room.members" :key="member.id" class="slot-card">
        <span class="slot-index">{{ index + 1 }}P</span>
        <button v-if="isHost && member.id !== room.selfId" type="button" class="kick-btn" :disabled="busy || !connected" :aria-label="`移除${member.name}`" @click="emit('command', { type: 'remove', memberId: member.id })">×</button>
        <div class="slot-portrait"><span class="char-block" :style="{ background: characterById(member.characterId).color }">{{ characterById(member.characterId).name.slice(0,1) }}</span></div>
        <div class="slot-info">
          <p class="char-name">{{ characterById(member.characterId).name }} <small>{{ characterById(member.characterId).title }}</small></p>
          <p class="char-skill">{{ characterById(member.characterId).skill }}</p>
          <div class="slot-player"><span class="piece" :style="{ background: member.pieceColor }">{{ member.isAI ? 'AI' : member.id === room.selfId ? '你' : '友' }}</span><strong>{{ member.name }}</strong></div>
          <div class="slot-tags"><span v-if="member.id === room.hostId" class="tag-pill host">房主</span><span class="tag-pill" :class="{ ready: member.ready }">{{ member.isAI ? '自动准备' : !member.connected ? '离线' : member.ready ? '已准备' : '未准备' }}</span></div>
          <label v-if="member.id === room.selfId || (isHost && member.isAI)" class="online-character-label">选择角色
            <select :value="member.characterId" :aria-label="`${member.name}的角色`" :disabled="busy || !connected" @change="emit('command', { type: 'character', memberId: member.id, characterId: ($event.target as HTMLSelectElement).value })"><option v-for="character in characters" :key="character.id" :value="character.id">{{ character.name }}</option></select>
          </label>
          <div v-if="member.id === room.selfId" class="online-colors" aria-label="棋子颜色"><button v-for="color in colors" :key="color" type="button" :style="{ background: color }" :class="{ chosen: member.pieceColor === color }" :disabled="busy || !connected || room.members.some(other => other.id !== member.id && other.pieceColor === color)" :aria-label="`选择颜色${color}`" @click="emit('command', { type: 'character', characterId: member.characterId, pieceColor: color })"></button></div>
        </div>
      </article>
      <button v-for="slot in Math.max(0, 8 - room.members.length)" :key="`empty-${slot}`" class="slot-card empty" type="button" :disabled="!isHost || busy || !connected" @click="emit('command', { type: 'add_ai' })">{{ isHost ? '+ 添加机器人' : '等待朋友加入' }}</button>
    </section></div>
    <footer class="lobby-footer">
      <p class="status-line">{{ room.members.length }} / 8 名选手 · {{ isHost ? canStart ? '所有选手已准备' : '等待至少两人连接并准备' : self.ready ? '你已准备' : '请完成准备' }}</p>
      <div class="lobby-footer-actions">
        <button type="button" class="pill-button" @click="emit('leave')">离开房间</button>
        <button v-if="!isHost" type="button" class="pill-button mint" :disabled="busy || !connected" @click="emit('command', { type: 'ready', ready: !self.ready })">{{ self.ready ? '取消准备' : '准备' }}</button>
        <button v-if="isHost" type="button" class="pill-button primary" :disabled="!canStart" @click="emit('command', { type: 'start' })">开始联机对局</button>
      </div>
    </footer>
  </main>
</template>

<style scoped>
.online-presence { margin: .5rem 0; color: var(--good); font-size: .76rem; }
.room-code-panel { flex-wrap: wrap; }
.room-code-panel .invite-button { width: auto; font-size: .7rem; padding: .5rem; border-radius: 8px; }
.online-character-label { display: flex; align-items: center; gap: .5rem; font-size: .75rem; margin-top: .65rem; color: var(--ink-dim); }
.online-character-label select { min-width: 0; max-width: 150px; border: 1px solid var(--line-strong); background: var(--panel); border-radius: 8px; padding: .35rem; color: var(--ink); }
.online-colors { display: flex; flex-wrap: wrap; gap: .4rem; margin-top: .6rem; }
.online-colors button { width: 20px; height: 20px; border: 2px solid transparent; border-radius: 50%; }
.online-colors button.chosen { outline: 2px solid var(--ink); outline-offset: 2px; }
.online-copy-notice { margin: .7rem 1rem 0; color: var(--good); font-size: .8rem; overflow-wrap: anywhere; }
@media (max-width: 600px) { .lobby-header { flex-direction: column; } .lobby-footer { flex-wrap: wrap; gap: .7rem; } .lobby-footer-actions { flex-wrap: wrap; } }
</style>
