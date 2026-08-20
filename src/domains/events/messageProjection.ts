/**
 * messageProjection — canonical 事件流 → 前端 Message[] 投影（A1-c P3）。
 *
 * 与 chatEventController 的 live/replay 落卡语义对齐（同一 wire 三路径深等）：
 * - user.message → user 消息（新 user 前清 running）；
 * - assistant.text.delta / assistant.thinking.delta → 末条同 role 且
 *   （running 或外部 identity 相同）聚合，否则新建 running 消息；
 * - tool.call.started → 建 running 工具卡；tool.call.updated/completed/failed →
 *   更新 output/status 并完成；无 toolCallId 的工具事件跳过（与 replay 一致）；
 * - turn.completed / turn.failed → settle 全部 running（与 replay 终态一致，
 *   error 文本不额外落卡）；
 * - unknown → 跳过（raw 保留在事件流，不丢）。
 *
 * 用途：canonical 首屏占位 / restart recovery。仅依赖 domains + 类型，不落盘。
 */
import type { Message } from '../../components/chat/messageTypes'
import type { OptionalChatEventIdentity } from '../../infrastructure/acp/chatContracts'
import type { EventProjector } from '../../contracts/eventProjector.ts'
import { getPluginServiceRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { getToolSummary } from '../tool/toolPresentation.ts'
import { resolveChunkAppend } from './chunkMerge.ts'
import type { CanonicalConversationEvent } from './eventSchema.ts'
import { normalizeRawEvent } from './canonicalNormalizer.ts'
import { toolFieldsFromCanonical } from './toolProjection.ts'

export function listCanonicalMessageProjectors(): EventProjector[] {
  return getPluginServiceRegistry().list<EventProjector>('event-projector')
}

function resolveActiveCanonicalMessageProjector(): EventProjector | undefined {
  return listCanonicalMessageProjectors()[0]
}

function textOf(event: CanonicalConversationEvent): string | undefined {
  const payload = event.typedPayload as { text?: string } | undefined
  return typeof payload?.text === 'string' ? payload.text : undefined
}

function identityOf(event: CanonicalConversationEvent): OptionalChatEventIdentity | undefined {
  const identity = event.identity
  if (!identity) return undefined
  const mapped: OptionalChatEventIdentity = {}
  if (identity.messageId !== undefined) mapped.messageId = identity.messageId
  if (identity.turnId !== undefined) mapped.turnId = identity.turnId
  if (identity.toolCallId !== undefined) mapped.toolCallId = identity.toolCallId
  return Object.keys(mapped).length > 0 ? mapped : undefined
}

function timeOf(event: CanonicalConversationEvent): string {
  const value = event.receivedAt ?? event.occurredAt
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleTimeString()
}

function settleAll(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role === 'tool' && message.running) {
      return { ...message, running: false, toolStatus: message.toolStatus || 'completed' }
    }
    return message.running ? { ...message, running: false } : message
  })
}

function stringifyOutput(rawOutput: unknown): string {
  if (typeof rawOutput === 'string') return rawOutput
  const json = JSON.stringify(rawOutput, null, 2)
  return json ?? ''
}

function stripReplayPersonaPrefix(content: string): string {
  const separator = '\n\n---\n\n'
  const index = content.lastIndexOf(separator)
  if (index < 0) return content
  const stripped = content.slice(index + separator.length)
  return stripped || content
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableJsonValue(nested)]))
}

function projectionSignature(event: CanonicalConversationEvent): string {
  return JSON.stringify(stableJsonValue({
    eventType: event.eventType,
    identity: event.identity ?? null,
    typedPayload: event.typedPayload ?? null,
    // Unknown events have no stable typed representation; raw remains their only evidence.
    ...(event.eventType === 'unknown' ? { rawPayload: event.rawPayload } : {}),
  }))
}

function replayEventsFromSnapshot(marker: CanonicalConversationEvent): CanonicalConversationEvent[] | null {
  if (marker.eventType !== 'history.snapshot' || !marker.rawPayload || typeof marker.rawPayload !== 'object') return null
  const replayEvents = (marker.rawPayload as { replayEvents?: unknown }).replayEvents
  if (!Array.isArray(replayEvents)) return null
  return replayEvents.map((raw, index) => {
    const normalized = normalizeRawEvent(raw, {
      owner: marker.owner,
      clientGeneration: marker.clientGeneration,
      sequence: index + 1,
      receivedAt: marker.receivedAt,
    }).event
    const typed = normalized.typedPayload as { text?: unknown } | undefined
    const event = normalized.eventType === 'user.message' && typeof typed?.text === 'string'
      ? { ...normalized, typedPayload: { ...typed, text: stripReplayPersonaPrefix(typed.text) } }
      : normalized
    // Snapshot children are projection records, not extra journal rows. Their identity is derived
    // from the persisted marker + remote ordinal and can never collide with a real canonical row.
    return { ...event, eventId: `${marker.eventId}/replay/${index + 1}` }
  })
}

/**
 * Resolve the single append-only journal into one effective projection stream. The latest valid
 * history.snapshot supplies the complete remote baseline. Older rows that match that baseline are
 * consumed as duplicates by multiplicity; unmatched rows remain after it as local evidence.
 */
export function effectiveCanonicalProjectionEvents(
  events: readonly CanonicalConversationEvent[],
): CanonicalConversationEvent[] {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence)
  let snapshotIndex = -1
  let snapshotEvents: CanonicalConversationEvent[] | null = null
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const expanded = replayEventsFromSnapshot(sorted[index])
    if (expanded) {
      snapshotIndex = index
      snapshotEvents = expanded
      break
    }
  }
  if (snapshotIndex < 0 || !snapshotEvents) return sorted

  const remainingSnapshotCounts = new Map<string, number>()
  for (const event of snapshotEvents) {
    const signature = projectionSignature(event)
    remainingSnapshotCounts.set(signature, (remainingSnapshotCounts.get(signature) ?? 0) + 1)
  }
  const unmatchedBefore: CanonicalConversationEvent[] = []
  for (const event of sorted.slice(0, snapshotIndex)) {
    if (event.eventType === 'history.snapshot') continue
    const signature = projectionSignature(event)
    const remaining = remainingSnapshotCounts.get(signature) ?? 0
    if (remaining > 0) remainingSnapshotCounts.set(signature, remaining - 1)
    else unmatchedBefore.push(event)
  }
  return [
    ...snapshotEvents,
    ...unmatchedBefore,
    ...sorted.slice(snapshotIndex + 1).filter(event => event.eventType !== 'history.snapshot'),
  ].map((event, index) => ({ ...event, sequence: index + 1 }))
}

/** 内置投影实现（core.projector.canonicalMessage 与无插件回退共用）。 */
export function projectMessagesFromCanonicalBuiltin(events: readonly CanonicalConversationEvent[]): Message[] {
  const sorted = effectiveCanonicalProjectionEvents(events)
  let messages: Message[] = []
  let seq = 0

  for (const event of sorted) {
    switch (event.eventType) {
      case 'user.message': {
        const text = textOf(event)
        if (text === undefined) break
        messages = settleAll(messages)
        seq += 1
        messages = [...messages, {
          id: `user-${seq}`,
          role: 'user',
          sender: event.owner.localSessionId,
          content: text,
          time: timeOf(event),
          agentId: event.owner.agentId,
          running: false,
          ...(identityOf(event) ? { externalIdentity: identityOf(event) } : {}),
        }]
        break
      }

      case 'assistant.text.delta':
      case 'assistant.thinking.delta': {
        const text = textOf(event)
        if (text === undefined) break
        const role = event.eventType === 'assistant.text.delta' ? 'assistant' : 'reasoning'
        const last = messages[messages.length - 1]
        const identity = identityOf(event)
        // 三路径投影深等：与 replay reducer / live flush 共用同一 chunk 聚合判据。
        // 同角色即同一段流（消息边界由 user/tool/turn 决定），identity 取最后出现者。
        const append = resolveChunkAppend({
          lastRole: last?.role,
          incomingRole: role,
          lastIdentity: last?.externalIdentity,
          incomingIdentity: identity,
        })
        if (append.shouldAppend) {
          messages = messages.map((message, index) => index === messages.length - 1
            ? { ...message, content: message.content + text, ...(append.identity ? { externalIdentity: append.identity } : {}) }
            : message)
          break
        }
        seq += 1
        messages = [...messages, {
          id: `${role === 'assistant' ? 'msg' : 'thought'}-${seq}`,
          role,
          sender: 'peri',
          content: text,
          time: timeOf(event),
          running: false,
          agentId: event.owner.agentId,
          ...(identityOf(event) ? { externalIdentity: identityOf(event) } : {}),
        }]
        break
      }

      case 'tool.call.started': {
        const toolCallId = event.identity?.toolCallId
        if (!toolCallId) break
        const tool = toolFieldsFromCanonical(event)
        const title = tool.title || '?'
        const rawInput = tool.rawInput
        const inputStr = getToolSummary(title, rawInput) || (typeof rawInput === 'string' ? rawInput.slice(0, 80) : '')
        const existing = messages.find(message => message.id === `tool-${toolCallId}`)
        if (existing) {
          messages = messages.map(message => message.id === existing.id ? {
            ...message,
            toolName: title,
            sender: `tool:${title}`,
            toolKind: tool.kind ?? message.toolKind,
            toolInput: inputStr,
            contentBlocks: tool.contentBlocks as Message['contentBlocks'],
            rawInput,
            clientGeneration: event.clientGeneration,
          } : message)
          break
        }
        messages = [...messages, {
          id: `tool-${toolCallId}`,
          role: 'tool',
          sender: `tool:${title}`,
          content: '',
          time: timeOf(event),
          agentId: event.owner.agentId,
          toolName: title,
          toolInput: inputStr,
          toolKind: tool.kind,
          contentBlocks: tool.contentBlocks as Message['contentBlocks'],
          rawInput,
          clientGeneration: event.clientGeneration,
          running: true,
          externalIdentity: { toolCallId },
        }]
        break
      }

      case 'tool.call.updated':
      case 'tool.call.completed':
      case 'tool.call.failed': {
        const toolCallId = event.identity?.toolCallId
        if (!toolCallId) break
        const tool = toolFieldsFromCanonical(event)
        const outputStr = stringifyOutput(tool.rawOutput)
        const lines = outputStr ? outputStr.split(/\n/).filter((line: string) => line.trim()).length : 0
        const existing = messages.find(message => message.id === `tool-${toolCallId}`)
        if (!existing) {
          // update 先到：与 reducer 一致，创建占位卡等待后续 started 补全
          messages = [...messages, {
            id: `tool-${toolCallId}`,
            role: 'tool',
            sender: 'tool:?',
            content: '',
            time: timeOf(event),
            agentId: event.owner.agentId,
            toolName: '?',
            toolOutput: outputStr,
            toolOutputLines: lines,
            toolKind: tool.kind,
            contentBlocks: tool.contentBlocks as Message['contentBlocks'],
            toolStatus: tool.status,
            rawOutput: tool.rawOutput,
            clientGeneration: event.clientGeneration,
            running: false,
            externalIdentity: { toolCallId },
          }]
          break
        }
        messages = messages.map(message => message.id === existing.id ? {
          ...message,
          toolOutput: outputStr,
          toolOutputLines: lines,
          toolStatus: tool.status,
          toolKind: tool.kind ?? message.toolKind,
          contentBlocks: (tool.contentBlocks ?? message.contentBlocks) as Message['contentBlocks'],
          rawOutput: tool.rawOutput !== undefined ? tool.rawOutput : message.rawOutput,
          clientGeneration: event.clientGeneration,
          running: false,
        } : message)
        break
      }

      case 'turn.completed':
      case 'turn.failed': {
        messages = settleAll(messages)
        break
      }

      default:
        break
    }
  }

  return messages
}

/** 优先走 Plugin Service Registry 中的 projector，独立工具路径回退 builtin。 */
export function projectMessagesFromCanonical(events: readonly CanonicalConversationEvent[]): Message[] {
  const projector = resolveActiveCanonicalMessageProjector()
  if (!projector) return projectMessagesFromCanonicalBuiltin(events)
  const effective = effectiveCanonicalProjectionEvents(events)
  return projector.project(effective as readonly unknown[]) as Message[]
}
