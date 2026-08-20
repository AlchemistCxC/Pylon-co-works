// @vitest-environment jsdom
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

const sheet: SheetRecord = { id: 'browser-tabs', kind: 'browser', title: 'Browser', createdAt: 0, lastFocusedAt: 0 }
const ctx: SheetContext = {
  openSheet: vi.fn(), focusSheet: vi.fn(), closeSheet: vi.fn(), activeSession: null,
  selectSession: vi.fn(), openProfileEdit: vi.fn(), openSessionSettings: vi.fn(),
  sidebarCollapsed: false, rightInset: 0, ccEditMode: false,
  sessionSource: () => null, sessionBySource: () => undefined,
}

const firstTab = { id: 1, url: 'https://example.com', title: 'Example Domain' }
const secondTab = { id: 2, url: 'https://www.iana.org/help/example-domains', title: 'IANA Help' }
type TestBrowserTab = { id: number; url: string; title: string | null }
const snapshot = (activeTabId: number | null, tabs: TestBrowserTab[] = [firstTab, secondTab]) => {
  const active = tabs.find(tab => tab.id === activeTabId)
  return {
    instanceId: active?.id ?? 0,
    phase: active ? 'ready' : 'idle',
    url: active?.url ?? null,
    title: active?.title ?? null,
    error: null,
    zoomPercent: 90,
    activeTabId,
    tabs,
  }
}

let serverTabs: TestBrowserTab[] = [firstTab, secondTab]
let serverActiveTabId: number | null = 1

describe('Browser 内部多标签', () => {
  beforeEach(() => {
    serverTabs = [firstTab, secondTab]
    serverActiveTabId = 1
    invokeMock.mockReset()
    invokeMock.mockImplementation((cmd: string, args?: { tabId?: number }) => {
      if (cmd === 'browser_status') return Promise.resolve(snapshot(serverActiveTabId, serverTabs))
      if (cmd === 'browser_select_tab') {
        serverActiveTabId = args?.tabId ?? serverActiveTabId
        return Promise.resolve(snapshot(serverActiveTabId, serverTabs))
      }
      if (cmd === 'browser_close_tab') {
        serverTabs = serverTabs.filter(tab => tab.id !== args?.tabId)
        if (serverActiveTabId === args?.tabId) serverActiveTabId = serverTabs.at(-1)?.id ?? null
        return Promise.resolve(snapshot(serverActiveTabId, serverTabs))
      }
      if (cmd === 'browser_new_tab') {
        serverTabs = [...serverTabs, { id: 3, url: 'about:blank', title: null }]
        serverActiveTabId = 3
        return Promise.resolve(snapshot(serverActiveTabId, serverTabs))
      }
      if (cmd === 'browser_set_bounds' || cmd === 'browser_close') return Promise.resolve({})
      return Promise.reject(new Error(`unexpected invoke: ${cmd}`))
    })
  })

  it('在 Browser 视图内切换、新建和关闭标签；关闭最后标签回空态', async () => {
    render(<BrowserSheetView sheet={sheet} ctx={ctx} />)

    expect(await screen.findByRole('tab', { name: 'Example Domain' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('tab', { name: 'IANA Help' }))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('browser_select_tab', { tabId: 2 })
      expect(screen.getByRole('textbox', { name: '网址' })).toHaveValue(secondTab.url)
    })

    fireEvent.click(screen.getByRole('button', { name: '关闭 IANA Help' }))
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'IANA Help' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '新建浏览器标签' }))
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('browser_new_tab', undefined)
      expect(screen.getByRole('tab', { name: '新标签' })).toHaveAttribute('aria-selected', 'true')
    })

    fireEvent.click(screen.getByRole('button', { name: '关闭 新标签' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Example Domain' })).toHaveAttribute('aria-selected', 'true'))
    fireEvent.click(screen.getByRole('button', { name: '关闭 Example Domain' }))
    await waitFor(() => {
      expect(screen.queryByRole('tablist', { name: '浏览器标签' })).toBeNull()
      expect(screen.getByRole('button', { name: '新建标签' })).toBeTruthy()
    })
  })
})
