<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { cellKey, sameCell, type Cell, type Dir, type GameState } from '../game/types.ts'
import { TERRAINS } from '../game/terrains.ts'
import { characterById } from '../game/characters.ts'
import { calculateBoardFitRadius } from '../rendering/cameraFit.ts'
import { movementAlpha } from '../rendering/presentation.ts'

const props = defineProps<{
  state: GameState
  highlights: Cell[]
  hoverCell?: Cell | null
  animationSpeed?: number
}>()
const emit = defineEmits<{ select: [cell: Cell] }>()

const host = ref<HTMLDivElement | null>(null)

let renderer: THREE.WebGLRenderer | undefined
let scene: THREE.Scene | undefined
let camera: THREE.PerspectiveCamera | undefined
let frame = 0
let resizeObserver: ResizeObserver | undefined

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()
type AssetTerrain = 'goal' | 'punchball' | 'lucky' | 'poison' | 'conveyor' | 'cannon' | 'pit' | 'earthwall' | 'home'
const terrainAssetPaths: Record<AssetTerrain, string> = {
  goal: '/assets/terrain/goal-flag.png',
  punchball: '/assets/terrain/punchball.png',
  lucky: '/assets/terrain/lucky-box.png',
  poison: '/assets/terrain/poison-skull.png',
  conveyor: '/assets/terrain/conveyor.png',
  cannon: '/assets/terrain/cannon.png',
  pit: '/assets/terrain/pit.png',
  earthwall: '/assets/terrain/earthwall.png',
  home: '/assets/terrain/home.png',
}
const terrainTextures = new Map<AssetTerrain, THREE.Texture>()
const textureLoader = new THREE.TextureLoader()

// 固定 2.5D 斜俯视角；玩家只能平移和缩放棋盘。
// 棋盘底边与屏幕底线接近平行，只保留少量水平偏转，避免正交画面的呆板感。
const camYaw = THREE.MathUtils.degToRad(8)
// 保留明显的立体纵深，不采用接近正俯视的镜头。
const camPitch = THREE.MathUtils.degToRad(54)
// 半径随地图尺寸自适应，保证整张棋盘入画（含手牌条遮挡余量）
const mapMaxDim = Math.max(props.state.width, props.state.height)
const baseCamRadius = Math.max(16, mapMaxDim * 1.75 + 3.5)
const minCamRadius = Math.max(8, baseCamRadius * 0.48)
const maxCamRadius = baseCamRadius * 1.7
let camRadius = baseCamRadius
let desiredCamRadius = baseCamRadius
let userZoomed = false
// 注视点向相机方向偏移：画面上移，避让底部手牌区
const lookTarget = new THREE.Vector3(0, -1.6, 0)
const desiredLookTarget = lookTarget.clone()
let dragStart: { x: number; y: number } | null = null
let dragMoved = false
const panning = ref(false)

interface TileEntry {
  group: THREE.Group
  kind: string
  dir?: Dir
  durability?: number
  glow?: THREE.Mesh
}
const tileEntries = new Map<string, TileEntry>()
const playerMeshes = new Map<string, THREE.Group>()
const entityMeshes = new Map<string, THREE.Group>()
const ghostMeshes = new Map<string, THREE.Group>()
const animations: Array<{
  obj: THREE.Object3D
  kind: string
  startMs: number
  durationMs: number
  from?: THREE.Vector3
  to?: THREE.Vector3
}> = []

function cellToWorld(cell: Cell, index = 0): THREE.Vector3 {
  const spread = index * 0.24
  return new THREE.Vector3(cell.x - (props.state.width - 1) / 2 + spread, 0, cell.y - (props.state.height - 1) / 2 + spread)
}

function makeTextSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 72
  const ctx = canvas.getContext('2d')!
  ctx.font = '700 34px "Trebuchet MS", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineWidth = 8
  ctx.strokeStyle = 'rgba(44, 53, 80, 0.85)'
  ctx.strokeText(text, 128, 36)
  ctx.fillStyle = '#fffaf0'
  ctx.fillText(text, 128, 36)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(1.9, 0.53, 1)
  return sprite
}

function makeIconPlane(kind: string, dir?: Dir): THREE.Mesh {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, 128, 128)
  ctx.strokeStyle = '#fffaf0'
  ctx.fillStyle = '#fffaf0'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (kind === 'lucky') {
    ctx.font = '700 92px Georgia, serif'
    ctx.fillText('?', 64, 70)
  } else if (kind === 'conveyor' && dir) {
    ctx.lineWidth = 10
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const offset of [-18, 18]) {
      ctx.beginPath()
      ctx.moveTo(64 - 14 + offset, 42)
      ctx.lineTo(64 + 14 + offset, 64)
      ctx.lineTo(64 - 14 + offset, 86)
      ctx.stroke()
    }
  } else if (kind === 'poison') {
    ctx.beginPath()
    ctx.arc(64, 54, 30, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(44, 72, 40, 18)
    ctx.fillStyle = '#2c3550'
    ctx.beginPath()
    ctx.arc(53, 50, 8, 0, Math.PI * 2)
    ctx.arc(75, 50, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillRect(60, 62, 8, 8)
  } else if (kind === 'cannon' && dir) {
    ctx.beginPath()
    ctx.moveTo(64, 34)
    ctx.lineTo(84, 66)
    ctx.lineTo(64, 56)
    ctx.lineTo(44, 66)
    ctx.closePath()
    ctx.fill()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false })
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.72), material)
  plane.rotation.x = -Math.PI / 2
  if (kind === 'conveyor' && dir) {
    const rot = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[dir]
    plane.rotation.z = rot
  }
  if (kind === 'cannon' && dir) {
    const rot = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 }[dir]
    plane.rotation.z = rot
  }
  return plane
}

function disposeGroup(group: THREE.Object3D) {
  group.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry.dispose()
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const material of materials) {
        const withMap = material as THREE.MeshStandardMaterial & { map?: THREE.Texture }
        withMap.map?.dispose()
        material.dispose()
      }
    }
    if (obj instanceof THREE.Sprite) {
      if (!obj.userData.sharedTexture) obj.material.map?.dispose()
      obj.material.dispose()
    }
  })
}

function makeTerrainSprite(kind: AssetTerrain, dir?: Dir): THREE.Sprite {
  let texture = terrainTextures.get(kind)
  if (!texture) {
    texture = textureLoader.load(terrainAssetPaths[kind])
    texture.colorSpace = THREE.SRGBColorSpace
    terrainTextures.set(kind, texture)
  }
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  })
  if (dir) {
    material.rotation = {
      right: 0,
      down: -Math.PI / 2,
      left: Math.PI,
      up: Math.PI / 2,
    }[dir]
  }
  const sprite = new THREE.Sprite(material)
  const large = kind === 'goal' || kind === 'home' || kind === 'cannon'
  sprite.scale.setScalar(large ? 1.08 : 0.92)
  sprite.position.y = large ? 0.62 : 0.42
  sprite.userData.sharedTexture = true
  return sprite
}

function buildTileGroup(kind: string, dir: Dir | undefined, durability: number | undefined): THREE.Group {
  const group = new THREE.Group()
  const def = TERRAINS[kind as keyof typeof TERRAINS]
  const baseY = 0

  if (kind === 'pit') {
    const hole = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, 0.1, 0.92),
      new THREE.MeshStandardMaterial({ color: 0x1a2438, roughness: 1 }),
    )
    hole.position.y = -0.12
    group.add(hole)
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.42, 24),
      new THREE.MeshBasicMaterial({ color: 0x0b0f1a, side: THREE.DoubleSide }),
    )
    rim.rotation.x = -Math.PI / 2
    rim.position.y = 0.02
    group.add(rim, makeTerrainSprite('pit'))
    return group
  }

  const tile = new THREE.Mesh(
    new THREE.BoxGeometry(0.92, 0.14, 0.92),
    new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.85 }),
  )
  tile.position.y = baseY - 0.07
  tile.receiveShadow = true
  group.add(tile)

  if (kind in terrainAssetPaths) {
    group.add(makeTerrainSprite(kind as AssetTerrain, dir))
    return group
  }

  if (kind === 'wall' || kind === 'highwall') {
    const height = kind === 'wall' ? 0.85 : 1.4
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(0.92, height, 0.92),
      new THREE.MeshStandardMaterial({ color: def.color, roughness: 0.9 }),
    )
    block.position.y = height / 2
    block.castShadow = true
    block.receiveShadow = true
    group.add(block)
  } else if (kind === 'earthwall') {
    const scale = durability === 1 ? 0.62 : 1
    const mound = new THREE.Mesh(
      new THREE.BoxGeometry(0.8 * scale, 0.55 * scale, 0.8 * scale),
      new THREE.MeshStandardMaterial({ color: def.color, roughness: 1 }),
    )
    mound.position.y = (0.55 * scale) / 2
    mound.rotation.y = 0.35
    mound.castShadow = true
    group.add(mound)
    const chips = new THREE.Mesh(
      new THREE.BoxGeometry(0.4 * scale, 0.22, 0.4 * scale),
      new THREE.MeshStandardMaterial({ color: 0xa3703f, roughness: 1 }),
    )
    chips.position.y = 0.55 * scale + 0.11
    chips.rotation.y = -0.3
    group.add(chips)
  } else if (kind === 'punchball') {
    for (let i = 0; i < 3; i++) {
      const log = new THREE.Mesh(
        new THREE.BoxGeometry(0.66, 0.2, 0.24),
        new THREE.MeshStandardMaterial({ color: i % 2 ? 0x97784a : 0xb08248, roughness: 0.9 }),
      )
      log.position.set((i - 1) * 0.02, 0.12 + i * 0.2, (i - 1) * 0.1)
      log.rotation.y = i % 2 ? 0.4 : -0.25
      log.castShadow = true
      group.add(log)
    }
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.09, 0.7, 8),
      new THREE.MeshStandardMaterial({ color: 0x7c5c30, roughness: 0.95 }),
    )
    post.position.y = 0.35
    post.castShadow = true
    group.add(post)
  } else if (kind === 'lucky') {
    group.add(makeIconPlane('lucky'))
  } else if (kind === 'poison') {
    const icon = makeIconPlane('poison')
    icon.position.y = 0.01
    group.add(icon)
    const cloud = new THREE.Mesh(
      new THREE.SphereGeometry(0.3, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x5f8d3a, transparent: true, opacity: 0.55, roughness: 1 }),
    )
    cloud.scale.y = 0.45
    cloud.position.y = 0.22
    group.add(cloud)
  } else if (kind === 'conveyor' && dir) {
    const icon = makeIconPlane('conveyor', dir)
    icon.position.y = 0.01
    group.add(icon)
  } else if (kind === 'cannon' && dir) {
    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.17, 0.55, 10),
      new THREE.MeshStandardMaterial({ color: 0x1f2733, roughness: 0.6, metalness: 0.3 }),
    )
    const rot = { right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2, up: 0 }[dir]
    barrel.rotation.y = rot
    barrel.rotation.x = Math.PI / 2.6
    barrel.position.y = 0.3
    barrel.castShadow = true
    group.add(barrel)
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.2, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x2c3550, roughness: 0.8 }),
    )
    base.position.y = 0.1
    group.add(base)
  } else if (kind === 'home') {
    const house = new THREE.Group()
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.26, 0.3),
      new THREE.MeshStandardMaterial({ color: 0xc9a86a, roughness: 0.85 }),
    )
    body.position.y = 0.13
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(0.28, 0.2, 4),
      new THREE.MeshStandardMaterial({ color: 0xc9504a, roughness: 0.8 }),
    )
    roof.position.y = 0.36
    roof.rotation.y = Math.PI / 4
    house.add(body, roof)
    house.castShadow = true
    group.add(house)
  } else if (kind === 'start') {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.24, 0.36, 24),
      new THREE.MeshBasicMaterial({ color: 0xc9b182, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    ring.position.y = 0.02
    group.add(ring)
  } else if (kind === 'goal') {
    const torus = new THREE.Mesh(
      new THREE.TorusGeometry(0.26, 0.07, 10, 26),
      new THREE.MeshStandardMaterial({ color: 0xefc66d, roughness: 0.4, metalness: 0.35 }),
    )
    torus.rotation.x = Math.PI / 2
    torus.position.y = 0.1
    group.add(torus)
    const flag = new THREE.Mesh(
      new THREE.CylinderGeometry(0.03, 0.03, 0.6, 6),
      new THREE.MeshStandardMaterial({ color: 0x2c3550 }),
    )
    flag.position.y = 0.3
    group.add(flag)
  }
  return group
}

function buildPlayerGroup(name: string, color: string): THREE.Group {
  const group = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.21, 0.34, 4, 12),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.55 }),
  )
  body.position.y = 0.42
  body.castShadow = true
  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 18, 18),
    new THREE.MeshStandardMaterial({ color: 0xffe3c0, roughness: 0.65 }),
  )
  head.position.y = 0.86
  head.castShadow = true
  const marker = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.045, 8, 26),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  )
  marker.rotation.x = Math.PI / 2
  marker.position.y = 0.06
  marker.name = 'active-marker'
  const label = makeTextSprite(name)
  label.position.y = 1.34
  label.name = 'player-label'
  group.add(body, head, marker, label)
  return group
}

function buildPig(): THREE.Group {
  const group = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.26, 16, 14),
    new THREE.MeshStandardMaterial({ color: 0xf2a7c3, roughness: 0.7 }),
  )
  body.scale.set(1.15, 0.95, 1)
  body.position.y = 0.3
  body.castShadow = true
  const snout = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 0.08, 10),
    new THREE.MeshStandardMaterial({ color: 0xe78bab, roughness: 0.8 }),
  )
  snout.rotation.x = Math.PI / 2
  snout.position.set(0, 0.3, 0.28)
  const earGeo = new THREE.ConeGeometry(0.07, 0.14, 6)
  const earMat = new THREE.MeshStandardMaterial({ color: 0xf2a7c3, roughness: 0.8 })
  const earL = new THREE.Mesh(earGeo, earMat)
  earL.position.set(-0.12, 0.52, 0.06)
  earL.rotation.z = 0.3
  const earR = new THREE.Mesh(earGeo, earMat)
  earR.position.set(0.12, 0.52, 0.06)
  earR.rotation.z = -0.3
  const die = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.18, 0.18),
    new THREE.MeshStandardMaterial({ color: 0xf5e6c4, roughness: 0.5 }),
  )
  die.position.y = 0.62
  die.rotation.set(0.4, 0.5, 0.2)
  group.add(body, snout, earL, earR, die)
  return group
}

function buildBomb(): THREE.Group {
  const group = new THREE.Group()
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(0.24, 14, 12),
    new THREE.MeshStandardMaterial({ color: 0x222a3e, roughness: 0.4 }),
  )
  ball.position.y = 0.26
  ball.castShadow = true
  const fuse = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xff7043, emissive: 0xff7043, emissiveIntensity: 0.9 }),
  )
  fuse.position.y = 0.55
  group.add(ball, fuse)
  return group
}

function buildWallet(): THREE.Group {
  const group = new THREE.Group()
  const pouch = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.24, 0.22),
    new THREE.MeshStandardMaterial({ color: 0xefc66d, roughness: 0.6 }),
  )
  pouch.position.y = 0.14
  pouch.castShadow = true
  const clasp = new THREE.Mesh(
    new THREE.TorusGeometry(0.07, 0.025, 6, 14),
    new THREE.MeshStandardMaterial({ color: 0xc9a352, roughness: 0.5 }),
  )
  clasp.position.y = 0.3
  group.add(pouch, clasp)
  return group
}

function buildGhost(): THREE.Group {
  const group = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.28, 16, 14),
    new THREE.MeshStandardMaterial({ color: 0xf4f6ff, transparent: true, opacity: 0.75, roughness: 0.3 }),
  )
  body.scale.y = 1.15
  body.position.y = 0.4
  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x2c3550 })
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 8), eyeMat)
  eyeL.position.set(-0.09, 0.46, 0.24)
  const eyeR = eyeL.clone()
  eyeR.position.x = 0.09
  group.add(body, eyeL, eyeR)
  return group
}

function buildStorm(): THREE.Group {
  const group = new THREE.Group()
  const sword = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.9, 4),
    new THREE.MeshStandardMaterial({ color: 0x7fb8e8, emissive: 0x3a88ff, emissiveIntensity: 0.35, roughness: 0.3 }),
  )
  sword.rotation.x = Math.PI
  sword.position.y = 0.75
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.5, 0.04, 8, 26),
    new THREE.MeshBasicMaterial({ color: 0x7fb8e8 }),
  )
  ring.rotation.x = Math.PI / 2
  ring.position.y = 0.08
  group.add(sword, ring)
  return group
}

function syncTiles() {
  if (!scene) return
  const seen = new Set<string>()
  for (const row of props.state.tiles) {
    for (const tile of row) {
      const key = cellKey(tile)
      seen.add(key)
      const existing = tileEntries.get(key)
      const signature = `${tile.kind}:${tile.dir ?? ''}:${tile.durability ?? ''}`
      if (existing && existing.kind === signature) continue
      if (existing) {
        scene.remove(existing.group)
        disposeGroup(existing.group)
      }
      const group = buildTileGroup(tile.kind, tile.dir, tile.durability)
      const pos = cellToWorld(tile)
      group.position.set(pos.x, 0, pos.z)
      scene.add(group)
      tileEntries.set(key, { group, kind: signature, dir: tile.dir, durability: tile.durability })
    }
  }
  for (const [key, entry] of tileEntries) {
    if (!seen.has(key)) {
      scene.remove(entry.group)
      disposeGroup(entry.group)
      tileEntries.delete(key)
    }
  }
}

function syncPlayers(deltaSeconds: number) {
  if (!scene) return
  const counts = new Map<string, number>()
  for (const player of props.state.players) {
    let group = playerMeshes.get(player.id)
    if (!group) {
      group = buildPlayerGroup(player.name, player.pieceColor)
      scene.add(group)
      playerMeshes.set(player.id, group)
      group.position.copy(cellToWorld(player.cell))
    }
    const key = cellKey(player.cell)
    const index = counts.get(key) ?? 0
    counts.set(key, index + 1)
    const target = cellToWorld(player.cell, index)
    // 低倍速时放慢棋子跟随，让玩家能看清 AI 的移动结果。
    group.position.lerp(target, movementAlpha(deltaSeconds, props.animationSpeed ?? 0.6))
    const marker = group.getObjectByName('active-marker')
    if (marker) marker.visible = player.id === props.state.players[props.state.activeIndex]?.id
    const label = group.getObjectByName('player-label')
    if (label) label.visible = player.id === props.state.players[props.state.activeIndex]?.id
  }
}

function syncEntitySet(
  meshMap: Map<string, THREE.Group>,
  entries: Array<{ id: number | string; cell: Cell }>,
  builder: () => THREE.Group,
  prefix: string,
) {
  if (!scene) return
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = `${prefix}-${entry.id}`
    seen.add(key)
    let group = meshMap.get(key)
    if (!group) {
      group = builder()
      scene.add(group)
      meshMap.set(key, group)
    }
    const pos = cellToWorld(entry.cell, prefix === 'pig' ? 1 : 0)
    group.position.lerp(pos, 0.25)
  }
  for (const [key, group] of meshMap) {
    if (!seen.has(key)) {
      scene.remove(group)
      disposeGroup(group)
      meshMap.delete(key)
    }
  }
}

function syncEntities() {
  syncEntitySet(entityMeshes, props.state.pigs, buildPig, 'pig')
  syncEntitySet(entityMeshes, props.state.bombs, buildBomb, 'bomb')
  syncEntitySet(entityMeshes, props.state.wallets, buildWallet, 'wallet')
  const ghostList = props.state.ghost ? [{ id: 'g', cell: props.state.ghost.cell }] : []
  syncEntitySet(ghostMeshes, ghostList, buildGhost, 'ghost')
  const stormList = props.state.storm ? [{ id: props.state.storm.id, cell: props.state.storm.cell }] : []
  syncEntitySet(ghostMeshes, stormList, buildStorm, 'storm')
}

function spawnAnimation(effect: { id: number; kind: string; from?: Cell; to?: Cell; cell?: Cell }) {
  if (!scene) return
  const now = performance.now()
  if (effect.kind === 'explosion' && effect.cell) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.06, 8, 30),
      new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.95 }),
    )
    ring.rotation.x = Math.PI / 2
    const pos = cellToWorld(effect.cell)
    ring.position.set(pos.x, 0.15, pos.z)
    scene.add(ring)
    animations.push({ obj: ring, kind: 'explosion', startMs: now, durationMs: 620 })
  } else if (effect.kind === 'projectile' && effect.from && effect.to) {
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0xfff4d5 }),
    )
    const from = cellToWorld(effect.from)
    const to = cellToWorld(effect.to)
    from.y = 0.5
    to.y = 0.5
    ball.position.copy(from)
    scene.add(ball)
    animations.push({ obj: ball, kind: 'projectile', startMs: now, durationMs: 360, from, to })
  } else if (effect.kind === 'punch' && effect.cell) {
    const flash = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.34, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    )
    flash.rotation.x = -Math.PI / 2
    const pos = cellToWorld(effect.cell)
    flash.position.set(pos.x, 0.5, pos.z)
    scene.add(flash)
    animations.push({ obj: flash, kind: 'flash', startMs: now, durationMs: 300 })
  } else if ((effect.kind === 'swap' || effect.kind === 'spawn' || effect.kind === 'airdrop') && effect.cell) {
    const color = effect.kind === 'swap' ? 0xc9a0e8 : 0x8fdfba
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.16, 0.3, 20),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    )
    ring.rotation.x = -Math.PI / 2
    const pos = cellToWorld(effect.cell)
    ring.position.set(pos.x, 0.2, pos.z)
    scene.add(ring)
    animations.push({ obj: ring, kind: 'flash', startMs: now, durationMs: 450 })
  }
}

const seenEffectIds = new Set<number>()

function syncEffects() {
  for (const effect of props.state.effects) {
    if (!seenEffectIds.has(effect.id)) {
      seenEffectIds.add(effect.id)
      spawnAnimation(effect)
    }
  }
}

function updateHighlights() {
  const highlighted = new Set(props.highlights.map(cellKey))
  for (const [key, entry] of tileEntries) {
    const material = entry.group.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh | undefined
    const isHighlighted = highlighted.has(key)
    entry.group.position.y = isHighlighted ? 0.1 : 0
    if (material && material instanceof THREE.Mesh) {
      const m = material.material as THREE.MeshStandardMaterial
      if (m.emissive) {
        m.emissive.set(isHighlighted ? 0x3a88ff : 0x000000)
        m.emissiveIntensity = isHighlighted ? 0.28 : 0
      }
    }
  }
}

function advanceAnimations(now: number) {
  for (let i = animations.length - 1; i >= 0; i--) {
    const anim = animations[i]
    const t = (now - anim.startMs) / anim.durationMs
    if (t >= 1) {
      scene?.remove(anim.obj)
      disposeGroup(anim.obj)
      animations.splice(i, 1)
      continue
    }
    if (anim.kind === 'explosion') {
      anim.obj.scale.setScalar(1 + t * 2.4)
      const mat = (anim.obj as THREE.Mesh).material as THREE.MeshBasicMaterial
      mat.opacity = 0.95 * (1 - t)
    } else if (anim.kind === 'projectile' && anim.from && anim.to) {
      anim.obj.position.lerpVectors(anim.from, anim.to, t)
      anim.obj.position.y = 0.5 + Math.sin(t * Math.PI) * 0.5
    } else if (anim.kind === 'flash') {
      anim.obj.scale.setScalar(1 + t * 1.2)
      const mat = (anim.obj as THREE.Mesh).material as THREE.MeshBasicMaterial
      mat.opacity = 0.9 * (1 - t)
    }
  }
}

function updateCamera() {
  if (!camera) return
  // 对目标值做阻尼跟随，让拖动和滚轮缩放保持连贯。
  camRadius += (desiredCamRadius - camRadius) * 0.18
  lookTarget.lerp(desiredLookTarget, 0.22)
  const y = camRadius * Math.sin(camPitch)
  const flat = camRadius * Math.cos(camPitch)
  camera.position.set(
    flat * Math.sin(camYaw) + lookTarget.x,
    y,
    flat * Math.cos(camYaw) + lookTarget.z,
  )
  camera.lookAt(lookTarget)
}

function fittedCameraRadius(): number {
  if (!camera) return baseCamRadius
  const fitted = calculateBoardFitRadius({
    boardWidth: props.state.width,
    boardHeight: props.state.height,
    yaw: camYaw,
    pitch: camPitch,
    verticalFov: THREE.MathUtils.degToRad(camera.fov),
    aspect: camera.aspect,
    boardMargin: 0,
    objectHeight: 0.7,
    padding: 1.02,
  })
  return Math.min(maxCamRadius, Math.max(minCamRadius, fitted))
}

function fitToView(instant = false) {
  userZoomed = false
  desiredLookTarget.set(0, 0, 0)
  desiredCamRadius = fittedCameraRadius()
  if (instant) {
    lookTarget.copy(desiredLookTarget)
    camRadius = desiredCamRadius
  }
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  ;(event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
  dragStart = { x: event.clientX, y: event.clientY }
  dragMoved = false
  panning.value = true
}

function onPointerMove(event: PointerEvent) {
  if (!dragStart) return
  const dx = event.clientX - dragStart.x
  const dy = event.clientY - dragStart.y
  if (Math.abs(dx) + Math.abs(dy) > 6) dragMoved = true
  if (dragMoved) {
    const speed = desiredCamRadius * 0.0022
    const screenRight = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw))
    const screenUp = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw))
    desiredLookTarget.addScaledVector(screenRight, -dx * speed)
    desiredLookTarget.addScaledVector(screenUp, dy * speed)

    const maxX = props.state.width * 0.65
    const maxZ = props.state.height * 0.65
    desiredLookTarget.x = Math.max(-maxX, Math.min(maxX, desiredLookTarget.x))
    desiredLookTarget.z = Math.max(-maxZ, Math.min(maxZ, desiredLookTarget.z))
    dragStart = { x: event.clientX, y: event.clientY }
  }
}

function onPointerUp(event: PointerEvent) {
  const wasDrag = dragMoved
  dragStart = null
  dragMoved = false
  panning.value = false
  const canvas = event.currentTarget as HTMLCanvasElement
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId)
  if (wasDrag || !host.value || !camera) return
  const rect = host.value.getBoundingClientRect()
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
  const meshes: THREE.Object3D[] = []
  for (const entry of tileEntries.values()) meshes.push(entry.group)
  const hits = raycaster.intersectObjects(meshes, true)
  if (!hits.length) return
  let obj: THREE.Object3D | null = hits[0].object
  while (obj && !obj.userData.cell) obj = obj.parent
  if (obj?.userData.cell) emit('select', obj.userData.cell as Cell)
}

function onPointerCancel() {
  dragStart = null
  dragMoved = false
  panning.value = false
}

function onWheel(event: WheelEvent) {
  event.preventDefault()
  userZoomed = true
  desiredCamRadius = Math.min(
    maxCamRadius,
    Math.max(minCamRadius, desiredCamRadius + event.deltaY * 0.012),
  )
}

function assignCellUserData() {
  for (const row of props.state.tiles) {
    for (const tile of row) {
      const entry = tileEntries.get(cellKey(tile))
      if (entry) entry.group.userData.cell = { x: tile.x, y: tile.y }
    }
  }
}

onMounted(() => {
  if (!host.value) return
  scene = new THREE.Scene()
  scene.background = new THREE.Color(0xf4edda)
  scene.fog = new THREE.Fog(0xf4edda, 24, 44)

  camera = new THREE.PerspectiveCamera(38, 1, 0.1, 120)
  updateCamera()

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  host.value.appendChild(renderer.domElement)

  const hemi = new THREE.HemisphereLight(0xfffaf0, 0xd8cba8, 1.5)
  scene.add(hemi)
  const sun = new THREE.DirectionalLight(0xfff2d9, 2.2)
  sun.position.set(6, 12, 7)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = -12
  sun.shadow.camera.right = 12
  sun.shadow.camera.top = 12
  sun.shadow.camera.bottom = -12
  scene.add(sun)

  const baseSize = Math.max(props.state.width, props.state.height) + 1.4
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(baseSize, 0.5, baseSize),
    new THREE.MeshStandardMaterial({ color: 0xe2d4b2, roughness: 0.95 }),
  )
  base.position.y = -0.32
  base.receiveShadow = true
  scene.add(base)

  syncTiles()
  assignCellUserData()
  syncEntities()

  resizeObserver = new ResizeObserver(() => {
    if (!host.value || !renderer || !camera) return
    const { clientWidth, clientHeight } = host.value
    camera.aspect = clientWidth / Math.max(clientHeight, 1)
    camera.updateProjectionMatrix()
    if (!userZoomed) {
      fitToView(true)
    }
    // 让 CSS 显示尺寸始终等于容器尺寸；像素比只提升内部绘制分辨率。
    renderer.setSize(clientWidth, clientHeight)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  })
  resizeObserver.observe(host.value)
  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove)
  renderer.domElement.addEventListener('pointerup', onPointerUp)
  renderer.domElement.addEventListener('pointercancel', onPointerCancel)
  renderer.domElement.addEventListener('wheel', onWheel, { passive: false })

  let previousFrame = performance.now()
  const animate = () => {
    frame = requestAnimationFrame(animate)
    const now = performance.now()
    syncPlayers((now - previousFrame) / 1000)
    previousFrame = now
    syncEntities()
    advanceAnimations(now)
    const t = now * 0.002
    let i = 0
    for (const group of playerMeshes.values()) {
      group.rotation.y = Math.sin(t + i) * 0.1
      i++
    }
    updateCamera()
    renderer?.render(scene!, camera!)
  }
  animate()
})

watch(
  () => props.state.tiles,
  () => {
    syncTiles()
    assignCellUserData()
    updateHighlights()
  },
  { deep: true },
)

watch(
  () => props.highlights,
  () => updateHighlights(),
  { deep: true },
)

watch(
  () => props.state.effects.length,
  () => syncEffects(),
)

watch(
  () => [props.state.players[props.state.activeIndex]?.id],
  () => updateHighlights(),
)

onBeforeUnmount(() => {
  cancelAnimationFrame(frame)
  resizeObserver?.disconnect()
  renderer?.domElement.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('pointermove', onPointerMove)
  renderer?.domElement.removeEventListener('pointerup', onPointerUp)
  renderer?.domElement.removeEventListener('pointercancel', onPointerCancel)
  renderer?.domElement.removeEventListener('wheel', onWheel)
  for (const entry of tileEntries.values()) disposeGroup(entry.group)
  for (const group of playerMeshes.values()) disposeGroup(group)
  for (const group of entityMeshes.values()) disposeGroup(group)
  for (const group of ghostMeshes.values()) disposeGroup(group)
  for (const texture of terrainTextures.values()) texture.dispose()
  terrainTextures.clear()
  renderer?.dispose()
})

defineExpose({ fitToView })
</script>

<template>
  <div ref="host" class="board-canvas" :class="{ panning }" aria-label="三维竞速棋盘"></div>
</template>
