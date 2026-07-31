//! Gateway：平台适配器层（B10）。
//!
//! 消息拓扑：平台(qq/微信/飞书/ins) → gateway → ACP → 本地 agent。
//! 本模块由主控预建骨架；各子模块由 BE-B10 系列任务完善。

pub mod qq;
pub mod route;
pub mod truncate;
