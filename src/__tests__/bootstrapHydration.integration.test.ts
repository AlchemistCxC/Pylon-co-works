/**
 * FE-AUD-005 行为回归（阶段 0，先 RED）：Workspace hydrate 双路径覆盖。
 *
 * 目标行为：Workspace hydrate 是单一 bootstrap transaction——App 首挂载 hydrate 后，
 * list_agents 到达（setAgents）只 prune 无效 agent sheet，不得全量替换并覆盖启动期
 * 用户操作或内存态。当前实现（2026-08-07）setAgents 内 loadSheetStateV2 +
 * replaceSheets 全量替换 → 本文件应 RED。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { useWorkspaceStore } from '../workspaceStore'
import { useIdentityStore } from '../identityStore'
import { resetStores } from '../test/resetStores'
import { sheetReducer } from '../workspace-sheets/sheetState'

const PERSISTED_V2 = {
  version: 2,
  state: {
    sheets: [
      { id: 'agent-peri', kind: 'agent', agentId: 'peri', title: 'Peri', createdAt: 1, lastFocusedAt: 1 },
      { id: 'agent-old', kind: 'agent', agentId: 'old-agent', title: 'Old', createdAt: 1, lastFocusedAt: 1 },
      { id: 'search', kind: 'search', title: '搜索', createdAt: 1, lastFocusedAt: 1 },
    ],
    activeSheetId: 'agent-peri',
    recentlyClosed: [],
    agentStates: {},
  },
  layout: { sidebarWidth: 250, sidebarCollapsed: false, rightPanelCollapsed: false },
}

function seedPersisted(): void {
  localStorage.setItem('pylon-workspace-sheets', JSON.stringify(PERSISTED_V2))
}

function hydrateThenUserOpensHistory(): void {
  useWorkspaceStore.getState().hydrateWorkspaceSheets()
  useWorkspaceStore.setState(state => ({
    workspaceSheets: sheetReducer(state.workspaceSheets, {
      type: 'open',
      sheet: { id: 'h1', kind: 'history', title: '历史' },
      now: Date.now(),
    }),
  }))
}

describe('FE-AUD-005 hydrate 双路径', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('agents 到达后的 hydrate 不覆盖启动期用户操作（当前 replaceSheets 覆盖 → RED）', () => {
    seedPersisted()
    hydrateThenUserOpensHistory()
    expect(useWorkspaceStore.getState().workspaceSheets.sheets.some(sheet => sheet.id === 'h1')).toBe(true)
    // agents 到达（list_agents 返回）——第二条 hydrate 路径
    useIdentityStore.getState().setAgents([{ id: 'peri', name: 'Peri' }])
    const sheets = useWorkspaceStore.getState().workspaceSheets.sheets
    expect(sheets.some(sheet => sheet.id === 'h1')).toBe(true)
    expect(sheets.some(sheet => sheet.id === 'search')).toBe(true)
  })

  it('agents 到达后 prune 无效 agent sheet（当前经全量替换实现 — 基线绿）', () => {
    seedPersisted()
    useWorkspaceStore.getState().hydrateWorkspaceSheets()
    useIdentityStore.getState().setAgents([{ id: 'peri', name: 'Peri' }])
    const sheets = useWorkspaceStore.getState().workspaceSheets.sheets
    expect(sheets.some(sheet => sheet.agentId === 'old-agent')).toBe(false)
    expect(sheets.some(sheet => sheet.kind === 'search')).toBe(true)
  })

  it('prune 后 activeSheetId 回退到保留 sheet（createSheetState 收尾）', () => {
    localStorage.setItem('pylon-workspace-sheets', JSON.stringify({
      ...PERSISTED_V2,
      state: { ...PERSISTED_V2.state, activeSheetId: 'agent-old' },
    }))
    useWorkspaceStore.getState().hydrateWorkspaceSheets()
    expect(useWorkspaceStore.getState().workspaceSheets.activeSheetId).toBe('agent-old')
    useIdentityStore.getState().setAgents([{ id: 'peri', name: 'Peri' }])
    const state = useWorkspaceStore.getState()
    expect(state.workspaceSheets.sheets.some(sheet => sheet.agentId === 'old-agent')).toBe(false)
    expect(state.workspaceSheets.activeSheetId).not.toBe('agent-old')
    expect(state.workspaceSheets.activeSheetId).not.toBeNull()
  })
})
