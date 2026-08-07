import { type MouseEventHandler, useState } from 'react'
import SheetTabStrip from './SheetTabStrip'
import { useRuntimeStore } from '../runtimeStore'
import { useStore } from '../store'
import AgentStatusLights from '../components/AgentStatusLights'
import type { SheetRecord } from './sheetTypes'
import type { WorkspaceMenuActions } from './WorkspaceMenu'
import WorkspaceMenu from './WorkspaceMenu'

interface WorkspaceTitlebarProps {
  sheets: SheetRecord[]
  activeSheetId: string | null
  activeAgent: string
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
  sidebarCollapsed,
  canReopenSheet,
  onToggleSidebar,
  onFocusSheet,
  onCloseSheet,
  menuActions,
  onOpenSheet,
  onReopenSheet: _onReopenSheet,
  onToggleRightPanel,
  onToggleSettings,
  onMinimize,
  onToggleFullscreen,
  onCloseWindow,
}: WorkspaceTitlebarProps) {
  // 在标题栏内部订阅 agent 状态：状态 tick 不再触发 App 整树（SheetHost）重渲染
  const agentStatuses = useRuntimeStore(s => s.agentStatuses)
  const showTabBar = useStore(s => s.showTabBar !== false)
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const activeSheet = sheets.find(sheet => sheet.id === activeSheetId) ?? null
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
        {!sidebarCollapsed && (
          <span className="workspace-titlebar-brand" aria-label="Agent 状态">
            <AgentStatusLights status={agentStatuses[activeAgent]?.status ?? ''} size={12} />
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
          <button type="button" className="workspace-titlebar-icon workspace-open-trigger" onClick={onOpenSheet} title="打开 Sheet" aria-label="打开 Sheet">+</button>
          <span className="workspace-launcher-separator" aria-hidden="true" />
          <button type="button" className="workspace-titlebar-icon workspace-reopen-trigger" onClick={() => setWorkspaceMenuOpen(value => !value)} title="Sheet 操作菜单" aria-label="Sheet 操作菜单">⌄</button>
          <WorkspaceMenu {...menuActions} sheet={activeSheet} canReopen={canReopenSheet} open={workspaceMenuOpen} onCloseMenu={() => setWorkspaceMenuOpen(false)} className="workspace-menu-workspace" />
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
