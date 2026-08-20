import { useWorkspaceStore } from '../workspaceStore.ts'
import { resolveWorkspace } from './workspaceRegistry.ts'
import type { SheetId, SheetRecord } from './sheetTypes.ts'

export interface WorkspaceOpenInput {
  type: string
  title?: string
  state?: unknown
  agentId?: string
  singletonKey?: string
  pinned?: boolean
  metadata?: Record<string, string>
}

export function openWorkspace(input: WorkspaceOpenInput): SheetId | null {
  const definition = resolveWorkspace(input.type)
  if (!definition) return null
  return useWorkspaceStore.getState().openSheet({
    kind: definition.kind,
    title: input.title?.trim() || definition.label,
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.singletonKey ? { singletonKey: input.singletonKey } : {}),
    ...(input.pinned ? { pinned: true } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  })
}

export function focusWorkspace(id: SheetId): boolean {
  const exists = useWorkspaceStore.getState().workspaceSheets.sheets.some(sheet => sheet.id === id)
  if (!exists) return false
  useWorkspaceStore.getState().focusSheet(id)
  return true
}

export async function closeWorkspace(id: SheetId): Promise<boolean> {
  const sheet = useWorkspaceStore.getState().workspaceSheets.sheets.find(candidate => candidate.id === id)
  if (!sheet) return false
  if (!await canCloseSheet(sheet)) return false
  useWorkspaceStore.getState().closeSheet(id)
  return true
}

async function canCloseSheet(sheet: SheetRecord): Promise<boolean> {
  const definition = resolveWorkspace(sheet.kind)
  if (definition?.canClose) {
    try {
      const allowed = await definition.canClose(definition.deserialize(sheet.state))
      if (!allowed) return false
    } catch {
      return false
    }
  }
  return true
}

async function canCloseAll(sheets: readonly SheetRecord[]): Promise<boolean> {
  const decisions = await Promise.all(sheets.map(canCloseSheet))
  return decisions.every(Boolean)
}

export async function closeOtherWorkspaces(id: SheetId): Promise<boolean> {
  const sheets = useWorkspaceStore.getState().workspaceSheets.sheets
  if (!sheets.some(sheet => sheet.id === id)) return false
  if (!await canCloseAll(sheets.filter(sheet => sheet.id !== id))) return false
  useWorkspaceStore.getState().closeOtherSheets(id)
  return true
}

export async function closeRightWorkspaces(id: SheetId): Promise<boolean> {
  const sheets = useWorkspaceStore.getState().workspaceSheets.sheets
  const index = sheets.findIndex(sheet => sheet.id === id)
  if (index < 0) return false
  if (!await canCloseAll(sheets.slice(index + 1))) return false
  useWorkspaceStore.getState().closeRightSheets(id)
  return true
}

export function listOpenWorkspaces(): readonly SheetRecord[] {
  return Object.freeze(useWorkspaceStore.getState().workspaceSheets.sheets.map(sheet => Object.freeze({ ...sheet })))
}
