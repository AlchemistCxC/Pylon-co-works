import type { PluginScope } from '../pluginScope.ts'
import {
  PLUGIN_MANAGEMENT_CAPABILITY,
  PluginManagementError,
  type PluginManagementApi,
  type PluginManagementDeps,
} from './pluginManagementTypes.ts'

/** 每次调用现查 grant；失效即抛 management_not_authorized（C4）。 */
function createPluginManagementApi(
  caller: { pluginId: string; pluginVersion: string },
  deps: PluginManagementDeps,
): PluginManagementApi {
  const assertAuthorized = () => {
    if (!deps.isCapabilityGranted(caller.pluginId, PLUGIN_MANAGEMENT_CAPABILITY, caller.pluginVersion)) {
      throw new PluginManagementError(
        'management_not_authorized',
        caller.pluginId,
        `插件 ${caller.pluginId} 的 plugin.management 授权已失效`,
      )
    }
  }
  const assertNotSelf = (pluginId: string) => {
    if (pluginId === caller.pluginId) {
      throw new PluginManagementError(
        'management_self_locked',
        pluginId,
        `管理操作目标不能是调用者自身：${pluginId}`,
      )
    }
  }
  const assertNotProductRequired = (pluginId: string) => {
    if (deps.isProductRequired(pluginId)) {
      throw new PluginManagementError(
        'management_product_required',
        pluginId,
        `产品运行所需插件不能停用：${pluginId}`,
      )
    }
  }
  const run = async (
    result: Promise<{ ok: boolean; message?: string }>,
  ): Promise<void> => {
    const outcome = await result
    if (!outcome.ok) throw new Error(outcome.message ?? '管理操作失败')
  }

  return {
    listInstalled() {
      assertAuthorized()
      return deps.listInstalled()
    },
    runtimeOverview() {
      assertAuthorized()
      return deps.runtimeOverview()
    },
    bootstrapOverview() {
      assertAuthorized()
      return deps.bootstrapOverview()
    },
    contractDiagnostics() {
      assertAuthorized()
      return deps.contractDiagnostics()
    },
    capabilityGrants() {
      assertAuthorized()
      return deps.capabilityGrants()
    },
    async setEnabled(pluginId, enabled) {
      assertAuthorized()
      assertNotSelf(pluginId)
      if (!enabled) assertNotProductRequired(pluginId)
      await run(deps.setEnabled(pluginId, enabled))
    },
    async reload(pluginId) {
      assertAuthorized()
      assertNotSelf(pluginId)
      await run(deps.reload(pluginId))
    },
    async uninstall(pluginId) {
      assertAuthorized()
      assertNotSelf(pluginId)
      await run(deps.uninstall(pluginId))
    },
    async installOrUpdate(sourcePath) {
      assertAuthorized()
      await run(deps.installOrUpdate(sourcePath))
    },
    async setBuiltinEnabled(pluginId, enabled) {
      assertAuthorized()
      assertNotSelf(pluginId)
      if (!enabled) assertNotProductRequired(pluginId)
      await run(deps.setBuiltinEnabled(pluginId, enabled))
    },
  }
}

export interface CreatePluginManagementApiOptions {
  readonly pluginId: string
  readonly pluginVersion: string
  readonly scope?: PluginScope
  readonly deps: PluginManagementDeps
}

export function createPluginManagementApiBound(options: CreatePluginManagementApiOptions): PluginManagementApi {
  const api = createPluginManagementApi(
    { pluginId: options.pluginId, pluginVersion: options.pluginVersion },
    options.deps,
  )
  // 异步操作经调用者 PluginScope 登记（守卫④）；scope 为空时（纯单测）跳过
  if (options.scope) {
    options.scope.add(() => undefined, { resourceId: `management-api:${options.pluginId}` })
  }
  return api
}

export { PLUGIN_MANAGEMENT_CAPABILITY } from './pluginManagementTypes.ts'
export { PluginManagementError } from './pluginManagementTypes.ts'
export type {
  PluginManagementApi,
  PluginManagementDeps,
  PluginManagementErrorCode,
  PluginRuntimeOverview,
  PluginRuntimeOverviewEntry,
  PluginBootstrapOverview,
  PluginBootstrapOverviewEntry,
  PluginContractDiagnostics,
  PluginCapabilityGrantFact,
} from './pluginManagementTypes.ts'
