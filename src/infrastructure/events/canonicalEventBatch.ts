/**
 * canonicalEventBatch — #81 L1 写入窗口聚合的纯合并规则。
 *
 * 在 canonicalEventSink 分配 sequence/eventId 之后、落盘之前，把 pending 中
 * **相邻同类 delta** 合并为一行 batch 行（跨度占用 sequence：行取跨度内最后一条的
 * sequence/eventId，跨度中间编号不被任何行占用，留给读侧按 `owner#(seqSpan[0]+i)`
 * 重建原始 id）。sink 的 id 分配与 conflict rebase 都经同一函数合并，规则不分叉。
 *
 * 合并条件（保守，等价性按构造成立）：
 * - 事件类型 ∈ {assistant.text.delta, assistant.thinking.delta} 且相邻同类；
 * - identity 全字段相等（比 messageProjectionRules 的三元组口径更严：合并更少、
 *   永不少并行为不同的事件）；
 * - 未超上限：rawPayload 序列化字节 ≤ maxRawBytes 且 foldedCount ≤ maxFoldedCount，
 *   超限切断成多行（不截断 ⇒ 不产生 raw_truncated 语义）。
 *   maxRawBytes 取 48 KiB 而非裁决字面的 256 KiB：Rust `retain_raw_payload`
 *   （MAX_CANONICAL_RAW_BYTES = 64 KiB）会对超限 rawPayload 做截断替换，与
 *   "不截断、rawPayload 可逐字节还原"的裁决意图冲突 ⇒ 预算必须落在 64 KiB 之内。
 *
 * 非 delta 事件、未知事件、identity 不连续处、单条 run：原样保留（unknown 不丢弃）。
 * 纯域函数：零 sink/scheduler/store 依赖，node 可测。
 */
import type { CanonicalConversationEvent, CanonicalEventIdentity, CanonicalEventType } from '../../domains/events/eventSchema'

export type CanonicalBatchDeltaType = 'assistant.text.delta.batch' | 'assistant.thinking.delta.batch'

const DELTA_TO_BATCH: Record<string, CanonicalBatchDeltaType> = {
  'assistant.text.delta': 'assistant.text.delta.batch',
  'assistant.thinking.delta': 'assistant.thinking.delta.batch',
}

export interface CanonicalBatchLimits {
  /** 单行 rawPayload 序列化字节上限（须低于 Rust 64 KiB 截断阈值，见文件头）。 */
  maxRawBytes: number
  /** 单行折叠 chunk 数上限。 */
  maxFoldedCount: number
}

export const CANONICAL_BATCH_LIMITS: CanonicalBatchLimits = {
  maxRawBytes: 48 * 1024,
  maxFoldedCount: 2000,
}

export function isCanonicalBatchDeltaType(eventType: CanonicalEventType | string): eventType is CanonicalBatchDeltaType {
  return eventType === 'assistant.text.delta.batch' || eventType === 'assistant.thinking.delta.batch'
}

/** delta → batch 类型映射；非 delta 返回 undefined。 */
export function batchEventTypeOf(eventType: CanonicalEventType | string): CanonicalBatchDeltaType | undefined {
  return DELTA_TO_BATCH[eventType]
}

/** batch 行的 seqSpan（typedPayload.seqSpan，形状非法返回 undefined）。 */
export function canonicalBatchSpanOf(event: CanonicalConversationEvent): readonly [number, number] | undefined {
  if (!isCanonicalBatchDeltaType(event.eventType)) return undefined
  const span = (event.typedPayload as { seqSpan?: unknown } | undefined)?.seqSpan
  if (!Array.isArray(span) || span.length !== 2) return undefined
  const first: unknown = span[0]
  const last: unknown = span[1]
  if (!isSpanBoundary(first) || !isSpanBoundary(last) || last < first) return undefined
  return [first, last] as const
}

function isSpanBoundary(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
}

/**
 * batch 行携带的原始 chunk 数组（形状一致才返回：数组长度、foldedCount、seqSpan
 * 三者互洽；损坏行返回 undefined，由读侧走单行归一兜底，raw 不丢）。
 */
export function canonicalBatchChunksOf(event: CanonicalConversationEvent): readonly unknown[] | undefined {
  const span = canonicalBatchSpanOf(event)
  if (!span || !Array.isArray(event.rawPayload)) return undefined
  const foldedCount = (event.typedPayload as { foldedCount?: unknown } | undefined)?.foldedCount
  if (foldedCount !== event.rawPayload.length) return undefined
  if (span[1] - span[0] + 1 !== event.rawPayload.length) return undefined
  return event.rawPayload
}

const identityKeys = ['messageId', 'turnId', 'toolCallId', 'requestId'] as const

function sameIdentity(left: CanonicalEventIdentity | undefined, right: CanonicalEventIdentity | undefined): boolean {
  return identityKeys.every(key => left?.[key] === right?.[key])
}

const rawBytesMemo = new WeakMap<object, number>()

function rawPayloadBytes(event: CanonicalConversationEvent): number {
  const raw = event.rawPayload
  if (raw !== null && typeof raw === 'object') {
    const memoized = rawBytesMemo.get(raw)
    if (memoized !== undefined) return memoized
    const bytes = encodedByteLength(raw)
    rawBytesMemo.set(raw, bytes)
    return bytes
  }
  return encodedByteLength(raw)
}

const byteEncoder = new TextEncoder()

function encodedByteLength(value: unknown): number {
  return byteEncoder.encode(JSON.stringify(value ?? null)).length
}

function deltaTextOf(event: CanonicalConversationEvent): string {
  const text = (event.typedPayload as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : ''
}

interface BatchRun {
  readonly chunks: CanonicalConversationEvent[]
  readonly batchType: CanonicalBatchDeltaType
  bytes: number
}

/**
 * 合并 pending 中相邻同类 delta chunk 为 batch 行；其余事件原样保留。
 * 输入须为同一 owner 的逐 chunk canonical 事件（升序 = 到达序）；单条 run 不合并
 * （保持与逐 chunk 存储逐字节一致）。id 分配与 conflict rebase 共用本函数。
 */
export function mergeAdjacentDeltaChunks(
  events: readonly CanonicalConversationEvent[],
  limits: CanonicalBatchLimits = CANONICAL_BATCH_LIMITS,
): CanonicalConversationEvent[] {
  const rows: CanonicalConversationEvent[] = []
  let run: BatchRun | undefined
  const flushRun = (): void => {
    if (!run) return
    rows.push(run.chunks.length === 1 ? run.chunks[0] : buildBatchRow(run))
    run = undefined
  }
  for (const event of events) {
    const batchType = batchEventTypeOf(event.eventType)
    if (run
      && run.batchType === batchType
      && sameIdentity(run.chunks[0].identity, event.identity)
      && run.chunks.length < limits.maxFoldedCount
      && run.bytes + rawPayloadBytes(event) <= limits.maxRawBytes) {
      run.chunks.push(event)
      run.bytes += rawPayloadBytes(event)
      continue
    }
    flushRun()
    if (batchType !== undefined) {
      run = { chunks: [event], batchType, bytes: rawPayloadBytes(event) }
      // 单条已超上限的 delta 无法成批，保持原样（不截断）。
      if (run.bytes > limits.maxRawBytes) flushRun()
    } else {
      rows.push(event)
    }
  }
  flushRun()
  return rows
}

/** batch 行：沿用跨度内首条的身份/时间戳/provenance，sequence/eventId 取末条（跨度占用）。 */
function buildBatchRow(run: BatchRun): CanonicalConversationEvent {
  const first = run.chunks[0]
  const last = run.chunks[run.chunks.length - 1]
  const text = run.chunks.map(deltaTextOf).join('')
  // rawMetadata 只描述单条 chunk 的截断状态，不适用于聚合行（聚合行不截断）。
  const { rawMetadata: _omitted, ...firstWithoutRawMetadata } = first
  return {
    ...firstWithoutRawMetadata,
    eventType: run.batchType,
    sequence: last.sequence,
    eventId: last.eventId,
    typedPayload: {
      text,
      foldedCount: run.chunks.length,
      seqSpan: [first.sequence, last.sequence],
    },
    rawPayload: run.chunks.map(chunk => chunk.rawPayload),
  }
}
