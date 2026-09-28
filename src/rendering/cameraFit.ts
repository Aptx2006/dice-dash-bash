export interface CameraFitInput {
  boardWidth: number
  boardHeight: number
  yaw: number
  pitch: number
  verticalFov: number
  aspect: number
  objectHeight?: number
  boardMargin?: number
  padding?: number
}

/**
 * 计算固定透视相机完整容纳棋盘所需的最短距离。
 * 该函数不依赖 Three.js 或 DOM，可独立测试并复用于其他渲染器。
 */
export function calculateBoardFitRadius(input: CameraFitInput): number {
  const boardMargin = input.boardMargin ?? 0.7
  const objectHeight = input.objectHeight ?? 2.1
  const padding = input.padding ?? 1.12
  const halfX = input.boardWidth / 2 + boardMargin
  const halfZ = input.boardHeight / 2 + boardMargin

  const horizontalExtent =
    halfX * Math.abs(Math.cos(input.yaw)) +
    halfZ * Math.abs(Math.sin(input.yaw))
  const groundDepth =
    halfX * Math.abs(Math.sin(input.yaw)) +
    halfZ * Math.abs(Math.cos(input.yaw))
  const verticalExtent =
    groundDepth * Math.sin(input.pitch) +
    objectHeight * Math.cos(input.pitch)

  const verticalTan = Math.tan(input.verticalFov / 2)
  const horizontalTan = verticalTan * Math.max(input.aspect, 0.01)
  return Math.max(
    horizontalExtent / horizontalTan,
    verticalExtent / verticalTan,
  ) * padding
}
