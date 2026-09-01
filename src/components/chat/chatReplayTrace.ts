import type { Message } from './messageTypes'

export const CHAT_REPLAY_TRACE_FLAG = 'pylon-chat-replay-trace'
export const CHAT_REPLAY_TRACE_KEY = 'pylon-chat-replay-trace-jsonl'
export const CHAT_REPLAY_TRACE_CONTRACT = 'C0-v1.0-20260902'
const MAX_TRACE_LINES = 500

/**
 * Fields shared with the Kernel `replay_trace` structured record.  They stay
 * optional because `load-start` is emitted before the response boundary and
 * failure traces do not have a commit outcome.
 */
export interface ReplayTraceContractFields {
  owner?: string
  loadGeneration?: number
  captureLp?: string | null
  responseBoundary?: string
  observedCount?: number
  retainedCount?: number
  droppedCount?: number
  authority?: string
  canonicalRevision?: number
  commitOutcome?: string
  errorCode?: string
}

export interface ChatReplayTraceEvent {
  at: number
  kind: string
  ownerSessionId?: string
  source?: string
  generation?: number
  revision?: number | null
  messageIds?: string[]
  messageCount?: number
  contentLength?: number
  contentHash?: string
  /** C0-v1.0 cross-line fields; names mirror backend replay_trace semantics. */
  contract?: typeof CHAT_REPLAY_TRACE_CONTRACT
  owner?: ReplayTraceContractFields['owner']
  loadGeneration?: ReplayTraceContractFields['loadGeneration']
  captureLp?: ReplayTraceContractFields['captureLp']
  responseBoundary?: ReplayTraceContractFields['responseBoundary']
  observedCount?: ReplayTraceContractFields['observedCount']
  retainedCount?: ReplayTraceContractFields['retainedCount']
  droppedCount?: ReplayTraceContractFields['droppedCount']
  authority?: ReplayTraceContractFields['authority']
  canonicalRevision?: ReplayTraceContractFields['canonicalRevision']
  commitOutcome?: ReplayTraceContractFields['commitOutcome']
  errorCode?: ReplayTraceContractFields['errorCode']
  detail?: Record<string, string | number | boolean | null>
}

function safeStorage(): Storage | null {
  try { return typeof localStorage !== 'undefined' ? localStorage : null } catch { return null }
}

/** 非加密安全摘要：只用于对账同一内容，不记录正文。 */
export function safeContentEvidence(messages: readonly Message[]): Pick<ChatReplayTraceEvent, 'messageIds' | 'messageCount' | 'contentLength' | 'contentHash'> {
  const joined = messages.map(message => `${message.role}\u0000${message.sender}\u0000${message.content}`).join('\u0001')
  let hash = 0x811c9dc5
  for (let i = 0; i < joined.length; i += 1) {
    hash ^= joined.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return {
    messageIds: messages.map(message => message.id),
    messageCount: messages.length,
    contentLength: joined.length,
    contentHash: hash.toString(16).padStart(8, '0'),
  }
}

/**
 * ISSUE-06 真实失败观测 JSONL。默认关闭；正文永不写入，只记录 ids/长度/安全 hash。
 */
export function recordChatReplayTrace(event: Omit<ChatReplayTraceEvent, 'at'> & { at?: number }): void {
  const storage = safeStorage()
  if (!storage) return
  try {
    if (storage.getItem(CHAT_REPLAY_TRACE_FLAG) !== '1') return
    const line = JSON.stringify({ ...event, at: event.at ?? Date.now() })
    const existing = storage.getItem(CHAT_REPLAY_TRACE_KEY)?.split('\n').filter(Boolean) ?? []
    const lines = [...existing, line].slice(-MAX_TRACE_LINES)
    storage.setItem(CHAT_REPLAY_TRACE_KEY, lines.join('\n'))
  } catch {
    // 观测不得影响生产消息链。
  }
}

export function readChatReplayTrace(): ChatReplayTraceEvent[] {
  const storage = safeStorage()
  if (!storage) return []
  try {
    return (storage.getItem(CHAT_REPLAY_TRACE_KEY)?.split('\n').filter(Boolean) ?? [])
      .map(line => JSON.parse(line) as ChatReplayTraceEvent)
  } catch {
    return []
  }
}

/**
 * Keep replay failures machine-readable without copying provider error text
 * into the trace.  Existing structured codes pass through; unknown errors use
 * one stable fallback understood by the cross-line contract tests.
 */
export function replayErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && /^[a-z0-9][a-z0-9_.-]*$/.test(code)) return code
  }
  return 'replay_load_failed'
}
