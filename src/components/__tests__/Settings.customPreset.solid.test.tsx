// @vitest-environment jsdom
/** @jsxImportSource solid-js */
// #515 改写点登记（迁移自 Settings.customPreset.test.tsx，React RTL → Solid）：
// - RTL 导入改 @solidjs/testing-library；补显式 afterEach(cleanup)（solid 不入 RTL 全局清理）。
// - AgentRuntimePanel 的 vi.mock 工厂内 JSX 改 createElement（React 岛只认 React 元素）。
// - 点击后的 status/alert 断言包 vi.waitFor：solid 的 DOM 更新是微任务异步（原 React act
//   同步提交）；store 状态断言（同步写）保持同步。断言语义不变、集合不缩减。
import { cleanup, fireEvent, screen, within } from '@solidjs/testing-library'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../test/fakeInvoke'
import { mountSettingsSheet } from '../../test/settingsSheetHarness.solid'
import { useStore } from '../../domains/theme/themeStore.ts'
import { useCustomPresetStore } from '../../domains/theme/customPresetStore.ts'
import { resetStores } from '../../test/resetStores.ts'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({ default: () => createElement('div') }))

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
/** 未注册命令 resolve undefined——预设状态断言不关心后台 invoke 返回值 */
class TolerantFakeInvoke extends FakeInvoke {
  override invoke(cmd: string, args?: unknown): Promise<unknown> {
    return super.invoke(cmd, args).catch((error: unknown) => {
      if (error instanceof Error && error.message.startsWith('Command not found')) return undefined
      throw error
    })
  }
}

const fakeInvoke = new TolerantFakeInvoke()
invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)

describe('Settings custom preset controls', () => {
  beforeEach(() => {
    resetStores()
    useCustomPresetStore.setState({
      customPresets: [{
        id: 'custom-existing', name: '我的预设', theme: { chatFontSize: 13 }, createdAt: 1, updatedAt: 1,
      }],
    })
  })

  afterEach(async () => {
    cleanup()
  })

  it('shows an explicit success status when overwrite completes', async () => {
    mountSettingsSheet()
    const row = screen.getByText('我的预设').closest('.set-custom-preset') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '覆盖' }))

    await vi.waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('自定义预设已覆盖')
    })
    expect(useCustomPresetStore.getState().customPresets[0].updatedAt).toBeGreaterThan(1)
  })

  it('shows an explicit applied status when a custom preset chip is clicked', async () => {
    mountSettingsSheet()
    const row = screen.getByText('我的预设').closest('.set-custom-preset') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '我的预设' }))

    await expect(screen.findByRole('status')).resolves.toHaveTextContent('自定义预设已应用')
    expect(useStore.getState().chatFontSize).toBe(13)
  })

  it('shows the failed provider when a custom preset transaction rolls back', async () => {
    useCustomPresetStore.setState({
      applyCustomPreset: vi.fn(async () => ({
        status: 'failed' as const, id: 'custom-existing', failedProvider: 'builtin.renderer-settings',
        message: '拒绝覆盖', rolledBack: true, revision: 2,
      })),
    } as never)
    mountSettingsSheet()
    const row = screen.getByText('我的预设').closest('.set-custom-preset') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '我的预设' }))

    await expect(screen.findByRole('alert')).resolves.toHaveTextContent('builtin.renderer-settings')
  })

  it('keeps a capture failure visible and reports it to the runtime error channel', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    useCustomPresetStore.setState({
      saveCustomPreset: () => { throw new Error('capture failed') },
    } as never)
    try {
      mountSettingsSheet()
      const row = screen.getByText('我的预设').closest('.set-custom-preset') as HTMLElement
      fireEvent.click(within(row).getByRole('button', { name: '覆盖' }))
      await vi.waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('覆盖已有自定义预设失败：capture failed')
      })
      expect(report).toHaveBeenCalled()
    } finally {
      report.mockRestore()
    }
  })
})
