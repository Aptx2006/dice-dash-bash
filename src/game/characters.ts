import type { ToolId } from './types.ts'

export interface CharacterDef {
  id: string
  name: string
  title: string
  skill: string
  flavor: string
  color: string
  associatedTools: ToolId[]
}

export const CHARACTERS: CharacterDef[] = [
  {
    id: 'villager',
    name: '村民',
    title: 'Villager',
    skill: '没有任何技能。',
    flavor: '迟来的艺术。',
    color: '#c9b182',
    associatedTools: [],
  },
  {
    id: 'russell',
    name: '罗素',
    title: 'Russell',
    skill: '移动过程中可以提前停止（制动）。',
    flavor: '朴素的白板。',
    color: '#8fdfba',
    associatedTools: ['move'],
  },
  {
    id: 'goose',
    name: '鹅哈哈',
    title: 'Goose',
    skill: '行动阶段开始时，额外获得一张【篮球】。',
    flavor: '到此一游。',
    color: '#efc66d',
    associatedTools: ['basketball'],
  },
  {
    id: 'lanpen',
    name: '兰彭',
    title: 'Lampen',
    skill: '回合开始时可【复制】：放弃工具骰，获得上回合其他玩家使用过的最后一张工具。',
    flavor: '可别再弄丢了。',
    color: '#5f8d95',
    associatedTools: ['copy'],
  },
  {
    id: 'leader',
    name: '领导',
    title: 'Leader',
    skill: '回合结束阶段，可以在相邻空地放置一个【钱包】，捡到的玩家获得随机工具。',
    flavor: '可不要离我太近。',
    color: '#e6b04a',
    associatedTools: ['wallet'],
  },
  {
    id: 'blaze',
    name: '布拉泽',
    title: 'Blazer',
    skill: '回合结束阶段获得一张【炸药】。',
    flavor: '行动要趁热。',
    color: '#d9714f',
    associatedTools: ['bomb'],
  },
  {
    id: 'lock',
    name: '锁',
    title: 'Lock',
    skill: '回合开始时可【备锁】：放弃移动骰，获得【牵引】，将一名玩家朝指定方向牵引2格。',
    flavor: '锁定目标，然后牵走它。',
    color: '#9aa7b8',
    associatedTools: ['tow'],
  },
  {
    id: 'heart',
    name: '心',
    title: 'Heart',
    skill: '游戏开始时生成小幽灵；行动阶段获得【移魂】，回合结束阶段获得【招魂】。',
    flavor: '心有所依，魂有所归。',
    color: '#c9a0e8',
    associatedTools: ['swapGhost', 'recallGhost'],
  },
  {
    id: 'storm',
    name: '暴风',
    title: 'Storm',
    skill: '回合开始时可召唤【风暴巨剑】：落在附近，持续一回合，将周围生物吸向中心并封锁路径。',
    flavor: '风眼之中，巨剑落下。',
    color: '#7fb8e8',
    associatedTools: ['storm'],
  },
  {
    id: 'flandi',
    name: '芙兰迪',
    title: 'Flandi',
    skill: '回合开始时可【飞跃】：放弃工具骰，将本回合移动改为向一方向跳跃（忽略途中地形）。',
    flavor: '我不会有所隐瞒。',
    color: '#88d7bd',
    associatedTools: ['leap'],
  },
  {
    id: 'chang',
    name: '常',
    title: 'Chang',
    skill: '钩锁初始长度为1；每使用一张牌，钩锁长度+1，最多5。',
    flavor: '还能再快一点。',
    color: '#a8c86a',
    associatedTools: ['hook'],
  },
  {
    id: 'fazhen',
    name: '法真',
    title: 'Fazhen',
    skill: '行动阶段可【制衡】：扣除至多一半移动点数，下回合取回等量移动。',
    flavor: '让枝叶自己选择方向。',
    color: '#8f6a34',
    associatedTools: ['balance'],
  },
  {
    id: 'morrison',
    name: '莫汀',
    title: 'Morrison',
    skill: '行动阶段开始时，额外获得一张【砌墙】。',
    flavor: '多一堵墙，多一分安全。',
    color: '#b08b69',
    associatedTools: ['buildwall'],
  },
  {
    id: 'jean',
    name: '让',
    title: 'Jean',
    skill: '移动点数始终-2；行动阶段获得【瞬步】；行动结束时若仍有移动，再次获得【瞬步】。',
    flavor: '烟里一步，身形已错。',
    color: '#b4b2a9',
    associatedTools: ['blink'],
  },
]

export const AI_CHARACTER: CharacterDef = {
  id: 'robot',
  name: '威猛机器人',
  title: 'Mighty Robot',
  skill: '没有任何技能。',
  flavor: '电量充足，随时开赛。',
  color: '#8ea0c9',
  associatedTools: [],
}

export function characterById(id: string): CharacterDef {
  if (id === AI_CHARACTER.id) return AI_CHARACTER
  return CHARACTERS.find((ch) => ch.id === id) ?? CHARACTERS[0]
}
