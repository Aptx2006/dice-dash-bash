import { createApp, h, reactive } from 'vue'
import GameScreen from '../../src/components/GameScreen.vue'
import { createGame } from '../../src/game/engine.ts'
import type { ToolId } from '../../src/game/types.ts'
import '../../src/style.css'

// 合成UI场景：不读取/保存玩家存档，不请求模型，也不进入真实房间。
const state = reactive(createGame({ mapId: 'race1', aiMode: 'rules', mechanisms: { airdrop: false, turnTimer: false }, players: [
  { name: '长昵称测试十二字以内', isAI: false, characterId: 'villager', pieceColor: '#f2a75c', isHost: true },
  { name: '测试机器人', isAI: true, characterId: 'russell', pieceColor: '#5f8d95', isHost: false },
] }))
state.phase = 'action'; state.dice = { move: 3, toolName: '钩锁' }
const cards: ToolId[] = ['hook', 'blink', 'bomb', 'basketball', 'sprint', 'wallet', 'teleport', 'punch']
state.players[0].hand = [{ uid: 99990, toolId: 'move', points: 3 }, ...Array.from({ length: 24 }, (_, i) => ({ uid: 100000 + i, toolId: cards[i % cards.length] })), { uid: 99991, toolId: 'end', system: true }]

const params = new URLSearchParams(location.search)
if (params.has('frame')) {
  createApp({ render: () => h(GameScreen, { state, myId: 'human', saveStatus: '合成UI测试 · 不保存', onExit: () => location.reload(), onRestart: () => location.reload() }) }).mount('#app')
} else {
  const sizes = { desktop: [1280, 720], mobile: [375, 812], landscape: [812, 375] }
  const selected = params.get('size') as keyof typeof sizes
  const [width, height] = sizes[selected] ?? sizes.desktop
  const root = document.querySelector('#app')!
  root.innerHTML = '<p style="padding:12px;margin:0">合成UI回归场景 · 26张手牌 · 不保存、不调用模型　<a href="?size=desktop">桌面</a>　<a href="?size=mobile">375竖屏</a>　<a href="?size=landscape">812横屏</a></p>'
  const frame = document.createElement('iframe')
  const metrics = document.createElement('p')
  metrics.style.cssText = 'margin:0;padding:4px 12px;font-size:12px;'
  metrics.setAttribute('role', 'status'); root.append(metrics)
  frame.title = '游戏测试视口'; frame.src = '/tests/browser/hand.html?frame=1'
  frame.style.cssText = `display:block;width:${width}px;height:${height}px;max-width:none;border:1px solid #888;margin:0 auto;`
  frame.addEventListener('load', () => {
    const document = frame.contentDocument!, view = frame.contentWindow!
    const board = document.querySelector<HTMLElement>('.board-wrap')!, hand = document.querySelector<HTMLElement>('.tool-hand')!
    const height = (selector: string) => Math.round(document.querySelector(selector)!.getBoundingClientRect().height)
    const report = () => { metrics.textContent = `视口 ${view.innerWidth}×${view.innerHeight} · 棋盘 ${height('.board-wrap')}px · 手牌 ${height('.tool-hand')}px · 页面宽度 ${document.documentElement.scrollWidth}px` }
    const observer = new ResizeObserver(report); observer.observe(board); observer.observe(hand); report()
  })
  root.append(frame)
}
