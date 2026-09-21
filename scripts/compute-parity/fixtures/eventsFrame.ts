// PYPB v1 批量帧的宿主侧编码器 + wasm events 出口类型（宿主侧对向装置）。
//
// 逐字取自 `src/domains/events/__tests__/eventsComputeParity.test.ts`（issue #220
// WP2 定稿的编组契约对向装置；只做字段搬运，不含任何投影语义）。本副本供
// `scripts/compute-parity/` 脚手架的 events 套件使用——两侧改帧格式时要一起改。

import { CANONICAL_EVENT_TYPES } from '../../../src/domains/events/eventSchema.ts'

/** wasm 出口（WP1 接口 + WP2 events 层出口；参数名是 Rust snake_case）。 */
export type EventsCompute = {
  canonicalEventTypes(): readonly string[]
  canonicalEventTypeFor(sessionUpdate?: string | null, status?: string | null): string
  isCanonicalEventType(value: string): boolean
  canonicalOwnerKey(profileId: string, agentId: string, localSessionId: string): string
  canonicalEventId(ownerKey: string, sequence: number): string
  nextEventSequence(previous?: number | null): number
  normalizeRawEvent(
    raw: unknown,
    owner: unknown,
    client_generation: number,
    sequence: number,
    received_at?: string | null,
  ): unknown
  resolveChunkAppend(
    last_role: string | null,
    incoming_role: string,
    last_identity: unknown,
    incoming_identity: unknown,
  ): unknown
  mergeAdjacentDeltaChunks(frame: Uint8Array, max_raw_bytes: number, max_folded_count: number): unknown
  projectToolProjectionsFromBatch(frame: Uint8Array): unknown[]
  toolFieldsFromCanonical(typed_payload: unknown): unknown
  projectToolFromMessage(
    tool_call_id: string | null,
    tool_name: string | null,
    tool_kind: string | null,
    raw_input: unknown,
    raw_output: unknown,
    tool_status: string | null,
    content_blocks: unknown,
    owner: unknown,
    client_generation: number,
  ): unknown
  canonicalBatchSpanOf(frame: Uint8Array): unknown
  deriveCanonicalTurnDuration(frame: Uint8Array): unknown
  hasCanonicalTurnTerminal(frame: Uint8Array): boolean
  expandTurnUnitRows(frame: Uint8Array): unknown
  effectiveCanonicalProjectionEvents(frame: Uint8Array): unknown
  projectCanonicalMessages(frame: Uint8Array): unknown
  projectMessagesFromCanonical(frame: Uint8Array): unknown
}

/** 投影宿主策略列：显示时间与工具摘要（TS options 注入点的同一函数喂两侧）。 */
export interface HostColumns {
  timeLabel: (event: Record<string, unknown>) => string
  toolInputSummary: (title: string, rawInput: unknown, toolKind: string | undefined) => string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function rawMetaBits(rawPayload: unknown): { recovery: boolean; optimistic: boolean } {
  const root = isRecord(rawPayload) ? rawPayload : undefined
  const fromParams = isRecord(root?.params) ? (root!.params as Record<string, unknown>).update : undefined
  const update = isRecord(root?.update) ? root!.update : isRecord(fromParams) ? fromParams : undefined
  const meta = isRecord(update?._meta) ? update!._meta : undefined
  return {
    recovery: meta?.pylonCanonicalRecovery === true,
    optimistic: meta?.pylonOptimisticUser === true,
  }
}

const ABSENT = 0xffffffff
const FIELD_COUNT = 23
/** 事件段步长：40B 头部（seq/timestamp 各 i64、typeIndex/flags 各 u32、cg/pv 各 i64）+ 23 对 (off,len)。 */
const EVENT_STRIDE = 40 + FIELD_COUNT * 8

/** 词表 → 下标（模块级只建一次）。原来是逐事件 `indexOf` 线性扫 23 项。 */
let typeIndexCache: Map<string, number> | undefined
function typeIndexes(): Map<string, number> {
  typeIndexCache ??= new Map((CANONICAL_EVENT_TYPES as readonly string[]).map((name, index) => [name, index]))
  return typeIndexCache
}

/**
 * `Date.parse` 记忆化：纯函数，同一串结果恒定。`byte-cap-2002` 那类语料里 `occurredAt`
 * 大量重复（实测这一步占该 case 编码的 ~0.8ms）。
 */
const dateMsCache = new Map<string, number>()
function dateMs(value: string): number {
  const cached = dateMsCache.get(value)
  if (cached !== undefined) return cached
  const parsed = Date.parse(value)
  dateMsCache.set(value, parsed)
  return parsed
}

/**
 * 编码一帧 PYPB v1（events 层批量出口的入参）。
 *
 * 本函数是**测量装置**，且它在计时 lambda 之内 —— 所以它自己必须不是瓶颈。技术同生产
 * 编码器（`src/infrastructure/compute/projectorCompute.ts` 的 `encodeProjectorFrame`）：
 *
 * 1. 字串池**分块 + 复用 scratch**：`encodeInto` 写进同一块 scratch 再 `slice` 取走，
 *    不用 `number[]` 逐字节 push（一帧 5MB 就是 500 万次数组 push，外加一次再遍历）。
 * 2. 23 个 (offset,len) 槽写进**预分配 `Int32Array`**，不用「每事件一个 23 元组数组」
 *    （2000 事件 = 4.6 万个短命数组）。
 * 3. 事件头用**并行定长数组**，不用每事件一个对象。
 * 4. i64 直接写低/高两个 32 位字，不构造 `BigInt`（原本每事件 3 次）。
 *
 * 为什么非修不可（#220 §30 子 agent 调查）：这个编码器原占 `byte-cap-2002` 的 58%、
 * `batch-scale` 的 83%，于是 events 域每轮都造出「150× 回退」这类假结论（§22/§23 两次
 * 被它带偏）。它是**装置**、不是冻结基线 —— 基线的价值在语义逐字节等于 main，parity
 * 门禁对「输出字节不变」兜底。
 */
export function encodeEventsFrame(events: readonly unknown[], columns: HostColumns): Uint8Array {
  const count = events.length
  const encoder = new TextEncoder()
  const poolChunks: Uint8Array[] = []
  let poolLength = 0
  let scratch = new Uint8Array(256)
  const slots = new Int32Array(count * FIELD_COUNT * 2)
  let slotCursor = 0

  /** 把一个串写进池，并把 (offset,len) 写进当前槽位；`null/undefined` 写成 `(0, ABSENT)`。 */
  const put = (value: string | null | undefined): void => {
    if (value === null || value === undefined) {
      slots[slotCursor] = 0
      slots[slotCursor + 1] = ABSENT
      slotCursor += 2
      return
    }
    if (scratch.length < value.length * 3) scratch = new Uint8Array(value.length * 3)
    let result = encoder.encodeInto(value, scratch)
    while (result.read !== value.length) {
      scratch = new Uint8Array(scratch.length * 2)
      result = encoder.encodeInto(value, scratch)
    }
    slots[slotCursor] = poolLength
    slots[slotCursor + 1] = result.written
    slotCursor += 2
    poolChunks.push(scratch.slice(0, result.written))
    poolLength += result.written
  }

  const sequence = new Float64Array(count)
  const timestamp = new Float64Array(count)
  const typeIndexAt = new Int32Array(count)
  const flagsAt = new Int32Array(count)
  const generation = new Float64Array(count)
  const version = new Float64Array(count)
  const types = typeIndexes()

  const jsonString = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value))
  const optionalString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

  for (let index = 0; index < count; index += 1) {
    const event = isRecord(events[index]) ? (events[index] as Record<string, unknown>) : {}
    const eventType = String(event.eventType)
    const typeIndex = types.get(eventType)
    if (typeIndex === undefined) throw new Error(`eventType 不在词表内: ${eventType}`)
    const owner = isRecord(event.owner) ? event.owner : {}
    const identity = isRecord(event.identity) ? event.identity : undefined
    const typed = isRecord(event.typedPayload) ? event.typedPayload : undefined
    const tool = isRecord(typed?.tool) ? (typed!.tool as Record<string, unknown>) : undefined
    const occurredMs = dateMs(String(event.occurredAt ?? ''))
    const receivedMs = dateMs(String(event.receivedAt ?? ''))
    const stamp = Number.isFinite(occurredMs) ? occurredMs : Number.isFinite(receivedMs) ? receivedMs : null
    const meta = rawMetaBits(event.rawPayload)

    const ownerKey = JSON.stringify([
      owner.profileId ?? null,
      owner.agentId ?? null,
      owner.localSessionId ?? null,
    ])
    const toolTitle = optionalString(tool?.title)
    const toolKind = optionalString(tool?.kind)
    const toolStatus = optionalString(tool?.status)
    const summary = tool
      ? columns.toolInputSummary(toolTitle ?? '?', tool.rawInput, toolKind ?? undefined)
      : null
    const typedText = optionalString(typed?.text)
    const typedPayloadJson =
      eventType === 'turn.unit' || eventType.endsWith('.batch') ? JSON.stringify(typed ?? null) : null

    // 槽位顺序是**与 Rust `decode_event` 逐位对齐的契约**，不许重排。
    put(ownerKey)
    put(optionalString(owner.profileId))
    put(optionalString(owner.agentId))
    put(optionalString(owner.localSessionId))
    put(optionalString(owner.remoteSessionId))
    put(optionalString(owner.workspaceId))
    put(optionalString(identity?.messageId))
    put(optionalString(identity?.turnId))
    put(optionalString(identity?.toolCallId))
    put(optionalString(identity?.requestId))
    put(typedText)
    put(columns.timeLabel(event))
    put(toolTitle)
    put(toolKind)
    put(toolStatus)
    put(tool?.rawInput === undefined ? null : JSON.stringify(tool.rawInput))
    put(tool?.rawOutput === undefined ? null : JSON.stringify(tool.rawOutput))
    put(tool?.contentBlocks === undefined ? null : JSON.stringify(tool.contentBlocks))
    put(jsonString(event.rawPayload ?? null))
    put(typedPayloadJson)
    put(optionalString(event.occurredAt))
    put(optionalString(event.receivedAt))
    put(summary)

    let flags = 0
    if (identity !== undefined) flags |= 1 << 0
    if (typedText !== null) flags |= 1 << 1
    if (tool !== undefined) flags |= 1 << 2
    flags |= 1 << 3
    if (typedPayloadJson !== null) flags |= 1 << 4
    if (stamp !== null) flags |= 1 << 5
    if (meta.recovery) flags |= 1 << 6
    if (meta.optimistic) flags |= 1 << 7

    sequence[index] = Number(event.sequence ?? 0)
    timestamp[index] = stamp ?? 0
    typeIndexAt[index] = typeIndex
    flagsAt[index] = flags
    generation[index] = Number(event.clientGeneration ?? 0)
    version[index] = Number(event.payloadVersion ?? 1)
  }

  const frame = new Uint8Array(14 + poolLength + count * EVENT_STRIDE)
  const view = new DataView(frame.buffer)
  frame.set([0x50, 0x59, 0x50, 0x42], 0) // "PYPB"
  view.setUint16(4, 1, true)
  view.setUint32(6, count, true)
  view.setUint32(10, poolLength, true)
  let at = 14
  for (const chunk of poolChunks) {
    frame.set(chunk, at)
    at += chunk.length
  }

  /**
   * i64 小端：直接写低/高两个 32 位字。`setBigInt64` 每事件要构造一个 `BigInt`（3 次/事件，
   * 2000 事件 = 6000 个），而本帧取值都落在安全整数域内 —— 拆字与 `setBigInt64(..., true)`
   * 逐字节等价（`value | 0` 取模 2³² 得低字，`Math.floor(value / 2³²)` 得高字）。
   */
  const setI64 = (offset: number, value: number): void => {
    view.setInt32(offset, value | 0, true)
    view.setInt32(offset + 4, Math.floor(value / 4294967296), true)
  }

  let cursor = 14 + poolLength
  let slot = 0
  for (let index = 0; index < count; index += 1) {
    setI64(cursor, sequence[index]!)
    setI64(cursor + 8, timestamp[index]!)
    view.setUint32(cursor + 16, typeIndexAt[index]!, true)
    view.setUint32(cursor + 20, flagsAt[index]!, true)
    setI64(cursor + 24, generation[index]!)
    setI64(cursor + 32, version[index]!)
    const refsBase = cursor + 40
    for (let field = 0; field < FIELD_COUNT; field += 1) {
      view.setUint32(refsBase + field * 8, slots[slot]!, true)
      view.setUint32(refsBase + field * 8 + 4, slots[slot + 1]!, true)
      slot += 2
    }
    cursor += EVENT_STRIDE
  }
  return frame
}
