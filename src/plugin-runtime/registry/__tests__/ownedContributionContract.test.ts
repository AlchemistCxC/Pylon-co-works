import { describe, expect, it, vi } from 'vitest'
import { ContextPanelRegistry } from '../../context-panel/contextPanelRegistry.ts'
import { PluginSettingsPageRegistry } from '../../settings/pluginSettingsRegistry.ts'
import { createPluginIdentity } from '../../pluginIdentity.ts'
import { createPluginSettingsValueAdapter, PluginSettingsStore } from '../../settings/pluginSettingsStore.ts'

describe.each([
  { namespace: 'context-panel' as const, create: () => new ContextPanelRegistry() },
  { namespace: 'plugin-page' as const, create: () => new PluginSettingsPageRegistry() },
])('$namespace ownership contract', ({ namespace, create }) => {
  it.each(['namespace', 'ownerPluginId', 'contributionId'] as const)(
    'rejects a mismatched %s in live and shadow registration without publishing', (field) => {
      const registry = create()
      const oldOwner = createPluginIdentity('plugin.old', 'old')
      const nextOwner = createPluginIdentity('plugin.next', 'next')
      const contribution = { id: 'shared', label: 'Settings', scope: 'global' as const,
        renderKind: 'isolated-surface' as const, surfaceId: 'test.surface' }
      registry.register(oldOwner, contribution)
      const before = registry.getSnapshot()
      const listener = vi.fn()
      registry.subscribe(listener)
      const adapter = createPluginSettingsValueAdapter({
        store: new PluginSettingsStore(), namespace, ownerPluginId: nextOwner.pluginId, contributionId: contribution.id,
      })
      const invalid = { ...contribution, valueAdapter: { ...adapter, [field]: 'invalid' } }
      expect(() => registry.register(nextOwner, invalid)).toThrow(new RegExp(`adapter ${field}`))
      const transaction = registry.beginShadowTransaction(nextOwner, oldOwner.key)
      expect(() => transaction.register(invalid, { contributionId: 'shared' })).toThrow(new RegExp(`adapter ${field}`))
      expect(registry.getSnapshot()).toBe(before)
      expect(listener).not.toHaveBeenCalled()
      transaction.register({ ...contribution, valueAdapter: adapter }, { contributionId: 'shared' })
      transaction.commit()
      expect(registry.getSnapshot().entries[0].ownerPluginId).toBe(nextOwner.pluginId)
      expect(registry.getSnapshot().entries[0].value.valueAdapter).toBe(adapter)
      expect(listener).toHaveBeenCalledTimes(1)
      transaction.revert()
      expect(registry.getSnapshot().entries).toEqual(before.entries)
    },
  )
})
