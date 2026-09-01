/**
 * browserContracts — Browser Sheet 的启动错误分类与轻量会话类型。
 *
 * Browser Sheet 现在由桌面端 WebView2 manager 提供真实命令面（开发浏览器只提供
 * 明确标注的 iframe preview）。这里仍保持前端的错误分类边界：命令不存在属于
 * blocked，其余启动失败保留后端返回的可读消息；不读取 cookie、storage 或请求头。
 */

export interface BrowserSessionInfo {
  instanceId?: string
  profileId?: string
}

export type BrowserStartStatus =
  | { kind: 'blocked' }
  | { kind: 'error'; message: string }

/** 命令不可用 → blocked；其余启动失败 → error */
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
