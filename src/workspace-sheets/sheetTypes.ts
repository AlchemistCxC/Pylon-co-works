// W1-01（F1-A 方案 A）：9 kind 原地替换——删 diff/changes/git-history（FileSheet 分区化，
// 从未有内容），增 overview/search/history/browser/gateway；旧 kind 由 schema v2 normalize 清洗
import type { ComponentType, ReactNode } from 'react'
import type { Session } from '../identityStore'

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

// ── W1-02：SheetContext（§1.4.1 定稿，13 字段）——只含「sheet 无法自己获得、必须由布局层给」的东西 ──

export interface SheetContext {
  // sheet 间导航（F1-D 联动的公开面）
  openSheet: (input: SheetInput) => SheetId | null
  focusSheet: (id: SheetId) => void
  closeSheet: (id: SheetId) => void
  // 会话选择（profile 投影状态机配套——App.tsx 现有 effect 链的宿主）
  activeSession: string | null
  selectSession: (id: string | null) => void
  // 对话框打开器（保留 App 单例挂载语义）
  openProfileEdit: () => void
  openSessionSettings: (id: string) => void
  // 布局态（布局层所有，sheet 只读）
  sidebarCollapsed: boolean
  rightInset: number
  ccEditMode: boolean
  // source 解析（identity sessionId ↔ ACP source 唯一换算口，禁止 sheet 自写 find）
  sessionSource: (sessionId: string | null) => string | null
  sessionBySource: (source: string) => Session | undefined
}

/** W1-02：渲染注册表条目（F1-B/F2-A）——主区渲染器 + 侧栏/右栏声明（W1-03/04 消费） */
export interface SheetRenderEntry {
  render: (sheet: SheetRecord, ctx: SheetContext) => ReactNode
  sidebar?: ComponentType
  rightPanel?: 'none' | ComponentType
}

export function isSheetKind(value: unknown): value is SheetKind {
  return typeof value === 'string' && (SHEET_KINDS as readonly string[]).includes(value)
}
