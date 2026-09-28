import test from 'node:test'
import assert from 'node:assert/strict'
import { isDiceReveal, movementAlpha } from '../src/rendering/presentation.ts'

test('仅真正投骰进入行动阶段展示双骰，冲刺和回合切换不重播', () => {
  assert.equal(isDiceReveal('turnStart', 'action', 4, '冲刺'), true)
  assert.equal(isDiceReveal('action', 'action', 6, '冲刺'), false)
  assert.equal(isDiceReveal('turnEnd', 'turnStart', null, null), false)
  assert.equal(isDiceReveal('turnStart', 'action', null, null), false)
})

test('棋子移动在60Hz与144Hz下经过相同时间进度一致', () => {
  const remaining = (fps: number) => Math.pow(1 - movementAlpha(1 / fps, 0.6), fps)
  assert.ok(Math.abs(remaining(60) - remaining(144)) < 1e-10)
  assert.ok(movementAlpha(1 / 60, 3) > movementAlpha(1 / 60, 0.6))
})
