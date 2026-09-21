// 流式文本计算核（Rust/WASM）的装载与出口——issue #220 WP3 切流。
//
// 装载形态与 `pylonCompute.ts` 同构：本文件是**编排壳**，只负责把 wasm 模块装起来
// 并转发纯计算出口；切分与揭示预算的实现都在 `src-tauri/pylon-compute`（Rust），
// 这里不含任何切分/预算逻辑，也不得就地补一份 TS 实现。
//
// 产物位置：`src/wasm/pylon-compute/`，由 `scripts/build-wasm.mjs` 生成（不入库，
// vitest 的 globalSetup 与 `bun run build:wasm` 都会确保它存在）。
//
// 装载：**环境无关**的那半在 `wasmRuntime.ts`，测试宿主（Node/vitest）由
// `scripts/wasmPreload.ts` 预初始化；浏览器走 glue 自己的 fetch 路径。产品源码里
// 因此没有 `node:*`，也不依赖 `@types/node`。调用点全是同步上下文（rAF 回调、
// Solid memo、纯函数），所以就绪门 + 同步出口的形态必须保留；**不用顶层 await**：
// Vite 生产构建 target 是 es2020，TLA 会让 esbuild 转译阶段直接失败。
//
import init, * as glue from '../../wasm/pylon-compute/pylon_compute.js'

import { createComputeRuntime } from './wasmRuntime.ts'

/** 揭示预算引擎的节奏选项（缺省字段由 Rust 侧 `positiveFinite` 归一化）。 */
export interface StreamingRevealEngineOptions {
  maxUpdatesPerSecond?: number
  revealUnitsPerSecond?: number
  maxRevealUnitsPerTick?: number
  maxRevealLagMs?: number
}

/** 一行的本拍决策（Rust `RowReveal`）。 */
export interface StreamingRevealRow {
  readonly key: string
  readonly value: string
  readonly consumedUnits: number
}

/** 一次 `tick` 的结果（Rust `TickOutcome`；结构发布/清定时器等编排动作由 JS 按 `kind` 执行）。 */
export interface StreamingRevealTickOutcome {
  readonly kind: 'budgeted' | 'converged'
  readonly budget: number
  readonly backlogUnits: number
  readonly advancedMaxUnits: number
  readonly advancedTotalUnits: number
  readonly rows: readonly StreamingRevealRow[]
  readonly catchUpWindows: number
}

/** 揭示预算引擎（Rust `StreamingRevealEngine`）。驱动协议：reset → (feed → noteBacklog)* → tick*。 */
export interface StreamingRevealEngine {
  reset(rows: ReadonlyArray<{ key: string, text: string }>, at: number): void
  feed(key: string, delta: string): void
  noteBacklog(now: number): void
  tick(now: number): StreamingRevealTickOutcome
  mirrorText(key: string): string | undefined
  revealedText(key: string): string | undefined
  revealedUnits(key: string): number | undefined
  catchUpWindows(): number
  free(): void
}

/** 流式计算核出口（与 Rust 侧 `pylon_compute::streaming` 一一对应）。 */
export interface StreamingCompute {
  splitStreamingMarkdownBlocks(text: string): { stableBlocks: string[], unstable: string }
  splitStreamingMarkdown(text: string): { stable: string, unstable: string }
  findLastStableBlockBoundary(text: string): number
  splitOpenCodeFenceTail(text: string): { prefix: string, language?: string, code: string } | null
  StreamingRevealEngine: new (options?: StreamingRevealEngineOptions) => StreamingRevealEngine
}

// 装载：环境无关的那半在 `wasmRuntime.ts`（浏览器 fetch / 测试宿主预初始化）。
// 产品源码里没有 `node:*`——那正是重构前三个装载器各自内联 `node:fs` 的代价：
// 前端门禁 job 在干净检出上直接 TS2307。
const runtime = createComputeRuntime('pylon-compute（流式）', glue, () => init())

/** 流式计算核就绪。测试宿主由前置预初始化，因此同步已就绪。 */
export function whenStreamingComputeReady(): Promise<void> {
  return runtime.whenReady()
}

/**
 * 就绪后的计算核出口。未就绪即抛——**不静默降级**：切分与预算一旦回退成另一套
 * 实现，就是 issue 明令禁止的长期双实现（见 `wasmRuntime.ts`）。
 */
export function streamingCompute(): StreamingCompute {
  return runtime.glue() as unknown as StreamingCompute
}

// ── 同步出口包装（切分的调用点是同步 memo/纯函数；测试直接 import 这些名字） ──

/** 把流式文本切成 { stable, unstable }。stable 是已完成块；unstable 是仍增长的尾块。 */
export function splitStreamingMarkdown(text: string): { stable: string, unstable: string } {
  return streamingCompute().splitStreamingMarkdown(text)
}

/** Stable 顶层块序列 + unstable 尾块。已解析结果永不增长、可缓存复用。 */
export function splitStreamingMarkdownBlocks(text: string): { stableBlocks: string[], unstable: string } {
  return streamingCompute().splitStreamingMarkdownBlocks(text)
}

/** 最后一个已证安全的块边界的 UTF-16 偏移。 */
export function findLastStableBlockBoundary(text: string): number {
  return streamingCompute().findLastStableBlockBoundary(text)
}

/** 文末最后一个仍未闭合的围栏代码块；不存在返回 null。 */
export function splitOpenCodeFenceTail(text: string): { prefix: string, language?: string, code: string } | null {
  return streamingCompute().splitOpenCodeFenceTail(text)
}
