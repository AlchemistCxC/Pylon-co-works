// 产品路径性能基准的**套件注册表**（issue #233）。
//
// 一个域 = 一条（或一组）已接线的生产路径。每条的 `wiredAt` 是接线点证据，不是结论——
// 判断「该不该量」时先核那个 file:line 有没有调用方，而不是看它是不是 wasm 出口。

import { loadComputeContext } from '../compute-parity/index.ts'
import type { PerfSuite } from './harness.ts'
import { buildEventsSuite } from './suites/eventsSuite.ts'
import { buildMarkdownHighlightSuite } from './suites/markdownHighlightSuite.ts'
import { buildMarkdownParseSuite } from './suites/markdownParseSuite.ts'
import { buildProjectorSuite } from './suites/projectorSuite.ts'
import { buildStreamingSuites } from './suites/streamingSuite.ts'

/** 六域全套件。计算核装载失败即抛（不静默降级——没有产物就没有读数）。 */
export async function buildPerfSuites(): Promise<PerfSuite[]> {
  const ctx = await loadComputeContext()
  return [
    ...buildStreamingSuites(ctx),
    await buildMarkdownParseSuite(),
    await buildMarkdownHighlightSuite(),
    buildProjectorSuite(),
    buildEventsSuite(),
  ]
}

/**
 * **被排除**的 wasm 计算出口，以及排除理由。
 *
 * 列出来而不是只体现在「表里没有」：「没接线」是一个结论，得能被人核。
 * 判据统一为「`src/` 里有没有调用方」。
 *
 * 本清单覆盖**两个计算核的全部真实导出**（`pylon-compute` 6 个、`pylon-markdown` 3 个，
 * `initSync` 除外；**#241 起高亮已不在 wasm**，故 markdown 核只剩解析面）：接线的是
 * **4 个**（= 本基准的 4 条 wasm 路径），未接线的是 **5 个**（下表）。不要只按 parity
 * 脚手架的 `REQUIRED_EXPORTS` 数——那只是 `pylon-compute` 的一半，且不含 `pylon-markdown`。
 *
 * 两次收窄都是**删除**而非新增：`scopeForLanguage` 按 #236 删除（无调用方 + 逐次调用比
 * 现役 TS 表慢约 18×）；`highlightBlock` / `highlightBlockJson` 按 #241 删除（高亮整体迁出
 * wasm 到前端 Lezer）。已删的出口不在此列——「不在导出面上」与「在但没接线」是两件事。
 */
export const EXCLUDED_WASM_EXITS: ReadonlyArray<{ readonly name: string, readonly reason: string }> = [
  {
    name: 'splitStreamingMarkdown',
    reason: '#220 边界收口后被 splitStreamingMarkdownBlockEnds 取代；src/ 内无调用方，作 parity 门禁的对照物保留',
  },
  {
    name: 'splitStreamingMarkdownBlocks',
    reason: '同上（`MarkdownContent.solid.tsx:76` 只是注释提到这个名字，实际调的是 ends 出口）',
  },
  {
    name: 'findLastStableBlockBoundary',
    reason: '同上；src/ 内无调用方',
  },
  {
    name: 'parseMarkdownJson',
    reason: 'wasm-bindgen 编组变体，头注称「供宿主快照/调试工具（parity 快照 bin）」；'
      + '但 `src/bin/parity_snapshot.rs` 直接调纯内层 `pylon_markdown::parser::parse_markdown`，'
      + '**不经过这个壳** ⇒ JS 可见面全仓零引用（意图记过，消费者没落地过）',
  },
  {
    name: 'markdownEngineVersion',
    reason: '头注称「供 JS 侧诊断与 parity 记录」；JS 侧无调用方，parity 快照 bin 也没调它',
  },
]
