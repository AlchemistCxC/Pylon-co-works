import { useSyncExternalStore } from 'react'

/**
 * 左栏模块的**折叠/展开**状态。
 *
 * 与 `sidebarBlockState` 里 Sheet 级的「当前整页」分开：把某个模块收起来是用户对
 * **左栏这个界面区域**的一次整理意图，不是某张 Sheet 的内容——放在每 Sheet 的状态里
 * 会导致切一张 Sheet 就换一套折叠，用户感知为「折叠状态没被记住」（issue #202）。
 *
 * 独立 localStorage key（与 `sidebarModulePrefs` 同一形状），**不写进 ADR-0009 锁定的
 * `pylon-workspace-layout-v3`**，避免动那个被契约钉住的持久化面。
 */

export const SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY = 'pylon-sidebar-block-collapse-v1'

/** 模块 id → 用户是否把它收起。显式映射两个方向都记得住（含「把默认塌陷的模块展开」）。 */
export type BlockCollapseMap = Readonly<Record<string, boolean>>

export const EMPTY_BLOCK_COLLAPSE: BlockCollapseMap = Object.freeze({})

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function normalizeBlockCollapse(raw: unknown): BlockCollapseMap {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw as { collapsed?: unknown }
    const entries = value.collapsed && typeof value.collapsed === 'object' && !Array.isArray(value.collapsed)
      ? Object.entries(value.collapsed as Record<string, unknown>)
        .filter(([id, isCollapsed]) => id.trim() !== '' && typeof isCollapsed === 'boolean')
      : []
    return Object.freeze(Object.fromEntries(entries as [string, boolean][]))
  }
  return EMPTY_BLOCK_COLLAPSE
}

export function readBlockCollapse(storage: StorageLike): BlockCollapseMap {
  try {
    const raw = storage.getItem(SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY)
    return raw == null ? EMPTY_BLOCK_COLLAPSE : normalizeBlockCollapse(JSON.parse(raw))
  } catch {
    return EMPTY_BLOCK_COLLAPSE
  }
}

export function writeBlockCollapse(storage: StorageLike, collapsed: BlockCollapseMap): void {
  try {
    storage.setItem(SIDEBAR_BLOCK_COLLAPSE_STORAGE_KEY, JSON.stringify({ collapsed: { ...collapsed } }))
  } catch {
    // 存储不可用：静默（内存态仍生效）
  }
}

interface BlockCollapseStore {
  readonly collapsed: BlockCollapseMap
  setCollapseMap(next: BlockCollapseMap): void
}

const listeners = new Set<() => void>()
let collapsed: BlockCollapseMap = typeof localStorage === 'undefined' ? EMPTY_BLOCK_COLLAPSE : readBlockCollapse(localStorage)

function emit(): void {
  for (const listener of listeners) listener()
}

/** 折叠状态是进程级单一真值：所有 Sheet 的左栏渲染与 CLI 命令共用它。 */
export const sidebarBlockCollapseStore: BlockCollapseStore & {
  subscribe(listener: () => void): () => void
  getSnapshot(): BlockCollapseMap
} = {
  get collapsed() { return collapsed },
  setCollapseMap(next) {
    collapsed = next
    if (typeof localStorage !== 'undefined') writeBlockCollapse(localStorage, next)
    emit()
  },
  subscribe(listener) {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot() { return collapsed },
}

/** 测试与「恢复默认」用：重置内存与持久化。 */
export function resetBlockCollapse(next: BlockCollapseMap = EMPTY_BLOCK_COLLAPSE): void {
  collapsed = next
  if (typeof localStorage !== 'undefined') writeBlockCollapse(localStorage, next)
  emit()
}

export function useSidebarBlockCollapse(): BlockCollapseMap {
  return useSyncExternalStore(
    listener => sidebarBlockCollapseStore.subscribe(listener),
    () => sidebarBlockCollapseStore.getSnapshot(),
    () => sidebarBlockCollapseStore.getSnapshot(),
  )
}
