import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Bookmark, ChevronLeft, ChevronRight, Clock3, Code2, Download, Globe2, Minus, Plus, RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import { browserReducer, createBrowserState } from '../../domains/browser/browserState.ts'
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

const DEFAULT_ZOOM_PERCENT = 90
const MIN_ZOOM_PERCENT = 50
const MAX_ZOOM_PERCENT = 200
const ZOOM_STEP = 10
// FE-AUD-021：未实现工具 disabled 并标注 unavailable（不保留可点击无行为的假完成态）
const TOOL_ITEMS = [
  { id: 'history', label: '历史', icon: Clock3, available: false },
  { id: 'bookmarks', label: '书签', icon: Bookmark, available: false },
  { id: 'downloads', label: '下载', icon: Download, available: false },
  { id: 'console', label: '控制台', icon: Code2, available: false },
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
  const [activeTool, setActiveTool] = useState<(typeof TOOL_ITEMS)[number]['id']>('history')
  const [address, setAddress] = useState('')
  // 跨域 iframe 的页面自身导航无法被父文档读取；命令导航/刷新时递增 key，
  // 让预览重新回到 Browser 状态机记录的 URL，避免地址栏与画面脱节。
  const [previewRevision, setPreviewRevision] = useState(0)
  const viewportRef = useRef<HTMLDivElement>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

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
  }, [browserPreview, isSheetActive])

  const syncBounds = useCallback(() => {
    const element = viewportRef.current
    if (!element || !browserRuntimeAvailable || snapshot.phase !== 'ready' || !isSheetActive) return
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    void createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).setBounds({
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
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
  }, [browserPreview, browserRuntimeAvailable, isSheetActive, snapshot.phase])

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
      if (payload.active) setAddress(payload.url && payload.url !== 'about:blank' ? payload.url : '')
    })
    return () => {
      disposed = true
      void status.then(stop => stop()).catch(() => {})
      void page.then(stop => stop()).catch(() => {})
    }
  }, [applySnapshot, browserPreview, browserRuntimeAvailable, isSheetActive])

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
                onClick={() => setActiveTool(item.id)}
                disabled={!item.available}
                title={item.available ? item.label : `${item.label}（未实现）`}
                aria-label={item.available ? item.label : `${item.label}（未实现）`}
                aria-pressed={activeTool === item.id}
              >
                {/* ISSUE-10 W1：折叠态只保留图标；label/unavailable 文字不渲染（CSS 仅第二道防线） */}
                <Icon size={18} aria-hidden="true" />
                {!sidebarCollapsed && <span>{item.label}</span>}
                {!sidebarCollapsed && !item.available && (
                  <span className="browser-tool-unavailable">unavailable</span>
                )}
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
