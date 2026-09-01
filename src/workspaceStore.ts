import { create } from 'zustand'
import { createSheetState, sheetReducer } from './workspace-sheets/sheetState.ts'
import {
  DEFAULT_SHEET_LAYOUT,
  loadSheetStateV2,
  persistSheetStateV2,
  type PersistedSheetState,
  type SheetLayoutState,
  type SheetWorkspaceState,
} from './workspace-sheets/sheetPersistence.ts'
import { readShowPet, writeShowPet } from './workspace-sheets/showPetPersistence.ts'
import { pushTouchedFile, type TouchedFile } from './infrastructure/acp/touchedFiles.ts'
import type { SheetInput, SheetId } from './workspace-sheets/sheetTypes.ts'
import type { AgentContext, AgentContextKey } from './agentContext.ts'
import { toAgentContextKey } from './agentContext.ts'
import { normalizeFilePath } from './domains/file/fileRelations.ts'
import { resolveWorkspace } from './workspace-sheets/workspaceRegistry.ts'
import { useRightRailStore } from './rightRailStore.ts'
import { readLegacyLayoutSnapshot } from './infrastructure/persistence/legacyKeyMigration.ts'

/** I01-W3：touchedFiles 刷新版本戳 key——context key + normalized path 二元（禁止冒号 split）。 */
export function touchedFileVersionKey(context: AgentContext, path: string): string {
  return JSON.stringify([toAgentContextKey(context), normalizeFilePath(path)])
}

/**
 * workspaceStore — Workspace Sheet 状态域（阶段 1：store 按域拆分）。
 *
 * 承载：workspaceSheets / sheetAgentStates / 布局三字段（sidebarWidth/sidebarCollapsed/
 * rightPanelCollapsed，W1-01 F2-B 从主题迁出——预设不覆盖布局状态）与 showPet（独立
 * localStorage key，非 envelope 持久字段）。全部独立 versioned 持久化
 * `pylon-workspace-sheets`（schema v2）。
 */

const legacyLayout = readLegacyLayoutSnapshot()

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
  /** Workspace definition state 经 codec 合并后持久化。 */
  patchSheetState: (id: SheetId, partial: Record<string, unknown>) => void
  /** W2-09 + I01-W3：工具改动文件（会话级 50 LRU，不持久化）+ 刷新版本戳；
   *  按 AgentContextKey（agentId+source）隔离——双 Agent 同名 source 文件状态不共享 */
  touchedFiles: Record<AgentContextKey, TouchedFile[]>
  touchVersions: Record<string, number>
  recordTouchedFile: (context: AgentContext, file: Omit<TouchedFile, 'source'>) => void
  /** FE-AUD-005：agents 到达后仅 prune 无效 agent sheet（不重复全量 hydrate） */
  pruneAgentSheets: (agentIds: readonly string[]) => void
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
  sidebarWidth: legacyLayout.leftWidth ?? DEFAULT_SHEET_LAYOUT.sidebarWidth,
  sidebarCollapsed: legacyLayout.leftCollapsed ?? DEFAULT_SHEET_LAYOUT.sidebarCollapsed,
  rightPanelCollapsed: legacyLayout.rightCollapsed ?? DEFAULT_SHEET_LAYOUT.rightPanelCollapsed,
  showPet: true,
  lastPersistError: null,
  hydrateWorkspaceSheets: (agentIds) => set(() => {
    const result = loadSheetStateV2(localStorage, agentIds)
    // v1→v2 迁移：sidebarWidth 从旧主题一次性搬家（读失败回退默认 250）
    let sidebarWidth = result.layout.sidebarWidth
    if (result.migrated) {
      sidebarWidth = legacyLayout.leftWidth ?? sidebarWidth
    }
    const layout: SheetLayoutState = { ...result.layout, sidebarWidth }
    // Keep the v3 application layout store in lockstep while old workspace
    // snapshots are hydrated.  This is a one-way compatibility bridge; new
    // UI writes go directly to useRightRailStore.
    useRightRailStore.getState().setLeftRailWidth(layout.sidebarWidth)
    useRightRailStore.getState().setLeftRailCollapsed(layout.sidebarCollapsed)
    useRightRailStore.getState().setCollapsed(layout.rightPanelCollapsed)
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
  recordTouchedFile: (context, file) => set(state => {
    const contextKey = toAgentContextKey(context)
    const versionKey = touchedFileVersionKey(context, file.path)
    const touchedFiles = { ...state.touchedFiles, [contextKey]: pushTouchedFile(state.touchedFiles[contextKey] ?? [], { ...file, source: context.source }) }
    const touchVersions = { ...state.touchVersions, [versionKey]: (state.touchVersions[versionKey] ?? 0) + 1 }
    return { touchedFiles, touchVersions }
  }),
  patchSheetMetadata: (id, partial) => set(state => {
    const sheets = state.workspaceSheets.sheets.map(sheet => sheet.id === id
      ? { ...sheet, metadata: { ...sheet.metadata, ...partial }, lastFocusedAt: Date.now() }
      : sheet)
    const workspaceSheets = { ...state.workspaceSheets, sheets }
    return commitWorkspaceMutation(state, { workspaceSheets })
  }),
  patchSheetState: (id, partial) => set(state => {
    const sheets = state.workspaceSheets.sheets.map(sheet => {
      if (sheet.id !== id) return sheet
      const definition = resolveWorkspace(sheet.kind)
      if (!definition) return sheet
      const current = definition.deserialize(sheet.state)
      const merged = { ...(current && typeof current === 'object' ? current : {}), ...partial }
      return { ...sheet, state: definition.serialize(merged), lastFocusedAt: Date.now() }
    })
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
  pruneAgentSheets: (agentIds) => set(state => {
    const allowed = new Set(agentIds)
    const sheets = state.workspaceSheets.sheets.filter(sheet =>
      sheet.kind !== 'agent' || (sheet.agentId !== undefined && allowed.has(sheet.agentId)))
    // createSheetState 收尾：activeSheetId 指向被删 sheet 时回退到保留的最后一个
    const workspaceSheets = createSheetState(sheets, state.workspaceSheets.activeSheetId, state.workspaceSheets.recentlyClosed)
    const sheetAgentStates = Object.fromEntries(
      Object.entries(state.sheetAgentStates).filter(([agentId]) => allowed.has(agentId)))
    return commitWorkspaceMutation(state, { workspaceSheets, sheetAgentStates })
  }),
  patchSheetAgentState: (agentId, partial) => set(state => {
    const sheetAgentStates = {
      ...state.sheetAgentStates,
      [agentId]: { ...state.sheetAgentStates[agentId], ...partial },
    }
    return commitWorkspaceMutation(state, { sheetAgentStates })
  }),
  patchSheetAgentStates: (agentStates) => set(state => commitWorkspaceMutation(state, { sheetAgentStates: agentStates })),
  setSidebarWidth: (sidebarWidth) => {
    // 兼容旧调用方：布局真值已迁移到 rightRailStore，workspace 字段仅保留
    // versioned snapshot/旧插件读取桥，不能再让两套状态分叉。
    useRightRailStore.getState().setLeftRailWidth(sidebarWidth)
    set(state => commitWorkspaceMutation(state, { sidebarWidth }))
  },
  // 左栏是应用布局，而不是 Sheet 内容。所有 Sheet 共享这一份持久化状态。
  setSidebarCollapsed: (sidebarCollapsed) => {
    useRightRailStore.getState().setLeftRailCollapsed(sidebarCollapsed)
    set(state => commitWorkspaceMutation(state, { sidebarCollapsed }))
  },
  setRightPanelCollapsed: (rightPanelCollapsed) => {
    useRightRailStore.getState().setCollapsed(rightPanelCollapsed)
    set(state => commitWorkspaceMutation(state, { rightPanelCollapsed }))
  },
  setShowPet: (show) => set(() => {
    writeShowPet(localStorage, show)
    return { showPet: show }
  }),
}))
