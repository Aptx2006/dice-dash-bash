import { mkdir, writeFile } from 'node:fs/promises'
import { createGame } from '../src/game/engine.ts'
import { createTacticalSnapshot, inspectTacticalAction } from '../src/game/tactical.ts'
import { runTacticalAgent } from '../server/agent/harness.ts'

const args = process.argv.slice(2)
const scenario = args.find(arg => arg.startsWith('--scenario='))?.slice(11) ?? 'movement'
if (!['movement', 'sprint', 'finish'].includes(scenario) || args.some(arg => arg !== '--save' && !arg.startsWith('--scenario='))) {
  console.error('用法：npm run agent:demo -- --scenario=movement|sprint|finish [--save]')
  process.exitCode = 1
} else {
  // 固定合成局面，不读取或覆盖玩家的浏览器存档。
  const state = createGame({
    mapId: 'tutorial', players: [
      { name: '样例玩家', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
      { name: '样例对手', isAI: true, characterId: 'robot', pieceColor: '#5f8d95', isHost: false },
    ], mechanisms: { airdrop: false, turnTimer: false },
  })
  state.phase = 'action'
  state.players[0].hand = [{ uid: 90001, toolId: 'move', points: 3 }]
  state.players[1].cell = { x: 3, y: 4 }
  state.dice = { move: 3, toolName: null }
  if (scenario === 'sprint') state.players[0].hand.push({ uid: 90002, toolId: 'sprint' })
  if (scenario === 'finish') state.players[0].hand.push({ uid: 90003, toolId: 'teleport' })
  const snapshot = createTacticalSnapshot(state, 'human')
  const goal = scenario === 'finish' ? '选择本步能直接获胜的行动；若没有则接近终点。'
    : scenario === 'sprint' ? '比较冲刺和直接移动的效果，给出一步合理行动。' : '尽量接近终点，避开危险地形。'
  const result = await runTacticalAgent({ snapshot, playerId: 'human', goal })
  const inspection = result.proposal ? inspectTacticalAction(state, 'human', result.proposal.actionId) : null
  const record = { scenario, synthetic: true, goal, snapshot, result, inspection }
  console.log(JSON.stringify(record, null, 2))
  if (args.includes('--save')) {
    await mkdir('docs/agent-runs', { recursive: true })
    await writeFile(`docs/agent-runs/${scenario}.json`, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  }
  if (result.status !== 'awaiting_confirmation' || !inspection || (scenario === 'finish' && !inspection.finished)) process.exitCode = 1
}
