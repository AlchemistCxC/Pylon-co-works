// @vitest-environment jsdom
/**
 * I09-A-FE-02（L2：Browser 单一折叠状态，6.10 问题 #4）：
 * Browser 消除独立折叠布尔/按钮——折叠状态唯一来源是 ctx.sidebarCollapsed
 * （titlebar 统一控制 workspaceStore.sidebarCollapsed → SheetLayout 注入 ctx）。
 * 观察点：.browser-sheet 的 browser-sidebar-collapsed 类直连 ctx.sidebarCollapsed，
 * 且不存在独立折叠按钮（browser-sidebar-toggle）。
 *
 * #515：自 React 测试逐用例移植为 Solid 实体原生测试（断言集不缩减）。改写点：
 * - React `rerender` → ctx 信号翻转（类切换仍同步可断言——Solid class 写入同步）；
 * - 左列工具项原为 React 岛（岛挂载在微任务落地），批7 起 BrowserSidebar 已是 Solid
 *   实体直连（同步渲染），waitFor 断言保留不改（语义等价、断言集不缩减）。
 */
import { createSignal } from 'solid-js'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@solidjs/testing-library'
import BrowserSheetView from '../BrowserSheetView.solid'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'

// jsdom 无原生 ResizeObserver：BrowserSheetView 挂载即建 observer，测试垫片即可
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock(vi.fn())
})
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

const sheet: SheetRecord = {
  id: 'browser-1',
  kind: 'browser',
  title: 'Browser',
  createdAt: 0,
  lastFocusedAt: 0,
}

function makeCtx(sidebarCollapsed: boolean): SheetContext {
  return {
    openSheet: vi.fn(),
    focusSheet: vi.fn(),
    closeSheet: vi.fn(),
    activeSession: null,
    selectSession: vi.fn(),
    openProfileEdit: vi.fn(),
    openSessionSettings: vi.fn(),
    sidebarCollapsed,
    rightInset: 0,
    sessionSource: () => 'ws-a',
    sessionBySource: () => undefined,
  }
}

describe('I09-A-FE-02 Browser 单一折叠状态（ctx.sidebarCollapsed）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('展开态：.browser-sheet 无 browser-sidebar-collapsed 类', () => {
    const [ctx] = createSignal<SheetContext>(makeCtx(false))
    const { container } = render(() => <BrowserSheetView sheet={sheet} ctx={ctx()} />)
    const root = container.querySelector('.browser-sheet')
    expect(root).toBeTruthy()
    expect(root!.classList.contains('browser-sidebar-collapsed')).toBe(false)
  })

  it('折叠态：消费 ctx.sidebarCollapsed=true → browser-sidebar-collapsed 类', () => {
    const [ctx] = createSignal<SheetContext>(makeCtx(true))
    const { container } = render(() => <BrowserSheetView sheet={sheet} ctx={ctx()} />)
    const root = container.querySelector('.browser-sheet')
    expect(root!.classList.contains('browser-sidebar-collapsed')).toBe(true)
  })

  it('无独立折叠按钮（titlebar 统一控制，禁止 browser-sidebar-toggle）', () => {
    const [ctx] = createSignal<SheetContext>(makeCtx(false))
    const { container } = render(() => <BrowserSheetView sheet={sheet} ctx={ctx()} />)
    expect(container.querySelector('.browser-sidebar-toggle')).toBeNull()
  })

  it('响应式：ctx.sidebarCollapsed 变化后类即时翻转（单一状态源）', () => {
    const [ctx, setCtx] = createSignal<SheetContext>(makeCtx(false))
    const { container } = render(() => <BrowserSheetView sheet={sheet} ctx={ctx()} />)
    const root = container.querySelector('.browser-sheet')!
    expect(root.classList.contains('browser-sidebar-collapsed')).toBe(false)
    setCtx(makeCtx(true))
    expect(root.classList.contains('browser-sidebar-collapsed')).toBe(true)
    setCtx(makeCtx(false))
    expect(root.classList.contains('browser-sidebar-collapsed')).toBe(false)
  })
})

describe('Browser 工具栏在展开/折叠态保持可用（Agent/历史/书签/下载/控制台）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('展开态：label 与标题/note 正常渲染，工具不是 disabled 占位', async () => {
    const [ctx] = createSignal<SheetContext>(makeCtx(false))
    const { container } = render(() => <BrowserSheetView sheet={sheet} ctx={ctx()} />)
    await waitFor(() => expect(container.querySelectorAll('.browser-tool-item')).toHaveLength(5))
    expect(container.querySelector('.browser-sidebar-title')).toBeTruthy()
    expect(container.querySelector('.browser-sidebar-note')).toBeTruthy()
    const items = container.querySelectorAll('.browser-tool-item')
    items.forEach(item => {
      expect(item.querySelector('span')).toBeTruthy()
      expect(item.querySelector('.browser-tool-unavailable')).toBeNull()
      expect(item.querySelector('svg')).toBeTruthy()
      expect((item as HTMLButtonElement).disabled).toBe(false)
    })
  })

  it('折叠态：不渲染 label 文字，只保留图标；aria-label/title 保留', async () => {
    const [ctx] = createSignal<SheetContext>(makeCtx(true))
    const { container } = render(() => <BrowserSheetView sheet={sheet} ctx={ctx()} />)
    await waitFor(() => expect(container.querySelectorAll('.browser-tool-item')).toHaveLength(5))
    await waitFor(() => {
      expect(container.querySelector('.browser-tool-unavailable')).toBeNull()
      expect(container.querySelector('.browser-sidebar-title')).toBeNull()
      expect(container.querySelector('.browser-sidebar-note')).toBeNull()
    })
    const items = container.querySelectorAll('.browser-tool-item')
    expect(items.length).toBe(5)
    items.forEach(item => {
      // 仅剩图标：无文字节点（label/unavailable 都不渲染），svg 仍在
      expect(item.querySelector('svg')).toBeTruthy()
      expect(item.textContent).toBe('')
      expect(item.querySelector('.browser-tool-unavailable')).toBeNull()
    })
    // 工具的可访问名仍由 aria-label/title 承担（首位工具为 issue #82 新增的 Agent）
    const firstTool = items[0] as HTMLButtonElement
    expect(firstTool.disabled).toBe(false)
    expect(firstTool.getAttribute('aria-label')).toBe('Agent')
    expect(firstTool.title).toBe('Agent')
  })

  it('往返：展开→折叠→展开后文字恢复渲染', async () => {
    const [ctx, setCtx] = createSignal<SheetContext>(makeCtx(false))
    const { container } = render(() => <BrowserSheetView sheet={sheet} ctx={ctx()} />)
    await waitFor(() => expect(container.querySelectorAll('.browser-tool-item')).toHaveLength(5))
    expect(container.querySelectorAll('.browser-tool-item')[0]!.querySelector('.browser-tool-unavailable')).toBeNull()

    setCtx(makeCtx(true))
    await waitFor(() => expect(container.querySelector('.browser-tool-unavailable')).toBeNull())
    await waitFor(() => expect((container.querySelectorAll('.browser-tool-item')[0]).textContent).toBe(''))

    setCtx(makeCtx(false))
    await waitFor(() => {
      expect(container.querySelector('.browser-tool-unavailable')).toBeNull()
      expect(container.querySelector('.browser-sidebar-title')).toBeTruthy()
    })
  })
})
