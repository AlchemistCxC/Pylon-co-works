import { createSheetState, type SheetState } from './sheetState.ts'
import { isSheetKind, type SheetRecord } from './sheetTypes.ts'
import { resolveWorkspace } from './workspaceRegistry.ts'

// W1-01：schema v1→v2（F1-A 方案 A + F2-B 布局搬家）——9 kind 清洗旧 kind；
// v2 envelope 加 layout 三字段（sidebarWidth/sidebarCollapsed/rightPanelCollapsed）；
// v1 parser 保留为迁移源，parse 按 version 分支，serialize 只输出 v2。
export const SHEET_SCHEMA_VERSION = 2
export const SHEET_STORAGE_KEY = 'pylon-workspace-sheets'

export interface SheetWorkspaceState {
  activeProfileId?: string
  activeSessionId?: string
}

export interface PersistedSheetState extends SheetState {
  agentStates: Record<string, SheetWorkspaceState>
}

/** v2 layout 三字段（F2-B：布局状态从主题迁出，预设不覆盖） */
export interface SheetLayoutState {
  sidebarWidth: number
  sidebarCollapsed: boolean
  rightPanelCollapsed: boolean
}

export const DEFAULT_SHEET_LAYOUT: SheetLayoutState = {
  sidebarWidth: 250,
  sidebarCollapsed: false,
  rightPanelCollapsed: false,
}

interface SheetEnvelopeV2 {
  version: typeof SHEET_SCHEMA_VERSION
  state: PersistedSheetState
  layout: SheetLayoutState
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const EMPTY_PERSISTED_SHEET_STATE: PersistedSheetState = Object.freeze({
  sheets: [],
  activeSheetId: null,
  recentlyClosed: [],
  agentStates: {},
})

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0

function normalizeSheet(value: unknown): SheetRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id)
  const title = text(raw.title)
  const kind = raw.kind
  if (!id || !title || !isSheetKind(kind)) return null
  const workspace = resolveWorkspace(kind)
  if (!workspace) return null
  try {
    workspace.deserialize(raw.state)
  } catch {
    return null
  }

  const metadata = raw.metadata && typeof raw.metadata === 'object'
    ? Object.fromEntries(
        Object.entries(raw.metadata).filter(([key, item]) => typeof key === 'string' && typeof item === 'string'),
      )
    : undefined

  return {
    id,
    kind,
    title,
    ...(text(raw.agentId) ? { agentId: text(raw.agentId) } : {}),
    ...(text(raw.singletonKey) ? { singletonKey: text(raw.singletonKey) } : {}),
    ...(raw.pinned === true ? { pinned: true } : {}),
    createdAt: timestamp(raw.createdAt),
    lastFocusedAt: timestamp(raw.lastFocusedAt),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    ...(raw.state !== undefined ? { state: raw.state } : {}),
  }
}

function normalizeAgentState(value: unknown): SheetWorkspaceState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const activeProfileId = text(raw.activeProfileId)
  const activeSessionId = text(raw.activeSessionId)
  if (!activeProfileId && !activeSessionId) return {}
  return {
    ...(activeProfileId ? { activeProfileId } : {}),
    ...(activeSessionId ? { activeSessionId } : {}),
  }
}

function normalizeState(value: unknown, agentIds?: readonly string[]): PersistedSheetState {
  if (!value || typeof value !== 'object') return EMPTY_PERSISTED_SHEET_STATE
  const raw = value as Record<string, unknown>
  const allowedAgents = agentIds ? new Set(agentIds.filter(id => typeof id === 'string' && id.trim())) : null
  const rawSheets = Array.isArray(raw.sheets) ? raw.sheets : []
  const sheets = rawSheets
    .map(normalizeSheet)
    .filter((sheet): sheet is SheetRecord => Boolean(sheet))
    .filter(sheet => !allowedAgents || sheet.kind !== 'agent' || (sheet.agentId && allowedAgents.has(sheet.agentId)))
  const recentlyClosed = Array.isArray(raw.recentlyClosed)
    ? raw.recentlyClosed.map(normalizeSheet).filter((sheet): sheet is SheetRecord => Boolean(sheet))
    : []
  const base = createSheetState(sheets, text(raw.activeSheetId) || null, recentlyClosed)

  const rawAgentStates = raw.agentStates && typeof raw.agentStates === 'object' ? raw.agentStates : {}
  const agentStates: Record<string, SheetWorkspaceState> = {}
  for (const [agentId, rawAgentState] of Object.entries(rawAgentStates)) {
    if (allowedAgents && !allowedAgents.has(agentId)) continue
    const normalized = normalizeAgentState(rawAgentState)
    if (normalized) agentStates[agentId] = normalized
  }

  return { ...base, agentStates }
}

/** v2 layout 容错：宽度 finite + clamp；collapsed 只接受 boolean（细化路线 §4 步骤 2） */
function normalizeLayout(value: unknown): SheetLayoutState {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const rawWidth = raw.sidebarWidth
  const width = typeof rawWidth === 'number' && Number.isFinite(rawWidth)
    ? Math.min(520, Math.max(160, rawWidth))
    : DEFAULT_SHEET_LAYOUT.sidebarWidth
  return {
    sidebarWidth: width,
    sidebarCollapsed: typeof raw.sidebarCollapsed === 'boolean' ? raw.sidebarCollapsed : DEFAULT_SHEET_LAYOUT.sidebarCollapsed,
    rightPanelCollapsed: typeof raw.rightPanelCollapsed === 'boolean' ? raw.rightPanelCollapsed : DEFAULT_SHEET_LAYOUT.rightPanelCollapsed,
  }
}

export interface SheetHydrateResult {
  state: PersistedSheetState
  layout: SheetLayoutState
  /** 输入为 v1（或缺失 layout）：true——调用方应立即 serialize 写回 v2 */
  migrated: boolean
}

/**
 * 解析 v2 envelope；v1 输入走迁移（normalize sheets 清洗旧 kind，layout 取默认，
 * sidebarWidth 由调用方读旧主题一次性迁移）。损坏/未知 version 返回空状态（不抛错）。
 */
export function parseSheetStateV2(raw: string | null, agentIds?: readonly string[]): SheetHydrateResult {
  if (!raw) return { state: EMPTY_PERSISTED_SHEET_STATE, layout: { ...DEFAULT_SHEET_LAYOUT }, migrated: false }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { state: EMPTY_PERSISTED_SHEET_STATE, layout: { ...DEFAULT_SHEET_LAYOUT }, migrated: false }
    const envelope = parsed as Record<string, unknown>
    if (envelope.version === SHEET_SCHEMA_VERSION) {
      return {
        state: normalizeState(envelope.state, agentIds),
        layout: normalizeLayout(envelope.layout),
        migrated: false,
      }
    }
    // v1 迁移（细化路线 §4 步骤 4）：先 normalize sheets，layout 取默认（sidebarWidth 由调用方读旧主题）
    if (envelope.version === 1) {
      return {
        state: normalizeState(envelope.state, agentIds),
        layout: { ...DEFAULT_SHEET_LAYOUT },
        migrated: true,
      }
    }
    return { state: EMPTY_PERSISTED_SHEET_STATE, layout: { ...DEFAULT_SHEET_LAYOUT }, migrated: false }
  } catch {
    return { state: EMPTY_PERSISTED_SHEET_STATE, layout: { ...DEFAULT_SHEET_LAYOUT }, migrated: false }
  }
}

/** 只输出 v2，不再生成 v1（细化路线 §4 步骤 6） */
export function serializeSheetStateV2(state: PersistedSheetState, layout: SheetLayoutState): string {
  const envelope: SheetEnvelopeV2 = { version: SHEET_SCHEMA_VERSION, state, layout }
  return JSON.stringify(envelope)
}

export function persistSheetStateV2(storage: StorageLike, state: PersistedSheetState, layout: SheetLayoutState): boolean {
  try {
    storage.setItem(SHEET_STORAGE_KEY, serializeSheetStateV2(normalizeState(state), normalizeLayout(layout)))
    return true
  } catch {
    // 存储不可用/写满：写盘失败不应让 workspace action（zustand set 内）抛异常；
    // 返回 false 供调用方把"未保存"提升为可见状态（报告 FE-AUD-001/阶段 1A.5）
    return false
  }
}

export function loadSheetStateV2(storage: StorageLike, agentIds?: readonly string[]): SheetHydrateResult {
  let raw: string | null = null
  try { raw = storage.getItem(SHEET_STORAGE_KEY) } catch { /* 存储不可用：按空状态处理 */ }
  return parseSheetStateV2(raw, agentIds)
}

// ── v1 保留（迁移源 fixture）：旧 schema normalize/roundtrip 由 test-sheet-persistence 锁定 ──

interface SheetEnvelopeV1 {
  version: 1
  state: PersistedSheetState
}

export function serializeSheetStateV1(state: PersistedSheetState): string {
  const envelope: SheetEnvelopeV1 = { version: 1, state }
  return JSON.stringify(envelope)
}

export function parseSheetStateV1(raw: string | null, agentIds?: readonly string[]): PersistedSheetState {
  if (!raw) return EMPTY_PERSISTED_SHEET_STATE
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return EMPTY_PERSISTED_SHEET_STATE
    const envelope = parsed as Record<string, unknown>
    if (envelope.version !== 1) return EMPTY_PERSISTED_SHEET_STATE
    return normalizeState(envelope.state, agentIds)
  } catch {
    return EMPTY_PERSISTED_SHEET_STATE
  }
}
