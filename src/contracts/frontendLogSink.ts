/**
 * #488 批⑦：前端诊断日志的最小出口端口（logSink）。
 *
 * 之前散落的 `console.warn/error` 中英混排、且绕过后端 runtime log——运行日志
 * 面板看不到前端侧的降级/失败诊断。收敛为单口：缺省出口是 console（浏览器
 * mock / 测试宿主的原行为），App 启动时由 infrastructure 换装「推后端
 * `push_frontend_log`」的实现（见 `infrastructure/tauri/frontendLogSink.ts`）。
 *
 * 契约：出口自身不得成为故障源——换装失败或后端推送失败一律静默降级回
 * console，任何实现都不得抛出。`detail` 建议传 Error（实现侧取 message）。
 */
export interface FrontendLogSink {
  warn(message: string, detail?: unknown): void
  error(message: string, detail?: unknown): void
}

const consoleSink: FrontendLogSink = {
  warn(message, detail) {
    if (detail === undefined) console.warn(message)
    else console.warn(message, detail)
  },
  error(message, detail) {
    if (detail === undefined) console.error(message)
    else console.error(message, detail)
  },
}

let active: FrontendLogSink = consoleSink

/** 换装出口（App 启动时调用；未调用则停留 console）。 */
export function installFrontendLogSink(next: FrontendLogSink): void {
  active = next
}

/** 测试复位（生产不调用）。 */
export function resetFrontendLogSinkForTest(): void {
  active = consoleSink
}

export function logWarn(message: string, detail?: unknown): void {
  try {
    active.warn(message, detail)
  } catch {
    // 出口自身故障：静默回落 console（约束：不得因日志故障影响功能）。
    consoleSink.warn(message, detail)
  }
}

export function logError(message: string, detail?: unknown): void {
  try {
    active.error(message, detail)
  } catch {
    consoleSink.error(message, detail)
  }
}
