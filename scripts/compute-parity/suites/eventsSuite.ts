// events 域套件：normalize / 批规则 / 投影 / turn 时长 / 单元展开。
// TS 侧全部是树上活实现（src/domains/events/** + canonicalEventBatch.ts）；
// wasm 侧批量出口统一走 PYPB v1 帧（fixtures/eventsFrame.ts 的宿主侧编码器）。

import type { Suite } from '../harness.ts'
// `stableJson` 在 harness.ts，不在 index.ts——从 index 取会让 bun/node 直接 SyntaxError
// （vitest 的解析更宽松，所以只在非 vitest 入口暴露）。
import { stableJson } from '../harness.ts'
import type { ComputeContextLike } from '../index.ts'
import { normalizeRawEvent, type CanonicalNormalizeContext } from '../../../src/domains/events/canonicalNormalizer.ts'
import { resolveChunkAppend } from '../../../src/domains/events/chunkMerge.ts'
import { mergeAdjacentDeltaChunks, canonicalBatchSpanOf as batchSpanOfTs } from '../../../src/infrastructure/events/canonicalEventBatch.ts'
import { projectCanonicalMessages } from '../../../src/domains/events/messageProjectionRules.ts'
import { effectiveCanonicalProjectionEvents } from '../../../src/domains/events/messageProjection.ts'
import { projectToolFromCanonical, projectToolFromMessage, toolFieldsFromCanonical } from '../../../src/domains/events/toolProjection.ts'
import { deriveCanonicalTurnDuration, hasCanonicalTurnTerminal } from '../../../src/domains/events/canonicalTurnDuration.ts'
import { expandTurnUnitRows } from '../../../src/domains/events/canonicalUnit.ts'
import { createCanonicalEvent, type CanonicalConversationEvent } from '../../../src/domains/events/eventSchema.ts'
import { encodeEventsFrame } from '../fixtures/eventsFrame.ts'
import {
  BASE_MS, chunkRows, columns, context, conversationTurn, identityColumns, isoAt, owner,
  rawDone, rawText, rawThinking, rawToolStart, rawToolUpdate, rawUser,
} from '../fixtures/eventsCorpus.ts'

// 消息投影注入列：与 Rust 侧同一函数喂两侧（toolInputSummary / timeFormatter）。
const projectionOptions = {
  toolInputSummary: (title: string, rawInput: unknown, toolKind?: string) =>
    columns.toolInputSummary(title, rawInput, toolKind),
  timeFormatter: (event: CanonicalConversationEvent) => columns.timeLabel(event as unknown as Record<string, unknown>),
}

/** 单元行构建（与 eventsComputeParity 的 unitRowFromTurn 同构）。 */
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

/** expandTurnUnitRows 的语义比对口径（TS 引用直通行 → 帧下标；段事件 → 语义子集）。 */
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
    identity: event.identity ?? undefined,
    typedPayload: event.typedPayload ?? undefined,
    rawPayload: event.rawPayload,
  }
}

/**
 * batch 行双侧统一投影：TS 的合并行把 text/foldedCount/seqSpan 藏在 typedPayload，
 * wasm 行是顶层扁平字段（另多 ownerKey）——按 eventsComputeParity 的比对口径取
 * 同一字段集（ownerKey 不在迁移契约内，不比）。
 */
function projectBatchRow(row: unknown): Record<string, unknown> {
  const source = row as Record<string, unknown>
  const typed = source.typedPayload as { text?: string, foldedCount?: number, seqSpan?: [number, number] } | undefined
  return {
    eventType: source.eventType,
    sequence: source.sequence,
    eventId: source.eventId,
    owner: source.owner,
    clientGeneration: source.clientGeneration,
    payloadVersion: source.payloadVersion,
    occurredAt: source.occurredAt,
    receivedAt: source.receivedAt,
    identity: source.identity ?? undefined,
    // TS 合并行把内容字段藏在 typedPayload，wasm 行是顶层扁平字段——两侧都取。
    text: typed?.text ?? source.text,
    foldedCount: typed?.foldedCount ?? source.foldedCount,
    seqSpan: typed?.seqSpan ?? source.seqSpan,
    rawPayload: source.rawPayload,
  }
}

export function buildEventsSuite(ctx: ComputeContextLike): Suite {
  const wasm = ctx.compute
  const frameOf = (rows: readonly unknown[], identity = false): Uint8Array =>
    encodeEventsFrame(rows, identity ? identityColumns : columns)

  return {
    domain: 'events',
    pairs: [
      {
        name: 'normalizeRawEvent',
        domain: 'events',
        ts: wires => wires.map((raw, index) => {
          const result = normalizeRawEvent(raw, normalizeContext(index + 1))
          return { event: result.event, malformed: result.malformed, sessionUpdate: result.sessionUpdate, warning: result.warning, update: result.update }
        }),
        wasm: wires => wires.map((raw, index) => {
          const result = wasm.normalizeRawEvent(raw, owner, 1, index + 1, isoAt(BASE_MS + index + 1)) as Record<string, unknown>
          return { event: result.event, malformed: result.malformed, sessionUpdate: result.sessionUpdate ?? undefined, warning: result.warning ?? undefined, update: result.update ?? undefined }
        }),
        cases: [
          {
            id: 'wire-shapes',
            meta: { shape: 'wire' },
            build: () => [
              rawToolStart('tc-1', { rawInput: { path: 'a.txt', mode: 'r' }, content: [{ type: 'text', text: 'preview' }] }),
              rawToolUpdate('tc-2', { content: { tool_use_id: 'tc-2' }, rawOutput: { ok: true, lines: 3 }, status: 'completed' }),
              rawToolUpdate('tc-3', { status: 'failed', rawOutput: 'boom' }),
              rawUser('你好'),
              { source: 'local:s1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } } },
              { source: 'local:s1', update: { sessionUpdate: 'error', message: '炸了' } },
              { source: 'local:s1', update: { sessionUpdate: 'cancelled' } },
              { source: 'local:s1', update: { sessionUpdate: 'done', stopReason: 'end_turn', usage: { outputTokens: 3 } } },
              { nope: true },
              { sessionUpdate: 'plan', content: 'plan-text' },
            ],
          },
          {
            id: 'identity-aliases',
            meta: { shape: 'identity', edge: true },
            build: () => [
              { update: { sessionUpdate: 'tool_call', toolCallId: 'root-id', content: { tool_call_id: 'content-id' } } },
              { update: { sessionUpdate: 'agent_message_chunk', messageId: 'root-msg', content: { text: 'x', messageId: 'content-msg' } } },
              { update: { sessionUpdate: 'tool_call', _meta: { toolUseId: 'meta-id' } } },
            ],
          },
          {
            id: 'turn-batch-scale',
            meta: { scale: 'm' as const },
            build: () => conversationTurn(1, { textChunks: 2 }).flatMap(wire => Array.from({ length: 60 }, () => wire)),
          },
        ],
      },
      {
        name: 'resolveChunkAppend',
        domain: 'events',
        ts: combos => combos.map(([lastRole, incomingRole, lastIdentity, incomingIdentity]) =>
          resolveChunkAppend({
            lastRole: lastRole ?? undefined,
            incomingRole,
            lastIdentity: lastIdentity ?? undefined,
            incomingIdentity: incomingIdentity ?? undefined,
          })),
        wasm: combos => combos.map(([lastRole, incomingRole, lastIdentity, incomingIdentity]) =>
          wasm.resolveChunkAppend(lastRole, incomingRole, lastIdentity, incomingIdentity)),
        cases: [
          {
            id: 'role-identity-combos',
            meta: { shape: 'matrix', edge: true },
            build: () => [
              ['assistant', 'assistant', { messageId: 'm-1' }, { messageId: 'm-2' }],
              ['assistant', 'reasoning', { messageId: 'm-1' }, null],
              [null, 'assistant', null, { messageId: 'm-1' }],
              ['reasoning', 'reasoning', { turnId: 't-1' }, null],
              ['tool', 'tool', null, null],
            ] as ReadonlyArray<readonly [string | null, string, unknown, unknown]>,
          },
        ],
      },
      {
        name: 'mergeAdjacentDeltaChunks',
        domain: 'events',
        // TS 侧真正调合并函数再分类（引用相等的归 passthrough，其余是合并行），
        // limits 与 wasm 侧参数同源；两侧 batch 行经 projectBatchRow 统一字段集后比对。
        ts: rows => mergeAdjacentDeltaChunks(rows.rows, {
          maxRawBytes: rows.maxRawBytes ?? 48 * 1024,
          maxFoldedCount: rows.maxFoldedCount ?? 2000,
        }).map((row) => {
          const index = rows.rows.indexOf(row)
          return index >= 0 ? { kind: 'event', index } : { kind: 'batchRow', row: projectBatchRow(row) }
        }),
        wasm: rows => (wasm.mergeAdjacentDeltaChunks(frameOf(rows.rows), rows.maxRawBytes ?? 48 * 1024, rows.maxFoldedCount ?? 2000) as Array<Record<string, unknown>>)
          .map(item => item.kind === 'event' ? item : { kind: 'batchRow', row: projectBatchRow(item.row) }),
        cases: [
          {
            id: 'fold-shapes',
            meta: { shape: 'batch' },
            build: () => ({ rows: chunkRows([
              rawUser('hi'), rawText('你'), rawText('好'), rawText('，世界'), rawUser('x'),
            ]) }),
          },
          {
            id: 'identity-type-boundaries',
            meta: { shape: 'batch', edge: true },
            build: () => ({ rows: chunkRows([
              rawText('A', 'msg-1'), rawText('B', 'msg-2'), rawUser('done'),
              rawText('a'), rawThinking('think-1'), rawText('c'), rawUser('x'),
              rawText('before'), rawToolStart('tool-1'), rawText('after'), rawDone(), rawText('b'),
            ]) }),
          },
          {
            id: 'folded-count-cap',
            meta: { shape: 'batch', edge: true },
            build: () => ({ rows: chunkRows(Array.from({ length: 7 }, (_, index) => rawText(`#${index}`))), maxFoldedCount: 3 }),
          },
          {
            id: 'byte-cap-2002',
            meta: { scale: 'm' },
            build: () => ({ rows: chunkRows(Array.from({ length: 2002 }, () => rawText('x'))) }),
          },
        ],
      },
      {
        name: 'projectToolProjectionsFromBatch',
        domain: 'events',
        ts: rows => rows.map(row => projectToolFromCanonical(row) ?? null),
        wasm: rows => (wasm.projectToolProjectionsFromBatch(frameOf(rows)) as unknown[]).map(item => item ?? null),
        cases: [
          {
            id: 'tool-full-fields',
            meta: { shape: 'tool' },
            build: () => chunkRows([
              rawToolStart('tc-1', { rawInput: { path: 'a.txt', mode: 'r' }, content: [{ type: 'text', text: 'preview' }] }),
              rawToolUpdate('tc-2', { content: { tool_use_id: 'tc-2' }, rawOutput: { ok: true, lines: 3 }, status: 'completed' }),
              rawToolUpdate('tc-1', { status: 'completed', rawOutput: '内容' }),
              rawUser('hi'),
              { source: 'local:s1', update: { sessionUpdate: 'future_update', value: 1 } },
            ], 7),
          },
          {
            id: 'tools-scale',
            meta: { scale: 'm' },
            build: () => chunkRows(
              Array.from({ length: 120 }, (_, index) => rawToolStart(`tc-${index}`, { rawInput: { path: `f${index}` } })),
            ),
          },
        ],
      },
      {
        name: 'toolFieldsFromCanonical',
        domain: 'events',
        ts: rows => rows.map(row => toolFieldsFromCanonical(row)),
        wasm: rows => rows.map(row => wasm.toolFieldsFromCanonical(row.typedPayload)),
        cases: [
          {
            id: 'typed-payload-shapes',
            meta: { shape: 'tool', edge: true },
            build: () => chunkRows([
              rawToolUpdate('tc-9', {
                title: 'Write', kind: 'write_file', rawInput: { path: 'b.txt' },
                rawOutput: 'ok', status: 'running', content: [{ type: 'text', text: 'w' }],
              }),
              rawToolStart('tc-10'),
              rawText('not-a-tool'),
            ]),
          },
        ],
      },
      {
        name: 'deriveCanonicalTurnDuration',
        domain: 'events',
        // case 输入 = 多份语料；每份语料独立喂两侧（与 parity 测试 it.each 同口径）。
        ts: corpora => corpora.map(rows => deriveCanonicalTurnDuration(rows as never) ?? null),
        wasm: corpora => corpora.map(rows => wasm.deriveCanonicalTurnDuration(frameOf(rows)) ?? null),
        cases: [
          {
            id: 'boundary-corpus',
            meta: { shape: 'turn' },
            build: () => [
              [
                { sequence: 1, eventType: 'user.message', occurredAt: '2026-09-03T00:00:10.000Z', receivedAt: '2026-09-03T00:00:10.000Z' },
                { sequence: 2, eventType: 'turn.completed', occurredAt: '2026-09-03T00:00:13.250Z', receivedAt: '2026-09-03T00:00:13.250Z' },
              ],
              [
                { sequence: 1, eventType: 'user.message', occurredAt: '2026-09-03T00:00:01.000Z', receivedAt: '2026-09-03T00:00:01.000Z' },
                { sequence: 2, eventType: 'turn.completed', occurredAt: '2026-09-03T00:00:02.000Z', receivedAt: '2026-09-03T00:00:02.000Z' },
                { sequence: 3, eventType: 'user.message', occurredAt: '2026-09-03T00:01:00.000Z', receivedAt: '2026-09-03T00:01:00.000Z' },
                { sequence: 4, eventType: 'turn.failed', occurredAt: '2026-09-03T00:01:04.500Z', receivedAt: '2026-09-03T00:01:04.500Z' },
              ],
              [{ sequence: 1, eventType: 'user.message', occurredAt: '', receivedAt: '' }, { sequence: 2, eventType: 'turn.completed', occurredAt: '2026-09-03T00:00:02.000Z', receivedAt: '2026-09-03T00:00:02.000Z' }],
              [{ sequence: 1, eventType: 'user.message', occurredAt: '2026-09-03T00:00:10.000Z', receivedAt: '2026-09-03T00:00:10.000Z' }, { sequence: 4, eventType: 'assistant.text.delta.batch', occurredAt: '2026-09-03T00:00:10.000Z', receivedAt: '2026-09-03T00:00:10.000Z' }],
            ],
          },
        ],
      },
      {
        name: 'hasCanonicalTurnTerminal',
        domain: 'events',
        ts: corpora => corpora.map(rows => hasCanonicalTurnTerminal(rows as never)),
        wasm: corpora => corpora.map(rows => wasm.hasCanonicalTurnTerminal(frameOf(rows))),
        cases: [{
          id: 'boundary-corpus-shared',
          meta: { shape: 'turn' },
          build: () => [
            [
              { sequence: 1, eventType: 'user.message', occurredAt: '2026-09-03T00:00:10.000Z', receivedAt: '2026-09-03T00:00:10.000Z' },
              { sequence: 2, eventType: 'turn.completed', occurredAt: '2026-09-03T00:00:13.250Z', receivedAt: '2026-09-03T00:00:13.250Z' },
            ],
            [{ sequence: 1, eventType: 'user.message', occurredAt: '2026-09-03T00:00:10.000Z', receivedAt: '2026-09-03T00:00:10.000Z' }],
          ],
        }],
      },
      {
        name: 'expandTurnUnitRows',
        domain: 'events',
        // TS 侧真正调展开函数：返回扁平事件数组（引用直通行 → 帧下标；单元展开的
        // 段事件是新对象 → 语义子集），wasm 侧返回 {kind, …} 包装项。
        ts: input => expandTurnUnitRows(input.input).map((event) => {
          const index = input.input.indexOf(event)
          return index >= 0 ? { kind: 'event', index } : { kind: 'segment', event: semanticsOf(event) }
        }),
        wasm: input => (wasm.expandTurnUnitRows(frameOf(input.input, true)) as Array<Record<string, unknown>>).map((item) => {
          if (item.kind === 'event') return item
          return { kind: 'segment', event: item.event }
        }),
        cases: [
          {
            id: 'unit-with-user-anchor',
            meta: { shape: 'unit' },
            build: () => {
              const rows = chunkRows([rawUser('问题'), rawText('答'), rawText('案'), rawDone()])
              return { input: [...rows, unitRowFromTurn(rows, 5)] }
            },
          },
          {
            id: 'unit-missing-sequence-segment',
            meta: { shape: 'unit', edge: true },
            build: () => {
              const rows = chunkRows([rawUser('问题'), rawText('答'), rawDone()])
              const unit = unitRowFromTurn(rows, 4)
              const typed = unit.typedPayload as { segments: Record<string, unknown>[] }
              typed.segments[1] = { kind: 'event', event: { eventType: 'turn.completed' } }
              return { input: [unit] }
            },
          },
        ],
      },
      {
        name: 'effectiveCanonicalProjectionEvents',
        domain: 'events',
        // 口径对齐 eventsComputeParity：TS 侧真正调有效流函数；比对「帧下标 +
        // origin + sequence」元数据，不比整对象（TS recovery 路径复制出新对象，
        // 引用/键序均不在契约内）。
        ts: rows => effectiveCanonicalProjectionEvents(rows.rows).map((event) => {
          const direct = rows.rows.indexOf(event)
          const withoutSequence = (candidate: unknown) => stableJson({ ...(candidate as object), sequence: null })
          const index = direct >= 0
            ? direct
            : rows.rows.findIndex(row => withoutSequence(row) === withoutSequence(event))
          return { origin: index >= 0 ? 'frame' : 'unit', index: index >= 0 ? index : null, sequence: (event as unknown as { sequence: number }).sequence }
        }),
        wasm: rows => (wasm.effectiveCanonicalProjectionEvents(frameOf(rows.rows)) as Array<Record<string, unknown>>)
          .map(item => ({ origin: item.origin, index: (item.index as number | undefined) ?? null, sequence: item.sequence })),
        cases: [
          {
            id: 'snapshot-optimistic-recovery',
            meta: { shape: 'effective', edge: true },
            build: () => {
              const snapshotRow = { ...chunkRows([rawUser('快照')], 1)[0]!, eventType: 'history.snapshot' as const }
              const optimistic = chunkRows([{
                source: 'local:s1',
                update: {
                  sessionUpdate: 'user_message_chunk',
                  content: { text: '你好' },
                  _meta: { pylonOptimisticUser: true },
                },
              }], 2)[0]!
              const echo = chunkRows([rawUser('你好')], 1)[0]!
              const liveA = chunkRows([rawText('live-1')], 1)[0]!
              const liveB = chunkRows([rawText('live-2')], 1)[0]!
              const recovered = (sequence: number, text: string, ordinal: number, anchorUpdate: unknown) =>
                normalizeRawEvent({
                  source: 'local:s1',
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text },
                    messageId: 'msg-rec',
                    _meta: { pylonCanonicalRecovery: true, pylonReplayOrdinal: ordinal, pylonReplayAnchor: anchorUpdate },
                  },
                }, normalizeContext(sequence)).event
              const recoveredLate = recovered(5, 'recovered-late', 1, (liveA.rawPayload as Record<string, unknown>).update)
              const recoveredEarly = recovered(4, 'recovered-early', 0, (liveB.rawPayload as Record<string, unknown>).update)
              return { rows: [snapshotRow, optimistic, echo, liveA, liveB, recoveredLate, recoveredEarly] }
            },
          },
          {
            id: 'plain-turn',
            meta: { shape: 'effective' },
            build: () => ({ rows: chunkRows([rawUser('问'), rawText('答'), rawDone()], 3) }),
          },
        ],
      },
      {
        name: 'projectCanonicalMessages',
        domain: 'events',
        ts: rows => projectCanonicalMessages(rows.rows, projectionOptions),
        wasm: rows => wasm.projectCanonicalMessages(frameOf(rows.rows)),
        cases: [
          {
            id: 'message-corpora',
            meta: { shape: 'projection' },
            build: () => ({
              rows: chunkRows([
                rawUser('问题'), rawText('你'), rawText('好'), rawText('，世界'), rawDone(),
              ], 3),
            }),
          },
          {
            id: 'thinking-text-alternation',
            meta: { shape: 'projection' },
            build: () => ({
              rows: chunkRows([
                rawUser('问题'), rawThinking('思考'), rawThinking('中…'), rawText('答'), rawText('案'), rawDone(),
              ], 3),
            }),
          },
          {
            id: 'tool-interrupted-run',
            meta: { shape: 'projection', edge: true },
            build: () => ({
              rows: chunkRows([
                rawUser('查一下'), rawText('先看看'), rawToolStart('tool-1', { rawInput: { path: 'a.txt' } }),
                rawText('结论是'), rawText('…'), rawDone(),
              ], 3),
            }),
          },
          {
            id: 'conversations-scale',
            meta: { scale: 'm' },
            build: () => ({
              rows: Array.from({ length: 12 }, (_, index) => chunkRows(conversationTurn(index, { textChunks: 4 }), 3)).flat(),
            }),
          },
        ],
      },
      {
        name: 'projectMessagesFromCanonical',
        domain: 'events',
        ts: rows => projectCanonicalMessages(effectiveCanonicalProjectionEvents(rows.rows), projectionOptions),
        wasm: rows => wasm.projectMessagesFromCanonical(frameOf(rows.rows)),
        cases: [
          {
            id: 'composed-message-corpora',
            meta: { shape: 'projection' },
            build: () => ({
              rows: chunkRows([
                rawUser('问题'), rawThinking('思考'), rawText('答'), rawToolStart('t1'), rawToolUpdate('t1', { status: 'completed', rawOutput: 'ok' }), rawDone(),
              ], 3),
            }),
          },
          {
            id: 'mixed-scale',
            meta: { scale: 'm' },
            build: () => ({
              rows: Array.from({ length: 10 }, (_, index) => chunkRows(conversationTurn(index, { textChunks: 5 }), 3)).flat(),
            }),
          },
        ],
      },
      {
        name: 'canonicalBatchSpanOf',
        domain: 'events',
        // TS 逐事件取跨度（undefined → null）；wasm 批量帧 → 每行 Option → null。
        ts: rows => rows.rows.map(row => batchSpanOfTs(row) ?? null),
        wasm: rows => (wasm.canonicalBatchSpanOf(frameOf(rows.rows)) as Array<[number, number] | null>),
        cases: [
          {
            id: 'delta-and-plain-rows',
            meta: { shape: 'batch', edge: true },
            build: () => ({ rows: chunkRows([
              rawUser('问'), rawText('答'), rawText('案'), rawDone(),
              rawToolStart('tc-1'), { source: 'local:s1', update: { sessionUpdate: 'error', message: '炸了' } },
            ]) }),
          },
          {
            id: 'batch-scale',
            meta: { scale: 'm' },
            build: () => ({ rows: chunkRows(Array.from({ length: 500 }, (_, index) => rawText(`x${index}`))) }),
          },
        ],
      },
      {
        name: 'projectToolFromMessage',
        domain: 'events',
        // TS 收整条 ToolProjectableMessage；wasm 薄壳按字段散参（同一载荷形状）。
        ts: inputs => inputs.map(({ message, clientGeneration }) =>
          projectToolFromMessage(message, owner, clientGeneration) ?? null),
        wasm: inputs => inputs.map(({ message, clientGeneration }) =>
          wasm.projectToolFromMessage(
            message.externalIdentity?.toolCallId ?? null,
            message.toolName ?? null,
            message.toolKind ?? null,
            message.rawInput,
            message.rawOutput,
            message.toolStatus ?? null,
            message.contentBlocks,
            owner,
            clientGeneration,
          ) ?? null),
        cases: [
          {
            id: 'message-shapes',
            meta: { shape: 'tool', edge: true },
            build: () => [
              { message: { externalIdentity: { toolCallId: 'tc-1' }, toolName: 'read', toolKind: 'read', rawInput: { path: 'a' }, rawOutput: 'ok', toolStatus: 'completed' }, clientGeneration: 1 },
              { message: { toolName: 'grep' }, clientGeneration: 1 },
              { message: {}, clientGeneration: 1 },
              { message: { externalIdentity: { toolCallId: 'tc-2' }, contentBlocks: [{ type: 'text', text: '块' }] }, clientGeneration: 3 },
              { message: { toolKind: 'write_file', rawInput: { path: 'b' } }, clientGeneration: 1 },
            ],
          },
        ],
      },
    ],
  }
}

function normalizeContext(sequence: number): CanonicalNormalizeContext {
  return context(sequence, 1)
}
