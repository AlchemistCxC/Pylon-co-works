// 前端计算核（Rust/WASM）的装载与出口——issue #220。
//
// 这一层是**编排壳**：它只负责把 wasm 模块装起来并把纯计算出口转发给调用方。
// 计算本身在 `src-tauri/pylon-compute`（Rust），本文件不含任何 canonical 逻辑，
// 也不得就地补一份 TS 实现——那会立刻变成 issue 明令禁止的「长期双实现」。
//
// 产物位置：`src/wasm/pylon-compute/`，由 `scripts/build-wasm.mjs` 生成（不入库，
// vitest 的 globalSetup 与 `bun run build:wasm` 都会确保它存在）。
//
// 两种宿主都要能装载（issue 的「浏览器预览模式必须继续可用」约束）：
// - 浏览器 / Vite：wasm-bindgen 的 `--target web` glue 用 `new URL(..., import.meta.url)`
//   取 wasm，Vite 会把它接成资源 URL，直接 `init()` 即可。
// - Node（vitest）：`fetch` 拿不到 `file:` URL，因此这里自己读字节喂给
//   `WebAssembly.instantiate`。**刻意不用 `new URL(字面量, import.meta.url)`**——
//   Vite/vitest 的静态重写会把那个字面量换成资源路径，Node 分支就再也还原不出文件
//   路径；改成字符串拼接后重写不匹配，语义在两种宿主下都稳定。

import init, * as glue from '../../wasm/pylon-compute/pylon_compute.js'

/** 计算核的 canonical 出口（与 Rust 侧 `pylon_compute::canonical` 一一对应）。 */
export interface PylonCompute {
  /** canonical 事件类型词表，声明顺序即 wire 顺序。 */
  canonicalEventTypes(): readonly string[]
  /** wire `sessionUpdate` 判别符 → canonical 事件类型；未识别归 `'unknown'`。 */
  canonicalEventTypeFor(sessionUpdate?: string | null, status?: string | null): string
  /** 值是否在 canonical 词表内。 */
  isCanonicalEventType(value: string): boolean
  /** owner key = `["profileId","agentId","localSessionId"]`（JSON 数组，禁冒号拼接）。 */
  canonicalOwnerKey(profileId: string, agentId: string, localSessionId: string): string
  /** 事件唯一标识：`ownerKey#sequence`。 */
  canonicalEventId(ownerKey: string, sequence: number): string
  /** sequence 纯原语：`undefined` → 1，否则 +1。 */
  nextEventSequence(previous?: number | null): number
}

const WASM_ARTIFACT = 'pylon_compute_bg.wasm'

let loading: Promise<PylonCompute> | undefined
let loaded: PylonCompute | undefined

function isNodeRuntime(): boolean {
  return typeof document === 'undefined' && typeof process !== 'undefined' && !!process.versions?.node
}

async function instantiate(): Promise<void> {
  if (!isNodeRuntime()) {
    await init()
    return
  }
  const [{ readFile }, { fileURLToPath }] = await Promise.all([
    import('node:fs/promises'),
    import('node:url'),
  ])
  const here = import.meta.url
  const artifactUrl = `${here.slice(0, here.lastIndexOf('/') + 1)}../../wasm/pylon-compute/${WASM_ARTIFACT}`
  await init({ module_or_path: await readFile(fileURLToPath(artifactUrl)) })
}

/**
 * 装载计算核（幂等）。失败时**不吞异常**：调用方要么让测试红，要么自己决定降级，
 * 装载层不替它们做「静默退回 TS 实现」这种决定。
 */
export function loadPylonCompute(): Promise<PylonCompute> {
  if (loaded) return Promise.resolve(loaded)
  loading ??= instantiate().then(() => {
    loaded = glue as unknown as PylonCompute
    return loaded
  })
  return loading
}

/** 已装载则同步取用（供热路径避免 await）；未装载返回 `undefined`。 */
export function peekPylonCompute(): PylonCompute | undefined {
  return loaded
}
