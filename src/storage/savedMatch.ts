import type { GameConfig, GameState } from '../game/types.ts'
import { validateGameConfig } from '../game/configValidation.ts'
import { mapById, parseMap } from '../game/maps.ts'
import { TOOLS } from '../game/tools.ts'
import { TERRAINS } from '../game/terrains.ts'

export const MATCH_STORAGE_KEY = 'dice-saved-match'
const RULES_VERSION = 'local-v1'
type GetStore = () => Pick<Storage, 'getItem' | 'setItem'>
const browserStore: GetStore = () => window.localStorage

export interface MatchInput {
  config: GameConfig
  state: GameState
  roomCode: string
  tutorialStep: number
  timeLeft: number
}
export interface SavedMatch extends MatchInput {
  formatVersion: 1
  rulesVersion: string
  savedAt: number
}

function ensure(condition: unknown): asserts condition {
  if (!condition) throw new Error('存档内容不完整或已损坏，无法继续；你仍可开始新对局。')
}
function object(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function integer(value: unknown, min = 0, max = 1_000_000_000): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
}
function text(value: unknown, max = 300): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}
function list(value: unknown, max: number): unknown[] {
  ensure(Array.isArray(value) && value.length <= max)
  return value
}

/** 存档也是外部输入；验证嵌套数据后才允许规则和渲染模块读取。 */
function decodeMatch(raw: string): SavedMatch {
  ensure(raw.length <= 2_000_000)
  const saved = object(JSON.parse(raw))
  if (saved.formatVersion !== 1 || saved.rulesVersion !== RULES_VERSION) {
    throw new Error('这份存档与当前游戏版本不兼容，请开始新对局。')
  }
  ensure(typeof saved.savedAt === 'number' && Number.isSafeInteger(saved.savedAt) && saved.savedAt > 0)
  ensure(text(saved.roomCode, 12) && /^[A-Z0-9-]+$/.test(saved.roomCode))
  ensure(integer(saved.tutorialStep, -1, 7) && integer(saved.timeLeft, 0, 75))
  const config = object(saved.config) as unknown as GameConfig
  validateGameConfig(config)
  ensure(config.mapId === 'tutorial' ? (saved.tutorialStep as number) >= 0 : saved.tutorialStep === -1)
  // 当前客户端只提供一个真人席位，其余席位由规则机器人驱动。
  ensure(!config.players[0].isAI && config.players.slice(1).every(p => p.isAI))
  const s = object(saved.state)
  const map = mapById(config.mapId)
  const { width, height } = parseMap(map)
  ensure(s.mapId === config.mapId && s.mapLabel === map.label && s.width === width && s.height === height)
  ensure(integer(s.turnNumber, 1) && integer(s.activeIndex, 0, config.players.length - 1))
  ensure(['turnStart', 'action', 'turnEnd', 'reward', 'finished'].includes(String(s.phase)))
  ensure(typeof s.finished === 'boolean' && s.finished === (s.phase === 'finished'))
  const mechanisms = object(s.mechanisms)
  ensure(mechanisms.airdrop === config.mechanisms.airdrop && mechanisms.turnTimer === config.mechanisms.turnTimer)
  const cell = (value: unknown) => {
    const c = object(value)
    ensure(integer(c.x, 0, width - 1) && integer(c.y, 0, height - 1))
  }
  const seenCards = new Set<number>()
  const card = (value: unknown) => {
    const c = object(value)
    ensure(integer(c.uid, 1) && !seenCards.has(c.uid))
    seenCards.add(c.uid)
    ensure(typeof c.toolId === 'string' && Object.hasOwn(TOOLS, c.toolId))
    if (c.points !== undefined) ensure(integer(c.points))
    if (c.length !== undefined) ensure(integer(c.length, 1, 5))
    if (c.system !== undefined) ensure(typeof c.system === 'boolean')
    if (c.toolId === 'move') ensure(integer(c.points))
  }
  const players = list(s.players, 8)
  ensure(players.length === config.players.length)
  players.forEach((value, index) => {
    const p = object(value), expected = config.players[index]
    ensure(p.id === (index === 0 ? 'human' : `ai-${index}`))
    ensure(p.name === expected.name.trim())
    for (const key of ['isAI', 'characterId', 'pieceColor', 'isHost'] as const) ensure(p[key] === expected[key])
    ensure(typeof p.ready === 'boolean' && integer(p.hookLevel, 1, 5) && integer(p.savedMove))
    if (p.finishedTurn !== undefined) ensure(integer(p.finishedTurn, 1, s.turnNumber as number) && s.finished)
    cell(p.cell); cell(p.spawn)
    list(p.hand, 10000).forEach(card)
  })
  const tiles = list(s.tiles, height)
  ensure(tiles.length === height)
  let goals = 0, starts = 0
  tiles.forEach((row, y) => {
    const entries = list(row, width);ensure(entries.length === width)
    entries.forEach((value, x) => {
      const t = object(value)
      ensure(t.x === x && t.y === y && typeof t.kind === 'string' && Object.hasOwn(TERRAINS, t.kind))
      if (t.dir !== undefined) ensure(['up', 'right', 'down', 'left'].includes(String(t.dir)))
      if (t.kind === 'conveyor' || t.kind === 'cannon') ensure(t.dir !== undefined)
      if (t.durability !== undefined) ensure(integer(t.durability, 0, 2))
      if (t.kind === 'goal') goals++
      if (t.kind === 'start') starts++
    })
  })
  ensure(goals === 1 && starts === 1)
  const dice = object(s.dice)
  ensure(dice.move === null || integer(dice.move))
  ensure(dice.toolName === null || text(dice.toolName, 30))
  const playerIds = new Set(players.map(p => object(p).id))
  const entityIds = new Set<number>()
  const entity = (value: unknown) => {
    const e = object(value)
    ensure(integer(e.id, 1) && !entityIds.has(e.id));entityIds.add(e.id);cell(e.cell)
    return e
  }
  list(s.pigs, width * height).forEach(entity)
  list(s.wallets, 10000).forEach(entity)
  list(s.bombs, 10000).forEach(value => {
    const b = entity(value)
    ensure(playerIds.has(b.ownerId) && integer(b.plantedTurn, 1, s.turnNumber as number))
  })
  if (s.ghost !== undefined) cell(object(s.ghost).cell)
  if (s.storm !== undefined) ensure(integer(entity(s.storm).remainingTurns, 1, 10))
  for (const [key, max] of [['logs', 40], ['effects', 30]] as const) {
    const ids = new Set<number>()
    list(s[key], max).forEach(value => {
      const e = object(value);ensure(integer(e.id, 1) && !ids.has(e.id));ids.add(e.id)
      if (key === 'logs') ensure(text(e.text, 1000))
      else {
        ensure(['explosion', 'projectile', 'punch', 'swap', 'airdrop', 'spawn'].includes(String(e.kind)))
        for (const pos of ['from', 'to', 'cell']) if (e[pos] !== undefined) cell(e[pos])
      }
    })
  }
  if (s.pendingReward !== undefined) {
    const r = object(s.pendingReward), options = list(r.options, 3)
    ensure(options.length > 0 && r.playerId === object(players[s.activeIndex as number]).id && text(r.reason))
    ensure(s.phase === 'reward' || s.finished)
    options.forEach(card)
  } else ensure(s.phase !== 'reward')
  if (s.lastUsedTool !== undefined) {
    const last = object(s.lastUsedTool)
    ensure(playerIds.has(last.playerId) && typeof last.toolId === 'string' && Object.hasOwn(TOOLS, last.toolId))
  }
  if (s.finished) ensure(players.some(p => object(p).finishedTurn !== undefined))
  // JSON反序列化得到独立数据，调用者修改对局不会修改首页的存档摘要。
  return saved as unknown as SavedMatch
}

export function loadMatch(getStore: GetStore = browserStore): { match: SavedMatch | null; warning: string } {
  let raw: string | null
  try { raw = getStore().getItem(MATCH_STORAGE_KEY) }
  catch { return { match: null, warning: '浏览器无法读取对局存档，你仍可开始新对局。' } }
  if (raw === null) return { match: null, warning: '' }
  try { return { match: decodeMatch(raw), warning: '' } }
  catch (error) { return { match: null, warning: error instanceof SyntaxError ? '对局存档已损坏，无法继续；你仍可开始新对局。' : error instanceof Error ? error.message : '无法恢复对局。' } }
}

export function saveMatch(input: MatchInput, getStore: GetStore = browserStore, savedAt = Date.now()): { match: SavedMatch | null; warning: string } {
  try {
    const raw = JSON.stringify({ ...input, formatVersion: 1, rulesVersion: RULES_VERSION, savedAt })
    const match = decodeMatch(raw)
    // 单次setItem为原子替换；校验或容量错误时不清除旧存档。
    getStore().setItem(MATCH_STORAGE_KEY, raw)
    return { match, warning: '' }
  } catch {
    return { match: null, warning: '本局未能保存，当前游戏可继续；请勿刷新或关闭页面。' }
  }
}
