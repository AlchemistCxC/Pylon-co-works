import { describe, expect, it } from 'vitest'
import { createRendererSettingsStore } from '../rendererSettingsStore.ts'

describe('renderer settings override store', () => {
  it('按 namespace 持久化 user override，但 session preview 只存在内存', () => {
    const storage = new Map<string, string>()
    const fakeStorage: Storage = {
      get length() { return storage.size },
      clear() { storage.clear() },
      getItem(key) { return storage.get(key) ?? null },
      key(index) { return [...storage.keys()][index] ?? null },
      removeItem(key) { storage.delete(key) },
      setItem(key, value) { storage.set(key, value) },
    }
    const store = createRendererSettingsStore({ storage: fakeStorage, storageKey: 'test-renderer-settings' })
    store.setOverride('kind.content.markdown.density', 'roomy')
    store.setSessionPreview({ 'kind.content.markdown.density': 'compact' })
    expect(store.getSnapshot().values['kind.content.markdown.density']).toBe('roomy')
    expect(store.getSnapshot().sessionPreview['kind.content.markdown.density']).toBe('compact')
    expect(JSON.parse(storage.get('test-renderer-settings') ?? '{}')).not.toHaveProperty('sessionPreview')
    const restored = createRendererSettingsStore({ storage: fakeStorage, storageKey: 'test-renderer-settings' })
    expect(restored.getSnapshot().values['kind.content.markdown.density']).toBe('roomy')
    expect(restored.getSnapshot().sessionPreview).toEqual({})
  })

  it('只清理当前字段的 session preview，不影响同一拖动会话中的其他字段', () => {
    const store = createRendererSettingsStore()
    store.setSessionPreview({
      'slot.tools.maxWidth': 720,
      'slot.tools.maxHeight': 360,
    })
    store.clearSessionPreview('slot.tools.maxWidth')
    expect(store.getSnapshot().sessionPreview).toEqual({ 'slot.tools.maxHeight': 360 })
    store.clearSessionPreview()
    expect(store.getSnapshot().sessionPreview).toEqual({})
  })

  it('reset scope 同时清理对应 session preview，避免临时值继续遮蔽默认值', () => {
    const store = createRendererSettingsStore()
    store.setOverride('slot.tools.maxWidth', 720)
    store.setOverride('slot.tools.maxHeight', 360)
    store.setSessionPreview({
      'slot.tools.maxWidth': 840,
      'slot.tools.maxHeight': 420,
      'kind.content.markdown.fontSize': 16,
    })
    store.reset('slot.tools')
    expect(store.getSnapshot().values).not.toHaveProperty('slot.tools.maxWidth')
    expect(store.getSnapshot().sessionPreview).toEqual({ 'kind.content.markdown.fontSize': 16 })
    store.reset()
    expect(store.getSnapshot().sessionPreview).toEqual({})
  })

  it('remove/reset 保留 unavailable 原值供插件重装恢复', () => {
    const store = createRendererSettingsStore({ storage: undefined })
    store.setOverride('suite.missing.density', 'roomy')
    store.markUnavailable('suite.missing.density', 'roomy')
    store.reset('suite.missing')
    expect(store.getSnapshot().unavailable['suite.missing.density']).toBe('roomy')
  })

  it('schema migration 失败保留原值取证并记录 diagnostic', () => {
    const storage = new Map<string, string>([['migration', JSON.stringify({ version: 1, values: { 'kind.content.markdown.density': 'old' } })]])
    const fakeStorage = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    } as unknown as Storage
    const store = createRendererSettingsStore({ storage: fakeStorage, storageKey: 'migration', schemaVersion: 2, migrate: () => { throw new Error('bad migration') } })
    expect(store.getSnapshot().values).toEqual({})
    expect(store.getSnapshot().unavailable['kind.content.markdown.density']).toBe('old')
    expect(store.getSnapshot().diagnostics[0]).toMatchObject({ code: 'renderer.settings.migration_failed' })
  })
})
