//! cwd 域：会话工作目录唯一真值（CWD 冻结语义）。
//!
//! 用户裁决：**会话 cwd 创建后不再变更**。new/load 时经 [`SessionCwd::resolve`]
//! 一次性解析并冻结进 SessionInfo；此后 workspace 删除/rootPath 变更都不回写
//! 既有会话。命令 root（workspace/git 等）一律读取会话自带的 `cwd`，不再回查
//! Workspace 注册表。
//!
//! 锁序纪律：本模块不跨持 `sessions` 与 `workspaces` 两把锁。

use serde::Serialize;

use crate::error::PylonError;
use crate::AppState;

/// 会话自带的工作目录信息：路径 + 可选 workspace 来源（provenance）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionCwd {
    /// 生效路径（已解析并冻结）。
    pub(crate) path: String,
    /// 创建时的 Workspace 来源；仅作展示/审计，不再参与运行时 root 解析。
    pub(crate) workspace_id: Option<String>,
}

impl SessionCwd {
    /// new/load 时唯一解析入口：Workspace 绑定 → root_path；否则显式 cwd；
    /// 否则 agent 默认 cwd。解析结果立即冻结进会话。
    pub(crate) fn resolve(
        state: &AppState,
        requested_cwd: Option<String>,
        workspace_id: Option<String>,
    ) -> Result<Self, PylonError> {
        match workspace_id {
            Some(id) => {
                let root = state
                    .workspace_root_path(&id)
                    .ok_or_else(|| PylonError::Protocol(format!("workspace not found: {id}")))?;
                Ok(Self {
                    path: root,
                    workspace_id: Some(id),
                })
            }
            None => Ok(Self {
                path: requested_cwd.unwrap_or_else(|| state.agent_cwd()),
                workspace_id: None,
            }),
        }
    }
}

/// 兼容旧调用点：返回 `(cwd, workspace_id)` 二元组。
pub(crate) fn resolve_session_cwd(
    state: &AppState,
    cwd: Option<String>,
    workspace_id: Option<String>,
) -> Result<(String, Option<String>), PylonError> {
    let resolved = SessionCwd::resolve(state, cwd, workspace_id)?;
    Ok((resolved.path, resolved.workspace_id))
}

/// Workspace 删除：仅解绑会话的 workspace_id；cwd 已冻结，不回写。
pub(crate) fn unbind_workspace_sessions(state: &AppState, workspace_id: &str) {
    for runtime in state.runtimes.all() {
        if let Ok(mut sessions) = runtime.sessions.lock() {
            for session in sessions.values_mut() {
                if session.workspace_id.as_deref() == Some(workspace_id) {
                    session.workspace_id = None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::{fake_acp_agent, TestStateBuilder};

    fn workspace(id: &str, root: &str) -> crate::workspaces::Workspace {
        crate::workspaces::Workspace {
            id: id.to_string(),
            agent_id: "peri".to_string(),
            name: id.to_string(),
            root_path: root.to_string(),
            created_at: 1,
            last_active_at: 1,
            skills: Vec::new(),
            mcp_server_ids: Vec::new(),
            hook_plugin_ids: Vec::new(),
        }
    }

    #[test]
    fn resolve_freezes_workspace_root_or_explicit_cwd_or_agent_default() {
        let state = TestStateBuilder::bare()
            .with_agent(fake_acp_agent("peri", ""))
            .with_workspace(workspace("ws-1", "C:\\ws-root"))
            .build();

        let bound = SessionCwd::resolve(&state, Some("C:\\stale".into()), Some("ws-1".into()))
            .expect("workspace 存在");
        assert_eq!(bound.path, "C:\\ws-root");
        assert_eq!(bound.workspace_id.as_deref(), Some("ws-1"));

        let explicit =
            SessionCwd::resolve(&state, Some("C:\\explicit".into()), None).expect("显式 cwd");
        assert_eq!(explicit.path, "C:\\explicit");
        assert_eq!(explicit.workspace_id, None);

        let missing = SessionCwd::resolve(&state, None, Some("ws-nope".into()))
            .expect_err("缺失 workspace 必须报错");
        assert!(missing.to_string().contains("not found"));
    }
}
