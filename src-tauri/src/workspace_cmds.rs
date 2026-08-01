//! 工作区/Git 只读命令（R1 拆分自 lib.rs；行为零变化）。

use crate::error::PylonError;
use crate::git;
use crate::workspace;
use crate::AppState;

#[tauri::command]
pub(crate) async fn get_workspace_root(state: tauri::State<'_, AppState>, source: String) -> Result<workspace::WorkspaceRoot, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let root = state.inner().workspace_root_for_source(&runtime, &source)?;
    Ok(workspace::workspace_root(source, std::path::Path::new(&root)))
}

#[tauri::command]
pub(crate) async fn list_workspace_entries(
    state: tauri::State<'_, AppState>, source: String, relative_path: Option<String>, include_hidden: Option<bool>,
) -> Result<Vec<workspace::WorkspaceEntry>, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let root = state.inner().workspace_root_for_source(&runtime, &source)?;
    workspace::list_entries(std::path::Path::new(&root), relative_path.as_deref().unwrap_or("."), include_hidden.unwrap_or(false)).map_err(|e| PylonError::Workspace(e.to_string()))
}

#[tauri::command]
pub(crate) async fn read_workspace_text(
    state: tauri::State<'_, AppState>, source: String, relative_path: String, max_bytes: Option<usize>,
) -> Result<workspace::WorkspaceTextPreview, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let root = state.inner().workspace_root_for_source(&runtime, &source)?;
    workspace::read_text(std::path::Path::new(&root), &relative_path, max_bytes).map_err(|e| PylonError::Workspace(e.to_string()))
}

/// B5：解析 source 对应的 git 工作区 root（会话 cwd，失败回退 active agent cwd）。
/// 只读操作；非 git 仓库 / git 不可用 → PylonError::Git（code=git_error）。
pub(crate) fn git_workspace_root(state: &AppState, source: &str) -> Result<std::path::PathBuf, PylonError> {
    let runtime = state.require_runtime()?;
    let root = state.workspace_root_for_source(&runtime, source)
        .or_else(|_| Ok::<String, String>(state.agent_cwd()))
        .map_err(PylonError::Git)?;
    Ok(std::path::PathBuf::from(root))
}

#[tauri::command]
pub(crate) async fn git_status(state: tauri::State<'_, AppState>, source: String) -> Result<Vec<git::GitStatusEntry>, PylonError> {
    let root = git_workspace_root(state.inner(), &source)?;
    git::git_status(&root).await.map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_diff(
    state: tauri::State<'_, AppState>,
    source: String,
    path: Option<String>,
    staged: Option<bool>,
) -> Result<String, PylonError> {
    let root = git_workspace_root(state.inner(), &source)?;
    git::git_diff(&root, path.as_deref(), staged.unwrap_or(false)).await.map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_history(
    state: tauri::State<'_, AppState>,
    source: String,
    limit: Option<usize>,
) -> Result<Vec<git::GitCommit>, PylonError> {
    let root = git_workspace_root(state.inner(), &source)?;
    git::git_history(&root, limit).await.map_err(PylonError::Git)
}
