import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react'
import { clearErrors, dismissError, useErrors, type ErrorEntry } from '../errorCenter'
import { reportRuntimeError, resolveRuntimeErrors } from '../runtimeError.ts'

function recoveryLabel(kind: NonNullable<ErrorEntry['recovery']>['kind']): string {
  return {
    'open-agent-settings': '打开 Agent 设置',
    'select-agent-executable': '选择可执行文件',
    'open-runtime-log': '查看运行日志',
  }[kind]
}

function openRecovery(recovery: NonNullable<ErrorEntry['recovery']>): void {
  const { kind, agentId } = recovery
  if (kind === 'open-runtime-log') {
    window.dispatchEvent(new CustomEvent('pylon:open-runtime-sheet'))
    return
  }
  window.dispatchEvent(new CustomEvent('pylon:open-settings', {
    detail: { domain: 'agents-connections', section: 'agent', agentId },
  }))
}

function scopeLabel(entry: ErrorEntry): string | undefined {
  if (!entry.scope) return undefined
  const labels: Record<NonNullable<ErrorEntry['scope']>['kind'], string> = {
    app: '应用', agent: 'Agent', session: '会话', sheet: 'Sheet', operation: '操作',
  }
  return `${labels[entry.scope.kind]} · ${entry.scope.id}`
}

function formatTime(value: number): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '时间未知'
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2)
    if (typeof serialized !== 'string') return '[详情不可用]'
    return serialized.length <= 8_192 ? serialized : `${serialized.slice(0, 8_192)}\n…（详情已截断）`
  } catch { return '[详情不可用]' }
}

function actionLabel(entry: ErrorEntry): string {
  const action = entry.action.trim()
  if (entry.severity === 'warning') return /(?:提醒|警告)$/.test(action) ? action : `${action}提醒`
  if (entry.severity === 'info') return action
  // Callers sometimes include a terminal failure word already. Avoid
  // displaying awkward "失败失败" while keeping the legacy default suffix.
  return /(?:失败|错误|异常|拒绝|不可用|超时)$/.test(action) ? action : `${action}失败`
}

function highestSeverity(errors: readonly ErrorEntry[]): NonNullable<ErrorEntry['severity']> {
  if (errors.some(entry => entry.severity === 'error' || !entry.severity)) return 'error'
  if (errors.some(entry => entry.severity === 'warning')) return 'warning'
  return 'info'
}

const recoveryErrorKey = (entry: ErrorEntry): string => `error-center:recovery:${entry.key}`

async function runRecoveryAction(entry: ErrorEntry): Promise<void> {
  const action = entry.recoveryAction
  if (!action) return
  try {
    await action.run()
    resolveRuntimeErrors({ key: recoveryErrorKey(entry), source: 'error-center.recovery' })
  } catch (error) {
    // A recovery button is an asynchronous operation too. Keep a failed
    // recovery visible in the same tray instead of creating an unhandled
    // rejection or silently making the original notice look fixed.
    reportRuntimeError('执行恢复动作', error, undefined, {
      key: recoveryErrorKey(entry),
      scope: entry.scope ?? { kind: 'operation', id: entry.key },
      source: 'error-center.recovery',
      metadata: { originKey: entry.key, recoveryLabel: action.label },
      recovery: entry.recovery,
    })
  }
}

function ErrorTechnicalDetails({ entry }: { entry: ErrorEntry }) {
  const scope = scopeLabel(entry)
  return (
    <details className="error-center-details">
      <summary>详细信息</summary>
      <dl className="error-center-detail-list">
        {entry.code && <div><dt>错误码</dt><dd><code>{entry.code}</code></dd></div>}
        {entry.source && <div><dt>来源</dt><dd>{entry.source}</dd></div>}
        {scope && <div><dt>作用域</dt><dd>{scope}</dd></div>}
        {entry.recovery && <div><dt>恢复动作</dt><dd><code>{entry.recovery.kind}</code></dd></div>}
        <div><dt>首次发生</dt><dd>{formatTime(entry.firstAt)}</dd></div>
        {entry.count > 1 && <div><dt>最近发生</dt><dd>{formatTime(entry.lastAt)} · {entry.count} 次</dd></div>}
      </dl>
      {entry.technicalMessage && <pre className="error-center-technical">{entry.technicalMessage}</pre>}
      {entry.metadata && <pre className="error-center-technical">{safeJson(entry.metadata)}</pre>}
    </details>
  )
}

/**
 * 全局运行错误中心：普通 runtime/application 错误的唯一展示宿主。
 * 它是非模态 tray，不遮挡工作区；错误事实仍由 canonical/runtime/log 保留。
 */
export default function ErrorCenter() {
  const errors = useErrors()
  const [open, setOpen] = useState(false)
  const [dockBottom, setDockBottom] = useState(130)
  useEffect(() => {
    if (errors.length === 0) setOpen(false)
  }, [errors.length])
  useLayoutEffect(() => {
    if (errors.length === 0 || typeof window === 'undefined') return
    const measureDock = () => {
      const dock = document.querySelector<HTMLElement>('.control-center, .solid-workbench-control-center-slot')
      if (!dock) {
        setDockBottom(130)
        return
      }
      const rect = dock.getBoundingClientRect()
      if (!Number.isFinite(rect.top) || rect.height <= 0) {
        setDockBottom(130)
        return
      }
      // Reserve the complete space below the dock's top edge plus a gap. This
      // follows user-adjusted control-center heights and remains safe when a
      // custom layout grows beyond the compact default. Empty-state composers
      // are intentionally centered; they are not a bottom dock, so reserving
      // their entire lower half would push the tray over the chat center.
      const isBottomDock = rect.top >= window.innerHeight * 0.55
      // Keep all arithmetic in JS instead of relying on CSS max()/env()
      // evaluation, which is inconsistent in a few embedded WebViews. The
      // tray remains above a real bottom dock and falls back to a compact,
      // deterministic offset when the composer is centered or absent.
      setDockBottom(isBottomDock ? Math.max(88, Math.ceil(window.innerHeight - rect.top + 10)) : 130)
    }
    measureDock()
    window.addEventListener('resize', measureDock)
    const dock = document.querySelector<HTMLElement>('.control-center, .solid-workbench-control-center-slot')
    const observer = typeof ResizeObserver !== 'undefined' && dock ? new ResizeObserver(measureDock) : undefined
    observer?.observe(dock!)
    return () => {
      window.removeEventListener('resize', measureDock)
      observer?.disconnect()
    }
  }, [errors.length])
  if (errors.length === 0) return null
  const severity = highestSeverity(errors)
  return (
    <>
      <button type="button" className={`error-center-badge severity-${severity}`} onClick={() => setOpen(value => !value)}
        title={`${errors.length} 个待处理运行错误`} aria-label="查看运行错误" aria-live="polite" aria-expanded={open}>⚠ {errors.length}</button>
      {open && (
        <section
          className={`error-center severity-${severity}`}
          role="region"
          aria-label="运行错误通知"
          style={{ '--error-center-bottom': `${dockBottom}px` } as CSSProperties}
        >
          <div className="error-center-head">
            <strong>运行错误（{errors.length}）</strong>
            <span className="error-center-head-hint">不会阻断当前工作</span>
            <button type="button" className="error-center-action" title="隐藏当前通知，历史事实仍保留" onClick={clearErrors}>全部清除</button>
            <button type="button" className="error-center-action" aria-label="关闭错误面板" onClick={() => setOpen(false)}>✕</button>
          </div>
          <ul className="error-center-list" aria-live="polite">
            {errors.map(entry => (
              <li key={entry.id} className={`error-center-item severity-${entry.severity ?? 'error'}`} data-error-key={entry.key} data-error-scope={entry.scope ? `${entry.scope.kind}:${entry.scope.id}` : undefined}>
                <div className="error-center-item-main">
                  <strong>{actionLabel(entry)}</strong>
                  <span className="error-center-msg">{entry.message}</span>
                  {entry.count > 1 && <small className="error-center-count">×{entry.count}</small>}
                  <ErrorTechnicalDetails entry={entry} />
                </div>
                {entry.recovery && (
                  <button
                    type="button"
                    className="error-center-action"
                    onClick={() => openRecovery(entry.recovery!)}
                  >{recoveryLabel(entry.recovery.kind)}</button>
                )}
                {entry.recoveryAction && (
                  <button
                    type="button"
                    className="error-center-action"
                    onClick={() => { void runRecoveryAction(entry) }}
                  >{entry.recoveryAction.label}</button>
                )}
                <button type="button" className="error-center-action error-center-dismiss" aria-label="关闭该错误" onClick={() => dismissError(entry.id)}>隐藏</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
