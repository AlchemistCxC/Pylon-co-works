import type { CanonicalEventRow } from '../../infrastructure/events/canonicalEventRepository.ts'
import { reconcileIngressMessages, type ChatIdentityCapabilities } from './messageIdentity'
import type { ChatEvent } from './sessionRuntimeStore.ts'
import type { Message } from './messageTypes.ts'

/**
 * Replay 权威历史与 load 期间 live 增量的合并 seam。
 * 只按外部 identity 去重；无 identity 的 live 增量保守保留。
 */
export function mergeReplayMessages<T extends {
  id: string
  role?: string
  sender?: string
  content?: string
  externalIdentity?: { messageId?: string; eventId?: string; turnId?: string; toolCallId?: string }
}>(
  resolved: T[],
  liveAdditions: T[],
  capabilities: ChatIdentityCapabilities = {},
): T[] {
  return reconcileIngressMessages(resolved, liveAdditions, capabilities)
}

/** 收敛并行 listener 注册结果，保留成功项并暴露失败项供重试。 */
export function settleListeners<T>(
  listeners: Array<Promise<T>>,
  onRejected: (reason: unknown, index: number) => void,
): Promise<{ fns: T[]; failures: Array<{ index: number; reason: unknown }> }> {
  return Promise.allSettled(listeners).then(results => {
    const fns: T[] = []
    const failures: Array<{ index: number; reason: unknown }> = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        fns.push(result.value)
      } else {
        failures.push({ index, reason: result.reason })
        onRejected(result.reason, index)
      }
    })
    return { fns, failures }
  })
}

export function stripReplayPersonaPrefix(content: string): string {
  const separator = '\n\n---\n\n'
  const index = content.indexOf(separator)
  if (index < 0) return content
  const stripped = content.slice(index + separator.length)
  return stripped || content
}

function canonicalTypedText(event: CanonicalEventRow): string | undefined {
  const text = (event.typedPayload as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : undefined
}

/** Match a load-buffered UI event to the canonical row that committed it. */
export function canonicalRepresentsChatEvent(row: CanonicalEventRow, event: ChatEvent): boolean {
  if (row.owner.localSessionId !== event.source) return false
  const identity = row.identity
  switch (event.type) {
    case 'user':
      return row.eventType === 'user.message' && canonicalTypedText(row) === event.content
    case 'message-chunk':
      return row.eventType === 'assistant.text.delta'
        && canonicalTypedText(row) === event.text
        && (!event.externalIdentity?.messageId || identity?.messageId === event.externalIdentity.messageId)
    case 'thought-chunk':
      return row.eventType === 'assistant.thinking.delta'
        && canonicalTypedText(row) === event.text
        && (!event.externalIdentity?.turnId || identity?.turnId === event.externalIdentity.turnId)
    case 'tool-call':
      return row.eventType === 'tool.call.started'
        && (!event.toolCallId || identity?.toolCallId === event.toolCallId)
    case 'tool-call-update':
      return ['tool.call.updated', 'tool.call.completed', 'tool.call.failed'].includes(row.eventType)
        && (!event.toolCallId || identity?.toolCallId === event.toolCallId)
    case 'done':
      return row.eventType === 'turn.completed'
    case 'error':
      return row.eventType === 'turn.failed'
    default:
      return false
  }
}

export function isRepresentedByCanonical(
  event: ChatEvent,
  canonicalEvents: readonly CanonicalEventRow[],
  consumed: Set<number>,
): boolean {
  const index = canonicalEvents.findIndex((row, rowIndex) =>
    !consumed.has(rowIndex) && canonicalRepresentsChatEvent(row, event),
  )
  if (index < 0) return false
  consumed.add(index)
  return true
}

export function isRenderedSource(source: string, renderedSource: string | null): boolean {
  return source.length > 0 && renderedSource === source
}

export function messagesRepresentSame(left: Message, right: Message): boolean {
  const leftIdentity = left.externalIdentity
  const rightIdentity = right.externalIdentity
  if (left.role === 'tool' && right.role === 'tool') {
    const leftToolCallId = leftIdentity?.toolCallId
    const rightToolCallId = rightIdentity?.toolCallId
    if (leftToolCallId && rightToolCallId) return leftToolCallId === rightToolCallId
  }
  for (const field of ['messageId', 'eventId', 'turnId'] as const) {
    const leftValue = leftIdentity?.[field]
    const rightValue = rightIdentity?.[field]
    if (leftValue && rightValue && leftValue === rightValue) return true
  }
  if (left.id === right.id) return true
  return left.role === right.role && left.content === right.content
}

export function mergeBase(cached: Message[], live: Message[], preferCanonicalOrder = false): Message[] {
  if (preferCanonicalOrder) {
    const unmatchedLive = [...live]
    const canonical = cached.map(message => {
      const matchedIndex = unmatchedLive.findIndex(candidate => messagesRepresentSame(message, candidate))
      if (matchedIndex >= 0) unmatchedLive.splice(matchedIndex, 1)
      return { ...message, running: false }
    })
    return unmatchedLive.length > 0 ? [...canonical, ...unmatchedLive] : canonical
  }
  const liveIds = new Set(live.map(message => message.id))
  const liveToolKeys = new Set<string>()
  const liveContentKeys = new Set<string>()
  for (const message of live) {
    if (message.role === 'tool') {
      const toolCallId = message.externalIdentity?.toolCallId
      if (toolCallId) liveToolKeys.add(`tool-call:${toolCallId}`)
    } else {
      liveContentKeys.add(`${message.role}:${message.content}`)
    }
  }
  const missing = cached
    .filter(message => {
      if (liveIds.has(message.id)) return false
      if (message.role === 'tool') {
        const toolCallId = message.externalIdentity?.toolCallId
        return toolCallId === undefined || !liveToolKeys.has(`tool-call:${toolCallId}`)
      }
      return !liveContentKeys.has(`${message.role}:${message.content}`)
    })
    .map(message => ({ ...message, running: false }))
  return missing.length > 0 ? [...live, ...missing] : live
}

export function insertMissingMessageAtBasePosition(
  messages: Message[],
  baseMessages: Message[],
  missingMessage: Message,
): Message[] {
  const baseIndex = baseMessages.indexOf(missingMessage)
  if (baseIndex < 0) return [...messages, missingMessage]

  for (let index = baseIndex + 1; index < baseMessages.length; index += 1) {
    const nextAnchor = messages.findIndex(message => messagesRepresentSame(message, baseMessages[index]))
    if (nextAnchor >= 0) {
      const result = [...messages]
      result.splice(nextAnchor, 0, missingMessage)
      return result
    }
  }
  for (let index = baseIndex - 1; index >= 0; index -= 1) {
    const previousAnchor = messages.findIndex(message => messagesRepresentSame(message, baseMessages[index]))
    if (previousAnchor >= 0) {
      const result = [...messages]
      result.splice(previousAnchor + 1, 0, missingMessage)
      return result
    }
  }
  return [...messages, missingMessage]
}
