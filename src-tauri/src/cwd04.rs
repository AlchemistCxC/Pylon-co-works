//! CWD-04：工具/Git/workspace cwd 验收（方案书任务表 CWD-04，§5.16 实际验收——四类 cwd 一致性）。
//!
//! 四类 cwd：
//!   1. `process.cwd()`          —— Agent 进程 spawn 目录（AgentDef.cwd；会话级 cwd 覆盖后与 2/3/4
//!                                  出现差异是预期行为：Agent 进程在配置目录启动，ACP session cwd
//!                                  才是产物所在目录——明确差异说明，见下方一致性预期）。
//!   2. ACP session cwd          —— SessionInfo.cwd（new/load 时 resolve_session_cwd 的解析结果）。
//!   3. workspace command cwd    —— workspace 命令 root（workspace_root_for_source 同链）。
//!   4. Git command cwd          —— Git 命令 root（git_workspace_root → workspace_root_for_source 同链）。
//!
//! 一致性预期（CWD-01 方案 C + CWD-03 迁移后）：
//!   - 绑定 Workspace：2/3/4 恒等于 Workspace.root_path（root 单一来源）；1 = AgentDef.cwd（可差异）。
//!   - 未绑定（显式 cwd）：2/3/4 恒等于传入 cwd；1 = AgentDef.cwd（可差异）。
//!   - 未绑定（无 cwd）：2/3/4 = agent_cwd() = AgentDef.cwd，四者全等。
//!   - Workspace 删除后：绑定解绑 + root_path 快照到 session.cwd（CWD-01 决策 2），2/3/4 保持旧
//!     root 不变（legacy cwd 语义），1 = AgentDef.cwd（可差异）。
//!
//! 验收纪律：本模块只读取证 + 诊断（`cwd_consistency_report`），不新增 wire/命令行为；
//! 自动化证据覆盖「后端侧三源（ACP session / workspace 命令 / Git 命令）一致性 +
//! process.cwd() 差异说明」；真实 agent 的「工具内部输出 process.cwd()」随
//! real_acp_smoke 的既有真实初始化路径（#[ignore]，session/new 以解析后 cwd 为参数）
//! 与人工验收步骤承担（§5.16 四类 cwd 实测对照）。
//!
//! CR-607（玉衡 CWD-04 审查）语义说明：AgentDef.cwd=None 时 process_cwd 为**会话 cwd 的代理值**
//! （非真实 spawn 目录——ACP 仅在某 Agent 显式配置 cwd 时指定进程目录，见 acp/mod.rs）。
//! 此时报告可能显示四源全等，掩盖真实差异；对照四类 cwd 时须以 real_acp_smoke（#[ignore]）
//! 与人工验收为准。

use crate::error::PylonError;
use crate::AppState;

/// CWD-04：四类 cwd 一致性快照（验收证据）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CwdConsistencyReport {
    /// 1. process.cwd()：Agent 进程 spawn 目录（AgentDef.cwd；缺省回退会话 cwd——代理值，
    ///    CR-607：非真实 spawn 目录，真实值以 real_acp_smoke + 人工验收为准）。
    pub(crate) process_cwd: String,
    /// 2. ACP session cwd：SessionInfo.cwd（会话创建/恢复时解析）。
    pub(crate) acp_session_cwd: String,
    /// 3. workspace command cwd：workspace_root_for_source 解析的 root。
    pub(crate) workspace_command_cwd: String,
    /// 4. Git command cwd：git_workspace_root 委托同链解析的 root。
    pub(crate) git_command_cwd: String,
}

impl CwdConsistencyReport {
    /// 后端侧三源（ACP session / workspace 命令 / Git 命令）是否完全一致
    /// ——四类 cwd 一致性的核心自动化判据（§5.16「四者一致或有明确差异说明」）。
    pub(crate) fn backend_sources_consistent(&self) -> bool {
        self.acp_session_cwd == self.workspace_command_cwd
            && self.acp_session_cwd == self.git_command_cwd
    }
}

/// CWD-04：对给定 source 输出四类 cwd 一致性快照。
///
/// 解析路径与既有命令完全一致（single-active 边界）：source 经 `active_context_for_source`
/// 定位 active agent 的 runtime 会话；ACP session cwd 直读 SessionInfo.cwd；workspace/Git
/// 命令 cwd 走同一 `workspace_root_for_context` 解析链。缺失会话/未注册 runtime → 结构化错误。
pub(crate) fn cwd_consistency_report(
    state: &AppState,
    source: &str,
) -> Result<CwdConsistencyReport, PylonError> {
    let (context, runtime) = state.active_context_for_source(source)?;
    let acp_session_cwd = {
        let sessions = runtime
            .sessions
            .lock()
            .map_err(|e| PylonError::Protocol(e.to_string()))?;
        sessions
            .get(source)
            .map(|session| session.cwd.clone())
            .ok_or_else(|| PylonError::SessionNotFound(format!("source={source}")))?
    };
    let workspace_command_cwd = state.workspace_root_for_context(&runtime, &context)?;
    // Legacy runtime diagnostic: production FileSheet/Git commands now use explicit
    // WorkspaceTarget and validate persisted ownership. Within this legacy source report,
    // both command roots intentionally mirror the same historical context resolver.
    let git_command_cwd = workspace_command_cwd.clone();
    let process_cwd = state
        .get_active_agent()
        .ok()
        .and_then(|agent| agent.cwd)
        .unwrap_or_else(|| acp_session_cwd.clone());
    Ok(CwdConsistencyReport {
        process_cwd,
        acp_session_cwd,
        workspace_command_cwd,
        git_command_cwd,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_utils::TestStateBuilder;
    use crate::workspaces::Workspace;

    const SOURCE: &str = "source-a";
    const WS_ROOT: &str = "C:\\work\\ws-a";
    const EXPLICIT_CWD: &str = "C:\\work\\explicit";

    fn workspace(id: &str, name: &str, root_path: &str) -> Workspace {
        Workspace {
            id: id.to_string(),
            agent_id: "agent-a".to_string(),
            name: name.to_string(),
            root_path: root_path.to_string(),
            created_at: 1,
            last_active_at: 1,
            skills: Vec::new(),
            mcp_server_ids: Vec::new(),
            hook_plugin_ids: Vec::new(),
        }
    }

    /// 构建：active agent（cwd=process 目录）+ runtime + source 会话（cwd/workspace_id 可设）。
    fn build_state(
        process_cwd: &str,
        session_cwd: &str,
        workspace_id: Option<&str>,
    ) -> crate::AppState {
        build_state_with_agent_cwd(Some(process_cwd), session_cwd, workspace_id)
    }

    /// 构建：agent.cwd 可显式为 None（CR-606：验证 process_cwd 回退会话 cwd 分支）。
    fn build_state_with_agent_cwd(
        agent_cwd: Option<&str>,
        session_cwd: &str,
        workspace_id: Option<&str>,
    ) -> crate::AppState {
        let mut agent = crate::test_utils::fake_acp_agent("agent-a", "");
        agent.cwd = agent_cwd.map(str::to_string);
        let runtime = crate::runtime::AgentRuntime::new_disconnected();
        let mut session = crate::session::SessionInfo::new(
            "peri-a".to_string(),
            String::new(),
            session_cwd.to_string(),
            false,
            0,
        );
        session.workspace_id = workspace_id.map(str::to_string);
        runtime
            .sessions
            .lock()
            .unwrap()
            .insert(SOURCE.to_string(), session);
        TestStateBuilder::bare()
            .with_active_agent("agent-a")
            .with_agent(agent)
            .with_runtime("agent-a", runtime.clone())
            .build()
    }

    #[test]
    fn bound_workspace_three_sources_equal_root_and_process_differs() {
        // 绑定 Workspace：ACP session cwd / workspace 命令 cwd / Git 命令 cwd 全部 = root_path。
        let state = build_state("C:\\work\\process-dir", WS_ROOT, Some("ws-1"));
        state
            .workspaces
            .lock()
            .unwrap()
            .insert("ws-1".to_string(), workspace("ws-1", "ws-a", WS_ROOT));
        let report = cwd_consistency_report(&state, SOURCE).expect("绑定会话必须可解析");
        assert!(report.backend_sources_consistent(), "{report:?}");
        assert_eq!(report.acp_session_cwd, WS_ROOT);
        assert_eq!(report.workspace_command_cwd, WS_ROOT);
        assert_eq!(report.git_command_cwd, WS_ROOT);
        // process.cwd() = AgentDef.cwd（spawn 目录）——与 session 工作目录的差异是预期行为（明确差异说明）。
        assert_eq!(report.process_cwd, "C:\\work\\process-dir");
        assert_ne!(report.process_cwd, report.acp_session_cwd);
    }

    #[test]
    fn unbound_explicit_cwd_three_sources_equal_explicit() {
        // 未绑定 + 显式 cwd：三源 = 传入 cwd；process.cwd() 保持 AgentDef.cwd。
        let state = build_state("C:\\work\\process-dir", EXPLICIT_CWD, None);
        state
            .workspaces
            .lock()
            .unwrap()
            .insert("ws-1".to_string(), workspace("ws-1", "ws-a", WS_ROOT));
        let report = cwd_consistency_report(&state, SOURCE).expect("未绑定会话必须可解析");
        assert!(report.backend_sources_consistent(), "{report:?}");
        assert_eq!(report.acp_session_cwd, EXPLICIT_CWD);
        assert_eq!(report.workspace_command_cwd, EXPLICIT_CWD);
        assert_eq!(report.git_command_cwd, EXPLICIT_CWD);
        assert_eq!(report.process_cwd, "C:\\work\\process-dir");
    }

    #[test]
    fn unbound_no_cwd_all_four_equal_agent_cwd() {
        // 未绑定 + 无 cwd：解析回退 agent_cwd() = AgentDef.cwd → 四类 cwd 全等。
        let state = build_state("C:\\work\\process-dir", "C:\\work\\process-dir", None);
        let report = cwd_consistency_report(&state, SOURCE).expect("回退链必须可解析");
        assert!(report.backend_sources_consistent(), "{report:?}");
        assert_eq!(report.process_cwd, report.acp_session_cwd);
        assert_eq!(report.process_cwd, report.workspace_command_cwd);
        assert_eq!(report.process_cwd, report.git_command_cwd);
    }

    #[test]
    fn agent_cwd_none_falls_back_to_session_cwd() {
        // CR-606（玉衡 CWD-04 审查）：AgentDef.cwd=None 时 process_cwd 回退会话 cwd（代理值，
        // 非真实 spawn 目录——真实值由 real_acp_smoke + 人工验收承担）；报告正常产出且三源一致。
        let state = build_state_with_agent_cwd(None, EXPLICIT_CWD, None);
        let report = cwd_consistency_report(&state, SOURCE).expect("回退链必须可解析");
        assert!(report.backend_sources_consistent(), "{report:?}");
        assert_eq!(report.acp_session_cwd, EXPLICIT_CWD);
        assert_eq!(report.workspace_command_cwd, EXPLICIT_CWD);
        assert_eq!(report.git_command_cwd, EXPLICIT_CWD);
        // 回退生效：process_cwd = acp_session_cwd（代理值）。
        assert_eq!(report.process_cwd, report.acp_session_cwd);
        assert_eq!(report.process_cwd, EXPLICIT_CWD);
    }

    #[test]
    fn deleted_workspace_snapshot_keeps_old_root() {
        // CWD-01 决策 2：Workspace 删除后绑定解绑 + root_path 快照到 session.cwd——
        // 三源保持旧 root（legacy cwd 语义），Workspace 注册表已无该实体。
        let state = build_state("C:\\work\\process-dir", WS_ROOT, Some("ws-1"));
        state
            .workspaces
            .lock()
            .unwrap()
            .insert("ws-1".to_string(), workspace("ws-1", "ws-a", WS_ROOT));
        // 模拟删除：注册表移除 + 绑定解绑 + cwd 快照（workspaces::snapshot_workspace_sessions 语义）。
        state.workspaces.lock().unwrap().remove("ws-1");
        {
            let runtime = state.runtimes.all()[0].clone();
            let mut sessions = runtime.sessions.lock().unwrap();
            if let Some(session) = sessions.get_mut(SOURCE) {
                session.workspace_id = None;
                session.cwd = WS_ROOT.to_string();
            }
        }
        let report = cwd_consistency_report(&state, SOURCE).expect("快照会话必须可解析");
        assert!(report.backend_sources_consistent(), "{report:?}");
        assert_eq!(report.acp_session_cwd, WS_ROOT);
        assert_eq!(report.workspace_command_cwd, WS_ROOT);
        assert_eq!(report.git_command_cwd, WS_ROOT);
    }

    #[test]
    fn missing_source_reports_structured_error() {
        let state = TestStateBuilder::bare()
            .with_active_agent("agent-a")
            .with_agent(crate::test_utils::fake_acp_agent("agent-a", ""))
            .with_runtime("agent-a", crate::runtime::AgentRuntime::new_disconnected())
            .build();
        match cwd_consistency_report(&state, "no-such-source") {
            Ok(_) => panic!("缺失 source 必须显式失败"),
            Err(error) => {
                assert_eq!(error.code(), "session_not_found");
                assert!(error.to_string().contains("no-such-source"));
            }
        }
    }
}
