// @vitest-environment jsdom
import { fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSettingsSheet } from '../../test/settingsSheetHarness'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({
  default: () => <div data-testid="agent-runtime-panel">runtime onboarding</div>,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))

// 下沉自 scripts/test-accessibility.mts（P91 A2）：宿主设置分区标题必须是真按钮
// （div + onClick 读屏不可达）。原契约只限 Settings.tsx 宿主文件——插件包页面
// （PluginManager/ConsentCard）的静态 div 标题不在该契约内，故渲染宿主外观域断言。
describe('Settings 宿主分区标题与导航的可访问性', () => {
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react')
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
    expect(first.getAttribute('aria-expanded')).toBe(before === 'true' ? 'false' : 'true')
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
