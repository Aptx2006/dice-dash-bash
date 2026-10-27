import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { OPPONENT_CASE_IDS, opponentPosition, type OpponentCaseId } from '../eval/opponent-positions.ts'
import { chooseFallbackAction } from '../src/agent/opponentController.ts'
import { createTacticalSnapshot, executeTacticalAction, inspectTacticalAction, tacticalSnapshotKey } from '../src/game/tactical.ts'
import { isolatedSimulation } from '../src/game/engine.ts'
import type { GameState } from '../src/game/types.ts'
import type { OpponentDecision } from '../src/agent/opponentTypes.ts'
import { runOpponentAgent } from '../server/agent/opponent.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const chosen = args.find(arg => arg.startsWith('--case='))?.slice(7)
const cloud = args.includes('--cloud'), save = args.includes('--save')
if (args.some(arg => arg !== '--cloud' && arg !== '--save' && !arg.startsWith('--case=')) ||
  args.filter(arg => arg.startsWith('--case=')).length > 1 ||
  (chosen !== undefined && !OPPONENT_CASE_IDS.includes(chosen as OpponentCaseId))) {
  console.error('用法：npm run eval:opponents -- [--cloud] [--case=safe|pit|poison|sprint|finish] [--save]')
  process.exitCode = 1
} else {
  const ids = chosen ? [chosen as OpponentCaseId] : [...OPPONENT_CASE_IDS]
  const cases = []
  for (const id of ids) {
    const sample = opponentPosition(id), state = sample.state
    const snapshot = createTacticalSnapshot(state, sample.playerId)
    const baselineStart = performance.now()
    const baseline = chooseFallbackAction(state, sample.playerId)
    const baselineMs = performance.now() - baselineStart
    const baselineResult = inspectAndExecute(state, sample.playerId, baseline?.action.actionId)
    let decision: OpponentDecision | null = null
    if (cloud) decision = await runOpponentAgent({ snapshot, playerId: sample.playerId })
    const proposed = decision?.status === 'ready' && decision.actionId
      ? inspectTacticalAction(state, sample.playerId, decision.actionId) : null
    // 与页面控制器一致：云端未通过检查时，使用同一固定排序的规则策略接管。
    const cloudAccepted = decision?.status === 'ready' && proposed !== null
    const cancelled = decision?.status === 'cancelled'
    const actionId = cancelled ? undefined : cloudAccepted ? decision!.actionId : baseline?.action.actionId
    const selected = inspectAndExecute(state, sample.playerId, actionId)
    const policy = !cloud ? 'rules' : cancelled ? 'cancelled' : cloudAccepted ? 'cloud' : 'rules_after_cloud_failure'
    const matchesExpected = selected.legal && (!sample.expected.avoidDeathTerrain || !selected.dangerous)
      && sample.expected.winThisStep === selected.winsThisStep
    cases.push({ id, title: sample.title, description: sample.description, synthetic: true, snapshot, expected: sample.expected,
      rulesBaseline: { decisionMs: round(baselineMs), actionId: baseline?.action.actionId ?? null, ...baselineResult },
      cloud: { requested: cloud, modelReady: decision?.status === 'ready', accepted: cloudAccepted,
        fallbackReason: decision?.status === 'fallback' ? decision.fallbackReason ?? 'MODEL_UNAVAILABLE'
          : decision?.status === 'ready' && !cloudAccepted ? 'INVALID_ACTION' : null,
        decision },
      final: { policy, actionId: actionId ?? null, ...selected, matchesExpected } })
  }
  const run = { createdAt: new Date().toISOString(), synthetic: true, mode: cloud ? 'cloud-with-rules-fallback' : 'rules-only',
    scope: '固定合成局面的单步合法性、危险地形、终点与时延检查，不证明全局最优、胜率或整局表现。',
    summary: { cases: cases.length, legal: cases.filter(item => item.final.legal).length,
      expectedPassed: cases.filter(item => item.final.matchesExpected).length,
      cloudRequested: cloud ? cases.length : 0, cloudReady: cases.filter(item => item.cloud.modelReady).length,
      cloudAccepted: cases.filter(item => item.cloud.accepted).length,
      rulesFallbacks: cases.filter(item => item.final.policy === 'rules_after_cloud_failure').length }, cases }
  console.log(JSON.stringify(run, null, 2))
  if (save) {
    const directory = resolve(root, 'docs/opponent-runs'), path = resolve(directory, 'evaluation.json')
    let runs: unknown[] = []
    try {
      const prior: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (!prior || typeof prior !== 'object' || !('formatVersion' in prior) || prior.formatVersion !== 1 ||
        !('runs' in prior) || !Array.isArray(prior.runs)) throw new Error('已有评估记录格式无法识别；为保留证据，未覆盖文件。')
      runs = prior.runs
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
    runs.push(run)
    await mkdir(directory, { recursive: true })
    await writeFile(path, `${JSON.stringify({ formatVersion: 1, runs }, null, 2)}\n`, 'utf8')
  }
  if (run.summary.expectedPassed !== cases.length) process.exitCode = 1
}

function round(value: number) { return Math.round(value * 1000) / 1000 }
function inspectAndExecute(state: GameState, playerId: string, actionId?: string) {
  const preview = actionId ? inspectTacticalAction(state, playerId, actionId) : null
  if (!preview) return { legal: false, dangerous: null, winsThisStep: false, preview: null, actual: null }
  const copy = JSON.parse(JSON.stringify(state)) as GameState
  const start = performance.now()
  const executed = isolatedSimulation(() => executeTacticalAction(copy, playerId, actionId!, tacticalSnapshotKey(copy)))
  const actual = copy.players.find(player => player.id === playerId)!
  return { legal: executed.ok, dangerous: preview.warnings.some(warning => warning.includes('危险地形')),
    winsThisStep: executed.ok && copy.finished && actual.finishedTurn === copy.turnNumber,
    preview, actual: { position: actual.cell, phase: copy.phase, finished: copy.finished,
      remainingHand: actual.hand, executionMs: round(performance.now() - start) } }
}
