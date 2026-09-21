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
const EVENT_STRIDE = 24 + 16 + FIELD_COUNT * 8

export function encodeEventsFrame(events: readonly unknown[], columns: HostColumns): Uint8Array {
  const byteEncoder = new TextEncoder()
  const pool: number[] = []
  const put = (value: string | null | undefined): [number, number] => {
    if (value === null || value === undefined) return [0, ABSENT]
    const bytes = byteEncoder.encode(value)
    const offset = pool.length
    for (const byte of bytes) pool.push(byte)
    return [offset, bytes.length]
  }
  const jsonString = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value))
  const optionalString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

  const refs: Array<Array<[number, number]>> = []
  const headers: Array<{
    sequence: number
    timestamp: number
    typeIndex: number
    flags: number
    clientGeneration: number
    payloadVersion: number
  }> = []

  for (const candidate of events) {
    const event = isRecord(candidate) ? candidate : {}
    const eventType = String(event.eventType)
    const typeIndex = (CANONICAL_EVENT_TYPES as readonly string[]).indexOf(eventType)
    if (typeIndex < 0) throw new Error(`eventType 不在词表内: ${eventType}`)
    const owner = isRecord(event.owner) ? event.owner : {}
    const identity = isRecord(event.identity) ? event.identity : undefined
    const typed = isRecord(event.typedPayload) ? event.typedPayload : undefined
    const tool = isRecord(typed?.tool) ? (typed!.tool as Record<string, unknown>) : undefined
    const occurredMs = Date.parse(String(event.occurredAt ?? ''))
    const receivedMs = Date.parse(String(event.receivedAt ?? ''))
    const timestamp = Number.isFinite(occurredMs) ? occurredMs : Number.isFinite(receivedMs) ? receivedMs : null
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
    const typedPayloadJson =
      eventType === 'turn.unit' || eventType.endsWith('.batch') ? JSON.stringify(typed ?? null) : null

    refs.push([
      put(ownerKey),
      put(optionalString(owner.profileId)),
      put(optionalString(owner.agentId)),
      put(optionalString(owner.localSessionId)),
      put(optionalString(owner.remoteSessionId)),
      put(optionalString(owner.workspaceId)),
      put(optionalString(identity?.messageId)),
      put(optionalString(identity?.turnId)),
      put(optionalString(identity?.toolCallId)),
      put(optionalString(identity?.requestId)),
      put(optionalString(typed?.text)),
      put(columns.timeLabel(event)),
      put(toolTitle),
      put(toolKind),
      put(toolStatus),
      put(tool?.rawInput === undefined ? null : JSON.stringify(tool.rawInput)),
      put(tool?.rawOutput === undefined ? null : JSON.stringify(tool.rawOutput)),
      put(tool?.contentBlocks === undefined ? null : JSON.stringify(tool.contentBlocks)),
      put(jsonString(event.rawPayload ?? null)),
      put(typedPayloadJson),
      put(optionalString(event.occurredAt)),
      put(optionalString(event.receivedAt)),
      put(summary),
    ])
    let flags = 0
    if (identity !== undefined) flags |= 1 << 0
    if (optionalString(typed?.text) !== null) flags |= 1 << 1
    if (tool !== undefined) flags |= 1 << 2
    flags |= 1 << 3
    if (typedPayloadJson !== null) flags |= 1 << 4
    if (timestamp !== null) flags |= 1 << 5
    if (meta.recovery) flags |= 1 << 6
    if (meta.optimistic) flags |= 1 << 7
    headers.push({
      sequence: Number(event.sequence ?? 0),
      timestamp: timestamp ?? 0,
      typeIndex,
      flags,
      clientGeneration: Number(event.clientGeneration ?? 0),
      payloadVersion: Number(event.payloadVersion ?? 1),
    })
  }

  const poolLength = pool.length
  const buffer = new ArrayBuffer(14 + poolLength + events.length * EVENT_STRIDE)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)
  bytes.set([0x50, 0x59, 0x50, 0x42], 0) // "PYPB"
  view.setUint16(4, 1, true)
  view.setUint32(6, events.length, true)
  view.setUint32(10, poolLength, true)
  bytes.set(pool, 14)
  let cursor = 14 + poolLength
  headers.forEach((header, index) => {
    const refsBase = cursor + 40
    view.setBigInt64(cursor, BigInt(header.sequence), true)
    view.setBigInt64(cursor + 8, BigInt(header.timestamp), true)
    view.setUint32(cursor + 16, header.typeIndex, true)
    view.setUint32(cursor + 20, header.flags, true)
    view.setBigInt64(cursor + 24, BigInt(header.clientGeneration), true)
    view.setBigInt64(cursor + 32, BigInt(header.payloadVersion), true)
    const eventRefs = refs[index]!
    eventRefs.forEach(([offset, length], slot) => {
      view.setUint32(refsBase + slot * 8, offset, true)
      view.setUint32(refsBase + slot * 8 + 4, length, true)
    })
    cursor += EVENT_STRIDE
  })
  return bytes
}
