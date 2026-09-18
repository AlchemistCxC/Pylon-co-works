import { Suspense, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEventHandler } from 'react'
import SheetTabStrip from './SheetTabStrip'
import { useRuntimeStore } from '../runtimeStore'
import { useStore } from '../store'
import { useWorkspaceStore } from '../workspaceStore'
import AgentStatusLights from '../components/AgentStatusLights'
import type { SheetRecord } from './sheetTypes'
import type { WorkspaceMenuActions } from './WorkspaceMenu'
import { selectAgentStatus } from '../components/settings/agentTypes'
import { Minus, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Plus, Settings, Square, X } from 'lucide-react'
import type { InterfaceMode } from '../domains/interface/interfaceModeStore.ts'
import type { InterfaceModeChromeStyle } from '../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import { getCommandRegistry, getContextPanelRegistry, getInterfaceModeRegistry, getTitlebarRegistry } from '../plugin-runtime/runtimeServices.ts'
import { selectContextPanels } from '../plugin-runtime/context-panel/contextPanelSelection.ts'
import { useRightRailStore } from '../rightRailStore.ts'
import { activateInterfaceMode } from '../application/transactions/activateInterfaceMode.ts'
import { IsolatedPluginSurface } from '../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../plugin-runtime/ui/PluginContributionBoundary.tsx'
import type { TitlebarContext } from '../plugin-runtime/titlebar/titlebarTypes.ts'
import { resolveLaunchIcon } from './launchIcons.tsx'
import { SETTINGS_DOMAINS, SETTINGS_DOMAIN_MENU_META, SETTINGS_DOMAIN_SHORT_LABELS, type SettingsDomainId } from '../settingsDomains.ts'

interface WorkspaceTitlebarProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
  activeSheetKind?: string
  activeSessionId?: string | null
  sidebarCollapsed: boolean
  /** active Sheet 是否真的会渲染左栏；无左栏时左格不占轨道、折叠按钮不出现。 */
  sidebarEnabled: boolean
  rightPanelEnabled?: boolean
  onToggleSidebar: () => void
  onFocusSheet: (id: string) => void
  onCloseSheet: (id: string) => void
  menuActions: WorkspaceMenuActions
  onOpenSheet: () => void
  onToggleRightPanel: () => void
  onToggleSettings: () => void
  /** Open Settings directly at one of the four top-level domains. */
  onOpenSettingsDomain?: (domain: SettingsDomainId) => void
  interfaceMode?: InterfaceMode
  chromeStyle?: InterfaceModeChromeStyle
  quickSwitchLabel?: string
  onToggleInterfaceMode?: () => void
  onMinimize: MouseEventHandler<HTMLButtonElement>
  onToggleFullscreen: MouseEventHandler<HTMLButtonElement>
  onCloseWindow: MouseEventHandler<HTMLButtonElement>
  /** 设置页打开时：除最小化/全屏/关闭外，标题栏其它交互禁用（视觉保留，且不产生新依赖链） */
  settingsOpen?: boolean
}

/** 右簇只有一个菜单：齿轮（界面 + 设置 + 插件项）。右栏的类型切换在右栏内部，标题栏不再有一份。 */
type WorkspaceMenuKind = 'app-menu'

export default function WorkspaceTitlebar({
  sheets,
  activeSheetId,
  activeAgent,
  activeSheetKind,
  activeSessionId = null,
  sidebarCollapsed,
  sidebarEnabled,
  onToggleSidebar,
  onFocusSheet,
  onCloseSheet,
  menuActions,
  onOpenSheet,
  onToggleRightPanel,
  rightPanelEnabled = true,
  onToggleSettings,
  onOpenSettingsDomain,
  interfaceMode = 'terminal-like',
  chromeStyle = interfaceMode === 'modern-gui' ? 'icons' : 'glyphs',
  onMinimize,
  onToggleFullscreen,
  onCloseWindow,
  settingsOpen = false,
}: WorkspaceTitlebarProps) {
  const agentStatuses = useRuntimeStore(s => s.agentStatuses)
  const activeStatus = selectAgentStatus(activeAgent, activeAgent, agentStatuses)
  const showTabBar = useStore(s => s.showTabBar !== false)
  // 「有最近关闭的 Sheet」只服务于**页签右键菜单**里的重开项：标题栏上那个重开按钮已删除
  // （能力没删——命令 `workspace.sheet.reopen` 与页签右键都还在）。
  const canReopenSheet = useWorkspaceStore(state => state.workspaceSheets.recentlyClosed.length > 0)
  const [openMenu, setOpenMenu] = useState<WorkspaceMenuKind | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const previousOpenMenuRef = useRef<WorkspaceMenuKind | null>(null)
  const titlebarId = useId().replace(/:/g, '')
  const contextPanelRegistry = getContextPanelRegistry()
  const interfaceModeRegistry = getInterfaceModeRegistry()
  const titlebarRegistry = getTitlebarRegistry()
  const panelSnapshot = useSyncExternalStore(
    listener => contextPanelRegistry.subscribe(listener),
    () => contextPanelRegistry.getSnapshot(),
    () => contextPanelRegistry.getSnapshot(),
  )
  const modeSnapshot = useSyncExternalStore(
    listener => interfaceModeRegistry.subscribe(listener),
    () => interfaceModeRegistry.getSnapshot(),
    () => interfaceModeRegistry.getSnapshot(),
  )
  const titlebarSnapshot = useSyncExternalStore(
    listener => titlebarRegistry.subscribe(listener),
    () => titlebarRegistry.getSnapshot(),
    () => titlebarRegistry.getSnapshot(),
  )
  const titlebarContext: TitlebarContext = {
    interfaceMode,
    workspaceKind: activeSheetKind,
    sheetId: activeSheetId,
    settingsOpen,
  }
  const contributedActions = titlebarSnapshot.entries.filter(entry => {
    if (entry.value.slot !== 'app-actions') return false
    try { return entry.value.when?.(titlebarContext) ?? true } catch { return false }
  })
  const availablePanels = selectContextPanels(panelSnapshot.entries, {
    workspaceKind: activeSheetKind,
    sheetId: activeSheetId,
    activeSessionId,
    activeAgent,
  })
  const rightRailCollapsed = useRightRailStore(state => state.collapsed)
  const rightPanelAvailable = rightPanelEnabled !== false && availablePanels.length > 0
  // 插件注册的齿轮菜单项（API 2.1）：数据化贡献，点了跑命令。
  const pluginMenuItems = titlebarSnapshot.entries.flatMap(entry => {
    const contribution = entry.value
    if (contribution.slot !== 'app-menu' || contribution.renderKind !== 'command') return []
    try { return (contribution.when?.(titlebarContext) ?? true) ? [contribution] : [] } catch { return [] }
  })
  const runMenuCommand = (commandId: string) => {
    // 菜单项的命令可能属于已停用插件或因故不可执行——失败记账但不炸标题栏。
    void getCommandRegistry().execute(commandId).catch(error => {
      console.error('标题栏菜单命令执行失败', commandId, error)
    })
  }
  const menuId = (kind: WorkspaceMenuKind) => `${titlebarId}-menu-${kind}`
  const toggleMenu = (kind: WorkspaceMenuKind, trigger: HTMLButtonElement) => {
    menuTriggerRef.current = trigger
    setOpenMenu(value => value === kind ? null : kind)
  }
  const closeMenu = () => setOpenMenu(null)
  const menuItems = (menu: HTMLDivElement | null): HTMLButtonElement[] => menu
    ? [...menu.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')]
    : []
  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const menu = event.currentTarget
    const items = menuItems(menu)
    if (items.length === 0) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowUp'
          ? (current <= 0 ? items.length - 1 : current - 1)
          : (current < 0 || current === items.length - 1 ? 0 : current + 1)
    items[next]?.focus()
  }
  useEffect(() => {
    const previousOpenMenu = previousOpenMenuRef.current
    if (openMenu) {
      const menu = document.getElementById(`${titlebarId}-menu-${openMenu}`)
      const selected = menu?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ;(selected ?? menu?.querySelector<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)'))?.focus()
    } else if (previousOpenMenu) {
      const trigger = menuTriggerRef.current
      if (trigger && document.contains(trigger)) trigger.focus()
    }
    previousOpenMenuRef.current = openMenu
  }, [openMenu, titlebarId])
  useEffect(() => {
    if (!openMenu) return
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpenMenu(null)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpenMenu(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown) }
  }, [openMenu])
  // #154：左格只在左列真的可见时占轨道——折叠后轨道宽度由
  // --sheet-sidebar-track-width 归零，整格不参与布局，于是既没有空列也没有悬空分割线。
  const sidebarExpanded = sidebarEnabled && !sidebarCollapsed
  const sidebarToggleLabel = sidebarCollapsed ? '展开左栏' : '收起左栏'
  return (
    <header className={`workspace-titlebar ${sidebarExpanded ? 'sidebar-expanded' : 'sidebar-collapsed'} ${sidebarEnabled ? 'sidebar-enabled' : 'sidebar-disabled'}${settingsOpen ? ' titlebar-settings-open' : ''}`} data-tauri-drag-region>
      <div className="workspace-titlebar-sidebar" data-tauri-drag-region>
        {/* 折叠按钮在最左、三灯在其右，顺序固定。它留在左格里的前提是左格折叠时**不收成 0**
            而是收窄到按钮宽度（标题栏 grid 第 1 列用 `max(轨道宽, 按钮宽)`），否则按钮会随
            轨道一起消失、位置也不再稳定。始终渲染（本 Sheet 无左栏时禁用），
            避免随 Sheet 能力忽隐忽现。 */}
        <button
          type="button"
          className="workspace-titlebar-icon workspace-sidebar-toggle"
          onClick={onToggleSidebar}
          disabled={!sidebarEnabled}
          title={sidebarEnabled ? sidebarToggleLabel : '当前 Sheet 无侧栏'}
          aria-label={sidebarEnabled ? sidebarToggleLabel : '当前 Sheet 无侧栏'}
          aria-expanded={sidebarEnabled ? sidebarExpanded : undefined}
          data-sidebar-toggle="true"
        >
          {/* 图标表达「左栏在/不在」而不是汉堡菜单：☰ 会读成「打开菜单」。 */}
          {chromeStyle === 'icons'
            ? (sidebarExpanded ? <PanelLeftClose size={17} aria-hidden="true" /> : <PanelLeftOpen size={17} aria-hidden="true" />)
            : <span aria-hidden="true">{sidebarExpanded ? '▤' : '▢'}</span>}
        </button>
        {sidebarExpanded && (
          <span className="workspace-titlebar-brand" aria-label="Agent 状态">
            <AgentStatusLights status={activeStatus.status} size={12} />
          </span>
        )}
      </div>

      <div className="workspace-titlebar-workspace">
        {showTabBar && <SheetTabStrip
          sheets={sheets}
          activeSheetId={activeSheetId}
          activeAgent={activeAgent}
          agentStatuses={agentStatuses}
          onFocus={onFocusSheet}
          onClose={onCloseSheet}
          menuActions={menuActions}
          canReopen={canReopenSheet}
        />}
        <div className="workspace-titlebar-launchers">
          {/* 新建 Sheet 是**浏览器式**的：紧贴最后一个页签右侧（页签区收缩到内容宽度，
              空档全部让给右侧拖拽区），不是被推到窗口右端。 */}
          <button type="button" className="workspace-titlebar-icon workspace-open-trigger" onClick={onOpenSheet} title="打开 Sheet" aria-label="打开 Sheet"><Plus size={16} aria-hidden="true" /></button>
        </div>
        <div className="workspace-titlebar-drag" data-tauri-drag-region />
      </div>

      <div className="workspace-window-controls" ref={menuRef}>
        <div className="workspace-window-app-controls">
          {/* 右栏按钮**只负责折叠**：类型切换在右栏内部（`.context-panel-tabs`），标题栏不再持有第二处
              切换入口。图标与左栏折叠钮同构，只是朝向镜像。 */}
          <button
            type="button"
            className="workspace-titlebar-icon workspace-right-rail-toggle"
            onClick={onToggleRightPanel}
            disabled={!rightPanelAvailable}
            title={rightPanelAvailable ? (rightRailCollapsed ? '展开右侧栏' : '收起右侧栏') : '当前没有可用右侧栏'}
            aria-label={rightPanelAvailable ? (rightRailCollapsed ? '展开右侧栏' : '收起右侧栏') : '当前没有可用右侧栏'}
            aria-expanded={rightPanelAvailable ? !rightRailCollapsed : undefined}
            data-right-rail-toggle="true"
          >
            {/* 图标是**画出来的**面板符号（右侧一道实心条 = 右栏在），不是 `»` 箭头：
                箭头和窗口控制、以及右栏内部那个折叠钮撞脸，用户点名要「个别的图标」。 */}
            {chromeStyle === 'icons'
              ? (rightRailCollapsed ? <PanelRightOpen size={17} aria-hidden="true" /> : <PanelRightClose size={17} aria-hidden="true" />)
              : <span className="workspace-rail-glyph" aria-hidden="true" />}
          </button>
          <div className="workspace-titlebar-menu-anchor">
            <button
              type="button"
              className="workspace-titlebar-icon workspace-titlebar-menu-icon"
              onClick={event => toggleMenu('app-menu', event.currentTarget)}
              title="界面与设置"
              aria-label="界面与设置"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'app-menu'}
              aria-controls={menuId('app-menu')}
              data-menu-trigger="app-menu"
            >
              {chromeStyle === 'icons' ? <Settings size={16} aria-hidden="true" /> : <span aria-hidden="true">⚙</span>}
            </button>
            {openMenu === 'app-menu' && <div id={menuId('app-menu')} className="workspace-menu workspace-menu-chrome" role="menu" data-menu-kind="app-menu" onKeyDown={handleMenuKeyDown}>
              {/* 二级内容分三段：界面模式（radio）/ 设置域（跳转）/ 插件项（命令）。 */}
              <div className="workspace-menu-heading">界面模式</div>
              {modeSnapshot.entries.map(entry => <button key={entry.contributionId} type="button" role="menuitemradio" aria-checked={entry.value.id === interfaceMode} data-selected={entry.value.id === interfaceMode ? 'true' : undefined} onClick={() => { try { const ok = activateInterfaceMode(entry.value.id); if (ok) closeMenu() } catch { /* activation failure is reported by the transaction */ } }}><span className="workspace-menu-check" aria-hidden="true">{entry.value.id === interfaceMode ? '✓' : ''}</span><span>{entry.value.label}</span></button>)}
              <span className="workspace-menu-separator" />
              <div className="workspace-menu-subheading">设置</div>
              {SETTINGS_DOMAINS.map(domain => {
                const meta = SETTINGS_DOMAIN_MENU_META[domain.id]
                const label = SETTINGS_DOMAIN_SHORT_LABELS[domain.id]
                return <button
                  key={domain.id}
                  type="button"
                  role="menuitem"
                  className="workspace-menu-domain-item"
                  aria-label={label}
                  title={`${domain.label}：${meta.description}`}
                  data-settings-domain={domain.id}
                  onClick={() => {
                    closeMenu()
                    if (onOpenSettingsDomain) onOpenSettingsDomain(domain.id)
                    else onToggleSettings()
                  }}
                >
                  <span className="workspace-menu-check workspace-menu-domain-glyph" aria-hidden="true">{meta.glyph}</span>
                  <span className="workspace-menu-item-copy"><strong>{label}</strong><small>{meta.description}</small></span>
                  <span className="workspace-menu-chevron" aria-hidden="true">›</span>
                </button>
              })}
              {pluginMenuItems.length > 0 && <>
                <span className="workspace-menu-separator" />
                <div className="workspace-menu-subheading">插件</div>
                {pluginMenuItems.map(contribution => {
                  const ContributionIcon = resolveLaunchIcon(contribution.icon)
                  return <button
                    key={contribution.id}
                    type="button"
                    role="menuitem"
                    className="workspace-menu-command-item"
                    title={contribution.label}
                    aria-label={contribution.label}
                    data-menu-command={contribution.commandId}
                    onClick={() => { closeMenu(); runMenuCommand(contribution.commandId) }}
                  >
                    <span className="workspace-menu-check workspace-menu-command-glyph" aria-hidden="true">{contribution.icon ? <ContributionIcon size={13} /> : ''}</span>
                    <span>{contribution.label}</span>
                  </button>
                })}
              </>}
            </div>}
          </div>
          {contributedActions.map(entry => {
            const contribution = entry.value
            // 菜单项不进标题栏按钮簇：它是数据化贡献，渲染在齿轮菜单里（见上）。
            if (contribution.renderKind === 'command') return null
            if (contribution.renderKind === 'isolated-surface') {
              return <IsolatedPluginSurface key={entry.contributionId} surfaceId={contribution.surfaceId} className="workspace-titlebar-plugin-action" input={{ titlebarContext }} />
            }
            const Contribution = contribution.component
            return <PluginContributionBoundary key={entry.contributionId} contributionId={entry.contributionId}><Suspense fallback={null}><Contribution context={titlebarContext} /></Suspense></PluginContributionBoundary>
          })}
        </div>
        <span className="workspace-window-controls-divider" aria-hidden="true" />
        <div className="workspace-window-native-controls" aria-label="窗口控制">
          <button type="button" className="titlebar-window-btn titlebar-window-btn-start" onClick={onMinimize} title="最小化" aria-label="最小化"><Minus size={14} aria-hidden="true" /></button>
          <button type="button" className="titlebar-window-btn" onClick={onToggleFullscreen} title="最大化或还原" aria-label="最大化或还原"><Square size={12} aria-hidden="true" /></button>
          <button type="button" className="titlebar-window-btn close" onClick={onCloseWindow} title="关闭" aria-label="关闭窗口"><X size={15} aria-hidden="true" /></button>
        </div>
      </div>
    </header>
  )
}
