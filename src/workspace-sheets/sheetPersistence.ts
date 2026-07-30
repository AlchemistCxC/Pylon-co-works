import { createSheetState, type SheetState } from './sheetState.ts'
import { isSheetKind, type SheetRecord } from './sheetTypes.ts'

export const SHEET_SCHEMA_VERSION = 1
export const SHEET_STORAGE_KEY = 'pylon-workspace-sheets'

export interface SheetWorkspaceState {
  activeProfileId?: string
  activeSessionId?: string
  rightPanelTab?: string
}

export interface PersistedSheetState extends SheetState {
  agentStates: Record<string, SheetWorkspaceState>
}

interface SheetEnvelope {
  version: typeof SHEET_SCHEMA_VERSION
  state: PersistedSheetState
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const EMPTY_PERSISTED_SHEET_STATE: PersistedSheetState = {
  sheets: [],
  activeSheetId: null,
  recentlyClosed: [],
  agentStates: {},
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0

function normalizeSheet(value: unknown): SheetRecord | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const id = text(raw.id)
  const title = text(raw.title)
  const kind = raw.kind
  if (!id || !title || !isSheetKind(kind)) return null

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
  }
}

function normalizeAgentState(value: unknown): SheetWorkspaceState | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const activeProfileId = text(raw.activeProfileId)
  const activeSessionId = text(raw.activeSessionId)
  const rightPanelTab = text(raw.rightPanelTab)
  if (!activeProfileId && !activeSessionId && !rightPanelTab) return {}
  return {
    ...(activeProfileId ? { activeProfileId } : {}),
    ...(activeSessionId ? { activeSessionId } : {}),
    ...(rightPanelTab ? { rightPanelTab } : {}),
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

export function serializeSheetState(state: PersistedSheetState): string {
  const envelope: SheetEnvelope = { version: SHEET_SCHEMA_VERSION, state }
  return JSON.stringify(envelope)
}

export function parseSheetState(raw: string | null, agentIds?: readonly string[]): PersistedSheetState {
  if (!raw) return EMPTY_PERSISTED_SHEET_STATE
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return EMPTY_PERSISTED_SHEET_STATE
    const envelope = parsed as Record<string, unknown>
    if (envelope.version !== SHEET_SCHEMA_VERSION) return EMPTY_PERSISTED_SHEET_STATE
    return normalizeState(envelope.state, agentIds)
  } catch {
    return EMPTY_PERSISTED_SHEET_STATE
  }
}

export function persistSheetState(storage: StorageLike, state: PersistedSheetState): void {
  storage.setItem(SHEET_STORAGE_KEY, serializeSheetState(normalizeState(state)))
}

export function loadSheetState(storage: StorageLike, agentIds?: readonly string[]): PersistedSheetState {
  return parseSheetState(storage.getItem(SHEET_STORAGE_KEY), agentIds)
}
