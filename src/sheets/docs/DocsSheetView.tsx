import { useCallback, useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronLeft, ChevronRight, House, RotateCw } from 'lucide-react'
import { tauriInvokeTransport } from '../../infrastructure/acp/tauriTransport.ts'
import { createDocsClient, type DocsSheetSnapshot } from '../../infrastructure/tauri/docsClient'
import { useModalOverlayOpen } from '../../app/modalOverlayStore'
import { reportRuntimeError } from '../../app/runtimeError'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/**
 * DocsSheetView — 离线文档站壳（#371）。
 *
 * 子 WebView 由后端创建并嵌进 viewport（`pylon-docs://` scheme），前端只做三件事：
 * 进入活动主区自动 start（keep-alive 复活为幂等）、bounds/可见性随布局与覆盖层同步、
 * 卸载时 close 回收 WebView2 子进程。导航 chrome 保持最小（回首页/后退/前进/刷新）——
 * VitePress 自带 navbar/sidebar/搜索，不复制浏览器语义。
 *
 * 原生子 WebView 是独立于 React DOM 的窗口：display:none 盖不住它，可见性必须走
 * docs_sheet_set_visible（与 Browser Sheet 同一约束）；外链在 Rust on_navigation
 * fail-closed 取消，壳层不代开系统浏览器。
 */

const DOCS_CLIENT = createDocsClient({ invoke: tauriInvokeTransport })

const IDLE_SNAPSHOT: DocsSheetSnapshot = { phase: 'idle', error: null, visible: true }

export default function DocsSheetView({ ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const [snapshot, setSnapshot] = useState<DocsSheetSnapshot>(IDLE_SNAPSHOT)
  const snapshotRef = useRef(snapshot)
  snapshotRef.current = snapshot
  // 原生子 WebView 不受父 DOM 影响；旧上下文省略 isActive 时按 active 处理。
  const isSheetActive = ctx.isActive !== false
  const { sidebarCollapsed } = ctx
  const modalOverlayOpen = useModalOverlayOpen()
  const viewportRef = useRef<HTMLDivElement>(null)

  const start = useCallback(async () => {
    const element = viewportRef.current
    const rect = element?.getBoundingClientRect()
    try {
      const next = await DOCS_CLIENT.start({
        x: Math.round(rect?.left ?? 0),
        y: Math.round(rect?.top ?? 0),
        width: Math.max(1, Math.round(rect?.width ?? 1)),
        height: Math.max(1, Math.round(rect?.height ?? 1)),
      }) as DocsSheetSnapshot
      setSnapshot(next)
    } catch (error) {
      setSnapshot(previous => ({ ...previous, phase: 'error', error: error instanceof Error ? error.message : String(error) }))
      reportRuntimeError('打开文档站', error)
    }
  }, [])

  // 进入活动主区自动建会话；对已就绪/启动中的 keep-alive 复活是幂等的（后端去重）。
  useEffect(() => {
    if (ctx.isActive !== true || snapshotRef.current.phase !== 'idle') return
    void start()
  }, [ctx.isActive, start])

  // phase 进入 ready 后 syncBounds 身份变化 → bounds 效果重跑一次，把原生 WebView
  // 边界与 DOM 布局收敛（与 BrowserSheetView 同一依赖形态）。
  const syncBounds = useCallback(() => {
    const element = viewportRef.current
    if (!element || snapshot.phase !== 'ready' || !isSheetActive) return
    const rect = element.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return
    void DOCS_CLIENT.setBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    }).catch(error => reportRuntimeError('调整文档区域', error))
  }, [isSheetActive, snapshot.phase])

  // 同步原生子 WebView 可见性（Sheet 切换 keep-alive + 模态覆盖层让位）；
  // 依赖 phase：start 完成后补发一次与当前活动态一致的可见性。
  useEffect(() => {
    if (typeof ctx.isActive !== 'boolean' || snapshot.phase !== 'ready') return
    void DOCS_CLIENT.setVisible(isSheetActive && !modalOverlayOpen)
      .catch(error => reportRuntimeError('切换文档可见性', error))
  }, [ctx.isActive, isSheetActive, modalOverlayOpen, snapshot.phase])

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
    // 折叠变化（ctx.sidebarCollapsed）即时重同步 bounds，与 CSS 布局保持一致
  }, [syncBounds, sidebarCollapsed])

  useEffect(() => () => {
    // Sheet 可能在 WebView 已创建但未 ready 时卸载；close 对 idle 幂等，覆盖所有状态。
    if (snapshotRef.current.phase !== 'idle') {
      void DOCS_CLIENT.close().catch(() => {})
    }
  }, [])

  const runCommand = useCallback(async (command: 'back' | 'forward' | 'reload' | 'home') => {
    try {
      const next = await DOCS_CLIENT[command]() as DocsSheetSnapshot
      setSnapshot(previous => ({ ...previous, ...next }))
    } catch (error) {
      reportRuntimeError('文档站导航', error)
    }
  }, [])

  const ready = snapshot.phase === 'ready'

  return (
    <div className="docs-sheet flex flex-1 min-w-0 min-h-0 flex-col overflow-hidden text-text font-[family-name:var(--font)] bg-[var(--global-bg-color,var(--bg))]">
      <div className="docs-toolbar flex shrink-0 min-w-0 min-h-[40px] items-center gap-1 m-0 py-1 px-2 border-0 border-b border-border rounded-none bg-bg-panel" aria-label="文档工具栏">
        <button type="button" className="docs-toolbar-button grid w-[30px] h-[30px] shrink-0 basis-[30px] place-items-center border border-transparent rounded-[4px] text-text-dim bg-transparent cursor-pointer enabled:hover:text-text enabled:hover:bg-bg-hover disabled:opacity-[0.35] disabled:cursor-not-allowed" onClick={() => void runCommand('home')} disabled={!ready} aria-label="回首页" title="回首页"><House size={16} /></button>
        <button type="button" className="docs-toolbar-button grid w-[30px] h-[30px] shrink-0 basis-[30px] place-items-center border border-transparent rounded-[4px] text-text-dim bg-transparent cursor-pointer enabled:hover:text-text enabled:hover:bg-bg-hover disabled:opacity-[0.35] disabled:cursor-not-allowed" onClick={() => void runCommand('back')} disabled={!ready} aria-label="后退"><ChevronLeft size={18} /></button>
        <button type="button" className="docs-toolbar-button grid w-[30px] h-[30px] shrink-0 basis-[30px] place-items-center border border-transparent rounded-[4px] text-text-dim bg-transparent cursor-pointer enabled:hover:text-text enabled:hover:bg-bg-hover disabled:opacity-[0.35] disabled:cursor-not-allowed" onClick={() => void runCommand('forward')} disabled={!ready} aria-label="前进"><ChevronRight size={18} /></button>
        <button type="button" className="docs-toolbar-button grid w-[30px] h-[30px] shrink-0 basis-[30px] place-items-center border border-transparent rounded-[4px] text-text-dim bg-transparent cursor-pointer enabled:hover:text-text enabled:hover:bg-bg-hover disabled:opacity-[0.35] disabled:cursor-not-allowed" onClick={() => void runCommand('reload')} disabled={!ready} aria-label="刷新"><RotateCw size={15} /></button>
        <span className="docs-title min-w-0 flex-1 px-1 text-[12px] text-text-dim truncate">Pylon 文档</span>
        <span className={`docs-status inline-flex h-[24px] items-center justify-center px-[7px] border rounded-[4px] font-[family-name:var(--mono)] text-[10px] tracking-[.04em] uppercase ${ready ? 'text-[var(--tool-ok)] border-[color-mix(in_srgb,var(--tool-ok)_38%,var(--border))]' : snapshot.phase === 'error' ? 'text-[var(--tool-err,var(--danger))] border-[color-mix(in_srgb,var(--tool-err,var(--danger))_38%,var(--border))]' : 'text-text-dim border-border'}`} data-phase={snapshot.phase}>{snapshot.phase}</span>
      </div>
      <div ref={viewportRef} className="docs-viewport relative flex flex-1 min-w-0 min-h-0 overflow-hidden">
        {!ready && (
          <div className="docs-placeholder absolute inset-0 grid place-content-center justify-items-center gap-2 p-6 text-text-dim" data-phase={snapshot.phase}>
            <BookOpen size={28} aria-hidden="true" />
            <p className="m-0 text-[13px]">
              {snapshot.phase === 'error' ? (snapshot.error || '文档站加载失败') : snapshot.phase === 'idle' ? '文档站尚未启动' : '正在打开文档站…'}
            </p>
            {snapshot.phase === 'error' && <p className="m-0 text-[11px] text-text-placeholder">离线文档站需随发行包分发的 docs-site 资源；开发构建可先运行 bun run docs:build:offline</p>}
            {snapshot.phase === 'idle' && <button type="button" className="docs-retry px-3 h-[28px] border border-border rounded-[5px] text-[12px] text-text bg-bg-input cursor-pointer hover:border-accent hover:text-text hover:bg-bg-hover" onClick={() => void start()}>打开文档</button>}
          </div>
        )}
      </div>
    </div>
  )
}
