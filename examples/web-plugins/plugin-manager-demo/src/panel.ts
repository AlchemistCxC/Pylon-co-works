/**
 * 外置管理器面板 —— 单一真源适配层（P53 D4 双形态要求："同一 panel/ DOM 源"）。
 *
 * 面板实现 = 内嵌第 6 包的 framework-free panel（src/plugins/product/packages/
 * builtin.pylon-plugin-manager/panel/pluginManagerPanel.ts），本模块只做签名
 * 适配并 re-export；esbuild 构建时把该源 bundle 进外置包，运行时零宿主内部
 * 依赖（仅 SDK 类型 import，编译期擦除）。
 */
import { mountPluginManagerPanel } from '../../../../src/plugins/product/packages/builtin.pylon-plugin-manager/panel/pluginManagerPanel.ts'
import type { PluginManagerPanelHandle, PluginManagerPanelOptions } from '../../../../src/plugins/product/packages/builtin.pylon-plugin-manager/panel/pluginManagerPanel.ts'
import type { PluginManagementApi } from '@pylon/plugin-sdk'

export type PanelManagement = PluginManagementApi
export type PanelHandle = PluginManagerPanelHandle

export function mountPanel(
  container: HTMLElement,
  management: PanelManagement | undefined,
  options: { onNotice?: (message: string) => void } = {},
): PanelHandle {
  const panelOptions: PluginManagerPanelOptions = {
    management,
    onNotice: options.onNotice,
  }
  return mountPluginManagerPanel(container, panelOptions)
}
