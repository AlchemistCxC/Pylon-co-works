//! 插件 runtime 目录创建/清理命令（D-split 自 plugin_cmds.rs；行为零变化）。

use std::fs;
use std::path::Path;

use tauri::AppHandle;

use super::store::{ensure_layout_at, root, runtime};
use super::validation::validate_runtime_id;
use super::PluginError;
use crate::error::PylonError;

#[tauri::command]
pub(crate) async fn plugin_runtime_create(
    app: AppHandle,
    runtime_instance_id: String,
) -> Result<(), PylonError> {
    validate_runtime_id(&runtime_instance_id)?;
    let root = root(&app)?;
    ensure_layout_at(&root)?;
    create_runtime_at(&root, &runtime_instance_id)?;
    Ok(())
}

#[tauri::command]
pub(crate) async fn plugin_runtime_cleanup(
    app: AppHandle,
    runtime_instance_id: String,
) -> Result<(), PylonError> {
    validate_runtime_id(&runtime_instance_id)?;
    cleanup_runtime_at(&root(&app)?, &runtime_instance_id)?;
    Ok(())
}

pub(crate) fn create_runtime_at(root: &Path, runtime_instance_id: &str) -> Result<(), PluginError> {
    validate_runtime_id(runtime_instance_id)?;
    fs::create_dir(runtime(root).join(runtime_instance_id))
        .map_err(|e| PluginError::Io(e.to_string()))
}

pub(crate) fn cleanup_runtime_at(
    root: &Path,
    runtime_instance_id: &str,
) -> Result<(), PluginError> {
    validate_runtime_id(runtime_instance_id)?;
    let path = runtime(root).join(runtime_instance_id);
    if path.exists() {
        fs::remove_dir_all(path).map_err(|e| PluginError::Io(e.to_string()))?;
    }
    Ok(())
}
