// 脚手架组装：wasm 装载上下文 + 全套件注册表 + 「全计算纯函数」覆盖门。
//
// 消费方：
// - `scripts/compute-parity.test.mts`（vitest parity 门禁）
// - `scripts/compute-parity-bench.mts`（node 性能对照）
// 共享同一份套件定义——对照面只有一份，改场景两入口同时生效。

import { loadPylonCompute } from '../../src/infrastructure/compute/pylonCompute.ts'
import type { EventsCompute } from './fixtures/eventsFrame.ts'
import type { Suite } from './harness.ts'
import { buildCanonicalSuite } from './suites/canonicalSuite.ts'
import { buildEventsSuite } from './suites/eventsSuite.ts'
import { buildProjectorSuite, buildProjectorFlowSuite } from './suites/projectorSuite.ts'
import { buildStreamingSplitSuite } from './suites/streamingSplitSuite.ts'
import { buildStreamingBudgetSuite } from './suites/streamingBudgetSuite.ts'

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

/** 套件运行上下文：两侧实现 + 帧编码装置都从这里取。 */
export interface ComputeContextLike {
  compute: EventsCompute & ProjectorCompute & StreamingComputeExports
}

/**
 * 只装 `pylon-compute`。**不再装 `pylon-markdown`**：markdown 的 TS 基线已随比较装置下线
 * （2026-09-21 裁决——流式形状实测 12–25×，比较已无必要），这里没有对照面可跑；markdown 的
 * 回归由产品路径门禁 `src/renderers/solid-workbench/chat/__tests__/markdownComputeParity.test.ts`
 * 的**快照锁**承担（那是「产品路径 vs 快照」，不是差分）。少装一个 2.87MB 产物也让本脚手架更快。
 */
export async function loadComputeContext(): Promise<ComputeContextLike> {
  const compute = await loadPylonCompute()
  return { compute: compute as ComputeContextLike['compute'] }
}

export function buildAllSuites(ctx: ComputeContextLike): Suite[] {
  return [
    buildCanonicalSuite(ctx),
    buildEventsSuite(ctx),
    buildProjectorSuite(ctx),
    buildProjectorFlowSuite(),
    buildStreamingSplitSuite(ctx),
    buildStreamingBudgetSuite(ctx),
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
  // markdown 三出口的 TS 基线已随比较装置下线 ⇒ 见 `EXEMPT_EXPORTS` 处的理由与取回办法。
]

/** 编组变体/诊断出口：与同名主出口同一计算，单独对照没有信息量。 */
export const EXEMPT_EXPORTS: readonly string[] = [
  'parseMarkdownJson', 'highlightBlockJson', 'markdownEngineVersion', 'foldPhases',
  // 2026-09-21：markdown 三出口的 TS 基线（`baselines/oldMarkdownParsePipeline.ts` 与
  // `oldHighlightEngine.ts`）随比较装置下线。依据是**流式形状实测**：生产每帧只解析增长
  // 短尾（graft 成立时连这一次都省），该形状 wasm 快 12–25×（一次完整流式回合
  // 10.94ms → 0.39ms），比较已无必要；且旧实现本就不在生产路径
  // （`markdownRenderModel` / `codeHighlight` 自 #220 切流起直取计算核，无 TS 回退）。
  // 取回办法：两个基线分别雕刻自 `76cbc819^` 的 `markdownRenderModel.ts` 与
  // `components/chat/codeHighlight.ts`，`git show 76cbc819^:<path>` 可取。
  // **这不是「markdown 不受门禁」**：产品路径快照锁见
  // `src/renderers/solid-workbench/chat/__tests__/markdownComputeParity.test.ts`。
  'parseMarkdown', 'highlightBlock', 'scopeForLanguage',
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
