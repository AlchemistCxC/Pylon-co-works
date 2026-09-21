// 流式文本计算核（Rust/WASM）的装载与出口——issue #220 WP3 切流。
//
// 装载形态与 `pylonCompute.ts` 同构：本文件是**编排壳**，只负责把 wasm 模块装起来
// 并转发纯计算出口；切分与揭示预算的实现都在 `src-tauri/pylon-compute`（Rust），
// 这里不含任何切分/预算逻辑，也不得就地补一份 TS 实现。
//
// 产物位置：`src/wasm/pylon-compute/`，由 `scripts/build-wasm.mjs` 生成（不入库，
// vitest 的 globalSetup 与 `bun run build:wasm` 都会确保它存在）。
//
// 装载时序同 `projectorCompute.ts`：Node 宿主（vitest，含 jsdom）在模块导入时
// **同步**初始化，于是调度器与切分的调用点可以保持同步（rAF 回调、Solid memo、
// 纯函数）；浏览器宿主异步初始化，宿主在挂载前 `await whenStreamingComputeReady()`，
// 就绪前调用同步出口会得到显式报错。**不用顶层 await**：Vite 生产构建 target 是
// es2020，TLA 会让 esbuild 转译阶段直接失败（这正是上一版踩过的）。

// node:* 走**默认导入**：vite 的 browser-external 桩只有 default 导出，具名导入
// 会让 rollup 构建直接失败；属性访问只发生在 Node 分支内，浏览器永不触达。
import nodeFs from 'node:fs'
import nodeUrl from 'node:url'
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

let ready: Promise<void>
/** 同步出口的守卫：Node 宿主在导入时就为真，浏览器宿主在 `ready` settle 后置真。 */
let glueReady = false

const WASM_ARTIFACT = 'pylon_compute_bg.wasm'
/** vitest 的 forks 池在同进程内跨测试文件复用 globalThis：编译好的 Module 只产一次。 */
const WASM_MODULE_CACHE_KEY = '__pylon_streaming_wasm_module__'

function isNodeRuntime(): boolean {
  // 不看 `document`：jsdom 测试环境里 document 存在但运行时仍是 Node，
  // 必须走自读字节路径而不是 fetch。
  return typeof process !== 'undefined' && !!process.versions?.node
}

function readWasmBytes(): Buffer {
  const candidates: string[] = []
  // 第一候选：从本模块 URL 推导（Node 直跑与浏览器构建都成立；vitest 的 vite
  // 管线可能产出非标准 URL，任一转换失败即退下一候选）。
  try {
    candidates.push(nodeUrl.fileURLToPath(new URL(`../../wasm/pylon-compute/${WASM_ARTIFACT}`, import.meta.url).href))
  } catch {
    /* 退下一候选 */
  }
  // 兜底：vitest/bun 的 cwd 恒为仓库根（`bun run test` / `bunx vitest` 入口）。
  candidates.push(`src/wasm/pylon-compute/${WASM_ARTIFACT}`)
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      return nodeFs.readFileSync(candidate)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error('wasm 产物读取失败')
}

function compiledWasmModule(): WebAssembly.Module {
  const cache = globalThis as Record<string, WebAssembly.Module | undefined>
  const cached = cache[WASM_MODULE_CACHE_KEY]
  if (cached) return cached
  const compiled = new WebAssembly.Module(new Uint8Array(readWasmBytes()))
  cache[WASM_MODULE_CACHE_KEY] = compiled
  return compiled
}

// 装载模型与 `projectorCompute.ts` 一致（**刻意不用顶层 await**：Vite 生产构建
// target 是 es2020，不支持 TLA——顶层 await 会让 `vite build` 在 esbuild 转译阶段
// 直接失败）。Node 宿主（vitest，含 jsdom）在模块导入时**同步**初始化，于是切分与
// 引擎的调用点可以保持同步；浏览器宿主异步初始化，同步调用方在就绪前拿到的是
// 显式报错而不是静默降级，宿主在挂载前 `await whenStreamingComputeReady()`。
if (isNodeRuntime()) {
  glue.initSync({ module: compiledWasmModule() })
  glueReady = true
  ready = Promise.resolve()
} else {
  ready = Promise.resolve(init()).then(() => {
    glueReady = true
  })
}

/** 流式计算核就绪；Node 宿主恒已就绪（模块导入时同步初始化）。 */
export function whenStreamingComputeReady(): Promise<void> {
  return ready
}

/**
 * 装载后的计算核出口。浏览器宿主在就绪前调用会抛——**不静默降级**：切分与预算
 * 一旦回退成另一套实现，就是 issue 明令禁止的长期双实现。
 */
export function streamingCompute(): StreamingCompute {
  if (!glueReady) throw new Error('流式计算核未就绪：请先 await whenStreamingComputeReady()')
  return glue as unknown as StreamingCompute
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
