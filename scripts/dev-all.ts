import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'

const root = fileURLToPath(new URL('../', import.meta.url))
const children: ChildProcess[] = []
let stopping = false
const lan = process.argv.includes('--lan')
if (process.argv.slice(2).some(arg => arg !== '--lan')) throw new Error('支持的启动参数：--lan')
const addresses = [...new Set(Object.values(networkInterfaces()).flatMap(entries => (entries ?? [])
  .filter(entry => entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))
  .map(entry => entry.address)))]

function stop(code: number) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
  // 仅终止本脚本创建的两个进程，不查杀其他已在运行的开发服务。
}

function start(name: string, args: string[], env = process.env) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true, env })
  children.push(child)
  child.once('error', () => { console.error(`${name}启动失败，请检查本地Node环境。`); stop(1) })
  child.once('exit', code => {
    if (!stopping) { console.error(`${name}已退出，正在关闭本次启动的其他服务。`); stop(code || 1) }
  })
}

process.once('SIGINT', () => stop(0))
process.once('SIGTERM', () => stop(0))
console.log('正在启动《当骰一棒》：前端 http://127.0.0.1:5173/，AI与房间服务 http://127.0.0.1:3001/')
if (lan) {
  console.log('已选择局域网模式；同一可信网络内可通过以下地址访问，后端仍仅监听本机：')
  for (const address of addresses) console.log(`http://${address}:5173/`)
  if (!addresses.length) console.log('未发现私有IPv4地址，请检查网络连接。')
}
const origins = [process.env.GAME_ALLOWED_ORIGINS, ...(lan ? addresses.map(address => `http://${address}:5173`) : [])].filter(Boolean).join(',')
start('AI与房间服务', ['--env-file-if-exists=.env', 'server/index.ts'], { ...process.env, ...(lan ? { GAME_ALLOWED_ORIGINS: origins } : {}) })
start('前端', ['node_modules/vite/bin/vite.js', '--host', lan ? '0.0.0.0' : '127.0.0.1', '--port', '5173', '--strictPort'])
