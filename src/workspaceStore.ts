import { create } from 'zustand'
import { createSheetState, sheetReducer } from './workspace-sheets/sheetState'
import {
  DEFAULT_SHEET_LAYOUT,
  loadSheetStateV2,
  persistSheetStateV2,
  type PersistedSheetState,
  type SheetLayoutState,
  type SheetWorkspaceState,
} from './workspace-sheets/sheetPersistence'
import { readShowPet, writeShowPet } from './workspace-sheets/showPetPersistence.ts'
import { pushTouchedFile, type TouchedFile } from './infrastructure/acp/touchedFiles.ts'
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
  /** FE-AUD-001：最近一次工作区写盘失败的可见状态（null = 无失败） */
  lastPersistError: string | null
  hydrateWorkspaceSheets: (agentIds?: readonly string[]) => void
  openSheet: (sheet: SheetInput) => SheetId | null
  focusSheet: (id: SheetId) => void
  toggleSheetPin: (id: SheetId) => void
  closeSheet: (id: SheetId) => void
  closeOtherSheets: (id: SheetId) => void
  closeRightSheets: (id: SheetId) => void
  reopenSheet: () => SheetId | null
  setSheetAgentState: (agentId: string, partial: Partial<SheetWorkspaceState>) => void
  /** W2-04：原子合并 sheet metadata（openTabs/activeFile 等）并持久化 */
  patchSheetMetadata: (id: SheetId, partial: Record<string, string>) => void
  /** W2-09：工具改动文件（会话级 50 LRU，不持久化）+ 刷新版本戳 */
  touchedFiles: Record<string, TouchedFile[]>
  touchVersions: Record<string, number>
  recordTouchedFile: (source: string, file: Omit<TouchedFile, 'source'>) => void
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

/** FE-AUD-001：唯一 Workspace 持久化快照构造（action 禁止自拼 envelope） */
function buildWorkspaceSnapshot(state: WorkspaceStoreState): PersistedSheetState {
  return { ...state.workspaceSheets, agentStates: state.sheetAgentStates }
}

/**
 * FE-AUD-001：原子工作区提交——先构造完整 next state，再持久化 next state，
 * 最后返回 store patch；写盘失败不阻断内存操作，但把"未保存"提升为可见状态。
 */
function commitWorkspaceMutation(state: WorkspaceStoreState, patch: Partial<WorkspaceStoreState>): Partial<WorkspaceStoreState> {
  const next = { ...state, ...patch }
  const ok = persistSheetStateV2(localStorage, buildWorkspaceSnapshot(next), layoutOf(next))
  if (!ok) return { ...patch, lastPersistError: '工作区状态未能保存到本地存储' }
  // 写盘恢复成功：清掉旧错误提示
  return state.lastPersistError ? { ...patch, lastPersistError: null } : patch
}

export const useWorkspaceStore = create<WorkspaceStoreState>()((set, get) => ({
  workspaceSheets: createSheetState(),
  sheetAgentStates: {},
  touchedFiles: {},
  touchVersions: {},
  sidebarWidth: DEFAULT_SHEET_LAYOUT.sidebarWidth,
  sidebarCollapsed: DEFAULT_SHEET_LAYOUT.sidebarCollapsed,
  rightPanelCollapsed: DEFAULT_SHEET_LAYOUT.rightPanelCollapsed,
  showPet: true,
  lastPersistError: null,
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
    set(commitWorkspaceMutation(state, { workspaceSheets }))
    return workspaceSheets.activeSheetId
  },
  focusSheet: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'focus', id, now: Date.now() })
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  toggleSheetPin: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'togglePin', id, now: Date.now() })
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  closeSheet: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'close', id, now: Date.now() })
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  closeOtherSheets: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'closeOthers', id, now: Date.now() })
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  closeRightSheets: (id) => set(state => {
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'closeRight', id, now: Date.now() })
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  reopenSheet: () => {
    const state = get()
    const workspaceSheets = sheetReducer(state.workspaceSheets, { type: 'reopen', now: Date.now() })
    set(commitWorkspaceMutation(state, { workspaceSheets }))
    return workspaceSheets.activeSheetId
  },
  recordTouchedFile: (source, file) => set(state => {
    const key = `${source}:${file.path}`
    const touchedFiles = { ...state.touchedFiles, [source]: pushTouchedFile(state.touchedFiles[source] ?? [], { ...file, source }) }
    const touchVersions = { ...state.touchVersions, [key]: (state.touchVersions[key] ?? 0) + 1 }
    return { touchedFiles, touchVersions }
  }),
  patchSheetMetadata: (id, partial) => set(state => {
    const sheets = state.workspaceSheets.sheets.map(sheet => sheet.id === id
      ? { ...sheet, metadata: { ...sheet.metadata, ...partial }, lastFocusedAt: Date.now() }
      : sheet)
    const workspaceSheets = { ...state.workspaceSheets, sheets }
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  setSheetAgentState: (agentId, partial) => set(state => {
    const sheetAgentStates = {
      ...state.sheetAgentStates,
      [agentId]: { ...state.sheetAgentStates[agentId], ...partial },
    }
    return commitWorkspaceMutation(state, { sheetAgentStates })
  }),
  replaceSheets: (workspaceSheets, sheetAgentStates) => set({ workspaceSheets, sheetAgentStates }),
  patchSheetAgentState: (agentId, partial) => set(state => {
    const sheetAgentStates = {
      ...state.sheetAgentStates,
      [agentId]: { ...state.sheetAgentStates[agentId], ...partial },
    }
    return commitWorkspaceMutation(state, { sheetAgentStates })
  }),
  patchSheetAgentStates: (agentStates) => set(state => commitWorkspaceMutation(state, { sheetAgentStates: agentStates })),
  setSidebarWidth: (sidebarWidth) => set(state => commitWorkspaceMutation(state, { sidebarWidth })),
  setSidebarCollapsed: (sidebarCollapsed) => set(state => commitWorkspaceMutation(state, { sidebarCollapsed })),
  setRightPanelCollapsed: (rightPanelCollapsed) => set(state => commitWorkspaceMutation(state, { rightPanelCollapsed })),
  setShowPet: (show) => set(() => {
    writeShowPet(localStorage, show)
    return { showPet: show }
  }),
}))
