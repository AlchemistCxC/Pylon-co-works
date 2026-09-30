import { useState, useEffect } from 'react'
import { ZoneGroupFields } from './settings/themeFieldRenderer'
import { useStore } from '../domains/theme/themeStore'
import { useCustomPresetStore } from '../domains/theme/customPresetStore'
import { useShallow } from 'zustand/react/shallow'
import type { ThemeSettings } from '../domains/theme/themeStore'
import { normalizeCustomPresetId, pickCustomPresetTheme } from '../domains/theme/customPresets'
import { INTERFACE_MODE_PRESET_BUCKET } from '../domains/theme/presets/index.ts'
import type { PresetApplyResult } from '../domains/theme/presetBundle.ts'
import { applyGlobalPreset as applyGlobalPresetTransaction } from '../application/transactions/applyGlobalPreset.ts'
import HookDiagnosticsPanel from './settings/HookDiagnosticsPanel.tsx'
import { resolveZonePresetEntryTheme, type ZonePresetEntry } from '../domains/theme/zones/index.ts'
import { useWorkspaceStore } from '../domains/workspace/workspaceStore'
import { useIdentityStore } from '../domains/identity/identityStore'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import SettingsPreview from './SettingsPreview'
import TemplateLibrary from './settings/TemplateLibrary'
import WindowPanel from './settings/WindowPanel'
import ConfigBackupPanel from './settings/ConfigBackupPanel'
import HistoryRetention from './settings/HistoryRetention'
import GatewayRiskPanel from './settings/GatewayRiskPanel'
import InputPredictionSettingsPanel from './settings/InputPredictionSettingsPanel'
import PluginManager from './settings/PluginManager'
import RendererSettingsPanel from './settings/RendererSettingsPanel'
import RendererSettingsPreview from './settings/RendererSettingsPreview.tsx'
import type { RendererSettingsCatalogEntry } from './settings/rendererSettingsCatalog.ts'
import PluginSettingsPageHost from './settings/PluginSettingsPageHost'
import SettingsSectionHeader from './settings/SettingsSectionHeader.tsx'
import SettingsQuickSearch from './settings/SettingsQuickSearch.tsx'
import SidebarModulesPanel from './settings/SidebarModulesPanel.tsx'
import PresentationProfilePicker from './settings/PresentationProfilePicker'
import AgentSettingsSection from './settings/AgentSettingsSection.tsx'
import GlobalPresetSection from './settings/GlobalPresetSection.tsx'
import ZonePresetSection from './settings/ZonePresetSection.tsx'
import { Group } from './settings/settingsSectionShared.tsx'
import { useSettingsSearchNavigation } from './settings/useSettingsSearchNavigation'
import { useSettingsChromeStore } from '../domains/appearance/settingsChromeStore.ts'
// I13-W1：Settings 一级信息架构唯一真值（domain → section + 字段归属派生）
import { HOSTED_PLUGIN_MANAGER_PAGE_ID, SETTINGS_SECTION_LABELS, sectionZone, type SettingsDomainId, type SettingsSectionId } from './settings/settingsDomains'
import type { WorkspaceViewProps } from '../plugin-runtime/workspaces/workspaceTypes.ts'
import type { SettingsSheetState } from '../workspace-sheets/settingsSheetState.ts'
import { useSettingsContributionCatalog } from './settings/useSettingsContributionCatalog.ts'

/**
 * Settings — 设置 sheet 主组件（A-V3 拆分后只保留装配职责）：
 * sheet 导航状态、主题字段渲染上下文（renderCtx）、分区路由（renderSection 委托
 * 各 section 组件）、搜索框与预览栏 chrome 态。Agent 运维事务在
 * settings/AgentSettingsSection（经 settingsAgentActions hook）；全局预设事务在
 * settings/GlobalPresetSection；区域分区骨架在 settings/ZonePresetSection；
 * 速搜定位在 settings/useSettingsSearchNavigation。
 */
export default function Settings({ sheet, ctx, state }: WorkspaceViewProps<SettingsSheetState>) {
  // #154 阶段 4：设置由固定覆盖层迁入 sheet 体系。导航真值（domain/section/pluginPageId/
  // agentId）改为 sheet 状态（持久化、随 workspace 布局落盘），本组件只保留视图局部态。
  // 深链 `pylon:open-settings` 的打开/聚焦/patch 由 App 层 openOrFocusSettingsSheet 统一处理。
  const activeDomain = state.domain
  const activeSection = state.section
  const activePluginPageId = state.pluginPageId ?? null
  const navigate = (partial: {
    domain?: SettingsDomainId
    section?: SettingsSectionId
    pluginPageId?: string | null
    agentId?: string | null
    rendererCategoryId?: string | null
  }) => useWorkspaceStore.getState().patchSheetState(sheet.id, partial as Record<string, unknown>)

  // 只订阅主题字段 + ccEditMode：后台生成时的 live 状态（token/生成源）不再穿透整棵设置树。
  // pickCustomPresetTheme 白名单覆盖 Settings 全部 t.xxx 访问（已核对），ccEditMode 单独补。
  const t = useStore(useShallow(s => ({
    ...pickCustomPresetTheme(s),
    ccEditMode: s.ccEditMode,
  } as ThemeSettings & { ccEditMode: boolean })))
  const resetZone = useStore(s => s.resetZone)
  const setZoneField = useStore(s => s.setZoneField)
  const setCcEditMode = useStore(s => s.setCcEditMode)
  const applyZonePreset = useStore(s => s.applyZonePreset)
  // 刀6（#206）：区域预设池自定义条目的存入口 + Q8 落盘清理（每次打开设置过一遍，
  // 读入容错也在此收口；无变化不写状态）。
  const saveZonePresetEntry = useCustomPresetStore(s => s.saveZonePresetEntry)
  const pruneZonePresetEntries = useCustomPresetStore(s => s.pruneZonePresetEntries)
  const removeZonePresetEntry = useCustomPresetStore(s => s.removeZonePresetEntry)
  useEffect(() => { pruneZonePresetEntries() }, [pruneZonePresetEntries])
  const currentInterfaceMode = useInterfaceModeStore(s => s.interfaceMode)
  const sessions = useIdentityStore(s => s.sessions)
  // I01-W2：动态配置按 AgentContext（agentId+source）读写
  const activeSessionId = ctx.activeSession
  const activeSessionContext = (() => {
    const session = sessions.find(session => session.id === activeSessionId)
    return session ? { agentId: session.agentId, source: session.source } : undefined
  })()
  const { settingsContributionCatalog, pluginSettingsPages, rendererRegistrySnapshot, activeRendererSuiteId } = useSettingsContributionCatalog()
  const [searchQuery, setSearchQuery] = useState('')
  // #154 阶段 4：renderers 分类导航位随 sheet 状态持久化（侧栏三级项与速搜命中同源）。
  const rendererCategoryId = state.rendererCategoryId ?? 'markdown-text'
  const [rendererObjectKey, setRendererObjectKey] = useState<string | undefined>()
  const [rendererPreviewEntry, setRendererPreviewEntry] = useState<RendererSettingsCatalogEntry>()

  // K-1：密度档 chrome 态（A-V12 收敛为 settingsChromeStore 单一持久化机制）
  const density = useSettingsChromeStore(s => s.density)
  const setDensity = useSettingsChromeStore(s => s.setDensity)

  // #116 子项 8：预览栏折叠（chrome 态，持久化；折叠后正文宽度回升）
  const previewCollapsed = useSettingsChromeStore(s => s.previewCollapsed)
  const setPreviewCollapsedState = useSettingsChromeStore(s => s.setPreviewCollapsed)
  const togglePreviewCollapsed = () => {
    setPreviewCollapsedState(!previewCollapsed)
  }

  // 改单个字段 — 标记当前 section 对应的 zone 为 custom（非主题 section 回退 global）
  const onSettingChange = (partial: Partial<ThemeSettings>) => {
    const zone = sectionZone(activeSection) || 'global'
    setZoneField(zone, partial)
  }
  // 声明式字段渲染上下文（骨架 3）：纯字段组由 themeFieldRenderer 自动渲染
  const renderCtx = { t, onChange: onSettingChange, search: searchQuery }
  // 搜索时隐藏手写组（预设/布局骨架/窗口/配置备份等非主题字段），只留命中的自动字段组
  const isSearching = searchQuery.trim().length > 0

  // 局部预设（zone 级别）：出厂条目现场切来源预设、自定义条目直接用值快照。
  // 出厂条目的 id === 来源预设名 ⇒ appliedPreset[zone] 记的名字与刀5 完全一致。
  const applyLocalPreset = (zone: ZonePresetEntry['zone'], entry: ZonePresetEntry) => {
    const theme = resolveZonePresetEntryTheme(entry)
    if (!theme) return
    applyZonePreset(zone, entry.id, theme)
  }

  // 「存当前为自定义」：存 = pickZoneFields(当前主题, zone)，随后立刻应用同一条目，
  // 使新条目成为该区基准（与全局预设「保存当前」后立即应用同一交互）。
  const modeBucket = INTERFACE_MODE_PRESET_BUCKET[currentInterfaceMode]
  const saveZonePresetEntryFromSettings = (zone: ZonePresetEntry['zone'], name: string) => {
    if (!modeBucket) return
    const id = saveZonePresetEntry(modeBucket, zone, name)
    if (!id) return
    const entry = useCustomPresetStore.getState().zonePresetEntries.find(item => item.id === id)
    const theme = entry ? resolveZonePresetEntryTheme(entry) : null
    if (theme) applyZonePreset(zone, id, theme)
  }

  // 应用全局预设（templates 区与 GlobalPresetSection 各自经事务薄壳调用）
  const applyGlobalPresetByName = (name: string) => {
    applyGlobalPresetTransaction(name)
  }
  const applyCustomPresetStore = useCustomPresetStore(s => s.applyCustomPreset)
  const applyCustomPresetTransaction = (requestedId: string): Promise<PresetApplyResult> =>
    applyCustomPresetStore(normalizeCustomPresetId(requestedId))

  const previewZone = sectionZone(activeSection)

  useEffect(() => {
    if (activePluginPageId && !pluginSettingsPages.some(entry => entry.contributionId === activePluginPageId)) {
      navigate({ pluginPageId: null, section: 'pluginManager' })
    }
    // navigate 是本渲染周期的 patchSheetState 绑定（随 sheet.id 定），非数据依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePluginPageId, pluginSettingsPages])

  const { quickSearchOpen, setQuickSearchOpen, quickSearchItems, navigateToField } = useSettingsSearchNavigation({
    navigate,
    activeDomain,
    rendererRegistryRevision: rendererRegistrySnapshot.revision,
    searchItems: settingsContributionCatalog.searchItems,
    onRendererRoute: route => setRendererObjectKey(route.objectKey),
    onSearchQuery: label => setSearchQuery(label),
  })

  const zoneFields = (zone: ZonePresetEntry['zone']) => (
    <ZoneGroupFields zone={zone} ctx={renderCtx} density={density} />
  )

  // I13-W1：section → 内容（复用既有块/组件，视觉 token 与字段行为不变）
  const renderSection = (section: SettingsSectionId) => {
    switch (section) {
      case 'templates':
        return (
          <Group title="模板库">
            <TemplateLibrary onApply={applyGlobalPresetByName} onRestore={applyGlobalPresetByName} onCustomApply={applyCustomPresetTransaction} />
          </Group>
        )
      case 'window':
        return <WindowPanel />
      case 'history':
        return <HistoryRetention />
      case 'backup':
        return <ConfigBackupPanel />
      case 'global':
        return (
          <GlobalPresetSection isSearching={isSearching}>
            {zoneFields('global')}
          </GlobalPresetSection>
        )
      case 'sidebar':
        return (
          <ZonePresetSection zone="sidebar" label={SETTINGS_SECTION_LABELS.sidebar} isSearching={isSearching} interfaceMode={currentInterfaceMode}
            header={!isSearching ? <Group title="模块"><SidebarModulesPanel /></Group> : undefined}
            fields={zoneFields('sidebar')}
            onApplyZonePreset={applyLocalPreset} onSaveZonePresetEntry={saveZonePresetEntryFromSettings} onRemoveZonePresetEntry={removeZonePresetEntry} />
        )
      case 'chat':
        return (
          <ZonePresetSection zone="chat" isSearching={isSearching} interfaceMode={currentInterfaceMode}
            header={!isSearching ? <Group title="渲染风格"><PresentationProfilePicker /></Group> : undefined}
            fields={zoneFields('chat')}
            onApplyZonePreset={applyLocalPreset} onSaveZonePresetEntry={saveZonePresetEntryFromSettings} onRemoveZonePresetEntry={removeZonePresetEntry} />
        )
      case 'renderers':
        return <RendererSettingsPanel search={searchQuery} categoryId={rendererCategoryId} objectKey={rendererObjectKey} density={density} settingsCatalog={settingsContributionCatalog} onSelectionChange={setRendererPreviewEntry} />
      case 'cc':
        return (
          <ZonePresetSection zone="cc" label={SETTINGS_SECTION_LABELS.cc} isSearching={isSearching} interfaceMode={currentInterfaceMode}
            fields={zoneFields('cc')}
            footer={!isSearching && <Group title="布局编辑">
              <button type="button" className="ps-btn primary"
                onClick={() => {
                  const cur = useStore.getState().ccEditMode
                  setCcEditMode(!cur)
                  if (!cur) ctx.closeSheet(sheet.id)
                }}>
                {t.ccEditMode ? '退出布局编辑器' : '进入布局编辑器'}
              </button>
              <div className="set-hint">位置 / 大小 / 显隐 在编辑器中拖拽调整</div>
            </Group>}
            onApplyZonePreset={applyLocalPreset} onSaveZonePresetEntry={saveZonePresetEntryFromSettings} onRemoveZonePresetEntry={removeZonePresetEntry} />
        )
      case 'right':
        return (
          <ZonePresetSection zone="right" label={SETTINGS_SECTION_LABELS.right} isSearching={isSearching} interfaceMode={currentInterfaceMode}
            fields={zoneFields('right')}
            onApplyZonePreset={applyLocalPreset} onSaveZonePresetEntry={saveZonePresetEntryFromSettings} onRemoveZonePresetEntry={removeZonePresetEntry} />
        )
      case 'agent':
        return (
          <AgentSettingsSection initialAgentId={state.agentId} activeSessionContext={activeSessionContext} />
        )
      case 'session':
        return (
          <div className="settings-empty-state">
            <span className="settings-empty-kicker">当前会话</span>
            <h3>会话设置从会话入口打开</h3>
            <p>在左栏目标会话右侧点击设置按钮，可编辑工作目录与 Session Prompt。会话级 Skills / Hooks 暂未接入运行时。</p>
          </div>
        )
      case 'gateway':
        // I13-W5：Gateway 风险 consumer——真实实例/凭据状态 + 备份边界提示（不伪装备份加密）
        return <GatewayRiskPanel />
      case 'prediction':
        return <InputPredictionSettingsPanel />
      case 'pluginManager': {
        // P53：插件管理默认进入管理器插件提供的页面（贡献存在时）；
        // 包未激活/未授权时贡献不存在，回落宿主基础页（承载能力授权卡）。
        const managerPage = pluginSettingsPages.find(entry => entry.contributionId === HOSTED_PLUGIN_MANAGER_PAGE_ID)
        return managerPage ? <PluginSettingsPageHost pageId={managerPage.contributionId} /> : <PluginManager />
      }
      case 'hookDiagnostics':
        return <HookDiagnosticsPanel />
    }
  }

  return (
    <div className="settings flex flex-1 min-w-0" data-settings-domain={activeDomain} data-settings-section={activeSection}>
      {/* #154 阶段 4：对话框外壳（role=dialog/焦点陷阱/settings-header/关闭钮）随覆盖层退役；
          一二级导航迁入注册表 sidebar（SettingsSheetSidebar），主区只保留 正文 + 速搜 + 预览。 */}
      <div className="settings-tabs-root">
        <div className="settings-body" data-settings-domain={activeDomain} data-settings-section={activeSection}>
          {!activePluginPageId && (
            <SettingsSectionHeader section={activeSection} density={density} onDensity={setDensity} />
          )}
          {!activePluginPageId && (previewZone || activeSection === 'renderers') && (
            <div className="set-toolbar">
              <div className="set-search-wrap">
                <input className="set-search" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                  placeholder="搜索设置项…（如 语法、停滞、透明）" />
                {searchQuery && <button type="button" className="set-search-clear" onClick={() => setSearchQuery('')} aria-label="清除搜索">✕</button>}
              </div>
              {previewZone && <button type="button" className="ps-btn sm set-zone-reset"
                onClick={() => resetZone(sectionZone(activeSection) || 'global')}
                title="将该区全部字段恢复默认">重置本区</button>}
            </div>
          )}
          {activePluginPageId ? <PluginSettingsPageHost pageId={activePluginPageId} /> : renderSection(activeSection)}
        </div>

        <SettingsQuickSearch
          open={quickSearchOpen}
          items={quickSearchItems}
          onNavigate={navigateToField}
          onOpenChange={setQuickSearchOpen}
        />
        {!activePluginPageId && (previewZone || activeSection === 'renderers') && (
          <div className={`settings-preview-pane${previewCollapsed ? ' collapsed' : ''}`}>
            <div className="settings-preview-pane-head">
              {!previewCollapsed && (
                <div className="settings-preview-label">{activeSection === 'renderers' ? 'Renderer fixture' : '实时预览'}</div>
              )}
              <button type="button" className="settings-preview-toggle"
                onClick={togglePreviewCollapsed}
                aria-expanded={!previewCollapsed}
                aria-controls="settings-preview-body"
                title={previewCollapsed ? '展开预览栏' : '折叠预览栏'}
                aria-label={previewCollapsed ? '展开预览栏' : '折叠预览栏'}>
                {previewCollapsed ? '‹' : '›'}
              </button>
            </div>
            {!previewCollapsed && (
              <div id="settings-preview-body" className="settings-preview-body">
                {activeSection === 'renderers'
                  ? <RendererSettingsPreview entry={rendererPreviewEntry} catalog={rendererRegistrySnapshot} settingsCatalog={settingsContributionCatalog} activeSuiteId={activeRendererSuiteId} />
                  : <SettingsPreview zone={previewZone!} />}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
