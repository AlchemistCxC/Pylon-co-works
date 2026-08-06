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
  const message = error instanceof Error ? error.message : String(error)
  if (/not ?found|不存在|unknown command|no such command/i.test(message)) return { kind: 'blocked' }
  return { kind: 'error', message: message && message !== '[object Object]' ? message : '浏览器启动失败' }
}
