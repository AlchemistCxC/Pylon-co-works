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
    processOverview: vi.fn(async () => []),
    storageUsage: () => [],
    dependencyGraph: async () => [],
    terminatePluginProcess: vi.fn(async () => undefined),
    retryCleanup: vi.fn(async () => ({ complete: true })),
    clearPluginStorage: () => undefined,
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

  // review P0-2：retryCleanup 只能针对 cleanup-failed 实例，且不得绕过
  // self/product-required 守卫（runtimeOverview 暴露的 instanceKey 不是"任意停用"钥匙）
  it('restricts retryCleanup to cleanup-failed non-self non-product-required instances', async () => {
    const overview = {
      revision: 1,
      activePluginIds: ['builtin.pylon-shell', 'plugin.manager', 'plugin.other'],
      instances: [
        { pluginId: 'builtin.pylon-shell', runtimeInstanceId: 'shell#r1', version: '1.0.0', status: 'active' as const, builtin: true },
        { pluginId: 'plugin.other', runtimeInstanceId: 'other#r2', version: '1.0.0', status: 'active' as const, builtin: false },
        { pluginId: 'plugin.other', runtimeInstanceId: 'other#r3', version: '1.0.0', status: 'cleanup-failed' as const, builtin: false },
        { pluginId: 'builtin.pylon-workspace', runtimeInstanceId: 'ws#r4', version: '1.0.0', status: 'cleanup-failed' as const, builtin: true },
        { pluginId: 'plugin.manager', runtimeInstanceId: 'mgr#r5', version: '1.0.0', status: 'cleanup-failed' as const, builtin: false },
      ],
    }
    const retryCleanup = vi.fn(async () => ({ complete: true }))
    const api = make({
      deps: {
        runtimeOverview: () => overview,
        retryCleanup,
        isProductRequired: pluginId => pluginId === 'builtin.pylon-workspace',
      },
    })

    // 未知实例 → 拒绝
    await expect(api.retryCleanup('ghost#r9')).rejects.toThrow('未找到运行实例')
    // active 实例 → 拒绝（retryCleanup 不是停用通道）
    await expect(api.retryCleanup('other#r2')).rejects.toThrow('仅适用于清理失败')
    // cleanup-failed 但 product-required → 拒绝
    await expect(api.retryCleanup('ws#r4')).rejects.toMatchObject({ code: 'management_product_required' })
    // cleanup-failed 但目标是调用者自身 → 拒绝
    await expect(api.retryCleanup('mgr#r5')).rejects.toMatchObject({ code: 'management_self_locked' })
    // 合法目标 → 委派
    await expect(api.retryCleanup('other#r3')).resolves.toBeTruthy()
    expect(retryCleanup).toHaveBeenCalledWith('other#r3')
  })

  // review P1-2/A：setBuiltinEnabled(true) 必须对照激活结果判定，不得恒报成功
  it('reports setBuiltinEnabled(true) as failed when the retry does not activate', async () => {
    const setBuiltinEnabled = vi.fn(async (_pluginId: string, enabled: boolean) => {
      // 模拟 wiring 真实现：retry 后对照 snapshot
      if (enabled) {
        const nowActive = false
        if (!nowActive) return { ok: false, message: '插件 x 未能激活' }
      }
      return { ok: true }
    })
    const api = make({ deps: { setBuiltinEnabled } })
    await expect(api.setBuiltinEnabled('plugin.x', true)).rejects.toThrow('未能激活')
    expect(setBuiltinEnabled).toHaveBeenCalledWith('plugin.x', true)
  })
})
