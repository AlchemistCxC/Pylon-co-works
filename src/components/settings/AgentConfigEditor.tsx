import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { reportRuntimeError } from '../../runtimeError'
import { classifyAgentConfigSaveError, validateAgentConfig, type AgentConfigSaveStatus } from './agentConfigStatus.ts'

/**
 * AgentConfigEditor — Agent 配置编辑入口（W1-07 桩化）。
 *
 * 只定义前端表单/校验/调用 update_agents_config 契约；命令不可用（invoke not found）
 * → 明确「待后端」阻塞态，不改 config 文件、不调用 reload_agents 冒充写回。
 * 真实后端契约到位后替换 invoke 参数形状即可（契约文件以实际返回为准）。
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
      // 契约：update_agents_config（待产品侧后端命令）；参数形状以后端实际契约为准
      await invoke('update_agents_config', { agentId, config })
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
          <span className="agent-config-blocked" role="status">待后端：update_agents_config 命令尚未提供，无法写回配置</span>
        )}
        {status.kind === 'error' && <span className="agent-config-error" role="alert">{status.message}</span>}
        {status.kind === 'ok' && <span className="agent-config-ok" role="status">配置已保存</span>}
      </div>
    </div>
  )
}
