//! Agent 生命周期：连接/切换/registry 命令 + MCP 配置持久化（R1 拆分自 lib.rs；行为零变化）。

use std::sync::Arc;

use crate::acp::AcpClient;
use crate::agent_config::AgentDef;
use crate::agent_runtime::{status_after_connection_failure, AgentLifecycleStatus};
use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::AppState;
use crate::AppStateHandles;
use tauri::Manager;

pub(crate) async fn do_connect_and_replace<R: tauri::Runtime>(
    handles: &AppStateHandles,
    runtime: &Arc<AgentRuntime>,
    window: &tauri::WebviewWindow<R>,
    agent: &AgentDef,
    agent_id: Option<String>,
    start_status: AgentLifecycleStatus,
    log_action: &str,
    keep_sessions: bool,
    announce: bool,
) -> Result<(), String> {
    let previous_status = runtime.agent_runtime.lock()
        .map(|state| state.status)
        .unwrap_or(AgentLifecycleStatus::Disconnected);
    if announce {
        handles.emit_agent_status(runtime, window, start_status, None);
    }
    handles.log_runtime_summary("info", "agent", agent_id.clone(), &format!("Agent {log_action} started"), serde_json::Map::new());
    let new_acp = match AcpClient::connect_with_logs(agent, Some(handles.runtime_logs.clone())).await {
        Ok(client) => client,
        Err(error) => {
            let fallback_status = status_after_connection_failure(previous_status);
            if announce {
                handles.emit_agent_status(runtime, window, fallback_status, Some(error.to_string()));
            }
            handles.log_runtime_summary("error", "agent", agent_id, &format!("Agent {log_action} failed"), serde_json::Map::new());
            return Err(error.into());
        }
    };
    handles.replace_agent_client(runtime, agent_id, new_acp, window.clone(), keep_sessions).await?;
    if announce {
        handles.emit_agent_status(runtime, window, AgentLifecycleStatus::Connected, None);
    }
    let _ = handles.pet.lock().map(|mut p| crate::pet::on_agent_connected(&mut p));
    handles.log_runtime_summary("info", "agent", None, &format!("Agent {log_action} succeeded"), serde_json::Map::new());
    Ok(())
}


pub(crate) fn agent_summary_payload(id: &str, agent: &AgentDef, active_id: Option<&str>, active_status: Option<AgentLifecycleStatus>) -> serde_json::Value {
    let available = active_id.map_or(false, |aid| id == aid)
        && active_status == Some(AgentLifecycleStatus::Connected);
    let active = active_id.map_or(false, |aid| id == aid);
    serde_json::json!({
        // list_agents 的 id 是 registry key，name 仅用于展示。
        "id": id,
        "name": agent.name,
        "transport": agent.transport,
        "available": available,
        "active": active,
        "cwd": agent.cwd.clone(),
    })
}

#[tauri::command]
pub(crate) async fn list_agents(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, PylonError> {
    let active_id = state.active_agent.lock().map_err(|e| e.to_string())?.clone();
    let active_status = state.active_runtime()
        .and_then(|runtime| runtime.agent_runtime.lock().ok().map(|state| state.status))
        .unwrap_or(AgentLifecycleStatus::Disconnected);
    Ok(state.agents.lock().map_err(|e| e.to_string())?.iter().map(|(id, a)| {
        agent_summary_payload(id, a, Some(&active_id), Some(active_status))
    }).collect())
}

#[tauri::command]
pub(crate) async fn validate_agents() -> Result<serde_json::Value, PylonError> {
    let agents = crate::agent_config::load()?;
    let default_agent_id = crate::agent_config::default_agent_id(&agents)?;
    let summaries = agents.iter()
        .map(|(id, agent)| agent_summary_payload(id, agent, None, None))
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "valid": true,
        "defaultAgentId": default_agent_id,
        "agents": summaries,
    }))
}

#[tauri::command]
pub(crate) async fn switch_agent(state: tauri::State<'_, AppState>, window: tauri::WebviewWindow, name: String) -> Result<(), PylonError> {
    let inner = state.inner();
    // P3：先查 registry 确认 agent 存在，再 get_or_create——未知 agent 直接报错，
    // 不得留下幽灵 runtime（disconnected 且永不连接的空注册项）。
    if !inner.agents.lock().map_err(|error| error.to_string())?.contains_key(&name) {
        return Err(PylonError::Protocol(format!("unknown agent: {name}")));
    }
    // 目标 runtime 懒启动（首次切换创建 disconnected runtime）
    let runtime = inner.runtimes.get_or_create(&name);
    let previous_active = inner.active_agent.lock().map_err(|error| error.to_string())?.clone();
    let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
    let agent = inner.agents.lock().map_err(|error| error.to_string())?
        .get(&name)
        .ok_or_else(|| format!("unknown agent: {name}"))?
        .clone();
    inner.connect_and_replace(&runtime, &window, &agent, Some(name.clone()), AgentLifecycleStatus::Connecting, "switch").await?;
    // 切到不同 agent 时：先停旧 dispatcher 再 kill 旧 acp，防止 kill 触发旧
    // runtime 的崩溃通知被旧 dispatcher 处理并调度自动重连；旧状态置 Disconnected。
    if previous_active != name {
        if let Some(old) = inner.runtimes.get(&previous_active) {
            if let Ok(mut task) = old.notification_task.lock() {
                if let Some(handle) = task.take() { handle.abort(); }
            }
            let mut acp = old.acp.lock().await;
            let _ = acp.kill();
            drop(acp);
            if let Ok(mut state) = old.agent_runtime.lock() {
                state.status = AgentLifecycleStatus::Disconnected;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn reconnect_agent(state: tauri::State<'_, AppState>, window: tauri::WebviewWindow) -> Result<(), PylonError> {
    let inner = state.inner();
    let active_id = inner.active_agent.lock().map_err(|error| error.to_string())?.clone();
    let runtime = inner.runtimes.get_or_create(&active_id);
    let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
    let agent = inner.get_active_agent().map_err(|error| error.to_string())?;
    inner.connect_and_replace(&runtime, &window, &agent, None, AgentLifecycleStatus::Reconnecting, "reconnect").await.map_err(PylonError::from)
}

#[tauri::command]
pub(crate) async fn agent_status(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, PylonError> {
    let inner = state.inner();
    // P2-3：崩溃检测显式前置（acp 已死 → 记录 Crashed + lastError），
    // 随后 getter 只读构造 payload——响应形状（status/lastError/recentError/error）
    // 是前端契约，保持不变。
    let runtime = inner.active_runtime();
    AppStateHandles::detect_and_record_crashes(runtime.as_deref());
    Ok(inner.agent_status_payload())
}

#[tauri::command]
pub(crate) async fn set_mcp_servers<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<Vec<serde_json::Value>, String> {
    let serialized = crate::mcp::validate_and_serialize(servers.clone())?;
    let persisted = servers.clone();
    *state.runtime_mcp.lock().map_err(|error| error.to_string())? = servers;
    // B4.2：配置落盘（重启不丢）。写失败只 warn，不阻断本次设置。
    persist_mcp_if_possible(&app, persisted.as_deref().unwrap_or_default());
    Ok(serialized)
}

#[tauri::command]
pub(crate) async fn reload_agents(state: tauri::State<'_, AppState>, config_path: Option<String>) -> Result<(), PylonError> {
    let runtime = state.inner().require_runtime()?;
    let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
    let new_agents = if let Some(path) = config_path {
        crate::agent_config::load_from_path(std::path::Path::new(&path))?
    } else {
        crate::agent_config::load()?
    };
    crate::agent_config::default_agent_id(&new_agents)?;
    let active_agent = state.active_agent.lock().map_err(|error| error.to_string())?.clone();
    if !new_agents.contains_key(&active_agent) {
        return Err(PylonError::Protocol(format!("agent config cannot remove active agent: {active_agent}")));
    }
    let agent_count = new_agents.len();
    let mut agents = state.agents.lock().map_err(|e| e.to_string())?;
    *agents = new_agents;
    state.inner().log_runtime_summary( "info", "agent", None, "Agent registry reloaded", serde_json::Map::from_iter([
        ("agentCount".to_string(), serde_json::Value::from(agent_count)),
    ]));
    Ok(())
}


// ── B4.2 MCP 配置持久化 ──

/// MCP 配置落盘路径：app_config_dir/pylon-mcp.json。
/// 注意：env/headers 可能含 secret，文件是本地用户配置（写盘是持久化目的），
/// 但不进任何日志/输出。
pub(crate) fn mcp_persist_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("pylon-mcp.json"))
}

/// 原子写 MCP 配置：临时文件 + rename，中断不留半截 JSON。
/// 写失败只 warn，不阻断主流程（尽力持久化）。
pub(crate) fn persist_mcp_if_possible<R: tauri::Runtime>(app: &tauri::AppHandle<R>, servers: &[crate::mcp::McpServerConfig]) {
    let path = match mcp_persist_path(app) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("resolve MCP persist path failed: {error}");
            return;
        }
    };
    let json = match serde_json::to_string(servers) {
        Ok(json) => json,
        Err(error) => {
            log::warn!("serialize MCP config failed: {error}");
            return;
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log::warn!("create MCP persist directory failed: {error}");
            return;
        }
    }
    // 审查修复：唯一 temp（pid+时间戳）——并发 set_mcp_servers 不得互相截断写坏
    let unique = path.with_file_name(format!(
        ".{}.{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("mcp"),
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0),
    ));
    let result = (|| {
        std::fs::write(&unique, json.as_bytes()).map_err(|error| format!("write temporary MCP config failed: {error}"))?;
        std::fs::rename(&unique, &path).map_err(|error| format!("commit MCP config failed: {error}"))
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&unique);
        log::warn!("persist MCP config failed: {error}");
    }
}

/// 加载 MCP 持久化配置：文件缺失/损坏 → None（启动时静默降级为空配置）。
/// 内容过 validate_and_serialize（防手改文件注入非法配置）——校验失败视为损坏。
pub(crate) fn load_mcp_persisted(path: &std::path::Path) -> Option<Vec<crate::mcp::McpServerConfig>> {
    let raw = std::fs::read_to_string(path).ok()?;
    let servers: Vec<crate::mcp::McpServerConfig> = serde_json::from_str(&raw).ok()?;
    match crate::mcp::validate_and_serialize(Some(servers.clone())) {
        Ok(_) => Some(servers),
        Err(error) => {
            log::warn!("loaded MCP config invalid; ignored: {error}");
            None
        }
    }
}


// ── B9 权限审批 commands ──
// ── Session persistence commands ──

#[cfg(test)]
mod tests {
    use super::*;

    fn agent() -> AgentDef {
        crate::test_utils::fake_acp_agent("peri", "print('x')")
    }

    #[test]
    fn summary_marks_active_and_available_only_when_connected() {
        let a = agent();
        let disconnected = agent_summary_payload("peri", &a, Some("peri"), Some(AgentLifecycleStatus::Disconnected));
        assert_eq!(disconnected["active"], true);
        assert_eq!(disconnected["available"], false, "未连接不算可用");
        let connected = agent_summary_payload("peri", &a, Some("peri"), Some(AgentLifecycleStatus::Connected));
        assert_eq!(connected["available"], true, "连接后 available 才为 true");
    }

    #[test]
    fn summary_non_active_agent_is_neither_active_nor_available() {
        let a = agent();
        let payload = agent_summary_payload("peri", &a, Some("hermes"), Some(AgentLifecycleStatus::Connected));
        assert_eq!(payload["id"], "peri");
        assert_eq!(payload["name"], "peri");
        assert_eq!(payload["transport"], "subprocess");
        assert_eq!(payload["active"], false);
        assert_eq!(payload["available"], false, "非 active agent 即使有连接也不可用");
    }

    #[test]
    fn summary_without_active_context_is_inactive() {
        let a = agent();
        let payload = agent_summary_payload("peri", &a, None, None);
        assert_eq!(payload["active"], false);
        assert_eq!(payload["available"], false);
    }
}

