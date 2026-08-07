import { useEffect, useMemo, useState } from 'react'
import { useIdentityStore } from '../../identityStore'
import PylonMark from '../../components/PylonMark'
import { sessionUiStateSet } from '../../components/chat/sessionUiState'
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
    // FE-AUD-003：持久导航意图（按 sessionId+messageId），ChatView 消息恢复后消费并清除——
    // 不依赖瞬时 CustomEvent（先发事件后挂载 ChatView 会丢）
    sessionUiStateSet(result.sessionId, 'pendingMessageLocation', { sessionId: result.sessionId, messageId: result.messageId })
    ctx.selectSession(session.id)
    ctx.openSheet({ kind: 'agent', title: session.name, agentId: activeAgent })
  }

  return (
    <div className="search-sheet">
      <div className="file-main-kicker">SEARCH</div>
      <h2 className="file-main-title">跨会话搜索</h2>
      <p className="search-sheet-description">在本地会话快照中查找消息，点击结果返回对应会话。</p>
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
      {query.trim() && results.length === 0 && (
        <div className="sheet-empty-state search-empty-state" role="status">
          <div className="sheet-empty-mark"><PylonMark size={30} title="Pylon 搜索" /></div>
          <strong>没有匹配结果</strong>
          <span>换一个关键词，或检查本地会话是否已经保存消息快照。</span>
        </div>
      )}
      {!query.trim() && (
        <div className="sheet-empty-state search-empty-state" role="status">
          <div className="sheet-empty-mark"><PylonMark size={30} title="Pylon 搜索" /></div>
          <strong>搜索本地会话消息</strong>
          <span>输入关键词后，从结果回到对应会话与消息位置。</span>
        </div>
      )}
    </div>
  )
}
