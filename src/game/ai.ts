import type { Cell, Dir, GameState, PlayerState, ToolInstance } from './types.ts'
import { DIRS } from './types.ts'
import {
  activePlayer,
  adjacentFreeCells,
  blinkCells,
  canUseTool,
  chooseReward,
  distanceToGoal,
  playAdjacentTool,
  playBlinkTool,
  playDirectionTool,
  playEndCard,
  playRollCard,
  playSimpleTool,
  playTeleportTool,
  playTow,
  resolveMoveCard,
  teleportCells,
  towCandidates,
} from './engine.ts'
import { TOOLS } from './tools.ts'

function clone(state: GameState): GameState {
  // 推演不需要历史日志和视觉特效，排除它们可避免长对局中反复复制无关数据。
  return JSON.parse(JSON.stringify({ ...state, logs: [], effects: [] })) as GameState
}

function scorePosition(state: GameState, player: PlayerState): number {
  if (player.finishedTurn) return -1000
  return distanceToGoal(state, player.cell)
}

function bestMoveDir(state: GameState): { dir: Dir; score: number } | null {
  const player = activePlayer(state)
  const moveCard = player.hand.find((t) => t.toolId === 'move')
  if (!moveCard) return null
  let best: { dir: Dir; score: number } | null = null
  for (const dir of DIRS) {
    const sim = clone(state)
    const simPlayer = activePlayer(sim)
    const before = sim.pigs.length + sim.wallets.length
    resolveMoveCard(sim, dir)
    let score = scorePosition(sim, simPlayer)
    const after = sim.pigs.length + sim.wallets.length
    if (after < before) score -= 1.5
    if (!best || score < best.score) best = { dir, score }
  }
  return best
}

function toolScore(toolId: ToolInstance['toolId']): number {
  switch (toolId) {
    case 'sprint':
      return 90
    case 'teleport':
      return 70
    case 'hook':
      return 60
    case 'blink':
      return 50
    case 'punch':
      return 40
    case 'basketball':
      return 35
    case 'rocket':
      return 30
    case 'bomb':
      return 25
    case 'tow':
      return 20
    case 'balance':
      return 15
    default:
      return 0
  }
}

function tryPlayDirectionTool(state: GameState, instance: ToolInstance): boolean {
  const player = activePlayer(state)
  const current = scorePosition(state, player)
  let best: { dir: Dir; score: number } | null = null
  for (const dir of DIRS) {
    const sim = clone(state)
    playDirectionTool(sim, instance.uid, dir)
    const score = scorePosition(sim, activePlayer(sim))
    const opponentsAdvanced = sim.players
      .filter((p) => p.id !== player.id)
      .reduce((sum, p) => sum + distanceToGoal(sim, p.cell), 0)
    const combined = score - opponentsAdvanced * 0.35
    if (!best || combined < best.score) best = { dir, score: combined }
  }
  if (best && best.score < current - 0.4) {
    playDirectionTool(state, instance.uid, best.dir)
    return true
  }
  return false
}

function tryPlayTeleport(state: GameState, instance: ToolInstance): boolean {
  const player = activePlayer(state)
  const current = distanceToGoal(state, player.cell)
  let best: Cell | null = null
  let bestDist = current
  for (const cell of teleportCells(state)) {
    const dist = distanceToGoal(state, cell)
    if (dist < bestDist) {
      bestDist = dist
      best = cell
    }
  }
  if (best && current - bestDist >= 4) {
    playTeleportTool(state, instance.uid, best)
    return true
  }
  return false
}

function tryPlayBlink(state: GameState, instance: ToolInstance): boolean {
  const player = activePlayer(state)
  const current = distanceToGoal(state, player.cell)
  let best: Cell | null = null
  let bestDist = current
  for (const cell of blinkCells(state, player)) {
    const dist = distanceToGoal(state, cell)
    if (dist < bestDist) {
      bestDist = dist
      best = cell
    }
  }
  if (best) {
    playBlinkTool(state, instance.uid, best)
    return true
  }
  return false
}

function tryPlayTow(state: GameState, instance: ToolInstance): boolean {
  const player = activePlayer(state)
  const candidates = towCandidates(state)
  if (!candidates.length) return false
  const target = candidates.reduce((a, b) =>
    distanceToGoal(state, a.cell) <= distanceToGoal(state, b.cell) ? a : b,
  )
  let best: { dir: Dir; score: number } | null = null
  for (const dir of DIRS) {
    const sim = clone(state)
    playTow(sim, instance.uid, target.id, dir)
    const score = distanceToGoal(sim, target.cell)
    if (!best || score > best.score) best = { dir, score }
  }
  if (best && best.score > distanceToGoal(state, target.cell)) {
    playTow(state, instance.uid, target.id, best.dir)
    return true
  }
  return false
}

function tryPlayBombOrWall(state: GameState, instance: ToolInstance): boolean {
  const player = activePlayer(state)
  if (instance.toolId === 'bomb') {
    const nearOpponent = state.players.some(
      (p) => p.id !== player.id && Math.abs(p.cell.x - player.cell.x) + Math.abs(p.cell.y - player.cell.y) <= 2,
    )
    if (nearOpponent) {
      playSimpleTool(state, instance.uid)
      return true
    }
    return false
  }
  if (instance.toolId === 'buildwall' || instance.toolId === 'wallet') {
    const cells = adjacentFreeCells(state, player)
    if (cells.length) {
      playAdjacentTool(state, instance.uid, cells[Math.floor(Math.random() * cells.length)])
      return true
    }
  }
  return false
}

export function aiStep(state: GameState): boolean {
  if (state.finished) return false
  const player = activePlayer(state)
  if (!player.isAI) return false

  // 避免 AI 连续保留无法用出的库存，导致手牌与推演成本无限增长。
  const systemCards = player.hand.filter((card) => card.system)
  const inventory = player.hand.filter((card) => !card.system)
  if (inventory.length > 10) {
    const ranked = inventory
      .map((card, index) => ({ card, index, score: card.toolId === 'move' ? 100 : toolScore(card.toolId) }))
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, 10)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.card)
    player.hand = [...ranked, ...systemCards]
  }

  if (state.pendingReward) {
    if (state.pendingReward.playerId === player.id) {
      let bestIndex = 0
      let bestScore = -1
      state.pendingReward.options.forEach((option, index) => {
        const score = toolScore(option.toolId)
        if (score > bestScore) {
          bestScore = score
          bestIndex = index
        }
      })
      chooseReward(state, bestIndex)
      return true
    }
    return false
  }

  if (state.phase === 'turnStart') {
    if (player.hand.some((t) => t.toolId === 'roll')) {
      playRollCard(state)
      return true
    }
    playEndCard(state)
    return true
  }

  if (state.phase === 'action') {
    const moveCard = player.hand.find((t) => t.toolId === 'move')
    const tools = player.hand.filter((t) => !['move', 'end', 'roll'].includes(t.toolId))
    tools.sort((a, b) => toolScore(b.toolId) - toolScore(a.toolId))

    for (const instance of tools) {
      if (!canUseTool(state, instance)) continue
      switch (instance.toolId) {
        case 'sprint':
          if (moveCard && (moveCard.points ?? 0) >= 1) {
            playSimpleTool(state, instance.uid)
            return true
          }
          break
        case 'teleport':
          if (tryPlayTeleport(state, instance)) return true
          break
        case 'blink':
          if (tryPlayBlink(state, instance)) return true
          break
        case 'hook':
          if (tryPlayDirectionTool(state, instance)) return true
          break
        case 'punch':
        case 'basketball':
        case 'rocket':
          if (tryPlayDirectionTool(state, instance)) return true
          break
        case 'tow':
          if (tryPlayTow(state, instance)) return true
          break
        case 'bomb':
        case 'buildwall':
          if (tryPlayBombOrWall(state, instance)) return true
          break
        case 'balance': {
          const mc = player.hand.find((t) => t.toolId === 'move')
          if (mc && (mc.points ?? 0) >= 4) {
            playSimpleTool(state, instance.uid)
            return true
          }
          break
        }
        default:
          break
      }
    }

    if (moveCard) {
      const best = bestMoveDir(state)
      if (best) {
        const current = distanceToGoal(state, player.cell)
        if (best.score < current) {
          resolveMoveCard(state, best.dir)
          return true
        }
      }
    }

    playEndCard(state)
    return true
  }

  if (state.phase === 'turnEnd') {
    for (const instance of player.hand.filter((t) => t.toolId !== 'end')) {
      if (!canUseTool(state, instance)) continue
      if (instance.toolId === 'wallet' || instance.toolId === 'buildwall') {
        if (tryPlayBombOrWall(state, instance)) return true
      }
      if (instance.toolId === 'bomb') {
        if (tryPlayBombOrWall(state, instance)) return true
      }
    }
    playEndCard(state)
    return true
  }

  return false
}

export function aiToolName(toolId: ToolInstance['toolId']): string {
  return TOOLS[toolId].name
}
