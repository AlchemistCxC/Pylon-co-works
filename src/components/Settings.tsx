import { useMemo, useState, useEffect, useSyncExternalStore, useId, useLayoutEffect, useRef } from 'react'
import { IS_TAURI } from '../infrastructure/tauri/env'
import { invoke } from '@tauri-apps/api/core'
import { createAgentClient } from '../infrastructure/acp/agentClient'
import { GROUP_ORDER } from '../themeFieldDefs'
import { ZoneGroupFields } from '../themeFieldRenderer'
import { useStore } from '../store'
import { useIdentityStore } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { applyToolDictionaryThroughPort } from '../app/ports/productContributionPorts.ts'
import { useShallow } from 'zustand/react/shallow'
import type { ThemeSettings } from '../store'
import { GLOBAL_PRESETS, pickZoneFields } from '../presets'
import { useWorkspaceStore } from '../workspaceStore'
import { pickCustomPresetTheme } from '../customPresets'
import { deriveGlobalStatus, deriveZoneStatus } from '../domains/theme/presetReducer'
import SettingsPreview from './SettingsPreview'
import { reportRuntimeError } from '../runtimeError'
import { switchAgentTransaction } from '../application/transactions/switchAgentTransaction'
import { applyGlobalPreset as applyGlobalPresetTransaction } from '../application/transactions/applyGlobalPreset.ts'
import { normalizeAgentStatus, selectAgentStatus, statusLabel } from './settings/agentTypes'
import { runReconnectCommand } from './settings/reconnectCommand'
import AgentRuntimePanel from './settings/AgentRuntimePanel'
import AgentConfigEditor from './settings/AgentConfigEditor'
import ConfigOptionsPanel from './settings/ConfigOptionsPanel'
import TemplateLibrary from './settings/TemplateLibrary'
import WindowPanel from './settings/WindowPanel'
import ConfigBackupPanel from './settings/ConfigBackupPanel'
import HistoryRetention from './settings/HistoryRetention'
import GatewayRiskPanel from './settings/GatewayRiskPanel'
import InputPredictionSettingsPanel from './settings/InputPredictionSettingsPanel'
import PluginManager from './settings/PluginManager'
import PresentationProfilePicker from './settings/PresentationProfilePicker'
import RendererSettingsPanel from './settings/RendererSettingsPanel'
import { projectRendererSettingsCatalog } from './settings/rendererSettingsCatalog.ts'
import RendererSettingsPreview from './settings/RendererSettingsPreview.tsx'
import type { RendererSettingsCatalogEntry } from './settings/rendererSettingsCatalog.ts'
import PluginSettingsPageHost from './settings/PluginSettingsPageHost'
import InterfaceModePicker from './settings/InterfaceModePicker.tsx'
import SettingsSectionHeader from './settings/SettingsSectionHeader.tsx'
import SettingsQuickSearch from './settings/SettingsQuickSearch.tsx'
import { buildSettingsSearchIndex } from '../settingsDomains'
import { readDensity, writeDensity, readPinned, writePinned, PINNED_LIMIT, safeStorage, type SettingsDensity } from './settings/settingsChromeState.ts'
import { getContextPanelRegistry, getPluginServiceRegistry, getPluginSettingsPageRegistry, getRendererRegistry } from '../plugin-runtime/runtimeServices.ts'
// I13-W1：Settings 一级信息架构唯一真值（domain → section + 字段归属派生）
import { SETTINGS_DOMAIN_BY_ID, SETTINGS_DOMAINS, SETTINGS_DOMAIN_MENU_META, SETTINGS_SECTION_LABELS, sectionZone, normalizeSettingsIntent, type SettingsDomainId, type SettingsSectionId } from '../settingsDomains'
import { resetThemeForActiveInterfaceMode } from '../application/transactions/activateInterfaceMode.ts'
import { useInterfaceModeStore } from '../domains/interface/interfaceModeStore.ts'
import { usePresentationPreferenceStore } from '../domains/presentation/presentationPreferenceStore.ts'
import { BUILTIN_INTERFACE_MODES } from '../plugins/core/interfaceMode/builtinInterfaceModes.ts'
import { getInterfaceModeRegistry } from '../plugin-runtime/runtimeServices.ts'
import { resolveInterfaceModeSuite } from '../application/transactions/activateInterfaceMode.ts'

// FE-AUD-008：typed client 收口 agent 域 command literal
const agentClient = createAgentClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })

const SETTINGS_FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function settingsFocusable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE_SELECTOR)]
    .filter(element => element.getAttribute('aria-hidden') !== 'true' && !element.hidden)
}

// ── helpers ──

function Group({ title, children, defaultOpen }: { title:string; children:React.ReactNode; defaultOpen?:boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? true)
  return (
    <div className="set-group">
      <button type="button" className="set-group-title" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="set-group-arrow">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && children}
    </div>
  )
}

function ZonePresetRow({ zone, activeName, isDirty, onApply }: {
  zone: string; activeName: string; isDirty: boolean; onApply: (zone: string, name: string) => void
}) {
  return (
    <Group title="局部预设">
      <div className="set-preset-row">
        {GLOBAL_PRESETS.map(p => (
          <button type="button" key={p.name} className={`set-preset-chip ${activeName === p.name && !isDirty ? 'active' : ''}`}
            onClick={() => onApply(zone, p.name)}>{p.label}</button>
        ))}
        {isDirty && <span className="set-preset-chip active">自定义</span>}
      </div>
    </Group>
  )
}

// ── main ──

export default function Settings({ onClose, activeSessionId, initialDomain, initialSection, initialAgentId }: {
  onClose?: () => void
  activeSessionId?: string | null
  initialDomain?: string
  initialSection?: string
  initialAgentId?: string
}) {
  const initialIntent = normalizeSettingsIntent({ domain: initialDomain, section: initialSection, agentId: initialAgentId })
  const settingsRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const restoreFocusRef = useRef<HTMLElement | null>(null)
  if (restoreFocusRef.current === null && typeof document !== 'undefined') {
    const active = document.activeElement
    restoreFocusRef.current = active instanceof HTMLElement ? active : null
  }

  useLayoutEffect(() => {
    const root = settingsRef.current
    if (!root) return
    const focusables = settingsFocusable(root)
    focusables[0]?.focus()
    return () => {
      const previous = restoreFocusRef.current
      if (previous && previous.isConnected && !root.contains(previous)) previous.focus()
    }
  }, [])

  const handleDialogKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const root = settingsRef.current
    if (!root) return
    const focusables = settingsFocusable(root)
    if (focusables.length === 0) {
      event.preventDefault()
      root.focus()
      return
    }
    const currentIndex = focusables.indexOf(document.activeElement as HTMLElement)
    const nextIndex = event.shiftKey
      ? (currentIndex <= 0 ? focusables.length - 1 : currentIndex - 1)
      : (currentIndex < 0 || currentIndex >= focusables.length - 1 ? 0 : currentIndex + 1)
    if (currentIndex < 0 || (event.shiftKey && currentIndex === 0) || (!event.shiftKey && currentIndex === focusables.length - 1)) {
      event.preventDefault()
      focusables[nextIndex]?.focus()
    }
  }

  // 只订阅主题字段 + ccEditMode：后台生成时的 live 状态（token/生成源）不再穿透整棵设置树。
  // pickCustomPresetTheme 白名单覆盖 Settings 全部 t.xxx 访问（已核对），ccEditMode 单独补。
  const t = useStore(useShallow(s => ({
    ...pickCustomPresetTheme(s),
    ccEditMode: s.ccEditMode,
  } as ThemeSettings & { ccEditMode: boolean })))
  const reset = () => { resetThemeForActiveInterfaceMode() }
  const resetZone = useStore(s => s.resetZone)
  const setZoneField = useStore(s => s.setZoneField)
  const setCcEditMode = useStore(s => s.setCcEditMode)
  const applyZonePreset = useStore(s => s.applyZonePreset)
  const appliedPreset = useStore(s => s.appliedPreset)
  const custom = useStore(s => s.custom)
  // A2：全局预设状态派生（任一 zone 触碰/基准不一致 → custom），原 appliedPreset.global 直读退役
  const globalStatus = useStore(s => deriveGlobalStatus(s))
  const agents = useIdentityStore(s => s.agents)
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const agentStatuses = useRuntimeStore(s => s.agentStatuses)
  const setAgentStatus = useRuntimeStore(s => s.setAgentStatus)
  const setActiveAgent = useIdentityStore(s => s.setActiveAgent)
  const customPresets = useStore(s => s.customPresets)
  const sessions = useIdentityStore(s => s.sessions)
  // I01-W2：动态配置按 AgentContext（agentId+source）读写
  const activeSessionContext = (() => {
    const session = sessions.find(session => session.id === activeSessionId)
    return session ? { agentId: session.agentId, source: session.source } : undefined
  })()
  const saveCustomPreset = useStore(s => s.saveCustomPreset)
  const applyCustomPreset = useStore(s => s.applyCustomPreset)
  const removeCustomPreset = useStore(s => s.removeCustomPreset)
  // I13-W1：导航状态收敛为 activeDomain/activeSection（settingsDomains 驱动）
  const [activeDomain, setActiveDomain] = useState<SettingsDomainId>(
    initialIntent.domain,
  )
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    initialIntent.section,
  )
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
  const rendererRegistry = getRendererRegistry()
  const rendererRegistrySnapshot = useSyncExternalStore(
    listener => rendererRegistry.subscribe(listener),
    () => rendererRegistry.snapshot(),
    () => rendererRegistry.snapshot(),
  )
  const [activePluginPageId, setActivePluginPageId] = useState<string | null>(
    initialIntent.pluginPageId ?? null,
  )
  const showPet = useWorkspaceStore(s => s.showPet)
  const setShowPet = useWorkspaceStore(s => s.setShowPet)
  const [searchQuery, setSearchQuery] = useState('')
  const [rendererCategoryId, setRendererCategoryId] = useState('markdown-text')
  const [rendererObjectKey, setRendererObjectKey] = useState<string | undefined>()
  const [rendererPreviewEntry, setRendererPreviewEntry] = useState<RendererSettingsCatalogEntry>()
  const [customPresetName, setCustomPresetName] = useState('')
  const [customPresetFeedback, setCustomPresetFeedback] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const [switchingAgentId, setSwitchingAgentId] = useState<string | null>(null)
  const [reconnectPending, setReconnectPending] = useState(false)
  const [reconnectCommandError, setReconnectCommandError] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const [dictFeedback, setDictFeedback] = useState<string | null>(null)
  const currentStatus = selectAgentStatus(activeAgent, activeAgent, agentStatuses)

  // 施工文档 §5.3：Settings 宿主消费 open-settings 事件（ErrorCenter/Overview 恢复入口）。
  useEffect(() => {
    const onOpenSettings = (event: Event) => {
      const detail = (event as CustomEvent<{ domain?: string; section?: string; agentId?: string }>).detail
      if (!detail) return
      const intent = normalizeSettingsIntent(detail)
      setActiveDomain(intent.domain)
      setActiveSection(intent.section)
      setActivePluginPageId(intent.pluginPageId ?? null)
    }
    window.addEventListener('pylon:open-settings', onOpenSettings)
    return () => window.removeEventListener('pylon:open-settings', onOpenSettings)
  }, [])
  // 应用全局预设
  const applyGlobalPreset = (name: string) => {
    applyGlobalPresetTransaction(name)
  }

  // 改单个字段 — 标记当前 section 对应的 zone 为 custom（非主题 section 回退 global）
  const onSettingChange = (partial: Partial<ThemeSettings>) => {
    const zone = sectionZone(activeSection) || 'global'
    setZoneField(zone, partial)
  }
  // 助手头像：Tauri 文件选择 → 存路径到 assistantDotImage（zone=chat）
  const pickAssistantAvatar = async () => {
    if (!IS_TAURI) return
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({ multiple: false, filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] })
    if (selected) setZoneField('chat', { assistantDotImage: selected as string })
  }
  // 声明式字段渲染上下文（骨架 3）：纯字段组由 themeFieldRenderer 自动渲染
  const renderCtx = { t, onChange: onSettingChange, search: searchQuery }
  // 搜索时隐藏手写组（预设/布局骨架/窗口/配置备份等非主题字段），只留命中的自动字段组
  const isSearching = searchQuery.trim().length > 0

  // 局部预设（zone 级别）
  const applyLocalPreset = (zone: string, presetName: string) => {
    const preset = GLOBAL_PRESETS.find(p => p.name === presetName)
    if (!preset) return
    const sub = pickZoneFields(preset.theme, zone)
    applyZonePreset(zone, presetName, sub)
  }

  /**
   * Custom preset persistence is a user action, so failures must stay visible
   * in this dialog. Previously an exception from provider capture (or a stale
   * overwrite id) escaped the click handler and looked like a dead button.
   */
  const saveCustomPresetFromSettings = (name: string, id?: string): string | undefined => {
    const isOverwrite = Boolean(id)
    try {
      const savedId = saveCustomPreset(name, id)
      setCustomPresetFeedback({
        kind: 'success',
        message: isOverwrite ? '自定义预设已覆盖' : '自定义预设已保存',
      })
      return savedId
    } catch (error) {
      const action = isOverwrite ? '覆盖自定义预设' : '保存自定义预设'
      const detail = reportRuntimeError(action, error)
      setCustomPresetFeedback({ kind: 'error', message: `${action}失败：${detail.message}` })
      return undefined
    }
  }

  const previewZone = sectionZone(activeSection)

  useEffect(() => {
    if (activePluginPageId && !pluginSettingsPages.some(entry => entry.contributionId === activePluginPageId)) {
      setActivePluginPageId(null)
      setActiveSection('pluginManager')
    }
  }, [activePluginPageId, pluginSettingsPages])

  const switchAgent = async (agentId: string) => {
    if (switchingAgentId || agentId === activeAgent) return
    setSwitchingAgentId(agentId)
    await switchAgentTransaction(agentId, agentId, {
      switchAgent: () => agentClient.switchAgent(agentId),
      resetRuntime: () => useRuntimeStore.getState().resetAll(),
      setActiveAgent: id => setActiveAgent(id),
      fetchAgentStatus: () => agentClient.agentStatus(),
      applyAgentStatus: (id, status) => useRuntimeStore.getState().setAgentStatus(id, status),
      reportError: (action, error) => reportRuntimeError(action, error),
      dispatchSwitched: () => window.dispatchEvent(new CustomEvent('pylon:agent-switched')),
    })
    setSwitchingAgentId(null)
  }

  const reconnectAgent = async () => {
    if (reconnectPending) return
    const targetAgent = activeAgent
    setReconnectPending(true)
    setReconnectCommandError(null)
    const result = await runReconnectCommand({
      reconnect: () => agentClient.reconnectAgent(),
      readSnapshot: async () => normalizeAgentStatus(await agentClient.agentStatus(), targetAgent),
      applySnapshot: snapshot => setAgentStatus(targetAgent, snapshot),
    })
    if (result.commandError !== undefined) {
      const detail = reportRuntimeError('重连 Agent', result.commandError)
      setReconnectCommandError(detail.message)
    }
    if (result.reconciliationError !== undefined) {
      reportRuntimeError('对账 Agent 状态', result.reconciliationError)
    }
    setReconnectPending(false)
  }

  const reloadAgents = async () => {
    if (reloading) return
    setReloading(true)
    try {
      await agentClient.reloadAgents()
      const list = await agentClient.listAgents()
      useIdentityStore.getState().setAgents(list)
      const dictionary = await agentClient.listToolDictionary()
      applyToolDictionaryThroughPort(getPluginServiceRegistry(), dictionary)
      const providerCount = Object.keys(dictionary as Record<string, unknown> ?? {}).length
      setDictFeedback(providerCount > 0 ? `工具归一化字典已加载（${providerCount} 个 provider）` : '工具归一化字典为空，已使用内置 fallback')
    } catch (error) {
      setDictFeedback('工具归一化字典加载失败')
      reportRuntimeError('重载 Agent 配置', error)
    } finally { setReloading(false) }
  }

  // F2：禁储环境安全存储（内存兜底，会话内可用）
  const storage = safeStorage()
  const activeDomainConfig = SETTINGS_DOMAIN_BY_ID[activeDomain]

  // K-1：密度档 chrome 态（localStorage 持久化；拍板 D3-A 全局一档）
  const [density, setDensity] = useState<SettingsDensity>(() =>
    readDensity((k) => storage.get(k)))
  const changeDensity = (d: SettingsDensity) => {
    setDensity(d)
    writeDensity(d, (key, v) => storage.set(key, v))
  }

  // K-2：左栏二级折叠导航展开态（session 内 UI 态；打开设置默认收起）
  const [navExpanded, setNavExpanded] = useState<ReadonlySet<string>>(new Set())
  const toggleNavSection = (section: string) => {
    setNavExpanded(prev => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }
  // K-4：收藏置顶（拍板 D4-A hover 星标；上限 PINNED_LIMIT=3）
  const [pinned, setPinned] = useState<readonly string[]>(() =>
    readPinned((k) => storage.get(k)))
  const togglePinned = (section: string) => {
    const next = pinned.includes(section)
      ? pinned.filter(id => id !== section)
      : [...pinned, section].slice(-PINNED_LIMIT)
    setPinned(next)
    writePinned(next, (key, v) => storage.set(key, v))
  }
  // section → 二级项（组标题）。链A 从 GROUP_ORDER[zone] 派生；无 zone 或 <2 组返回空（不显示箭头）
  const navGroupsFor = (section: SettingsSectionId): readonly { readonly id: string; readonly label: string }[] => {
    // Renderer 的三级项由 owner placement 投影成稳定语义类别；完整 object graph 留在高级目录。
    if (section === 'renderers') {
      const mode = getInterfaceModeRegistry().resolve(useInterfaceModeStore.getState().interfaceMode)?.value
        ?? BUILTIN_INTERFACE_MODES.find(item => item.id === useInterfaceModeStore.getState().interfaceMode)
      const activeSuiteId = mode?.workbench.renderKind === 'renderer-suite'
        ? resolveInterfaceModeSuite(mode, usePresentationPreferenceStore.getState().rendererSuiteIdByMode[mode.id], rendererRegistrySnapshot.rendererSuites.map(item => item.value.id)).activeSuiteId
        : undefined
      const projection = projectRendererSettingsCatalog(rendererRegistrySnapshot, activeSuiteId)
      return projection.categories.map(category => ({ id: category.id, label: category.label }))
    }
    const zone = sectionZone(section)
    if (!zone) return []
    const groups = (GROUP_ORDER[zone] ?? []).flatMap(block => [...block.groups.map(g => g.title)])
    return groups.length >= 2 ? groups.map(title => ({ id: title, label: title })) : []
  }

  // O-3：速搜定位态
  const [quickSearchOpen, setQuickSearchOpen] = useState(false)
  // B2 边界修复：面板打开或 Renderer catalog 热更新时重建索引。
  // 不能只依赖 quickSearchOpen，否则插件热装卸后的字段要重新打开命令面板才可搜。
  const quickSearchItems = useMemo(() => {
    // 显式引用依赖项：它们是缓存失效信号（B2），非数据来源——抑制 exhaustive-deps
    void quickSearchOpen
    void rendererRegistrySnapshot.revision
    try {
      const snapshot = getRendererRegistry().snapshot()
      return [...buildSettingsSearchIndex(undefined, pluginSettingsPages, contextPanelEntries), ...projectRendererSettingsCatalog(snapshot).searchItems]
    } catch { return buildSettingsSearchIndex(undefined, pluginSettingsPages, contextPanelEntries) }
  }, [quickSearchOpen, rendererRegistrySnapshot.revision, pluginSettingsPages, contextPanelEntries])
  const navigateToField = (item: import('../settingsDomains').SettingsSearchItem) => {
    if (item.contextPanelId) {
      setActiveDomain('appearance')
      setActiveSection('right')
      setActivePluginPageId(null)
      return
    }
    if (item.pluginPageId) {
      setActiveDomain('plugins')
      setActiveSection('pluginManager')
      setActivePluginPageId(item.pluginPageId)
      return
    }
    if (item.rendererRoute) {
      setRendererCategoryId(item.rendererRoute.categoryId)
      setRendererObjectKey(item.rendererRoute.objectKey)
      setSearchQuery(item.label)
    }
    jumpToSection(item.section)
    if (density !== 'all') changeDensity('all')  // D2-A：advanced 命中自动切全部档
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
      if (group instanceof HTMLElement) {
        group.classList.add('settings-anchor-pulse')
        setTimeout(() => group.classList.remove('settings-anchor-pulse'), 1200)
      }
    })
  }
  // F1 边界修复：section → 所属 domain 反查（SETTINGS_DOMAINS 单一真值派生）
  const domainOfSection = (section: string): SettingsDomainId | undefined =>
    SETTINGS_DOMAINS.find(d => (d.sections as readonly string[]).includes(section))?.id
  const jumpToSection = (section: SettingsSectionId) => {
    setActivePluginPageId(null)
    const domain = domainOfSection(section)
    if (domain && domain !== activeDomain) {
      // 跨域跳转：先设 section 再切 domain——switchDomain 会重置 section，故直接组合设置
      setActiveDomain(domain)
      setNavExpanded(new Set())
    }
    setActiveSection(section)
  }

  // I13-W1：section → 内容（复用既有块/组件，视觉 token 与字段行为不变）
  const renderSection = (section: SettingsSectionId) => {
    switch (section) {
      case 'templates':
        return (
          <Group title="模板库">
            <TemplateLibrary onApply={applyGlobalPreset} onRestore={applyGlobalPreset} />
          </Group>
        )
      case 'pet':
        return (
          <Group title="宠物">
            <div className="set-preset-row">
              <button type="button" className="set-preset-chip" onClick={() => setShowPet(!showPet)}>
                {showPet ? '宠物显示中 — 点击隐藏' : '宠物已隐藏 — 点击显示'}
              </button>
            </div>
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
          <>
            {!isSearching && <Group title="界面模式"><InterfaceModePicker /></Group>}
            {!isSearching && <Group title="全局预设">
              <div className="set-preset-row">
                {GLOBAL_PRESETS.map(p => (
                  <button type="button" key={p.name} className={`set-preset-chip ${globalStatus === p.name ? 'active' : ''}`}
                    onClick={() => applyGlobalPreset(p.name)}>{p.label}</button>
                ))}
                {globalStatus && !GLOBAL_PRESETS.some(p => p.name === globalStatus) && (
                  <button type="button" className="set-preset-chip active">{globalStatus}</button>
                )}
              </div>
              <div className="set-hint">
                {globalStatus === 'custom'
                  ? '当前为自定义 — 可保存为新预设或覆盖已有预设'
                  : '选择预设后修改任意外观参数，自动切换为自定义'}
              </div>
              <div className="set-custom-preset-save">
                <input className="set-input" value={customPresetName} onChange={event => setCustomPresetName(event.target.value)} placeholder="自定义预设名称" />
                {/* A3：保存必须命名——空名禁用按钮（数据层 saveCustomPresetReducer 抛错兜底），不再静默 return */}
                <button type="button" className="ps-btn sm" disabled={!customPresetName.trim()} title={customPresetName.trim() ? undefined : '保存必须命名'}
                  onClick={() => {
                    const id = saveCustomPresetFromSettings(customPresetName)
                    if (id) {
                      applyCustomPreset(id)
                      setCustomPresetName('')
                    }
                  }}>保存当前</button>
              </div>
              {customPresetFeedback && (
                <div className={`set-hint custom-preset-feedback ${customPresetFeedback.kind === 'error' ? 'is-error' : 'is-success'}`}
                  role={customPresetFeedback.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
                  {customPresetFeedback.message}
                </div>
              )}
              {customPresets.length > 0 && <div className="set-custom-presets">
                {customPresets.map(preset => <div className="set-custom-preset" key={preset.id}>
                  <button type="button" className={`set-preset-chip ${globalStatus === preset.id ? 'active' : ''}`} onClick={() => applyCustomPreset(preset.id)}>{preset.name}</button>
                  <button type="button" className="ps-btn sm" onClick={() => { void saveCustomPresetFromSettings(preset.name, preset.id) }}>覆盖</button>
                  <button type="button" className="ps-btn sm danger" onClick={() => removeCustomPreset(preset.id)}>删除</button>
                </div>)}
              </div>}
            </Group>}
            {/* 个人信息/强调色/布局骨架/玻璃效果/字体 已声明式化（defs 组），自动获得搜索/custom/恢复默认 */}
            <ZoneGroupFields zone="global" ctx={renderCtx} density={density} />
          </>
        )
      case 'sidebar':
        return (
          <>
            {!isSearching && <h3>左侧栏</h3>}
            {!isSearching && <ZonePresetRow zone="sidebar" activeName={deriveZoneStatus({ appliedPreset, custom }, 'sidebar').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'sidebar').isCustom} onApply={applyLocalPreset}/>}
            <ZoneGroupFields zone="sidebar" ctx={renderCtx} density={density} />
          </>
        )
      case 'chat':
        return (
          <>
            {!isSearching && <Group title="渲染风格"><PresentationProfilePicker /></Group>}
            {!isSearching && <ZonePresetRow zone="chat" activeName={deriveZoneStatus({ appliedPreset, custom }, 'chat').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'chat').isCustom} onApply={applyLocalPreset}/>}
            <ZoneGroupFields zone="chat" ctx={renderCtx} density={density} />
          </>
        )
      case 'renderers':
        return <RendererSettingsPanel search={searchQuery} categoryId={rendererCategoryId} objectKey={rendererObjectKey} density={density} onSelectionChange={setRendererPreviewEntry} />
      case 'cc':
        return (
          <>
            {!isSearching && <h3>中控区</h3>}
            {!isSearching && <ZonePresetRow zone="cc" activeName={deriveZoneStatus({ appliedPreset, custom }, 'cc').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'cc').isCustom} onApply={applyLocalPreset}/>}
            <ZoneGroupFields zone="cc" ctx={renderCtx} density={density} />
            {!isSearching && (
              <Group title="助手头像">
                <div className="set-preset-row">
                  <button type="button" className="ps-btn sm" onClick={() => void pickAssistantAvatar()}>选择图片文件…</button>
                  {useStore.getState().assistantDotImage && (
                    <button type="button" className="ps-btn sm" onClick={() => useStore.getState().setZoneField('chat', { assistantDotImage: '' })}>清除</button>
                  )}
                </div>
              </Group>
            )}
            {!isSearching && <Group title="布局编辑">
              <button type="button" className="ps-btn primary"
                onClick={() => {
                  const cur = useStore.getState().ccEditMode
                  setCcEditMode(!cur)
                  if (typeof onClose === 'function') onClose?.()
                }}>
                {t.ccEditMode ? '退出布局编辑器' : '进入布局编辑器'}
              </button>
              <div className="set-hint">位置 / 大小 / 显隐 在编辑器中拖拽调整</div>
            </Group>}
          </>
        )
      case 'right':
        return (
          <>
            {!isSearching && <h3>右侧栏</h3>}
            {!isSearching && <ZonePresetRow zone="right" activeName={deriveZoneStatus({ appliedPreset, custom }, 'right').appliedName} isDirty={deriveZoneStatus({ appliedPreset, custom }, 'right').isCustom} onApply={applyLocalPreset}/>}
            <ZoneGroupFields zone="right" ctx={renderCtx} density={density} />
          </>
        )
      case 'agent':
        return (
          <>
            <div className="agent-settings-heading">
              <div><h3>Agent</h3><p>连接、发现与导入集中在这里；YAML 和动态配置保留在高级区域。</p></div>
            </div>
            <section className="agent-settings-overview" aria-label="当前 Agent 概况">
              <div className="agent-settings-overview-main">
                <span className={`agent-status-indicator is-${currentStatus.status}`} aria-hidden="true" />
                <div>
                  <span className="agent-settings-kicker">当前 Agent</span>
                  <strong>{agents.find(agent => agent.id === activeAgent)?.name || activeAgent || 'peri'}</strong>
                  <span>{activeAgent || 'peri'}</span>
                  <span className="agent-settings-status-copy">状态：{statusLabel(currentStatus.status)}</span>
                </div>
              </div>
              <div className="agent-settings-actions">
                <button type="button" className="ps-btn sm primary" disabled={reconnectPending} onClick={reconnectAgent}>{reconnectPending ? '重连中…' : '重新连接'}</button>
                <button type="button" className="ps-btn sm" disabled={reloading} onClick={reloadAgents}>{reloading ? '重载中…' : '重载配置'}</button>
              </div>
              <dl className="agent-settings-facts">
                <div><dt>传输方式</dt><dd>{currentStatus.transport || '未报告'}</dd></div>
                <div><dt>工作目录</dt><dd title={currentStatus.cwd}>{currentStatus.cwd || '跟随会话'}</dd></div>
              </dl>
              {currentStatus.recentError && <div className="agent-settings-notice error" role="alert">最近错误：{currentStatus.recentError}</div>}
              {reconnectCommandError && <div className="agent-settings-notice error" role="alert">重连失败：{reconnectCommandError}</div>}
              {dictFeedback && <div className="agent-settings-notice" role="status">{dictFeedback}</div>}
            </section>
            <Group title="切换 Agent">
              <div className="agent-switch-list">
                {agents.map((agent) => (
                  <button key={agent.id} type="button" className={`agent-switch-card ${agent.id === activeAgent ? 'active' : ''}`}
                    disabled={switchingAgentId !== null || agent.id === activeAgent}
                    aria-busy={switchingAgentId === agent.id}
                    onClick={() => switchAgent(agent.id)}>
                    <span className="agent-switch-copy"><strong>{agent.name}</strong><small>{agent.provider || agent.id}</small></span>
                    <span className="agent-switch-state">{switchingAgentId === agent.id ? '连接中…' : agent.id === activeAgent ? '当前' : '切换'}</span>
                  </button>
                ))}
              </div>
              <div className="set-hint">切换会立即重置当前会话的运行时状态。</div>
            </Group>
            <Group title="发现与管理 Agent">
              <AgentRuntimePanel initialAgentId={initialAgentId} />
            </Group>
            <Group title="高级：YAML 配置" defaultOpen={false}>
              <AgentConfigEditor agentId={activeAgent} />
              <div className="set-hint">保存会原子写回生效配置并刷新 Agent 列表；当前 active agent 不可被删除。</div>
            </Group>
            <Group title="高级：会话动态配置" defaultOpen={false}>
              <ConfigOptionsPanel context={activeSessionContext} />
            </Group>
          </>
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
      case 'pluginManager':
        // M12：插件管理页（列表只读 core；signed/dev 停用；本地包安装；日志）
        return <PluginManager />
    }
  }

  return (
    <div ref={settingsRef} className="settings" role="dialog" aria-modal="true" aria-labelledby={titleId} data-settings-domain={activeDomain} data-settings-section={activeSection} onKeyDown={handleDialogKeyDown}>
      <header className="settings-header">
        <div>
          <h2 id={titleId}>设置</h2>
          <p>调整 Pylon 的外观、工作区和 Agent 运行方式。</p>
          <span className="settings-header-route" aria-live="polite">当前域 / {activeDomainConfig.label} · 使用标题栏“设置”菜单切换</span>
        </div>
        <button type="button" className="settings-close" onClick={onClose} aria-label="关闭设置">✕</button>
      </header>
      <div className="settings-tabs-root">
        <div className="settings-nav">
          <div className="settings-nav-context" data-settings-domain={activeDomain}>
            <span>DOMAIN / {activeDomain}</span>
            <div className="settings-nav-context-title">
              <span className="settings-nav-context-glyph" aria-hidden="true">{SETTINGS_DOMAIN_MENU_META[activeDomain].glyph}</span>
              <strong>{activeDomainConfig.label}</strong>
            </div>
            <small>{SETTINGS_DOMAIN_MENU_META[activeDomain].description}</small>
          </div>
          <div className="settings-nav-group settings-nav-sections">
            {pinned.length > 0 && (
              <>
                <div className="settings-nav-label">常用</div>
                {pinned.map(section => (
                  <button type="button" key={`pin-${section}`} className="set-nav-btn pinned"
                    onClick={() => jumpToSection(section as SettingsSectionId)}>
                    <span className="settings-nav-pin-star" aria-hidden="true">★</span>
                    {SETTINGS_SECTION_LABELS[section as SettingsSectionId]}
                  </button>
                ))}
              </>
            )}
            <div className="settings-nav-label">{activeDomainConfig.label} 分区</div>
            {activeDomainConfig.sections.map(section => {
              const zone = sectionZone(section)
              const subGroups = navGroupsFor(section)
              const expanded = navExpanded.has(section)
              const label = SETTINGS_SECTION_LABELS[section]
              const hasSub = subGroups.length > 0
              return (
                <div key={section} className="settings-nav-section-block">
                  <div className="settings-nav-section-row">
                    <button type="button"
                      className={`set-nav-btn ${!activePluginPageId && activeSection === section ? 'active' : ''}${zone && custom[zone] ? ' custom' : ''}`}
                      aria-expanded={hasSub ? expanded : undefined}
                      onClick={() => {
                        setActivePluginPageId(null)
                        setActiveSection(section)
                        if (hasSub) toggleNavSection(section)
                      }}
                      title={zone && custom[zone] ? '该区有未保存的自定义改动' : undefined}>
                      {hasSub && <span className="settings-nav-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>}
                      {label}
                    </button>
                    <button type="button" className={`settings-nav-pin${pinned.includes(section) ? ' pinned' : ''}`}
                      aria-label={pinned.includes(section) ? `取消置顶 ${label}` : `置顶 ${label}`}
                      aria-pressed={pinned.includes(section)}
                      onClick={e => { e.stopPropagation(); togglePinned(section) }}>★</button>
                  </div>
                  {hasSub && expanded && (
                    <div className="settings-nav-subgroups">
                      {subGroups.map(group => (
                        <button type="button" key={group.id}
                          className={`set-nav-btn subgroup${section === 'renderers' && rendererCategoryId === group.id ? ' active' : ''}`}
                          onClick={e => {
                            e.stopPropagation()
                            setActivePluginPageId(null)
                            setActiveSection(section)
                            if (section === 'renderers') {
                              setRendererCategoryId(group.id)
                              return
                            }
                            // 锚点滚动：等 section 渲染后按组标题定位（下一帧）
                            requestAnimationFrame(() => {
                              const target = document.querySelector(`[data-group-anchor="${CSS.escape(group.label)}"]`)
                              target?.scrollIntoView({ block: 'start', behavior: 'smooth' })
                              // O-2：高亮脉冲 1.2s（prefers-reduced-motion 时 CSS 端自动禁用动画）
                              target?.classList.add('settings-anchor-pulse')
                              setTimeout(() => target?.classList.remove('settings-anchor-pulse'), 1200)
                            })
                          }}>
                          {group.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            {activeDomain === 'plugins' && pluginSettingsPages.map(entry => (
              <button type="button" key={entry.contributionId}
                className={`set-nav-btn plugin-page ${activePluginPageId === entry.contributionId ? 'active' : ''}`}
                onClick={() => setActivePluginPageId(entry.contributionId)}
                title={entry.value.description}>
                <span>{entry.value.label}</span>
                <small>{entry.ownerPluginId}</small>
              </button>
            ))}
          </div>
          <div className="settings-nav-footer">
            <button type="button" className="set-nav-btn reset" onClick={reset}>重置主题</button>
          </div>
        </div>

        <div className="settings-body" data-settings-domain={activeDomain} data-settings-section={activeSection}>
          {!activePluginPageId && (
            <SettingsSectionHeader section={activeSection} density={density} onDensity={changeDensity} />
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
          <div className="settings-preview-pane">
            <div className="settings-preview-label">{activeSection === 'renderers' ? 'Renderer fixture' : '实时预览'}</div>
            {activeSection === 'renderers'
              ? <RendererSettingsPreview entry={rendererPreviewEntry} catalog={rendererRegistrySnapshot} activeSuiteId={(() => {
                const mode = getInterfaceModeRegistry().resolve(useInterfaceModeStore.getState().interfaceMode)?.value ?? BUILTIN_INTERFACE_MODES.find(item => item.id === useInterfaceModeStore.getState().interfaceMode)
                return mode?.workbench.renderKind === 'renderer-suite' ? resolveInterfaceModeSuite(mode, usePresentationPreferenceStore.getState().rendererSuiteIdByMode[mode.id], rendererRegistrySnapshot.rendererSuites.map(item => item.value.id)).activeSuiteId : undefined
              })()} />
              : <SettingsPreview zone={previewZone!} />}
          </div>
        )}
      </div>
    </div>
  )
}
