import { type MouseEventHandler } from 'react'
import SheetTabStrip from './SheetTabStrip'
import type { SheetRecord } from './sheetTypes'
import type { AgentStatus } from '../components/settings/agentTypes'
import type { WorkspaceMenuActions } from './WorkspaceMenu'

interface WorkspaceTitlebarProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
  agentStatuses: Record<string, AgentStatus>
  sidebarCollapsed: boolean
  canReopenSheet: boolean
  onToggleSidebar: () => void
  onFocusSheet: (id: string) => void
  onCloseSheet: (id: string) => void
  menuActions: WorkspaceMenuActions
  onOpenSheet: () => void
  onReopenSheet: () => void
  onToggleRightPanel: () => void
  onToggleSettings: () => void
  onMinimize: MouseEventHandler<HTMLButtonElement>
  onToggleFullscreen: MouseEventHandler<HTMLButtonElement>
  onCloseWindow: MouseEventHandler<HTMLButtonElement>
}

export default function WorkspaceTitlebar({
  sheets,
  activeSheetId,
  activeAgent,
  agentStatuses,
  sidebarCollapsed,
  canReopenSheet,
  onToggleSidebar,
  onFocusSheet,
  onCloseSheet,
  menuActions,
  onOpenSheet,
  onReopenSheet,
  onToggleRightPanel,
  onToggleSettings,
  onMinimize,
  onToggleFullscreen,
  onCloseWindow,
}: WorkspaceTitlebarProps) {
  return (
    <header className={`workspace-titlebar ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`} data-tauri-drag-region>
      <div className="workspace-titlebar-sidebar" data-tauri-drag-region>
        <button
          type="button"
          className="workspace-titlebar-icon workspace-sidebar-toggle"
          onClick={onToggleSidebar}
          title={sidebarCollapsed ? '展开左栏' : '收起左栏'}
          aria-label={sidebarCollapsed ? '展开左栏' : '收起左栏'}
        >
          <span aria-hidden="true">☰</span>
        </button>
        {!sidebarCollapsed && <span className="workspace-titlebar-brand" aria-hidden="true">PYLON</span>}
      </div>

      <div className="workspace-titlebar-workspace">
        <SheetTabStrip
          sheets={sheets}
          activeSheetId={activeSheetId}
          activeAgent={activeAgent}
          agentStatuses={agentStatuses}
          onFocus={onFocusSheet}
          onClose={onCloseSheet}
          menuActions={menuActions}
          canReopen={canReopenSheet}
        />
        <div className="workspace-titlebar-launchers">
          <button type="button" className="workspace-titlebar-icon workspace-open-trigger" onClick={onOpenSheet} title="打开 Sheet" aria-label="打开 Sheet">+</button>
          <span className="workspace-launcher-separator" aria-hidden="true" />
          <button type="button" className="workspace-titlebar-icon workspace-reopen-trigger" onClick={onReopenSheet} disabled={!canReopenSheet} title="重开最近关闭的 Sheet" aria-label="重开最近关闭的 Sheet">⌄</button>
        </div>
        <div className="workspace-titlebar-drag" data-tauri-drag-region />
      </div>

      <div className="workspace-window-controls">
        <button type="button" onClick={onToggleRightPanel} title="右栏" aria-label="切换右栏">☷</button>
        <button type="button" onClick={onToggleSettings} title="设置" aria-label="切换设置">⚙</button>
        <button type="button" onClick={onMinimize} title="最小化" aria-label="最小化">─</button>
        <button type="button" onClick={onToggleFullscreen} title="最大化或还原" aria-label="最大化或还原">□</button>
        <button type="button" className="close" onClick={onCloseWindow} title="关闭" aria-label="关闭窗口">×</button>
      </div>
    </header>
  )
}
