import { createEffect, createMemo, createSignal, onMount, Show } from 'solid-js'
import { createElement, type ReactElement, type ReactNode } from 'react'
import { createSolidMount } from '../host/solidBridge.solid'
import { createZustandSignal } from '../host/solidStoreBridge.ts'
import { createRegistrySignal, ReactIslandHost } from '../sheets/solidSheetSupport.solid.tsx'
import { useStore } from '../domains/theme/themeStore'
import { useCustomPresetStore } from '../domains/theme/customPresetStore'
import type { ThemeSettings } from '../domains/theme/themeStore'
import { normalizeCustomPresetId, pickCustomPresetTheme } from '../domains/theme/customPresets'
import { INTERFACE_MODE_PRESET_BUCKET } from '../domains/theme/presets/index.ts'
import type { PresetApplyResult } from '../domains/theme/presetBundle.ts'
import { resolveZonePresetEntryTheme, type ZonePresetEntry } from '../domains/theme/zones/index.ts'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import { useSettingsChromeStore } from '../domains/appearance/settingsChromeStore.ts'
import { useRightRailStore } from '../domains/workspace/layoutRailsStore.ts'
import { pulseSettingsAnchor } from '../utils/anchorPulse.ts'
import { usePresentationPreferenceStore } from '../domains/presentation/presentationPreferenceStore.ts'
import {
  getContextPanelRegistry,
  getPluginSettingsPageRegistry,
  getPluginSettingsStore,
  getRendererRegistry,
} from '../plugin-runtime/runtimeServices.ts'
import { createPluginSettingsValueAdapter } from '../plugin-runtime/settings/pluginSettingsStore.ts'
import { findInterfaceModeContribution } from '../app/interfaceModeLookup.ts'
import { resolveInterfaceModeSuite } from '../application/transactions/activateInterfaceMode.ts'
import { applyGlobalPreset as applyGlobalPresetTransaction } from '../application/transactions/applyGlobalPreset.ts'
import { projectSettingsContributionCatalog, type SettingsContributionCatalog } from './settings/settingsContributionCatalog.ts'
import type { RendererRegistrySnapshot } from '../plugin-runtime/renderers/rendererRegistry.ts'
// I13-W1：Settings 一级信息架构唯一真值（domain → section + 字段归属派生）
import { SETTINGS_SECTION_LABELS, sectionZone, SETTINGS_DOMAINS, type SettingsDomainId, type SettingsSectionId, type SettingsSearchItem } from './settings/settingsDomains'
import type { WorkspaceViewProps } from '../plugin-runtime/workspaces/workspaceTypes.ts'
import type { SettingsSheetState } from '../workspace-sheets/settingsSheetState.ts'
import type { RendererSettingsCatalogEntry } from './settings/rendererSettingsCatalog.ts'
// Solid 域内直连实体（settings/* 已实体化）
import { type RenderCtx } from './settings/themeFieldRenderer.solid.tsx'
import SettingsPreviewSolid from './SettingsPreview.solid.tsx'
import TemplateLibrarySolid from './settings/TemplateLibrary.solid.tsx'
import WindowPanelSolid from './settings/WindowPanel.solid.tsx'
import ConfigBackupPanelSolid from './settings/ConfigBackupPanel.solid.tsx'
import HistoryRetentionSolid from './settings/HistoryRetention.solid.tsx'
import GatewayRiskPanelSolid from './settings/GatewayRiskPanel.solid.tsx'
import InputPredictionSettingsPanelSolid from './settings/InputPredictionSettingsPanel.solid.tsx'
import HookDiagnosticsPanelSolid from './settings/HookDiagnosticsPanel.solid.tsx'
import GlobalPresetSectionSolid, { Group } from './settings/GlobalPresetSection.solid.tsx'
// ---- React 岛（#515 迁移期：这些 settings 子组件仍是 React 面，批7 后随 React 面退役；
// 类型图不触碰 React 组件文件，模块接口就地声明，与实体侧逐字段一致）。 ----

interface SettingsSectionHeaderProps {
  section: SettingsSectionId
  density: 'basic' | 'standard' | 'all'
  onDensity: (density: 'basic' | 'standard' | 'all') => void
}

interface SettingsSectionHeaderModule {
  default: (props: SettingsSectionHeaderProps) => ReactElement
}

const sectionHeaderModules = import.meta.glob<SettingsSectionHeaderModule>('./settings/SettingsSectionHeader.tsx', { eager: true })
const SettingsSectionHeader = sectionHeaderModules['./settings/SettingsSectionHeader.tsx']?.default
if (!SettingsSectionHeader) throw new Error('SettingsSectionHeader React 面未进入 Vite module graph')

interface ZonePresetSectionProps {
  zone: 'sidebar' | 'chat' | 'cc' | 'right'
  label?: string
  isSearching: boolean
  interfaceMode: string
  fields: ReactElement
  header?: ReactElement
  footer?: ReactElement
  onApplyZonePreset: (zone: ZonePresetEntry['zone'], entry: ZonePresetEntry) => void
  onSaveZonePresetEntry: (zone: ZonePresetEntry['zone'], name: string) => void
  onRemoveZonePresetEntry: (id: string) => void
}

interface ZonePresetSectionModule {
  default: (props: ZonePresetSectionProps) => ReactElement
}

const zonePresetModules = import.meta.glob<ZonePresetSectionModule>('./settings/ZonePresetSection.tsx', { eager: true })
const ZonePresetSection = zonePresetModules['./settings/ZonePresetSection.tsx']?.default
if (!ZonePresetSection) throw new Error('ZonePresetSection React 面未进入 Vite module graph')

interface ReactGroupProps {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}

interface SettingsSectionSharedModule {
  Group: (props: ReactGroupProps) => ReactElement
}

const sectionSharedModules = import.meta.glob<SettingsSectionSharedModule>('./settings/settingsSectionShared.tsx', { eager: true })
const ReactGroup = sectionSharedModules['./settings/settingsSectionShared.tsx']?.Group
if (!ReactGroup) throw new Error('settingsSectionShared React 面未进入 Vite module graph')

interface ReactZoneGroupFieldsProps {
  zone: ZonePresetEntry['zone']
  ctx: RenderCtx
  density?: 'basic' | 'standard' | 'all'
}

interface ThemeFieldRendererModule {
  ZoneGroupFields: (props: ReactZoneGroupFieldsProps) => ReactElement
}

const themeFieldModules = import.meta.glob<ThemeFieldRendererModule>('./settings/themeFieldRenderer.tsx', { eager: true })
const ZoneGroupFieldsReact = themeFieldModules['./settings/themeFieldRenderer.tsx']?.ZoneGroupFields
if (!ZoneGroupFieldsReact) throw new Error('themeFieldRenderer React 面未进入 Vite module graph')

interface NoPropsModule {
  default: (props: Record<string, never>) => ReactElement
}

const sidebarModulesModules = import.meta.glob<NoPropsModule>('./settings/SidebarModulesPanel.tsx', { eager: true })
const SidebarModulesPanelBridge = sidebarModulesModules['./settings/SidebarModulesPanel.tsx']?.default
if (!SidebarModulesPanelBridge) throw new Error('SidebarModulesPanel React 面未进入 Vite module graph')

const presentationModules = import.meta.glob<NoPropsModule>('./settings/PresentationProfilePicker.tsx', { eager: true })
const PresentationProfilePickerBridge = presentationModules['./settings/PresentationProfilePicker.tsx']?.default
if (!PresentationProfilePickerBridge) throw new Error('PresentationProfilePicker React 面未进入 Vite module graph')

const pluginManagerModules = import.meta.glob<NoPropsModule>('./settings/PluginManager.tsx', { eager: true })
const PluginManager = pluginManagerModules['./settings/PluginManager.tsx']?.default
if (!PluginManager) throw new Error('PluginManager React 面未进入 Vite module graph')

interface PluginSettingsPageHostProps {
  pageId: string
}

interface PluginSettingsPageHostModule {
  default: (props: PluginSettingsPageHostProps) => ReactElement
}

const pluginPageHostModules = import.meta.glob<PluginSettingsPageHostModule>('./settings/PluginSettingsPageHost.tsx', { eager: true })
const PluginSettingsPageHost = pluginPageHostModules['./settings/PluginSettingsPageHost.tsx']?.default
if (!PluginSettingsPageHost) throw new Error('PluginSettingsPageHost React 面未进入 Vite module graph')

interface AgentSettingsSectionProps {
  initialAgentId?: string
  activeSessionContext?: { agentId: string; source: string }
}

interface AgentSettingsSectionModule {
  default: (props: AgentSettingsSectionProps) => ReactElement
}

const agentSectionModules = import.meta.glob<AgentSettingsSectionModule>('./settings/AgentSettingsSection.tsx', { eager: true })
const AgentSettingsSection = agentSectionModules['./settings/AgentSettingsSection.tsx']?.default
if (!AgentSettingsSection) throw new Error('AgentSettingsSection React 面未进入 Vite module graph')

interface RendererSettingsPanelProps {
  search?: string
  categoryId?: string
  objectKey?: string
  density?: 'basic' | 'standard' | 'all'
  settingsCatalog: SettingsContributionCatalog
  onSelectionChange: (entry: RendererSettingsCatalogEntry | undefined) => void
}

interface RendererSettingsPanelModule {
  default: (props: RendererSettingsPanelProps) => ReactElement
}

const rendererPanelModules = import.meta.glob<RendererSettingsPanelModule>('./settings/RendererSettingsPanel.tsx', { eager: true })
const RendererSettingsPanel = rendererPanelModules['./settings/RendererSettingsPanel.tsx']?.default
if (!RendererSettingsPanel) throw new Error('RendererSettingsPanel React 面未进入 Vite module graph')

interface RendererSettingsPreviewProps {
  entry?: RendererSettingsCatalogEntry
  catalog: RendererRegistrySnapshot
  activeSuiteId?: string
  settingsCatalog?: SettingsContributionCatalog
}

interface RendererSettingsPreviewModule {
  default: (props: RendererSettingsPreviewProps) => ReactElement
}

const rendererPreviewModules = import.meta.glob<RendererSettingsPreviewModule>('./settings/RendererSettingsPreview.tsx', { eager: true })
const RendererSettingsPreview = rendererPreviewModules['./settings/RendererSettingsPreview.tsx']?.default
if (!RendererSettingsPreview) throw new Error('RendererSettingsPreview React 面未进入 Vite module graph')

interface SettingsQuickSearchProps {
  open: boolean
  items: readonly SettingsSearchItem[]
  onNavigate: (item: SettingsSearchItem) => void
  onOpenChange: (open: boolean) => void
}

interface SettingsQuickSearchModule {
  default: (props: SettingsQuickSearchProps) => ReactElement
}

const quickSearchModules = import.meta.glob<SettingsQuickSearchModule>('./settings/SettingsQuickSearch.tsx', { eager: true })
const SettingsQuickSearch = quickSearchModules['./settings/SettingsQuickSearch.tsx']?.default
if (!SettingsQuickSearch) throw new Error('SettingsQuickSearch React 面未进入 Vite module graph')

/**
 * 设置贡献目录的共享投影（`useSettingsContributionCatalog` 的 Solid 形态，#515 内联；
 * 注册表订阅经 createRegistrySignal，语义与 React useSyncExternalStore 版一致）。
 * 须在响应式 owner 内调用。
 */
export function createSettingsContributionCatalog() {
  const settingsPageRegistry = getPluginSettingsPageRegistry()
  const settingsPageSnapshot = createRegistrySignal(settingsPageRegistry, () => settingsPageRegistry.getSnapshot())
  const contextPanelRegistry = getContextPanelRegistry()
  const contextPanelSnapshot = createRegistrySignal(contextPanelRegistry, () => contextPanelRegistry.getSnapshot())
  const pluginSettingsStore = getPluginSettingsStore()
  const rendererRegistry = getRendererRegistry()
  const rendererRegistrySnapshot = createRegistrySignal(rendererRegistry, () => rendererRegistry.snapshot())
  const interfaceMode = createZustandSignal(useInterfaceModeStore, s => s.interfaceMode)
  const rendererSuiteIdByMode = createZustandSignal(usePresentationPreferenceStore, s => s.rendererSuiteIdByMode)

  const activeRendererSuiteId = createMemo(() => {
    const snapshot = rendererRegistrySnapshot()
    const mode = findInterfaceModeContribution(interfaceMode())
    return mode?.workbench.renderKind === 'renderer-suite'
      ? resolveInterfaceModeSuite(mode, rendererSuiteIdByMode()[mode.id], snapshot.rendererSuites.map(item => item.value.id)).activeSuiteId
      : undefined
  })
  const pluginSettingsPages = createMemo(() => settingsPageSnapshot().entries)
  const pluginPagesForCatalog = createMemo(() => pluginSettingsPages().map(entry => {
    if (!entry.value.schema || entry.value.valueAdapter) return entry
    return { ...entry, value: { ...entry.value, valueAdapter: createPluginSettingsValueAdapter({ store: pluginSettingsStore, ownerPluginId: entry.ownerPluginId, contributionId: entry.contributionId, namespace: 'plugin-page' }) } }
  }))
  const contextPanelEntries = createMemo(() => contextPanelSnapshot().entries)
  const contextPanelsForCatalog = createMemo(() => contextPanelEntries().map(entry => {
    if (!entry.value.schema || entry.value.valueAdapter) return entry
    return { ...entry, value: { ...entry.value, valueAdapter: createPluginSettingsValueAdapter({ store: pluginSettingsStore, ownerPluginId: entry.ownerPluginId, contributionId: entry.contributionId, namespace: 'context-panel' }) } }
  }))
  const settingsContributionCatalog = createMemo(() => projectSettingsContributionCatalog({
    rendererSnapshot: rendererRegistrySnapshot(),
    activeSuiteId: activeRendererSuiteId(),
    pluginPages: pluginPagesForCatalog(),
    contextPanels: contextPanelsForCatalog(),
  }))
  return { settingsContributionCatalog, pluginSettingsPages, rendererRegistrySnapshot, activeRendererSuiteId }
}

export interface SettingsProps extends WorkspaceViewProps<SettingsSheetState> {}

/**
 * Settings — 设置 sheet 主组件（A-V3 拆分后只保留装配职责）：
 * sheet 导航状态、主题字段渲染上下文（renderCtx）、分区路由（renderSection 委托
 * 各 section 组件）、搜索框与预览栏 chrome 态。Agent 运维事务在
 * settings/AgentSettingsSection；全局预设事务在 settings/GlobalPresetSection；
 * 区域分区骨架在 settings/ZonePresetSection；速搜定位在 useSettingsSearchNavigation。
 *
 * #515：Solid 实体——settings/* 已实体化的子组件直连 .solid；仍为 React 面的子组件
 * （AgentSettingsSection / ZonePresetSection / PluginManager / RendererSettings* /
 * PluginSettingsPageHost / SettingsSectionHeader / SettingsQuickSearch）经 ReactIslandHost
 * 岛挂载（批7 后随 React 面退役）；原 useSettingsSearchNavigation hook 的定位态内联。
 */
export default function Settings(props: SettingsProps) {
  // #154 阶段 4：设置由固定覆盖层迁入 sheet 体系。导航真值（domain/section/pluginPageId/
  // agentId）改为 sheet 状态（持久化、随 workspace 布局落盘），本组件只保留视图局部态。
  // 深链 `pylon:open-settings` 的打开/聚焦/patch 由 App 层 openOrFocusSettingsSheet 统一处理。
  const activeDomain = () => props.state.domain
  const activeSection = () => props.state.section
  const activePluginPageId = () => props.state.pluginPageId ?? null
  const navigate = (partial: {
    domain?: SettingsDomainId
    section?: SettingsSectionId
    pluginPageId?: string | null
    agentId?: string | null
    rendererCategoryId?: string | null
  }) => useWorkspaceStore.getState().patchSheetState(props.sheet.id, partial as Record<string, unknown>)

  // 只订阅主题字段 + ccEditMode：后台生成时的 live 状态（token/生成源）不再穿透整棵设置树。
  // pickCustomPresetTheme 白名单覆盖 Settings 全部 t.xxx 访问（已核对），ccEditMode 单独补。
  const themeState = createZustandSignal(useStore, s => s)
  const t = createMemo(() => ({ ...pickCustomPresetTheme(themeState()), ccEditMode: themeState().ccEditMode } as ThemeSettings & { ccEditMode: boolean }))

  // 刀6（#206）：区域预设池自定义条目的存入口 + Q8 落盘清理（每次打开设置过一遍，
  // 读入容错也在此收口；无变化不写状态）。
  onMount(() => { useCustomPresetStore.getState().pruneZonePresetEntries() })
  const currentInterfaceMode = createZustandSignal(useInterfaceModeStore, s => s.interfaceMode)
  const sessions = createZustandSignal(useIdentityStore, s => s.sessions)
  // I01-W2：动态配置按 AgentContext（agentId+source）读写
  const activeSessionContext = createMemo(() => {
    const session = sessions().find(item => item.id === props.ctx.activeSession)
    return session ? { agentId: session.agentId, source: session.source } : undefined
  })
  const { settingsContributionCatalog, pluginSettingsPages, rendererRegistrySnapshot, activeRendererSuiteId } = createSettingsContributionCatalog()
  const [searchQuery, setSearchQuery] = createSignal('')
  // #154 阶段 4：renderers 分类导航位随 sheet 状态持久化（侧栏三级项与速搜命中同源）。
  const rendererCategoryId = () => props.state.rendererCategoryId ?? 'markdown-text'
  const [rendererObjectKey, setRendererObjectKey] = createSignal<string | undefined>()
  const [rendererPreviewEntry, setRendererPreviewEntry] = createSignal<RendererSettingsCatalogEntry>()

  // K-1：密度档 chrome 态（A-V12 收敛为 settingsChromeStore 单一持久化机制）
  const density = createZustandSignal(useSettingsChromeStore, s => s.density)

  // #116 子项 8：预览栏折叠（chrome 态，持久化；折叠后正文宽度回升）
  const previewCollapsed = createZustandSignal(useSettingsChromeStore, s => s.previewCollapsed)
  const togglePreviewCollapsed = () => {
    useSettingsChromeStore.getState().setPreviewCollapsed(!previewCollapsed())
  }

  // 改单个字段 — 标记当前 section 对应的 zone 为 custom（非主题 section 回退 global）
  const onSettingChange = (partial: Partial<ThemeSettings>) => {
    const zone = sectionZone(activeSection()) || 'global'
    useStore.getState().setZoneField(zone, partial)
  }
  // 声明式字段渲染上下文（骨架 3）：纯字段组由 themeFieldRenderer 自动渲染
  const renderCtx = createMemo<RenderCtx>(() => ({ t: t(), onChange: onSettingChange, search: searchQuery() }))
  // 搜索时隐藏手写组（预设/布局骨架/窗口/配置备份等非主题字段），只留命中的自动字段组
  const isSearching = createMemo(() => searchQuery().trim().length > 0)

  // 局部预设（zone 级别）：出厂条目现场切来源预设、自定义条目直接用值快照。
  // 出厂条目的 id === 来源预设名 ⇒ appliedPreset[zone] 记的名字与刀5 完全一致。
  const applyLocalPreset = (zone: ZonePresetEntry['zone'], entry: ZonePresetEntry) => {
    const theme = resolveZonePresetEntryTheme(entry)
    if (!theme) return
    useStore.getState().applyZonePreset(zone, entry.id, theme)
  }

  // 「存当前为自定义」：存 = pickZoneFields(当前主题, zone)，随后立刻应用同一条目，
  // 使新条目成为该区基准（与全局预设「保存当前」后立即应用同一交互）。
  const modeBucket = createMemo(() => INTERFACE_MODE_PRESET_BUCKET[currentInterfaceMode()])
  const saveZonePresetEntryFromSettings = (zone: ZonePresetEntry['zone'], name: string) => {
    if (!modeBucket()) return
    const id = useCustomPresetStore.getState().saveZonePresetEntry(modeBucket()!, zone, name)
    if (!id) return
    const entry = useCustomPresetStore.getState().zonePresetEntries.find(item => item.id === id)
    const theme = entry ? resolveZonePresetEntryTheme(entry) : null
    if (theme) useStore.getState().applyZonePreset(zone, id, theme)
  }

  // 应用全局预设（templates 区与 GlobalPresetSection 各自经事务薄壳调用）
  const applyGlobalPresetByName = (name: string) => {
    applyGlobalPresetTransaction(name)
  }
  const applyCustomPresetTransaction = (requestedId: string): Promise<PresetApplyResult> =>
    useCustomPresetStore.getState().applyCustomPreset(normalizeCustomPresetId(requestedId))

  const previewZone = createMemo(() => sectionZone(activeSection()))

  createEffect(() => {
    const pluginPageId = activePluginPageId()
    if (pluginPageId && !pluginSettingsPages().some(entry => entry.contributionId === pluginPageId)) {
      navigate({ pluginPageId: null, section: 'pluginManager' })
    }
  })

  // useSettingsSearchNavigation（A-V3）Solid 形态内联：命令面板开合、索引缓存语义
  // （面板打开或 catalog 热更时重算）、navigateToField 三路跳转 + 锚点滚动与脉冲。
  const [quickSearchOpen, setQuickSearchOpen] = createSignal(false)
  const quickSearchItems = createMemo(() => {
    // 显式引用依赖项：它们是缓存失效信号（B2），非数据来源。
    void quickSearchOpen()
    void rendererRegistrySnapshot().revision
    return settingsContributionCatalog().searchItems
  })
  const navigateToField = (item: SettingsSearchItem) => {
    const setDensity = useSettingsChromeStore.getState().setDensity
    if (item.contextPanelId) {
      navigate({ domain: 'appearance', section: 'right', pluginPageId: null })
      useRightRailStore.getState().setActivePanel(item.contextPanelId)
      useRightRailStore.getState().setCollapsed(false)
      if (item.anchor) requestAnimationFrame(() => document.querySelector(`[data-search-anchor="${CSS.escape(item.anchor!)}"]`)?.scrollIntoView({ block: 'center' }))
      return
    }
    if (item.pluginPageId) {
      navigate({ domain: 'plugins', section: 'pluginManager', pluginPageId: item.pluginPageId })
      if (item.anchor) requestAnimationFrame(() => document.querySelector(`[data-search-anchor="${CSS.escape(item.anchor!)}"]`)?.scrollIntoView({ block: 'center' }))
      return
    }
    if (item.rendererRoute) {
      navigate({ rendererCategoryId: item.rendererRoute.categoryId })
      setRendererObjectKey(item.rendererRoute.objectKey)
      setSearchQuery(item.label)
    }
    // F1 边界修复：section → 所属 domain 反查（SETTINGS_DOMAINS 单一真值派生）
    const domainOfSection = (section: string): SettingsDomainId | undefined =>
      SETTINGS_DOMAINS.find(d => (d.sections as readonly string[]).includes(section))?.id
    navigate({ section: item.section, domain: domainOfSection(item.section) ?? activeDomain(), pluginPageId: null })
    if (density() !== 'all') setDensity('all')  // D2-A：advanced 命中自动切全部档
    requestAnimationFrame(() => {
      // B3 边界修复：优先唯一锚定位（重名字段如多个「背景图」不再误跳第一处）
      let target: Element | null = null
      if (item.anchor) target = document.querySelector(`[data-search-anchor="${CSS.escape(item.anchor)}"]`)
      if (!target) {
        // 链B entry 无字段级锚——回退到组标题文本匹配
        target = [...document.querySelectorAll('.set-group-title, .renderer-settings-group-heading h3')]
          .find(el => el.textContent?.includes(item.label)) ?? null
      }
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      const group = target?.closest('[data-group-anchor], .renderer-settings-group, .set-group')
      if (group instanceof HTMLElement) pulseSettingsAnchor(group)
    })
  }

  // I13-W1：section → 内容（复用既有块/组件，视觉 token 与字段行为不变）
  const renderSection = (section: SettingsSectionId) => {
    switch (section) {
      case 'templates':
        return (
          <Group title="模板库">
            <TemplateLibrarySolid onApply={applyGlobalPresetByName} onRestore={applyGlobalPresetByName} onCustomApply={applyCustomPresetTransaction} />
          </Group>
        )
      case 'window':
        return <WindowPanelSolid />
      case 'history':
        return <HistoryRetentionSolid />
      case 'backup':
        return <ConfigBackupPanelSolid />
      case 'global':
        return (
          <GlobalPresetSectionSolid isSearching={isSearching()} ctx={renderCtx()} density={density()} />
        )
      case 'sidebar':
        return (
          <ReactIslandHost element={() => createElement(ZonePresetSection, {
            zone: 'sidebar',
            label: SETTINGS_SECTION_LABELS.sidebar,
            isSearching: isSearching(),
            interfaceMode: currentInterfaceMode(),
            header: !isSearching() ? createElement(ReactGroup, { title: '模块', children: createElement(SidebarModulesPanelBridge) }) : undefined,
            fields: createElement(ZoneGroupFieldsReact, { zone: 'sidebar', ctx: renderCtx(), density: density() }),
            onApplyZonePreset: applyLocalPreset,
            onSaveZonePresetEntry: saveZonePresetEntryFromSettings,
            onRemoveZonePresetEntry: id => useCustomPresetStore.getState().removeZonePresetEntry(id),
          })} />
        )
      case 'chat':
        return (
          <ReactIslandHost element={() => createElement(ZonePresetSection, {
            zone: 'chat',
            isSearching: isSearching(),
            interfaceMode: currentInterfaceMode(),
            header: !isSearching() ? createElement(ReactGroup, { title: '渲染风格', children: createElement(PresentationProfilePickerBridge) }) : undefined,
            fields: createElement(ZoneGroupFieldsReact, { zone: 'chat', ctx: renderCtx(), density: density() }),
            onApplyZonePreset: applyLocalPreset,
            onSaveZonePresetEntry: saveZonePresetEntryFromSettings,
            onRemoveZonePresetEntry: id => useCustomPresetStore.getState().removeZonePresetEntry(id),
          })} />
        )
      case 'renderers':
        return (
          <ReactIslandHost element={() => createElement(RendererSettingsPanel, {
            search: searchQuery(),
            categoryId: rendererCategoryId(),
            objectKey: rendererObjectKey(),
            density: density(),
            settingsCatalog: settingsContributionCatalog(),
            onSelectionChange: setRendererPreviewEntry,
          })} />
        )
      case 'cc':
        return (
          <ReactIslandHost element={() => createElement(ZonePresetSection, {
            zone: 'cc',
            label: SETTINGS_SECTION_LABELS.cc,
            isSearching: isSearching(),
            interfaceMode: currentInterfaceMode(),
            fields: createElement(ZoneGroupFieldsReact, { zone: 'cc', ctx: renderCtx(), density: density() }),
            footer: !isSearching() ? createElement(ReactGroup, {
              title: '布局编辑',
              children: [
                createElement('button', {
                  type: 'button',
                  className: 'ps-btn primary',
                  onClick: () => {
                    const cur = useStore.getState().ccEditMode
                    useStore.getState().setCcEditMode(!cur)
                    if (!cur) props.ctx.closeSheet(props.sheet.id)
                  },
                }, t().ccEditMode ? '退出布局编辑器' : '进入布局编辑器'),
                createElement('div', { className: 'set-hint' }, '位置 / 大小 / 显隐 在编辑器中拖拽调整'),
              ],
            }) : undefined,
            onApplyZonePreset: applyLocalPreset,
            onSaveZonePresetEntry: saveZonePresetEntryFromSettings,
            onRemoveZonePresetEntry: id => useCustomPresetStore.getState().removeZonePresetEntry(id),
          })} />
        )
      case 'right':
        return (
          <ReactIslandHost element={() => createElement(ZonePresetSection, {
            zone: 'right',
            label: SETTINGS_SECTION_LABELS.right,
            isSearching: isSearching(),
            interfaceMode: currentInterfaceMode(),
            fields: createElement(ZoneGroupFieldsReact, { zone: 'right', ctx: renderCtx(), density: density() }),
            onApplyZonePreset: applyLocalPreset,
            onSaveZonePresetEntry: saveZonePresetEntryFromSettings,
            onRemoveZonePresetEntry: id => useCustomPresetStore.getState().removeZonePresetEntry(id),
          })} />
        )
      case 'agent':
        return (
          <ReactIslandHost element={() => {
            // 岛重渲触发：活动会话变化要透传（原 React 父渲染语义）。
            void activeSessionContext()
            return createElement(AgentSettingsSection, {
              initialAgentId: props.state.agentId,
              activeSessionContext: activeSessionContext(),
            })
          }} />
        )
      case 'session':
        return (
          <div class="settings-empty-state">
            <span class="settings-empty-kicker">当前会话</span>
            <h3>会话设置从会话入口打开</h3>
            <p>在左栏目标会话右侧点击设置按钮，可编辑工作目录与 Session Prompt。会话级 Skills / Hooks 暂未接入运行时。</p>
          </div>
        )
      case 'gateway':
        // I13-W5：Gateway 风险 consumer——真实实例/凭据状态 + 备份边界提示（不伪装备份加密）
        return <GatewayRiskPanelSolid />
      case 'prediction':
        return <InputPredictionSettingsPanelSolid />
      case 'pluginManager': {
        // P53：插件管理默认进入管理器插件提供的页面（贡献存在时）；
        // 包未激活/未授权时贡献不存在，回落宿主基础页（承载能力授权卡）。
        const managerPage = pluginSettingsPages().find(entry => entry.contributionId === 'pylon-plugin-manager')
        return managerPage
          ? <ReactIslandHost element={() => createElement(PluginSettingsPageHost, { pageId: managerPage.contributionId })} />
          : <ReactIslandHost element={() => createElement(PluginManager)} />
      }
      case 'hookDiagnostics':
        return <HookDiagnosticsPanelSolid />
    }
  }

  return (
    <div class="settings flex flex-1 min-w-0" data-settings-domain={activeDomain()} data-settings-section={activeSection()}>
      {/* #154 阶段 4：对话框外壳（role=dialog/焦点陷阱/settings-header/关闭钮）随覆盖层退役；
          一二级导航迁入注册表 sidebar（SettingsSheetSidebar），主区只保留 正文 + 速搜 + 预览。 */}
      <div class="settings-tabs-root">
        <div class="settings-body" data-settings-domain={activeDomain()} data-settings-section={activeSection()}>
          <Show when={!activePluginPageId()}>
            <ReactIslandHost element={() => createElement(SettingsSectionHeader, {
              section: activeSection(),
              density: density(),
              onDensity: value => useSettingsChromeStore.getState().setDensity(value),
            })} />
          </Show>
          <Show when={!activePluginPageId() && (previewZone() || activeSection() === 'renderers')}>
            <div class="set-toolbar">
              <div class="set-search-wrap">
                <input class="set-search" value={searchQuery()} onInput={e => setSearchQuery(e.currentTarget.value)}
                  placeholder="搜索设置项…（如 语法、停滞、透明）" />
                <Show when={searchQuery()}>
                  <button type="button" class="set-search-clear" onClick={() => setSearchQuery('')} aria-label="清除搜索">✕</button>
                </Show>
              </div>
              <Show when={previewZone()}>
                <button type="button" class="ps-btn sm set-zone-reset"
                  onClick={() => useStore.getState().resetZone(sectionZone(activeSection()) || 'global')}
                  title="将该区全部字段恢复默认">重置本区</button>
              </Show>
            </div>
          </Show>
          <Show when={activePluginPageId()} fallback={renderSection(activeSection())}>
            <ReactIslandHost element={() => createElement(PluginSettingsPageHost, { pageId: activePluginPageId()! })} />
          </Show>
        </div>

        <ReactIslandHost element={() => createElement(SettingsQuickSearch, {
          open: quickSearchOpen(),
          items: quickSearchItems(),
          onNavigate: navigateToField,
          onOpenChange: setQuickSearchOpen,
        })} />
        <Show when={!activePluginPageId() && (previewZone() || activeSection() === 'renderers')}>
          <div class={`settings-preview-pane${previewCollapsed() ? ' collapsed' : ''}`}>
            <div class="settings-preview-pane-head">
              <Show when={!previewCollapsed()}>
                <div class="settings-preview-label">{activeSection() === 'renderers' ? 'Renderer fixture' : '实时预览'}</div>
              </Show>
              <button type="button" class="settings-preview-toggle"
                onClick={togglePreviewCollapsed}
                aria-expanded={!previewCollapsed()}
                aria-controls="settings-preview-body"
                title={previewCollapsed() ? '展开预览栏' : '折叠预览栏'}
                aria-label={previewCollapsed() ? '展开预览栏' : '折叠预览栏'}>
                {previewCollapsed() ? '‹' : '›'}
              </button>
            </div>
            <Show when={!previewCollapsed()}>
              <div id="settings-preview-body" class="settings-preview-body">
                <Show when={activeSection() === 'renderers'} fallback={<SettingsPreviewSolid zone={previewZone()!} />}>
                  <ReactIslandHost element={() => createElement(RendererSettingsPreview, {
                    entry: rendererPreviewEntry(),
                    catalog: rendererRegistrySnapshot(),
                    activeSuiteId: activeRendererSuiteId(),
                    settingsCatalog: settingsContributionCatalog(),
                  })} />
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

/** React 薄桥（Settings.tsx）的挂载工厂：Solid JSX 只允许出现在本文件。 */
export const renderSettings = createSolidMount(Settings)
