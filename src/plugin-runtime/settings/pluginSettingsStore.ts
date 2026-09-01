import type { PluginSettingValue } from './pluginSettingsTypes.ts'
import { validatePluginKey } from './pluginKeyValidation.ts'

const STORAGE_KEY = 'pylon-plugin-settings-v1'

function cloneValue(value: PluginSettingValue): PluginSettingValue {
  const json = JSON.stringify(value)
  if (json === undefined) throw new Error('插件设置必须可 JSON 序列化')
  return JSON.parse(json) as PluginSettingValue
}

export class PluginSettingsStore {
  private hydrated = false
  private values: Record<string, Readonly<Record<string, PluginSettingValue>>> = {}
  private readonly listeners = new Map<string, Set<() => void>>()

  getSnapshot(pluginId: string): Readonly<Record<string, PluginSettingValue>> {
    this.hydrate()
    return this.values[pluginId] ?? Object.freeze({})
  }

  get(pluginId: string, key: string): PluginSettingValue | undefined {
    validatePluginKey(key, '插件设置')
    return this.getSnapshot(pluginId)[key]
  }

  set(pluginId: string, key: string, value: PluginSettingValue): void {
    validatePluginKey(key, '插件设置')
    const next = Object.freeze({ ...this.getSnapshot(pluginId), [key]: cloneValue(value) })
    this.values = { ...this.values, [pluginId]: next }
    this.persist()
    this.publish(pluginId)
  }

  remove(pluginId: string, key: string): void {
    validatePluginKey(key, '插件设置')
    const current = this.getSnapshot(pluginId)
    if (!(key in current)) return
    const next = { ...current }
    delete next[key]
    this.values = { ...this.values, [pluginId]: Object.freeze(next) }
    this.persist()
    this.publish(pluginId)
  }

  subscribe(pluginId: string, listener: () => void): () => void {
    const group = this.listeners.get(pluginId) ?? new Set()
    group.add(listener)
    this.listeners.set(pluginId, group)
    return () => {
      group.delete(listener)
      if (group.size === 0) this.listeners.delete(pluginId)
    }
  }

  private hydrate(): void {
    if (this.hydrated) return
    this.hydrated = true
    if (typeof localStorage === 'undefined') return
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<string, Record<string, PluginSettingValue>>
      this.values = Object.fromEntries(Object.entries(parsed).map(([pluginId, values]) => [pluginId, Object.freeze({ ...values })]))
    } catch {
      this.values = {}
    }
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values))
  }

  private publish(pluginId: string): void {
    for (const listener of [...(this.listeners.get(pluginId) ?? [])]) listener()
  }
}
