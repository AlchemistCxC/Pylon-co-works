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
import type { EventProjector } from '../../contracts/eventProjector.ts'
import { getPluginServiceRegistry } from '../../plugin-runtime/runtimeServices.ts'
import { getToolSummary } from '../tool/toolPresentation.ts'
import { normalizeRawEvent } from './canonicalNormalizer.ts'
import type { CanonicalConversationEvent } from './eventSchema.ts'
import { projectCanonicalMessages, reconcileOptimisticUserEvents } from './messageProjectionRules.ts'

export function listCanonicalMessageProjectors(): EventProjector[] {
  return getPluginServiceRegistry().list<EventProjector>('event-projector')
}

function resolveActiveCanonicalMessageProjector(): EventProjector | undefined {
  return listCanonicalMessageProjectors()[0]
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
  const live = reconcileOptimisticUserEvents(sorted.filter(event => event.eventType !== 'history.snapshot'))
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
  // history.snapshot is retained only as forensic evidence. It is never a second
  // projection source: missing local facts must be reported by recovery, not synthesized
  // in the renderer from an unverified agent replay payload.
  return live
}

/** 内置投影实现（core.projector.canonicalMessage 与无插件回退共用）。 */
export function projectMessagesFromCanonicalBuiltin(events: readonly CanonicalConversationEvent[]): Message[] {
  const sorted = effectiveCanonicalProjectionEvents(events)
  return projectCanonicalMessages(sorted, {
    toolInputSummary: (title, rawInput) => getToolSummary(title, rawInput),
  })
}

/** 优先走 Plugin Service Registry 中的 projector，独立工具路径回退 builtin。 */
export function projectMessagesFromCanonical(events: readonly CanonicalConversationEvent[]): Message[] {
  const projector = resolveActiveCanonicalMessageProjector()
  if (!projector) return projectMessagesFromCanonicalBuiltin(events)
  const effective = effectiveCanonicalProjectionEvents(events)
  return projector.project(effective as readonly unknown[]) as Message[]
}
