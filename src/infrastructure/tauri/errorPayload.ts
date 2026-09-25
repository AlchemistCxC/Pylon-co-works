/**
 * #172：Tauri invoke 的拒绝值是 `{ code, message }` 结构化对象（非 Error），
 * 裸 `String(error)` 会把真实原因吞成「[object Object]」。本模块是
 * workspaceContracts / browserContracts / gatewayContracts / gitContracts /
 * agentConfigStatus 各处归一化惯例的共享版——后端 `error.rs` DTO 的前端
 * 唯一解释点（归属 infrastructure：形状由 IPC 边界定义）。
 */

/**
 * 提取可读 message：Error 实例取 `message`；结构化对象取 `message` 字段；
 * 其余走 `String()`。提取不到可读文本（空、`[object Object]`、null/undefined）
 * 时回退 fallback。
 */
export function errorMessage(error: unknown, fallback = ''): string {
  const raw = error instanceof Error
    ? error.message
    : error == null
      ? ''
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error)
  return raw && raw !== '[object Object]' ? raw : fallback
}

/** 读取结构化拒绝 DTO 的 `code`（如 NoActiveAgent / AgentRuntimeUnavailable / Acp），非该形状返回 null。 */
export function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('code' in error)) return null
  const code = (error as { code: unknown }).code
  return typeof code === 'string' && code ? code : null
}

/**
 * #317 批次二：各 repository 的 typed Error 包装共用提取核心——结构化对象取
 * `{ code, message }`；Error 实例/其余（含原裸 String 命令面）取 message。
 * code 经字符串校验（后端 DTO 恒为字符串；校验替代各点的历史裸 cast）。
 */
export function wireErrorParts(error: unknown): { code: string | undefined; message: string } {
  if (error && typeof error === 'object' && ('message' in error || 'code' in error)) {
    const shape = error as { code?: unknown; message?: unknown }
    return {
      code: typeof shape.code === 'string' && shape.code ? shape.code : undefined,
      message: String(shape.message ?? error),
    }
  }
  return { code: undefined, message: String(error) }
}
