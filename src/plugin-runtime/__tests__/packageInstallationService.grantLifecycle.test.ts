import { describe, expect, it, vi } from 'vitest'
import { PackageInstallationService } from '../packageInstallationService.ts'
import type { PluginPackageClient, PluginPackageDescriptor } from '../../infrastructure/plugins/pluginPackageClient.ts'
import type { PackagePluginRuntimeService } from '../packagePluginRuntime.ts'
import type { PluginRuntime } from '../pluginRuntime.ts'
import { createPluginCapabilityGrantStore, type PluginCapabilityGrantStore } from '../management/pluginCapabilityGrants.ts'
import { evaluatePluginCapabilityConsent } from '../management/pluginCapabilityConsent.ts'

/**
 * P53 review 处置回归（P0-1）：uninstall 成功 → grant store 回收全部授权
 * （C2：重装同版本须重新同意，不得静默复用旧授权）。
 */

function descriptor(pluginId: string, api = '1.0'): PluginPackageDescriptor {
  return {
    pluginId,
    version: '1.0.0',
    packageInstanceId: `${pluginId}@1.0.0-hash`,
    manifest: {
      schema: 1, id: pluginId, name: 'Demo', version: '1.0.0',
      api: api as '1.0', kind: 'feature', web: { entry: './index.js' },
    },
    files: [], totalBytes: 1, active: true,
  }
}

function fixture(options: {
  descriptor: PluginPackageDescriptor
  grants: PluginCapabilityGrantStore
}) {
  let installed = [{ package: options.descriptor, enabled: true }]
  const packages = {
    inspect: vi.fn(async () => options.descriptor),
    list: vi.fn(async () => installed),
    uninstall: vi.fn(async () => {
      installed = installed.filter(item => item.package.pluginId !== options.descriptor.pluginId)
    }),
    install: vi.fn(async () => ({ operationId: 'i', package: options.descriptor })),
    setEnabled: vi.fn(async () => undefined),
    stage: vi.fn(),
    commitStage: vi.fn(),
    abortStage: vi.fn(),
  }
  const runtime = {
    snapshot: vi.fn(() => ({ revision: 0, active: [], instances: [], switches: [] })),
    contractSnapshot: vi.fn(() => []),
    disable: vi.fn(),
    enable: vi.fn(),
    retryCleanup: vi.fn(),
    reload: vi.fn(),
  }
  const service = new PackageInstallationService({
    runtime: runtime as unknown as PluginRuntime,
    packageRuntime: {} as unknown as PackagePluginRuntimeService,
    packages: packages as unknown as PluginPackageClient,
    evaluateConsent: (pluginId, version, capabilities) => evaluatePluginCapabilityConsent({
      pluginId, pluginVersion: version, capabilities, grants: options.grants,
    }),
    onUninstalled: pluginId => options.grants.revoke(pluginId),
  })
  return { service, packages }
}

describe('uninstall revokes capability grants (C2, review P0-1)', () => {
  it('recycles grants on uninstall so a same-version reinstall needs fresh consent', async () => {
    const grants = createPluginCapabilityGrantStore({
      storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    })
    grants.grant('plugin.manager', 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })
    expect(grants.getGrant('plugin.manager', 'plugin.management', '1.0.0')).toBeDefined()

    const managerDescriptor: PluginPackageDescriptor = {
      ...descriptor('plugin.manager', '1.2'),
      manifest: {
        schema: 1, id: 'plugin.manager', name: 'Manager', version: '1.0.0',
        api: '1.2', kind: 'feature', capabilities: ['plugin.management'],
        web: { entry: './index.js' },
      },
    }
    const { service, packages } = fixture({ descriptor: managerDescriptor, grants })

    const uninstallResult = await service.uninstall('plugin.manager')
    expect(uninstallResult.ok).toBe(true)
    expect(grants.getGrant('plugin.manager', 'plugin.management', '1.0.0')).toBeUndefined()

    // 卸载后重装：未授权 → consent 前置失败（不得复用旧授权）
    const reinstall = await service.installOrUpdate('C:/manager')
    expect(reinstall.ok).toBe(false)
    expect(packages.install).not.toHaveBeenCalled()
  })

  it('does not revoke when uninstall fails', async () => {
    const grants = createPluginCapabilityGrantStore({
      storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    })
    grants.grant('plugin.manager', 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })
    const managerDescriptor: PluginPackageDescriptor = {
      ...descriptor('plugin.manager', '1.2'),
      manifest: {
        schema: 1, id: 'plugin.manager', name: 'Manager', version: '1.0.0',
        api: '1.2', kind: 'feature', capabilities: ['plugin.management'],
        web: { entry: './index.js' },
      },
    }
    const { service, packages } = fixture({ descriptor: managerDescriptor, grants })
    vi.mocked(packages.uninstall).mockRejectedValueOnce(new Error('rust refused'))

    const result = await service.uninstall('plugin.manager')
    expect(result.ok).toBe(false)
    expect(grants.getGrant('plugin.manager', 'plugin.management', '1.0.0')).toBeDefined()
  })
})

describe('installOrUpdateFromUrl post-install consent recheck (review P1-2/C)', () => {
  it('blocks activation when the installed manifest differs from the inspected one', async () => {
    const grants = createPluginCapabilityGrantStore({
      storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    })
    const benign: PluginPackageDescriptor = descriptor('sneaky.plugin')
    const malicious: PluginPackageDescriptor = {
      ...descriptor('sneaky.plugin', '1.2'),
      manifest: {
        schema: 1, id: 'sneaky.plugin', name: 'Sneaky', version: '1.0.0',
        api: '1.2', kind: 'feature', capabilities: ['plugin.management'],
        web: { entry: './index.js' },
      },
    }
    let inspectCount = 0
    const packages = {
      inspectUrl: vi.fn(async () => {
        inspectCount += 1
        // 双取差分攻击模拟：第一次（inspect）良性，第二次（install 落库）恶意
        return inspectCount === 1 ? benign : malicious
      }),
      installFromUrl: vi.fn(async () => ({ operationId: 'u', package: malicious })),
      list: vi.fn(async () => [{ package: malicious, enabled: true }]),
      setEnabled: vi.fn(async () => undefined),
      stage: vi.fn(), commitStage: vi.fn(), abortStage: vi.fn(),
      install: vi.fn(), update: vi.fn(), inspect: vi.fn(), inspectZip: vi.fn(),
      installFromZip: vi.fn(), uninstall: vi.fn(),
    }
    const service = new PackageInstallationService({
      runtime: {
        snapshot: vi.fn(() => ({ revision: 0, active: [], instances: [], switches: [] })),
        contractSnapshot: vi.fn(() => []),
        disable: vi.fn(), enable: vi.fn(), retryCleanup: vi.fn(), reload: vi.fn(),
      } as unknown as PluginRuntime,
      packageRuntime: {
        activateInstalled: vi.fn(async () => ({ operationId: 'a', package: malicious, runtimeInstanceId: 'r' })),
      } as unknown as PackagePluginRuntimeService,
      packages: packages as unknown as PluginPackageClient,
      evaluateConsent: (pluginId, version, capabilities) => evaluatePluginCapabilityConsent({
        pluginId, pluginVersion: version, capabilities, grants,
      }),
    })

    const result = await service.installOrUpdateFromUrl('https://evil.example/demo.zip')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('plugin_capability_denied')
    // 已落库但不得激活/保持启用
    expect(packages.setEnabled).toHaveBeenLastCalledWith('sneaky.plugin', false)
  })
})
