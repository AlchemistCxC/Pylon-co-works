import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useIdentityStore, type AgentEntry } from '../identityStore'
import { useRuntimeStore } from '../runtimeStore'
import { reportRuntimeError } from '../runtimeError'
import { runAgentSwitchTransaction } from '../components/agentSwitchTransaction'
import type { SheetContext, SheetRecord } from '../workspace-sheets/sheetTypes'
import './OverviewSheetView.css'

/**
 * OverviewSheetView — 启动选择器（W1-05，§5.1）。
 *
 * 虚拟空态（不写入持久 sheet 数组）：无 active sheet 时 SheetLayout 直接渲染 overview。
 * 三入口：选择 Agent（list_agents → switch_agent → 无缝 open agent sheet，成功后
 * open/focus 目标，失败保持 overview 并报错）/ 配置 Agent（W1-07 接线）/ 继续会话
 * （W1-06 接线，最近 5 个）。
 */
export default function OverviewSheetView({ ctx }: { sheet: SheetRecord; ctx: SheetContext }) {
  const agents = useIdentityStore(s => s.agents)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const [error, setError] = useState('')

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

  return (
    <div className="overview-sheet">
      <div className="overview-kicker">PYLON WORKSPACE</div>
      <h1 className="overview-title">开始工作</h1>
      <div className="overview-entries">
        <section className="overview-entry">
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
          <h2 className="overview-entry-title">配置 Agent</h2>
          <p className="overview-hint">编辑 Agent 配置（W1-07 接线）</p>
        </section>
        <section className="overview-entry">
          <h2 className="overview-entry-title">继续会话</h2>
          <p className="overview-hint">恢复最近会话（W1-06 接线）</p>
        </section>
      </div>
      {error && <div className="overview-error" role="alert">{error}</div>}
    </div>
  )
}
