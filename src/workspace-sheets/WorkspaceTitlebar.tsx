import { useEffect, useRef, useState, useSyncExternalStore, type MouseEventHandler } from 'react'
import SheetTabStrip from './SheetTabStrip'
import { useRuntimeStore } from '../runtimeStore'
import { useStore } from '../store'
import AgentStatusLights from '../components/AgentStatusLights'
import type { SheetRecord } from './sheetTypes'
import type { WorkspaceMenuActions } from './WorkspaceMenu'
import { selectAgentStatus } from '../components/settings/agentTypes'
import { Menu, Minus, PanelRight, PanelsTopLeft, Plus, RotateCcw, Settings, Square, Terminal, X } from 'lucide-react'
import type { InterfaceMode } from '../domains/interface/interfaceModeStore.ts'
import type { InterfaceModeChromeStyle } from '../plugin-runtime/interface-mode/interfaceModeTypes.ts'
import { getContextPanelRegistry, getInterfaceModeRegistry } from '../plugin-runtime/runtimeServices.ts'
import { selectAvailableContextPanels } from '../plugin-runtime/context-panel/contextPanelSelection.ts'
import { useRightRailStore } from '../rightRailStore.ts'
import { activateInterfaceMode } from '../application/transactions/activateInterfaceMode.ts'

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
  onToggleSettings,
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
  const [openMenu, setOpenMenu] = useState<'right-panel' | 'interface' | 'settings' | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const contextPanelRegistry = getContextPanelRegistry()
  const interfaceModeRegistry = getInterfaceModeRegistry()
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
  const availablePanels = selectAvailableContextPanels(panelSnapshot.entries, {
    workspaceKind: activeSheetKind,
    sheetId: activeSheetId,
    activeSessionId,
    activeAgent,
  })
  useEffect(() => {
    if (!openMenu) return
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setOpenMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenMenu(null) }
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
            <button type="button" onClick={() => setOpenMenu(value => value === 'right-panel' ? null : 'right-panel')} disabled={availablePanels.length === 0} title={availablePanels.length > 0 ? '右侧栏' : '当前没有可用右侧栏'} aria-label="右侧栏">{chromeStyle === 'icons' ? <PanelRight size={15} aria-hidden="true" /> : '☷'}<span className="workspace-titlebar-entry-label">右侧栏</span></button>
            {openMenu === 'right-panel' && <div className="workspace-menu workspace-menu-chrome" role="menu">
              <div className="workspace-menu-heading">右侧栏</div>
              {availablePanels.length === 0 && <div className="workspace-menu-empty">当前没有可用面板</div>}
              {availablePanels.map(entry => <button key={entry.contributionId} type="button" role="menuitemradio" aria-checked={useRightRailStore.getState().activePanelId === entry.contributionId} onClick={() => { useRightRailStore.getState().setActivePanel(entry.contributionId); useRightRailStore.getState().setCollapsed(false); setOpenMenu(null) }}>{entry.value.label}</button>)}
              <span className="workspace-menu-separator" />
              <button type="button" role="menuitem" onClick={() => { useRightRailStore.getState().setCollapsed(true); setOpenMenu(null) }}>收起右侧栏</button>
            </div>}
          </div>
          <div className="workspace-titlebar-menu-anchor">
            <button type="button" onClick={() => setOpenMenu(value => value === 'interface' ? null : 'interface')} title="界面模式" aria-label="界面模式">{chromeStyle === 'icons' ? <Terminal size={15} aria-hidden="true" /> : <PanelsTopLeft size={15} aria-hidden="true" />}<span className="workspace-titlebar-entry-label">界面</span></button>
            {openMenu === 'interface' && <div className="workspace-menu workspace-menu-chrome" role="menu">
              <div className="workspace-menu-heading">界面模式</div>
              {modeSnapshot.entries.map(entry => <button key={entry.contributionId} type="button" role="menuitemradio" aria-checked={entry.value.id === interfaceMode} onClick={() => { try { const ok = activateInterfaceMode(entry.value.id); if (ok) setOpenMenu(null) } catch { /* activation failure is reported by the transaction */ } }}>{entry.value.label}{entry.value.id === interfaceMode ? '  ✓' : ''}</button>)}
            </div>}
          </div>
          <div className="workspace-titlebar-menu-anchor">
            <button type="button" onClick={() => setOpenMenu(value => value === 'settings' ? null : 'settings')} title="设置" aria-label="设置">{chromeStyle === 'icons' ? <Settings size={15} aria-hidden="true" /> : '⚙'}<span className="workspace-titlebar-entry-label">设置</span></button>
            {openMenu === 'settings' && <div className="workspace-menu workspace-menu-chrome" role="menu"><div className="workspace-menu-heading">设置</div><button type="button" role="menuitem" onClick={() => { setOpenMenu(null); onToggleSettings() }}>全局设置</button></div>}
          </div>
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
