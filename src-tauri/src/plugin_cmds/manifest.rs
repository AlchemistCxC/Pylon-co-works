//! pylon-plugin.json 读取与契约校验（D-split 自 plugin_cmds.rs；行为零变化）。
//!
//! 原文件把 manifest 校验内嵌在 store 段；此处按实际职责独立成模块。
//! `MANIFEST` 常量同时被 [`super::install_remote::extract_zip_archive`] 消费
//! （zip 根必须有 manifest）。

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use super::PluginError;

pub(crate) const MANIFEST: &str = "pylon-plugin.json";

pub(crate) fn read_manifest(dir: &Path) -> Result<serde_json::Value, PluginError> {
    let path = dir.join(MANIFEST);
    serde_json::from_str(
        &fs::read_to_string(&path)
            .map_err(|e| PluginError::ManifestInvalid(format!("read {}: {e}", path.display())))?,
    )
    .map_err(|e| PluginError::ManifestInvalid(format!("invalid JSON: {e}")))
}

pub(crate) fn manifest_string<'a>(
    value: &'a serde_json::Value,
    field: &str,
) -> Result<&'a str, PluginError> {
    value
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| PluginError::ManifestInvalid(format!("missing string {field}")))
}

pub(crate) fn manifest_details(
    dir: &Path,
) -> Result<(serde_json::Value, String, String, String), PluginError> {
    let manifest = read_manifest(dir)?;
    for removed in ["trust", "capabilities", "contributes", "signature", "entry"] {
        if manifest.get(removed).is_some() {
            return Err(PluginError::ManifestInvalid(format!(
                "field {removed} was removed from api 1.0"
            )));
        }
    }
    if manifest.get("schema").and_then(|value| value.as_u64()) != Some(1) {
        return Err(PluginError::ManifestInvalid("schema must be 1".into()));
    }
    if manifest.get("api").and_then(|value| value.as_str()) != Some("1.0") {
        return Err(PluginError::ManifestInvalid("api must be 1.0".into()));
    }
    let id = manifest_string(&manifest, "id")?.to_string();
    super::validation::validate_plugin_id(&id)?;
    validate_manifest_contract_shape(&manifest, &id)?;
    if manifest_string(&manifest, "name")?.trim().is_empty() {
        return Err(PluginError::ManifestInvalid(
            "name must not be empty".into(),
        ));
    }
    let version = manifest_string(&manifest, "version")?.to_string();
    if !super::validation::version_regex().is_match(&version) {
        return Err(PluginError::ManifestInvalid(format!(
            "invalid version: {version}"
        )));
    }
    let kind = manifest_string(&manifest, "kind")?;
    if !matches!(
        kind,
        "shell"
            | "workspace"
            | "feature"
            | "hook"
            | "renderer"
            | "skin"
            | "agent-adapter"
            | "tool-provider"
            | "service"
            | "automation"
    ) {
        return Err(PluginError::ManifestInvalid(format!(
            "invalid kind: {kind}"
        )));
    }
    let entry = manifest
        .get("web")
        .and_then(|value| value.get("entry"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| PluginError::ManifestInvalid("missing web.entry".into()))?
        .trim_start_matches("./")
        .to_string();
    super::validation::validate_relative_path(&entry)?;
    if !dir.join(&entry).is_file() {
        return Err(PluginError::ManifestInvalid(format!(
            "entry does not exist: {entry}"
        )));
    }
    Ok((manifest, id, version, entry))
}

fn validate_manifest_contract_shape(
    manifest: &serde_json::Value,
    plugin_id: &str,
) -> Result<(), PluginError> {
    for field in ["dependencies", "optionalDependencies"] {
        let Some(value) = manifest.get(field) else {
            continue;
        };
        let entries = value
            .as_object()
            .ok_or_else(|| PluginError::ManifestInvalid(format!("{field} must be an object")))?;
        for (dependency_id, range) in entries {
            if !super::validation::plugin_id_regex().is_match(dependency_id) {
                return Err(PluginError::ManifestInvalid(format!(
                    "{field}.{dependency_id} has an invalid plugin id"
                )));
            }
            let range = range.as_str().ok_or_else(|| {
                PluginError::ManifestInvalid(format!("{field}.{dependency_id} must be a string"))
            })?;
            if !super::validation::version_range_regex().is_match(range) {
                return Err(PluginError::ManifestInvalid(format!(
                    "{field}.{dependency_id} only supports exact, caret or * ranges"
                )));
            }
        }
    }

    if let Some(value) = manifest.get("conflicts") {
        let conflicts = value
            .as_array()
            .ok_or_else(|| PluginError::ManifestInvalid("conflicts must be an array".into()))?;
        for (index, conflict) in conflicts.iter().enumerate() {
            let conflict = conflict.as_str().ok_or_else(|| {
                PluginError::ManifestInvalid(format!("conflicts.{index} must be a string"))
            })?;
            if !super::validation::plugin_id_regex().is_match(conflict) || conflict == plugin_id {
                return Err(PluginError::ManifestInvalid(format!(
                    "conflicts.{index} must be a valid non-self plugin id"
                )));
            }
        }
    }

    if let Some(value) = manifest.get("activation") {
        let events = value
            .as_object()
            .and_then(|activation| activation.get("events"))
            .and_then(|events| events.as_array())
            .ok_or_else(|| {
                PluginError::ManifestInvalid("activation.events must be an array".into())
            })?;
        let mut unique = BTreeSet::new();
        if events.is_empty()
            || events.iter().any(|value| match value.as_str() {
                Some(event) if !event.trim().is_empty() => !unique.insert(event),
                _ => true,
            })
        {
            return Err(PluginError::ManifestInvalid(
                "activation.events must contain unique non-empty strings".into(),
            ));
        }
    }
    Ok(())
}
