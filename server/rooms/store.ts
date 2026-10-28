import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import { readRoomCheckpoint, type RoomCheckpoint } from './checkpoint.ts'

export interface RoomStore {
  readAll(): RoomCheckpoint[]
  put(checkpoint: RoomCheckpoint): void
  remove(id: string): void
  close(): void
}

/** 同步事务在响应/广播前提交；身份仅保存哈希，文件不在静态目录或Git中。 */
export class SqliteRoomStore implements RoomStore {
  private db: DatabaseSync
  private closed = false
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      try { chmodSync(path, 0o600) } catch { /* Windows沿用当前用户目录的ACL。 */ }
      // 生命周期内仅允许一个房间服务使用此数据库，避免多个独立内存状态覆盖彼此。
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      this.db.exec('CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, checkpoint TEXT NOT NULL)')
    } catch { this.db.close(); throw new Error('无法打开房间存储：请检查文件权限，或是否有其他服务正在使用同一数据库。原文件已保留。') }
  }
  readAll(): RoomCheckpoint[] {
    const rows = this.db.prepare('SELECT id, checkpoint FROM rooms ORDER BY id').all()
    if (rows.length > 32) throw new Error('房间存档数量超过当前版本上限，原文件已保留。')
    return rows.map(row => {
      const checkpoint = readRoomCheckpoint(String(row.checkpoint))
      if (checkpoint.id !== row.id) throw new Error('房间存档编号不一致，原文件已保留。')
      return checkpoint
    })
  }
  put(checkpoint: RoomCheckpoint) {
    const raw = JSON.stringify(checkpoint)
    if (raw.length > 2_000_000) throw new Error('房间存档过大。')
    this.db.prepare('INSERT INTO rooms (id, checkpoint) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET checkpoint=excluded.checkpoint').run(checkpoint.id, raw)
  }
  remove(id: string) { this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id) }
  close() { if (!this.closed) { this.closed = true; this.db.close() } }
}
