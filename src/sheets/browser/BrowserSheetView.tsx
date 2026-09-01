import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Bookmark, BookmarkCheck, ChevronLeft, ChevronRight, Clock3, Code2, Download, Globe2, Minus, Plus, RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import { browserReducer, createBrowserState } from '../../domains/browser/browserState.ts'
import {
  appendConsole,
  clearBrowserCollection,
  isBrowserLibraryUrl,
  loadBrowserLibrary,
  recordDownload,
  recordHistory,
  saveBrowserLibrary,
  toggleBookmark,
  type BrowserLibrary,
  type ConsoleEntry,
} from '../../domains/browser/browserLibrary.ts'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { classifyBrowserStartError } from '../../infrastructure/tauri/browserContracts.ts'
import { createBrowserClient } from '../../infrastructure/tauri/browserClient'
import { hasTauriRuntime, isBrowserMockRuntime, IS_TAURI, type TauriWindow } from '../../infrastructure/tauri/env.ts'
import { reportRuntimeError } from '../../runtimeError'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/**
 * BrowserSheetView — browser 壳（W4-03）。
 *
 * 纯状态机 idle/starting/ready/error + WebView bounds/导航控制；子 WebView 由后端创建并嵌入 viewport。
 * Sheet 卸载时调用 browser_close，确保 WebView2 子进程随 sheet 生命周期回收。
 */
interface BrowserSnapshot {
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

interface BrowserTabSnapshot {
  id: number
  url?: string | null
  title?: string | null
}

interface BrowserPageLink {
  index?: number
  text?: string
  href?: string
  target?: string | null
  download?: boolean
  downloadName?: string | null
}

interface BrowserPageSnapshot {
  runtime?: string
  tabId?: number
  url?: string
  title?: string | null
  text?: string
  links?: BrowserPageLink[]
  [key: string]: unknown
}

const DEFAULT_ZOOM_PERCENT = 90
const MIN_ZOOM_PERCENT = 50
const MAX_ZOOM_PERCENT = 200
const ZOOM_STEP = 10
type BrowserToolId = 'history' | 'bookmarks' | 'downloads' | 'console'

// Browser library tools are backed by the local library + explicit host commands.
const TOOL_ITEMS = [
  { id: 'history', label: '历史', icon: Clock3 },
  { id: 'bookmarks', label: '书签', icon: Bookmark },
  { id: 'downloads', label: '下载', icon: Download },
  { id: 'console', label: '控制台', icon: Code2 },
] as const

export default function BrowserSheetView({ ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const [state, dispatch] = useReducer(browserReducer, undefined, createBrowserState)
  // 部分旧的组件测试只 mock env.ts 的两个旧导出；保留函数存在性守卫，
  // 不让预览探测成为它们的隐式新依赖。
  const browserPreview = !IS_TAURI && typeof isBrowserMockRuntime === 'function' && isBrowserMockRuntime()
  // 浏览器 Dev Mock 在静态 import 之后安装 Tauri globals，故运行时再探测一次；
  // 原生环境仍走模块级 IS_TAURI 快路径。
  const browserRuntimeAvailable = IS_TAURI || browserPreview || (typeof window !== 'undefined' && hasTauriRuntime(window as Window & TauriWindow))
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>({ instanceId: 0, phase: 'idle', zoomPercent: DEFAULT_ZOOM_PERCENT, activeTabId: null, tabs: [], runtime: browserPreview ? 'iframe-preview' : 'tauri-webview' })
  const [zoomSettingsOpen, setZoomSettingsOpen] = useState(false)
  // I09-A-FE-02（D-01/D-08）：折叠状态唯一来源 ctx.sidebarCollapsed（titlebar 统一控制），
  // 不再维护独立折叠布尔——browser-sidebar-collapsed 类直连全局状态
  const { sidebarCollapsed } = ctx
  // 原生子 WebView 是独立于 React DOM 的窗口，父节点 display:none 不会将其隐藏。
  // SheetLayout 对 keep-alive Browser 显式传 isActive=false；旧上下文省略时按 active 处理。
  const isSheetActive = ctx.isActive !== false
  const [activeTool, setActiveTool] = useState<BrowserToolId | null>(null)
  const [address, setAddress] = useState('')
  const [library, setLibrary] = useState<BrowserLibrary>(() => loadBrowserLibrary())
  const libraryRef = useRef(library)
  libraryRef.current = library
  const [pageSnapshot, setPageSnapshot] = useState<BrowserPageSnapshot | null>(null)
  // `browser_snapshot` is an expensive cross-process call.  Tool-panel effects
  // can run more than once (React StrictMode, rapid panel changes, or a status
  // replay), so keep one in-flight request and let concurrent callers share it.
  const inspectPageInFlightRef = useRef<Promise<void> | null>(null)
  const [downloadUrlInput, setDownloadUrlInput] = useState('')
  const [consoleFilter, setConsoleFilter] = useState<'all' | ConsoleEntry['level']>('all')
  // 跨域 iframe 的页面自身导航无法被父文档读取；命令导航/刷新时递增 key，
  // 让预览重新回到 Browser 状态机记录的 URL，避免地址栏与画面脱节。
  const [previewRevision, setPreviewRevision] = useState(0)
  const viewportRef = useRef<HTMLDivElement>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  const updateLibrary = useCallback((updater: (current: BrowserLibrary) => BrowserLibrary) => {
    setLibrary(current => {
      const next = updater(current)
      libraryRef.current = next
      saveBrowserLibrary(next)
      return next
    })
  }, [])

  const logConsole = useCallback((command: string, level: ConsoleEntry['level'] = 'info', detail?: string) => {
    updateLibrary(current => appendConsole(current, { command, level, detail }))
  }, [updateLibrary])

  const recordCurrentPage = useCallback((url: string | null | undefined, title?: string | null) => {
    if (!url || url === 'about:blank' || !isBrowserLibraryUrl(url)) return
    const previous = libraryRef.current.history[0]
    // Page-load callbacks can arrive twice (URL then title).  Avoid moving an entry
    // on every duplicate callback while still refreshing a changed title.
    if (previous?.url === url && previous.title === (title?.trim() || previous.title)) return
    updateLibrary(current => recordHistory(current, { url, title: title ?? undefined }))
  }, [updateLibrary])

  const applySnapshot = useCallback((next: BrowserSnapshot) => {
    const normalized: BrowserSnapshot = {
      ...next,
      runtime: next.runtime ?? (browserPreview ? 'iframe-preview' : 'tauri-webview'),
      zoomPercent: next.zoomPercent ?? DEFAULT_ZOOM_PERCENT,
      activeTabId: next.activeTabId ?? (next.instanceId || null),
      tabs: next.tabs ?? (next.instanceId ? [{ id: next.instanceId, url: next.url, title: next.title }] : []),
      visible: next.visible ?? isSheetActive,
    }
    setSnapshot(normalized)
    if (normalized.phase === 'ready') dispatch({ type: 'started', instanceId: String(normalized.instanceId) })
    else if (normalized.phase === 'idle') dispatch({ type: 'stop' })
    else if (normalized.phase === 'error') dispatch({ type: 'failed', error: normalized.error || '浏览器启动失败' })
    else if (normalized.error) dispatch({ type: 'failed', error: normalized.error })
    setAddress(normalized.url && normalized.url !== 'about:blank' ? normalized.url : '')
    if (normalized.url && normalized.url !== 'about:blank') {
      recordCurrentPage(normalized.url, normalized.title)
    }
  }, [browserPreview, isSheetActive, recordCurrentPage])

  const syncBounds = useCallback(() => {
    const element = viewportRef.current
    if (!element || !browserRuntimeAvailable || snapshot.phase !== 'ready' || !isSheetActive) return
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    void createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }).catch(error => reportRuntimeError('调整浏览器区域', error))
  }, [browserRuntimeAvailable, isSheetActive, snapshot.phase])

  // 同步原生子 WebView 的可见性。不能用 CSS 代替：Tauri child WebView 位于
  // 宿主窗口的原生层，React 树上的 display:none 对它没有效果。
  useEffect(() => {
    // 旧的独立组件调用方没有 isActive 字段；不向它们引入一个额外的
    // 未 mock 命令，SheetLayout（生产路径）会始终提供显式布尔值。
    if (!browserRuntimeAvailable || browserPreview || typeof ctx.isActive !== 'boolean' || snapshot.phase !== 'ready') return
    void createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      .setVisible(isSheetActive)
      .catch(error => reportRuntimeError('切换浏览器可见性', error))
  }, [browserPreview, browserRuntimeAvailable, ctx.isActive, isSheetActive, snapshot.phase])

  useEffect(() => {
    if (!browserRuntimeAvailable) return
    let disposed = false
    const client = createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
    const commit = (next: BrowserSnapshot) => {
      if (!disposed) applySnapshot(next)
    }
    const startSessionIfNeeded = async (raw: BrowserSnapshot) => {
      commit(raw)
      // Browser Sheet 进入活动主区后自动建立会话；开发预览同样走真实 iframe，
      // 不再注入静态 ready 快照。没有显式活动态的旧独立调用方保持原来的手动启动语义。
      const canAutoStart = browserPreview || ctx.isActive === true
      if (canAutoStart && raw.phase === 'idle' && !disposed) {
        const rect = viewportRef.current?.getBoundingClientRect()
        try {
          const started = await client.start({
            x: Math.round(rect?.left ?? 0),
            y: Math.round(rect?.top ?? 0),
            width: Math.max(1, Math.round(rect?.width ?? 1)),
            height: Math.max(1, Math.round(rect?.height ?? 1)),
          }) as BrowserSnapshot
          setPreviewRevision(revision => revision + 1)
          commit(started)
        } catch {
          // 真实错误会由用户点击“新建标签”时再次显示；这里不让一次
          // 启动竞态阻塞整个 Sheet 的其它 chrome。
        }
      }
    }
    void client.status().then(raw => void startSessionIfNeeded(raw as BrowserSnapshot)).catch(() => {})
    const status = listen<BrowserSnapshot>('pylon:browser-status', event => commit(event.payload))
    const page = listen<{ tabId: number; active: boolean; url?: string | null; title?: string | null }>('pylon:browser-page', event => {
      if (disposed) return
      const payload = event.payload
      setSnapshot(previous => ({
        ...previous,
        ...(payload.active ? { url: payload.url, title: payload.title } : {}),
        tabs: previous.tabs.map(tab => tab.id === payload.tabId ? { ...tab, url: payload.url, title: payload.title } : tab),
      }))
      if (payload.active) {
        setAddress(payload.url && payload.url !== 'about:blank' ? payload.url : '')
        recordCurrentPage(payload.url, payload.title)
      }
    })
    return () => {
      disposed = true
      void status.then(stop => stop()).catch(() => {})
      void page.then(stop => stop()).catch(() => {})
    }
  }, [applySnapshot, browserPreview, browserRuntimeAvailable, ctx.isActive, isSheetActive, recordCurrentPage])

  useEffect(() => {
    const element = viewportRef.current
    if (!element) return
    const observer = new ResizeObserver(syncBounds)
    observer.observe(element)
    window.addEventListener('resize', syncBounds)
    syncBounds()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', syncBounds)
    }
    // I09-A-FE-02：折叠变化（ctx.sidebarCollapsed）即时重同步 WebView bounds——bounds 与 CSS 一致
  }, [syncBounds, sidebarCollapsed])

  const start = async () => {
    dispatch({ type: 'start' })
    try {
      const element = viewportRef.current
      const rect = element?.getBoundingClientRect()
      const next = await createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).start({
        x: Math.round(rect?.left ?? 0),
        y: Math.round(rect?.top ?? 0),
        width: Math.max(1, Math.round(rect?.width ?? 1)),
        height: Math.max(1, Math.round(rect?.height ?? 1)),
      }) as BrowserSnapshot
      if (browserPreview) setPreviewRevision(revision => revision + 1)
      applySnapshot(next)
    } catch (error) {
      const classified = classifyBrowserStartError(error)
      dispatch({ type: 'failed', error: classified.kind === 'blocked' ? '浏览器 WebView 命令不可用' : classified.message })
      setSnapshot(previous => ({ ...previous, phase: 'error', error: classified.kind === 'blocked' ? '浏览器 WebView 命令不可用' : classified.message }))
      if (classified.kind === 'error') reportRuntimeError('启动浏览器 WebView', error)
    }
  }

  const navigateTo = useCallback(async (rawUrl: string) => {
    const value = rawUrl.trim()
    if (!value) return
    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`
    try {
      const next = await createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).navigate(url) as BrowserSnapshot
      if (browserPreview) setPreviewRevision(revision => revision + 1)
      applySnapshot(next)
    } catch (error) {
      reportRuntimeError('浏览器导航', error)
    }
  }, [applySnapshot, browserPreview])

  const navigate = () => { void navigateTo(address) }

  const browserCommand = async (command: 'browser_back' | 'browser_forward' | 'browser_reload') => {
    try {
      const bc = createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      const next = await (command === 'browser_back' ? bc.back() : command === 'browser_forward' ? bc.forward() : bc.reload()) as BrowserSnapshot
      if (browserPreview) setPreviewRevision(revision => revision + 1)
      applySnapshot(next)
    } catch (error) {
      reportRuntimeError('浏览器操作', error)
    }
  }

  const tabCommand = useCallback(async (command: 'new' | 'select' | 'close' | 'open', tabId?: number, url?: string) => {
    try {
      const client = createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      const next = await (command === 'new'
        ? client.newTab()
        : command === 'open'
          ? client.openTab(url!)
          : command === 'select'
            ? client.selectTab(tabId!)
            : client.closeTab(tabId!)) as BrowserSnapshot
      if (browserPreview) setPreviewRevision(revision => revision + 1)
      applySnapshot(next)
    } catch (error) {
      reportRuntimeError(command === 'new' || command === 'open' ? '新建浏览器标签' : command === 'select' ? '切换浏览器标签' : '关闭浏览器标签', error)
    }
  }, [applySnapshot, browserPreview])

  // 开发代理页会把跨域页面中的链接点击通过 postMessage 交回这里；
  // 原生 Tauri WebView 则由 Rust 的初始化脚本处理同一语义。
  useEffect(() => {
    if (!browserPreview) return
    const onPreviewMessage = (event: MessageEvent<unknown>) => {
      const frame = viewportRef.current?.querySelector<HTMLIFrameElement>('.browser-preview-frame')
      if (!frame || event.source !== frame.contentWindow) return
      const payload = event.data
      if (!payload || typeof payload !== 'object') return
      const message = payload as { source?: unknown; action?: unknown; href?: unknown }
      if (message.source !== 'pylon-browser-preview' || typeof message.href !== 'string') return
      if (message.action === 'open-tab') void tabCommand('open', undefined, message.href)
      else if (message.action === 'navigate') void navigateTo(message.href)
    }
    window.addEventListener('message', onPreviewMessage)
    return () => window.removeEventListener('message', onPreviewMessage)
  }, [browserPreview, navigateTo, tabCommand])

  // 开发预览没有 Tauri event plugin；mock transport 会把命令结果投影成
  // 同名 DOM 事件。这样 Agent 在预览中执行 browser.* 时，标签栏/地址栏/iframe
  // 仍与返回的状态保持一致。原生 WebView 继续只消费 Tauri 事件。
  useEffect(() => {
    if (!browserPreview) return
    const onMockStatus = (event: Event) => {
      const payload = (event as CustomEvent<unknown>).detail
      if (!payload || typeof payload !== 'object') return
      const next = payload as BrowserSnapshot
      if (typeof next.phase !== 'string' || !Array.isArray(next.tabs)) return
      const previous = snapshotRef.current
      if (previous.activeTabId !== next.activeTabId || previous.url !== next.url) {
        setPreviewRevision(revision => revision + 1)
      }
      applySnapshot(next)
    }
    window.addEventListener('pylon:browser-status', onMockStatus)
    return () => window.removeEventListener('pylon:browser-status', onMockStatus)
  }, [applySnapshot, browserPreview])

  const setZoom = async (zoomPercent: number) => {
    const nextZoom = Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, zoomPercent))
    try {
      const next = await createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).setZoom(nextZoom) as BrowserSnapshot
      applySnapshot({ ...next, zoomPercent: next.zoomPercent ?? nextZoom })
    } catch (error) {
      reportRuntimeError('调整浏览器缩放', error)
    }
  }

  const inspectPage = useCallback(() => {
    if (snapshot.phase !== 'ready') return Promise.resolve()
    const inFlight = inspectPageInFlightRef.current
    if (inFlight) return inFlight

    const command = 'browser_snapshot'
    const request = (async () => {
      logConsole(command, 'info')
      try {
        const result = await createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).snapshot() as BrowserPageSnapshot
        setPageSnapshot(result)
        const detail = typeof result.text === 'string' ? `${result.url ?? ''} · ${result.text.length} chars · ${result.links?.length ?? 0} links` : String(result.url ?? '')
        logConsole(command, 'success', detail)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logConsole(command, 'error', message)
        reportRuntimeError('读取浏览器页面快照', error)
      }
    })()
    inspectPageInFlightRef.current = request
    void request.finally(() => {
      if (inspectPageInFlightRef.current === request) inspectPageInFlightRef.current = null
    })
    return request
  }, [logConsole, snapshot.phase])

  const toggleCurrentBookmark = useCallback(() => {
    const url = snapshot.url
    if (!url || url === 'about:blank' || !isBrowserLibraryUrl(url)) return
    const currentlyBookmarked = libraryRef.current.bookmarks.some(item => item.url === url)
    updateLibrary(current => toggleBookmark(current, { url, title: snapshot.title ?? undefined }).library)
    logConsole(currentlyBookmarked ? 'bookmark.remove' : 'bookmark.add', 'success', url)
  }, [logConsole, snapshot.title, snapshot.url, updateLibrary])

  const downloadUrl = useCallback(async (rawUrl: string, filename?: string) => {
    const url = rawUrl.trim()
    if (!isBrowserLibraryUrl(url)) {
      logConsole('browser_download', 'error', '仅允许 http/https URL')
      return
    }
    logConsole('browser_download', 'info', url)
    try {
      const result = await createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).download(url, filename) as Record<string, unknown>
      const status = result?.status === 'failed' ? 'failed' : 'started'
      const error = typeof result?.error === 'string' ? result.error : undefined
      updateLibrary(current => recordDownload(current, { url, filename: typeof result?.filename === 'string' ? result.filename : filename, status, error }))
      logConsole('browser_download', status === 'failed' ? 'error' : 'success', error || `${url}${filename ? ` → ${filename}` : ''}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateLibrary(current => recordDownload(current, { url, filename, status: 'failed', error: message }))
      logConsole('browser_download', 'error', message)
      reportRuntimeError('下载浏览器资源', error)
    }
  }, [logConsole, updateLibrary])

  const chooseTool = useCallback((tool: BrowserToolId) => {
    setActiveTool(current => current === tool ? null : tool)
    // The activeTool effect below owns snapshot refresh. Keeping one trigger
    // avoids issuing two browser_snapshot commands when opening Downloads or
    // Console (the old callback + effect race was visible as duplicate log
    // entries and unnecessary WebView work).
  }, [])

  useEffect(() => {
    if ((activeTool === 'downloads' || activeTool === 'console') && snapshot.phase === 'ready') void inspectPage()
  }, [activeTool, inspectPage, snapshot.phase])

  useEffect(() => () => {
    // Sheet 可能在 WebView 仍处于 starting/error（但已创建子视图）时卸载；
    // 只在 ready 清理会留下后台 WebView。browser_close 对 idle 也是幂等的，
    // 因而这里覆盖所有非 idle 状态。
    if (browserRuntimeAvailable && snapshotRef.current.phase !== 'idle') {
      void createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).close().catch(() => {})
    }
  }, [browserRuntimeAvailable])

  return (
    <div className={`browser-sheet ${sidebarCollapsed ? 'browser-sidebar-collapsed' : ''}`} data-browser-mode={browserPreview ? 'preview' : 'runtime'}>
      <aside className="browser-sidebar">
        <div className="browser-sidebar-head">
          {!sidebarCollapsed && <span className="browser-sidebar-title">TOOLS</span>}
        </div>
        <nav className="browser-tool-list" aria-label="浏览器工具栏">
          {TOOL_ITEMS.map(item => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                type="button"
                className={`browser-tool-item ${activeTool === item.id ? 'active' : ''}`}
                onClick={() => chooseTool(item.id)}
                title={item.label}
                aria-label={item.label}
                aria-pressed={activeTool === item.id}
              >
                <Icon size={18} aria-hidden="true" />
                {!sidebarCollapsed && <span>{item.label}</span>}
              </button>
            )
          })}
        </nav>
        {!sidebarCollapsed && <div className="browser-sidebar-note">WebView session<br /><span>{snapshot.phase}</span></div>}
      </aside>
      <main className="browser-main">
        {/* 保留语义节点供旧主题/可访问性选择器兼容；视觉上 Browser Sheet 不再重复显示
            BROWSER + Browser 两层标题，浏览器 chrome 直接成为主区入口。 */}
        <div className="browser-header browser-header-legacy">
          <div>
            <div className="file-main-kicker">BROWSER</div>
            <h2 className="file-main-title">Browser</h2>
          </div>
          <span className="browser-status" data-phase={snapshot.phase}>{snapshot.phase}</span>
        </div>
        {snapshot.tabs.length > 0 && (
          <div className="browser-tab-strip" role="tablist" aria-label="浏览器标签">
            {snapshot.tabs.map(tab => {
              const active = snapshot.activeTabId === tab.id
              return (
                <div key={tab.id} className={`browser-tab ${active ? 'active' : ''}`}>
                  <button type="button" className="browser-tab-select" role="tab" aria-selected={active} onClick={() => void tabCommand('select', tab.id)} title={tab.title || tab.url || '新标签'}>
                    <Globe2 size={13} aria-hidden="true" />
                    <span>{browserTabLabel(tab)}</span>
                  </button>
                  <button type="button" className="browser-tab-close" onClick={() => void tabCommand('close', tab.id)} aria-label={`关闭 ${browserTabLabel(tab)}`}><X size={12} /></button>
                </div>
              )
            })}
            <button type="button" className="browser-tab-new" onClick={() => void tabCommand('new')} aria-label="新建浏览器标签"><Plus size={14} /></button>
          </div>
        )}
        <div className="browser-toolbar" aria-label="浏览器导航栏">
          <button type="button" className="browser-toolbar-button" onClick={() => void browserCommand('browser_back')} disabled={snapshot.phase !== 'ready'} aria-label="后退"><ChevronLeft size={18} /></button>
          <button type="button" className="browser-toolbar-button" onClick={() => void browserCommand('browser_forward')} disabled={snapshot.phase !== 'ready'} aria-label="前进"><ChevronRight size={18} /></button>
          <button type="button" className="browser-toolbar-button" onClick={() => void browserCommand('browser_reload')} disabled={snapshot.phase !== 'ready'} aria-label="刷新"><RefreshCw size={15} /></button>
          <div className="browser-address-wrap"><Search size={14} /><input className="browser-address" value={address} onChange={event => setAddress(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void navigate() }} placeholder="输入网址…" aria-label="网址" /></div>
          <button
            type="button"
            className={`browser-toolbar-button browser-bookmark-button ${library.bookmarks.some(item => item.url === snapshot.url) ? 'active' : ''}`}
            onClick={toggleCurrentBookmark}
            disabled={!snapshot.url || snapshot.url === 'about:blank'}
            aria-label={library.bookmarks.some(item => item.url === snapshot.url) ? '移除当前页书签' : '添加当前页书签'}
            title={library.bookmarks.some(item => item.url === snapshot.url) ? '移除书签' : '添加书签'}
          >
            {library.bookmarks.some(item => item.url === snapshot.url) ? <BookmarkCheck size={16} /> : <Bookmark size={16} />}
          </button>
          <button
            type="button"
            className="browser-zoom-toggle"
            onClick={() => setZoomSettingsOpen(open => !open)}
            aria-expanded={zoomSettingsOpen}
            aria-controls="browser-zoom-settings"
            aria-label={`页面缩放，当前 ${snapshot.zoomPercent}%`}
          >
            {snapshot.zoomPercent}%
          </button>
          <span className="browser-status browser-status-inline" data-phase={snapshot.phase} data-runtime={snapshot.runtime} title={browserPreview ? '开发预览：页面由 iframe 加载' : '桌面 WebView2 会话'}>
            {browserPreview ? 'preview' : snapshot.phase}
          </span>
        </div>
        {zoomSettingsOpen && (
          <div id="browser-zoom-settings" className="browser-zoom-settings" role="group" aria-label="页面缩放设置">
            <button type="button" className="browser-zoom-button" onClick={() => void setZoom(snapshot.zoomPercent - ZOOM_STEP)} disabled={snapshot.phase !== 'ready' || snapshot.zoomPercent <= MIN_ZOOM_PERCENT} aria-label="缩小页面"><Minus size={14} /></button>
            <input
              className="browser-zoom-range"
              type="range"
              min={MIN_ZOOM_PERCENT}
              max={MAX_ZOOM_PERCENT}
              step={ZOOM_STEP}
              value={snapshot.zoomPercent}
              onChange={event => void setZoom(Number(event.target.value))}
              disabled={snapshot.phase !== 'ready'}
              aria-label="页面缩放"
            />
            <output className="browser-zoom-value" aria-live="polite">{snapshot.zoomPercent}%</output>
            <button type="button" className="browser-zoom-button" onClick={() => void setZoom(snapshot.zoomPercent + ZOOM_STEP)} disabled={snapshot.phase !== 'ready' || snapshot.zoomPercent >= MAX_ZOOM_PERCENT} aria-label="放大页面"><Plus size={14} /></button>
            <button type="button" className="browser-zoom-reset" onClick={() => void setZoom(DEFAULT_ZOOM_PERCENT)} disabled={snapshot.phase !== 'ready' || snapshot.zoomPercent === DEFAULT_ZOOM_PERCENT} aria-label="恢复默认缩放"><RotateCcw size={13} />默认 90%</button>
          </div>
        )}
        {activeTool && (
          <BrowserToolPanel
            activeTool={activeTool}
            library={library}
            pageSnapshot={pageSnapshot}
            consoleFilter={consoleFilter}
            onConsoleFilterChange={setConsoleFilter}
            onClose={() => setActiveTool(null)}
            onClear={collection => updateLibrary(current => clearBrowserCollection(current, collection))}
            onNavigate={url => void navigateTo(url)}
            onDownload={downloadUrl}
            onInspect={() => void inspectPage()}
            downloadUrlInput={downloadUrlInput}
            onDownloadUrlInputChange={setDownloadUrlInput}
          />
        )}
        <div ref={viewportRef} className="browser-viewport">
          {browserPreview && snapshot.phase === 'ready' && snapshot.url && snapshot.url !== 'about:blank' && (
            <iframe
              key={`${snapshot.activeTabId ?? 'tab'}:${snapshot.url}:${previewRevision}`}
              className="browser-preview-frame"
              src={browserPreviewUrl(snapshot.url)}
              title={snapshot.title || snapshot.url}
              referrerPolicy="no-referrer"
            />
          )}
          <div className={`browser-empty-state ${snapshot.phase === 'ready' ? 'browser-empty-hidden' : ''}`} role="status">
            <div className="browser-empty-mark" aria-hidden="true">◌</div>
            <strong>{browserPreview ? '输入网址开始浏览' : '浏览器会话尚未启动'}</strong>
            <span>{browserPreview ? '开发预览加载真实网页；桌面端会切换为嵌入式 WebView2。' : '启动后，完整 WebView 将占据主工作区。'}</span>
            <span className="browser-empty-note">{browserPreview ? 'preview runtime · 不伪装成桌面 WebView' : 'WebView2 子进程由 Browser Sheet 生命周期管理'}</span>
            <div className="browser-actions"><button type="button" className="template-apply" onClick={() => void start()} disabled={snapshot.phase === 'starting'}>新建标签</button></div>
          </div>
        </div>
        {state.error && <div className="file-tree-error browser-error" role="alert">{state.error}</div>}
      </main>
    </div>
  )
}

interface BrowserToolPanelProps {
  activeTool: BrowserToolId
  library: BrowserLibrary
  pageSnapshot: BrowserPageSnapshot | null
  consoleFilter: 'all' | ConsoleEntry['level']
  onConsoleFilterChange: (value: 'all' | ConsoleEntry['level']) => void
  onClose: () => void
  onClear: (collection: 'history' | 'bookmarks' | 'downloads' | 'console') => void
  onNavigate: (url: string) => void
  onDownload: (url: string, filename?: string) => void
  onInspect: () => void
  downloadUrlInput: string
  onDownloadUrlInputChange: (value: string) => void
}

function BrowserToolPanel({
  activeTool,
  library,
  pageSnapshot,
  consoleFilter,
  onConsoleFilterChange,
  onClose,
  onClear,
  onNavigate,
  onDownload,
  onInspect,
  downloadUrlInput,
  onDownloadUrlInputChange,
}: BrowserToolPanelProps) {
  const labels: Record<BrowserToolId, string> = { history: '历史', bookmarks: '书签', downloads: '下载', console: '控制台' }
  const clearable = activeTool
  return (
    <section className="browser-tool-panel" aria-label={`${labels[activeTool]}面板`}>
      <header className="browser-tool-panel-head">
        <strong>{labels[activeTool]}</strong>
        <div className="browser-tool-panel-actions">
          {activeTool === 'console' && <button type="button" className="browser-panel-action" onClick={onInspect}>刷新快照</button>}
          <button type="button" className="browser-panel-action" onClick={() => onClear(clearable)} disabled={library[clearable].length === 0}>清空</button>
          <button type="button" className="browser-panel-close" onClick={onClose} aria-label={`关闭${labels[activeTool]}面板`}><X size={14} /></button>
        </div>
      </header>

      {activeTool === 'history' && (
        <div className="browser-library-list">
          {library.history.length === 0 && <p className="browser-library-empty">暂无浏览记录</p>}
          {library.history.map(entry => (
            <button key={entry.id} type="button" className="browser-library-item" onClick={() => onNavigate(entry.url)}>
              <span className="browser-library-item-title">{entry.title || entry.url}</span>
              <span className="browser-library-item-meta">{entry.url} · {formatBrowserTime(entry.visitedAt)}</span>
            </button>
          ))}
        </div>
      )}

      {activeTool === 'bookmarks' && (
        <div className="browser-library-list">
          {library.bookmarks.length === 0 && <p className="browser-library-empty">暂无书签；点击地址栏旁的书签图标添加。</p>}
          {library.bookmarks.map(entry => (
            <button key={entry.id} type="button" className="browser-library-item" onClick={() => onNavigate(entry.url)}>
              <span className="browser-library-item-title">{entry.title || entry.url}</span>
              <span className="browser-library-item-meta">{entry.url} · {formatBrowserTime(entry.createdAt)}</span>
            </button>
          ))}
        </div>
      )}

      {activeTool === 'downloads' && (
        <div className="browser-download-panel">
          <form className="browser-download-form" onSubmit={event => { event.preventDefault(); if (downloadUrlInput.trim()) { onDownload(downloadUrlInput); onDownloadUrlInputChange('') } }}>
            <input
              value={downloadUrlInput}
              onChange={event => onDownloadUrlInputChange(event.target.value)}
              placeholder="粘贴 http(s) 下载地址"
              aria-label="下载地址"
              inputMode="url"
            />
            <button type="submit" className="browser-panel-action" disabled={!downloadUrlInput.trim()}>开始</button>
          </form>
          {pageSnapshot?.links?.some(link => link.download && typeof link.href === 'string') && (
            <div className="browser-discovered-downloads">
              <span className="browser-library-caption">当前页面的下载链接</span>
              {pageSnapshot.links.filter(link => link.download && typeof link.href === 'string').map((link, index) => (
                <button key={`${link.href}-${index}`} type="button" className="browser-library-item" onClick={() => onDownload(link.href!, link.downloadName ?? undefined)}>
                  <span className="browser-library-item-title">{link.text || link.downloadName || link.href}</span>
                  <span className="browser-library-item-meta">{link.href}</span>
                </button>
              ))}
            </div>
          )}
          <div className="browser-library-list">
            {library.downloads.length === 0 && <p className="browser-library-empty">暂无下载记录</p>}
            {library.downloads.map(entry => (
              <div key={entry.id} className="browser-library-item browser-download-entry">
                <span className="browser-library-item-title">{entry.filename || entry.url}</span>
                <span className="browser-library-item-meta" data-status={entry.status}>{entry.status === 'started' ? '已发起' : '失败'} · {entry.url} · {formatBrowserTime(entry.startedAt)}</span>
                {entry.error && <span className="browser-library-item-error">{entry.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTool === 'console' && (
        <div className="browser-console-panel">
          <div className="browser-console-toolbar">
            <label>级别
              <select value={consoleFilter} onChange={event => onConsoleFilterChange(event.target.value as 'all' | ConsoleEntry['level'])} aria-label="控制台级别">
                <option value="all">全部</option><option value="info">信息</option><option value="success">成功</option><option value="error">错误</option>
              </select>
            </label>
            {pageSnapshot && <span className="browser-console-snapshot">快照：{pageSnapshot.links?.length ?? 0} links · {(pageSnapshot.text?.length ?? 0).toLocaleString()} chars</span>}
          </div>
          <div className="browser-console-list">
            {library.console.filter(entry => consoleFilter === 'all' || entry.level === consoleFilter).length === 0 && <p className="browser-library-empty">暂无操作记录</p>}
            {library.console.filter(entry => consoleFilter === 'all' || entry.level === consoleFilter).map(entry => (
              <div key={entry.id} className="browser-console-entry" data-level={entry.level}>
                <span className="browser-console-time">{formatBrowserTime(entry.at)}</span>
                <code>{entry.command}</code>
                {entry.detail && <span className="browser-console-detail">{entry.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function formatBrowserTime(value: number): string {
  try {
    return new Date(value).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

function browserTabLabel(tab: BrowserTabSnapshot): string {
  const title = tab.title?.trim()
  if (title) return title
  const rawUrl = tab.url?.trim()
  if (!rawUrl || rawUrl === 'about:blank') return '新标签'
  try {
    return new URL(rawUrl).hostname || rawUrl
  } catch {
    return rawUrl
  }
}

function browserPreviewUrl(url: string): string {
  return `/__pylon_browser_proxy?url=${encodeURIComponent(url)}`
}
