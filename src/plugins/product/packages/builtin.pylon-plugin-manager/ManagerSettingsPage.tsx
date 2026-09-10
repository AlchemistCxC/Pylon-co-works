import { useEffect, useRef } from 'react'
import type { PluginSettingsPageProps } from '../../../../plugin-runtime/settings/pluginSettingsTypes.ts'
import { mountPluginManagerPanel, type PluginManagerPanelHandle } from './panel/pluginManagerPanel.ts'
import type { PluginManagementApi } from '../../../../sdk/index.ts'
import { getPluginManagerRuntimeBridge, type PluginManagerRuntimeBridge } from './runtimeBridge.ts'

/**
 * P53 D2 · 管理器设置页薄壳（renderKind 'first-party-react'）。
 *
 * 数据一律经 activation context 的 `management` API（runtimeBridge 由包内
 * entry activate 时装配）；本组件不 import 任何宿主内部单例。目录选择经
 * 宿主 UI 能力注入（tauri dialog 懒加载在 bridge 中完成）。
 */
export default function ManagerSettingsPage(_props: PluginSettingsPageProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const handleRef = useRef<PluginManagerPanelHandle | undefined>(undefined)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const bridge = getPluginManagerRuntimeBridge()
    const options = toPanelOptions(bridge)
    const handle = mountPluginManagerPanel(container, options)
    handleRef.current = handle
    return () => {
      handleRef.current = undefined
      handle.dispose()
    }
  }, [])

  return <div ref={containerRef} className="pypm-page" data-plugin-manager-page="builtin.pylon-plugin-manager" />
}

function toPanelOptions(bridge: PluginManagerRuntimeBridge): {
  management?: PluginManagementApi
  pickDirectory?: () => Promise<string | null>
  pickZipFile?: () => Promise<string | null>
  promptUrl?: () => Promise<string | null>
} {
  const management = bridge.getManagement()
  if (!management) return {}
  const openHostDialog = async (options: { directory?: boolean; zip?: boolean }): Promise<string | null> => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({
        directory: options.directory === true,
        multiple: false,
        title: options.zip ? '选择插件 zip 包' : '选择插件包目录',
        ...(options.zip ? { filters: [{ name: '插件包', extensions: ['zip'] }] } : {}),
      })
      return typeof selected === 'string' ? selected : null
    } catch {
      return null
    }
  }
  return {
    management,
    pickDirectory: () => openHostDialog({ directory: true }),
    pickZipFile: () => openHostDialog({ zip: true }),
    promptUrl: async () => {
      const input = window.prompt('输入插件包 https URL（仅支持 https）')
      const trimmed = input?.trim()
      return trimmed ? trimmed : null
    },
  }
}
