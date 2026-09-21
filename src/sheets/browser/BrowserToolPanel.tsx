import { Send, X } from 'lucide-react'
import type { BrowserLibrary, ConsoleEntry } from '../../domains/browser/browserLibrary.ts'
import type { BrowserAgentOp, BrowserAgentSettingsView } from '../../infrastructure/tauri/browserAgentClient.ts'
import type { BrowserPageSnapshot, BrowserToolId } from './browserSheetTypes.ts'

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
  browserPreview: boolean
  agentSettings: BrowserAgentSettingsView | null
  agentClaim: { mode?: string; holder?: string | null } | null
  agentOps: BrowserAgentOp[]
  agentBlocklistDraft: string
  onAgentBlocklistDraftChange: (value: string) => void
  agentBusy: boolean
  agentError: string | null
  pageChangedAt: number | null
  askAiDraft: string
  onAskAiDraftChange: (value: string) => void
  canSendAskAi: boolean
  onRefreshAgent: () => void
  onAgentModeChange: (mode: 'off' | 'readonly' | 'full') => void
  onAgentAdFilterChange: (enabled: boolean) => void
  onAgentBlocklistSave: () => void
  onBuildAskAi: () => void
  onSendAskAi: () => void
}

export function BrowserToolPanel({
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
  browserPreview,
  agentSettings,
  agentClaim,
  agentOps,
  agentBlocklistDraft,
  onAgentBlocklistDraftChange,
  agentBusy,
  agentError,
  pageChangedAt,
  askAiDraft,
  onAskAiDraftChange,
  canSendAskAi,
  onRefreshAgent,
  onAgentModeChange,
  onAgentAdFilterChange,
  onAgentBlocklistSave,
  onBuildAskAi,
  onSendAskAi,
}: BrowserToolPanelProps) {
  const labels: Record<BrowserToolId, string> = { history: '历史', bookmarks: '书签', downloads: '下载', console: '控制台', agent: 'Agent' }
  const clearable = activeTool === 'agent' ? 'console' : activeTool
  return (
    <section className="browser-tool-panel flex shrink-0 min-h-0 max-h-[250px] flex-col border-b border-border bg-[color-mix(in_srgb,var(--bg-panel)_94%,transparent)]" aria-label={`${labels[activeTool]}面板`}>
      <header className="browser-tool-panel-head flex min-h-[34px] items-center gap-2 px-2.5 border-b border-border">
        <strong className="text-text text-[12px]">{labels[activeTool]}</strong>
        <div className="browser-tool-panel-actions flex items-center gap-[5px] ml-auto">
          {activeTool === 'console' && <button type="button" className="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={onInspect}>刷新快照</button>}
          {activeTool === 'agent' && <button type="button" className="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={onRefreshAgent} disabled={agentBusy}>刷新状态</button>}
          <button type="button" className="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={() => onClear(clearable)} disabled={library[clearable].length === 0}>清空</button>
          <button type="button" className="browser-panel-close grid w-6 place-items-center p-0 min-h-6 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer hover:border-accent hover:text-text" onClick={onClose} aria-label={`关闭${labels[activeTool]}面板`}><X size={14} /></button>
        </div>
      </header>

      {activeTool === 'history' && (
        <div className="browser-library-list min-h-0 overflow-auto py-1 px-2">
          {library.history.length === 0 && <p className="browser-library-empty mx-1 mt-3.5 mb-0 text-text-placeholder text-[11px]">暂无浏览记录</p>}
          {library.history.map(entry => (
            <button key={entry.id} type="button" className="browser-library-item flex w-full flex-col gap-0.5 my-0.5 px-[7px] py-1.5 border border-transparent text-text bg-transparent cursor-pointer text-left hover:border-border hover:bg-bg-hover" onClick={() => onNavigate(entry.url)}>
              <span className="browser-library-item-title overflow-hidden text-text text-[11px] text-ellipsis whitespace-nowrap">{entry.title || entry.url}</span>
              <span className="browser-library-item-meta overflow-hidden text-text-dim font-[family-name:var(--mono)] text-[10px] text-ellipsis whitespace-nowrap">{entry.url} · {formatBrowserTime(entry.visitedAt)}</span>
            </button>
          ))}
        </div>
      )}

      {activeTool === 'bookmarks' && (
        <div className="browser-library-list min-h-0 overflow-auto py-1 px-2">
          {library.bookmarks.length === 0 && <p className="browser-library-empty mx-1 mt-3.5 mb-0 text-text-placeholder text-[11px]">暂无书签；点击地址栏旁的书签图标添加。</p>}
          {library.bookmarks.map(entry => (
            <button key={entry.id} type="button" className="browser-library-item flex w-full flex-col gap-0.5 my-0.5 px-[7px] py-1.5 border border-transparent text-text bg-transparent cursor-pointer text-left hover:border-border hover:bg-bg-hover" onClick={() => onNavigate(entry.url)}>
              <span className="browser-library-item-title overflow-hidden text-text text-[11px] text-ellipsis whitespace-nowrap">{entry.title || entry.url}</span>
              <span className="browser-library-item-meta overflow-hidden text-text-dim font-[family-name:var(--mono)] text-[10px] text-ellipsis whitespace-nowrap">{entry.url} · {formatBrowserTime(entry.createdAt)}</span>
            </button>
          ))}
        </div>
      )}

      {activeTool === 'downloads' && (
        <div className="browser-download-panel min-h-0 overflow-hidden">
          <form className="browser-download-form flex gap-[5px] pt-1.5 px-2 pb-[3px]" onSubmit={event => { event.preventDefault(); if (downloadUrlInput.trim()) { onDownload(downloadUrlInput); onDownloadUrlInputChange('') } }}>
            <input
              value={downloadUrlInput}
              onChange={event => onDownloadUrlInputChange(event.target.value)}
              placeholder="粘贴 http(s) 下载地址"
              aria-label="下载地址"
              inputMode="url"
              className="min-w-0 flex-1 h-[26px] px-[7px] border border-border rounded-[3px] text-text bg-bg-input font-[family-name:var(--mono)] text-[10px] focus:border-accent focus:outline-none"
            />
            <button type="submit" className="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" disabled={!downloadUrlInput.trim()}>开始</button>
          </form>
          {pageSnapshot?.links?.some(link => link.download && typeof link.href === 'string') && (
            <div className="browser-discovered-downloads">
              <span className="browser-library-caption block mx-1 mt-[5px] mb-0.5 text-text-dim text-[10px]">当前页面的下载链接</span>
              {pageSnapshot.links.filter(link => link.download && typeof link.href === 'string').map((link, index) => (
                <button key={`${link.href}-${index}`} type="button" className="browser-library-item flex w-full flex-col gap-0.5 my-0.5 px-[7px] py-1.5 border border-transparent text-text bg-transparent cursor-pointer text-left hover:border-border hover:bg-bg-hover" onClick={() => onDownload(link.href!, link.downloadName ?? undefined)}>
                  <span className="browser-library-item-title overflow-hidden text-text text-[11px] text-ellipsis whitespace-nowrap">{link.text || link.downloadName || link.href}</span>
                  <span className="browser-library-item-meta overflow-hidden text-text-dim font-[family-name:var(--mono)] text-[10px] text-ellipsis whitespace-nowrap">{link.href}</span>
                </button>
              ))}
            </div>
          )}
          <div className="browser-library-list min-h-0 overflow-auto py-1 px-2">
            {library.downloads.length === 0 && <p className="browser-library-empty mx-1 mt-3.5 mb-0 text-text-placeholder text-[11px]">暂无下载记录</p>}
            {library.downloads.map(entry => (
              <div key={entry.id} className="browser-library-item browser-download-entry flex w-full flex-col gap-0.5 my-0.5 px-[7px] py-1.5 border border-transparent text-text bg-transparent cursor-pointer text-left hover:border-border hover:bg-bg-hover">
                <span className="browser-library-item-title overflow-hidden text-text text-[11px] text-ellipsis whitespace-nowrap">{entry.filename || entry.url}</span>
                <span className={`browser-library-item-meta overflow-hidden text-text-dim font-[family-name:var(--mono)] text-[10px] text-ellipsis whitespace-nowrap ${entry.status === 'started' ? 'text-[var(--tool-ok)]' : 'text-[var(--tool-err,var(--danger))]'}`} data-status={entry.status}>{entry.status === 'started' ? '已发起' : '失败'} · {entry.url} · {formatBrowserTime(entry.startedAt)}</span>
                {entry.error && <span className="browser-library-item-error text-[var(--tool-err,var(--danger))]">{entry.error}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTool === 'console' && (
        <div className="browser-console-panel min-h-0 overflow-hidden">
          <div className="browser-console-toolbar flex items-center gap-2.5 py-1 px-2 text-text-dim text-[10px]">
            <label className="inline-flex items-center gap-1">级别
              <select className="h-[23px] border border-border rounded-[3px] text-text bg-bg-input text-[10px]" value={consoleFilter} onChange={event => onConsoleFilterChange(event.target.value as 'all' | ConsoleEntry['level'])} aria-label="控制台级别">
                <option value="all">全部</option><option value="info">信息</option><option value="success">成功</option><option value="error">错误</option>
              </select>
            </label>
            {pageSnapshot && <span className="browser-console-snapshot ml-auto text-text-placeholder font-[family-name:var(--mono)]">快照：{pageSnapshot.links?.length ?? 0} links · {(pageSnapshot.text?.length ?? 0).toLocaleString()} chars</span>}
          </div>
          <div className="browser-console-list min-h-0 overflow-auto py-1 px-2">
            {library.console.filter(entry => consoleFilter === 'all' || entry.level === consoleFilter).length === 0 && <p className="browser-library-empty mx-1 mt-3.5 mb-0 text-text-placeholder text-[11px]">暂无操作记录</p>}
            {library.console.filter(entry => consoleFilter === 'all' || entry.level === consoleFilter).map(entry => (
              <div key={entry.id} className={`browser-console-entry grid grid-cols-[76px_130px_minmax(0,1fr)] gap-[7px] items-baseline py-1 px-[5px] border-b border-[color-mix(in_srgb,var(--border)_55%,transparent)] text-[10px] ${entry.level === 'error' ? 'text-[var(--tool-err,var(--danger))]' : entry.level === 'success' ? 'text-[var(--tool-ok)]' : ''}`} data-level={entry.level}>
                <span className="browser-console-time text-text-placeholder font-[family-name:var(--mono)] text-[9px]">{formatBrowserTime(entry.at)}</span>
                <code className="text-text font-[family-name:var(--mono)] text-[10px]">{entry.command}</code>
                {entry.detail && <span className="browser-console-detail min-w-0 overflow-hidden text-text-dim text-ellipsis whitespace-nowrap">{entry.detail}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {activeTool === 'agent' && (
        <div className="browser-agent-panel min-h-0 overflow-auto py-1.5 px-2" aria-label="Agent 浏览器授权面板">
          {browserPreview && <p className="browser-agent-note mx-1 mb-2 text-text-placeholder text-[10px]">开发预览不支持 Agent 浏览器控制；请在桌面端使用。</p>}
          {agentError && <p className="browser-agent-error mx-1 mb-2 text-[var(--tool-err,var(--danger))] text-[10px]" role="alert">{agentError}</p>}
          {pageChangedAt && <p className="browser-agent-page-changed mx-1 mb-2 text-[var(--tool-run)] text-[10px]">页面已更新（{formatBrowserTime(pageChangedAt)}）——Agent 下一次操作前建议重新 browser_snapshot。</p>}
          <div className="browser-agent-access grid grid-cols-[70px_minmax(0,1fr)] items-center gap-2 mb-2">
            <label className="text-text-dim text-[10px]" htmlFor="browser-agent-mode">授权档位</label>
            <select
              id="browser-agent-mode"
              className="h-[26px] border border-border rounded-[3px] text-text bg-bg-input text-[10px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              value={agentSettings?.defaultMode ?? 'readonly'}
              onChange={event => onAgentModeChange(event.target.value as 'off' | 'readonly' | 'full')}
              disabled={agentBusy || !agentSettings}
              aria-label="Agent 浏览器授权档位"
            >
              <option value="off">off · 关闭（不注入工具）</option>
              <option value="readonly">readonly · 只读（默认）</option>
              <option value="full">full · 完整（写操作）</option>
            </select>
          </div>
          <div className="browser-agent-adfilter grid grid-cols-[70px_minmax(0,1fr)] items-center gap-2 mb-2">
            <label className="text-text-dim text-[10px]" htmlFor="browser-agent-adfilter">广告过滤</label>
            <span className="inline-flex items-center gap-2">
              <input
                id="browser-agent-adfilter"
                type="checkbox"
                className="accent-accent cursor-pointer disabled:cursor-not-allowed"
                checked={agentSettings?.adFilterEnabled ?? true}
                onChange={event => onAgentAdFilterChange(event.target.checked)}
                disabled={agentBusy || !agentSettings}
              />
              <span className="text-text-placeholder text-[10px]">拦截广告/追踪请求（CDP）</span>
            </span>
          </div>
          <div className="browser-agent-blocklist mb-2">
            <label className="browser-library-caption block mx-1 mb-0.5 text-text-dim text-[10px]" htmlFor="browser-agent-blocklist">Agent 导航域名黑名单（每行一个，后缀匹配）</label>
            <textarea
              id="browser-agent-blocklist"
              className="min-h-[52px] w-full resize-y border border-border rounded-[3px] p-[6px] text-text bg-bg-input font-[family-name:var(--mono)] text-[10px] focus:border-accent focus:outline-none disabled:opacity-40"
              value={agentBlocklistDraft}
              onChange={event => onAgentBlocklistDraftChange(event.target.value)}
              placeholder={'bank.cn\ninternal.corp'}
              disabled={agentBusy || !agentSettings}
            />
            <div className="flex items-center gap-2 mt-1">
              <button type="button" className="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={onAgentBlocklistSave} disabled={agentBusy || !agentSettings}>保存黑名单</button>
              <span className="text-text-placeholder text-[10px]">当前 claim：{agentClaim?.holder ? <code className="text-text font-[family-name:var(--mono)]">{agentClaim.holder}</code> : '空闲（写操作由首个请求的会话自动持有；你的手动操作立即抢占）'}</span>
            </div>
          </div>
          <div className="browser-agent-askai mb-2 border-t border-border pt-2">
            <span className="browser-library-caption block mx-1 mb-1 text-text-dim text-[10px]">问 AI 关于当前页面</span>
            <div className="flex items-center gap-2 mb-1">
              <button type="button" className="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={onBuildAskAi}>生成上下文</button>
              <button type="button" className="browser-agent-askai-send inline-flex min-h-6 items-center gap-1 px-[7px] py-0.5 border border-accent rounded-[3px] text-text bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:bg-bg-hover disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={onSendAskAi} disabled={!askAiDraft.trim() || agentBusy}><Send size={11} />{canSendAskAi ? '发送到当前会话' : '复制到剪贴板'}</button>
            </div>
            <textarea
              className="min-h-[64px] w-full resize-y border border-border rounded-[3px] p-[6px] text-text bg-bg-input font-[family-name:var(--mono)] text-[10px] focus:border-accent focus:outline-none"
              value={askAiDraft}
              onChange={event => onAskAiDraftChange(event.target.value)}
              placeholder="点击「生成上下文」把当前页面文本组装为会话消息；确认内容后发送。"
              aria-label="问 AI 消息草稿"
            />
          </div>
          <div className="browser-agent-ops border-t border-border pt-2">
            <span className="browser-library-caption block mx-1 mb-0.5 text-text-dim text-[10px]">最近 Agent 操作（新到旧）</span>
            {agentOps.length === 0 && <p className="browser-library-empty mx-1 mt-2 mb-0 text-text-placeholder text-[11px]">暂无记录</p>}
            {[...agentOps].reverse().map((op, index) => (
              <div key={`${String(op.atMs ?? 0)}-${String(index)}`} className={`browser-agent-op grid grid-cols-[70px_90px_minmax(0,1fr)] gap-[7px] items-baseline py-1 px-[5px] border-b border-[color-mix(in_srgb,var(--border)_55%,transparent)] text-[10px] ${op.outcome === 'ok' ? '' : 'text-[var(--tool-err,var(--danger))]'}`} data-outcome={op.outcome}>
                <span className="text-text-placeholder font-[family-name:var(--mono)] text-[9px]">{typeof op.atMs === 'number' ? formatBrowserTime(op.atMs) : ''}</span>
                <code className="text-text font-[family-name:var(--mono)] text-[10px]">{op.tool}</code>
                <span className="min-w-0 overflow-hidden text-text-dim text-ellipsis whitespace-nowrap" title={`${String(op.sessionKey ?? '')} ${String(op.summary ?? '')} ${String(op.outcome ?? '')}`}>{op.outcome === 'ok' ? (op.summary || op.outcome) : `${String(op.outcome)}${op.summary ? ` · ${String(op.summary)}` : ''}`}</span>
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
