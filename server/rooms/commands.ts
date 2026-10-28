import type { GameState, Dir, Cell } from '../../src/game/types.ts'
import type { RoomCommand } from '../../src/network/types.ts'
import { DIRS, sameCell } from '../../src/game/types.ts'
import * as engine from '../../src/game/engine.ts'
import { executeTacticalAction, tacticalSnapshotKey } from '../../src/game/tactical.ts'

export class RoomError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status }
}
export function ensure(value: unknown, message = '命令参数不正确。', code = 'INVALID_COMMAND'): asserts value {
  if (!value) throw new RoomError(code, message)
}
export function object(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, allowed: string[]) {
  ensure(Object.keys(value).every(key => allowed.includes(key)))
}
export function integer(value: unknown, min = 0, max = 1_000_000_000): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
export function parseRoomCommand(input: unknown): RoomCommand {
  const c = object(input)
  ensure(typeof c.type === 'string')
  switch (c.type) {
    case 'ready': keys(c, ['type', 'ready']); ensure(typeof c.ready === 'boolean'); break
    case 'character':
      keys(c, ['type', 'characterId', 'pieceColor', 'memberId']); ensure(typeof c.characterId === 'string' && c.characterId.length < 30)
      if (c.pieceColor !== undefined) ensure(typeof c.pieceColor === 'string' && /^#[0-9a-f]{6}$/i.test(c.pieceColor))
      if (c.memberId !== undefined) ensure(typeof c.memberId === 'string' && c.memberId.length < 80)
      break
    case 'configure':
      keys(c, ['type', 'mapId', 'airdrop', 'turnTimer', 'aiMode'])
      if (c.mapId !== undefined) ensure(typeof c.mapId === 'string' && c.mapId.length < 30)
      for (const key of ['airdrop', 'turnTimer']) if (c[key] !== undefined) ensure(typeof c[key] === 'boolean')
      if (c.aiMode !== undefined) ensure(c.aiMode === 'rules' || c.aiMode === 'cloud')
      break
    case 'add_ai': case 'start': case 'rematch': case 'leave': keys(c, ['type']); break
    case 'remove': keys(c, ['type', 'memberId']); ensure(typeof c.memberId === 'string' && c.memberId.length < 80); break
    case 'reward': keys(c, ['type', 'index']); ensure(integer(c.index, 0, 2)); break
    case 'tactical': keys(c, ['type', 'actionId']); ensure(typeof c.actionId === 'string' && c.actionId.length > 0 && c.actionId.length <= 120); break
    case 'card':
      keys(c, ['type', 'uid', 'dir', 'target', 'targetId', 'stopAfter']); ensure(integer(c.uid, 1))
      if (c.dir !== undefined) ensure(DIRS.includes(c.dir as Dir))
      if (c.targetId !== undefined) ensure(typeof c.targetId === 'string' && c.targetId.length <= 40)
      if (c.stopAfter !== undefined) ensure(integer(c.stopAfter, 1, 32))
      if (c.target !== undefined) { const target = object(c.target); keys(target, ['x', 'y']); ensure(integer(target.x, 0, 31) && integer(target.y, 0, 31)) }
      break
    default: throw new RoomError('UNKNOWN_COMMAND', '不支持这项操作。')
  }
  return c as unknown as RoomCommand
}

/** 所有参数先校验，再进入规则引擎；调用方在独立副本中提交并原子替换。 */
export function applyGameCommand(state: GameState, playerId: string, command: RoomCommand): void {
  ensure(!state.finished, '对局已经结束。', 'FINISHED')
  const actor = engine.activePlayer(state)
  ensure(actor.id === playerId && !actor.isAI, '还没有轮到你行动。', 'NOT_YOUR_TURN')
  if (command.type === 'reward') {
    ensure(state.pendingReward?.playerId === playerId && !!state.pendingReward.options[command.index], '请选择当前奖励。')
    engine.chooseReward(state, command.index); return
  }
  ensure(!state.pendingReward, '请先领取奖励。')
  if (command.type === 'tactical') {
    const result = executeTacticalAction(state, playerId, command.actionId, tacticalSnapshotKey(state))
    ensure(result.ok, result.error ?? '该行动已不可用。'); return
  }
  ensure(command.type === 'card', '现在只能使用手牌或选择奖励。')
  const card = actor.hand.find(card => card.uid === command.uid)
  ensure(card, '你没有这张手牌。', 'CARD_NOT_OWNED')
  const dir = () => { ensure(command.dir && DIRS.includes(command.dir), '请选择合法方向。'); return command.dir! }
  const target = () => { ensure(command.target && engine.inBoard(state, command.target), '请选择棋盘内的目标。'); return command.target! }
  const cellAllowed = (cells: Cell[]) => { const cell = target(); ensure(cells.some(item => sameCell(item, cell)), '目标不合法，手牌未消耗。', 'INVALID_TARGET'); return cell }
  // 避免隐含、被忽略的参数在重试时变成另一种操作。
  const allowed: Record<string, string[]> = { move: ['dir', 'stopAfter'], leap: state.phase === 'turnStart' ? [] : ['dir'],
    storm: ['target'], blink: ['target'], teleport: ['target'], buildwall: ['target'], wallet: ['target'],
    punch: ['dir'], basketball: ['dir'], hook: ['dir'], rocket: ['dir'], tow: ['dir', 'targetId'] }
  for (const field of ['dir', 'target', 'targetId', 'stopAfter'] as const) ensure(command[field] === undefined || (allowed[card.toolId] ?? []).includes(field))
  if (state.phase === 'turnStart') {
    switch (card.toolId) {
      case 'roll': engine.playRollCard(state); return
      case 'copy': ensure(state.lastUsedTool && state.lastUsedTool.playerId !== actor.id, '没有可模仿的道具。'); engine.playCopyCard(state); return
      case 'prepareTow': engine.playPrepareTowCard(state); return
      case 'leap': engine.playLeapCard(state); return
      case 'storm': {
        const cell = target(); const distance = Math.abs(cell.x - actor.cell.x) + Math.abs(cell.y - actor.cell.y)
        ensure(distance >= 1 && distance <= 3 && !engine.blocksMove(state, cell) && !engine.playerAt(state, cell), '请选择3格内的空地。')
        engine.playStormCard(state, cell); return
      }
      default: throw new RoomError('WRONG_PHASE', '这张牌不能在回合开始时使用。')
    }
  }
  ensure(engine.canUseTool(state, card), '这张牌现在不能使用。', 'WRONG_PHASE')
  switch (card.toolId) {
    case 'end': engine.playEndCard(state); return
    case 'move': {
      const direction = dir()
      ensure(engine.computeMoveTargets(state, actor, card.uid).some(path => path.dir === direction), '这个方向被阻挡。')
      if (command.stopAfter !== undefined) ensure(actor.characterId === 'russell', '当前角色不能提前制动。')
      engine.resolveMoveCard(state, direction, command.stopAfter, card.uid); return
    }
    case 'leap': ensure(engine.leapTargets(state, actor, card.points ?? 0).some(path => path.dir === dir()), '这个方向无法飞跃。'); engine.playLeapTool(state, card.uid, dir()); return
    case 'blink': engine.playBlinkTool(state, card.uid, cellAllowed(engine.blinkCells(state, actor))); return
    case 'teleport': engine.playTeleportTool(state, card.uid, cellAllowed(engine.teleportCells(state))); return
    case 'wallet': case 'buildwall': engine.playAdjacentTool(state, card.uid, cellAllowed(engine.adjacentFreeCells(state, actor))); return
    case 'punch': case 'basketball': case 'hook': case 'rocket': engine.playDirectionTool(state, card.uid, dir()); return
    case 'tow': ensure(command.targetId && engine.towCandidates(state).some(player => player.id === command.targetId), '牵引目标不合法。'); engine.playTow(state, card.uid, command.targetId!, dir()); return
    case 'sprint': case 'bomb': case 'balance': case 'swapGhost': case 'recallGhost': case 'copy': engine.playSimpleTool(state, card.uid); return
    default: throw new RoomError('WRONG_PHASE', '这张牌现在不能使用。')
  }
}
