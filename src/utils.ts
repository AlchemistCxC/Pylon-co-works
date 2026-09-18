/**
 * #116 子项 4：口径与 OverviewSheetView 的 relativeTime 对齐——同一批会话数据在
 * Overview 显示「2 天前」、在侧栏显示「2d ago」，是同一应用内两种说法。
 */
export function formatTime(ts: number | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/**
 * #172：Tauri invoke 的拒绝值是 `{ code, message }` 结构化对象（非 Error），
 * 裸 `String(error)` 会把真实原因吞成「[object Object]」。本助手是
 * workspaceContracts / browserContracts / gatewayContracts / gitContracts /
 * agentConfigStatus 各处归一化惯例的共享版；提取不到可读 message 时回退 fallback。
 */
export function errorMessage(error: unknown, fallback = ''): string {
  const raw = error instanceof Error
    ? error.message
    : error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error)
  return raw && raw !== '[object Object]' ? raw : fallback
}

/** #172：读取结构化拒绝 DTO 的 `code`（如 NoActiveAgent / AgentRuntimeUnavailable / Acp），非该形状返回 null。 */
export function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code: unknown }).code
  return typeof code === 'string' && code ? code : null
}
