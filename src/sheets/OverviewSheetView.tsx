import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { IS_TAURI } from '../infrastructure/tauri/env'
import { useIdentityStore, type AgentEntry } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { reportRuntimeError } from '../runtimeError'
import { runAgentSwitchTransaction } from '../components/agentSwitchTransaction'
import AgentConfigEditor from '../components/settings/AgentConfigEditor'
import PylonMark from '../components/PylonMark'
import { recentPersistedSessions, type PersistedSessionSummary } from '../domains/overview/persistedSessions.ts'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'
import './OverviewSheetView.css'

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
  const activeAgent = useIdentityStore(s => s.activeAgent) || 'peri'
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [recent, setRecent] = useState<PersistedSessionSummary[]>([])
  const [showConfigEditor, setShowConfigEditor] = useState(false)

  // W1-06：加载最近会话（宽松 normalize，形状漂移不崩）
  useEffect(() => {
    if (!IS_TAURI) return
    let disposed = false
    invoke('list_persisted_sessions').then(raw => {
      if (!disposed) setRecent(recentPersistedSessions(raw))
    }).catch(err => reportRuntimeError('读取最近会话', err))
    return () => { disposed = true }
  }, [])

  const selectAgent = async (agent: AgentEntry) => {
    if (switchingId) return
    setSwitchingId(agent.id)
    setError('')
    const ok = await runAgentSwitchTransaction({
      switchAgent: () => invoke('switch_agent', { name: agent.id }),
      onSuccess: () => {
        useRuntimeStore.getState().resetAll()
        useIdentityStore.getState().setActiveAgent(agent.id)
        window.dispatchEvent(new CustomEvent('pylon:agent-switched'))
        // 无缝进 sheet：成功后 open agent sheet（失败保持 overview 由 return false 承载）
        ctx.openSheet({ kind: 'agent', title: agent.name, agentId: agent.id })
      },
      onError: err => {
        setError(err instanceof Error ? err.message : String(err))
        reportRuntimeError('选择 Agent', err)
      },
    })
    if (!ok) setSwitchingId(null)
  }

  // W1-06：复用现有 identity session；无则创建 row 并纠正 source/periId（不直接 load——
  // 由 ChatView 挂载后的 lifecycle 执行 load，保证 listener/controller 就绪）
  const resumeSession = (p: PersistedSessionSummary) => {
    setError('')
    const store = useIdentityStore.getState()
    const existing = store.sessions.find(s => s.source === p.source || (p.periId && s.periId === p.periId))
    let id: string | null
    if (existing) {
      id = existing.id
    } else {
      const before = store.sessions.length
      const name = p.title || `session-${Date.now().toString(36)}`
      useIdentityStore.getState().addSession(name)
      const created = useIdentityStore.getState().sessions[before]
      if (created) {
        useIdentityStore.getState().updateSession(created.id, {
          ...(p.source ? { source: p.source } : {}),
          ...(p.periId ? { periId: p.periId } : {}),
          lastActiveAt: p.updatedAt || Date.now(),
        })
        id = created.id
      } else {
        id = null
      }
    }
    if (!id) return
    ctx.selectSession(id)
    ctx.openSheet({ kind: 'agent', title: p.title || 'Agent', agentId: activeAgent })
  }

  return (
    <div className="overview-sheet">
      <div className="overview-shell">
        <header className="overview-hero">
          <PylonMark size={56} className="overview-brand-mark" title="Pylon" />
          <div className="overview-hero-copy">
            <div className="overview-kicker">PYLON WORKSPACE</div>
            <h1 className="overview-title">开始工作</h1>
            <p className="overview-lede">选择 Agent、调整配置，或从最近会话继续。工作区会保留你的 Sheet 与上下文。</p>
          </div>
        </header>
        <div className="overview-entries">
          <section className="overview-entry">
            <span className="overview-entry-index">01</span>
            <h2 className="overview-entry-title">选择 Agent</h2>
            {agents.length === 0 ? (
              <p className="overview-hint">等待 Agent 列表…</p>
            ) : (
              <ul className="overview-agent-list">
                {agents.map(agent => (
                  <li key={agent.id}>
                    <button
                      type="button"
                      className="overview-agent-btn"
                      disabled={switchingId === agent.id}
                      onClick={() => selectAgent(agent)}
                    >
                      {agent.name}
                      {switchingId === agent.id && <span className="overview-switching">切换中…</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="overview-entry">
            <span className="overview-entry-index">02</span>
            <h2 className="overview-entry-title">配置 Agent</h2>
            <p className="overview-hint">编辑 Agent 配置（update_agents_config 待后端）</p>
            <button type="button" className="overview-agent-btn" onClick={() => setShowConfigEditor(value => !value)}>
              {showConfigEditor ? '收起编辑器' : '编辑配置'}
            </button>
            {showConfigEditor && <AgentConfigEditor agentId={activeAgent} />}
          </section>
          <section className="overview-entry">
            <span className="overview-entry-index">03</span>
            <h2 className="overview-entry-title">继续会话</h2>
            {recent.length === 0 ? (
              <p className="overview-hint">最近没有可恢复的会话</p>
            ) : (
              <ul className="overview-agent-list">
                {recent.map(p => (
                  <li key={p.id}>
                    <button type="button" className="overview-agent-btn" onClick={() => resumeSession(p)}>
                      {p.title || p.source || p.id}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        {error && <div className="overview-error" role="alert">{error}</div>}
      </div>
    </div>
  )
}
