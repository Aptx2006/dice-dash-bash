<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import RulesCoach from './RulesCoach.vue'
import MatchHistory from './MatchHistory.vue'
import { TOOLS } from '../game/tools.ts'
import type { GameState, ToolId } from '../game/types.ts'

const props = defineProps<{ state: GameState; myId: string }>()
const dialog = ref<HTMLDialogElement | null>(null)
const coach = ref<{ setQuestion: (value: string) => void } | null>(null)
const open = ref(false)
const page = ref<'quick' | 'coach' | 'journal'>('quick')
const selected = ref<ToolId>('move')
const self = computed(() => props.state.players.find(player => player.id === props.myId))
// 只读取自己的手牌。快捷问题仅发送道具名称，不发送房间、姓名、手牌或局面。
const handKinds = computed(() => [...new Set(self.value?.hand.filter(card => !['roll', 'end'].includes(card.toolId)).map(card => card.toolId) ?? [])])
const selectedCard = computed(() => self.value?.hand.find(card => card.toolId === selected.value))
const tool = computed(() => TOOLS[selected.value])
const description = computed(() => selected.value === 'move' && !selectedCard.value
  ? '投骰后获得移动牌，能前进的步数以手牌显示的点数为准。' : tool.value.desc(selectedCard.value))
watch(handKinds, kinds => { if (!kinds.includes(selected.value)) selected.value = kinds[0] ?? 'move' })
const toolNotes: Partial<Record<ToolId, string>> = {
  move: '点击移动牌后选方向，按规则滑行；普通角色不能任意在中途停下，罗素可以选择制动点。路线和落点以棋盘预览为准。',
  sprint: '手里有移动牌才能使用冲刺；它增加移动牌的点数，不会立即移动棋子。',
  teleport: '点击瞬移牌，再选择高亮落点。墙、坑洞、已被占据的格子和风暴不可选；合法落到终点会立即完赛。',
  blink: '点击瞬步牌，再选择高亮落点；以棋盘上当前显示的合法目标为准。',
  tow: '先选择被拖拽的目标，再选择方向；目标与方向均需要合法。',
}
const question = computed(() => `${tool.value.name}怎么使用，有哪些限制？`)
const suggestions = computed(() => [...new Set([question.value, '一回合为什么要结束两次？', '抵达终点后怎么排名？'])])
async function show(initial: 'quick' | 'journal' = 'quick') {
  selected.value = handKinds.value[0] ?? 'move'
  page.value = initial; open.value = true
  await nextTick(); dialog.value?.showModal()
}
function close() { dialog.value?.close(); open.value = false }
async function askTool() {
  page.value = 'coach'
  await nextTick(); coach.value?.setQuestion(question.value)
}
onBeforeUnmount(() => dialog.value?.close())
defineExpose({ showJournal: () => show('journal') })
</script>

<template>
  <button type="button" class="camera-fit rules-open" @click="show()">规则速查</button>
  <dialog v-if="open" ref="dialog" class="match-rules" aria-label="对局规则手册" @cancel.prevent="close">
    <header><div><small>随时查一查</small><h2>{{ page === 'journal' ? '行动记录' : '规则手册' }}</h2></div><button type="button" aria-label="关闭规则手册" autofocus @click="close">×</button></header>
    <p class="rules-timing">{{ state.finished ? '本局已结束，可以查阅规则和保留的行动记录。' : '查阅时，对局和回合计时继续；关闭手册即可继续操作。' }}</p>
    <nav class="rules-pages" aria-label="规则查询方式">
      <button type="button" :aria-pressed="page === 'quick'" @click="page = 'quick'">基础与手牌</button>
      <button type="button" :aria-pressed="page === 'coach'" @click="page = 'coach'">询问规则教练</button>
      <button type="button" :aria-pressed="page === 'journal'" @click="page = 'journal'">行动记录</button>
    </nav>
    <section v-show="page === 'quick'" class="rules-quick" aria-label="基础与手牌速查">
      <ol class="rules-steps"><li><strong>投骰</strong><span>获得移动点数和本回合工具牌。</span></li><li><strong>使用手牌</strong><span>点击或向上拖出卡牌，再按高亮选择方向或目标；点取消可以重新选择。</span></li><li><strong>结束阶段</strong><span>行动后先结束行动阶段，再结束回合；只有“结束回合”后才轮到下一位。</span></li></ol>
      <p class="rules-win">第一位抵达终点的玩家获胜，其余玩家按到终点的剩余距离排名。</p>
      <h3>{{ handKinds.length ? '我的手牌怎么用' : '先了解移动' }}</h3>
      <div class="rules-tool-list" aria-label="选择要了解的道具">
        <button v-for="kind in handKinds.length ? handKinds : (['move'] as const)" :key="kind" type="button" :aria-pressed="selected === kind" @click="selected = kind">{{ TOOLS[kind].icon }} {{ TOOLS[kind].name }}</button>
      </div>
      <article class="rules-tool-detail" aria-live="polite"><h4>{{ tool.icon }} {{ tool.name }}</h4><p>{{ description }}</p><p v-if="toolNotes[selected]">{{ toolNotes[selected] }}</p>
        <button type="button" class="pill-button" @click="askTool">向教练了解{{ tool.name }}</button>
      </article>
      <p class="rules-footnote">基础与手牌速查可离线使用。规则教练通过资料检索回答一般规则；具体落点请看棋盘预览。</p>
    </section>
    <div v-show="page === 'coach'" class="rules-in-match"><RulesCoach ref="coach" expanded :suggestions="suggestions" /></div>
    <MatchHistory v-if="page === 'journal'" :logs="state.logs" :finished="state.finished" />
  </dialog>
</template>

<style scoped>
.match-rules { width: min(540px, calc(100vw - 1.5rem)); max-height: calc(100dvh - 1.5rem); overflow-y: auto; overscroll-behavior: contain; border: 1px solid var(--line-strong); border-radius: 20px; padding: 1.1rem; background: var(--panel); color: var(--ink); box-shadow: var(--shadow-card); }
.match-rules::backdrop { background: #2c355066; backdrop-filter: blur(3px); }
header { display: flex; justify-content: space-between; align-items: center; gap: 1rem; } header h2 { margin: .2rem 0 0; font-size: 1.15rem; } header small { color: var(--ink-faint); }
header > button { border: 0; background: var(--panel-deep); border-radius: 9px; width: 32px; height: 32px; font-size: 1.4rem; color: var(--ink); flex: none; }
.rules-timing, .rules-footnote { font-size: .72rem; line-height: 1.65; color: var(--ink-dim); margin: .8rem 0; }
.rules-pages { display: flex; gap: .4rem; padding: .3rem; border-radius: 12px; background: var(--panel-deep); margin-bottom: 1rem; }
.rules-pages button { flex: 1; border: 1px solid transparent; border-radius: 9px; padding: .55rem .25rem; color: var(--ink-dim); background: transparent; font: inherit; font-size: .78rem; }
.rules-pages button[aria-pressed=true] { background: var(--panel); border-color: var(--line); color: var(--ink); box-shadow: 0 2px 6px #25344908; }
.rules-steps { list-style: none; display: grid; gap: .65rem; padding: 0; counter-reset: steps; }
.rules-steps li { display: grid; grid-template-columns: 25px 1fr; column-gap: .5rem; counter-increment: steps; }
.rules-steps li::before { content: counter(steps); grid-row: span 2; width: 25px; height: 25px; display: grid; place-items: center; background: var(--mint); color: #215941; border-radius: 9px; font-size: .75rem; font-weight: bold; }
.rules-steps strong { font-size: .8rem; } .rules-steps span { font-size: .75rem; color: var(--ink-dim); line-height: 1.7; }
.rules-win { border-left: 3px solid var(--good); padding-left: .7rem; font-size: .76rem; line-height: 1.7; margin: 1rem 0; }
h3 { font-size: .85rem; margin: 1rem 0 .6rem; }.rules-tool-list { display: flex; flex-wrap: wrap; gap: .4rem; }
.rules-tool-list button { border: 1px solid var(--line); border-radius: 9px; background: var(--panel); color: var(--ink-dim); padding: .4rem .65rem; font: inherit; font-size: .75rem; }
.rules-tool-list button[aria-pressed=true] { border-color: var(--good); color: #215941; background: var(--mint); }
.rules-tool-detail { background: var(--panel-deep); padding: .85rem; margin-top: .75rem; border-radius: 12px; }.rules-tool-detail h4 { margin: 0 0 .4rem; font-size: .85rem; }.rules-tool-detail p { font-size: .77rem; line-height: 1.8; margin: .35rem 0; }.rules-tool-detail button { margin-top: .6rem; font-size: .73rem; padding: .5rem .7rem; }
.rules-in-match :deep(.rules-coach) { margin: 0; box-shadow: none; }
@media(max-height: 450px) { .match-rules { padding: .8rem; } .rules-timing { margin: .5rem 0; } }
</style>
