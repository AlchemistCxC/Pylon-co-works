// @vitest-environment jsdom
/**
 * I09-A-FE-01（L1：响应式 SheetContext，6.10 问题 #4 等级 1）：
 * sidebarCollapsed 变化后 active Sheet 必须立即收到新 ctx——不依赖 buildSheetContext
 * 里 useWorkspaceStore.getState() 的旧快照（ISSUE-09.md 施工点 2：折叠状态完全响应式）。
 * 观察点：Sidebar 的 <aside className="sidebar collapsed|">（agent = workspace 级侧栏，
 * ctx.sidebarCollapsed 直连折叠类）。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import '../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { render, act, waitFor } from '@testing-library/react'
import SheetLayout from '../SheetLayout'
import { useWorkspaceStore } from '../../workspaceStore'
import { resetStores } from '../../test/resetStores'

function renderLayout() {
  return render(
    <SheetLayout
      activeSession={null}
      onSelectSession={() => {}}
      onProfileEdit={() => {}}
      onSessionSettings={() => {}}
    />,
  )
}

describe('I09-A-FE-01 SheetLayout sidebarCollapsed 响应式订阅', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('sidebarCollapsed 变化后 ctx 立即响应（不经 getState 旧快照）', async () => {
    const agentId = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })
    expect(agentId).not.toBeNull()
    useWorkspaceStore.getState().focusSheet(agentId!)
    const { container } = renderLayout()

    await waitFor(() => expect(container.querySelector('.sidebar')).toBeTruthy(), { timeout: 10_000 })
    const sidebar = container.querySelector('.sidebar') as HTMLElement | null
    expect(sidebar).toBeTruthy()
    expect(sidebar!.classList.contains('collapsed')).toBe(false)

    const expandedTrack = getComputedStyle(sidebar!).width

    // 折叠：若 SheetLayout 仅 getState() 快照（不订阅），此处不重渲染 → collapsed 类不出现
    act(() => {
      useWorkspaceStore.getState().setSidebarCollapsed(true)
    })
    expect(sidebar!.classList.contains('collapsed')).toBe(true)
    expect(getComputedStyle(sidebar!).width).toBe(expandedTrack)

    // 展开：响应式订阅同样立即可见
    act(() => {
      useWorkspaceStore.getState().setSidebarCollapsed(false)
    })
    expect(sidebar!.classList.contains('collapsed')).toBe(false)
    expect(getComputedStyle(sidebar!).width).toBe(expandedTrack)
  })

  it('FileSheet 与 AgentSheet 共享同一折叠状态', async () => {
    const agentId = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })
    const fileId = useWorkspaceStore.getState().openSheet({ kind: 'file', title: 'Files', singletonKey: 'file:workspace' })
    expect(agentId).not.toBeNull()
    expect(fileId).not.toBeNull()
    useWorkspaceStore.getState().focusSheet(fileId!)
    const { container } = renderLayout()

    await waitFor(() => expect(container.querySelector('.file-sidebar')).toBeTruthy(), { timeout: 10_000 })
    act(() => useWorkspaceStore.getState().setSidebarCollapsed(true))
    expect(container.querySelector('.file-sidebar')).toHaveClass('collapsed')

    act(() => useWorkspaceStore.getState().focusSheet(agentId!))
    await waitFor(() => expect(container.querySelector('.sidebar')).toBeTruthy(), { timeout: 10_000 })
    expect(container.querySelector('.sidebar')).toHaveClass('collapsed')

    act(() => useWorkspaceStore.getState().setSidebarCollapsed(false))
    expect(container.querySelector('.sidebar')).not.toHaveClass('collapsed')

    act(() => useWorkspaceStore.getState().focusSheet(fileId!))
    await waitFor(() => expect(container.querySelector('.file-sidebar')).toBeTruthy(), { timeout: 10_000 })
    expect(container.querySelector('.file-sidebar')).not.toHaveClass('collapsed')
  })
})
