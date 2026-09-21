// 流式文本计算核（Rust/WASM）的装载与出口——issue #220 WP3 切流。
//
// 装载形态与 `pylonCompute.ts` 同构：本文件是**编排壳**，只负责把 wasm 模块装起来
// 并转发纯计算出口；切分与揭示预算的实现都在 `src-tauri/pylon-compute`（Rust），
// 这里不含任何切分/预算逻辑，也不得就地补一份 TS 实现。
//
// 产物位置：`src/wasm/pylon-compute/`，由 `scripts/build-wasm.mjs` 生成（不入库，
// vitest 的 globalSetup 与 `bun run build:wasm` 都会确保它存在）。
//
// 装载时序：本模块**顶层 await** 完成实例化——调度器与流式切分的调用点全是同步
// 上下文（rAF 回调、Solid memo、纯函数），计算核必须在首次调用前就绪，因此把
// 「等装载」放在模块求值处而不是每个调用点。glue 的 `init()` 内部有
// `wasm !== undefined` 守卫，与 `pylonCompute.ts` 等其他装载方并发安全。
//
// 两种宿主的装载路径：
// - 浏览器 / Vite：glue 的 `--target web` 默认 `init()` 用 `new URL(..., import.meta.url)`
//   取 wasm，Vite 接成资源 URL，直接 await 即可。
// - Node（vitest）：`fetch` 拿不到 `file:` URL，这里自读字节喂给
//   `WebAssembly.instantiate`。**刻意不用 `new URL(字面量, import.meta.url)`**——
//   Vite/vitest 的静态重写会把字面量换成资源路径，Node 分支就再也还原不出文件
//   路径；改成字符串拼接后重写不匹配，语义在两种宿主下都稳定。

import init, * as glue from '../../wasm/pylon-compute/pylon_compute.js'

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

const WASM_ARTIFACT = 'pylon_compute_bg.wasm'

function isNodeRuntime(): boolean {
  // 不看 `document`：jsdom 测试环境里 document 存在但运行时仍是 Node，
  // 必须走自读字节路径而不是 fetch。
  return typeof process !== 'undefined' && !!process.versions?.node
}

async function instantiate(): Promise<void> {
  if (isNodeRuntime()) {
    const [{ readFile }, { fileURLToPath }] = await Promise.all([
      import('node:fs/promises'),
      import('node:url'),
    ])
    const here = import.meta.url
    const artifactUrl = `${here.slice(0, here.lastIndexOf('/') + 1)}../../wasm/pylon-compute/${WASM_ARTIFACT}`
    await init({ module_or_path: await readFile(fileURLToPath(artifactUrl)) })
    return
  }
  await init()
}

// 模块顶层装载：TLA。装载成功前，任何 import 本模块的代码都不会开始求值。
const loaded: StreamingCompute = await (async () => {
  await instantiate()
  return glue as unknown as StreamingCompute
})()

/** 装载后的计算核出口。顶层 await 保证：import 本模块即已就绪。 */
export function streamingCompute(): StreamingCompute {
  if (loaded === undefined) throw new Error('流式计算核未就绪：模块顶层装载尚未完成')
  return loaded
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
