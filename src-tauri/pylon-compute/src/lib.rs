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
//! 模块：
//!
//! - [`canonical`]：canonical 事件词表、wire 判别符映射与 identity 推导。它直接
//!   复用 `pylon-canonical-types`（WP1 的单源），因此 TS 侧生成物、`src-tauri` 的
//!   写入侧与这里的投影侧读的是同一份词表。
//!
//! 迁移期纪律（issue #220）：WP2 起计算核与 TS 基线**只允许作为差分校验并存**，
//! parity 绿后 TS 实现退役；本 crate 不保留「和 TS 不一样的第二套语义」。

pub mod canonical;
