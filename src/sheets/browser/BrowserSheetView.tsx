import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Bookmark, ChevronLeft, ChevronRight, Clock3, Code2, Download, PanelLeftClose, PanelLeftOpen, RefreshCw, Search } from 'lucide-react'
import { browserReducer, createBrowserState } from '../../domains/browser/browserState.ts'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { classifyBrowserStartError } from '../../infrastructure/tauri/browserContracts.ts'
import { createBrowserClient } from '../../infrastructure/tauri/browserClient'
import { IS_TAURI } from '../../infrastructure/tauri/env.ts'
import { reportRuntimeError } from '../../runtimeError'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import './BrowserSheet.css'

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
}

const TOOL_ITEMS = [
  { id: 'history', label: '历史', icon: Clock3 },
  { id: 'bookmarks', label: '书签', icon: Bookmark },
  { id: 'downloads', label: '下载', icon: Download },
  { id: 'console', label: '控制台', icon: Code2 },
] as const

export default function BrowserSheetView({ sheet: _sheet, ctx: _ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const [state, dispatch] = useReducer(browserReducer, undefined, createBrowserState)
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>({ instanceId: 0, phase: 'idle' })
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [activeTool, setActiveTool] = useState<(typeof TOOL_ITEMS)[number]['id']>('history')
  const [address, setAddress] = useState('')
  const viewportRef = useRef<HTMLDivElement>(null)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot

  const syncBounds = useCallback(() => {
    const element = viewportRef.current
    if (!element || !IS_TAURI || snapshot.phase !== 'ready') return
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
  }, [snapshot.phase])

  useEffect(() => {
    if (!IS_TAURI) return
    let disposed = false
    const applySnapshot = (next: BrowserSnapshot) => {
      if (disposed) return
      setSnapshot(next)
      if (next.phase === 'ready') dispatch({ type: 'started', instanceId: String(next.instanceId) })
      else if (next.phase === 'idle') dispatch({ type: 'stop' })
      else if (next.phase === 'error') dispatch({ type: 'failed', error: next.error || '浏览器启动失败' })
      if (next.url) setAddress(next.url)
    }
    void createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).status().then(raw => applySnapshot(raw as BrowserSnapshot)).catch(() => {})
    const status = listen<BrowserSnapshot>('pylon:browser-status', event => applySnapshot(event.payload))
    const page = listen<Pick<BrowserSnapshot, 'instanceId' | 'url' | 'title'>>('pylon:browser-page', event => {
      if (!disposed && event.payload.url) setAddress(event.payload.url)
    })
    return () => {
      disposed = true
      void status.then(stop => stop()).catch(() => {})
      void page.then(stop => stop()).catch(() => {})
    }
  }, [])

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
      setSnapshot(next)
      setAddress(next.url || '')
      dispatch({ type: 'started', instanceId: String(next.instanceId) })
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
      setSnapshot(next)
    } catch (error) {
      reportRuntimeError('浏览器操作', error)
    }
  }

  useEffect(() => () => {
    if (IS_TAURI && snapshotRef.current.phase === 'ready') {
      void createBrowserClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).close().catch(() => {})
    }
  }, [])

  return (
    <div className={`browser-sheet ${sidebarCollapsed ? 'browser-sidebar-collapsed' : ''}`}>
      <aside className="browser-sidebar">
        <div className="browser-sidebar-head">
          {!sidebarCollapsed && <span className="browser-sidebar-title">TOOLS</span>}
          <button type="button" className="browser-sidebar-toggle" onClick={() => setSidebarCollapsed(value => !value)} title={sidebarCollapsed ? '展开浏览器工具栏' : '折叠浏览器工具栏'} aria-label={sidebarCollapsed ? '展开浏览器工具栏' : '折叠浏览器工具栏'}>
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>
        </div>
        <nav className="browser-tool-list" aria-label="浏览器工具栏">
          {TOOL_ITEMS.map(item => {
            const Icon = item.icon
            return <button key={item.id} type="button" className={`browser-tool-item ${activeTool === item.id ? 'active' : ''}`} onClick={() => setActiveTool(item.id)} title={item.label} aria-label={item.label} aria-pressed={activeTool === item.id}><Icon size={18} />{!sidebarCollapsed && <span>{item.label}</span>}</button>
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
          <span className="browser-toolbar-menu" aria-hidden="true">⋯</span>
        </div>
        <div ref={viewportRef} className="browser-viewport">
          <div className={`browser-empty-state ${snapshot.phase === 'ready' ? 'browser-empty-hidden' : ''}`} role="status">
            <div className="browser-empty-mark" aria-hidden="true">◌</div>
            <strong>浏览器会话尚未启动</strong>
            <span>启动后，完整 WebView 将占据主工作区。</span>
            <span className="browser-empty-note">WebView2 子进程由 Browser Sheet 生命周期管理</span>
            <div className="browser-actions"><button type="button" className="template-apply" onClick={() => void start()} disabled={snapshot.phase === 'starting'}>启动</button></div>
          </div>
        </div>
        {state.error && <div className="file-tree-error browser-error" role="alert">{state.error}</div>}
      </main>
    </div>
  )
}
