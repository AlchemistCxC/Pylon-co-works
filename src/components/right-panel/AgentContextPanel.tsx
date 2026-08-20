import { useMemo, useState } from 'react'
import { useIdentityStore } from '../../identityStore'
import { useWorkspaceStore } from '../../workspaceStore'
import { toAgentContextKey } from '../../agentContext'
import { useSessionUiState} from '../chat/sessionUiState'
import { useChatRuntimeSnapshot } from '../chat/useChatRuntimeSnapshot'
import { messageMatchesQuery } from '../chat/messageSearchIndex'
import { getChatController } from '../chat/chatEventController'
import MessageSearchBar from '../chat/MessageSearchBar'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'

/**
 * AgentContextPanel — agent 右栏（W2-12，F2-F）。
 *
 * 搜索模式：驱动 ChatView 的 useMessageSearch 共享状态（sessionUiState 同 key——
 * hook 行为不变，匹配/滚动定位仍在 ChatView），本栏展示输入/计数/前后导航；
 * 消息快照经 handle.getMessages 读（W2-12 访问器）。关联模式：touchedFiles
 * 正向（会话→文件）。
 */
export default function AgentContextPanel({ ctx }: { ctx: SheetContext }) {
  const sessionId = ctx.activeSession
  const source = ctx.sessionSource(sessionId)
  const [searchQuery, setSearchQuery] = useSessionUiState(sessionId, 'search-query', '')
  const [searchIndex, setSearchIndex] = useSessionUiState(sessionId, 'search-index', 0)
  const [mode, setMode] = useState<'search' | 'relations'>('search')

  // FE-AUD-012：横向订阅消息版本戳——消息 append 立即进入右栏搜索计数（不再只读一次）。
  // version 是必要依赖（变化时重读消息），eslint 误判为多余（组件已因 version 重渲染）
  const { version } = useChatRuntimeSnapshot(source)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const messages = useMemo(() => (source ? getChatController()?.getMessages(source) ?? [] : []), [source, version])
  const matches = useMemo(() => {
    if (!searchQuery.trim()) return []
    return messages.filter(message => messageMatchesQuery(message, searchQuery))
  }, [messages, searchQuery])
  const moveSearch = (direction: 1 | -1) => {
    if (matches.length === 0) return
    setSearchIndex(index => (index + direction + matches.length) % matches.length)
  }
  // zustand v5 useStore 的 selector 返回值即 useSyncExternalStore 快照：`?? []` 每次返回
  // 新数组 → Object.is 不等 → forceStoreRerender 死循环。选整个 record（引用稳定），派生留组件体。
  // I01-W3：touchedFiles 按 AgentContextKey（agentId+source）隔离读取
  const touchedFilesRecord = useWorkspaceStore(s => s.touchedFiles)
  // CR-002：经 useIdentityStore selector 订阅（getState 不经订阅不响应变更）
  const touchedSession = useIdentityStore(state => sessionId
    ? state.sessions.find(item => item.id === sessionId)
    : undefined)
  const touchedContext = touchedSession && source
    ? { agentId: touchedSession.agentId, source: touchedSession.source }
    : null
  const touchedFiles = touchedContext ? touchedFilesRecord[toAgentContextKey(touchedContext)] ?? [] : []

  return (
    <div className="context-panel-contribution">
      <div className="context-panel-subnav">
        <button type="button" className={`context-panel-mode ${mode === 'search' ? 'active' : ''}`} onClick={() => setMode('search')}>搜索</button>
        <button type="button" className={`context-panel-mode ${mode === 'relations' ? 'active' : ''}`} onClick={() => setMode('relations')}>关联</button>
      </div>
      {mode === 'search' && (
        <MessageSearchBar
          query={searchQuery}
          matchIndex={searchIndex}
          matchCount={matches.length}
          onQueryChange={setSearchQuery}
          onPrevious={() => moveSearch(-1)}
          onNext={() => moveSearch(1)}
          onClose={() => { setSearchQuery(''); setSearchIndex(0) }}
        />
      )}
      {mode === 'relations' && (
        <div className="agent-relations">
          <div className="file-section-title">关联文件</div>
          {touchedFiles.length === 0 ? (
            <p className="file-section-hint">agent 尚未改动文件</p>
          ) : (
            <ul className="search-result-list">
              {touchedFiles.map(file => (
                <li key={`${file.path}:${file.at}`}>
                  <span className="search-result-path">{file.path}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
