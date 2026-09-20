/**
 * #220 WP2 · TS↔Rust parity（events 层）。
 *
 * 同一输入喂两侧：TS 基线（本目录的归一化 / 单元展开 / 消息投影纯规则 + 写入侧批规则）
 * 与 WASM 计算核（`pylon-compute/src/events/**`），逐项断言一致。wasm 侧统一走
 * **PYPB 批量帧**（spec「编组格式」定稿：事件类型传词表 u32 索引、字符串只留内容本体、
 * ownerKey 复用预计算串、serde_json 往返不进热路径）——这里的 `encodeEventsFrame`
 * 是该编组契约的宿主侧对向装置（生产中属于装载/编排层，不是第二份规则实现：
 * 它只做字段搬运，不含任何投影语义）。
 *
 * 比对口径：Message/投影串用**键序归一的 JSON 字符串**逐字节比对（Rust 侧
 * serde_json::Map 为字典序，与 TS 插入序天然不同，键序本身不在迁移契约内）；
 * 含任意 JSON 的行（batch rawPayload 等）用 toEqual 深等。
 */
import { describe, expect, it } from 'vitest'
import { normalizeRawEvent, type CanonicalNormalizeContext } from '../canonicalNormalizer'
import { createCanonicalEvent, CANONICAL_EVENT_TYPES, type CanonicalConversationEvent, type CanonicalEventOwner } from '../eventSchema'
import { expandTurnUnitRows } from '../canonicalUnit'
import { deriveCanonicalTurnDuration, hasCanonicalTurnTerminal } from '../canonicalTurnDuration'
import { resolveChunkAppend } from '../chunkMerge'
import { projectCanonicalMessages } from '../messageProjectionRules'
import { effectiveCanonicalProjectionEvents } from '../messageProjection'
import { projectToolFromCanonical, toolFieldsFromCanonical } from '../toolProjection'
import { mergeAdjacentDeltaChunks } from '../../../infrastructure/events/canonicalEventBatch'
import { loadPylonCompute, type PylonCompute } from '../../../infrastructure/compute/pylonCompute'

/** wasm 出口（WP1 接口 + WP2 events 层出口；参数名是 Rust snake_case）。 */
type EventsCompute = PylonCompute & {
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
  deriveCanonicalTurnDuration(frame: Uint8Array): unknown
  hasCanonicalTurnTerminal(frame: Uint8Array): boolean
  expandTurnUnitRows(frame: Uint8Array): unknown
  effectiveCanonicalProjectionEvents(frame: Uint8Array): unknown
  projectCanonicalMessages(frame: Uint8Array): unknown
  projectMessagesFromCanonical(frame: Uint8Array): unknown
}

// ── 宿主侧 PYPB v1 帧编码（与 Rust decode 的字段槽位/flags 逐字节对齐） ────────

const ABSENT = 0xffffffff
const FIELD_COUNT = 23
const EVENT_STRIDE = 24 + 16 + FIELD_COUNT * 8

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 投影宿主策略列：显示时间与工具摘要（TS options 注入点的同一函数喂两侧）。 */
interface HostColumns {
  timeLabel: (event: Record<string, unknown>) => string
  toolInputSummary: (title: string, rawInput: unknown, toolKind: string | undefined) => string
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

function encodeEventsFrame(events: readonly unknown[], columns: HostColumns): Uint8Array {
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

/** 键序归一的 JSON（Rust serde Map 为字典序；键序不在迁移契约内，语义必须逐字节同）。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    // undefined 值键与缺失键同判（toEqual 语义）；Rust 侧 skip_serializing 同口径。
    const entries = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')
    return `{${entries}}`
  }
  return JSON.stringify(value ?? null)
}

// ── 语料 ─────────────────────────────────────────────────────────────────────

const owner: CanonicalEventOwner = { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' }
const BASE_MS = Date.UTC(2026, 8, 14, 0, 0, 0)

function isoAt(ms: number): string {
  return new Date(ms).toISOString()
}

function context(sequence: number, clientGeneration = 1): CanonicalNormalizeContext {
  return { owner, clientGeneration, sequence, receivedAt: isoAt(BASE_MS + sequence) }
}

function rawText(text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId },
  }
}
function rawThinking(text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId },
  }
}
function rawUser(text: string): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'user_message_chunk', content: { text } } }
}
function rawToolStart(toolCallId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'tool_call', toolCallId, title: 'Read', kind: 'read', ...extra },
  }
}
function rawToolUpdate(toolCallId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'tool_call_update', toolCallId, ...extra },
  }
}
function rawDone(): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'done' } }
}

function chunkRows(wires: readonly unknown[], clientGeneration = 1): CanonicalConversationEvent[] {
  return wires.map((raw, index) => normalizeRawEvent(raw, context(index + 1, clientGeneration)).event)
}

/** 消息投影注入列：与 Rust 侧同一函数喂两侧（toolInputSummary / timeFormatter）。 */
const columns: HostColumns = {
  timeLabel: event => `@${String(event.receivedAt ?? '')}`,
  toolInputSummary: (title, rawInput) => (title === 'Read' ? `READ:${JSON.stringify(rawInput)}` : ''),
}

const projectionOptions = {
  toolInputSummary: (title: string, rawInput: unknown, toolKind?: string) =>
    columns.toolInputSummary(title, rawInput, toolKind),
  timeFormatter: (event: CanonicalConversationEvent) => columns.timeLabel(event as unknown as Record<string, unknown>),
}

/** 恒等注入列：单元展开的段事件在 wasm 内合成、无宿主格式化列，显示时间回退
 * receivedAt 原文——含单元行的 corpus 用这组列两侧对齐。 */
const identityColumns: HostColumns = {
  timeLabel: event => String(event.receivedAt ?? ''),
  toolInputSummary: (title, rawInput) => (title === 'Read' ? `READ:${JSON.stringify(rawInput)}` : ''),
}

const identityProjectionOptions = {
  toolInputSummary: (title: string, rawInput: unknown, toolKind?: string) =>
    identityColumns.toolInputSummary(title, rawInput, toolKind),
  timeFormatter: (event: CanonicalConversationEvent) =>
    identityColumns.timeLabel(event as unknown as Record<string, unknown>),
}

let computePromise: Promise<EventsCompute> | undefined
async function compute(): Promise<EventsCompute> {
  computePromise ??= loadPylonCompute() as Promise<EventsCompute>
  return computePromise
}

// ── parity 用例 ──────────────────────────────────────────────────────────────

describe('词表单源（Rust CanonicalEventType::ALL ↔ TS 生成物）', () => {
  it('词表逐项一致（声明顺序即帧索引序）', async () => {
    const wasmCompute = await compute()
    expect(wasmCompute.canonicalEventTypes()).toEqual(CANONICAL_EVENT_TYPES)
  })
})

describe('normalizeRawEvent parity（wire → canonical）', () => {
  const cases: Array<{ name: string; raw: unknown }> = [
    { name: 'tool_call 全字段', raw: rawToolStart('tc-1', { rawInput: { path: 'a.txt', mode: 'r' }, content: [{ type: 'text', text: 'preview' }] }) },
    { name: 'tool_call_update completed（content 层别名）', raw: rawToolUpdate('tc-2', { content: { tool_use_id: 'tc-2' }, rawOutput: { ok: true, lines: 3 }, status: 'completed' }) },
    { name: 'tool_call_update failed', raw: rawToolUpdate('tc-3', { status: 'failed', rawOutput: 'boom' }) },
    { name: 'user chunk', raw: rawUser('你好') },
    { name: '空文本 chunk（无 typedPayload）', raw: { source: 'local:s1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } } } },
    { name: 'error → typedPayload.error', raw: { source: 'local:s1', update: { sessionUpdate: 'error', message: '炸了' } } },
    { name: 'cancelled → stopReason', raw: { source: 'local:s1', update: { sessionUpdate: 'cancelled' } } },
    { name: 'done → 完成元数据', raw: { source: 'local:s1', update: { sessionUpdate: 'done', stopReason: 'end_turn', usage: { outputTokens: 3 } } } },
    { name: 'malformed → unknown 保留 raw', raw: { nope: true } },
    { name: '裸 sessionUpdate envelope', raw: { sessionUpdate: 'plan', content: 'plan-text' } },
  ]

  it.each(cases)('$name', async ({ raw }) => {
    const wasmCompute = await compute()
    const tsResult = normalizeRawEvent(raw, context(7, 4))
    const rustResult = wasmCompute.normalizeRawEvent(raw, owner, 4, 7, isoAt(BASE_MS + 7)) as Record<string, unknown>
    expect(rustResult).not.toBeNull()
    expect((rustResult.event as Record<string, unknown>).eventId).toBe(tsResult.event.eventId)
    expect(rustResult.event).toEqual(tsResult.event)
    expect(rustResult.malformed).toBe(tsResult.malformed)
    expect(rustResult.sessionUpdate ?? undefined).toBe(tsResult.sessionUpdate)
    expect(rustResult.warning ?? undefined).toBe(tsResult.warning)
    expect(rustResult.update ?? undefined).toEqual(tsResult.update)
  })

  it('identity 别名走单一路径（toolCallId 根优先 / messageId content 优先 / toolUseId）', async () => {
    const wasmCompute = await compute()
    const rootWins = normalizeRawEvent(
      { update: { sessionUpdate: 'tool_call', toolCallId: 'root-id', content: { tool_call_id: 'content-id' } } },
      context(1),
    ).event
    const contentWins = normalizeRawEvent(
      { update: { sessionUpdate: 'agent_message_chunk', messageId: 'root-msg', content: { text: 'x', messageId: 'content-msg' } } },
      context(2),
    ).event
    const metaAlias = normalizeRawEvent(
      { update: { sessionUpdate: 'tool_call', _meta: { toolUseId: 'meta-id' } } },
      context(3),
    ).event
    const wires = [
      { update: { sessionUpdate: 'tool_call', toolCallId: 'root-id', content: { tool_call_id: 'content-id' } } },
      { update: { sessionUpdate: 'agent_message_chunk', messageId: 'root-msg', content: { text: 'x', messageId: 'content-msg' } } },
      { update: { sessionUpdate: 'tool_call', _meta: { toolUseId: 'meta-id' } } },
    ]
    const rustResults = wires.map((raw, index) =>
      wasmCompute.normalizeRawEvent(raw, owner, 1, index + 1, isoAt(BASE_MS + index + 1)),
    ) as Array<Record<string, unknown>>
    expect(rustResults[0]!.event).toEqual(rootWins)
    expect(rustResults[1]!.event).toEqual(contentWins)
    expect(rustResults[2]!.event).toEqual(metaAlias)
  })
})

describe('resolveChunkAppend parity', () => {
  it.each([
    ['同角色聚合 + identity 取 incoming', 'assistant', 'assistant', { messageId: 'm-1' }, { messageId: 'm-2' }],
    ['跨角色新建', 'assistant', 'reasoning', { messageId: 'm-1' }, null],
    ['无 last 不聚合', null, 'assistant', null, { messageId: 'm-1' }],
    ['identity 回退 last', 'reasoning', 'reasoning', { turnId: 't-1' }, null],
    ['双方无 identity', 'tool', 'tool', null, null],
  ])('%s', async (_name, lastRole, incomingRole, lastIdentity, incomingIdentity) => {
    const wasmCompute = await compute()
    const ts = resolveChunkAppend({
      lastRole: lastRole ?? undefined,
      incomingRole: incomingRole!,
      lastIdentity: lastIdentity ?? undefined,
      incomingIdentity: incomingIdentity ?? undefined,
    })
    const rust = wasmCompute.resolveChunkAppend(lastRole, incomingRole!, lastIdentity, incomingIdentity) as Record<string, unknown>
    expect(rust).toEqual(ts)
  })
})

describe('mergeAdjacentDeltaChunks parity（写入侧批规则，整页帧入口）', () => {
  const corpora: Array<{ name: string; wires: unknown[] }> = [
    { name: '相邻同类 delta 合并', wires: [rawUser('hi'), rawText('你'), rawText('好'), rawText('，世界'), rawUser('x')] },
    { name: 'identity 变化切断', wires: [rawText('A', 'msg-1'), rawText('B', 'msg-2'), rawUser('done')] },
    { name: '类型切换切断', wires: [rawText('a'), rawText('b'), rawThinking('think-1'), rawText('c'), rawUser('x')] },
    { name: '工具卡穿插切断', wires: [rawText('before'), rawToolStart('tool-1'), rawText('after'), rawUser('x')] },
    { name: '空文本 chunk 不合并', wires: [
        rawUser('问题'),
        rawText('x'),
        { source: 'local:s1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } } },
        rawText('y'),
        rawDone(),
      ] },
    { name: '终态切断', wires: [rawUser('一'), rawText('a'), rawDone(), rawText('b'), rawDone()] },
  ]

  it.each(corpora)('$name', async ({ wires }) => {
    const wasmCompute = await compute()
    const rows = chunkRows(wires)
    const tsMerged = mergeAdjacentDeltaChunks(rows)
    const rustItems = wasmCompute.mergeAdjacentDeltaChunks(
      encodeEventsFrame(rows, columns),
      48 * 1024,
      2000,
    ) as Array<Record<string, unknown>>
    // TS 侧分类：引用相等的归 passthrough，其余是合并行。
    const classified = tsMerged.map(row => {
      const index = rows.indexOf(row)
      return index >= 0 ? { kind: 'event', index } : { kind: 'batchRow', row }
    })
    expect(rustItems).toHaveLength(classified.length)
    classified.forEach((expected, position) => {
      const actual = rustItems[position]!
      expect(actual.kind).toBe(expected.kind)
      if (expected.kind === 'event') {
        expect(actual.index).toBe(expected.index)
        return
      }
      const tsRow = (expected as { row: CanonicalConversationEvent }).row
      const tsTyped = tsRow.typedPayload as { text: string; foldedCount: number; seqSpan: [number, number] }
      expect(actual.row).toBeDefined()
      const rustRow = actual.row as Record<string, unknown>
      expect(rustRow.eventType).toBe(tsRow.eventType)
      expect(rustRow.sequence).toBe(tsRow.sequence)
      expect(rustRow.eventId).toBe(tsRow.eventId)
      expect(rustRow.owner).toEqual(tsRow.owner)
      expect(rustRow.clientGeneration).toBe(tsRow.clientGeneration)
      expect(rustRow.payloadVersion).toBe(tsRow.payloadVersion)
      expect(rustRow.occurredAt).toBe(tsRow.occurredAt)
      expect(rustRow.receivedAt).toBe(tsRow.receivedAt)
      expect(rustRow.identity ?? null).toEqual(tsRow.identity ?? null)
      expect(rustRow.text).toBe(tsTyped.text)
      expect(rustRow.foldedCount).toBe(tsTyped.foldedCount)
      expect(rustRow.seqSpan).toEqual(tsTyped.seqSpan)
      // rawPayload = 原始 chunk 数组，顺序不变（raw 不丢）。
      expect(rustRow.rawPayload).toEqual(tsRow.rawPayload)
    })
  })

  it('foldedCount 上限注入：达到上限切断成多行', async () => {
    const wasmCompute = await compute()
    const wires = Array.from({ length: 7 }, (_, index) => rawText(`#${index}`))
    const rows = chunkRows(wires)
    const rustItems = wasmCompute.mergeAdjacentDeltaChunks(encodeEventsFrame(rows, columns), Number.MAX_SAFE_INTEGER, 3) as Array<Record<string, unknown>>
    expect(rustItems.map(item => item.kind)).toEqual(['batchRow', 'batchRow', 'event'])
    const first = (rustItems[0]!.row as Record<string, unknown>)
    expect(first.text).toBe('#0#1#2')
    expect(first.foldedCount).toBe(3)
    expect(first.seqSpan).toEqual([1, 3])
    const second = (rustItems[1]!.row as Record<string, unknown>)
    expect(second.text).toBe('#3#4#5')
    expect(second.seqSpan).toEqual([4, 6])
  })

  it('字节上限先于条数上限：2002 条小 chunk 跨度无缝铺满', async () => {
    const wasmCompute = await compute()
    const rows = chunkRows(Array.from({ length: 2002 }, () => rawText('x')))
    const rustItems = wasmCompute.mergeAdjacentDeltaChunks(encodeEventsFrame(rows, columns), 48 * 1024, 2000) as Array<Record<string, unknown>>
    const batches = rustItems.filter(item => item.kind === 'batchRow')
    expect(batches.length).toBeGreaterThanOrEqual(2)
    let expectedNext = 1
    for (const item of batches) {
      const row = item.row as Record<string, unknown>
      expect(row.eventType).toBe('assistant.text.delta.batch')
      const [start, end] = row.seqSpan as [number, number]
      expect(start).toBe(expectedNext)
      expectedNext = end + 1
    }
    expect(expectedNext).toBe(2003)
  })
})

describe('toolProjection parity', () => {
  it('全字段投影与非工具事件逐位一致', async () => {
    const wasmCompute = await compute()
    const wires = [
      rawToolStart('tc-1', { rawInput: { path: 'a.txt', mode: 'r' }, content: [{ type: 'text', text: 'preview' }] }),
      rawToolUpdate('tc-2', { content: { tool_use_id: 'tc-2' }, rawOutput: { ok: true, lines: 3 }, status: 'completed' }),
      rawToolUpdate('tc-1', { status: 'completed', rawOutput: '内容' }),
      rawUser('hi'),
      { source: 'local:s1', update: { sessionUpdate: 'future_update', value: 1 } },
    ]
    const rows = chunkRows(wires, 7)
    const rustProjections = wasmCompute.projectToolProjectionsFromBatch(encodeEventsFrame(rows, columns))
    expect(rustProjections).toHaveLength(rows.length)
    rows.forEach((row, index) => {
      const ts = projectToolFromCanonical(row)
      expect(rustProjections[index] ?? null).toEqual(ts ?? null)
    })
  })

  it('toolFieldsFromCanonical 直通一致', async () => {
    const wasmCompute = await compute()
    const rows = chunkRows([
      rawToolUpdate('tc-9', {
        title: 'Write',
        kind: 'write_file',
        rawInput: { path: 'b.txt' },
        rawOutput: 'ok',
        status: 'running',
        content: [{ type: 'text', text: 'w' }],
      }),
    ])
    const rust = wasmCompute.toolFieldsFromCanonical(rows[0]!.typedPayload)
    expect(rust).toEqual(toolFieldsFromCanonical(rows[0]!))
  })
})

describe('turnDuration parity', () => {
  const START = '2026-09-03T00:00:10.000Z'
  const END = '2026-09-03T00:00:22.500Z'
  const boundary = (sequence: number, eventType: string, at: string, extra: Record<string, unknown> = {}) => ({
    sequence,
    eventType,
    occurredAt: at,
    receivedAt: at,
    ...extra,
  })

  const corpora: Array<{ name: string; rows: unknown[] }> = [
    {
      name: '基础回合',
      rows: [boundary(1, 'user.message', START), boundary(2, 'turn.completed', '2026-09-03T00:00:13.250Z')],
    },
    {
      name: '失败终态覆盖早回合',
      rows: [
        boundary(1, 'user.message', '2026-09-03T00:00:01.000Z'),
        boundary(2, 'turn.completed', '2026-09-03T00:00:02.000Z'),
        boundary(3, 'user.message', '2026-09-03T00:01:00.000Z'),
        boundary(4, 'turn.failed', '2026-09-03T00:01:04.500Z'),
      ],
    },
    {
      name: '起点锚定首条 user 行',
      rows: [
        boundary(1, 'user.message', START),
        boundary(2, 'user.message', '2026-09-03T00:00:10.500Z'),
        boundary(3, 'turn.completed', '2026-09-03T00:00:13.000Z'),
      ],
    },
    {
      name: '时间戳缺失 → undefined',
      rows: [boundary(1, 'user.message', ''), boundary(2, 'turn.completed', '2026-09-03T00:00:02.000Z')],
    },
    {
      name: '聚合行不是终态也不是边界',
      rows: [boundary(1, 'user.message', START), boundary(4, 'assistant.text.delta.batch', START)],
    },
    {
      name: '#199 compact 读：user 锚点内嵌于 unit segments',
      rows: [
        boundary(8, 'turn.unit', END, {
          typedPayload: {
            segments: [
              { kind: 'event', event: { sequence: 1, eventType: 'user.message', occurredAt: START } },
              { kind: 'delta-run', eventType: 'assistant.text.delta', seqStart: 2, seqEnd: 6, text: '答案', occurredAt: START },
            ],
          },
        }),
      ],
    },
    {
      name: '#199 unit 未内嵌 user 段 → undefined',
      rows: [
        boundary(8, 'turn.unit', END, {
          typedPayload: {
            segments: [
              { kind: 'delta-run', eventType: 'assistant.text.delta', seqStart: 2, seqEnd: 7, text: '答案', occurredAt: START },
            ],
          },
        }),
      ],
    },
  ]

  it.each(corpora)('$name', async ({ rows }) => {
    const wasmCompute = await compute()
    const frame = encodeEventsFrame(rows, columns)
    const tsDuration = deriveCanonicalTurnDuration(rows as never)
    const rustDuration = wasmCompute.deriveCanonicalTurnDuration(frame)
    expect(rustDuration ?? null).toEqual(tsDuration ?? null)
    const rustTerminal = wasmCompute.hasCanonicalTurnTerminal(frame)
    expect(rustTerminal).toBe(hasCanonicalTurnTerminal(rows as never))
  })
})

describe('expandTurnUnitRows parity（#81 L2）', () => {
  /** 与 TS 测试同构的单元行（跨度含 user 锚点与终态行，单元自身占 terminal+1）。 */
  function unitRowFromTurn(rows: readonly CanonicalConversationEvent[], sequence: number): CanonicalConversationEvent {
    const terminal = rows[rows.length - 1]!
    const segments: Record<string, unknown>[] = []
    for (const row of rows) {
      const isDelta = row.eventType === 'assistant.text.delta' || row.eventType === 'assistant.thinking.delta'
      if (!isDelta) {
        segments.push({ kind: 'event', event: row })
        continue
      }
      const text = (row.typedPayload as { text?: string } | undefined)?.text ?? ''
      const last = segments[segments.length - 1]
      const sameRun =
        last?.kind === 'delta-run' &&
        last.eventType === row.eventType &&
        JSON.stringify(last.identity ?? null) === JSON.stringify(row.identity ?? null)
      if (sameRun) {
        last.seqEnd = row.sequence
        last.text = `${String(last.text ?? '')}${text}`
        continue
      }
      segments.push({
        kind: 'delta-run',
        eventType: row.eventType,
        seqStart: row.sequence,
        seqEnd: row.sequence,
        ...(row.identity ? { identity: row.identity } : {}),
        text,
        occurredAt: row.occurredAt,
        markdown: false,
      })
    }
    return createCanonicalEvent({
      owner,
      clientGeneration: 1,
      sequence,
      occurredAt: terminal.occurredAt,
      receivedAt: terminal.receivedAt,
      eventType: 'turn.unit',
      payloadVersion: 1,
      typedPayload: {
        aggregateKind: 'turn-rollup',
        seqStart: rows[0]!.sequence,
        seqEnd: terminal.sequence,
        foldedCount: rows.length,
        foldScheme: 'adjacent-delta-fold-v1',
        contentSha256: 'deadbeef',
        terminal: { eventType: terminal.eventType, occurredAt: terminal.occurredAt },
        segments,
      },
      rawPayload: { kind: 'turn-unit' },
    })
  }

  function semanticsOf(event: CanonicalConversationEvent): Record<string, unknown> {
    return {
      eventId: event.eventId,
      owner: event.owner,
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      receivedAt: event.receivedAt,
      eventType: event.eventType,
      payloadVersion: event.payloadVersion,
      clientGeneration: event.clientGeneration,
      // 缺失以 undefined 表达（stableJson 跳过），与 Rust 缺键对齐。
      identity: event.identity ?? undefined,
      typedPayload: event.typedPayload ?? undefined,
      rawPayload: event.rawPayload,
    }
  }

  it('单元展开与被覆盖行丢弃逐位一致（混合读取不重复投影）', async () => {
    const wasmCompute = await compute()
    const rows = chunkRows([rawUser('问题'), rawText('答'), rawText('案'), rawDone()])
    const unit = unitRowFromTurn(rows, 5)
    const input = [...rows, unit]
    const tsExpanded = expandTurnUnitRows(input)
    const rustItems = wasmCompute.expandTurnUnitRows(encodeEventsFrame(input, columns)) as Array<Record<string, unknown>>
    expect(rustItems).toHaveLength(tsExpanded.length)
    tsExpanded.forEach((event, position) => {
      const actual = rustItems[position]!
      // TS 的 event segment 经 normalize 归一后是新对象（引用不等）——segment 一律
      // 走语义比对；未被单元展开的原样行才保引用。
      if (actual.kind === 'event') {
        expect(input[actual.index as number]).toBe(event)
        return
      }
      expect(actual.kind).toBe('segment')
      expect(stableJson(actual.event as Record<string, unknown>)).toBe(stableJson(semanticsOf(event)))
    })
  })

  it('缺 sequence 的段事件判不可解析 → 整行原样保留', async () => {
    const wasmCompute = await compute()
    const rows = chunkRows([rawUser('问题'), rawText('答'), rawDone()])
    const unit = unitRowFromTurn(rows, 4)
    const typed = unit.typedPayload as { segments: Record<string, unknown>[] }
    typed.segments[1] = { kind: 'event', event: { eventType: 'turn.completed' } }
    const rustItems = wasmCompute.expandTurnUnitRows(encodeEventsFrame([unit], columns)) as Array<Record<string, unknown>>
    expect(rustItems).toEqual([{ kind: 'event', index: 0 }])
  })
})

describe('消息投影 parity（projectCanonicalMessages / composed）', () => {
  const messageCorpora: Array<{ name: string; wires: unknown[] }> = [
    { name: '文本 run', wires: [rawUser('问题'), rawText('你'), rawText('好'), rawText('，世界'), rawDone()] },
    { name: 'thinking 与 text 交替', wires: [rawUser('问题'), rawThinking('思考'), rawThinking('中…'), rawText('答'), rawText('案'), rawDone()] },
    { name: '工具卡切断 run', wires: [rawUser('查一下'), rawText('先看看'), rawToolStart('tool-1', { rawInput: { path: 'a.txt' } }), rawText('结论是'), rawText('…'), rawDone()] },
    { name: '工具完成更新', wires: [rawUser('查一下'), rawToolStart('tool-1', { rawInput: { path: 'a.txt' } }), rawToolUpdate('tool-1', { status: 'completed', rawOutput: { ok: true, lines: 3 }, content: [{ type: 'text', text: 'x' }] }), rawDone()] },
    { name: '无起点的工具完成补卡', wires: [rawToolUpdate('tc-x', { status: 'failed', rawOutput: '行1\n\n  \n行2' })] },
    { name: 'messageId 变化 identity 取末次', wires: [rawText('A', 'msg-1'), rawText('B', 'msg-1'), rawText('C', 'msg-2'), rawText('D', 'msg-2')] },
    { name: '终态后续流聚合', wires: [rawUser('一'), rawText('a'), rawDone(), rawText('b'), rawDone()] },
    { name: '错误与取消落 typedPayload 不落卡', wires: [rawUser('一'), { source: 'local:s1', update: { sessionUpdate: 'error', message: '炸了' } }, rawUser('二'), { source: 'local:s1', update: { sessionUpdate: 'cancelled' } }] },
  ]

  it.each(messageCorpora)('$name（纯规则直连）', async ({ wires }) => {
    const wasmCompute = await compute()
    const rows = chunkRows(wires, 3)
    const tsMessages = projectCanonicalMessages(rows, projectionOptions)
    const rustMessages = wasmCompute.projectCanonicalMessages(encodeEventsFrame(rows, columns))
    expect(stableJson(rustMessages)).toBe(stableJson(tsMessages))
  })

  it.each(messageCorpora)('$name（组合出口：有效流 + 投影单次过界）', async ({ wires }) => {
    const wasmCompute = await compute()
    const rows = chunkRows(wires, 3)
    const effective = effectiveCanonicalProjectionEvents(rows)
    const tsMessages = projectCanonicalMessages(effective, projectionOptions)
    const rustMessages = wasmCompute.projectMessagesFromCanonical(encodeEventsFrame(rows, columns))
    expect(stableJson(rustMessages)).toBe(stableJson(tsMessages))
  })

  it('有效流解析 parity：snapshot 过滤 / optimistic 去重 / recovery 归位与重排', async () => {
    const wasmCompute = await compute()
    const snapshot = normalizeRawEvent(
      { update: { sessionUpdate: 'user_message_chunk', content: { text: '快照' } } },
      context(1),
    ).event
    const snapshotRow = { ...snapshot, eventType: 'history.snapshot' as const }
    const optimistic = normalizeRawEvent(
      {
        source: 'local:s1',
        update: {
          sessionUpdate: 'user_message_chunk',
          content: { text: '你好' },
          _meta: { pylonOptimisticUser: true },
        },
      },
      context(2),
    ).event
    const echo = chunkRows([rawUser('你好')], 1)[0]!
    const liveA = chunkRows([rawText('live-1')], 1)[0]!
    const liveB = chunkRows([rawText('live-2')], 1)[0]!
    const recoveredRow = (sequence: number, text: string, ordinal: number, anchorUpdate: unknown) =>
      normalizeRawEvent(
        {
          source: 'local:s1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
            messageId: 'msg-rec',
            _meta: { pylonCanonicalRecovery: true, pylonReplayOrdinal: ordinal, pylonReplayAnchor: anchorUpdate },
          },
        },
        context(sequence),
      ).event
    // 回收行 ordinal 1 在前，锚点分别指向 live-2 与 live-1 的 wire update。
    const recoveredLate = recoveredRow(5, 'recovered-late', 1, (liveB.rawPayload as Record<string, unknown>).update)
    const recoveredEarly = recoveredRow(4, 'recovered-early', 0, (liveA.rawPayload as Record<string, unknown>).update)
    const rows = [snapshotRow, optimistic, echo, liveA, liveB, recoveredLate, recoveredEarly]

    const tsEffective = effectiveCanonicalProjectionEvents(rows)
    const rustEffective = wasmCompute.effectiveCanonicalProjectionEvents(encodeEventsFrame(rows, columns)) as Array<Record<string, unknown>>
    expect(rustEffective).toHaveLength(tsEffective.length)
    // TS 的 recovery 路径会 {...event} 复制出新对象（引用不等，sequence 已重排）；
    // 两侧统一按「帧下标 + 重排后 sequence」比对：剥离 sequence 后逐字节同即同一行。
    const frameIndexOf = (event: CanonicalConversationEvent): number => {
      const direct = rows.indexOf(event)
      if (direct >= 0) return direct
      const withoutSequence = (candidate: unknown) => stableJson({ ...(candidate as object), sequence: null })
      return rows.findIndex(row => withoutSequence(row) === withoutSequence(event))
    }
    tsEffective.forEach((event, position) => {
      const item = rustEffective[position]!
      const originalIndex = frameIndexOf(event)
      expect(item.origin).toBe(originalIndex >= 0 ? 'frame' : 'unit')
      if (originalIndex >= 0) expect(item.index).toBe(originalIndex)
      expect(item.sequence).toBe(event.sequence)
    })

    const tsMessages = projectCanonicalMessages(tsEffective, projectionOptions)
    const rustMessages = wasmCompute.projectMessagesFromCanonical(encodeEventsFrame(rows, columns))
    expect(stableJson(rustMessages)).toBe(stableJson(tsMessages))
    // optimistic echo 被隐藏、snapshot 不投影、recovery 按锚点归位（序断言取自 TS 基线）。
    expect(stableJson(tsMessages)).toContain('recovered-early')
    expect(stableJson(tsMessages)).not.toContain('快照')
  })

  it('单元混合读取的组合投影与逐行逐字节一致（#81 L2 golden）', async () => {
    const wasmCompute = await compute()
    const { createCanonicalEvent } = await import('../../events/eventSchema')
    const rows = chunkRows([rawUser('问题'), rawText('答'), rawText('案'), rawDone()])
    const unit = createCanonicalEvent({
      owner,
      clientGeneration: 1,
      sequence: 5,
      occurredAt: isoAt(BASE_MS + 5),
      receivedAt: isoAt(BASE_MS + 5),
      eventType: 'turn.unit',
      payloadVersion: 1,
      typedPayload: {
        aggregateKind: 'turn-rollup',
        seqStart: 1,
        seqEnd: 4,
        foldedCount: 4,
        foldScheme: 'adjacent-delta-fold-v1',
        contentSha256: 'deadbeef',
        terminal: { eventType: rows[3]!.eventType, occurredAt: rows[3]!.occurredAt },
        // 生产形状（turn_rollup）：跨度内全部行都入段——user 锚点行作为整行 segment。
        segments: [
          { kind: 'event', event: rows[0]! },
          { kind: 'delta-run', eventType: 'assistant.text.delta', seqStart: 2, seqEnd: 3, identity: { messageId: 'msg-1' }, text: '答案', occurredAt: rows[1]!.occurredAt, markdown: false },
          { kind: 'event', event: rows[3]! },
        ],
      },
      rawPayload: { kind: 'turn-unit' },
    })
    const perRow = projectCanonicalMessages(effectiveCanonicalProjectionEvents(rows), identityProjectionOptions)
    const fromUnit = projectCanonicalMessages(effectiveCanonicalProjectionEvents([unit]), identityProjectionOptions)
    expect(stableJson(fromUnit)).toBe(stableJson(perRow))
    // wasm 组合出口对「单元 + 被覆盖行」混合读取同样与逐行一致。
    // 单元展开的段事件在 wasm 内合成，拿不到宿主格式化列（列只对帧事件存在），
    // 显示时间回退 receivedAt 原文——本用例因此用恒等 formatter 两侧对齐
    // （帧事件走宿主格式化列的 parity 由上面 @ 前缀用例证明）。
    const rustMixed = wasmCompute.projectMessagesFromCanonical(encodeEventsFrame([...rows, unit], identityColumns))
    expect(stableJson(rustMixed)).toBe(stableJson(perRow))
  })
})
