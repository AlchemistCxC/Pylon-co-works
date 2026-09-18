import { useCallback, useEffect, useRef, useState } from 'react'
import { Database, Search, X } from 'lucide-react'
import { useIdentityStore } from '../../identityStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError.ts'
import { createStandardSwitchAgent, openOwnedSessionTransaction } from '../../application/transactions/openOwnedSessionTransaction'
import PylonMark from '../../components/PylonMark'
import { sessionUiStateSet } from '../../components/chat/sessionUiState'
import { searchAllMessages, type SearchHitUi } from '../../domains/search/searchService'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/**
 * SearchSheetView — 跨会话快照搜索（W3-03）。
 *
 * 扫描本地会话消息快照（复用 messagePersistence key/parse 语义，扫描上限纯常量）；
 * 结果点击 → open agent sheet + selectSession（定位 message id 经 CustomEvent 由
 * ChatView 后续消费）。范围仅本地会话（平台扫描范围为产品未决项，不猜策略）。
 *
 * 样式绞杀（P93）：原 SearchSheet.css 的 utility 化——共享词汇类名（file-main-*、
 * file-section-hint 的基线部分）不再携带，FileSheet 基线值并入最终 utility；
 * `search-sheet-input/search-sidebar-scope/-action/search-result-row` 类名保留为
 * workspace adaptive.css（modern-gui 覆写）锚点。
 */
// #116 子项 2：本壳是 .layout（flex 容器）的直接子项，缺 flex-1 时按内容宽度
// 收缩（实测 528×988，而同排 File/Overview/Runtime/Gateway 都是 1920×988）。
const SHEET = 'search-sheet flex flex-1 min-w-0 overflow-hidden text-text font-[family-name:var(--font)]'
// #154：左列几何（宽度 / 竖直分割线 / 折叠可见性）归布局层的 .sidebar——本类只管内容样式。
// 原先自带 w/basis/border-r 与 max-[720px] 局部断点，是「标题栏分割线与左列分割线错位」的
// 成因之一（每个 Sheet 各自决定宽度）。
const SIDEBAR = 'sidebar search-sidebar flex flex-col py-[var(--ui-space-5)] px-3 bg-[color-mix(in_srgb,var(--bg-panel)_72%,transparent)]'
const SIDEBAR_HEAD = 'grid gap-2 mx-2 mb-4 pb-4 border-b border-border'
const HEAD_SPAN = 'text-accent font-bold text-[10px] leading-[1] font-[family-name:var(--mono)] tracking-[.14em]'
const HEAD_STRONG = 'text-[15px]'
const SCOPE = 'search-sidebar-scope grid grid-cols-[18px_minmax(0,1fr)_auto] items-center min-h-[var(--ui-control-standard)] px-3 mb-3 text-text border border-[color-mix(in_srgb,var(--accent)_32%,var(--border))] bg-[color-mix(in_srgb,var(--accent)_8%,transparent)] text-[12px]'
const SCOPE_SVG = 'text-accent'
const SCOPE_SMALL = 'text-text-dim font-[family-name:var(--mono)] text-[10px]'
const SIDEBAR_ACTION = 'search-sidebar-action grid grid-cols-[18px_minmax(0,1fr)_auto] items-center min-h-[var(--ui-control-standard)] px-3 w-full text-text-dim border-0 border-l-[3px] border-l-transparent bg-transparent text-left cursor-pointer font-[family-name:var(--font)] text-[12px] enabled:hover:text-text enabled:hover:border-border enabled:hover:border-l-accent enabled:hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-40 disabled:cursor-not-allowed'
const SIDEBAR_SUMMARY = 'grid gap-1 mt-auto pt-4 px-3 border-t border-border text-text-dim'
const SUMMARY_STRONG = 'text-text font-bold text-[24px] leading-[1] font-[family-name:var(--mono)]'
const SUMMARY_SPAN = 'text-[10px]'
const MAIN = 'flex-1 min-w-0 max-w-[1120px] py-[var(--ui-space-6)] px-[clamp(var(--ui-space-5),4vw,var(--ui-space-7))] overflow-y-auto max-[720px]:py-[var(--ui-space-5)] max-[720px]:px-4'
const KICKER = 'font-mono text-[11px] font-[650] tracking-[.12em] text-accent'
const MAIN_TITLE = 'mt-1 mb-2 text-text text-[24px] font-bold tracking-[-.025em]'
const DESCRIPTION = 'm-0 mb-5 text-text-dim text-[12px] leading-[1.5] [overflow-wrap:anywhere]'
const INPUT = 'search-sheet-input block w-[min(100%,640px)] h-[var(--ui-control-emphasis)] mb-4 px-4 border border-border rounded-none text-text bg-bg-input font-[family-name:var(--font)] text-[13px] outline-none transition-[border-color,box-shadow,background-color] duration-[120ms] hover:border-border-focus focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent placeholder:text-text-placeholder'
const HINT = 'w-[min(100%,640px)] m-0 mb-4 px-4 py-3 border border-dashed border-border rounded-none text-text-dim text-[12px] leading-[1.5]'
const EMPTY = 'search-empty-state sheet-empty-state w-[min(100%,960px)] mt-4 flex flex-col items-center gap-2 py-[var(--ui-space-7)] px-[var(--ui-space-5)] border border-dashed border-border rounded-none text-text-dim bg-[color-mix(in_srgb,var(--bg-panel)_72%,transparent)] text-center'
const EMPTY_STRONG = 'text-text text-[14px]'
const EMPTY_SPAN = 'max-w-[520px] text-[12px] leading-[1.5]'
const EMPTY_MARK = 'sheet-empty-mark grid w-[44px] h-[44px] place-items-center mb-2 border border-[color-mix(in_srgb,var(--accent)_38%,var(--border))] rounded-none text-accent bg-[color-mix(in_srgb,var(--accent)_8%,var(--bg-panel))] font-bold text-[22px] font-[family-name:var(--mono)] [&>svg]:block'
const RESULTS = 'search-sheet-results grid gap-2 w-[min(100%,960px)] m-0 p-0 list-none'
const RESULTS_LI = 'border border-border rounded-none bg-bg-panel transition-[border-color,background-color] duration-[120ms] hover:border-border-focus hover:bg-bg-hover'
const ROW = 'search-result-row grid grid-cols-[minmax(140px,220px)_minmax(0,1fr)] gap-4 items-center w-full min-h-[var(--ui-control-emphasis)] px-3 py-2 border-0 border-l-[3px] border-l-transparent rounded-none text-text bg-transparent text-left cursor-pointer font-[family-name:var(--font)] transition-[background-color,border-color] duration-[120ms] hover:border-l-accent hover:bg-bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'
const ROW_PATH = 'search-result-path min-w-0 overflow-hidden text-accent font-[family-name:var(--mono)] text-[11px] truncate'
const ROW_TEXT = 'min-w-0 overflow-hidden text-text-dim text-[12px] leading-[1.5] truncate'

export default function SearchSheetView({ sheet: _sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchHitUi[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const sessions = useIdentityStore(s => s.sessions)
  // I14-W4：request generation——旧响应不覆盖新 query
  const generationRef = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const errorKey = useCallback((needle: string) => `search:${_sheet.id}:${needle}`, [_sheet.id])

  useEffect(() => {
    const needle = query.trim()
    if (!needle) { setResults([]); setTruncated(false); setLoading(false); setSearchError(null); return }
    const generation = ++generationRef.current
    setLoading(true)
    setSearchError(null)
    searchAllMessages(needle)
      .then(({ results: found, truncated: cut }) => {
        if (generationRef.current !== generation) return
        setResults(found)
        setTruncated(cut)
        setLoading(false)
        resolveRuntimeErrors({ key: errorKey(needle) })
      })
      .catch(error => {
        if (generationRef.current !== generation) return
        setLoading(false)
        setSearchError(error instanceof Error ? error.message : String(error))
        reportRuntimeError('搜索会话消息', error, undefined, {
          key: errorKey(needle),
          scope: { kind: 'sheet', id: _sheet.id },
          source: 'search.sheet',
          recovery: { kind: 'open-runtime-log', sheetId: _sheet.id },
        })
      })
  }, [query, errorKey, _sheet.id])

  const openResult = async (result: SearchHitUi) => {
    const session = sessions.find(item => item.id === result.sessionId)
    if (!session) return
    // FE-AUD-003：持久导航意图（按 sessionId+messageId），ChatView 消息恢复后消费并清除——
    // 不依赖瞬时 CustomEvent（先发事件后挂载 ChatView 会丢）
    sessionUiStateSet(result.sessionId, 'pendingMessageLocation', { sessionId: result.sessionId, messageId: result.messageId })
    // I01-W4：owner-aware 打开（Session owner 而非 active Agent）；切换失败保持原页面
    const opened = await openOwnedSessionTransaction(
      { targetId: session.id },
      {
        getSessions: () => useIdentityStore.getState().sessions,
        activeAgent: useIdentityStore.getState().activeAgent,
        addSession: (name, agentId) => useIdentityStore.getState().addSession(name, agentId),
        updateSession: (id, partial) => useIdentityStore.getState().updateSession(id, partial),
        switchAgent: createStandardSwitchAgent(id => useIdentityStore.getState().agents.find(a => a.id === id)?.name),
        selectSession: id => ctx.selectSession(id),
        openAgentSheet: ({ title, agentId }) => ctx.openSheet({ kind: 'agent', title, agentId }),
      },
    )
    if (!opened.ok) {
      // 切换失败保持原页面（不 selectSession 不开 sheet），仅可见提示
      reportRuntimeError('打开会话', opened.message, undefined, {
        key: `search-open:${_sheet.id}:${session.id}`,
        scope: { kind: 'sheet', id: _sheet.id },
        source: 'search.sheet',
        recovery: { kind: 'open-runtime-log', sheetId: _sheet.id },
      })
    }
  }

  return (
    <div className={SHEET}>
      <aside className={SIDEBAR} aria-label="搜索工具">
          <div className={SIDEBAR_HEAD}><span className={HEAD_SPAN}>SEARCH</span><strong className={HEAD_STRONG}>搜索范围</strong></div>
          <div className={SCOPE}><Database size={15} aria-hidden="true" className={SCOPE_SVG} /><span>本地会话快照</span><small className={SCOPE_SMALL}>{sessions.length}</small></div>
          <button type="button" className={SIDEBAR_ACTION} onClick={() => inputRef.current?.focus()}><Search size={15} aria-hidden="true" /><span>输入关键词</span></button>
          <button type="button" className={SIDEBAR_ACTION} disabled={!query} onClick={() => { setQuery(''); inputRef.current?.focus() }}><X size={15} aria-hidden="true" /><span>清除查询</span></button>
          <div className={SIDEBAR_SUMMARY}><strong className={SUMMARY_STRONG}>{loading ? '…' : results.length}</strong><span className={SUMMARY_SPAN}>当前结果</span>{truncated && <small className={SUMMARY_SPAN}>已达显示上限</small>}</div>
        </aside>
      <main className={MAIN}>
        <div className={KICKER}>SEARCH</div>
        <h2 className={MAIN_TITLE}>跨会话搜索</h2>
        <p className={DESCRIPTION}>在本地会话快照中查找消息，点击结果返回对应会话。</p>
        <input
          ref={inputRef}
          className={INPUT}
          type="search"
          placeholder="搜索全部本地会话消息…"
          value={query}
          onChange={event => setQuery(event.target.value)}
          aria-label="跨会话搜索"
        />
        {loading && <p className={HINT} role="status">搜索中…</p>}
        {searchError && <p className="search-error-reference" role="status">搜索失败，详情见右下角错误中心</p>}
        {truncated && <p className={HINT} role="status">结果过多已截断（上限 {50} 条）</p>}
        <ul className={RESULTS}>
          {results.map(result => (
            <li key={`${result.sessionId}:${result.messageId}`} className={RESULTS_LI}>
              <button type="button" className={ROW} onClick={() => openResult(result)}>
                <span className={ROW_PATH}>{result.sessionId}</span>
                <span className={ROW_TEXT}>{result.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
        {query.trim() && results.length === 0 && !searchError && (
          <div className={EMPTY} role="status">
            <div className={EMPTY_MARK}><PylonMark size={30} title="Pylon 搜索" /></div>
            <strong className={EMPTY_STRONG}>没有匹配结果</strong>
            <span className={EMPTY_SPAN}>换一个关键词，或检查本地会话消息是否已入库。</span>
          </div>
        )}
        {!query.trim() && (
          <div className={EMPTY} role="status">
            <div className={EMPTY_MARK}><PylonMark size={30} title="Pylon 搜索" /></div>
            <strong className={EMPTY_STRONG}>搜索本地会话消息</strong>
            <span className={EMPTY_SPAN}>输入关键词后，从结果回到对应会话与消息位置。</span>
          </div>
        )}
      </main>
    </div>
  )
}
