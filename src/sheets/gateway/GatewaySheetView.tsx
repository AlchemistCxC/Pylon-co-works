import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { classifyGatewayWriteError, normalizeGatewayStatus, type GatewayStatus, type GatewayWriteStatus } from '../../infrastructure/tauri/gatewayContracts.ts'
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
  const [editSource, setEditSource] = useState('')
  const [editAgentId, setEditAgentId] = useState('')
  const [writeStatus, setWriteStatus] = useState<GatewayWriteStatus>({ kind: 'idle' })

  // W3-02 桩化：update_agents_config 成功后 reload_gateway；命令缺失 → 明确「待后端」；锁中毒展示失败
  const saveRoute = async () => {
    if (!editSource.trim() || !editAgentId.trim()) return
    setWriteStatus({ kind: 'saving' })
    try {
      // 契约：update_agents_config（待产品侧后端命令）；成功后 reload_gateway
      await invoke('update_agents_config', { config: { gateway: { routes: [{ source: editSource, agentId: editAgentId }] } } })
      try {
        await invoke('reload_gateway')
      } catch (reloadError) {
        const classified = classifyGatewayWriteError(reloadError)
        setWriteStatus(classified)
        if (classified.kind === 'lock-poisoned') reportRuntimeError('重载网关', '磁盘已更新、运行态仍旧配置')
        return
      }
      setWriteStatus({ kind: 'ok' })
    } catch (error) {
      const classified = classifyGatewayWriteError(error)
      setWriteStatus(classified)
      if (classified.kind === 'error') reportRuntimeError('保存网关配置', error)
    }
  }

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
        <p className="file-section-hint" role="status">待后端：gateway_sessions 命令尚未提供</p>
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
        <div className="gateway-route-edit">
          <div className="file-section-title">新增路由（写回待后端）</div>
          <div className="gateway-edit-row">
            <input className="runtime-filter-input" placeholder="source（如 qq:group:123）" value={editSource} onChange={e => setEditSource(e.target.value)} aria-label="路由 source" />
            <input className="runtime-filter-input" placeholder="agentId（如 peri）" value={editAgentId} onChange={e => setEditAgentId(e.target.value)} aria-label="路由 agentId" />
            <button type="button" className="template-apply" onClick={() => void saveRoute()}>保存</button>
          </div>
          {writeStatus.kind === 'blocked' && <p className="file-section-hint" role="status">待后端：update_agents_config 命令尚未提供</p>}
          {writeStatus.kind === 'lock-poisoned' && <div className="file-tree-error" role="alert">网关配置锁中毒：磁盘已更新、运行态仍旧配置</div>}
          {writeStatus.kind === 'error' && <div className="file-tree-error" role="alert">{writeStatus.message}</div>}
          {writeStatus.kind === 'ok' && <p className="file-section-hint" role="status">已保存并重载</p>}
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
