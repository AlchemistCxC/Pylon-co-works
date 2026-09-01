// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Settings from '../Settings.tsx'
import { useStore } from '../../store.ts'
import { resetStores } from '../../test/resetStores.ts'

vi.mock('../settings/AgentRuntimePanel.tsx', () => ({ default: () => <div /> }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))

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
    render(<Settings />)
    const row = screen.getByText('我的预设').closest('.set-custom-preset') as HTMLElement
    fireEvent.click(within(row).getByRole('button', { name: '覆盖' }))

    expect(screen.getByRole('status')).toHaveTextContent('自定义预设已覆盖')
    expect(useStore.getState().customPresets[0].updatedAt).toBeGreaterThan(1)
  })

  it('keeps a capture failure visible and reports it to the runtime error channel', () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    useStore.setState({
      saveCustomPreset: () => { throw new Error('capture failed') },
    } as never)
    try {
      render(<Settings />)
      const row = screen.getByText('我的预设').closest('.set-custom-preset') as HTMLElement
      fireEvent.click(within(row).getByRole('button', { name: '覆盖' }))
      expect(screen.getByRole('alert')).toHaveTextContent('覆盖自定义预设失败：capture failed')
      expect(report).toHaveBeenCalled()
    } finally {
      report.mockRestore()
    }
  })
})
