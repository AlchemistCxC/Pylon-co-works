/**
 * browserClient — 浏览器域 typed client（报告阶段 4 / FE-AUD-008）。
 *
 * Browser Sheet 与 Agent 控制面的 command/payload 收口。
 */
import { ClientTransport } from '../acp/agentClient'

/** Native Browser WebView bounds.  The Tauri command receives this value under
 * the `bounds` argument; keeping the wrapper in this client prevents call sites
 * from accidentally sending a flat object that the Rust command cannot bind. */
export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export function createBrowserClient(transport: ClientTransport) {
  return {
    status: (): Promise<unknown> => transport.invoke('browser_status'),
    start: (bounds: BrowserBounds): Promise<unknown> => transport.invoke('browser_start', { bounds }),
    newTab: (): Promise<unknown> => transport.invoke('browser_new_tab'),
    openTab: (url: string): Promise<unknown> => transport.invoke('browser_open_tab', { url }),
    selectTab: (tabId: number): Promise<unknown> => transport.invoke('browser_select_tab', { tabId }),
    closeTab: (tabId: number): Promise<unknown> => transport.invoke('browser_close_tab', { tabId }),
    navigate: (url: string): Promise<unknown> => transport.invoke('browser_navigate', { url }),
    back: (): Promise<unknown> => transport.invoke('browser_back'),
    forward: (): Promise<unknown> => transport.invoke('browser_forward'),
    reload: (): Promise<unknown> => transport.invoke('browser_reload'),
    snapshot: (): Promise<unknown> => transport.invoke('browser_snapshot'),
    /** Explicit user/agent download action; URL is validated again by the host. */
    download: (url: string, filename?: string): Promise<unknown> => transport.invoke('browser_download', { url, ...(filename ? { filename } : {}) }),
    click: (input: { selector?: string, text?: string }): Promise<unknown> => transport.invoke('browser_click', input),
    type: (input: { text: string, selector?: string }): Promise<unknown> => transport.invoke('browser_type', input),
    press: (key: string): Promise<unknown> => transport.invoke('browser_press', { key }),
    scroll: (input: { deltaX?: number, deltaY?: number } = {}): Promise<unknown> => transport.invoke('browser_scroll', {
      ...(input.deltaX !== undefined ? { deltaX: input.deltaX } : {}),
      ...(input.deltaY !== undefined ? { deltaY: input.deltaY } : {}),
    }),
    setZoom: (zoomPercent: number): Promise<unknown> => transport.invoke('browser_set_zoom', { zoomPercent }),
    setBounds: (bounds: BrowserBounds): Promise<unknown> => transport.invoke('browser_set_bounds', { bounds }),
    setVisible: (visible: boolean): Promise<unknown> => transport.invoke('browser_set_visible', { visible }),
    close: (): Promise<unknown> => transport.invoke('browser_close'),
  }
}

export type BrowserClient = ReturnType<typeof createBrowserClient>
