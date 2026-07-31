export interface MessageIdAllocator {
  next(prefix: string): string
}

/**
 * 每 ChatView 实例的单调消息 ID allocator。
 *
 * 替换历史 `Date.now()` 构造的 React key：同一毫秒内多个事件/分片可能碰撞，
 * 且 replay 与 live 共用不稳定身份。本 allocator 按实例维护单调递增本地
 * sequence，跨 user/msg/thought/err/tool-missing 前缀全局唯一（同一实例内
 * 所有 source 共享，比 per-source 更强且不会串）。
 *
 * tool_call 使用事件稳定 toolCallId（`tool-` + id），不经过本 allocator；
 * 只有缺失 toolCallId 的兜底 stub 使用 `tool-missing-` 前缀。
 */
export function createMessageIdAllocator(): MessageIdAllocator {
  let sequence = 0
  return {
    next(prefix: string) {
      sequence += 1
      return `${prefix}-${sequence}`
    },
  }
}
