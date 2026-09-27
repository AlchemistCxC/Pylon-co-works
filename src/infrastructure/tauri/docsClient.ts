/**
 * docsClient — 文档 Sheet typed client（#371）。
 *
 * 离线文档站 Sheet 的 command/payload 收口；与 browserClient 同型但面窄：
 * 单 WebView、固定入口，无标签/缩放/Agent 操作。
 */
import { ClientTransport } from '../acp/agentClient'

/** Native Docs WebView bounds. 与 BrowserBounds 同形；独立声明避免跨域耦合。 */
export interface DocsSheetBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DocsSheetSnapshot {
  phase: 'idle' | 'starting' | 'ready' | 'error'
  error?: string | null
  visible: boolean
}

export function createDocsClient(transport: ClientTransport) {
  return {
    status: (): Promise<unknown> => transport.invoke('docs_sheet_status'),
    start: (bounds: DocsSheetBounds): Promise<unknown> => transport.invoke('docs_sheet_start', { bounds }),
    setBounds: (bounds: DocsSheetBounds): Promise<unknown> => transport.invoke('docs_sheet_set_bounds', { bounds }),
    setVisible: (visible: boolean): Promise<unknown> => transport.invoke('docs_sheet_set_visible', { visible }),
    back: (): Promise<unknown> => transport.invoke('docs_sheet_back'),
    forward: (): Promise<unknown> => transport.invoke('docs_sheet_forward'),
    reload: (): Promise<unknown> => transport.invoke('docs_sheet_reload'),
    home: (): Promise<unknown> => transport.invoke('docs_sheet_home'),
    close: (): Promise<unknown> => transport.invoke('docs_sheet_close'),
  }
}

export type DocsClient = ReturnType<typeof createDocsClient>
