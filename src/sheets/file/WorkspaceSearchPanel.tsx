import { useState } from 'react'
import { Search } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { classifyWorkspaceSearchError, normalizeWorkspaceSearchResults, type WorkspaceSearchResult, type WorkspaceSearchSaveStatus } from '../../infrastructure/tauri/workspaceSearchContracts.ts'
import FileTypeIcon from './FileTypeIcon'

function highlightedText(text: string, query: string): React.ReactNode {
  const keyword = query.trim()
  if (!keyword) return text
  const lower = text.toLowerCase()
  const needle = keyword.toLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let index = lower.indexOf(needle)
  while (index >= 0) {
    if (index > cursor) parts.push(text.slice(cursor, index))
    parts.push(<mark key={`${index}-${cursor}`}>{text.slice(index, index + keyword.length)}</mark>)
    cursor = index + keyword.length
    index = lower.indexOf(needle, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts
}

/** WorkspaceSearchPanel — 工作区全文搜索与横向结果列表。 */
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
    <div className="file-section-panel file-search-panel">
      <div className="file-search-toolbar">
        <input
          className="file-search-input"
          type="search"
          placeholder="搜索文件内容…"
          value={query}
          onChange={event => setQuery(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') void search() }}
          aria-label="工作区搜索"
        />
        <button type="button" className="file-search-submit" onClick={() => void search()} disabled={status.kind === 'searching' || !source || !query.trim()} aria-label="搜索">
          <Search size={15} />
        </button>
      </div>
      <div className="file-panel-heading"><span>RESULTS</span><span className="file-panel-count">{results.length}</span></div>
      {status.kind === 'blocked' && <p className="file-section-hint" role="status">待后端：workspace_search 命令尚未提供，无法搜索</p>}
      {status.kind === 'error' && <div className="file-tree-error" role="alert">{status.message}</div>}
      {status.kind === 'searching' && <p className="file-section-hint">正在搜索…</p>}
      {status.kind === 'idle' && query.trim() && results.length === 0 && <p className="file-section-hint">没有匹配结果</p>}
      <ul className="search-result-list">
        {results.map((result, index) => {
          const fileName = result.path.split('/').pop() || result.path
          return (
            <li key={`${result.path}:${result.line}:${index}`}>
              <button type="button" className="search-result-row" onClick={() => onOpenResult(result.path, result.line)} title={`${result.path}:${result.line}`}>
                <span className="search-result-file">
                  <FileTypeIcon path={result.path} size={15} />
                  <span>
                    <strong>{fileName}</strong>
                    <small>L{result.line}</small>
                  </span>
                </span>
                <span className="search-result-text">{highlightedText(result.lineText, query)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
