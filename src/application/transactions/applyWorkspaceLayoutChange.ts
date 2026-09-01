import { useWorkspaceStore } from '../../workspaceStore.ts'
import { useRightRailStore } from '../../rightRailStore.ts'
import { reportRuntimeError } from '../../runtimeError.ts'

export interface WorkspaceLayoutPatch {
  readonly sidebarWidth?: number
  readonly sidebarCollapsed?: boolean
  readonly rightPanelCollapsed?: boolean
  readonly rightRailWidth?: number
  readonly rightRailCollapsed?: boolean
}

export interface WorkspaceLayoutPorts {
  readonly workspace: {
    getState: () => { sidebarWidth: number; sidebarCollapsed: boolean; rightPanelCollapsed: boolean; setSidebarWidth: (value: number) => void; setSidebarCollapsed: (value: boolean) => void; setRightPanelCollapsed: (value: boolean) => void }
  }
  readonly rightRail: {
    getState: () => { width: number; leftRailWidth: number; leftRailCollapsed: boolean; collapsed: boolean; setWidth: (value: number) => void; setLeftRailWidth: (value: number) => void; setLeftRailCollapsed: (value: boolean) => void; setCollapsed: (value: boolean) => void }
  }
}

const defaults: WorkspaceLayoutPorts = { workspace: useWorkspaceStore, rightRail: useRightRailStore }

export type WorkspaceLayoutResult = { ok: true } | { ok: false; message: string }

/** Single owner for the workspace/right-rail layout bridge. */
export function applyWorkspaceLayoutChange(
  patch: WorkspaceLayoutPatch,
  ports: WorkspaceLayoutPorts = defaults,
): WorkspaceLayoutResult {
  const workspace = ports.workspace.getState()
  const rail = ports.rightRail.getState()
  const previous = {
    sidebarWidth: workspace.sidebarWidth,
    sidebarCollapsed: workspace.sidebarCollapsed,
    rightPanelCollapsed: workspace.rightPanelCollapsed,
    width: rail.width,
    leftRailWidth: rail.leftRailWidth,
    leftRailCollapsed: rail.leftRailCollapsed,
    collapsed: rail.collapsed,
  }
  try {
    if (patch.sidebarWidth !== undefined) {
      rail.setLeftRailWidth(patch.sidebarWidth)
      workspace.setSidebarWidth(patch.sidebarWidth)
    }
    if (patch.sidebarCollapsed !== undefined) {
      rail.setLeftRailCollapsed(patch.sidebarCollapsed)
      workspace.setSidebarCollapsed(patch.sidebarCollapsed)
    }
    if (patch.rightPanelCollapsed !== undefined) {
      rail.setCollapsed(patch.rightPanelCollapsed)
      workspace.setRightPanelCollapsed(patch.rightPanelCollapsed)
    }
    if (patch.rightRailWidth !== undefined) rail.setWidth(patch.rightRailWidth)
    if (patch.rightRailCollapsed !== undefined) rail.setCollapsed(patch.rightRailCollapsed)
    return { ok: true }
  } catch (error) {
    try {
      rail.setWidth(previous.width)
      rail.setLeftRailWidth(previous.leftRailWidth)
      rail.setLeftRailCollapsed(previous.leftRailCollapsed)
      rail.setCollapsed(previous.collapsed)
      workspace.setSidebarWidth(previous.sidebarWidth)
      workspace.setSidebarCollapsed(previous.sidebarCollapsed)
      workspace.setRightPanelCollapsed(previous.rightPanelCollapsed)
    } catch (rollbackError) {
      reportRuntimeError('回滚 Workspace 布局事务', rollbackError)
    }
    const detail = reportRuntimeError('更新 Workspace 布局', error)
    return { ok: false, message: detail.message }
  }
}
