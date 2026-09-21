//! Pylon 前端计算核（Rust/WASM）——issue #220。
//!
//! 目标形态是 **JS 编排 + WASM 计算核 + Solid DOM 消费层**：本 crate 承担「计算」，
//! 不承担编排（调 store、读时钟、发 IPC、管持久化）与 DOM。硬约束：
//!
//! - **纯函数 / 纯状态**：不读时钟、不读 store、不读 registry、不做 IO。需要时间时
//!   由 JS 侧把 `now` 传进来（揭示预算引擎的 `tick(now)` 即此形态）。
//! - **不发明活性判定**：在途回合的权威在运行时内核（ADR-0017）。计算核只做折叠，
//!   不对「这个会话是否在途」表态。
//! - **浏览器预览可加载**：不依赖 Tauri/宿主能力，mock 数据路径与桌面路径跑同一份核。
//!
//! # scope（2026-09-21 收窄）
//!
//! 本 crate 现在**只保留流式**（[`streaming`]：切分 + 揭示预算引擎）。
//! `canonical` / `events` / `projector` 三个模块随投影与 events 层的**回退**删除。
//! 判决与基准依据见 ADR-0018 的 scope 修订，一句话版：
//!
//! - **投影**：wasm 在现实入口（mixed flow）1.12×、页级 1.92×，而合成 delta 形 6.75× 的
//!   根因是 Rust 折叠本体比 TS 整条管线慢数倍/事件（数据模型问题，非边界问题）。更关键的
//!   是文档必须在计算核里与 JS 里**各存一份**，同 workload 持有成本实测 4.4–6.1×，任何微
//!   优化都碰不到它。**净负收益 ⇒ 回退 TS**
//!   （`src/domains/workbench/workbenchProjector.ts`）。
//! - **events 层**：wasm 出口比它要替换的 TS 慢 **9–71×**（逐事件 `serde_wasm_bindgen`
//!   双向往返），且**从未接线**（`canonicalEventSink.ts` 一直用 TS）——把迁移做完等于主动
//!   引进回退，故删 Rust 侧、保留跑着的 TS。
//! - **canonical 词表**未受影响：仍由 `pylon-canonical-types` 单源 →
//!   `scripts/generate-canonical-event-types.mjs` 生成 TS 词表。那是**代码生成**机制，
//!   与 wasm 无关。
//!
//! 保留 wasm 的判据是「同形状对照里真的赢」：markdown 流式形 12–25×、流式切分大输入
//! 2–3×、揭示预算 burst 档 0.6–0.9×。

pub mod streaming;
