import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { classifyWorkspaceSearchError, normalizeWorkspaceSearchResults, type WorkspaceSearchResult, type WorkspaceSearchSaveStatus } from '../../infrastructure/tauri/workspaceSearchContracts.ts'

/**
 * WorkspaceSearchPanel — 工作区搜索分区（W2-06 桩化）。
 *
 * 只消费正式 workspace_search 命令（不以前端遍历文件冒充搜索）；命令不可用 → 明确
 * 「待后端」阻塞态。结果点击打开 tab（定位行由 W2-08/09 后续增强）。
 */
export default function WorkspaceSearchPanel({ source, onOpenResult }: {
  source: string | null
  onOpenResult: (path: string, line: number) => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<WorkspaceSearchResult[]>([])
  const [status, setStatus] = useState<WorkspaceSearchSaveStatus>({ kind: 'idle' })

  const search = async () => {
    if (!source || !query.trim()) return
    setStatus({ kind: 'searching' })
    try {
      // 契约：workspace_search（待产品侧后端命令）；参数形状以后端实际契约为准
      const raw = await invoke<unknown>('workspace_search', { source, query: query.trim() })
      setResults(normalizeWorkspaceSearchResults(raw))
      setStatus({ kind: 'idle' })
    } catch (error) {
      const classified = classifyWorkspaceSearchError(error)
      setStatus(classified)
      if (classified.kind === 'error') reportRuntimeError('搜索工作区', error)
    }
  }

  return (
    <div className="file-section-panel">
      <div className="file-section-title">搜索</div>
      <input
        className="runtime-filter-input"
        type="search"
        placeholder="搜索文件内容…"
        value={query}
        onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') void search() }}
        aria-label="工作区搜索"
      />
      <button type="button" className="runtime-clear" onClick={() => void search()} disabled={status.kind === 'searching' || !source}>
        {status.kind === 'searching' ? '搜索中…' : '搜索'}
      </button>
      {status.kind === 'blocked' && (
        <p className="file-section-hint" role="status">待后端：workspace_search 命令尚未提供，无法搜索</p>
      )}
      {status.kind === 'error' && <div className="file-tree-error" role="alert">{status.message}</div>}
      {status.kind === 'idle' && results.length > 0 && (
        <ul className="search-result-list">
          {results.map((result, index) => (
            <li key={`${result.path}:${result.line}:${index}`}>
              <button type="button" className="search-result-row" onClick={() => onOpenResult(result.path, result.line)}>
                <span className="search-result-path">{result.path}</span>
                <span className="search-result-line">{result.line}</span>
                <span className="search-result-text">{result.lineText}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
