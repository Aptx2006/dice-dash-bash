<script setup lang="ts">
import { computed, ref } from 'vue'
import type { LogEntry } from '../game/types.ts'
const props = defineProps<{ logs: LogEntry[]; finished?: boolean }>()
const query = ref(''), oldestFirst = ref(false)
const frozen = ref<LogEntry[] | null>(null)
const entries = computed(() => frozen.value ?? props.logs)
const visible = computed(() => {
  const rows = entries.value.filter(entry => entry.text.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase()))
  return oldestFirst.value ? rows.reverse() : rows
})
const hasNew = computed(() => frozen.value !== null && props.logs[0]?.id !== frozen.value[0]?.id)
function toggleUpdate() { frozen.value = frozen.value ? null : props.logs.map(entry => ({ ...entry })) }
</script>

<template>
  <section class="match-history" aria-label="最近行动记录">
    <p class="history-scope">显示最近40条公开记录，较早记录会随对局推进移出列表。<template v-if="finished">本局已结束，可按时间顺序查看记录。</template><template v-else>查阅或暂停更新时，对局和计时继续。</template></p>
    <div class="history-controls">
      <input v-model="query" type="search" maxlength="80" aria-label="搜索行动记录" placeholder="搜索玩家、道具或事件" />
      <select v-model="oldestFirst" aria-label="记录显示顺序"><option :value="false">最新在前</option><option :value="true">时间顺序</option></select>
      <button v-if="!finished || frozen" type="button" :aria-pressed="frozen !== null" @click="toggleUpdate">{{ frozen ? '继续更新' : '暂停更新' }}</button>
    </div>
    <p class="history-count" role="status">{{ visible.length }} / {{ entries.length }} 条<template v-if="frozen"> · 已暂停更新<template v-if="hasNew">，有新记录</template></template></p>
    <ol v-if="visible.length" class="history-entries"><li v-for="entry in visible" :key="entry.id">{{ entry.text }}</li></ol>
    <p v-else class="history-empty">{{ entries.length ? '没有匹配的记录，换个关键词试试。' : '对局开始后，投骰、出牌和回合进展会记录在这里。' }}</p>
  </section>
</template>

<style scoped>
.history-scope, .history-empty { color: var(--ink-dim); font-size: .73rem; line-height: 1.7; margin: .5rem 0 .8rem; }
.history-controls { display: flex; flex-wrap: wrap; gap: .4rem; }
.history-controls input { flex: 1 1 160px; min-width: 0; width: 100%; }
.history-controls input, .history-controls select, .history-controls button { font: inherit; font-size: .73rem; color: var(--ink); border: 1px solid var(--line); background: var(--panel); border-radius: 9px; padding: .5rem .6rem; }
.history-controls button[aria-pressed=true] { background: var(--mint); color: #215941; }
.history-count { font-size: .68rem; color: var(--ink-faint); margin: .7rem 0; }
.history-entries { margin: 0; padding: 0; list-style: none; }
.history-entries li { padding: .6rem .3rem .6rem .85rem; font-size: .77rem; line-height: 1.75; border-left: 2px solid var(--line-strong); border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.history-entries li:first-child { border-left-color: var(--good); }
</style>
