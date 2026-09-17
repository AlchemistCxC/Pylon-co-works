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

  it('active Sheet 无侧栏 → 折叠按钮禁用（保留位置，不忽隐忽现）', () => {
    const onToggle = renderTitlebar(false, false)
    const button = toggleButton()
    expect(button).not.toBeNull()
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', '当前 Sheet 无侧栏')
    expect(document.querySelector('.workspace-titlebar')).toHaveClass('sidebar-disabled')
    expect(screen.queryByLabelText('Agent 状态')).toBeNull()
    fireEvent.click(button!)
    expect(onToggle).not.toHaveBeenCalled()
  })

  it('折叠按钮在最左、三灯在其右，且**不在**右侧应用控制簇内（三菜单与窗口控制位置不受影响）', () => {
    renderTitlebar(true, false)
    const button = toggleButton()
    expect(button).not.toBeNull()
    const cell = button!.closest('.workspace-titlebar-sidebar')
    expect(cell).not.toBeNull()
    // 顺序：按钮是左格首个元素，三灯紧随其右。
    expect(cell!.firstElementChild).toBe(button)
    expect(button!.nextElementSibling).toHaveClass('workspace-titlebar-brand')
    expect(button!.closest('.workspace-window-app-controls')).toBeNull()
    expect(button!.closest('.workspace-window-controls')).toBeNull()
    expect(button!.closest('.workspace-titlebar-workspace')).toBeNull()

    // 应用控制簇里仍然只有三个菜单触发（外加插件贡献），不得混入折叠按钮。
    const appControls = document.querySelector('.workspace-window-app-controls')!
    expect(appControls.querySelectorAll('[data-sidebar-toggle="true"]').length).toBe(0)
    expect([...appControls.querySelectorAll('[data-menu-trigger]')].map(b => b.getAttribute('data-menu-trigger')))
      .toEqual(['right-panel', 'interface', 'settings'])

    // 窗口控制三按钮照旧存在且顺序不变。
    const nativeControls = document.querySelector('.workspace-window-native-controls')!
    expect([...nativeControls.querySelectorAll('button')].map(b => b.getAttribute('aria-label')))
      .toEqual(['最小化', '最大化或还原', '关闭窗口'])
  })

  it('折叠态按钮仍在左格首位（位置折叠前后不变），三灯隐藏', () => {
    renderTitlebar(true, true)
    const button = toggleButton()
    // 左格折叠时收窄到按钮宽度而不是归零，所以按钮仍在原位、可点。
    expect(button).not.toBeNull()
    expect(button!.closest('.workspace-titlebar-sidebar')).not.toBeNull()
    expect(button!.closest('.workspace-titlebar-sidebar')!.firstElementChild).toBe(button)
    expect(button).not.toBeDisabled()
    expect(screen.getByRole('button', { name: '展开左栏' })).toBe(button)
    // 折叠后三灯不显示。
    expect(document.querySelector('.workspace-titlebar-brand')).toBeNull()
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
