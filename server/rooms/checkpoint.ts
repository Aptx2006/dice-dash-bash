import type { GameState, GameConfig } from '../../src/game/types.ts'
import type { RoomMember, RoomPresentation, RoomView } from '../../src/network/types.ts'
import { CHARACTERS, AI_CHARACTER } from '../../src/game/characters.ts'
import { MAPS } from '../../src/game/maps.ts'
import { validateNickname } from '../../src/game/configValidation.ts'
import { validateGameSnapshot } from '../../src/storage/savedMatch.ts'
import { TOOLS } from '../../src/game/tools.ts'

export interface MemberCheckpoint extends Omit<RoomMember, 'connected'> {
  human: boolean
  departed: boolean
  tokenHash: string
  acknowledgements: [string, string][]
}
export interface RoomCheckpoint {
  formatVersion: 1
  rulesVersion: 'engine-v1'
  savedAt: number
  id: string
  hostId: string
  revision: number
  broadcastId: number
  config: Omit<GameConfig, 'players'>
  status: RoomView['status']
  game?: GameState
  gameId?: string
  randomState: number
  randomSecret: string
  createdAt: number
  updatedAt: number
  remainingMs: number | null
  holdMs: number | null
  nextAiMs: number
  eventId: number
  presentation?: RoomPresentation
  inFlightAttempt: boolean
  members: MemberCheckpoint[]
}
function ensure(value: unknown): asserts value { if (!value) throw new Error('房间存档损坏或版本不兼容，原文件已保留。') }
const obj = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v)
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
const ms = (v: unknown) => v === null || integer(v, 0, 120000)

export function readRoomCheckpoint(raw: string): RoomCheckpoint {
  ensure(raw.length <= 2_000_000)
  let c: any
  try { c = JSON.parse(raw) } catch { ensure(false) }
  ensure(obj(c) && c.formatVersion === 1 && c.rulesVersion === 'engine-v1')
  ensure(/^\d{6}$/.test(c.id) && typeof c.hostId === 'string' && integer(c.revision, 1) && integer(c.broadcastId))
  ensure(integer(c.savedAt, 1) && integer(c.createdAt, 1) && integer(c.updatedAt, c.createdAt, c.savedAt))
  ensure(integer(c.randomState) && /^[A-Za-z0-9_-]{43}$/.test(c.randomSecret))
  ensure(ms(c.remainingMs) && ms(c.holdMs) && integer(c.nextAiMs, 0, 120000) && integer(c.eventId))
  ensure(typeof c.inFlightAttempt === 'boolean' && ['lobby', 'playing', 'finished'].includes(c.status))
  ensure(obj(c.config) && MAPS.some(map => map.id === c.config.mapId) && ['rules', 'cloud'].includes(c.config.aiMode))
  ensure(obj(c.config.mechanisms) && typeof c.config.mechanisms.airdrop === 'boolean' && typeof c.config.mechanisms.turnTimer === 'boolean')
  ensure(Array.isArray(c.members) && c.members.length >= 1 && c.members.length <= 8)
  const ids = new Set<string>(), hashes = new Set<string>(), colors = new Set<string>()
  for (const m of c.members) {
    ensure(obj(m) && typeof m.id === 'string' && /^[a-f0-9-]{36}$/.test(m.id) && !ids.has(m.id)); ids.add(m.id)
    ensure(validateNickname(m.name) === m.name && [...CHARACTERS, AI_CHARACTER].some(character => character.id === m.characterId))
    ensure(/^#[a-f0-9]{6}$/i.test(m.pieceColor) && !colors.has(m.pieceColor)); colors.add(m.pieceColor)
    for (const key of ['human', 'departed', 'isAI', 'takeover', 'ready']) ensure(typeof m[key] === 'boolean')
    ensure(m.human ? /^[a-f0-9]{64}$/.test(m.tokenHash) && !hashes.has(m.tokenHash) : m.tokenHash === '' && m.isAI)
    if (m.human) hashes.add(m.tokenHash)
    ensure(!m.takeover || (m.human && m.isAI))
    ensure(m.isAI === (!m.human || m.takeover) && (!m.departed || m.human))
    ensure(Array.isArray(m.acknowledgements) && m.acknowledgements.length <= 128)
    const acknowledgements = new Set<string>()
    for (const pair of m.acknowledgements) {
      ensure(Array.isArray(pair) && pair.length === 2 && /^[A-Za-z0-9-]{8,100}$/.test(pair[0]) && !acknowledgements.has(pair[0]))
      ensure(typeof pair[1] === 'string' && pair[1].length <= 4096); acknowledgements.add(pair[0])
    }
  }
  ensure(ids.has(c.hostId) && c.members.some((m: any) => m.id === c.hostId && m.human && !m.departed))
  if (c.status === 'lobby') ensure(c.game === undefined && c.gameId === undefined && c.remainingMs === null)
  else {
    ensure(typeof c.gameId === 'string' && /^[a-f0-9-]{36}$/.test(c.gameId) && c.members.length >= 2)
    const config: GameConfig = { ...(c.config as RoomCheckpoint['config']), players: c.members.map((m: any) => ({ name: m.name, characterId: m.characterId,
      pieceColor: m.pieceColor, isAI: m.isAI, isHost: m.id === c.hostId })) }
    validateGameSnapshot(config, c.game, true)
    ensure(c.game.finished === (c.status === 'finished'))
    c.members.forEach((m: any, index: number) => ensure(m.gamePlayerId === c.game.players[index].id))
  }
  if (c.presentation !== undefined) {
    const p = c.presentation
    ensure(obj(p) && integer(p.id, 1, c.eventId) && typeof p.actorName === 'string' && typeof p.actorId === 'string')
    ensure(['turnStart', 'action', 'turnEnd', 'reward', 'finished'].includes(p.phaseBefore))
    if (p.card !== undefined) ensure(obj(p.card) && integer(p.card.uid, 1) && Object.hasOwn(TOOLS, p.card.toolId))
    if (p.dice !== undefined) ensure(obj(p.dice) && integer(p.dice.move, 0, 1_000_000_000) && typeof p.dice.toolName === 'string')
  }
  return c as RoomCheckpoint
}
