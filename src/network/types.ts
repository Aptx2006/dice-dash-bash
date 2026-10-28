import type { Cell, Dir, GameConfig, GameState, ToolInstance } from '../game/types.ts'
import type { TacticalRunResult } from '../agent/types.ts'

export interface RoomMember {
  id: string
  name: string
  characterId: string
  pieceColor: string
  isAI: boolean
  ready: boolean
  connected: boolean
  takeover: boolean
  gamePlayerId?: string
}
export interface RoomPresentation {
  id: number
  actorId: string
  actorName: string
  phaseBefore: GameState['phase']
  card?: ToolInstance
  dice?: { move: number; toolName: string }
}
export interface RoomView {
  id: string
  revision: number
  syncId: number
  hostId: string
  selfId: string
  members: RoomMember[]
  config: Omit<GameConfig, 'players'>
  status: 'lobby' | 'playing' | 'finished'
  gameId?: string
  game?: GameState
  deadlineAt: number | null
  timerHoldUntil: number | null
  serverNow: number
  presentation?: RoomPresentation
  thinkingPlayerName: string
  pauseReason: string
}
export interface RoomSession { roomId: string; token: string }
export type RoomCommand =
  | { type: 'ready'; ready: boolean }
  | { type: 'character'; characterId: string; pieceColor?: string; memberId?: string }
  | { type: 'configure'; mapId?: string; airdrop?: boolean; turnTimer?: boolean; aiMode?: 'rules' | 'cloud' }
  | { type: 'add_ai' }
  | { type: 'remove'; memberId: string }
  | { type: 'start' }
  | { type: 'rematch' }
  | { type: 'leave' }
  | { type: 'card'; uid: number; dir?: Dir; target?: Cell; targetId?: string; stopAfter?: number }
  | { type: 'reward'; index: number }
  | { type: 'tactical'; actionId: string }

/** 界面仅发出命令，不在客户端结算联机规则。 */
export interface RemoteGameControls {
  roomId: string
  isHost: boolean
  connected: boolean
  busy: boolean
  revision: number
  deadlineAt: number | null
  timerHoldUntil: number | null
  serverOffsetMs: number
  thinkingPlayerName: string
  pauseReason: string
  presentation?: RoomPresentation
  submit: (command: RoomCommand) => Promise<boolean>
  suggest: (goal: string, signal: AbortSignal) => Promise<TacticalRunResult>
  applySuggestion: (actionId: string) => Promise<boolean>
}
