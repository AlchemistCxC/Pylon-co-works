// @vitest-environment jsdom
/**
 * Browser 页面缩放。
 * #515：自 React 测试逐用例移植为 Solid 实体原生测试（断言集不缩减）。改写点：
 * range 的 fireEvent.change → fireEvent.input（实体 onInput 契约）。
 */
import { createSignal } from 'solid-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@solidjs/testing-library'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import BrowserSheetView from '../BrowserSheetView.solid'
import { FakeInvoke } from '../../../test/fakeInvoke'

vi.mock('../../../infrastructure/tauri/env.ts', () => ({
  IS_TAURI: true,
  hasTauriRuntime: () => true,
}))

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
  sessionSource: () => null,
  sessionBySource: () => undefined,
}

let fakeInvoke: FakeInvoke

afterEach(() => cleanup())

describe('Browser 页面缩放', () => {
  beforeEach(() => {
    fakeInvoke = new FakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
    fakeInvoke.registerMany({
      browser_status: () => Promise.resolve({ instanceId: 1, phase: 'ready', url: 'https://example.com', title: '', zoomPercent: 90 }),
      browser_set_zoom: args => Promise.resolve({ instanceId: 1, phase: 'ready', url: 'https://example.com', title: '', zoomPercent: (args as { zoomPercent?: number }).zoomPercent }),
      browser_set_bounds: () => Promise.resolve({}),
      browser_close: () => Promise.resolve({}),
    })
  })

  it('默认 90%，设置范围 50–200%，并把用户值发送到原生 WebView', async () => {
    const [ctxSignal] = createSignal<SheetContext>(ctx)
    render(() => <BrowserSheetView sheet={sheet} ctx={ctxSignal()} />)

    const toggle = await screen.findByRole('button', { name: '页面缩放，当前 90%' })
    fireEvent.click(toggle)

    const range = screen.getByRole('slider', { name: '页面缩放' }) as HTMLInputElement
    expect(range.min).toBe('50')
    expect(range.max).toBe('200')
    expect(range.step).toBe('10')
    expect(range.value).toBe('90')

    // browser_status 响应跨宏任务落地（applySnapshot → phase=ready）；就绪前滑杆
    // 按语义禁用，input 会落空。等会话就绪（滑杆可用）再输入，不与时序赌运气。
    await waitFor(() => expect(range.disabled).toBe(false))
    fireEvent.input(range, { target: { value: '120' } })
    await waitFor(() => {
      expect(fakeInvoke.calls).toContainEqual({ cmd: 'browser_set_zoom', args: { zoomPercent: 120 } })
      expect(screen.getByRole('button', { name: '页面缩放，当前 120%' })).toBeTruthy()
    })
  })
})
