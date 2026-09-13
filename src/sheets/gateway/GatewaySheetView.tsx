import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError, resolveRuntimeErrors } from '../../runtimeError'
import { createGatewayClient, type AdapterCatalogItem, type AdapterInstance, type GatewayInstanceInput } from '../../infrastructure/tauri/gatewayClient'
import { migrateLegacyRouteBindings, saveGatewayRouteTransaction, type GatewayRouteShape } from '../../application/transactions/saveGatewayRouteTransaction'
import { GATEWAY_ROUTE_RESETS, type GatewayRouteReset, type GatewayStatus, type GatewayWriteStatus, type PlatformSession } from '../../infrastructure/tauri/gatewayContracts.ts'
import { useIdentityStore } from '../../identityStore'
import type { SheetContext, SheetRecord } from '../../workspace-sheets/sheetTypes'

/**
 * GatewaySheetView — 网关平台概览（W3-01）+ 实例管理（I12-W5）+ 交互优化（P79）。
 *
 * gateway_status 只读概览：适配器/平台会话两分区（GatewaySidebar）；主区平台概览
 * （routes 表 + inject 只读提示「归 Prism」不编辑）。I12-W5：实例分区展示真实
 * 实例/状态/错误/凭据状态与启停删操作；创建仅限 builtIn 平台（未实现平台不可用）；
 * 凭据提交后清空前端 secret state（不残留明文）。
 *
 * P79 交互优化：
 * - 实例状态轮询（3s，可见时才拉）：状态翻转（starting→connected/error）无后端
 *   推送通道，此前必须重开 sheet 才能看到「已连接」；
 * - 凭据表单按 catalog credentialFields 动态渲染（QQ = App ID + Client Secret 两框，
 *   提交按字段顺序 join ':'）——不再要求用户手拼单串；无字段描述的平台回退单框；
 * - 删除二段确认（误点保护，3s 自动回弹）；
 * - 只读信息（注入/未绑定策略）从 key = value 日志行改为字段行展示。
 */
function statusLabel(status: AdapterInstance['status']): string {
  return status === 'connected' ? '已连接' : status === 'starting' ? '启动中' : status === 'error' ? '错误' : '已停止'
}

const INSTANCE_REFRESH_MS = 3000
const DELETE_CONFIRM_MS = 3000

export default function GatewaySheetView({ sheet, ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const sheetScope = useMemo(() => ({ kind: 'sheet' as const, id: sheet.id }), [sheet.id])
  const operationKey = useCallback((action: string, suffix = '') => `gateway:${sheet.id}:${action}${suffix ? `:${suffix}` : ''}`, [sheet.id])
  const [gatewayClient] = useState(() => createGatewayClient({
    invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined),
  }))
  const [status, setStatus] = useState<GatewayStatus | null>(null)
  const [sessions, setSessions] = useState<PlatformSession[]>([])
  const [error, setError] = useState('')
  const [expandedRoute, setExpandedRoute] = useState<number | null>(null)
  const [editSource, setEditSource] = useState('')
  const [editAgentId, setEditAgentId] = useState('')
  // I12 W6（LR2-WI02）：新 route 表单——instance/profile/session 必填，其余可选
  const [editInstanceId, setEditInstanceId] = useState('')
  const [editProfileId, setEditProfileId] = useState('')
  const [editSessionKey, setEditSessionKey] = useState('')
  const [editReset, setEditReset] = useState<GatewayRouteReset>('idle')
  const [editIdleMinutes, setEditIdleMinutes] = useState('')
  const [editAllowFrom, setEditAllowFrom] = useState('')
  const [formError, setFormError] = useState('')
  const [writeStatus, setWriteStatus] = useState<GatewayWriteStatus>({ kind: 'idle' })
  // profile 只读消费（identityStore 仅查读，不写）
  const profiles = useIdentityStore(state => state.profiles)
  // I12-W5：实例/目录 + 操作反馈
  const [instances, setInstances] = useState<AdapterInstance[]>([])
  const [catalog, setCatalog] = useState<AdapterCatalogItem[]>([])
  const [instanceError, setInstanceError] = useState('')
  // P79：凭据草稿按 catalog 字段顺序存放（无字段描述的平台回退单框 = index 0）
  const [credentialDrafts, setCredentialDrafts] = useState<Record<string, string[]>>({})
  // P79：删除二段确认（null = 无待确认实例）
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const [createForm, setCreateForm] = useState<{ platform: string; id: string; label: string }>({ platform: '', id: '', label: '' })

  // W3-02 + FE-AUD-004：保存 = saveGatewayRouteTransaction（合并既有 routes → 保存 →
  // reload → read-back 一致才 ok）；锁中毒/回读 mismatch 明确展示
  // I12 W6（LR2-WI02）：新 route 必须绑定 instance/profile/session；既有 legacy route
  // 在保存时经 migrateLegacyRouteBindings 自动补绑定（平台唯一 enabled instance 时）
  const saveRoute = async () => {
    const route: GatewayRouteShape = {
      source: editSource.trim(),
      agentId: editAgentId.trim(),
      ...(editInstanceId ? { instanceId: editInstanceId } : {}),
      ...(editProfileId ? { profileId: editProfileId } : {}),
      ...(editSessionKey.trim() ? { sessionKey: editSessionKey.trim() } : {}),
      reset: editReset,
      ...(editIdleMinutes.trim() !== '' ? { idleMinutes: Number(editIdleMinutes) } : {}),
      ...(editAllowFrom.trim() ? { allowFrom: editAllowFrom.split(',').map(part => part.trim()).filter(Boolean) } : {}),
    }
    // 严格校验：新 route 必须绑定存在的 instance + 有效 profile/session（I12 W6）
    if (!route.instanceId) {
      setFormError('请选择实例：该 source 平台无可绑定实例（唯一 enabled instance 时自动选择）')
      return
    }
    if (!route.profileId) {
      setFormError('请选择 profile')
      return
    }
    if (!route.sessionKey) {
      setFormError('请输入 session')
      return
    }
    setFormError('')
    setWriteStatus({ kind: 'saving' })
    const enabledInstances = instances.filter(instance => instance.enabled)
    const readMigrated = async (): Promise<GatewayRouteShape[]> => {
      const existing = (await gatewayClient.status() as GatewayStatus).routes as unknown as GatewayRouteShape[]
      return migrateLegacyRouteBindings(existing, enabledInstances)
    }
    const result = await saveGatewayRouteTransaction(
      route,
      {
        readRoutes: readMigrated,
        saveRoutes: payload => gatewayClient.updateAgentsConfig(payload),
        reload: () => gatewayClient.reload(),
        readBackRoutes: readMigrated,
        reportError: (action, error) => reportRuntimeError(action, error, undefined, {
          key: operationKey(action), scope: sheetScope, source: 'gateway',
          recovery: { kind: 'open-runtime-log', sheetId: sheet.id },
        }),
      },
    )
    if (!result.ok) {
      // G3：命令缺失 → blocked（「待后端」分支可达）；锁中毒/回读 mismatch 明确展示
      if (result.kind === 'blocked') setWriteStatus({ kind: 'blocked' })
      else if (result.kind === 'mismatch') {
        setWriteStatus({ kind: 'lock-poisoned' })
        reportRuntimeError('保存网关配置', new Error(result.message), undefined, {
          key: operationKey('保存网关配置'), scope: sheetScope, source: 'gateway',
          recovery: { kind: 'open-runtime-log', sheetId: sheet.id },
        })
      }
      else setWriteStatus({ kind: 'error', message: result.message })
      return
    }
    // FE-AUD-004：保存成功后用事务回读结果刷新 UI（status 不只挂载时读一次）
    setStatus({ ...(status ?? { adapters: [], routes: [], qq: null, inject: null }), routes: result.value as GatewayStatus['routes'] })
    setWriteStatus({ kind: 'ok' })
    for (const action of ['读取网关路由', '保存网关配置', '重载网关', '回读网关状态']) {
      resolveRuntimeErrors({ key: operationKey(action) })
    }
  }

  // I12 W6：source 变化时，若平台恰好一个 enabled instance 则自动预选实例（可手动改）
  const onSourceChange = (value: string) => {
    setEditSource(value)
    const bound = migrateLegacyRouteBindings([{ source: value.trim(), agentId: editAgentId.trim() }], instances.filter(instance => instance.enabled))
    setEditInstanceId(bound[0]?.instanceId ?? '')
  }

  useEffect(() => {
    let disposed = false
    gatewayClient.status().then(raw => {
      if (!disposed) {
        setStatus(raw as GatewayStatus)
        setError('')
        resolveRuntimeErrors({ key: operationKey('读取网关状态') })
      }
    }).catch(err => {
      if (!disposed) {
        setError(err instanceof Error ? err.message : String(err))
        reportRuntimeError('读取网关状态', err, undefined, {
          key: operationKey('读取网关状态'), scope: sheetScope, source: 'gateway',
          recovery: { kind: 'open-runtime-log', sheetId: sheet.id },
        })
      }
    })
    return () => { disposed = true }
  }, [gatewayClient, operationKey, sheet.id, sheetScope])

  // Phase 2：平台会话（gateway_sessions 只读快照）
  useEffect(() => {
    let disposed = false
    gatewayClient.sessions().then(raw => {
      if (!disposed) {
        setSessions(raw as PlatformSession[])
        resolveRuntimeErrors({ key: operationKey('读取平台会话') })
      }
    }).catch(err => {
      if (!disposed) reportRuntimeError('读取平台会话', err, undefined, {
        key: operationKey('读取平台会话'), scope: sheetScope, source: 'gateway',
        recovery: { kind: 'open-runtime-log', sheetId: sheet.id },
      })
    })
    return () => { disposed = true }
  }, [gatewayClient, operationKey, sheet.id, sheetScope])

  // I12-W5：实例列表 + 平台 catalog（创建表单可用平台与凭据字段来源）
  const reloadInstances = useCallback(async () => {
    try {
      setInstances(await gatewayClient.instances())
      setInstanceError('')
      resolveRuntimeErrors({ key: operationKey('读取网关实例') })
    } catch (err) {
      setInstanceError(err instanceof Error ? err.message : String(err))
      reportRuntimeError('读取网关实例', err, undefined, {
        key: operationKey('读取网关实例'), scope: sheetScope, source: 'gateway',
        recovery: { kind: 'open-runtime-log', sheetId: sheet.id },
      })
    }
  }, [gatewayClient, operationKey, sheet.id, sheetScope])
  useEffect(() => {
    let disposed = false
    void reloadInstances()
    gatewayClient.catalog().then(items => {
      if (!disposed) {
        setCatalog(items)
        resolveRuntimeErrors({ key: operationKey('读取平台目录') })
      }
    }).catch(err => {
      if (!disposed) reportRuntimeError('读取平台目录', err, undefined, {
        key: operationKey('读取平台目录'), scope: sheetScope, source: 'gateway',
        recovery: { kind: 'open-runtime-log', sheetId: sheet.id },
      })
    })
    return () => { disposed = true }
  }, [gatewayClient, reloadInstances, operationKey, sheet.id, sheetScope])

  // P79：实例状态轮询——状态翻转（starting→connected/error）无后端推送通道，
  // 挂载期间低频轮询让「已连接/错误」自动可见（此前必须重开 sheet 才能看到）。
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      void reloadInstances()
    }, INSTANCE_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [reloadInstances])

  // P79：删除确认 3s 未二次点击自动回弹
  useEffect(() => {
    if (!pendingDeleteId) return
    const timer = window.setTimeout(() => setPendingDeleteId(null), DELETE_CONFIRM_MS)
    return () => window.clearTimeout(timer)
  }, [pendingDeleteId])

  const runInstanceAction = async (operation: string, action: () => Promise<unknown>) => {
    try {
      await action()
      // The mutation itself succeeded; retire its prior notification before
      // the follow-up snapshot read. A snapshot failure is tracked separately
      // under "读取网关实例" and must not make a successful mutation look
      // permanently failed.
      resolveRuntimeErrors({ key: operationKey(operation) })
      await reloadInstances()
    } catch (err) {
      setInstanceError(err instanceof Error ? err.message : String(err))
      reportRuntimeError(operation, err, undefined, {
        key: operationKey(operation), scope: sheetScope, source: 'gateway',
        recovery: { kind: 'open-runtime-log', sheetId: sheet.id },
      })
    }
  }

  const createInstance = async () => {
    if (!createForm.platform || !createForm.id.trim()) return
    const input: GatewayInstanceInput = {
      platform: createForm.platform,
      id: createForm.id.trim(),
      label: createForm.label.trim() || createForm.id.trim(),
      enabled: true,
      autoStart: false,
    }
    await runInstanceAction('创建网关实例', () => gatewayClient.createInstance(input))
    setCreateForm({ platform: createForm.platform, id: '', label: '' })
  }

  const credentialFieldsFor = useCallback((platform: string) => {
    return catalog.find(item => item.platform === platform)?.credentialFields ?? []
  }, [catalog])

  const setCredentialDraft = (id: string, index: number, value: string) => {
    setCredentialDrafts(prev => {
      const current = prev[id] ?? []
      const next = [...current]
      next[index] = value
      return { ...prev, [id]: next }
    })
  }

  const submitCredentials = async (instance: AdapterInstance) => {
    const drafts = credentialDrafts[instance.id] ?? []
    const secret = drafts.join(':')
    if (!secret) return
    await runInstanceAction('保存网关凭据', () => gatewayClient.setInstanceCredentials(instance.id, secret))
    // I12-W5：凭据提交后清空前端 secret state（明文不残留）
    setCredentialDrafts(prev => ({ ...prev, [instance.id]: [] }))
  }

  const availablePlatforms = catalog.filter(item => item.availability === 'builtIn')

  return (
    <div className="gateway-sheet">
      {!ctx.sidebarCollapsed && <aside className="gateway-sidebar">
        <div className="file-section-title">适配器</div>
        {status?.adapters.length ? (
          <ul className="search-result-list">
            {status.adapters.map(adapter => (
              <li key={adapter}><span className="search-result-path">{adapter}</span></li>
            ))}
          </ul>
        ) : <p className="file-section-hint">无适配器</p>}
        <div className="file-section-title">平台会话</div>
        {sessions.length === 0 ? (
          <p className="file-section-hint">无平台会话</p>
        ) : (
          <ul className="search-result-list">
            {sessions.map(session => (
              <li key={session.source}>
                <span className="search-result-path">{session.source}</span>
                <span className="search-result-text">→ {session.agentId} · {session.reset}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>}
      <main className="gateway-main">
        {error && <p className="file-section-hint gateway-error-reference" role="status">网关状态读取失败，详情见右下角错误中心</p>}
        <div className="file-main-kicker">GATEWAY</div>
        <h2 className="file-main-title">平台概览</h2>
        <div className="gateway-routes">
          {status?.routes.map((route, index) => (
            <div key={route.source} className="gateway-route">
              <button type="button" className="gateway-route-head" aria-expanded={expandedRoute === index} onClick={() => setExpandedRoute(expandedRoute === index ? null : index)}>
                <span className="search-result-path">{route.source}</span>
                <span className="search-result-text">→ {route.agentId}</span>
                <span className="gateway-route-reset">{route.reset}</span>
              </button>
              {expandedRoute === index && (
                <div className="gateway-route-detail">
                  <div className="runtime-log-field"><code>instanceId</code> = {route.instanceId || '—（未绑定实例）'}</div>
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
          <div className="file-section-title">新增路由</div>
          <p className="gateway-section-hint">把平台会话（source）绑定到 agent：实例 / profile / session 为必填，其余可选</p>
          <div className="gateway-edit-row">
            <input className="runtime-filter-input" placeholder="source（如 qq:group:123）" value={editSource} onChange={e => onSourceChange(e.target.value)} aria-label="路由 source" />
            <input className="runtime-filter-input" placeholder="agentId（如 peri）" value={editAgentId} onChange={e => setEditAgentId(e.target.value)} aria-label="路由 agentId" />
          </div>
          <div className="gateway-edit-row">
            <select className="runtime-filter-input" aria-label="路由 instance" value={editInstanceId} onChange={e => setEditInstanceId(e.target.value)}>
              <option value="">选择实例</option>
              {instances.map(instance => (
                <option key={instance.id} value={instance.id}>{instance.label || instance.id}（{instance.platform}）{instance.enabled ? '' : '· 未启用'}</option>
              ))}
            </select>
            <select className="runtime-filter-input" aria-label="路由 profile" value={editProfileId} onChange={e => setEditProfileId(e.target.value)}>
              <option value="">选择 profile</option>
              {profiles.map(profile => (
                <option key={profile.id} value={profile.id}>{profile.name || profile.id}</option>
              ))}
            </select>
            <input className="runtime-filter-input" placeholder="session（如 战役1）" value={editSessionKey} onChange={e => setEditSessionKey(e.target.value)} aria-label="路由 session" />
          </div>
          <div className="gateway-edit-row">
            <select className="runtime-filter-input" aria-label="路由 reset" value={editReset} onChange={e => setEditReset(e.target.value as GatewayRouteReset)}>
              {GATEWAY_ROUTE_RESETS.map(reset => (
                <option key={reset} value={reset}>{reset}</option>
              ))}
            </select>
            <input className="runtime-filter-input" placeholder="idleMinutes（可选）" type="number" min="0" value={editIdleMinutes} onChange={e => setEditIdleMinutes(e.target.value)} aria-label="路由 idleMinutes" />
            <input className="runtime-filter-input" placeholder="allowFrom（逗号分隔，可选）" value={editAllowFrom} onChange={e => setEditAllowFrom(e.target.value)} aria-label="路由 allowFrom" />
            <button type="button" className="template-apply" onClick={() => void saveRoute()}>保存</button>
          </div>
          {formError && <div className="file-tree-error" role="alert">{formError}</div>}
          {writeStatus.kind === 'blocked' && <p className="file-section-hint" role="status">待后端：update_agents_config 命令尚未提供</p>}
          {writeStatus.kind === 'lock-poisoned' && <p className="file-section-hint gateway-error-reference" role="status">网关配置回读不一致，详情见右下角错误中心</p>}
          {writeStatus.kind === 'error' && <p className="file-section-hint gateway-error-reference" role="status">网关配置保存失败，详情见右下角错误中心</p>}
          {writeStatus.kind === 'ok' && <p className="file-section-hint" role="status">已保存并重载</p>}
        </div>
        {/* I12-W5：实例管理（真实实例/状态/错误/操作；未实现平台不可用） */}
        <div className="gateway-instances">
          <div className="file-section-title">实例</div>
          <p className="gateway-section-hint">状态每 {INSTANCE_REFRESH_MS / 1000} 秒自动刷新；启动前需配置凭据</p>
          {instanceError && <p className="file-section-hint gateway-error-reference" role="status">网关实例操作失败，详情见右下角错误中心</p>}
          {instances.length === 0 ? (
            <p className="file-section-hint">无实例</p>
          ) : (
            <ul className="search-result-list">
              {instances.map(instance => {
                const fields = credentialFieldsFor(instance.platform)
                const drafts = credentialDrafts[instance.id] ?? []
                const readyToSave = fields.length > 0
                  ? fields.every((field, index) => !field.required || (drafts[index] ?? '').length > 0)
                  : (drafts[0] ?? '').length > 0
                return (
                <li key={instance.id} className={`gateway-instance-card${instance.status === 'error' ? ' gateway-instance-card-error' : ''}`}>
                  <div className="gateway-instance-head">
                    <span className="search-result-path">{instance.label || instance.id}</span>
                    <span className={`gateway-instance-status gateway-instance-status-${instance.status}${instance.status === 'starting' ? ' gateway-status-pulse' : ''}`}>{statusLabel(instance.status)}</span>
                    <span className="search-result-text">· {instance.platform}</span>
                    <span className="search-result-text">凭据：{instance.credentialStatus === 'configured' ? '已配置' : instance.credentialStatus === 'invalid' ? '损坏' : '未配置'}</span>
                  </div>
                  {instance.lastError && <p className="file-section-hint" role="status">上次运行错误：{instance.lastError}</p>}
                  <div className="gateway-edit-row">
                    <button type="button" className="template-apply" disabled={instance.status === 'starting'} onClick={() => void runInstanceAction('启动网关实例', () => gatewayClient.startInstance(instance.id))}>启动</button>
                    <button type="button" className="template-apply" disabled={instance.status === 'stopped' || instance.status === 'starting'} onClick={() => void runInstanceAction('停止网关实例', () => gatewayClient.stopInstance(instance.id))}>停止</button>
                    <button type="button" className="template-apply" disabled={instance.status === 'starting'} onClick={() => void runInstanceAction('重启网关实例', () => gatewayClient.restartInstance(instance.id))}>重启</button>
                    {pendingDeleteId === instance.id ? (
                      <button type="button" className="template-apply gateway-btn-danger" aria-label={`确认删除 ${instance.id}`} onClick={() => {
                        setPendingDeleteId(null)
                        void runInstanceAction('删除网关实例', () => gatewayClient.removeInstance(instance.id))
                      }}>确认删除</button>
                    ) : (
                      <button type="button" className="template-apply" disabled={instance.status !== 'stopped'} aria-label={`删除 ${instance.id}`} onClick={() => setPendingDeleteId(instance.id)}>删除</button>
                    )}
                  </div>
                  {/* P79：凭据字段按 catalog credentialFields 渲染（secret → 密码框）；
                      提交按字段顺序 join ':'；无字段描述的平台回退单框。 */}
                  <div className="gateway-edit-row">
                    {(fields.length > 0 ? fields : [{ key: 'secret', label: '凭据（appId:clientSecret）', secret: true, required: true }]).map((field, index) => (
                      <input
                        key={field.key}
                        className="runtime-filter-input"
                        type={field.secret ? 'password' : 'text'}
                        placeholder={`${field.label}${field.required ? '' : '（可选）'}`}
                        value={drafts[index] ?? ''}
                        onChange={e => setCredentialDraft(instance.id, index, e.target.value)}
                        aria-label={`${instance.id} ${field.label}`}
                        autoComplete="off"
                      />
                    ))}
                    <button type="button" className="template-apply" disabled={!readyToSave} onClick={() => void submitCredentials(instance)}>保存凭据</button>
                  </div>
                </li>
                )
              })}
            </ul>
          )}
          <div className="file-section-title">新建实例</div>
          <p className="gateway-section-hint">仅显示已实现平台；创建后配置凭据并启动。未实现平台（如微信）不可创建。</p>
          {availablePlatforms.length === 0 ? (
            <p className="file-section-hint">无可用平台（未实现平台不可用）</p>
          ) : (
            <div className="gateway-edit-row">
              <select className="runtime-filter-input" aria-label="平台" value={createForm.platform} onChange={e => setCreateForm(prev => ({ ...prev, platform: e.target.value }))}>
                <option value="">选择平台</option>
                {availablePlatforms.map(item => <option key={item.platform} value={item.platform}>{item.label}</option>)}
              </select>
              <input className="runtime-filter-input" placeholder="实例 id" value={createForm.id} onChange={e => setCreateForm(prev => ({ ...prev, id: e.target.value }))} aria-label="实例 id" />
              <input className="runtime-filter-input" placeholder="标签（可选）" value={createForm.label} onChange={e => setCreateForm(prev => ({ ...prev, label: e.target.value }))} aria-label="实例标签" />
              <button type="button" className="template-apply" disabled={!createForm.platform || !createForm.id.trim()} onClick={() => void createInstance()}>创建</button>
            </div>
          )}
        </div>
        {/* I12 W9：未绑定消息策略只读展示（明示风险——reject 模式未绑定消息不进入 agent） */}
        {status?.unboundPolicy && (
          <div className="gateway-inject">
            <div className="file-section-title">未绑定消息策略</div>
            <div className="gateway-field">
              <span className="gateway-field-label">策略</span>
              <span className="gateway-field-value">{status.unboundPolicy === 'reject' ? '严格模式（reject）：未绑定路由的消息将被拒绝，不会回退到 active agent' : '宽松模式（active-agent）：未绑定路由的消息回退到 active agent'}</span>
            </div>
          </div>
        )}
        {status?.inject && (
          <div className="gateway-inject">
            <div className="file-section-title">知识注入（归 Prism 管理，只读）</div>
            <div className="gateway-field">
              <span className="gateway-field-label">注入开关</span>
              <span className="gateway-field-value">{status.inject.enabled == null ? '—' : status.inject.enabled ? '开启' : '关闭'}</span>
            </div>
            <div className="gateway-field">
              <span className="gateway-field-label">注入场景</span>
              <span className="gateway-field-value">{status.inject.scenario || '跟随 Prism active.scenario'}</span>
            </div>
            <div className="gateway-field">
              <span className="gateway-field-label">完成持久化</span>
              <span className="gateway-field-value">{status.inject.persist === 'prism' ? '写入 Prism（persist）' : status.inject.persist || '—'}</span>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
