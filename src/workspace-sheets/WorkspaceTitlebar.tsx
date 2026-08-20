import { type MouseEventHandler } from 'react'
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

interface WorkspaceTitlebarProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
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
  sidebarCollapsed,
  sidebarEnabled,
  sidebarExpandedTrack = sidebarEnabled,
  rightPanelEnabled = true,
  canReopenSheet,
  onToggleSidebar,
  onFocusSheet,
  onCloseSheet,
  menuActions,
  onOpenSheet,
  onReopenSheet,
  onToggleRightPanel,
  onToggleSettings,
  interfaceMode = 'terminal-like',
  chromeStyle = interfaceMode === 'modern-gui' ? 'icons' : 'glyphs',
  quickSwitchLabel,
  onToggleInterfaceMode,
  onMinimize,
  onToggleFullscreen,
  onCloseWindow,
  settingsOpen = false,
}: WorkspaceTitlebarProps) {
  const agentStatuses = useRuntimeStore(s => s.agentStatuses)
  const activeStatus = selectAgentStatus(activeAgent, activeAgent, agentStatuses)
  const showTabBar = useStore(s => s.showTabBar !== false)
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

      <div className="workspace-window-controls">
        <button type="button" onClick={onToggleRightPanel} disabled={!rightPanelEnabled} title={rightPanelEnabled ? '右栏' : '当前 Sheet 无右栏'} aria-label={rightPanelEnabled ? '切换右栏' : '当前 Sheet 无右栏'}>{chromeStyle === 'icons' ? <PanelRight size={15} aria-hidden="true" /> : '☷'}</button>
        {onToggleInterfaceMode && <button type="button" className="interface-mode-quick-toggle" onClick={onToggleInterfaceMode}
          title={`切换到 ${quickSwitchLabel ?? (interfaceMode === 'modern-gui' ? 'Terminal-like' : '现代 GUI')}`}
          aria-label={`切换到 ${quickSwitchLabel ?? (interfaceMode === 'modern-gui' ? 'Terminal-like' : '现代 GUI')}`}>
          {chromeStyle === 'icons' ? <Terminal size={15} aria-hidden="true" /> : <PanelsTopLeft size={15} aria-hidden="true" />}
        </button>}
        <button type="button" onClick={onToggleSettings} title="设置" aria-label="切换设置">{chromeStyle === 'icons' ? <Settings size={15} aria-hidden="true" /> : '⚙'}</button>
        <button type="button" className="titlebar-window-btn" onClick={onMinimize} title="最小化" aria-label="最小化">{chromeStyle === 'icons' ? <Minus size={14} aria-hidden="true" /> : '─'}</button>
        <button type="button" className="titlebar-window-btn" onClick={onToggleFullscreen} title="最大化或还原" aria-label="最大化或还原">{chromeStyle === 'icons' ? <Square size={12} aria-hidden="true" /> : '□'}</button>
        <button type="button" className="titlebar-window-btn close" onClick={onCloseWindow} title="关闭" aria-label="关闭窗口">{chromeStyle === 'icons' ? <X size={15} aria-hidden="true" /> : '×'}</button>
      </div>
    </header>
  )
}
