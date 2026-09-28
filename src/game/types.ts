export type Dir = 'up' | 'right' | 'down' | 'left'

export interface Cell {
  x: number
  y: number
}

export type TerrainKind =
  | 'floor'
  | 'wall'
  | 'highwall'
  | 'earthwall'
  | 'pit'
  | 'poison'
  | 'conveyor'
  | 'cannon'
  | 'lucky'
  | 'home'
  | 'start'
  | 'goal'
  | 'punchball'

export interface Tile {
  x: number
  y: number
  kind: TerrainKind
  dir?: Dir
  durability?: number
}

export type Phase = 'turnStart' | 'roll' | 'action' | 'turnEnd' | 'reward' | 'finished'

export type ToolId =
  | 'roll'
  | 'move'
  | 'end'
  | 'sprint'
  | 'punch'
  | 'basketball'
  | 'hook'
  | 'buildwall'
  | 'bomb'
  | 'rocket'
  | 'teleport'
  | 'blink'
  | 'tow'
  | 'swapGhost'
  | 'recallGhost'
  | 'wallet'
  | 'balance'
  | 'leap'
  | 'copy'
  | 'storm'
  | 'prepareTow'

export interface ToolInstance {
  uid: number
  toolId: ToolId
  points?: number
  length?: number
  /** 系统每阶段发放的卡：进入新阶段或新回合时自动作废 */
  system?: boolean
}

export interface PlayerState {
  id: string
  name: string
  isAI: boolean
  characterId: string
  pieceColor: string
  ready: boolean
  isHost: boolean
  cell: Cell
  spawn: Cell
  finishedTurn?: number
  hookLevel: number
  savedMove: number
  hand: ToolInstance[]
}

export interface BombEntity {
  id: number
  cell: Cell
  ownerId: string
  plantedTurn: number
}

export interface PigEntity {
  id: number
  cell: Cell
}

export interface WalletEntity {
  id: number
  cell: Cell
}

export interface GhostEntity {
  cell: Cell
}

export interface StormEntity {
  id: number
  cell: Cell
  remainingTurns: number
}

export interface EffectEvent {
  id: number
  kind: 'explosion' | 'projectile' | 'punch' | 'swap' | 'airdrop' | 'spawn'
  from?: Cell
  to?: Cell
  cell?: Cell
}

export interface LogEntry {
  id: number
  text: string
}

export interface GamePlayerConfig {
  name: string
  isAI: boolean
  characterId: string
  pieceColor: string
  isHost: boolean
}

export interface GameConfig {
  mapId: string
  players: GamePlayerConfig[]
  mechanisms: { airdrop: boolean; turnTimer: boolean }
}

export interface GameState {
  mapId: string
  mapLabel: string
  width: number
  height: number
  tiles: Tile[][]
  players: PlayerState[]
  activeIndex: number
  turnNumber: number
  phase: Phase
  dice: { move: number | null; toolName: string | null }
  bombs: BombEntity[]
  pigs: PigEntity[]
  wallets: WalletEntity[]
  ghost?: GhostEntity
  storm?: StormEntity
  effects: EffectEvent[]
  pendingReward?: { playerId: string; options: ToolInstance[]; reason: string }
  lastUsedTool?: { playerId: string; toolId: ToolId }
  logs: LogEntry[]
  mechanisms: { airdrop: boolean; turnTimer: boolean }
  finished: boolean
}

export const DIRS: Dir[] = ['up', 'right', 'down', 'left']

export const DIR_DELTA: Record<Dir, Cell> = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

export const DIR_LABEL: Record<Dir, string> = {
  up: '上',
  right: '右',
  down: '下',
  left: '左',
}

export const cellKey = (cell: Cell) => `${cell.x},${cell.y}`
export const sameCell = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y
