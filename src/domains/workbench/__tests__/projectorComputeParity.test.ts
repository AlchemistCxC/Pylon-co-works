// #220 WP2：projector 层（内容部件解析/聚合、span 占用、工作台文档折叠）的
// TS↔WASM parity 门禁。同一输入喂两侧，断言逐字段一致：
//
// - TS 基线：`workbenchProjector.ts` / `content/contentPartSchema.ts`（迁移期与
//   计算核并存，parity 绿后 TS 侧退役——见 ADR-0018）；
// - WASM：`src-tauri/pylon-compute/src/projector/**`，批量入口走 spec「编组格式」
//   的紧凑列式帧（词表 u32 索引 + 字串池 + 定长头），**热路径零 JSON**。
//
// 帧编码器（本文件内的 encodeFrame）是 TS 侧的生产形态预演：事件类型传词表
// 下标、字符串只留内容本体、serde_json 只碰冷事件整块载荷。

import { describe, expect, it } from 'vitest'

import {
  coalesceAdjacentDisplayTextParts,
  coalesceAdjacentReasoningParts,
  createUnknownContentPart,
  parseContentPart,
  type ContentPart,
} from '../content/contentPartSchema.ts'
import {
  WORKBENCH_SEMANTIC_EVENT_TYPES,
  createWorkbenchEnvelope,
  type WorkbenchEventEnvelope,
  type WorkbenchSemanticEvent,
} from '../events/workbenchEventSchema.ts'
import { createWorkbenchDocument, projectWorkbench } from '../workbenchProjector.ts'
import { loadPylonCompute } from '../../../infrastructure/compute/pylonCompute'

// ── 计算核出口（WP2 projector 段） ───────────────────────────────────────────

interface ProjectorPatch {
  revision: number
  appliedEventIdsAppended: string[]
  appliedRanges: [number, number][]
  timelineUpserts: unknown[]
  messageUpserts: { index: number; message: unknown }[]
  session: unknown
}

interface PylonProjectorInstance {
  /** 边界输出为一次 serde_json 写出的 JSON 文本（保 null 精确；见 Rust 侧 to_boundary_json）。 */
  appendBatch(frame: Uint8Array): string
  document(): string
}

interface ProjectorCompute {
  PylonProjector: new (sessionId: string) => PylonProjectorInstance
  projectorEventTypes(): string[]
  projectorParseContentPart(input: string): string
  projectorCreateUnknownContentPart(originalType: string, raw: string, maxRawBytes?: number): string
  projectorCoalesceDisplayTextParts(input: string): string
  projectorCoalesceReasoningParts(input: string): string
  projectorMergeCoverage(ranges: string, start: number, end: number): string
}

const compute = (await loadPylonCompute()) as unknown as ProjectorCompute

/** 边界输出统一 JSON.parse（serde_wasm_bindgen 会把 null 编成 undefined，故不用）。 */
function fromBoundary<T>(json: string): T {
  return JSON.parse(json) as T
}

// ── 帧编码器（与 Rust decodeFrame 对齐；编组格式见 projector/workbench.rs 头注） ──

const PROJECTOR_EVENT_TYPES = [...WORKBENCH_SEMANTIC_EVENT_TYPES, 'event.unknown', 'extension.event']
const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool', 'reasoning', 'developer', 'unknown']
const PROVENANCE_ORIGINS = ['local-observed', 'optimistic-local', 'recovery-import', 'migration', 'plugin']
const TEXT_PART_KINDS = ['text', 'markdown', 'code', 'ansi', 'reasoning', 'thinking']
/** v2：在 v1 的 17 槽后追加 provenance 富字段 JSON（activity/extension 节点携带完整 provenance）。 */
const FRAME_PAIRS = 18
const PROVENANCE_EXTRA_KEYS = ['provider', 'importId', 'sourceOrdinal', 'orderConfidence', 'collectionComplete', 'synthetic'] as const

function encodeFrame(envelopes: readonly WorkbenchEventEnvelope[]): Uint8Array {
  const encoder = new TextEncoder()
  const pool: number[] = []
  const putString = (value: string | undefined): [number, number] => {
    if (value === undefined || value.length === 0) return [0, 0]
    const bytes = encoder.encode(value)
    const offset = pool.length
    for (const byte of bytes) pool.push(byte)
    return [offset, bytes.length]
  }

  const encoded = envelopes.map(envelope => {
    const event = envelope.event as unknown as Record<string, unknown>
    const typeIndex = PROJECTOR_EVENT_TYPES.indexOf(envelope.event.type)
    if (typeIndex < 0) throw new Error(`事件类型不在投影词表内：${envelope.event.type}`)

    let flags = PROVENANCE_ORIGINS.indexOf(envelope.provenance.origin)
    flags |= (envelope.provenance.trust === 'unverified' ? 1 : 0) << 3
    if (envelope.coverage !== undefined) flags |= 1 << 5

    const roleIndex = typeof event.role === 'string' ? MESSAGE_ROLES.indexOf(event.role) : -1
    if (roleIndex >= 0) flags |= (1 << 6) | (roleIndex << 7)

    // parts 通道：单个无 language 的文本部件走热路径（零 JSON），其余整块 JSON。
    let partsText: string | undefined
    if (Array.isArray(event.parts)) {
      const parts = event.parts as { kind?: unknown; text?: unknown; language?: unknown }[]
      const single = parts.length === 1
        && typeof parts[0]?.text === 'string'
        && typeof parts[0]?.kind === 'string'
        && TEXT_PART_KINDS.includes(parts[0].kind)
        && parts[0].language === undefined
      const partsMode = single ? 1 : 2
      const partKind = single ? TEXT_PART_KINDS.indexOf(parts[0].kind as string) : 0
      partsText = single ? (parts[0].text as string) : JSON.stringify(event.parts)
      flags |= (partsMode << 10) | (partKind << 12)
    }

    const extra: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(event)) {
      if (key === 'type' || key === 'role' || key === 'parts' || key === 'reason') continue
      extra[key] = value
    }
    const extraJson = Object.keys(extra).length > 0 ? JSON.stringify(extra) : undefined
    const reason = typeof event.reason === 'string' ? (event.reason as string) : undefined
    // v2 第 18 槽：provenance 可选富字段（origin/trust 走 flags 低 4 位）。
    const provenanceExtras: Record<string, unknown> = {}
    const provenance = envelope.provenance as unknown as Record<string, unknown>
    for (const key of PROVENANCE_EXTRA_KEYS) {
      if (key in provenance) provenanceExtras[key] = provenance[key]
    }
    const provenanceJson = Object.keys(provenanceExtras).length > 0 ? JSON.stringify(provenanceExtras) : undefined

    const identity = envelope.identity
    const pairs: (string | undefined)[] = [
      envelope.eventId,
      envelope.sessionId,
      envelope.recordedAt,
      envelope.occurredAt,
      identity.turnId,
      identity.messageId,
      identity.toolCallId,
      identity.taskId,
      identity.runId,
      identity.interactionId,
      envelope.source.provider,
      envelope.source.sourceId,
      envelope.source.agentId,
      envelope.source.parentAgentId,
      reason,
      partsText,
      extraJson,
      provenanceJson,
    ]
    return { envelope, typeIndex, flags, pairs, slots: undefined as unknown as [number, number][] }
  })

  // 第一遍：把全部字符串写进字串池并记下 (offset,len)；第二遍只写帧。
  for (const item of encoded) {
    item.slots = item.pairs.map(putString)
  }
  const eventSectionBytes = encoded.reduce(
    (total, item) => total + 24 + FRAME_PAIRS * 8 + (item.envelope.coverage !== undefined ? 16 : 0),
    0,
  )
  const frame = new Uint8Array(14 + pool.length + eventSectionBytes)
  const view = new DataView(frame.buffer)
  frame.set([0x50, 0x59, 0x50, 0x42]) // "PYPB"
  view.setUint16(4, 2, true)
  view.setUint32(6, encoded.length, true)
  view.setUint32(10, pool.length, true)
  frame.set(Uint8Array.from(pool), 14)

  let cursor = 14 + pool.length
  for (const item of encoded) {
    view.setFloat64(cursor, item.envelope.sequence, true)
    view.setFloat64(cursor + 8, 0, true)
    view.setUint32(cursor + 16, item.typeIndex, true)
    view.setUint32(cursor + 20, item.flags, true)
    cursor += 24
    for (const [offset, length] of item.slots) {
      view.setUint32(cursor, offset, true)
      view.setUint32(cursor + 4, length, true)
      cursor += 8
    }
    if (item.envelope.coverage !== undefined) {
      view.setFloat64(cursor, item.envelope.coverage[0], true)
      view.setFloat64(cursor + 8, item.envelope.coverage[1], true)
      cursor += 16
    }
  }
  return frame
}

// ── 词表 parity ──────────────────────────────────────────────────────────────

describe('语义事件词表（typeIndex 单源）', () => {
  it('WASM 词表 = TS WORKBENCH_SEMANTIC_EVENT_TYPES + event.unknown + extension.event', () => {
    expect(compute.projectorEventTypes()).toEqual([
      ...WORKBENCH_SEMANTIC_EVENT_TYPES,
      'event.unknown',
      'extension.event',
    ])
  })
})

// ── 内容部件解析/聚合 parity ────────────────────────────────────────────────

describe('parseContentPart parity', () => {
  const corpus: readonly unknown[] = [
    { kind: 'text', text: 'hello' },
    { kind: 'thinking', text: 'private reasoning' },
    { kind: 'markdown', text: '# 标题' },
    { kind: 'image', source: 'https://example.test/image.png', mimeType: 'image/png' },
    { kind: 'image', source: 'iVBORw0KGgo=', sourceKind: 'base64', mimeType: 'image/png', width: 640, height: 480, caption: '架构图' },
    { kind: 'video', source: 'C:\\media\\demo.mp4', sourceKind: 'path', mimeType: 'video/mp4', durationMs: 1_500 },
    { kind: 'image', source: 'https://safe.test/a.png', headers: { authorization: 'Bearer secret' } },
    { kind: 'image', source: 'https://safe.test/a.png', base64: 'duplicate-payload' },
    { kind: 'image', source: 'https://safe.test/a.png', width: -1 },
    { kind: 'image', source: '   ' },
    { kind: 'resource', uri: 'mcp://resource/1', title: 'Resource' },
    { kind: 'resource', uri: '   ' },
    { kind: 'resource', uri: 'file:///private.pdf', blob: 'JVBERi0xLjQK' },
    { kind: 'document', title: 'spec.pdf', uri: 'file:///spec.pdf', mimeType: 'application/pdf', hasBlob: true },
    { kind: 'document', title: 'empty', text: '' },
    { kind: 'diff', path: 'src/app.ts', unified: '@@ -1 +1 @@' },
    { kind: 'diff', lines: [{ kind: 'added', text: 'x' }] },
    { kind: 'location', path: 'src/app.ts', line: 3, column: 4 },
    { kind: 'terminal', command: 'npm test', processId: 'proc-1', sessionId: 'shell-1', streams: [{ stream: 'stdout', text: 'ok', ordinal: 0 }], status: 'completed', exitCode: 0, truncation: { capturedLines: 1, omittedLines: 2, capturedBytes: 2, omittedBytes: 4 } },
    { kind: 'terminal', streams: [{ stream: 'stdin', text: 'secret' }] },
    { kind: 'terminal', streams: [{ stream: 'stdout', text: 'x', ordinal: -1 }] },
    { kind: 'log', source: 'worker', entries: [{ level: 'warn', text: 'slow', ordinal: 2, timestampConfidence: 'synthetic' }] },
    { kind: 'log', entries: [] },
    { kind: 'log', entries: [{ level: 'verbose', text: 'x' }] },
    { kind: 'tool-result', status: 'completed', parts: [] },
    { kind: 'tool-result', parts: [{ kind: 'text', text: 'ok' }, { kind: 'image', source: 42 }] },
    { kind: 'memory', memoryId: 'mem-1', source: 'hermes', scope: 'session', title: 'User prefers dark mode', summary: 'stored preference', status: 'recalled', version: 3 },
    { kind: 'memory', title: 'missing identity', source: 'hermes' },
    { kind: 'memory', memoryId: 'm', title: 'M', source: 'hermes', artifactId: 'cross-family' },
    { kind: 'skill', skillId: 's', title: 'Skill', source: 'peri', enabled: 'yes' },
    { kind: 'mcp-resource', server: 'fs-mcp', resourceUri: 'file:///docs/spec.md', mimeType: 'text/markdown', connectionState: 'connected' },
    { kind: 'mcp-resource', server: 'mcp', resourceUri: '' },
    { kind: 'artifact', artifactId: 'art-1', title: 'report.pdf', uri: 'https://example.com/report.pdf', version: 2, hasBlob: true },
    { kind: 'artifact', artifactId: 'a', title: 'A', uri: 'artifact://a', parts: [{ kind: 'text' }] },
    { kind: 'plugin.card', text: 'namespaced extension kind' },
    { kind: 'search-result', query: 'q', results: [{ source: 'local', rank: 1, title: 'T', snippet: 'abc', highlights: [{ start: 0, end: 2 }] }] },
    { kind: 'link', url: 'https://example.test', status: 200 },
    { kind: 'diagnostic-lsp', message: 'missing import', path: 'src/app.ts', severity: 'error' },
    { kind: 'unknown', originalType: 'future.block', summary: 'Unknown content type future.block (2 bytes)', raw: { a: 1 }, truncated: false },
    { kind: 'text' },
    'not-an-object',
    42,
  ]

  it('同一语料上逐条与 TS parseContentPart 同判同值', () => {
    for (const value of corpus) {
      const ts = parseContentPart(value)
      const rust = fromBoundary<{ ok: boolean; value?: unknown; issues?: unknown[] }>(
        compute.projectorParseContentPart(JSON.stringify(value)),
      )
      expect(rust, JSON.stringify(value).slice(0, 80)).toEqual(
        ts.ok ? { ok: true, value: ts.value } : { ok: false, issues: ts.issues },
      )
    }
  })
})

describe('createUnknownContentPart parity', () => {
  it('小载荷：raw/redactions/summary 逐字段一致', () => {
    const cases: [string, unknown][] = [
      ['provider.unknown', { nested: [1, true, null] }],
      ['mystery-attachment', { blob: 'x' }],
      ['memory', { apiToken: 'must-not-survive', vendorFuture: 9 }],
      ['', 'plain string raw'],
    ]
    for (const [originalType, raw] of cases) {
      const ts = createUnknownContentPart(originalType, raw)
      const rust = fromBoundary(compute.projectorCreateUnknownContentPart(originalType, JSON.stringify(raw)))
      expect(rust, originalType).toEqual(ts)
      expect(JSON.stringify(rust)).not.toContain('must-not-survive')
    }
  })

  it('截断路径：元数据一致；预览内容不比（键序缺口，长度一致）', () => {
    const raw = { providerType: 'future.block', payload: 'x'.repeat(20_000) }
    const ts = createUnknownContentPart('future.block', raw, { maxRawBytes: 256 })
    const rust = fromBoundary<{
      kind: string
      summary: string
      truncated: boolean
      truncation: { truncated: boolean; originalBytes: number; retainedBytes: number; omittedBytes: number; reason: string }
      raw: { preview: string; truncated: boolean }
    }>(compute.projectorCreateUnknownContentPart('future.block', JSON.stringify(raw), 256)) as {
      kind: string
      summary: string
      truncated: boolean
      truncation: { truncated: boolean; originalBytes: number; retainedBytes: number; omittedBytes: number; reason: string }
      raw: { preview: string; truncated: boolean }
    }
    expect(rust.kind).toBe(ts.kind)
    expect(rust.summary).toBe(ts.summary)
    expect(rust.truncated).toBe(ts.truncated)
    expect(rust.truncation).toEqual(ts.truncation)
    expect(rust.raw.truncated).toBe(true)
    expect(rust.raw.preview.length).toBe((ts.raw as { preview: string }).preview.length)
  })
})

describe('相邻聚合 parity', () => {
  const displayCorpus: readonly ContentPart[][] = [
    [
      { kind: 'text', text: '连续' },
      { kind: 'markdown', text: '正文' },
      { kind: 'code', text: 'const answer = 42', language: 'ts' },
      { kind: 'markdown', text: '尾部' },
      { kind: 'text', text: '正文' },
    ],
    [{ kind: 'text', text: 'single' }],
    [
      { kind: 'code', text: 'a', language: 'ts' },
      { kind: 'code', text: 'b', language: 'ts' },
    ],
  ]
  const reasoningCorpus: readonly ContentPart[][] = [
    [
      { kind: 'text', text: '先' },
      { kind: 'reasoning', text: '思考' },
      { kind: 'thinking', text: '再' },
      { kind: 'code', text: 'const answer = 42', language: 'ts' },
      { kind: 'markdown', text: '后' },
      { kind: 'text', text: '续' },
    ],
    [{ kind: 'reasoning', text: 'only' }],
  ]

  it('display-text 聚合与 TS 同判', () => {
    for (const parts of displayCorpus) {
      const ts = coalesceAdjacentDisplayTextParts(parts)
      const rust = fromBoundary<{ changed: boolean; parts: unknown[] }>(
        compute.projectorCoalesceDisplayTextParts(JSON.stringify(parts)),
      )
      expect(rust.parts).toEqual([...ts])
    }
  })

  it('reasoning 文本族聚合与 TS 同判', () => {
    for (const parts of reasoningCorpus) {
      const ts = coalesceAdjacentReasoningParts(parts)
      const rust = fromBoundary<{ changed: boolean; parts: unknown[] }>(
        compute.projectorCoalesceReasoningParts(JSON.stringify(parts)),
      )
      expect(rust.parts).toEqual([...ts])
    }
  })
})

// ── span 占用 parity ────────────────────────────────────────────────────────

describe('mergeCoverage parity', () => {
  it('与 TS mergeCoverage 家族同判（升序合并、相邻吸收、间隔保留）', () => {
    const cases: readonly { ranges: [number, number][]; start: number; end: number }[] = [
      { ranges: [], start: 1, end: 6 },
      { ranges: [[1, 3], [10, 12]], start: 5, end: 9 },
      { ranges: [[1, 3], [10, 12]], start: 5, end: 8 },
      { ranges: [[4, 6]], start: 1, end: 3 },
      { ranges: [[1, 3], [5, 9]], start: 8, end: 20 },
      { ranges: [[1, 1]], start: 1, end: 1 },
    ]
    for (const { ranges, start, end } of cases) {
      const rust = fromBoundary<[number, number][]>(
        compute.projectorMergeCoverage(JSON.stringify(ranges), start, end),
      )
      expect(rust, JSON.stringify({ ranges, start, end })).toEqual([
        ...mergeCoverageReference(ranges, start, end),
      ])
    }
  })

  // TS 基线的私有实现按原样内联（workbenchProjector.ts 的 mergeCoverage）。
  function mergeCoverageReference(
    ranges: readonly (readonly [number, number])[],
    start: number,
    end: number,
  ): [number, number][] {
    const merged: [number, number][] = []
    let low = start
    let high = end
    let placed = false
    for (const [from, to] of ranges) {
      if (to < low - 1) {
        merged.push([from, to])
        continue
      }
      if (from > high + 1) {
        if (!placed) {
          merged.push([low, high])
          placed = true
        }
        merged.push([from, to])
        continue
      }
      low = Math.min(low, from)
      high = Math.max(high, to)
    }
    if (!placed) merged.push([low, high])
    return merged
  }
})

// ── 折叠主干 parity ─────────────────────────────────────────────────────────

const SESSION_ID = 'session-parity'
const RECORDED_AT = '2026-08-21T00:00:00.000Z'

function envelope(
  sequence: number,
  event: WorkbenchSemanticEvent,
  identity: WorkbenchEventEnvelope['identity'] = {},
  provenance: WorkbenchEventEnvelope['provenance'] = { origin: 'local-observed', trust: 'authoritative' },
  coverage?: readonly [number, number],
): WorkbenchEventEnvelope {
  return createWorkbenchEnvelope({
    sessionId: SESSION_ID,
    sequence,
    recordedAt: RECORDED_AT,
    source: { provider: 'peri', sourceId: `wire-${sequence}` },
    identity,
    provenance,
    ...(coverage ? { coverage } : {}),
    event,
  })
}

function projectBoth(envelopes: readonly WorkbenchEventEnvelope[]): unknown {
  const projector = new compute.PylonProjector(SESSION_ID)
  const patch = fromBoundary<ProjectorPatch>(projector.appendBatch(encodeFrame(envelopes)))
  expect(patch.appliedEventIdsAppended.length).toBeGreaterThan(0)
  return fromBoundary(projector.document())
}

describe('折叠主干 parity（appendBatch → document）', () => {
  it('message/reasoning/tool/interaction/diagnostic/session 混合流与 TS projectWorkbench 逐字段一致', () => {
    const envelopes = [
      envelope(1, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'question' }] }),
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'answer ' }] }, { messageId: 'm-1' }),
      envelope(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'continues' }] }, { messageId: 'm-2' }),
      envelope(4, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'thinking' }] }, { messageId: 'r-1' }),
      envelope(5, { type: 'tool.started', tool: { toolCallId: 'tool-1', name: 'read', semanticKind: 'tool.read', parentActivityId: 'parent-1' } }, { toolCallId: 'tool-1' }),
      envelope(6, { type: 'reasoning.delta', parts: [{ kind: 'text', text: 'more' }] }),
      envelope(7, { type: 'tool.progress', tool: { toolCallId: 'tool-1', status: 'running', progress: { step: 2 } } }, { toolCallId: 'tool-1' }),
      envelope(8, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'after tool' }] }, { messageId: 'm-2' }),
      envelope(9, { type: 'tool.completed', tool: { toolCallId: 'tool-1', status: 'completed', durationMs: 120 } }, { toolCallId: 'tool-1' }),
      envelope(10, { type: 'interaction.requested', interactionId: 'ask-1', request: { question: 'continue?', password: 'hunter2' } }, { interactionId: 'ask-1' }),
      envelope(11, { type: 'diagnostic.notice', level: 'info', message: 'notice' }),
      envelope(12, { type: 'session.status-updated', status: 'running' }),
      envelope(13, { type: 'interaction.resolved', interactionId: 'ask-1', response: { answer: 'yes' } }, { interactionId: 'ask-1' }),
      envelope(14, { type: 'reasoning.redacted', parts: [{ kind: 'text', text: 'thinkingmore' }], reason: 'provider redaction' }, { messageId: 'r-1' }),
      envelope(15, { type: 'message.completed', role: 'assistant', parts: [] }, { messageId: 'm-2' }),
      envelope(16, { type: 'session.completed', stopReason: 'end_turn' }),
      envelope(17, { type: 'event.unknown', originalType: 'future_event', summary: 'future', raw: { value: 1 }, truncated: false }),
      envelope(18, { type: 'diagnostic.notice', level: 'error', message: 'failed', code: 'turn.failed' }),
      envelope(19, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'one prompt' }] }, { interactionId: 'client-1' }, { origin: 'optimistic-local', trust: 'unverified' }),
      envelope(20, { type: 'message.delta', role: 'user', parts: [{ kind: 'text', text: 'one prompt' }] }),
    ]
    expect(projectBoth(envelopes)).toEqual(
      projectWorkbench(envelopes, { initialDocument: createWorkbenchDocument(SESSION_ID) }).document,
    )
  })

  it('分页合批与整页投影在两侧都收敛到同一文档（重放 == 增量）', () => {
    const page1 = [
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '你好' }] }, { messageId: 'm-1' }),
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: '世界' }] }, { messageId: 'm-1' }),
    ]
    const page2 = [
      envelope(3, { type: 'tool.started', tool: { toolCallId: 'tool-9', name: 'grep' } }, { toolCallId: 'tool-9' }),
      envelope(4, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'done' }] }),
      envelope(5, { type: 'session.completed', stopReason: 'end_turn' }),
    ]
    const whole = [...page1, ...page2]

    const tsWhole = projectWorkbench(whole, { initialDocument: createWorkbenchDocument(SESSION_ID) }).document
    const tsSplit = projectWorkbench(page2, {
      initialDocument: projectWorkbench(page1, { initialDocument: createWorkbenchDocument(SESSION_ID) }).document,
    }).document
    expect(tsSplit).toEqual(tsWhole)

    const projectorWhole = new compute.PylonProjector(SESSION_ID)
    projectorWhole.appendBatch(encodeFrame(whole))
    const projectorSplit = new compute.PylonProjector(SESSION_ID)
    const patch1 = fromBoundary<ProjectorPatch>(projectorSplit.appendBatch(encodeFrame(page1)))
    expect(patch1.messageUpserts).toHaveLength(1)
    expect(patch1.appliedEventIdsAppended).toHaveLength(2)
    projectorSplit.appendBatch(encodeFrame(page2))
    expect(fromBoundary(projectorSplit.document())).toEqual(tsWhole)
    expect(fromBoundary(projectorWhole.document())).toEqual(tsWhole)
  })

  it('coverage 信封：区间幂等 + 升序合并，与 TS appliedRanges 契约一致', () => {
    const envelopes = [
      envelope(4, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 't4' }] }, { messageId: 'msg' }, { origin: 'local-observed', trust: 'authoritative' }, [4, 6]),
      envelope(3, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 't1' }] }, { messageId: 'msg' }, { origin: 'local-observed', trust: 'authoritative' }, [1, 3]),
      envelope(8, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 't8' }] }, { messageId: 'msg' }, { origin: 'local-observed', trust: 'authoritative' }, [8, 8]),
      envelope(7, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 't7' }] }, { messageId: 'msg' }, { origin: 'local-observed', trust: 'authoritative' }, [7, 9]),
      // 整段 [1,9] 已覆盖 → 幂等跳过（不重复拼接）。
      envelope(9, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 't1t4t8t7t1t3' }] }, { messageId: 'msg' }, { origin: 'local-observed', trust: 'authoritative' }, [1, 9]),
    ]
    const ts = projectWorkbench(envelopes, { initialDocument: createWorkbenchDocument(SESSION_ID) }).document
    const projector = new compute.PylonProjector(SESSION_ID)
    projector.appendBatch(encodeFrame(envelopes))
    const rust = fromBoundary<{ appliedRanges: [number, number][]; messages: { content: string }[] }>(
      projector.document(),
    )
    expect(rust.appliedRanges).toEqual([...ts.appliedRanges])
    expect(rust.appliedRanges).toEqual([[1, 9]])
    expect(rust.messages).toEqual(ts.messages)
  })

  it('recovery-import 历史按已沉淀投影（running=false），与 TS #200 语义一致', () => {
    const envelopes = [
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'same' }] }, {}, { origin: 'recovery-import', trust: 'unverified', provider: 'peri', importId: 'import-1' }),
    ]
    const ts = projectWorkbench(envelopes, { initialDocument: createWorkbenchDocument(SESSION_ID) }).document
    const projector = new compute.PylonProjector(SESSION_ID)
    projector.appendBatch(encodeFrame(envelopes))
    const rust = fromBoundary<{ messages: { running: boolean }[] }>(projector.document())
    expect(rust).toEqual(ts)
    expect(rust.messages[0].running).toBe(false)
  })

  it('乱序输入：两侧同一 sequence 排序语义（字节序 tie-break）', () => {
    const envelopes = [
      envelope(2, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'b' }] }),
      envelope(1, { type: 'message.delta', role: 'assistant', parts: [{ kind: 'text', text: 'a' }] }),
    ]
    expect(projectBoth(envelopes)).toEqual(
      projectWorkbench(envelopes, { initialDocument: createWorkbenchDocument(SESSION_ID) }).document,
    )
  })

  it('usage/plan/goal（原 fail-closed 事件）两侧逐字段一致', () => {
    // WP2 补全前的行为是整页拒绝（/未迁移/）；现在这些事件与 TS 基线同判。
    const envelopes = [
      envelope(1, { type: 'usage.updated', usage: { inputTokens: 12, outputTokens: 8, contextUsed: 25, contextLimit: 100, calls: -1, futureCounter: 7 } }),
      envelope(2, { type: 'budget.warning', used: 900, limit: 1000, threshold: 'warning', percent: 90 }),
      envelope(3, { type: 'plan.replaced', entries: [
        { id: 'a', content: '第一步', status: 'completed' },
        { id: 'b', content: '第二步', status: 'in_progress', activeForm: '正在第二步' },
      ] }),
      envelope(4, { type: 'plan.entry-updated', entry: { id: 'b', content: '第二步', status: 'blocked', blockedReason: '等待审批' } }),
      envelope(5, { type: 'goal.updated', goal: { goalId: 'g-1', objective: '完成渲染引擎', status: 'active', tokenBudget: 5000, tokensUsed: 120 } }),
      envelope(6, { type: 'goal.cleared', goalId: 'g-1' }),
    ]
    expect(projectBoth(envelopes)).toEqual(
      projectWorkbench(envelopes, { initialDocument: createWorkbenchDocument(SESSION_ID) }).document,
    )
  })

  it('session commands/options/usage 字段与 TS sessionSurface 归一化一致', () => {
    const envelopes = [
      envelope(1, {
        type: 'session.commands-updated',
        commands: [{ id: 'compact', name: '/compact', description: '压缩上下文', inputHint: '[focus]', availability: true, capability: 'compact', future: 'kept' }],
      }),
      envelope(2, {
        type: 'session.config-updated',
        options: [{ id: 'temperature', label: 'Temperature', value: { providerScale: 'adaptive' }, valueType: 'provider.custom', editable: true, schema: { type: 'object' }, version: 3, future: 'kept' }],
      }),
      // 空列表不宣告 → 不清空既有候选面。
      envelope(3, { type: 'session.config-updated', options: [] }),
      envelope(4, { type: 'session.status-updated', status: 'running', usage: { contextUsed: 25, contextLimit: 100, currency: 'USD', futureCounter: 9, calls: -1 } }),
      envelope(5, { type: 'session.completed', stopReason: 'end_turn', usage: { contextUsed: 60 } }),
    ]
    expect(projectBoth(envelopes)).toEqual(
      projectWorkbench(envelopes, { initialDocument: createWorkbenchDocument(SESSION_ID) }).document,
    )
  })

  it('lifecycle/assist 事件与 TS 状态机一致', () => {
    const envelopes = [
      envelope(1, { type: 'lifecycle.retrying', attempt: 1, maxAttempts: 3, delayMs: 1000, error: { technicalMessage: 'boom', recoverability: 'retry', retryAfterMs: 2000, classification: 'network' } }),
      envelope(2, { type: 'lifecycle.compact-started', strategy: 'rolling', tokensBefore: 1000 }),
      envelope(3, { type: 'lifecycle.compact-completed', tokensBefore: 1000, tokensAfter: 300 }),
      envelope(4, { type: 'lifecycle.rewind-preview', files: [{ path: 'a.ts' }], summary: '三处改动' }),
      envelope(5, { type: 'lifecycle.rewind-completed' }),
      envelope(6, { type: 'lifecycle.suspended', reason: '等待输入' }),
      envelope(7, { type: 'lifecycle.recovered', source: 'agent-import', importedEvents: 42 }),
      envelope(8, { type: 'assist.prediction', placeholder: '继续修复', actions: [{ id: 'accept', label: '接受' }] }),
      envelope(9, { type: 'assist.prediction', actions: [] }),
      envelope(10, { type: 'assist.file-suggestions', files: ['src/a.ts', 'src/b.ts'] }),
      envelope(11, { type: 'assist.queued-command', command: '/compact' }),
      envelope(12, { type: 'assist.queued-command', command: '' }),
    ]
    expect(projectBoth(envelopes)).toEqual(
      projectWorkbench(envelopes, { initialDocument: createWorkbenchDocument(SESSION_ID) }).document,
    )
  })

  it('activity C09/C10 家族（rich 字段/终态幂等/畸形 parts/合成 provenance）与 TS 一致', () => {
    const envelopes = [
      envelope(1, {
        type: 'activity.started', activityId: 'sub-1',
        activity: {
          kind: 'subagent', semanticKind: 'activity.subagent', title: 'Explore repo',
          parentId: 'tool-1', depth: 2, role: 'explorer', model: 'ox-alpha-free', provider: 'opencode-go',
          goal: 'find all call sites', capabilities: ['fs', 'search'],
        },
      }, { taskId: 'sub-1' }),
      envelope(2, {
        type: 'activity.progress', activityId: 'sub-1',
        patch: { progress: { completed: 3, total: 5 }, usage: { inputTokens: 1200, outputTokens: 340 }, files: ['src/a.ts'] },
      }, { taskId: 'sub-1' }),
      envelope(3, {
        type: 'activity.progress', activityId: 'sub-1',
        patch: { metrics: { toolCount: 4, durationMs: 900 }, execution: { mode: 'remote', background: true }, tools: [{ id: 'tool-4' }], tasks: [{ id: 'task-2' }] },
      }, { taskId: 'sub-1' }),
      envelope(4, {
        type: 'activity.completed', activityId: 'sub-1',
        result: { completedAt: '2026-08-23T06:00:03.000Z', output: [{ kind: 'text', text: 'done' }] },
      }, { taskId: 'sub-1' }),
      // 终态后迟到 progress：只补缺不回退。
      envelope(5, { type: 'activity.progress', activityId: 'sub-1', patch: { progress: { completed: 9, total: 5 } } }, { taskId: 'sub-1' }),
      // 畸形 parts → bounded unknown + warning 诊断。
      envelope(6, {
        type: 'activity.completed', activityId: 'sub-malformed',
        activity: { kind: 'subagent' },
        result: { parts: [{ kind: 'terminal', streams: [{ stream: 'stdout', text: 'kept' }], exitCode: 0 }, { kind: 'terminal', streams: [{ stream: 'stdin', text: 'unsafe' }] }] },
      }, { taskId: 'sub-2' }),
      // 孤儿 → 父节点后到解除。
      envelope(7, { type: 'activity.started', activityId: 'sub-orphan', activity: { kind: 'delegation', parentId: 'team-9', title: 'delegate' } }, { taskId: 'sub-3' }),
      envelope(8, { type: 'activity.started', activityId: 'team-9', activity: { kind: 'team', title: 'Ops' } }),
      // 词表外 status 降级 unknown。
      envelope(9, { type: 'activity.progress', activityId: 'sub-teleport', patch: { kind: 'subagent', status: 'teleporting' } }),
      // C10：killed/timeout 终止证据 + 合成 provenance。
      envelope(10, { type: 'activity.started', activityId: 'bg-1', activity: { kind: 'background-task', title: 'nightly index' } }),
      envelope(11, {
        type: 'activity.failed', activityId: 'bg-1', reason: 'connection lost',
      }, {}, { origin: 'plugin', trust: 'unverified', orderConfidence: 'observed', synthetic: { reason: 'terminal response observed' } }),
    ]
    expect(projectBoth(envelopes)).toEqual(
      projectWorkbench(envelopes, { initialDocument: createWorkbenchDocument(SESSION_ID) }).document,
    )
  })

  it('extension.event 与 TS durable slice 一致（payload/fallback/source/provenance 全携带）', () => {
    const envelopes = [
      envelope(1, {
        type: 'extension.event', kind: 'plugin.demo/result',
        payload: { status: 'completed', summary: 'done' },
        fallback: [{ kind: 'unknown', originalType: 'plugin.demo/result', summary: 'unknown plugin event', raw: { status: 'completed' }, truncated: false }],
      }),
      envelope(2, { type: 'extension.event', kind: 'a.b', payload: [1, 2, 3], fallback: [] }),
    ]
    expect(projectBoth(envelopes)).toEqual(
      projectWorkbench(envelopes, { initialDocument: createWorkbenchDocument(SESSION_ID) }).document,
    )
  })
})
