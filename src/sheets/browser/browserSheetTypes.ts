/**
 * Browser Sheet 的跨子组件共享类型与展示映射（#228 批次 D 从 BrowserSheetView.tsx 纯搬移）。
 */

export interface BrowserSnapshot {
  instanceId: number
  phase: 'idle' | 'starting' | 'ready' | 'error'
  url?: string | null
  title?: string | null
  error?: string | null
  zoomPercent: number
  activeTabId: number | null
  tabs: BrowserTabSnapshot[]
  /** 原生子 WebView 当前是否可见；开发预览固定为 true。 */
  visible?: boolean
  /** browser preview only; desktop WebView snapshots omit this field. */
  runtime?: 'tauri-webview' | 'iframe-preview'
}

export interface BrowserTabSnapshot {
  id: number
  url?: string | null
  title?: string | null
}

/**
 * #116 子项 4：phase 是前端状态机枚举（BrowserSnapshot['phase']），直接插值会把
 * `ready` 这类内部值送到地址栏与左侧栏——同一条工具栏的按钮文案已是中文。
 * 仅做展示映射，`data-phase` 属性保留原枚举值供选择器与测试使用。
 */
export const BROWSER_PHASE_LABELS: Record<BrowserSnapshot['phase'], string> = {
  idle: '空闲',
  starting: '启动中',
  ready: '就绪',
  error: '异常',
}

export interface BrowserPageLink {
  index?: number
  text?: string
  href?: string
  target?: string | null
  download?: boolean
  downloadName?: string | null
}

export interface BrowserPageSnapshot {
  runtime?: string
  tabId?: number
  url?: string
  title?: string | null
  text?: string
  links?: BrowserPageLink[]
  [key: string]: unknown
}

export type BrowserToolId = 'history' | 'bookmarks' | 'downloads' | 'console' | 'agent'
