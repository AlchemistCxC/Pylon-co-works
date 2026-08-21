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
import { normalizeRawEvent } from './canonicalNormalizer.ts'
import type { CanonicalConversationEvent } from './eventSchema.ts'
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

/** Expand only the raw replay events needed to recover missing user turns. */
function replayEventsFromSnapshot(marker: CanonicalConversationEvent): CanonicalConversationEvent[] {
  if (marker.eventType !== 'history.snapshot' || !marker.rawPayload || typeof marker.rawPayload !== 'object') return []
  const replayEvents = (marker.rawPayload as { replayEvents?: unknown }).replayEvents
  if (!Array.isArray(replayEvents)) return []
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
    return { ...event, eventId: `${marker.eventId}/replay/${index + 1}` }
  })
}

function eventProjectionKey(event: CanonicalConversationEvent): string {
  const typed = event.typedPayload as { text?: unknown; tool?: { rawInput?: unknown } } | undefined
  return JSON.stringify([
    event.eventType,
    event.identity ?? null,
    typed?.text ?? null,
    typed?.tool?.rawInput ?? null,
  ])
}

function canonicalRecoveryMetadata(event: CanonicalConversationEvent): Record<string, unknown> | undefined {
  if (!event.rawPayload || typeof event.rawPayload !== 'object') return undefined
  const root = event.rawPayload as { update?: unknown; params?: { update?: unknown } }
  const update = root.update ?? root.params?.update
  if (!update || typeof update !== 'object') return undefined
  const meta = (update as { _meta?: unknown })._meta
  if (!meta || typeof meta !== 'object' || (meta as { pylonCanonicalRecovery?: unknown }).pylonCanonicalRecovery !== true) {
    return undefined
  }
  return meta as Record<string, unknown>
}

function canonicalRecoveryAnchor(event: CanonicalConversationEvent): CanonicalConversationEvent | undefined {
  const meta = canonicalRecoveryMetadata(event)
  if (!meta) return undefined
  const anchor = (meta as { pylonReplayAnchor?: unknown }).pylonReplayAnchor
  if (!anchor || typeof anchor !== 'object') return undefined
  return normalizeRawEvent(anchor, {
    owner: event.owner,
    clientGeneration: event.clientGeneration,
    sequence: event.sequence,
    receivedAt: event.receivedAt,
  }).event
}

/**
 * Resolve the single append-only journal into one effective projection stream.
 *
 * Bug2（2026-08-20）：不再把 `history.snapshot` 纳入投影。canonical_events 的权威数据是
 * dispatcher 逐条 ingest 的实时逐 chunk 行（user/assistant.text/tool.call.*，已按真实交错序
 * 持久化，sequence 单调）。`history.snapshot` 是 agent（Hermes）分组重放导入的产物
 * （text→tools 批量），若作为"快照基线"整块前置会盖过实时交错序 → 工具/文字聚簇。
 * 因此 snapshot 不作为完整投影基线；迁移标记的缺失 replay 行从 canonical 末尾按锚点归位，
 * 更老的 snapshot-only journal 则仅补回缺失用户事件。
 */
export function effectiveCanonicalProjectionEvents(
  events: readonly CanonicalConversationEvent[],
): CanonicalConversationEvent[] {
  const sorted = [...events].sort((left, right) => left.sequence - right.sequence)
  const live = sorted.filter(event => event.eventType !== 'history.snapshot')
  const recoveredEvents = live
    .filter(event => canonicalRecoveryMetadata(event))
    .sort((left, right) => {
      const leftOrdinal = canonicalRecoveryMetadata(left)?.pylonReplayOrdinal
      const rightOrdinal = canonicalRecoveryMetadata(right)?.pylonReplayOrdinal
      return (typeof leftOrdinal === 'number' ? leftOrdinal : Number.MAX_SAFE_INTEGER)
        - (typeof rightOrdinal === 'number' ? rightOrdinal : Number.MAX_SAFE_INTEGER)
    })
  if (recoveredEvents.length > 0) {
    // Recovered rows are durable canonical events. Their sequence is the migration append
    // position, so place them back before the explicit live anchor captured in SQLite.
    const merged = live.filter(event => !recoveredEvents.includes(event))
    let insertionFloor = 0
    for (const recovered of recoveredEvents) {
      const anchor = canonicalRecoveryAnchor(recovered)
      const anchorIndex = anchor
        ? merged.findIndex(event => eventProjectionKey(event) === eventProjectionKey(anchor))
        : -1
      const position = anchorIndex >= insertionFloor ? anchorIndex : insertionFloor
      merged.splice(Math.min(position, merged.length), 0, recovered)
      insertionFloor = position + 1
    }
    return merged.map((event, index) => ({ ...event, sequence: index + 1 }))
  }
  // 正常路径优先使用逐条 durable live rows，避免 snapshot 的分组顺序覆盖工具/文字交错。
  // 兼容一种已经存在的 journal：live rows 只有 Agent 事件，用户事件只留在 snapshot。
  // 只有在 live 完全没有 user.message 时才补用户，避免把 snapshot 的旧/重复内容混入
  // 一个已经拥有用户 canonical 行的完整 journal。
  if (live.some(event => event.eventType === 'user.message')) return live
  const marker = [...sorted].reverse().find(event => event.eventType === 'history.snapshot')
  if (!marker) return live
  const snapshot = replayEventsFromSnapshot(marker)
  const users = snapshot.filter(event => event.eventType === 'user.message')
  if (users.length === 0) return live

  const merged = [...live]
  let insertionFloor = 0
  for (const user of users) {
    const snapshotIndex = snapshot.indexOf(user)
    const nextLiveSnapshotEvent = snapshot
      .slice(snapshotIndex + 1)
      .find(event => event.eventType !== 'user.message')
    const anchor = nextLiveSnapshotEvent
      ? live.find(event => eventProjectionKey(event) === eventProjectionKey(nextLiveSnapshotEvent))
      : undefined
    const anchorIndex = anchor ? merged.findIndex(event => event.eventId === anchor.eventId) : -1
    const position = anchorIndex >= insertionFloor ? anchorIndex : insertionFloor
    merged.splice(Math.min(position, merged.length), 0, user)
    insertionFloor = position + 1
  }
  return merged.map((event, index) => ({ ...event, sequence: index + 1 }))
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
