import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { classifyAgentConfigSaveError, validateAgentConfig, type AgentConfigSaveStatus } from './agentConfigStatus.ts'
import { createAgentClient } from '../../infrastructure/acp/agentClient'
import { useIdentityStore } from '../../identityStore'

/**
 * AgentConfigEditor — Agent 配置编辑入口（W1-07）。
 *
 * scope="agent" 的 YAML 整块替换：调用 update_agents_config 写回生效配置，
 * 成功后刷新前端 agent 列表（写盘与内存提交均由后端事务完成，无需 reload_agents）。
 */
export default function AgentConfigEditor({ agentId }: { agentId: string }) {
  const [config, setConfig] = useState('')
  const [status, setStatus] = useState<AgentConfigSaveStatus>({ kind: 'idle' })

  const save = async () => {
    const validationError = validateAgentConfig(config)
    if (validationError) {
      setStatus({ kind: 'error', message: validationError })
      return
    }
    setStatus({ kind: 'saving' })
    try {
      const client = createAgentClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) })
      await client.updateAgentsConfig({ scope: 'agent', agentId, config })
      // 后端事务已原子提交 agents 域；前端刷新 agent 列表与工具字典，保持设置页一致。
      const list = await client.listAgents()
      useIdentityStore.getState().setAgents(list)
      setStatus({ kind: 'ok' })
    } catch (error) {
      const classified = classifyAgentConfigSaveError(error)
      setStatus(classified)
      if (classified.kind === 'error') reportRuntimeError('保存 Agent 配置', error)
    }
  }

  return (
    <div className="agent-config-editor">
      <textarea
        className="agent-config-textarea"
        value={config}
        onChange={event => { setConfig(event.target.value); setStatus({ kind: 'idle' }) }}
        placeholder="粘贴 Agent 配置（YAML）…"
        rows={8}
        aria-label="Agent 配置"
      />
      <div className="agent-config-actions">
        <button type="button" className="agent-config-save" onClick={save} disabled={status.kind === 'saving'}>
          {status.kind === 'saving' ? '保存中…' : '保存配置'}
        </button>
        {status.kind === 'blocked' && (
          <span className="agent-config-blocked" role="status">保存命令不可用：请检查应用版本是否包含 update_agents_config</span>
        )}
        {status.kind === 'error' && <span className="agent-config-error" role="alert">{status.message}</span>}
        {status.kind === 'ok' && <span className="agent-config-ok" role="status">配置已保存，Agent 列表已刷新</span>}
      </div>
    </div>
  )
}
