// @vitest-environment jsdom
/**
 * I09-A-FE-01（AC-1 / 方案 B，ISSUE-09.md）：无 sidebar 的 Sheet 不生成可操作折叠按钮。
 * WorkspaceTitlebar 接收 active Sheet 的 sidebar capability（sidebarEnabled）；
 * 有侧栏才启用折叠按钮，无侧栏禁用（titlebar 第一列仍固定 42px 控制区）。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceTitlebar from '../WorkspaceTitlebar'
import { resetStores } from '../../test/resetStores'
import type { SheetRecord } from '../sheetTypes'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const sheets: SheetRecord[] = []

function renderTitlebar(sidebarEnabled: boolean, sidebarCollapsed = false, onToggleSidebar = vi.fn()) {
  render(
    <WorkspaceTitlebar
      sheets={sheets}
      activeSheetId={null}
      activeAgent="peri"
      sidebarCollapsed={sidebarCollapsed}
      sidebarEnabled={sidebarEnabled}
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
      onOpenRuntime={vi.fn()}
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
    fireEvent.click(button)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('已折叠且有侧栏 → 按钮标注展开', () => {
    renderTitlebar(true, true)
    expect(screen.getByRole('button', { name: '展开左栏' })).not.toBeDisabled()
  })
})
