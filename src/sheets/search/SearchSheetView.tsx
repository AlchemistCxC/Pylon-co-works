import { useEffect, useMemo, useState } from 'react'
import { useIdentityStore } from '../../identityStore'
import { isMessageSnapshotKey, snapshotSearch, type SnapshotSearchResult } from '../../domains/search/snapshotSearch.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import './SearchSheet.css'

/**
 * SearchSheetView — 跨会话快照搜索（W3-03）。
 *
 * 扫描本地会话消息快照（复用 messagePersistence key/parse 语义，扫描上限纯常量）；
 * 结果点击 → open agent sheet + selectSession（定位 message id 经 CustomEvent 由
 * ChatView 后续消费）。范围仅本地会话（平台扫描范围为产品未决项，不猜策略）。
 */
export default function SearchSheetView({ sheet: _sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SnapshotSearchResult[]>([])
  const [truncated, setTruncated] = useState(false)
  const sessions = useIdentityStore(s => s.sessions)
  const activeAgent = useIdentityStore(s => s.activeAgent) || 'peri'

  const snapshotKeys = useMemo(() => {
    if (typeof localStorage === 'undefined') return []
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key && isMessageSnapshotKey(key)) keys.push(key)
    }
    return keys
  }, [])

  useEffect(() => {
    if (!query.trim()) { setResults([]); setTruncated(false); return }
    const { results: found, truncated: cut } = snapshotSearch(localStorage, query, snapshotKeys)
    setResults(found)
    setTruncated(cut)
  }, [query, snapshotKeys])

  const openResult = (result: SnapshotSearchResult) => {
    const session = sessions.find(item => item.id === result.sessionId)
    if (!session) return
    // 定位 message id：CustomEvent 供 ChatView 消费（滚动/高亮）
    window.dispatchEvent(new CustomEvent('pylon:locate-message', { detail: { sessionId: result.sessionId, messageId: result.messageId } }))
    ctx.selectSession(session.id)
    ctx.openSheet({ kind: 'agent', title: session.name, agentId: activeAgent })
  }

  return (
    <div className="search-sheet">
      <input
        className="runtime-filter-input search-sheet-input"
        type="search"
        placeholder="搜索全部本地会话消息…"
        value={query}
        onChange={event => setQuery(event.target.value)}
        aria-label="跨会话搜索"
      />
      {truncated && <p className="file-section-hint" role="status">结果过多已截断（扫描上限为常量）</p>}
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
      {query.trim() && results.length === 0 && <p className="file-section-hint">无匹配</p>}
    </div>
  )
}
