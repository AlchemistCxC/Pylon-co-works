// markdown 计算核（Rust/WASM）的装载与出口——issue #220 WP4 切流。
//
// 装载形态与 `pylonCompute.ts` 同构：本文件是**编排壳**，只负责把 wasm 模块装起来
// 并转发纯计算出口；解析与高亮的实现都在 `src-tauri/pylon-markdown`（Rust，comrak +
// syntect），这里不含任何解析/高亮逻辑，也不得就地补一份 TS 实现。
//
// 产物位置：`src/wasm/pylon-markdown/`，由 `scripts/build-wasm.mjs` 生成（不入库，
// vitest 的 globalSetup 与 `bun run build:wasm` 都会确保它存在）。
//
// 两个出口的边界约定（spec「边界约定」第 3 条，用户裁决）：
// - `parseMarkdown`：整块 markdown 进、渲染模型出。流式侧只喂 split 切出的不稳定
//   尾块，禁止每拍全文过界。
// - `highlightBlock`：整块代码进、行数组 span 出（github `pl-*` 类名链）。逐行过界禁止。
//
// 装载：**环境无关**的那半在 `wasmRuntime.ts`，测试宿主由 `scripts/wasmPreload.ts`
// 预初始化；浏览器走 glue 自己的 fetch 路径。产品源码里因此没有 `node:*`，也不依赖
// `@types/node`。消费点（渲染模型解析、代码高亮）本就是异步形态，这里保持 Promise 装载。

import init, * as glue from '../../wasm/pylon-markdown/pylon_markdown.js'

import { createComputeRuntime } from './wasmRuntime.ts'

/** 整块代码的高亮结果：每行一组 span（不含行尾换行；换行由消费方按行拼）。 */
export interface HighlightSpan {
  readonly classes: readonly string[]
  readonly text: string
}

export interface HighlightedLine {
  readonly spans: readonly HighlightSpan[]
}

/** markdown 计算核出口（与 Rust 侧 `pylon_markdown::wasm_exit` 一一对应）。 */
export interface MarkdownCompute {
  /** markdown 文本 → 渲染模型（root 树， hast 同构）。 */
  parseMarkdown(text: string): unknown
  /** 整块代码 → 行数组高亮 span；语言未知 / 语法包缺失返回 `undefined`（null 语义）。 */
  highlightBlock(code: string, language: string): readonly HighlightedLine[] | undefined
  /** 语言别名 → TextMate scope（与原 TS 基线 `scopeForLanguage` 同表）。 */
  scopeForLanguage(language: string): string | undefined
  /** 引擎版本标记（随 crate 版本走），供诊断与 parity 记录。 */
  markdownEngineVersion(): string
}

const runtime = createComputeRuntime('pylon-markdown', glue, () => init())

let loading: Promise<MarkdownCompute> | undefined
let loaded: MarkdownCompute | undefined

/**
 * 装载 markdown 计算核（幂等）。失败时不吞异常：调用方要么让请求红，要么自己
 * 决定降级，装载层不替它们做「静默退回 TS 实现」这种决定。
 */
export function loadMarkdownCompute(): Promise<MarkdownCompute> {
  if (loaded) return Promise.resolve(loaded)
  loading ??= runtime.whenReady().then(() => {
    loaded = runtime.glue() as unknown as MarkdownCompute
    return loaded
  })
  return loading
}

/** 已装载则同步取用；未装载返回 `undefined`。 */
export function peekMarkdownCompute(): MarkdownCompute | undefined {
  return loaded
}
