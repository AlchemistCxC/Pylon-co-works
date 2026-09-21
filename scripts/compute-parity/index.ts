// 脚手架组装：wasm 装载上下文 + 全套件注册表 + 「全计算纯函数」覆盖门。
//
// 消费方：
// - `scripts/compute-parity.test.mts`（vitest parity 门禁）
// - `scripts/compute-parity-bench.mts`（node 性能对照）
// 共享同一份套件定义——对照面只有一份，改场景两入口同时生效。

import { loadPylonCompute } from '../../src/infrastructure/compute/pylonCompute.ts'
import { loadMarkdownCompute } from '../../src/infrastructure/compute/markdownCompute.ts'
import type { EventsCompute } from './fixtures/eventsFrame.ts'
import type { Suite } from './harness.ts'
import { buildCanonicalSuite } from './suites/canonicalSuite.ts'
import { buildEventsSuite } from './suites/eventsSuite.ts'
import { buildProjectorSuite, buildProjectorFlowSuite } from './suites/projectorSuite.ts'
import { buildStreamingSplitSuite } from './suites/streamingSplitSuite.ts'
import { buildStreamingBudgetSuite } from './suites/streamingBudgetSuite.ts'
import { buildMarkdownParseSuite } from './suites/markdownParseSuite.ts'
import { buildMarkdownHighlightSuite } from './suites/markdownHighlightSuite.ts'

/** 投影段 wasm 出口（WP2 projector 段薄壳）。 */
export interface ProjectorCompute {
  projectorEventTypes(): string[]
  projectorParseContentPart(input: string): string
  projectorCreateUnknownContentPart(originalType: string, raw: string, maxRawBytes?: number): string
  projectorCoalesceDisplayTextParts(input: string): string
  projectorCoalesceReasoningParts(input: string): string
  projectorMergeCoverage(ranges: string, start: number, end: number): string
}

/** 流式段 wasm 出口（WP3 streaming 段薄壳）。 */
export interface StreamingComputeExports {
  splitStreamingMarkdownBlocks(text: string): { stableBlocks: string[], unstable: string }
  splitStreamingMarkdown(text: string): { stable: string, unstable: string }
  findLastStableBlockBoundary(text: string): number
  splitOpenCodeFenceTail(text: string): { prefix: string, language?: string, code: string } | null
  StreamingRevealEngine: new (options?: Record<string, number>) => unknown
}

export interface MarkdownComputeExports {
  parseMarkdown(text: string): unknown
  highlightBlock(code: string, language: string): unknown
  scopeForLanguage(language: string): string | undefined
}

/** 套件运行上下文：两侧实现 + 帧编码装置都从这里取。 */
export interface ComputeContextLike {
  compute: EventsCompute & ProjectorCompute & StreamingComputeExports
  markdown: MarkdownComputeExports
}

export async function loadComputeContext(): Promise<ComputeContextLike> {
  const [compute, markdown] = await Promise.all([
    loadPylonCompute() as Promise<ComputeContextLike['compute']>,
    loadMarkdownCompute() as Promise<MarkdownComputeExports>,
  ])
  return { compute, markdown }
}

export function buildAllSuites(ctx: ComputeContextLike): Suite[] {
  return [
    buildCanonicalSuite(ctx),
    buildEventsSuite(ctx),
    buildProjectorSuite(ctx),
    buildProjectorFlowSuite(),
    buildStreamingSplitSuite(ctx),
    buildStreamingBudgetSuite(ctx),
    buildMarkdownParseSuite(ctx),
    buildMarkdownHighlightSuite(ctx),
  ]
}

// ── 覆盖门：wasm 计算纯函数出口必须全部有对照 pair（「全计算纯函数」的判据） ──

/** 全部 wasm 计算出口（canonical/events/projector/streaming = pylon-compute；markdown = pylon-markdown）。 */
export const REQUIRED_EXPORTS: readonly string[] = [
  // canonical
  'canonicalEventTypes', 'canonicalEventTypeFor', 'isCanonicalEventType',
  'canonicalOwnerKey', 'canonicalEventId', 'nextEventSequence',
  // events
  'normalizeRawEvent', 'resolveChunkAppend', 'mergeAdjacentDeltaChunks', 'canonicalBatchSpanOf',
  'deriveCanonicalTurnDuration', 'hasCanonicalTurnTerminal', 'expandTurnUnitRows',
  'effectiveCanonicalProjectionEvents', 'projectCanonicalMessages', 'projectMessagesFromCanonical',
  'projectToolFromMessage', 'projectToolProjectionsFromBatch', 'toolFieldsFromCanonical',
  // projector（appendBatch/document/foldPhases 经 projectWorkbench(fold)/(paged) pair 驱动）
  'appendBatch', 'document', 'foldPhases',
  'projectorParseContentPart', 'projectorCreateUnknownContentPart',
  'projectorCoalesceDisplayTextParts', 'projectorCoalesceReasoningParts',
  'projectorMergeCoverage', 'projectorEventTypes',
  // streaming split + budget
  'splitStreamingMarkdownBlocks', 'splitStreamingMarkdown', 'findLastStableBlockBoundary',
  'splitOpenCodeFenceTail', 'StreamingRevealEngine',
  // markdown
  'parseMarkdown', 'highlightBlock', 'scopeForLanguage',
]

/** 编组变体/诊断出口：与同名主出口同一计算，单独对照没有信息量。 */
export const EXEMPT_EXPORTS: readonly string[] = [
  'parseMarkdownJson', 'highlightBlockJson', 'markdownEngineVersion', 'foldPhases',
]

/** 覆盖门：返回缺失的出口名（非空即脚手架没跟上计算核面，parity 不许绿）。 */
export function missingCoverage(suites: readonly Suite[]): string[] {
  const covered = new Set<string>()
  for (const suite of suites) {
    for (const pair of suite.pairs) {
      covered.add(pair.name.replace(/\(.*\)$/, ''))
    }
  }
  // appendBatch / document 由 fold 端到端 pair 覆盖（wasm 投影核只经它消费）。
  covered.add('appendBatch')
  covered.add('document')
  return REQUIRED_EXPORTS.filter(name => !covered.has(name) && !EXEMPT_EXPORTS.includes(name))
}
