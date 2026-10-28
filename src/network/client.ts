import type { RoomCommand, RoomSession, RoomView } from './types.ts'
import type { TacticalRunResult } from '../agent/types.ts'
import { TOOLS } from '../game/tools.ts'
import { TERRAINS } from '../game/terrains.ts'

const SESSION_KEY = 'dice-online-session-v1'
export class RoomRequestError extends Error {
  code: string; status: number
  constructor(code: string, message: string, status = 0) { super(message); this.code = code; this.status = status }
}
const record = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown, min = 0, max = 1_000_000_000): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
function ensure(value: unknown): asserts value { if (!value) throw new RoomRequestError('INVALID_RESPONSE', '房间数据无法识别，请重新连接。') }
export function readRoomView(value: unknown): RoomView {
  ensure(record(value) && /^\d{6}$/.test(value.id) && integer(value.revision, 1) && integer(value.syncId) && typeof value.hostId === 'string' && typeof value.selfId === 'string')
  ensure(['lobby', 'playing', 'finished'].includes(value.status) && record(value.config) && record(value.config.mechanisms))
  ensure(typeof value.config.mapId === 'string' && typeof value.config.mechanisms.airdrop === 'boolean' && typeof value.config.mechanisms.turnTimer === 'boolean')
  ensure(['rules', 'cloud'].includes(value.config.aiMode) && typeof value.serverNow === 'number' && Number.isFinite(value.serverNow))
  ensure(value.deadlineAt === null || (typeof value.deadlineAt === 'number' && Number.isFinite(value.deadlineAt)))
  ensure(value.timerHoldUntil === null || (typeof value.timerHoldUntil === 'number' && Number.isFinite(value.timerHoldUntil)))
  ensure(typeof value.thinkingPlayerName === 'string' && value.thinkingPlayerName.length <= 30)
  ensure(Array.isArray(value.members) && value.members.length >= 1 && value.members.length <= 8)
  const ids = new Set<string>()
  for (const member of value.members) {
    ensure(record(member) && typeof member.id === 'string' && !ids.has(member.id) && member.id.length <= 80); ids.add(member.id)
    ensure(typeof member.name === 'string' && member.name.length <= 30 && typeof member.characterId === 'string' && /^#[0-9a-f]{6}$/i.test(member.pieceColor))
    for (const key of ['isAI', 'ready', 'connected', 'takeover']) ensure(typeof member[key] === 'boolean')
  }
  ensure(ids.has(value.selfId) && ids.has(value.hostId))
  if (value.presentation !== undefined) {
    const event = value.presentation
    ensure(record(event) && integer(event.id, 1) && typeof event.actorId === 'string' && typeof event.actorName === 'string')
    ensure(['turnStart', 'action', 'turnEnd', 'reward', 'finished'].includes(event.phaseBefore))
    if (event.card !== undefined) ensure(record(event.card) && integer(event.card.uid, 1) && Object.hasOwn(TOOLS, event.card.toolId))
    if (event.dice !== undefined) ensure(record(event.dice) && integer(event.dice.move, 0, 1000) && typeof event.dice.toolName === 'string' && event.dice.toolName.length <= 80)
  }
  if (value.status !== 'lobby') {
    const game = value.game
    ensure(record(game) && integer(game.width, 1, 32) && integer(game.height, 1, 32) && Array.isArray(game.tiles) && game.tiles.length === game.height)
    ensure(Array.isArray(game.players) && game.players.length === value.members.length && integer(game.activeIndex, 0, game.players.length - 1))
    ensure(['turnStart', 'action', 'turnEnd', 'reward', 'finished'].includes(game.phase) && typeof game.finished === 'boolean')
    const self = value.members.find((member: any) => member.id === value.selfId)
    ensure(typeof self.gamePlayerId === 'string' && game.players.some((player: any) => player.id === self.gamePlayerId))
    const cell = (value: any) => record(value) && integer(value.x, 0, game.width - 1) && integer(value.y, 0, game.height - 1)
    for (const row of game.tiles) { ensure(Array.isArray(row) && row.length === game.width); for (const tile of row) ensure(cell(tile) && Object.hasOwn(TERRAINS, tile.kind)) }
    for (const player of game.players) {
      ensure(record(player) && typeof player.id === 'string' && typeof player.name === 'string' && cell(player.cell) && cell(player.spawn) && typeof player.isAI === 'boolean')
      ensure(Array.isArray(player.hand) && player.hand.length <= 10000)
      // 服务端投影若意外包含别人的隐藏手牌，拒绝渲染，而非静默接收。
      if (player.id !== self.gamePlayerId) ensure(player.hand.length === 0)
      for (const card of player.hand) ensure(record(card) && integer(card.uid, 1) && Object.hasOwn(TOOLS, card.toolId))
    }
    for (const key of ['bombs', 'pigs', 'wallets', 'effects', 'logs']) ensure(Array.isArray(game[key]))
    if (game.pendingReward) ensure(Array.isArray(game.pendingReward.options)
      && (game.pendingReward.playerId === self.gamePlayerId || game.pendingReward.options.length === 0))
    ensure(typeof value.gameId === 'string')
  }
  return value as RoomView
}
function session(value: unknown): RoomSession {
  ensure(record(value) && /^\d{6}$/.test(value.roomId) && /^[A-Za-z0-9_-]{40,64}$/.test(value.token))
  return { roomId: value.roomId, token: value.token }
}
export function loadRoomSession(): RoomSession | null {
  try { const raw = sessionStorage.getItem(SESSION_KEY); return raw ? session(JSON.parse(raw)) : null } catch { return null }
}
export function saveRoomSession(value: RoomSession | null): string {
  try { if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value)); else sessionStorage.removeItem(SESSION_KEY); return '' }
  catch { return '浏览器无法保存房间身份，刷新后将不能自动重连。' }
}
async function request(path: string, secret?: string, body?: unknown, signal?: AbortSignal): Promise<any> {
  try {
    const response = await fetch(`/api/rooms${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    })
    const data: unknown = await response.json()
    if (!response.ok) throw new RoomRequestError(record(data) && typeof data.code === 'string' ? data.code : 'REQUEST_FAILED',
      record(data) && typeof data.error === 'string' ? data.error : '暂时无法完成操作。', response.status)
    return data
  } catch (error) {
    if (error instanceof RoomRequestError) throw error
    if (signal?.aborted) throw new RoomRequestError('CANCELLED', '已取消操作。')
    throw new RoomRequestError('CONNECTION_FAILED', '无法连接房间服务，请稍后重试或使用本地练习。')
  }
}
export const roomApi = {
  async create(name: string, mapId: string) { const value = await request('', undefined, { name, mapId }); return { session: session(value.session), snapshot: readRoomView(value.snapshot) } },
  async join(roomId: string, name: string) { const value = await request(`/${roomId}/join`, undefined, { name }); return { session: session(value.session), snapshot: readRoomView(value.snapshot) } },
  async snapshot(value: RoomSession) { return readRoomView(await request(`/${value.roomId}`, value.token)) },
  async command(value: RoomSession, expectedRevision: number, command: RoomCommand, requestId = globalThis.crypto?.randomUUID?.() ?? `action-${Date.now()}-${Math.random().toString(36).slice(2)}`) {
    const result = await request(`/${value.roomId}/commands`, value.token, { expectedRevision, command, requestId })
    return result.snapshot === null ? null : readRoomView(result.snapshot)
  },
  async suggest(value: RoomSession, goal: string, signal: AbortSignal): Promise<TacticalRunResult> {
    // 战术分析最长45秒，独立于普通命令的10秒等待。
    const response = await fetch(`/api/rooms/${value.roomId}/suggest`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${value.token}` }, body: JSON.stringify({ goal }), signal })
    const data = await response.json()
    if (!response.ok) throw new RoomRequestError(data.code ?? 'REQUEST_FAILED', data.error ?? '分析暂不可用。', response.status)
    return data
  },
}

/** 使用带认证头的SSE流，不把房间凭证写进URL、日志或分享链接。 */
export function watchRoom(value: RoomSession, onView: (view: RoomView) => void, onStatus: (connected: boolean) => void,
  onFatal: (message: string) => void) {
  const controller = new AbortController()
  const wait = (ms: number) => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, ms); controller.signal.addEventListener('abort', done, { once: true })
  })
  void (async () => {
    let retry = 300
    while (!controller.signal.aborted) {
      onStatus(false)
      const connection = new AbortController()
      let watchdog: ReturnType<typeof setTimeout> | undefined
      const resetWatchdog = () => { clearTimeout(watchdog); watchdog = setTimeout(() => connection.abort(), 35000) }
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      try {
        resetWatchdog()
        const response = await fetch(`/api/rooms/${value.roomId}/events`, { headers: { Authorization: `Bearer ${value.token}` }, signal: AbortSignal.any([controller.signal, connection.signal]) })
        if (!response.ok || !response.body) {
          if ([401, 404].includes(response.status)) { onFatal('房间已关闭或身份已失效，请重新加入。'); break }
          throw new Error('stream-failed')
        }
        reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!controller.signal.aborted) {
          const { value: chunk, done } = await reader.read()
          if (done) break
          resetWatchdog()
          buffer += decoder.decode(chunk, { stream: true })
          if (buffer.length > 524288) throw new Error('frame-too-large')
          let boundary: number
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2)
            if (frame.startsWith('data: ')) { onView(readRoomView(JSON.parse(frame.slice(6)))); onStatus(true); retry = 300 }
          }
        }
      } catch { /* 网络波动后重连并重新接收最新权威快照。 */ }
      finally { clearTimeout(watchdog); connection.abort(); try { await reader?.cancel() } catch { /* 连接已关闭。 */ } }
      if (controller.signal.aborted) break
      onStatus(false); await wait(retry); retry = Math.min(3000, retry * 2)
    }
  })()
  return () => controller.abort()
}
