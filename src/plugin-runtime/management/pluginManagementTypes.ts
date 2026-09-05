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

export interface PluginManagementDeps {
  /** 只读：已安装包清单（含 manifest 投影）。 */
  listInstalled(): Promise<readonly InstalledPluginPackage[]>
  /** 只读：runtime snapshot 投影。 */
  runtimeOverview(): PluginRuntimeOverview
  /** 只读：kernel bootstrap 状态投影。 */
  bootstrapOverview(): PluginBootstrapOverview
  /** 只读：包契约诊断（waiting_activation/契约阻止）。 */
  contractDiagnostics(): PluginContractDiagnostics
  /** 只读：授权事实投影。 */
  capabilityGrants(): readonly PluginCapabilityGrantFact[]
  /** 每次调用现查 grant；失效返回 false。 */
  isCapabilityGranted(pluginId: string, capability: string, pluginVersion: string): boolean
  /** product-required 内置包停用保护（对齐宿主页 UI 规则）。 */
  isProductRequired(pluginId: string): boolean
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
  capabilityGrants(): readonly PluginCapabilityGrantFact[]
  setEnabled(pluginId: string, enabled: boolean): Promise<void>
  reload(pluginId: string): Promise<void>
  uninstall(pluginId: string): Promise<void>
  installOrUpdate(sourcePath: string): Promise<void>
  setBuiltinEnabled(pluginId: string, enabled: boolean): Promise<void>
}
