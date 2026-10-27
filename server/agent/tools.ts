import { activePlayer, distanceToGoal, findGoal } from '../../src/game/engine.ts'
import { inspectTacticalAction, listTacticalActions } from '../../src/game/tactical.ts'
import type { GameState } from '../../src/game/types.ts'
import { loadKnowledge, retrieve, type KnowledgeChunk } from '../rag/knowledge.ts'

export const TACTICAL_TOOL_NAMES = ['observe_board', 'list_actions', 'inspect_action', 'lookup_rules'] as const
export type TacticalToolName = typeof TACTICAL_TOOL_NAMES[number]
export interface ToolRequest { name: string; args: Record<string, unknown> }
export interface TacticalToolContext { snapshot: GameState; playerId: string; chunks?: KnowledgeChunk[] }
export class ToolError extends Error {
  code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function exactKeys(args: Record<string, unknown>, keys: string[]) {
  if (Object.keys(args).some(key => !keys.includes(key))) throw new ToolError('INVALID_ARGUMENTS', '工具参数包含未允许的字段。')
}

/** 工具名和参数均在分发前验证；这里没有动态函数查找、任意文件路径或命令执行入口。 */
export function validateToolRequest(name: unknown, args: unknown): ToolRequest & { name: TacticalToolName } {
  if (typeof name !== 'string' || !TACTICAL_TOOL_NAMES.includes(name as TacticalToolName)) {
    throw new ToolError('UNKNOWN_TOOL', '不允许调用这个工具。可用工具：observe_board、list_actions、inspect_action、lookup_rules。')
  }
  if (!object(args)) throw new ToolError('INVALID_ARGUMENTS', 'args必须为JSON对象。')
  if (name === 'observe_board') exactKeys(args, [])
  if (name === 'list_actions') {
    exactKeys(args, ['offset', 'limit'])
    if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || (args.offset as number) < 0 || (args.offset as number) > 1024)) {
      throw new ToolError('INVALID_ARGUMENTS', 'offset必须为0至1024的整数。')
    }
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 20)) {
      throw new ToolError('INVALID_ARGUMENTS', 'limit必须为1至20的整数。')
    }
  }
  if (name === 'inspect_action') {
    exactKeys(args, ['actionId'])
    if (typeof args.actionId !== 'string' || !args.actionId.trim() || args.actionId.length > 120) {
      throw new ToolError('INVALID_ARGUMENTS', 'actionId必须为合法行动列表里的非空编号，最长120字。')
    }
  }
  if (name === 'lookup_rules') {
    exactKeys(args, ['query'])
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 100) {
      throw new ToolError('INVALID_ARGUMENTS', 'query必须为1至100字的规则查询。')
    }
  }
  return { name: name as TacticalToolName, args: { ...args } }
}

/** 全部只读；反复调用不会花费真实卡牌、推进回合或修改存档。 */
export async function executeTacticalTool(request: ToolRequest, context: TacticalToolContext): Promise<unknown> {
  const { name, args } = validateToolRequest(request.name, request.args)
  const { snapshot: state, playerId } = context
  switch (name) {
    case 'observe_board': {
      const self = activePlayer(state)
      return {
        phase: state.phase, turnNumber: state.turnNumber, selfId: playerId,
        position: self.cell, goal: findGoal(state), distanceToGoal: distanceToGoal(state, self.cell),
        characterId: self.characterId, hand: self.hand,
        board: { width: state.width, height: state.height, specialTiles: state.tiles.flat().filter(tile => tile.kind !== 'floor') },
        opponents: state.players.filter(player => player.id !== playerId).map(player => ({ id: player.id, cell: player.cell })),
        bombs: state.bombs.map(bomb => ({ cell: bomb.cell, plantedTurn: bomb.plantedTurn })),
        pigs: state.pigs.map(pig => pig.cell), wallets: state.wallets.map(wallet => wallet.cell), storm: state.storm,
        scope: '只建议一步移动、冲刺、瞬步或瞬移；随机奖励的具体内容不作预测。',
      }
    }
    case 'list_actions': {
      const offset = (args.offset as number | undefined) ?? 0
      const limit = (args.limit as number | undefined) ?? 12
      // 先给出更接近终点的候选，避免瞬移的长列表挤掉终点；模型仍决定选哪一个并必须显式复查。
      const actions = listTacticalActions(state, playerId).map(action => ({
        action, preview: inspectTacticalAction(state, playerId, action.actionId),
      })).sort((a, b) => Number(b.preview?.finished) - Number(a.preview?.finished)
        || (a.preview?.distanceAfter ?? 999) - (b.preview?.distanceAfter ?? 999)
        || a.action.actionId.localeCompare(b.action.actionId))
      return {
        total: actions.length, offset, hasMore: offset + limit < actions.length,
        ordering: '先按本步是否完赛、再按规则引擎计算的剩余距离排序；不代表保证最优路线。',
        actions: actions.slice(offset, offset + limit).map(({ action, preview }) => ({
          ...action, preview: preview ? { to: preview.to, distanceAfter: preview.distanceAfter, finished: preview.finished,
            summary: preview.summary, warnings: preview.warnings } : null,
        })),
      }
    }
    case 'inspect_action': {
      const inspected = inspectTacticalAction(state, playerId, args.actionId as string)
      if (!inspected) throw new ToolError('ILLEGAL_ACTION', '该编号不是当前局面的合法行动，请重新查询list_actions。')
      return inspected
    }
    case 'lookup_rules': {
      const chunks = context.chunks ?? await loadKnowledge()
      const hits = retrieve(chunks, args.query as string, 3)
      return { rulesVersion: chunks[0]?.rulesVersion ?? null, sources: hits.map(hit => ({
        id: hit.chunk.id, title: hit.chunk.title, text: hit.chunk.text,
        source: hit.chunk.source, sourceLines: hit.chunk.sourceLines,
      })) }
    }
  }
}
