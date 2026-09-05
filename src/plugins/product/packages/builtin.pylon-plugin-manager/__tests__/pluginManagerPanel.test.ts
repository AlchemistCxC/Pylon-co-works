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
          { pluginId: 'builtin.pylon-shell', runtimeInstanceId: 'builtin.pylon-shell@b1', version: 'builtin', status: 'active' as const },
          { pluginId: 'user.demo', runtimeInstanceId: 'user.demo@1.0.0-pkg#run-1', version: '1.0.0', status: 'cleanup-failed' as const },
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
    isCapabilityGranted: () => true,
    isProductRequired: pluginId => pluginId === 'builtin.pylon-shell',
    setEnabled: vi.fn(async () => { calls.push(`setEnabled:${overrides}`); return { ok: true } }),
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
})
