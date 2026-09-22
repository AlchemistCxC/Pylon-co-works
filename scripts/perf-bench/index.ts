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
 * 判据统一为「`src/` 里有没有调用方」——只被测试引用的出口是给 parity 门禁留的兼容面，
 * parity **门禁**（`scripts/compute-parity.test.mts`）仍需要它们，但产品路径不走。
 */
export const EXCLUDED_WASM_EXITS: ReadonlyArray<{ readonly name: string, readonly reason: string }> = [
  {
    name: 'splitStreamingMarkdown',
    reason: 'src/ 内无调用方（生产消费方已切到 ends 出口），仅 parity 门禁用',
  },
  {
    name: 'splitStreamingMarkdownBlocks',
    reason: '同上：作为兼容出口保留给 parity，热路径是 splitStreamingMarkdownBlockEnds',
  },
  {
    name: 'findLastStableBlockBoundary',
    reason: '同上：src/ 内无调用方',
  },
  {
    name: 'scopeForLanguage（wasm 出口）',
    reason: '生产用 src/components/chat/codeHighlight.ts:15 的 TS 映射表做同步语言门，wasm 出口无调用方',
  },
]
