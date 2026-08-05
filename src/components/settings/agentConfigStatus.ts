/**
 * agentConfigStatus — Agent 配置保存状态纯推导（W1-07 桩化）。
 *
 * update_agents_config 命令待产品侧提供（桩化先行）：前端表单/校验/调用点就位，
 * 命令不可用（invoke 报 not found）→ 明确「待后端」阻塞态；配置错误 → 展示后端
 * 错误码消息；成功 → ok。不调用 reload_agents 冒充写回。
 */

export type AgentConfigSaveStatus =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'ok' }
  | { kind: 'blocked' }
  | { kind: 'error'; message: string }

/** invoke 错误分类：命令不存在 → blocked（待后端）；其余 → error 带消息 */
export function classifyAgentConfigSaveError(error: unknown): Exclude<AgentConfigSaveStatus, { kind: 'idle' } | { kind: 'saving' } | { kind: 'ok' }> {
  const message = error instanceof Error ? error.message : String(error)
  if (/not ?found|不存在|unknown command|unrecognized|no such command/i.test(message)) {
    return { kind: 'blocked' }
  }
  return { kind: 'error', message: message && message !== '[object Object]' ? message : '保存 Agent 配置失败' }
}

/** 前端校验：配置文本非空（更细校验待真实契约到位） */
export function validateAgentConfig(config: string): string | null {
  if (!config || !config.trim()) return '配置不能为空'
  return null
}
