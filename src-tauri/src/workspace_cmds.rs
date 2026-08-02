//! 工作区/Git 只读命令（R1 拆分自 lib.rs；行为零变化）。

use crate::error::PylonError;
use crate::git;
use crate::workspace;
use crate::AppState;

#[tauri::command]
pub(crate) async fn get_workspace_root(
    state: tauri::State<'_, AppState>,
    source: String,
) -> Result<workspace::WorkspaceRoot, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let root = state.inner().workspace_root_for_source(&runtime, &source)?;
    Ok(workspace::workspace_root(
        source,
        std::path::Path::new(&root),
    ))
}

#[tauri::command]
pub(crate) async fn list_workspace_entries(
    state: tauri::State<'_, AppState>,
    source: String,
    relative_path: Option<String>,
    include_hidden: Option<bool>,
) -> Result<Vec<workspace::WorkspaceEntry>, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let root = state.inner().workspace_root_for_source(&runtime, &source)?;
    workspace::list_entries(
        std::path::Path::new(&root),
        relative_path.as_deref().unwrap_or("."),
        include_hidden.unwrap_or(false),
    )
    .map_err(|e| PylonError::Workspace(e.to_string()))
}

#[tauri::command]
pub(crate) async fn read_workspace_text(
    state: tauri::State<'_, AppState>,
    source: String,
    relative_path: String,
    max_bytes: Option<usize>,
) -> Result<workspace::WorkspaceTextPreview, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let root = state.inner().workspace_root_for_source(&runtime, &source)?;
    workspace::read_text(std::path::Path::new(&root), &relative_path, max_bytes)
        .map_err(|e| PylonError::Workspace(e.to_string()))
}

/// B5：解析 source 对应的 git 工作区 root（会话 cwd，失败回退 active agent cwd）。
/// 只读操作；非 git 仓库 / git 不可用 → PylonError::Git（code=git_error）。
pub(crate) fn git_workspace_root(
    state: &AppState,
    source: &str,
) -> Result<std::path::PathBuf, PylonError> {
    // A10（2026-08-02）：git 只读命令统一 git_error 契约——无 active agent 也报
    // git_error（前端对 git 面板按 git_error 分支），不泄出 no_active_agent。
    let runtime = state
        .require_runtime()
        .map_err(|error| PylonError::Git(error.to_string()))?;
    let root = state
        .workspace_root_for_source(&runtime, source)
        .or_else(|_| Ok::<String, String>(state.agent_cwd()))
        .map_err(PylonError::Git)?;
    Ok(std::path::PathBuf::from(root))
}

#[tauri::command]
pub(crate) async fn git_status(
    state: tauri::State<'_, AppState>,
    source: String,
) -> Result<Vec<git::GitStatusEntry>, PylonError> {
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
    git::git_diff(&root, path.as_deref(), staged.unwrap_or(false))
        .await
        .map_err(PylonError::Git)
}

#[tauri::command]
pub(crate) async fn git_history(
    state: tauri::State<'_, AppState>,
    source: String,
    limit: Option<usize>,
) -> Result<Vec<git::GitCommit>, PylonError> {
    let root = git_workspace_root(state.inner(), &source)?;
    git::git_history(&root, limit)
        .await
        .map_err(PylonError::Git)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A10：git 只读命令保持 git_error 契约——无 active agent 也报 git_error，
    /// 不泄出 no_active_agent（前端 git 面板按 git_error 分支）。
    #[test]
    fn git_workspace_root_without_active_agent_reports_git_error() {
        let state = AppState {
            runtimes: std::sync::Arc::new(crate::runtime::AgentRuntimeManager::new()),
            agents: std::sync::Arc::new(Mutex::new(std::collections::HashMap::new())),
            active_agent: std::sync::Arc::new(Mutex::new("ghost-agent".to_string())),
            pet: std::sync::Arc::new(Mutex::new(crate::pet::PetState::default())),
            runtime_logs: crate::runtime_log::RuntimeLogHub::default(),
            runtime_mcp: Mutex::new(None),
            prism: crate::prism::PrismClient::unavailable("test".to_string()),
            gateway: std::sync::Arc::new(crate::gateway::GatewayCore::new()),
            approval_mode: std::sync::Arc::new(Mutex::new("default".to_string())),
            pet_last_persist_ms: std::sync::atomic::AtomicU64::new(0),
            pet_write_lock: tokio::sync::Mutex::new(()),
            switch_lock: tokio::sync::Mutex::new(()),
            mcp_write_lock: tokio::sync::Mutex::new(()),
        };
        match git_workspace_root(&state, "source-a") {
            Ok(_) => panic!("git_workspace_root must fail without an active agent"),
            Err(error) => {
                assert_eq!(error.code(), "git_error");
                assert!(
                    error.to_string().contains("no active agent"),
                    "message should preserve the underlying cause: {error}"
                );
            }
        }
    }
}
