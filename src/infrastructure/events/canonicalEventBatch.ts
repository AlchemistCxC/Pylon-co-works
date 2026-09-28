/**
 * canonicalEventBatch — `*.delta.batch` 行的**读侧解析**（#439 起）。
 *
 * 写侧（sink 的合并与预算常量）已随前端自写轨退役：生产 batch 行由 Rust
 * `event_repo/fold.rs`（终态 `turn.unit`）与 `draft_flush.rs`（draft 折叠）产出，
 * 预算常量（48 KiB / 2000 chunk）以 fold.rs 为唯一单源。本文件只保留读侧
 * 纯函数（投影展开 batch 行用）与测试期参考合并器 `mergeAdjacentDeltaChunks`
 * （replay 测试/perf-bench 造数器——无生产调用方，#449 基准在途依赖，收工后
 * 迁 `src/test-utils/`）。
 *
 * 读侧判据（与 Rust 写入形状互为镜像）：
 * - 事件类型 ∈ {assistant.text.delta.batch, assistant.thinking.delta.batch}；
 * - 行占跨度末位 sequence，跨度中间编号不被任何行占用，读侧按
 *   `owner#(seqSpan[0]+i)` 重建原始 id；
 * - rawPayload 字节 ≤ 48 KiB 且 foldedCount ≤ 2000（写入侧保证，读侧不重验预算）。
 *
 * 纯域函数：零 sink/store 依赖，node 可测。
 */
import type { CanonicalConversationEvent, CanonicalEventIdentity, CanonicalEventType } from '../../domains/events/eventSchema'

export type CanonicalBatchDeltaType = 'assistant.text.delta.batch' | 'assistant.thinking.delta.batch'

/** 测试期参考合并器用：delta → batch 类型映射（写入规则由 Rust fold.rs 单源承载）。 */
const DELTA_TO_BATCH: Record<string, CanonicalBatchDeltaType> = {
  'assistant.text.delta': 'assistant.text.delta.batch',
  'assistant.thinking.delta': 'assistant.thinking.delta.batch',
}

export function isCanonicalBatchDeltaType(eventType: CanonicalEventType | string): eventType is CanonicalBatchDeltaType {
  return eventType === 'assistant.text.delta.batch' || eventType === 'assistant.thinking.delta.batch'
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

/**
 * delta 的折叠文本；**typedPayload 无 string text（如空文本 chunk）返回 undefined**。
 * 这类 chunk 在逐行投影中是 no-op（textOf === undefined），若并入 batch 行会让
 * text 变成 string，投影从 no-op 变成新建消息 ⇒ 破坏 Message[] 等价（审核 P1-2）。
 * 因此无 string text 的 delta 一律不参与合并、原样落盘。
 */
function deltaTextOf(event: CanonicalConversationEvent): string | undefined {
  const text = (event.typedPayload as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : undefined
}

interface BatchRun {
  readonly chunks: CanonicalConversationEvent[]
  readonly batchType: CanonicalBatchDeltaType
  bytes: number
}

/**
 * 合并相邻同类 delta chunk 为 batch 行（**测试期参考合并器**——replay 测试与
 * perf-bench 造数器用，无生产调用方；生产折叠归 Rust fold.rs/draft_flush.rs）。
 * 输入须为同一 owner 的逐 chunk canonical 事件（升序 = 到达序）；单条 run 不合并
 * （保持与逐 chunk 存储逐字节一致）。预算字面量与 Rust fold.rs 常量同源对齐。
 */
export function mergeAdjacentDeltaChunks(
  events: readonly CanonicalConversationEvent[],
  limits: { readonly maxRawBytes: number; readonly maxFoldedCount: number } = {
    maxRawBytes: 48 * 1024,
    maxFoldedCount: 2000,
  },
): CanonicalConversationEvent[] {
  const rows: CanonicalConversationEvent[] = []
  let run: BatchRun | undefined
  const flushRun = (): void => {
    if (!run) return
    rows.push(run.chunks.length === 1 ? run.chunks[0] : buildBatchRow(run))
    run = undefined
  }
  for (const event of events) {
    const batchType = DELTA_TO_BATCH[event.eventType]
    const foldText = batchType === undefined ? undefined : deltaTextOf(event)
    if (run
      && foldText !== undefined
      && run.batchType === batchType
      && sameIdentity(run.chunks[0].identity, event.identity)
      && run.chunks.length < limits.maxFoldedCount
      && run.bytes + rawPayloadBytes(event) <= limits.maxRawBytes) {
      run.chunks.push(event)
      run.bytes += rawPayloadBytes(event)
      continue
    }
    flushRun()
    if (batchType !== undefined && foldText !== undefined) {
      run = { chunks: [event], batchType, bytes: rawPayloadBytes(event) }
      // 单条已超上限的 delta 无法成批，保持原样（不截断）。
      if (run.bytes > limits.maxRawBytes) flushRun()
    } else {
      // 非 delta、无 string text 的 delta：原样保留（no-op 语义/unknown 不丢）
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
  const text = run.chunks.map(deltaTextOf).join('') // run 内均已通过 string text 门控
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
