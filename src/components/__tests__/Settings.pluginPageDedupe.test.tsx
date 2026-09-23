// @vitest-environment jsdom
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSettingsSheet } from '../../test/settingsSheetHarness'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({
  default: () => <div data-testid="agent-runtime-panel">runtime onboarding</div>,
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock(async () => null)
})

/**
 * #274：设置 sheet 插件贡献页导航两条回归——
 * ① 侧栏去重：宿主托管的「插件管理器」贡献不再单列独立条目（与宿主「插件管理」分区重复）；
 * ② 导航逃逸：进入插件贡献页后，点击其它分区内容必须跟手（pluginPageId 可清除）。
 */

describe('plugin manager page navigation (#274)', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react')
    cleanup()
    const composition = await import('../../plugin-runtime/pluginCompositionRoot.ts')
    const runtime = composition.getPluginRuntime()
    for (const instance of runtime.snapshot().instances.filter(
      item => item.identity.pluginId === 'builtin.pylon-plugin-manager',
    )) {
      await runtime.deactivate(instance.identity.key)
    }
  })

  async function bootWithManagerGranted() {
    const grants = await import('../../plugin-runtime/management/pluginManagementWiring.ts')
    grants.resetPluginCapabilityGrantStoreForTests()
    grants.getPluginCapabilityGrantStore().grant('builtin.pylon-plugin-manager', 'plugin.management', {
      pluginVersion: '1.0.0',
      apiVersion: '1.2',
    })
    const { kernelBootstrap } = await import('../../kernel/kernelBootstrapServices.ts')
    await kernelBootstrap.startNormal()
    return grants
  }

  const sidebar = () => document.querySelector('aside.settings-sheet-nav')!

  it('宿主托管的贡献不在侧栏单列（去重），宿主分区条目渲染贡献页', async () => {
    const grants = await bootWithManagerGranted()
    const ui = mountSettingsSheet({ domain: 'plugins' })

    // 贡献页渲染 = 贡献已注册（宿主分区 P53 重定向生效）
    await screen.findByRole('heading', { name: '插件管理器', level: 3 })
    // 去重：贡献已注册的前提下，侧栏不得出现「插件管理器」独立条目
    const sideEntries = [...sidebar().querySelectorAll('.set-nav-btn.plugin-page')]
    expect(sideEntries.some(btn => btn.textContent?.includes('插件管理器'))).toBe(false)
    // 宿主分区条目存在，且点击它仍渲染贡献页（重定向保留）。
    // data-plugin-manager-page 的值是插件 id（builtin.pylon-plugin-manager），只断言属性存在。
    const hostEntry = [...sidebar().querySelectorAll('.set-nav-btn')].find(btn => btn.textContent?.includes('插件管理'))
    expect(hostEntry).toBeTruthy()
    fireEvent.click(hostEntry!)
    await vi.waitFor(() => {
      expect(document.querySelector('[data-plugin-manager-page]')).toBeTruthy()
    })
    expect(ui.sheetState()).toMatchObject({ domain: 'plugins', section: 'pluginManager' })
    grants.resetPluginCapabilityGrantStoreForTests()
  })

  it('点击「Hook 诊断」内容离开插件页（pluginPageId 清除，导航不再被困）', async () => {
    const grants = await bootWithManagerGranted()
    const ui = mountSettingsSheet({ domain: 'plugins' })
    await screen.findByRole('heading', { name: '插件管理器', level: 3 })
    expect(document.querySelector('[data-plugin-manager-page]')).toBeTruthy()

    const hookEntry = [...sidebar().querySelectorAll('.set-nav-btn')].find(btn => btn.textContent?.includes('Hook 诊断'))
    expect(hookEntry).toBeTruthy()
    fireEvent.click(hookEntry!)

    // 内容跟手：插件页 DOM 卸载，sheet 状态归位（pluginPageId 不残留）
    await vi.waitFor(() => {
      expect(document.querySelector('[data-plugin-manager-page]')).toBeNull()
    })
    const state = ui.sheetState() as SettingsSheetStateLike
    expect(state.section).toBe('hookDiagnostics')
    expect(state.pluginPageId ?? null).toBeNull()
    grants.resetPluginCapabilityGrantStoreForTests()
  })
})

type SettingsSheetStateLike = { section?: unknown; pluginPageId?: unknown }
