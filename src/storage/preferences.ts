export const STORAGE_WARNING = '浏览器无法保存偏好，本次操作仍可继续；刷新后设置可能丢失。'
type Store = Pick<Storage, 'getItem' | 'setItem'>
type GetStore = () => Store
const browserStore: GetStore = () => window.localStorage

// 访问 localStorage 属性本身也可能抛 SecurityError，必须位于 try 内。
export function readPreference(key: string, fallback: string, getStore: GetStore = browserStore) {
  try { return { value: getStore().getItem(key) ?? fallback, warning: '' } }
  catch { return { value: fallback, warning: STORAGE_WARNING } }
}

export function writePreference(key: string, value: string, getStore: GetStore = browserStore): string {
  try { getStore().setItem(key, value); return '' }
  catch { return STORAGE_WARNING }
}
