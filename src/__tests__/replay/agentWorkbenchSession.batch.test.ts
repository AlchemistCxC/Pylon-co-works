/**
 * #81 L1：canonicalRowToWorkbench 的 batch 行展开测试。
 * - batch 行按 seqSpan 展开重建 sub-envelope（eventId = owner#(seqSpan[0]+i)）⇒
 *   appliedEventIds 与逐 chunk 存储逐一相同、文档逐字节相等；
 * - live 路径（sink 发布合并行）与逐 chunk 发布的文档一致；
 * - 形状损坏的 batch 行退回单行归一（event.unknown，raw 不丢，不崩溃）。
 */
import { describe, expect, it } from 'vitest'
import { normalizeRawEvent } from '../../domains/events/canonicalNormalizer'
import { mergeAdjacentDeltaChunks } from '../../infrastructure/events/canonicalEventBatch'
import { toCanonicalOwnerKey, type CanonicalConversationEvent, type CanonicalEventOwner } from '../../domains/events/eventSchema'
import type { Session } from '../../identityStore.ts'
import { createAgentWorkbenchSessionRuntime } from '../../sheets/agent-workbench/agentWorkbenchSession.ts'

const owner: CanonicalEventOwner = { profileId: 'profile-a', agentId: 'peri', localSessionId: 'local:a' }
const ownerKey = toCanonicalOwnerKey(owner)

function session(id = 'session-batch'): Session {
  return {
    id, source: 'local:a', agentId: 'peri', profileId: 'profile-a', name: id,
    createdAt: 1, lastActiveAt: 1, platform: 'local', workdir: '', sessionPrompt: '',
    skills: [], hooks: [], autoName: '',
  }
}

function rawText(text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:a',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId },
  }
}

function rawThinking(text: string, messageId = 'msg-1'): unknown {
  return {
    source: 'local:a',
    update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text }, messageId },
  }
}

function rawUser(text: string): unknown {
  return { source: 'local:a', update: { sessionUpdate: 'user_message_chunk', content: { text } } }
}

function rawToolStart(toolCallId: string): unknown {
  return {
    source: 'local:a',
    update: { sessionUpdate: 'tool_call', toolCallId, title: 'Read', kind: 'read' },
  }
}

function rawDone(): unknown {
  return { source: 'local:a', update: { sessionUpdate: 'done' } }
}

/** 逐 chunk canonical 行（每行 receivedAt 互不相同，等价性不得依赖时间戳巧合）。 */
function chunkRows(wires: readonly unknown[]): CanonicalConversationEvent[] {
  return wires.map((raw, index) => normalizeRawEvent(raw, {
    owner,
    clientGeneration: 1,
    sequence: index + 1,
    receivedAt: new Date(Date.UTC(2026, 8, 14, 0, 0, 0) + index).toISOString(),
  }).event)
}

async function bindWith(rows: readonly unknown[]) {
  const service = createAgentWorkbenchSessionRuntime({
    loadAll: async () => rows,
    subscribe: () => () => {},
  })
  await service.bind(session())
  const snapshot = service.runtime.getSnapshot()
  service.destroy()
  return snapshot
}

describe('agentWorkbenchSession batch 展开（#81 L1）', () => {
  it('replay：batch 行展开的 appliedEventIds 与文档和逐 chunk 存储逐字节一致', async () => {
    const wires = [
      rawUser('问题'),
      rawThinking('思考'),
      rawThinking('中'),
      rawText('答'),
      rawText('案'),
      rawToolStart('tool-1'),
      rawText('完成'),
      rawDone(),
    ]
    const perChunk = chunkRows(wires)
    const merged = mergeAdjacentDeltaChunks(perChunk)
    expect(merged.length).toBeLessThan(perChunk.length)

    const fromChunks = await bindWith(perChunk)
    const fromBatch = await bindWith(merged)

    expect(JSON.stringify(fromBatch.document)).toBe(JSON.stringify(fromChunks.document))
    // #81 L2：journal 信封改按 appliedRanges 覆盖幂等（appliedEventIds 只留非 journal 信封）
    expect(fromBatch.document?.appliedEventIds).toEqual(fromChunks.document?.appliedEventIds)
    expect(fromBatch.document?.appliedRanges).toEqual([[1, 8]])
    expect(fromChunks.document?.appliedRanges).toEqual([[1, 8]])
  })

  it('live：sink 发布的合并行经订阅展开后，文档与逐 chunk 发布一致', async () => {
    const wires = [rawText('你'), rawText('好'), rawText('世界')]
    const perChunk = chunkRows(wires)
    const [batch] = mergeAdjacentDeltaChunks(perChunk)

    const buildLive = async (events: readonly unknown[]) => {
      let publish: ((event: unknown) => void) | undefined
      const service = createAgentWorkbenchSessionRuntime({
        loadAll: async () => [],
        subscribe: listener => { publish = listener; return () => { publish = undefined } },
      })
      await service.bind(session())
      for (const event of events) publish?.(event)
      const snapshot = service.runtime.getSnapshot()
      service.destroy()
      return snapshot
    }

    const fromChunks = await buildLive(perChunk)
    const fromBatch = await buildLive([batch])
    expect(JSON.stringify(fromBatch.document)).toBe(JSON.stringify(fromChunks.document))
    expect(fromBatch.document?.messages.some(message => message.role === 'assistant' && message.content === '你好世界')).toBe(true)
  })

  it('形状损坏的 batch 行退回单行归一：产出 unknown 信封且不崩溃', async () => {
    const corrupt: CanonicalConversationEvent = {
      ...chunkRows([rawText('a'), rawText('b')]).map(row => row)[0],
      eventType: 'assistant.text.delta.batch',
      typedPayload: { text: 'ab', foldedCount: 2, seqSpan: [1, 2] },
      rawPayload: [rawText('a')], // 长度与 foldedCount/seqSpan 不互洽
    }
    const snapshot = await bindWith([rawUser('q') as unknown, corrupt, rawDone() as unknown].slice(0, 2))
    expect(snapshot.document?.diagnostics.some(item => item.code === 'canonical.journal.malformed')).toBe(true)
    expect(snapshot.status).toBe('degraded')
  })
})

describe('agentWorkbenchSession turn.unit 展开（#81 L2）', () => {
  it('compact 读（单元 + 未覆盖行）与逐行存储投影出相同消息内容与 appliedRanges', async () => {
    // 逐行存储：user(1) + text.delta(2,3) + turn.completed(4)
    const perRows = chunkRows([rawUser('问题'), rawText('答'), rawText('案'), rawDone()])
    // compact 存储：user(1) + turn.unit(5，覆盖 [2..4]，segments = delta-run + terminal event)
    const unitRow: CanonicalConversationEvent = {
      ...chunkRows([rawUser('问题')])[0],
      sequence: 5,
      eventId: `${ownerKey}#5`,
      eventType: 'turn.unit',
      occurredAt: perRows[3].occurredAt,
      receivedAt: perRows[3].occurredAt,
      typedPayload: {
        aggregateKind: 'turn-rollup',
        seqStart: 2,
        seqEnd: 4,
        foldedCount: 3,
        foldScheme: 'adjacent-delta-fold-v1',
        contentSha256: 'deadbeef',
        terminal: { eventType: 'turn.completed', occurredAt: perRows[3].occurredAt },
        segments: [
          { kind: 'delta-run', eventType: 'assistant.text.delta', seqStart: 2, seqEnd: 3, identity: { messageId: 'msg-1' }, text: '答案', occurredAt: perRows[1].occurredAt, markdown: false },
          { kind: 'event', event: perRows[3] },
        ],
      },
      rawPayload: { kind: 'turn-unit' },
    }

    const fromRows = await bindWith(perRows)
    const fromUnit = await bindWith([perRows[0], unitRow])

    // 消息内容等价（用户消息 + 折叠文本），终态摘要等价
    const rowsMessages = fromRows.document?.messages.map(message => ({ role: message.role, content: message.content }))
    const unitMessages = fromUnit.document?.messages.map(message => ({ role: message.role, content: message.content }))
    expect(JSON.stringify(unitMessages)).toBe(JSON.stringify(rowsMessages))
    expect(unitMessages?.some(message => message.role === 'assistant' && message.content === '答案')).toBe(true)
    // journal 行（user [1,1]）与单元覆盖 [2,4] 合并；journal 行不再进 appliedEventIds
    expect(fromUnit.document?.appliedRanges).toEqual([[1, 4]])
    expect(fromUnit.document?.appliedEventIds).toEqual([])
    // 终态证据可从单元行恢复（canonicalHasTerminal）
    expect(fromUnit.summary?.reason).toBe('done')
  })
})

/**
 * #81 回归修复（重启后无法重放会话）：单元行的整行 segment 嵌的是**后端行形状**——
 * 新数据经 Rust `canonical_event_wire`（嵌套 owner 的 EVT-01 事件），历史数据是扁平列
 * 形状，且**用户消息也落在单元跨度内**（`seqStart` = turn 首行，生产形状）。两条读边界
 * 不变式必须成立：①解析边界把两种形状都归一为嵌套 canonical 事件；②单个段不可读时只
 * 退化该段，不抹掉整单元。
 */
describe('agentWorkbenchSession turn.unit 生产形状（#81 回归修复）', () => {
  /** Rust 段事件形状：`canonical_event_wire`（嵌套 owner/provenance）。 */
  function canonicalSegmentEvent(event: CanonicalConversationEvent): CanonicalConversationEvent {
    return { ...event, provenance: { origin: 'local-observed', trust: 'authoritative' } }
  }

  /** Rust `serde_json::to_value(CanonicalEventRow)` 遗留扁平列形状。 */
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

  /** 生产形状单元行：跨度含用户消息与终态行，单元自身占 `terminal.sequence + 1`。 */
  function unitRowFromTurn(
    rows: readonly CanonicalConversationEvent[],
    shape: 'canonical' | 'legacy-flat' = 'canonical',
    corruptKinds: readonly number[] = [],
  ): CanonicalConversationEvent {
    const terminal = rows[rows.length - 1]
    const segment = shape === 'canonical' ? canonicalSegmentEvent : legacyFlatSegmentEvent
    const segments: Record<string, unknown>[] = []
    rows.forEach((row, index) => {
      const isDelta = row.eventType === 'assistant.text.delta' || row.eventType === 'assistant.thinking.delta'
      if (!isDelta) {
        // corruptKinds 命中的整行段换成形状不可用的事件（有 sequence ⇒ 可解析，
        // 但 owner 三元组为空 ⇒ validateCanonicalEvent 失败 ⇒ 走段级隔离）。
        segments.push(corruptKinds.includes(index)
          ? { kind: 'event', event: { sequence: row.sequence, eventType: row.eventType, payloadVersion: 1, rawPayload: { kind: 'corrupt-segment' } } }
          : { kind: 'event', event: segment(row) })
        return
      }
      const text = (row.typedPayload as { text?: string } | undefined)?.text ?? ''
      const last = segments[segments.length - 1]
      const sameRun = last?.kind === 'delta-run'
        && last.eventType === row.eventType
        && JSON.stringify(last.identity ?? null) === JSON.stringify(row.identity ?? null)
      if (sameRun) {
        last.seqEnd = row.sequence
        last.text = `${String(last.text ?? '')}${text}`
        return
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
    })
    return {
      ...terminal,
      sequence: terminal.sequence + 1,
      eventId: `${ownerKey}#${terminal.sequence + 1}`,
      eventType: 'turn.unit',
      occurredAt: terminal.occurredAt,
      receivedAt: terminal.receivedAt,
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
    } as CanonicalConversationEvent
  }

  const messagesOf = (snapshot: Awaited<ReturnType<typeof bindWith>>) =>
    snapshot.document?.messages.map(message => ({ role: message.role, content: message.content }))

  it('compact 读（多轮生产形状单元行）与逐行存储投影出相同消息与 appliedRanges', async () => {
    // 逐行：turn1 = user(1) text(2,3) done(4)；turn2 = user(5) tool(6) text(7,8) done(9)
    const wires = [
      rawUser('第一问'), rawText('答'), rawText('案'), rawDone(),
      rawUser('第二问'), rawToolStart('tool-1'), rawText('结论', 'msg-2'), rawText('完毕', 'msg-2'), rawDone(),
    ]
    const perRows = chunkRows(wires)
    const turn1 = unitRowFromTurn(perRows.slice(0, 4))
    const turn2 = unitRowFromTurn(perRows.slice(4))
    // compact 读只返回两条单元行（被覆盖行不传输）
    const fromRows = await bindWith(perRows)
    const fromUnits = await bindWith([turn1, turn2])

    expect(JSON.stringify(messagesOf(fromUnits))).toBe(JSON.stringify(messagesOf(fromRows)))
    expect(messagesOf(fromUnits)?.map(message => message.content)).toEqual(['第一问', '答案', '第二问', '结论完毕'])
    // journal 行不记 appliedEventIds；覆盖区间由 appliedRanges 承担（相邻吸收成全跨度）
    expect(fromUnits.document?.appliedEventIds).toEqual([])
    expect(fromUnits.document?.appliedRanges).toEqual([[1, 9]])
    expect(fromUnits.summary?.reason).toBe('done')
  })

  it('遗留扁平段载荷与 canonical 段载荷投影等价', async () => {
    const perRows = chunkRows([rawUser('问题'), rawThinking('想'), rawText('答案'), rawToolStart('tool-1'), rawDone()])
    const canonical = await bindWith([unitRowFromTurn(perRows)])
    const legacy = await bindWith([unitRowFromTurn(perRows, 'legacy-flat')])
    expect(JSON.stringify(messagesOf(legacy))).toBe(JSON.stringify(messagesOf(canonical)))
    expect(messagesOf(legacy)?.map(message => message.content)).toEqual(['问题', '想', '答案'])
    expect(legacy.document?.appliedRanges).toEqual(canonical.document?.appliedRanges)
  })

  it('段级隔离：单个不可读段只退化该段，不抹掉整轮正文', async () => {
    const perRows = chunkRows([rawUser('问题'), rawText('答'), rawText('案'), rawDone()])
    // 用户段（index 0）损坏：可读的 delta-run（答案）必须仍然展开，终态段亦不受影响
    const snapshot = await bindWith([unitRowFromTurn(perRows, 'canonical', [0])])
    const contents = messagesOf(snapshot)?.map(message => message.content)
    expect(contents).toEqual(['答案'])
    // 坏段以 event.unknown 保留（raw 证据不丢，可见为诊断项）
    expect(snapshot.document?.diagnostics.some(item => item.code === 'event.unknown')).toBe(true)
    // 未被污染的终态段仍提供完成态证据
    expect(snapshot.summary?.reason).toBe('done')

    // 更烂的段（连 payloadVersion/rawPayload 都没有）也不得抛异常或吞掉整轮：
    // 隔离路径必须容忍任意形状的坏段。
    const bare = unitRowFromTurn(perRows)
    const typed = bare.typedPayload as { segments: Record<string, unknown>[] }
    typed.segments[0] = { kind: 'event', event: { sequence: 1, eventType: 'user.message' } }
    const bareSnapshot = await bindWith([bare])
    expect(messagesOf(bareSnapshot)?.map(message => message.content)).toEqual(['答案'])
    expect(bareSnapshot.document?.diagnostics.some(item => item.code === 'event.unknown')).toBe(true)
  })
})
