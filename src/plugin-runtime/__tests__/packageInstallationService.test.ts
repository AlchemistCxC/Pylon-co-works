import { describe, expect, it, vi } from 'vitest'
import type { PluginPackageClient, PluginPackageDescriptor } from '../../infrastructure/plugins/pluginPackageClient.ts'
import { PackageInstallationService } from '../packageInstallationService.ts'
import type { PackagePluginRuntimeService } from '../packagePluginRuntime.ts'
import type { PluginRuntime } from '../pluginRuntime.ts'

const descriptor: PluginPackageDescriptor = {
  pluginId: 'feature.demo',
  version: '1.0.0',
  packageInstanceId: 'feature.demo@1.0.0-hash',
  manifest: {
    schema: 1,
    id: 'feature.demo',
    name: 'Demo',
    version: '1.0.0',
    api: '1.0',
    kind: 'feature',
    web: { entry: './index.js' },
  },
  files: [],
  totalBytes: 1,
  active: true,
}

function fixture(active = false) {
  const runtime = {
    snapshot: vi.fn(() => ({ active: active ? [{ pluginId: descriptor.pluginId }] : [] })),
    disable: vi.fn(async () => undefined),
    enable: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
  }
  const packageRuntime = {
    activateInstalled: vi.fn(async () => undefined),
    activateFromDirectory: vi.fn(async () => undefined),
    updateFromDirectory: vi.fn(async () => undefined),
  }
  const packages = {
    list: vi.fn(async () => [{ package: descriptor, enabled: true }]),
    inspect: vi.fn(async () => descriptor),
    setEnabled: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
  }
  const service = new PackageInstallationService({
    runtime: runtime as unknown as PluginRuntime,
    packageRuntime: packageRuntime as unknown as PackagePluginRuntimeService,
    packages: packages as unknown as PluginPackageClient,
  })
  return { service, runtime, packageRuntime, packages }
}

describe('PackageInstallationService', () => {
  it('activates enabled installed API 1.0 packages exactly once during initialization', async () => {
    const { service, packageRuntime } = fixture()
    await expect(service.initialize()).resolves.toEqual({ activated: ['feature.demo'], failed: [] })
    await service.initialize()
    expect(packageRuntime.activateInstalled).toHaveBeenCalledOnce()
  })

  it('allows a later retry when first-run package enumeration fails transiently', async () => {
    const { service, packages } = fixture()
    packages.list.mockRejectedValueOnce(new Error('plugin directory not ready'))
    await expect(service.initialize()).rejects.toThrow('plugin directory not ready')
    await expect(service.initialize()).resolves.toEqual({ activated: ['feature.demo'], failed: [] })
    expect(packages.list).toHaveBeenCalledTimes(2)
  })

  it('rolls the persisted enabled flag back when activation fails', async () => {
    const { service, packageRuntime, packages } = fixture()
    packageRuntime.activateInstalled.mockRejectedValueOnce(new Error('activation failed'))
    await expect(service.setEnabled('feature.demo', true)).resolves.toEqual({
      ok: false,
      message: 'activation failed',
    })
    expect(packages.setEnabled).toHaveBeenNthCalledWith(1, 'feature.demo', true)
    expect(packages.setEnabled).toHaveBeenNthCalledWith(2, 'feature.demo', false)
  })

  it('uses shadow update for an active package and staged activation for an inactive package', async () => {
    const activeFixture = fixture(true)
    await expect(activeFixture.service.installOrUpdate('C:/candidate')).resolves.toEqual({ ok: true })
    expect(activeFixture.packageRuntime.updateFromDirectory).toHaveBeenCalledWith('C:/candidate', 'feature.demo')

    const inactiveFixture = fixture(false)
    await inactiveFixture.service.installOrUpdate('C:/candidate')
    expect(inactiveFixture.packageRuntime.activateFromDirectory).toHaveBeenCalledWith('C:/candidate', 'feature.demo')
  })

  it('restores an active package if native uninstall fails', async () => {
    const { service, runtime, packages } = fixture(true)
    packages.uninstall.mockRejectedValueOnce(new Error('disk busy'))
    await expect(service.uninstall('feature.demo')).resolves.toEqual({ ok: false, message: 'disk busy' })
    expect(runtime.disable).toHaveBeenCalledWith('feature.demo')
    expect(runtime.enable).toHaveBeenCalledWith('feature.demo')
  })
})
