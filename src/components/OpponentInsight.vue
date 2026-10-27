<script setup lang="ts">
import { computed } from 'vue'
import type { GameState } from '../game/types.ts'
const props = defineProps<{ state: GameState; thinking?: string; settlement?: boolean }>()
const stats = computed(() => props.state.aiTelemetry)
const latest = computed(() => stats.value?.recent[0])
function playerName(id: string) { return props.state.players.find(player => player.id === id)?.name ?? '机器人' }
const failureLabels: Record<string, string> = {
  TIMEOUT: '等待超时', TOTAL_TIMEOUT: '思考达到时限', MODEL_TIMEOUT: '模型响应超时',
  NOT_CONFIGURED: '模型未配置', RATE_LIMIT: '服务繁忙', Arrearage: '模型额度不可用',
  SERVICE_UNAVAILABLE: '暂时无法连接', INVALID_ACTION: '行动检查未通过', INVALID_RESPONSE: '响应检查未通过',
}
const ruleLabels: Record<string, string> = {
  'move.basic': '方向移动与移动牌', 'move.blocked': '墙壁与阻挡', 'tool.sprint': '冲刺增加移动点数',
  'tool.teleport': '瞬移落点', 'tool.blink': '瞬步范围', 'result.finish': '终点判定',
  'terrain.danger': '坑洞与毒气', 'terrain.conveyor': '传送带推进', 'terrain.lucky': '幸运奖励',
  'character.russell': '罗素制动',
}
</script>

<template>
  <aside v-if="state.aiMode === 'cloud'" class="opponent-insight" :class="{ settlement }" aria-label="智能对手动态">
    <template v-if="thinking">
      <strong class="thinking-title"><span class="thinking-dot"></span>{{ thinking }} 正在思考</strong>
      <p role="status">比较行动并查阅规则，达到时限会自动继续。</p>
    </template>
    <template v-else-if="latest && !settlement">
      <strong>{{ playerName(latest.playerId) }} · {{ latest.mode === 'cloud' ? '云端决策' : '本地策略接管' }}</strong>
      <p>{{ latest.reason }}</p>
    </template>
    <template v-else><strong>{{ settlement ? '智能对手复盘' : '云端智能对手' }}</strong><p v-if="!settlement">每回合分析一次，剩余行动由本地策略完成。</p></template>
    <div class="insight-metrics"><span>已分析 <b>{{ stats?.requests ?? 0 }}</b></span><span>云端执行 <b>{{ stats?.modelSuccess ?? 0 }}</b></span><span>本地接管 <b>{{ stats?.fallbacks ?? 0 }}</b></span></div>
    <details v-if="stats?.recent.length">
      <summary>查看{{ settlement ? '关键决策' : '最近决策' }}</summary>
      <ol><li v-for="record in stats.recent" :key="record.runId">
        <strong>第{{ record.turnNumber }}回合 · {{ playerName(record.playerId) }}</strong>
        <span class="insight-badge">{{ record.mode === 'cloud' ? '云端' : '本地接管' }} · {{ (record.elapsedMs / 1000).toFixed(1) }}秒</span>
        <p>{{ record.label }}</p><p>{{ record.reason }}</p>
        <small v-if="record.fallbackReason">{{ failureLabels[record.fallbackReason] ?? '云端决定未通过运行检查' }}</small>
        <small v-if="record.sourceIds.length" :title="record.sourceIds.join(' · ')">规则依据：{{ record.sourceIds.map(id => ruleLabels[id] ?? id).join('、') }}</small>
      </li></ol>
      <small>仅保留最近20次云端尝试；这些计数不代表全部机器人动作。</small>
    </details>
  </aside>
</template>

<style scoped>
.opponent-insight { position: absolute; top: 6.4rem; left: .9rem; z-index: 4; width: min(260px, calc(100% - 1.8rem)); max-height: calc(100% - 8rem); overflow-y: auto; padding: .75rem .85rem; background: rgba(255,250,240,.96); border: 1px solid var(--line-strong); border-radius: 14px; box-shadow: 0 5px 20px #2c355015; font-size: .72rem; overflow-wrap: anywhere; }
strong { font-size: .77rem; } p { line-height: 1.6; margin: .35rem 0 0; color: var(--ink-dim); }
.insight-metrics { display: flex; flex-wrap: wrap; gap: .55rem; margin: .55rem 0 .35rem; font-size: .65rem; color: var(--ink-dim); }
.insight-metrics b { color: var(--ink); } summary { cursor: pointer; font-size: .67rem; }
ol { list-style: none; padding: 0; margin: .5rem 0 0; } li { border-top: 1px dashed var(--line-strong); padding: .55rem 0; } li > strong { display: block; font-size: .7rem; }
small { display: block; margin-top: .3rem; color: var(--ink-dim); font-size: .62rem; line-height: 1.5; }
.insight-badge { display: inline-block; margin-top: .3rem; font-size: .62rem; padding: .13rem .35rem; border-radius: 5px; background: #e9eddf; }
.thinking-title { display: flex; align-items: center; gap: .4rem; }.thinking-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--good); animation: pulse 1s infinite alternate; }
.settlement { position: static; width: 100%; max-height: 240px; margin: 1rem 0 0; text-align: left; box-shadow: none; }
@keyframes pulse { from { opacity: .35; } to { opacity: 1; } }
@media (max-width: 600px) { .opponent-insight:not(.settlement) { top: 6.5rem; width: min(230px, calc(100% - 1.8rem)); padding: .55rem .65rem; } }
@media (max-height: 500px) {
  .opponent-insight:not(.settlement) { top: 3rem; max-height: calc(100% - 4rem); padding: .45rem .6rem; }
  .opponent-insight:not(.settlement) > p { display: none; }
}
@media (prefers-reduced-motion: reduce) { .thinking-dot { animation: none; } }
</style>
