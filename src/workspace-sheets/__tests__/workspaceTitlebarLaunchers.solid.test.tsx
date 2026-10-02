// @vitest-environment jsdom
/** @jsxImportSource solid-js */
/**
 * WorkspaceTitlebar Sheet 导航入口（右栏折叠钮语义 / Launcher 唯一入口 / 齿轮菜单三段 /
 * VS Code 式 menu 语义 / 焦点归还 / #195 不锁标题栏）。
 *
 * #515：迁移自 workspaceTitlebarLaunchers.test.tsx（React RTL → @solidjs/testing-library，
 * 实体直连 WorkspaceTitlebar.solid.tsx）。改写点登记：
 * - 实体 props 形态是 `latest: () => WorkspaceTitlebarProps` 访问器隧道（照 App.solid.tsx
 *   用法）：`render(() => <WorkspaceTitlebar latest={() => props} />)`；
 * - 补显式 `afterEach(cleanup)`（vitest globals 未开）；
 * - `within` 从 @solidjs/testing-library 取（@testing-library/dom 同名再导出）；
 * - DOM/aria/几何断言逐字保留（data-right-rail-toggle、data-menu-trigger、
 *   data-menu-kind、.workspace-titlebar-launchers 按钮清单、aria-expanded/controls、
 *   焦点归还）。
 */
import { cleanup, fireEvent, render, screen, within } from '@solidjs/testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkspaceTitlebar from '../WorkspaceTitlebar.solid.tsx'
import type { WorkspaceTitlebarProps } from '../WorkspaceTitlebar.solid.tsx'
import { resetStores } from '../../test/resetStores'
import { getCommandRegistry, getContextPanelRegistry, getTitlebarRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { createPluginIdentity } from '../../plugin-runtime/pluginIdentity.ts'
import { useRightRailStore } from '../../domains/workspace/layoutRailsStore.ts'

afterEach(cleanup)

const baseProps: WorkspaceTitlebarProps = {
  sheets: [],
  activeSheetId: null,
  activeAgent: 'peri',
  sidebarCollapsed: true,
  sidebarEnabled: false,
  onToggleSidebar: vi.fn(),
  onFocusSheet: vi.fn(),
  onCloseSheet: vi.fn(),
  menuActions: { onTogglePin: vi.fn(), onClose: vi.fn(), onCloseOthers: vi.fn(), onCloseRight: vi.fn(), onReopen: vi.fn() },
  onOpenSheet: vi.fn(),
  onToggleRightPanel: vi.fn(),
  onOpenSettingsDomain: vi.fn(),
  onMinimize: vi.fn(),
  onToggleFullscreen: vi.fn(),
  onCloseWindow: vi.fn(),
}

function renderTitlebar(props: WorkspaceTitlebarProps): void {
  render(() => <WorkspaceTitlebar latest={() => props} />)
}

const gear = () => screen.getByRole('button', { name: '界面与设置' })
const railToggle = () => document.querySelector<HTMLButtonElement>('[data-right-rail-toggle="true"]')!

describe('WorkspaceTitlebar Sheet 导航入口', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStores()
    vi.clearAllMocks()
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('#52 右栏按钮只负责折叠：点它切换 collapsed，面板类型不在这里选', () => {
    const registration = getContextPanelRegistry().register(createPluginIdentity('test.issue52', 'run'), {
      id: 'test.context', label: '上下文', scope: 'global', renderKind: 'first-party-react', component: () => null,
    })
    try {
      useRightRailStore.setState({ activePanelId: 'test.context', collapsed: true })
      renderTitlebar(baseProps)
      expect(railToggle()).toHaveAttribute('aria-label', '展开右侧栏')
      expect(railToggle()).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(railToggle())
      expect(baseProps.onToggleRightPanel).toHaveBeenCalledOnce()
      // 类型切换的入口只有一个：右栏内部（`.context-panel-tabs`）。标题栏不再有面板列表。
      fireEvent.click(gear())
      expect(screen.queryByRole('menuitemradio', { name: '上下文' })).toBeNull()
    } finally {
      registration.dispose()
    }
  })

  it('无可用右栏贡献时右栏按钮禁用', () => {
    renderTitlebar(baseProps)
    expect(railToggle()).toBeDisabled()
  })

  it('打开入口只打开 Registry Launcher，不再暴露硬编码 Runtime 动作', () => {
    renderTitlebar(baseProps)
    fireEvent.click(screen.getByRole('button', { name: '打开 Sheet' }))
    expect(baseProps.onOpenSheet).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: /调试|Runtime/ })).toBeNull()
  })

  it('「重新打开最近关闭的 Sheet」按钮与启动器分隔线都已删除，能力留在页签右键菜单与命令里', () => {
    renderTitlebar(baseProps)
    expect(screen.queryByRole('button', { name: /最近关闭的 Sheet/ })).toBeNull()
    const launchers = document.querySelector('.workspace-titlebar-launchers')!
    expect([...launchers.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))).toEqual(['打开 Sheet'])
    expect(launchers.querySelector('.workspace-launcher-separator')).toBeNull()
  })

  it('右簇只剩一个齿轮菜单触发与一个右栏折叠按钮', () => {
    renderTitlebar(baseProps)
    expect([...document.querySelectorAll('[data-menu-trigger]')].map(node => node.getAttribute('data-menu-trigger'))).toEqual(['app-menu'])
    expect(document.querySelectorAll('[data-right-rail-toggle="true"]').length).toBe(1)
    expect(gear()).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('齿轮菜单一次含三段：界面模式（radio）、设置域（跳转）、插件项（命令）', () => {
    const command = vi.fn()
    const owner = createPluginIdentity('test.menu', 'run')
    const commandHandle = getCommandRegistry().register(owner, {
      id: 'test.menu.ping', name: 'test.menu.ping', description: 'ping', priority: 0, execute: command,
    })
    const itemHandle = getTitlebarRegistry().register(owner, {
      id: 'test.menu.item', slot: 'app-menu', renderKind: 'command', label: '插件动作', commandId: 'test.menu.ping',
    }, { contributionId: 'test.menu.item', priority: 0 })
    try {
      renderTitlebar(baseProps)
      fireEvent.click(gear())
      const menu = screen.getByRole('menu')
      expect(menu).toHaveAttribute('data-menu-kind', 'app-menu')
      // 三段的分段标题都在（界面模式的 radio 项由界面模式注册表提供，单测里可能为空）。
      expect(within(menu).getByText('界面模式')).toBeTruthy()
      expect([...menu.querySelectorAll('.workspace-menu-subheading')].map(node => node.textContent)).toEqual(['设置', '插件'])
      expect(within(menu).getByRole('menuitem', { name: '外观' })).toBeTruthy()
      const pluginItem = within(menu).getByRole('menuitem', { name: '插件动作' })
      expect(pluginItem).toHaveAttribute('data-menu-command', 'test.menu.ping')
      fireEvent.click(pluginItem)
      expect(command).toHaveBeenCalledOnce()
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(gear())
    } finally {
      itemHandle.dispose()
      commandHandle.dispose()
    }
  })

  it('插件菜单项受 when 门控，为假时整项不出现', () => {
    const handle = getTitlebarRegistry().register(createPluginIdentity('test.menu.hidden', 'run'), {
      id: 'test.menu.hidden.item', slot: 'app-menu', renderKind: 'command', label: '隐藏项', commandId: 'test.menu.ping',
      when: () => false,
    }, { contributionId: 'test.menu.hidden.item', priority: 0 })
    try {
      renderTitlebar(baseProps)
      fireEvent.click(gear())
      expect(screen.queryByRole('menuitem', { name: '隐藏项' })).toBeNull()
    } finally {
      handle.dispose()
    }
  })

  it('右上角菜单入口提供互斥的 VS Code 式 menu 语义与稳定锚点', () => {
    renderTitlebar(baseProps)
    const trigger = gear()

    expect(trigger).toHaveAttribute('aria-haspopup', 'menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    expect(menu).toHaveAttribute('data-menu-kind', 'app-menu')
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(trigger).toHaveAttribute('aria-controls', menu.id)

    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    expect(document.activeElement).toBe(trigger)
  })

  it('菜单项点击或外部关闭后焦点回到对应触发按钮', () => {
    renderTitlebar(baseProps)
    const trigger = gear()

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: '外观' }))
    expect(baseProps.onOpenSettingsDomain).toHaveBeenCalledWith('appearance')
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('设置 sheet 活动时标题栏不被锁：无打开态交互锁类，齿轮菜单照常切换顶层域', () => {
    const onOpenSettingsDomain = vi.fn()
    renderTitlebar({ ...baseProps, activeSheetKind: 'settings', onOpenSettingsDomain })
    // #195：设置是普通布局 sheet，标题栏（含页签条）不再有 pointer-events 锁与锁类。
    expect(document.querySelector('.workspace-titlebar')).not.toHaveClass('titlebar-settings-open')
    const trigger = gear()
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitem', { name: '插件' }))
    expect(onOpenSettingsDomain).toHaveBeenCalledWith('plugins')
    expect(document.activeElement).toBe(trigger)
  })
})
