import type { PluginContractDiagnostic } from '../pluginContractResolver.ts'
import type { PluginDeactivateResult } from '../pluginInstance.ts'
import type { InstalledPluginPackage } from '../../infrastructure/plugins/pluginPackageClient.ts'

/**
 * API 1.2 PluginManagementApi（capability-gated：仅当插件声明
 * `plugin.management` 且用户已按 manifest version 授权时装配，P53 D1）。
 *
 * 守卫契约（typed 错误，见 PluginManagementErrorCode）：
 * - `management_self_locked`：目标 = 调用者自身时拒绝；
 * - `management_product_required`：product-required 内置包停用拒绝；
 * - `management_not_authorized`：每次调用现查 grant，失效即抛。
 */

export const PLUGIN_MANAGEMENT_CAPABILITY = 'plugin.management' as const

export type PluginManagementErrorCode =
  | 'management_self_locked'
  | 'management_product_required'
  | 'management_not_authorized'

export class PluginManagementError extends Error {
  constructor(
    readonly code: PluginManagementErrorCode,
    readonly pluginId: string,
    message: string,
  ) {
    super(message)
    this.name = 'PluginManagementError'
  }
}

export interface PluginRuntimeOverviewEntry {
  readonly pluginId: string
  readonly runtimeInstanceId: string
  readonly version: string
  readonly status: 'active' | 'deactivating' | 'inactive' | 'cleanup-failed'
  readonly cleanup?: PluginDeactivateResult
}

export interface PluginRuntimeOverview {
  readonly revision: number
  readonly activePluginIds: readonly string[]
  readonly instances: readonly PluginRuntimeOverviewEntry[]
}

export interface PluginBootstrapOverviewEntry {
  readonly pluginId: string
  readonly stage: string
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface PluginBootstrapOverview {
  readonly state: 'idle' | 'starting' | 'ready' | 'degraded' | 'safe-mode'
  readonly activePluginIds: readonly string[]
  readonly failures: readonly PluginBootstrapOverviewEntry[]
  readonly skippedPluginIds: readonly string[]
}

export interface PluginContractDiagnostics {
  readonly revision: number
  readonly eligibleIds: readonly string[]
  readonly diagnostics: readonly PluginContractDiagnostic[]
}

/** 影响到 manifest 声明能力的授权事实（只读投影；授予/拒绝是宿主职责）。 */
export interface PluginCapabilityGrantFact {
  readonly pluginId: string
  readonly capability: string
  readonly grantedAt: number
  readonly pluginVersion: string
  readonly apiVersion: string
}

/** 贡献面透视事实（registry 只读投影；surface → contributionId 清单）。 */
export interface PluginContributionFact {
  readonly pluginId: string
  readonly contributions: Readonly<Record<string, readonly string[]>>
  readonly total: number
}

/** 运行时监管：插件附带进程快照（host PluginProcessClient 投影）。 */
export interface PluginProcessOverviewEntry {
  readonly processId: string
  readonly pluginId: string
  readonly runtimeInstanceId: string
  readonly status: 'starting' | 'running' | 'stopping' | 'exited' | 'failed'
  readonly restartAttempts: number
}

/** 运行时监管：每插件存储用量/软配额（64 KiB 预算）。 */
export interface PluginStorageUsageEntry {
  readonly pluginId: string
  readonly usedBytes: number
  readonly budgetBytes: number
  readonly keyCount: number
}

/** 依赖契约诊断：依赖/冲突关系图节点（内置 + 已安装包 manifests 投影）。 */
export interface PluginDependencyNode {
  readonly pluginId: string
  readonly kind: string
  readonly version: string
  readonly builtin: boolean
  readonly dependencies: readonly string[]
  readonly optionalDependencies: readonly string[]
  readonly conflicts: readonly string[]
}

export interface PluginManagementDeps {
  /** 只读：已安装包清单（含 manifest 投影）。 */
  listInstalled(): Promise<readonly InstalledPluginPackage[]>
  /** 只读：runtime snapshot 投影。 */
  runtimeOverview(): PluginRuntimeOverview
  /** 只读：kernel bootstrap 状态投影。 */
  bootstrapOverview(): PluginBootstrapOverview
  /** 只读：包契约诊断（waiting_activation/契约阻止）。 */
  contractDiagnostics(): PluginContractDiagnostics
  /** 只读：每插件注册贡献摘要（贡献面透视，registry 只读投影）。 */
  contributionOverview(): readonly PluginContributionFact[]
  /** 只读：授权事实投影。 */
  capabilityGrants(): readonly PluginCapabilityGrantFact[]
  /** 每次调用现查 grant；失效返回 false。 */
  isCapabilityGranted(pluginId: string, capability: string, pluginVersion: string): boolean
  /** product-required 内置包停用保护（对齐宿主页 UI 规则）。 */
  isProductRequired(pluginId: string): boolean
  /** 只读：插件附带进程快照（监管，host PluginProcessClient 投影）。 */
  processOverview(): Promise<readonly PluginProcessOverviewEntry[]>
  /** 只读：每插件存储用量/软配额投影。 */
  storageUsage(): readonly PluginStorageUsageEntry[]
  /** 只读：依赖/冲突关系图（内置 + 已安装 manifests）。 */
  dependencyGraph(): Promise<readonly PluginDependencyNode[]>
  /** 运行时监管：终止插件附带进程（supervisor restart 策略拉起即"重启"）。 */
  terminatePluginProcess(processId: string): Promise<void>
  /** 清理失败重试：对 cleanup-failed 实例重跑既有 dispose 语义。 */
  retryCleanup(runtimeInstanceId: string): Promise<{ complete: boolean; message?: string }>
  /** 存储清理：按插件清空（既有 remove 语义，不涉其它插件）。 */
  clearPluginStorage(pluginId: string): void
  setEnabled(pluginId: string, enabled: boolean): Promise<{ ok: boolean; message?: string }>
  reload(pluginId: string): Promise<{ ok: boolean; message?: string }>
  uninstall(pluginId: string): Promise<{ ok: boolean; message?: string }>
  installOrUpdate(sourcePath: string): Promise<{ ok: boolean; message?: string }>
  /** 内置侧启用/停用（→ runtime.disable / retryBuiltinPlugin）。 */
  setBuiltinEnabled(pluginId: string, enabled: boolean): Promise<{ ok: boolean; message?: string }>
}

export interface PluginManagementApi {
  listInstalled(): Promise<readonly InstalledPluginPackage[]>
  runtimeOverview(): PluginRuntimeOverview
  bootstrapOverview(): PluginBootstrapOverview
  contractDiagnostics(): PluginContractDiagnostics
  contributionOverview(): readonly PluginContributionFact[]
  capabilityGrants(): readonly PluginCapabilityGrantFact[]
  processOverview(): Promise<readonly PluginProcessOverviewEntry[]>
  storageUsage(): readonly PluginStorageUsageEntry[]
  dependencyGraph(): Promise<readonly PluginDependencyNode[]>
  terminatePluginProcess(processId: string): Promise<void>
  retryCleanup(runtimeInstanceId: string): Promise<{ complete: boolean; message?: string }>
  clearPluginStorage(pluginId: string): void
  setEnabled(pluginId: string, enabled: boolean): Promise<void>
  reload(pluginId: string): Promise<void>
  uninstall(pluginId: string): Promise<void>
  installOrUpdate(sourcePath: string): Promise<void>
  setBuiltinEnabled(pluginId: string, enabled: boolean): Promise<void>
}
