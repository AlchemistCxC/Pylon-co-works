mod acp;
mod agent_config;
mod agent_runtime;
mod dispatcher;
mod error;
mod export;
mod gateway;
mod gateway_cmds;
mod git;
mod lifecycle;
mod logs_cmds;
mod mcp;
mod permission;
mod pet;
mod pet_cmds;
mod prism;
mod prism_cmds;
mod runtime;
mod runtime_log;
mod session;
#[cfg(test)]
mod test_utils;
mod time;
mod workspace;
mod workspace_cmds;

use acp::AcpClient;
use agent_config::AgentDef;
use agent_runtime::AgentLifecycleStatus;
use gateway::GatewayCore;
use prism::PrismClient;
use runtime::{AgentRuntime, AgentRuntimeManager};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, Runtime};

#[cfg(test)]
use crate::time::Timestamp;

#[cfg(test)]
use agent_runtime::AgentRuntimeState;
#[cfg(test)]
use session::SessionInfo;

// R1 拆分：子模块函数桥接。生产代码（setup/watcher/replace）裸引用；
// 测试模块经 `use super::*` 引入命令/工具函数（R5a：清理 R1 遗留的冗余
// cfg(test) 显式导入——测试模块实际引用集中在下列被保留的名字上）。
use crate::dispatcher::start_notification_dispatcher;
use crate::lifecycle::{load_mcp_persisted, mcp_persist_path};
use crate::permission::check_pending_permission_timeouts;
use crate::pet_cmds::{persist_pet_if_possible, pet_persist_path};
use crate::session::{apply_client_replacement_sessions, check_session_expiry, send_prompt_core};

#[cfg(test)]
use crate::export::{is_export_sensitive_key, sanitize_export_messages, write_export_atomically};
#[cfg(test)]
use crate::lifecycle::{do_connect_and_replace, set_mcp_servers};
#[cfg(test)]
use crate::permission::{
    parse_permission_request, permission_response, permission_response_cancelled,
    resolve_permission,
};
#[cfg(test)]
use crate::session::{
    build_full_inspector_payload, compose_inject_prompt, config_option_current_value,
    extract_tool_file_name, inject_applies_to, send_message, session_expired,
};

fn emit_event<R, W>(window: &W, event: &str, payload: serde_json::Value)
where
    R: Runtime,
    W: Emitter<R>,
{
    if let Err(error) = window.emit(event, payload) {
        log::warn!("emit {event} failed: {error}");
    }
}

/// 事件广播（B10.1）：WebView 始终接收；平台 source 同时经 gateway 投递平台适配器。
/// peri:user 回显/agent-status/runtime-log 不投平台（仅 update/done/error）。
pub(crate) fn emit_event_all<R, W>(
    window: &W,
    gateway: &GatewayCore,
    source: &str,
    event: &str,
    payload: serde_json::Value,
) where
    R: Runtime,
    W: Emitter<R>,
{
    emit_event(window, event, payload.clone());
    gateway.deliver_all(source, event, &payload);
}

/// AppState：全局状态 = 全局配置 + per-agent 隔离运行时（B7a-2）+ gateway（B10.1）。
/// per-agent 字段（acp/notification_task/session_creation/agent_lifecycle/
/// client_generation/prompt_locks/sessions/agent_runtime/auto_reconnect_active）
/// 全部收进 AgentRuntimeManager（runtime.rs），命令层按 active_agent 解析 runtime。
/// R1 拆分：字段 pub(crate) 供子模块（session/dispatcher/lifecycle 等）访问。
pub(crate) struct AppState {
    pub(crate) runtimes: Arc<AgentRuntimeManager>,
    pub(crate) agents: Arc<Mutex<HashMap<String, AgentDef>>>,
    pub(crate) active_agent: Arc<Mutex<String>>,
    pub(crate) pet: Arc<Mutex<pet::PetState>>,
    pub(crate) runtime_logs: Arc<runtime_log::RuntimeLogHub>,
    pub(crate) runtime_mcp: Mutex<Option<Vec<mcp::McpServerConfig>>>,
    pub(crate) prism: PrismClient,
    pub(crate) gateway: Arc<GatewayCore>,
    /// 权限审批模式（B9.3）：bypass/auto 自动批准；edit/default 挂起询问。
    pub(crate) approval_mode: Arc<Mutex<String>>,
    /// 宠物状态最近一次落盘时间（Unix 毫秒）——get_pet 12s 轮询路径写盘节流用。
    pub(crate) pet_last_persist_ms: AtomicU64,
    /// R6a：宠物落盘写序锁（tokio Mutex）——序列化在临界区内执行，保证
    /// 后写状态 ≥ 先写状态（无乱序覆盖）；fs 写经 spawn_blocking 移出 async 运行时。
    pub(crate) pet_write_lock: tokio::sync::Mutex<()>,
}

/// 供 async 闭包/静态辅助持有的 AppState 字段子集。
/// Tauri manage 的 state 不能 move 进闭包，只能 clone 字段；
/// start_notification_dispatcher / do_connect_and_replace / 自动重连共用。
/// per-agent 状态经 [`Self::active_runtime`] / 参数传入的 runtime 访问。
/// R1 拆分：字段 pub(crate)（dispatcher/lifecycle 子模块访问）。
pub(crate) struct AppStateHandles {
    pub(crate) runtimes: Arc<AgentRuntimeManager>,
    pub(crate) agents: Arc<Mutex<HashMap<String, AgentDef>>>,
    pub(crate) active_agent: Arc<Mutex<String>>,
    pub(crate) pet: Arc<Mutex<pet::PetState>>,
    pub(crate) runtime_logs: Arc<runtime_log::RuntimeLogHub>,
    pub(crate) gateway: Arc<GatewayCore>,
    pub(crate) approval_mode: Arc<Mutex<String>>,
}

impl AppStateHandles {
    fn from_state(state: &AppState) -> Self {
        Self {
            runtimes: state.runtimes.clone(),
            agents: state.agents.clone(),
            active_agent: state.active_agent.clone(),
            pet: state.pet.clone(),
            runtime_logs: state.runtime_logs.clone(),
            gateway: state.gateway.clone(),
            approval_mode: state.approval_mode.clone(),
        }
    }

    /// 当前 active agent 的 runtime（无 active agent 时返回 None）。
    fn active_runtime(&self) -> Option<Arc<AgentRuntime>> {
        let id = self.active_agent.lock().ok()?.clone();
        self.runtimes.get(&id)
    }

    fn log_runtime_summary(
        &self,
        level: &str,
        source: &str,
        session: Option<String>,
        message: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) {
        self.runtime_logs.push(
            crate::time::Timestamp::now(),
            level,
            source,
            session,
            message,
            fields,
        );
    }

    fn set_agent_runtime_status(
        &self,
        runtime: &AgentRuntime,
        status: AgentLifecycleStatus,
        last_error: Option<String>,
    ) {
        if let Ok(mut runtime) = runtime.agent_runtime.lock() {
            runtime.status = status;
            runtime.last_error = last_error;
            if status == AgentLifecycleStatus::Connected {
                runtime.last_connected_at = Some(crate::time::Timestamp::now());
            }
        }
    }

    /// 崩溃检测 + 记录（P2-3）：只做"acp 已死 → status=Crashed + 注入 last_error"的
    /// 记录性写入，必须在纯查询路径（agent_status_payload）之外显式调用——
    /// getter 不再有副作用。try_lock 失败（acp 锁正被占用）视为未崩溃（读路径不等待）。
    fn detect_and_record_crashes(runtime: Option<&AgentRuntime>) {
        let Some(runtime) = runtime else { return };
        let crashed = runtime
            .acp
            .try_lock()
            .ok()
            .map(|acp| acp.is_crashed())
            .unwrap_or(false);
        if crashed {
            if let Ok(mut state) = runtime.agent_runtime.lock() {
                state.status = AgentLifecycleStatus::Crashed;
                if state.last_error.is_none() {
                    state.last_error = Some("ACP child process stdout closed".to_string());
                }
            }
        }
    }

    fn agent_status_payload(&self, runtime: Option<&AgentRuntime>) -> serde_json::Value {
        let (status, last_error, last_connected_at) = runtime
            .and_then(|runtime| runtime.agent_runtime.lock().ok().map(|state| state.clone()))
            .map(|state| (state.status, state.last_error, state.last_connected_at))
            .unwrap_or((AgentLifecycleStatus::Disconnected, None, None));
        let active_agent_id = self
            .active_agent
            .lock()
            .ok()
            .map(|value| value.clone())
            .unwrap_or_default();
        let agent = self
            .agents
            .lock()
            .ok()
            .and_then(|agents| agents.get(&active_agent_id).cloned());
        let crashed = matches!(status, AgentLifecycleStatus::Crashed)
            || runtime
                .and_then(|runtime| runtime.acp.try_lock().ok())
                .map(|acp| acp.is_crashed())
                .unwrap_or(false);
        let status = if crashed {
            AgentLifecycleStatus::Crashed
        } else {
            status
        };
        let available = agent.is_some() && status == AgentLifecycleStatus::Connected;
        let generation = runtime
            .map(|runtime| runtime.client_generation.load(Ordering::Acquire))
            .unwrap_or(0);
        let last_error = last_error.clone();
        let recent_error = last_error.clone();
        let legacy_error = last_error.clone();
        serde_json::json!({
            "agentId": active_agent_id,
            "agentName": agent.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
            "agent": agent.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
            "status": status.as_str(),
            "transport": agent.as_ref().map(|value| value.transport.clone()).unwrap_or_default(),
            "cwd": agent.as_ref().and_then(|value| value.cwd.clone()).unwrap_or_default(),
            "lastError": last_error,
            "recentError": recent_error,
            "error": legacy_error,
            "lastConnectedAt": last_connected_at,
            "generation": generation,
            "active": agent.is_some(),
            "available": available,
            "crashed": crashed,
        })
    }

    fn emit_agent_status<R: tauri::Runtime, W: tauri::Emitter<R>>(
        &self,
        runtime: &AgentRuntime,
        window: &W,
        status: AgentLifecycleStatus,
        last_error: Option<String>,
    ) {
        self.set_agent_runtime_status(runtime, status, last_error.clone());
        // P2-3：崩溃检测在状态写入之后执行——acp 已死时崩溃状态优先于本次
        // announce 的状态（避免"status=reconnecting 但 crashed=true"的自我矛盾）。
        Self::detect_and_record_crashes(Some(runtime));
        emit_event(window, "peri:agent-status", {
            let mut payload = self.agent_status_payload(Some(runtime));
            if let serde_json::Value::Object(ref mut map) = payload {
                // P3-12：只在 payload 未报告崩溃时覆盖——payload 内 status/crashed 必须一致。
                let payload_crashed = map.get("status").and_then(|value| value.as_str())
                    == Some(AgentLifecycleStatus::Crashed.as_str());
                if !payload_crashed {
                    map.insert(
                        "status".to_string(),
                        serde_json::Value::String(status.as_str().to_string()),
                    );
                    if let Some(error) = last_error {
                        let error = serde_json::Value::String(error);
                        map.insert("lastError".to_string(), error.clone());
                        map.insert("recentError".to_string(), error.clone());
                        map.insert("error".to_string(), error);
                    }
                }
            }
            payload
        });
    }

    async fn replace_agent_client<R: tauri::Runtime>(
        &self,
        runtime: &Arc<AgentRuntime>,
        agent_id: Option<String>,
        new_acp: AcpClient,
        window: tauri::WebviewWindow<R>,
        keep_sessions: bool,
    ) -> Result<(), String> {
        if new_acp.is_crashed() {
            return Err("new ACP client crashed before activation".to_string());
        }

        let mut old_acp = {
            let mut acp = runtime.acp.lock().await;
            let mut sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
            let old_acp = std::mem::replace(&mut *acp, new_acp);
            let new_generation = runtime.client_generation.fetch_add(1, Ordering::AcqRel) + 1;
            self.set_agent_runtime_status(runtime, AgentLifecycleStatus::Connected, None);
            if let Some(agent_id) = agent_id {
                if let Ok(mut active) = self.active_agent.lock() {
                    *active = agent_id;
                }
            }
            apply_client_replacement_sessions(&mut sessions, keep_sessions, new_generation);
            // 审查修复：客户端替换（switch/重连/自动重连）后旧进程的挂起权限请求
            // 全部失效——清空，避免 300s 超时把 reject 写到新进程（且可能撞新 id）。
            if let Ok(mut pending) = runtime.pending_permissions.lock() {
                let stale = pending.len();
                pending.clear();
                if stale > 0 {
                    log::warn!("客户端替换：清理 {stale} 个挂起的权限请求（旧进程已失效）");
                }
            }
            log::info!("ACP client activated; generation is now {}", new_generation);
            old_acp
        };
        start_notification_dispatcher(self, runtime, window);
        if let Err(error) = old_acp.kill() {
            log::warn!("kill replaced agent: {}", error);
        }
        Ok(())
    }
}

/// per-source prompt 锁表（source → 锁）。clippy 2026-08-02：复杂类型提取别名。
pub(crate) type PromptLockTable = Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>;

pub(crate) fn prompt_lock_for(
    locks: &PromptLockTable,
    source: &str,
) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = locks
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(source.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

#[cfg(test)]
mod session_info_tests {
    use super::*;

    #[test]
    fn export_sanitizer_removes_secret_payloads() {
        let messages = vec![serde_json::json!({
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"text": "visible"},
                "rawInput": {"prompt": "private"},
                "rawOutput": "private output",
                "headers": {"authorization": "Bearer secret"},
                "safe": "kept"
            }
        })];
        let safe = sanitize_export_messages(&messages);
        let text = serde_json::to_string(&safe).expect("serialize sanitized export");
        assert!(text.contains("visible"));
        assert!(text.contains("kept"));
        assert!(!text.contains("private"));
        assert!(!text.contains("secret"));
    }

    #[test]
    fn export_file_write_rejects_existing_path_and_commits_new_file() {
        let root = std::env::temp_dir().join(format!("pylon-export-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("create export test directory");
        let output = root.join("session.json");
        write_export_atomically(&output, b"first").expect("write export");
        assert_eq!(
            std::fs::read_to_string(&output).expect("read export"),
            "first"
        );
        assert!(write_export_atomically(&output, b"second").is_err());
        assert_eq!(
            std::fs::read_to_string(&output).expect("read export"),
            "first"
        );
        std::fs::remove_dir_all(&root).expect("remove export test directory");
    }

    #[test]
    fn export_session_owner_requires_active_generation_match() {
        assert_eq!(is_export_sensitive_key("rawInput"), true);
        assert_eq!(is_export_sensitive_key("tokenValue"), true);
        assert_eq!(is_export_sensitive_key("safe"), false);
    }

    #[test]
    fn session_response_preserves_mode_and_all_config_options() {
        let mut session = SessionInfo::new(
            "peri-1".into(),
            "persona".into(),
            "G:/work".into(),
            false,
            0,
        );
        session.apply_session_response(&serde_json::json!({
            "modes": {"currentModeId": "plan"},
            "configOptions": [
                {"id": "model", "currentValue": "deepseek-chat"},
                {"id": "thinking", "currentValue": "high"}
            ]
        }));
        assert_eq!(session.mode.as_deref(), Some("plan"));
        assert_eq!(session.model, "deepseek-chat");
        assert_eq!(session.config_options.len(), 2);
    }

    #[test]
    fn config_option_update_accepts_nested_value_shape() {
        let option = serde_json::json!({"id": "model", "value": {"valueId": {"value": "deepseek-reasoner"}}});
        assert_eq!(
            config_option_current_value(&option).as_deref(),
            Some("deepseek-reasoner")
        );
    }

    #[test]
    fn mode_falls_back_to_mode_config_option() {
        let mut session = SessionInfo::new("peri-1".into(), String::new(), ".".into(), true, 0);
        session.apply_session_response(&serde_json::json!({
            "configOptions": [{"id": "mode", "currentValue": "code"}]
        }));
        assert_eq!(session.mode.as_deref(), Some("code"));
    }

    #[test]
    fn keep_sessions_migrates_generation() {
        let mut sessions = HashMap::new();
        sessions.insert(
            "source-a".into(),
            SessionInfo::new("peri-1".into(), "persona".into(), ".".into(), true, 1),
        );
        sessions.insert(
            "source-b".into(),
            SessionInfo::new("peri-2".into(), "persona".into(), ".".into(), true, 1),
        );
        apply_client_replacement_sessions(&mut sessions, true, 9);
        assert_eq!(sessions.len(), 2);
        for session in sessions.values() {
            assert_eq!(session.generation, 9);
        }
    }

    #[test]
    fn keep_sessions_false_clears_sessions() {
        let mut sessions = HashMap::new();
        sessions.insert(
            "source-a".into(),
            SessionInfo::new("peri-1".into(), "persona".into(), ".".into(), true, 1),
        );
        apply_client_replacement_sessions(&mut sessions, false, 9);
        assert!(sessions.is_empty());
    }

    #[test]
    fn inspector_aggregates_session_stats() {
        let mut sessions = HashMap::new();
        let mut s1 = SessionInfo::new("peri-1".into(), "p1".into(), ".".into(), true, 0);
        s1.tokens_in = 100;
        s1.tokens_out = 50;
        s1.tokens_total = 150;
        s1.context_size = 8192;
        s1.model = "model-a".into();
        let mut s2 = SessionInfo::new("peri-2".into(), "p2".into(), "/work".into(), false, 0);
        s2.tokens_in = 20;
        s2.tokens_out = 10;
        s2.tokens_total = 30;
        s2.context_size = 4096;
        sessions.insert("source-a".into(), s1);
        sessions.insert("source-b".into(), s2);
        let runtime = AgentRuntimeState {
            status: AgentLifecycleStatus::Connected,
            last_error: None,
            last_connected_at: Some(Timestamp::new(1)),
        };
        let entries = vec![("agent-x".to_string(), sessions, runtime)];
        let payload = build_full_inspector_payload(&entries, "agent-x");
        assert_eq!(payload["agent"]["id"], "agent-x");
        assert_eq!(payload["agent"]["status"], "connected");
        assert_eq!(payload["summary"]["sessionCount"], 2);
        assert_eq!(payload["summary"]["activeCount"], 1); // 仅 s1 有 first prompt
        assert_eq!(payload["summary"]["tokensTotal"], 180);
        assert_eq!(payload["summary"]["tokensIn"], 120);
        assert_eq!(payload["summary"]["tokensOut"], 60);
        let rows = payload["sessions"]
            .as_array()
            .expect("sessions must be array");
        assert_eq!(rows.len(), 2);
        let rows_by_source: HashMap<&str, &serde_json::Value> = rows
            .iter()
            .map(|r| (r["source"].as_str().unwrap(), r))
            .collect();
        assert_eq!(rows_by_source["source-a"]["tokensTotal"], 150);
        assert_eq!(rows_by_source["source-b"]["cwd"], "/work");
        assert_eq!(rows_by_source["source-a"]["model"], "model-a");
        assert_eq!(
            rows_by_source["source-a"]["agentId"], "agent-x",
            "session 行必须带 agentId 区分来源"
        );
        // B2 增量：runtimes 数组 + workspace 映射
        let runtimes = payload["runtimes"]
            .as_array()
            .expect("runtimes must be array");
        assert_eq!(runtimes.len(), 1);
        assert_eq!(runtimes[0]["agentId"], "agent-x");
        assert_eq!(runtimes[0]["status"], "connected");
        assert_eq!(runtimes[0]["sessionCount"], 2);
        assert_eq!(runtimes[0]["tokensTotal"], 180);
        assert!(
            payload["workspace"].get("source-a").is_some(),
            "workspace 必须含每个 source 的 root 状态"
        );
    }

    #[test]
    fn inspector_full_aggregates_across_runtimes() {
        let mut sessions_a = HashMap::new();
        let s1 = SessionInfo::new("peri-a".into(), "pa".into(), ".".into(), true, 0);
        sessions_a.insert("local".into(), s1);
        let mut sessions_b = HashMap::new();
        let s2 = SessionInfo::new("peri-b".into(), "pb".into(), ".".into(), false, 0);
        sessions_b.insert("qq:group:1".into(), s2);
        let state_a = AgentRuntimeState {
            status: AgentLifecycleStatus::Connected,
            last_error: None,
            last_connected_at: Some(Timestamp::new(1)),
        };
        let state_b = AgentRuntimeState {
            status: AgentLifecycleStatus::Crashed,
            last_error: Some("boom".into()),
            last_connected_at: None,
        };
        let entries = vec![
            ("peri".to_string(), sessions_a, state_a),
            ("hermes".to_string(), sessions_b, state_b),
        ];
        let payload = build_full_inspector_payload(&entries, "peri");
        assert_eq!(payload["summary"]["sessionCount"], 2, "跨 runtime 全局聚合");
        assert_eq!(payload["summary"]["activeCount"], 1);
        let runtimes = payload["runtimes"].as_array().expect("runtimes array");
        assert_eq!(runtimes.len(), 2);
        let crashed = runtimes
            .iter()
            .find(|r| r["agentId"] == "hermes")
            .expect("hermes runtime");
        assert_eq!(crashed["status"], "crashed");
        assert_eq!(crashed["lastError"], "boom");
        assert_eq!(crashed["sessionCount"], 1);
        let rows = payload["sessions"].as_array().expect("sessions array");
        let qq_row = rows
            .iter()
            .find(|r| r["source"] == "qq:group:1")
            .expect("qq session");
        assert_eq!(
            qq_row["agentId"], "hermes",
            "跨 runtime session 必须可区分来源"
        );
    }

    #[test]
    fn session_expiry_idle_threshold_and_off_mode() {
        let now = Timestamp::new(1722500000000);
        // idle：超过阈值过期
        assert_eq!(
            session_expired(Some(Timestamp::new(1722490000000)), now, "idle", 30).as_deref(),
            Some("超过 30 分钟无活动")
        );
        // 31 分钟前（1860000ms）应过期
        assert!(
            session_expired(Some(Timestamp::new(1722498140000)), now, "idle", 30).is_some(),
            "31 分钟前应过期"
        );
        // 1 分钟内未过期
        assert!(
            session_expired(Some(Timestamp::new(1722499900000)), now, "idle", 30).is_none(),
            "1 分钟内未过期"
        );
        // off：永不过期
        assert_eq!(
            session_expired(Some(Timestamp::new(1)), now, "off", 1),
            None
        );
        // updated_at 缺失：保守不过期
        assert_eq!(session_expired(None, now, "idle", 1), None);
    }

    #[test]
    fn session_expiry_daily_mode_compares_calendar_day() {
        let now = Timestamp::new(1722500000000); // 某日
        assert!(
            session_expired(Some(Timestamp::new(1722400000000)), now, "daily", 0).is_some(),
            "跨天应过期"
        );
        assert!(
            session_expired(Some(Timestamp::new(1722500000000)), now, "daily", 0).is_none(),
            "同天未过期"
        );
        // 同一天但 23 小时前：daily 不过期（idle 才看时长）
        let same_day_later = Timestamp::new(1722490000000);
        assert_eq!(session_expired(Some(same_day_later), now, "daily", 0), None);
    }

    #[test]
    fn parse_permission_request_extracts_fields_and_sanitizes_prompt() {
        let params = serde_json::json!({
            "sessionId": "session-1",
            "toolCall": {
                "toolCallId": "call-1",
                "title": "edit_file",
                "rawInput": "{\"path\": \"/tmp/x\", \"token=SECRET\"}"
            },
            "options": [
                {"optionId": "allow_once", "name": "Allow once", "kind": "allowOnce"},
                {"optionId": "reject_once", "name": "Reject", "kind": "rejectOnce"}
            ]
        });
        let permission = parse_permission_request(Some(&params)).expect("合法请求必须解析");
        assert_eq!(permission.session_id, "session-1");
        assert_eq!(permission.tool_call_id, "call-1");
        assert_eq!(permission.title, "edit_file");
        assert_eq!(permission.options, vec!["allow_once", "reject_once"]);
        // prompt 脱敏：token= 载荷被 REDACTED
        assert!(
            !permission.prompt.contains("SECRET"),
            "prompt 不得含 secret 载荷: {}",
            permission.prompt
        );
        assert!(permission.prompt.contains("[REDACTED]"));
    }

    #[test]
    fn parse_permission_request_rejects_malformed_shapes() {
        // 缺 toolCall
        assert!(parse_permission_request(Some(&serde_json::json!({
            "sessionId": "s1", "options": [{"optionId": "allow_once"}]
        })))
        .is_none());
        // 缺 toolCallId
        assert!(parse_permission_request(Some(&serde_json::json!({
            "sessionId": "s1", "toolCall": {"title": "t"}, "options": [{"optionId": "allow_once"}]
        })))
        .is_none());
        // 空选项
        assert!(parse_permission_request(Some(&serde_json::json!({
            "sessionId": "s1", "toolCall": {"toolCallId": "c1"}, "options": []
        })))
        .is_none());
        // 缺 params
        assert!(parse_permission_request(None).is_none());
    }

    #[test]
    fn permission_response_wire_shapes_are_stable() {
        // RequestPermissionOutcome 是 internally tagged（tag="outcome"）：
        // Selected → {"outcome": {"outcome": "selected", "optionId": "..."}}
        let selected = permission_response("allow_once");
        assert_eq!(selected["outcome"]["outcome"], "selected");
        assert_eq!(selected["outcome"]["optionId"], "allow_once");
        let rejected = permission_response("reject_once");
        assert_eq!(rejected["outcome"]["optionId"], "reject_once");
        let cancelled = permission_response_cancelled();
        assert_eq!(cancelled["outcome"]["outcome"], "cancelled");
    }

    #[tokio::test]
    async fn resolve_permission_responds_and_clears_pending() {
        let runtime = AgentRuntime::new_disconnected();
        let permission = parse_permission_request(Some(&serde_json::json!({
            "sessionId": "s1",
            "toolCall": {"toolCallId": "call-1", "title": "tool"},
            "options": [{"optionId": "allow_once"}, {"optionId": "reject_once"}]
        })))
        .expect("parse");
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(7, permission);
        // 非法选项拒绝
        assert!(resolve_permission(&runtime, 7, "allow_always")
            .await
            .is_err());
        // 未找到拒绝
        assert!(resolve_permission(&runtime, 99, "allow_once")
            .await
            .is_err());
        // 合法应答：disconnected client 写通道关闭 → 发送失败，但 pending 已清理？
        // disconnected client 的 write_tx send 会失败（无接收端）——resolve 返回 Err 且 pending 保留。
        // 用真实 fake ACP 覆盖发送成功路径（见集成测试）。
        let result = resolve_permission(&runtime, 7, "reject_once").await;
        assert!(result.is_err(), "disconnected client 发送应失败");
        // 失败后 pending 保留（可重试）
        assert!(runtime.pending_permissions.lock().unwrap().contains_key(&7));
    }
}

#[cfg(test)]
mod auto_reconnect_integration_tests {
    use super::*;
    use crate::agent_config::AgentDef;

    /// fake ACP 脚本：FAKE_MODE=crash 时响应首个请求（initialize）后立即退出
    /// → stdout EOF → 崩溃通知；FAKE_MODE=alive 时保持存活并响应请求。
    const FAKE_SCRIPT: &str = r#"import json,sys,os
mode = os.environ.get('FAKE_MODE', 'alive')
for line in sys.stdin:
    request = json.loads(line)
    response = {'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    method = request.get('method')
    if method == 'session/new':
        response['result'] = {'sessionId':'fake-session-1'}
    elif method == 'session/prompt':
        response['result'] = {'stopReason':'end_turn'}
    print(json.dumps(response), flush=True)
    if mode == 'crash':
        sys.exit(0)
"#;

    fn fake_agent(mode: &str) -> AgentDef {
        let mut env = std::collections::HashMap::new();
        env.insert("FAKE_MODE".to_string(), mode.to_string());
        crate::test_utils::fake_acp_agent_with("fake-acp", FAKE_SCRIPT, Vec::new(), env)
    }

    async fn build_state(initial_acp: AcpClient, agent: AgentDef) -> AppState {
        build_state_with(
            initial_acp,
            agent,
            Arc::new(gateway::GatewayCore::new()),
            prism::PrismClient::unavailable("test".to_string()),
        )
        .await
    }

    async fn build_state_with(
        initial_acp: AcpClient,
        agent: AgentDef,
        gateway: Arc<gateway::GatewayCore>,
        prism: prism::PrismClient,
    ) -> AppState {
        let mut agents = std::collections::HashMap::new();
        agents.insert(agent.name.clone(), agent.clone());
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = initial_acp;
        {
            let mut sessions = runtime.sessions.lock().unwrap();
            // 崩溃前已有会话映射（generation 0）——重连后应保留并迁移到新代际
            sessions.insert(
                "source-a".to_string(),
                SessionInfo::new(
                    "fake-session-1".into(),
                    "persona".into(),
                    ".".into(),
                    true,
                    0,
                ),
            );
        }
        let runtimes = Arc::new(AgentRuntimeManager::new());
        runtimes.insert(agent.name.clone(), runtime);
        AppState {
            runtimes,
            agents: Arc::new(Mutex::new(agents)),
            active_agent: Arc::new(Mutex::new(agent.name.clone())),
            pet: Arc::new(Mutex::new(pet::PetState::default())),
            runtime_logs: runtime_log::RuntimeLogHub::default(),
            runtime_mcp: Mutex::new(None),
            prism,
            gateway,
            approval_mode: Arc::new(Mutex::new("default".to_string())),
            pet_last_persist_ms: AtomicU64::new(0),
            pet_write_lock: tokio::sync::Mutex::new(()),
        }
    }

    #[tokio::test]
    async fn fake_acp_crash_triggers_auto_reconnect() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock window must build");

        // 初始连接 crash 模式：initialize 成功但进程立即退出 → EOF → 崩溃通知
        let crash_agent = fake_agent("crash");
        let initial_acp = AcpClient::connect_with_logs(&crash_agent, None)
            .await
            .expect("fake ACP must initialize");
        let state = build_state(initial_acp, crash_agent).await;
        let handles = AppStateHandles::from_state(&state);
        let runtime = handles.active_runtime().expect("active runtime must exist");
        start_notification_dispatcher(&handles, &runtime, window);

        // 等待崩溃被 dispatcher 处理：状态置 Crashed + 自动重连已调度
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let status = runtime
                    .agent_runtime
                    .lock()
                    .map(|r| r.status)
                    .unwrap_or(AgentLifecycleStatus::Disconnected);
                if status == AgentLifecycleStatus::Crashed {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("dispatcher must observe crash within 5s");
        assert!(
            runtime.auto_reconnect_active.load(Ordering::Acquire),
            "auto-reconnect must be scheduled on crash"
        );

        // 注入重连成功：自动重连（2s 退避）开始前把 agents 表切到 alive 模式
        {
            let mut agents = state.agents.lock().unwrap();
            agents.insert("fake-acp".to_string(), fake_agent("alive"));
        }

        // 等待自动重连完成：Connected + generation 前进
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let status = runtime
                    .agent_runtime
                    .lock()
                    .map(|r| r.status)
                    .unwrap_or(AgentLifecycleStatus::Disconnected);
                if status == AgentLifecycleStatus::Connected {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("auto-reconnect must restore Connected within 15s");

        // 断言：generation +1、sessions 保留且迁移到新代际、防重入标志释放
        assert_eq!(
            runtime.client_generation.load(Ordering::Acquire),
            1,
            "auto-reconnect must bump generation"
        );
        {
            let sessions = runtime.sessions.lock().unwrap();
            assert_eq!(sessions.len(), 1, "sessions must survive auto-reconnect");
            assert_eq!(
                sessions.get("source-a").map(|s| s.generation),
                Some(1),
                "kept sessions must migrate generation"
            );
        }
        assert!(
            !runtime.auto_reconnect_active.load(Ordering::Acquire),
            "auto-reconnect flag must release after loop"
        );
    }

    /// A7 回归：洪泛 300 条（> BROADCAST_CAP=256）后 EOF——NOTIF_AGENT_CRASHED 广播
    /// 必然被 Lagged 丢弃（dispatcher 逐条处理期间队列溢出），崩溃信号必须经独立
    /// watch 通道送达，自动重连才仍会触发。
    #[tokio::test]
    async fn flood_crash_still_triggers_auto_reconnect_via_watch() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock window must build");

        // 洪泛崩溃 agent：initialize 成功后连发 300 条 session/update 再退出。
        // 300 > BROADCAST_CAP(256)——广播路径的崩溃通知必然丢失，只有 watch 通道可靠。
        let flood_script = r#"import json,sys
for line in sys.stdin:
    request = json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
        for i in range(300):
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'flood','update':{'sessionUpdate':'agent_message_chunk','content':{'text':'x'}}}}), flush=True)
        break
sys.exit(0)
"#;
        let flood_agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp",
            flood_script,
            Vec::new(),
            std::collections::HashMap::new(),
        );
        let initial_acp = AcpClient::connect_with_logs(&flood_agent, None)
            .await
            .expect("flood fake ACP must initialize");
        let state = build_state(initial_acp, flood_agent).await;
        let handles = AppStateHandles::from_state(&state);
        let runtime = handles.active_runtime().expect("active runtime must exist");
        start_notification_dispatcher(&handles, &runtime, window);

        // 等待崩溃被 dispatcher 处理：状态置 Crashed（经 watch 路径，广播已丢）
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let status = runtime
                    .agent_runtime
                    .lock()
                    .map(|r| r.status)
                    .unwrap_or(AgentLifecycleStatus::Disconnected);
                if status == AgentLifecycleStatus::Crashed {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("dispatcher must observe flood crash via watch within 5s");
        assert!(
            runtime.auto_reconnect_active.load(Ordering::Acquire),
            "auto-reconnect must be scheduled on crash even after broadcast overflow"
        );
    }

    /// 核验回归：崩溃触发自动重连调度后，用户手动 reconnect 成功——
    /// 自动重连闭包复查 status!=Crashed 提前放弃时**必须释放防重入标志**，
    /// 否则下一次崩溃将永远不再自动重连。
    #[tokio::test]
    async fn manual_reconnect_releases_auto_reconnect_flag() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock window must build");

        let crash_agent = fake_agent("crash");
        let initial_acp = AcpClient::connect_with_logs(&crash_agent, None)
            .await
            .expect("fake ACP must initialize");
        let state = build_state(initial_acp, crash_agent).await;
        let handles = AppStateHandles::from_state(&state);
        let runtime = handles.active_runtime().expect("active runtime must exist");
        start_notification_dispatcher(&handles, &runtime, window.clone());

        // 崩溃 → 自动重连已调度（标志 true）
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if runtime.auto_reconnect_active.load(Ordering::Acquire) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("auto-reconnect must be scheduled on crash");

        // 用户手动 reconnect：agents 表切 alive + 走手动连接路径（状态置 Connected）
        {
            let mut agents = state.agents.lock().unwrap();
            agents.insert("fake-acp".to_string(), fake_agent("alive"));
        }
        let agent = state.get_active_agent().expect("active agent");
        do_connect_and_replace(
            &handles,
            &runtime,
            &window,
            &agent,
            None,
            AgentLifecycleStatus::Reconnecting,
            "reconnect",
            false,
            true,
        )
        .await
        .expect("manual reconnect must succeed");

        // 自动重连闭包（2s 退避后复查）发现 status!=Crashed → 提前放弃并释放标志
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                if !runtime.auto_reconnect_active.load(Ordering::Acquire) {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("auto-reconnect flag must release after manual reconnect");
        assert_eq!(
            runtime.client_generation.load(Ordering::Acquire),
            1,
            "manual reconnect must bump generation"
        );
    }

    /// fake ACP：initialize 后主动发 request_permission（id 5），随后把 stdin 收到的
    /// 每一行写入 trace（验证客户端应答 wire）。
    const PERMISSION_SCRIPT: &str = r#"import json,sys,time
trace=open(sys.argv[1],'w',encoding='utf-8')
def emit(obj):
    print(json.dumps(obj), flush=True)
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize':
        emit({'jsonrpc':'2.0','id':request.get('id'),'result':{}})
        time.sleep(0.5)
        emit({'jsonrpc':'2.0','id':5,'method':'session/request_permission','params':{
            'sessionId':'fake-session-p1',
            'toolCall':{'toolCallId':'call-9','title':'edit_file','rawInput':'{"token=SECRET}","path":"x"}'},
            'options':[{'optionId':'allow_once','name':'Allow once','kind':'allowOnce'},
                       {'optionId':'reject_once','name':'Reject','kind':'rejectOnce'}]
        }})
    else:
        trace.write(line)
        trace.flush()
"#;

    #[tokio::test]
    async fn fake_acp_request_permission_pends_then_resolves_on_wire() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-permission-{}.jsonl", std::process::id()));
        let mut env = std::collections::HashMap::new();
        env.insert("FAKE_MODE".to_string(), "alive".to_string());
        let agent = crate::test_utils::fake_acp_agent_with(
            "fake-permission",
            PERMISSION_SCRIPT,
            vec![trace_path.to_string_lossy().into_owned()],
            env,
        );
        let initial_acp = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let state = build_state(initial_acp, agent).await;
        let handles = AppStateHandles::from_state(&state);
        let runtime = handles.active_runtime().expect("active runtime");
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock window must build");
        start_notification_dispatcher(&handles, &runtime, window);

        // 等 dispatcher 挂起权限请求
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let pending = runtime.pending_permissions.lock().unwrap();
                if pending.contains_key(&5) {
                    break;
                }
                drop(pending);
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("dispatcher must pend request_permission");
        let pending = runtime.pending_permissions.lock().unwrap();
        let permission = pending.get(&5).expect("pending entry");
        assert_eq!(permission.tool_call_id, "call-9");
        assert_eq!(permission.options, vec!["allow_once", "reject_once"]);
        assert!(
            !permission.prompt.contains("SECRET"),
            "事件 prompt 必须脱敏"
        );
        drop(pending);

        // 应答（approve_tool_call 等价路径）
        resolve_permission(&runtime, 5, "allow_once")
            .await
            .expect("resolve must succeed");
        assert!(
            !runtime.pending_permissions.lock().unwrap().contains_key(&5),
            "应答后必须清理挂起"
        );

        // 等 fake ACP 收到响应并写入 trace
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if std::fs::metadata(&trace_path)
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("fake ACP must receive response");
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let response: serde_json::Value = serde_json::from_str(trace.trim()).expect("trace line");
        assert_eq!(response["id"], 5);
        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["result"]["outcome"]["outcome"], "selected");
        assert_eq!(response["result"]["outcome"]["optionId"], "allow_once");
    }
}

// ── B11 注入钩子集成测试 ──

#[cfg(test)]
mod b11_inject_integration_tests {
    use super::*;
    use crate::gateway::route;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    /// 记录收到 session/prompt 请求的 fake ACP（trace 文件 + 标准响应）。
    /// 可选流式 chunk（PERSIST_CHUNK 环境变量开启）——先发 agent_message_chunk
    /// 再响应 stopReason（延迟 0.2s 让 dispatcher 先收集回复文本）。
    const TRACE_ACP_SCRIPT: &str = r#"import json,sys,os,time
trace=open(sys.argv[1],'w',encoding='utf-8')
persist_chunk = os.environ.get('PERSIST_CHUNK', '') == '1'
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'session/new':
        response['result']={'sessionId':'fake-inject-session'}
    elif method == 'session/prompt':
        if persist_chunk:
            session_id=request['params']['sessionId']
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'回复文本'}}}}), flush=True)
            time.sleep(0.2)
        trace.write(json.dumps(request)+'\n')
        trace.flush()
        response['result']={'stopReason':'end_turn'}
    print(json.dumps(response), flush=True)
"#;

    fn trace_acp_agent(trace_path: &std::path::Path, chunk: bool) -> AgentDef {
        let mut env = std::collections::HashMap::new();
        env.insert("FAKE_MODE".to_string(), "alive".to_string());
        env.insert(
            "PERSIST_CHUNK".to_string(),
            if chunk {
                "1".to_string()
            } else {
                "0".to_string()
            },
        );
        crate::test_utils::fake_acp_agent_with(
            "fake-acp-trace",
            TRACE_ACP_SCRIPT,
            vec![trace_path.to_string_lossy().into_owned()],
            env,
        )
    }

    const STUB_RESPONSE_BODY: &str =
        r#"{"context":"注入上下文","activated":["uid-1"],"source":"vein"}"#;

    /// Prism /inject 桩：非阻塞轮询处理 expected_requests 次请求（超时自动退出，
    /// 防"不应有请求"的测试卡死 join），完整请求文本发 channel。
    fn spawn_inject_stub(
        expected_requests: usize,
    ) -> (
        std::net::SocketAddr,
        mpsc::Receiver<String>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
        listener.set_nonblocking(true).expect("nonblocking");
        let address = listener.local_addr().expect("address");
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let mut handled = 0usize;
            while handled < expected_requests {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut bytes = Vec::new();
                        let mut buffer = [0_u8; 1024];
                        loop {
                            match stream.read(&mut buffer) {
                                Ok(0) => break,
                                Ok(count) => {
                                    bytes.extend_from_slice(&buffer[..count]);
                                    if let Some(headers_end) =
                                        bytes.windows(4).position(|window| window == b"\r\n\r\n")
                                    {
                                        let headers =
                                            String::from_utf8_lossy(&bytes[..headers_end]);
                                        let length = headers
                                            .lines()
                                            .find_map(|line| line.strip_prefix("Content-Length: "))
                                            .and_then(|value| value.trim().parse::<usize>().ok())
                                            .unwrap_or(0);
                                        if bytes.len() >= headers_end + 4 + length {
                                            break;
                                        }
                                    }
                                }
                                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                    if std::time::Instant::now() > deadline {
                                        return;
                                    }
                                    thread::sleep(Duration::from_millis(20));
                                }
                                Err(_) => return,
                            }
                        }
                        let _ = request_tx.send(String::from_utf8(bytes).expect("request UTF-8"));
                        handled += 1;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            STUB_RESPONSE_BODY.len(), STUB_RESPONSE_BODY
                        );
                        let _ = stream.write_all(response.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if std::time::Instant::now() > deadline {
                            return;
                        }
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => return,
                }
            }
        });
        (address, request_rx, server)
    }

    fn gateway_with_inject(yaml: &str) -> Arc<gateway::GatewayCore> {
        Arc::new(gateway::GatewayCore::from_config(
            route::parse_config(yaml).expect("合法配置"),
        ))
    }

    fn inject_prompt_text(trace_path: &std::path::Path) -> String {
        let trace = std::fs::read_to_string(trace_path).expect("read trace");
        let request: serde_json::Value = trace
            .lines()
            .map(|line| serde_json::from_str(line).expect("trace line"))
            .find(|value: &serde_json::Value| {
                value.get("method").and_then(|m| m.as_str()) == Some("session/prompt")
            })
            .expect("prompt request must be traced");
        request["params"]["prompt"][0]["text"]
            .as_str()
            .expect("prompt text")
            .to_string()
    }

    /// mock 环境：owned app + window；state() 借用 app（生命周期安全）。
    struct MockEnv {
        app: tauri::App<tauri::test::MockRuntime>,
        window: tauri::Window<tauri::test::MockRuntime>,
        _webview: tauri::WebviewWindow<tauri::test::MockRuntime>,
    }

    impl MockEnv {
        fn new(state: AppState) -> Self {
            let app = tauri::test::mock_builder()
                .build(tauri::test::mock_context(tauri::test::noop_assets()))
                .expect("mock app must build");
            app.manage(state);
            let webview = tauri::WebviewWindowBuilder::new(
                &app,
                "main",
                tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
            )
            .build()
            .expect("mock webview must build");
            let window = webview.as_ref().window();
            Self {
                app,
                window,
                _webview: webview,
            }
        }

        fn state(&self) -> tauri::State<'_, AppState> {
            self.app.state::<AppState>()
        }
    }

    /// b11 模块专用 state 构造（auto_reconnect_integration_tests 的
    /// build_state_with 是兄弟模块私有项，不能跨模块引用）。
    async fn build_state_with(
        initial_acp: AcpClient,
        agent: AgentDef,
        gateway: Arc<gateway::GatewayCore>,
        prism: prism::PrismClient,
    ) -> AppState {
        let mut agents = std::collections::HashMap::new();
        agents.insert(agent.name.clone(), agent.clone());
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = initial_acp;
        let runtimes = Arc::new(AgentRuntimeManager::new());
        runtimes.insert(agent.name.clone(), runtime);
        AppState {
            runtimes,
            agents: Arc::new(Mutex::new(agents)),
            active_agent: Arc::new(Mutex::new(agent.name.clone())),
            pet: Arc::new(Mutex::new(pet::PetState::default())),
            runtime_logs: runtime_log::RuntimeLogHub::default(),
            runtime_mcp: Mutex::new(None),
            prism,
            gateway,
            approval_mode: Arc::new(Mutex::new("default".to_string())),
            pet_last_persist_ms: AtomicU64::new(0),
            pet_write_lock: tokio::sync::Mutex::new(()),
        }
    }

    #[tokio::test]
    async fn inject_prepends_context_and_advances_round_per_message() {
        let (address, request_rx, server) = spawn_inject_stub(2);
        let trace_path =
            std::env::temp_dir().join(format!("pylon-b11-trace-{}.jsonl", std::process::id()));
        let agent = trace_acp_agent(&trace_path, false);
        let initial_acp = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let gateway = gateway_with_inject(
            r#"
gateway:
  inject:
    scenario: trpg
    sources: [vein]
"#,
        );
        let prism = prism::PrismClient::for_testing(
            format!("http://{}", address),
            Some("test-token".to_string()),
        );
        let state = build_state_with(initial_acp, agent, gateway, prism).await;
        let env = MockEnv::new(state);

        send_message(
            env.state(),
            env.window.clone(),
            "source-b11".to_string(),
            "你好".to_string(),
            String::new(),
            None,
            None,
            None,
        )
        .await
        .expect("first message must send");
        assert_eq!(inject_prompt_text(&trace_path), "注入上下文\n\n你好");
        let first_request = request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first inject request");
        let first_body: serde_json::Value = first_request
            .split("\r\n\r\n")
            .nth(1)
            .expect("body")
            .parse()
            .expect("body JSON");
        assert_eq!(first_body["scenario"], "trpg");
        assert_eq!(first_body["sources"], serde_json::json!(["vein"]));
        assert_eq!(first_body["user_msg"], "你好");
        assert_eq!(first_body["round"], 0);

        send_message(
            env.state(),
            env.window.clone(),
            "source-b11".to_string(),
            "继续".to_string(),
            String::new(),
            None,
            None,
            None,
        )
        .await
        .expect("second message must send");
        let second_request = request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("second inject request");
        let second_body: serde_json::Value = second_request
            .split("\r\n\r\n")
            .nth(1)
            .expect("body")
            .parse()
            .expect("body JSON");
        assert_eq!(second_body["round"], 1);
        assert_eq!(second_body["user_msg"], "继续");

        server.join().expect("stub thread");
        std::fs::remove_file(&trace_path).ok();
    }

    #[tokio::test]
    async fn inject_disabled_passes_plain_text_through() {
        let (address, request_rx, server) = spawn_inject_stub(1);
        let trace_path =
            std::env::temp_dir().join(format!("pylon-b11-disabled-{}.jsonl", std::process::id()));
        let agent = trace_acp_agent(&trace_path, false);
        let initial_acp = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let gateway = gateway_with_inject(
            r#"
gateway:
  inject:
    enabled: false
"#,
        );
        let prism =
            prism::PrismClient::for_testing(format!("http://{}", address), Some("t".to_string()));
        let state = build_state_with(initial_acp, agent, gateway, prism).await;
        let env = MockEnv::new(state);

        send_message(
            env.state(),
            env.window.clone(),
            "source-b11-off".to_string(),
            "你好".to_string(),
            String::new(),
            None,
            None,
            None,
        )
        .await
        .expect("message must send");
        assert_eq!(inject_prompt_text(&trace_path), "你好");
        assert!(request_rx.try_recv().is_err(), "禁用注入时不得调用 /inject");
        server.join().expect("stub thread");
        std::fs::remove_file(&trace_path).ok();
    }

    #[tokio::test]
    async fn inject_unavailable_degrades_without_injection() {
        let trace_path = std::env::temp_dir().join(format!(
            "pylon-b11-unavailable-{}.jsonl",
            std::process::id()
        ));
        let agent = trace_acp_agent(&trace_path, false);
        let initial_acp = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let gateway = gateway_with_inject(
            r#"
gateway:
  inject:
    enabled: true
"#,
        );
        let state = build_state_with(
            initial_acp,
            agent,
            gateway,
            prism::PrismClient::unavailable("test".to_string()),
        )
        .await;
        let env = MockEnv::new(state);

        send_message(
            env.state(),
            env.window.clone(),
            "source-b11-ua".to_string(),
            "你好".to_string(),
            String::new(),
            None,
            None,
            None,
        )
        .await
        .expect("message must send without injection");
        assert_eq!(inject_prompt_text(&trace_path), "你好");
        std::fs::remove_file(&trace_path).ok();
    }

    #[tokio::test]
    async fn command_message_skips_injection() {
        let (address, request_rx, server) = spawn_inject_stub(1);
        let trace_path =
            std::env::temp_dir().join(format!("pylon-b11-cmd-{}.jsonl", std::process::id()));
        let agent = trace_acp_agent(&trace_path, false);
        let initial_acp = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let gateway = gateway_with_inject(
            r#"
gateway:
  inject:
    enabled: true
"#,
        );
        let prism =
            prism::PrismClient::for_testing(format!("http://{}", address), Some("t".to_string()));
        let state = build_state_with(initial_acp, agent, gateway, prism).await;
        let env = MockEnv::new(state);

        send_message(
            env.state(),
            env.window.clone(),
            "source-b11-cmd".to_string(),
            "/status".to_string(),
            String::new(),
            None,
            None,
            None,
        )
        .await
        .expect("command message must send");
        assert_eq!(inject_prompt_text(&trace_path), "/status");
        assert!(request_rx.try_recv().is_err(), "命令消息不得触发 /inject");
        server.join().expect("stub thread");
        std::fs::remove_file(&trace_path).ok();
    }

    #[tokio::test]
    async fn persist_prism_mode_sends_round_with_streamed_response() {
        let (address, request_rx, server) = spawn_inject_stub(2);
        let trace_path =
            std::env::temp_dir().join(format!("pylon-b11-persist-{}.jsonl", std::process::id()));
        let agent = trace_acp_agent(&trace_path, true);
        let initial_acp = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let gateway = gateway_with_inject(
            r#"
gateway:
  inject:
    enabled: true
    scenario: trpg
    persist: prism
"#,
        );
        let prism = prism::PrismClient::for_testing(
            format!("http://{}", address),
            Some("test-token".to_string()),
        );
        let state = build_state_with(initial_acp, agent, gateway, prism).await;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock webview must build");
        // 启动 dispatcher：流式收集回复文本（persist 依赖）
        let handles = AppStateHandles::from_state(app.state::<AppState>().inner());
        let runtime = handles.active_runtime().expect("active runtime");
        start_notification_dispatcher(&handles, &runtime, webview.clone());
        let window = webview.as_ref().window();

        send_message(
            app.state::<AppState>(),
            window,
            "source-b11-persist".to_string(),
            "你好".to_string(),
            String::new(),
            None,
            None,
            None,
        )
        .await
        .expect("message must send");

        // 第一个请求 = /inject（round 0）
        let first = request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("inject request");
        assert!(first.starts_with("POST /inject HTTP/1.1"));
        // 第二个请求 = /persist（round 0 + 流式回复文本）
        let second = request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("persist request");
        assert!(second.starts_with("POST /persist HTTP/1.1"));
        let body: serde_json::Value = second
            .split("\r\n\r\n")
            .nth(1)
            .expect("body")
            .parse()
            .expect("body JSON");
        assert_eq!(body["scenario"], "trpg");
        assert_eq!(body["user_msg"], "你好");
        assert_eq!(body["response"], "回复文本");
        assert_eq!(body["round"], 0);

        server.join().expect("stub thread");
        std::fs::remove_file(&trace_path).ok();
    }

    #[test]
    fn inject_prompt_composition_is_plain_and_conditional() {
        assert_eq!(
            compose_inject_prompt("世界书上下文", "用户消息"),
            "世界书上下文\n\n用户消息"
        );
        assert_eq!(compose_inject_prompt("", "用户消息"), "用户消息");
        assert_eq!(compose_inject_prompt("   ", "用户消息"), "用户消息");
        assert_eq!(compose_inject_prompt("上下文", ""), "上下文\n\n");
        assert!(inject_applies_to("普通消息"));
        assert!(inject_applies_to("  hello"));
        assert!(!inject_applies_to("/command"));
        assert!(!inject_applies_to("  /command"));
    }

    #[test]
    fn extract_tool_file_name_parses_sanitized_summary() {
        assert_eq!(
            extract_tool_file_name(r#"{"path": "G:/project/src/lib.rs"}"#).as_deref(),
            Some("G:/project/src/lib.rs")
        );
        assert_eq!(
            extract_tool_file_name(r#"{"file": "main.ts", "op": "edit"}"#).as_deref(),
            Some("main.ts")
        );
        assert_eq!(
            extract_tool_file_name(r#"{"command": "ls"}"#),
            None,
            "无文件名键不提取"
        );
        assert_eq!(
            extract_tool_file_name(r#"{"path": ""}"#),
            None,
            "空路径不提取"
        );
        assert_eq!(extract_tool_file_name("not json at all"), None);
        // 只取顶层 path 值，不把 rawInput（可能含 secret）带出
        let raw = r#"{"path": "src/x.rs", "token": "SECRET"}"#;
        assert_eq!(extract_tool_file_name(raw).as_deref(), Some("src/x.rs"));
    }

    #[test]
    fn extract_tool_file_name_ignores_embedded_path_fragments() {
        // 审查修复回归：值内嵌的 "path": 片段不得被当作文件名（防 secret 以文件名形态落盘）
        let embedded = r#"{"input": "config says \"path\":\"sk-abc123\""}"#;
        assert_eq!(
            extract_tool_file_name(embedded),
            None,
            "非顶层键的内嵌 path 片段必须忽略"
        );
        // 非 JSON 形态一律不提取
        assert_eq!(extract_tool_file_name(r#"{path: x}"#), None);
        assert_eq!(extract_tool_file_name(r#""path":"src/x.rs""#), None);
    }
}

// ── B4.2 MCP 配置持久化测试 ──

#[cfg(test)]
mod mcp_persist_tests {
    use super::*;
    use std::collections::HashMap;

    fn sample_servers() -> Vec<mcp::McpServerConfig> {
        vec![
            mcp::McpServerConfig {
                id: Some("files".into()),
                name: None,
                transport: "stdio".into(),
                enabled: true,
                command: Some("npx".into()),
                args: vec!["-y".into(), "mcp-server-filesystem".into()],
                env: [("API_TOKEN".to_string(), "secret-value".to_string())]
                    .into_iter()
                    .collect(),
                url: None,
                headers: HashMap::new(),
                oauth: None,
                disabled: false,
            },
            mcp::McpServerConfig {
                id: None,
                name: Some("remote".into()),
                transport: "http".into(),
                enabled: true,
                command: None,
                args: Vec::new(),
                env: HashMap::new(),
                url: Some("http://127.0.0.1:3000/mcp".into()),
                headers: [("Authorization".to_string(), "Bearer x".to_string())]
                    .into_iter()
                    .collect(),
                oauth: None,
                disabled: false,
            },
        ]
    }

    #[test]
    fn load_round_trips_servers_with_secrets() {
        let dir = std::env::temp_dir().join(format!("pylon-mcp-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pylon-mcp.json");
        std::fs::write(&path, serde_json::to_string(&sample_servers()).unwrap()).unwrap();
        let loaded = load_mcp_persisted(&path).expect("valid file must load");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id.as_deref(), Some("files"));
        assert_eq!(
            loaded[0].env.get("API_TOKEN").map(String::as_str),
            Some("secret-value"),
            "secret 必须保留（本地配置文件）"
        );
        assert_eq!(loaded[1].url.as_deref(), Some("http://127.0.0.1:3000/mcp"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_missing_or_corrupt_returns_none() {
        let dir = std::env::temp_dir().join(format!("pylon-mcp-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing.json");
        assert!(load_mcp_persisted(&missing).is_none(), "缺失文件应降级");
        let corrupt = dir.join("corrupt.json");
        std::fs::write(&corrupt, "{not json").unwrap();
        assert!(load_mcp_persisted(&corrupt).is_none(), "损坏文件应降级");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_rejects_hand_edited_invalid_config() {
        let dir = std::env::temp_dir().join(format!("pylon-mcp-invalid-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("invalid.json");
        // 重复 identity：validate 应拒绝 → 整体不加载（防手改文件注入非法配置）
        let invalid = serde_json::json!([
            {"id": "dup", "transport": "stdio", "command": "a"},
            {"id": "dup", "transport": "stdio", "command": "b"}
        ]);
        std::fs::write(&path, invalid.to_string()).unwrap();
        assert!(load_mcp_persisted(&path).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn set_mcp_servers_persists_to_disk_and_restores() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        let state = AppState {
            runtimes: Arc::new(AgentRuntimeManager::new()),
            agents: Arc::new(Mutex::new(HashMap::new())),
            active_agent: Arc::new(Mutex::new(String::new())),
            pet: Arc::new(Mutex::new(pet::PetState::default())),
            runtime_logs: runtime_log::RuntimeLogHub::default(),
            runtime_mcp: Mutex::new(None),
            prism: prism::PrismClient::unavailable("test".to_string()),
            gateway: Arc::new(gateway::GatewayCore::new()),
            approval_mode: Arc::new(Mutex::new("default".to_string())),
            pet_last_persist_ms: AtomicU64::new(0),
            pet_write_lock: tokio::sync::Mutex::new(()),
        };
        app.manage(state);
        let path = match mcp_persist_path(&app.handle()) {
            Ok(path) => path,
            Err(_) => return, // mock 环境无 config dir 时跳过（不验证持久化）
        };
        let _ = std::fs::remove_file(&path);

        set_mcp_servers(
            app.handle().clone(),
            app.state::<AppState>(),
            Some(sample_servers()),
        )
        .await
        .expect("set_mcp_servers must succeed");
        let loaded = load_mcp_persisted(&path).expect("命令后文件必须存在且可加载");
        assert_eq!(loaded.len(), 2);
        assert_eq!(
            loaded[0].env.get("API_TOKEN").map(String::as_str),
            Some("secret-value")
        );

        // 清空配置 → 落盘空数组（非删除）
        set_mcp_servers(
            app.handle().clone(),
            app.state::<AppState>(),
            Some(Vec::new()),
        )
        .await
        .expect("clear must succeed");
        let cleared = load_mcp_persisted(&path).expect("cleared file must load");
        assert!(cleared.is_empty());
        std::fs::remove_file(&path).ok();
    }
}

// ── 会话过期平台判定测试（核验修复） ──

#[cfg(test)]
mod session_expiry_platform_tests {
    use super::*;

    const ECHO_ACP_SCRIPT: &str = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if request.get('method') == 'session/new':
        response['result']={'sessionId':'expiry-session'}
    print(json.dumps(response), flush=True)
"#;

    fn echo_agent() -> AgentDef {
        crate::test_utils::fake_acp_agent("fake-acp-echo", ECHO_ACP_SCRIPT)
    }

    /// 模块内 state 构造（兄弟模块的 build_state_with 不可访问）。
    async fn build_state_with(
        initial_acp: AcpClient,
        agent: AgentDef,
        gateway: Arc<gateway::GatewayCore>,
        prism: prism::PrismClient,
    ) -> AppState {
        let mut agents = std::collections::HashMap::new();
        agents.insert(agent.name.clone(), agent.clone());
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = initial_acp;
        let runtimes = Arc::new(AgentRuntimeManager::new());
        runtimes.insert(agent.name.clone(), runtime);
        AppState {
            runtimes,
            agents: Arc::new(Mutex::new(agents)),
            active_agent: Arc::new(Mutex::new(agent.name.clone())),
            pet: Arc::new(Mutex::new(pet::PetState::default())),
            runtime_logs: runtime_log::RuntimeLogHub::default(),
            runtime_mcp: Mutex::new(None),
            prism,
            gateway,
            approval_mode: Arc::new(Mutex::new("default".to_string())),
            pet_last_persist_ms: AtomicU64::new(0),
            pet_write_lock: tokio::sync::Mutex::new(()),
        }
    }

    #[tokio::test]
    async fn expiry_watcher_skips_local_sessions_and_resets_platform_sessions() {
        let agent = echo_agent();
        let initial_acp = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let gateway = Arc::new(gateway::GatewayCore::from_config(
            gateway::route::parse_config(
                r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#,
            )
            .expect("合法配置"),
        ));
        let state = build_state_with(
            initial_acp,
            agent,
            gateway,
            prism::PrismClient::unavailable("test".to_string()),
        )
        .await;

        let runtime = state.active_runtime().expect("active runtime");
        {
            let mut sessions = runtime.sessions.lock().unwrap();
            // 清理 build_state_with 预置的 source-a，插入过期/平台两类会话
            sessions.clear();
            let mut local =
                SessionInfo::new("local-peri".into(), String::new(), ".".into(), true, 0);
            local.updated_at = Some(Timestamp::new(1)); // 1970 年，必然过期
            sessions.insert("local".to_string(), local);
            let mut platform =
                SessionInfo::new("platform-peri".into(), String::new(), ".".into(), true, 0);
            platform.updated_at = Some(Timestamp::new(1));
            sessions.insert("qq:group:123".to_string(), platform);
        }

        check_session_expiry(&state).await;

        let sessions = runtime.sessions.lock().unwrap();
        assert!(
            sessions.contains_key("local"),
            "GUI local 会话必须豁免过期重置"
        );
        assert!(
            !sessions.contains_key("qq:group:123"),
            "平台会话过期必须 close + 移除"
        );
    }
}

// ── B10.4 平台链路集成测试（fake QQ 事件 → ingest → 注入 → fake ACP → deliver 回发） ──

#[cfg(test)]
mod b10_gateway_integration_tests {
    use super::*;
    use crate::gateway::qq::{auth::QqAuth, QqAdapter};
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    /// fake ACP：prompt 时先发一条流式 chunk（deliver 回发的文本），再响应 end_turn。
    const CHUNK_ACP_SCRIPT: &str = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'session/new':
        response['result']={'sessionId':'b10-session'}
    elif method == 'session/prompt':
        session_id=request['params']['sessionId']
        print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'QQ 回复内容'}}}}), flush=True)
        response['result']={'stopReason':'end_turn'}
    print(json.dumps(response), flush=True)
"#;

    fn chunk_acp_agent() -> AgentDef {
        crate::test_utils::fake_acp_agent("fake-acp-chunk", CHUNK_ACP_SCRIPT)
    }

    /// 模块内 state 构造。
    async fn build_state_with(
        initial_acp: AcpClient,
        agent: AgentDef,
        gateway: Arc<gateway::GatewayCore>,
    ) -> AppState {
        let mut agents = std::collections::HashMap::new();
        agents.insert(agent.name.clone(), agent.clone());
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = initial_acp;
        let runtimes = Arc::new(AgentRuntimeManager::new());
        runtimes.insert(agent.name.clone(), runtime);
        AppState {
            runtimes,
            agents: Arc::new(Mutex::new(agents)),
            active_agent: Arc::new(Mutex::new(agent.name.clone())),
            pet: Arc::new(Mutex::new(pet::PetState::default())),
            runtime_logs: runtime_log::RuntimeLogHub::default(),
            runtime_mcp: Mutex::new(None),
            prism: prism::PrismClient::unavailable("test".to_string()),
            gateway,
            approval_mode: Arc::new(Mutex::new("default".to_string())),
            pet_last_persist_ms: AtomicU64::new(0),
            pet_write_lock: tokio::sync::Mutex::new(()),
        }
    }

    /// QQ API 桩：捕获发送请求（Content-Length 完整读取），返回 {"id":"sent-1"}。
    fn spawn_qq_api_stub() -> (
        std::net::SocketAddr,
        mpsc::Receiver<String>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
        let address = listener.local_addr().expect("address");
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 4096];
            loop {
                let count = stream.read(&mut buffer).expect("read request");
                if count == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(headers_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&bytes[..headers_end]);
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("Content-Length: "))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if bytes.len() >= headers_end + 4 + length {
                        break;
                    }
                }
            }
            request_tx
                .send(String::from_utf8(bytes).expect("request UTF-8"))
                .expect("send request");
            let body = r#"{"id":"sent-1"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            let _ = stream.write_all(response.as_bytes());
        });
        (address, request_rx, server)
    }

    #[tokio::test]
    async fn qq_ingest_to_deliver_end_to_end_with_reply_anchor() {
        let (_qq_api_address, qq_request_rx, qq_server) = spawn_qq_api_stub();
        // gateway：qq:group:123 → peri 绑定；注入关闭（本测试不依赖 Prism）
        let gateway = Arc::new(gateway::GatewayCore::from_config(
            gateway::route::parse_config(
                r#"
gateway:
  inject:
    enabled: false
  routes:
    - source: qq:group:123
      agent: fake-acp-chunk
      profile: trpg
      session: 战役1
"#,
            )
            .expect("合法配置"),
        ));
        // QQ 适配器注册（test token + 桩地址，避免真实 QQ API）
        let qq_http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(10))
            .build()
            .expect("http client");
        let qq_auth = Arc::new(QqAuth::for_testing("test-token".to_string()));
        let qq_adapter = QqAdapter::for_testing(
            gateway.clone(),
            qq_http.clone(),
            qq_auth.clone(),
            format!("http://{_qq_api_address}"),
        );
        gateway.register(qq_adapter.clone()).expect("register qq");

        let agent = chunk_acp_agent();
        let initial_acp = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let state = build_state_with(initial_acp, agent, gateway.clone()).await;
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock webview must build");
        // dispatcher：chunk 转发 → deliver_all → QQ 适配器
        let handles = AppStateHandles::from_state(app.state::<AppState>().inner());
        let runtime = handles.active_runtime().expect("active runtime");
        start_notification_dispatcher(&handles, &runtime, webview.clone());
        let main_window = webview.as_ref().window();

        // ingest handler 接线（模拟 run() setup：绑定 agent 路由 + 发送）
        let app_handle = app.handle().clone();
        let window_for_handler = main_window.clone();
        gateway.set_ingest_handler(Arc::new(move |resolved: &gateway::ResolvedIngest| {
            let app = app_handle.clone();
            let window = window_for_handler.clone();
            let resolved = resolved.clone();
            tokio::spawn(async move {
                let state = app.state::<AppState>();
                let agent_id = resolved
                    .binding
                    .as_ref()
                    .map(|b| b.agent_id.clone())
                    .unwrap_or_default();
                let runtime = state.inner().runtimes.get_or_create(&agent_id);
                if let Err(error) = send_prompt_core(
                    state.inner(),
                    &runtime,
                    Some(&window),
                    &state.gateway,
                    &resolved.source,
                    &resolved.content,
                    "",
                    None,
                    None,
                    None,
                    None,
                )
                .await
                {
                    log::warn!("ingest send failed: {error}");
                }
            });
        }));

        // 平台消息入站：去重 + 白名单 + ingest + dispatch（B10.4 链路起点）
        let resolved = qq_adapter
            .handle_incoming("qq:group:123", "msg-1", "你好", Some("member-1"), None)
            .expect("ingest must resolve")
            .expect("新消息必须处理");
        assert_eq!(resolved.source, "qq:group:123");
        assert_eq!(
            resolved.binding.as_ref().unwrap().agent_id,
            "fake-acp-chunk"
        );

        // 中间断言：send_prompt_core 必须建立平台会话（handler 链路通的证据）
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let sessions = app
                    .state::<AppState>()
                    .inner()
                    .active_runtime()
                    .map(|r| {
                        r.sessions
                            .lock()
                            .map(|s| s.contains_key("qq:group:123"))
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                if sessions {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("ingest handler 必须建立平台会话（send_prompt_core 链路）");

        // 等待 deliver 回发到达 QQ API 桩
        let request = qq_request_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("QQ API 桩必须收到 deliver");
        assert!(
            request.starts_with("POST /v2/groups/123/messages HTTP/1.1"),
            "URL: {request:.100}"
        );
        assert!(
            request.contains("authorization: QQBot test-token")
                || request.contains("Authorization: QQBot test-token")
        );
        let body: serde_json::Value = request
            .split("\r\n\r\n")
            .nth(1)
            .expect("body")
            .parse()
            .expect("body JSON");
        assert_eq!(
            body["content"], "QQ 回复内容",
            "deliver 文本必须来自 fake ACP 流式 chunk"
        );
        assert_eq!(body["msg_type"], 0);
        assert_eq!(
            body["msg_id"], "msg-1",
            "回复锚点必须取 chat 最新 msg_id（dedup latest_for）"
        );

        qq_server.join().expect("stub thread");
    }
}

/// 会话过期判定（B10.3b，参考 Hermes reset policy）：返回过期原因，None = 未过期。
///
/// - reset="off"：永不过期
/// - reset="daily"：按 UTC 日历天比较（updated_at 与 now 不同天 → 过期）
/// - 其他（默认 idle）：`now - updated_at > idle_minutes` → 过期
///   updated_at 缺失（历史数据）视为未过期（保守，防误杀）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let agents = match agent_config::load() {
        Ok(agents) => agents,
        Err(error) => {
            eprintln!("Pylon agent configuration error: {error}");
            HashMap::new()
        }
    };
    let default_agent_id = match agent_config::default_agent_id(&agents) {
        Ok(Some(id)) => id,
        Ok(None) => String::new(),
        Err(error) => {
            eprintln!("Pylon agent configuration error: {error}");
            String::new()
        }
    };
    let default_agent = agents.get(&default_agent_id).cloned();
    let agents_for_state = agents;

    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(error) => {
            eprintln!("Pylon runtime initialization failed: {error}");
            return;
        }
    };
    rt.block_on(async {
        let prism = match PrismClient::from_env() {
            Ok(client) => client,
            Err(error) => {
                eprintln!("Pylon Prism client unavailable: {error}");
                PrismClient::unavailable(error)
            }
        };
        let runtime_logs = runtime_log::RuntimeLogHub::default();
        let gateway = Arc::new(GatewayCore::new());
        // QQ 适配器（B10.2）：凭据存在时创建 auth + adapter + WS 循环并注册进 gateway。
        // PYLON_QQ_CLIENT_SECRET 为 secret：只读入 QqAuth，不进任何输出。
        if let (Ok(qq_app_id), Ok(qq_client_secret)) = (
            std::env::var("PYLON_QQ_APP_ID"),
            std::env::var("PYLON_QQ_CLIENT_SECRET"),
        ) {
            let qq_http = match reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(30))
                .build()
            {
                Ok(client) => client,
                Err(error) => {
                    eprintln!("Pylon QQ HTTP client unavailable: {error}");
                    reqwest::Client::new()
                }
            };
            let qq_auth = Arc::new(gateway::qq::auth::QqAuth::new(
                qq_http.clone(),
                qq_app_id,
                qq_client_secret,
            ));
            let qq_adapter = gateway::qq::QqAdapter::new(gateway.clone(), qq_http.clone(), qq_auth.clone());
            if let Err(error) = gateway.register(qq_adapter.clone()) {
                eprintln!("Pylon QQ adapter register failed: {error}");
            } else {
                log::info!("QQ 适配器已注册（PYLON_QQ_APP_ID）");
                tokio::spawn(gateway::qq::ws::run_ws_loop(qq_http, qq_auth, qq_adapter));
            }
        }
        let runtimes = Arc::new(AgentRuntimeManager::new());
        let default_runtime = AgentRuntime::new_disconnected();
        {
            // 默认 agent 初始连接：成功 → Connected；失败 → Error（保留错误信息）
            if let Some(agent) = &default_agent {
                match AcpClient::connect_with_logs(agent, Some(runtime_logs.clone())).await {
                    Ok(client) => {
                        let mut acp = default_runtime.acp.lock().await;
                        *acp = client;
                        drop(acp);
                        if let Ok(mut state) = default_runtime.agent_runtime.lock() {
                            state.status = AgentLifecycleStatus::Connected;
                            state.last_error = None;
                            state.last_connected_at = Some(crate::time::Timestamp::now());
                        }
                    }
                    Err(error) => {
                        eprintln!("Pylon ACP agent unavailable: {error}");
                        if let Ok(mut state) = default_runtime.agent_runtime.lock() {
                            state.status = AgentLifecycleStatus::Error;
                            state.last_error = Some(error.to_string());
                            state.last_connected_at = None;
                        }
                    }
                }
            } else {
                eprintln!("Pylon has no configured Agent; start in disconnected mode");
            }
        }
        if !default_agent_id.is_empty() {
            runtimes.insert(default_agent_id.clone(), default_runtime);
        }

        tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_fs::init())
            .manage(AppState {
                runtimes,
                agents: Arc::new(Mutex::new(agents_for_state)),
                active_agent: Arc::new(Mutex::new(default_agent_id)),
                pet: Arc::new(Mutex::new(pet::PetState::default())),
                runtime_logs,
                runtime_mcp: Mutex::new(None),
                prism,
                gateway,
                approval_mode: Arc::new(Mutex::new("default".to_string())),
                pet_last_persist_ms: AtomicU64::new(0),
                pet_write_lock: tokio::sync::Mutex::new(()),
            })
            .invoke_handler(tauri::generate_handler![
                crate::prism_cmds::prism_health, crate::prism_cmds::prism_status, crate::prism_cmds::prism_state, crate::prism_cmds::prism_scenarios, crate::prism_cmds::prism_sources, crate::prism_cmds::prism_aliases, crate::prism_cmds::prism_config,
                crate::prism_cmds::prism_logs, crate::prism_cmds::prism_chronicle, crate::prism_cmds::prism_history, crate::prism_cmds::prism_scenario, crate::prism_cmds::prism_blocks,
                crate::prism_cmds::prism_inject, crate::prism_cmds::prism_command, crate::prism_cmds::prism_create_scenario, crate::prism_cmds::prism_delete_scenario,
                crate::prism_cmds::prism_create_source, crate::prism_cmds::prism_delete_source, crate::prism_cmds::prism_source_detail, crate::prism_cmds::prism_source_files,
                crate::prism_cmds::prism_read_source_file, crate::prism_cmds::prism_write_source_file, crate::prism_cmds::prism_delete_source_file,
                crate::prism_cmds::prism_source_entries, crate::prism_cmds::prism_source_entry, crate::prism_cmds::prism_add_source_entry, crate::prism_cmds::prism_edit_source_entry,
                crate::prism_cmds::prism_delete_source_entry,
                crate::prism_cmds::prism_update_config, crate::prism_cmds::prism_update_scenario, crate::prism_cmds::prism_create_block, crate::prism_cmds::prism_update_block,
                crate::prism_cmds::prism_delete_block, crate::prism_cmds::prism_add_scenario_block, crate::prism_cmds::prism_edit_scenario_block,
                crate::prism_cmds::prism_delete_scenario_block, crate::prism_cmds::prism_reorder_scenario_blocks, crate::prism_cmds::prism_reload, crate::prism_cmds::prism_llm_test,
                crate::session::new_session, crate::session::send_message, crate::session::set_mode, crate::session::set_config_option, crate::session::close_session, crate::session::cancel_prompt, crate::session::load_sessions,
                crate::session::session_inspector, crate::lifecycle::list_agents, crate::lifecycle::switch_agent, crate::lifecycle::reconnect_agent, crate::lifecycle::agent_status, crate::lifecycle::reload_agents, crate::lifecycle::set_mcp_servers,
                crate::lifecycle::validate_agents,
                crate::permission::approve_tool_call, crate::permission::set_approval_mode,
                crate::pet_cmds::get_pet, crate::pet_cmds::pet_action,
                crate::session::load_persisted_session, crate::session::list_persisted_sessions,
                crate::export::export_session,
                crate::logs_cmds::list_runtime_logs, crate::logs_cmds::clear_runtime_logs, crate::logs_cmds::push_frontend_log,
                crate::workspace_cmds::get_workspace_root, crate::workspace_cmds::list_workspace_entries, crate::workspace_cmds::read_workspace_text,
                crate::workspace_cmds::git_status, crate::workspace_cmds::git_diff, crate::workspace_cmds::git_history,
                crate::gateway_cmds::gateway_status, crate::gateway_cmds::reload_gateway,
            ])
            .setup(|app| {
                let window = app.get_webview_window("main").ok_or("main window not found")?;
                if let Err(error) = window.set_title("Pylon") { log::warn!("set window title failed: {error}"); }
                // 宠物状态落盘加载：文件缺失/损坏时保持新宠物（静默降级）
                match pet_persist_path(app.handle()) {
                    Ok(path) => {
                        if let Some(saved) = pet::load_from_file(&path) {
                            let pet_arc = app.state::<AppState>().pet.clone();
                            if let Ok(mut pet) = pet_arc.lock() {
                                pet::restore(&mut pet, saved);
                            };
                        }
                    }
                    Err(error) => log::warn!("resolve pet persist path failed: {error}"),
                }
                // B4.2：MCP 配置落盘加载（重启不丢）。文件缺失/损坏/非法 → 保持空配置（静默降级）。
                match mcp_persist_path(app.handle()) {
                    Ok(path) => {
                        if let Some(servers) = load_mcp_persisted(&path) {
                            if let Ok(mut slot) = app.state::<AppState>().runtime_mcp.lock() {
                                *slot = Some(servers);
                                log::info!("MCP 配置已从 {} 恢复", path.display());
                            }
                        }
                    }
                    Err(error) => log::warn!("resolve MCP persist path failed: {error}"),
                }
                let handles = AppStateHandles::from_state(app.state::<AppState>().inner());
                if let Some(runtime) = handles.active_runtime() {
                    start_notification_dispatcher(&handles, &runtime, window.clone());
                }
                app.state::<AppState>().inner().start_runtime_log_dispatcher(window);
                // gateway ingest handler（B10.3）：平台消息 → 绑定/默认 agent runtime → 发送。
                // 平台消息路由不切换 GUI active agent；目标 agent 未连接时懒启动
                // （announce=false，不广播 GUI 状态）。
                {
                    let app_handle = app.handle().clone();
                    let main_webview = app.get_webview_window("main");
                    let main_window = main_webview.as_ref().map(|w| w.as_ref().window());
                    let state = app.state::<AppState>();
                    state.gateway.set_ingest_handler(Arc::new(move |resolved: &gateway::ResolvedIngest| {
                        let app = app_handle.clone();
                        let webview = main_webview.clone();
                        let window = main_window.clone();
                        let resolved = resolved.clone();
                        tokio::spawn(async move {
                            let state = app.state::<AppState>();
                            let agent_id = resolved.binding.as_ref().map(|b| b.agent_id.clone())
                                .unwrap_or_else(|| {
                                    state.inner().active_agent.lock().map(|v| v.clone()).unwrap_or_default()
                                });
                            if agent_id.is_empty() {
                                log::warn!("gateway ingest 无路由目标（未绑定且无 active agent）: {}", resolved.source);
                                return;
                            }
                            let runtime = state.inner().runtimes.get_or_create(&agent_id);
                            if let Some(webview) = webview.as_ref() {
                                if let Err(error) = state.inner().ensure_runtime_ready(&runtime, &agent_id, webview).await {
                                    log::warn!("gateway ingest 目标 agent 连接失败 ({agent_id}): {error}");
                                    return;
                                }
                            }
                            // P1-1：平台路由绑定 agent ≠ GUI active agent 时会话 cwd 必须用
                            // 绑定 agent 的 cwd（而非 active agent）；无绑定 agent 定义时回退 None。
                            let agent_cwd = state.inner().agents.lock().ok()
                                .and_then(|agents| agents.get(&agent_id).cloned())
                                .and_then(|agent| agent.cwd);
                            if let Err(error) = send_prompt_core(
                                state.inner(),
                                &runtime,
                                window.as_ref(),
                                &state.gateway,
                                &resolved.source,
                                &resolved.content,
                                "",
                                None,
                                None,
                                None,
                                agent_cwd.as_deref(),
                            ).await {
                                log::warn!("gateway ingest 发送失败 ({}): {error}", resolved.source);
                            }
                        });
                    }));
                }
                // 会话过期 watcher（B10.3b）：每 60s 检查所有 runtime 的平台会话，
                // 按绑定 reset 策略（idle/daily/off）过期并重置（close + 平台通知）。
                // 同循环检查挂起权限请求超时（B9.2：超时默认拒绝）。
                {
                    let app_for_watcher = app.handle().clone();
                    tokio::spawn(async move {
                        loop {
                            tokio::time::sleep(Duration::from_secs(60)).await;
                            let state = app_for_watcher.state::<AppState>();
                            check_session_expiry(state.inner()).await;
                            check_pending_permission_timeouts(state.inner()).await;
                        }
                    });
                }
                Ok(())
            })
            // 关窗时不在此处 block_on kill——run() 由 rt.block_on 驱动，窗口回调在
            // 同一 runtime 栈内执行，嵌套 block_on 必 panic ("Cannot start a runtime
            // from within a runtime")。子进程清理依赖 AppState drop 链：
            // AcpClient → ManagedChild::drop → kill_and_wait（同步 std 操作，不依赖 tokio）。
            .build(tauri::generate_context!())
            .expect("error while building tauri application")
            .run(|app_handle: &tauri::AppHandle, event: tauri::RunEvent| {
                if let tauri::RunEvent::Exit = event {
                    // 退出兜底：最后持久化一次（get_pet 12s 轮询已覆盖大部分变更）
                    let pet_arc = app_handle.state::<AppState>().pet.clone();
                    if let Ok(pet) = pet_arc.try_lock() {
                        persist_pet_if_possible(app_handle, &pet);
                    };
                }
            });
    });
}
