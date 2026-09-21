// 前端计算核（Rust/WASM）的装载与出口——issue #220。
//
// 这一层是**编排壳**：它只负责把 wasm 模块装起来并把纯计算出口转发给调用方。
// 计算本身在 `src-tauri/pylon-compute`（Rust），本文件不含任何 canonical 逻辑，
// 也不得就地补一份 TS 实现——那会立刻变成 issue 明令禁止的「长期双实现」。
//
// 产物位置：`src/wasm/pylon-compute/`，由 `scripts/build-wasm.mjs` 生成（不入库，
// vitest 的 globalSetup 与 `bun run build:wasm` 都会确保它存在）。
//
// 装载：**环境无关**的那半在 `wasmRuntime.ts`——浏览器走 glue 的 fetch 路径，
// 测试宿主由 `scripts/wasmPreload.ts` 预初始化。产品源码里因此没有 `node:*`。

import init, * as glue from '../../wasm/pylon-compute/pylon_compute.js'

import { createComputeRuntime } from './wasmRuntime.ts'

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

const runtime = createComputeRuntime('pylon-compute', glue, () => init())

let loading: Promise<PylonCompute> | undefined
let loaded: PylonCompute | undefined

/**
 * 装载计算核（幂等）。失败时**不吞异常**：调用方要么让测试红，要么自己决定降级，
 * 装载层不替它们做「静默退回 TS 实现」这种决定。
 */
export function loadPylonCompute(): Promise<PylonCompute> {
  if (loaded) return Promise.resolve(loaded)
  loading ??= runtime.whenReady().then(() => {
    loaded = runtime.glue() as unknown as PylonCompute
    return loaded
  })
  return loading
}

/** 已装载则同步取用（供热路径避免 await）；未装载返回 `undefined`。 */
export function peekPylonCompute(): PylonCompute | undefined {
  return loaded
}
