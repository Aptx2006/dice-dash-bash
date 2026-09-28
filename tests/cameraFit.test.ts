import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateBoardFitRadius } from '../src/rendering/cameraFit.ts'

const base = {
  boardWidth: 10,
  boardHeight: 10,
  yaw: 8 * Math.PI / 180,
  pitch: 54 * Math.PI / 180,
  verticalFov: 38 * Math.PI / 180,
}

test('相机适配：窄屏需要比宽屏拉得更远', () => {
  const wide = calculateBoardFitRadius({ ...base, aspect: 16 / 9 })
  const narrow = calculateBoardFitRadius({ ...base, aspect: 3 / 4 })
  assert.ok(narrow > wide)
})

test('相机适配：更大的棋盘需要更远的镜头距离', () => {
  const small = calculateBoardFitRadius({ ...base, aspect: 16 / 9 })
  const large = calculateBoardFitRadius({
    ...base,
    boardWidth: 16,
    boardHeight: 14,
    aspect: 16 / 9,
  })
  assert.ok(large > small)
})

test('相机适配：计算距离能够容纳水平和纵向投影', () => {
  const padding = 1.12
  const aspect = 16 / 9
  const radius = calculateBoardFitRadius({ ...base, aspect, padding })
  const halfX = base.boardWidth / 2 + 0.7
  const halfZ = base.boardHeight / 2 + 0.7
  const horizontalExtent =
    halfX * Math.abs(Math.cos(base.yaw)) +
    halfZ * Math.abs(Math.sin(base.yaw))
  const verticalExtent =
    (halfX * Math.abs(Math.sin(base.yaw)) +
      halfZ * Math.abs(Math.cos(base.yaw))) *
      Math.sin(base.pitch) +
    2.1 * Math.cos(base.pitch)
  const verticalTan = Math.tan(base.verticalFov / 2)

  assert.ok(radius * verticalTan * aspect >= horizontalExtent * padding)
  assert.ok(radius * verticalTan >= verticalExtent * padding)
})
