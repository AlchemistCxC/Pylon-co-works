// @vitest-environment jsdom
/**
 * I09-A-FE-02（L2：File 单一折叠状态）+ #154 改写。
 *
 * 旧契约：「折叠唯一来源 ctx.sidebarCollapsed」，观察点是 `.file-sidebar` 上的
 * collapsed 类。那仍然是「Sheet 自持左栏几何」——折叠宽度、边框、可见性都写在
 * Sheet 自己的类里，于是标题栏的分割线与左列的分割线各画一条、各自漂移。
 *
 * 新契约：几何（宽度 / 竖直分割线 / 折叠可见性）全部归布局层，File 的左栏只挂
 * 共享几何类 `.sidebar`，**不再参与折叠状态**。本文件因此断言：
 *  - 左栏挂 `.sidebar`（宽度唯一来自 --sheet-sidebar-track-width）；
 *  - 左栏没有属于自己的 collapsed / hidden 类，也没有独立收起按钮；
 *  - ctx.sidebarCollapsed 变化**不再**改变左栏类集合（它与折叠已解耦）。
 * 折叠态的可见性由 `.layout[data-sidebar="collapsed"]` 保证，逐格验证在
 * `src/workspace-sheets/__tests__/sheetLayoutSidebarCollapsedReactive.test.tsx`
 * 与 `sidebarUnifiedModel.css.test.ts`。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '../../../plugin-runtime/testing/productPluginTestBootstrap.ts'
import { render } from '@testing-library/react'
import FileSheetView from '../FileSheetView'
import { useWorkspaceStore } from '../../../workspaceStore'
import { resetStores } from '../../../test/resetStores'
import { createSheetState } from '../../../workspace-sheets/sheetState'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../../../components/chat/codeHighlight', () => ({ highlightCode: vi.fn().mockResolvedValue(null) }))

const sheet: SheetRecord = {
  id: 'file-1',
  kind: 'file',
  title: '文件',
  singletonKey: 'file:ws-a',
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

function renderHarness(sidebarCollapsed: boolean) {
  useWorkspaceStore.setState({ workspaceSheets: createSheetState([sheet], 'file-1') })
  return render(<FileSheetView sheet={sheet} ctx={makeCtx(sidebarCollapsed)} />)
}

describe('I09-A-FE-02 / #154 File 左栏单一几何来源', () => {
  beforeEach(() => {
    resetStores()
    localStorage.clear()
    invoke.mockReset()
    invoke.mockImplementation((cmd: string, args: { source?: string; relativePath?: string } | undefined) => {
      if (cmd === 'list_workspace_entries') return Promise.resolve([])
      if (cmd === 'read_workspace_text') return Promise.resolve({ relativePath: args?.relativePath ?? '', content: 'const x = 1', bytesRead: 12, totalBytes: 12, truncated: false })
      return Promise.reject(new Error(`unexpected invoke ${cmd}`))
    })
  })

  it('左栏挂共享几何类 .sidebar，无 collapsed / hidden 类，无独立收起按钮', () => {
    const { container } = renderHarness(false)
    const sidebar = container.querySelector('.file-sidebar') as HTMLElement
    expect(sidebar).toBeTruthy()
    expect(sidebar).toHaveClass('sidebar')
    expect(sidebar.classList.contains('collapsed')).toBe(false)
    expect(sidebar.classList.contains('hidden')).toBe(false)
    expect(container.querySelector('.file-sidebar-close')).toBeNull()
  })

  it('折叠态：左栏仍在 DOM 且类集合不变——可见性归布局层，不归本 Sheet', () => {
    const { container } = renderHarness(true)
    const sidebar = container.querySelector('.file-sidebar') as HTMLElement
    expect(sidebar).toBeTruthy()
    expect(sidebar.classList.contains('collapsed')).toBe(false)
    expect(sidebar.classList.contains('hidden')).toBe(false)
  })

  it('ctx.sidebarCollapsed 变化不再改变左栏类集合（与折叠解耦，单一几何来源）', () => {
    useWorkspaceStore.setState({ workspaceSheets: createSheetState([sheet], 'file-1') })
    const { container, rerender } = render(<FileSheetView sheet={sheet} ctx={makeCtx(false)} />)
    const sidebar = container.querySelector('.file-sidebar') as HTMLElement
    const expandedClasses = sidebar.className
    rerender(<FileSheetView sheet={sheet} ctx={makeCtx(true)} />)
    expect(sidebar.className).toBe(expandedClasses)
    rerender(<FileSheetView sheet={sheet} ctx={makeCtx(false)} />)
    expect(sidebar.className).toBe(expandedClasses)
  })
})
