//! WP2（projector 层）：内容部件解析/聚合、span 占用与工作台文档折叠。
//!
//! TS 基线（逐函数对齐，不是重新设计）：
//!
//! - [`content_part`] ← `src/domains/workbench/content/contentPartSchema.ts`
//!   （内容部件解析 + 相邻聚合 + unknown 兜底）
//! - [`coverage`] ← `workbenchProjector.ts` 内的 `coverageSpanOf` / `isSpanCovered` /
//!   `mergeCoverage` / `mergeCoverageInPlace` 家族（ADR-0016 的 span 占用语义；
//!   `src/domains/workbench/coverage/` 目录是 provider 覆盖审计矩阵（静态清单），
//!   不是投影计算，不在计算核范围）
//! - [`workbench`] ← `workbenchProjector.ts` 的折叠主干（document 状态机 +
//!   `append(batch)` 批量入口 + 边界 patch DTO）
//!
//! # 分层与边界（沿 WP1 钉死的纪律）
//!
//! 纯内层是普通 Rust 函数/类型（宿主可测）；`#[wasm_bindgen]` 薄壳只做值/错误
//! 转换。`JsError::new` 在非 wasm 目标会 panic，可失败逻辑一律不进壳。
//!
//! # 热边界约定（spec「编组格式」节）
//!
//! - 事件类型过界传 **u32 词表索引**（[`workbench::WORKBENCH_EVENT_TYPES`]，前 43 项
//!   顺序即 TS `WORKBENCH_SEMANTIC_EVENT_TYPES`，末尾追加 `event.unknown` /
//!   `extension.event` 两个 schema 类型；两侧由 parity 测试钉死）。
//! - 批量入口是 `append(batch)`（二进制帧），回放按页合批，不做逐事件 append 循环。
//! - 热路径（message/reasoning delta）走定长头 + 字串池的文本通道，**零 serde_json**；
//!   冷事件（tool/diagnostic 等低频富载荷）允许整块 JSON 进池，Rust 侧一次性解析。
//! - 边界输出走增量 patch（[`workbench::WorkbenchPatch`]），不是全量 WorkbenchDocument。
//!
//! # 未移植（fail-closed，见交付说明）
//!
//! `activity.*` / `usage.updated` / `budget.warning` / `plan.*` / `goal.*` /
//! `lifecycle.*` / `assist.*` / `extension.event` 以及 session 事件的
//! `commands` / `options` / `usage` 字段：这些归约器依赖 goalModel / lifecycleModel /
//! sessionSurface 等未迁移的 domain 模型。折叠核遇到它们时**报错拒绝**而不是静默
//! 丢弃或另写一套语义——迁移期宁可红也不许与 TS 基线分叉。

pub mod content_part;
pub mod coverage;
pub mod workbench;
