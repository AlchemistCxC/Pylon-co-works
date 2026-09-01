//! Agent 配置领域（agents.yaml 解析/校验/原子写/补丁 API）。
//!
//! D-split：原单文件 3177 行按自然接缝拆分——
//! - `types`：错误/结构体/默认值/校验（ConfigError、AgentDef、AcpProtocolConfig…）
//! - `atomic_write`：配置文件原子事务（ConfigLease/fsync/临时文件/替换备份）
//! - `load`：加载与解析（load/parse/ConfigDocument/load_app_config）
//! - `patch`：补丁与变更 API（apply_agent_patch/apply_agent_create/…）
//! - `tests`：领域测试（原 mod tests 原样搬移）
//!
//! 拆分为纯机械搬移：子模块内原私有项统一 `pub(crate)`（本模块本身私有，
//! 可见性对外不变），mod.rs glob 再导出保证 `crate::agent_config::X` 引用零改动。

mod atomic_write;
mod load;
mod patch;
mod types;

#[cfg(test)]
mod tests;

pub(crate) use atomic_write::*;
pub(crate) use load::*;
pub(crate) use patch::*;
pub(crate) use types::*;
