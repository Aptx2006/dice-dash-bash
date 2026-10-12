import { MAPS, TUTORIAL_MAP } from './maps.ts'
import { CHARACTERS, AI_CHARACTER } from './characters.ts'
import type { GameConfig } from './types.ts'

export function validateNickname(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 12) {
    throw new Error('昵称必须为1至12个字符。')
  }
  return value.trim()
}

/** 在分配状态、随机资源和日志之前验证；失败不产生半成品对局。 */
export function validateGameConfig(config: GameConfig): void {
  if (!config || !Array.isArray(config.players) || config.players.length < 2 || config.players.length > 8) {
    throw new Error('玩家人数必须为2至8人。')
  }
  if (![TUTORIAL_MAP, ...MAPS].some(map => map.id === config.mapId)) throw new Error('地图不存在，请重新选择。')
  if (!config.mechanisms || typeof config.mechanisms.airdrop !== 'boolean' || typeof config.mechanisms.turnTimer !== 'boolean') {
    throw new Error('机制设置格式错误。')
  }
  for (const player of config.players) {
    if (!player) throw new Error('玩家配置格式错误。')
    validateNickname(player.name)
    if (![AI_CHARACTER, ...CHARACTERS].some(character => character.id === player.characterId)) throw new Error('角色不存在。')
    if (typeof player.isAI !== 'boolean' || typeof player.isHost !== 'boolean' || !/^#[0-9a-f]{6}$/i.test(player.pieceColor)) {
      throw new Error('玩家配置格式错误。')
    }
  }
}
