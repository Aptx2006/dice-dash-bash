<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { RemoteGameControls } from '../network/types.ts'
import { memberPresence } from '../network/presence.ts'
const props = defineProps<{ controls: RemoteGameControls; myId: string; activeId: string }>()
const dialog = ref<HTMLDialogElement | null>(null)
const open = ref(false)
const offline = computed(() => props.controls.members.filter(member => !member.isAI && !member.connected).length)
const label = computed(() => !props.controls.connected ? '连接中断 · 自动重连' : props.controls.pauseReason ? '对局暂停' : offline.value ? `${offline.value}人离线` : '实时同步')
async function show() { open.value = true; await nextTick(); dialog.value?.showModal() }
function close() { dialog.value?.close(); open.value = false }
onBeforeUnmount(() => dialog.value?.close())
</script>

<template>
  <button type="button" class="save-status room-status" :class="{ 'save-failed': !controls.connected || controls.pauseReason || offline }"
    aria-label="查看房间与连接状态" @click="show">房间 {{ controls.roomId }} · {{ label }} <span aria-hidden="true">⌃</span></button>
  <dialog v-if="open" ref="dialog" class="room-roster" aria-label="房间与连接状态" @cancel.prevent="close">
    <header><div><small>房间 {{ controls.roomId }}</small><h2>在场的伙伴</h2></div><button type="button" aria-label="关闭房间状态" autofocus @click="close">×</button></header>
    <p class="connection-label" role="status">{{ label }}</p>
    <p v-if="controls.pauseReason" class="room-explanation">{{ controls.pauseReason }}</p>
    <p v-else-if="!controls.connected" class="room-explanation">正在连接房间服务；恢复后按最新局面继续，连接期间不能出牌。</p>
    <ul><li v-for="member in controls.members" :key="member.id">
      <span class="piece" :style="{ background: member.pieceColor }" aria-hidden="true">{{ member.name.slice(0, 1) }}</span>
      <span class="member-name"><strong>{{ member.name }}</strong><small>{{ member.id === controls.hostId ? '房主' : member.gamePlayerId === myId ? '你的角色' : '房间成员' }}<template v-if="member.gamePlayerId === activeId"> · 正在行动</template></small></span>
      <span class="member-state" :class="{ away: member.takeover || !member.connected && !member.isAI }">{{ memberPresence(member, member.gamePlayerId === myId, controls.connected) }}</span>
    </li></ul>
    <p class="room-explanation">正常对局中，暂时离线超过20秒由AI代打，使用原身份重连会恢复真人控制；主动离开会注销身份。</p>
    <button type="button" class="pill-button mint roster-close" @click="close">继续对局</button>
  </dialog>
</template>

<style scoped>
.room-status { pointer-events: auto; cursor: pointer; border: 1px solid var(--line); font-family: inherit; }
.room-roster { width: min(440px, calc(100vw - 1.5rem)); max-height: calc(100dvh - 1.5rem); overflow-y: auto; border: 1px solid var(--line-strong); border-radius: 20px; padding: 1.2rem; background: var(--panel); color: var(--ink); box-shadow: var(--shadow-card); }
.room-roster::backdrop { background: #2c355066; backdrop-filter: blur(3px); }
header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; } header h2 { margin: .2rem 0 0; font-size: 1.15rem; } header small { color: var(--ink-faint); }
header button { border: 0; background: var(--panel-deep); border-radius: 9px; width: 32px; height: 32px; font-size: 1.4rem; color: var(--ink); }
.connection-label { color: var(--good); margin: .7rem 0; font-size: .8rem; }
ul { list-style: none; padding: 0; margin: .8rem 0; } li { display: flex; align-items: center; gap: .65rem; padding: .65rem 0; border-bottom: 1px solid var(--line); }
.piece { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: 10px; color: white; font-weight: 700; }
.member-name { min-width: 0; flex: 1; overflow-wrap: anywhere; }.member-name strong { font-size: .84rem; } .member-name small { display: block; margin-top: .2rem; font-size: .67rem; color: var(--ink-faint); }
.member-state { font-size: .7rem; color: var(--good); flex: none; } .member-state.away { color: #9c6c28; }
.room-explanation { font-size: .75rem; line-height: 1.7; color: var(--ink-dim); }.roster-close { margin-top: .8rem; width: 100%; }
</style>
