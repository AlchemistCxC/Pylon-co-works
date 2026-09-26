/**
 * #376/#375 的 memory 域：**逻辑载荷 → 文档驻留**的比值判据（纯函数口径）。
 *
 * 这里量的是「折完之后文档还留着多少」——不是耗时。判据全用比值（驻留 / Σ逻辑载荷），
 * 换机器、换语料都还能比；绝对 MB 由实机探针（`proc-tree.ps1` + CDP）给，见 README。
 *
 * 两条 case：
 * - `cold-load-residency`：整份 compact 读（2203 行 / Σ载荷 ≈61.5 MB）折完后的文档驻留；
 * - `beat-sensitivity`：同一终值内容下，拍数 5 → 40 的驻留增长（累计式回传的放大量纲）。
 *
 * 装载路径走**生产出口**：`toWorkbenchEnvelopes`（canonical 行 → 信封）+ `projectWorkbench`
 * （信封 → 文档）。行与信封在折完之后即可回收——这正是 #376-b 分页装载要让位给 GC 的部分，
 * 故本域只从**文档**取根，不把行数组算进驻留。
 */
import { toWorkbenchEnvelopes } from '../../../src/sheets/agent-workbench/agentWorkbenchProjection.ts'
import { createWorkbenchDocument, projectWorkbench, setTimelinePayloadNarrowing } from '../../../src/domains/workbench/workbenchProjector.ts'
import { measureRetainedBytes, type RetainedBytesReport } from '../retainedHeap.ts'
import { buildMemoryCorpus, type MemoryCorpusOptions } from '../fixtures/memoryCorpus.ts'

export interface MemoryCaseResult {
  readonly name: string
  readonly logicalPayloadBytes: number
  readonly retained: RetainedBytesReport
  /** 判据：驻留 / Σ逻辑载荷 */
  readonly ratio: number
  readonly threshold: number
  readonly pass: boolean
  readonly note: string
}

export interface MemorySuiteResult {
  readonly cases: readonly MemoryCaseResult[]
  /**
   * 拍数敏感性：**同一终值内容**下拍数 5 → 40 的**绝对**驻留增长。这里必须用绝对字节，
   * 不能用「驻留/Σ载荷」——Σ载荷本身就随拍数变（累计式回传下 5 拍的 Σ 是 40 拍的一半），
   * 用比值会把要量的效应约掉。
   */
  readonly beatSensitivity: {
    readonly lowBeats: number
    readonly highBeats: number
    readonly lowBytes: number
    readonly highBytes: number
    readonly growth: number
    readonly threshold: number
    readonly pass: boolean
  }
}

/** 把一整份 compact 读折成文档（与前端 `listJournalPages` 的逐页折同序同果）。 */
function foldToDocument(corpus: ReturnType<typeof buildMemoryCorpus>, pageSize = 256) {
  let document = createWorkbenchDocument(corpus.owner.localSessionId)
  const rows = corpus.rows as readonly unknown[]
  for (let start = 0; start < rows.length; start += pageSize) {
    const envelopes = rows.slice(start, start + pageSize).flatMap(row => toWorkbenchEnvelopes(row))
    document = projectWorkbench(envelopes, { initialDocument: document }).document
    // 页内行与信封在这里失去引用（页级回收）——与分页装载的实际形状一致。
  }
  return document
}

function residencyCase(
  name: string,
  options: MemoryCorpusOptions,
  threshold: number,
  note: string,
): { readonly result: MemoryCaseResult } {
  const corpus = buildMemoryCorpus(options)
  const document = foldToDocument(corpus)
  // 根 = 文档本身（+ 它挂着的全部切片）；行数组**不**入根。
  const retained = measureRetainedBytes([document])
  const ratio = corpus.logicalPayloadBytes === 0 ? 0 : retained.bytes / corpus.logicalPayloadBytes
  return {
    result: {
      name,
      logicalPayloadBytes: corpus.logicalPayloadBytes,
      retained,
      ratio,
      threshold,
      pass: ratio <= threshold,
      note,
    },
  }
}

export function buildMemorySuite(options: { readonly legacy?: boolean } = {}): MemorySuiteResult {
  // 对照档：关掉 #375-a 的 timeline 收窄，用**同一把尺子**量改动前的驻留（逃生口即对照开关）。
  if (options.legacy) setTimelinePayloadNarrowing(false)
  try {
    return buildMemorySuiteInner()
  } finally {
    if (options.legacy) setTimelinePayloadNarrowing(true)
  }
}

function buildMemorySuiteInner(): MemorySuiteResult {
  const cold = residencyCase(
    'cold-load-residency',
    {},
    1.2,
    '整份 compact 读（一个完整回合 / 100 次工具调用 × 20 拍累计回传）折完后的驻留 / Σ逻辑载荷',
  )
  const low = residencyCase('beat-sensitivity-low', { calls: 8, beats: 5 }, Number.POSITIVE_INFINITY, '终值相同、拍数 5')
  const high = residencyCase('beat-sensitivity-high', { calls: 8, beats: 40 }, Number.POSITIVE_INFINITY, '终值相同、拍数 40')
  const lowBytes = low.result.retained.bytes
  const highBytes = high.result.retained.bytes
  const growth = lowBytes === 0 ? 1 : highBytes / lowBytes
  return {
    cases: [cold.result, low.result, high.result],
    beatSensitivity: {
      lowBeats: 5,
      highBeats: 40,
      lowBytes,
      highBytes,
      growth,
      threshold: 1.5,
      pass: growth <= 1.5,
    },
  }
}
