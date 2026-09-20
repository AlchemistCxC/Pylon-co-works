// vitest globalSetup：确保前端计算核的 wasm 产物存在（issue #220）。
//
// 为什么放在 globalSetup 而不是 package.json 的 `test` 前置：
//   vitest 的入口不止 `bun run test`（还有 watch 模式与编辑器集成），把构建挂到
//   某一个 npm script 上会留下「换个入口跑就是陈旧产物」的缺口。globalSetup 是
//   所有入口的公共前置。
//
// 成本：`build-wasm.mjs` 以源码哈希做戳，未变时只读几个文件（<100ms）；只有真的
// 动过计算核才付 wasm-pack 的 20-35s。
//
// 少了 wasm 工具链时**不静默跳过**——跳过等于悄悄弱化 parity 门禁（issue #220
// 明确禁止弱化既有门禁），所以这里直接失败并给出补齐命令。

// @ts-expect-error —— 构建脚本是 .mjs，无类型声明；此处只取一个导出函数。
import { ensureWasmBuilt } from './build-wasm.mjs'

export default function setup(): void {
  const outcome = ensureWasmBuilt() as { skipped: boolean }
  console.log(
    outcome.skipped
      ? '[vitest] 前端计算核 wasm 产物已是最新'
      : '[vitest] 已重建前端计算核 wasm 产物',
  )
}
