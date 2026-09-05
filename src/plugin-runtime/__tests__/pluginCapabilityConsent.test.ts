import { describe, expect, it, vi } from 'vitest'
import { bootstrapPluginDefinitions } from '../builtinPluginBootstrap.ts'
import { TestPluginRuntime } from '../testing/pluginRuntimeHarness.ts'
import { createPluginCapabilityGrantStore } from '../management/pluginCapabilityGrants.ts'
import { evaluatePluginCapabilityConsent } from '../management/pluginCapabilityConsent.ts'

describe('builtin capability consent flow (stage capability-consent)', () => {
  it('blocks activation with a retryable failure when consent is missing', async () => {
    const runtime = new TestPluginRuntime()
    const activate = vi.fn()
    const result = await bootstrapPluginDefinitions(runtime, [
      {
        id: 'plugin.manager',
        version: '1.0.0',
        capabilities: ['plugin.management'],
        activate,
      },
    ], 'normal', {
      evaluateConsent: definition => evaluatePluginCapabilityConsent({
        pluginId: definition.id,
        pluginVersion: definition.version ?? '0.0.0',
        capabilities: definition.capabilities,
        grants: createPluginCapabilityGrantStore({
          storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
        }),
      }),
    })

    expect(activate).not.toHaveBeenCalled()
    expect(result.failures).toEqual([
      expect.objectContaining({
        pluginId: 'plugin.manager',
        stage: 'capability-consent',
        code: 'plugin_capability_denied',
        retryable: true,
      }),
    ])
  })

  it('activates normally once the grant exists (retry after authorization)', async () => {
    const runtime = new TestPluginRuntime()
    const activate = vi.fn()
    const store = createPluginCapabilityGrantStore({
      storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    })
    store.grant('plugin.manager', 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })

    const result = await bootstrapPluginDefinitions(runtime, [
      {
        id: 'plugin.manager',
        version: '1.0.0',
        capabilities: ['plugin.management'],
        activate,
      },
    ], 'normal', {
      evaluateConsent: definition => evaluatePluginCapabilityConsent({
        pluginId: definition.id,
        pluginVersion: definition.version ?? '0.0.0',
        capabilities: definition.capabilities,
        grants: store,
      }),
    })

    expect(activate).toHaveBeenCalledOnce()
    expect(result.activePluginIds).toEqual(['plugin.manager'])
    expect(result.failures).toEqual([])
  })

  it('skips the check for plugins without declared capabilities', async () => {
    const runtime = new TestPluginRuntime()
    const activate = vi.fn()
    const result = await bootstrapPluginDefinitions(runtime, [
      { id: 'plugin.plain', activate },
    ], 'normal', {
      evaluateConsent: () => ({ status: 'awaiting_consent', missingCapabilities: ['plugin.management'] }),
    })
    expect(activate).toHaveBeenCalledOnce()
    expect(result.failures).toEqual([])
  })
})
