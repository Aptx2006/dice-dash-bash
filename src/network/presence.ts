import type { RoomMember } from './types.ts'

export function memberPresence(member: RoomMember | undefined, isSelf = false, localConnected = true): string {
  if (isSelf && !localConnected) return '本机离线'
  if (!member) return ''
  if (member.takeover) return 'AI代打'
  if (member.isAI) return '机器人'
  return member.connected ? isSelf ? '你 · 在线' : '在线' : '离线 · 等待重连'
}
