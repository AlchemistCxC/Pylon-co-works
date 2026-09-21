//! 插件包安装/回滚/卸载事务：两阶段 stage/commit/abort + recover 恢复
//! （D-split 自 plugin_cmds.rs；行为零变化）。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::store::{
    copy_binary, data, describe_source, ensure_layout_at, packages, read_state, root, sorted_paths,
    transactions, write_state,
};
use super::validation::validate_plugin_id;
use super::{
    InstalledPluginPackage, PluginError, PluginPackageDescriptor, PluginPackageOperationResult,
};
use crate::error::PylonError;

pub(crate) async fn write_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Journal {
    pub(crate) operation_id: String,
    pub(crate) plugin_id: String,
    pub(crate) package_instance_id: String,
    pub(crate) previous_active: Option<String>,
    #[serde(default = "default_created_package")]
    pub(crate) created_package: bool,
}

fn default_created_package() -> bool {
    true
}

pub(crate) fn operation_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{}-{nanos}", std::process::id())
}

fn journal_path(root: &Path, id: &str) -> PathBuf {
    transactions(root).join(format!("{id}.json"))
}

pub(crate) fn write_journal(root: &Path, journal: &Journal) -> Result<(), PluginError> {
    let json = serde_json::to_string_pretty(journal)
        .map_err(|e| PluginError::Transaction(e.to_string()))?;
    crate::agent_config::write_config_atomically(&journal_path(root, &journal.operation_id), &json)
        .map_err(|e| PluginError::Transaction(e.to_string()))
}

pub(crate) fn recover(root: &Path) -> Result<(), PluginError> {
    if !transactions(root).is_dir() {
        return Ok(());
    }
    let state = read_state(root)?;
    for path in sorted_paths(&transactions(root))? {
        if path.extension().and_then(|v| v.to_str()) == Some("staging") {
            if path.is_dir() {
                fs::remove_dir_all(&path).map_err(|e| PluginError::Transaction(e.to_string()))?;
            }
            continue;
        }
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let journal: Journal = serde_json::from_str(
            &fs::read_to_string(&path).map_err(|e| PluginError::Transaction(e.to_string()))?,
        )
        .map_err(|e| PluginError::Transaction(e.to_string()))?;
        if journal.created_package
            && state.active_versions.get(&journal.plugin_id) != Some(&journal.package_instance_id)
        {
            let target = packages(root)
                .join(&journal.plugin_id)
                .join(&journal.package_instance_id);
            if target.exists() {
                fs::remove_dir_all(target).map_err(|e| PluginError::Transaction(e.to_string()))?;
            }
        }
        fs::remove_file(path).map_err(|e| PluginError::Transaction(e.to_string()))?;
    }
    Ok(())
}

pub(crate) fn describe_installed(
    root: &Path,
    plugin_id: &str,
    package_id: &str,
    active: bool,
) -> Result<PluginPackageDescriptor, PluginError> {
    let dir = packages(root).join(plugin_id).join(package_id);
    if !dir.is_dir() {
        return Err(PluginError::NotFound(package_id.into()));
    }
    let mut descriptor = describe_source(&dir)?;
    if descriptor.plugin_id != plugin_id {
        return Err(PluginError::ManifestInvalid(
            "directory/manifest id mismatch".into(),
        ));
    }
    descriptor.package_instance_id = package_id.into();
    descriptor.active = active;
    Ok(descriptor)
}

pub(crate) fn install_at(
    root: &Path,
    source: &Path,
    expected_id: &str,
) -> Result<PluginPackageOperationResult, PluginError> {
    let staged = stage_at(root, source, expected_id)?;
    match commit_stage_at(root, &staged.operation_id) {
        Ok(result) => Ok(result),
        Err(error) => {
            // 回滚失败不改控制流（原错误继续上抛），但必须留下观测痕迹：
            // 残留的 staging 目录/事务日志会由后续 recover 流程或人工清理。
            if let Err(rollback_error) = abort_stage_at(root, &staged.operation_id) {
                tracing::warn!(
                    operation_id = %staged.operation_id,
                    error = %rollback_error,
                    "plugin stage rollback failed; staging artifacts may remain"
                );
            }
            Err(error)
        }
    }
}

pub(crate) fn stage_at(
    root: &Path,
    source: &Path,
    expected_id: &str,
) -> Result<PluginPackageOperationResult, PluginError> {
    let mut descriptor = describe_source(source)?;
    if descriptor.plugin_id != expected_id {
        return Err(PluginError::ManifestInvalid(format!(
            "manifest.id={} != expectedId={expected_id}",
            descriptor.plugin_id
        )));
    }
    let state = read_state(root)?;
    let previous_active = state.active_versions.get(expected_id).cloned();
    let target = packages(root)
        .join(expected_id)
        .join(&descriptor.package_instance_id);
    let created_package = !target.exists();
    if !created_package {
        descriptor = describe_installed(root, expected_id, &descriptor.package_instance_id, false)?;
    }
    fs::create_dir_all(target.parent().unwrap()).map_err(|e| PluginError::Io(e.to_string()))?;
    fs::create_dir_all(data(root).join(expected_id)).map_err(|e| PluginError::Io(e.to_string()))?;
    let op = operation_id("stage");
    let staging = transactions(root).join(format!("{op}.staging"));
    write_journal(
        root,
        &Journal {
            operation_id: op.clone(),
            plugin_id: expected_id.into(),
            package_instance_id: descriptor.package_instance_id.clone(),
            previous_active: previous_active.clone(),
            created_package,
        },
    )?;
    if created_package {
        let result = (|| {
            copy_binary(source, &staging)?;
            if describe_source(&staging)?.package_instance_id != descriptor.package_instance_id {
                return Err(PluginError::Transaction(
                    "source changed during copy".into(),
                ));
            }
            fs::rename(&staging, &target).map_err(|e| PluginError::Transaction(e.to_string()))
        })();
        if let Err(error) = result {
            // 清理失败不改控制流（原错误继续上抛），仅告警留痕：残留路径
            // 交由下次 stage 的 overwrite 或人工清理处理。
            if let Err(remove_error) = fs::remove_dir_all(&staging) {
                tracing::warn!(
                    operation_id = %op,
                    path = %staging.display(),
                    error = %remove_error,
                    "plugin staging cleanup failed"
                );
            }
            if let Err(remove_error) = fs::remove_dir_all(&target) {
                tracing::warn!(
                    operation_id = %op,
                    path = %target.display(),
                    error = %remove_error,
                    "plugin staging cleanup failed"
                );
            }
            let journal = journal_path(root, &op);
            if let Err(remove_error) = fs::remove_file(&journal) {
                tracing::warn!(
                    operation_id = %op,
                    path = %journal.display(),
                    error = %remove_error,
                    "plugin staging cleanup failed"
                );
            }
            return Err(error);
        }
    }
    descriptor.active = previous_active.as_deref() == Some(&descriptor.package_instance_id);
    Ok(PluginPackageOperationResult {
        operation_id: op,
        package: descriptor,
        previous_active,
    })
}

fn read_journal(root: &Path, operation_id: &str) -> Result<Journal, PluginError> {
    let path = journal_path(root, operation_id);
    let source =
        fs::read_to_string(&path).map_err(|_| PluginError::NotFound(operation_id.into()))?;
    serde_json::from_str(&source).map_err(|e| PluginError::Transaction(e.to_string()))
}

pub(crate) fn commit_stage_at(
    root: &Path,
    operation_id: &str,
) -> Result<PluginPackageOperationResult, PluginError> {
    let journal = read_journal(root, operation_id)?;
    let mut state = read_state(root)?;
    if state.active_versions.get(&journal.plugin_id) != journal.previous_active.as_ref() {
        return Err(PluginError::StateConflict(format!(
            "active pointer changed during transaction: {}",
            journal.plugin_id
        )));
    }
    let mut descriptor = describe_installed(
        root,
        &journal.plugin_id,
        &journal.package_instance_id,
        false,
    )?;
    state.active_versions.insert(
        journal.plugin_id.clone(),
        journal.package_instance_id.clone(),
    );
    let history = state
        .package_history
        .entry(journal.plugin_id.clone())
        .or_default();
    history.retain(|id| id != &journal.package_instance_id);
    history.push(journal.package_instance_id.clone());
    write_state(root, &state)?;
    fs::remove_file(journal_path(root, operation_id))
        .map_err(|e| PluginError::Transaction(e.to_string()))?;
    descriptor.active = true;
    Ok(PluginPackageOperationResult {
        operation_id: operation_id.into(),
        package: descriptor,
        previous_active: journal.previous_active,
    })
}

pub(crate) fn abort_stage_at(root: &Path, operation_id: &str) -> Result<(), PluginError> {
    let journal = read_journal(root, operation_id)?;
    let state = read_state(root)?;
    if state.active_versions.get(&journal.plugin_id) == Some(&journal.package_instance_id) {
        return Err(PluginError::StateConflict(format!(
            "cannot abort committed package: {}",
            journal.package_instance_id
        )));
    }
    let staging = transactions(root).join(format!("{operation_id}.staging"));
    if staging.exists() {
        fs::remove_dir_all(staging).map_err(|e| PluginError::Transaction(e.to_string()))?;
    }
    if journal.created_package {
        let target = packages(root)
            .join(&journal.plugin_id)
            .join(&journal.package_instance_id);
        if target.exists() {
            fs::remove_dir_all(target).map_err(|e| PluginError::Transaction(e.to_string()))?;
        }
    }
    fs::remove_file(journal_path(root, operation_id))
        .map_err(|e| PluginError::Transaction(e.to_string()))
}

#[tauri::command]
pub(crate) async fn plugin_package_install(
    app: AppHandle,
    source_path: String,
    expected_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    validate_plugin_id(&expected_id)?;
    let source = PathBuf::from(source_path);
    if !source.is_absolute() || !source.is_dir() {
        return Err(PluginError::SourceInvalid(
            "sourcePath must be an existing absolute directory".into(),
        )
        .into());
    }
    let _guard = write_lock().await;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    Ok(install_at(&root, &source, &expected_id)?)
}

#[tauri::command]
pub(crate) async fn plugin_package_update(
    app: AppHandle,
    source_path: String,
    expected_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    plugin_package_install(app, source_path, expected_id).await
}

#[tauri::command]
pub(crate) async fn plugin_package_stage(
    app: AppHandle,
    source_path: String,
    expected_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    validate_plugin_id(&expected_id)?;
    let source = PathBuf::from(source_path);
    if !source.is_absolute() || !source.is_dir() {
        return Err(PluginError::SourceInvalid(
            "sourcePath must be an existing absolute directory".into(),
        )
        .into());
    }
    let _guard = write_lock().await;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    Ok(stage_at(&root, &source, &expected_id)?)
}

#[tauri::command]
pub(crate) async fn plugin_package_stage_commit(
    app: AppHandle,
    operation_id: String,
) -> Result<PluginPackageOperationResult, PylonError> {
    let _guard = write_lock().await;
    Ok(commit_stage_at(&root(&app)?, &operation_id)?)
}

#[tauri::command]
pub(crate) async fn plugin_package_stage_abort(
    app: AppHandle,
    operation_id: String,
) -> Result<(), PylonError> {
    let _guard = write_lock().await;
    Ok(abort_stage_at(&root(&app)?, &operation_id)?)
}

#[tauri::command]
pub(crate) async fn plugin_package_versions(
    app: AppHandle,
    plugin_id: String,
) -> Result<Vec<PluginPackageDescriptor>, PylonError> {
    validate_plugin_id(&plugin_id)?;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    let state = read_state(&root)?;
    let dir = packages(&root).join(&plugin_id);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for path in sorted_paths(&dir)? {
        if !path.is_dir() {
            continue;
        }
        let package_id = path
            .file_name()
            .and_then(|v| v.to_str())
            .ok_or_else(|| PluginError::SourceInvalid("non-UTF-8 package id".into()))?;
        result.push(describe_installed(
            &root,
            &plugin_id,
            package_id,
            state.active_versions.get(&plugin_id).map(String::as_str) == Some(package_id),
        )?);
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn plugin_package_list(
    app: AppHandle,
) -> Result<Vec<InstalledPluginPackage>, PylonError> {
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    Ok(list_installed_at(&root)?)
}

pub(crate) fn list_installed_at(root: &Path) -> Result<Vec<InstalledPluginPackage>, PluginError> {
    let state = read_state(root)?;
    let mut result = Vec::new();
    for (plugin_id, package_instance_id) in &state.active_versions {
        result.push(InstalledPluginPackage {
            package: describe_installed(root, plugin_id, package_instance_id, true)?,
            enabled: !state.disabled.contains(plugin_id),
        });
    }
    Ok(result)
}

#[tauri::command]
pub(crate) async fn plugin_package_set_enabled(
    app: AppHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<(), PylonError> {
    validate_plugin_id(&plugin_id)?;
    let _guard = write_lock().await;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    set_enabled_at(&root, &plugin_id, enabled)?;
    Ok(())
}

pub(crate) fn set_enabled_at(
    root: &Path,
    plugin_id: &str,
    enabled: bool,
) -> Result<(), PluginError> {
    validate_plugin_id(plugin_id)?;
    let mut state = read_state(root)?;
    if !state.active_versions.contains_key(plugin_id) {
        return Err(PluginError::NotFound(plugin_id.into()));
    }
    if enabled {
        state.disabled.retain(|id| id != plugin_id);
    } else if !state.disabled.iter().any(|id| id == plugin_id) {
        state.disabled.push(plugin_id.into());
    }
    write_state(root, &state)?;
    Ok(())
}

pub(crate) fn rollback_at(
    root: &Path,
    plugin_id: String,
    package_instance_id: Option<String>,
) -> Result<PluginPackageOperationResult, PluginError> {
    validate_plugin_id(&plugin_id)?;
    let mut state = read_state(root)?;
    let previous_active = state
        .active_versions
        .get(&plugin_id)
        .cloned()
        .ok_or_else(|| PluginError::NotFound(plugin_id.clone()))?;
    let target = package_instance_id.unwrap_or_else(|| {
        state
            .package_history
            .get(&plugin_id)
            .and_then(|history| history.iter().rev().find(|id| *id != &previous_active))
            .cloned()
            .unwrap_or_default()
    });
    if target.is_empty() {
        return Err(PluginError::StateConflict(
            "no previous package to roll back to".into(),
        ));
    }
    let mut descriptor = describe_installed(root, &plugin_id, &target, false)?;
    let op = operation_id("rollback");
    state
        .active_versions
        .insert(plugin_id.clone(), target.clone());
    let history = state.package_history.entry(plugin_id).or_default();
    history.retain(|id| id != &target);
    history.push(target);
    write_state(root, &state)?;
    descriptor.active = true;
    Ok(PluginPackageOperationResult {
        operation_id: op,
        package: descriptor,
        previous_active: Some(previous_active),
    })
}

#[tauri::command]
pub(crate) async fn plugin_package_rollback(
    app: AppHandle,
    plugin_id: String,
    package_instance_id: Option<String>,
) -> Result<PluginPackageOperationResult, PylonError> {
    let _guard = write_lock().await;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    Ok(rollback_at(&root, plugin_id, package_instance_id)?)
}

pub(crate) fn uninstall_at(
    root: &Path,
    plugin_id: &str,
    purge_data: bool,
) -> Result<(), PluginError> {
    let package_dir = packages(root).join(plugin_id);
    if !package_dir.exists() {
        return Err(PluginError::NotFound(plugin_id.into()));
    }
    fs::remove_dir_all(&package_dir).map_err(|e| PluginError::Io(e.to_string()))?;
    if purge_data {
        let data_dir = data(root).join(plugin_id);
        if data_dir.exists() {
            fs::remove_dir_all(data_dir).map_err(|e| PluginError::Io(e.to_string()))?;
        }
    }
    let mut state = read_state(root)?;
    state.active_versions.remove(plugin_id);
    state.package_history.remove(plugin_id);
    state.disabled.retain(|id| id != plugin_id);
    write_state(root, &state)
}

#[tauri::command]
pub(crate) async fn plugin_package_uninstall(
    app: AppHandle,
    plugin_id: String,
    purge_data: bool,
) -> Result<(), PylonError> {
    validate_plugin_id(&plugin_id)?;
    let _guard = write_lock().await;
    uninstall_at(&root(&app)?, &plugin_id, purge_data)?;
    Ok(())
}
