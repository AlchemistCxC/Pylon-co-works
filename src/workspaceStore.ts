import { create } from 'zustand'
import { createSheetState, sheetReducer } from './workspace-sheets/sheetState'
import {
  DEFAULT_SHEET_LAYOUT,
  loadSheetStateV2,
  persistSheetStateV2,
  type SheetLayoutState,
  type SheetWorkspaceState,
} from './workspace-sheets/sheetPersistence'
import { readShowPet, writeShowPet } from './workspace-sheets/showPetPersistence.ts'
import type { SheetInput, SheetId } from './workspace-sheets/sheetTypes'

/**
 * workspaceStore — Workspace Sheet 状态域（阶段 1：store 按域拆分）。
 *
 * 承载：workspaceSheets / sheetAgentStates / 布局三字段（sidebarWidth/sidebarCollapsed/
 * rightPanelCollapsed，W1-01 F2-B 从主题迁出——预设不覆盖布局状态）与 showPet（独立
 * localStorage key，非 envelope 持久字段）。全部独立 versioned 持久化
 * `pylon-workspace-sheets`（schema v2）。
 */

const THEME_STORAGE_KEY = 'pylon-theme'

/** v1→v2 一次性迁移源：读旧主题 sidebarWidth（读失败 250 由调用方回退） */
function readThemeSidebarWidth(): number | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: Record<string, unknown>; sidebarWidth?: unknown }
    const value = parsed.state?.sidebarWidth ?? parsed.sidebarWidth
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

interface WorkspaceStoreState {
  workspaceSheets: ReturnType<typeof createSheetState>
  sheetAgentStates: Record<string, SheetWorkspaceState>
  sidebarWidth: number
  sidebarCollapsed: boolean
  rightPanelCollapsed: boolean
  showPet: boolean
  hydrateWorkspaceSheets: (agentIds?: readonly string[]) => void
  openSheet: (sheet: SheetInput) => SheetId | null
  focusSheet: (id: SheetId) => void
  toggleSheetPin: (id: SheetId) => void
  closeSheet: (id: SheetId) => void
  closeOtherSheets: (id: SheetId) => void
  closeRightSheets: (id: SheetId) => void
  reopenSheet: () => SheetId | null
  setSheetAgentState: (agentId: string, partial: Partial<SheetWorkspaceState>) => void
  replaceSheets: (workspaceSheets: ReturnType<typeof createSheetState>, sheetAgentStates: Record<string, SheetWorkspaceState>) => void
  patchSheetAgentState: (agentId: string, partial: Partial<SheetWorkspaceState>) => void
  patchSheetAgentStates: (agentStates: Record<string, SheetWorkspaceState>) => void
  setSidebarWidth: (width: number) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setRightPanelCollapsed: (collapsed: boolean) => void
  setShowPet: (show: boolean) => void
}

function layoutOf(state: WorkspaceStoreState): SheetLayoutState {
  return {
    sidebarWidth: state.sidebarWidth,
    sidebarCollapsed: state.sidebarCollapsed,
    rightPanelCollapsed: state.rightPanelCollapsed,
  }
}

function persistWorkspace(state: WorkspaceStoreState): void {
  persistSheetStateV2(localStorage, { ...state.workspaceSheets, agentStates: state.sheetAgentStates }, layoutOf(state))
}

export const useWorkspaceStore = create<WorkspaceStoreState>()((set, get) => ({
  workspaceSheets: createSheetState(),
  sheetAgentStates: {},
  sidebarWidth: DEFAULT_SHEET_LAYOUT.sidebarWidth,
  sidebarCollapsed: DEFAULT_SHEET_LAYOUT.sidebarCollapsed,
  rightPanelCollapsed: DEFAULT_SHEET_LAYOUT.rightPanelCollapsed,
  showPet: true,
  hydrateWorkspaceSheets: (agentIds) => set(() => {
    const result = loadSheetStateV2(localStorage, agentIds)
    // v1→v2 迁移：sidebarWidth 从旧主题一次性搬家（读失败回退默认 250）
    let sidebarWidth = result.layout.sidebarWidth
    if (result.migrated) {
      sidebarWidth = readThemeSidebarWidth() ?? sidebarWidth
    }
    const layout: SheetLayoutState = { ...result.layout, sidebarWidth }
    // 迁移写回失败不能让 hydrate 抛错；内存仍返回迁移后的 v2 状态
    try {
      if (result.migrated) persistSheetStateV2(localStorage, { ...result.state, agentStates: result.state.agentStates }, layout)
    } catch { /* 静默 */ }
    return {
      workspaceSheets: result.state,
      sheetAgentStates: result.state.agentStates,
      sidebarWidth: layout.sidebarWidth,
      sidebarCollapsed: layout.sidebarCollapsed,
      rightPanelCollapsed: layout.rightPanelCollapsed,
      showPet: readShowPet(localStorage),
    }
  }),
  openSheet: (sheet) => {
    const state = get()
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'open', sheet, now: Date.now() })
    set({ workspaceSheets })
    persistWorkspace(state)
    return workspaceSheets.activeSheetId
  },
  focusSheet: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'focus', id, now: Date.now() })
    persistWorkspace(state)
    return { workspaceSheets }
  }),
  toggleSheetPin: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'togglePin', id, now: Date.now() })
    persistWorkspace(state)
    return { workspaceSheets }
  }),
  closeSheet: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'close', id, now: Date.now() })
    persistWorkspace(state)
    return { workspaceSheets }
  }),
  closeOtherSheets: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'closeOthers', id, now: Date.now() })
    persistWorkspace(state)
    return { workspaceSheets }
  }),
  closeRightSheets: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'closeRight', id, now: Date.now() })
    persistWorkspace(state)
    return { workspaceSheets }
  }),
  reopenSheet: () => {
    const state = get()
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'reopen', now: Date.now() })
    set({ workspaceSheets })
    persistWorkspace(state)
    return workspaceSheets.activeSheetId
  },
  setSheetAgentState: (agentId, partial) => set(state => {
    const sheetAgentStates = {
      ...state.sheetAgentStates,
      [agentId]: { ...state.sheetAgentStates[agentId], ...partial },
    }
    persistSheetStateV2(localStorage, { ...state.workspaceSheets, agentStates: sheetAgentStates }, layoutOf(state))
    return { sheetAgentStates }
  }),
  replaceSheets: (workspaceSheets, sheetAgentStates) => set({ workspaceSheets, sheetAgentStates }),
  patchSheetAgentState: (agentId, partial) => set(state => {
    const sheetAgentStates = {
      ...state.sheetAgentStates,
      [agentId]: { ...state.sheetAgentStates[agentId], ...partial },
    }
    persistSheetStateV2(localStorage, { ...state.workspaceSheets, agentStates: sheetAgentStates }, layoutOf(state))
    return { sheetAgentStates }
  }),
  patchSheetAgentStates: (agentStates) => set(state => {
    persistSheetStateV2(localStorage, { ...state.workspaceSheets, agentStates }, layoutOf(state))
    return { sheetAgentStates: agentStates }
  }),
  setSidebarWidth: (sidebarWidth) => set(state => {
    const next = { ...state, sidebarWidth }
    persistWorkspace(next)
    return { sidebarWidth }
  }),
  setSidebarCollapsed: (sidebarCollapsed) => set(state => {
    const next = { ...state, sidebarCollapsed }
    persistWorkspace(next)
    return { sidebarCollapsed }
  }),
  setRightPanelCollapsed: (rightPanelCollapsed) => set(state => {
    const next = { ...state, rightPanelCollapsed }
    persistWorkspace(next)
    return { rightPanelCollapsed }
  }),
  setShowPet: (show) => set(() => {
    writeShowPet(localStorage, show)
    return { showPet: show }
  }),
}))
