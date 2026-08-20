import { describe, expect, it, vi } from 'vitest'
import type { PluginPackageClient, PluginPackageDescriptor } from '../../infrastructure/plugins/pluginPackageClient.ts'
import { PackageInstallationService } from '../packageInstallationService.ts'
import type { PackagePluginRuntimeService } from '../packagePluginRuntime.ts'
import type { PluginRuntime } from '../pluginRuntime.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'

function identity(pluginId: string): PluginIdentity {
  const packageInstanceId = `${pluginId}@1.0.0-hash`
  return {
    pluginId,
    version: '1.0.0',
    packageInstanceId,
    instanceId: 'run-1',
    runtimeInstanceId: `${packageInstanceId}#run-1`,
    key: `${packageInstanceId}#run-1`,
  }
}

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
    snapshot: vi.fn<PluginRuntime['snapshot']>(() => ({
      revision: 0,
      active: active ? [identity(descriptor.pluginId)] : [],
      instances: [],
      switches: [],
    })),
    contractSnapshot: vi.fn(() => [] as Array<{
      id: string
      version: string
      enabled: boolean
      dependencies?: Readonly<Record<string, string>>
    }>),
    disable: vi.fn<PluginRuntime['disable']>(async () => ({
      complete: true,
      alreadyInactive: false,
      scope: { disposed: 0, remaining: 0, errors: [] },
    })),
    enable: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
  }
  const packageRuntime = {
    activateInstalled: vi.fn(async (_descriptor: PluginPackageDescriptor) => undefined),
    activateFromDirectory: vi.fn(async (_sourcePath: string, _expectedId: string) => undefined),
    updateFromDirectory: vi.fn(async (_sourcePath: string, _expectedId: string) => undefined),
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

  it('initializes enabled packages in resolved dependency order', async () => {
    const { service, packageRuntime, packages } = fixture()
    const provider: PluginPackageDescriptor = {
      ...descriptor,
      pluginId: 'service.clock',
      packageInstanceId: 'service.clock@1.0.0-hash',
      manifest: { ...descriptor.manifest, id: 'service.clock', name: 'Clock' },
    }
    const consumer: PluginPackageDescriptor = {
      ...descriptor,
      pluginId: 'feature.consumer',
      packageInstanceId: 'feature.consumer@1.0.0-hash',
      manifest: {
        ...descriptor.manifest,
        id: 'feature.consumer',
        name: 'Consumer',
        dependencies: { 'service.clock': '^1.0.0' },
      },
    }
    packages.list.mockResolvedValue([
      { package: consumer, enabled: true },
      { package: provider, enabled: true },
    ])

    await service.initialize()

    expect(packageRuntime.activateInstalled.mock.calls.map(([item]) => item.pluginId))
      .toEqual(['service.clock', 'feature.consumer'])
  })

  it('keeps an enabled package waiting until Kernel emits its activation event', async () => {
    const { service, packageRuntime, packages } = fixture()
    packages.list.mockResolvedValue([{
      package: {
        ...descriptor,
        manifest: {
          ...descriptor.manifest,
          activation: { events: ['kernel.ready'] },
        },
      },
      enabled: true,
    }])

    await expect(service.initialize()).resolves.toEqual({ activated: [], failed: [] })
    expect(packageRuntime.activateInstalled).not.toHaveBeenCalled()
    expect(service.getContractSnapshot().diagnostics).toEqual([expect.objectContaining({
      pluginId: 'feature.demo',
      code: 'waiting_activation',
    })])

    await expect(service.emitActivationEvent('kernel.ready')).resolves.toEqual({
      activated: ['feature.demo'],
      failed: [],
    })
    expect(packageRuntime.activateInstalled).toHaveBeenCalledOnce()
    expect(service.getContractSnapshot().diagnostics).toEqual([])
  })

  it('allows a later retry when first-run package enumeration fails transiently', async () => {
    const { service, packages } = fixture()
    packages.list.mockRejectedValueOnce(new Error('plugin directory not ready'))
    await expect(service.initialize()).rejects.toThrow('plugin directory not ready')
    await expect(service.initialize()).resolves.toEqual({ activated: ['feature.demo'], failed: [] })
    expect(packages.list).toHaveBeenCalledTimes(2)
  })

  it('isolates an invalid manifest while initializing unrelated enabled packages', async () => {
    const { service, packageRuntime, packages } = fixture()
    const invalid: PluginPackageDescriptor = {
      ...descriptor,
      pluginId: 'feature.invalid',
      packageInstanceId: 'feature.invalid@1.0.0-hash',
      manifest: {
        ...descriptor.manifest,
        id: 'feature.invalid',
        dependencies: { 'service.clock': '>=1.0.0' },
      },
    }
    packages.list.mockResolvedValue([
      { package: invalid, enabled: true },
      { package: descriptor, enabled: true },
    ])

    await expect(service.initialize()).resolves.toMatchObject({
      activated: ['feature.demo'],
      failed: [expect.objectContaining({ pluginId: 'feature.invalid' })],
    })
    expect(packageRuntime.activateInstalled).toHaveBeenCalledWith(descriptor)
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

  it('rejects disabling a package still required by an enabled dependent', async () => {
    const { service, runtime, packages } = fixture(true)
    const consumer: PluginPackageDescriptor = {
      ...descriptor,
      pluginId: 'feature.consumer',
      packageInstanceId: 'feature.consumer@1.0.0-hash',
      manifest: {
        ...descriptor.manifest,
        id: 'feature.consumer',
        name: 'Consumer',
        dependencies: { 'feature.demo': '^1.0.0' },
      },
    }
    packages.list.mockResolvedValue([
      { package: descriptor, enabled: true },
      { package: consumer, enabled: true },
    ])
    runtime.snapshot.mockReturnValue({
      revision: 1,
      active: [identity('feature.demo'), identity('feature.consumer')],
      instances: [],
      switches: [],
    })
    runtime.contractSnapshot.mockReturnValue([
      { id: 'feature.demo', version: '1.0.0', enabled: true },
      {
        id: 'feature.consumer',
        version: '1.0.0',
        enabled: true,
        dependencies: { 'feature.demo': '^1.0.0' },
      },
    ])

    await expect(service.setEnabled('feature.demo', false)).resolves.toMatchObject({
      ok: false,
      code: 'plugin_contract_blocked',
      message: expect.stringContaining('feature.consumer'),
    })
    expect(runtime.disable).not.toHaveBeenCalled()
    expect(packages.setEnabled).not.toHaveBeenCalled()

    await expect(service.uninstall('feature.demo')).resolves.toMatchObject({
      ok: false,
      code: 'plugin_contract_blocked',
    })
    expect(runtime.disable).not.toHaveBeenCalled()
    expect(runtime.enable).not.toHaveBeenCalled()
    expect(packages.uninstall).not.toHaveBeenCalled()
  })

  it('keeps native enabled state and package bytes when runtime cleanup is incomplete', async () => {
    const { service, runtime, packages } = fixture(true)
    runtime.disable.mockResolvedValue({
      complete: false,
      alreadyInactive: false,
      scope: {
        disposed: 1,
        remaining: 1,
        errors: [{ resourceId: 'locked', message: 'resource locked' }],
      },
    })

    await expect(service.setEnabled('feature.demo', false)).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('resource locked'),
    })
    expect(packages.setEnabled).not.toHaveBeenCalled()

    runtime.snapshot.mockReturnValue({
      revision: 1,
      active: [],
      instances: [{
        identity: {
          pluginId: descriptor.pluginId,
          version: descriptor.version,
          packageInstanceId: descriptor.packageInstanceId,
          instanceId: 'run-1',
          runtimeInstanceId: `${descriptor.packageInstanceId}#run-1`,
          key: `${descriptor.packageInstanceId}#run-1`,
        },
        status: 'cleanup-failed',
        cleanup: await runtime.disable('feature.demo'),
      }],
      switches: [],
    })

    await expect(service.uninstall('feature.demo')).resolves.toMatchObject({
      ok: false,
      message: expect.stringContaining('resource locked'),
    })
    expect(packages.uninstall).not.toHaveBeenCalled()
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
