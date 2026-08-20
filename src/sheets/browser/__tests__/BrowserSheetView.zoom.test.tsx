// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import BrowserSheetView from '../BrowserSheetView'

vi.mock('../../../infrastructure/tauri/env.ts', () => ({
  IS_TAURI: true,
  hasTauriRuntime: () => true,
}))

const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)

const sheet: SheetRecord = {
  id: 'browser-zoom',
  kind: 'browser',
  title: 'Browser',
  createdAt: 0,
  lastFocusedAt: 0,
}

const ctx: SheetContext = {
  openSheet: vi.fn(),
  focusSheet: vi.fn(),
  closeSheet: vi.fn(),
  activeSession: null,
  selectSession: vi.fn(),
  openProfileEdit: vi.fn(),
  openSessionSettings: vi.fn(),
  sidebarCollapsed: false,
  rightInset: 0,
  ccEditMode: false,
  sessionSource: () => null,
  sessionBySource: () => undefined,
}

describe('Browser 页面缩放', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation((cmd: string, args?: { zoomPercent?: number }) => {
      if (cmd === 'browser_status') {
        return Promise.resolve({ instanceId: 1, phase: 'ready', url: 'https://example.com', title: '', zoomPercent: 90 })
      }
      if (cmd === 'browser_set_zoom') {
        return Promise.resolve({ instanceId: 1, phase: 'ready', url: 'https://example.com', title: '', zoomPercent: args?.zoomPercent })
      }
      if (cmd === 'browser_set_bounds' || cmd === 'browser_close') return Promise.resolve({})
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`))
    })
  })

  it('默认 90%，设置范围 50–200%，并把用户值发送到原生 WebView', async () => {
    render(<BrowserSheetView sheet={sheet} ctx={ctx} />)

    const toggle = await screen.findByRole('button', { name: '页面缩放，当前 90%' })
    fireEvent.click(toggle)

    const range = screen.getByRole('slider', { name: '页面缩放' }) as HTMLInputElement
    expect(range.min).toBe('50')
    expect(range.max).toBe('200')
    expect(range.step).toBe('10')
    expect(range.value).toBe('90')

    fireEvent.change(range, { target: { value: '120' } })
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('browser_set_zoom', { zoomPercent: 120 })
      expect(screen.getByRole('button', { name: '页面缩放，当前 120%' })).toBeTruthy()
    })
  })
})
