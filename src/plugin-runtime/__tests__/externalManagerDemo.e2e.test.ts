// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { PluginPackageClient, PluginPackageDescriptor } from '../../infrastructure/plugins/pluginPackageClient.ts'
import { PackageInstallationService } from '../packageInstallationService.ts'
import { PackagePluginRuntimeService } from '../packagePluginRuntime.ts'
import { TestPluginRuntime as PluginRuntime } from '../testing/pluginRuntimeHarness.ts'
import { createPluginCapabilityGrantStore, type PluginCapabilityGrantStore } from '../management/pluginCapabilityGrants.ts'
import { evaluatePluginCapabilityConsent } from '../management/pluginCapabilityConsent.ts'
import { createPluginManagementApiBound } from '../management/pluginManagementApi.ts'
import type { PluginManagementDeps } from '../management/pluginManagementTypes.ts'

/**
 * P53 D4 E2E：外置管理器示例包（api 1.2 + plugin.management）的完整链路——
 * 目录安装 → 未授权时启用被 plugin_capability_denied 阻断 → 宿主补授权 →
 * 激活成功且 context.management 可用（增强面板数据面）。
 */

const DEMO_ID = 'external.pylon-plugin-manager-demo'

function demoDescriptor(): PluginPackageDescriptor {
  return {
    pluginId: DEMO_ID,
    version: '1.0.0',
    packageInstanceId: `${DEMO_ID}@1.0.0-hash`,
    manifest: {
      schema: 1,
      id: DEMO_ID,
      name: 'External Plugin Manager Demo',
      version: '1.0.0',
      api: '1.2',
      kind: 'feature',
      capabilities: ['plugin.management'],
      web: { entry: './index.js' },
      dependencies: {},
      optionalDependencies: {},
      conflicts: [],
      activation: { events: ['kernel.ready'] },
      hotSwap: { mode: 'parallel', drainTimeoutMs: 5000 },
    },
    files: [],
    totalBytes: 1,
    active: true,
  }
}

function grantStore(): PluginCapabilityGrantStore {
  return createPluginCapabilityGrantStore({
    storage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
  })
}

/** 外置包入口：记录 activation context 的 management 可见性。 */
function entryModule(managementSeen: { current: unknown }, pageIdSuffix = '') {
  return {
    activate: (context: { management?: unknown; settings: { registerPage: (page: unknown) => void } }) => {
      managementSeen.current = context.management
      context.settings.registerPage({
        id: `external.pylon-plugin-manager-demo.settings${pageIdSuffix}`,
        label: '插件管理器（外置示例）',
        renderKind: 'isolated-surface',
        surfaceId: 'external.pylon-plugin-manager-demo.panel',
      })
    },
  }
}

async function fixture(options: {
  grants: PluginCapabilityGrantStore
  importEntry: (url: string) => Promise<unknown>
}) {
  const descriptor = demoDescriptor()
  const packages = {
    stage: vi.fn(async () => ({ operationId: 'stage-1', package: descriptor })),
    commitStage: vi.fn(async (operationId: string) => ({ operationId, package: descriptor })),
    abortStage: vi.fn(async () => undefined),
    install: vi.fn(async () => ({ operationId: 'install-1', package: descriptor })),
    update: vi.fn(async () => ({ operationId: 'update-1', package: descriptor })),
    list: vi.fn(async () => [{ package: descriptor, enabled: true }]),
    setEnabled: vi.fn(async () => undefined),
    uninstall: vi.fn(async () => undefined),
    resourceUrl: vi.fn(async (packageId: string, path: string) => `pylon-plugin://${packageId}/${path}`),
    createRuntime: vi.fn(async () => undefined),
    cleanupRuntime: vi.fn(async () => undefined),
    inspect: vi.fn(async () => descriptor),
  } as unknown as PluginPackageClient & ReturnType<typeof demoDescriptorExtension>
  const runtime = new PluginRuntime({
    // 与宿主 wiring 同构的 C3 门控装配器：声明 ∧ 授权 ⇔ management 装配
    createManagementApi: definition => {
      const consent = evaluatePluginCapabilityConsent({
        pluginId: definition.id,
        pluginVersion: definition.version ?? '0.0.0',
        capabilities: definition.capabilities,
        grants: options.grants,
      })
      if (consent.status !== 'granted') return undefined
      const deps: PluginManagementDeps = {
        listInstalled: () => packages.list(),
        runtimeOverview: () => {
          const snapshot = runtime.snapshot()
          return {
            revision: snapshot.revision,
            activePluginIds: snapshot.active.map(item => item.pluginId),
            instances: snapshot.instances.map(instance => ({
              pluginId: instance.identity.pluginId,
              runtimeInstanceId: instance.identity.runtimeInstanceId,
              version: instance.identity.version,
              status: instance.status,
            })),
          }
        },
        bootstrapOverview: () => ({
          state: 'ready' as const,
          activePluginIds: [],
          failures: [],
          skippedPluginIds: [],
        }),
        contractDiagnostics: () => installation.getContractSnapshot(),
        contributionOverview: () => [],
        capabilityGrants: () => [],
        isCapabilityGranted: (pluginId, capability, pluginVersion) => (
          options.grants.getGrant(pluginId, capability as 'plugin.management', pluginVersion) !== undefined
        ),
        isProductRequired: () => false,
        setEnabled: (pluginId, enabled) => installation.setEnabled(pluginId, enabled),
        reload: pluginId => installation.reload(pluginId),
        uninstall: pluginId => installation.uninstall(pluginId),
        installOrUpdate: sourcePath => installation.installOrUpdate(sourcePath),
        setBuiltinEnabled: async () => ({ ok: true }),
      }
      return createPluginManagementApiBound({
        pluginId: definition.id,
        pluginVersion: definition.version ?? '0.0.0',
        deps,
      })
    },
  })
  const packageRuntime = new PackagePluginRuntimeService({
    runtime,
    packages,
    // 参数是 packageInstanceId（demo@1.0.0-hash）：runtimeInstanceId = <pkgInstanceId>#run
    createRuntimeId: packageInstanceId => `${packageInstanceId}#run-1`,
    importEntry: options.importEntry,
  })
  const installation = new PackageInstallationService({
    runtime,
    packageRuntime,
    packages,
    evaluateConsent: (pluginId, version, capabilities) => evaluatePluginCapabilityConsent({
      pluginId,
      pluginVersion: version,
      capabilities,
      grants: options.grants,
    }),
  })
  // kernel.ready 已发射：activation 事件门通过，consent 检查才会进入激活路径
  await installation.emitActivationEvent('kernel.ready')
  return { runtime, packages, installation, descriptor }
}

function demoDescriptorExtension() {
  return { stage: vi.fn() }
}

describe('external plugin manager demo E2E (install → consent → panel)', () => {
  it('blocks enable while the capability is not granted, then activates after host grant', async () => {
    const grants = grantStore()
    const managementSeen: { current: unknown } = { current: 'unset' }

    // 第一步：未授权安装——安装成功但激活前置失败 plugin_capability_denied
    const blocked = await fixture({
      grants,
      importEntry: async () => entryModule(managementSeen),
    })
    const blockedResult = await blocked.installation.installOrUpdate('C:/demo')
    expect(blockedResult.ok).toBe(false)
    expect(blockedResult.message).toContain('plugin_capability_denied')
    expect(blocked.runtime.snapshot().active).toEqual([])

    // 第二步：未授权直接启用同样被阻断
    const enableBlocked = await blocked.installation.setEnabled(DEMO_ID, true)
    expect(enableBlocked.ok).toBe(false)
    expect(enableBlocked.message).toContain('plugin_capability_denied')

    // 第三步：宿主授权（版本绑定）后启用 → 激活且 management API 装配
    grants.grant(DEMO_ID, 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })
    const granted = await fixture({
      grants,
      importEntry: async () => entryModule(managementSeen),
    })
    const enabled = await granted.installation.setEnabled(DEMO_ID, true)
    expect(enabled.ok).toBe(true)
    expect(granted.runtime.snapshot().active.map(identity => identity.pluginId)).toEqual([DEMO_ID])
    // C3 门控：授权后 activation context 携带 management（面板数据面可用）
    expect(managementSeen.current).toBeDefined()
    expect(typeof (managementSeen.current as { listInstalled?: unknown }).listInstalled).toBe('function')

    // 第四步：版本变更后旧授权失效（须重新同意）
    const stale = grants.getGrant(DEMO_ID, 'plugin.management', '1.1.0')
    expect(stale).toBeUndefined()
  })

  it('activates from directory with consent pre-granted and the panel reads data through management', async () => {
    const grants = grantStore()
    grants.grant(DEMO_ID, 'plugin.management', { pluginVersion: '1.0.0', apiVersion: '1.2' })
    const managementSeen: { current: unknown } = { current: 'unset' }

    const { runtime } = await fixture({
      grants,
      importEntry: async () => entryModule(managementSeen, '.second'),
    })

    // fixture 内 emitActivationEvent('kernel.ready') → initializeOnce：授权预置时
    // 启动初始化即完成"目录安装 → 激活"链路
    expect(runtime.snapshot().active.map(identity => identity.pluginId)).toEqual([DEMO_ID])

    const management = managementSeen.current as {
      listInstalled(): Promise<unknown[]>
      runtimeOverview(): { activePluginIds: readonly string[] }
      contributionOverview(): readonly { pluginId: string }[]
    }
    const installed = await management.listInstalled()
    expect(Array.isArray(installed)).toBe(true)
    expect(management.runtimeOverview().activePluginIds).toContain(DEMO_ID)
    expect(management.contributionOverview()).toEqual([])
  })
})
