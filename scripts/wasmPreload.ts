/**
 * 计算核的**测试侧**装载前置（issue #220）。
 *
 * 产品源码只保留「浏览器自己 fetch wasm」那条路；Node 宿主要能**同步**调用计算核
 * （切分、揭示引擎、投影折叠的调用点全是同步上下文），所以这里在测试进程里读盘 +
 * `initSync` 预初始化，并向 `wasmRuntime` 登记。放 `scripts/` 而不是 `src/` 是有意的：
 * `tsconfig.json` 的 `include` 只覆盖 `src`，测试专用的 `node:*` 因此不会把
 * `@types/node` 反向耦合进产品源码——那正是重构要消除的东西。
 *
 * 调用点：`vitest.setup.ts`（`setupFiles` 每个测试文件执行一次）。**必须在此之前**
 * 完成，测试文件才可能同步调用计算核；所以这里是**同步**的，不用动态 import。
 *
 * 跨测试文件只缓存「编译好的 `WebAssembly.Module`」（编译是昂贵的那半）。
 * **不缓存 glue 命名空间**：vitest 的 isolate 会为每个测试文件重建模块图，上一张图
 * 的 glue 实例对下一张图无效，缓存它会让「已就绪」变成谎话。
 */

import nodeFs from 'node:fs'
import nodeUrl from 'node:url'

import * as computeGlue from '../src/wasm/pylon-compute/pylon_compute.js'
import * as markdownGlue from '../src/wasm/pylon-markdown/pylon_markdown.js'
import { registerPreloadedWasm } from '../src/infrastructure/compute/wasmRuntime.ts'

interface RuntimeSpec {
  name: string
  /** 编译产物缓存键（编译结果与模块图无关，可跨测试文件复用）。 */
  cacheKey: string
  artifact: string
  glue: { initSync: (input: { module: WebAssembly.Module }) => unknown }
}

const RUNTIMES: readonly RuntimeSpec[] = [
  {
    name: 'pylon-compute',
    cacheKey: '__pylon_compute_wasm_module__',
    artifact: 'pylon_compute_bg.wasm',
    glue: computeGlue,
  },
  {
    name: 'pylon-markdown',
    cacheKey: '__pylon_markdown_wasm_module__',
    artifact: 'pylon_markdown_bg.wasm',
    glue: markdownGlue,
  },
]

/** 产物目录相对本文件；测试/脚本的 cwd 不保证，故从模块 URL 推导再退 cwd 兜底。 */
function resolveArtifact(artifact: string, packageName: string): string {
  const candidates: string[] = []
  try {
    candidates.push(
      nodeUrl.fileURLToPath(new URL(`../src/wasm/${packageName}/${artifact}`, import.meta.url).href),
    )
  } catch {
    /* 退下一候选 */
  }
  candidates.push(`src/wasm/${packageName}/${artifact}`)
  let lastError: unknown
  for (const candidate of candidates) {
    try {
      nodeFs.accessSync(candidate)
      return candidate
    } catch (error) {
      lastError = error
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`wasm 产物缺失：${artifact}`)
}

function compiledModule(spec: RuntimeSpec): WebAssembly.Module {
  const host = globalThis as Record<string, unknown>
  const cached = host[spec.cacheKey]
  if (cached instanceof WebAssembly.Module) return cached
  const bytes = nodeFs.readFileSync(resolveArtifact(spec.artifact, spec.name))
  const compiled = new WebAssembly.Module(new Uint8Array(bytes))
  host[spec.cacheKey] = compiled
  return compiled
}

/**
 * 预初始化全部计算核。`initSync` 在已初始化的 glue 上会早退，因此重复调用安全；
 * 每个测试文件的模块图都需要各自调一次（编译结果复用缓存）。
 */
export function preloadComputeWasm(): void {
  for (const spec of RUNTIMES) {
    const output = spec.glue.initSync({ module: compiledModule(spec) }) as { memory?: WebAssembly.Memory }
    registerPreloadedWasm(spec.glue as object)
    // 诊断用：把 memory 留在 globalThis 上，基准脚本据此报堆增长（不参与装载语义）。
    if (output?.memory) {
      ;(globalThis as Record<string, unknown>)[`${spec.cacheKey}memory`] = output.memory
    }
  }
}
