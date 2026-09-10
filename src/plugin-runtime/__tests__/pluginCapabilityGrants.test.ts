import { describe, expect, it, vi } from 'vitest'
import {
  createPluginCapabilityGrantStore,
  type PluginCapabilityGrantStorage,
} from '../management/pluginCapabilityGrants.ts'

function memoryStorage(initial: Record<string, string> = {}): PluginCapabilityGrantStorage & {
  backing: Map<string, string>
} {
  const backing = new Map(Object.entries(initial))
  return {
    backing,
    getItem: key => backing.get(key) ?? null,
    setItem: (key, value) => { backing.set(key, value) },
    removeItem: key => { backing.delete(key) },
  }
}

describe('plugin capability grant store', () => {
  it('grants, reads back and persists a capability grant', () => {
    const storage = memoryStorage()
    const store = createPluginCapabilityGrantStore({ storage, now: () => 1234 })
    store.grant('plugin.a', 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })

    expect(store.getGrant('plugin.a', 'plugin.management', '1.0.0'))
      .toEqual(expect.objectContaining({ grantedAt: 1234, pluginVersion: '1.0.0', apiVersion: '1.2' }))
    const persisted = JSON.parse(storage.backing.get('pylon.plugin-capability-grants.v1') ?? '{}')
    expect(persisted['plugin.a']['plugin.management'].grantedAt).toBe(1234)
  })

  it('invalidates grants when the plugin version changes', () => {
    const store = createPluginCapabilityGrantStore({ storage: memoryStorage() })
    store.grant('plugin.a', 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })
    expect(store.getGrant('plugin.a', 'plugin.management', '1.1.0')).toBeUndefined()
  })

  it('revokes a single capability and recycles all grants on uninstall', () => {
    const store = createPluginCapabilityGrantStore({ storage: memoryStorage() })
    store.grant('plugin.a', 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })

    store.revoke('plugin.a', 'plugin.management')
    expect(store.getGrant('plugin.a', 'plugin.management', '1.0.0')).toBeUndefined()
    expect(store.snapshot()).toEqual({})

    store.grant('plugin.a', 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })
    store.revoke('plugin.a')
    expect(store.snapshot()).toEqual({})
  })

  it('reloads persisted grants from storage', () => {
    const seeded = memoryStorage({
      'pylon.plugin-capability-grants.v1': JSON.stringify({
        'plugin.a': { 'plugin.management': { grantedAt: 9, pluginVersion: '1.0.0', apiVersion: '1.2' } },
      }),
    })
    const store = createPluginCapabilityGrantStore({ storage: seeded })
    expect(store.getGrant('plugin.a', 'plugin.management', '1.0.0')?.grantedAt).toBe(9)
  })

  it('treats corrupted JSON as no grants and reports a diagnostic', () => {
    const report = vi.fn()
    const store = createPluginCapabilityGrantStore({
      storage: memoryStorage({ 'pylon.plugin-capability-grants.v1': '{oops' }),
      report,
    })
    expect(store.storageAvailable).toBe(true)
    expect(store.getGrant('plugin.a', 'plugin.management', '1.0.0')).toBeUndefined()
    expect(report).toHaveBeenCalledOnce()
  })

  it('denies everything when storage is unavailable (fail-closed)', () => {
    const report = vi.fn()
    const store = createPluginCapabilityGrantStore({ storage: null, report })
    expect(store.storageAvailable).toBe(false)
    store.grant('plugin.a', 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })
    expect(store.getGrant('plugin.a', 'plugin.management', '1.0.0')).toBeUndefined()
    expect(report).toHaveBeenCalledOnce()
  })

  it('rolls back the in-memory grant when persisting hits a quota error', () => {
    const backing = new Map<string, string>()
    const storage: PluginCapabilityGrantStorage = {
      getItem: key => backing.get(key) ?? null,
      setItem: () => { throw new Error('QuotaExceededError') },
      removeItem: key => { backing.delete(key) },
    }
    const report = vi.fn()
    const store = createPluginCapabilityGrantStore({ storage, report })
    store.grant('plugin.a', 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })
    expect(store.getGrant('plugin.a', 'plugin.management', '1.0.0')).toBeUndefined()
    expect(report).toHaveBeenCalledOnce()
  })

  it('notifies subscribers on grant and revoke', () => {
    const store = createPluginCapabilityGrantStore({ storage: memoryStorage() })
    const listener = vi.fn()
    store.subscribe(listener)
    store.grant('plugin.a', 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })
    store.revoke('plugin.a')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})
