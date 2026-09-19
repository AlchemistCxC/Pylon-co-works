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
import { FakeInvoke } from '../../../test/fakeInvoke'

vi.mock('../../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: true, hasTauriRuntime: () => true }))

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd, args) => invokeRef.current!(cmd, args))
})
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
  let fakeInvoke: FakeInvoke

  beforeEach(() => {
    fakeInvoke = new FakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
  })

  it('coalesces concurrent panel-triggered snapshot calls', async () => {
    let releaseSnapshot: ((value: unknown) => void) | undefined
    const snapshotPromise = new Promise(resolve => { releaseSnapshot = resolve })
    fakeInvoke.registerMany({
      browser_status: () => Promise.resolve({
        instanceId: 1, phase: 'ready', url: 'https://example.com', title: 'Example', zoomPercent: 90,
        activeTabId: 1, tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }],
      }),
      browser_snapshot: () => snapshotPromise,
      browser_set_bounds: () => Promise.resolve({}),
      browser_close: () => Promise.resolve({}),
    })

    render(<BrowserSheetView sheet={sheet} ctx={ctx} />)
    await screen.findByRole('button', { name: '下载' })

    fireEvent.click(screen.getByRole('button', { name: '下载' }))
    fireEvent.click(screen.getByRole('button', { name: '控制台' }))

    await waitFor(() => expect(fakeInvoke.calls.filter(call => call.cmd === 'browser_snapshot')).toHaveLength(1))
    releaseSnapshot?.({ url: 'https://example.com', text: 'ok', links: [] })
    await waitFor(() => expect(fakeInvoke.calls.filter(call => call.cmd === 'browser_snapshot')).toHaveLength(1))
  })
})

