import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const children: ChildProcess[] = []
let stopping = false

function stop(code: number) {
  if (stopping) return
  stopping = true
  process.exitCode = code
  for (const child of children) if (child.exitCode === null && !child.killed) child.kill('SIGTERM')
  // 仅终止本脚本创建的两个进程，不查杀其他已在运行的开发服务。
}

function start(name: string, args: string[]) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true })
  children.push(child)
  child.once('error', () => { console.error(`${name}启动失败，请检查本地Node环境。`); stop(1) })
  child.once('exit', code => {
    if (!stopping) { console.error(`${name}已退出，正在关闭本次启动的其他服务。`); stop(code || 1) }
  })
}

process.once('SIGINT', () => stop(0))
process.once('SIGTERM', () => stop(0))
console.log('正在启动《当骰一棒》：前端 http://127.0.0.1:5173/，AI服务 http://127.0.0.1:3001/')
start('AI服务', ['--env-file-if-exists=.env', 'server/index.ts'])
start('前端', ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '5173', '--strictPort'])
