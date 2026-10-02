/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js'
import { LucideIcon } from '../../components/LucideIcon.solid.tsx'
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

/**
 * 工具面板（#228 批次 D 从 BrowserSheetView.tsx 纯搬移；历史/书签/下载/控制台/Agent 五区）。
 * #515 批7：React → Solid 实体（BrowserSheetView.solid 直连）；DOM/class/aria 逐字节保持。
 * 改写点登记：className→class；数组 map→For；`&&` 条件→Show；受控文本输入
 * （input/textarea）onChange→onInput（select/checkbox 沿用 onChange，同仓 Solid 先例）；
 * lucide-react 具名图标→LucideIcon（X 已在表，Send 已按文件头约定登记映射表）；
 * htmlFor→for（Solid 属性名，DOM 输出同为 for）。
 */
export function BrowserToolPanel(props: BrowserToolPanelProps) {
  const labels: Record<BrowserToolId, string> = { history: '历史', bookmarks: '书签', downloads: '下载', console: '控制台', agent: 'Agent' }
  const clearable = () => (props.activeTool === 'agent' ? 'console' : props.activeTool)
  return (
    <section class="browser-tool-panel flex shrink-0 min-h-0 max-h-[250px] flex-col border-b border-border bg-[color-mix(in_srgb,var(--bg-panel)_94%,transparent)]" aria-label={`${labels[props.activeTool]}面板`}>
      <header class="browser-tool-panel-head flex min-h-[34px] items-center gap-2 px-2.5 border-b border-border">
        <strong class="text-text text-[12px]">{labels[props.activeTool]}</strong>
        <div class="browser-tool-panel-actions flex items-center gap-[5px] ml-auto">
          <Show when={props.activeTool === 'console'}><button type="button" class="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={props.onInspect}>刷新快照</button></Show>
          <Show when={props.activeTool === 'agent'}><button type="button" class="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={props.onRefreshAgent} disabled={props.agentBusy}>刷新状态</button></Show>
          <button type="button" class="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={() => props.onClear(clearable())} disabled={props.library[clearable()].length === 0}>清空</button>
          <button type="button" class="browser-panel-close grid w-6 place-items-center p-0 min-h-6 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer hover:border-accent hover:text-text" onClick={props.onClose} aria-label={`关闭${labels[props.activeTool]}面板`}><LucideIcon name="X" size={14} /></button>
        </div>
      </header>

      <Show when={props.activeTool === 'history'}>
        <div class="browser-library-list min-h-0 overflow-auto py-1 px-2">
          <Show when={props.library.history.length === 0}><p class="browser-library-empty mx-1 mt-3.5 mb-0 text-text-placeholder text-[11px]">暂无浏览记录</p></Show>
          <For each={props.library.history}>
            {entry => (
              <button type="button" class="browser-library-item flex w-full flex-col gap-0.5 my-0.5 px-[7px] py-1.5 border border-transparent text-text bg-transparent cursor-pointer text-left hover:border-border hover:bg-bg-hover" onClick={() => props.onNavigate(entry.url)}>
                <span class="browser-library-item-title overflow-hidden text-text text-[11px] text-ellipsis whitespace-nowrap">{entry.title || entry.url}</span>
                <span class="browser-library-item-meta overflow-hidden text-text-dim font-[family-name:var(--mono)] text-[10px] text-ellipsis whitespace-nowrap">{entry.url} · {formatBrowserTime(entry.visitedAt)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.activeTool === 'bookmarks'}>
        <div class="browser-library-list min-h-0 overflow-auto py-1 px-2">
          <Show when={props.library.bookmarks.length === 0}><p class="browser-library-empty mx-1 mt-3.5 mb-0 text-text-placeholder text-[11px]">暂无书签；点击地址栏旁的书签图标添加。</p></Show>
          <For each={props.library.bookmarks}>
            {entry => (
              <button type="button" class="browser-library-item flex w-full flex-col gap-0.5 my-0.5 px-[7px] py-1.5 border border-transparent text-text bg-transparent cursor-pointer text-left hover:border-border hover:bg-bg-hover" onClick={() => props.onNavigate(entry.url)}>
                <span class="browser-library-item-title overflow-hidden text-text text-[11px] text-ellipsis whitespace-nowrap">{entry.title || entry.url}</span>
                <span class="browser-library-item-meta overflow-hidden text-text-dim font-[family-name:var(--mono)] text-[10px] text-ellipsis whitespace-nowrap">{entry.url} · {formatBrowserTime(entry.createdAt)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.activeTool === 'downloads'}>
        <div class="browser-download-panel min-h-0 overflow-hidden">
          <form class="browser-download-form flex gap-[5px] pt-1.5 px-2 pb-[3px]" onSubmit={event => { event.preventDefault(); if (props.downloadUrlInput.trim()) { props.onDownload(props.downloadUrlInput); props.onDownloadUrlInputChange('') } }}>
            <input
              value={props.downloadUrlInput}
              onInput={event => props.onDownloadUrlInputChange(event.currentTarget.value)}
              placeholder="粘贴 http(s) 下载地址"
              aria-label="下载地址"
              inputMode="url"
              class="min-w-0 flex-1 h-[26px] px-[7px] border border-border rounded-[3px] text-text bg-bg-input font-[family-name:var(--mono)] text-[10px] focus:border-accent focus:outline-none"
            />
            <button type="submit" class="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" disabled={!props.downloadUrlInput.trim()}>开始</button>
          </form>
          <Show when={props.pageSnapshot?.links?.some(link => link.download && typeof link.href === 'string')}>
            <div class="browser-discovered-downloads">
              <span class="browser-library-caption block mx-1 mt-[5px] mb-0.5 text-text-dim text-[10px]">当前页面的下载链接</span>
              <For each={props.pageSnapshot?.links?.filter(link => link.download && typeof link.href === 'string') ?? []}>
                {link => (
                  <button type="button" class="browser-library-item flex w-full flex-col gap-0.5 my-0.5 px-[7px] py-1.5 border border-transparent text-text bg-transparent cursor-pointer text-left hover:border-border hover:bg-bg-hover" onClick={() => props.onDownload(link.href!, link.downloadName ?? undefined)}>
                    <span class="browser-library-item-title overflow-hidden text-text text-[11px] text-ellipsis whitespace-nowrap">{link.text || link.downloadName || link.href}</span>
                    <span class="browser-library-item-meta overflow-hidden text-text-dim font-[family-name:var(--mono)] text-[10px] text-ellipsis whitespace-nowrap">{link.href}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <div class="browser-library-list min-h-0 overflow-auto py-1 px-2">
            <Show when={props.library.downloads.length === 0}><p class="browser-library-empty mx-1 mt-3.5 mb-0 text-text-placeholder text-[11px]">暂无下载记录</p></Show>
            <For each={props.library.downloads}>
              {entry => (
                <div class="browser-library-item browser-download-entry flex w-full flex-col gap-0.5 my-0.5 px-[7px] py-1.5 border border-transparent text-text bg-transparent cursor-pointer text-left hover:border-border hover:bg-bg-hover">
                  <span class="browser-library-item-title overflow-hidden text-text text-[11px] text-ellipsis whitespace-nowrap">{entry.filename || entry.url}</span>
                  <span class={`browser-library-item-meta overflow-hidden text-text-dim font-[family-name:var(--mono)] text-[10px] text-ellipsis whitespace-nowrap ${entry.status === 'started' ? 'text-[var(--tool-ok)]' : 'text-[var(--tool-err,var(--danger))]'}`} data-status={entry.status}>{entry.status === 'started' ? '已发起' : '失败'} · {entry.url} · {formatBrowserTime(entry.startedAt)}</span>
                  <Show when={entry.error}><span class="browser-library-item-error text-[var(--tool-err,var(--danger))]">{entry.error}</span></Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={props.activeTool === 'console'}>
        <div class="browser-console-panel min-h-0 overflow-hidden">
          <div class="browser-console-toolbar flex items-center gap-2.5 py-1 px-2 text-text-dim text-[10px]">
            <label class="inline-flex items-center gap-1">级别
              <select class="h-[23px] border border-border rounded-[3px] text-text bg-bg-input text-[10px]" value={props.consoleFilter} onChange={event => props.onConsoleFilterChange(event.currentTarget.value as 'all' | ConsoleEntry['level'])} aria-label="控制台级别">
                <option value="all">全部</option><option value="info">信息</option><option value="success">成功</option><option value="error">错误</option>
              </select>
            </label>
            <Show when={props.pageSnapshot}><span class="browser-console-snapshot ml-auto text-text-placeholder font-[family-name:var(--mono)]">快照：{props.pageSnapshot?.links?.length ?? 0} links · {(props.pageSnapshot?.text?.length ?? 0).toLocaleString()} chars</span></Show>
          </div>
          <div class="browser-console-list min-h-0 overflow-auto py-1 px-2">
            <Show when={props.library.console.filter(entry => props.consoleFilter === 'all' || entry.level === props.consoleFilter).length === 0}><p class="browser-library-empty mx-1 mt-3.5 mb-0 text-text-placeholder text-[11px]">暂无操作记录</p></Show>
            <For each={props.library.console.filter(entry => props.consoleFilter === 'all' || entry.level === props.consoleFilter)}>
              {entry => (
                <div class={`browser-console-entry grid grid-cols-[76px_130px_minmax(0,1fr)] gap-[7px] items-baseline py-1 px-[5px] border-b border-[color-mix(in_srgb,var(--border)_55%,transparent)] text-[10px] ${entry.level === 'error' ? 'text-[var(--tool-err,var(--danger))]' : entry.level === 'success' ? 'text-[var(--tool-ok)]' : ''}`} data-level={entry.level}>
                  <span class="browser-console-time text-text-placeholder font-[family-name:var(--mono)] text-[9px]">{formatBrowserTime(entry.at)}</span>
                  <code class="text-text font-[family-name:var(--mono)] text-[10px]">{entry.command}</code>
                  <Show when={entry.detail}><span class="browser-console-detail min-w-0 overflow-hidden text-text-dim text-ellipsis whitespace-nowrap">{entry.detail}</span></Show>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={props.activeTool === 'agent'}>
        <div class="browser-agent-panel min-h-0 overflow-auto py-1.5 px-2" aria-label="Agent 浏览器授权面板">
          <Show when={props.browserPreview}><p class="browser-agent-note mx-1 mb-2 text-text-placeholder text-[10px]">开发预览不支持 Agent 浏览器控制；请在桌面端使用。</p></Show>
          <Show when={props.agentError}><p class="browser-agent-error mx-1 mb-2 text-[var(--tool-err,var(--danger))] text-[10px]" role="alert">{props.agentError}</p></Show>
          <Show when={props.pageChangedAt}><p class="browser-agent-page-changed mx-1 mb-2 text-[var(--tool-run)] text-[10px]">页面已更新（{formatBrowserTime(props.pageChangedAt!)}）——Agent 下一次操作前建议重新 browser_snapshot。</p></Show>
          <div class="browser-agent-access grid grid-cols-[70px_minmax(0,1fr)] items-center gap-2 mb-2">
            <label class="text-text-dim text-[10px]" for="browser-agent-mode">授权档位</label>
            <select
              id="browser-agent-mode"
              class="h-[26px] border border-border rounded-[3px] text-text bg-bg-input text-[10px] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              value={props.agentSettings?.defaultMode ?? 'readonly'}
              onChange={event => props.onAgentModeChange(event.currentTarget.value as 'off' | 'readonly' | 'full')}
              disabled={props.agentBusy || !props.agentSettings}
              aria-label="Agent 浏览器授权档位"
            >
              <option value="off">off · 关闭（不注入工具）</option>
              <option value="readonly">readonly · 只读（默认）</option>
              <option value="full">full · 完整（写操作）</option>
            </select>
          </div>
          <div class="browser-agent-adfilter grid grid-cols-[70px_minmax(0,1fr)] items-center gap-2 mb-2">
            <label class="text-text-dim text-[10px]" for="browser-agent-adfilter">广告过滤</label>
            <span class="inline-flex items-center gap-2">
              <input
                id="browser-agent-adfilter"
                type="checkbox"
                class="accent-accent cursor-pointer disabled:cursor-not-allowed"
                checked={props.agentSettings?.adFilterEnabled ?? true}
                onChange={event => props.onAgentAdFilterChange(event.currentTarget.checked)}
                disabled={props.agentBusy || !props.agentSettings}
              />
              <span class="text-text-placeholder text-[10px]">拦截广告/追踪请求（CDP）</span>
            </span>
          </div>
          <div class="browser-agent-blocklist mb-2">
            <label class="browser-library-caption block mx-1 mb-0.5 text-text-dim text-[10px]" for="browser-agent-blocklist">Agent 导航域名黑名单（每行一个，后缀匹配）</label>
            <textarea
              id="browser-agent-blocklist"
              class="min-h-[52px] w-full resize-y border border-border rounded-[3px] p-[6px] text-text bg-bg-input font-[family-name:var(--mono)] text-[10px] focus:border-accent focus:outline-none disabled:opacity-40"
              value={props.agentBlocklistDraft}
              onInput={event => props.onAgentBlocklistDraftChange(event.currentTarget.value)}
              placeholder={'bank.cn\ninternal.corp'}
              disabled={props.agentBusy || !props.agentSettings}
            />
            <div class="flex items-center gap-2 mt-1">
              <button type="button" class="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={props.onAgentBlocklistSave} disabled={props.agentBusy || !props.agentSettings}>保存黑名单</button>
              <span class="text-text-placeholder text-[10px]">当前 claim：{props.agentClaim?.holder ? <code class="text-text font-[family-name:var(--mono)]">{props.agentClaim.holder}</code> : '空闲（写操作由首个请求的会话自动持有；你的手动操作立即抢占）'}</span>
            </div>
          </div>
          <div class="browser-agent-askai mb-2 border-t border-border pt-2">
            <span class="browser-library-caption block mx-1 mb-1 text-text-dim text-[10px]">问 AI 关于当前页面</span>
            <div class="flex items-center gap-2 mb-1">
              <button type="button" class="browser-panel-action min-h-6 px-[7px] py-0.5 border border-border rounded-[3px] text-text-dim bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:text-text disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={props.onBuildAskAi}>生成上下文</button>
              <button type="button" class="browser-agent-askai-send inline-flex min-h-6 items-center gap-1 px-[7px] py-0.5 border border-accent rounded-[3px] text-text bg-bg-input text-[10px] cursor-pointer enabled:hover:border-accent enabled:hover:bg-bg-hover disabled:opacity-[0.45] disabled:cursor-not-allowed" onClick={props.onSendAskAi} disabled={!props.askAiDraft.trim() || props.agentBusy}><LucideIcon name="Send" size={11} />{props.canSendAskAi ? '发送到当前会话' : '复制到剪贴板'}</button>
            </div>
            <textarea
              class="min-h-[64px] w-full resize-y border border-border rounded-[3px] p-[6px] text-text bg-bg-input font-[family-name:var(--mono)] text-[10px] focus:border-accent focus:outline-none"
              value={props.askAiDraft}
              onInput={event => props.onAskAiDraftChange(event.currentTarget.value)}
              placeholder="点击「生成上下文」把当前页面文本组装为会话消息；确认内容后发送。"
              aria-label="问 AI 消息草稿"
            />
          </div>
          <div class="browser-agent-ops border-t border-border pt-2">
            <span class="browser-library-caption block mx-1 mb-0.5 text-text-dim text-[10px]">最近 Agent 操作（新到旧）</span>
            <Show when={props.agentOps.length === 0}><p class="browser-library-empty mx-1 mt-2 mb-0 text-text-placeholder text-[11px]">暂无记录</p></Show>
            <For each={[...props.agentOps].reverse()}>
              {op => (
                <div class={`browser-agent-op grid grid-cols-[70px_90px_minmax(0,1fr)] gap-[7px] items-baseline py-1 px-[5px] border-b border-[color-mix(in_srgb,var(--border)_55%,transparent)] text-[10px] ${op.outcome === 'ok' ? '' : 'text-[var(--tool-err,var(--danger))]'}`} data-outcome={op.outcome}>
                  <span class="text-text-placeholder font-[family-name:var(--mono)] text-[9px]">{typeof op.atMs === 'number' ? formatBrowserTime(op.atMs) : ''}</span>
                  <code class="text-text font-[family-name:var(--mono)] text-[10px]">{op.tool}</code>
                  <span class="min-w-0 overflow-hidden text-text-dim text-ellipsis whitespace-nowrap" title={`${String(op.sessionKey ?? '')} ${String(op.summary ?? '')} ${String(op.outcome ?? '')}`}>{op.outcome === 'ok' ? (op.summary || op.outcome) : `${String(op.outcome)}${op.summary ? ` · ${String(op.summary)}` : ''}`}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
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
