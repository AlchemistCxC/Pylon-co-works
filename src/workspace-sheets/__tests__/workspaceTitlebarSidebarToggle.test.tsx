// @vitest-environment jsdom
/**
 * I09-A-FE-01（AC-1 / 方案 B）：无 sidebar 的 Sheet 不生成可操作折叠按钮。
 * #154（统一侧栏模型）改写：判据从「按 sidebarMode 给按钮 disabled」收紧为
 * 「按注册表是否真的提供 sidebar 组件决定按钮是否存在」，且按钮**移到右侧应用
 * 控制簇**——折叠后左轨道为 0 宽，按钮若留在左格会随轨道一起消失，用户将无法
 * 再展开。断言强度不降：原「禁用 + 不发事件」改为「不存在 + 恰好没有该按钮」，
 * 并新增按钮归属簇与 aria-expanded 的断言。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceTitlebar from '../WorkspaceTitlebar'
import { resetStores } from '../../test/resetStores'
import type { SheetRecord } from '../sheetTypes'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const sheets: SheetRecord[] = []

function renderTitlebar(sidebarEnabled: boolean, sidebarCollapsed = false, onToggleSidebar = vi.fn(), rightPanelEnabled = true) {
  render(
    <WorkspaceTitlebar
      sheets={sheets}
      activeSheetId={null}
      activeAgent="peri"
      sidebarCollapsed={sidebarCollapsed}
      sidebarEnabled={sidebarEnabled}
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

const toggleButton = () => document.querySelector<HTMLButtonElement>('[data-sidebar-toggle="true"]')

describe('I09-A-FE-01 / #154 titlebar 折叠按钮 capability', () => {
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

  it('active Sheet 无侧栏 → 完全不生成折叠按钮（不是禁用）', () => {
    const onToggle = renderTitlebar(false, false)
    expect(toggleButton()).toBeNull()
    expect(screen.queryByRole('button', { name: '当前 Sheet 无侧栏' })).toBeNull()
    expect(document.querySelector('.workspace-titlebar')).toHaveClass('sidebar-disabled')
    expect(screen.queryByLabelText('Agent 状态')).toBeNull()
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('#154：按钮位于右侧应用控制簇，不随左轨道折叠而消失', () => {
    renderTitlebar(true, true)
    const button = toggleButton()
    // 折叠态没有左轨道，按钮必须仍然可点——否则用户无法再展开。
    expect(button).not.toBeNull()
    expect(button!.closest('.workspace-window-app-controls')).not.toBeNull()
    expect(button!.closest('.workspace-titlebar-sidebar')).toBeNull()
    expect(button).not.toBeDisabled()
  })

  it('已折叠且有侧栏 → 按钮标注展开，且状态灯一并隐藏', () => {
    renderTitlebar(true, true)
    const button = screen.getByRole('button', { name: '展开左栏' })
    expect(button).not.toBeDisabled()
    expect(button).toHaveAttribute('aria-expanded', 'false')
    expect(button.closest('.workspace-titlebar')).toHaveClass('sidebar-collapsed')
    // #154：折叠后状态灯不显示（左格不参与布局）。
    expect(button.closest('.workspace-titlebar')?.querySelector('.workspace-titlebar-brand')).toBeNull()
  })

  it('展开且有侧栏 → 状态灯可见、aria-expanded 为真', () => {
    renderTitlebar(true, false)
    const button = screen.getByRole('button', { name: '收起左栏' })
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(button.closest('.workspace-titlebar')).toHaveClass('sidebar-expanded')
    expect(button.closest('.workspace-titlebar')?.querySelector('.workspace-titlebar-brand')).not.toBeNull()
  })

  it('Agent 展开和折叠复用同一个折叠按钮节点', () => {
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
    const { rerender } = render(<WorkspaceTitlebar {...props} sidebarCollapsed={false} />)
    const expandedButton = screen.getByRole('button', { name: '收起左栏' })
    rerender(<WorkspaceTitlebar {...props} sidebarCollapsed />)
    expect(screen.getByRole('button', { name: '展开左栏' })).toBe(expandedButton)
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
    const button = screen.getByRole('button', { name: '右侧栏' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', '当前没有可用右侧栏')
    fireEvent.click(button)
    expect(onToggleRightPanel).not.toHaveBeenCalled()
  })
})
