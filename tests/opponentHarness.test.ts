import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runOpponentAgent, type OpponentAgentInput, type OpponentAgentOptions } from '../server/agent/opponent.ts'
import { executeTacticalTool } from '../server/agent/tools.ts'
import { createGame } from '../src/game/engine.ts'
import { createTacticalSnapshot } from '../src/game/tactical.ts'
import type { GameState } from '../src/game/types.ts'
import type { ChatMessage } from '../server/providers/chat.ts'
import { ModelError } from '../server/providers/chat.ts'
import type { KnowledgeChunk } from '../server/rag/knowledge.ts'

const chunks: KnowledgeChunk[] = [{ id: 'move.basic', title: '移动牌', text: '消耗移动牌，沿合法方向滑行。',
  source: 'knowledge/test-only.md', sourceLines: [1, 3], rulesVersion: 'local-v1', keywords: ['移动牌', '方向移动'] }]
function input(): OpponentAgentInput {
  const state = createGame({ mapId: 'tutorial', players: [
    { name: '不公开的真人姓名', isAI: false, characterId: 'villager', pieceColor: '#ffccaa', isHost: true },
    { name: '不公开的机器人姓名', isAI: true, characterId: 'robot', pieceColor: '#ccddee', isHost: false },
  ], mechanisms: { airdrop: false, turnTimer: false } })
  state.activeIndex = 1
  state.phase = 'action'
  state.players[0].cell = { x: 3, y: 4 }
  state.players[0].hand = [{ uid: 90002, toolId: 'teleport' }]
  state.players[1].hand = [{ uid: 90001, toolId: 'move', points: 3 }]
  state.dice = { move: 3, toolName: null }
  return { snapshot: createTacticalSnapshot(state, 'ai-1'), playerId: 'ai-1' }
}
const tool = (name = 'inspect_action', args: Record<string, unknown> = { actionId: 'move:90001:right' }) => ({ type: 'tool', name, args })
const final = (sourceIds = ['move.basic'], actionId = 'move:90001:right') => ({ type: 'final', actionId,
  reason: '向右滑行后更接近终点，且该路线没有危险地形。', sourceIds })
function queue(decisions: unknown[], history: ChatMessage[][] = []): NonNullable<OpponentAgentOptions['model']> {
  let index = 0
  return async messages => {
    history.push(messages.map(message => ({ ...message })))
    const decision = decisions[Math.min(index++, decisions.length - 1)]
    return { content: typeof decision === 'string' ? decision : JSON.stringify(decision), model: 'test-opponent',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
  }
}

test('AI真实工具循环：准备候选和RAG，模型检查后final才ready，不修改局面', async () => {
  const task = input(), before = JSON.stringify(task.snapshot), history: ChatMessage[][] = []
  const result = await runOpponentAgent(task, { chunks, model: queue([tool(), final()], history) })
  assert.equal(result.status, 'ready')
  assert.equal(result.actionId, 'move:90001:right')
  assert.equal(result.steps, 2)
  assert.deepEqual(result.sourceIds, ['move.basic'])
  assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 })
  assert.equal(JSON.stringify(task.snapshot), before)
  assert.ok(history[0].some(message => message.content.includes('prepared_actions') && message.content.includes('move.basic')))
  assert.ok(history[1].some(message => message.role === 'assistant' && message.content.includes('inspect_action')))
  assert.ok(history[1].some(message => message.role === 'user' && message.content.includes('tool_result') && message.content.includes('"ok":true')))
  assert.ok(result.events.some(event => event.step === 0 && event.toolName === 'lookup_rules'))
  assert.ok(result.events.some(event => event.step === 1 && event.toolName === 'inspect_action'))
  const serialized = JSON.stringify({ history, result })
  assert.equal(serialized.includes('不公开的真人姓名'), false)
  assert.equal(serialized.includes('不公开的机器人姓名'), false)
  assert.equal(serialized.includes('90002'), false, '不发送真人隐藏手牌')
})

test('拒绝非当前AI、人类席位和损坏局面，不调用模型', async () => {
  let calls = 0
  const model: NonNullable<OpponentAgentOptions['model']> = async () => { calls++; throw new Error('must-not-call') }
  const task = input(), state = task.snapshot as GameState
  for (const request of [{ ...task, playerId: 'human' }, { ...task, playerId: 'ai-2' }, { ...task, snapshot: {} },
    { ...task, snapshot: { ...state, players: state.players.map(player => ({ ...player, isAI: false })) } }]) {
    const result = await runOpponentAgent(request, { chunks, model })
    assert.equal(result.status, 'fallback')
    assert.equal(result.fallbackReason, 'INVALID_INPUT')
    assert.equal(result.steps, 0)
  }
  assert.equal(calls, 0)
})

test('没有受支持的行动时不调用模型，交还规则策略', async () => {
  const task = input()
  ;(task.snapshot as GameState).players[1].hand = [{ uid: 90001, toolId: 'end' }]
  const result = await runOpponentAgent(task, { chunks, model: async () => { throw new Error('must-not-call') } })
  assert.equal(result.status, 'fallback')
  assert.equal(result.fallbackReason, 'NO_ACTIONS')
  assert.equal(result.steps, 0)
})

test('预先排序的候选不能取代模型显式检查；直接自称完成会降级', async () => {
  const result = await runOpponentAgent(input(), { chunks, model: queue([final()]) })
  assert.equal(result.status, 'fallback')
  assert.equal(result.actionId, undefined)
  assert.equal(result.fallbackReason, 'UNVERIFIED_ACTION')
})

test('参数错误会进入上下文，模型可在4步内修正一次', async () => {
  const history: ChatMessage[][] = []
  const result = await runOpponentAgent(input(), { chunks, model: queue([
    tool('inspect_action', { actionId: 'move:90001:right', command: 'arbitrary' }), tool(), final(),
  ], history) })
  assert.equal(result.status, 'ready')
  assert.equal(result.steps, 3)
  assert.ok(result.events.some(event => event.errorCode === 'INVALID_ARGUMENTS'))
  assert.ok(history[1].some(message => message.content.includes('"ok":false') && message.content.includes('INVALID_ARGUMENTS')))
})

test('伪造行动、未知工具与非法JSON不能绕过白名单', async () => {
  for (const decision of [tool('inspect_action', { actionId: 'move:90001:diagonal' }), tool('run_command', { command: 'arbitrary' }), '{broken']) {
    const result = await runOpponentAgent(input(), { chunks, model: queue([decision]) })
    assert.equal(result.status, 'fallback')
    assert.equal(result.actionId, undefined)
    assert.ok(['UNLISTED_ACTION', 'UNKNOWN_TOOL', 'INVALID_OUTPUT'].includes(result.fallbackReason!))
    assert.equal(result.steps, 2)
  }
})

test('伪造引用或缺少当前动作规则均降级，不能仅凭候选合法放行', async () => {
  for (const sources of [['fake.rule'], [], ['move.basic', 'fake.rule']]) {
    const result = await runOpponentAgent(input(), { chunks, model: queue([tool(), final(sources)]) })
    assert.equal(result.status, 'fallback')
    assert.equal(result.actionId, undefined)
    assert.ok(['UNVERIFIED_SOURCE', 'INVALID_FINAL'].includes(result.fallbackReason!))
  }
})

test('工具异常返回安全错误，有限修正后降级且不泄露异常内容', async () => {
  const result = await runOpponentAgent(input(), { chunks, model: queue([tool(), final()]),
    executeTool: async (request, context) => {
      if (request.name === 'inspect_action') throw new Error('private-internal-path')
      return executeTacticalTool(request, context)
    } })
  assert.equal(result.status, 'fallback')
  assert.equal(result.actionId, undefined)
  assert.ok(result.events.some(event => event.errorCode === 'TOOL_FAILED'))
  assert.equal(JSON.stringify(result).includes('private-internal-path'), false)
})

test('模型网络失败和未配置密钥不自动重试，也不虚构token用量', async () => {
  let calls = 0
  const result = await runOpponentAgent(input(), { chunks, model: async () => {
    calls++; throw new ModelError('CONNECTION_FAILED', 'upstream-private-detail')
  } })
  assert.equal(result.status, 'fallback')
  assert.equal(result.fallbackReason, 'CONNECTION_FAILED')
  assert.equal(result.usage, null)
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(result).includes('upstream-private-detail'), false)
  const missing = await runOpponentAgent(input(), { chunks,
    config: { baseUrl: 'https://example.invalid/v1', apiKey: '', model: 'qwen3.8-flash', timeoutMs: 100 } })
  assert.equal(missing.status, 'fallback')
  assert.equal(missing.fallbackReason, 'NOT_CONFIGURED')
})

test('模型忽略取消信号也不能无限等待，超时结果无行动', async () => {
  const started = Date.now()
  let aborted = false
  const result = await runOpponentAgent(input(), { chunks, limits: { modelTimeoutMs: 25 },
    model: async (_messages, _config, signal) => {
      signal.addEventListener('abort', () => { aborted = true }, { once: true })
      return new Promise(() => {})
    } })
  assert.equal(result.status, 'fallback')
  assert.equal(result.fallbackReason, 'MODEL_TIMEOUT')
  assert.equal(result.actionId, undefined)
  assert.equal(aborted, true)
  assert.ok(Date.now() - started < 1000)
})

test('总时限涵盖准备上下文和后续模型，工具迟到结果不放行', async () => {
  const started = Date.now()
  const result = await runOpponentAgent(input(), { chunks, limits: { totalTimeoutMs: 25 },
    executeTool: async () => new Promise(() => {}), model: queue([tool(), final()]) })
  assert.equal(result.status, 'fallback')
  assert.equal(result.fallbackReason, 'TOTAL_TIMEOUT')
  assert.equal(result.steps, 0)
  assert.equal(result.actionId, undefined)
  assert.ok(Date.now() - started < 1000)
})

test('取消返回cancelled而非可执行fallback，取消前后均无动作', async () => {
  const controller = new AbortController()
  const resultPromise = runOpponentAgent(input(), { chunks, signal: controller.signal,
    model: async () => { controller.abort(); return new Promise(() => {}) } })
  const result = await resultPromise
  assert.equal(result.status, 'cancelled')
  assert.equal(result.fallbackReason, 'CANCELLED')
  assert.equal(result.actionId, undefined)
  const preAborted = await runOpponentAgent(input(), { chunks, signal: AbortSignal.abort(), model: queue([tool(), final()]) })
  assert.equal(preAborted.status, 'cancelled')
  assert.equal(preAborted.steps, 0)
})

test('4步上限受程序控制，运行参数只能收窄预算', async () => {
  const result = await runOpponentAgent(input(), { chunks, model: queue([tool('observe_board', {})]), limits: { maxSteps: 100 } })
  assert.equal(result.status, 'fallback')
  assert.equal(result.fallbackReason, 'STEP_LIMIT')
  assert.equal(result.steps, 4)
})
