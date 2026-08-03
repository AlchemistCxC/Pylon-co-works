import { useEffect, useState } from 'react'
import type { RenderMetricSnapshot } from './chat/renderMetrics'

type MetricsApi = { snapshot: () => RenderMetricSnapshot; reset: () => void }

function metricsApi(): MetricsApi | null {
  const target = window as typeof window & { __PYLON_RENDER_METRICS__?: MetricsApi }
  return target.__PYLON_RENDER_METRICS__ ?? null
}

/**
 * dev-only 渲染指标悬浮面板：消费 renderMetrics 的埋点（recordRender 计数 /
 * measureRender 耗时），500ms 节流刷新。Ctrl+Shift+M 切换。
 */
export default function DevMetricsOverlay() {
  const [open, setOpen] = useState(false)
  const [snap, setSnap] = useState<RenderMetricSnapshot | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'm') {
        event.preventDefault()
        setOpen(value => !value)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const read = () => {
      const api = metricsApi()
      if (api) setSnap(api.snapshot())
    }
    read()
    const timer = window.setInterval(read, 500)
    return () => window.clearInterval(timer)
  }, [open])

  if (!open) {
    return (
      <button type="button" className="dev-metrics-toggle" title="渲染指标（Ctrl+Shift+M）" onClick={() => setOpen(true)}>📊</button>
    )
  }

  const rows = snap ? Object.entries(snap.counts).map(([name, count]) => {
    const measure = snap.measures[name]
    return {
      name,
      count,
      avgMs: measure ? measure.totalMs / measure.count : undefined,
      maxMs: measure?.maxMs,
    }
  }) : []

  return (
    <div className="dev-metrics" role="dialog" aria-label="渲染指标">
      <div className="dev-metrics-head">
        <span>渲染指标</span>
        <button type="button" className="dev-metrics-action" onClick={() => metricsApi()?.reset()}>重置</button>
        <button type="button" className="dev-metrics-action" onClick={() => setOpen(false)}>✕</button>
      </div>
      <table className="dev-metrics-table">
        <thead>
          <tr><th>埋点</th><th>次数</th><th>均耗</th><th>峰值</th></tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.name}>
              <td className="dev-metrics-name">{row.name}</td>
              <td>{row.count}</td>
              <td>{row.avgMs !== undefined ? `${row.avgMs.toFixed(1)}ms` : '—'}</td>
              <td>{row.maxMs !== undefined ? `${row.maxMs.toFixed(1)}ms` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
