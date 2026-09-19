// @vitest-environment jsdom
import { fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeInvoke } from '../../test/fakeInvoke'
import { mountSettingsSheet } from '../../test/settingsSheetHarness'
import { useStore } from '../../store.ts'
import { resetStores } from '../../test/resetStores.ts'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({ default: () => <div /> }))

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
    useStore.setState({
      customPresets: [{
        id: 'custom-existing', name: '我的预设', theme: { chatFontSize: 13 }, createdAt: 1, updatedAt: 1,
      }],
    })
  })

  it('shows an explicit success status when overwrite completes', () => {
    mountSettingsSheet()
    const row = screen.getByText('我的预设').closest('.set-custom-preset') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '覆盖' }))

    expect(screen.getByRole('status')).toHaveTextContent('自定义预设已覆盖')
    expect(useStore.getState().customPresets[0].updatedAt).toBeGreaterThan(1)
  })

  it('shows an explicit applied status when a custom preset chip is clicked', async () => {
    mountSettingsSheet()
    const row = screen.getByText('我的预设').closest('.set-custom-preset') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '我的预设' }))

    await expect(screen.findByRole('status')).resolves.toHaveTextContent('自定义预设已应用')
    expect(useStore.getState().chatFontSize).toBe(13)
  })

  it('shows the failed provider when a custom preset transaction rolls back', async () => {
    useStore.setState({
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

  it('keeps a capture failure visible and reports it to the runtime error channel', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    useStore.setState({
      saveCustomPreset: () => { throw new Error('capture failed') },
    } as never)
    try {
      mountSettingsSheet()
      const row = screen.getByText('我的预设').closest('.set-custom-preset') as HTMLElement
      fireEvent.click(within(row).getByRole('button', { name: '覆盖' }))
      expect(screen.getByRole('alert')).toHaveTextContent('覆盖自定义预设失败：capture failed')
      expect(report).toHaveBeenCalled()
    } finally {
      report.mockRestore()
    }
  })
})
