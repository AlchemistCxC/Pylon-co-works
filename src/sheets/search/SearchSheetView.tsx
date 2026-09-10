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
 */
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
    <div className="search-sheet">
      {!ctx.sidebarCollapsed && (
        <aside className="search-sidebar" aria-label="搜索工具">
          <div className="search-sidebar-head"><span>SEARCH</span><strong>搜索范围</strong></div>
          <div className="search-sidebar-scope"><Database size={15} aria-hidden="true" /><span>本地会话快照</span><small>{sessions.length}</small></div>
          <button type="button" className="search-sidebar-action" onClick={() => inputRef.current?.focus()}><Search size={15} aria-hidden="true" /><span>输入关键词</span></button>
          <button type="button" className="search-sidebar-action" disabled={!query} onClick={() => { setQuery(''); inputRef.current?.focus() }}><X size={15} aria-hidden="true" /><span>清除查询</span></button>
          <div className="search-sidebar-summary"><strong>{loading ? '…' : results.length}</strong><span>当前结果</span>{truncated && <small>已达显示上限</small>}</div>
        </aside>
      )}
      <main className="search-main">
        <div className="file-main-kicker">SEARCH</div>
        <h2 className="file-main-title">跨会话搜索</h2>
        <p className="search-sheet-description">在本地会话快照中查找消息，点击结果返回对应会话。</p>
        <input
          ref={inputRef}
          className="runtime-filter-input search-sheet-input"
          type="search"
          placeholder="搜索全部本地会话消息…"
          value={query}
          onChange={event => setQuery(event.target.value)}
          aria-label="跨会话搜索"
        />
        {loading && <p className="file-section-hint" role="status">搜索中…</p>}
        {searchError && <p className="file-section-hint search-error-reference" role="status">搜索失败，详情见右下角错误中心</p>}
        {truncated && <p className="file-section-hint" role="status">结果过多已截断（上限 {50} 条）</p>}
        <ul className="search-result-list search-sheet-results">
          {results.map(result => (
            <li key={`${result.sessionId}:${result.messageId}`}>
              <button type="button" className="search-result-row" onClick={() => openResult(result)}>
                <span className="search-result-path">{result.sessionId}</span>
                <span className="search-result-text">{result.snippet}</span>
              </button>
            </li>
          ))}
        </ul>
        {query.trim() && results.length === 0 && !searchError && (
          <div className="sheet-empty-state search-empty-state" role="status">
            <div className="sheet-empty-mark"><PylonMark size={30} title="Pylon 搜索" /></div>
            <strong>没有匹配结果</strong>
            <span>换一个关键词，或检查本地会话消息是否已入库。</span>
          </div>
        )}
        {!query.trim() && (
          <div className="sheet-empty-state search-empty-state" role="status">
            <div className="sheet-empty-mark"><PylonMark size={30} title="Pylon 搜索" /></div>
            <strong>搜索本地会话消息</strong>
            <span>输入关键词后，从结果回到对应会话与消息位置。</span>
          </div>
        )}
      </main>
    </div>
  )
}
