import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EMPTY_BLOCK_COLLAPSE,
  normalizeBlockCollapse,
  readBlockCollapse,
  resetBlockCollapse,
  SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY,
  sidebarBlockCollapseStore,
  writeBlockCollapse,
} from '../sidebarBlockCollapse.ts'

const storage = () => localStorage

beforeEach(() => {
  localStorage.clear()
  resetBlockCollapse()
})

afterEach(() => {
  localStorage.clear()
  resetBlockCollapse()
})

describe('左栏模块折叠偏好（跨 Sheet 应用级，issue #202）', () => {
  it('normalize 只收非空 id 的布尔条目，未知形状回落空映射', () => {
    expect(normalizeBlockCollapse(undefined)).toEqual({})
    expect(normalizeBlockCollapse('nope')).toEqual({})
    expect(normalizeBlockCollapse({ collapsed: 'nope' })).toEqual({})
    expect(normalizeBlockCollapse({ collapsed: { mod: true, '': false, bad: 'yes', ok: false } }))
      .toEqual({ mod: true, ok: false })
  })

  it('setCollapseMap 落库到独立 key；读取同一 key 还原同一映射', () => {
    sidebarBlockCollapseStore.setCollapseMap({ mod: true, sessions: false })
    expect(JSON.parse(localStorage.getItem(SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY)!))
      .toEqual({ collapsed: { mod: true, sessions: false } })
    expect(readBlockCollapse(storage())).toEqual({ mod: true, sessions: false })
  })

  it('重启恢复：模块重新加载时从持久化 key 读回折叠映射（应用级偏好的语义）', async () => {
    sidebarBlockCollapseStore.setCollapseMap({ mod: true })
    vi.resetModules()
    const fresh = await import('../sidebarBlockCollapse.ts')
    expect(fresh.sidebarBlockCollapseStore.getSnapshot()).toEqual({ mod: true })
    // 恢复现场：后续用例与本文件的顶层单例各自独立。
    fresh.resetBlockCollapse()
  })

  it('持久化损坏/缺失回落空映射，不抛错', () => {
    localStorage.setItem(SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY, '{{{')
    expect(readBlockCollapse(storage())).toEqual(EMPTY_BLOCK_COLLAPSE)
    localStorage.setItem(SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY, JSON.stringify({ order: [] }))
    expect(readBlockCollapse(storage())).toEqual(EMPTY_BLOCK_COLLAPSE)
  })

  it('存储不可用时写盘静默失败，内存真值仍生效', () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error('quota') } }
    expect(() => writeBlockCollapse(broken, { mod: true })).not.toThrow()
  })

  it('订阅者在写入时收到通知，reset 回空并清库', () => {
    const seen: Array<Record<string, boolean>> = []
    const unsubscribe = sidebarBlockCollapseStore.subscribe(() => seen.push({ ...sidebarBlockCollapseStore.getSnapshot() }))
    sidebarBlockCollapseStore.setCollapseMap({ mod: true })
    unsubscribe()
    expect(seen).toEqual([{ mod: true }])

    resetBlockCollapse()
    expect(sidebarBlockCollapseStore.getSnapshot()).toEqual({})
    expect(localStorage.getItem(SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY)).toBe(JSON.stringify({ collapsed: {} }))
  })
})
