import type { OptionalChatEventIdentity } from '../../infrastructure/acp/chatContracts'

export type CapabilityStatus = 'supported' | 'unsupported' | 'unknown'

export interface ChatIdentityCapabilities {
  message?: CapabilityStatus
  event?: CapabilityStatus
  turn?: CapabilityStatus
  toolCall?: CapabilityStatus
}

export function detectChatIdentityCapabilities(replay: readonly unknown[]): ChatIdentityCapabilities {
  let message: CapabilityStatus = 'unsupported'
  let event: CapabilityStatus = 'unsupported'
  let turn: CapabilityStatus = 'unsupported'
  let toolCall: CapabilityStatus = 'unsupported'
  for (const raw of replay) {
    if (typeof raw !== 'object' || raw === null) continue
    const envelope = raw as Record<string, unknown>
    const update = typeof envelope.update === 'object' && envelope.update !== null
      ? envelope.update as Record<string, unknown>
      : undefined
    if (!update) continue
    const content = typeof update.content === 'object' && update.content !== null
      ? update.content
      : undefined
    const identity = extractExternalIdentity(content ?? update, {
      message: 'supported',
      event: 'supported',
      turn: 'supported',
      toolCall: 'supported',
    })
    if (identity?.messageId) message = 'supported'
    if (identity?.eventId) event = 'supported'
    if (identity?.turnId) turn = 'supported'
    if (identity?.toolCallId) toolCall = 'supported'
  }
  return { message, event, turn, toolCall }
}

/**
 * 单一权威 identity 类型（wire 契约在 chatContracts 定义，此处复用避免平行类型漂移）。
 */
export type ExternalIdentity = OptionalChatEventIdentity

export interface IdentityMessage {
  id: string
  role?: string
  sender?: string
  content?: string
  externalIdentity?: ExternalIdentity
}

function usable(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function extractExternalIdentity(value: unknown, capabilities: ChatIdentityCapabilities = {}): ExternalIdentity | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  const identity = typeof raw.externalIdentity === 'object' && raw.externalIdentity !== null
    ? raw.externalIdentity as Record<string, unknown>
    : raw
  const result: ExternalIdentity = {}
  if (capabilities.message === 'supported' && usable(identity.messageId)) result.messageId = identity.messageId
  if (capabilities.event === 'supported' && usable(identity.eventId)) result.eventId = identity.eventId
  if (capabilities.turn === 'supported' && usable(identity.turnId)) result.turnId = identity.turnId
  if (capabilities.toolCall === 'supported' && usable(identity.toolCallId)) result.toolCallId = identity.toolCallId
  return Object.keys(result).length > 0 ? result : undefined
}

function identityKey(message: IdentityMessage, capabilities: ChatIdentityCapabilities): string | undefined {
  const identity = extractExternalIdentity(message, capabilities)
  if (!identity) return undefined
  if (message.role === 'tool' && identity.toolCallId) return `tool-call:${identity.toolCallId}`
  if (identity.messageId) return `message:${identity.messageId}`
  if (identity.eventId) return `event:${identity.eventId}`
  if (identity.turnId) return `turn:${identity.turnId}`
  return undefined
}

export function reconcileIngressMessages<T extends IdentityMessage>(
  resolved: T[],
  liveAdditions: T[],
  capabilities: ChatIdentityCapabilities = {},
): T[] {
  const resolvedKeys = new Set(resolved.map(message => identityKey(message, capabilities)).filter((key): key is string => key !== undefined))
  const additions = liveAdditions.filter(message => {
    const key = identityKey(message, capabilities)
    return key === undefined || !resolvedKeys.has(key)
  })
  return additions.length > 0 ? [...resolved, ...additions] : resolved
}
