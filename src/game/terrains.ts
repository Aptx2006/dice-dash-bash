import type { TerrainKind } from './types.ts'

export interface TerrainDef {
  kind: TerrainKind
  label: string
  desc: string
  color: number
  blocksMove: boolean
  blocksLeap: boolean
  blocksShot: boolean
}

// 颜色取自 Watcher 实机截图：木色地板、深蓝墙块、绿骷髅毒气、紫问号幸运、浅蓝传送带
export const TERRAINS: Record<TerrainKind, TerrainDef> = {
  floor: {
    kind: 'floor',
    label: '地板',
    desc: '可以正常停留。',
    color: 0xd6c096,
    blocksMove: false,
    blocksLeap: false,
    blocksShot: false,
  },
  start: {
    kind: 'start',
    label: '出生点',
    desc: '玩家的出生与复活位置。',
    color: 0xe8d9ae,
    blocksMove: false,
    blocksLeap: false,
    blocksShot: false,
  },
  home: {
    kind: 'home',
    label: '家园',
    desc: '经过时，将自己的出生点改为这里。',
    color: 0xe0bd85,
    blocksMove: false,
    blocksLeap: false,
    blocksShot: false,
  },
  lucky: {
    kind: 'lucky',
    label: '幸运方块',
    desc: '停留时获得随机工具。',
    color: 0xa98de0,
    blocksMove: false,
    blocksLeap: false,
    blocksShot: false,
  },
  goal: {
    kind: 'goal',
    label: '终点',
    desc: '停在这里即可完成竞速。',
    color: 0x7255c7,
    blocksMove: false,
    blocksLeap: false,
    blocksShot: false,
  },
  wall: {
    kind: 'wall',
    label: '墙壁',
    desc: '阻挡地面移动和投射物，可被飞跃越过。',
    color: 0x2c3550,
    blocksMove: true,
    blocksLeap: false,
    blocksShot: true,
  },
  highwall: {
    kind: 'highwall',
    label: '高墙',
    desc: '阻挡地面移动、飞跃和投射物。',
    color: 0x232b42,
    blocksMove: true,
    blocksLeap: true,
    blocksShot: true,
  },
  earthwall: {
    kind: 'earthwall',
    label: '土墙',
    desc: '耐久2。阻挡地面移动和投射物；撞碎需额外消耗移动。',
    color: 0x8a5a33,
    blocksMove: true,
    blocksLeap: false,
    blocksShot: true,
  },
  punchball: {
    kind: 'punchball',
    label: '拳击球',
    desc: '阻挡移动和投射物。用平移撞击时，会被同力度拳击弹开。',
    color: 0xb08248,
    blocksMove: true,
    blocksLeap: false,
    blocksShot: true,
  },
  pit: {
    kind: 'pit',
    label: '坑洞',
    desc: '经过或停留时死亡，并回到出生点。',
    color: 0x1a2438,
    blocksMove: false,
    blocksLeap: false,
    blocksShot: false,
  },
  poison: {
    kind: 'poison',
    label: '毒气',
    desc: '停留时死亡，并回到出生点。',
    color: 0x7fb04a,
    blocksMove: false,
    blocksLeap: false,
    blocksShot: false,
  },
  conveyor: {
    kind: 'conveyor',
    label: '传送带',
    desc: '顺行经过时获得 1 步额外移动。',
    color: 0x7fc4e8,
    blocksMove: false,
    blocksLeap: false,
    blocksShot: false,
  },
  cannon: {
    kind: 'cannon',
    label: '大炮',
    desc: '停留时向朝向方向发射一枚火箭。',
    color: 0x39424f,
    blocksMove: false,
    blocksLeap: false,
    blocksShot: false,
  },
}
