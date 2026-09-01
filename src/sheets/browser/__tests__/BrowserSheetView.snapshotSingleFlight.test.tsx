// @vitest-environment jsdom
/**
 * Browser snapshot single-flight regression:
 * opening two tool panels in the same tick (or React StrictMode replaying an
 * effect) must share one in-flight browser_snapshot request.  A duplicate
 * cross-process snapshot is both wasteful and produces duplicate console rows.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import BrowserSheetView from '../BrowserSheetView'

vi.mock('../../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: true, hasTauriRuntime: () => true }))
const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)

const sheet: SheetRecord = { id: 'browser-snapshot', kind: 'browser', title: 'Browser', createdAt: 0, lastFocusedAt: 0 }
const ctx: SheetContext = {
  openSheet: vi.fn(), focusSheet: vi.fn(), closeSheet: vi.fn(), activeSession: null,
  selectSession: vi.fn(), openProfileEdit: vi.fn(), openSessionSettings: vi.fn(),
  sidebarCollapsed: false, rightInset: 0, ccEditMode: false,
  sessionSource: () => null, sessionBySource: () => undefined,
}

describe('Browser page snapshot single-flight', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('coalesces concurrent panel-triggered snapshot calls', async () => {
    let releaseSnapshot: ((value: unknown) => void) | undefined
    const snapshotPromise = new Promise(resolve => { releaseSnapshot = resolve })
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'browser_status') return Promise.resolve({
        instanceId: 1, phase: 'ready', url: 'https://example.com', title: 'Example', zoomPercent: 90,
        activeTabId: 1, tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }],
      })
      if (cmd === 'browser_snapshot') return snapshotPromise
      if (cmd === 'browser_set_bounds' || cmd === 'browser_close') return Promise.resolve({})
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`))
    })

    render(<BrowserSheetView sheet={sheet} ctx={ctx} />)
    await screen.findByRole('button', { name: '下载' })

    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    fireEvent.click(screen.getByRole('button', { name: '控制台' }))

    await waitFor(() => expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'browser_snapshot')).toHaveLength(1))
    releaseSnapshot?.({ url: 'https://example.com', text: 'ok', links: [] })
    await waitFor(() => expect(invokeMock.mock.calls.filter(([cmd]) => cmd === 'browser_snapshot')).toHaveLength(1))
  })
})

