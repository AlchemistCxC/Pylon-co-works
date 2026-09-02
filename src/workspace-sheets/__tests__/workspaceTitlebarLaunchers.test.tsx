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
  onOpenSettingsDomain: vi.fn(),
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

  it('右上角菜单入口提供互斥的 VS Code 式 menu 语义与稳定锚点', () => {
    render(<WorkspaceTitlebar {...baseProps} />)
    const settings = screen.getByRole('button', { name: '设置' })
    const interfaceMode = screen.getByRole('button', { name: '界面模式' })

    expect(settings).toHaveAttribute('aria-haspopup', 'menu')
    expect(settings).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(settings)
    const settingsMenu = screen.getByRole('menu')
    expect(settingsMenu).toHaveAttribute('data-menu-kind', 'settings')
    expect(settings).toHaveAttribute('aria-expanded', 'true')
    expect(settings).toHaveAttribute('aria-controls', settingsMenu.id)

    fireEvent.click(interfaceMode)
    const interfaceMenu = screen.getByRole('menu')
    expect(interfaceMenu).toHaveAttribute('data-menu-kind', 'interface')
    expect(settings).toHaveAttribute('aria-expanded', 'false')
    expect(interfaceMode).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(interfaceMenu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(interfaceMode).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(interfaceMode)
  })

  it('菜单项点击或外部关闭后焦点回到对应触发按钮', () => {
    render(<WorkspaceTitlebar {...baseProps} />)
    const settings = screen.getByRole('button', { name: '设置' })

    fireEvent.click(settings)
    const menuItem = screen.getByRole('menuitem', { name: '外观' })
    fireEvent.click(menuItem)
    expect(baseProps.onOpenSettingsDomain).toHaveBeenCalledWith('appearance')
    expect(document.activeElement).toBe(settings)

    fireEvent.click(settings)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(settings)
  })

  it('设置菜单在设置页打开时仍可切换顶层域', () => {
    const onOpenSettingsDomain = vi.fn()
    render(<WorkspaceTitlebar {...baseProps} settingsOpen onOpenSettingsDomain={onOpenSettingsDomain} />)
    const settings = screen.getByRole('button', { name: '设置' })
    fireEvent.click(settings)
    fireEvent.click(screen.getByRole('menuitem', { name: '插件' }))
    expect(onOpenSettingsDomain).toHaveBeenCalledWith('plugins')
    expect(document.activeElement).toBe(settings)
  })
})
