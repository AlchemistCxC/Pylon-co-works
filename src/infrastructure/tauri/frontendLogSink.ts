import { invoke } from '@tauri-apps/api/core'
import { IS_TAURI } from './env.ts'
import { installFrontendLogSink } from '../../domains/diagnostics/frontendLogSink.ts'

/**
 * #488 批⑦：把前端诊断日志接进后端 runtime log（`push_frontend_log`，R8 每秒
 * 限流在后端侧）。fire-and-forget：任何失败（非 Tauri 宿主 / invoke 拒绝 / 限流
 * 报错）静默降级回 console——诊断出口自身不得成为新的故障源，也绝不向上抛。
 * `detail` 收进 message（后端有截长），Error 取 message。
 */
export function installTauriFrontendLogSink(): void {
  if (!IS_TAURI) return
  installFrontendLogSink({
    warn: (message, detail) => {
      void push('warn', message, detail)
    },
    error: (message, detail) => {
      void push('error', message, detail)
    },
  })
}

function push(level: 'warn' | 'error', message: string, detail?: unknown): Promise<unknown> {
  const merged = detail === undefined ? message : `${message}: ${formatDetail(detail)}`
  return invoke('push_frontend_log', { level, message: merged })
    .catch(() => {
      // 静默降级回 console（限流 / 桥故障）：单条日志的落点偏好不值得惊动用户。
      // 回落传原始 (message, detail)——devtools 侧结构不丢。
      if (level === 'error') console.error(message, detail)
      else console.warn(message, detail)
    })
}

/** detail 并入 message 的格式化：Error 取 message；对象走 JSON.stringify（失败
 * 或循环引用回落 String()——不得因日志格式化抛错）。 */
function formatDetail(detail: unknown): string {
  if (detail instanceof Error) return detail.message
  if (typeof detail === 'string') return detail
  if (typeof detail === 'object' && detail !== null) {
    try {
      return JSON.stringify(detail) ?? String(detail)
    } catch {
      return String(detail)
    }
  }
  return String(detail)
}
