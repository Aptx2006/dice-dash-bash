import { performance } from 'node:perf_hooks'
import assert from 'node:assert/strict'
import { createGame } from '../src/game/engine.ts'
import { createTacticalAnalysis, inspectTacticalAction, listTacticalActions } from '../src/game/tactical.ts'

// 同机、同局面比较三次候选查询；不请求模型、不写房间库，不代表跨设备网络延迟。
function measure(run: () => unknown) {
  const samples: number[] = []
  for (let index = 0; index < 14; index++) {
    const started = performance.now()
    run()
    if (index >= 4) samples.push(performance.now() - started)
  }
  samples.sort((a, b) => a - b)
  return { medianMs: +samples[5]!.toFixed(2), p95Ms: +samples[9]!.toFixed(2) }
}
for (const mapId of ['race1', 'race2', 'race3']) {
  const state = createGame({ mapId, players: Array.from({ length: 8 }, (_, index) => ({
    name: `基准${index + 1}`, isAI: index > 0, characterId: index ? 'robot' : 'russell',
    pieceColor: '#f2a75c', isHost: index === 0,
  })), mechanisms: { airdrop: false, turnTimer: false } })
  state.phase = 'action'
  state.players[0]!.hand = [{ uid: 90001, toolId: 'move', points: 6 }, { uid: 90002, toolId: 'teleport' },
    { uid: 90003, toolId: 'blink' }, { uid: 90004, toolId: 'sprint' }]
  const original = JSON.stringify(state)
  const legacy = () => listTacticalActions(state, 'human').map(action => ({ action, preview: inspectTacticalAction(state, 'human', action.actionId)! }))
  assert.deepEqual(createTacticalAnalysis(state, 'human').evaluations(), legacy())
  const before = measure(() => { for (let page = 0; page < 3; page++) legacy() })
  const after = measure(() => {
    const analysis = createTacticalAnalysis(state, 'human')
    for (let page = 0; page < 3; page++) analysis.evaluations()
  })
  assert.equal(JSON.stringify(state), original)
  console.log(JSON.stringify({ mapId, players: 8, candidates: listTacticalActions(state, 'human').length,
    queries: 3, before, after, medianSpeedup: +(before.medianMs / after.medianMs).toFixed(2), equivalent: true }))
}
