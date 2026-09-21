// #220：计算核装载门（`wasmRuntime.ts`）的契约测试。
//
// 真机验收（记录 §25.2）撞上过一次：投影核的同步出口**绕过**装载门、直接用导入的
// glue 命名空间，于是「核还没就绪」暴露成 wasm-bindgen 内部的
// `TypeError: Cannot read properties of undefined (reading '__wbindgen_export')`
// ——一句话看不出是谁没等谁。本文件钉的就是这条契约：**未就绪时抛本仓自己的
// 可执行错误，绝不把 wasm-bindgen 的内部形状漏给调用方**。
//
// 注意测试宿主（vitest）里产物是由 `scripts/wasmPreload.ts` 预初始化的，所以这里
// 用**没登记过的假命名空间**来制造「未就绪」——这正是装载门要区分的那种命名空间。

import { describe, expect, it, vi } from 'vitest'

import { createComputeRuntime, isWasmPreloaded, registerPreloadedWasm } from '../wasmRuntime.ts'

describe('createComputeRuntime · 装载门', () => {
  it('未就绪就取 glue：抛可执行错误（带核名与下一步），不抛 wasm-bindgen 内部形状', () => {
    const namespace = {}
    const runtime = createComputeRuntime('测试核', namespace, async () => ({}))
    expect(isWasmPreloaded(namespace)).toBe(false)
    expect(() => runtime.glue()).toThrowError(/测试核/)
    expect(() => runtime.glue()).toThrowError(/whenReady/)
    // 关键：错误里不得出现 wasm-bindgen 的内部标识（那正是真机上一个下午的排障成本）。
    expect(() => runtime.glue()).not.toThrowError(/__wbindgen_export/)
  })

  it('whenReady 后 glue 可用，且 init 只跑一次（幂等）', async () => {
    const namespace = {}
    const init = vi.fn(async () => ({}))
    const runtime = createComputeRuntime('测试核', namespace, init)
    await runtime.whenReady()
    await runtime.whenReady()
    expect(init).toHaveBeenCalledTimes(1)
    expect(runtime.glue()).toBe(namespace)
  })

  it('init 失败不吞异常，且不会把 glue 变成可用', async () => {
    const namespace = {}
    const runtime = createComputeRuntime('测试核', namespace, async () => { throw new Error('产物缺失') })
    await expect(runtime.whenReady()).rejects.toThrowError('产物缺失')
    expect(() => runtime.glue()).toThrowError(/未就绪/)
  })

  it('登记为预初始化（Node 宿主路径）后无需 init 即可同步取用', () => {
    const namespace = {}
    registerPreloadedWasm(namespace)
    const init = vi.fn(async () => ({}))
    const runtime = createComputeRuntime('测试核', namespace, init)
    expect(isWasmPreloaded(namespace)).toBe(true)
    expect(runtime.glue()).toBe(namespace)
    expect(init).not.toHaveBeenCalled()
  })

  it('预初始化是「按 glue 命名空间」而不是「按名字」——换一张模块图不得被误认', () => {
    const first = {}
    registerPreloadedWasm(first)
    const second = {}
    expect(isWasmPreloaded(first)).toBe(true)
    // 名字相同的另一张图（vitest isolate 会重建）必须仍是未就绪。
    expect(isWasmPreloaded(second)).toBe(false)
    const runtime = createComputeRuntime('测试核', second, async () => ({}))
    expect(() => runtime.glue()).toThrowError(/未就绪/)
  })
})
