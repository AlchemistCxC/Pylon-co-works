// @vitest-environment jsdom
/**
 * I09-A-FE-02（L2：Browser 单一折叠状态，6.10 问题 #4）：
 * Browser 消除独立折叠布尔/按钮——折叠状态唯一来源是 ctx.sidebarCollapsed
 * （titlebar 统一控制 workspaceStore.sidebarCollapsed → SheetLayout 注入 ctx）。
 * 观察点：.browser-sheet 的 browser-sidebar-collapsed 类直连 ctx.sidebarCollapsed，
 * 且不存在独立折叠按钮（browser-sidebar-toggle）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import BrowserSheetView from '../BrowserSheetView'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'

// jsdom 无原生 ResizeObserver：BrowserSheetView 挂载即建 observer，测试垫片即可
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
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
    ccEditMode: false,
    sessionSource: () => 'ws-a',
    sessionBySource: () => undefined,
  }
}

describe('I09-A-FE-02 Browser 单一折叠状态（ctx.sidebarCollapsed）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('展开态：.browser-sheet 无 browser-sidebar-collapsed 类', () => {
    const { container } = render(<BrowserSheetView sheet={sheet} ctx={makeCtx(false)} />)
    const root = container.querySelector('.browser-sheet')
    expect(root).toBeTruthy()
    expect(root!.classList.contains('browser-sidebar-collapsed')).toBe(false)
  })

  it('折叠态：消费 ctx.sidebarCollapsed=true → browser-sidebar-collapsed 类', () => {
    const { container } = render(<BrowserSheetView sheet={sheet} ctx={makeCtx(true)} />)
    const root = container.querySelector('.browser-sheet')
    expect(root!.classList.contains('browser-sidebar-collapsed')).toBe(true)
  })

  it('无独立折叠按钮（titlebar 统一控制，禁止 browser-sidebar-toggle）', () => {
    const { container } = render(<BrowserSheetView sheet={sheet} ctx={makeCtx(false)} />)
    expect(container.querySelector('.browser-sidebar-toggle')).toBeNull()
  })

  it('响应式：ctx.sidebarCollapsed 变化后类即时翻转（单一状态源）', () => {
    const { container, rerender } = render(<BrowserSheetView sheet={sheet} ctx={makeCtx(false)} />)
    const root = container.querySelector('.browser-sheet')!
    expect(root.classList.contains('browser-sidebar-collapsed')).toBe(false)
    rerender(<BrowserSheetView sheet={sheet} ctx={makeCtx(true)} />)
    expect(root.classList.contains('browser-sidebar-collapsed')).toBe(true)
    rerender(<BrowserSheetView sheet={sheet} ctx={makeCtx(false)} />)
    expect(root.classList.contains('browser-sidebar-collapsed')).toBe(false)
  })
})

describe('ISSUE-10 Browser 折叠态不泄漏文字/unavailable（T10-1 DOM 语义）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('展开态：label 与 unavailable 文字正常渲染，标题/note 存在', () => {
    const { container } = render(<BrowserSheetView sheet={sheet} ctx={makeCtx(false)} />)
    const items = container.querySelectorAll('.browser-tool-item')
    expect(items.length).toBe(4)
    expect(container.querySelector('.browser-sidebar-title')).toBeTruthy()
    expect(container.querySelector('.browser-sidebar-note')).toBeTruthy()
    items.forEach(item => {
      expect(item.querySelector('span')).toBeTruthy()
      expect(item.querySelector('.browser-tool-unavailable')).toBeTruthy()
      expect(item.querySelector('svg')).toBeTruthy()
    })
  })

  it('折叠态：不渲染 label/unavailable 文字，只保留图标；aria-label/title 保留', () => {
    const { container } = render(<BrowserSheetView sheet={sheet} ctx={makeCtx(true)} />)
    const items = container.querySelectorAll('.browser-tool-item')
    expect(items.length).toBe(4)
    expect(container.querySelector('.browser-tool-unavailable')).toBeNull()
    expect(container.querySelector('.browser-sidebar-title')).toBeNull()
    expect(container.querySelector('.browser-sidebar-note')).toBeNull()
    items.forEach(item => {
      // 仅剩图标：无文字节点（label/unavailable 都不渲染），svg 仍在
      expect(item.querySelector('svg')).toBeTruthy()
      expect(item.textContent).toBe('')
      expect(item.querySelector('.browser-tool-unavailable')).toBeNull()
    })
    // disabled tool 的可访问名仍由 aria-label/title 承担
    const history = container.querySelectorAll('.browser-tool-item')[0] as HTMLButtonElement
    expect(history.disabled).toBe(true)
    expect(history.getAttribute('aria-label')).toBe('历史（未实现）')
    expect(history.title).toBe('历史（未实现）')
  })

  it('往返：展开→折叠→展开后文字恢复渲染', () => {
    const { container, rerender } = render(<BrowserSheetView sheet={sheet} ctx={makeCtx(false)} />)
    const first = container.querySelectorAll('.browser-tool-item')[0]
    expect(first!.querySelector('.browser-tool-unavailable')).toBeTruthy()

    rerender(<BrowserSheetView sheet={sheet} ctx={makeCtx(true)} />)
    expect(container.querySelector('.browser-tool-unavailable')).toBeNull()
    expect((container.querySelectorAll('.browser-tool-item')[0]).textContent).toBe('')

    rerender(<BrowserSheetView sheet={sheet} ctx={makeCtx(false)} />)
    expect(container.querySelector('.browser-tool-unavailable')).toBeTruthy()
    expect(container.querySelector('.browser-sidebar-title')).toBeTruthy()
  })
})
