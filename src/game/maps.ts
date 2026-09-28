import type { Dir, TerrainKind, Tile } from './types.ts'

export interface MapDef {
  id: string
  label: string
  desc: string
  grid: string[]
}

export const MAP_LEGEND: Record<string, { kind: TerrainKind; dir?: Dir }> = {
  '.': { kind: 'floor' },
  '#': { kind: 'wall' },
  H: { kind: 'highwall' },
  E: { kind: 'earthwall' },
  P: { kind: 'pit' },
  X: { kind: 'poison' },
  '<': { kind: 'conveyor', dir: 'left' },
  '>': { kind: 'conveyor', dir: 'right' },
  '^': { kind: 'conveyor', dir: 'up' },
  v: { kind: 'conveyor', dir: 'down' },
  U: { kind: 'cannon', dir: 'up' },
  R: { kind: 'cannon', dir: 'right' },
  D: { kind: 'cannon', dir: 'down' },
  L: { kind: 'cannon', dir: 'left' },
  '*': { kind: 'lucky' },
  h: { kind: 'home' },
  S: { kind: 'start' },
  G: { kind: 'goal' },
  B: { kind: 'punchball' },
}

export const TUTORIAL_MAP: MapDef = {
  id: 'tutorial',
  label: '基础教学关',
  desc: '练习投骰、移动、结束回合和观察智能体行动。',
  grid: [
    '......G',
    '.......',
    '...#...',
    '.......',
    '.....h.',
    '.......',
    'S......',
  ],
}

export const MAPS: MapDef[] = [
  {
    id: 'race1',
    label: '竞速模式 图一',
    desc: '雾港捷径：经典墙阵，适合第一次上手。',
    grid: [
      '........G.',
      '.....###..',
      '....H...*.',
      '..#.......',
      '.*.#..E...',
      '...#......',
      'H.....#..h',
      '..E...#...',
      '.#....#...',
      'S.......#.',
    ],
  },
  {
    id: 'race2',
    label: '竞速模式 图二',
    desc: '传送工坊：传送带、大炮与拳击球登场。',
    grid: [
      '.......v..G',
      '.**.v..H...',
      '...v....B..',
      '.U....##...',
      '....B....#.',
      '.##.....U..',
      '....*.R....',
      '.v....H....',
      'S...v....h.',
    ],
  },
  {
    id: 'race3',
    label: '竞速模式 图三',
    desc: '毒沼迷城：毒气与坑洞密布，谨慎选择路线。',
    grid: [
      '..........G',
      '.XXXX...H..',
      '.......X...',
      '.HH...E...*',
      '....P......',
      '.E..PP..H..',
      '.....P.....',
      '*.H..E..X..',
      '..E....X...',
      '.HH......h.',
      'S.........*',
    ],
  },
]

export function parseMap(def: MapDef): { tiles: Tile[][]; width: number; height: number } {
  const height = def.grid.length
  const width = Math.max(...def.grid.map((row) => row.length))
  const tiles: Tile[][] = []
  for (let y = 0; y < height; y++) {
    const row: Tile[] = []
    for (let x = 0; x < width; x++) {
      const ch = def.grid[y][x] ?? '.'
      const entry = MAP_LEGEND[ch] ?? { kind: 'floor' as TerrainKind }
      const tile: Tile = { x, y, kind: entry.kind, dir: entry.dir }
      if (entry.kind === 'earthwall') tile.durability = 2
      row.push(tile)
    }
    tiles.push(row)
  }
  return { tiles, width, height }
}

export function mapById(id: string): MapDef {
  return [TUTORIAL_MAP, ...MAPS].find((map) => map.id === id) ?? MAPS[0]
}
