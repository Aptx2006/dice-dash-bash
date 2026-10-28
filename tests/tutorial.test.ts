import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGame, isolatedSimulation, playEndCard, playRollCard, resolveMoveCard } from '../src/game/engine.ts'
import { aiStep } from '../src/game/ai.ts'
import { reconcileTutorialStep, tutorialFocus } from '../src/game/tutorial.ts'

function fixture() {
  return createGame({ mapId: 'tutorial', players: [
    { name: '新手', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
    { name: '教学机器人', isAI: true, characterId: 'robot', pieceColor: '#5f8d95', isHost: false },
  ], mechanisms: { airdrop: false, turnTimer: false } })
}

test('教学完整一轮：投骰、选择方向、移动、结束两阶段、机器人返回或完赛', () => {
  isolatedSimulation(() => {
    const state = fixture()
    assert.equal(reconcileTutorialStep(0, state), 0)
    assert.equal(tutorialFocus(0), null)
    playRollCard(state)
    assert.equal(reconcileTutorialStep(1, state), 2)
    assert.equal(tutorialFocus(2), 'move')
    assert.equal(tutorialFocus(3), 'move')
    assert.equal(reconcileTutorialStep(3, state), 3)
    resolveMoveCard(state, 'right')
    assert.equal(reconcileTutorialStep(3, state), 4)
    assert.equal(tutorialFocus(4), 'end')
    playEndCard(state)
    assert.equal(reconcileTutorialStep(4, state), 5)
    playEndCard(state)
    assert.equal(reconcileTutorialStep(5, state), 6)
    assert.equal(tutorialFocus(6), null)
    for (let count = 0; count < 30 && !state.finished && state.players[state.activeIndex]!.isAI; count++) assert.ok(aiStep(state))
    assert.equal(reconcileTutorialStep(6, state), 7)
    assert.equal(tutorialFocus(7), null)
  })
})

test('恢复旧教学的跳步局面时按实际阶段继续，普通对局不受引导约束', () => {
  const state = fixture()
  playRollCard(state); playEndCard(state)
  assert.equal(reconcileTutorialStep(2, state), 5, '旧版本提前结束的局面也能交出回合')
  playEndCard(state)
  assert.equal(reconcileTutorialStep(3, state), 6)
  state.activeIndex = 0; state.turnNumber = 3; state.phase = 'turnStart'
  assert.equal(reconcileTutorialStep(6, state), 7)
  assert.equal(reconcileTutorialStep(3, state), 1, '旧进度与回合开始不一致时重做投骰')
  state.finished = true; state.phase = 'finished'
  assert.equal(reconcileTutorialStep(6, state), 7)
  state.mapId = 'race1'
  assert.equal(reconcileTutorialStep(6, state), -1)
})
