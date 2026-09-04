import { describe, expect, it } from 'vitest'
import { createPluginSettingsValueAdapter, PluginSettingsStore } from '../pluginSettingsStore.ts'

describe('SettingsValueAdapter', () => {
  it('isolates page/panel values by ownerPluginId + contributionId', () => {
    const store = new PluginSettingsStore()
    const page = createPluginSettingsValueAdapter({ store, ownerPluginId: 'plugin.demo', contributionId: 'page.one', namespace: 'plugin-page' })
    const panel = createPluginSettingsValueAdapter({ store, ownerPluginId: 'plugin.demo', contributionId: 'panel.one', namespace: 'context-panel' })
    page.setValue('enabled', true)
    panel.setValue('enabled', false)
    expect(page.getSnapshot().values).toEqual({ enabled: true })
    expect(panel.getSnapshot().values).toEqual({ enabled: false })
  })

  it('reports monotonic revision and subscription updates', () => {
    const adapter = createPluginSettingsValueAdapter({ store: new PluginSettingsStore(), ownerPluginId: 'plugin.demo', contributionId: 'page.one', namespace: 'plugin-page' })
    const seen: number[] = []
    const unsubscribe = adapter.subscribe(() => seen.push(adapter.getSnapshot().revision))
    adapter.setValue('tone', 'amber')
    adapter.reset('tone')
    unsubscribe()
    expect(seen).toEqual([1, 2])
    expect(adapter.getSnapshot().unavailable).toEqual({})
  })

  it('returns a stable snapshot until a real mutation and observes external store updates', () => {
    const store = new PluginSettingsStore()
    const adapter = createPluginSettingsValueAdapter({ store, ownerPluginId: 'plugin.demo', contributionId: 'page.one', namespace: 'plugin-page' })
    const first = adapter.getSnapshot()
    expect(adapter.getSnapshot()).toBe(first)
    adapter.removeValue('missing')
    expect(adapter.getSnapshot()).toBe(first)
    const seen: number[] = []
    const stop = adapter.subscribe(() => seen.push(adapter.getSnapshot().revision))
    store.set('pylon:11:plugin.demo:8:page.one', 'external', 'value')
    expect(adapter.getSnapshot().values.external).toBe('value')
    expect(seen).toEqual([1])
    stop()
  })

  it('round-trips unavailable values without publishing failed/no-op removals', () => {
    const adapter = createPluginSettingsValueAdapter({ store: new PluginSettingsStore(), ownerPluginId: 'plugin.demo', contributionId: 'page.one', namespace: 'plugin-page' })
    const seen: number[] = []
    const stop = adapter.subscribe(() => seen.push(adapter.getSnapshot().revision))
    adapter.markUnavailable?.('tone', 'amber', 'option-removed', '候选已卸载')
    expect(adapter.getSnapshot().unavailable.tone).toMatchObject({ value: 'amber', code: 'option-removed' })
    adapter.restoreUnavailable?.('tone')
    expect(adapter.getSnapshot().values.tone).toBe('amber')
    expect(adapter.getSnapshot().unavailable).toEqual({})
    adapter.removeValue('missing')
    expect(seen).toEqual([1, 2])
    stop()
  })
})
