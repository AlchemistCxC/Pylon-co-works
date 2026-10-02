// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #515 改写点登记（迁移自 Settings.a11y.test.tsx，React RTL → Solid）：
// - RTL 导入改 @solidjs/testing-library（screen 经其再导出）；显式 afterEach(cleanup)。
// - AgentRuntimePanel 的 vi.mock 工厂内 JSX 改 createElement（React 岛只认 React 元素，
//   本文件 JSX 经 solid 编译，不能进岛）；DOM 契约逐字段不变。
// - 点击后的 aria-expanded 断言包 vi.waitFor：solid 的 DOM 更新是微任务异步
//   （原 React act 同步提交），断言语义不变。
import { cleanup, fireEvent } from '@solidjs/testing-library'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSettingsSheet } from '../../test/settingsSheetHarness.solid'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({
  default: () => createElement('div', { 'data-testid': 'agent-runtime-panel' }, 'runtime onboarding'),
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock(async () => null)
})

// 下沉自 scripts/test-accessibility.mts（P91 A2）：宿主设置分区标题必须是真按钮
// （div + onClick 读屏不可达）。原契约只限 Settings.tsx 宿主文件——插件包页面
// （PluginManager/ConsentCard）的静态 div 标题不在该契约内，故渲染宿主外观域断言。
describe('Settings 宿主分区标题与导航的可访问性', () => {
  afterEach(async () => {
    cleanup()
  })

  it('外观域的 set-group-title 全部是 button 且点击可切换折叠', async () => {
    const { kernelBootstrap } = await import('../../kernel/kernelBootstrapServices.ts')
    await kernelBootstrap.startNormal()
    mountSettingsSheet({ domain: 'appearance' })
    await vi.waitFor(() => {
      const titles = document.querySelectorAll<HTMLButtonElement>('.set-group-title')
      expect(titles.length).toBeGreaterThan(0)
      for (const title of titles) {
        expect(title.tagName).toBe('BUTTON')
        expect(title.getAttribute('aria-expanded')).not.toBeNull()
      }
    })
    // 行为锁：真按钮点击才切换折叠（div 假交互在此会红）
    const first = document.querySelector<HTMLButtonElement>('.set-group-title')!
    const before = first.getAttribute('aria-expanded')
    fireEvent.click(first)
    await vi.waitFor(() => {
      expect(first.getAttribute('aria-expanded')).toBe(before === 'true' ? 'false' : 'true')
    })
  })

  it('设置分区导航是可聚焦的 button', async () => {
    const { kernelBootstrap } = await import('../../kernel/kernelBootstrapServices.ts')
    await kernelBootstrap.startNormal()
    mountSettingsSheet({ domain: 'appearance' })
    await vi.waitFor(() => {
      const navButtons = document.querySelectorAll<HTMLElement>('[class*="set-nav-btn"]')
      expect(navButtons.length).toBeGreaterThan(0)
      for (const button of navButtons) {
        expect(button.tagName).toBe('BUTTON')
        expect(button.tabIndex).toBeGreaterThanOrEqual(0)
      }
    })
  })
})
