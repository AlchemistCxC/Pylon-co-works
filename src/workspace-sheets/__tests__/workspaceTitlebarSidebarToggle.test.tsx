// @vitest-environment jsdom
/**
 * I09-A-FE-01（AC-1 / 方案 B，ISSUE-09.md）：无 sidebar 的 Sheet 不生成可操作折叠按钮。
 * WorkspaceTitlebar 接收 active Sheet 的 sidebar capability（sidebarEnabled）；
 * workspace / sheet 两类侧栏都启用同一个按钮，无侧栏禁用。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceTitlebar from '../WorkspaceTitlebar'
import { resetStores } from '../../test/resetStores'
import type { SheetRecord } from '../sheetTypes'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const sheets: SheetRecord[] = []

function renderTitlebar(sidebarEnabled: boolean, sidebarCollapsed = false, onToggleSidebar = vi.fn(), sidebarExpandedTrack = sidebarEnabled, rightPanelEnabled = true) {
  render(
    <WorkspaceTitlebar
      sheets={sheets}
      activeSheetId={null}
      activeAgent="peri"
      sidebarCollapsed={sidebarCollapsed}
      sidebarEnabled={sidebarEnabled}
      sidebarExpandedTrack={sidebarExpandedTrack}
      rightPanelEnabled={rightPanelEnabled}
      canReopenSheet={false}
      onToggleSidebar={onToggleSidebar}
      onFocusSheet={vi.fn()}
      onCloseSheet={vi.fn()}
      menuActions={{
        onTogglePin: vi.fn(),
        onClose: vi.fn(),
        onCloseOthers: vi.fn(),
        onCloseRight: vi.fn(),
        onReopen: vi.fn(),
      }}
      onOpenSheet={vi.fn()}
      onReopenSheet={vi.fn()}
      onToggleRightPanel={vi.fn()}
      onToggleSettings={vi.fn()}
      onMinimize={vi.fn()}
      onToggleFullscreen={vi.fn()}
      onCloseWindow={vi.fn()}
    />,
  )
  return onToggleSidebar
}

describe('I09-A-FE-01 titlebar 折叠按钮 capability', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    invoke.mockReset()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('active Sheet 有侧栏 → 折叠按钮可操作，点击折叠', () => {
    const onToggle = renderTitlebar(true, false)
    const button = screen.getByRole('button', { name: '收起左栏' })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('active Sheet 无侧栏 → 折叠按钮禁用（不生成可操作按钮）', () => {
    const onToggle = renderTitlebar(false, false)
    const button = screen.getByRole('button', { name: '当前 Sheet 无侧栏' })
    expect(button).toBeDisabled()
    expect(button.closest('.workspace-titlebar')).toHaveClass('sidebar-disabled')
    expect(screen.queryByLabelText('Agent 状态')).toBeNull()
    fireEvent.click(button)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('已折叠且有侧栏 → 按钮标注展开', () => {
    renderTitlebar(true, true)
    const button = screen.getByRole('button', { name: '展开左栏' })
    expect(button).not.toBeDisabled()
    expect(button.closest('.workspace-titlebar')).toHaveClass('sidebar-expanded-track')
    expect(button.closest('.workspace-titlebar')?.querySelector('.workspace-titlebar-brand')).toBeNull()
  })

  it('Agent 展开和折叠复用同一个最左侧按钮节点', () => {
    const props = {
      sheets,
      activeSheetId: null,
      activeAgent: 'peri',
      sidebarEnabled: true,
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
    const { rerender } = render(<WorkspaceTitlebar {...props} sidebarCollapsed={false} sidebarExpandedTrack />)
    const expandedButton = screen.getByRole('button', { name: '收起左栏' })
    rerender(<WorkspaceTitlebar {...props} sidebarCollapsed sidebarExpandedTrack />)
    expect(screen.getByRole('button', { name: '展开左栏' })).toBe(expandedButton)
  })

  it('所有 Sheet 左栏展开时 TitleBar 标签都从同一完整轨道后开始', () => {
    renderTitlebar(true, false)
    const button = screen.getByRole('button', { name: '收起左栏' })
    expect(button).not.toBeDisabled()
    expect(button.closest('.workspace-titlebar')).toHaveClass('sidebar-expanded-track')
    expect(button.closest('.workspace-titlebar')?.querySelector('.workspace-titlebar-brand')).not.toBeNull()
  })

  it('active Sheet 无右栏贡献时禁用右栏按钮', () => {
    const onToggleRightPanel = vi.fn()
    render(
      <WorkspaceTitlebar
        sheets={sheets}
        activeSheetId={null}
        activeAgent="peri"
        sidebarCollapsed={false}
        sidebarEnabled={false}
        rightPanelEnabled={false}
        canReopenSheet={false}
        onToggleSidebar={vi.fn()}
        onFocusSheet={vi.fn()}
        onCloseSheet={vi.fn()}
        menuActions={{ onTogglePin: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseRight: vi.fn(), onReopen: vi.fn() }}
        onOpenSheet={vi.fn()}
        onReopenSheet={vi.fn()}
        onToggleRightPanel={onToggleRightPanel}
        onToggleSettings={vi.fn()}
        onMinimize={vi.fn()}
        onToggleFullscreen={vi.fn()}
        onCloseWindow={vi.fn()}
      />,
    )
    const button = screen.getByRole('button', { name: '当前 Sheet 无右栏' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(onToggleRightPanel).not.toHaveBeenCalled()
  })
})
