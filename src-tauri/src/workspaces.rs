//! Workspace 实体域（CWD-03，方案 C——独立 Workspace 实体，Session 绑定 Workspace）。
//!
//! 契约（Docs/施工交接/CWD-01.md）：
//! - 生命周期：workspace_create / workspace_update（name/root_path）/ workspace_delete / workspace_list。
//! - root_path 必须为绝对路径（创建与更新校验）；存在性不在创建时强校验——与既有
//!   session.cwd 语义一致（目录缺失由命令解析层以 io 错误自然暴露，不静默回退）。
//! - 跨 Agent 共享（CWD-01 决策 4）：Workspace 全局可见（可见性模型 = 所有 Agent 可绑定），
//!   owner（agent_id）仅作创建者溯源，绑定不要求 Session.agentId === Workspace.agentId。
//! - 删除（CWD-01 决策 2）：绑定 Session 解绑 + root_path 快照到 session.cwd（兼容字段），
//!   Session 继续可读旧目录，不自动删 Session。
//! - rootPath 变更（CWD-01 决策 1）：立即 reload（方案 A 语义嫁接）由前端驱动
//!   （binding invalidate → close → load/new），后端只维护注册表与解析链。
//!
//! 锁序纪律：本模块绝不同时持有 workspaces 锁与 runtime.sessions 锁（workspace_root_for_context
//! 先在 sessions 锁内 clone 所需字段、释放后再解析 workspace，避免两锁交叉形成死锁面）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use tauri::State;

use crate::error::PylonError;
use crate::AppState;

/// CWD-03：Workspace 实体（创建/编辑/删除/列表；owner 溯源 + 跨 Agent 共享）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Workspace {
    pub(crate) id: String,
    /// 创建者 agentId（owner 溯源；创建后不可变更；跨 Agent 共享见 CWD-01 决策 4）
    pub(crate) agent_id: String,
    pub(crate) name: String,
    /// 绝对路径工作目录（唯一 root 来源；创建/更新时校验绝对路径）
    pub(crate) root_path: String,
    pub(crate) created_at: i64,
    pub(crate) last_active_at: i64,
    /// cwd 级 skills（会话在 cwd 下创建时继承快照）。
    #[serde(default)]
    pub(crate) skills: Vec<String>,
    /// cwd 级 MCP 选择：agent 暴露的 MCP server 中，本 cwd 选择启用哪些（按名称）。
    #[serde(default)]
    pub(crate) mcp_server_ids: Vec<String>,
    /// cwd 级 hook 插件 id（工作区级插件 hook；会话在 cwd 下创建时继承快照）。
    #[serde(default)]
    pub(crate) hook_plugin_ids: Vec<String>,
}

const WORKSPACE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFile {
    schema_version: u32,
    workspaces: Vec<Workspace>,
}

fn load_workspaces_at(path: &Path) -> Result<HashMap<String, Workspace>, PylonError> {
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let content = std::fs::read_to_string(path)
        .map_err(|error| PylonError::Io(format!("read {}: {error}", path.display())))?;
    let file: WorkspaceFile = serde_json::from_str(&content)
        .map_err(|error| PylonError::Serialize(format!("invalid {}: {error}", path.display())))?;
    if file.schema_version > WORKSPACE_SCHEMA_VERSION {
        return Err(PylonError::Protocol(format!(
            "unsupported workspace schemaVersion: {}",
            file.schema_version
        )));
    }
    Ok(file
        .workspaces
        .into_iter()
        .map(|workspace| (workspace.id.clone(), workspace))
        .collect())
}

fn persist_workspaces_at(
    path: &Path,
    registry: &HashMap<String, Workspace>,
) -> Result<(), PylonError> {
    let mut workspaces: Vec<_> = registry.values().cloned().collect();
    workspaces.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let content = serde_json::to_string_pretty(&WorkspaceFile {
        schema_version: WORKSPACE_SCHEMA_VERSION,
        workspaces,
    })?;
    crate::agent_config::write_config_atomically(path, &content).map_err(PylonError::Config)
}

fn persist_registry_if_configured(
    state: &AppState,
    registry: &HashMap<String, Workspace>,
) -> Result<(), PylonError> {
    let Some(dirs) = state.data_dirs.get() else {
        // Unit tests and deliberately bare embedded states are memory-only.
        return Ok(());
    };
    persist_workspaces_at(&crate::paths::workspace_persist_path(dirs), registry)
}

/// setup() 在前端可调用 workspace_list 前恢复唯一后端真值。
pub(crate) fn hydrate_workspaces(state: &AppState) -> Result<(), PylonError> {
    let path = crate::paths::workspace_persist_path(state.data_dirs()?);
    let loaded = load_workspaces_at(&path)?;
    *state
        .workspaces
        .lock()
        .map_err(|error| PylonError::Protocol(error.to_string()))? = loaded;
    Ok(())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn validate_absolute_path(root_path: &str) -> Result<(), PylonError> {
    if root_path.trim().is_empty() || std::path::Path::new(root_path).is_relative() {
        return Err(PylonError::Protocol(
            "workspace root_path must be an absolute path".to_string(),
        ));
    }
    Ok(())
}

// CWD 冻结语义：new/load 解析统一收口到 cwd 域（crate::cwd::resolve_session_cwd）。
pub(crate) use crate::cwd::resolve_session_cwd;

impl AppState {
    pub(crate) fn workspace_by_id(&self, id: &str) -> Option<Workspace> {
        self.workspaces
            .lock()
            .ok()
            .and_then(|registry| registry.get(id).cloned())
    }

    /// CWD-03：root 解析——workspace_id → root_path（唯一来源；缺失 = 回退 cwd 兼容分支）。
    pub(crate) fn workspace_root_path(&self, id: &str) -> Option<String> {
        self.workspace_by_id(id)
            .map(|workspace| workspace.root_path)
    }

    /// CWD 冻结语义：删除 Workspace 时仅解绑会话（cwd 已冻结，不回写）。
    /// Session 继续可读旧目录，不自动删 Session。逐 runtime 遍历；
    /// 不嵌套持锁（workspaces 锁已释放，此处只持 runtime.sessions 锁）。
    pub(crate) fn snapshot_workspace_sessions(&self, id: &str, _root_path: &str) {
        crate::cwd::unbind_workspace_sessions(self, id)
    }
}

#[tauri::command]
pub(crate) fn workspace_create(
    state: State<'_, AppState>,
    agent_id: String,
    name: String,
    root_path: String,
) -> Result<Workspace, PylonError> {
    create_workspace_in_state(state.inner(), agent_id, name, root_path)
}

pub(crate) fn create_workspace_in_state(
    state: &AppState,
    agent_id: String,
    name: String,
    root_path: String,
) -> Result<Workspace, PylonError> {
    validate_absolute_path(&root_path)?;
    let mut registry = state
        .workspaces
        .lock()
        .map_err(|error| PylonError::Protocol(error.to_string()))?;
    let mut next = registry.clone();
    let base = format!("w{}", now_millis());
    let mut id = base.clone();
    let mut suffix = 1;
    while next.contains_key(&id) {
        id = format!("{base}-{suffix}");
        suffix += 1;
    }
    let workspace = Workspace {
        id: id.clone(),
        agent_id,
        name,
        root_path,
        created_at: now_millis(),
        last_active_at: now_millis(),
        skills: Vec::new(),
        mcp_server_ids: Vec::new(),
        hook_plugin_ids: Vec::new(),
    };
    next.insert(id, workspace.clone());
    persist_registry_if_configured(state, &next)?;
    *registry = next;
    Ok(workspace)
}

#[tauri::command]
pub(crate) fn workspace_update(
    state: State<'_, AppState>,
    workspace_id: String,
    name: Option<String>,
    root_path: Option<String>,
    skills: Option<Vec<String>>,
    mcp_server_ids: Option<Vec<String>>,
    hook_plugin_ids: Option<Vec<String>>,
) -> Result<Workspace, PylonError> {
    update_workspace_in_state(
        state.inner(),
        workspace_id,
        name,
        root_path,
        skills,
        mcp_server_ids,
        hook_plugin_ids,
    )
}

pub(crate) fn update_workspace_in_state(
    state: &AppState,
    workspace_id: String,
    name: Option<String>,
    root_path: Option<String>,
    skills: Option<Vec<String>>,
    mcp_server_ids: Option<Vec<String>>,
    hook_plugin_ids: Option<Vec<String>>,
) -> Result<Workspace, PylonError> {
    if let Some(root) = &root_path {
        validate_absolute_path(root)?;
    }
    let mut registry = state
        .workspaces
        .lock()
        .map_err(|error| PylonError::Protocol(error.to_string()))?;
    let mut next = registry.clone();
    let workspace = next
        .get_mut(&workspace_id)
        .ok_or_else(|| PylonError::Protocol(format!("workspace not found: {workspace_id}")))?;
    if let Some(name) = name {
        workspace.name = name;
    }
    if let Some(root) = root_path {
        workspace.root_path = root;
    }
    if let Some(value) = skills {
        workspace.skills = value;
    }
    if let Some(value) = mcp_server_ids {
        workspace.mcp_server_ids = value;
    }
    if let Some(value) = hook_plugin_ids {
        workspace.hook_plugin_ids = value;
    }
    workspace.last_active_at = now_millis();
    let updated = workspace.clone();
    persist_registry_if_configured(state, &next)?;
    *registry = next;
    Ok(updated)
}

#[tauri::command]
pub(crate) fn workspace_delete(
    state: State<'_, AppState>,
    workspace_id: String,
) -> Result<(), PylonError> {
    delete_workspace_in_state(state.inner(), workspace_id)
}

pub(crate) fn delete_workspace_in_state(
    state: &AppState,
    workspace_id: String,
) -> Result<(), PylonError> {
    let removed = {
        let mut registry = state
            .workspaces
            .lock()
            .map_err(|error| PylonError::Protocol(error.to_string()))?;
        let mut next = registry.clone();
        let removed = next.remove(&workspace_id);
        if removed.is_some() {
            persist_registry_if_configured(state, &next)?;
            *registry = next;
        }
        removed
    };
    match removed {
        Some(workspace) => {
            state.snapshot_workspace_sessions(&workspace_id, &workspace.root_path);
            Ok(())
        }
        None => Err(PylonError::Protocol(format!(
            "workspace not found: {workspace_id}"
        ))),
    }
}

#[tauri::command]
pub(crate) fn workspace_list(state: State<'_, AppState>) -> Result<Vec<Workspace>, PylonError> {
    list_workspaces_in_state(state.inner())
}

/// v1 内存注册表 → v2 落盘注册表的一次性桥：仅当后端为空时接收前端旧镜像，
/// 保留 Workspace id，避免已持久化 Session 的 workspaceId 绑定断裂。
#[tauri::command]
pub(crate) fn workspace_restore(
    state: State<'_, AppState>,
    workspaces: Vec<Workspace>,
) -> Result<Vec<Workspace>, PylonError> {
    restore_workspaces_in_state(state.inner(), workspaces)
}

pub(crate) fn restore_workspaces_in_state(
    state: &AppState,
    workspaces: Vec<Workspace>,
) -> Result<Vec<Workspace>, PylonError> {
    let mut registry = state
        .workspaces
        .lock()
        .map_err(|error| PylonError::Protocol(error.to_string()))?;
    if !registry.is_empty() {
        let mut current: Vec<_> = registry.values().cloned().collect();
        current.sort_by_key(|workspace| workspace.created_at);
        return Ok(current);
    }
    let mut next = HashMap::new();
    for workspace in workspaces {
        if workspace.id.trim().is_empty() {
            return Err(PylonError::Protocol(
                "workspace id must not be empty".into(),
            ));
        }
        validate_absolute_path(&workspace.root_path)?;
        if next.insert(workspace.id.clone(), workspace).is_some() {
            return Err(PylonError::Protocol("duplicate workspace id".into()));
        }
    }
    persist_registry_if_configured(state, &next)?;
    *registry = next;
    let mut restored: Vec<_> = registry.values().cloned().collect();
    restored.sort_by_key(|workspace| workspace.created_at);
    Ok(restored)
}

pub(crate) fn list_workspaces_in_state(state: &AppState) -> Result<Vec<Workspace>, PylonError> {
    let registry = state
        .workspaces
        .lock()
        .map_err(|error| PylonError::Protocol(error.to_string()))?;
    let mut workspaces: Vec<Workspace> = registry.values().cloned().collect();
    workspaces.sort_by_key(|workspace| workspace.created_at);
    Ok(workspaces)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::AgentRuntime;
    use crate::session::SessionInfo;
    use crate::test_utils::{fake_acp_agent, TestStateBuilder};
    use std::sync::Arc;

    fn temp_data_dirs() -> (std::path::PathBuf, crate::paths::DataDirs) {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "pylon-workspaces-test-{}-{}",
            std::process::id(),
            nonce
        ));
        std::fs::create_dir_all(&root).unwrap();
        let dirs = crate::paths::DataDirs {
            data_root: root.clone(),
            config_root: root.clone(),
            mode: crate::paths::StorageMode::AppData,
            portable_requested: false,
            fallback_reason: None,
        };
        (root, dirs)
    }

    fn sample_workspace(id: &str, root_path: &str) -> Workspace {
        Workspace {
            id: id.to_string(),
            agent_id: "peri".to_string(),
            name: "默认工作区".to_string(),
            root_path: root_path.to_string(),
            created_at: 100,
            last_active_at: 100,
            skills: Vec::new(),
            mcp_server_ids: Vec::new(),
            hook_plugin_ids: Vec::new(),
        }
    }

    fn state_with_session(
        workspace_id: Option<&str>,
        session_cwd: &str,
    ) -> (AppState, Arc<AgentRuntime>) {
        let runtime = AgentRuntime::new_disconnected();
        let mut session = SessionInfo::new(
            "peri-1".to_string(),
            String::new(),
            session_cwd.to_string(),
            true,
            1,
        );
        session.workspace_id = workspace_id.map(ToOwned::to_owned);
        runtime
            .sessions
            .lock()
            .unwrap()
            .insert("local:s1".to_string(), session);
        (
            TestStateBuilder::bare()
                .with_active_agent("peri")
                .with_agent(fake_acp_agent("peri", ""))
                .with_runtime("peri", runtime.clone())
                .build(),
            runtime,
        )
    }

    #[test]
    fn create_requires_absolute_path_and_generates_unique_id() {
        let state = TestStateBuilder::bare().build();
        let error =
            create_workspace_in_state(&state, "peri".into(), "x".into(), "relative/path".into())
                .expect_err("相对路径必须被拒绝");
        assert!(error.to_string().contains("absolute"));

        let first =
            create_workspace_in_state(&state, "peri".into(), "默认".into(), "C:\\root-a".into())
                .expect("绝对路径创建成功");
        assert_eq!(first.agent_id, "peri");
        assert!(first.id.starts_with('w'));

        let second =
            create_workspace_in_state(&state, "peri".into(), "另一个".into(), "C:\\root-b".into())
                .expect("第二个创建成功");
        assert_ne!(first.id, second.id, "id 必须唯一");
        assert_eq!(list_workspaces_in_state(&state).expect("list").len(), 2);
    }

    #[test]
    fn create_update_delete_survive_a_fresh_state_hydration() {
        let (root, dirs) = temp_data_dirs();
        let state = TestStateBuilder::bare()
            .with_data_dirs(dirs.clone())
            .build();
        let created =
            create_workspace_in_state(&state, "peri".into(), "项目".into(), "C:\\project".into())
                .expect("create persists");
        update_workspace_in_state(
            &state,
            created.id.clone(),
            Some("项目二".into()),
            None,
            Some(vec!["review".into()]),
            None,
            None,
        )
        .expect("update persists");

        let restarted = TestStateBuilder::bare()
            .with_data_dirs(dirs.clone())
            .build();
        hydrate_workspaces(&restarted).expect("restart hydration");
        let restored = restarted
            .workspace_by_id(&created.id)
            .expect("workspace restored");
        assert_eq!(restored.name, "项目二");
        assert_eq!(restored.skills, vec!["review"]);

        delete_workspace_in_state(&restarted, created.id.clone()).expect("delete persists");
        let restarted_again = TestStateBuilder::bare().with_data_dirs(dirs).build();
        hydrate_workspaces(&restarted_again).expect("second restart hydration");
        assert!(restarted_again.workspace_by_id(&created.id).is_none());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn empty_backend_restores_legacy_frontend_mirror_without_changing_ids() {
        let (root, dirs) = temp_data_dirs();
        let state = TestStateBuilder::bare()
            .with_data_dirs(dirs.clone())
            .build();
        let legacy = sample_workspace("legacy-workspace-id", "C:\\legacy-root");
        let restored = restore_workspaces_in_state(&state, vec![legacy.clone()]).expect("restore");
        assert_eq!(restored, vec![legacy.clone()]);

        let restarted = TestStateBuilder::bare().with_data_dirs(dirs).build();
        hydrate_workspaces(&restarted).expect("hydrate restored mirror");
        assert_eq!(restarted.workspace_by_id(&legacy.id), Some(legacy));
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn update_renames_and_changes_root_rejecting_relative() {
        let state = TestStateBuilder::bare().build();
        let ws = create_workspace_in_state(&state, "peri".into(), "a".into(), "C:\\root".into())
            .unwrap();
        let error = update_workspace_in_state(
            &state,
            ws.id.clone(),
            None,
            Some("..\\x".into()),
            None,
            None,
            None,
        )
        .expect_err("相对 root_path 必须被拒绝");
        assert!(error.to_string().contains("absolute"));
        let updated = update_workspace_in_state(
            &state,
            ws.id.clone(),
            Some("重命名".into()),
            Some("D:\\new-root".into()),
            Some(vec!["code-review".to_string()]),
            Some(vec!["mcp-filesystem".to_string()]),
            Some(vec!["p.workspace-hook".to_string()]),
        )
        .expect("更新成功");
        assert_eq!(updated.name, "重命名");
        assert_eq!(updated.root_path, "D:\\new-root");
        assert_eq!(updated.skills, vec!["code-review".to_string()]);
        assert_eq!(updated.mcp_server_ids, vec!["mcp-filesystem".to_string()]);
        assert_eq!(
            updated.hook_plugin_ids,
            vec!["p.workspace-hook".to_string()]
        );
        let missing =
            update_workspace_in_state(&state, "ws-nope".into(), None, None, None, None, None)
                .expect_err("缺失 Workspace 必须报错");
        assert!(missing.to_string().contains("not found"));
    }

    #[test]
    fn delete_unbinds_bound_sessions_and_keeps_frozen_cwd() {
        let (_, runtime) = state_with_session(Some("ws-1"), "C:\\frozen-cwd");
        let state = TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(fake_acp_agent("peri", ""))
            .with_runtime("peri", runtime.clone())
            .with_workspace(sample_workspace("ws-1", "C:\\root"))
            .build();
        // 删除 → 仅解绑，cwd 保持不变。
        delete_workspace_in_state(&state, "ws-1".to_string()).expect("删除成功");
        assert!(state.workspace_by_id("ws-1").is_none());
        let (cwd, workspace_id) = {
            let sessions = runtime.sessions.lock().unwrap();
            let session = sessions.get("local:s1").expect("会话保留");
            (session.cwd.clone(), session.workspace_id.clone())
        };
        assert_eq!(workspace_id, None, "删除后解绑");
        assert_eq!(cwd, "C:\\frozen-cwd", "cwd 冻结不回写");
        // 未绑定会话不受影响
        let missing = delete_workspace_in_state(&state, "ws-1".to_string())
            .expect_err("二次删除必须报 not found");
        assert!(missing.to_string().contains("not found"));
    }

    #[test]
    fn resolve_session_cwd_binding_wins_and_missing_workspace_errors() {
        let state = TestStateBuilder::bare().build();
        // 未绑定 → cwd 缺省链
        let (cwd, ws) =
            resolve_session_cwd(&state, Some("C:\\cwd".into()), None).expect("未绑定走 cwd");
        assert_eq!(cwd, "C:\\cwd");
        assert_eq!(ws, None);
        // 绑定缺失 → 结构化错误（不静默回退）
        let error = resolve_session_cwd(&state, Some("C:\\cwd".into()), Some("ws-nope".into()))
            .expect_err("缺失 Workspace 必须报错");
        assert!(error.to_string().contains("not found"));
        // 绑定存在 → root_path 优先（忽略传入 cwd）
        let state = TestStateBuilder::bare()
            .with_workspace(sample_workspace("ws-1", "C:\\root"))
            .build();
        let (cwd, ws) = resolve_session_cwd(&state, Some("C:\\stale".into()), Some("ws-1".into()))
            .expect("workspace root 优先");
        assert_eq!(cwd, "C:\\root");
        assert_eq!(ws.as_deref(), Some("ws-1"));
    }
}
