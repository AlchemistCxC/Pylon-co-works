// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountPluginManagerPanel } from '../panel/pluginManagerPanel.ts'
import { createPluginManagementApiBound } from '../../../../../plugin-runtime/management/pluginManagementApi.ts'
import type { PluginManagementDeps } from '../../../../../plugin-runtime/management/pluginManagementTypes.ts'
import type { InstalledPluginPackage } from '../../../../../infrastructure/plugins/pluginPackageClient.ts'

function mockManagementDeps(overrides: Partial<PluginManagementDeps> = {}): PluginManagementDeps & {
  calls: string[]
} {
  const calls: string[] = []
  const installed: InstalledPluginPackage[] = [{
    package: {
      pluginId: 'user.demo',
      version: '1.0.0',
      packageInstanceId: 'user.demo@1.0.0-pkg',
      manifest: {
        schema: 1, id: 'user.demo', name: 'Demo Plugin', version: '1.0.0', api: '1.0',
        kind: 'feature', web: { entry: './entry.js' },
      },
      files: [], totalBytes: 0, active: true,
    },
    enabled: true,
  }]
  return {
    calls,
    listInstalled: vi.fn(async () => {
      calls.push('listInstalled')
      return installed
    }),
    runtimeOverview: () => {
      calls.push('runtimeOverview')
      return {
        revision: 1,
        activePluginIds: ['builtin.pylon-shell', 'builtin.pylon-plugin-manager'],
        instances: [
          { pluginId: 'builtin.pylon-shell', runtimeInstanceId: 'builtin.pylon-shell@b1', version: '1.0.0', status: 'active' as const, builtin: true },
          { pluginId: 'builtin.pylon-plugin-manager', runtimeInstanceId: 'builtin.pylon-plugin-manager@1.0.0-m1', version: '1.0.0', status: 'active' as const, builtin: true },
          { pluginId: 'user.demo', runtimeInstanceId: 'user.demo@1.0.0-pkg#run-1', version: '1.0.0', status: 'cleanup-failed' as const, builtin: false },
        ],
      }
    },
    bootstrapOverview: () => ({
      state: 'ready' as const,
      activePluginIds: [],
      failures: [],
      skippedPluginIds: [],
    }),
    contractDiagnostics: () => ({
      revision: 0,
      eligibleIds: [],
      diagnostics: [],
    }),
    contributionOverview: () => [
      { pluginId: 'builtin.pylon-shell', contributions: { commands: ['shell.open'] }, total: 1 },
    ],
    capabilityGrants: () => [],
    processOverview: vi.fn(async () => [
      {
        processId: 'proc-1',
        pluginId: 'user.demo',
        runtimeInstanceId: 'user.demo@1.0.0-pkg#run-1',
        status: 'running' as const,
        restartAttempts: 1,
      },
    ]),
    storageUsage: () => [
      { pluginId: 'user.demo', usedBytes: 256, budgetBytes: 65536, keyCount: 3 },
    ],
    dependencyGraph: async () => [
      {
        pluginId: 'builtin.pylon-shell',
        kind: 'shell',
        version: '1.0.0',
        builtin: true,
        dependencies: ['builtin.pylon-tools'],
        optionalDependencies: [],
        conflicts: [],
      },
      {
        pluginId: 'user.demo',
        kind: 'feature',
        version: '1.0.0',
        builtin: false,
        dependencies: [],
        optionalDependencies: [],
        conflicts: ['other.demo'],
      },
    ],
    terminatePluginProcess: vi.fn(async () => undefined),
    retryCleanup: vi.fn(async () => ({ complete: true })),
    clearPluginStorage: () => undefined,
    isCapabilityGranted: () => true,
    isProductRequired: pluginId => pluginId === 'builtin.pylon-shell',
    setEnabled: vi.fn(async () => { calls.push('setEnabled'); return { ok: true } }),
    reload: vi.fn(async () => ({ ok: true })),
    uninstall: vi.fn(async () => ({ ok: true })),
    installOrUpdate: vi.fn(async () => ({ ok: true })),
    setBuiltinEnabled: vi.fn(async () => ({ ok: true })),
    ...overrides,
  }
}

/** 面板测试经真实 API 工厂构造（守卫 + ok→throw 语义一并被覆盖）。 */
function toApi(deps: PluginManagementDeps): ReturnType<typeof createPluginManagementApiBound> {
  return createPluginManagementApiBound({
    pluginId: 'builtin.pylon-plugin-manager',
    pluginVersion: '1.0.0',
    deps,
  })
}

describe('plugin manager panel (framework-free DOM)', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('renders the consent guide instead of manager UI when management is absent', () => {
    const container = document.createElement('div')
    document.body.append(container)

    const handle = mountPluginManagerPanel(container, {})

    expect(handle.root.querySelector('.pypm-consent-title')?.textContent).toBe('等待能力授权')
    expect(handle.root.querySelector('.pypm-group')).toBeNull()
    handle.dispose()
  })

  it('renders manager sections and delegates data reads through the management api', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const deps = mockManagementDeps()

    const handle = mountPluginManagerPanel(container, { management: toApi(deps) })

    await vi.waitFor(() => {
      expect(handle.root.querySelector('[data-plugin-id="user.demo"]')).not.toBeNull()
    })
    expect(deps.calls).toContain('listInstalled')
    expect(handle.root.querySelector('.pypm-overview')?.textContent).toContain('2 个运行中')
    expect(handle.root.querySelector('.pypm-overview')?.textContent).toContain('1 个用户插件')
    expect(handle.root.querySelectorAll('.pypm-group-title').length).toBeGreaterThanOrEqual(5)
    // review P1-2/B：内置组件区块只渲染 builtin 实例——用户插件不得混入
    expect(handle.root.querySelector('[data-builtin-id="builtin.pylon-shell"]')).not.toBeNull()
    expect(handle.root.querySelector('[data-builtin-id="user.demo"]')).toBeNull()
    handle.dispose()
  })

  it('delegates user plugin operations through the management api', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const deps = mockManagementDeps()
    const setEnabled = vi.fn(async () => ({ ok: true }))

    const handle = mountPluginManagerPanel(container, {
      management: toApi({ ...deps, setEnabled }),
    })

    await vi.waitFor(() => {
      expect(handle.root.querySelector('[data-plugin-id="user.demo"] button')).not.toBeNull()
    })
    const row = handle.root.querySelector('[data-plugin-id="user.demo"]')!
    const toggle = [...row.querySelectorAll('button')].find(button => button.textContent === '停用')!
    toggle.click()
    await vi.waitFor(() => {
      expect(setEnabled).toHaveBeenCalledWith('user.demo', false)
    })
    handle.dispose()
  })

  it('shows the contribution overview block after toggling 贡献清单', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const deps = mockManagementDeps()

    const handle = mountPluginManagerPanel(container, { management: toApi(deps) })

    const contributionButton = [...handle.root.querySelectorAll('button')]
      .find(button => button.textContent === '贡献清单')!
    contributionButton.click()
    await vi.waitFor(() => {
      expect(handle.root.querySelector('[data-contribution-plugin="builtin.pylon-shell"]')).not.toBeNull()
    })
    const row = handle.root.querySelector('[data-contribution-plugin="builtin.pylon-shell"]')!
    expect(row.textContent).toContain('commands x1')
    handle.dispose()
  })

  it('logs operation failures into the operation log section', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const deps = mockManagementDeps()
    const reload = vi.fn(async () => ({ ok: false, message: 'runtime 缺失' }))

    const handle = mountPluginManagerPanel(container, {
      management: toApi({ ...deps, reload }),
    })

    await vi.waitFor(() => {
      expect(handle.root.querySelector('[data-plugin-id="user.demo"]')).not.toBeNull()
    })
    const row = handle.root.querySelector('[data-plugin-id="user.demo"]')!
    const reloadButton = [...row.querySelectorAll('button')].find(button => button.textContent === '重载')!
    reloadButton.click()
    await vi.waitFor(() => {
      expect(handle.root.textContent).toContain('重载 user.demo失败：runtime 缺失')
    })
    handle.dispose()
  })

  // P53 D5：运行时监管区块（进程/存储配额/依赖关系）
  it('renders supervision blocks: processes, storage quota and dependency graph', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const deps = mockManagementDeps()

    const handle = mountPluginManagerPanel(container, { management: toApi(deps) })

    await vi.waitFor(() => {
      expect(handle.root.querySelector('[data-process-id="proc-1"]')).not.toBeNull()
    })
    expect(handle.root.querySelector('[data-process-id="proc-1"]')?.textContent).toContain('running（重启 1 次）')
    expect(handle.root.querySelector('[data-storage-plugin="user.demo"]')?.textContent)
      .toContain('256/65536 字节 · 3 键')
    expect(handle.root.querySelector('[data-dependency-node="builtin.pylon-shell"]')?.textContent)
      .toContain('依赖 builtin.pylon-tools')
    expect(handle.root.querySelector('[data-dependency-node="user.demo"]')?.textContent)
      .toContain('冲突 other.demo')

    // cleanup-failed 行提供一键重试（走 management.retryCleanup）
    const retryCleanup = vi.fn(async () => ({ complete: true }))
    const handle2 = mountPluginManagerPanel(container, {
      management: toApi({ ...deps, retryCleanup }),
    })
    await vi.waitFor(() => {
      expect(handle2.root.querySelector('[data-cleanup-failed="user.demo"]')).not.toBeNull()
    })
    const retryButton = [...handle2.root.querySelectorAll('button')]
      .find(button => button.textContent === '重试清理')!
    retryButton.click()
    await vi.waitFor(() => {
      expect(retryCleanup).toHaveBeenCalledWith('user.demo@1.0.0-pkg#run-1')
    })
    handle.dispose()
    handle2.dispose()
  })

  // P53 D5：终止进程按钮经 management API 委派
  it('terminates a plugin process through the management api', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const deps = mockManagementDeps()
    const terminatePluginProcess = vi.fn(async () => undefined)

    const handle = mountPluginManagerPanel(container, {
      management: toApi({ ...deps, terminatePluginProcess }),
    })

    await vi.waitFor(() => {
      expect(handle.root.querySelector('[data-process-id="proc-1"]')).not.toBeNull()
    })
    const terminateButton = [...handle.root.querySelectorAll('button')]
      .find(button => button.textContent === '终止/重启')!
    terminateButton.click()
    await vi.waitFor(() => {
      expect(terminatePluginProcess).toHaveBeenCalledWith('proc-1')
    })
    handle.dispose()
  })
})
