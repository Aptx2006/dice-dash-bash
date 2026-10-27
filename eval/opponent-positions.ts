import { createGame } from '../src/game/engine.ts'
import type { Cell, GameState, ToolInstance } from '../src/game/types.ts'

export const OPPONENT_CASE_IDS = ['safe', 'pit', 'poison', 'sprint', 'finish'] as const
export type OpponentCaseId = typeof OPPONENT_CASE_IDS[number]
export interface OpponentPosition {
  id: OpponentCaseId
  title: string
  description: string
  state: GameState
  playerId: string
  /** 单步检查判据，不是策略最优性或整局胜率标注。 */
  expected: { legal: true; avoidDeathTerrain: boolean; winThisStep: boolean }
}

function position(mapId: string, cell: Cell, hand: ToolInstance[]): GameState {
  const state = createGame({ mapId, aiMode: 'cloud', players: [
    { name: '合成真人席位', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
    { name: '合成AI席位', isAI: true, characterId: 'robot', pieceColor: '#5f8d95', isHost: false },
  ], mechanisms: { airdrop: false, turnTimer: false } })
  state.activeIndex = 1
  state.phase = 'action'
  state.players[0].hand = []
  state.players[0].cell = mapId === 'tutorial' ? { x: 3, y: 4 } : { x: 0, y: 10 }
  state.players[1].cell = { ...cell }
  state.players[1].hand = hand.map(card => ({ ...card }))
  state.dice = { move: hand.find(card => card.toolId === 'move')?.points ?? null, toolName: null }
  state.logs = []
  state.effects = []
  return state
}

/** 内置地图上的固定手牌与坐标；不读取用户存档，不修改正式地图。 */
export function opponentPosition(id: OpponentCaseId): OpponentPosition {
  const move = (points: number): ToolInstance => ({ uid: 91001, toolId: 'move', points })
  switch (id) {
    case 'safe': return {
      id, title: '安全移动', description: '教学地图起点，3点移动，可向上或向右前进，均无危险地形。',
      state: position('tutorial', { x: 0, y: 6 }, [move(3)]), playerId: 'ai-1',
      expected: { legal: true, avoidDeathTerrain: true, winThisStep: false },
    }
    case 'pit': return {
      id, title: '坑洞旁选择', description: '图三(6,6)有1点移动，向左进入(5,6)坑洞；另有安全方向。',
      state: position('race3', { x: 6, y: 6 }, [move(1)]), playerId: 'ai-1',
      expected: { legal: true, avoidDeathTerrain: true, winThisStep: false },
    }
    case 'poison': return {
      id, title: '毒气旁选择', description: '图三(6,8)有1点移动，向右停在(7,8)毒气格；另有安全方向。',
      state: position('race3', { x: 6, y: 8 }, [move(1)]), playerId: 'ai-1',
      expected: { legal: true, avoidDeathTerrain: true, winThisStep: false },
    }
    case 'sprint': return {
      id, title: '冲刺与移动比较', description: '教学地图起点，3点移动及冲刺牌；只检查本步结果，不把原地加点判断为劣解。',
      state: position('tutorial', { x: 0, y: 6 }, [move(3), { uid: 91002, toolId: 'sprint' }]), playerId: 'ai-1',
      expected: { legal: true, avoidDeathTerrain: true, winThisStep: false },
    }
    case 'finish': return {
      id, title: '瞬移终点', description: '教学地图起点，3点移动及瞬移牌，终点(6,0)可合法瞬移抵达。',
      state: position('tutorial', { x: 0, y: 6 }, [move(3), { uid: 91003, toolId: 'teleport' }]), playerId: 'ai-1',
      expected: { legal: true, avoidDeathTerrain: true, winThisStep: true },
    }
  }
}
