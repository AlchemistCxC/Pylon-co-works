import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Bookmark, ChevronLeft, ChevronRight, Clock3, Code2, Download, Globe2, Minus, Plus, RefreshCw, RotateCcw, Search, X } from 'lucide-react'
import { browserReducer, createBrowserState } from '../../domains/browser/browserState.ts'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { classifyBrowserStartError } from '../../infrastructure/tauri/browserContracts.ts'
import { createBrowserClient } from '../../infrastructure/tauri/browserClient'
import { hasTauriRuntime, IS_TAURI, type TauriWindow } from '../../infrastructure/tauri/env.ts'
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
const VISUAL_QA_BROWSER_SNAPSHOT: BrowserSnapshot = {
  instanceId: 1,
  phase: 'ready',
  url: 'https://example.com',
  title: 'Example Domain',
  error: null,
  zoomPercent: DEFAULT_ZOOM_PERCENT,
  activeTabId: 1,
  tabs: [
    { id: 1, url: 'https://example.com', title: 'Example Domain' },
    { id: 2, url: 'https://developer.mozilla.org/', title: 'MDN Web Docs' },
    { id: 3, url: 'https://tauri.app/', title: 'Tauri' },
  ],
}

// FE-AUD-021：未实现工具 disabled 并标注 unavailable（不保留可点击无行为的假完成态）
const TOOL_ITEMS = [
  { id: 'history', label: '历史', icon: Clock3, available: false },
  { id: 'bookmarks', label: '书签', icon: Bookmark, available: false },
  { id: 'downloads', label: '下载', icon: Download, available: false },
  { id: 'console', label: '控制台', icon: Code2, available: false },
] as const

export default function BrowserSheetView({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const visualQaMock = !IS_TAURI && sheet.metadata?.visualQaBrowser === 'tabs'
  const [state, dispatch] = useReducer(browserReducer, undefined, createBrowserState)
  // 浏览器 Dev Mock 在静态 import 之后安装 Tauri globals，故运行时再探测一次；
  // 原生环境仍走模块级 IS_TAURI 快路径。
  const browserRuntimeAvailable = !visualQaMock && (IS_TAURI
    || (typeof window !== 'undefined' && hasTauriRuntime(window as Window & TauriWindow)))
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>(() => visualQaMock
    ? VISUAL_QA_BROWSER_SNAPSHOT
    : { instanceId: 0, phase: 'idle', zoomPercent: DEFAULT_ZOOM_PERCENT, activeTabId: null, tabs: [] })
  const [zoomSettingsOpen, setZoomSettingsOpen] = useState(false)
  // I09-A-FE-02（D-01/D-08）：折叠状态唯一来源 ctx.sidebarCollapsed（titlebar 统一控制），
  // 不再维护独立折叠布尔——browser-sidebar-collapsed 类直连全局状态
  const { sidebarCollapsed } = ctx
  const [activeTool, setActiveTool] = useState<(typeof TOOL_ITEMS)[number]['id']>('history')
  const [address, setAddress] = useState(() => visualQaMock ? VISUAL_QA_BROWSER_SNAPSHOT.url || '' : '')
  const viewportRef = useRef<HTMLDivElement>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  const applySnapshot = useCallback((next: BrowserSnapshot) => {
    const normalized: BrowserSnapshot = {
      ...next,
      zoomPercent: next.zoomPercent ?? DEFAULT_ZOOM_PERCENT,
      activeTabId: next.activeTabId ?? (next.instanceId || null),
      tabs: next.tabs ?? (next.instanceId ? [{ id: next.instanceId, url: next.url, title: next.title }] : []),
    }
    setSnapshot(normalized)
    if (normalized.phase === 'ready') dispatch({ type: 'started', instanceId: String(normalized.instanceId) })
    else if (normalized.phase === 'idle') dispatch({ type: 'stop' })
    else if (normalized.phase === 'error') dispatch({ type: 'failed', error: normalized.error || '浏览器启动失败' })
    else if (normalized.error) dispatch({ type: 'failed', error: normalized.error })
    setAddress(normalized.url && normalized.url !== 'about:blank' ? normalized.url : '')
  }, [])

  const syncBounds = useCallback(() => {
    const element = viewportRef.current
    if (!element || !browserRuntimeAvailable || snapshot.phase !== 'ready') return
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
  }, [browserRuntimeAvailable, snapshot.phase])

  useEffect(() => {
    if (!browserRuntimeAvailable) return
    let disposed = false
    const commit = (next: BrowserSnapshot) => {
      if (!disposed) applySnapshot(next)
    }
    void createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).status().then(raw => commit(raw as BrowserSnapshot)).catch(() => {})
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
  }, [applySnapshot, browserRuntimeAvailable])

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
      applySnapshot(next)
    } catch (error) {
      const classified = classifyBrowserStartError(error)
      dispatch({ type: 'failed', error: classified.kind === 'blocked' ? '浏览器 WebView 命令不可用' : classified.message })
      setSnapshot(previous => ({ ...previous, phase: 'error', error: classified.kind === 'blocked' ? '浏览器 WebView 命令不可用' : classified.message }))
      if (classified.kind === 'error') reportRuntimeError('启动浏览器 WebView', error)
    }
  }

  const navigate = async () => {
    const url = address.trim()
    if (!url) return
    try {
      const next = await createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).navigate(/^https?:\/\//i.test(url) ? url : `https://${url}`) as BrowserSnapshot
      setSnapshot(next)
    } catch (error) {
      reportRuntimeError('浏览器导航', error)
    }
  }

  const browserCommand = async (command: 'browser_back' | 'browser_forward' | 'browser_reload') => {
    try {
      const bc = createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      const next = await (command === 'browser_back' ? bc.back() : command === 'browser_forward' ? bc.forward() : bc.reload()) as BrowserSnapshot
      applySnapshot(next)
    } catch (error) {
      reportRuntimeError('浏览器操作', error)
    }
  }

  const tabCommand = async (command: 'new' | 'select' | 'close', tabId?: number) => {
    try {
      const client = createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      const next = await (command === 'new'
        ? client.newTab()
        : command === 'select'
          ? client.selectTab(tabId!)
          : client.closeTab(tabId!)) as BrowserSnapshot
      applySnapshot(next)
    } catch (error) {
      reportRuntimeError(command === 'new' ? '新建浏览器标签' : command === 'select' ? '切换浏览器标签' : '关闭浏览器标签', error)
    }
  }

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
    if (browserRuntimeAvailable && snapshotRef.current.phase === 'ready') {
      void createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).close().catch(() => {})
    }
  }, [browserRuntimeAvailable])

  return (
    <div className={`browser-sheet ${sidebarCollapsed ? 'browser-sidebar-collapsed' : ''}`}>
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
        <div className="browser-header">
          <div>
            <div className="file-main-kicker">BROWSER</div>
            <h2 className="file-main-title">Browser</h2>
          </div>
          <span className="browser-status" data-phase={snapshot.phase}>{snapshot.phase}</span>
        </div>
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
          <div className={`browser-empty-state ${snapshot.phase === 'ready' ? 'browser-empty-hidden' : ''}`} role="status">
            <div className="browser-empty-mark" aria-hidden="true">◌</div>
            <strong>浏览器会话尚未启动</strong>
            <span>启动后，完整 WebView 将占据主工作区。</span>
            <span className="browser-empty-note">WebView2 子进程由 Browser Sheet 生命周期管理</span>
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
