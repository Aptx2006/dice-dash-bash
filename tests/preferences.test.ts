import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPreference, writePreference } from '../src/storage/preferences.ts'
import { validateNickname } from '../src/game/configValidation.ts'

test('E4-09 偏好不存在使用默认值，写入后可读取', () => {
  const values=new Map<string,string>()
  const store=()=>({getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v)}})
  assert.equal(readPreference('speed','0.6',store).value,'0.6')
  assert.equal(writePreference('speed','1.75',store),'')
  assert.equal(readPreference('speed','0.6',store).value,'1.75')
})
test('E4-10 存储属性访问被禁止：读取降级、写入不抛异常并提示', () => {
  const blocked=()=>{throw new Error('SecurityError')}
  assert.equal(readPreference('name','玩家',blocked).value,'玩家')
  assert.match(readPreference('name','玩家',blocked).warning,/本次操作仍可继续/)
  assert.match(writePreference('speed','3',blocked),/本次操作仍可继续/)
})
test('E4-11 容量不足：写入失败仍返回可展示提示', () => {
  const full=()=>({getItem:()=>null,setItem:()=>{throw new Error('QuotaExceededError')}})
  assert.match(writePreference('name','小骰',full),/无法保存偏好/)
})
test('E4-12 昵称去空白并拒绝超长、非字符串输入', () => {
  assert.equal(validateNickname('  小骰  '),'小骰')
  assert.throws(()=>validateNickname('一'.repeat(13)),/1至12/)
  assert.throws(()=>validateNickname(null),/1至12/)
})
