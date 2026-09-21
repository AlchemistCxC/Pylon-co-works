//! id / 版本 / 路径校验原语（D-split 自 plugin_cmds.rs；行为零变化）。
//!
//! `split_package_id` 原文件位于 resource 段，但其本质是 package id 解析校验，
//! 按实际职责归入本模块。

use std::path::{Component, Path};
use std::sync::OnceLock;

use regex::Regex;

use super::PluginError;

pub(crate) fn plugin_id_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9]+(?:[.-][a-z0-9]+)*$").unwrap())
}

pub(crate) fn version_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[0-9A-Za-z]+(?:[.+-][0-9A-Za-z]+)*$").unwrap())
}

pub(crate) fn version_range_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^(?:\*|\^?[0-9]+\.[0-9]+\.[0-9]+)$").unwrap())
}

pub(crate) fn validate_plugin_id(id: &str) -> Result<(), PluginError> {
    plugin_id_regex()
        .is_match(id)
        .then_some(())
        .ok_or_else(|| PluginError::InvalidId(id.into()))
}

pub(crate) fn validate_relative_path(value: &str) -> Result<(), PluginError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.contains('\\')
        || value.contains('\0')
        || path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        Err(PluginError::SourceInvalid(format!(
            "invalid package path: {value}"
        )))
    } else {
        Ok(())
    }
}

pub(crate) fn validate_runtime_id(id: &str) -> Result<(), PluginError> {
    if id.is_empty()
        || id.len() > 240
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.contains('\0')
    {
        Err(PluginError::ResourceInvalid(format!(
            "invalid runtime id: {id}"
        )))
    } else {
        Ok(())
    }
}

/// 从 `{plugin_id}@{instance_suffix}` 形态的 package id 中解析 plugin id。
pub(crate) fn split_package_id(id: &str) -> Result<&str, PluginError> {
    let (plugin_id, suffix) = id
        .split_once('@')
        .ok_or_else(|| PluginError::ResourceInvalid(format!("invalid package id: {id}")))?;
    validate_plugin_id(plugin_id)?;
    if suffix.is_empty()
        || suffix.contains('/')
        || suffix.contains('\\')
        || suffix.contains("..")
        || suffix.contains('\0')
    {
        return Err(PluginError::ResourceInvalid(format!(
            "invalid package id: {id}"
        )));
    }
    Ok(plugin_id)
}
