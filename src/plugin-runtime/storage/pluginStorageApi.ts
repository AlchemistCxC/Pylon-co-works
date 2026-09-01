/**
 * pluginStorageApi — PluginStorageApi 的宿主实现。
 *
 * 持久化：localStorage 单键 `pylon-plugin-storage`（模块级缓存，同步读写）；
 * localStorage 不可用（测试/禁储环境）回退进程内存。
 * 配额：每插件序列化体积软上限（PER_PLUGIN_BUDGET_BYTES），超限抛错。
 */
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginStorageApi } from './pluginStorageTypes.ts'

export const PLUGIN_STORAGE_BUDGET_BYTES = 1024 * 1024
const STORE_KEY = 'pylon-plugin-storage'

export class PluginStorageError extends Error {
  readonly code = 'plugin_storage_error'

  constructor(readonly field: string, message: string) {
    super(message)
    this.name = 'PluginStorageError'
  }
}

type StorageTree = Record<string, Record<string, unknown>>

let cache: StorageTree | null = null

function loadTree(): StorageTree {
  if (cache) return cache
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    cache = raw ? (JSON.parse(raw) as StorageTree) : {}
  } catch {
    cache = {}
  }
  return cache
}

function persistTree(tree: StorageTree): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(tree))
  } catch (error) {
    throw new PluginStorageError(
      'persist',
      `持久化失败（可能是磁盘配额）：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function createPluginStorageApi(identity: PluginIdentity): PluginStorageApi {
  const listeners = new Set<() => void>()
  const notify = (): void => { listeners.forEach(listener => listener()) }
  const namespace = (): Record<string, unknown> => {
    const tree = loadTree()
    tree[identity.pluginId] ??= {}
    return tree[identity.pluginId]!
  }

  return {
    getValue<T = unknown>(key: string): T | undefined {
      return namespace()[key] as T | undefined
    },
    setValue(key: string, value: unknown): void {
      // 先在候选树上做预算检查，通过后才提交——超限不得留下半写入状态
      const tree = loadTree()
      const candidate = { ...(tree[identity.pluginId] ?? {}), [key]: structuredClone(value) }
      const size = JSON.stringify(candidate).length
      if (size > PLUGIN_STORAGE_BUDGET_BYTES) {
        throw new PluginStorageError(
          'quota',
          `插件 ${identity.pluginId} 存储超出软配额（${PLUGIN_STORAGE_BUDGET_BYTES} 字节）`,
        )
      }
      const next: StorageTree = { ...tree, [identity.pluginId]: candidate }
      persistTree(next)
      cache = next
      notify()
    },
    removeValue(key: string): void {
      delete namespace()[key]
      persistTree(loadTree())
      notify()
    },
    keys(): string[] {
      return Object.keys(namespace())
    },
    clear(): void {
      loadTree()[identity.pluginId] = {}
      persistTree(loadTree())
      notify()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
