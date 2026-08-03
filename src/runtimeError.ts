import { addError } from './errorCenter.ts'

export interface RuntimeErrorDetail {
  action: string
  message: string
}

export function formatRuntimeError(action: string, error: unknown): RuntimeErrorDetail {
  const raw = error instanceof Error ? error.message : String(error)
  return {
    action,
    message: raw && raw !== '[object Object]' ? raw : '未知错误',
  }
}

export function reportRuntimeError(action: string, error: unknown): RuntimeErrorDetail {
  const detail = formatRuntimeError(action, error)
  console.error(`${action}失败`, error)
  if (typeof window !== 'undefined') {
    // 聚合错误中心（保留事件分发向后兼容，如外部 listener）
    addError(detail)
    window.dispatchEvent(new CustomEvent<RuntimeErrorDetail>('pylon:runtime-error', { detail }))
  }
  return detail
}
