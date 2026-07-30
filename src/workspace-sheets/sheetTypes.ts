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

export function normalizeSheetInput(input: SheetInput, now: number, fallbackId: SheetId): SheetRecord | null {
  if (!isSheetKind(input.kind) || typeof input.title !== 'string' || !input.title.trim()) return null
  const id = typeof input.id === 'string' && input.id.trim() ? input.id : fallbackId
  const metadata = input.metadata && typeof input.metadata === 'object'
    ? Object.fromEntries(Object.entries(input.metadata).filter(([key, value]) => typeof key === 'string' && typeof value === 'string'))
    : undefined
  return {
    id,
    kind: input.kind,
    title: input.title.trim(),
    ...(typeof input.agentId === 'string' && input.agentId.trim() ? { agentId: input.agentId.trim() } : {}),
    ...(typeof input.singletonKey === 'string' && input.singletonKey.trim() ? { singletonKey: input.singletonKey.trim() } : {}),
    ...(input.pinned === true ? { pinned: true } : {}),
    createdAt: now,
    lastFocusedAt: now,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  }
}
