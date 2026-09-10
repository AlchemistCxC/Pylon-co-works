import { describe, expect, it, vi } from 'vitest'
import type { PluginPackageClient, PluginPackageDescriptor } from '../../infrastructure/plugins/pluginPackageClient.ts'
import { PackageInstallationService } from '../packageInstallationService.ts'
import type { PackagePluginRuntimeService } from '../packagePluginRuntime.ts'
import type { PluginRuntime } from '../pluginRuntime.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import { createPluginCapabilityGrantStore } from '../management/pluginCapabilityGrants.ts'
import { evaluatePluginCapabilityConsent } from '../management/pluginCapabilityConsent.ts'

/**
 * P53 D6：PackageInstallationService 的 zip/URL 安装流——
 * 契约前置检查、consent 前置检查、active 插件原子替换、happy path。
 */

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

function descriptor(pluginId: string, capabilities?: readonly string[]): PluginPackageDescriptor {
  return {
    pluginId,
    version: '1.0.0',
    packageInstanceId: `${pluginId}@1.0.0-hash`,
    manifest: {
      schema: 1,
      id: pluginId,
      name: 'Demo',
      version: '1.0.0',
      // capabilities 仅 API 1.2 合法；1.0 场景省略
      api: capabilities ? '1.2' : '1.0',
      kind: 'feature',
      ...(capabilities ? { capabilities } : {}),
      web: { entry: './index.js' },
    },
    files: [],
    totalBytes: 1,
    active: true,
  }
}

function fixture(options: {
  descriptor: PluginPackageDescriptor
  active?: boolean
} = { descriptor: descriptor('feature.demo') }) {
  const installed = [{ package: options.descriptor, enabled: true }]
  const packages = {
    inspect: vi.fn(async () => options.descriptor),
    inspectZip: vi.fn(async () => options.descriptor),
    inspectUrl: vi.fn(async () => options.descriptor),
    installFromZip: vi.fn(async () => ({ operationId: 'zip-1', package: options.descriptor })),
    installFromUrl: vi.fn(async () => ({ operationId: 'url-1', package: options.descriptor })),
    install: vi.fn(async () => ({ operationId: 'i-1', package: options.descriptor })),
    update: vi.fn(async () => ({ operationId: 'u-1', package: options.descriptor })),
    list: vi.fn(async () => installed),
    setEnabled: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
    stage: vi.fn(),
    commitStage: vi.fn(),
    abortStage: vi.fn(),
  }
  const runtime = {
    snapshot: vi.fn(() => ({
      revision: 0,
      active: options.active ? [identity(options.descriptor.pluginId)] : [],
      instances: [],
      switches: [],
    })),
    contractSnapshot: vi.fn(() => []),
    disable: vi.fn(async () => ({ complete: true, alreadyInactive: false, scope: { disposed: 0, remaining: 0, errors: [] } })),
    enable: vi.fn(async () => identity(options.descriptor.pluginId)),
    retryCleanup: vi.fn(),
    reload: vi.fn(),
  }
  const packageRuntime = {
    activateInstalled: vi.fn(async () => ({ operationId: 'a-1', package: options.descriptor, runtimeInstanceId: 'run-1' })),
    activateFromDirectory: vi.fn(),
    updateFromDirectory: vi.fn(),
  }
  const grants = createPluginCapabilityGrantStore({
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  })
  const service = new PackageInstallationService({
    runtime: runtime as unknown as PluginRuntime,
    packageRuntime: packageRuntime as unknown as PackagePluginRuntimeService,
    packages: packages as unknown as PluginPackageClient,
    evaluateConsent: (pluginId, version, capabilities) => evaluatePluginCapabilityConsent({
      pluginId, pluginVersion: version, capabilities, grants,
    }),
  })
  return { service, packages, runtime, packageRuntime, grants }
}

describe('PackageInstallationService zip/url install sources (P53 D6)', () => {
  it('installs from zip: contract and consent checks pass, then installFromZip + activate', async () => {
    const { service, packages, packageRuntime } = fixture()
    const result = await service.installOrUpdateFromZip('C:/packages/demo.zip')

    expect(result.ok).toBe(true)
    expect(packages.inspectZip).toHaveBeenCalledWith('C:/packages/demo.zip')
    expect(packages.installFromZip).toHaveBeenCalledWith('C:/packages/demo.zip', 'feature.demo')
    expect(packageRuntime.activateInstalled).toHaveBeenCalled()
    expect(packages.setEnabled).toHaveBeenCalledWith('feature.demo', true)
  })

  it('installs from url: contract and consent checks pass, then installFromUrl + activate', async () => {
    const { service, packages } = fixture()
    const result = await service.installOrUpdateFromUrl('https://example.com/demo.zip')

    expect(result.ok).toBe(true)
    expect(packages.inspectUrl).toHaveBeenCalledWith('https://example.com/demo.zip')
    expect(packages.installFromUrl).toHaveBeenCalledWith('https://example.com/demo.zip', 'feature.demo')
  })

  it('blocks a capability-declaring zip while the grant is missing', async () => {
    const { service, packages } = fixture({
      descriptor: descriptor('plugin.manager', ['plugin.management']),
    })

    const result = await service.installOrUpdateFromZip('C:/packages/manager.zip')

    expect(result.ok).toBe(false)
    expect(result.message).toContain('plugin_capability_denied')
    expect(packages.installFromZip).not.toHaveBeenCalled()
  })

  it('replaces an active plugin from zip via disable → install → re-activate', async () => {
    const { service, packages, runtime } = fixture({
      descriptor: descriptor('feature.demo'),
      active: true,
    })

    const result = await service.installOrUpdateFromZip('C:/packages/demo.zip')

    expect(result.ok).toBe(true)
    expect(runtime.disable).toHaveBeenCalledWith('feature.demo')
    expect(packages.installFromZip).toHaveBeenCalledWith('C:/packages/demo.zip', 'feature.demo')
    expect(packages.setEnabled).toHaveBeenCalledWith('feature.demo', true)
  })
})
