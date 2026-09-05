/**
 * P53 D2 · 管理器包运行时桥（activation context → React 薄壳）。
 *
 * entry activate 时写入当前 runtime instance 的 management API；React 设置页
 * 薄壳经此读取。disable/reload 后旧实例的 API 随 stale 标记失效，新实例
 * 重新装配——薄壳每次挂载都现查，不持有陈旧引用。
 */
import type { PluginManagementApi } from '../../../../sdk/index.ts'

export interface PluginManagerRuntimeBridge {
  /** 现查当前授权有效的 management API；未授权/未激活返回 undefined。 */
  getManagement(): PluginManagementApi | undefined
  /** entry activate 装配；deactivate 卸载。 */
  setManagement(api: PluginManagementApi | undefined): void
}

let currentManagement: PluginManagementApi | undefined

export const pluginManagerRuntimeBridge: PluginManagerRuntimeBridge = Object.freeze({
  getManagement: () => currentManagement,
  setManagement(api: PluginManagementApi | undefined) {
    currentManagement = api
  },
})

export function getPluginManagerRuntimeBridge(): PluginManagerRuntimeBridge {
  return pluginManagerRuntimeBridge
}
