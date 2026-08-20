// @vitest-environment jsdom
/**
 * I09-A-FE-02（L2：Browser child WebView bounds 与 CSS 一致，6.10 问题 #4）：
 * 折叠状态（ctx.sidebarCollapsed）变化必须即时重同步 WebView bounds——
 * syncBounds 效果以 [syncBounds, sidebarCollapsed] 为依赖，折叠切换触发
 * browser_set_bounds 重新调用，使后端 WebView 边界与折叠后的 CSS 布局一致。
 * 本测试 mock IS_TAURI=true + ready 快照，观察 setBounds 调用次数随折叠变化递增。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import type { SheetContext, SheetRecord } from '../../../workspace-sheets/sheetTypes'
import BrowserSheetView from '../BrowserSheetView'

// 折叠变化 → bounds 重同步依赖真实 Tauri 运行时路径（IS_TAURI 守卫），故 mock env 为 Tauri
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
  id: 'browser-1',
  kind: 'browser',
  title: 'Browser',
  createdAt: 0,
  lastFocusedAt: 0,
}

function makeCtx(sidebarCollapsed: boolean): SheetContext {
  return {
    openSheet: vi.fn(),
    focusSheet: vi.fn(),
    closeSheet: vi.fn(),
    activeSession: null,
    selectSession: vi.fn(),
    openProfileEdit: vi.fn(),
    openSessionSettings: vi.fn(),
    sidebarCollapsed,
    rightInset: 0,
    ccEditMode: false,
    sessionSource: () => 'ws-a',
    sessionBySource: () => undefined,
  }
}

const setBoundsCalls = () => invokeMock.mock.calls.filter(([cmd]) => cmd === 'browser_set_bounds').length

describe('I09-A-FE-02 Browser WebView bounds 与 CSS 一致（折叠变化重同步）', () => {
  beforeEach(() => {
    // jsdom 的 getBoundingClientRect 全 0 → syncBounds 早退；垫片真实尺寸以观察 setBounds
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect)
    invokeMock.mockReset()
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'browser_status') return Promise.resolve({ instanceId: 1, phase: 'ready', url: 'https://example.com', title: '' })
      if (cmd === 'browser_set_bounds') return Promise.resolve({})
      if (cmd === 'browser_close') return Promise.resolve({})
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('展开态就绪后同步 bounds；折叠切换再次同步（setBounds 次数递增）', async () => {
    const { rerender } = render(<BrowserSheetView sheet={sheet} ctx={makeCtx(false)} />)
    // 等 browser_status → ready → syncBounds 效果触发 setBounds
    await waitFor(() => expect(setBoundsCalls()).toBeGreaterThanOrEqual(1))
    const expanded = setBoundsCalls()

    rerender(<BrowserSheetView sheet={sheet} ctx={makeCtx(true)} />)
    // 折叠变化（dep sidebarCollapsed 翻转）→ 效果重跑 → 重新 setBounds
    await waitFor(() => expect(setBoundsCalls()).toBeGreaterThan(expanded))
    const collapsed = setBoundsCalls()

    rerender(<BrowserSheetView sheet={sheet} ctx={makeCtx(false)} />)
    await waitFor(() => expect(setBoundsCalls()).toBeGreaterThan(collapsed))
  })
})
