import { create } from 'zustand'
import { createSheetState, sheetReducer } from './workspace-sheets/sheetState'
import { loadSheetState, persistSheetState, type SheetWorkspaceState } from './workspace-sheets/sheetPersistence'
import type { SheetInput, SheetId } from './workspace-sheets/sheetTypes'

/**
 * workspaceStore — Workspace Sheet 状态域（阶段 1：store 按域拆分）。
 *
 * 承载：workspaceSheets / sheetAgentStates 与全部 Sheet actions（独立 versioned 持久化
 * `pylon-workspace-sheets`）。跨域联动（profile/session 变更同步 sheetAgentStates）由
 * identityStore 组合 action 经本 store 的 setter 触发。
 */

interface WorkspaceStoreState {
  workspaceSheets: ReturnType<typeof createSheetState>
  sheetAgentStates: Record<string, SheetWorkspaceState>
  hydrateWorkspaceSheets: (agentIds?: readonly string[]) => void
  openSheet: (sheet: SheetInput) => SheetId | null
  focusSheet: (id: SheetId) => void
  toggleSheetPin: (id: SheetId) => void
  closeSheet: (id: SheetId) => void
  closeOtherSheets: (id: SheetId) => void
  closeRightSheets: (id: SheetId) => void
  reopenSheet: () => SheetId | null
  setSheetAgentState: (agentId: string, partial: Partial<SheetWorkspaceState>) => void
  /** 组合 action 用：整体替换（list_agents 返回时） */
  replaceSheets: (workspaceSheets: ReturnType<typeof createSheetState>, sheetAgentStates: Record<string, SheetWorkspaceState>) => void
  /** 组合 action 用：更新某 agent 的 sheetAgentState 并持久化 */
  patchSheetAgentState: (agentId: string, partial: Partial<SheetWorkspaceState>) => void
  /** 组合 action 用：批量更新 sheetAgentStates 并持久化 */
  patchSheetAgentStates: (agentStates: Record<string, SheetWorkspaceState>) => void
}

function persist(state: WorkspaceStoreState, workspaceSheets: ReturnType<typeof createSheetState>): void {
  persistSheetState(localStorage, { ...workspaceSheets, agentStates: state.sheetAgentStates })
}

export const useWorkspaceStore = create<WorkspaceStoreState>()((set, get) => ({
  workspaceSheets: createSheetState(),
  sheetAgentStates: {},
  hydrateWorkspaceSheets: (agentIds) => set(() => {
    const workspaceSheets = loadSheetState(localStorage, agentIds)
    return { workspaceSheets, sheetAgentStates: workspaceSheets.agentStates }
  }),
  openSheet: (sheet) => {
    const state = get()
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'open', sheet, now: Date.now() })
    set({ workspaceSheets })
    persist(state, workspaceSheets)
    return workspaceSheets.activeSheetId
  },
  focusSheet: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'focus', id, now: Date.now() })
    persist(state, workspaceSheets)
    return { workspaceSheets }
  }),
  toggleSheetPin: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'togglePin', id, now: Date.now() })
    persist(state, workspaceSheets)
    return { workspaceSheets }
  }),
  closeSheet: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'close', id, now: Date.now() })
    persist(state, workspaceSheets)
    return { workspaceSheets }
  }),
  closeOtherSheets: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'closeOthers', id, now: Date.now() })
    persist(state, workspaceSheets)
    return { workspaceSheets }
  }),
  closeRightSheets: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'closeRight', id, now: Date.now() })
    persist(state, workspaceSheets)
    return { workspaceSheets }
  }),
  reopenSheet: () => {
    const state = get()
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'reopen', now: Date.now() })
    set({ workspaceSheets })
    persist(state, workspaceSheets)
    return workspaceSheets.activeSheetId
  },
  setSheetAgentState: (agentId, partial) => set(state => {
    const sheetAgentStates = {
      ...state.sheetAgentStates,
      [agentId]: { ...state.sheetAgentStates[agentId], ...partial },
    }
    persistSheetState(localStorage, { ...state.workspaceSheets, agentStates: sheetAgentStates })
    return { sheetAgentStates }
  }),
  replaceSheets: (workspaceSheets, sheetAgentStates) => set({ workspaceSheets, sheetAgentStates }),
  patchSheetAgentState: (agentId, partial) => set(state => {
    const sheetAgentStates = {
      ...state.sheetAgentStates,
      [agentId]: { ...state.sheetAgentStates[agentId], ...partial },
    }
    persistSheetState(localStorage, { ...state.workspaceSheets, agentStates: sheetAgentStates })
    return { sheetAgentStates }
  }),
  patchSheetAgentStates: (agentStates) => set(state => {
    persistSheetState(localStorage, { ...state.workspaceSheets, agentStates })
    return { sheetAgentStates: agentStates }
  }),
}))
