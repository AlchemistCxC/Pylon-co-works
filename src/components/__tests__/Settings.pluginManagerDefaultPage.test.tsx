// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from '../Settings.tsx'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({
  default: () => <div data-testid="agent-runtime-panel">runtime onboarding</div>,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))

/**
 * P53：插件管理默认页——管理器插件贡献存在时，「插件管理」分区渲染包页面
 * （PluginSettingsPageHost），贡献不存在时回落宿主基础页（含能力授权卡）。
 */

describe('plugin manager default page (P53)', () => {
  // grant store 落真实 localStorage：每个用例前清空，避免上一用例授权"复活"
  beforeEach(() => { localStorage.clear() })
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
    // 运行时/registry 是模块级单例：卸载管理器实例，避免跨用例贡献泄漏
    const composition = await import('../../plugin-runtime/pluginCompositionRoot.ts')
    const runtime = composition.getPluginRuntime()
    for (const instance of runtime.snapshot().instances.filter(
      item => item.identity.pluginId === 'builtin.pylon-plugin-manager',
    )) {
      await runtime.deactivate(instance.identity.key)
    }
  })

  it('renders the manager package page when its contribution exists', async () => {
    const grants = await import('../../plugin-runtime/management/pluginManagementWiring.ts')
    grants.resetPluginCapabilityGrantStoreForTests()
    grants.getPluginCapabilityGrantStore().grant('builtin.pylon-plugin-manager', 'plugin.management', {
      pluginVersion: '1.0.0',
      apiVersion: '1.2',
    })
    // 经 kernelBootstrap.startNormal 发布真实 bootstrap 状态（非 compositionRoot 直调）
    const { kernelBootstrap } = await import('../../kernel/kernelBootstrapServices.ts')
    await kernelBootstrap.startNormal()

    render(<Settings initialDomain="plugins" />)
    // 管理器贡献页渲染（heading 来自注册 label，不含"增强"）
    const heading = await screen.findByRole('heading', { name: '插件管理器', level: 3 })
    expect(heading).toBeInTheDocument()
    // 面板区块存在（aria-label 挂在 DOM 面板 overview 区；宿主基础页的授权卡不在默认页里）
    await vi.waitFor(() => {
      expect(screen.getByLabelText('插件概览')).toBeInTheDocument()
    })
    expect(screen.queryByText('能力授权')).not.toBeInTheDocument()
    grants.resetPluginCapabilityGrantStoreForTests()
  })

  it('falls back to the host page with the consent card when the package is not activated', async () => {
    const grants = await import('../../plugin-runtime/management/pluginManagementWiring.ts')
    grants.resetPluginCapabilityGrantStoreForTests()
    // 不授权 → 管理器包进 capability-consent → 贡献不存在 → 回落宿主页
    localStorage.clear()
    const { kernelBootstrap } = await import('../../kernel/kernelBootstrapServices.ts')
    await kernelBootstrap.startNormal()

    render(<Settings initialDomain="plugins" />)
    // 宿主基础页可见（API 文案）；管理器包页面未渲染（无 data-plugin-manager-page 标记）。
    // 能力授权卡的渲染断言由 PluginManager.test.tsx 授权卡用例覆盖（mock bootstrap 注入）。
    expect(await screen.findByText(/Pylon Plugin API/)).toBeInTheDocument()
    expect(document.querySelector('[data-plugin-manager-page]')).toBeNull()
    grants.resetPluginCapabilityGrantStoreForTests()
  })
})
