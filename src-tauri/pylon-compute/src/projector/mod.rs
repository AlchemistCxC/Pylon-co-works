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
//! - [`session_surface`] ← `session/sessionSurface.ts` 的 usage/budget/commands/options
//!   归一化 + `infrastructure/acp/chatContracts.ts` 的 wire extract 家族
//! - [`goal_model`] ← `plan/goalModel.ts`（C08 plan/goal 状态机）
//! - [`lifecycle_model`] ← `lifecycle/lifecycleModel.ts` 的 `applyLifecycleEvent`
//!   （C13 生命周期状态机；`normalizeNormalizedError` 落在 [`workbench`]）
//! - [`event_schema`] ← `events/workbenchEventSchema.ts` 的 envelope 构造/迁移/解析
//!   与 canonical→semantic 投影注册表（journal 读缝，含 fnv1a eventId 派生）
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
//!   冷事件（tool/diagnostic/usage 等低频富载荷）允许整块 JSON 进池，Rust 侧一次性解析。
//! - 边界输出走增量 patch（[`workbench::WorkbenchPatch`]），不是全量 WorkbenchDocument。

pub mod content_part;
pub mod coverage;
pub mod event_schema;
pub mod goal_model;
pub mod lifecycle_model;
pub mod session_surface;
pub mod workbench;
