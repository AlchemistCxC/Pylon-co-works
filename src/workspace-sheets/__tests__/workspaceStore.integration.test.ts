/**
 * FE-AUD-001 行为回归（阶段 0，先 RED）：Workspace Sheet action 持久化一致性。
 *
 * 目标行为：open/focus/pin/close/closeOthers/closeRight/reopen/metadata/layout 任一
 * action 之后，`pylon-workspace-sheets` 的序列化内容必须与 store 内存 next state 一致。
 * 当前实现（2026-08-07）在多个 action 中持久化的是 action 前旧 state → 本文件应 RED。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { useWorkspaceStore } from '../../workspaceStore'
import { resetStores } from '../../test/resetStores'
import { SHEET_STORAGE_KEY, type PersistedSheetState, type SheetLayoutState } from '../sheetPersistence'
import type { SheetRecord } from '../sheetTypes'

const KEY = SHEET_STORAGE_KEY

interface PersistedEnvelope {
  version: number
  state: PersistedSheetState
  layout: SheetLayoutState
}

function readPersisted(): PersistedEnvelope {
  const raw = localStorage.getItem(KEY)
  expect(raw).not.toBeNull()
  return JSON.parse(raw!) as PersistedEnvelope
}

function openAgentSheet(agentId = 'peri'): string {
  const id = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId, title: agentId })
  expect(id).not.toBeNull()
  return id!
}

function openToolSheet(kind: 'search' | 'history' | 'gateway', title: string): string {
  const id = useWorkspaceStore.getState().openSheet({ kind, title })
  expect(id).not.toBeNull()
  return id!
}

/** 内存 sheet 集合（含重开栈）与持久化集合的一致性断言 */
function expectPersistedMatchesMemory(): void {
  const memory = useWorkspaceStore.getState().workspaceSheets
  const persisted = readPersisted().state
  const ids = (sheets: readonly SheetRecord[]) => sheets.map(sheet => sheet.id).sort()
  expect(ids(persisted.sheets)).toEqual(ids(memory.sheets))
  expect(persisted.activeSheetId).toBe(memory.activeSheetId)
  expect(persisted.recentlyClosed.length).toBe(memory.recentlyClosed.length)
}

describe('FE-AUD-001 Workspace action 持久化一致性', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('openSheet 后持久化与内存一致', () => {
    openAgentSheet()
    expectPersistedMatchesMemory()
  })

  it('连续 openSheet 后持久化与内存一致', () => {
    openAgentSheet('peri')
    openToolSheet('search', '搜索')
    openToolSheet('history', '历史')
    expectPersistedMatchesMemory()
  })

  it('focusSheet 后持久化 activeSheetId 与内存一致', () => {
    const a = openAgentSheet('peri')
    const b = openToolSheet('search', '搜索')
    useWorkspaceStore.getState().focusSheet(a)
    expect(useWorkspaceStore.getState().workspaceSheets.activeSheetId).toBe(a)
    expect(readPersisted().state.activeSheetId).toBe(a)
    useWorkspaceStore.getState().focusSheet(b)
    expect(useWorkspaceStore.getState().workspaceSheets.activeSheetId).toBe(b)
    expect(readPersisted().state.activeSheetId).toBe(b)
  })

  it('toggleSheetPin 后持久化 pin 与内存一致', () => {
    const id = openToolSheet('search', '搜索')
    useWorkspaceStore.getState().toggleSheetPin(id)
    const memory = useWorkspaceStore.getState().workspaceSheets.sheets.find(sheet => sheet.id === id)
    const persisted = readPersisted().state.sheets.find(sheet => sheet.id === id)
    expect(memory?.pinned).toBe(true)
    expect(persisted?.pinned).toBe(true)
  })

  it('closeSheet 后持久化与内存一致（不再含已关 sheet）', () => {
    openAgentSheet('peri')
    openToolSheet('search', '搜索')
    const closeTarget = openToolSheet('history', '历史')
    useWorkspaceStore.getState().closeSheet(closeTarget)
    const memory = useWorkspaceStore.getState().workspaceSheets
    expect(memory.sheets.some(sheet => sheet.id === closeTarget)).toBe(false)
    const persisted = readPersisted().state
    expect(persisted.sheets.some(sheet => sheet.id === closeTarget)).toBe(false)
    expect(persisted.sheets.length).toBe(memory.sheets.length)
  })

  it('closeOtherSheets 后持久化与内存一致', () => {
    openAgentSheet('peri')
    const keep = openToolSheet('search', '搜索')
    openToolSheet('history', '历史')
    useWorkspaceStore.getState().closeOtherSheets(keep)
    const memory = useWorkspaceStore.getState().workspaceSheets
    expect(memory.sheets.map(sheet => sheet.id).sort()).toEqual([keep])
    expect(readPersisted().state.sheets.map(sheet => sheet.id).sort()).toEqual([keep])
  })

  it('closeRightSheets 后持久化与内存一致', () => {
    openAgentSheet('peri')
    openToolSheet('search', '搜索')
    const right = openToolSheet('history', '历史')
    useWorkspaceStore.getState().closeRightSheets(right)
    const memory = useWorkspaceStore.getState().workspaceSheets
    expect(memory.sheets.some(sheet => sheet.id === right)).toBe(false)
    expect(readPersisted().state.sheets.some(sheet => sheet.id === right)).toBe(false)
  })

  it('reopenSheet 后持久化与内存一致', () => {
    openAgentSheet('peri')
    const closed = openToolSheet('search', '搜索')
    useWorkspaceStore.getState().closeSheet(closed)
    const reopened = useWorkspaceStore.getState().reopenSheet()
    expect(reopened).not.toBeNull()
    expectPersistedMatchesMemory()
  })

  it('patchSheetMetadata 后持久化 metadata 与内存一致（基线：当前已正确）', () => {
    const id = openToolSheet('search', '搜索')
    useWorkspaceStore.getState().patchSheetMetadata(id, { activeFile: '/a/b.ts' })
    const memory = useWorkspaceStore.getState().workspaceSheets.sheets.find(sheet => sheet.id === id)
    const persisted = readPersisted().state.sheets.find(sheet => sheet.id === id)
    expect(memory?.metadata).toEqual({ activeFile: '/a/b.ts' })
    expect(persisted?.metadata).toEqual({ activeFile: '/a/b.ts' })
  })

  it('setSidebarWidth 后持久化 layout 与内存一致（基线：当前已正确）', () => {
    useWorkspaceStore.getState().setSidebarWidth(320)
    expect(useWorkspaceStore.getState().sidebarWidth).toBe(320)
    expect(readPersisted().layout.sidebarWidth).toBe(320)
  })

  it('openSheet 后模拟重启（hydrate）不丢失最近操作（当前实现丢失）', () => {
    openAgentSheet('peri')
    openToolSheet('search', '搜索')
    const memSheets = useWorkspaceStore.getState().workspaceSheets.sheets.length
    expect(memSheets).toBe(2)
    // 模拟重启：从持久化重新 hydrate
    useWorkspaceStore.getState().hydrateWorkspaceSheets()
    const afterReload = useWorkspaceStore.getState().workspaceSheets.sheets.length
    expect(afterReload).toBe(memSheets)
  })
})
