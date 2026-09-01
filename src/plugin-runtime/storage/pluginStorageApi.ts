/**
 * pluginStorageApi — PluginStorageApi 的宿主实现。
 *
 * 持久化：localStorage 单键 `pylon-plugin-storage`（模块级缓存，同步读写）；
 * localStorage 不可用（测试/禁储环境）回退进程内存。
 * 配额：每插件序列化体积软上限（PER_PLUGIN_BUDGET_BYTES），超限抛错。
 */
import type { PluginIdentity } from '../pluginIdentity.ts'
import type { PluginStorageApi } from './pluginStorageTypes.ts'
import { validatePluginKey } from '../settings/pluginKeyValidation.ts'
import { PLUGIN_STORAGE_BUDGET_BYTES, PluginStorageError } from './pluginStorageContract.ts'

export { PLUGIN_STORAGE_BUDGET_BYTES, PluginStorageError } from './pluginStorageContract.ts'
const STORE_KEY = 'pylon-plugin-storage'

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

function cloneValue(value: unknown, field: string): unknown {
  try {
    return structuredClone(value)
  } catch (error) {
    throw new PluginStorageError(
      field,
      `插件存储值必须可结构化克隆：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function serializedSize(value: unknown): number {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new PluginStorageError(
      'serialize',
      `插件存储值必须可 JSON 序列化：${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (serialized === undefined) throw new PluginStorageError('serialize', '插件存储值必须可 JSON 序列化')
  return new TextEncoder().encode(serialized).byteLength
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
      validatePluginKey(key, '插件存储')
      const values = namespace()
      if (!Object.hasOwn(values, key)) return undefined
      return cloneValue(values[key], 'read') as T
    },
    setValue(key: string, value: unknown): void {
      validatePluginKey(key, '插件存储')
      // 先在候选树上做预算检查，通过后才提交——超限不得留下半写入状态
      const tree = loadTree()
      const candidate = { ...(tree[identity.pluginId] ?? {}), [key]: cloneValue(value, 'value') }
      const size = serializedSize(candidate)
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
      validatePluginKey(key, '插件存储')
      const tree = loadTree()
      const current = tree[identity.pluginId] ?? {}
      if (!Object.hasOwn(current, key)) return
      const candidate = { ...current }
      delete candidate[key]
      const next: StorageTree = { ...tree, [identity.pluginId]: candidate }
      persistTree(next)
      cache = next
      notify()
    },
    keys(): string[] {
      return Object.keys(namespace())
    },
    clear(): void {
      const tree = loadTree()
      const next: StorageTree = { ...tree, [identity.pluginId]: {} }
      persistTree(next)
      cache = next
      notify()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
