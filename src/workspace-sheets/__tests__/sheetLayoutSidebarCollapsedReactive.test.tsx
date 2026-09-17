// @vitest-environment jsdom
/**
 * I09-A-FE-01（L1：响应式 SheetContext，6.10 问题 #4 等级 1）
 * + #154 改写：折叠可见性从「各 Sheet 自己加 collapsed 类」收归布局层状态。
 *
 * 旧观察点是 `Sidebar` 的 `<aside className="sidebar collapsed">`——每个 Sheet 各持
 * 一份折叠类，这正是分割线对不齐的成因。新观察点是布局层唯一状态
 * `.layout[data-sidebar="expanded" | "collapsed"]`：它同时驱动唯一宽度真值
 * （--sheet-sidebar-track-width）、唯一竖直分割线与内部可见性。
 *
 * 被测风险不变，且更集中：sidebarCollapsed 变化后必须**立即**反映到布局状态，
 * 不能依赖 buildSheetContext 里 getState() 的陈旧快照（ISSUE-09.md 施工点 2）。
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

const layoutOf = (container: HTMLElement) => container.querySelector('.layout') as HTMLElement

describe('I09-A-FE-01 / #154 SheetLayout sidebarCollapsed 响应式订阅', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
  })

  it('sidebarCollapsed 变化后布局状态立即响应（不经 getState 旧快照）', async () => {
    const agentId = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })
    expect(agentId).not.toBeNull()
    useWorkspaceStore.getState().focusSheet(agentId!)
    const { container } = renderLayout()

    await waitFor(() => expect(container.querySelector('.sidebar')).toBeTruthy(), { timeout: 10_000 })
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'expanded')

    // 折叠：若 SheetLayout 仅 getState() 快照（不订阅），此处不重渲染 → 状态不翻转
    act(() => {
      useWorkspaceStore.getState().setSidebarCollapsed(true)
    })
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'collapsed')

    // 展开：响应式订阅同样立即可见
    act(() => {
      useWorkspaceStore.getState().setSidebarCollapsed(false)
    })
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'expanded')
  })

  it('拖拽手柄只在左列可见时存在（折叠后不残留热区）', async () => {
    const agentId = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })
    useWorkspaceStore.getState().focusSheet(agentId!)
    const { container } = renderLayout()

    await waitFor(() => expect(container.querySelector('.left-rail-resize-handle')).toBeTruthy(), { timeout: 10_000 })
    act(() => useWorkspaceStore.getState().setSidebarCollapsed(true))
    expect(container.querySelector('.left-rail-resize-handle')).toBeNull()
  })

  it('FileSheet 与 AgentSheet 共享同一折叠状态（同一布局状态，不是两份 Sheet 私有类）', async () => {
    const agentId = useWorkspaceStore.getState().openSheet({ kind: 'agent', agentId: 'peri', title: 'Peri' })
    const fileId = useWorkspaceStore.getState().openSheet({ kind: 'file', title: 'Files', singletonKey: 'file:workspace' })
    expect(agentId).not.toBeNull()
    expect(fileId).not.toBeNull()
    useWorkspaceStore.getState().focusSheet(fileId!)
    const { container } = renderLayout()

    await waitFor(() => expect(container.querySelector('.file-sidebar')).toBeTruthy(), { timeout: 10_000 })
    act(() => useWorkspaceStore.getState().setSidebarCollapsed(true))
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'collapsed')

    act(() => useWorkspaceStore.getState().focusSheet(agentId!))
    await waitFor(() => expect(container.querySelector('.sidebar')).toBeTruthy(), { timeout: 10_000 })
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'collapsed')

    act(() => useWorkspaceStore.getState().setSidebarCollapsed(false))
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'expanded')

    act(() => useWorkspaceStore.getState().focusSheet(fileId!))
    await waitFor(() => expect(container.querySelector('.file-sidebar')).toBeTruthy(), { timeout: 10_000 })
    expect(layoutOf(container)).toHaveAttribute('data-sidebar', 'expanded')
  })
})
