import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useIdentityStore } from '../../identityStore'
import { useWorkspaceStore } from '../../workspaceStore'
import { toAgentContextKey } from '../../agentContext'
import { useSessionUiState} from '../chat/sessionUiState'
import { searchValuesMatchQuery } from '../chat/messageSearchIndex'
import MessageSearchBar from '../chat/MessageSearchBar'
import type { SheetContext } from '../../workspace-sheets/sheetTypes'
import type { SheetRecord } from '../../workspace-sheets/sheetTypes'
import type { SessionUiKey } from '../../domains/workbench/sessionUiStore.ts'
import type { WorkbenchHostPort } from '../../renderers/solid-workbench/workbenchHostPort.ts'
import {
  getActiveWorkbenchHostPort,
  subscribeActiveWorkbenchHostPort,
} from '../../sheets/agent-workbench/activeWorkbenchHostPort.ts'

function useActiveWorkbenchHostPort(sheetId: string): WorkbenchHostPort | undefined {
  return useSyncExternalStore(
    useCallback(listener => subscribeActiveWorkbenchHostPort(sheetId, listener), [sheetId]),
    useCallback(() => getActiveWorkbenchHostPort(sheetId), [sheetId]),
    () => undefined,
  )
}

function useHostSessionUiState<T>(hostPort: WorkbenchHostPort | undefined, bindingKey: string | null, key: SessionUiKey, fallback: T): T {
  return useSyncExternalStore(
    useCallback(listener => bindingKey === null
      ? () => {}
      : hostPort?.sessionUi.subscribe(key, listener) ?? (() => {}), [bindingKey, hostPort, key]),
    useCallback(() => bindingKey === null
      ? fallback
      : hostPort?.sessionUi.get(key, fallback) ?? fallback, [bindingKey, fallback, hostPort, key]),
    () => fallback,
  )
}

function useHostDocument(hostPort: WorkbenchHostPort | undefined) {
  return useSyncExternalStore(
    useCallback(listener => hostPort?.document.subscribe(listener) ?? (() => {}), [hostPort]),
    useCallback(() => hostPort?.document.getSnapshot(), [hostPort]),
    () => undefined,
  )
}

/**
 * AgentContextPanel — agent 右栏（W2-12，F2-F）。
 *
 * 搜索模式：Renderer Suite 存在时消费当前 Sheet 发布的 Workbench Host Port，
 * 从 canonical document 计算命中并写 namespaced SessionUiPort；legacy ChatView
 * 仍通过原 sessionUiState/controller 回退，切换渲染模式不丢现有搜索能力。
 * 关联模式：touchedFiles 正向（会话→文件）。
 */
export default function AgentContextPanel({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const sessionId = ctx.activeSession
  const source = ctx.sessionSource(sessionId)
  const hostPort = useActiveWorkbenchHostPort(sheet.id)
  const hostDocument = useHostDocument(hostPort)
  const [legacySearchQuery, setLegacySearchQuery] = useSessionUiState(sessionId, 'search-query', '')
  const [legacySearchIndex, setLegacySearchIndex] = useSessionUiState(sessionId, 'search-index', 0)
  const searchQuery = useHostSessionUiState(hostPort, sessionId, 'search-query', legacySearchQuery)
  const searchIndex = useHostSessionUiState(hostPort, sessionId, 'search-index', legacySearchIndex)
  const [mode, setMode] = useState<'search' | 'relations'>('search')
  const initializedHostBinding = useRef(false)
  const previousHostPort = useRef(hostPort)
  const previousSessionId = useRef(sessionId)

  useEffect(() => {
    const firstBinding = !initializedHostBinding.current
    initializedHostBinding.current = true
    const hostChanged = previousHostPort.current !== hostPort
    const sessionChanged = previousSessionId.current !== sessionId
    previousHostPort.current = hostPort
    previousSessionId.current = sessionId
    // Only bridge legacy state when a renderer Host appears for the same
    // session. A session switch must start from the new owner namespace.
    if (hostPort && sessionId && (firstBinding || hostChanged) && !sessionChanged) {
      if (hostPort.sessionUi.get<string | undefined>('search-query', undefined) === undefined) {
        hostPort.sessionUi.set('search-query', legacySearchQuery)
      }
      if (hostPort.sessionUi.get<number | undefined>('search-index', undefined) === undefined) {
        hostPort.sessionUi.set('search-index', legacySearchIndex)
      }
    }
  }, [hostPort, legacySearchIndex, legacySearchQuery, sessionId])

  // P52 D4：controller legacy 消息回退已退役——搜索命中只来自当前 Sheet 发布的
  // Workbench Host Port（canonical document）；无 Host Port 时无命中。
  const matches = useMemo(() => {
    if (!searchQuery.trim() || !hostPort) return []
    return (hostDocument?.messages ?? []).filter(message => searchValuesMatchQuery([
      message.source.provider,
      message.content,
      message.parts,
    ], searchQuery))
  }, [hostDocument, hostPort, searchQuery])
  const setSearchQuery = (value: string) => {
    setLegacySearchQuery(value)
    hostPort?.sessionUi.set('search-query', value)
  }
  const setSearchIndex = (valueOrUpdater: number | ((previous: number) => number)) => {
    const next = typeof valueOrUpdater === 'function' ? valueOrUpdater(searchIndex) : valueOrUpdater
    setLegacySearchIndex(next)
    hostPort?.sessionUi.set('search-index', next)
  }
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
