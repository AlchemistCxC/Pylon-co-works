/**
 * browserContracts — browser 契约壳（W4-04 桩化）。
 *
 * CDP 命令契约未定——**不虚构命令名**（W4-03 纪律）；本文件预留 normalize 与错误分类
 * 的桩形状（后端契约到位后对齐字段名并接真实 invoke）。前端只消费后端返回的
 * session/profile 标识（不读 cookie，不导出，不进 localStorage）。
 */

export interface BrowserSessionInfo {
  instanceId?: string
  profileId?: string
}

export type BrowserStartStatus =
  | { kind: 'blocked' }
  | { kind: 'error'; message: string }

/** 命令不可用 → blocked（待后端 CDP 契约）；其余 error */
export function classifyBrowserStartError(error: unknown): BrowserStartStatus {
  // Tauri invoke 拒绝值为 { code, message } 结构化对象（非 Error）——提取 message 而非 [object Object]
  const raw = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error)
  const message = raw && raw !== '[object Object]' ? raw : '浏览器启动失败'
  if (/not ?found|不存在|unknown command|no such command/i.test(message)) return { kind: 'blocked' }
  return { kind: 'error', message }
}
