import { describe, expect, it } from 'vitest'
import {
  EMPTY_MODULE_PREFS,
  SIDEBAR_MODULES_STORAGE_KEY,
  applyModulePrefs,
  normalizeModulePrefs,
  readModulePrefs,
  reorderModuleIds,
  writeModulePrefs,
} from '../sidebarModulePrefs.ts'
import type { AgentSidebarContribution } from '../../../plugin-runtime/sidebar/sidebarTypes.ts'

const buildModule = (id: string, extra: Partial<AgentSidebarContribution> = {}) => ({
  id, label: id, renderKind: 'first-party-react' as const, component: () => null, ...extra,
} as AgentSidebarContribution)

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value) },
    raw: () => map.get(SIDEBAR_MODULES_STORAGE_KEY),
  }
}

describe('侧栏模块偏好', () => {
  it('未列出的模块按注册顺序接在已排序模块之后（新装模块落末尾，可预期）', () => {
    const modules = [buildModule('a'), buildModule('b'), buildModule('c')]
    expect(applyModulePrefs(modules, { order: ['c', 'a'], hidden: [] }).map(m => m.id)).toEqual(['c', 'a', 'b'])
    expect(applyModulePrefs(modules, EMPTY_MODULE_PREFS).map(m => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('隐藏生效，但 alwaysOpen 的模块不可隐藏', () => {
    const modules = [buildModule('a'), buildModule('sessions', { alwaysOpen: true })]
    expect(applyModulePrefs(modules, { order: [], hidden: ['a', 'sessions'] }).map(m => m.id)).toEqual(['sessions'])
  })

  it('alwaysOpen 的模块**钉在栈底**：用户拖拽写下的次序也不能把它挪到前面', () => {
    const modules = [buildModule('a'), buildModule('b'), buildModule('sessions', { alwaysOpen: true })]
    // 旧偏好 / 手改 localStorage 把常驻模块排在第一位 —— 收纳时纠正回栈底。
    expect(applyModulePrefs(modules, { order: ['sessions', 'a', 'b'], hidden: [] }).map(m => m.id))
      .toEqual(['a', 'b', 'sessions'])
    // 两个常驻模块：各自保持相对次序，整体仍然贴底。
    const two = [buildModule('p', { alwaysOpen: true }), buildModule('a'), buildModule('q', { alwaysOpen: true })]
    expect(applyModulePrefs(two, { order: [], hidden: [] }).map(m => m.id)).toEqual(['a', 'p', 'q'])
  })

  it('偏好里指向已卸载模块的 id 被忽略', () => {
    const modules = [buildModule('a')]
    expect(applyModulePrefs(modules, { order: ['gone', 'a'], hidden: ['gone'] }).map(m => m.id)).toEqual(['a'])
  })

  it('reorderModuleIds 把 from 移到 to 的位置；未知 id 或同位原样返回', () => {
    expect(reorderModuleIds(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
    expect(reorderModuleIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(reorderModuleIds(['a', 'b'], 'a', 'a')).toEqual(['a', 'b'])
    expect(reorderModuleIds(['a', 'b'], 'x', 'a')).toEqual(['a', 'b'])
  })

  it('损坏或旧形状回落空偏好，且读写往返稳定', () => {
    expect(normalizeModulePrefs(null)).toEqual(EMPTY_MODULE_PREFS)
    expect(normalizeModulePrefs({ order: 'nope', hidden: [1, 'a', 'a'] })).toEqual({ order: [], hidden: ['a'] })

    const storage = memoryStorage()
    expect(readModulePrefs(storage)).toEqual(EMPTY_MODULE_PREFS)
    writeModulePrefs(storage, { order: ['b', 'a'], hidden: ['a'] })
    expect(readModulePrefs(storage)).toEqual({ order: ['b', 'a'], hidden: ['a'] })

    const broken = memoryStorage({ [SIDEBAR_MODULES_STORAGE_KEY]: '{not json' })
    expect(readModulePrefs(broken)).toEqual(EMPTY_MODULE_PREFS)
  })
})
