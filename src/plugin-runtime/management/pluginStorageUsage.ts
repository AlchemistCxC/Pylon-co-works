/**
 * P53 D5 · 插件存储用量投影（运行时监管）。
 *
 * 数据源 = pluginStorageApi 的持久化树（localStorage 单键
 * `pylon-plugin-storage`，namespace 按 pluginId）；用量按序列化字节数
 * 计算（与 pluginStorageApi 的 serializedSize 同一语义），预算为
 * PLUGIN_STORAGE_BUDGET_BYTES。只读投影，清理走既有 clear/remove 语义。
 */
import { PLUGIN_STORAGE_BUDGET_BYTES } from '../storage/pluginStorageContract.ts'
import type { PluginStorageUsageEntry } from './pluginManagementTypes.ts'

const STORE_KEY = 'pylon-plugin-storage'

function loadTree(): Record<string, Record<string, unknown>> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(STORE_KEY)
    return raw ? JSON.parse(raw) as Record<string, Record<string, unknown>> : {}
  } catch {
    return {}
  }
}

function serializedSize(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
  } catch {
    return 0
  }
}

export function readPluginStorageUsage(): readonly PluginStorageUsageEntry[] {
  const tree = loadTree()
  return Object.keys(tree).sort().map(pluginId => {
    const namespace = tree[pluginId] ?? {}
    return {
      pluginId,
      usedBytes: serializedSize(namespace),
      budgetBytes: PLUGIN_STORAGE_BUDGET_BYTES,
      keyCount: Object.keys(namespace).length,
    }
  })
}

/** 清空指定插件的存储 namespace（既有 remove 语义，不涉其它插件）。 */
export function clearPluginStorageNamespace(pluginId: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return
    const tree = JSON.parse(raw) as Record<string, Record<string, unknown>>
    if (!Object.hasOwn(tree, pluginId)) return
    const next = { ...tree }
    delete next[pluginId]
    localStorage.setItem(STORE_KEY, JSON.stringify(next))
  } catch {
    // 损坏/不可写存储下清理尽力而为；容量投影按无授权处理同一降级语义
  }
}
