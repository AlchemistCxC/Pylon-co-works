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

/// Phase 1：工作区全文行匹配（后端施工计划书 §3）。
/// source 绑定 runtime 会话（workspace_root_for_source，缺失 session_not_found）；
/// 同步遍历放 spawn_blocking（意见稿 §2.1：大文件扫描不得阻塞 async 运行时）；
/// 硬上限（结果 200 / 扫描文件 400 / 单文件 256KB / 单行 500 字符）。
#[tauri::command]
pub(crate) async fn workspace_search(
    state: tauri::State<'_, AppState>,
    source: String,
    query: String,
    max_results: Option<usize>,
) -> Result<Vec<workspace::WorkspaceSearchResult>, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let root = state.inner().workspace_root_for_source(&runtime, &source)?;
    let limits = workspace::default_search_limits(max_results);
    let root_path = std::path::PathBuf::from(root);
    let found = tokio::task::spawn_blocking(move || workspace::search(&root_path, &query, limits))
        .await
        .map_err(|e| PylonError::Workspace(e.to_string()))?
        .map_err(|e| PylonError::Workspace(e.to_string()))?;
    Ok(found)
}

/// B5：解析 source 对应的 git 工作区 root（会话 cwd）。
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
        .map_err(|error| PylonError::Git(error.to_string()))?;
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

    /// A10：git 只读命令保持 git_error 契约——无 active agent 也报 git_error，
    /// 不泄出 no_active_agent（前端 git 面板按 git_error 分支）。
    #[test]
    fn git_workspace_root_without_active_agent_reports_git_error() {
        let state = crate::test_utils::TestStateBuilder::bare().build();
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

    #[test]
    fn git_workspace_root_rejects_missing_source_in_active_runtime() {
        let mut agent = crate::test_utils::fake_acp_agent("agent-a", "");
        agent.cwd = Some("fallback-cwd-must-not-be-used".to_string());
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("agent-a")
            .with_agent(agent)
            .with_runtime("agent-a", crate::runtime::AgentRuntime::new_disconnected())
            .build();

        let error = git_workspace_root(&state, "same-source-on-another-agent")
            .expect_err("未知 source 必须显式失败，不能回退 active agent cwd");
        assert_eq!(error.code(), "git_error");
        assert!(!error.to_string().contains("fallback-cwd-must-not-be-used"));
    }

    #[test]
    fn workspace_context_rejects_source_from_another_agent_runtime() {
        let mut agent_a = crate::test_utils::fake_acp_agent("agent-a", "");
        agent_a.cwd = Some("agent-a-cwd".to_string());
        let mut agent_b = crate::test_utils::fake_acp_agent("agent-b", "");
        agent_b.cwd = Some("agent-b-cwd".to_string());
        let runtime_a = crate::runtime::AgentRuntime::new_disconnected();
        runtime_a.sessions.lock().unwrap().insert(
            "shared-source".to_string(),
            crate::session::SessionInfo::new(
                "peri-a".to_string(),
                String::new(),
                "agent-a-workspace".to_string(),
                false,
                0,
            ),
        );
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("agent-a")
            .with_agent(agent_a)
            .with_agent(agent_b)
            .with_runtime("agent-a", runtime_a.clone())
            .with_runtime("agent-b", crate::runtime::AgentRuntime::new_disconnected())
            .build();

        let context = crate::runtime::AgentContextKey::new("agent-b", "shared-source");
        let error = state
            .workspace_root_for_context(&runtime_a, &context)
            .expect_err("context 与 runtime Agent 不一致时必须显式失败");
        assert_eq!(error.code(), "session_not_found");
        assert!(!error.to_string().contains("agent-a-workspace"));
    }
}
