// @vitest-environment jsdom
/**
 * I09-A-FE-02（L2：File 单一折叠状态，6.10 问题 #4）：
 * File 消除双层状态（本地 collapsed + ctx.sidebarCollapsed 当 hidden）——
 * 折叠唯一来源 ctx.sidebarCollapsed（titlebar 统一控制），不再出现 hidden 类，
 * 不再有独立收起按钮（file-sidebar-close）。
 * 观察点：.file-sidebar 的 collapsed 类直连 ctx.sidebarCollapsed。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '../../../plugin-runtime/pluginCompositionRoot'
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

describe('I09-A-FE-02 File 单一折叠状态（消除双层状态）', () => {
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

  it('展开态：.file-sidebar 无 collapsed / 无 hidden 类，无独立收起按钮', () => {
    const { container } = renderHarness(false)
    const sidebar = container.querySelector('.file-sidebar') as HTMLElement
    expect(sidebar).toBeTruthy()
    expect(sidebar.classList.contains('collapsed')).toBe(false)
    expect(sidebar.classList.contains('hidden')).toBe(false)
    expect(container.querySelector('.file-sidebar-close')).toBeNull()
  })

  it('折叠态：ctx.sidebarCollapsed=true → collapsed 类（保留 42px 功能图标栏），无 hidden', () => {
    const { container } = renderHarness(true)
    const sidebar = container.querySelector('.file-sidebar') as HTMLElement
    expect(sidebar.classList.contains('collapsed')).toBe(true)
    expect(sidebar.classList.contains('hidden')).toBe(false)
  })

  it('响应式：ctx.sidebarCollapsed 变化后 collapsed 类即时翻转（单一状态源）', () => {
    useWorkspaceStore.setState({ workspaceSheets: createSheetState([sheet], 'file-1') })
    const { container, rerender } = render(<FileSheetView sheet={sheet} ctx={makeCtx(false)} />)
    const sidebar = container.querySelector('.file-sidebar') as HTMLElement
    expect(sidebar.classList.contains('collapsed')).toBe(false)
    rerender(<FileSheetView sheet={sheet} ctx={makeCtx(true)} />)
    expect(sidebar.classList.contains('collapsed')).toBe(true)
    rerender(<FileSheetView sheet={sheet} ctx={makeCtx(false)} />)
    expect(sidebar.classList.contains('collapsed')).toBe(false)
  })
})
