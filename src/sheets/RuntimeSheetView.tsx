import { useCallback, useEffect, useMemo, useState } from 'react'
import { tauriInvokeTransport } from '../infrastructure/acp/tauriTransport.ts'
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
export default function RuntimeSheetView({ sheet: _sheet }: { sheet: SheetRecord; ctx: SheetContext }) {
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
    createRuntimeClient({ invoke: tauriInvokeTransport }).startupDiagnostics().then(raw => {
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
    createRuntimeClient({ invoke: tauriInvokeTransport }).listRuntimeLogs().then(raw => {
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
    const runtimeClient = createRuntimeClient({ invoke: tauriInvokeTransport })
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
      await createRuntimeClient({ invoke: tauriInvokeTransport }).clearRuntimeLogs()
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
    <div className="runtime-sheet flex flex-1 min-w-0 text-text font-[family-name:var(--font)]">
      {/* #154：左列几何（宽度/竖直分割线/折叠可见性）归布局层的 .sidebar；本类只管内容样式。 */}
      <aside className="sidebar runtime-sidebar bg-[color-mix(in_srgb,var(--bg-panel)_70%,transparent)]">
        <div className="runtime-sidebar-head pt-[var(--ui-space-4)] px-[var(--ui-space-3)] pb-[var(--ui-space-3)] border-b border-border">
          <div className="runtime-sidebar-kicker text-accent font-bold text-[10px] leading-none font-[family-name:var(--mono)] tracking-[0.14em] opacity-80">OBSERVE</div>
          <div className="runtime-sidebar-title mt-[var(--ui-space-2)] text-[15px] font-[650]">日志筛选</div>
          <div className="runtime-sidebar-summary mt-[var(--ui-space-1)] text-text-dim text-[11px] leading-[1.4] font-[family-name:var(--mono)]">{filtered.length} / {entries.length} 条</div>
        </div>
        <div className="runtime-filter flex flex-col gap-[var(--ui-space-2)] p-[var(--ui-space-3)]">
          <label className="runtime-filter-label mt-[var(--ui-space-1)] text-[11px] font-semibold text-text-dim">级别</label>
          <select className="runtime-filter-select w-full h-[var(--ui-control-standard)] font-[family-name:var(--font)] text-[13px] text-text bg-bg-input border border-border rounded-none px-[var(--ui-space-3)] outline-none transition-[border-color,box-shadow,background] duration-150 ease-[ease] hover:border-border-focus focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_14%,transparent)]" value={filter.level || ''} onChange={event => setFilter(f => ({ ...f, level: event.target.value || undefined }))}>
            <option value="">全部</option>
            {levels.map(level => <option key={level} value={level}>{level}</option>)}
          </select>
          <label className="runtime-filter-label mt-[var(--ui-space-1)] text-[11px] font-semibold text-text-dim">来源</label>
          <select className="runtime-filter-select w-full h-[var(--ui-control-standard)] font-[family-name:var(--font)] text-[13px] text-text bg-bg-input border border-border rounded-none px-[var(--ui-space-3)] outline-none transition-[border-color,box-shadow,background] duration-150 ease-[ease] hover:border-border-focus focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_14%,transparent)]" value={filter.source || ''} onChange={event => setFilter(f => ({ ...f, source: event.target.value || undefined }))}>
            <option value="">全部</option>
            {sources.map(source => <option key={source} value={source}>{source}</option>)}
          </select>
          <label className="runtime-filter-label mt-[var(--ui-space-1)] text-[11px] font-semibold text-text-dim">搜索</label>
          <input className="runtime-filter-input w-full h-[var(--ui-control-standard)] font-[family-name:var(--font)] text-[13px] text-text bg-bg-input border border-border rounded-none px-[var(--ui-space-3)] outline-none transition-[border-color,box-shadow,background] duration-150 ease-[ease] hover:border-border-focus focus:border-accent focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_14%,transparent)]" type="search" placeholder="搜索日志…"
            value={filter.search || ''} onChange={event => setFilter(f => ({ ...f, search: event.target.value || undefined }))} />
          <button type="button" className="runtime-clear h-[var(--ui-control-standard)] mt-[var(--ui-space-2)] px-[var(--ui-space-3)] text-[13px] font-[family-name:var(--font)] text-text bg-bg-panel border border-border rounded-none cursor-pointer transition-[background,border-color] duration-150 ease-[ease] hover:bg-bg-hover hover:border-border-focus focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" onClick={clear}>清空日志</button>
        </div>
      </aside>
      <main className="runtime-main flex flex-1 min-w-0 flex-col overflow-hidden">
        {diagnostics && (
          <div className="runtime-diagnostics p-[var(--ui-space-3)] border-b border-border bg-[color-mix(in_srgb,var(--bg-panel)_78%,transparent)]">
            <div className="runtime-diagnostics-title text-[12px] font-[650] text-text mb-[var(--ui-space-2)]">启动诊断</div>
            <div className="runtime-diagnostics-row flex gap-[var(--ui-space-2)] items-center flex-wrap">
              <DiagnosticChip label="agent" entry={diagnostics.agentConfig} />
              <DiagnosticChip label="gateway" entry={diagnostics.gatewayConfig} />
              <DiagnosticChip label="prism" entry={diagnostics.prism} />
              {diagnostics.configSource && <span className="runtime-diagnostics-source text-[11px] text-text-dim">config: {diagnostics.configSource.fileName || diagnostics.configSource.kind}</span>}
            </div>
          </div>
        )}
        {markers.length > 0 && (
          <div className="runtime-markers p-[var(--ui-space-3)] border-b border-border bg-[color-mix(in_srgb,var(--danger)_5%,var(--bg-input))]">
            <div className="runtime-markers-title text-[12px] font-[650] text-text mb-[var(--ui-space-2)]">本地诊断标记（非后端日志）</div>
            {markers.map(marker => (
              <div key={marker.key} className="runtime-marker flex gap-[var(--ui-space-2)] font-[family-name:var(--mono)] text-[11px] py-[var(--ui-space-1)]">
                <span className="runtime-marker-status text-[var(--danger,#e5484d)]">{marker.status}</span>
                <span className="runtime-marker-agent text-accent">{marker.agentId}</span>
                {marker.detail && <span className="runtime-marker-detail text-text-dim">{marker.detail}</span>}
              </div>
            ))}
          </div>
        )}
        {(diagnosticErrors.length > 0 || recentErrorHistory.length > 0) && (
          <RuntimeErrorFacts diagnostics={diagnosticErrors} history={recentErrorHistory} />
        )}
        <div className="runtime-count min-h-[var(--ui-control-standard)] flex items-center justify-between px-[var(--ui-space-3)] text-[11px] leading-none font-[family-name:var(--mono)] text-text-dim border-b border-border bg-[color-mix(in_srgb,var(--bg-panel)_46%,transparent)]">
          <span>实时日志</span>
          <span>{filtered.length} 条</span>
        </div>
        <ul className="runtime-log-list list-none m-0 p-0 overflow-y-auto flex-1 bg-[color-mix(in_srgb,var(--global-bg-color)_16%,transparent)]">
          {filtered.map(entry => (
            <li key={entry.id} className="border-b border-b-[color-mix(in_srgb,var(--border)_64%,transparent)]">
              <button
                type="button"
                className={`runtime-log-row runtime-log-${entry.level} flex gap-[var(--ui-space-2)] items-baseline min-h-[30px] w-full text-left px-[var(--ui-space-3)] py-[5px] text-[12px] leading-[1.55] font-[family-name:var(--mono)] text-text bg-transparent border-none cursor-pointer outline-none transition-[background] duration-100 ease-[ease] hover:bg-bg-hover aria-expanded:bg-bg-active aria-expanded:shadow-[inset_3px_0_0_var(--accent)] focus-visible:shadow-[inset_3px_0_0_var(--accent)] focus-visible:bg-bg-hover max-[760px]:flex-wrap ${entry.level === 'error' ? 'text-[var(--danger,#e5484d)]' : entry.level === 'warn' ? 'text-[var(--state-warning,#fbbf24)]' : entry.level === 'debug' || entry.level === 'trace' ? 'text-text-dim' : ''}`}
                onClick={() => setExpandedId(expandedId === entry.id ? null : entry.id)}
              >
                <span className="runtime-log-id text-text-dim w-[3em] basis-[3em] shrink grow-0">{entry.id}</span>
                <span className="runtime-log-level w-[4em] basis-[4em] shrink grow-0 font-bold uppercase">{entry.level}</span>
                {/* #116 子项 3：缺 whitespace-nowrap 时 agent-stderr 会在连字符处断成
                    两行（单元格 19→37px、整行 30→37px），与含下划线不可断行的
                    prism_desktop_lib 同一列两种表现。同文件 runtime-log-chip 已有该 utiliy。 */}
                <span className="runtime-log-source w-[6em] basis-[6em] shrink grow-0 overflow-hidden text-ellipsis whitespace-nowrap">{entry.source || '—'}</span>
                <span className="runtime-log-time text-text-dim w-[8em] basis-[8em] shrink grow-0">{formatTime(entry.timestamp)}</span>
                {entry.category && <span className="runtime-log-chip flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-text-dim border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.category}</span>}
                <span className="runtime-log-message flex-1 min-w-0 [word-break:break-word] max-[760px]:basis-full max-[760px]:[overflow-wrap:anywhere]">{entry.message}</span>
              </button>
              {expandedId === entry.id && hasLogDetail(entry) && (
                <div className="runtime-log-detail mt-[var(--ui-space-1)] mx-[var(--ui-space-3)] mb-[var(--ui-space-2)] py-[var(--ui-space-2)] px-[var(--ui-space-3)] text-[11px] bg-bg-input border border-border rounded-none text-text-dim max-[760px]:[overflow-wrap:anywhere]">
                  {(entry.category || entry.code || entry.recoverable !== undefined || entry.userActionRequired !== undefined || entry.rawAvailable !== undefined) && (
                    <div className="runtime-log-tags flex flex-wrap gap-[var(--ui-space-1)] mb-[var(--ui-space-2)]">
                      {entry.category && <span className="runtime-log-chip flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-text-dim border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.category}</span>}
                      {entry.code && <span className="runtime-log-chip runtime-log-code flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-[var(--danger,#e5484d)] border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.code}</span>}
                      {entry.rawAvailable !== undefined && <span className="runtime-log-chip flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-text-dim border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.rawAvailable ? '原文可用' : '占位文本'}</span>}
                      {entry.recoverable !== undefined && <span className="runtime-log-chip flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-text-dim border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.recoverable ? '可重试' : '不可重试'}</span>}
                      {entry.userActionRequired !== undefined && <span className="runtime-log-chip flex-none max-w-[9em] overflow-hidden text-ellipsis whitespace-nowrap px-[6px] font-[family-name:var(--mono)] text-[10px] leading-[18px] text-text-dim border border-border rounded-none bg-[color-mix(in_srgb,var(--bg-input)_70%,transparent)]">{entry.userActionRequired ? '需用户操作' : '无需用户操作'}</span>}
                    </div>
                  )}
                  {entry.correlation && (
                    <div className="runtime-log-section [&+&]:mt-[var(--ui-space-2)]">
                      <div className="runtime-log-section-title mb-[var(--ui-space-1)] text-[11px] font-[650] text-text">身份（OBS-02）</div>
                      <div className="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>agentId</code> = {entry.correlation.agentId}</div>
                      <div className="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>source</code> = {entry.correlation.source}</div>
                      <div className="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>generation</code> = {entry.correlation.clientGeneration}</div>
                      {entry.correlation.provider && <div className="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>provider</code> = {entry.correlation.provider}</div>}
                      {entry.correlation.localSessionId && <div className="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>localSessionId</code> = {entry.correlation.localSessionId}</div>}
                      {entry.correlation.remoteSessionId && <div className="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>remoteSessionId</code> = {entry.correlation.remoteSessionId}</div>}
                      {entry.correlation.periId && <div className="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>periId</code> = {entry.correlation.periId}</div>}
                      {entry.correlation.requestId && <div className="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>requestId</code> = {entry.correlation.requestId}</div>}
                      {entry.correlation.toolCallId && <div className="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>toolCallId</code> = {entry.correlation.toolCallId}</div>}
                    </div>
                  )}
                  {entry.fields && Object.keys(entry.fields).length > 0 && (
                    <div className="runtime-log-section [&+&]:mt-[var(--ui-space-2)]">
                      <div className="runtime-log-section-title mb-[var(--ui-space-1)] text-[11px] font-[650] text-text">字段</div>
                      {Object.entries(entry.fields).map(([key, value]) => (
                        <div key={key} className="runtime-log-field [&+&]:mt-[var(--ui-space-1)] [&>code]:font-[family-name:var(--mono)] [&>code]:text-accent"><code>{key}</code> = {value}</div>
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
    <section className="runtime-error-facts flex-none max-h-[min(32vh,360px)] overflow-auto p-[var(--ui-space-3)] border-b border-border bg-[color-mix(in_srgb,var(--bg-panel)_78%,transparent)]" aria-label="应用错误事实">
      <div className="runtime-error-facts-head flex items-baseline justify-between gap-[var(--ui-space-2)] mb-[var(--ui-space-2)]">
        <strong>应用错误事实</strong>
        <span className="text-text-dim text-[11px]">{diagnostics.length > 0 ? `${diagnostics.length} 条待诊断` : '无待诊断'} · 保留最近 {history.length} 条</span>
      </div>
      <ul className="runtime-error-facts-list grid gap-[var(--ui-space-1)] list-none m-0 p-0">
        {history.map(entry => (
          <li key={entry.id} className={`runtime-error-fact p-[var(--ui-space-2)] border border-border bg-[color-mix(in_srgb,var(--bg-input)_60%,transparent)] ${entry.state === 'active' ? 'border-s-[3px] border-s-[var(--danger,#e5484d)]' : entry.state === 'resolved' ? 'border-s-[3px] border-s-[var(--tool-ok,#1e9646)]' : entry.state === 'dismissed' ? 'border-s-[3px] border-s-[var(--text-dim)]' : ''}`}>
            <div className="runtime-error-fact-summary grid grid-cols-[auto_minmax(0,1fr)_auto] gap-[var(--ui-space-2)] items-baseline text-[12px]">
              <strong>{entry.action}</strong>
              <span className="min-w-0 [overflow-wrap:anywhere] text-text-dim">{entry.message}</span>
              <small className="text-text-dim whitespace-nowrap">{entry.state === 'active' ? '待处理' : entry.state === 'resolved' ? '已恢复' : '已隐藏'}</small>
            </div>
            <details className="mt-[var(--ui-space-1)] text-[11px]">
              <summary className="cursor-pointer text-text-dim">详细信息</summary>
              <div className="runtime-error-fact-detail grid gap-[var(--ui-space-1)] mt-[var(--ui-space-1)] text-text-dim [overflow-wrap:anywhere]">
                {entry.code && <div><code>code</code> = {entry.code}</div>}
                {entry.source && <div><code>source</code> = {entry.source}</div>}
                {entry.scope && <div><code>scope</code> = {entry.scope.kind}:{entry.scope.id}</div>}
                {entry.technicalMessage && <pre className="max-h-[120px] overflow-auto m-0 p-[var(--ui-space-1)] whitespace-pre-wrap bg-bg-input font-[family-name:var(--mono)] text-[11px] leading-[1.4]">{entry.technicalMessage}</pre>}
                {entry.metadata && <pre className="max-h-[120px] overflow-auto m-0 p-[var(--ui-space-1)] whitespace-pre-wrap bg-bg-input font-[family-name:var(--mono)] text-[11px] leading-[1.4]">{safeErrorJson(entry.metadata)}</pre>}
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
    <span className={`runtime-diag-chip font-[family-name:var(--mono)] text-[11px] px-[9px] py-[4px] rounded-none border bg-[color-mix(in_srgb,var(--bg-input)_80%,transparent)] ${ok ? 'text-[var(--tool-ok,#1e9646)] border-[color-mix(in_srgb,var(--tool-ok,#1e9646)_30%,var(--border))]' : 'text-[var(--danger,#e5484d)] border-[color-mix(in_srgb,var(--danger,#e5484d)_30%,var(--border))]'}`} title={entry.message || ''}>
      {label}: {entry.status}
    </span>
  )
}
