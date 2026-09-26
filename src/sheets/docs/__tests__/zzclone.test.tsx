// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const { invokeRef } = vi.hoisted(() => ({
  invokeRef: { current: null as null | ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) },
}))
vi.mock('@tauri-apps/api/core', async () => {
  const { tauriCoreMock } = await import('../../../test-utils/tauriCoreMock')
  return tauriCoreMock((cmd: string, args?: Record<string, unknown>) => invokeRef.current!(cmd, args))
})
vi.mock('../../../infrastructure/tauri/env.ts', () => ({ IS_TAURI: true, hasTauriRuntime: () => true }))

import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import DocsSheetView from '../DocsSheetView'
import { FakeInvoke } from '../../../test/fakeInvoke'

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver)

const sheet: SheetRecord = { id: 'docs-1', kind: 'docs', title: '文档', createdAt: 0, lastFocusedAt: 0 }
const ctx: SheetContext = {
  openSheet: vi.fn(), focusSheet: vi.fn(), closeSheet: vi.fn(), activeSession: null,
  selectSession: vi.fn(), openProfileEdit: vi.fn(), openSessionSettings: vi.fn(),
  sidebarCollapsed: false, rightInset: 0, ccEditMode: false, isActive: true,
  sessionSource: () => null, sessionBySource: () => undefined,
}

describe('morph probe', () => {
  let fakeInvoke: FakeInvoke
  beforeEach(() => {
    fakeInvoke = new FakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
    fakeInvoke.registerMany({
      docs_sheet_status: () => Promise.resolve({ phase: 'idle', error: null, visible: true }),
      docs_sheet_start: () => Promise.resolve({ phase: 'ready', error: null, visible: true }),
      docs_sheet_set_bounds: () => Promise.resolve({}),
      docs_sheet_set_visible: () => Promise.resolve({ phase: 'ready', error: null, visible: true }),
      docs_sheet_close: () => Promise.resolve({ phase: 'idle', error: null, visible: true }),
    })
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
  })

  it('component invokes start', async () => {
    render(<DocsSheetView sheet={sheet} ctx={ctx} />)
    await waitFor(() => expect(fakeInvoke.calls.length).toBeGreaterThanOrEqual(1))
  })
})
