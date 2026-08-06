import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { normalizeGatewayStatus, type GatewayStatus } from '../../infrastructure/tauri/gatewayContracts.ts'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'
import './GatewaySheet.css'

/**
 * GatewaySheetView — 网关平台概览（W3-01）。
 *
 * gateway_status 只读概览：适配器/平台会话两分区（GatewaySidebar）；主区平台概览
 * （routes 表 + inject 只读提示「归 Prism」不编辑）。route 写回在 W3-02（桩化）。
 */
export default function GatewaySheetView({ sheet: _sheet, ctx: _ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [error, setError] = useState('')
  const [expandedRoute, setExpandedRoute] = useState<number | null>(null)

  useEffect(() => {
    let disposed = false
    invoke<unknown>('gateway_status').then(raw => {
      if (!disposed) setStatus(normalizeGatewayStatus(raw))
    }).catch(err => {
      if (!disposed) {
        setError(err instanceof Error ? err.message : String(err))
        reportRuntimeError('读取网关状态', err)
      }
    })
    return () => { disposed = true }
  }, [])

  return (
    <div className="gateway-sheet">
      <aside className="gateway-sidebar">
        <div className="file-section-title">适配器</div>
        {status?.adapters.length ? (
          <ul className="search-result-list">
            {status.adapters.map(adapter => (
              <li key={adapter}><span className="search-result-path">{adapter}</span></li>
            ))}
          </ul>
        ) : <p className="file-section-hint">无适配器</p>}
        <div className="file-section-title">平台会话</div>
        <p className="file-section-hint">平台会话流（W3-02 接线，待 gateway_sessions）</p>
      </aside>
      <main className="gateway-main">
        {error && <div className="file-tree-error" role="alert">{error}</div>}
        <div className="file-main-kicker">GATEWAY</div>
        <h2 className="file-main-title">平台概览</h2>
        <div className="gateway-routes">
          {status?.routes.map((route, index) => (
            <div key={route.source} className="gateway-route">
              <button type="button" className="gateway-route-head" onClick={() => setExpandedRoute(expandedRoute === index ? null : index)}>
                <span className="search-result-path">{route.source}</span>
                <span className="search-result-text">→ {route.agentId}</span>
                <span className="gateway-route-reset">{route.reset}</span>
              </button>
              {expandedRoute === index && (
                <div className="gateway-route-detail">
                  <div className="runtime-log-field"><code>profileId</code> = {route.profileId || '—'}</div>
                  <div className="runtime-log-field"><code>sessionKey</code> = {route.sessionKey || '—'}</div>
                  <div className="runtime-log-field"><code>allowFrom</code> = {(route.allowFrom || []).join(', ') || '—'}</div>
                  <div className="runtime-log-field"><code>idleMinutes</code> = {route.idleMinutes ?? '—'}</div>
                </div>
              )}
            </div>
          ))}
          {status && status.routes.length === 0 && <p className="file-section-hint">无路由</p>}
        </div>
        {status?.inject && (
          <div className="gateway-inject">
            <div className="file-section-title">注入（归 Prism 管理，只读）</div>
            <div className="runtime-log-field"><code>enabled</code> = {String(status.inject.enabled ?? '—')}</div>
            <div className="runtime-log-field"><code>scenario</code> = {status.inject.scenario || '—'}</div>
            <div className="runtime-log-field"><code>persist</code> = {status.inject.persist || '—'}</div>
          </div>
        )}
      </main>
    </div>
  )
}
