import { describe, it, expect } from 'vitest'
import {
  readDensity, writeDensity,
  readCollapsed, writeCollapsed,
  readPinned, writePinned, PINNED_LIMIT,
  visibleByDensity,
} from '../settingsChromeState.ts'

/** K-1：设置页 chrome 状态纯模块（localStorage 持久化 + 密度过滤谓词）。 */

describe('密度档', () => {
  it('缺省读出 standard', () => {
    expect(readDensity(() => null)).toBe('standard')
  })
  it('写入后按原值读出；非法值回退 standard', () => {
    const store = new Map<string,string>()
    const get = (k: string) => store.get(k) ?? null
    writeDensity('basic', (key, v) => store.set(key, v))
    expect(readDensity(get)).toBe('basic')
    store.set(DENSITY_KEY_FOR_TEST, JSON.stringify('alien'))
    expect(readDensity(get)).toBe('standard')
    store.set(DENSITY_KEY_FOR_TEST, 'alien-not-json')
    expect(readDensity(get)).toBe('standard')
  })
})

describe('折叠记忆', () => {
  it('空存储读出空 map；写多条后全量还原', () => {
    expect(readCollapsed(() => null)).toEqual({})
    const store = new Map<string,string>()
    writeCollapsed({ 'chat.字体': false, 'cc.外观风格': true }, (_k, v) => store.set(k2('collapse'), v))
    expect(readCollapsed(get2(store))).toEqual({ 'chat.字体': false, 'cc.外观风格': true })
  })
})

describe('收藏置顶', () => {
  it('上限 PINNED_LIMIT 截断且保序去重', () => {
    expect(PINNED_LIMIT).toBe(3)
    const store = new Map<string,string>()
    const ids = ['a','b','c','d','a']
    writePinned(ids, (_k, v) => store.set(k2('pinned'), v))
    expect(readPinned(get2(store))).toEqual(['a','b','c'])
  })
})

describe('密度过滤谓词 visibleByDensity', () => {
  const fBasic = { tier: 'basic' }
  const fAdv = { advanced: true }
  const fPlain = {}
  it("basic 档只显 tier:'basic'", () => {
    expect(visibleByDensity('basic', fBasic)).toBe(true)
    expect(visibleByDensity('basic', fAdv)).toBe(false)
    expect(visibleByDensity('basic', fPlain)).toBe(false)
  })
  it('standard 档隐 advanced、其余可见（存量行为零变化）', () => {
    expect(visibleByDensity('standard', fBasic)).toBe(true)
    expect(visibleByDensity('standard', fAdv)).toBe(false)
    expect(visibleByDensity('standard', fPlain)).toBe(true)
  })
  it('all 档全可见', () => {
    expect(visibleByDensity('all', fAdv)).toBe(true)
  })
})

const DENSITY_KEY_FOR_TEST = 'pylon-settings-density'
function k2(k: string) { return `pylon-settings-${k}` }
function get2(store: Map<string,string>) { return (key: string) => store.get(key) ?? null }
