import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTacticalAgent, type TacticalAgentInput, type TacticalAgentOptions } from '../server/agent/harness.ts'
import { executeTacticalTool, ToolError, validateToolRequest } from '../server/agent/tools.ts'
import { createGame } from '../src/game/engine.ts'
import { createTacticalSnapshot, listTacticalActions } from '../src/game/tactical.ts'
import { ModelError, type ChatMessage } from '../server/providers/chat.ts'
import type { KnowledgeChunk } from '../server/rag/knowledge.ts'

// 合成局面和注入模型，不读取密钥或调用外部服务。真实模型回归由单独烟测执行。
const chunks: KnowledgeChunk[] = [{
  id: 'move.basic', title: '移动牌', text: '移动消耗一张移动牌，沿指定方向前进。',
  source: 'knowledge/test-only.md', sourceLines: [1, 3], rulesVersion: 'local-v1', keywords: ['移动', '移动牌'],
}]
function input(): TacticalAgentInput {
  const state = createGame({ mapId: 'tutorial', players: [
    { name: '不应出现在模型里的真名', isAI: false, characterId: 'villager', pieceColor: '#ffccaa', isHost: true },
    { name: '隐藏对手姓名', isAI: true, characterId: 'robot', pieceColor: '#ccddee', isHost: false },
  ], mechanisms: { airdrop: false, turnTimer: false } })
  state.phase = 'action'
  state.players[0].hand = [{ uid: 90001, toolId: 'move', points: 3 }]
  state.players[1].hand = [{ uid: 90002, toolId: 'teleport' }]
  state.players[1].cell = { x: 6, y: 5 }
  return { snapshot: createTacticalSnapshot(state, 'human'), playerId: 'human', goal: '安全接近终点' }
}
function actionId(task: TacticalAgentInput) {
  return listTacticalActions(task.snapshot as ReturnType<typeof createGame>, task.playerId).find(action => action.dir === 'right')!.actionId
}
const tool = (name: string, args: Record<string, unknown> = {}) => ({ type: 'tool', name, args })
function goodSequence(id: string) {
  return [tool('list_actions'), tool('inspect_action', { actionId: id }), tool('lookup_rules', { query: '移动牌' }),
    { type: 'final', actionId: id, reason: '向右移动，沿可通行路线接近终点。', sourceIds: ['move.basic'] }]
}
function queue(decisions: unknown[], history: ChatMessage[][] = []): NonNullable<TacticalAgentOptions['model']> {
  let index = 0
  return async messages => {
    history.push(messages.map(message => ({ ...message })))
    const item = decisions[Math.min(index++, decisions.length - 1)]
    return { content: typeof item === 'string' ? item : JSON.stringify(item), model: 'synthetic-agent',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
  }
}

test('战术工具：先校验名称和参数，合法查询只读且重复结果一致', async () => {
  const task = input(), before = JSON.stringify(task.snapshot)
  const ctx = { snapshot: task.snapshot as ReturnType<typeof createGame>, playerId: 'human', chunks }
  const correct = validateToolRequest('list_actions', { offset: 0, limit: 2 })
  const first = await executeTacticalTool(correct, ctx)
  const second = await executeTacticalTool(correct, ctx)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(task.snapshot), before)
  assert.throws(() => validateToolRequest('eval', { command: 'arbitrary' }), (error: unknown) => error instanceof ToolError && error.code === 'UNKNOWN_TOOL')
  for (const [name, args] of [['observe_board', { path: '../private' }], ['list_actions', { limit: 100 }], ['list_actions', { offset: -1 }],
    ['inspect_action', {}], ['lookup_rules', { query: '' }], ['lookup_rules', { query: '移动', command: 'shell' }]] as const) {
    assert.throws(() => validateToolRequest(name, args), (error: unknown) => error instanceof ToolError && error.code === 'INVALID_ARGUMENTS')
  }
  await assert.rejects(executeTacticalTool({ name: 'inspect_action', args: { actionId: 'fake' } }, ctx),
    (error: unknown) => error instanceof ToolError && error.code === 'ILLEGAL_ACTION')
})

test('单Agent正常循环：真实工具结果回传上下文，程序验收后仅待确认', async () => {
  const task = input(), id = actionId(task), before = JSON.stringify(task.snapshot), history: ChatMessage[][] = []
  const result = await runTacticalAgent(task, { model: queue(goodSequence(id), history), chunks })
  assert.equal(result.status, 'awaiting_confirmation')
  assert.equal(result.proposal?.actionId, id)
  assert.equal(result.steps, 4)
  assert.ok(result.proposal!.expiresAt > Date.now())
  assert.deepEqual(result.usage, { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 })
  assert.deepEqual(result.proposal?.sourceIds, ['move.basic'])
  assert.equal(result.events.filter(event => event.kind === 'tool' && event.status === 'ok').length, 3)
  assert.equal(JSON.stringify(task.snapshot), before, '运行Agent不得改变真实局面')
  assert.ok(history[1].some(message => message.role === 'assistant' && message.content.includes('list_actions')))
  assert.ok(history[1].some(message => message.role === 'user' && message.content.includes('tool_result') && message.content.includes(id)))
  assert.ok(history[3].some(message => message.content.includes('move.basic')))
  assert.equal(JSON.stringify(history).includes('不应出现在模型里的真名'), false)
  assert.equal(JSON.stringify(history).includes('隐藏对手姓名'), false)
  assert.equal(JSON.stringify(history).includes('90002'), false, '对手私有牌不进入上下文')
  assert.equal(JSON.stringify(result).includes('system'), false, '公开轨迹不返回system提示词')
})

test('参数错误反馈模型后可在预算内修正，不执行不合法工具调用', async () => {
  const task = input(), history: ChatMessage[][] = []
  const result = await runTacticalAgent(task, { model: queue([tool('list_actions', { limit: -1 }), ...goodSequence(actionId(task))], history), chunks })
  assert.equal(result.status, 'awaiting_confirmation')
  assert.equal(result.steps, 5)
  assert.ok(result.events.some(event => event.errorCode === 'INVALID_ARGUMENTS'))
  assert.ok(history[1].some(message => message.content.includes('"ok":false') && message.content.includes('INVALID_ARGUMENTS')))
})

test('未知工具与不可解析输出不能绕过允许列表，纠错次数达到上限即停止', async () => {
  const task = input()
  for (const decision of [tool('run_shell', { command: 'arbitrary' }), '{broken']) {
    let executions = 0
    const result = await runTacticalAgent(task, { model: queue([decision]), chunks,
      executeTool: async () => { executions++; return {} } })
    assert.equal(result.status, 'failed')
    assert.equal(result.steps, 3)
    assert.equal(executions, 0)
    assert.equal(result.proposal, undefined)
  }
})

test('工具异常反馈后有限次终止，不泄露底层异常和局面个人信息', async () => {
  const history: ChatMessage[][] = []
  const result = await runTacticalAgent(input(), { model: queue([tool('observe_board')], history), chunks,
    executeTool: async () => { throw new Error('synthetic-private-token-and-path') } })
  assert.equal(result.status, 'failed')
  assert.equal(result.events.filter(event => event.errorCode === 'TOOL_FAILED').length, 3)
  assert.ok(history[1].some(message => message.content.includes('TOOL_FAILED')))
  assert.equal(JSON.stringify(result).includes('synthetic-private-token-and-path'), false)
  assert.equal(JSON.stringify(history).includes('synthetic-private-token-and-path'), false)
})

test('模型反复查询达到最大步数时终止，不无限循环', async () => {
  const result = await runTacticalAgent(input(), { model: queue([tool('observe_board')]), chunks, limits: { maxSteps: 2 } })
  assert.equal(result.status, 'step_limit')
  assert.equal(result.steps, 2)
  assert.match(result.reason, /2步/)
  assert.equal(result.proposal, undefined)
})

test('挂起且忽略AbortSignal的模型仍会停止等待，绝不把迟到结果作为成功', async () => {
  let receivedSignal: AbortSignal | undefined
  const started = Date.now()
  const result = await runTacticalAgent(input(), { chunks, limits: { modelTimeoutMs: 10 },
    model: async (_messages, _config, signal) => { receivedSignal = signal; return new Promise(() => {}) } })
  assert.equal(result.status, 'timeout')
  assert.ok(receivedSignal?.aborted)
  assert.ok(Date.now() - started < 500)
  assert.equal(result.proposal, undefined)
  assert.equal(result.usage, null, '未取得usage不得虚构0token')
})

test('工具超过最长等待可反馈并修正，只读迟到结果不进入验收依据', async () => {
  const task = input()
  let attempts = 0
  const result = await runTacticalAgent(task, { model: queue([tool('observe_board'), ...goodSequence(actionId(task))]), chunks,
    limits: { toolTimeoutMs: 10 }, executeTool: async (request, ctx) => {
      if (++attempts === 1) return new Promise(() => {})
      return executeTacticalTool(request, ctx)
    } })
  assert.equal(result.status, 'awaiting_confirmation')
  assert.ok(result.events.some(event => event.errorCode === 'TOOL_TIMEOUT'))
  assert.equal(result.steps, 5)
})

test('总时限独立于单次模型超时和步数限制', async () => {
  const model = queue([tool('observe_board')])
  const result = await runTacticalAgent(input(), { chunks, limits: { totalTimeoutMs: 30, modelTimeoutMs: 100 },
    model: async (...args) => { await new Promise(resolve => setTimeout(resolve, 20)); return model(...args) } })
  assert.equal(result.status, 'timeout')
  assert.ok(result.steps < 8)
  assert.equal(result.proposal, undefined)
})

test('用户取消会停止等待且向下传递AbortSignal，不重试', async context => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10)
  context.after(() => clearTimeout(timer))
  let signalReceived: AbortSignal | undefined, attempts = 0
  const result = await runTacticalAgent(input(), { signal: controller.signal, chunks,
    model: async (_messages, _config, signal) => { attempts++; signalReceived = signal; return new Promise(() => {}) } })
  assert.equal(result.status, 'cancelled')
  assert.equal(attempts, 1)
  assert.ok(signalReceived?.aborted)
  assert.equal(result.proposal, undefined)
})

test('模型自称完成、伪造行动、未查来源或未检查行动都不能通过最终验收', async () => {
  const task = input(), id = actionId(task)
  const decisions = [
    { type: 'final', actionId: id, reason: '已经完成', sourceIds: ['move.basic'] },
    { type: 'final', actionId: 'fake-action', reason: '可以直接获胜', sourceIds: ['invented-rule'] },
  ]
  for (const decision of decisions) {
    const result = await runTacticalAgent(task, { model: queue([decision]), chunks })
    assert.equal(result.status, 'failed')
    assert.equal(result.proposal, undefined)
    assert.ok(result.events.some(event => event.errorCode === 'UNVERIFIED_ACTION'))
  }
  const result = await runTacticalAgent(task, { model: queue([...goodSequence(id).slice(0, 3),
    { type: 'final', actionId: id, reason: '引用不存在的规则', sourceIds: ['invented-rule'] }]), chunks })
  assert.equal(result.status, 'failed')
  assert.ok(result.events.some(event => event.errorCode === 'UNVERIFIED_SOURCE'))
})

test('未先查询合法行动时inspect请求不会执行', async () => {
  const task = input()
  const result = await runTacticalAgent(task, { model: queue([tool('inspect_action', { actionId: actionId(task) })]), chunks })
  assert.equal(result.status, 'failed')
  assert.ok(result.events.some(event => event.errorCode === 'UNLISTED_ACTION'))
  assert.equal(result.events.filter(event => event.kind === 'tool' && event.status === 'ok').length, 0)
})

test('缺配置或服务失败仅调用一次并返回unavailable，游戏可继续手动行动', async () => {
  let attempts = 0
  const result = await runTacticalAgent(input(), { chunks, model: async () => { attempts++; throw new ModelError('NOT_CONFIGURED', 'private-provider-message') } })
  assert.equal(result.status, 'unavailable')
  assert.equal(attempts, 1)
  assert.equal(result.proposal, undefined)
  assert.equal(JSON.stringify(result).includes('private-provider-message'), false)
})

test('无可建议行动或不合法输入不会发起模型调用', async () => {
  const noAction = input()
  ;(noAction.snapshot as ReturnType<typeof createGame>).players[0].hand = [{ uid: 90001, toolId: 'end' }]
  let attempts = 0
  const model: NonNullable<TacticalAgentOptions['model']> = async () => { attempts++; throw new Error('不应调用') }
  assert.equal((await runTacticalAgent(noAction, { model })).status, 'no_actions')
  const invalid = input()
  ;(invalid.snapshot as ReturnType<typeof createGame>).width = 999
  assert.equal((await runTacticalAgent(invalid, { model })).status, 'failed')
  assert.equal((await runTacticalAgent({ ...input(), playerId: 'ai-1' }, { model })).status, 'failed')
  assert.equal((await runTacticalAgent({ ...input(), goal: '' }, { model })).status, 'failed')
  assert.equal(attempts, 0)
})
