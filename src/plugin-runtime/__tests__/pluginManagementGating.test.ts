import { describe, expect, it, vi } from 'vitest'
import { TestPluginRuntime } from '../testing/pluginRuntimeHarness.ts'
import { createPluginCapabilityGrantStore } from '../management/pluginCapabilityGrants.ts'
import { createPluginManagementApiBound, PluginManagementError } from '../management/pluginManagementApi.ts'
import { evaluatePluginCapabilityConsent } from '../management/pluginCapabilityConsent.ts'
import type { PluginManagementDeps } from '../management/pluginManagementTypes.ts'

function grantStoreWith(pluginId = 'plugin.manager') {
  const store = createPluginCapabilityGrantStore({
    storage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  })
  store.grant(pluginId, 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })
  return store
}

function depsOverrides(overrides: Partial<PluginManagementDeps> = {}): PluginManagementDeps {
  return {
    listInstalled: vi.fn(async () => []),
    runtimeOverview: () => ({
      revision: 0,
      activePluginIds: [],
      instances: [],
    }),
    bootstrapOverview: () => ({
      state: 'ready' as const,
      activePluginIds: [],
      failures: [],
      skippedPluginIds: [],
    }),
    contractDiagnostics: () => ({ revision: 0, eligibleIds: [], diagnostics: [] }),
    contributionOverview: () => [],
    capabilityGrants: () => [],
    isCapabilityGranted: () => true,
    isProductRequired: () => false,
    setEnabled: vi.fn(async () => ({ ok: true })),
    reload: vi.fn(async () => ({ ok: true })),
    uninstall: vi.fn(async () => ({ ok: true })),
    installOrUpdate: vi.fn(async () => ({ ok: true })),
    setBuiltinEnabled: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }
}

describe('capability gating (C3: declared ∧ granted ⇔ management present)', () => {
  it('omits management when the manifest declares no capabilities', async () => {
    const runtime = new TestPluginRuntime()
    let saw: { management?: unknown } | undefined
    await runtime.activateBuiltin({
      id: 'plugin.plain',
      activate: context => { saw = context },
    })
    expect(saw && 'management' in saw).toBe(false)
  })

  it('omits management when capabilities are declared but not granted', async () => {
    const store = createPluginCapabilityGrantStore({
      storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    })
    const runtime = new TestPluginRuntime({
      createManagementApi: definition => (
        evaluatePluginCapabilityConsent({
          pluginId: definition.id,
          pluginVersion: definition.version ?? '0.0.0',
          capabilities: definition.capabilities,
          grants: store,
        }).status === 'granted'
          ? createPluginManagementApiBound({
            pluginId: definition.id,
            pluginVersion: definition.version ?? '0.0.0',
            deps: depsOverrides(),
          })
          : undefined
      ),
    })
    let saw: { management?: unknown } | undefined
    await runtime.activateBuiltin({
      id: 'plugin.manager',
      version: '1.0.0',
      capabilities: ['plugin.management'],
      activate: context => { saw = context },
    })
    expect(saw && 'management' in saw).toBe(false)
  })

  it('assembles management when declared and granted', async () => {
    const store = grantStoreWith()
    const runtime = new TestPluginRuntime({
      createManagementApi: definition => (
        evaluatePluginCapabilityConsent({
          pluginId: definition.id,
          pluginVersion: definition.version ?? '0.0.0',
          capabilities: definition.capabilities,
          grants: store,
        }).status === 'granted'
          ? createPluginManagementApiBound({
            pluginId: definition.id,
            pluginVersion: definition.version ?? '0.0.0',
            deps: depsOverrides(),
          })
          : undefined
      ),
    })
    let saw: { management?: unknown } | undefined
    await runtime.activateBuiltin({
      id: 'plugin.manager',
      version: '1.0.0',
      capabilities: ['plugin.management'],
      activate: context => { saw = context },
    })
    expect(saw && 'management' in saw).toBe(true)
    const management = saw?.management as { listInstalled?: unknown } | undefined
    expect(management && typeof management.listInstalled).toBe('function')
  })
})

describe('management guards (C4 typed errors)', () => {
  const make = (options: {
    callerId?: string
    callerVersion?: string
    deps?: Partial<PluginManagementDeps>
  } = {}) => createPluginManagementApiBound({
    pluginId: options.callerId ?? 'plugin.manager',
    pluginVersion: options.callerVersion ?? '1.0.0',
    deps: depsOverrides(options.deps),
  })

  it('rejects operations targeting the caller itself (management_self_locked)', async () => {
    const api = make()
    await expect(api.setEnabled('plugin.manager', false)).rejects.toMatchObject({
      name: 'PluginManagementError',
      code: 'management_self_locked',
      pluginId: 'plugin.manager',
    })
    await expect(api.reload('plugin.manager')).rejects.toMatchObject({ code: 'management_self_locked' })
    await expect(api.uninstall('plugin.manager')).rejects.toMatchObject({ code: 'management_self_locked' })
    await expect(api.setBuiltinEnabled('plugin.manager', false)).rejects.toMatchObject({ code: 'management_self_locked' })
  })

  it('rejects disabling a product-required builtin (management_product_required)', async () => {
    const api = make({ deps: { isProductRequired: pluginId => pluginId === 'builtin.pylon-shell' } })
    await expect(api.setEnabled('builtin.pylon-shell', false)).rejects.toMatchObject({
      code: 'management_product_required',
      pluginId: 'builtin.pylon-shell',
    })
    await expect(api.setBuiltinEnabled('builtin.pylon-shell', false)).rejects.toMatchObject({
      code: 'management_product_required',
    })
  })

  it('re-checks the grant on every call and throws management_not_authorized once invalid', async () => {
    const granted = { current: true }
    const api = make({ deps: { isCapabilityGranted: () => granted.current } })
    expect(api.runtimeOverview()).toBeTruthy()

    granted.current = false
    expect(() => api.runtimeOverview()).toThrow(PluginManagementError)
    expect(() => api.runtimeOverview()).toThrow(/授权已失效/)
    // 只读方法是同步 throw；异步方法（内部 assertAuthorized 先于 await）在
    // Promise 构造前同步抛出，同样表现为调用点异常
    let caughtList: unknown
    try {
      await api.listInstalled()
    } catch (error) {
      caughtList = error
    }
    expect(caughtList).toBeInstanceOf(PluginManagementError)
    expect((caughtList as PluginManagementError).code).toBe('management_not_authorized')
  })

  it('delegates operations to host deps and surfaces failures as errors', async () => {
    const setEnabled = vi.fn(async () => ({ ok: false, message: 'cleanup pending' }))
    const api = make({ deps: { setEnabled } })
    await expect(api.setEnabled('plugin.other', false)).rejects.toThrow('cleanup pending')
    expect(setEnabled).toHaveBeenCalledWith('plugin.other', false)
  })
})
