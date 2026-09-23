// markdown 计算核（Rust/WASM）的装载与出口——issue #220 WP4 切流；**#241 起只做 markdown 解析**。
//
// 装载形态与 `pylonCompute.ts` 同构：本文件是**编排壳**，只负责把 wasm 模块装起来
// 并转发纯计算出口；解析实现在 `src-tauri/pylon-markdown`（Rust，comrak），
// 这里不含任何解析逻辑，也不得就地补一份 TS 实现。
//
// **代码高亮出口已退役**（#241/ADR-0020）：原 `highlightBlock` / `highlightBlockJson`
// 随 syntect 语法机器一并从 crate 删除，高亮改由前端 Lezer 承担
// （`src/components/chat/lezerHighlight.ts`）。本壳因此只剩 markdown 解析面。
//
// 产物位置：`src/wasm/pylon-markdown/`，由 `scripts/build-wasm.mjs` 生成（不入库，
// vitest 的 globalSetup 与 `bun run build:wasm` 都会确保它存在）。
//
// 出口的边界约定（spec「边界约定」第 3 条，用户裁决）：
// - `parseMarkdown`：整块 markdown 进、渲染模型出。流式侧只喂 split 切出的不稳定
//   尾块，禁止每拍全文过界。
//
// 装载：**环境无关**的那半在 `wasmRuntime.ts`，测试宿主由 `scripts/wasmPreload.ts`
// 预初始化；浏览器走 glue 自己的 fetch 路径。产品源码里因此没有 `node:*`，也不依赖
// `@types/node`。消费点（渲染模型解析）本就是异步形态，这里保持 Promise 装载。

import init, * as glue from '../../wasm/pylon-markdown/pylon_markdown.js'

import { createComputeRuntime } from './wasmRuntime.ts'

/** markdown 计算核出口（与 Rust 侧 `pylon_markdown::wasm_exit` 一一对应）。 */
export interface MarkdownCompute {
  /**
   * markdown 文本 → 渲染模型（root 树，hast 同构，形状见 `MarkdownModelRoot`）。
   * 返回类型保持 `unknown`：过界值是信任边界，消费方各自显式转型/归一
   * （Solid 侧 `normalizeRoot`，React 侧 `as MarkdownModelRoot`），不在出口处假装已验证。
   */
  parseMarkdown(text: string): unknown
  /**
   * 引擎版本标记（随 crate 版本走），供诊断与 parity 记录。
   *
   * 已退役的两个出口（本壳不再声明，避免留下假契约）：
   * - `scopeForLanguage`（#236 删）：生产用 `src/components/chat/codeHighlight.ts` 的同步 TS 表，
   *   该出口无调用方，且实测逐次调用比 TS 表慢约 18×。
   * - `highlightBlock` / `highlightBlockJson`（#241 删）：高亮整体迁出 wasm 到前端 Lezer。
   */
  markdownEngineVersion(): string
}

// ── 渲染模型类型（#276 起为跨框架共享契约）────────────────────────────────
//
// Rust `pylon_markdown::model::RenderNode` 的 serde JSON 投影（字段逐一同名，
// hast 同构：`type`/`tagName`/`properties`/`children`/`value`；`tagName` camelCase）。
// Solid 侧消费在 `src/renderers/solid-workbench/chat/markdownRenderModel.ts`
// （含 LRU/graft，暂保留其自有同名类型），React 侧消费在 `sheets/file/MarkdownPreview.tsx`。
// 形状由 parity 快照（`src-tauri/pylon-markdown/parity/`）逐字段钉死。

export interface MarkdownModelText {
  type: 'text'
  value: string
}

export interface MarkdownModelElement {
  type: 'element'
  tagName: string
  /** hast 语义属性名（camelCase，如 `className`/`ariaLabel`/`dataFootnoteRef`）。 */
  properties: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
  children: readonly MarkdownModelNode[]
}

export interface MarkdownModelRoot {
  type: 'root'
  children: readonly MarkdownModelNode[]
}

export type MarkdownModelNode = MarkdownModelElement | MarkdownModelText

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
