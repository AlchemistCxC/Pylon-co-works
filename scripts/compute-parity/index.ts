// 脚手架组装：wasm 装载上下文 + 套件注册表 + 「全计算出口」覆盖门。
//
// 消费方：
// - `scripts/compute-parity.test.mts`（vitest parity 门禁，本文件的主要消费者）
// - `scripts/perf-bench/`（产品路径性能基准，issue #233）：只取本套件 pair 的 `wasm` 侧计时。
//   #233 已废除 `scripts/compute-parity-bench.mts` 与 `-memory.mts`（双侧比值口径）。
//
// # 2026-09-21 scope 收窄（ADR-0018 修订）
//
// 本脚手架**只对照流式两项**（`pylon-compute` 的切分与揭示预算引擎）。canonical / events /
// projector 三域的套件随其**回退**删除，理由与读数见 ADR-0018 与
// `.agents/records/220-*completion.md` §31。markdown 两域此前已下线（TS 基线退役）。
//
// 保留 wasm 的判据因此收敛成一句：**同形状对照里真的赢** —— markdown 流式形 12–25×、
// 流式切分大输入 2–3×、揭示预算 burst 档 0.6–0.9×。

import { streamingCompute, whenStreamingComputeReady } from '../../src/infrastructure/compute/streamingCompute.ts'
import type { Suite } from './harness.ts'
import { buildStreamingSplitSuite } from './suites/streamingSplitSuite.ts'
import { buildStreamingBudgetSuite } from './suites/streamingBudgetSuite.ts'

/** 流式段 wasm 出口（WP3 streaming 段薄壳）。 */
export interface StreamingComputeExports {
  splitStreamingMarkdownBlocks(text: string): { stableBlocks: string[], unstable: string }
  splitStreamingMarkdown(text: string): { stable: string, unstable: string }
  findLastStableBlockBoundary(text: string): number
  splitOpenCodeFenceTail(text: string): { prefix: string, language?: string, code: string } | null
  StreamingRevealEngine: new (options?: Record<string, number>) => unknown
}

/** 套件运行上下文：只给流式出口。 */
export interface ComputeContextLike {
  compute: StreamingComputeExports
}

/**
 * 只装 `pylon-compute` 的流式出口。markdown 与 projector/events 的装载器均已随其套件下线
 * —— 少装一个 2.87MB 产物（markdown）也让本脚手架更快。
 */
export async function loadComputeContext(): Promise<ComputeContextLike> {
  await whenStreamingComputeReady()
  return { compute: streamingCompute() }
}

export function buildAllSuites(ctx: ComputeContextLike): Suite[] {
  return [
    buildStreamingSplitSuite(ctx),
    buildStreamingBudgetSuite(ctx),
  ]
}

// ── 覆盖门：wasm 计算纯函数出口必须全部有对照 pair（「全计算纯函数」的判据） ──

/** 全部 wasm 计算出口（= `pylon-compute` 现存的流式出口）。 */
export const REQUIRED_EXPORTS: readonly string[] = [
  'splitStreamingMarkdownBlocks', 'splitStreamingMarkdown', 'findLastStableBlockBoundary',
  'splitOpenCodeFenceTail', 'StreamingRevealEngine',
]

/** 编组变体/诊断出口：与同名主出口同一计算，单独对照没有信息量。 */
export const EXEMPT_EXPORTS: readonly string[] = []

/** 覆盖门：返回缺失的出口名（非空即脚手架没跟上计算核面，parity 不许绿）。 */
export function missingCoverage(suites: readonly Suite[]): string[] {
  const covered = new Set<string>()
  for (const suite of suites) {
    for (const pair of suite.pairs) covered.add(pair.name.replace(/\(.*\)$/, ''))
  }
  return REQUIRED_EXPORTS.filter(name => !covered.has(name) && !EXEMPT_EXPORTS.includes(name))
}
