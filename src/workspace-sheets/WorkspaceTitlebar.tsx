import { Suspense, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type MouseEventHandler } from 'react'
import SheetTabStrip from './SheetTabStrip'
import { useRuntimeStore } from '../runtimeStore'
import { useStore } from '../store'
import AgentStatusLights from '../components/AgentStatusLights'
import type { SheetRecord } from './sheetTypes'
import type { WorkspaceMenuActions } from './WorkspaceMenu'
import { selectAgentStatus } from '../components/settings/agentTypes'
import { Menu, Minus, Plus, RotateCcw, Square, X } from 'lucide-react'
import type { InterfaceMode } from '../domains/interface/interfaceModeStore.ts'
import type { InterfaceModeChromeStyle } from '../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import { getContextPanelRegistry, getInterfaceModeRegistry, getTitlebarRegistry } from '../plugin-runtime/runtimeServices.ts'
import { selectAvailableContextPanels } from '../plugin-runtime/context-panel/contextPanelSelection.ts'
import { useRightRailStore } from '../rightRailStore.ts'
import { activateInterfaceMode } from '../application/transactions/activateInterfaceMode.ts'
import { IsolatedPluginSurface } from '../plugin-runtime/ui/IsolatedPluginSurface.tsx'
import { PluginContributionBoundary } from '../plugin-runtime/ui/PluginContributionBoundary.tsx'
import type { TitlebarContext } from '../plugin-runtime/titlebar/titlebarTypes.ts'
import { SETTINGS_DOMAINS, SETTINGS_DOMAIN_MENU_META, SETTINGS_DOMAIN_SHORT_LABELS, type SettingsDomainId } from '../settingsDomains.ts'

interface WorkspaceTitlebarProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
  activeSheetKind?: string
  activeSessionId?: string | null
  sidebarCollapsed: boolean
  /** active Sheet 是否有 workspace 或 sheet 左栏；无左栏时按钮禁用。 */
  sidebarEnabled: boolean
  /** TitleBar 左侧是否与 active Sheet 的展开左栏共用同一轨道宽度。 */
  sidebarExpandedTrack?: boolean
  rightPanelEnabled?: boolean
  canReopenSheet: boolean
  onToggleSidebar: () => void
  onFocusSheet: (id: string) => void
  onCloseSheet: (id: string) => void
  menuActions: WorkspaceMenuActions
  onOpenSheet: () => void
  onReopenSheet: () => void
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

type WorkspaceMenuKind = 'right-panel' | 'interface' | 'settings'

export default function WorkspaceTitlebar({
  sheets,
  activeSheetId,
  activeAgent,
  activeSheetKind,
  activeSessionId = null,
  sidebarCollapsed,
  sidebarEnabled,
  sidebarExpandedTrack = sidebarEnabled,
  canReopenSheet,
  onToggleSidebar,
  onFocusSheet,
  onCloseSheet,
  menuActions,
  onOpenSheet,
  onReopenSheet,
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
  const availablePanels = selectAvailableContextPanels(panelSnapshot.entries, {
    workspaceKind: activeSheetKind,
    sheetId: activeSheetId,
    activeSessionId,
    activeAgent,
  })
  const activePanelId = useRightRailStore(state => state.activePanelId)
  const rightPanelAvailable = rightPanelEnabled !== false && availablePanels.length > 0
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
  const sidebarVisiblyOpen = sidebarExpandedTrack && !sidebarCollapsed
  const sidebarToggleLabel = !sidebarEnabled
    ? '当前 Sheet 无侧栏'
    : sidebarCollapsed ? '展开左栏' : '收起左栏'
  return (
    <header className={`workspace-titlebar ${sidebarExpandedTrack ? 'sidebar-expanded-track' : 'sidebar-compact-track'} ${sidebarEnabled ? 'sidebar-enabled' : 'sidebar-disabled'}${settingsOpen ? ' titlebar-settings-open' : ''}`} data-tauri-drag-region>
      <div className="workspace-titlebar-sidebar" data-tauri-drag-region>
        <button
          type="button"
          className="workspace-titlebar-icon workspace-sidebar-toggle"
          onClick={onToggleSidebar}
          disabled={!sidebarEnabled}
          title={sidebarToggleLabel}
          aria-label={sidebarToggleLabel}
        >
          {chromeStyle === 'icons' ? <Menu size={17} aria-hidden="true" /> : <span aria-hidden="true">☰</span>}
        </button>
        {sidebarVisiblyOpen && (
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
          <button type="button" className="workspace-titlebar-icon workspace-open-trigger" onClick={onOpenSheet} title="打开 Sheet" aria-label="打开 Sheet"><Plus size={16} aria-hidden="true" /></button>
          <span className="workspace-launcher-separator" aria-hidden="true" />
          <button type="button" className="workspace-titlebar-icon workspace-reopen-trigger" onClick={onReopenSheet} disabled={!canReopenSheet} title={canReopenSheet ? '重新打开最近关闭的 Sheet' : '没有最近关闭的 Sheet'} aria-label={canReopenSheet ? '重新打开最近关闭的 Sheet' : '没有最近关闭的 Sheet'}><RotateCcw size={14} aria-hidden="true" /></button>
        </div>
        <div className="workspace-titlebar-drag" data-tauri-drag-region />
      </div>

      <div className="workspace-window-controls" ref={menuRef}>
        <div className="workspace-window-app-controls">
          <div className="workspace-titlebar-menu-anchor">
            <button type="button" onClick={event => toggleMenu('right-panel', event.currentTarget)} disabled={!rightPanelAvailable} title={rightPanelAvailable ? '右侧栏' : '当前没有可用右侧栏'} aria-label="右侧栏" aria-haspopup="menu" aria-expanded={openMenu === 'right-panel'} aria-controls={menuId('right-panel')} data-menu-trigger="right-panel"><span className="workspace-titlebar-entry-label">右侧栏</span></button>
            {openMenu === 'right-panel' && <div id={menuId('right-panel')} className="workspace-menu workspace-menu-chrome" role="menu" data-menu-kind="right-panel" onKeyDown={handleMenuKeyDown}>
              <div className="workspace-menu-heading">右侧栏</div>
              {!rightPanelAvailable && <div className="workspace-menu-empty">当前没有可用面板</div>}
              {availablePanels.map(entry => <button key={entry.contributionId} type="button" role="menuitemradio" aria-checked={activePanelId === entry.contributionId} data-selected={activePanelId === entry.contributionId ? 'true' : undefined} onClick={() => { useRightRailStore.getState().setActivePanel(entry.contributionId); useRightRailStore.getState().setCollapsed(false); closeMenu() }}><span className="workspace-menu-check" aria-hidden="true">{activePanelId === entry.contributionId ? '✓' : ''}</span><span>{entry.value.label}</span></button>)}
              <span className="workspace-menu-separator" />
              <button type="button" role="menuitem" onClick={() => { useRightRailStore.getState().setCollapsed(true); closeMenu() }}>收起右侧栏</button>
            </div>}
          </div>
          <div className="workspace-titlebar-menu-anchor">
            <button type="button" onClick={event => toggleMenu('interface', event.currentTarget)} title="界面模式" aria-label="界面模式" aria-haspopup="menu" aria-expanded={openMenu === 'interface'} aria-controls={menuId('interface')} data-menu-trigger="interface"><span className="workspace-titlebar-entry-label">界面</span></button>
            {openMenu === 'interface' && <div id={menuId('interface')} className="workspace-menu workspace-menu-chrome" role="menu" data-menu-kind="interface" onKeyDown={handleMenuKeyDown}>
              <div className="workspace-menu-heading">界面模式</div>
              {modeSnapshot.entries.map(entry => <button key={entry.contributionId} type="button" role="menuitemradio" aria-checked={entry.value.id === interfaceMode} data-selected={entry.value.id === interfaceMode ? 'true' : undefined} onClick={() => { try { const ok = activateInterfaceMode(entry.value.id); if (ok) closeMenu() } catch { /* activation failure is reported by the transaction */ } }}><span className="workspace-menu-check" aria-hidden="true">{entry.value.id === interfaceMode ? '✓' : ''}</span><span>{entry.value.label}</span></button>)}
            </div>}
          </div>
          <div className="workspace-titlebar-menu-anchor">
            <button type="button" onClick={event => toggleMenu('settings', event.currentTarget)} title="设置" aria-label="设置" aria-haspopup="menu" aria-expanded={openMenu === 'settings'} aria-controls={menuId('settings')} data-menu-trigger="settings"><span className="workspace-titlebar-entry-label">设置</span></button>
            {openMenu === 'settings' && <div id={menuId('settings')} className="workspace-menu workspace-menu-chrome" role="menu" data-menu-kind="settings" onKeyDown={handleMenuKeyDown}>
              <div className="workspace-menu-heading">设置</div>
              <div className="workspace-menu-subheading">跳转到设置域</div>
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
            </div>}
          </div>
          {contributedActions.map(entry => {
            const contribution = entry.value
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
