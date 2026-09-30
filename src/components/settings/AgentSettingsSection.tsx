import { useIdentityStore } from '../../domains/identity/identityStore'
import { useRuntimeStore } from '../../domains/runtime/runtimeStore'
import { selectAgentStatus, statusLabel } from '../../contracts/agentTypes'
import AgentRuntimePanel from './AgentRuntimePanel'
import AgentConfigEditor from './AgentConfigEditor'
import ConfigOptionsPanel from './ConfigOptionsPanel'
import { Group } from './settingsSectionShared.tsx'
import { useSettingsAgentActions } from './settingsAgentActions'

/**
 * AgentSettingsSection — 设置页 agent 分区（A-V3 拆分自 Settings.tsx，JSX 逐字随迁）：
 * 当前 Agent 概况卡（重连/重载/事实行/权威状态提示）+ 切换 Agent 列表 +
 * 发现与管理（AgentRuntimePanel）+ 高级 YAML/动态配置。事务等待态经
 * useSettingsAgentActions 自持，Settings 主组件不再持有 agent 运维状态。
 */
export default function AgentSettingsSection({ initialAgentId, activeSessionContext }: {
  initialAgentId?: string
  activeSessionContext?: { agentId: string; source: string }
}) {
  const agents = useIdentityStore(s => s.agents)
  const activeAgent = useIdentityStore(s => s.activeAgent)
  const agentStatuses = useRuntimeStore(s => s.agentStatuses)
  const { switchingAgentId, reconnectPending, reconnectCommandError, reloading, dictFeedback, switchAgent, reconnectAgent, reloadAgents } = useSettingsAgentActions(activeAgent)
  const currentStatus = selectAgentStatus(activeAgent, activeAgent, agentStatuses)
  // #326：零 Agent 是合法首跑状态。此前这里回落硬编码 'peri'——会在没有该 Agent 时
  // 显示一个不存在的名字/ID（与「预置必然失败的占位 Agent」同一类病），改为如实空态。
  const activeAgentEntry = agents.find(agent => agent.id === activeAgent)

  return (
    <>
      <div className="agent-settings-heading">
        <div><h3>Agent</h3><p>连接、发现与导入集中在这里；YAML 和动态配置保留在高级区域。</p></div>
      </div>
      <section className="agent-settings-overview" aria-label="当前 Agent 概况">
        <div className="agent-settings-overview-main">
          <span className={`agent-status-indicator is-${currentStatus.status}`} aria-hidden="true" />
          <div>
            <span className="agent-settings-kicker">当前 Agent</span>
            <strong>{activeAgentEntry?.name || activeAgent || '尚未配置 Agent'}</strong>
            {activeAgent
              ? <span>{activeAgent}</span>
              : <span>在下方「发现与管理 Agent」新建后即可连接</span>}
            <span className="agent-settings-status-copy">状态：{activeAgent ? statusLabel(currentStatus.status) : '未配置'}</span>
          </div>
        </div>
        <div className="agent-settings-actions">
          <button type="button" className="ps-btn sm primary" disabled={reconnectPending || !activeAgent} onClick={reconnectAgent}>{reconnectPending ? '重连中…' : '重新连接'}</button>
          <button type="button" className="ps-btn sm" disabled={reloading} onClick={reloadAgents}>{reloading ? '重载中…' : '重载配置'}</button>
        </div>
        <dl className="agent-settings-facts">
          <div><dt>传输方式</dt><dd>{currentStatus.transport || '未报告'}</dd></div>
          <div><dt>工作目录</dt><dd title={currentStatus.cwd}>{currentStatus.cwd || '跟随会话'}</dd></div>
        </dl>
        {/* This is an authoritative Agent status fact, not a dismissible
            runtime toast; keep the alert semantics for assistive tech. */}
        {currentStatus.recentError && <div className="agent-settings-notice error" role="alert">最近错误：{currentStatus.recentError}</div>}
        {reconnectCommandError && <div className="agent-settings-notice error" role="status">重连失败，详情见右下角错误中心</div>}
        {dictFeedback && <div className="agent-settings-notice" role="status">{dictFeedback}</div>}
      </section>
      <Group title="切换 Agent">
        <div className="agent-switch-list">
          {agents.map((agent) => (
            <button key={agent.id} type="button" className={`agent-switch-card ${agent.id === activeAgent ? 'active' : ''}`}
              disabled={switchingAgentId !== null || agent.id === activeAgent}
              aria-busy={switchingAgentId === agent.id}
              onClick={() => switchAgent(agent.id)}>
              <span className="agent-switch-copy"><strong>{agent.name}</strong><small>{agent.provider || agent.id}</small></span>
              <span className="agent-switch-state">{switchingAgentId === agent.id ? '连接中…' : agent.id === activeAgent ? '当前' : '切换'}</span>
            </button>
          ))}
        </div>
        <div className="set-hint">切换会立即重置当前会话的运行时状态。</div>
      </Group>
      <Group title="发现与管理 Agent">
        <AgentRuntimePanel initialAgentId={initialAgentId} />
      </Group>
      <Group title="高级：YAML 配置" defaultOpen={false}>
        <AgentConfigEditor agentId={activeAgent} />
        <div className="set-hint">保存会原子写回生效配置并刷新 Agent 列表；当前 active agent 不可被删除。</div>
      </Group>
      <Group title="高级：会话动态配置" defaultOpen={false}>
        <ConfigOptionsPanel context={activeSessionContext} />
      </Group>
    </>
  )
}
