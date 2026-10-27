<script setup lang="ts">
import { computed } from 'vue'
import type { Dir, GameState } from '../game/types.ts'
import { DIR_LABEL, DIRS } from '../game/types.ts'
import { inspectTacticalAction, listTacticalActions } from '../game/tactical.ts'

const props = defineProps<{ state: GameState; playerId: string; uid: number }>()
const emit = defineEmits<{ choose: [dir: Dir]; cancel: [] }>()
const arrows: Record<Dir, string> = { up: '↑', right: '→', down: '↓', left: '←' }
const canBrake = computed(() => props.state.players.find(player => player.id === props.playerId)?.characterId === 'russell')
const choices = computed(() => {
  const actions = listTacticalActions(props.state, props.playerId, props.uid).filter(action => action.kind === 'move' && action.uid === props.uid && !action.stopAfter)
  return DIRS.map(dir => {
    const action = actions.find(action => action.dir === dir)
    const preview = action ? inspectTacticalAction(props.state, props.playerId, action.actionId, props.uid) : null
    return { dir, preview }
  })
})
</script>

<template>
  <section class="movement-choices" aria-label="移动预览">
    <header><strong>先看落点，再选方向</strong><button type="button" @click="emit('cancel')">取消</button></header>
    <div class="movement-grid">
      <button v-for="{ dir, preview } in choices" :key="dir" type="button" :disabled="!preview"
        :class="{ danger: preview?.warnings.some(text => text.includes('危险')), finish: preview?.finished }"
        :aria-label="`向${DIR_LABEL[dir]}移动${preview ? `，落点(${preview.to.x},${preview.to.y})${preview.finished ? '，抵达终点' : ''}${preview.warnings.join('；')}` : '，该方向被阻挡'}`"
        @click="emit('choose', dir)">
        <span class="movement-arrow" aria-hidden="true">{{ arrows[dir] }}</span>
        <span><strong>向{{ DIR_LABEL[dir] }}<template v-if="preview"> · ({{ preview.to.x }}, {{ preview.to.y }})</template></strong>
          <small v-if="!preview">该方向被阻挡</small>
          <small v-else-if="preview.finished">抵达终点</small>
          <small v-else-if="preview.warnings.some(text => text.includes('危险'))">危险：会回到出生点</small>
          <small v-else-if="preview.requiresReward">途中有奖励，随后选牌</small>
          <small v-else>距终点约 {{ preview.distanceAfter === 999 ? '不可达' : `${preview.distanceAfter} 格` }}</small>
        </span>
      </button>
    </div>
    <p>显示本步结算位置；点方向即消耗移动牌。坐标从0开始。<template v-if="canBrake">罗素也可点路径制动，地形效果仍会结算。</template></p>
  </section>
</template>

<style scoped>
.movement-choices { position: absolute; z-index: 5; bottom: .9rem; left: 50%; transform: translateX(-50%); width: min(470px, calc(100% - 1.8rem)); padding: .65rem .75rem; background: rgba(255,250,240,.97); border: 1px solid var(--line-strong); border-radius: 16px; box-shadow: 0 10px 30px #2c355022; }
header { display: flex; align-items: center; justify-content: space-between; margin-bottom: .45rem; font-size: .76rem; }
header button { border: none; background: transparent; color: var(--ink-dim); font-size: .72rem; padding: .25rem .5rem; }
.movement-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem; }
.movement-grid > button { display: flex; align-items: center; text-align: left; gap: .6rem; border: 1px solid #c4cdb7; border-radius: 10px; background: #f1f5e8; color: var(--ink); padding: .5rem; }
.movement-grid > button:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
.movement-grid > button:disabled { background: #eee9de; border-color: #d9d1c4; }
.movement-grid > button.danger { background: #fff0e3; border-color: #daa46e; }
.movement-grid > button.finish { background: #e5f2df; border-color: #62a56a; }
.movement-arrow { font-size: 1.35rem; line-height: 1; min-width: 1.2rem; }
.movement-grid strong, .movement-grid small { display: block; font-size: .72rem; line-height: 1.5; }
.movement-grid small { color: var(--ink-dim); font-size: .65rem; }
p { margin: .45rem 0 0; font-size: .62rem; color: var(--ink-dim); }
@media (max-height: 480px) { .movement-choices { bottom: .4rem; padding: .4rem; } header { margin: 0 0 .2rem; } .movement-grid > button { padding: .25rem .4rem; } p { display: none; } }
</style>
