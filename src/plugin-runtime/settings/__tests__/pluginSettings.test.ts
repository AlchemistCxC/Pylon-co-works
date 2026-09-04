// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { PluginSettingsPageRegistry } from '../pluginSettingsRegistry.ts'
import { PluginSettingsStore } from '../pluginSettingsStore.ts'
import { validatePluginSettingOptionsContribution } from '../pluginSettingOptionsRegistry.ts'

describe('plugin settings contracts', () => {
  beforeEach(() => localStorage.clear())

  it('settings page follows owner lifecycle and deterministic order', async () => {
    const registry = new PluginSettingsPageRegistry()
    const first = registry.register(createPluginIdentity('plugin.a', 'one'), {
      id: 'plugin.a.settings', label: 'A', order: 20, renderKind: 'isolated-surface', surfaceId: 'plugin.a.surface',
    })
    registry.register(createPluginIdentity('plugin.b', 'one'), {
      id: 'plugin.b.settings', label: 'B', order: 10, renderKind: 'isolated-surface', surfaceId: 'plugin.b.surface',
    })

    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['plugin.b.settings', 'plugin.a.settings'])
    await first.dispose()
    expect(registry.getSnapshot().entries.map(entry => entry.contributionId)).toEqual(['plugin.b.settings'])
  })

  it('persists JSON values by plugin namespace and publishes only its owner', () => {
    const store = new PluginSettingsStore()
    const a = vi.fn()
    const b = vi.fn()
    store.subscribe('plugin.a', a)
    store.subscribe('plugin.b', b)

    store.set('plugin.a', 'layout', { density: 'compact', glow: 2 })

    expect(store.get('plugin.a', 'layout')).toEqual({ density: 'compact', glow: 2 })
    expect(store.get('plugin.b', 'layout')).toBeUndefined()
    expect(a).toHaveBeenCalledOnce()
    expect(b).not.toHaveBeenCalled()
    expect(localStorage.getItem('pylon-plugin-settings-v1')).toContain('plugin.a')
  })

  it('accepts multi-segment legacy Kind targets without truncating owner identity', () => {
    expect(() => validatePluginSettingOptionsContribution({
      id: 'plugin.palette', target: 'kind.acme.widgets.chart.accent', upsert: [{ value: 'amber' }],
    })).not.toThrow()
  })

  it('normalizes structured targets to an unambiguous legacy string', () => {
    const normalized = validatePluginSettingOptionsContribution({
      id: 'plugin.palette.structured', target: { namespace: 'kind', ownerId: 'acme.widgets.chart', fieldKey: 'accent' }, upsert: [{ value: 'amber' }],
    })
    expect(normalized.target).toBe('kind.acme%2Ewidgets%2Echart.accent')
  })

  it('preserves ownerPluginId and Theme compatibility when normalizing targets', () => {
    const normalized = validatePluginSettingOptionsContribution({
      id: 'plugin.palette.owner',
      target: { namespace: 'kind', ownerPluginId: 'plugin.acme', ownerId: 'acme.widgets.chart', fieldKey: 'accent' },
      upsert: [{ value: 'amber' }],
    })
    expect(normalized.target).toBe('kind.plugin%2Eacme.acme%2Ewidgets%2Echart.accent')
    const theme = validatePluginSettingOptionsContribution({
      id: 'plugin.palette.theme',
      target: { namespace: 'theme', ownerId: 'theme', fieldKey: 'accent' },
      upsert: [{ value: 'amber' }],
    })
    expect(theme.target).toBe('theme.accent')
  })
})
