// vitest 门禁：计算纯函数 TS↔wasm 对照（parity 口径，issue #220 配套脚手架）。
//
// - 覆盖门先跑：wasm 计算出口必须全部有对照 pair（缺了就是脚手架没跟上计算核）；
// - parity 默认跑到 m 档（`COMPUTE_PARITY_SCALE=full` 加 l 档极量级）；
// - mismatch 即红；known-diff（已过审引擎级差异）只记录不算红。
//
// 性能对照走 `node scripts/compute-parity-bench.mts`（同一套套件定义）。
// @vitest-environment node
// markdown 套件下线后，本门禁只剩 pylon-compute 的纯计算出口（无 DOM 依赖）——原先的
// jsdom 是被「旧 unified 管线经 decode-named-character-reference 读 document」逼出来的，
// 那个依赖已随 TS 基线下线而消失。
// 为什么需要 jsdom：markdown 侧的 TS 基线（旧 unified 管线）经
// `decode-named-character-reference` 解析实体名，其 dom 变体要 `document`；
// 在 node 环境下这一步直接 `ReferenceError: document is not defined`，
// 整轮对照连跑都跑不起来。根 `vitest.config.ts` 按本注释决定测试环境。
import { describe, expect, it } from 'vitest'

import { runParity, resolveScale, summarizeParity } from './compute-parity/harness.ts'
import { buildAllSuites, loadComputeContext, missingCoverage } from './compute-parity/index.ts'

const ctx = await loadComputeContext()
const suites = buildAllSuites(ctx)

describe('计算纯函数 TS↔wasm 对照脚手架', () => {
  it('覆盖门：wasm 计算出口全部有对照 pair', () => {
    expect(missingCoverage(suites)).toEqual([])
  })

  it('parity：同输入两侧归一后逐字节一致（known-diff 除外）', async () => {
    const rows = await runParity(suites, { scale: resolveScale(process.env.COMPUTE_PARITY_SCALE) })
    const summary = summarizeParity(rows)
    const mismatches = rows.filter(row => row.outcome === 'mismatch')
    if (mismatches.length > 0) console.error(`\n${summary}\n`)
    expect(mismatches, summary).toEqual([])
  })
})
