import type { Message } from './messageTypes'
import { toolIdFromMessage } from '../tool/id.ts'
import { normalizeToolStatus } from '../tool/status.ts'

export interface MessageLookups {
  resolvedToolIds: Set<string>
  failedToolIds: Set<string>
  runningToolIds: Set<string>
}

export function buildMessageLookups(messages: readonly Message[]): MessageLookups {
  const resolvedToolIds = new Set<string>()
  const failedToolIds = new Set<string>()
  const runningToolIds = new Set<string>()

  for (const message of messages) {
    const toolId = toolIdFromMessage(message)
    if (!toolId) continue
    const visualStatus = message.toolStatus
    const normalizedStatus = normalizeToolStatus(visualStatus)
    if (message.running || visualStatus === 'pending' || visualStatus === 'in_progress') {
      runningToolIds.add(toolId)
    }
    if (visualStatus === 'failed' || visualStatus === 'error') {
      failedToolIds.add(toolId)
    }
    // A cancelled tool may still include provider output (for example, a
    // partial stream or a cancellation reason). Keep the source status in the
    // rendered row instead of letting the output presence promote it to
    // completed. This is a presentation-only guard; domain status and output
    // payloads remain untouched.
    if (!message.running && normalizedStatus !== 'cancelled' && (visualStatus === 'completed' || message.toolOutput !== undefined)) {
      resolvedToolIds.add(toolId)
    }
  }

  return { resolvedToolIds, failedToolIds, runningToolIds }
}

/**
 * #441-A：`buildMessageLookups` 的单槽引用门（前提与 `prepareMessagesOf` 同：纯函数 +
 * 快照冻结数组的 COW 纪律）。生产链里 tool 行只存在于 legacy 预览宿主——canonical 路径
 * 上三个 Set 恒空，但每次发布仍白扫整表；门控后同引用发布直接复用。
 */
let lookupsMemo: { readonly source: readonly Message[], readonly out: MessageLookups } | undefined

export function messageLookupsOf(messages: readonly Message[]): MessageLookups {
  const memo = lookupsMemo
  if (memo !== undefined && memo.source === messages) return memo.out
  const out = buildMessageLookups(messages)
  lookupsMemo = { source: messages, out }
  return out
}
