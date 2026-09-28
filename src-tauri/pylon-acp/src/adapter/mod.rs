//! 适配层残件：permission_wire 是官方审批 wire 解析正身（宿主
//! protocol_adapter 委托消费）。provider 方言信封（private_ext 与其超时裁决
//! 表 interaction_bridge）已随 #424 迁宿主 `src-tauri/src/protocol_adapter/`——
//! 引擎 crate 不再携带 vendor 方言。
pub mod permission_wire;
