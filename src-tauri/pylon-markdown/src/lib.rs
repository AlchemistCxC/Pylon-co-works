//! markdown 引擎 crate（issue #220 WP4 起；**#241/ADR-0020 起只做 markdown 解析**）。
//!
//! 边界约定（用户 2026-09-21 裁决，见 spec 边界约定 3）：**整块进 / 整块出**。
//! markdown 流式只喂 split 后的**不稳定尾块**（comrak 无增量 API，尾块已由 split 限界），
//! 禁止每拍全文过界。
//!
//! 出口分层：纯内层（宿主可测）+ `#[wasm_bindgen]` 薄壳（[`wasm_exit`]）。
//! `JsError` 在非 wasm 目标会 panic，可失败逻辑不得写在壳里。
//!
//! 模块：
//!
//! - [`model`]：渲染模型类型，与 TS 基线 `markdownRenderModel.ts` 的
//!   `MarkdownRenderNode` 逐字段同形状（serde JSON 即 parity 比对面）。
//! - [`parser`]：comrak（GFM 扩展）→ 渲染模型。对齐目标是 remark-rehype 的
//!   hast 投影形状，不是 comrak 的 HTML 输出。
//!
//! **代码高亮已不在本 crate**（#241/ADR-0020）：原 `highlight` / `theme` / `tm_language`
//! 三个模块连同 `assets/grammars/*`（14 个 vendored 语法、728KB）与 syntect 依赖一并退役。
//! 理由：那套的语法编译产物占渲染器**可控内存 ~30% 且不可归还**（wasm 线性内存只涨不跌），
//! 首次用到某语言还要同步编译 0.5–1s。高亮改为前端 Lezer
//! （`src/components/chat/lezerHighlight.ts`），`pl-*` 类名与 `--syn-*` 调色板不动。

pub mod model;
pub mod parser;
pub mod wasm_exit;
