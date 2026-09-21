import type { RefObject } from 'react'
import type { BrowserSnapshot } from './browserSheetTypes.ts'

function browserPreviewUrl(url: string): string {
  return `/__pylon_browser_proxy?url=${encodeURIComponent(url)}`
}

/** 预览 iframe 与未启动空态共用的 viewport 容器（#228 批次 D 纯搬移）。
 * `viewportRef` 仍归属主组件——bounds 同步、启动定位都读这个节点。 */
export function BrowserViewport({ viewportRef, browserPreview, snapshot, previewRevision, onStart }: {
  viewportRef: RefObject<HTMLDivElement | null>
  browserPreview: boolean
  snapshot: BrowserSnapshot
  previewRevision: number
  onStart: () => void
}) {
  return (
    <div ref={viewportRef} className="browser-viewport relative flex flex-1 min-w-0 min-h-0 items-stretch justify-stretch overflow-hidden border-0 rounded-none bg-bg-panel">
      {browserPreview && snapshot.phase === 'ready' && snapshot.url && snapshot.url !== 'about:blank' && (
        <iframe
          key={`${snapshot.activeTabId ?? 'tab'}:${snapshot.url}:${previewRevision}`}
          className="browser-preview-frame block w-full h-full flex-1 border-0 bg-white"
          src={browserPreviewUrl(snapshot.url)}
          title={snapshot.title || snapshot.url}
          referrerPolicy="no-referrer"
        />
      )}
      <div className={`browser-empty-state absolute inset-0 flex items-center justify-center flex-col gap-2 w-auto p-[var(--ui-space-7)] border-0 rounded-none text-text-dim bg-bg-panel text-center ${snapshot.phase === 'ready' ? 'invisible pointer-events-none' : ''}`} role="status">
        <div className="browser-empty-mark grid w-[46px] h-[46px] place-items-center mb-2 border border-[color-mix(in_srgb,var(--accent)_42%,var(--border))] rounded-full text-accent bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg-panel))] font-bold text-[22px] font-[family-name:var(--mono)]" aria-hidden="true">◌</div>
        <strong className="text-text text-[15px]">{browserPreview ? '输入网址开始浏览' : '浏览器会话尚未启动'}</strong>
        <span className="max-w-[520px] text-[12px] leading-[1.5]">{browserPreview ? '开发预览加载真实网页；桌面端会切换为嵌入式 WebView2。' : '启动后，完整 WebView 将占据主工作区。'}</span>
        <span className="browser-empty-note mt-2 text-text-placeholder font-[family-name:var(--mono)] text-[10px] leading-[1.5]">{browserPreview ? 'preview runtime · 不伪装成桌面 WebView' : 'WebView2 子进程由 Browser Sheet 生命周期管理'}</span>
        <div className="browser-actions flex gap-[var(--ui-space-2)] mt-[var(--ui-space-4)]"><button type="button" className="template-apply" onClick={onStart} disabled={snapshot.phase === 'starting'}>新建标签</button></div>
      </div>
    </div>
  )
}
