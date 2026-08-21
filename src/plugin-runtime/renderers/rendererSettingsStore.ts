import type { RendererSettingValue } from './rendererSettingsTypes.ts'

export interface RendererSettingsStoreSnapshot {
  readonly schemaVersion: number
  readonly values: Readonly<Record<string, RendererSettingValue>>
  readonly unavailable: Readonly<Record<string, RendererSettingValue>>
  readonly sessionPreview: Readonly<Record<string, RendererSettingValue>>
  readonly diagnostics: readonly { readonly code: string; readonly message: string; readonly key?: string }[]
}

export interface RendererSettingsStoreOptions {
  readonly storage?: Storage
  readonly storageKey?: string
  readonly schemaVersion?: number
  readonly migrate?: (version: number, values: Readonly<Record<string, RendererSettingValue>>) => Readonly<Record<string, RendererSettingValue>>
}

export interface RendererSettingsStore {
  getSnapshot(): RendererSettingsStoreSnapshot
  subscribe(listener: () => void): () => void
  setOverride(key: string, value: RendererSettingValue): void
  removeOverride(key: string): void
  markUnavailable(key: string, value: RendererSettingValue): void
  restoreUnavailable(key: string): void
  setSessionPreview(values: Readonly<Record<string, RendererSettingValue>>): void
  reset(scope?: string): void
  clearDiagnostics(): void
}

const KEY_PATTERN = /^(kind|suite|slot)\.[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+$/
const DEFAULT_STORAGE_KEY = 'pylon-renderer-settings'

function freezeSnapshot(snapshot: RendererSettingsStoreSnapshot): RendererSettingsStoreSnapshot {
  return Object.freeze({
    ...snapshot,
    values: Object.freeze({ ...snapshot.values }),
    unavailable: Object.freeze({ ...snapshot.unavailable }),
    sessionPreview: Object.freeze({ ...snapshot.sessionPreview }),
    diagnostics: Object.freeze(snapshot.diagnostics.map(item => Object.freeze({ ...item }))),
  })
}

function readPersisted(storage: Storage | undefined, key: string): { version: number; values: Record<string, RendererSettingValue>; unavailable: Record<string, RendererSettingValue> } {
  if (!storage) return { version: 1, values: {}, unavailable: {} }
  try {
    const raw = storage.getItem(key)
    if (!raw) return { version: 1, values: {}, unavailable: {} }
    const parsed = JSON.parse(raw) as { version?: unknown; values?: unknown; unavailable?: unknown }
    const values = parsed.values && typeof parsed.values === 'object' && !Array.isArray(parsed.values) ? parsed.values as Record<string, RendererSettingValue> : {}
    const unavailable = parsed.unavailable && typeof parsed.unavailable === 'object' && !Array.isArray(parsed.unavailable) ? parsed.unavailable as Record<string, RendererSettingValue> : {}
    return { version: typeof parsed.version === 'number' ? parsed.version : 1, values, unavailable }
  } catch {
    return { version: 1, values: {}, unavailable: {} }
  }
}

export function createRendererSettingsStore(options: RendererSettingsStoreOptions = {}): RendererSettingsStore {
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY
  const persisted = readPersisted(options.storage, storageKey)
  let values = { ...persisted.values }
  let unavailable = { ...persisted.unavailable }
  const diagnostics: { code: string; message: string; key?: string }[] = []
  if (options.migrate && persisted.version !== (options.schemaVersion ?? 1)) {
    try {
      values = { ...options.migrate(persisted.version, values) }
    } catch (error) {
      unavailable = { ...unavailable, ...values }
      values = {}
      diagnostics.push({ code: 'renderer.settings.migration_failed', message: error instanceof Error ? error.message : String(error) })
    }
  }
  let sessionPreview: Record<string, RendererSettingValue> = {}
  let snapshot = freezeSnapshot({ schemaVersion: options.schemaVersion ?? 1, values, unavailable, sessionPreview, diagnostics })
  const listeners = new Set<() => void>()

  const persist = () => {
    if (!options.storage) return
    options.storage.setItem(storageKey, JSON.stringify({ version: snapshot.schemaVersion, values: snapshot.values, unavailable: snapshot.unavailable }))
  }
  const publish = () => {
    snapshot = freezeSnapshot({ schemaVersion: snapshot.schemaVersion, values, unavailable, sessionPreview, diagnostics })
    persist()
    for (const listener of [...listeners]) listener()
  }
  const assertKey = (key: string) => {
    if (!KEY_PATTERN.test(key)) throw new Error(`Renderer setting namespace 非法：${key}`)
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setOverride(key, value) {
      assertKey(key)
      values = { ...values, [key]: value }
      delete unavailable[key]
      publish()
    },
    removeOverride(key) {
      assertKey(key)
      const next = { ...values }
      delete next[key]
      values = next
      publish()
    },
    markUnavailable(key, value) {
      assertKey(key)
      unavailable = { ...unavailable, [key]: value }
      publish()
    },
    restoreUnavailable(key) {
      assertKey(key)
      if (!(key in unavailable)) return
      values = { ...values, [key]: unavailable[key] }
      const next = { ...unavailable }
      delete next[key]
      unavailable = next
      publish()
    },
    setSessionPreview(next) {
      for (const key of Object.keys(next)) assertKey(key)
      sessionPreview = { ...next }
      // Preview is intentionally not persisted by publish().
      snapshot = freezeSnapshot({ schemaVersion: snapshot.schemaVersion, values, unavailable, sessionPreview, diagnostics })
      for (const listener of [...listeners]) listener()
    },
    reset(scope) {
      if (!scope) values = {}
      else values = Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith(`${scope}.`)))
      publish()
    },
    clearDiagnostics() {
      diagnostics.length = 0
      publish()
    },
  }
}

export const createRendererSettingsOverrideStore = createRendererSettingsStore
