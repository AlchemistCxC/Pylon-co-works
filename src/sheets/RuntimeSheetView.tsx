import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useRuntimeStore } from '../runtimeStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../runtimeError'
import { useDiagnosticErrors, useErrorHistory, type ErrorEntry } from '../errorCenter.ts'
import { createRuntimeClient } from '../infrastructure/tauri/runtimeClient'
import { normalizeRuntimeLogEntry, normalizeRuntimeLogList, normalizeStartupDiagnostics, type StartupDiagnostics } from '../infrastructure/tauri/runtimeLogContracts.ts'
import { collectRuntimeLogFacets, deriveCrashMarkers, filterRuntimeLogs, mergeRuntimeLogs, type CrashMarker, type RuntimeLogEntry, type RuntimeLogFilter } from '../domains/runtime/runtimeLogs.ts'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'

/**
 * RuntimeSheetView — 运行日志观察面（W1-08，§6 定稿）。
 *
 * list 回放 + pylon:runtime-log 增量（按 id 去重、固定上限）；左栏 source/level/search
 * 纯过滤；主区日志流 + clear；详情主区展开（无右栏）。unmount 清理 listener。
 */
export default function RuntimeSheetView({ sheet: _sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const [entries, setEntries] = useState<RuntimeLogEntry[]>([])
  const [filter, setFilter] = useState<RuntimeLogFilter>({})
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [diagnostics, setDiagnostics] = useState<StartupDiagnostics | null>(null)
  const [markers, setMarkers] = useState<CrashMarker[]>([])
  const agentStatuses = useRuntimeStore(state => state.agentStatuses)
  const diagnosticErrors = useDiagnosticErrors()
  const errorHistory = useErrorHistory()
  const runtimeErrorKey = useCallback((operation: string) => `runtime-sheet:${_sheet.id}:${operation}`, [_sheet.id])
  // W1-09：crashed/error → 本地诊断 marker（按 agentId:status:generation 去重）
  useEffect(() => {
    setMarkers(previous => deriveCrashMarkers(previous, agentStatuses))
  }, [agentStatuses])

  useEffect(() => {
    // 浏览器模式 mock 后端已装（demo）：invoke/listen 经假 __TAURI_INTERNALS__ 返回 mock 数据
    let disposed = false
    createRuntimeClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).startupDiagnostics().then(raw => {
      if (!disposed) {
        setDiagnostics(normalizeStartupDiagnostics(raw))
        resolveRuntimeErrors({ key: runtimeErrorKey('读取启动诊断') })
      }
    }).catch(error => {
      if (!disposed) reportRuntimeError('读取启动诊断', error, undefined, {
        key: runtimeErrorKey('读取启动诊断'),
        scope: { kind: 'sheet', id: _sheet.id },
        source: 'runtime.sheet',
        recovery: { kind: 'open-runtime-log', sheetId: _sheet.id },
      })
    })
    createRuntimeClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).listRuntimeLogs().then(raw => {
      if (!disposed) {
        setEntries(previous => mergeRuntimeLogs(previous, normalizeRuntimeLogList(raw)))
        resolveRuntimeErrors({ key: runtimeErrorKey('读取运行日志') })
      }
    }).catch(error => {
      if (!disposed) reportRuntimeError('读取运行日志', error, undefined, {
        key: runtimeErrorKey('读取运行日志'),
        scope: { kind: 'sheet', id: _sheet.id },
        source: 'runtime.sheet',
        recovery: { kind: 'open-runtime-log', sheetId: _sheet.id },
      })
    })
    // B2：挂载时开 live 推送、卸载时关（ringbuffer pull 兜底不受影响）
    const runtimeClient = createRuntimeClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
    void runtimeClient.setRuntimeLogLive(true).catch(() => {})
    const unlisten = listen<unknown>('pylon:runtime-log', event => {
      if (disposed) return
      const entry = normalizeRuntimeLogEntry(event.payload)
      if (entry) setEntries(previous => mergeRuntimeLogs(previous, [entry]))
    })
    return () => {
      disposed = true
      void runtimeClient.setRuntimeLogLive(false).catch(() => {})
      unlisten.then(stop => stop()).catch(() => {})
    }
  }, [_sheet.id, runtimeErrorKey])

  const { levels, sources } = useMemo(() => collectRuntimeLogFacets(entries), [entries])
  const filtered = useMemo(() => filterRuntimeLogs(entries, filter), [entries, filter])
  const recentErrorHistory = useMemo(() => errorHistory.slice(0, 20), [errorHistory])

  const clear = async () => {
    try {
      await createRuntimeClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).clearRuntimeLogs()
      setEntries([])
      resolveRuntimeErrors({ key: runtimeErrorKey('清空运行日志') })
    } catch (error) {
      reportRuntimeError('清空运行日志', error, undefined, {
        key: runtimeErrorKey('清空运行日志'),
        scope: { kind: 'sheet', id: _sheet.id },
        source: 'runtime.sheet',
        recovery: { kind: 'open-runtime-log', sheetId: _sheet.id },
      })
    }
  }

  return (
    <div className="runtime-sheet">
      {!ctx.sidebarCollapsed && <aside className="runtime-sidebar">
        <div className="runtime-sidebar-head">
          <div className="runtime-sidebar-kicker">OBSERVE</div>
          <div className="runtime-sidebar-title">日志筛选</div>
          <div className="runtime-sidebar-summary">{filtered.length} / {entries.length} 条</div>
        </div>
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
      </aside>}
      <main className="runtime-main">
        {diagnostics && (
          <div className="runtime-diagnostics">
            <div className="runtime-diagnostics-title">启动诊断</div>
            <div className="runtime-diagnostics-row">
              <DiagnosticChip label="agent" entry={diagnostics.agentConfig} />
              <DiagnosticChip label="gateway" entry={diagnostics.gatewayConfig} />
              <DiagnosticChip label="prism" entry={diagnostics.prism} />
              {diagnostics.configSource && <span className="runtime-diagnostics-source">config: {diagnostics.configSource.fileName || diagnostics.configSource.kind}</span>}
              {diagnostics.hermesProfile && (
                <span className={`runtime-diagnostics-source ${diagnostics.hermesProfile.resolved ? '' : 'runtime-diag-bad'}`}
                  title={`可用 profiles: ${diagnostics.hermesProfile.profiles.join(', ') || '（未探测到）'}`}>
                  hermes: {diagnostics.hermesProfile.configured ? `profile=${diagnostics.hermesProfile.configured}` : '未配置 profile'}
                  {diagnostics.hermesProfile.resolved ? ' ✓' : ' ✗'}
                </span>
              )}
            </div>
          </div>
        )}
        {markers.length > 0 && (
          <div className="runtime-markers">
            <div className="runtime-markers-title">本地诊断标记（非后端日志）</div>
            {markers.map(marker => (
              <div key={marker.key} className="runtime-marker">
                <span className="runtime-marker-status">{marker.status}</span>
                <span className="runtime-marker-agent">{marker.agentId}</span>
                {marker.detail && <span className="runtime-marker-detail">{marker.detail}</span>}
              </div>
            ))}
          </div>
        )}
        {(diagnosticErrors.length > 0 || recentErrorHistory.length > 0) && (
          <RuntimeErrorFacts diagnostics={diagnosticErrors} history={recentErrorHistory} />
        )}
        <div className="runtime-count">
          <span>实时日志</span>
          <span>{filtered.length} 条</span>
        </div>
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
                {entry.category && <span className="runtime-log-chip">{entry.category}</span>}
                <span className="runtime-log-message">{entry.message}</span>
              </button>
              {expandedId === entry.id && hasLogDetail(entry) && (
                <div className="runtime-log-detail">
                  {(entry.category || entry.code || entry.recoverable !== undefined || entry.userActionRequired !== undefined || entry.rawAvailable !== undefined) && (
                    <div className="runtime-log-tags">
                      {entry.category && <span className="runtime-log-chip">{entry.category}</span>}
                      {entry.code && <span className="runtime-log-chip runtime-log-code">{entry.code}</span>}
                      {entry.rawAvailable !== undefined && <span className="runtime-log-chip">{entry.rawAvailable ? '原文可用' : '占位文本'}</span>}
                      {entry.recoverable !== undefined && <span className="runtime-log-chip">{entry.recoverable ? '可重试' : '不可重试'}</span>}
                      {entry.userActionRequired !== undefined && <span className="runtime-log-chip">{entry.userActionRequired ? '需用户操作' : '无需用户操作'}</span>}
                    </div>
                  )}
                  {entry.correlation && (
                    <div className="runtime-log-section">
                      <div className="runtime-log-section-title">身份（OBS-02）</div>
                      <div className="runtime-log-field"><code>agentId</code> = {entry.correlation.agentId}</div>
                      <div className="runtime-log-field"><code>source</code> = {entry.correlation.source}</div>
                      <div className="runtime-log-field"><code>generation</code> = {entry.correlation.clientGeneration}</div>
                      {entry.correlation.provider && <div className="runtime-log-field"><code>provider</code> = {entry.correlation.provider}</div>}
                      {entry.correlation.localSessionId && <div className="runtime-log-field"><code>localSessionId</code> = {entry.correlation.localSessionId}</div>}
                      {entry.correlation.remoteSessionId && <div className="runtime-log-field"><code>remoteSessionId</code> = {entry.correlation.remoteSessionId}</div>}
                      {entry.correlation.periId && <div className="runtime-log-field"><code>periId</code> = {entry.correlation.periId}</div>}
                      {entry.correlation.requestId && <div className="runtime-log-field"><code>requestId</code> = {entry.correlation.requestId}</div>}
                      {entry.correlation.toolCallId && <div className="runtime-log-field"><code>toolCallId</code> = {entry.correlation.toolCallId}</div>}
                    </div>
                  )}
                  {entry.fields && Object.keys(entry.fields).length > 0 && (
                    <div className="runtime-log-section">
                      <div className="runtime-log-section-title">字段</div>
                      {Object.entries(entry.fields).map(([key, value]) => (
                        <div key={key} className="runtime-log-field"><code>{key}</code> = {value}</div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </main>
    </div>
  )
}

function RuntimeErrorFacts({ diagnostics, history }: { diagnostics: readonly ErrorEntry[]; history: readonly ErrorEntry[] }) {
  return (
    <section className="runtime-error-facts" aria-label="应用错误事实">
      <div className="runtime-error-facts-head">
        <strong>应用错误事实</strong>
        <span>{diagnostics.length > 0 ? `${diagnostics.length} 条待诊断` : '无待诊断'} · 保留最近 {history.length} 条</span>
      </div>
      <ul className="runtime-error-facts-list">
        {history.map(entry => (
          <li key={entry.id} className={`runtime-error-fact state-${entry.state}`}>
            <div className="runtime-error-fact-summary">
              <strong>{entry.action}</strong>
              <span>{entry.message}</span>
              <small>{entry.state === 'active' ? '待处理' : entry.state === 'resolved' ? '已恢复' : '已隐藏'}</small>
            </div>
            <details>
              <summary>详细信息</summary>
              <div className="runtime-error-fact-detail">
                {entry.code && <div><code>code</code> = {entry.code}</div>}
                {entry.source && <div><code>source</code> = {entry.source}</div>}
                {entry.scope && <div><code>scope</code> = {entry.scope.kind}:{entry.scope.id}</div>}
                {entry.technicalMessage && <pre>{entry.technicalMessage}</pre>}
                {entry.metadata && <pre>{safeErrorJson(entry.metadata)}</pre>}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </section>
  )
}

function safeErrorJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2)
    if (typeof serialized !== 'string') return '[详情不可用]'
    return serialized.length <= 8_192 ? serialized : `${serialized.slice(0, 8_192)}\n…（详情已截断）`
  } catch { return '[详情不可用]' }
}

function formatTime(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

/** LOG-03：详情区是否可展开——增量字段 / correlation / fields 任一存在即展开。 */
function hasLogDetail(entry: RuntimeLogEntry): boolean {
  return Boolean(
    entry.code ||
    entry.category ||
    entry.recoverable !== undefined ||
    entry.userActionRequired !== undefined ||
    entry.rawAvailable !== undefined ||
    entry.correlation ||
    (entry.fields && Object.keys(entry.fields).length > 0),
  )
}


function DiagnosticChip({ label, entry }: { label: string; entry: { status: string; message?: string } | null }) {
  if (!entry) return null
  const ok = entry.status === 'ready'
  return (
    <span className={`runtime-diag-chip ${ok ? 'runtime-diag-ok' : 'runtime-diag-bad'}`} title={entry.message || ''}>
      {label}: {entry.status}
    </span>
  )
}
