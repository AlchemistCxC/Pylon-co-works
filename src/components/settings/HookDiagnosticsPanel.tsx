/**
 * HookDiagnosticsPanel — 插件 hook 运行诊断（设置 › 插件 › Hook 诊断）。
 *
 * 消费唯一产品 HookRuntime 的三个只读投影：
 * - trace 快照（最近 200 条调用：锚点/插件/handler/结局/耗时/错误）；
 * - 熔断快照（per-plugin 失败计数与开启时间）；
 * - 注册表快照（每锚点当前注册者清单）。
 * 「锚点没触发 / 为什么被拦截」类问题的第一诊断入口（#37 类问题回溯面）。
 */
import { useMemo, useSyncExternalStore } from 'react'
import { getHookRuntime } from '../../plugin-runtime/runtimeServices.ts'

function useTraceRevision(): number {
  const runtime = getHookRuntime()
  return useSyncExternalStore(
    listener => runtime.subscribeTrace(listener),
    () => runtime.traceSnapshot().revision,
  )
}

function useRegistryRevision(): number {
  const runtime = getHookRuntime()
  return useSyncExternalStore(
    listener => runtime.registry.subscribe(listener),
    () => runtime.registry.getSnapshot().revision,
  )
}

const OUTCOME_LABELS: Record<string, string> = {
  continued: '放行',
  transformed: '改写',
  cancelled: '拦截',
  responded: '应答',
  failed: '失败',
  'timed-out': '超时',
  skipped: '跳过',
  'plugin-disable-failed': '停用失败',
}

export default function HookDiagnosticsPanel() {
  useTraceRevision()
  useRegistryRevision()
  const runtime = getHookRuntime()
  const traces = runtime.traceSnapshot().entries
  const circuits = runtime.circuitsSnapshot()
  const registrations = runtime.registry.getSnapshot().entries

  const byAnchor = useMemo(() => {
    const map = new Map<string, string[]>()
    for (const entry of registrations) {
      const list = map.get(entry.value.hookName) ?? []
      list.push(`${entry.ownerPluginId} · ${entry.value.id}（${entry.value.mode}）`)
      map.set(entry.value.hookName, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [registrations])

  return (
    <div className="settings-surface" data-testid="hook-diagnostics">
      <section aria-labelledby="hook-circuits-title" style={{ marginBottom: 16 }}>
        <h3 id="hook-circuits-title">熔断状态</h3>
        {circuits.length === 0
          ? <p className="set-hint">当前没有插件处于熔断状态。</p>
          : circuits.map(circuit => (
            <p key={circuit.pluginId} className="set-hint" role="status">
              <strong>{circuit.pluginId}</strong>：连续失败 {circuit.failures} 次
              {circuit.openedAt !== null ? '，熔断中' : ''}
            </p>
          ))}
      </section>

      <section aria-labelledby="hook-registry-title" style={{ marginBottom: 16 }}>
        <h3 id="hook-registry-title">锚点注册者</h3>
        {byAnchor.length === 0
          ? <p className="set-hint">当前没有任何插件注册钩子。</p>
          : byAnchor.map(([anchor, owners]) => (
            <div key={anchor} className="set-hint">
              <strong>{anchor}</strong>
              <ul style={{ margin: '2px 0 8px', paddingLeft: 18 }}>
                {owners.map(owner => <li key={owner}>{owner}</li>)}
              </ul>
            </div>
          ))}
      </section>

      <section aria-labelledby="hook-trace-title">
        <h3 id="hook-trace-title">最近调用（{traces.length} 条）</h3>
        {traces.length === 0
          ? <p className="set-hint">暂无钩子调用记录。</p>
          : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: 4 }}>时间</th>
                  <th style={{ textAlign: 'left', padding: 4 }}>锚点</th>
                  <th style={{ textAlign: 'left', padding: 4 }}>插件 · handler</th>
                  <th style={{ textAlign: 'left', padding: 4 }}>结局</th>
                  <th style={{ textAlign: 'right', padding: 4 }}>耗时</th>
                </tr>
              </thead>
              <tbody>
                {[...traces].reverse().map(trace => (
                  <tr key={trace.invocationId + trace.handlerId + trace.startedAt} title={trace.error ?? undefined}>
                    <td style={{ padding: 4 }}>{new Date(trace.startedAt).toLocaleTimeString()}</td>
                    <td style={{ padding: 4 }}>{trace.hookName}</td>
                    <td style={{ padding: 4 }}>{trace.pluginId} · {trace.handlerId}</td>
                    <td style={{ padding: 4 }}>
                      {OUTCOME_LABELS[trace.outcome] ?? trace.outcome}
                      {trace.error ? `（${trace.error}）` : ''}
                    </td>
                    <td style={{ padding: 4, textAlign: 'right' }}>{trace.durationMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </section>
    </div>
  )
}
