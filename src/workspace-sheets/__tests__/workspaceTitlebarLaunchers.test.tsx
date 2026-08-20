// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceTitlebar from '../WorkspaceTitlebar'
import { resetStores } from '../../test/resetStores'

const baseProps = {
  sheets: [],
  activeSheetId: null,
  activeAgent: 'peri',
  sidebarCollapsed: true,
  sidebarEnabled: false,
  canReopenSheet: false,
  onToggleSidebar: vi.fn(),
  onFocusSheet: vi.fn(),
  onCloseSheet: vi.fn(),
  menuActions: { onTogglePin: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseRight: vi.fn(), onReopen: vi.fn() },
  onOpenSheet: vi.fn(),
  onReopenSheet: vi.fn(),
  onToggleRightPanel: vi.fn(),
  onToggleSettings: vi.fn(),
  onMinimize: vi.fn(),
  onToggleFullscreen: vi.fn(),
  onCloseWindow: vi.fn(),
}

describe('WorkspaceTitlebar Sheet 导航入口', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    vi.clearAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('打开入口只打开 Registry Launcher，不再暴露硬编码 Runtime 动作', () => {
    render(<WorkspaceTitlebar {...baseProps} />)
    fireEvent.click(screen.getByRole('button', { name: '打开 Sheet' }))
    expect(baseProps.onOpenSheet).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /调试|Runtime/ })).toBeNull()
  })

  it('最近关闭项存在时恢复按钮调用 reopen，否则禁用', () => {
    const { rerender } = render(<WorkspaceTitlebar {...baseProps} />)
    expect(screen.getByRole('button', { name: '没有最近关闭的 Sheet' })).toBeDisabled()

    rerender(<WorkspaceTitlebar {...baseProps} canReopenSheet />)
    const reopen = screen.getByRole('button', { name: '重新打开最近关闭的 Sheet' })
    expect(reopen).not.toBeDisabled()
    fireEvent.click(reopen)
    expect(baseProps.onReopenSheet).toHaveBeenCalledOnce()
  })
})
