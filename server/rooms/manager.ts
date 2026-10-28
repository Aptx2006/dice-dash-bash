import { createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto'
import type { GameState, GameConfig, ToolInstance } from '../../src/game/types.ts'
import type { RoomMember, RoomPresentation, RoomView } from '../../src/network/types.ts'
import { CHARACTERS, AI_CHARACTER } from '../../src/game/characters.ts'
import { MAPS } from '../../src/game/maps.ts'
import { validateNickname } from '../../src/game/configValidation.ts'
import { activePlayer, createGame, timeoutTurn, withGameRandom } from '../../src/game/engine.ts'
import { aiStep } from '../../src/game/ai.ts'
import { executeTacticalAction, createTacticalSnapshot } from '../../src/game/tactical.ts'
import { createOpponentController } from '../../src/agent/opponentController.ts'
import { runOpponentAgent, type OpponentAgentInput } from '../agent/opponent.ts'
import type { OpponentDecision } from '../../src/agent/opponentTypes.ts'
import { runTacticalAgent } from '../agent/harness.ts'
import { RoomError, ensure, integer, object, keys, parseRoomCommand, applyGameCommand } from './commands.ts'

const COLORS = ['#f2a75c', '#5f8d95', '#8fdfba', '#c9a0e8', '#7fb8e8', '#efc66d', '#d9714f', '#a8c86a']
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
function nickname(value: unknown): string {
  try { return validateNickname(value) } catch { throw new RoomError('INVALID_NAME', '昵称必须为1至12个字符。') }
}
interface Member extends RoomMember {
  token: string
  human: boolean
  departed: boolean
  disconnectedAt: number | null
  sinks: Set<(view: RoomView | null) => void>
  acknowledgements: Map<string, string>
}
interface Room {
  id: string; hostId: string; revision: number; members: Member[]
  config: Omit<GameConfig, 'players'>; status: RoomView['status']; game?: GameState; gameId?: string
  randomState: number; randomSecret: Buffer; updatedAt: number; createdAt: number; deadlineAt: number | null; timerHoldUntil: number | null; nextAiAt: number
  presentation?: RoomPresentation; eventId: number; broadcastId: number; pendingAI: boolean; thinkingPlayerName: string
  controller: ReturnType<typeof createOpponentController>
}
interface ManagerOptions {
  now?: () => number
  disconnectGraceMs?: number
  turnMs?: number
  aiDelayMs?: number
  diceHoldMs?: number
  opponentRequest?: (input: OpponentAgentInput, signal: AbortSignal) => Promise<OpponentDecision>
}

/** 服务端持有完整状态；订阅者只获得本方手牌和公开状态。房间生命周期独立于浏览器。 */
export class RoomManager {
  private rooms = new Map<string, Room>()
  private now: () => number
  private options: ManagerOptions
  private closed = false
  constructor(options: ManagerOptions = {}) { this.options = options; this.now = options.now ?? Date.now }

  private get(id: string): Room {
    const room = this.rooms.get(id)
    if (!room) throw new RoomError('ROOM_NOT_FOUND', '房间不存在或已关闭，请检查房间号。', 404)
    return room
  }
  private member(room: Room, token: string): Member {
    const member = room.members.find(member => member.human && !member.departed && member.token === token)
    if (!member) throw new RoomError('INVALID_SESSION', '房间凭证无效，请重新加入。', 401)
    return member
  }
  private owner(room: Room, member: Member) { ensure(room.hostId === member.id, '只有房主可以执行这项操作。', 'HOST_ONLY') }
  private random(room: Room): number {
    const block = createHmac('sha256', room.randomSecret).update(String(room.randomState++)).digest()
    return block.readUInt32BE(0) / 4294967296
  }
  private run<T>(room: Room, operation: () => T): T { return withGameRandom(() => this.random(room), operation) }
  private newMember(room: Room, name: string, human: boolean): Member {
    const used = new Set(room.members.map(member => member.characterId))
    return {
      id: randomUUID(), token: human ? randomBytes(32).toString('base64url') : '', name,
      characterId: human ? 'villager' : (CHARACTERS.find(character => !used.has(character.id))?.id ?? AI_CHARACTER.id),
      pieceColor: COLORS.find(color => !room.members.some(member => member.pieceColor === color)) ?? COLORS[0],
      isAI: !human, human, departed: false, takeover: false, ready: !human, connected: false,
      disconnectedAt: this.now(), sinks: new Set(), acknowledgements: new Map(),
    }
  }
  create(input: unknown): { session: { roomId: string; token: string }; snapshot: RoomView } {
    if (this.closed) throw new RoomError('UNAVAILABLE', '房间服务正在停止。', 503)
    ensure(this.rooms.size < 32, '房间数量已达上限，请稍后再试。', 'ROOM_LIMIT')
    const data = object(input); keys(data, ['name', 'mapId'])
    const name = nickname(data.name)
    ensure(MAPS.some(map => map.id === data.mapId), '地图不存在。')
    let id: string
    do { id = String(randomInt(100000, 1000000)) } while (this.rooms.has(id))
    const room: Room = {
      id, hostId: '', revision: 1, members: [], config: { mapId: data.mapId as string, mechanisms: { airdrop: true, turnTimer: true }, aiMode: 'rules' },
      status: 'lobby', randomState: 0, randomSecret: randomBytes(32), updatedAt: this.now(), createdAt: this.now(),
      deadlineAt: null, timerHoldUntil: null, nextAiAt: 0, eventId: 0, broadcastId: 0, pendingAI: false, thinkingPlayerName: '', controller: null!,
    }
    room.controller = createOpponentController({
      request: (task, signal) => this.options.opponentRequest ? this.options.opponentRequest(task, signal) : runOpponentAgent(task, { signal }),
      rulesStep: state => this.run(room, () => aiStep(state, () => this.random(room))),
      executeAction: (...args) => this.run(room, () => executeTacticalAction(...args)),
    })
    const host = this.newMember(room, name, true); host.ready = true
    room.members.push(host); room.hostId = host.id; this.rooms.set(id, room)
    return { session: { roomId: id, token: host.token }, snapshot: this.view(room, host) }
  }
  join(id: string, input: unknown) {
    const room = this.get(id), data = object(input); keys(data, ['name'])
    ensure(room.status === 'lobby', '这局已经开始，请等待下一局。', 'ALREADY_STARTED')
    ensure(room.members.length < 8, '房间已满。', 'ROOM_FULL')
    const name = nickname(data.name)
    ensure(!room.members.some(member => member.name.toLocaleLowerCase() === name.toLocaleLowerCase()), '昵称已被使用，请换一个昵称。')
    const member = this.newMember(room, name, true); room.members.push(member)
    this.changed(room)
    return { session: { roomId: id, token: member.token }, snapshot: this.view(room, member) }
  }
  snapshot(id: string, token: string): RoomView { const room = this.get(id); return this.view(room, this.member(room, token)) }
  private view(room: Room, self: Member): RoomView {
    const game = room.game ? clone(room.game) : undefined
    if (game) {
      for (const player of game.players) if (player.id !== self.gamePlayerId) player.hand = []
      if (game.pendingReward && game.pendingReward.playerId !== self.gamePlayerId) game.pendingReward.options = []
    }
    return {
      id: room.id, revision: room.revision, syncId: room.broadcastId, hostId: room.hostId, selfId: self.id,
      members: room.members.map(({ id, name, characterId, pieceColor, isAI, ready, connected, takeover, gamePlayerId }) => ({
        id, name, characterId, pieceColor, isAI, ready, connected, takeover, ...(gamePlayerId ? { gamePlayerId } : {}),
      })),
      config: clone(room.config), status: room.status, ...(room.gameId ? { gameId: room.gameId } : {}),
      ...(game ? { game } : {}), deadlineAt: room.deadlineAt, timerHoldUntil: room.timerHoldUntil, serverNow: this.now(),
      ...(room.presentation ? { presentation: clone(room.presentation) } : {}), thinkingPlayerName: room.thinkingPlayerName,
    }
  }
  private publish(room: Room) {
    room.broadcastId++
    for (const member of room.members) for (const sink of member.sinks) {
      try { sink(this.view(room, member)) } catch { /* 断开的连接由HTTP层移除。 */ }
    }
  }
  private changed(room: Room) { room.revision++; room.updatedAt = this.now(); this.publish(room) }
  subscribe(id: string, token: string, sink: (view: RoomView | null) => void): () => void {
    const room = this.get(id), member = this.member(room, token)
    ensure(member.sinks.size < 2, '此座位的连接过多，请关闭重复页面。', 'CONNECTION_LIMIT')
    member.sinks.add(sink); member.connected = true; member.disconnectedAt = null
    if (member.takeover && !member.departed && room.game && !room.game.finished) {
      room.controller.cancel(); member.takeover = false; member.isAI = false
      const actor = room.game.players.find(player => player.id === member.gamePlayerId)!
      actor.isAI = false
      if (activePlayer(room.game).id === actor.id) this.resetDeadline(room)
      this.changed(room)
    } else this.publish(room)
    // publish已发送初始视图，不需要重复发送。
    let done = false
    return () => {
      if (done) return
      done = true; member.sinks.delete(sink)
      if (!member.sinks.size) { member.connected = false; member.disconnectedAt = this.now(); this.publish(room) }
    }
  }
  command(id: string, token: string, input: unknown): RoomView | null {
    const room = this.get(id), member = this.member(room, token), request = object(input)
    keys(request, ['requestId', 'expectedRevision', 'command'])
    ensure(typeof request.requestId === 'string' && /^[A-Za-z0-9-]{8,100}$/.test(request.requestId), '请求编号无效。')
    ensure(integer(request.expectedRevision, 1))
    const command = parseRoomCommand(request.command), signature = JSON.stringify(command)
    const previous = member.acknowledgements.get(request.requestId)
    if (previous) { ensure(previous === signature, '同一请求编号不能提交不同操作。', 'REQUEST_CONFLICT'); return this.view(room, member) }
    if (command.type !== 'leave' && request.expectedRevision !== room.revision) throw new RoomError('STALE_STATE', '局面已更新，请按最新画面重新操作。', 409)
    if (command.type === 'leave') {
      this.leave(room, member)
      return null
    }
    if (command.type === 'rematch') {
      this.owner(room, member); ensure(room.status === 'finished', '请先完成当前对局。')
      room.controller.cancel(); room.game = undefined; room.gameId = undefined; room.status = 'lobby'; room.deadlineAt = null
      room.presentation = undefined; room.thinkingPlayerName = ''; room.pendingAI = false
      room.members = room.members.filter(member => !member.departed)
      for (const entry of room.members) { delete entry.gamePlayerId; entry.takeover = false; entry.isAI = !entry.human; entry.ready = !entry.human || entry.id === room.hostId }
    } else if (room.status === 'lobby') {
      switch (command.type) {
        case 'ready': member.ready = member.id === room.hostId || command.ready; break
        case 'configure':
          this.owner(room, member)
          if (command.mapId !== undefined) { ensure(MAPS.some(map => map.id === command.mapId), '地图不存在。'); room.config.mapId = command.mapId }
          if (command.airdrop !== undefined) room.config.mechanisms.airdrop = command.airdrop
          if (command.turnTimer !== undefined) room.config.mechanisms.turnTimer = command.turnTimer
          if (command.aiMode !== undefined) room.config.aiMode = command.aiMode
          // 机制变化后需要真人重新确认准备，避免在未知规则下被开始。
          for (const entry of room.members) if (entry.human && entry.id !== room.hostId) entry.ready = false
          break
        case 'character': {
          const target = command.memberId ? room.members.find(entry => entry.id === command.memberId) : member
          ensure(target && (target.id === member.id || (!target.human && room.hostId === member.id)), '不能修改其他玩家的角色。', 'FORBIDDEN')
          ensure([...CHARACTERS, AI_CHARACTER].some(character => character.id === command.characterId), '角色不存在。')
          if (command.pieceColor) ensure(!room.members.some(other => other.id !== target.id && other.pieceColor === command.pieceColor), '棋子颜色已被占用。')
          target.characterId = command.characterId
          if (command.pieceColor) target.pieceColor = command.pieceColor
          break
        }
        case 'add_ai':
          this.owner(room, member); ensure(room.members.length < 8, '房间已满。')
          room.members.push(this.newMember(room, `机器人${room.members.length}`, false)); break
        case 'remove': {
          this.owner(room, member); ensure(command.memberId !== member.id, '请使用离开房间。')
          const target = room.members.find(entry => entry.id === command.memberId); ensure(target, '该成员已离开。')
          for (const sink of target.sinks) sink(null)
          room.members = room.members.filter(entry => entry !== target); break
        }
        case 'start':
          this.owner(room, member); ensure(room.members.length >= 2, '至少需要两名选手。')
          ensure(room.members.every(entry => !entry.human || entry.ready), '还有玩家没有准备。', 'NOT_READY')
          ensure(room.members.every(entry => !entry.human || entry.connected), '有玩家尚未连接，请等待重连或移除该成员。', 'NOT_CONNECTED')
          room.game = this.run(room, () => createGame({ ...clone(room.config), players: room.members.map(entry => ({
            name: entry.name, isAI: !entry.human, characterId: entry.characterId, pieceColor: entry.pieceColor, isHost: entry.id === room.hostId,
          })) }))
          room.gameId = randomUUID(); room.status = 'playing'; room.nextAiAt = this.now()
          room.members.forEach((entry, index) => { entry.gamePlayerId = room.game!.players[index].id })
          this.resetDeadline(room); break
        default: throw new RoomError('WRONG_PHASE', '对局尚未开始。')
      }
    } else {
      ensure(room.game && member.gamePlayerId, '当前没有可操作的对局。')
      if (room.deadlineAt !== null && this.now() >= room.deadlineAt) {
        const expired = clone(room.game)
        this.run(room, () => timeoutTurn(room.game!)); this.afterGameStep(room, expired); this.changed(room)
        throw new RoomError('TURN_EXPIRED', '回合已经超时，请等待下一回合。', 409)
      }
      const before = clone(room.game), next = clone(room.game), rngBefore = room.randomState
      try {
        this.run(room, () => applyGameCommand(next, member.gamePlayerId!, command))
        ensure(JSON.stringify(next) !== JSON.stringify(before), '操作没有生效，请重新选择。', 'NO_EFFECT')
      } catch (error) { room.randomState = rngBefore; throw error }
      room.controller.cancel(); room.game = next
      this.afterGameStep(room, before)
    }
    member.acknowledgements.set(request.requestId, signature)
    while (member.acknowledgements.size > 128) member.acknowledgements.delete(member.acknowledgements.keys().next().value!)
    this.changed(room)
    return this.view(room, member)
  }
  private resetDeadline(room: Room) {
    room.timerHoldUntil = null
    room.deadlineAt = room.game && !room.game.finished && !activePlayer(room.game).isAI && room.game.mechanisms.turnTimer
      ? this.now() + (this.options.turnMs ?? 75000) : null
  }
  private afterGameStep(room: Room, before: GameState) {
    const game = room.game!, actor = activePlayer(before)
    const currentActor = game.players.find(player => player.id === actor.id)!
    const removed = actor.hand.find(card => !currentActor.hand.some(after => after.uid === card.uid))
    const reward = before.pendingReward?.options.find(card => currentActor.hand.some(after => after.uid === card.uid))
    const rolled = before.phase === 'turnStart' && game.phase === 'action' && game.dice.move !== null && game.dice.toolName !== null
    room.presentation = { id: ++room.eventId, actorId: actor.id, actorName: actor.name, phaseBefore: before.phase,
      ...((removed ?? reward) ? { card: clone((removed ?? reward) as ToolInstance) } : {}),
      ...(rolled ? { dice: { move: game.dice.move!, toolName: game.dice.toolName! } } : {}) }
    room.status = game.finished ? 'finished' : 'playing'
    room.nextAiAt = this.now() + (rolled ? this.options.diceHoldMs ?? 4000 : this.options.aiDelayMs ?? 2500)
    if (before.turnNumber !== game.turnNumber || before.activeIndex !== game.activeIndex || game.finished) this.resetDeadline(room)
    else if (rolled && room.deadlineAt) {
      const hold = this.options.diceHoldMs ?? 4000
      room.deadlineAt += hold; room.timerHoldUntil = this.now() + hold
    }
  }
  private leave(room: Room, member: Member) {
    member.departed = true; member.connected = false; member.ready = false
    for (const sink of member.sinks) { try { sink(null) } catch { /* 已断开 */ } }
    member.sinks.clear()
    if (room.status === 'lobby') room.members = room.members.filter(entry => entry !== member)
    else if (room.game && !room.game.finished) this.takeover(room, member)
    if (room.hostId === member.id) room.hostId = room.members.find(entry => entry.human && !entry.departed && entry.connected)?.id
      ?? room.members.find(entry => entry.human && !entry.departed)?.id ?? ''
    const nextHost = room.members.find(entry => entry.id === room.hostId)
    if (nextHost) nextHost.ready = true
    if (room.game) for (const player of room.game.players) player.isHost = player.id === nextHost?.gamePlayerId
    if (!room.members.some(entry => entry.human && !entry.departed)) this.drop(room)
    else this.changed(room)
  }
  private takeover(room: Room, member: Member) {
    if (!room.game || !member.gamePlayerId) return
    room.controller.cancel(); member.takeover = true; member.isAI = true
    const player = room.game.players.find(player => player.id === member.gamePlayerId)!
    player.isAI = true
    if (activePlayer(room.game).id === player.id) { room.deadlineAt = null; room.nextAiAt = this.now() }
  }
  async suggest(id: string, token: string, goal: unknown, signal: AbortSignal) {
    const room = this.get(id), member = this.member(room, token)
    ensure(typeof goal === 'string' && goal.trim().length > 0 && goal.length <= 120, '请输入1至120字的目标。')
    ensure(room.game && member.gamePlayerId && activePlayer(room.game).id === member.gamePlayerId && !activePlayer(room.game).isAI, '请在自己的行动阶段分析。')
    const revision = room.revision
    const result = await runTacticalAgent({ snapshot: createTacticalSnapshot(room.game, member.gamePlayerId), playerId: member.gamePlayerId, goal }, { signal })
    if (room.revision !== revision || this.rooms.get(id) !== room) throw new RoomError('STALE_STATE', '局面已改变，请重新分析。', 409)
    return result
  }
  async tick(): Promise<void> {
    if (this.closed) return
    const now = this.now()
    await Promise.all([...this.rooms.values()].map(async room => {
      if (now - room.createdAt > 2 * 60 * 60 * 1000 || now - room.updatedAt > 30 * 60 * 1000) { this.drop(room); return }
      if (room.status === 'lobby') {
        const host = room.members.find(member => member.id === room.hostId)
        if (host && !host.connected && host.disconnectedAt !== null && now - host.disconnectedAt >= (this.options.disconnectGraceMs ?? 20000)) {
          const successor = room.members.find(member => member.human && !member.departed && member.connected)
          if (successor && successor !== host) { room.hostId = successor.id; successor.ready = true; this.changed(room) }
        }
      }
      if (room.game && !room.game.finished) for (const member of room.members) {
        if (member.human && !member.departed && !member.connected && !member.takeover && member.disconnectedAt !== null
          && now - member.disconnectedAt >= (this.options.disconnectGraceMs ?? 20000)) { this.takeover(room, member); this.changed(room) }
      }
      const game = room.game
      if (!game || game.finished || room.pendingAI) return
      if (room.deadlineAt !== null && now >= room.deadlineAt && !activePlayer(game).isAI) {
        const before = clone(game); this.run(room, () => timeoutTurn(game)); this.afterGameStep(room, before); this.changed(room); return
      }
      if (!activePlayer(game).isAI || now < room.nextAiAt) return
      room.pendingAI = true
      const before = clone(game), gameId = room.gameId
      room.thinkingPlayerName = game.aiMode === 'cloud' && game.phase === 'action' ? activePlayer(game).name : ''
      try {
        const pending = room.controller.step(game)
        this.publish(room)
        const result = await pending
        if (this.rooms.get(room.id) !== room || room.game !== game || room.gameId !== gameId) return
        if (result.acted) { this.afterGameStep(room, before); this.changed(room) }
        else room.nextAiAt = this.now() + 200
      } catch {
        // 本地控制器意外异常仍受固定规则兜底；不返回内部异常或模型密钥。
        if (this.rooms.get(room.id) === room && room.game === game && !game.finished) {
          this.run(room, () => aiStep(game, () => this.random(room))); this.afterGameStep(room, before); this.changed(room)
        }
      } finally {
        room.pendingAI = false; room.thinkingPlayerName = ''
        if (this.rooms.get(room.id) === room) this.publish(room)
      }
    }))
  }
  private drop(room: Room) {
    if (!this.rooms.has(room.id)) return
    this.rooms.delete(room.id); room.controller.dispose()
    for (const member of room.members) for (const sink of member.sinks) { try { sink(null) } catch { /* 已断开 */ } }
  }
  close() { this.closed = true; for (const room of [...this.rooms.values()]) this.drop(room) }
}
