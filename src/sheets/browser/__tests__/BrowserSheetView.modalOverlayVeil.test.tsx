// @vitest-environment jsdom
/**
 * #309：模态覆盖层（启动器/权限请求等）打开期间，原生子 WebView 必须让位
 * （browser_set_visible false），关闭后恢复 true——否则覆盖层上的按钮被原生页面
 * 吃掉点击。可见性判定 = isSheetActive && !modalOverlayOpen。
 */
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import BrowserSheetView from '../BrowserSheetView'
import { FakeInvoke } from '../../../test/fakeInvoke'
import { useModalOverlayStore } from '../../../app/modalOverlayStore'

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

const sheet: SheetRecord = { id: 'browser-veil', kind: 'browser', title: 'Browser', createdAt: 0, lastFocusedAt: 0 }
const ctx: SheetContext = {
  openSheet: vi.fn(), focusSheet: vi.fn(), closeSheet: vi.fn(), activeSession: null,
  selectSession: vi.fn(), openProfileEdit: vi.fn(), openSessionSettings: vi.fn(),
  sidebarCollapsed: false, rightInset: 0, ccEditMode: false, isActive: true,
  sessionSource: () => null, sessionBySource: () => undefined,
}

function readyStatus(): unknown {
  return {
    instanceId: 1, phase: 'ready', url: 'https://example.com', title: 'Example', zoomPercent: 90,
    activeTabId: 1, tabs: [{ id: 1, url: 'https://example.com', title: 'Example' }],
  }
}

describe('#309 模态覆盖层期间原生子视图让位', () => {
  let fakeInvoke: FakeInvoke

  beforeEach(() => {
    fakeInvoke = new FakeInvoke()
    invokeRef.current = (cmd, args) => fakeInvoke.invoke(cmd, args)
    fakeInvoke.registerMany({
      browser_status: () => Promise.resolve(readyStatus()),
      browser_set_visible: () => Promise.resolve(readyStatus()),
      browser_set_bounds: () => Promise.resolve({}),
      browser_close: () => Promise.resolve({}),
    })
    useModalOverlayStore.setState({ openKeys: new Set<string>() })
  })

  function visibleCalls(): unknown[] {
    return fakeInvoke.calls.filter(call => call.cmd === 'browser_set_visible').map(call => (call.args as { visible?: unknown }).visible)
  }

  it('覆盖层打开 → setVisible(false)；关闭 → setVisible(true)', async () => {
    act(() => { useModalOverlayStore.getState().setOverlayOpen('sheet-launcher', true) })
    render(<BrowserSheetView sheet={sheet} ctx={ctx} />)

    await waitFor(() => expect(visibleCalls()).not.toHaveLength(0))
    expect(visibleCalls().at(-1)).toBe(false)

    act(() => { useModalOverlayStore.getState().setOverlayOpen('sheet-launcher', false) })
    await waitFor(() => expect(visibleCalls().at(-1)).toBe(true))
  })

  it('非活动 Sheet（isActive=false）依旧隐藏，不受覆盖层影响', async () => {
    act(() => { useModalOverlayStore.getState().setOverlayOpen('sheet-launcher', false) })
    const { rerender } = render(<BrowserSheetView sheet={sheet} ctx={{ ...ctx, isActive: false }} />)
    await waitFor(() => expect(visibleCalls()).not.toHaveLength(0))
    expect(visibleCalls().at(-1)).toBe(false)

    act(() => { useModalOverlayStore.getState().setOverlayOpen('sheet-launcher', true) })
    rerender(<BrowserSheetView sheet={sheet} ctx={{ ...ctx, isActive: false }} />)
    await waitFor(() => expect(visibleCalls().at(-1)).toBe(false))
  })
})
