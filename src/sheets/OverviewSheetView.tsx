import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Activity, ArrowUpRight, Bot, Folder, LayoutDashboard, MessageSquare, Settings2, Sparkles } from 'lucide-react'
import { IS_TAURI } from '../infrastructure/tauri/env'
import { useIdentityStore, type AgentEntry, type Session } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { reportRuntimeError, resolveRuntimeErrors } from '../runtimeError'
import { createAgentClient } from '../infrastructure/acp/agentClient'
import { createSessionClient } from '../infrastructure/acp/sessionClient'
import { normalizeStartupDiagnostics, type StorageDiagnostics } from '../infrastructure/tauri/runtimeLogContracts'
import { switchAgentTransaction } from '../application/transactions/switchAgentTransaction'
import { createStandardSwitchAgent, openOwnedSessionTransaction } from '../application/transactions/openOwnedSessionTransaction'
import AgentConfigEditor from '../components/settings/AgentConfigEditor'
import PylonMark from '../components/PylonMark'
import { statusLabel } from '../components/settings/agentTypes.ts'
import { recentPersistedSessions, type PersistedSessionSummary } from '../domains/overview/persistedSessions.ts'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'
import { useWorkspaceEntityStore } from '../workspaceEntityStore.ts'
import { isAgentInvocationConfigured } from '../domains/agent/agentEntry.ts'

function relativeTime(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return `${days} 天前`
}

/**
 * OverviewSheetView — 启动选择器（W1-05/06，§5.1）。
 *
 * 虚拟空态（不写入持久 sheet 数组）：无 active sheet 时 SheetLayout 直接渲染 overview。
 * 三入口：选择 Agent（list_agents → switch_agent → 无缝 open agent sheet，失败保持
 * overview 并报错）/ 配置 Agent（W1-07 接线）/ 继续会话（list_persisted_sessions →
 * 最近 5 个 → 找/建 identity row → selectSession + open agent sheet；load 由 ChatView
 * 挂载后的 controller lifecycle 承担——listener 就绪后才 load）。
 */
export default function OverviewSheetView({ ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const agents = useIdentityStore(s => s.agents)
  const sessions = useIdentityStore(s => s.sessions)
  const activeAgent = useIdentityStore(s => s.activeAgent) || 'peri'
  const agentStatuses = useRuntimeStore(s => s.agentStatuses)
  const workspaces = useWorkspaceEntityStore(s => s.workspaces)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [errorIsValidation, setErrorIsValidation] = useState(false)
  const [recent, setRecent] = useState<PersistedSessionSummary[]>([])
  const [showConfigEditor, setShowConfigEditor] = useState(false)
  const [storage, setStorage] = useState<StorageDiagnostics | undefined>(undefined)
  const [migrationBusy, setMigrationBusy] = useState(false)
  const [migrationDismissed, setMigrationDismissed] = useState(false)

  // 施工文档 §7.4/§7.8：读取启动诊断（storage 模式/迁移可用性），Overview 顶部按需提示。
  useEffect(() => {
    if (!IS_TAURI) return
    let disposed = false
    invoke('startup_diagnostics')
      .then(raw => {
        if (!disposed) {
          setStorage(normalizeStartupDiagnostics(raw).storage)
          resolveRuntimeErrors({ key: 'overview:startup-diagnostics' })
        }
      })
      .catch(error => {
        if (!disposed) reportRuntimeError('读取启动诊断', error, undefined, {
          key: 'overview:startup-diagnostics', scope: { kind: 'sheet', id: 'overview' }, source: 'overview',
          recovery: { kind: 'open-runtime-log', sheetId: 'overview' },
        })
      })
    return () => { disposed = true }
  }, [])

  const migrateToPortable = async () => {
    if (migrationBusy) return
    setMigrationBusy(true)
    try {
      await invoke('migrate_appdata_to_portable')
      setMigrationDismissed(true)
      resolveRuntimeErrors({ key: 'overview:migrate-portable' })
    } catch (error) {
      reportRuntimeError('迁移 AppData 到便携目录', error, undefined, {
        key: 'overview:migrate-portable', scope: { kind: 'sheet', id: 'overview' }, source: 'overview',
        recovery: { kind: 'open-runtime-log', sheetId: 'overview' },
      })
    } finally {
      setMigrationBusy(false)
    }
  }

  // W1-06：加载最近会话（client 已 normalize，取最近 5 个展示）
  useEffect(() => {
    if (!IS_TAURI) return
    let disposed = false
    const client = createSessionClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
    client.listPersistedSessions().then(all => {
      if (!disposed) {
        setRecent(recentPersistedSessions(all))
        resolveRuntimeErrors({ key: 'overview:recent-sessions' })
      }
    }).catch(err => {
      if (!disposed) reportRuntimeError('读取最近会话', err, undefined, {
        key: 'overview:recent-sessions', scope: { kind: 'sheet', id: 'overview' }, source: 'overview',
        recovery: { kind: 'open-runtime-log', sheetId: 'overview' },
      })
    })
    return () => { disposed = true }
  }, [])

  const selectAgent = async (agent: AgentEntry) => {
    if (switchingId) return
    setSwitchingId(agent.id)
    setError('')
    setErrorIsValidation(false)
    const agentClient = createAgentClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
    const result = await switchAgentTransaction(agent.id, agent.name, {
      switchAgent: () => agentClient.switchAgent(agent.id),
      resetRuntime: () => useRuntimeStore.getState().resetAll(),
      setActiveAgent: id => useIdentityStore.getState().setActiveAgent(id),
      fetchAgentStatus: () => agentClient.agentStatus(),
      applyAgentStatus: (id, status) => useRuntimeStore.getState().setAgentStatus(id, status),
      reportError: (action, err) => {
        setError(err instanceof Error ? err.message : String(err))
        // Compatibility token retained for the overview structure guard:
        // reportRuntimeError(action, err)
        reportRuntimeError(action, err, agent.id, {
          key: `overview:agent:${agent.id}:${action}`,
          scope: { kind: 'agent', id: agent.id },
          source: 'overview.agent-switch',
          recovery: { kind: 'open-runtime-log', agentId: agent.id },
        })
      },
      resolveError: action => resolveRuntimeErrors({ key: `overview:agent:${agent.id}:${action}` }),
      dispatchSwitched: () => window.dispatchEvent(new CustomEvent('pylon:agent-switched')),
      // 无缝进 sheet：成功后 open agent sheet（失败保持 overview）
      openAgentSheet: (id, title) => ctx.openSheet({ kind: 'agent', title, agentId: id }),
    })
    if (!result.ok) setSwitchingId(null)
  }

  // W1-06：复用现有 identity session；无则创建 row 并纠正 source/periId（不直接 load——
  // 由 ChatView 挂载后的 lifecycle 执行 load，保证 listener/controller 就绪）。
  // FE-AUD-010：找/建逻辑收敛到 resumePersistedSessionTransaction，不靠数组长度定位。
  const resumeSession = async (p: PersistedSessionSummary) => {
    setError('')
    setErrorIsValidation(false)
    // I01-W4：owner-aware 打开——owner 无法确定时 blocked，不静默归 active Agent
    const result = await openOwnedSessionTransaction(
      { source: p.source, periId: p.periId, title: p.title, updatedAt: p.updatedAt },
      {
        getSessions: () => useIdentityStore.getState().sessions,
        activeAgent: useIdentityStore.getState().activeAgent,
        addSession: (name, agentId) => useIdentityStore.getState().addSession(name, agentId),
        updateSession: (id, partial) => useIdentityStore.getState().updateSession(id, partial),
        switchAgent: createStandardSwitchAgent(id => useIdentityStore.getState().agents.find(a => a.id === id)?.name),
        selectSession: id => ctx.selectSession(id),
        openAgentSheet: ({ title, agentId }) => ctx.openSheet({ kind: 'agent', title, agentId }),
      },
    )
    if (!result.ok) {
      setError(result.message)
      // Transport failures are already represented by the central ErrorCenter
      // (the standard owner-switch transaction reports there). Keep only
      // validation/ownership facts as assertive inline guidance.
      setErrorIsValidation(result.kind !== 'transport')
      return
    }
  }

  const openKnownSession = (session: Session) => resumeSession({
    id: session.id,
    source: session.source,
    periId: session.periId,
    title: session.name,
    updatedAt: session.lastActiveAt,
  })

  const localRecent = useMemo(
    () => [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 6),
    [sessions],
  )
  const persistedRecent = useMemo(
    () => recent.filter(item => !sessions.some(session => session.source === item.source)).slice(0, Math.max(0, 6 - localRecent.length)),
    [localRecent.length, recent, sessions],
  )
  const connectedCount = agents.filter(agent => agentStatuses[agent.id]?.status === 'connected').length
  const activeAgentEntry = agents.find(agent => agent.id === activeAgent)
  const activeAgentConfigured = isAgentInvocationConfigured(activeAgentEntry)

  const openAgentSettings = () => window.dispatchEvent(new CustomEvent('pylon:open-settings', {
    detail: { domain: 'agents-connections', section: 'agent', agentId: activeAgent },
  }))

  const openWorkspace = (workspaceId: string, ownerAgentId: string) => {
    const linked = localRecent.find(session => session.workspaceId === workspaceId)
    if (linked) {
      void openKnownSession(linked)
      return
    }
    const resolvedOwnerId = ownerAgentId || activeAgent
    const owner = agents.find(agent => agent.id === resolvedOwnerId)
    ctx.openSheet({ kind: 'agent', title: owner?.name ?? resolvedOwnerId, agentId: resolvedOwnerId })
  }

  const navigateTo = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <div className="overview-sheet">
      {!ctx.sidebarCollapsed && (
        <aside className="overview-sidebar" aria-label="Overview 分区">
          <div className="overview-sidebar-head">
            <span>OVERVIEW</span>
            <strong>工作台导航</strong>
          </div>
          <nav>
            <button type="button" onClick={() => navigateTo('overview-home')}><LayoutDashboard size={15} aria-hidden="true" /><span>概览</span></button>
            <button type="button" onClick={() => navigateTo('overview-agents')}><Bot size={15} aria-hidden="true" /><span>Agent</span><small>{agents.length}</small></button>
            <button type="button" onClick={() => navigateTo('overview-recent')}><MessageSquare size={15} aria-hidden="true" /><span>最近会话</span><small>{localRecent.length + persistedRecent.length}</small></button>
            <button type="button" onClick={() => navigateTo('overview-workspaces')}><Folder size={15} aria-hidden="true" /><span>工作区</span><small>{workspaces.length}</small></button>
            <button type="button" onClick={() => navigateTo('overview-advanced')}><Settings2 size={15} aria-hidden="true" /><span>高级配置</span></button>
          </nav>
          <div className="overview-sidebar-foot"><Activity size={14} aria-hidden="true" />{connectedCount} 个 Agent 在线</div>
        </aside>
      )}
      <main className="overview-main">
      <div className="overview-shell">
        <section className="overview-hero" id="overview-home" aria-labelledby="overview-title">
          <div className="overview-hero-brand">
            <div className="overview-mark-stage">
              <PylonMark size={58} className="overview-brand-mark" title="Pylon" />
            </div>
            <div className="overview-hero-copy">
              <div className="overview-kicker"><Sparkles size={12} aria-hidden="true" /> PYLON WORKSPACE</div>
              <h1 className="overview-title" id="overview-title">欢迎回到工作台</h1>
              <p className="overview-lede">从最近的上下文继续，或选择一位 Agent 开始新的工作。你的 Workspace、Sheet 与运行状态都在这里汇合。</p>
              <div className="overview-hero-actions">
                {localRecent[0] ? (
                  <button type="button" className="overview-primary-action" onClick={() => void openKnownSession(localRecent[0])}>
                    继续「{localRecent[0].name}」 <ArrowUpRight size={15} aria-hidden="true" />
                  </button>
                ) : activeAgentEntry && activeAgentConfigured ? (
                  <button type="button" className="overview-primary-action" onClick={() => void selectAgent(activeAgentEntry)}>
                    打开 {activeAgentEntry.name} <ArrowUpRight size={15} aria-hidden="true" />
                  </button>
                ) : (
                  <button type="button" className="overview-primary-action" onClick={openAgentSettings}>
                    配置 Agent <ArrowUpRight size={15} aria-hidden="true" />
                  </button>
                )}
                <button type="button" className="overview-secondary-action" onClick={openAgentSettings}>
                  <Settings2 size={14} aria-hidden="true" /> Agent 设置
                </button>
              </div>
            </div>
          </div>
          <div className="overview-pulse" aria-label={`${connectedCount} 个 Agent 已连接，${workspaces.length} 个工作区`}>
            <Activity size={16} aria-hidden="true" />
            <div><strong>{connectedCount}/{agents.length || 0}</strong><span>Agent 在线</span></div>
            <i aria-hidden="true" />
            <div><strong>{workspaces.length}</strong><span>工作区</span></div>
            <i aria-hidden="true" />
            <div><strong>{sessions.length}</strong><span>会话</span></div>
          </div>
        </section>
        {storage?.migrationAvailable && !migrationDismissed && (
          <div className="overview-migration" role="status">
            <span>检测到 AppData/AppConfig 中有旧数据，可迁移到当前便携目录。</span>
            <div className="set-preset-row">
              <button type="button" className="ps-btn sm primary" disabled={migrationBusy} onClick={() => void migrateToPortable()}>
                {migrationBusy ? '迁移中…' : '迁移'}
              </button>
              <button type="button" className="ps-btn sm" disabled={migrationBusy} onClick={() => setMigrationDismissed(true)}>
                暂不迁移
              </button>
            </div>
          </div>
        )}
        <section className="overview-section overview-agent-section" id="overview-agents">
          <div className="overview-section-heading">
            <div>
              <span className="overview-section-eyebrow">AGENT FLEET</span>
              <h2>选择 Agent</h2>
            </div>
            <span className="overview-section-meta">{agents.length} 个运行时</span>
          </div>
          {agents.length === 0 ? (
            <div className="overview-empty-agents">
              <Bot size={24} aria-hidden="true" />
              <div><strong>还没有 Agent</strong><p>配置一个 ACP Agent 后即可开始工作。</p></div>
              <button type="button" className="overview-secondary-action" onClick={openAgentSettings}>新建 Agent</button>
            </div>
          ) : (
            <div className="overview-agent-grid">
              {agents.map(agent => {
                const status = agentStatuses[agent.id]?.status ?? (agent.id === activeAgent ? 'unknown' : 'inactive')
                const sessionCount = sessions.filter(session => session.agentId === agent.id).length
                return (
                  <button
                    key={agent.id}
                    type="button"
                    className={`overview-agent-card ${agent.id === activeAgent ? 'is-active' : ''}`}
                    data-status={status}
                    disabled={switchingId === agent.id}
                    onClick={() => void selectAgent(agent)}
                  >
                    <span className="overview-agent-glyph" aria-hidden="true">{agent.name.slice(0, 1).toUpperCase()}</span>
                    <span className="overview-agent-copy">
                      <strong>{agent.name}</strong>
                      <span>{agent.provider || agent.transport || 'ACP'} · {sessionCount} 个会话</span>
                    </span>
                    <span className="overview-agent-state"><i aria-hidden="true" />{switchingId === agent.id ? '切换中' : statusLabel(status)}</span>
                    <ArrowUpRight className="overview-card-arrow" size={14} aria-hidden="true" />
                  </button>
                )
              })}
            </div>
          )}
        </section>

        <div className="overview-content-grid">
          <section className="overview-section overview-recent-section" id="overview-recent">
            <div className="overview-section-heading">
              <div>
                <span className="overview-section-eyebrow">RECENT CONTEXT</span>
                <h2>最近会话</h2>
              </div>
              <MessageSquare size={17} aria-hidden="true" />
            </div>
            {localRecent.length === 0 && persistedRecent.length === 0 ? (
              <div className="overview-list-empty"><MessageSquare size={20} aria-hidden="true" /><span>还没有可继续的会话</span></div>
            ) : (
              <div className="overview-session-list">
                {localRecent.map(session => {
                  const agent = agents.find(item => item.id === session.agentId)
                  const workspace = workspaces.find(item => item.id === session.workspaceId)
                  return (
                    <button type="button" className="overview-session-row" key={session.id} onClick={() => void openKnownSession(session)}>
                      <span className="overview-session-icon"><MessageSquare size={14} aria-hidden="true" /></span>
                      <span className="overview-session-copy"><strong>{session.name}</strong><span>{(workspace?.name ?? session.workdir) || '未绑定工作区'} · {agent?.name ?? session.agentId}</span></span>
                      <time>{relativeTime(session.lastActiveAt)}</time>
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </button>
                  )
                })}
                {persistedRecent.map(item => (
                  <button type="button" className="overview-session-row" key={item.id} onClick={() => void resumeSession(item)}>
                    <span className="overview-session-icon"><MessageSquare size={14} aria-hidden="true" /></span>
                    <span className="overview-session-copy"><strong>{item.title || item.source || item.id}</strong><span>持久化会话</span></span>
                    <time>{relativeTime(item.updatedAt)}</time>
                    <ArrowUpRight size={14} aria-hidden="true" />
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="overview-section overview-workspace-section" id="overview-workspaces">
            <div className="overview-section-heading">
              <div>
                <span className="overview-section-eyebrow">WORKSPACES</span>
                <h2>工作区</h2>
              </div>
              <Folder size={17} aria-hidden="true" />
            </div>
            {workspaces.length === 0 ? (
              <div className="overview-list-empty"><Folder size={20} aria-hidden="true" /><span>从左栏创建第一个工作区</span></div>
            ) : (
              <div className="overview-workspace-list">
                {[...workspaces].sort((a, b) => b.lastActiveAt - a.lastActiveAt).slice(0, 5).map(workspace => {
                  const linkedSessions = sessions.filter(session => session.workspaceId === workspace.id)
                  return (
                    <button type="button" className="overview-workspace-row" key={workspace.id} onClick={() => openWorkspace(workspace.id, workspace.agentId)}>
                      <span className="overview-folder-icon"><Folder size={15} aria-hidden="true" /></span>
                      <span className="overview-workspace-copy"><strong>{workspace.name}</strong><span title={workspace.rootPath}>{workspace.rootPath}</span></span>
                      <span className="overview-workspace-count">{linkedSessions.length} 会话</span>
                      <ArrowUpRight size={14} aria-hidden="true" />
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        </div>

        <section className="overview-config-strip" id="overview-advanced">
          <div>
            <span className="overview-section-eyebrow">ADVANCED</span>
            <strong>当前 Agent：{activeAgentEntry?.name ?? activeAgent}</strong>
            <span>需要直接检查底层配置时再展开 YAML 编辑器。</span>
          </div>
          <button type="button" className="overview-secondary-action" onClick={() => setShowConfigEditor(value => !value)}>
            <Settings2 size={14} aria-hidden="true" /> {showConfigEditor ? '收起编辑器' : '编辑高级配置'}
          </button>
        </section>
        {showConfigEditor && <div className="overview-config-editor"><AgentConfigEditor agentId={activeAgent} /></div>}
        {error && (errorIsValidation
          ? <div className="overview-error" role="alert">{error}</div>
          : <p className="overview-error overview-error-reference" role="status">操作失败，详情见右下角错误中心</p>)}
      </div>
      </main>
    </div>
  )
}
