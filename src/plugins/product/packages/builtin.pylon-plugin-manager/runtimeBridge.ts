/**
 * P53 D2 · 管理器包运行时桥（activation context → React 薄壳）。
 *
 * entry activate 时写入当前 runtime instance 的 management API；React 设置页
 * 薄壳经此读取。清除按持有者判定（review P1-1）：parallel 热替换时新实例先
 * activate、旧实例后 deactivate，只有持有者本人清除才生效——避免旧实例的
 * deactivate 把新实例刚装配的 API 清掉。
 */
import type { PluginManagementApi } from '../../../../sdk/index.ts'

export interface PluginManagerRuntimeBridge {
  /** 现查当前授权有效的 management API；未授权/未激活返回 undefined。 */
  getManagement(): PluginManagementApi | undefined
  /** entry activate 装配（记录持有者 runtimeInstanceId）。 */
  setManagement(api: PluginManagementApi | undefined, ownerRuntimeInstanceId: string): void
  /** entry deactivate 清除；仅当清除者是当前持有者才生效。 */
  clearManagement(ownerRuntimeInstanceId: string): void
}

let currentManagement: PluginManagementApi | undefined
let currentOwner: string | undefined

export const pluginManagerRuntimeBridge: PluginManagerRuntimeBridge = Object.freeze({
  getManagement: () => currentManagement,
  setManagement(api: PluginManagementApi | undefined, ownerRuntimeInstanceId: string) {
    currentManagement = api
    currentOwner = ownerRuntimeInstanceId
  },
  clearManagement(ownerRuntimeInstanceId: string) {
    if (currentOwner !== ownerRuntimeInstanceId) return
    currentManagement = undefined
    currentOwner = undefined
  },
})

export function getPluginManagerRuntimeBridge(): PluginManagerRuntimeBridge {
  return pluginManagerRuntimeBridge
}
