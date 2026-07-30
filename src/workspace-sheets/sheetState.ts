import { getSheetRegistryEntry, resolveSheetSingletonKey } from './sheetRegistry.ts'
import { isSheetKind, type SheetId, type SheetInput, type SheetRecord } from './sheetTypes.ts'

export interface SheetState {
  sheets: SheetRecord[]
  activeSheetId: SheetId | null
  recentlyClosed: SheetRecord[]
}

export const EMPTY_SHEET_STATE: SheetState = {
  sheets: [],
  activeSheetId: null,
  recentlyClosed: [],
}

export type SheetAction =
  | { type: 'open'; sheet: SheetInput; now: number }
  | { type: 'focus'; id: SheetId; now: number }
  | { type: 'togglePin'; id: SheetId; now: number }
  | { type: 'close'; id: SheetId; now: number }
  | { type: 'closeOthers'; id: SheetId; now: number }
  | { type: 'closeRight'; id: SheetId; now: number }
  | { type: 'reopen'; now: number }

const MAX_RECENTLY_CLOSED = 20

function withActiveFallback(state: SheetState): SheetState {
  if (state.sheets.length === 0) return { ...state, activeSheetId: null }
  if (state.activeSheetId && state.sheets.some(sheet => sheet.id === state.activeSheetId)) return state
  return { ...state, activeSheetId: state.sheets[state.sheets.length - 1].id }
}

function focusSheet(state: SheetState, id: SheetId, now: number): SheetState {
  if (!state.sheets.some(sheet => sheet.id === id)) return withActiveFallback(state)
  return {
    ...state,
    activeSheetId: id,
    sheets: state.sheets.map(sheet => sheet.id === id ? { ...sheet, lastFocusedAt: now } : sheet),
  }
}

function closeIds(state: SheetState, ids: Set<SheetId>): SheetState {
  const closed = state.sheets.filter(sheet => ids.has(sheet.id) && !sheet.pinned)
  if (closed.length === 0) return withActiveFallback(state)
  const closeIds = new Set(closed.map(sheet => sheet.id))
  const sheets = state.sheets.filter(sheet => !closeIds.has(sheet.id))
  const recentlyClosed = [...closed.reverse(), ...state.recentlyClosed.filter(sheet => !closeIds.has(sheet.id))].slice(0, MAX_RECENTLY_CLOSED)
  return withActiveFallback({
    sheets,
    activeSheetId: state.activeSheetId && !closeIds.has(state.activeSheetId) ? state.activeSheetId : null,
    recentlyClosed,
  })
}

export function createSheetState(sheets: SheetRecord[] = [], activeSheetId: SheetId | null = null, recentlyClosed: SheetRecord[] = []): SheetState {
  const deduped: SheetRecord[] = []
  const singletonKeys = new Set<string>()
  for (const sheet of sheets) {
    if (!isSheetKind(sheet.kind) || !sheet.id || !sheet.title.trim()) continue
    const key = sheet.singletonKey || resolveSheetSingletonKey(sheet)
    if (key && singletonKeys.has(key)) continue
    if (key) singletonKeys.add(key)
    deduped.push(sheet)
  }
  return withActiveFallback({ sheets: deduped, activeSheetId, recentlyClosed: recentlyClosed.slice(0, MAX_RECENTLY_CLOSED) })
}

export function sheetReducer(state: SheetState, action: SheetAction): SheetState {
  switch (action.type) {
    case 'open': {
      const registry = getSheetRegistryEntry(action.sheet.kind)
      if (!registry) return withActiveFallback(state)
      const singletonKey = resolveSheetSingletonKey(action.sheet)
      const existing = singletonKey ? state.sheets.find(sheet => (sheet.singletonKey || resolveSheetSingletonKey(sheet)) === singletonKey) : undefined
      if (existing) return focusSheet(state, existing.id, action.now)
      const id = action.sheet.id || `${action.sheet.kind}-${action.now.toString(36)}-${state.sheets.length}`
      const kind = isSheetKind(action.sheet.kind) ? action.sheet.kind : null
      if (!kind) return withActiveFallback(state)
      const sheet: SheetRecord = {
        id,
        kind,
        title: action.sheet.title.trim(),
        ...(action.sheet.agentId ? { agentId: action.sheet.agentId } : {}),
        ...(singletonKey ? { singletonKey } : {}),
        ...(action.sheet.pinned ? { pinned: true } : {}),
        createdAt: action.now,
        lastFocusedAt: action.now,
        ...(action.sheet.metadata ? { metadata: action.sheet.metadata } : {}),
      }
      if (!sheet.title) return withActiveFallback(state)
      return { ...state, sheets: [...state.sheets, sheet], activeSheetId: sheet.id }
    }
    case 'focus': return focusSheet(state, action.id, action.now)
    case 'togglePin': {
      if (!state.sheets.some(sheet => sheet.id === action.id)) return withActiveFallback(state)
      return {
        ...state,
        sheets: state.sheets.map(sheet => sheet.id === action.id
          ? { ...sheet, pinned: !sheet.pinned, lastFocusedAt: action.now }
          : sheet),
      }
    }
    case 'close': return closeIds(state, new Set([action.id]))
    case 'closeOthers': return closeIds(state, new Set(state.sheets.filter(sheet => sheet.id !== action.id).map(sheet => sheet.id)))
    case 'closeRight': {
      const index = state.sheets.findIndex(sheet => sheet.id === action.id)
      return index < 0 ? withActiveFallback(state) : closeIds(state, new Set(state.sheets.slice(index + 1).map(sheet => sheet.id)))
    }
    case 'reopen': {
      const recent = state.recentlyClosed[0]
      if (!recent) return withActiveFallback(state)
      const remaining = state.recentlyClosed.slice(1)
      const singletonKey = recent.singletonKey || resolveSheetSingletonKey(recent)
      if (singletonKey && state.sheets.some(sheet => (sheet.singletonKey || resolveSheetSingletonKey(sheet)) === singletonKey)) {
        return { ...state, recentlyClosed: remaining }
      }
      return { ...state, sheets: [...state.sheets, { ...recent, lastFocusedAt: action.now }], activeSheetId: recent.id, recentlyClosed: remaining }
    }
  }
}
