import type {
  BombEntity,
  Cell,
  Dir,
  GameConfig,
  GameState,
  PlayerState,
  Tile,
  ToolInstance,
} from './types.ts'
import { DIRS, DIR_DELTA, cellKey, sameCell } from './types.ts'
import { TERRAINS } from './terrains.ts'
import { mapById, parseMap } from './maps.ts'
import { characterById } from './characters.ts'
import { TOOLS, TOOL_DIE_POOL } from './tools.ts'

let toolSerial = 1
let entitySerial = 1
let logSerial = 1
let effectSerial = 1

function nextToolSerial() {
  return toolSerial++
}

function pushSystemCard(player: PlayerState, toolId: ToolInstance['toolId'], params?: { points?: number; length?: number }) {
  const instance: ToolInstance = { uid: nextToolSerial(), toolId, system: true }
  if (params?.points !== undefined) instance.points = params.points
  if (params?.length !== undefined) instance.length = params.length
  player.hand.push(instance)
}

export function log(state: GameState, text: string) {
  state.logs.unshift({ id: logSerial++, text })
  if (state.logs.length > 40) state.logs.length = 40
}

export function pushEffect(
  state: GameState,
  kind: 'explosion' | 'projectile' | 'punch' | 'swap' | 'airdrop' | 'spawn',
  payload: { from?: Cell; to?: Cell; cell?: Cell },
) {
  state.effects.push({ id: effectSerial++, kind, ...payload })
  if (state.effects.length > 30) state.effects.splice(0, state.effects.length - 30)
}

export function createGame(config: GameConfig): GameState {
  const mapDef = mapById(config.mapId)
  const { tiles, width, height } = parseMap(mapDef)
  const startCell = findStart(tiles)
  const players: PlayerState[] = config.players.map((entry, index) => ({
    id: index === 0 ? 'human' : `ai-${index}`,
    name: entry.name,
    isAI: entry.isAI,
    characterId: entry.characterId,
    pieceColor: entry.pieceColor,
    ready: true,
    isHost: entry.isHost,
    cell: { ...startCell },
    spawn: { ...startCell },
    hookLevel: entry.characterId === 'chang' ? 1 : 4,
    savedMove: 0,
    hand: [],
  }))
  const state: GameState = {
    mapId: mapDef.id,
    mapLabel: mapDef.label,
    width,
    height,
    tiles,
    players,
    activeIndex: 0,
    turnNumber: 1,
    phase: 'turnStart',
    dice: { move: null, toolName: null },
    bombs: [],
    pigs: [],
    wallets: [],
    effects: [],
    logs: [],
    mechanisms: { ...config.mechanisms },
    finished: false,
  }
  if (players.some((p) => characterById(p.characterId).id === 'heart')) {
    state.ghost = { cell: randomFreeCell(state) ?? { ...startCell } }
    log(state, '小幽灵出现在棋盘上，随风飘荡。')
  }
  if (config.mechanisms.airdrop) {
    airdropPigs(state, 3)
    log(state, '一大批骰子猪正在降落！')
  }
  log(state, `对局开始：${mapDef.label}。率先抵达紫色终点者获胜。`)
  beginTurn(state)
  return state
}

function findStart(tiles: Tile[][]): Cell {
  for (const row of tiles) {
    for (const tile of row) {
      if (tile.kind === 'start') return { x: tile.x, y: tile.y }
    }
  }
  return { x: 0, y: tiles.length - 1 }
}

export function findGoal(state: GameState): Cell {
  for (const row of state.tiles) {
    for (const tile of row) {
      if (tile.kind === 'goal') return { x: tile.x, y: tile.y }
    }
  }
  return { x: state.width - 1, y: 0 }
}

export function tileAt(state: GameState, cell: Cell): Tile {
  return state.tiles[cell.y][cell.x]
}

export function inBoard(state: GameState, cell: Cell): boolean {
  return cell.x >= 0 && cell.y >= 0 && cell.x < state.width && cell.y < state.height
}

export function blocksMove(state: GameState, cell: Cell): boolean {
  if (!inBoard(state, cell)) return true
  const def = TERRAINS[tileAt(state, cell).kind]
  if (def.blocksMove) return true
  if (state.storm && sameCell(state.storm.cell, cell)) return true
  return false
}

export function blocksShot(state: GameState, cell: Cell): boolean {
  if (!inBoard(state, cell)) return true
  if (TERRAINS[tileAt(state, cell).kind].blocksShot) return true
  if (state.storm && sameCell(state.storm.cell, cell)) return true
  return false
}

export function playerAt(state: GameState, cell: Cell): PlayerState | undefined {
  return state.players.find((p) => sameCell(p.cell, cell))
}

export function activePlayer(state: GameState): PlayerState {
  return state.players[state.activeIndex]
}

function randomFreeCell(state: GameState): Cell | null {
  const candidates: Cell[] = []
  for (const row of state.tiles) {
    for (const tile of row) {
      const cell = { x: tile.x, y: tile.y }
      if (tile.kind === 'floor' && !playerAt(state, cell) && !pigAt(state, cell) && !walletAt(state, cell)) {
        candidates.push(cell)
      }
    }
  }
  if (!candidates.length) return null
  return candidates[Math.floor(Math.random() * candidates.length)]
}

export function pigAt(state: GameState, cell: Cell) {
  return state.pigs.find((p) => sameCell(p.cell, cell))
}

export function walletAt(state: GameState, cell: Cell) {
  return state.wallets.find((w) => sameCell(w.cell, cell))
}

function airdropPigs(state: GameState, count: number) {
  for (let i = 0; i < count; i++) {
    const cell = randomFreeCell(state)
    if (!cell) break
    state.pigs.push({ id: entitySerial++, cell })
    pushEffect(state, 'airdrop', { cell })
  }
}

function grantTool(state: GameState, player: PlayerState, toolId: ToolInstance['toolId'], params?: { points?: number; length?: number }) {
  const instance: ToolInstance = { uid: nextToolSerial(), toolId }
  if (params?.points !== undefined) instance.points = params.points
  if (params?.length !== undefined) instance.length = params.length
  player.hand.push(instance)
  return instance
}

function rollToolDie(state: GameState, player: PlayerState): ToolInstance {
  const toolId = TOOL_DIE_POOL[Math.floor(Math.random() * TOOL_DIE_POOL.length)]
  const params: { points?: number; length?: number } = {}
  if (toolId === 'hook') params.length = player.hookLevel
  const instance = grantTool(state, player, toolId, params)
  state.dice.toolName = TOOLS[toolId].name
  state.lastUsedTool = undefined
  log(state, `${player.name} 的工具骰给出了【${TOOLS[toolId].name}】。`)
  return instance
}

function moveDieValue(player: PlayerState): number {
  const raw = Math.floor(Math.random() * 6) + 1
  const isJean = player.characterId === 'jean'
  return Math.max(1, raw - (isJean ? 2 : 0))
}

function setSystemCards(state: GameState, player: PlayerState, phase: GameState['phase']) {
  // 系统卡每次进入新阶段全部作废重发；玩家库存工具（非 system 标记）跨回合保留
  player.hand = player.hand.filter((t) => !t.system)
  const char = characterById(player.characterId)
  if (phase === 'turnStart') {
    pushSystemCard(player, 'roll')
    if (char.id === 'lanpen' && state.lastUsedTool && state.lastUsedTool.playerId !== player.id) {
      pushSystemCard(player, 'copy')
    }
    if (char.id === 'lock') pushSystemCard(player, 'prepareTow')
    if (char.id === 'flandi') pushSystemCard(player, 'leap')
    if (char.id === 'storm') pushSystemCard(player, 'storm')
  } else if (phase === 'action') {
    pushSystemCard(player, 'end')
    if (char.id === 'goose') pushSystemCard(player, 'basketball')
    if (char.id === 'morrison') pushSystemCard(player, 'buildwall')
    if (char.id === 'jean') pushSystemCard(player, 'blink')
    if (char.id === 'heart' && state.ghost) pushSystemCard(player, 'swapGhost')
    if (char.id === 'fazhen') {
      const mc = player.hand.find((t) => t.toolId === 'move')
      if (mc && (mc.points ?? 0) >= 2) pushSystemCard(player, 'balance', { points: Math.floor((mc.points ?? 0) / 2) })
    }
  } else if (phase === 'turnEnd') {
    pushSystemCard(player, 'end')
    if (char.id === 'leader') pushSystemCard(player, 'wallet')
    if (char.id === 'blaze') pushSystemCard(player, 'bomb')
    if (char.id === 'heart' && state.ghost) pushSystemCard(player, 'recallGhost')
  }
}

export function beginTurn(state: GameState) {
  if (state.finished) return
  const player = activePlayer(state)
  state.dice = { move: null, toolName: null }
  detonateBombs(state, player)
  tickStorm(state)
  state.phase = 'turnStart'
  setSystemCards(state, player, 'turnStart')
  log(state, `第 ${state.turnNumber} 回合 · 轮到 ${player.name}。`)
}

function detonateBombs(state: GameState, owner: PlayerState) {
  const due = state.bombs.filter((b) => b.ownerId === owner.id && b.plantedTurn < state.turnNumber)
  for (const bomb of due) {
    state.bombs = state.bombs.filter((b) => b.id !== bomb.id)
    pushEffect(state, 'explosion', { cell: bomb.cell })
    log(state, `炸药爆炸了！`)
    for (const target of state.players) {
      const dx = target.cell.x - bomb.cell.x
      const dy = target.cell.y - bomb.cell.y
      if (Math.abs(dx) + Math.abs(dy) === 1) {
        const dir: Dir = dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up'
        knockback(state, target, dir, 2, `${target.name} 被炸飞了`)
      }
    }
  }
}

function tickStorm(state: GameState) {
  if (!state.storm) return
  const center = state.storm.cell
  log(state, '风暴巨剑吸附着周围的生物。')
  for (const target of state.players) {
    const dx = center.x - target.cell.x
    const dy = center.y - target.cell.y
    if (Math.abs(dx) + Math.abs(dy) === 1) {
      const dir: Dir = dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up'
      knockback(state, target, dir, 1, `${target.name} 被吸向风暴中心`)
    }
  }
  state.storm.remainingTurns -= 1
  if (state.storm.remainingTurns <= 0) {
    log(state, '风暴巨剑消失了。')
    state.storm = undefined
  }
}

export function nextTurn(state: GameState) {
  if (state.finished) return
  const player = activePlayer(state)
  player.hand = player.hand.filter((t) => !t.system)
  state.activeIndex = (state.activeIndex + 1) % state.players.length
  state.turnNumber += 1
  beginTurn(state)
}

export function playRollCard(state: GameState) {
  const player = activePlayer(state)
  if (state.phase !== 'turnStart') return
  const card = player.hand.find((t) => t.toolId === 'roll')
  if (!card) return
  player.hand = player.hand.filter((t) => t.uid !== card.uid)
  const moveValue = moveDieValue(player) + player.savedMove
  const saved = player.savedMove
  player.savedMove = 0
  state.dice.move = moveValue
  log(
    state,
    `${player.name} 投出移动骰 ${state.dice.move}${saved ? `（含制衡取回 ${saved} 点）` : ''}。`,
  )
  grantTool(state, player, 'move', { points: moveValue })
  rollToolDie(state, player)
  state.phase = 'action'
  setSystemCards(state, player, 'action')
}

export function playCopyCard(state: GameState) {
  const player = activePlayer(state)
  if (state.phase !== 'turnStart' || !state.lastUsedTool) return
  const card = player.hand.find((t) => t.toolId === 'copy')
  if (!card) return
  player.hand = player.hand.filter((t) => t.uid !== card.uid)
  player.hand = player.hand.filter((t) => t.toolId !== 'roll')
  const moveValue = moveDieValue(player) + player.savedMove
  player.savedMove = 0
  state.dice.move = moveValue
  grantTool(state, player, 'move', { points: moveValue })
  const copiedId = state.lastUsedTool.toolId
  const params: { points?: number; length?: number } = {}
  if (copiedId === 'hook') params.length = player.hookLevel
  grantTool(state, player, copiedId, params)
  state.dice.toolName = `复制·${TOOLS[copiedId].name}`
  log(state, `${player.name} 放弃工具骰，复制了【${TOOLS[copiedId].name}】。`)
  state.phase = 'action'
  setSystemCards(state, player, 'action')
}

export function playPrepareTowCard(state: GameState) {
  const player = activePlayer(state)
  if (state.phase !== 'turnStart') return
  const card = player.hand.find((t) => t.toolId === 'prepareTow')
  if (!card) return
  player.hand = player.hand.filter((t) => t.uid !== card.uid)
  player.hand = player.hand.filter((t) => t.toolId !== 'roll')
  state.dice.move = 0
  log(state, `${player.name} 放弃移动骰，握紧了牵引锁链。`)
  grantTool(state, player, 'tow')
  rollToolDie(state, player)
  state.phase = 'action'
  setSystemCards(state, player, 'action')
}

export function playLeapCard(state: GameState) {
  const player = activePlayer(state)
  if (state.phase !== 'turnStart') return
  const card = player.hand.find((t) => t.toolId === 'leap')
  if (!card) return
  player.hand = player.hand.filter((t) => t.uid !== card.uid)
  player.hand = player.hand.filter((t) => t.toolId !== 'roll')
  const moveValue = moveDieValue(player)
  state.dice.move = moveValue
  state.dice.toolName = '飞跃'
  log(state, `${player.name} 放弃工具骰，将移动改为飞跃 ${moveValue} 格。`)
  grantTool(state, player, 'leap', { points: moveValue })
  state.phase = 'action'
  setSystemCards(state, player, 'action')
}

export function playStormCard(state: GameState, target: Cell) {
  const player = activePlayer(state)
  if (state.phase !== 'turnStart') return
  const card = player.hand.find((t) => t.toolId === 'storm')
  if (!card) return
  const dist = Math.abs(target.x - player.cell.x) + Math.abs(target.y - player.cell.y)
  if (dist > 3 || dist === 0 || blocksMove(state, target) || playerAt(state, target)) return
  player.hand = player.hand.filter((t) => t.uid !== card.uid)
  player.hand = player.hand.filter((t) => t.toolId !== 'roll')
  state.storm = { id: entitySerial++, cell: { ...target }, remainingTurns: 1 }
  pushEffect(state, 'spawn', { cell: target })
  log(state, `${player.name} 召唤了风暴巨剑！`)
  tickStorm(state)
  nextTurn(state)
}

export function playEndCard(state: GameState) {
  const player = activePlayer(state)
  if (state.phase === 'action') {
    if (characterById(player.characterId).id === 'jean') {
      const moveCard = player.hand.find((t) => t.toolId === 'move')
      if (moveCard && (moveCard.points ?? 0) > 0) {
        grantTool(state, player, 'blink')
        log(state, `${player.name} 行动结束时仍有移动，再次获得【瞬步】。`)
      }
    }
    state.phase = 'turnEnd'
    setSystemCards(state, player, 'turnEnd')
    return
  }
  if (state.phase === 'turnEnd') {
    nextTurn(state)
  }
}

export interface MoveTarget {
  dir: Dir
  cells: Cell[]
}

export function computeMoveTargets(state: GameState, player: PlayerState): MoveTarget[] {
  const moveCard = player.hand.find((t) => t.toolId === 'move')
  if (!moveCard) return []
  return computeSlideTargets(state, player, moveCard.points ?? 0)
}

export function computeSlideTargets(state: GameState, player: PlayerState, points: number): MoveTarget[] {
  const targets: MoveTarget[] = []
  for (const dir of DIRS) {
    const cells: Cell[] = []
    let current = { ...player.cell }
    let remaining = points
    let steps = 0
    while (remaining > 0 && steps < 32) {
      const delta = DIR_DELTA[dir]
      const next = { x: current.x + delta.x, y: current.y + delta.y }
      if (!inBoard(state, next)) break
      const tile = tileAt(state, next)
      if (TERRAINS[tile.kind].blocksMove) {
        if (tile.kind === 'earthwall' && (tile.durability ?? 0) > 0 && remaining >= 2) {
          remaining -= 2
          current = next
          cells.push({ ...next })
          steps++
          continue
        }
        break
      }
      if (state.storm && sameCell(state.storm.cell, next)) break
      const occupant = playerAt(state, next)
      if (occupant && occupant.id !== player.id) break
      current = next
      remaining -= 1
      cells.push({ ...next })
      steps++
    }
    if (cells.length) targets.push({ dir, cells })
  }
  return targets
}

export function resolveMoveCard(state: GameState, dir: Dir, stopAfter?: number) {
  const player = activePlayer(state)
  if (state.phase !== 'action') return
  const moveCard = player.hand.find((t) => t.toolId === 'move')
  if (!moveCard) return
  const canBrake = characterById(player.characterId).id === 'russell'
  const cap = canBrake && stopAfter && stopAfter > 0 ? stopAfter : Infinity
  player.hand = player.hand.filter((t) => t.uid !== moveCard.uid)
  slidePlayer(state, player, dir, moveCard.points ?? 0, cap, `${player.name} 的移动`)
}

function slidePlayer(
  state: GameState,
  player: PlayerState,
  dir: Dir,
  points: number,
  cap: number,
  reason: string,
) {
  let current = { ...player.cell }
  let remaining = points
  let moved = 0
  const delta = DIR_DELTA[dir]
  while (remaining > 0 && moved < cap && moved < 32) {
    const next = { x: current.x + delta.x, y: current.y + delta.y }
    if (!inBoard(state, next)) break
    const tile = tileAt(state, next)
    if (TERRAINS[tile.kind].blocksMove) {
      if (tile.kind === 'earthwall' && (tile.durability ?? 0) > 0 && remaining >= 2) {
        tile.durability = (tile.durability ?? 0) - 1
        remaining -= 2
        current = next
        moved++
        pushEffect(state, 'punch', { cell: next })
        log(state, `${player.name} 撞碎了土墙的砖块。`)
        if ((tile.durability ?? 0) <= 0) tile.kind = 'floor'
        player.cell = { ...current }
        continue
      }
      if (tile.kind === 'punchball') {
        pushEffect(state, 'punch', { cell: next })
        log(state, `${player.name} 撞上拳击球，被弹了回去。`)
        knockback(state, player, opposite(dir), 1, '')
        return
      }
      break
    }
    if (state.storm && sameCell(state.storm.cell, next)) break
    const occupant = playerAt(state, next)
    if (occupant && occupant.id !== player.id) break
    current = next
    remaining -= 1
    moved++
    player.cell = { ...current }
    const enter = onEnterCell(state, player, current, dir)
    if (enter === 'died' || enter === 'finished') return
    if (enter === 'boosted') {
      // conveyor boost: free extra step in the same direction
      const beyond = { x: current.x + delta.x, y: current.y + delta.y }
      if (
        inBoard(state, beyond) &&
        !blocksMove(state, beyond) &&
        !(playerAt(state, beyond) && playerAt(state, beyond)!.id !== player.id)
      ) {
        current = beyond
        player.cell = { ...beyond }
        const extra = onEnterCell(state, player, current, dir)
        if (extra === 'died' || extra === 'finished') return
      }
    }
  }
  onStopCell(state, player, player.cell)
}

const OPPOSITE: Record<Dir, Dir> = { up: 'down', down: 'up', left: 'right', right: 'left' }

function opposite(dir: Dir): Dir {
  return OPPOSITE[dir]
}

function onEnterCell(
  state: GameState,
  player: PlayerState,
  cell: Cell,
  moveDir: Dir,
): 'ok' | 'died' | 'finished' | 'boosted' {
  const tile = tileAt(state, cell)
  const pig = pigAt(state, cell)
  if (pig) {
    state.pigs = state.pigs.filter((p) => p.id !== pig.id)
    log(state, `${player.name} 经过骰子猪，捡走了它头上的奖励！`)
    queueReward(state, player, '骰子猪的奖励')
  }
  const wallet = walletAt(state, cell)
  if (wallet) {
    state.wallets = state.wallets.filter((w) => w.id !== wallet.id)
    const toolId = TOOL_DIE_POOL[Math.floor(Math.random() * TOOL_DIE_POOL.length)]
    const params: { points?: number; length?: number } = {}
    if (toolId === 'hook') params.length = player.hookLevel
    grantTool(state, player, toolId, params)
    log(state, `${player.name} 捡到钱包，获得【${TOOLS[toolId].name}】。`)
  }
  if (tile.kind === 'home') {
    player.spawn = { ...cell }
    log(state, `${player.name} 经过家园，把出生点安在了这里。`)
  }
  if (tile.kind === 'pit') {
    killPlayer(state, player, '掉进了坑洞')
    return 'died'
  }
  if (tile.kind === 'goal') {
    finishPlayer(state, player)
    return 'finished'
  }
  if (tile.kind === 'conveyor' && tile.dir === moveDir) {
    return 'boosted'
  }
  return 'ok'
}

function onStopCell(state: GameState, player: PlayerState, cell: Cell) {
  if (player.finishedTurn) return
  const tile = tileAt(state, cell)
  // 瞬移、瞬步、飞跃和钩锁会直接调用停留结算，也必须能触发终点。
  if (tile.kind === 'goal') {
    finishPlayer(state, player)
    return
  }
  if (tile.kind === 'poison') {
    killPlayer(state, player, '被毒气吞没')
    return
  }
  if (tile.kind === 'lucky') {
    tile.kind = 'floor'
    log(state, `${player.name} 停在幸运方块上！`)
    queueReward(state, player, '幸运方块的奖励')
    return
  }
  if (tile.kind === 'cannon' && tile.dir) {
    log(state, `大炮轰然开火！`)
    fireRocketPath(state, cell, tile.dir, player)
  }
}

function queueReward(state: GameState, player: PlayerState, reason: string) {
  const options: ToolInstance[] = []
  const pool = [...TOOL_DIE_POOL]
  for (let i = 0; i < 3 && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length)
    const toolId = pool.splice(idx, 1)[0]
    const params: { points?: number; length?: number } = {}
    if (toolId === 'hook') params.length = player.hookLevel
    const instance: ToolInstance = { uid: nextToolSerial(), toolId }
    if (params.points !== undefined) instance.points = params.points
    if (params.length !== undefined) instance.length = params.length
    options.push(instance)
  }
  state.pendingReward = { playerId: player.id, options, reason }
  if (state.phase !== 'finished') state.phase = 'reward'
}

export function chooseReward(state: GameState, index: number) {
  if (!state.pendingReward) return
  const pending = state.pendingReward
  state.pendingReward = undefined
  const player = state.players.find((p) => p.id === pending.playerId)
  const option = pending.options[index]
  if (player && option) {
    player.hand.push(option)
    log(state, `${player.name} 选择了【${TOOLS[option.toolId].name}】。`)
  }
  if (state.finished) return
  state.phase = 'action'
}

export function killPlayer(state: GameState, player: PlayerState, reason: string) {
  pushEffect(state, 'swap', { cell: player.cell })
  log(state, `${player.name} ${reason}，回到出生点。`)
  player.cell = { ...player.spawn }
  pushEffect(state, 'spawn', { cell: player.cell })
}

export function finishPlayer(state: GameState, player: PlayerState) {
  if (player.finishedTurn) return
  player.finishedTurn = state.turnNumber
  pushEffect(state, 'spawn', { cell: player.cell })
  log(state, `${player.name} 抵达终点！回合到达：第 ${state.turnNumber} 回合。`)
  state.finished = true
  state.phase = 'finished'
}

export function knockback(state: GameState, target: PlayerState, dir: Dir, dist: number, reason: string) {
  if (reason) log(state, `${reason}，被击退 ${dist} 格。`)
  const delta = DIR_DELTA[dir]
  let current = { ...target.cell }
  for (let i = 0; i < dist; i++) {
    const next = { x: current.x + delta.x, y: current.y + delta.y }
    if (!inBoard(state, next) || blocksMove(state, next)) break
    const occupant = playerAt(state, next)
    if (occupant && occupant.id !== target.id) break
    current = next
    target.cell = { ...current }
    if (tileAt(state, current).kind === 'pit') {
      killPlayer(state, target, '被击进了坑洞')
      return
    }
    if (tileAt(state, current).kind === 'home') {
      target.spawn = { ...current }
    }
    if (tileAt(state, current).kind === 'goal') {
      finishPlayer(state, target)
      return
    }
  }
}

function fireRocketPath(state: GameState, from: Cell, dir: Dir, shooter: PlayerState) {
  const delta = DIR_DELTA[dir]
  let impact = { ...from }
  let target: PlayerState | undefined
  for (let i = 1; i <= 6; i++) {
    const cell = { x: from.x + delta.x * i, y: from.y + delta.y * i }
    if (!inBoard(state, cell) || blocksShot(state, cell)) {
      impact = { x: from.x + delta.x * (i - 1), y: from.y + delta.y * (i - 1) }
      break
    }
    impact = cell
    const occupant = playerAt(state, cell)
    if (occupant && occupant.id !== shooter.id) {
      target = occupant
      break
    }
  }
  pushEffect(state, 'projectile', { from, to: impact })
  pushEffect(state, 'explosion', { cell: impact })
  if (target) {
    log(state, `火箭命中 ${target.name}！`)
    knockback(state, target, dir, 2, `${target.name} 被火箭击飞`)
  }
  for (const other of state.players) {
    if (other.id === shooter.id || other.id === target?.id) continue
    const dx = other.cell.x - impact.x
    const dy = other.cell.y - impact.y
    if (Math.abs(dx) + Math.abs(dy) === 1) {
      const awayDir: Dir = dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up'
      knockback(state, other, awayDir, 1, `${other.name} 被爆炸波及`)
    }
  }
}

export function distanceToGoal(state: GameState, from: Cell): number {
  const goal = findGoal(state)
  const queue: Array<{ cell: Cell; dist: number }> = [{ cell: from, dist: 0 }]
  const seen = new Set([cellKey(from)])
  while (queue.length) {
    const current = queue.shift()!
    if (sameCell(current.cell, goal)) return current.dist
    for (const dir of DIRS) {
      const delta = DIR_DELTA[dir]
      const next = { x: current.cell.x + delta.x, y: current.cell.y + delta.y }
      const key = cellKey(next)
      if (!inBoard(state, next) || seen.has(key)) continue
      const kind = tileAt(state, next).kind
      if (TERRAINS[kind].blocksMove && kind !== 'earthwall') continue
      if (state.storm && sameCell(state.storm.cell, next)) continue
      seen.add(key)
      queue.push({ cell: next, dist: current.dist + 1 })
    }
  }
  return 999
}

export function canUseTool(state: GameState, instance: ToolInstance): boolean {
  const player = activePlayer(state)
  if (state.phase !== 'action' && state.phase !== 'turnEnd') return false
  if (state.pendingReward) return false
  switch (instance.toolId) {
    case 'sprint':
      return !!player.hand.find((t) => t.toolId === 'move')
    case 'balance':
      return (instance.points ?? 0) >= 1 && !!player.hand.find((t) => t.toolId === 'move')
    case 'swapGhost':
      return !!state.ghost
    case 'recallGhost':
      return !!state.ghost
    case 'bomb':
      return !state.bombs.some((b) => b.ownerId === player.id && sameCell(b.cell, player.cell))
    case 'copy':
      return !!state.lastUsedTool && state.lastUsedTool.playerId !== player.id
    default:
      return true
  }
}

export function consumeTool(state: GameState, player: PlayerState, uid: number, toolId: ToolInstance['toolId']) {
  player.hand = player.hand.filter((t) => t.uid !== uid)
  state.lastUsedTool = { playerId: player.id, toolId }
  if (characterById(player.characterId).id === 'chang') {
    player.hookLevel = Math.min(5, player.hookLevel + 1)
  }
}

export function playSimpleTool(state: GameState, uid: number) {
  const player = activePlayer(state)
  if (state.phase !== 'action' && state.phase !== 'turnEnd') return
  const instance = player.hand.find((t) => t.uid === uid)
  if (!instance || !canUseTool(state, instance)) return
  switch (instance.toolId) {
    case 'sprint': {
      const moveCard = player.hand.find((t) => t.toolId === 'move')!
      moveCard.points = (moveCard.points ?? 0) + 2
      state.dice.move = moveCard.points
      log(state, `${player.name} 使用冲刺，移动点数 +2。`)
      break
    }
    case 'bomb': {
      state.bombs.push({ id: entitySerial++, cell: { ...player.cell }, ownerId: player.id, plantedTurn: state.turnNumber })
      log(state, `${player.name} 在脚下布置了炸药，下回合开始时爆炸。`)
      break
    }
    case 'swapGhost': {
      if (!state.ghost) return
      pushEffect(state, 'swap', { cell: player.cell })
      const ghostCell = { ...state.ghost.cell }
      state.ghost.cell = { ...player.cell }
      player.cell = ghostCell
      pushEffect(state, 'swap', { cell: player.cell })
      log(state, `${player.name} 与小幽灵互换了位置。`)
      onStopCell(state, player, player.cell)
      break
    }
    case 'recallGhost': {
      if (!state.ghost) return
      const spot = DIRS.map((d) => DIR_DELTA[d])
        .map((delta) => ({ x: player.cell.x + delta.x, y: player.cell.y + delta.y }))
        .find((c) => inBoard(state, c) && !blocksMove(state, c) && !playerAt(state, c))
      if (spot) {
        state.ghost.cell = spot
        pushEffect(state, 'spawn', { cell: spot })
        log(state, `${player.name} 将小幽灵召唤到身旁。`)
      }
      break
    }
    case 'balance': {
      const moveCard = player.hand.find((t) => t.toolId === 'move')!
      const stored = Math.min(instance.points ?? 0, Math.floor((moveCard.points ?? 0) / 2))
      if (stored <= 0) return
      moveCard.points = (moveCard.points ?? 0) - stored
      player.savedMove += stored
      state.dice.move = moveCard.points
      log(state, `${player.name} 制衡储存了 ${stored} 点移动，下回合取回。`)
      break
    }
    case 'copy': {
      if (!state.lastUsedTool) return
      const copiedId = state.lastUsedTool.toolId
      const params: { points?: number; length?: number } = {}
      if (copiedId === 'hook') params.length = player.hookLevel
      grantTool(state, player, copiedId, params)
      log(state, `${player.name} 复制了【${TOOLS[copiedId].name}】。`)
      break
    }
    default:
      return
  }
  consumeTool(state, player, uid, instance.toolId)
}

export function playDirectionTool(state: GameState, uid: number, dir: Dir) {
  const player = activePlayer(state)
  if (state.phase !== 'action' && state.phase !== 'turnEnd') return
  const instance = player.hand.find((t) => t.uid === uid)
  if (!instance) return
  const delta = DIR_DELTA[dir]
  switch (instance.toolId) {
    case 'punch': {
      let hit = false
      for (let i = 1; i <= 2; i++) {
        const cell = { x: player.cell.x + delta.x * i, y: player.cell.y + delta.y * i }
        if (!inBoard(state, cell) || blocksShot(state, cell)) break
        const occupant = playerAt(state, cell)
        if (occupant && occupant.id !== player.id) {
          pushEffect(state, 'punch', { from: player.cell, to: cell })
          log(state, `${player.name} 的拳击命中了 ${occupant.name}！`)
          knockback(state, occupant, dir, 2, '')
          hit = true
          break
        }
      }
      if (!hit) {
        const wallCell = { x: player.cell.x + delta.x, y: player.cell.y + delta.y }
        if (!inBoard(state, wallCell) || blocksShot(state, wallCell)) {
          pushEffect(state, 'punch', { from: player.cell, to: wallCell })
          log(state, `${player.name} 一拳打在墙上，反被推了回来。`)
          knockback(state, player, opposite(dir), 1, '')
        }
      }
      break
    }
    case 'basketball': {
      let pos = { ...player.cell }
      let travel = dir
      let remaining = 4
      let bounced = false
      while (remaining > 0) {
        const next = { x: pos.x + DIR_DELTA[travel].x, y: pos.y + DIR_DELTA[travel].y }
        if (!inBoard(state, next) || blocksShot(state, next)) {
          if (bounced) break
          travel = opposite(travel)
          bounced = true
          continue
        }
        pos = next
        remaining--
        const occupant = playerAt(state, pos)
        if (occupant && occupant.id !== player.id) {
          pushEffect(state, 'projectile', { from: player.cell, to: pos })
          log(state, `${player.name} 的篮球砸中了 ${occupant.name}！`)
          knockback(state, occupant, travel, 2, '')
          break
        }
      }
      pushEffect(state, 'projectile', { from: player.cell, to: pos })
      break
    }
    case 'hook': {
      const length = instance.length ?? player.hookLevel
      for (let i = 1; i <= length; i++) {
        const cell = { x: player.cell.x + delta.x * i, y: player.cell.y + delta.y * i }
        if (!inBoard(state, cell)) break
        if (blocksShot(state, cell)) {
          const landing = { x: player.cell.x + delta.x * (i - 1), y: player.cell.y + delta.y * (i - 1) }
          if (i > 1) {
            pushEffect(state, 'projectile', { from: player.cell, to: cell })
            player.cell = landing
            log(state, `${player.name} 用钩锁把自己拉了过去。`)
            onStopCell(state, player, player.cell)
          }
          break
        }
        const occupant = playerAt(state, cell)
        if (occupant && occupant.id !== player.id) {
          const front = { x: player.cell.x + delta.x, y: player.cell.y + delta.y }
          if (inBoard(state, front) && !blocksMove(state, front) && !playerAt(state, front)) {
            pushEffect(state, 'projectile', { from: player.cell, to: cell })
            occupant.cell = front
            log(state, `${player.name} 用钩锁把 ${occupant.name} 拉到身前。`)
            onStopCell(state, occupant, occupant.cell)
          }
          break
        }
      }
      break
    }
    case 'rocket': {
      fireRocketPath(state, player.cell, dir, player)
      break
    }
    case 'tow': {
      // tow uses player targeting then direction; handled by UI in two steps
      break
    }
    default:
      return
  }
  consumeTool(state, player, uid, instance.toolId)
}

export function towCandidates(state: GameState): PlayerState[] {
  const player = activePlayer(state)
  return state.players.filter(
    (p) =>
      p.id !== player.id &&
      !p.finishedTurn &&
      Math.abs(p.cell.x - player.cell.x) + Math.abs(p.cell.y - player.cell.y) <= 3,
  )
}

export function playTow(state: GameState, uid: number, targetId: string, dir: Dir) {
  const player = activePlayer(state)
  if (state.phase !== 'action' && state.phase !== 'turnEnd') return
  const instance = player.hand.find((t) => t.uid === uid)
  const target = state.players.find((p) => p.id === targetId)
  if (!instance || !target) return
  log(state, `${player.name} 用牵引锁链拉动了 ${target.name}。`)
  knockback(state, target, dir, 2, '')
  consumeTool(state, player, uid, instance.toolId)
}

export function adjacentFreeCells(state: GameState, player: PlayerState): Cell[] {
  const cells: Cell[] = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      const cell = { x: player.cell.x + dx, y: player.cell.y + dy }
      if (inBoard(state, cell) && !blocksMove(state, cell) && !playerAt(state, cell) && !pigAt(state, cell) && !walletAt(state, cell)) {
        cells.push(cell)
      }
    }
  }
  return cells
}

export function playAdjacentTool(state: GameState, uid: number, target: Cell) {
  const player = activePlayer(state)
  if (state.phase !== 'action' && state.phase !== 'turnEnd') return
  const instance = player.hand.find((t) => t.uid === uid)
  if (!instance) return
  if (!adjacentFreeCells(state, player).some((c) => sameCell(c, target))) return
  if (instance.toolId === 'buildwall') {
    const tile = tileAt(state, target)
    tile.kind = 'earthwall'
    tile.durability = 2
    log(state, `${player.name} 砌起了一面土墙。`)
  } else if (instance.toolId === 'wallet') {
    state.wallets.push({ id: entitySerial++, cell: { ...target } })
    log(state, `${player.name} 放下了一个钱包。`)
  } else {
    return
  }
  consumeTool(state, player, uid, instance.toolId)
}

export function blinkCells(state: GameState, player: PlayerState): Cell[] {
  const cells: Cell[] = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue
      const cell = { x: player.cell.x + dx, y: player.cell.y + dy }
      if (inBoard(state, cell) && !blocksMove(state, cell) && !playerAt(state, cell)) cells.push(cell)
    }
  }
  return cells
}

export function teleportCells(state: GameState): Cell[] {
  const cells: Cell[] = []
  for (const row of state.tiles) {
    for (const tile of row) {
      const cell = { x: tile.x, y: tile.y }
      if (!TERRAINS[tile.kind].blocksMove && !playerAt(state, cell) && tile.kind !== 'pit') cells.push(cell)
    }
  }
  return cells
}

export function leapTargets(state: GameState, player: PlayerState, points: number): MoveTarget[] {
  const targets: MoveTarget[] = []
  for (const dir of DIRS) {
    const delta = DIR_DELTA[dir]
    for (let d = points; d >= 1; d--) {
      const land = { x: player.cell.x + delta.x * d, y: player.cell.y + delta.y * d }
      if (!inBoard(state, land)) continue
      if (TERRAINS[tileAt(state, land).kind].blocksLeap || blocksMove(state, land)) continue
      if (playerAt(state, land)) continue
      let blockedByHighwall = false
      for (let i = 1; i < d; i++) {
        const mid = { x: player.cell.x + delta.x * i, y: player.cell.y + delta.y * i }
        if (inBoard(state, mid) && TERRAINS[tileAt(state, mid).kind].blocksLeap) {
          blockedByHighwall = true
          break
        }
      }
      if (blockedByHighwall) continue
      targets.push({ dir, cells: [land] })
      break
    }
  }
  return targets
}

export function playLeapTool(state: GameState, uid: number, dir: Dir) {
  const player = activePlayer(state)
  if (state.phase !== 'action' && state.phase !== 'turnEnd') return
  const instance = player.hand.find((t) => t.uid === uid)
  if (!instance) return
  const target = leapTargets(state, player, instance.points ?? 0).find((t) => t.dir === dir)
  if (!target) return
  pushEffect(state, 'swap', { cell: player.cell })
  player.cell = { ...target.cells[0] }
  pushEffect(state, 'spawn', { cell: player.cell })
  log(state, `${player.name} 飞跃而过，落在了 ${instance.points} 格之外。`)
  onStopCell(state, player, player.cell)
  consumeTool(state, player, uid, instance.toolId)
}

export function playBlinkTool(state: GameState, uid: number, target: Cell) {
  const player = activePlayer(state)
  if (state.phase !== 'action' && state.phase !== 'turnEnd') return
  const instance = player.hand.find((t) => t.uid === uid)
  if (!instance) return
  if (!blinkCells(state, player).some((c) => sameCell(c, target))) return
  pushEffect(state, 'swap', { cell: player.cell })
  player.cell = { ...target }
  pushEffect(state, 'spawn', { cell: player.cell })
  log(state, `${player.name} 瞬步一闪。`)
  onStopCell(state, player, player.cell)
  consumeTool(state, player, uid, instance.toolId)
}

export function playTeleportTool(state: GameState, uid: number, target: Cell) {
  const player = activePlayer(state)
  if (state.phase !== 'action' && state.phase !== 'turnEnd') return
  const instance = player.hand.find((t) => t.uid === uid)
  if (!instance) return
  if (!teleportCells(state).some((c) => sameCell(c, target))) return
  pushEffect(state, 'swap', { cell: player.cell })
  player.cell = { ...target }
  pushEffect(state, 'spawn', { cell: player.cell })
  log(state, `${player.name} 瞬移到了棋盘的另一角。`)
  onStopCell(state, player, player.cell)
  consumeTool(state, player, uid, instance.toolId)
}

export function timeoutTurn(state: GameState) {
  if (state.finished) return
  if (state.pendingReward) {
    chooseReward(state, 0)
  }
  if (state.phase === 'turnStart') {
    playRollCard(state)
  }
  if (state.phase === 'action' || state.phase === 'turnEnd' || state.phase === 'reward') {
    nextTurn(state)
  }
}

export function settlementRanking(state: GameState): Array<{ player: PlayerState; note: string }> {
  const rows = state.players.map((player) => ({
    player,
    note: player.finishedTurn ? `回合到达：第 ${player.finishedTurn} 回合` : `未完赛 · 距终点 ${distanceToGoal(state, player.cell)} 格`,
  }))
  rows.sort((a, b) => {
    if (a.player.finishedTurn && b.player.finishedTurn) return a.player.finishedTurn - b.player.finishedTurn
    if (a.player.finishedTurn) return -1
    if (b.player.finishedTurn) return 1
    return distanceToGoal(state, a.player.cell) - distanceToGoal(state, b.player.cell)
  })
  return rows
}
