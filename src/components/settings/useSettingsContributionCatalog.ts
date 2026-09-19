import { useMemo, useSyncExternalStore } from 'react'
import { projectSettingsContributionCatalog } from './settingsContributionCatalog.ts'
import { createPluginSettingsValueAdapter } from '../../plugin-runtime/settings/pluginSettingsStore.ts'
import {
  getContextPanelRegistry,
  getPluginSettingsPageRegistry,
  getPluginSettingsStore,
  getRendererRegistry,
} from '../../plugin-runtime/runtimeServices.ts'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import { BUILTIN_INTERFACE_MODES } from '../../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { getInterfaceModeRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { resolveInterfaceModeSuite } from '../../application/transactions/activateInterfaceMode.ts'

/**
 * 设置贡献目录的共享投影（#154 阶段 4 抽取）。
 *
 * 设置迁入 sheet 体系后，主区（Settings.tsx）与左栏导航（SettingsSheetSidebar）
 * 是两棵独立的 React 树——导航的 renderers 三级项与插件页列表也需要同一份目录。
 * 本 hook 把注册表订阅 + 值适配器包装 + 目录投影收敛为单一来源，两树各订阅一份
 * （投影是纯函数，输入快照相同则结果一致）。
 */
export function useSettingsContributionCatalog() {
  const settingsPageRegistry = getPluginSettingsPageRegistry()
  const pluginSettingsPages = useSyncExternalStore(
    listener => settingsPageRegistry.subscribe(listener),
    () => settingsPageRegistry.getSnapshot(),
    () => settingsPageRegistry.getSnapshot(),
  ).entries
  const contextPanelRegistry = getContextPanelRegistry()
  const contextPanelEntries = useSyncExternalStore(
    listener => contextPanelRegistry.subscribe(listener),
    () => contextPanelRegistry.getSnapshot(),
    () => contextPanelRegistry.getSnapshot(),
  ).entries
  const pluginSettingsStore = getPluginSettingsStore()
  const rendererRegistry = getRendererRegistry()
  const rendererRegistrySnapshot = useSyncExternalStore(
    listener => rendererRegistry.subscribe(listener),
    () => rendererRegistry.snapshot(),
    () => rendererRegistry.snapshot(),
  )
  const activeRendererSuiteId = (() => {
    const modeId = useInterfaceModeStore.getState().interfaceMode
    const mode = getInterfaceModeRegistry().resolve(modeId)?.value ?? BUILTIN_INTERFACE_MODES.find(item => item.id === modeId)
    return mode?.workbench.renderKind === 'renderer-suite'
      ? resolveInterfaceModeSuite(mode, usePresentationPreferenceStore.getState().rendererSuiteIdByMode[mode.id], rendererRegistrySnapshot.rendererSuites.map(item => item.value.id)).activeSuiteId
      : undefined
  })()
  const pluginPagesForCatalog = useMemo(() => pluginSettingsPages.map(entry => {
    if (!entry.value.schema || entry.value.valueAdapter) return entry
    return { ...entry, value: { ...entry.value, valueAdapter: createPluginSettingsValueAdapter({ store: pluginSettingsStore, ownerPluginId: entry.ownerPluginId, contributionId: entry.contributionId, namespace: 'plugin-page' }) } }
  }), [pluginSettingsPages, pluginSettingsStore])
  const contextPanelsForCatalog = useMemo(() => contextPanelEntries.map(entry => {
    if (!entry.value.schema || entry.value.valueAdapter) return entry
    return { ...entry, value: { ...entry.value, valueAdapter: createPluginSettingsValueAdapter({ store: pluginSettingsStore, ownerPluginId: entry.ownerPluginId, contributionId: entry.contributionId, namespace: 'context-panel' }) } }
  }), [contextPanelEntries, pluginSettingsStore])
  const settingsContributionCatalog = useMemo(() => projectSettingsContributionCatalog({
    rendererSnapshot: rendererRegistrySnapshot,
    activeSuiteId: activeRendererSuiteId,
    pluginPages: pluginPagesForCatalog,
    contextPanels: contextPanelsForCatalog,
  }), [activeRendererSuiteId, rendererRegistrySnapshot, pluginPagesForCatalog, contextPanelsForCatalog])
  return { settingsContributionCatalog, pluginSettingsPages, rendererRegistrySnapshot, activeRendererSuiteId }
}
