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
})
