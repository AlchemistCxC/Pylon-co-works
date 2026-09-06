/**
 * P53 D1 宿主侧 capability 装配（compositionRoot 专用）。
 *
 * grant store 为宿主专属单例（localStorage，host-owned）；授权 UI 是 D2
 * 宿主页职责。本模块提供：
 * 1. `evaluateConsentForDefinition`（bootstrap/包链的同意流判定）；
 * 2. `createRuntimeManagementApiFactory`（PluginRuntime 的 C3 门控装配器——
 *    声明 ∧ 授权时才产出 PluginManagementApi）。
 *
 * 依赖一律惰性 getter（compositionRoot 模块级构造顺序：wiring 先于各服务
 * 单例就绪；且 kernelBootstrapServices 静态依赖 compositionRoot，直接静态
 * 反向 import 会成环）。
 */
import type { BuiltinPluginDefinition, PluginRuntime } from '../pluginRuntime.ts'
import type { PluginScope } from '../pluginScope.ts'
import type { PluginIdentity } from '../pluginIdentity.ts'
import { evaluatePluginCapabilityConsent } from './pluginCapabilityConsent.ts'
import { createPluginCapabilityGrantStore, type PluginCapabilityGrantStore } from './pluginCapabilityGrants.ts'
import { createPluginManagementApiBound } from './pluginManagementApi.ts'
import type {
  PluginManagementApi,
  PluginManagementDeps,
  PluginCapabilityGrantFact,
} from './pluginManagementTypes.ts'
import type { PackageInstallationService } from '../packageInstallationService.ts'
import type { KernelBootstrap } from '../../kernel/kernelBootstrap.ts'
import type { RuntimeRegistries } from '../pluginHostServices.ts'
import type { PluginProcessClient } from '../../infrastructure/plugins/pluginProcessClient.ts'
import { readPluginContributionFacts } from './pluginContributionProjection.ts'
import { readPluginStorageUsage, clearPluginStorageNamespace } from './pluginStorageUsage.ts'
import type { PluginDependencyNode } from './pluginManagementTypes.ts'

let grantStoreSingleton: PluginCapabilityGrantStore | undefined

export function getPluginCapabilityGrantStore(): PluginCapabilityGrantStore {
  grantStoreSingleton ??= createPluginCapabilityGrantStore()
  return grantStoreSingleton
}

/** 测试复位（生产代码不得调用）。 */
export function resetPluginCapabilityGrantStoreForTests(): void {
  grantStoreSingleton = undefined
}

/** bootstrap/包链的同意流判定：声明了 capability 但授权缺失 → awaiting_consent。 */
export function evaluateConsentForDefinition(
  definition: Pick<BuiltinPluginDefinition, 'id' | 'version' | 'capabilities'>,
): ReturnType<typeof evaluatePluginCapabilityConsent> {
  return evaluatePluginCapabilityConsent({
    pluginId: definition.id,
    pluginVersion: definition.version ?? '0.0.0',
    capabilities: definition.capabilities,
    grants: getPluginCapabilityGrantStore(),
  })
}

type BootstrapProvider = Pick<KernelBootstrap, 'getSnapshot' | 'retryPlugin'>

let bootstrapProvider: BootstrapProvider | undefined

/** 由 kernelBootstrapServices 装配后注入（打破静态循环依赖）。 */
export function registerKernelBootstrapProvider(provider: BootstrapProvider): void {
  bootstrapProvider = provider
}

export function getRegisteredKernelBootstrap(): BootstrapProvider {
  if (!bootstrapProvider) {
    throw new Error('kernel bootstrap 尚未装配（management wiring）')
  }
  return bootstrapProvider
}

export interface RuntimeManagementWiringOptions {
  /** 惰性取各依赖（compositionRoot 模块级构造顺序：wiring 先于服务单例就绪）。 */
  readonly getRuntime: () => PluginRuntime
  readonly getInstallation: () => PackageInstallationService
  readonly getBootstrap: () => BootstrapProvider
  readonly getBuiltinCriticality: (pluginId: string) => 'kernel-required' | 'product-required' | 'optional' | undefined
}

/** 贡献面透视的 registry 数据源（由 compositionRoot 注入，惰性取）。 */
let registriesProvider: (() => RuntimeRegistries) | undefined

export function registerRuntimeRegistriesProvider(provider: () => RuntimeRegistries): void {
  registriesProvider = provider
}

function runtimeHostRegistries(): RuntimeRegistries {
  if (!registriesProvider) throw new Error('runtime registries 尚未装配（management wiring）')
  return registriesProvider()
}

/** 插件附带进程客户端（D5 监管；由 compositionRoot 注入，惰性取）。 */
let processClientProvider: (() => PluginProcessClient) | undefined

export function registerPluginProcessClientProvider(provider: () => PluginProcessClient): void {
  processClientProvider = provider
}

function hostProcessClient(): PluginProcessClient {
  if (!processClientProvider) throw new Error('plugin process client 尚未装配（management wiring）')
  return processClientProvider()
}

/** 内置包依赖图节点（D5 依赖契约诊断；数据 = first-party manifests）。 */
let builtinDependencyNodesProvider: (() => readonly PluginDependencyNode[]) | undefined

export function registerBuiltinDependencyNodesProvider(
  provider: () => readonly PluginDependencyNode[],
): void {
  builtinDependencyNodesProvider = provider
}

function builtinDependencyNodes(): readonly PluginDependencyNode[] {
  return builtinDependencyNodesProvider?.() ?? []
}

/** C3 门控装配器：声明 plugin.management ∧ 当前版本已授权 → PluginManagementApi；
 *  否则 undefined（context 不装配 management 属性）。 */
export function createRuntimeManagementApiFactory(options: RuntimeManagementWiringOptions) {
  return (
    definition: BuiltinPluginDefinition,
    scope: PluginScope,
  ): PluginManagementApi | undefined => {
    if (!definition.capabilities?.includes('plugin.management')) return undefined
    const consent = evaluateConsentForDefinition(definition)
    if (consent.status !== 'granted') return undefined
    const runtime = options.getRuntime()
    const installation = options.getInstallation()
    const grants = getPluginCapabilityGrantStore()
    const deps: PluginManagementDeps = {
      listInstalled: () => installation.list(),
      runtimeOverview: () => {
        const snapshot = runtime.snapshot()
        return {
          revision: snapshot.revision,
          activePluginIds: snapshot.active.map(identity => identity.pluginId),
          instances: snapshot.instances.map(instance => ({
            pluginId: instance.identity.pluginId,
            runtimeInstanceId: instance.identity.runtimeInstanceId,
            version: instance.identity.version,
            status: instance.status,
            cleanup: instance.cleanup,
            // review P1-2：面板据此外置/内置分类（identity.version 不可靠——
            // first-party 包版本也是 semver）
            builtin: options.getBuiltinCriticality(instance.identity.pluginId) !== undefined,
          })),
        }
      },
      bootstrapOverview: () => {
        const state = options.getBootstrap().getSnapshot()
        if (state.kind === 'ready') {
          return { state: 'ready', activePluginIds: state.activePluginIds, failures: [], skippedPluginIds: [] }
        }
        if (state.kind === 'degraded') {
          return {
            state: 'degraded',
            activePluginIds: state.activePluginIds,
            failures: state.failures.map(failure => ({
              pluginId: failure.pluginId,
              stage: failure.stage,
              code: failure.code,
              message: failure.message,
              retryable: failure.retryable,
            })),
            skippedPluginIds: state.skippedPluginIds,
          }
        }
        if (state.kind === 'safe-mode') {
          return { state: 'safe-mode', activePluginIds: [], failures: [], skippedPluginIds: state.skippedPluginIds }
        }
        return { state: state.kind, activePluginIds: [], failures: [], skippedPluginIds: [] }
      },
      contractDiagnostics: () => installation.getContractSnapshot(),
      contributionOverview: () => readPluginContributionFacts(runtimeHostRegistries()),
      capabilityGrants: () => {
        const facts: PluginCapabilityGrantFact[] = []
        for (const [pluginId, capabilities] of Object.entries(grants.snapshot())) {
          for (const [capability, record] of Object.entries(capabilities)) {
            facts.push({
              pluginId,
              capability,
              grantedAt: record.grantedAt,
              pluginVersion: record.pluginVersion,
              apiVersion: record.apiVersion,
            })
          }
        }
        return facts
      },
      isCapabilityGranted: (pluginId, capability, pluginVersion) => (
        grants.getGrant(pluginId, capability as 'plugin.management', pluginVersion) !== undefined
      ),
      isProductRequired: pluginId => options.getBuiltinCriticality(pluginId) === 'product-required',
      processOverview: async () => {
        const descriptors = await hostProcessClient().list()
        return descriptors.map(descriptor => ({
          processId: descriptor.processId,
          pluginId: descriptor.pluginId,
          runtimeInstanceId: descriptor.runtimeInstanceId,
          status: descriptor.status,
          restartAttempts: descriptor.restartAttempts,
        }))
      },
      storageUsage: () => readPluginStorageUsage(),
      dependencyGraph: async () => {
        const nodes: PluginDependencyNode[] = [...builtinDependencyNodes()]
        const known = new Set(nodes.map(node => node.pluginId))
        const installed = await installation.list()
        for (const item of installed) {
          if (known.has(item.package.pluginId)) continue
          const manifest = item.package.manifest
          nodes.push({
            pluginId: manifest.id,
            kind: String(manifest.kind),
            version: item.package.version,
            builtin: false,
            dependencies: Object.keys(manifest.dependencies ?? {}),
            optionalDependencies: Object.keys(manifest.optionalDependencies ?? {}),
            conflicts: [...(manifest.conflicts ?? [])],
          })
        }
        return nodes.sort((a, b) => a.pluginId.localeCompare(b.pluginId))
      },
      terminatePluginProcess: processId => hostProcessClient().terminate(processId),
      retryCleanup: async runtimeInstanceId => {
        const result = await options.getRuntime().retryCleanup(runtimeInstanceId)
        if (result.complete) return { complete: true }
        const errors = [
          result.deactivateError?.message,
          ...result.scope.errors.map(error => error.message),
        ].filter((message): message is string => Boolean(message))
        return {
          complete: false,
          message: `清理未完成：${errors.join('；') || `${result.scope.remaining} 个资源残留`}`,
        }
      },
      clearPluginStorage: pluginId => clearPluginStorageNamespace(pluginId),
      setEnabled: (pluginId, enabled) => installation.setEnabled(pluginId, enabled),
      reload: pluginId => installation.reload(pluginId),
      uninstall: pluginId => installation.uninstall(pluginId),
      installOrUpdate: sourcePath => installation.installOrUpdate(sourcePath),
      setBuiltinEnabled: async (pluginId, enabled) => {
        if (enabled) {
          // review P1-2/A：retryPlugin 从不抛错（失败进 degraded snapshot），
          // 必须对照激活结果判定，否则启用失败被误报为成功
          await options.getBootstrap().retryPlugin(pluginId)
          const nowActive = options.getRuntime().snapshot().active.some(
            (identity: PluginIdentity) => identity.pluginId === pluginId,
          )
          if (!nowActive) {
            const failure = options.getBootstrap().getSnapshot()
            const reason = failure.kind === 'degraded'
              ? failure.failures.find(item => item.pluginId === pluginId)?.message
              : undefined
            return { ok: false, message: reason ?? `插件 ${pluginId} 未能激活` }
          }
          return { ok: true }
        }
        const active = runtime.snapshot().active.find(
          (identity: PluginIdentity) => identity.pluginId === pluginId,
        )
        if (!active) return { ok: true }
        const cleanup = await runtime.disable(pluginId)
        if (!cleanup.complete) {
          const errors = [
            cleanup.deactivateError?.message,
            ...cleanup.scope.errors.map(error => error.message),
          ].filter((message): message is string => Boolean(message))
          return {
            ok: false,
            message: `插件 ${pluginId} 清理未完成：${errors.join('；') || `${cleanup.scope.remaining} 个资源残留`}`,
          }
        }
        return { ok: true }
      },
    }
    return createPluginManagementApiBound({
      pluginId: definition.id,
      pluginVersion: definition.version ?? '0.0.0',
      scope,
      deps,
    })
  }
}
