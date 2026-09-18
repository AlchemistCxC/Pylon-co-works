/**
 * turn 单元行（#81 L2）段内事件的读入契约——回归修复锁定（重启后无法重放会话）。
 *
 * 单元行的整行 segment 嵌的是**后端 canonical_events 行**：新数据经 Rust
 * `canonical_event_wire`（嵌套 owner 的 EVT-01 事件），历史数据是扁平列形状。
 * `parseTurnUnitPayload` 必须在解析边界把两种形状都归一为嵌套 owner 的 canonical
 * 事件——否则消息投影取 `event.owner.localSessionId` 抛 TypeError（首屏占位与跨会话
 * 搜索同路径），工作台侧则把整轮塌成一条 event.unknown。
 */
import { describe, expect, it } from 'vitest'
import { createCanonicalEvent, toCanonicalOwnerKey, type CanonicalConversationEvent, type CanonicalEventOwner } from '../../domains/events/eventSchema'
import { expandTurnUnitRows, parseTurnUnitPayload } from '../../domains/events/canonicalUnit.ts'
import { normalizeRawEvent } from '../../domains/events/canonicalNormalizer.ts'
import { projectMessagesFromCanonical } from '../../domains/events/messageProjection.ts'

const owner: CanonicalEventOwner = { profileId: 'p1', agentId: 'peri', localSessionId: 'local:s1' }
const ownerKey = toCanonicalOwnerKey(owner)

function rawUser(text: string): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'user_message_chunk', content: { text } } }
}
function rawText(text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:s1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId },
  }
}
function rawDone(): unknown {
  return { source: 'local:s1', update: { sessionUpdate: 'done' } }
}
function chunkRows(wires: readonly unknown[]): CanonicalConversationEvent[] {
  return wires.map((raw, index) => normalizeRawEvent(raw, {
    owner,
    clientGeneration: 1,
    sequence: index + 1,
    receivedAt: new Date(Date.UTC(2026, 8, 14, 0, 0, 0) + index).toISOString(),
  }).event)
}

/** Rust `canonical_event_wire` 形状：嵌套 owner/provenance 的 EVT-01 事件。 */
function canonicalSegmentEvent(event: CanonicalConversationEvent): CanonicalConversationEvent {
  return { ...event, provenance: { origin: 'local-observed', trust: 'authoritative' } }
}

/** Rust `serde_json::to_value(CanonicalEventRow)` 遗留扁平列形状（#81 回归时的落盘形状）。 */
function legacyFlatSegmentEvent(event: CanonicalConversationEvent): Record<string, unknown> {
  return {
    eventId: event.eventId,
    ownerKey,
    profileId: owner.profileId,
    agentId: owner.agentId,
    localSessionId: owner.localSessionId,
    remoteSessionId: null,
    clientGeneration: event.clientGeneration,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    eventType: event.eventType,
    payloadVersion: event.payloadVersion,
    identity: event.identity ?? null,
    typedPayload: event.typedPayload ?? null,
    rawPayload: event.rawPayload,
    createdAt: 0,
    schemaVersion: 1,
    provenanceOrigin: 'local-observed',
    provenanceTrust: 'authoritative',
    provenanceProvider: null,
    provenanceImportId: null,
    rawTruncated: false,
    rawOriginalBytes: 0,
    rawRetainedBytes: 0,
    rawOmittedBytes: 0,
    rawTruncationReason: null,
  }
}

/**
 * 生产形状的单元行：跨度含用户消息与终态行（`seqStart` = turn 首行，与
 * `turn_rollup::build_turn_unit_row` 的 `query_event_rows(prev_boundary + 1, terminal)`
 * 一致），单元自身占 `terminal.sequence + 1`。
 */
function unitRowFromTurn(
  rows: readonly CanonicalConversationEvent[],
  shape: 'canonical' | 'legacy-flat' = 'canonical',
): CanonicalConversationEvent {
  const terminal = rows[rows.length - 1]
  const segment = shape === 'canonical' ? canonicalSegmentEvent : legacyFlatSegmentEvent
  const segments: Record<string, unknown>[] = []
  for (const row of rows) {
    const isDelta = row.eventType === 'assistant.text.delta' || row.eventType === 'assistant.thinking.delta'
    if (!isDelta) {
      segments.push({ kind: 'event', event: segment(row) })
      continue
    }
    const text = (row.typedPayload as { text?: string } | undefined)?.text ?? ''
    const last = segments[segments.length - 1]
    const sameRun = last?.kind === 'delta-run'
      && last.eventType === row.eventType
      && JSON.stringify(last.identity ?? null) === JSON.stringify(row.identity ?? null)
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
    sequence: terminal.sequence + 1,
    occurredAt: terminal.occurredAt,
    receivedAt: terminal.receivedAt,
    eventType: 'turn.unit',
    payloadVersion: 1,
    typedPayload: {
      aggregateKind: 'turn-rollup',
      seqStart: rows[0].sequence,
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

describe('turn.unit 段内事件读入（#81 回归修复）', () => {
  it('嵌套 owner 与遗留扁平段载荷都归一为 canonical 事件', () => {
    const [user, text, terminal] = chunkRows([rawUser('问题'), rawText('答'), rawDone()])
    for (const shape of ['canonical', 'legacy-flat'] as const) {
      const payload = parseTurnUnitPayload(unitRowFromTurn([user, text, terminal], shape))
      expect(payload).toBeDefined()
      const eventSegments = payload!.segments.filter(segment => segment.kind === 'event')
      expect(eventSegments).toHaveLength(2)
      for (const segment of eventSegments) {
        expect(segment.event.owner).toEqual(owner)
        expect(segment.event.eventType).toBeDefined()
      }
    }
  })

  it('两种段载荷展开出的 canonical 语义字段相等（额外取证字段允许保留）', () => {
    const rows = chunkRows([rawUser('问题'), rawText('答'), rawText('案'), rawDone()])
    const fromCanonical = expandTurnUnitRows([unitRowFromTurn(rows)])
    const fromLegacy = expandTurnUnitRows([unitRowFromTurn(rows, 'legacy-flat')])
    // 扁平列形状额外携带 schemaVersion/rawMetadata/createdAt 等取证字段——归一后允许保留；
    // 投影负载字段（身份/序号/类型/结构化载荷）必须一致。
    const semantics = (events: readonly CanonicalConversationEvent[]): string => JSON.stringify(
      events.map(event => ({
        eventId: event.eventId,
        owner: event.owner,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
        receivedAt: event.receivedAt,
        eventType: event.eventType,
        payloadVersion: event.payloadVersion,
        identity: event.identity ?? null,
        typedPayload: event.typedPayload ?? null,
        rawPayload: event.rawPayload,
      })),
    )
    expect(semantics(fromLegacy)).toBe(semantics(fromCanonical))
    // 展开结果不得泄漏缺 owner 的事件（消息投影据此取 owner.localSessionId）
    for (const event of [...fromCanonical, ...fromLegacy]) {
      expect(event.owner?.localSessionId).toBe(owner.localSessionId)
    }
  })

  it('消息投影对单元行不抛异常，且与逐行投影逐字节相等', () => {
    const rows = chunkRows([rawUser('问题'), rawText('答'), rawText('案'), rawDone()])
    const perRow = JSON.stringify(projectMessagesFromCanonical(rows))
    // compact 读：被单元覆盖的行不在返回集内（生产形状：用户消息也在跨度内）
    const compact = JSON.stringify(projectMessagesFromCanonical([unitRowFromTurn(rows)]))
    expect(compact).toBe(perRow)
    const legacy = JSON.stringify(projectMessagesFromCanonical([unitRowFromTurn(rows, 'legacy-flat')]))
    expect(legacy).toBe(perRow)
    expect(compact).toContain('问题')
    expect(compact).toContain('答案')
  })

  it('缺 sequence 的段事件判为不可解析（调用方走单行兜底，不静默放行）', () => {
    const rows = chunkRows([rawUser('问题'), rawText('答'), rawDone()])
    const unit = unitRowFromTurn(rows)
    const typed = unit.typedPayload as { segments: Record<string, unknown>[] }
    typed.segments[1] = { kind: 'event', event: { eventType: 'turn.completed' } }
    expect(parseTurnUnitPayload(unit)).toBeUndefined()
    // 不可解析 ⇒ 整行按原样保留（不展开、不丢 raw 证据）
    expect(expandTurnUnitRows([unit])).toHaveLength(1)
  })
})
