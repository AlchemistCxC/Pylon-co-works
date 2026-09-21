// projector 域套件：折叠端到端 + part 级原语 + coverage 合并 + 词表。
// TS 侧 = 冻结基线（baselines/oldWorkbenchProjector.ts / oldCoverageMerge.ts）
// 与树上活实现（contentPartSchema.ts，投影原语的 TS 版未退役）。

import type { Suite } from '../harness.ts'
import type { ComputeContextLike } from '../index.ts'
import {
  coalesceAdjacentDisplayTextParts,
  coalesceAdjacentReasoningParts,
  createUnknownContentPart,
  parseContentPart,
} from '../../../src/domains/workbench/content/contentPartSchema.ts'
import type { WorkbenchEventEnvelope } from '../../../src/domains/workbench/events/workbenchEventSchema.ts'
import type { WorkbenchDocument } from '../../../src/domains/workbench/workbenchProjector.ts'
import { WORKBENCH_SEMANTIC_EVENT_TYPES } from '../../../src/domains/workbench/events/workbenchEventSchema.ts'
import { projectWorkbench as projectWasmCurrent } from '../../../src/domains/workbench/workbenchProjector.ts'
import { projectWorkbench as projectTsLegacy } from '../baselines/oldWorkbenchProjector.ts'
import { mergeCoverage as mergeCoverageTs } from '../baselines/oldCoverageMerge.ts'
import { coveragePage, deltaJournal, mixedJournal } from '../fixtures/envelopes.ts'

/** 投影词表（与 projectorComputeParity 同口径：语义词表 + 两个合成类型）。 */
const PROJECTOR_EVENT_TYPES = [...WORKBENCH_SEMANTIC_EVENT_TYPES, 'event.unknown', 'extension.event']

export function buildProjectorSuite(ctx: ComputeContextLike): Suite {
  const wasm = ctx.compute
  return {
    domain: 'projector',
    pairs: [
      {
        name: 'projectWorkbench(fold)',
        domain: 'projector',
        ts: events => projectTsLegacy(events).document,
        wasm: events => projectWasmCurrent(events).document,
        cases: [
          { id: 'delta-xs', meta: { scale: 'xs', flow: 'cold' }, build: () => deltaJournal(1) },
          { id: 'delta-s', meta: { scale: 's', flow: 'cold' }, build: () => deltaJournal(100) },
          { id: 'delta-m', meta: { scale: 'm', flow: 'cold' }, build: () => deltaJournal(2000) },
          { id: 'delta-l', meta: { scale: 'l', flow: 'cold' }, build: () => deltaJournal(20_000) },
          { id: 'mixed-xs', meta: { scale: 'xs', shape: 'mixed-flow', flow: 'cold' }, build: () => mixedJournal(1) },
          { id: 'mixed-s', meta: { scale: 's', shape: 'mixed-flow', flow: 'cold' }, build: () => mixedJournal(10) },
          { id: 'mixed-m', meta: { scale: 'm', shape: 'mixed-flow', flow: 'cold' }, build: () => mixedJournal(200) },
          { id: 'coverage-disorder', meta: { scale: 'xs', shape: 'coverage', flow: 'cold' }, build: () => coveragePage() },
        ],
      },
      {
        name: 'projectorEventTypes',
        domain: 'projector',
        ts: () => PROJECTOR_EVENT_TYPES,
        wasm: () => wasm.projectorEventTypes(),
        cases: [{ id: 'wordlist-order', meta: { shape: 'wordlist' }, build: () => undefined }],
      },
      {
        name: 'projectorParseContentPart',
        domain: 'projector',
        ts: values => values.map((value) => {
          const result = parseContentPart(value)
          return result.ok ? { ok: true, value: result.value } : { ok: false, issues: result.issues }
        }),
        wasm: values => values.map(value => JSON.parse(wasm.projectorParseContentPart(JSON.stringify(value)))),
        cases: [
          {
            id: 'part-corpus',
            meta: { shape: 'parts', edge: true },
            build: () => [
              { kind: 'text', text: 'plain' },
              { kind: 'thinking', text: '思考' },
              { kind: 'markdown', text: '# 标题\n正文' },
              { kind: 'code', text: 'const x = 1', language: 'ts' },
              { kind: 'ansi', text: '\u001b[31m红\u001b[0m' },
              { kind: 'mystery-kind', text: 'unknown kind' },
              { kind: 'text' },
              'not-an-object',
              42,
              null,
              { kind: 'text', text: 123 },
              { type: 'text', text: 'wrong-discriminant' },
            ],
          },
        ],
      },
      {
        name: 'projectorCreateUnknownContentPart',
        domain: 'projector',
        ts: cases => cases.map(([originalType, raw]) => createUnknownContentPart(originalType, raw)),
        wasm: cases => cases.map(([originalType, raw]) =>
          JSON.parse(wasm.projectorCreateUnknownContentPart(originalType, JSON.stringify(raw)))),
        cases: [
          {
            id: 'small-payloads',
            meta: { shape: 'unknown-part', edge: true },
            build: () => [
              ['provider.unknown', { nested: [1, true, null] }],
              ['mystery-attachment', { blob: 'x' }],
              ['memory', { apiToken: 'must-not-survive', vendorFuture: 9 }],
              ['', 'plain string raw'],
            ] as ReadonlyArray<readonly [string, unknown]>,
          },
        ],
      },
      {
        name: 'projectorCreateUnknownContentPart(truncation)',
        domain: 'projector',
        // 截断路径的 raw.preview 内容存在已过审的键序/内容缺口（与
        // projectorComputeParity 同口径）：只比元数据与长度。
        ts: ([originalType, raw, maxRawBytes]) => {
          const part = createUnknownContentPart(originalType, raw, { maxRawBytes: maxRawBytes ?? undefined }) as Record<string, unknown>
          return {
            kind: part.kind,
            summary: part.summary,
            truncated: part.truncated,
            truncation: part.truncation,
            rawTruncated: (part.raw as { truncated?: boolean }).truncated,
            previewLength: (part.raw as { preview?: string }).preview?.length,
          }
        },
        wasm: ([originalType, raw, maxRawBytes]) => {
          const part = JSON.parse(wasm.projectorCreateUnknownContentPart(originalType, JSON.stringify(raw), maxRawBytes)) as Record<string, unknown>
          return {
            kind: part.kind,
            summary: part.summary,
            truncated: part.truncated,
            truncation: part.truncation,
            rawTruncated: (part.raw as { truncated?: boolean }).truncated,
            previewLength: (part.raw as { preview?: string }).preview?.length,
          }
        },
        cases: [
          {
            id: 'truncation-metadata',
            meta: { shape: 'unknown-part', edge: true },
            build: () => ['future.block', { providerType: 'future.block', payload: 'x'.repeat(20_000) }, 256] as const,
          },
        ],
      },
      {
        name: 'projectorCoalesceDisplayTextParts',
        domain: 'projector',
        ts: partLists => partLists.map(parts => coalesceAdjacentDisplayTextParts(parts)),
        // wasm 出口包一层 {changed, parts}；changed 是调用方优化提示，不在纯函数
        // 输出契约内，归一只取 parts。
        wasm: partLists => partLists.map(parts => JSON.parse(wasm.projectorCoalesceDisplayTextParts(JSON.stringify(parts))).parts),
        cases: [
          {
            id: 'adjacency-shapes',
            meta: { shape: 'parts', edge: true },
            build: () => [
              [],
              [{ kind: 'text', text: 'a' }, { kind: 'text', text: 'b' }],
              [{ kind: 'text', text: 'a' }, { kind: 'thinking', text: 't' }, { kind: 'text', text: 'b' }],
              [{ kind: 'markdown', text: '# x' }, { kind: 'markdown', text: '## y' }],
              [{ kind: 'code', text: 'a', language: 'ts' }, { kind: 'code', text: 'b', language: 'ts' }],
              [{ kind: 'text', text: '' }, { kind: 'text', text: 'nonempty' }],
            ],
          },
        ],
      },
      {
        name: 'projectorCoalesceReasoningParts',
        domain: 'projector',
        ts: partLists => partLists.map(parts => coalesceAdjacentReasoningParts(parts)),
        wasm: partLists => partLists.map(parts => JSON.parse(wasm.projectorCoalesceReasoningParts(JSON.stringify(parts))).parts),
        cases: [
          {
            id: 'adjacency-shapes',
            meta: { shape: 'parts', edge: true },
            build: () => [
              [],
              [{ kind: 'thinking', text: 'a' }, { kind: 'reasoning', text: 'b' }],
              [{ kind: 'thinking', text: 'a' }, { kind: 'text', text: 't' }, { kind: 'thinking', text: 'c' }],
            ],
          },
        ],
      },
      {
        name: 'projectorMergeCoverage',
        domain: 'projector',
        ts: cases => cases.map(([ranges, start, end]) => mergeCoverageTs(ranges, start, end)),
        wasm: cases => cases.map(([ranges, start, end]) =>
          JSON.parse(wasm.projectorMergeCoverage(JSON.stringify(ranges), start, end))),
        cases: [
          {
            id: 'range-shapes',
            meta: { shape: 'ranges', edge: true },
            build: () => [
              [[], 1, 3],
              [[[1, 3]], 4, 6],
              [[[1, 3]], 2, 5],
              [[[1, 3], [7, 9]], 4, 6],
              [[[1, 3], [7, 9]], 5, 5],
              [[[5, 8], [1, 3]], 2, 6],
              [[[1, 1]], 9, 9],
            ] as ReadonlyArray<readonly [readonly (readonly [number, number])[], number, number]>,
          },
          {
            id: 'range-scale',
            meta: { scale: 'm', shape: 'ranges' },
            build: () => {
              const ranges: [number, number][] = []
              for (let index = 0; index < 1000; index += 1) ranges.push([index * 3, index * 3 + 1])
              // 注意只有一层：build 返回的是**案例列表**，每个案例是一个 [ranges, start, end] 三元组。
              // 多包一层会让 `cases.map(([ranges, start, end]) => ...)` 解出的 ranges 变成数字 ⇒
              // oldCoverageMerge 里 `for (const [from, to] of ranges)` 抛 "1 is not iterable"。
              return [[ranges, 1, 1] as readonly [readonly (readonly [number, number])[], number, number]]
            },
          },
        ],
      },
    ],
  }
}

// 两段式 flow（idempotent / paged）以独立 pair 表达：输入是事件页序列，
// TS/wasm 各自按页推进并返回最终文档（stableJson 比对终态）。
export function buildProjectorFlowSuite(): Suite {
  type Page = readonly WorkbenchEventEnvelope[]
  const foldTs = (pages: readonly Page[]): unknown => {
    let document: WorkbenchDocument | undefined
    for (const page of pages) document = projectTsLegacy(page, { initialDocument: document }).document
    return document
  }
  const foldWasm = (pages: readonly Page[]): unknown => {
    let document: WorkbenchDocument | undefined
    for (const page of pages) document = projectWasmCurrent(page, { initialDocument: document }).document
    return document
  }
  return {
    domain: 'projector',
    pairs: [
      {
        name: 'projectWorkbench(paged)',
        domain: 'projector',
        ts: input => foldTs(input.pages),
        wasm: input => foldWasm(input.pages),
        cases: [
          // 真幂等：同一页（同一批 eventId）重折——两侧都必须收敛到同一份文档。
          // 不要用两段序列号重叠的 journal：那不是幂等语义，是非法输入。
          { id: 'idempotent-refold', meta: { scale: 's', flow: 'idempotent' }, build: () => { const page = mixedJournal(2); return { pages: [page, page] } } },
          {
            id: 'paged-replay-s',
            meta: { scale: 's', flow: 'paged' },
            build: () => {
              const events = mixedJournal(6)
              return { pages: [events.slice(0, 30), events.slice(30, 60), events.slice(60)] }
            },
          },
          {
            id: 'paged-replay-m',
            meta: { scale: 'm', flow: 'paged' },
            build: () => {
              const events = mixedJournal(60)
              const pages: Page[] = []
              for (let at = 0; at < events.length; at += 100) pages.push(events.slice(at, at + 100))
              return { pages }
            },
          },
        ],
      },
    ],
  }
}
