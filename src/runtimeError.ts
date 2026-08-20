import { addError } from './errorCenter.ts'

export type RecoveryKind = 'open-agent-settings' | 'select-agent-executable' | 'open-runtime-log'

export interface RuntimeErrorDetail {
  action: string
  message: string
  /** 后端稳定错误码（施工文档 §5.2）；缺失时保留 undefined。 */
  code?: string
  /** 可行动恢复入口（ErrorCenter 据此渲染恢复按钮）。 */
  recovery?: {
    kind: RecoveryKind
    agentId?: string
  }
}

interface StructuredWireError {
  message?: unknown
  code?: unknown
}

/** 从后端 wire 错误提取 code 与 message（不把 code 拼进 message 后丢失结构）。 */
function structuredErrorParts(error: unknown): { code?: string; message: string } | null {
  if (error && typeof error === 'object') {
    const shape = error as StructuredWireError
    if (typeof shape.message === 'string' && shape.message.trim().length > 0) {
      return {
        code: typeof shape.code === 'string' && shape.code.trim() ? shape.code.trim() : undefined,
        message: shape.message.trim(),
      }
    }
  }
  return null
}

/** 从部署错误码推导恢复入口（施工文档 §5.3 按钮映射）。 */
export function recoveryForCode(code: string | undefined, agentId?: string): RuntimeErrorDetail['recovery'] {
  switch (code) {
    case 'agent_executable_missing':
      return { kind: 'select-agent-executable', agentId }
    case 'config_read_only':
    case 'config_write_error':
      return { kind: 'open-agent-settings', agentId }
    case 'agent_spawn_failed':
    case 'agent_initialize_failed':
    case 'agent_connection_timeout':
      return { kind: 'open-runtime-log' }
    default:
      return undefined
  }
}

export function formatRuntimeError(action: string, error: unknown, agentId?: string): RuntimeErrorDetail {
  if (error === null || error === undefined) {
    return { action, message: '未知错误' }
  }
  if (error instanceof Error) {
    const message = error.message.trim().length > 0 ? error.message : '未知错误'
    return { action, message }
  }
  const parts = structuredErrorParts(error)
  if (parts !== null) {
    return {
      action,
      message: parts.message,
      code: parts.code,
      recovery: recoveryForCode(parts.code, agentId),
    }
  }
  const raw = String(error)
  const message = raw && raw.trim().length > 0 && raw !== '[object Object]'
    ? raw
    : '未知错误'
  return { action, message }
}

export function reportRuntimeError(action: string, error: unknown, agentId?: string): RuntimeErrorDetail {
  const detail = formatRuntimeError(action, error, agentId)
  console.error(`${action}失败`, error)
  if (typeof window !== 'undefined') {
    // 聚合错误中心（保留事件分发向后兼容，如外部 listener）
    addError(detail)
    window.dispatchEvent(new CustomEvent<RuntimeErrorDetail>('pylon:runtime-error', { detail }))
  }
  return detail
}
