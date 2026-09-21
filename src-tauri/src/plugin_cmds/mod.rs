//! Phase 7 transactional binary plugin package store.
//!
//! `packages/`, `data/`, `runtime/`, `transactions/` and `state.json` are the
//! native source of truth. V2 commands exchange descriptors only; package
//! bytes are copied on disk and served by the `pylon-plugin` URI protocol.
//!
//! D-split（issue #228 批次D）：原单文件 2420 行按职责拆分——
//! - `validation`：id / 版本范围 / 相对路径 / runtime id / package id 校验
//! - `store`：store 布局 ensure、state.json、目录原语与包扫描/描述
//! - `manifest`：pylon-plugin.json 读取与契约校验（清单校验在原文件内嵌于
//!   store 段，按实际职责独立成模块）
//! - `transaction`：安装/回滚/卸载事务（两阶段 stage/commit/abort + recover）
//! - `install_remote`：zip / https URL 安装源（下载、解压、进度事件）
//! - `runtime_cmds`：runtime 目录创建/清理命令
//! - `resource`：`pylon-plugin://` 协议 HTTP 响应与 URL 编解码
//! - `tests`：原 mod tests 原样搬移
//!
//! 纯机械搬移：子模块内原私有项统一 `pub(crate)`（本模块本身私有，可见性对外
//! 不变），mod.rs glob 再导出保证 `crate::plugin_cmds::X` 引用与 lib.rs
//! generate_handler! 路径零改动（`__cmd__*` / `__tauri_command_name_*` 一并随
//! glob 再导出）。

mod install_remote;
mod manifest;
mod resource;
mod runtime_cmds;
mod store;
mod transaction;
mod validation;

#[cfg(test)]
mod tests;

pub(crate) use install_remote::*;
// `manifest` / `validation` 的消费方全在 plugin_cmds 子树内（子模块直接 use
// super::manifest::…），glob 再导出仅为 tests.rs 的 `use super::*` 服务。
#[cfg(test)]
pub(crate) use manifest::*;
pub(crate) use resource::*;
pub(crate) use runtime_cmds::*;
pub(crate) use store::*;
pub(crate) use transaction::*;
#[cfg(test)]
pub(crate) use validation::*;

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub(crate) enum PluginError {
    #[error("plugin not found: {0}")]
    NotFound(String),
    #[error("invalid plugin id: {0}")]
    InvalidId(String),
    #[error("plugin io error: {0}")]
    Io(String),
    #[error("plugin manifest invalid: {0}")]
    ManifestInvalid(String),
    #[error("plugin source invalid: {0}")]
    SourceInvalid(String),
    #[error("plugin state conflict: {0}")]
    StateConflict(String),
    #[error("plugin resource invalid: {0}")]
    ResourceInvalid(String),
    #[error("plugin transaction failed: {0}")]
    Transaction(String),
}

impl PluginError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "plugin_not_found",
            Self::InvalidId(_) => "plugin_invalid_id",
            Self::Io(_) => "plugin_io",
            Self::ManifestInvalid(_) => "plugin_manifest_invalid",
            Self::SourceInvalid(_) => "plugin_source_invalid",
            Self::StateConflict(_) => "plugin_state_conflict",
            Self::ResourceInvalid(_) => "plugin_resource_invalid",
            Self::Transaction(_) => "plugin_transaction_failed",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginFileMetadata {
    pub(crate) path: String,
    pub(crate) size: u64,
    pub(crate) mime: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginPackageDescriptor {
    pub(crate) plugin_id: String,
    pub(crate) version: String,
    pub(crate) package_instance_id: String,
    pub(crate) manifest: serde_json::Value,
    pub(crate) files: Vec<PluginFileMetadata>,
    pub(crate) total_bytes: u64,
    pub(crate) active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstalledPluginPackage {
    pub(crate) package: PluginPackageDescriptor,
    pub(crate) enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginPackageOperationResult {
    pub(crate) operation_id: String,
    pub(crate) package: PluginPackageDescriptor,
    pub(crate) previous_active: Option<String>,
}
