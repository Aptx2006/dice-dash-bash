import type { ToolId } from './types.ts'

export interface ToolDef {
  id: ToolId
  name: string
  icon: string
  tone: 'move' | 'attack' | 'build' | 'movePlus' | 'system'
  desc: (params?: { points?: number; length?: number }) => string
  target: 'none' | 'direction' | 'cell' | 'player' | 'adjacent' | 'anywhere'
}

export const TOOLS: Record<ToolId, ToolDef> = {
  roll: {
    id: 'roll',
    name: '投骰',
    icon: '🎲',
    tone: 'system',
    desc: () => '投掷【工具骰】和【移动骰】，进入行动阶段。',
    target: 'none',
  },
  move: {
    id: 'move',
    name: '移动',
    icon: '👣',
    tone: 'move',
    desc: (p) => `朝指定方向前进最多 ${p?.points ?? 0} 格。`,
    target: 'direction',
  },
  end: {
    id: 'end',
    name: '结束',
    icon: '⏹',
    tone: 'system',
    desc: () => '结束当前阶段。',
    target: 'none',
  },
  sprint: {
    id: 'sprint',
    name: '冲刺',
    icon: '⚡',
    tone: 'movePlus',
    desc: () => '本回合的移动牌增加 2 点移动。',
    target: 'none',
  },
  punch: {
    id: 'punch',
    name: '拳击',
    icon: '👊',
    tone: 'attack',
    desc: () => '向一方向出拳，2 格内命中生物将其击退 2 格；命中墙壁反推自身 1 格。',
    target: 'direction',
  },
  basketball: {
    id: 'basketball',
    name: '篮球',
    icon: '🏀',
    tone: 'attack',
    desc: () => '向前丢出篮球，遇到墙壁反弹，命中生物时将其击退 2 格。',
    target: 'direction',
  },
  hook: {
    id: 'hook',
    name: '钩锁',
    icon: '🪝',
    tone: 'movePlus',
    desc: (p) => `发射长度为 ${p?.length ?? 3} 的钩锁，将自己拉向墙壁，或将目标拉到身前。`,
    target: 'direction',
  },
  buildwall: {
    id: 'buildwall',
    name: '砌墙',
    icon: '🧱',
    tone: 'build',
    desc: () => '在相邻空地生成一面耐久 2 的土墙。',
    target: 'adjacent',
  },
  bomb: {
    id: 'bomb',
    name: '炸药',
    icon: '💣',
    tone: 'attack',
    desc: () => '在脚下布置炸药；下回合开始时爆炸，击飞四邻玩家 2 格。',
    target: 'none',
  },
  rocket: {
    id: 'rocket',
    name: '火箭',
    icon: '🚀',
    tone: 'attack',
    desc: () => '发射火箭，将中心目标击飞 2 格，周围目标击退 1 格。',
    target: 'direction',
  },
  teleport: {
    id: 'teleport',
    name: '瞬移',
    icon: '✨',
    tone: 'movePlus',
    desc: () => '瞬移到全场任意可落脚地块。',
    target: 'anywhere',
  },
  blink: {
    id: 'blink',
    name: '瞬步',
    icon: '🌀',
    tone: 'movePlus',
    desc: () => '瞬移到自身 3×3 范围内一格。',
    target: 'cell',
  },
  tow: {
    id: 'tow',
    name: '牵引',
    icon: '🔗',
    tone: 'attack',
    desc: () => '选择距离 3 内一名玩家，将其朝指定方向牵引 2 格。',
    target: 'player',
  },
  swapGhost: {
    id: 'swapGhost',
    name: '移魂',
    icon: '👻',
    tone: 'movePlus',
    desc: () => '与小幽灵互换位置。',
    target: 'none',
  },
  recallGhost: {
    id: 'recallGhost',
    name: '招魂',
    icon: '🕯',
    tone: 'movePlus',
    desc: () => '将小幽灵召唤至自身身旁。',
    target: 'none',
  },
  wallet: {
    id: 'wallet',
    name: '钱包',
    icon: '👛',
    tone: 'build',
    desc: () => '在相邻空地放置钱包，捡到的玩家获得随机工具。',
    target: 'adjacent',
  },
  balance: {
    id: 'balance',
    name: '制衡',
    icon: '⚖',
    tone: 'movePlus',
    desc: (p) => `扣除 ${p?.points ?? 0} 点移动点数，下回合取回等量移动。`,
    target: 'none',
  },
  leap: {
    id: 'leap',
    name: '飞跃',
    icon: '🦘',
    tone: 'move',
    desc: (p) => `向一方向跳跃 ${p?.points ?? 0} 格，忽略途中地形。`,
    target: 'direction',
  },
  copy: {
    id: 'copy',
    name: '复制',
    icon: '📋',
    tone: 'movePlus',
    desc: () => '放弃工具骰，复制上回合其他玩家使用过的最后一件工具。',
    target: 'none',
  },
  storm: {
    id: 'storm',
    name: '风暴巨剑',
    icon: '🗡',
    tone: 'attack',
    desc: () => '放弃行动，在附近召唤风暴巨剑：一回合内将周围生物吸向中心并封锁路径。',
    target: 'cell',
  },
  prepareTow: {
    id: 'prepareTow',
    name: '备锁',
    icon: '🔒',
    tone: 'movePlus',
    desc: () => '放弃移动骰，获得【牵引】：将一名玩家朝指定方向牵引 2 格。',
    target: 'none',
  },
}

export const TOOL_DIE_POOL: ToolId[] = [
  'sprint',
  'punch',
  'basketball',
  'hook',
  'buildwall',
  'bomb',
  'rocket',
  'teleport',
  'tow',
  'blink',
]

export function toolName(id: ToolId): string {
  return TOOLS[id].name
}
