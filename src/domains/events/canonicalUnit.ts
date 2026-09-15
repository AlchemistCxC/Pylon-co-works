/**
 * canonicalUnit — #81 L2 turn 单元行（turn.unit）的 payload 契约与展开。
 *
 * 单元行由 Rust kernel 在写入 turn.completed|failed 的同一事务内追加（生产唯一
 * 写路径；只加不减）。payload = 保序 segment 数组：相邻同类 delta（identity 全字
 * 段相等）合成一段（text 精确拼接，occurredAt 取 run 首条）；tool/user/状态/unknown
 * 事件按 sequence 穿插保留为整行 segment。contentSha256 覆盖 segments 的规范化
 * 序列化，供 L3 裁剪迁移做折叠前后等价校验。
 *
 * 读侧优先消费单元：compact 读返回「单元 + 未覆盖行」，被单元覆盖的行不再读取
 * （L2）/已删除（L3）。展开按 segment 重建 canonical 事件（eventId = owner#seqEnd），
 * 投影结果与逐行投影逐字节等价。
 *
 * **段内事件形状**：单元载荷里的整行 segment 是**后端 canonical_events 行的形状**
 * （`canonical_event_wire`：嵌套 owner/provenance 的 EVT-01 事件；历史数据可能是扁平
 * 列形状）。两种形状都在本模块的解析边界经 `normalizeCanonicalEventRow` 归一——绕过
 * 这一步会把扁平行当不可读（#81 回归：重启后整轮历史丢失，且消息投影缺 owner 抛错）。
 */
import {
  createCanonicalEvent,
  type CanonicalConversationEvent,
  type CanonicalEventIdentity,
} from './eventSchema'
import { normalizeCanonicalEventRow } from './canonicalEventRow.ts'

export const TURN_UNIT_AGGREGATE_KIND = 'turn-rollup'
export const TURN_UNIT_FOLD_SCHEME = 'adjacent-delta-fold-v1'

export type TurnUnitDeltaEventType = 'assistant.text.delta' | 'assistant.thinking.delta'

export interface TurnUnitTerminalInfo {
  readonly eventType: 'turn.completed' | 'turn.failed'
  readonly occurredAt: string
}

export interface TurnUnitDeltaRunSegment {
  readonly kind: 'delta-run'
  readonly eventType: TurnUnitDeltaEventType
  readonly seqStart: number
  readonly seqEnd: number
  readonly identity?: CanonicalEventIdentity
  /** run 内全部 chunk 文本的精确拼接。 */
  readonly text: string
  /** run 首条的 occurredAt（消息创建 time 与思考起点都取首条）。 */
  readonly occurredAt: string
  /** run 内是否出现 markdown 内容（决定展开 part kind）。 */
  readonly markdown: boolean
}

export interface TurnUnitEventSegment {
  readonly kind: 'event'
  /** 整行 segment：tool/user/状态/unknown 的原样保留事件（raw 不丢）。解析边界已归一为
   * 嵌套 owner 的 EVT-01 canonical 事件；扁平落盘行不会泄漏到消费方。 */
  readonly event: CanonicalConversationEvent
}

export type TurnUnitSegment = TurnUnitDeltaRunSegment | TurnUnitEventSegment

export interface TurnUnitPayload {
  readonly aggregateKind: string
  readonly seqStart: number
  readonly seqEnd: number
  readonly foldedCount: number
  readonly foldScheme: string
  readonly contentSha256: string
  readonly terminal: TurnUnitTerminalInfo
  readonly segments: readonly TurnUnitSegment[]
}

/** 解析并校验单元行 payload；形状不互洽返回 undefined（调用方走单行兜底，不丢证据）。 */
export function parseTurnUnitPayload(event: CanonicalConversationEvent): TurnUnitPayload | undefined {
  if (event.eventType !== 'turn.unit') return undefined
  const typed = (event.typedPayload ?? {}) as Record<string, unknown>
  const seqStart = typed.seqStart
  const seqEnd = typed.seqEnd
  const foldedCount = typed.foldedCount
  const segments = typed.segments
  const terminal = typed.terminal as Partial<TurnUnitTerminalInfo> | undefined
  if (!Number.isSafeInteger(seqStart) || !Number.isSafeInteger(seqEnd) || (seqStart as number) < 1 || (seqStart as number) > (seqEnd as number)) return undefined
  if (!Number.isSafeInteger(foldedCount) || (foldedCount as number) < 1) return undefined
  if (!Array.isArray(segments) || segments.length < 1) return undefined
  if (typeof typed.aggregateKind !== 'string' || typeof typed.foldScheme !== 'string' || typeof typed.contentSha256 !== 'string') return undefined
  if (!terminal || (terminal.eventType !== 'turn.completed' && terminal.eventType !== 'turn.failed') || typeof terminal.occurredAt !== 'string') return undefined
  const parsedSegments: TurnUnitSegment[] = []
  for (const raw of segments) {
    if (!raw || typeof raw !== 'object') return undefined
    const segment = raw as Record<string, unknown>
    if (segment.kind === 'delta-run') {
      const eventType = segment.eventType
      if (eventType !== 'assistant.text.delta' && eventType !== 'assistant.thinking.delta') return undefined
      if (!Number.isSafeInteger(segment.seqStart) || !Number.isSafeInteger(segment.seqEnd)) return undefined
      if ((segment.seqStart as number) < (seqStart as number) || (segment.seqEnd as number) > (seqEnd as number)) return undefined
      if (typeof segment.text !== 'string' || typeof segment.occurredAt !== 'string' || typeof segment.markdown !== 'boolean') return undefined
      parsedSegments.push({
        kind: 'delta-run',
        eventType,
        seqStart: segment.seqStart as number,
        seqEnd: segment.seqEnd as number,
        ...(segment.identity && typeof segment.identity === 'object' ? { identity: segment.identity as CanonicalEventIdentity } : {}),
        text: segment.text,
        occurredAt: segment.occurredAt,
        markdown: segment.markdown,
      })
      continue
    }
    if (segment.kind === 'event') {
      const inner = segment.event
      // 先在**载荷原文**上校验 sequence 存在（`normalizeCanonicalEventRow` 会把缺失的
      // sequence 兜底为 0，先归一后校验会放行形状损坏的段），再归一为嵌套 canonical 事件。
      if (!inner || typeof inner !== 'object' || typeof (inner as { sequence?: unknown }).sequence !== 'number') return undefined
      parsedSegments.push({ kind: 'event', event: normalizeCanonicalEventRow(inner) })
      continue
    }
    return undefined
  }
  return {
    aggregateKind: typed.aggregateKind as string,
    seqStart: seqStart as number,
    seqEnd: seqEnd as number,
    foldedCount: foldedCount as number,
    foldScheme: typed.foldScheme as string,
    contentSha256: typed.contentSha256 as string,
    terminal: terminal as TurnUnitTerminalInfo,
    segments: parsedSegments,
  }
}

/**
 * 消息侧展开：unit 行 → segment 重建的 canonical 事件（eventId 由 owner+sequence
 * 推导，与逐行存储的行级 id 对齐）；**被任一单元覆盖的普通行一并丢弃**——因此
 * 「单元 + 被覆盖行」混入任何读取路径（全量读、增量补读、cursor）都不会重复投影。
 * 非 unit 且未被覆盖的行原样保留。
 */
export function expandTurnUnitRows(events: readonly CanonicalConversationEvent[]): CanonicalConversationEvent[] {
  const unitRanges: Array<readonly [number, number]> = []
  for (const event of events) {
    const payload = parseTurnUnitPayload(event)
    if (payload) unitRanges.push([payload.seqStart, payload.seqEnd])
  }
  const covered = (sequence: number): boolean =>
    unitRanges.some(([start, end]) => sequence >= start && sequence <= end)
  return events.flatMap(event => {
    const payload = parseTurnUnitPayload(event)
    if (!payload) {
      if (unitRanges.length > 0 && covered(event.sequence)) return []
      return [event]
    }
    return payload.segments.map(segment => {
      if (segment.kind === 'event') return segment.event
      return createCanonicalEvent({
        owner: event.owner,
        clientGeneration: event.clientGeneration,
        sequence: segment.seqEnd,
        occurredAt: segment.occurredAt,
        receivedAt: segment.occurredAt,
        eventType: segment.eventType,
        payloadVersion: event.payloadVersion,
        ...(segment.identity ? { identity: segment.identity } : {}),
        typedPayload: { text: segment.text },
        rawPayload: { kind: 'turn-unit-segment', unitEventId: event.eventId },
      })
    })
  })
}

