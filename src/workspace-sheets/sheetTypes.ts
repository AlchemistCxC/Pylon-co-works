// W1-01（F1-A 方案 A）：9 kind 原地替换——删 diff/changes/git-history（FileSheet 分区化，
// 从未有内容），增 overview/search/history/browser/gateway；旧 kind 由 schema v2 normalize 清洗
export const SHEET_KINDS = [
  'agent',
  'prism',
  'runtime',
  'file',
  'overview',
  'search',
  'history',
  'browser',
  'gateway',
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
