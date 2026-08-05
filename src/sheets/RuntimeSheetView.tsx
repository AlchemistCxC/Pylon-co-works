import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { IS_TAURI } from '../infrastructure/tauri/env'
import { reportRuntimeError } from '../runtimeError'
import { normalizeRuntimeLogEntry, normalizeRuntimeLogList } from '../infrastructure/tauri/runtimeLogContracts.ts'
import { collectRuntimeLogFacets, filterRuntimeLogs, mergeRuntimeLogs, type RuntimeLogEntry, type RuntimeLogFilter } from '../domains/runtime/runtimeLogs.ts'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'
import './RuntimeSheetView.css'

/**
 * RuntimeSheetView — 运行日志观察面（W1-08，§6 定稿）。
 *
 * list 回放 + pylon:runtime-log 增量（按 id 去重、固定上限）；左栏 source/level/search
 * 纯过滤；主区日志流 + clear；详情主区展开（无右栏）。unmount 清理 listener。
 */
export default function RuntimeSheetView({ sheet: _sheet, ctx: _ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const [entries, setEntries] = useState<RuntimeLogEntry[]>([])
  const [filter, setFilter] = useState<RuntimeLogFilter>({})
  const [expandedId, setExpandedId] = useState<number | null>(null)

  useEffect(() => {
    if (!IS_TAURI) return
    let disposed = false
    invoke<unknown>('list_runtime_logs').then(raw => {
      if (!disposed) setEntries(previous => mergeRuntimeLogs(previous, normalizeRuntimeLogList(raw)))
    }).catch(error => reportRuntimeError('读取运行日志', error))
    const unlisten = listen<unknown>('pylon:runtime-log', event => {
      if (disposed) return
      const entry = normalizeRuntimeLogEntry(event.payload)
      if (entry) setEntries(previous => mergeRuntimeLogs(previous, [entry]))
    })
    return () => {
      disposed = true
      unlisten.then(stop => stop()).catch(() => {})
    }
  }, [])

  const { levels, sources } = useMemo(() => collectRuntimeLogFacets(entries), [entries])
  const filtered = useMemo(() => filterRuntimeLogs(entries, filter), [entries, filter])

  const clear = async () => {
    try {
      await invoke('clear_runtime_logs')
      setEntries([])
    } catch (error) {
      reportRuntimeError('清空运行日志', error)
    }
  }

  return (
    <div className="runtime-sheet">
      <aside className="runtime-sidebar">
        <div className="runtime-filter">
          <label className="runtime-filter-label">级别</label>
          <select className="runtime-filter-select" value={filter.level || ''} onChange={event => setFilter(f => ({ ...f, level: event.target.value || undefined }))}>
            <option value="">全部</option>
            {levels.map(level => <option key={level} value={level}>{level}</option>)}
          </select>
          <label className="runtime-filter-label">来源</label>
          <select className="runtime-filter-select" value={filter.source || ''} onChange={event => setFilter(f => ({ ...f, source: event.target.value || undefined }))}>
            <option value="">全部</option>
            {sources.map(source => <option key={source} value={source}>{source}</option>)}
          </select>
          <label className="runtime-filter-label">搜索</label>
          <input className="runtime-filter-input" type="search" placeholder="搜索日志…"
            value={filter.search || ''} onChange={event => setFilter(f => ({ ...f, search: event.target.value || undefined }))} />
          <button type="button" className="runtime-clear" onClick={clear}>清空日志</button>
        </div>
      </aside>
      <main className="runtime-main">
        <div className="runtime-count">{filtered.length} 条日志</div>
        <ul className="runtime-log-list">
          {filtered.map(entry => (
            <li key={entry.id}>
              <button
                type="button"
                className={`runtime-log-row runtime-log-${entry.level}`}
                onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
              >
                <span className="runtime-log-id">{entry.id}</span>
                <span className="runtime-log-level">{entry.level}</span>
                <span className="runtime-log-source">{entry.source || '—'}</span>
                <span className="runtime-log-time">{formatTime(entry.timestamp)}</span>
                <span className="runtime-log-message">{entry.message}</span>
              </button>
              {expandedId === entry.id && entry.fields && Object.keys(entry.fields).length > 0 && (
                <div className="runtime-log-detail">
                  {Object.entries(entry.fields).map(([key, value]) => (
                    <div key={key} className="runtime-log-field"><code>{key}</code> = {value}</div>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}

function formatTime(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}
