// @vitest-environment jsdom
/**
 * 刷新丢 sheets 回归测试（报告 2.3 ready 前禁写）：
 * hydration 就绪前 SheetLayout 的写回 effect 必须跳过——否则用初始空
 * sheets 覆盖持久化（子 effect 先于 bootstrap hydrate 执行）。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import SheetLayout from '../SheetLayout'
import { useWorkspaceStore } from '../../workspaceStore'
import { useHydrationStore } from '../../app/bootstrap/hydrationState'
import { resetStores } from '../../test/resetStores'

const KEY = 'pylon-workspace-sheets'

function renderLayout() {
  return render(
    <SheetLayout
      activeSession={null}
      onSelectSession={() => {}}
      onProfileEdit={() => {}}
      onSessionSettings={() => {}}
      rightInset={0}
    />,
  )
}

describe('SheetLayout hydration 守卫（刷新丢 sheets）', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    // 预置已持久化的 sheets（模拟 hydrate 应恢复的数据）
    useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })
    useWorkspaceStore.getState().openSheet({ kind: 'search', title: 'Search' })
    useWorkspaceStore.getState().openSheet({ kind: 'gateway', title: 'Gateway' })
  })

  it('hydration 未就绪时 SheetLayout 不写空 sheets（不覆盖持久化）', () => {
    // hydration 初始 idle（未 ready）
    expect(useHydrationStore.getState().status).not.toBe('ready')
    renderLayout()
    // 写回 effect 应跳过：localStorage 保持预置的 3 个 sheets
    const persisted = JSON.parse(localStorage.getItem(KEY)!).state.sheets.map((s: { kind: string }) => s.kind)
    expect(persisted).toContain('search')
    expect(persisted).toContain('gateway')
  })

  it('hydration ready 后恢复持久化 sheets（hydrate 恢复 + 写回不覆盖）', () => {
    renderLayout()
    // 模拟 hydrate：从 localStorage 恢复（此时应已 ready）
    act(() => {
      useHydrationStore.getState().setStatus('ready')
      useWorkspaceStore.getState().hydrateWorkspaceSheets()
    })
    const sheets = useWorkspaceStore.getState().workspaceSheets.sheets
    expect(sheets.some(s => s.kind === 'search')).toBe(true)
    expect(sheets.some(s => s.kind === 'gateway')).toBe(true)
    expect(sheets.some(s => s.kind === 'agent')).toBe(true)
  })
})
