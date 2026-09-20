//! WP4（issue #220）：markdown 引擎与代码高亮换代。
//!
//! 边界约定（用户 2026-09-21 裁决，见 spec 边界约定 3）：**整块进 / 整块（或行数组）出**。
//! 逐行过界 = 每块几百次小调用，禁止；markdown 流式只喂 split 后的**不稳定尾块**
//! （comrak/pulldown 无增量 API，尾块已由 split 限界），禁止每拍全文过界。
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
//! - [`highlight`]：syntect（`fancy-regex` 后端，无 onig C 依赖）整块高亮，
//!   产 scope 栈 + 主题样式的行数组 span。
//!
//! 迁移期纪律：TS 基线与本 crate 只允许作为 parity 差分并存（差异清单见
//! `parity/` 与 vitest `markdownComputeParity.test.ts`），parity 绿后 TS 退役。

pub mod highlight;
pub mod model;
pub mod parser;
pub mod wasm_exit;
