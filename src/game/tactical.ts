import type { Cell, Dir, GameState, PlayerState, ToolInstance } from './types.ts'
import { DIR_LABEL, DIRS } from './types.ts'
import { AI_CHARACTER, CHARACTERS } from './characters.ts'
import { MAPS, TUTORIAL_MAP, parseMap } from './maps.ts'
import { TOOLS } from './tools.ts'
import { TERRAINS } from './terrains.ts'
import {
  activePlayer, blinkCells, computeMoveTargets, distanceToGoal, isolatedSimulation,
  playBlinkTool, playSimpleTool, playTeleportTool, resolveMoveCard, teleportCells,
} from './engine.ts'

export interface TacticalAction {
  actionId: string
  kind: 'move' | 'sprint' | 'blink' | 'teleport'
  label: string
  uid: number
  dir?: Dir
  target?: Cell
  stopAfter?: number
}

export interface TacticalInspection {
  action: TacticalAction
  from: Cell
  to: Cell
  distanceBefore: number
  distanceAfter: number
  finished: boolean
  requiresReward: boolean
  summary: string
  warnings: string[]
}

function eligible(state: GameState, playerId: string): boolean {
  return !state.finished && state.phase === 'action' && !state.pendingReward
    && activePlayer(state)?.id === playerId
}

/** 第一版明确只覆盖移动、冲刺、瞬步、瞬移，不擅自结束回合或使用其他牌。 */
export function listTacticalActions(state: GameState, playerId: string, moveUid?: number): TacticalAction[] {
  if (!eligible(state, playerId)) return []
  const player = activePlayer(state)
  const actions: TacticalAction[] = []
  const move = player.hand.find(card => card.toolId === 'move' && (moveUid === undefined || card.uid === moveUid))
  if (move) {
    for (const path of computeMoveTargets(state, player)) {
      actions.push({ actionId: `move:${move.uid}:${path.dir}`, kind: 'move', uid: move.uid,
        dir: path.dir, label: `使用移动牌，向${DIR_LABEL[path.dir]}滑行` })
      // 引擎只允许罗素提前停止；全程滑行已由不带stopAfter的行动覆盖。
      if (player.characterId === 'russell') {
        const paidStops = [...new Set(path.stops ?? path.cells.map((_, index) => index + 1))]
        for (const stop of paidStops.slice(0, -1)) {
          actions.push({ actionId: `move:${move.uid}:${path.dir}:${stop}`, kind: 'move', uid: move.uid,
            dir: path.dir, stopAfter: stop, label: `向${DIR_LABEL[path.dir]}第 ${stop} 步后制动` })
        }
      }
    }
  }
  // 相同道具的第二张在本次单步中等价，不重复展开整张棋盘。
  const seenKinds = new Set<string>()
  for (const card of player.hand) {
    if (seenKinds.has(card.toolId)) continue
    seenKinds.add(card.toolId)
    if (card.toolId === 'sprint' && move) {
      actions.push({ actionId: `sprint:${card.uid}`, kind: 'sprint', uid: card.uid,
        label: `使用冲刺，移动牌从 ${move.points ?? 0} 点增加到 ${(move.points ?? 0) + 2} 点` })
    }
    const cells = card.toolId === 'blink' ? blinkCells(state, player)
      : card.toolId === 'teleport' ? teleportCells(state) : []
    for (const target of cells) {
      const kind = card.toolId as 'blink' | 'teleport'
      actions.push({ actionId: `${kind}:${card.uid}:${target.x}:${target.y}`, kind, uid: card.uid,
        target: { ...target }, label: `使用${kind === 'blink' ? '瞬步' : '瞬移'}到 (${target.x}, ${target.y})` })
    }
  }
  return actions
}

function applyAction(state: GameState, action: TacticalAction): void {
  switch (action.kind) {
    case 'move': resolveMoveCard(state, action.dir!, action.stopAfter, action.uid); break
    case 'sprint': playSimpleTool(state, action.uid); break
    case 'blink': playBlinkTool(state, action.uid, action.target!); break
    case 'teleport': playTeleportTool(state, action.uid, action.target!); break
  }
}

/** 使用真实规则引擎推演位置和地形效果；随机奖励牌的抽取不作为预测内容。 */
export function inspectTacticalAction(state: GameState, playerId: string, actionId: string, moveUid?: number): TacticalInspection | null {
  const action = listTacticalActions(state, playerId, moveUid).find(item => item.actionId === actionId)
  if (!action) return null
  const before = activePlayer(state)
  const sim = JSON.parse(JSON.stringify(state)) as GameState
  sim.logs = []
  sim.effects = []
  isolatedSimulation(() => applyAction(sim, action))
  const after = sim.players.find(player => player.id === playerId)!
  const warnings: string[] = []
  if (sim.logs.some(entry => /坑洞|毒气|被击进|回到出生点/.test(entry.text))) warnings.push('该行动会触发危险地形，棋子可能回到出生点。')
  if (sim.pendingReward && !sim.finished) warnings.push('该行动会触发奖励，仍需要玩家手动选牌。')
  if (state.wallets.length !== sim.wallets.length || sim.pendingReward) warnings.push('随机奖励的具体牌面不作预测，实际执行时才抽取。')
  if (sim.logs.some(entry => /大炮|火箭|爆炸/.test(entry.text))) warnings.push('该行动会触发大炮或击退，可能影响其他棋子。')
  const distanceBefore = distanceToGoal(state, before.cell)
  const distanceAfter = distanceToGoal(sim, after.cell)
  const summary = action.kind === 'sprint'
    ? `消耗一张冲刺牌，现有移动牌增加 2 点；棋子仍在 (${after.cell.x}, ${after.cell.y})。`
    : `消耗${action.kind === 'move' ? '移动' : action.kind === 'blink' ? '瞬步' : '瞬移'}牌，结算后位于 (${after.cell.x}, ${after.cell.y})。${after.finishedTurn ? '立即抵达终点。' : `到终点的静态最短路径估计为 ${distanceAfter === 999 ? '不可达' : `${distanceAfter} 格`}。`}`
  return { action, from: { ...before.cell }, to: { ...after.cell }, distanceBefore, distanceAfter,
    finished: !!after.finishedTurn, requiresReward: !!sim.pendingReward && !sim.finished, summary, warnings }
}

/** 只保留当前玩家的手牌，姓名、历史文字和视觉特效均不进入云端上下文。 */
export function createTacticalSnapshot(state: GameState, playerId: string): GameState {
  const players = state.players.map((player, index): PlayerState => ({
    id: player.id, name: player.id === playerId ? '当前玩家' : `对手${index + 1}`,
    isAI: player.isAI, characterId: player.characterId, pieceColor: player.pieceColor,
    ready: player.ready, isHost: player.isHost, cell: { ...player.cell }, spawn: { ...player.spawn },
    ...(player.finishedTurn !== undefined ? { finishedTurn: player.finishedTurn } : {}),
    hookLevel: player.hookLevel, savedMove: player.savedMove,
    hand: player.id === playerId ? player.hand.map(card => ({ ...card })) : [],
  }))
  return JSON.parse(JSON.stringify({
    mapId: state.mapId, mapLabel: state.mapLabel, width: state.width, height: state.height,
    tiles: state.tiles.map(row => row.map(tile => ({ ...tile }))), players,
    activeIndex: state.activeIndex, turnNumber: state.turnNumber, phase: state.phase,
    dice: { ...state.dice }, bombs: state.bombs.map(entity => ({ ...entity, cell: { ...entity.cell } })),
    pigs: state.pigs.map(entity => ({ ...entity, cell: { ...entity.cell } })),
    wallets: state.wallets.map(entity => ({ ...entity, cell: { ...entity.cell } })),
    ...(state.ghost ? { ghost: { cell: { ...state.ghost.cell } } } : {}),
    ...(state.storm ? { storm: { ...state.storm, cell: { ...state.storm.cell } } } : {}),
    effects: [], logs: [], mechanisms: { ...state.mechanisms }, finished: state.finished,
    ...(state.pendingReward ? { pendingReward: state.pendingReward } : {}),
    ...(state.lastUsedTool ? { lastUsedTool: { ...state.lastUsedTool } } : {}),
  })) as GameState
}

/** 完整字符串比较避免短哈希碰撞。包含棋盘、资源、阶段、回合、实体与活动玩家。 */
export function tacticalSnapshotKey(state: GameState): string {
  return JSON.stringify(createTacticalSnapshot(state, activePlayer(state).id))
}

export function executeTacticalAction(
  state: GameState, playerId: string, actionId: string, expectedSnapshotKey: string,
): { ok: boolean; error?: string } {
  if (!eligible(state, playerId)) return { ok: false, error: '当前不是你的行动阶段，请重新获取建议。' }
  if (typeof expectedSnapshotKey !== 'string' || tacticalSnapshotKey(state) !== expectedSnapshotKey) {
    return { ok: false, error: '局面已经改变，旧建议已失效，请重新分析。' }
  }
  const action = listTacticalActions(state, playerId).find(item => item.actionId === actionId)
  if (!action) return { ok: false, error: '这项行动已不可用，请重新分析。' }
  // 检查和执行是同一个同步调用，中间没有await，不会被其他操作插入。
  applyAction(state, action)
  return { ok: true }
}

function ensure(condition: unknown, message = '战术局面格式无效。'): asserts condition {
  if (!condition) throw new Error(message)
}
function object(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function integer(value: unknown, min = 0, max = 1_000_000_000): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function array(value: unknown, max: number): unknown[] {
  ensure(Array.isArray(value) && value.length <= max)
  return value
}

/** API接收的是不可信JSON。逐层验证后重建白名单字段，绝不把未知字段交给规则引擎。 */
export function parseTacticalSnapshot(input: unknown): GameState {
  const state = object(input)
  const map = [TUTORIAL_MAP, ...MAPS].find(item => item.id === state.mapId)
  ensure(map, '未知地图，无法进行战术分析。')
  const { width, height } = parseMap(map)
  ensure(state.width === width && state.height === height && state.mapLabel === map.label)
  ensure(state.phase === 'action' && state.finished === false && state.pendingReward === undefined,
    '请在投骰完成、领取奖励后的行动阶段使用战术助手。')
  ensure(integer(state.turnNumber, 1) && integer(state.activeIndex, 0, 7))
  const cell = (value: unknown): Cell => {
    const c = object(value)
    ensure(integer(c.x, 0, width - 1) && integer(c.y, 0, height - 1))
    return { x: c.x, y: c.y }
  }
  const seenCards = new Set<number>()
  const card = (value: unknown): ToolInstance => {
    const item = object(value)
    ensure(integer(item.uid, 1) && !seenCards.has(item.uid))
    seenCards.add(item.uid)
    ensure(typeof item.toolId === 'string' && Object.hasOwn(TOOLS, item.toolId))
    if (item.points !== undefined) ensure(integer(item.points, 0, 1_000_000))
    if (item.length !== undefined) ensure(integer(item.length, 1, 5))
    if (item.system !== undefined) ensure(typeof item.system === 'boolean')
    if (item.toolId === 'move') ensure(integer(item.points, 0, 1_000_000))
    return { uid: item.uid, toolId: item.toolId as ToolInstance['toolId'],
      ...(item.points !== undefined ? { points: item.points as number } : {}),
      ...(item.length !== undefined ? { length: item.length as number } : {}),
      ...(item.system !== undefined ? { system: item.system as boolean } : {}) }
  }
  const rawPlayers = array(state.players, 8)
  ensure(rawPlayers.length >= 2 && (state.activeIndex as number) < rawPlayers.length)
  const playerIds = new Set<string>()
  const players: PlayerState[] = rawPlayers.map((value, index) => {
    const p = object(value)
    ensure(typeof p.id === 'string' && /^(human|ai-[1-7])$/.test(p.id) && !playerIds.has(p.id))
    playerIds.add(p.id)
    ensure([AI_CHARACTER, ...CHARACTERS].some(character => character.id === p.characterId))
    ensure(typeof p.isAI === 'boolean' && typeof p.ready === 'boolean' && typeof p.isHost === 'boolean')
    ensure(typeof p.pieceColor === 'string' && /^#[0-9a-f]{6}$/i.test(p.pieceColor))
    ensure(integer(p.hookLevel, 1, 5) && integer(p.savedMove))
    ensure(p.finishedTurn === undefined)
    const hand = array(p.hand, 128).map(card)
    ensure(index === state.activeIndex || hand.length === 0, '局面不能包含其他玩家的隐藏手牌。')
    return { id: p.id, name: index === state.activeIndex ? '当前玩家' : `对手${index + 1}`,
      isAI: p.isAI, ready: p.ready, isHost: p.isHost,
      characterId: p.characterId as string, pieceColor: p.pieceColor,
      cell: cell(p.cell), spawn: cell(p.spawn), hookLevel: p.hookLevel, savedMove: p.savedMove, hand }
  })
  const rawTiles = array(state.tiles, height)
  ensure(rawTiles.length === height)
  let starts = 0, goals = 0
  const tiles = rawTiles.map((value, y) => {
    const row = array(value, width)
    ensure(row.length === width)
    return row.map((value, x) => {
      const tile = object(value)
      ensure(tile.x === x && tile.y === y && typeof tile.kind === 'string' && Object.hasOwn(TERRAINS, tile.kind))
      if (tile.dir !== undefined) ensure(DIRS.includes(tile.dir as Dir))
      if (tile.kind === 'conveyor' || tile.kind === 'cannon') ensure(tile.dir !== undefined)
      if (tile.durability !== undefined) ensure(integer(tile.durability, 0, 2))
      if (tile.kind === 'earthwall') ensure(integer(tile.durability, 1, 2))
      if (tile.kind === 'start') starts++
      if (tile.kind === 'goal') goals++
      return { x, y, kind: tile.kind as keyof typeof TERRAINS,
        ...(tile.dir !== undefined ? { dir: tile.dir as Dir } : {}),
        ...(tile.durability !== undefined ? { durability: tile.durability as number } : {}) }
    })
  })
  ensure(starts === 1 && goals === 1)
  const dice = object(state.dice)
  ensure(dice.move === null || integer(dice.move, 0, 1_000_000))
  ensure(dice.toolName === null || (typeof dice.toolName === 'string' && dice.toolName.length <= 30))
  const mechanisms = object(state.mechanisms)
  ensure(typeof mechanisms.airdrop === 'boolean' && typeof mechanisms.turnTimer === 'boolean')
  ensure(array(state.logs, 0).length === 0 && array(state.effects, 0).length === 0)
  const seenEntities = new Set<number>()
  const entity = (value: unknown) => {
    const e = object(value)
    ensure(integer(e.id, 1) && !seenEntities.has(e.id))
    seenEntities.add(e.id)
    return { id: e.id, cell: cell(e.cell) }
  }
  const pigs = array(state.pigs, width * height).map(entity)
  const wallets = array(state.wallets, 256).map(entity)
  const bombs = array(state.bombs, 256).map(value => {
    const bomb = object(value), base = entity(value)
    ensure(typeof bomb.ownerId === 'string' && playerIds.has(bomb.ownerId) && integer(bomb.plantedTurn, 1, state.turnNumber as number))
    return { ...base, ownerId: bomb.ownerId, plantedTurn: bomb.plantedTurn }
  })
  const ghost = state.ghost === undefined ? undefined : { cell: cell(object(state.ghost).cell) }
  let storm: GameState['storm']
  if (state.storm !== undefined) {
    const rawStorm = object(state.storm), base = entity(state.storm)
    ensure(integer(rawStorm.remainingTurns, 1, 10))
    storm = { ...base, remainingTurns: rawStorm.remainingTurns }
  }
  let lastUsedTool: GameState['lastUsedTool']
  if (state.lastUsedTool !== undefined) {
    const last = object(state.lastUsedTool)
    ensure(typeof last.playerId === 'string' && playerIds.has(last.playerId)
      && typeof last.toolId === 'string' && Object.hasOwn(TOOLS, last.toolId))
    lastUsedTool = { playerId: last.playerId, toolId: last.toolId as ToolInstance['toolId'] }
  }
  return { mapId: map.id, mapLabel: map.label, width, height, tiles, players,
    activeIndex: state.activeIndex as number, turnNumber: state.turnNumber as number, phase: 'action',
    dice: { move: dice.move as number | null, toolName: dice.toolName as string | null },
    bombs, pigs, wallets, ...(ghost ? { ghost } : {}), ...(storm ? { storm } : {}),
    effects: [], logs: [], mechanisms: { airdrop: mechanisms.airdrop, turnTimer: mechanisms.turnTimer }, finished: false,
    ...(lastUsedTool ? { lastUsedTool } : {}) }
}
