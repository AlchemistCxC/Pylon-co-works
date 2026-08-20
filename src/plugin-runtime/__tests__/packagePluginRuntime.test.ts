import { describe, expect, it, vi } from 'vitest'
import type { PluginPackageClient, PluginPackageDescriptor } from '../../infrastructure/plugins/pluginPackageClient.ts'
import { getCommandRegistry } from '../runtimeServices.ts'
import { PackagePluginRuntimeService } from '../packagePluginRuntime.ts'
import { PluginRuntime } from '../pluginRuntime.ts'

function descriptor(version: string, styles: readonly string[] = []): PluginPackageDescriptor {
  return {
    pluginId: 'phase9.package',
    version,
    packageInstanceId: `phase9.package@${version}-hash`,
    manifest: {
      schema: 1, id: 'phase9.package', name: 'Phase 9 Package', api: '1.0',
      version, kind: 'feature', web: { entry: './index.js', styles }, hotSwap: { mode: 'parallel' },
    },
    files: [],
    totalBytes: 1,
    active: false,
  }
}

function fakePackages(stages: PluginPackageDescriptor[]) {
  let index = 0
  const client = {
    stage: vi.fn(async () => {
      const packageDescriptor = stages[index++]!
      return { operationId: `stage-${packageDescriptor.version}`, package: packageDescriptor }
    }),
    commitStage: vi.fn(async (operationId: string) => ({ operationId, package: stages[index - 1]! })),
    abortStage: vi.fn(async () => undefined),
    resourceUrl: vi.fn(async (packageId: string, path: string, runtimeId: string) => `pylon-plugin://${packageId}/${path.replace(/^\.\//, '')}?runtime=${runtimeId}`),
    createRuntime: vi.fn(async () => undefined),
    cleanupRuntime: vi.fn(async () => undefined),
  }
  return client as unknown as PluginPackageClient & typeof client
}

describe('PackagePluginRuntimeService shadow update', () => {
  it('stages/imports candidate and commits active pointer only after registry switch is ready', async () => {
    const one = descriptor('1.0.0')
    const two = descriptor('2.0.0')
    const packages = fakePackages([one, two])
    const runtime = new PluginRuntime()
    const service = new PackagePluginRuntimeService({
      runtime,
      packages,
      createRuntimeId: packageId => `${packageId}#test`,
      importEntry: async url => ({
        activate: ({ commands }: Parameters<Parameters<PluginRuntime['activatePackage']>[0]['activate']>[0]) => {
          const version = url.includes('@1.0.0-') ? 'old' : 'new'
          commands.register({ id: 'phase9.package.command', name: 'phase9-package', description: version, priority: 1, execute: () => version })
        },
      }),
    })

    const active = await service.activateFromDirectory('C:/v1', 'phase9.package')
    expect(await getCommandRegistry().execute('phase9.package.command')).toBe('old')
    const updated = await service.updateFromDirectory('C:/v2', 'phase9.package')

    expect(updated.package.version).toBe('2.0.0')
    expect(updated.runtimeInstanceId).toBe('phase9.package@2.0.0-hash#test')
    expect(await getCommandRegistry().execute('phase9.package.command')).toBe('new')
    expect(packages.commitStage).toHaveBeenNthCalledWith(1, 'stage-1.0.0')
    expect(packages.commitStage).toHaveBeenNthCalledWith(2, 'stage-2.0.0')
    expect(packages.abortStage).not.toHaveBeenCalled()
    await runtime.deactivate(updated.runtimeInstanceId)
    expect(packages.cleanupRuntime).toHaveBeenCalledWith(active.runtimeInstanceId)
    expect(packages.cleanupRuntime).toHaveBeenCalledWith(updated.runtimeInstanceId)
  })

  it('candidate activation failure aborts stage, cleans runtime and leaves old package serving', async () => {
    const one = descriptor('1.0.0')
    const two = descriptor('2.0.0')
    const packages = fakePackages([one, two])
    const runtime = new PluginRuntime()
    const service = new PackagePluginRuntimeService({
      runtime,
      packages,
      createRuntimeId: packageId => `${packageId}#test-failure`,
      importEntry: async url => ({
        activate: ({ commands }: Parameters<Parameters<PluginRuntime['activatePackage']>[0]['activate']>[0]) => {
          const candidate = url.includes('@2.0.0-')
          commands.register({ id: 'phase9.package.failure.command', name: 'phase9-package-failure', description: 'test', priority: 1, execute: () => candidate ? 'new' : 'old' })
          if (candidate) throw new Error('readiness failed')
        },
      }),
    })

    const active = await service.activateFromDirectory('C:/v1', 'phase9.package')
    await expect(service.updateFromDirectory('C:/v2', 'phase9.package')).rejects.toThrow('readiness failed')
    expect(await getCommandRegistry().execute('phase9.package.failure.command')).toBe('old')
    expect(packages.abortStage).toHaveBeenCalledWith('stage-2.0.0')
    expect(packages.cleanupRuntime).toHaveBeenCalledWith('phase9.package@2.0.0-hash#test-failure')
    expect(runtime.snapshot().active[0]?.key).toBe(active.runtimeInstanceId)
    await runtime.deactivate(active.runtimeInstanceId)
  })
})
