export const SHEET_KINDS = [
  'agent',
  'prism',
  'runtime',
  'file',
  'diff',
  'changes',
  'git-history',
] as const

export type SheetKind = typeof SHEET_KINDS[number]

export type SheetId = string

export interface SheetRecord {
  id: SheetId
  kind: SheetKind
  title: string
  agentId?: string
  singletonKey?: string
  pinned?: boolean
  createdAt: number
  lastFocusedAt: number
  metadata?: Record<string, string>
}

export interface SheetInput {
  id?: SheetId
  kind: SheetKind | string
  title: string
  agentId?: string
  singletonKey?: string
  pinned?: boolean
  metadata?: Record<string, string>
}

export interface SheetRegistryEntry {
  kind: SheetKind
  label: string
  renderKey: string
  singleton: boolean
  getSingletonKey: (input: Pick<SheetInput, 'agentId' | 'singletonKey' | 'metadata'>) => string | undefined
}

export function isSheetKind(value: unknown): value is SheetKind {
  return typeof value === 'string' && (SHEET_KINDS as readonly string[]).includes(value)
}
