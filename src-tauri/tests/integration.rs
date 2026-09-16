//! #106 P5：集成测试单 target（harness 即门面）。
//!
//! 迁入顺序（spec P5）：b10_gateway → auto_reconnect → b11_inject → model_switch。
//! 消费产品只经 `prism_desktop_lib::test_harness` 门面（#[doc(hidden)] pub）——
//! AppState / command 函数可见性零新增；断言逐条保持（验收 8/13）。
//!
//! 运行：`cargo test --workspace --tests --features test-agent`
//! 前置：`cargo build --bin pylon-fake-agent --features test-agent`
//! （bin 经 current_exe 祖先目录定位，见 test_utils::fake_agent_bin）。

mod auto_reconnect;
mod b10_gateway;
mod b11_inject;
mod issue110_establishment;
mod model_switch;
