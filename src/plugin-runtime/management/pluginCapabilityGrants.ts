import { reportRuntimeDiagnostic } from '../../runtimeError.ts'
import type { PylonPluginCapability } from '../packageManifest.ts'

/**
 * Host-owned capability grant store（API 1.2 能力授权模型，P53 D1）。
 *
 * 授权数据只存宿主 localStorage（key `pylon.plugin-capability-grants.v1`），
 * 不进任何插件可写的 PluginSettingsStore/storage API；插件 version 变更后
 * 旧授权失效（须重新同意）；卸载时由宿主调用 revoke 回收。存储不可用或
 * 内容损坏时全部 deny（fail-closed）并经 reportRuntimeDiagnostic 留诊断。
 */

export const PLUGIN_CAPABILITY_GRANTS_STORAGE_KEY = 'pylon.plugin-capability-grants.v1'

export interface PluginCapabilityGrantRecord {
  readonly grantedAt: number
  readonly pluginVersion: string
  readonly apiVersion: string
}

export type PluginCapabilityGrantMap = Readonly<
  Record<string, Readonly<Record<string, PluginCapabilityGrantRecord>>>
>

export interface PluginCapabilityGrantStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface PluginCapabilityGrantStoreOptions {
  /** 默认 window.localStorage；测试注入内存实现。显式传 null = 模拟存储不可用。 */
  storage?: PluginCapabilityGrantStorage | null
  /** 默认 reportRuntimeDiagnostic；测试注入采集。 */
  report?: (action: string, error: unknown) => void
  now?: () => number
}

export interface PluginCapabilityGrantStore {
  getGrant(
    pluginId: string,
    capability: PylonPluginCapability,
    pluginVersion: string,
  ): PluginCapabilityGrantRecord | undefined
  grant(
    pluginId: string,
    capability: PylonPluginCapability,
    input: { pluginVersion: string; apiVersion: string },
  ): void
  /** capability 省略时回收该插件全部授权（卸载路径）。 */
  revoke(pluginId: string, capability?: PylonPluginCapability): void
  subscribe(listener: () => void): () => void
  snapshot(): PluginCapabilityGrantMap
  readonly storageAvailable: boolean
}

function isGrantRecord(value: unknown): value is PluginCapabilityGrantRecord {
  return Boolean(value)
    && typeof value === 'object'
    && typeof (value as PluginCapabilityGrantRecord).grantedAt === 'number'
    && typeof (value as PluginCapabilityGrantRecord).pluginVersion === 'string'
    && typeof (value as PluginCapabilityGrantRecord).apiVersion === 'string'
}

function isGrantMap(value: unknown): value is PluginCapabilityGrantMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value).every(capabilities => (
    Boolean(capabilities)
    && typeof capabilities === 'object'
    && !Array.isArray(capabilities)
    && Object.values(capabilities).every(isGrantRecord)
  ))
}

export function createPluginCapabilityGrantStore(
  options: PluginCapabilityGrantStoreOptions = {},
): PluginCapabilityGrantStore {
  const report = options.report ?? ((action, error) => { reportRuntimeDiagnostic(action, error) })
  const now = options.now ?? (() => Date.now())
  const listeners = new Set<() => void>()
  let globalStorage: PluginCapabilityGrantStorage | undefined
  if (options.storage !== null) {
    try {
      // 存储被禁的 WebView 访问 localStorage 本身可抛 SecurityError
      globalStorage = typeof localStorage === 'undefined' ? undefined : localStorage
    } catch {
      globalStorage = undefined
    }
  }
  const storage = options.storage === null ? undefined : options.storage ?? globalStorage
  // 存储不可用 → 全部 deny（fail-closed）
  const available = storage !== undefined

  let grants: PluginCapabilityGrantMap = {}
  if (storage) {
    try {
      const raw = storage.getItem(PLUGIN_CAPABILITY_GRANTS_STORAGE_KEY)
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw)
        if (isGrantMap(parsed)) grants = parsed
        else report('解析插件能力授权存储', new Error('授权数据结构损坏，按无授权处理'))
      }
    } catch (error) {
      report('解析插件能力授权存储', error)
    }
  } else {
    report('读取插件能力授权存储', new Error('localStorage 不可用，能力授权全部拒绝'))
  }

  const publish = () => {
    for (const listener of [...listeners]) listener()
  }

  const persist = (next: PluginCapabilityGrantMap): boolean => {
    if (!storage) return false
    const previous = grants
    grants = next
    try {
      if (Object.keys(next).length === 0) storage.removeItem(PLUGIN_CAPABILITY_GRANTS_STORAGE_KEY)
      else storage.setItem(PLUGIN_CAPABILITY_GRANTS_STORAGE_KEY, JSON.stringify(next))
      return true
    } catch (error) {
      // 写失败（配额等）→ 回滚内存态，本次授权不生效（降级）
      grants = previous
      report('写入插件能力授权存储', error)
      return false
    }
  }

  return {
    get storageAvailable() {
      return available
    },
    getGrant(pluginId, capability, pluginVersion) {
      if (!available) return undefined
      const record = grants[pluginId]?.[capability]
      // 插件 version 变更 → 旧授权失效（须重新同意）
      if (!record || record.pluginVersion !== pluginVersion) return undefined
      return record
    },
    grant(pluginId, capability, input) {
      if (!available) return
      const persisted = persist({
        ...grants,
        [pluginId]: {
          ...(grants[pluginId] ?? {}),
          [capability]: {
            grantedAt: now(),
            pluginVersion: input.pluginVersion,
            apiVersion: input.apiVersion,
          },
        },
      })
      if (persisted) publish()
    },
    revoke(pluginId, capability) {
      if (!available) return
      const previous = grants[pluginId]
      if (!previous) return
      const next: Record<string, Readonly<Record<string, PluginCapabilityGrantRecord>>> = { ...grants }
      if (capability === undefined) {
        // 卸载路径：回收该插件全部授权
        delete next[pluginId]
      } else {
        if (!Object.hasOwn(previous, capability)) return
        const restCapabilities: Record<string, PluginCapabilityGrantRecord> = { ...previous }
        delete restCapabilities[capability]
        if (Object.keys(restCapabilities).length === 0) delete next[pluginId]
        else next[pluginId] = restCapabilities
      }
      if (persist(next)) publish()
    },
    subscribe(listener) {
      listeners.add(listener)
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        listeners.delete(listener)
      }
    },
    snapshot() {
      return grants
    },
  }
}
