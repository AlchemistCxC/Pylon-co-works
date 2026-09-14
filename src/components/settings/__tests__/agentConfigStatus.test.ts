// 迁移自 scripts/test-agent-config-editor.mts（P91 A1）；源码正则与组件接线段不迁（接线已有 AgentConfigEditor.test.tsx 覆盖）。
import { describe, expect, it } from 'vitest'
import { classifyAgentConfigSaveError, validateAgentConfig } from '../agentConfigStatus.ts'

// W1-07：Agent 配置入口——command missing/成功/配置错误三路径 + 不冒充写回

describe('classifyAgentConfigSaveError — 保存错误分类（W1-07，迁移自 scripts/test-agent-config-editor.mts）', () => {
  it('command missing → blocked（保存命令不可用）', () => {
    expect(classifyAgentConfigSaveError(new Error('Command not found: update_agents_config'))).toEqual({ kind: 'blocked' })
    expect(classifyAgentConfigSaveError('unknown command: update_agents_config')).toEqual({ kind: 'blocked' })
    expect(classifyAgentConfigSaveError('no such command')).toEqual({ kind: 'blocked' })
    expect(classifyAgentConfigSaveError('update_agents_config 不存在')).toEqual({ kind: 'blocked' })
  })

  it('配置错误 → error 带消息', () => {
    expect(classifyAgentConfigSaveError(new Error('config_error: 非法 agent 配置'))).toEqual({ kind: 'error', message: 'config_error: 非法 agent 配置' })
    expect(classifyAgentConfigSaveError('protocol_error')).toEqual({ kind: 'error', message: 'protocol_error' })
    expect(classifyAgentConfigSaveError('[object Object]')).toEqual({ kind: 'error', message: '保存 Agent 配置失败' })
  })

  it('前端校验：非空', () => {
    expect(validateAgentConfig('')).toBe('配置不能为空')
    expect(validateAgentConfig('  \n  ')).toBe('配置不能为空')
    expect(validateAgentConfig('agents:\n  peri:\n    exe: peri')).toBeNull()
  })
})
