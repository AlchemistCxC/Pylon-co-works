/**
 * 计算核装载里**与运行环境无关**的那一半（issue #220）。
 *
 * 「wasm 从哪来」是**环境**的关切，不该长在产品源码里：
 *
 * - **浏览器 / Vite**：glue 的 `--target web` 路径自己按 `import.meta.url` 取
 *   `_bg.wasm`（Vite 把它接成资源 URL），直接 `init()` 即可。
 * - **Node（vitest / bun）**：`fetch` 读不了 `file:`，所以由**测试前置**
 *   （`scripts/wasmPreload.ts`，经 `vitest.setup.ts` 调用）读盘 + `initSync`
 *   预初始化，并在本模块登记。
 *
 * 于是产品源码里**不出现 `node:*`**、也不依赖 `@types/node`——这正是重构前
 * 三个装载器各自内联 `node:fs` 的代价：前端门禁 job 在干净检出上直接
 * `TS2307: Cannot find module 'node:fs'`。
 *
 * 登记用 `WeakSet<object>` 而不是 `globalThis` 上的名字表：glue 的模块实例是
 * **每个模块图一份**（vitest 的 isolate 会为每个测试文件重建模块图），
 * 用名字表会让「上一张图登记过」被下一张图误读成「我的 glue 已就绪」。
 * 以 glue 命名空间对象本身为键，登记的语义自动与「哪份 glue」对齐。
 */

/** 已由测试前置 `initSync` 预初始化过的 glue 命名空间。 */
const preloaded = new WeakSet<object>()

/** 测试前置预初始化某个计算核后登记它（幂等）。 */
export function registerPreloadedWasm(namespace: object): void {
  preloaded.add(namespace)
}

/** 该 glue 命名空间是否已被预初始化（即可以**同步**调用）。 */
export function isWasmPreloaded(namespace: object): boolean {
  return preloaded.has(namespace)
}

export interface ComputeRuntime<Glue> {
  /**
   * 就绪保证，幂等。预初始化环境下同步已就绪；否则走 glue 的 `init()`
   * （浏览器 fetch 路径）。**装载失败不吞异常**：这里不替调用方决定降级。
   */
  whenReady(): Promise<void>
  /**
   * 取已就绪的 glue 出口。未就绪即**抛**——回退成第二套 TS 实现正是 issue 明令
   * 禁止的长期双实现，静默降级会让它悄悄复活。
   */
  glue(): Glue
}

/**
 * 为一个计算核建立装载门。`namespace` 是 `import * as glue from '...'` 的命名空间
 * （wasm-bindgen 的出口就挂在它上面），`init` 是 glue 的默认导出 `init`。
 */
export function createComputeRuntime<Glue extends object>(
  name: string,
  namespace: Glue,
  init: () => Promise<unknown>,
): ComputeRuntime<Glue> {
  let pending: Promise<void> | undefined
  let ready = isWasmPreloaded(namespace)
  return {
    whenReady(): Promise<void> {
      if (ready || isWasmPreloaded(namespace)) {
        ready = true
        return Promise.resolve()
      }
      pending ??= Promise.resolve(init()).then(() => {
        ready = true
      })
      return pending
    },
    glue(): Glue {
      if (!ready && !isWasmPreloaded(namespace)) {
        throw new Error(
          `${name} 计算核未就绪：请先 await whenReady()` +
            '（浏览器宿主；Node 宿主由测试前置 scripts/wasmPreload.ts 预初始化）',
        )
      }
      ready = true
      return namespace
    },
  }
}
