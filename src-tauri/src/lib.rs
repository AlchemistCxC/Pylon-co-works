mod acp;
mod agent_config;
mod agent_runtime;
mod error;
mod gateway;
mod mcp;
mod pet;
mod prism;
mod runtime;
mod runtime_log;
mod workspace;

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, Runtime};
use acp::{AcpClient, PromptWaitOutcome};
use agent_config::AgentDef;
use agent_runtime::{session_mapping_matches, source_for_peri_id_in_generation, status_after_connection_failure, AgentLifecycleStatus, AgentRuntimeState};
use error::PylonError;
use gateway::GatewayCore;
use prism::PrismClient;
use runtime::{AgentRuntime, AgentRuntimeManager};

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
fn emit_event_all<R, W>(window: &W, gateway: &GatewayCore, source: &str, event: &str, payload: serde_json::Value)
where
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
struct AppState {
    runtimes: Arc<AgentRuntimeManager>,
    agents: Arc<Mutex<HashMap<String, AgentDef>>>,
    active_agent: Arc<Mutex<String>>,
    pet: Arc<Mutex<pet::PetState>>,
    runtime_logs: Arc<runtime_log::RuntimeLogHub>,
    runtime_mcp: Mutex<Option<Vec<mcp::McpServerConfig>>>,
    prism: PrismClient,
    gateway: Arc<GatewayCore>,
    /// 权限审批模式（B9.3）：bypass/auto 自动批准；edit/default 挂起询问。
    approval_mode: Arc<Mutex<String>>,
}

/// 供 async 闭包/静态辅助持有的 AppState 字段子集。
/// Tauri manage 的 state 不能 move 进闭包，只能 clone 字段；
/// start_notification_dispatcher / do_connect_and_replace / 自动重连共用。
/// per-agent 状态经 [`Self::active_runtime`] / 参数传入的 runtime 访问。
struct AppStateHandles {
    runtimes: Arc<AgentRuntimeManager>,
    agents: Arc<Mutex<HashMap<String, AgentDef>>>,
    active_agent: Arc<Mutex<String>>,
    pet: Arc<Mutex<pet::PetState>>,
    runtime_logs: Arc<runtime_log::RuntimeLogHub>,
    gateway: Arc<GatewayCore>,
    approval_mode: Arc<Mutex<String>>,
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
        self.runtime_logs.push(runtime_log::timestamp(), level, source, session, message, fields);
    }

    fn set_agent_runtime_status(&self, runtime: &AgentRuntime, status: AgentLifecycleStatus, last_error: Option<String>) {
        if let Ok(mut runtime) = runtime.agent_runtime.lock() {
            runtime.status = status;
            runtime.last_error = last_error;
            if status == AgentLifecycleStatus::Connected {
                runtime.last_connected_at = Some(runtime_log::timestamp());
            }
        }
    }

    fn agent_status_payload(&self, runtime: Option<&AgentRuntime>) -> serde_json::Value {
        let crashed = runtime
            .and_then(|runtime| runtime.acp.try_lock().ok())
            .map(|acp| acp.is_crashed())
            .unwrap_or(false);
        if crashed {
            if let Some(runtime) = runtime {
                if let Ok(mut state) = runtime.agent_runtime.lock() {
                    state.status = AgentLifecycleStatus::Crashed;
                    if state.last_error.is_none() {
                        state.last_error = Some("ACP child process stdout closed".to_string());
                    }
                }
            }
        }
        let (status, last_error, last_connected_at) = runtime
            .and_then(|runtime| runtime.agent_runtime.lock().ok().map(|state| state.clone()))
            .map(|state| (state.status, state.last_error, state.last_connected_at))
            .unwrap_or((AgentLifecycleStatus::Disconnected, None, None));
        let active_agent_id = self.active_agent.lock().ok().map(|value| value.clone()).unwrap_or_default();
        let agent = self.agents.lock().ok().and_then(|agents| agents.get(&active_agent_id).cloned());
        let crashed = matches!(status, AgentLifecycleStatus::Crashed)
            || runtime
                .and_then(|runtime| runtime.acp.try_lock().ok())
                .map(|acp| acp.is_crashed())
                .unwrap_or(false);
        let status = if crashed { AgentLifecycleStatus::Crashed } else { status };
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
        emit_event(window, "peri:agent-status", {
            let mut payload = self.agent_status_payload(Some(runtime));
            if let serde_json::Value::Object(ref mut map) = payload {
                map.insert("status".to_string(), serde_json::Value::String(status.as_str().to_string()));
                if let Some(error) = last_error {
                    let error = serde_json::Value::String(error);
                    map.insert("lastError".to_string(), error.clone());
                    map.insert("recentError".to_string(), error.clone());
                    map.insert("error".to_string(), error);
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

/// 连接并替换客户端（connect_and_replace 的静态辅助版本）。
/// 手动 switch/reconnect 传 keep_sessions=false；自动重连传 true（崩溃恢复续会话）。
async fn do_connect_and_replace<R: tauri::Runtime>(
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
                handles.emit_agent_status(runtime, window, fallback_status, Some(error.clone()));
            }
            handles.log_runtime_summary("error", "agent", agent_id, &format!("Agent {log_action} failed"), serde_json::Map::new());
            return Err(error.into());
        }
    };
    handles.replace_agent_client(runtime, agent_id, new_acp, window.clone(), keep_sessions).await?;
    if announce {
        handles.emit_agent_status(runtime, window, AgentLifecycleStatus::Connected, None);
    }
    let _ = handles.pet.lock().map(|mut p| pet::on_agent_connected(&mut p));
    handles.log_runtime_summary("info", "agent", None, &format!("Agent {log_action} succeeded"), serde_json::Map::new());
    Ok(())
}

#[tauri::command]
async fn prism_health(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.prism.get("/health").await
}

#[tauri::command]
async fn prism_status(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(state.prism.status().await)
}

#[tauri::command]
async fn prism_state(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.prism.get("/state").await
}

#[tauri::command]
async fn prism_scenarios(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.prism.get("/api/scenarios").await
}

#[tauri::command]
async fn prism_sources(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.prism.get("/api/sources").await
}

#[tauri::command]
async fn prism_aliases(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.prism.get("/api/aliases").await
}

#[tauri::command]
async fn prism_config(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    state.prism.get_query("/api/config", [("name", name)]).await
}

#[tauri::command]
async fn prism_logs(
    state: tauri::State<'_, AppState>,
    log_type: Option<String>,
    limit: Option<u64>,
    offset: Option<u64>,
) -> Result<serde_json::Value, String> {
    let mut query = Vec::new();
    if let Some(value) = log_type { query.push(("type".to_string(), value)); }
    if let Some(value) = limit { query.push(("limit".to_string(), value.to_string())); }
    if let Some(value) = offset { query.push(("offset".to_string(), value.to_string())); }
    state.prism.get_query("/api/logs", query).await
}

#[tauri::command]
async fn prism_chronicle(
    state: tauri::State<'_, AppState>,
    scenario: Option<String>,
) -> Result<serde_json::Value, String> {
    let query = scenario.into_iter().map(|value| ("scenario".to_string(), value)).collect::<Vec<_>>();
    state.prism.get_query("/api/chronicle", query).await
}

#[tauri::command]
async fn prism_history(
    state: tauri::State<'_, AppState>,
    scenario: Option<String>,
    limit: Option<u64>,
    offset: Option<u64>,
) -> Result<serde_json::Value, String> {
    let mut query = Vec::new();
    if let Some(value) = scenario { query.push(("scenario".to_string(), value)); }
    if let Some(value) = limit { query.push(("limit".to_string(), value.to_string())); }
    if let Some(value) = offset { query.push(("offset".to_string(), value.to_string())); }
    state.prism.get_query("/api/history", query).await
}

#[tauri::command]
async fn prism_scenario(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    state.prism.get_query("/api/scenario", [("name", name)]).await
}

#[tauri::command]
async fn prism_blocks(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.prism.get("/api/blocks").await
}

#[tauri::command]
async fn prism_inject(
    state: tauri::State<'_, AppState>,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.prism.post("/inject", request).await
}

#[tauri::command]
async fn prism_command(
    state: tauri::State<'_, AppState>,
    command: String,
) -> Result<serde_json::Value, String> {
    state.prism.post("/command", serde_json::json!({"command": command})).await
}

#[tauri::command]
async fn prism_create_scenario(
    state: tauri::State<'_, AppState>,
    name: String,
    yaml: String,
) -> Result<serde_json::Value, String> {
    state.prism.post("/api/scenarios", serde_json::json!({"name": name, "yaml": yaml})).await
}

#[tauri::command]
async fn prism_delete_scenario(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    state.prism.post_query("/api/scenarios/delete", [("name", name)], serde_json::json!({})).await
}

#[tauri::command]
async fn prism_create_source(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    state.prism.post("/api/sources", serde_json::json!({"name": name})).await
}

#[tauri::command]
async fn prism_delete_source(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    state.prism.post_query("/api/sources/delete", [("name", name)], serde_json::json!({})).await
}

#[tauri::command]
async fn prism_source_detail(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    state.prism.get_query("/api/source/detail", [("name", name)]).await
}

#[tauri::command]
async fn prism_source_files(
    state: tauri::State<'_, AppState>,
    name: String,
) -> Result<serde_json::Value, String> {
    state.prism.get_query("/api/sources/files", [("name", name)]).await
}

#[tauri::command]
async fn prism_read_source_file(
    state: tauri::State<'_, AppState>,
    name: String,
    path: String,
) -> Result<serde_json::Value, String> {
    state.prism.get_query("/api/sources/file", [("name", name), ("path", path)]).await
}

#[tauri::command]
async fn prism_write_source_file(
    state: tauri::State<'_, AppState>,
    name: String,
    path: String,
    content: String,
) -> Result<serde_json::Value, String> {
    state.prism.put_query("/api/sources/file", [("name", name), ("path", path)], serde_json::json!({"content": content})).await
}

#[tauri::command]
async fn prism_delete_source_file(
    state: tauri::State<'_, AppState>,
    name: String,
    path: String,
) -> Result<serde_json::Value, String> {
    state.prism.delete_query("/api/sources/file", [("name", name), ("path", path)]).await
}

#[tauri::command]
async fn prism_source_entries(
    state: tauri::State<'_, AppState>,
    source: String,
    scenario: String,
) -> Result<serde_json::Value, String> {
    state.prism.get_query("/api/source/entries", [("source", source), ("scenario", scenario)]).await
}

#[tauri::command]
async fn prism_source_entry(
    state: tauri::State<'_, AppState>,
    source: String,
    scenario: String,
    uid: String,
) -> Result<serde_json::Value, String> {
    state.prism.get_query("/api/source/entry", [("source", source), ("scenario", scenario), ("uid", uid)]).await
}

#[tauri::command]
async fn prism_add_source_entry(
    state: tauri::State<'_, AppState>,
    source: String,
    scenario: String,
    entry: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.prism.post_query("/api/source/entry/add", [("source", source), ("scenario", scenario)], serde_json::json!({"entry": entry})).await
}

#[tauri::command]
async fn prism_edit_source_entry(
    state: tauri::State<'_, AppState>,
    source: String,
    scenario: String,
    uid: String,
    entry: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.prism.put_query("/api/source/entry/edit", [("source", source), ("scenario", scenario), ("uid", uid)], serde_json::json!({"entry": entry})).await
}

#[tauri::command]
async fn prism_delete_source_entry(
    state: tauri::State<'_, AppState>,
    source: String,
    scenario: String,
    uid: String,
) -> Result<serde_json::Value, String> {
    state.prism.post_query("/api/source/entry/delete", [("source", source), ("scenario", scenario), ("uid", uid)], serde_json::json!({})).await
}

#[tauri::command]
async fn prism_update_config(
    state: tauri::State<'_, AppState>,
    name: String,
    yaml: String,
) -> Result<serde_json::Value, String> {
    state.prism.put_query("/api/config", [("name", name)], serde_json::json!({"yaml": yaml})).await
}

#[tauri::command]
async fn prism_update_scenario(
    state: tauri::State<'_, AppState>,
    name: String,
    update: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.prism.put_query("/api/scenario", [("name", name)], update).await
}

#[tauri::command]
async fn prism_create_block(
    state: tauri::State<'_, AppState>,
    block: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.prism.post("/api/blocks", serde_json::json!({"block": block})).await
}

#[tauri::command]
async fn prism_update_block(
    state: tauri::State<'_, AppState>,
    id: String,
    block: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.prism.put_query("/api/blocks", [("id", id)], serde_json::json!({"block": block})).await
}

#[tauri::command]
async fn prism_delete_block(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, String> {
    state.prism.delete_query("/api/blocks", [("id", id)]).await
}

#[tauri::command]
async fn prism_add_scenario_block(
    state: tauri::State<'_, AppState>,
    scenario: String,
    block: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.prism.post_query("/api/scenario/blocks/add", [("scenario", scenario)], serde_json::json!({"block": block})).await
}

#[tauri::command]
async fn prism_edit_scenario_block(
    state: tauri::State<'_, AppState>,
    scenario: String,
    id: String,
    block: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.prism.put_query("/api/scenario/blocks/edit", [("scenario", scenario), ("id", id)], serde_json::json!({"block": block})).await
}

#[tauri::command]
async fn prism_delete_scenario_block(
    state: tauri::State<'_, AppState>,
    scenario: String,
    id: String,
) -> Result<serde_json::Value, String> {
    state.prism.post_query("/api/scenario/blocks/delete", [("scenario", scenario), ("id", id)], serde_json::json!({})).await
}

#[tauri::command]
async fn prism_reorder_scenario_blocks(
    state: tauri::State<'_, AppState>,
    scenario: String,
    blocks: serde_json::Value,
) -> Result<serde_json::Value, String> {
    state.prism.put_query("/api/scenario/blocks/reorder", [("scenario", scenario)], serde_json::json!({"blocks": blocks})).await
}

#[tauri::command]
async fn prism_reload(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.prism.post("/reload", serde_json::json!({})).await
}

#[tauri::command]
async fn prism_llm_test(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    state.prism.post("/api/llm/test", serde_json::json!({})).await
}


#[tauri::command]
async fn list_runtime_logs(state: tauri::State<'_, AppState>, query: Option<runtime_log::RuntimeLogQuery>) -> Result<Vec<runtime_log::RuntimeLogEntry>, PylonError> {
    Ok(state.runtime_logs.list(&query.unwrap_or_default()))
}

#[tauri::command]
async fn clear_runtime_logs(state: tauri::State<'_, AppState>) -> Result<(), PylonError> {
    state.runtime_logs.clear();
    Ok(())
}

#[tauri::command]
async fn push_frontend_log(
    state: tauri::State<'_, AppState>, _window: tauri::Window, level: String, source: Option<String>, session: Option<String>, message: String,
    fields: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<runtime_log::RuntimeLogEntry, String> {
    Ok(state.runtime_logs.push(
        runtime_log::timestamp(),
        level,
        source.unwrap_or_else(|| "frontend".into()),
        session,
        message,
        fields.unwrap_or_default(),
    ))
}

fn agent_summary_payload(id: &str, agent: &AgentDef, active_id: Option<&str>, active_status: Option<AgentLifecycleStatus>) -> serde_json::Value {
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
async fn get_workspace_root(state: tauri::State<'_, AppState>, source: String) -> Result<workspace::WorkspaceRoot, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let root = state.inner().workspace_root_for_source(&runtime, &source)?;
    Ok(workspace::workspace_root(source, std::path::Path::new(&root)))
}

#[tauri::command]
async fn list_workspace_entries(
    state: tauri::State<'_, AppState>, source: String, relative_path: Option<String>, include_hidden: Option<bool>,
) -> Result<Vec<workspace::WorkspaceEntry>, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let root = state.inner().workspace_root_for_source(&runtime, &source)?;
    workspace::list_entries(std::path::Path::new(&root), relative_path.as_deref().unwrap_or("."), include_hidden.unwrap_or(false)).map_err(|e| PylonError::Workspace(e.to_string()))
}

#[tauri::command]
async fn read_workspace_text(
    state: tauri::State<'_, AppState>, source: String, relative_path: String, max_bytes: Option<usize>,
) -> Result<workspace::WorkspaceTextPreview, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let root = state.inner().workspace_root_for_source(&runtime, &source)?;
    workspace::read_text(std::path::Path::new(&root), &relative_path, max_bytes).map_err(|e| PylonError::Workspace(e.to_string()))
}

fn prompt_lock_for(
    locks: &Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    source: &str,
) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = locks.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(source.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn start_notification_dispatcher<R: tauri::Runtime>(handles: &AppStateHandles, runtime: &Arc<AgentRuntime>, window: tauri::WebviewWindow<R>) {
    if let Ok(mut task) = runtime.notification_task.lock() {
        if let Some(handle) = task.take() { handle.abort(); }
        let acp = runtime.acp.clone();
        let sessions = runtime.sessions.clone();
        let pet = handles.pet.clone();
        let generation = runtime.client_generation.load(Ordering::Acquire);
        let client_generation = runtime.client_generation.clone();
        let agents = handles.agents.clone();
        let active_agent = handles.active_agent.clone();
        let agent_runtime = runtime.agent_runtime.clone();
        let runtime_logs = handles.runtime_logs.clone();
        let runtimes = handles.runtimes.clone();
        let gateway = handles.gateway.clone();
        let approval_mode = handles.approval_mode.clone();
        let pending_permissions = runtime.pending_permissions.clone();
        let runtime_for_reconnect = runtime.clone();
        *task = Some(tokio::spawn(async move {
            let mut rx = acp.lock().await.rx.resubscribe();
            loop {
                if client_generation.load(Ordering::Acquire) != generation {
                    break;
                }
                let raw = match rx.recv().await {
                    Ok(raw) => raw,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("notification dispatcher lagged by {} messages", n);
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
                if client_generation.load(Ordering::Acquire) != generation {
                    break;
                }
                if raw.method.as_deref() == Some(acp::NOTIF_AGENT_CRASHED) {
                    let last_error = "ACP child process stdout closed".to_string();
                    if let Ok(mut runtime_state) = agent_runtime.lock() {
                        runtime_state.status = AgentLifecycleStatus::Crashed;
                        runtime_state.last_error = Some(last_error.clone());
                    }
                    let _ = pet.lock().map(|mut p| pet::on_agent_crashed(&mut p));
                    let runtime_state = agent_runtime.lock().map(|value| value.clone()).unwrap_or_default();
                    let active_id = active_agent.lock().ok().map(|value| value.clone()).unwrap_or_default();
                    let agent = agents.lock().ok().and_then(|items| items.get(&active_id).cloned());
                    let last_error = runtime_state.last_error.clone();
                    let recent_error = last_error.clone();
                    let legacy_error = last_error.clone();
                    emit_event(&window, "peri:agent-status", serde_json::json!({
                        // agentId 是 registry key；agentName/agent 仅用于展示兼容。
                        "agentId": active_id,
                        "agentName": agent.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
                        "agent": agent.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
                        "status": AgentLifecycleStatus::Crashed.as_str(),
                        "transport": agent.as_ref().map(|value| value.transport.clone()).unwrap_or_default(),
                        "cwd": agent.as_ref().and_then(|value| value.cwd.clone()).unwrap_or_default(),
                        "lastError": last_error,
                        "recentError": recent_error,
                        "error": legacy_error,
                        "lastConnectedAt": runtime_state.last_connected_at,
                        "generation": client_generation.load(Ordering::Acquire),
                        "active": agent.is_some(),
                        "available": false,
                        "crashed": true,
                    }));
                    // 自动重连：崩溃后指数退避自动拉起（最多 5 次，~62s）。
                    // 防重入：多次崩溃通知只调度一次（auto_reconnect_active）。
                    // per-runtime 语义：只重连本 runtime 绑定的 agent；用户手动
                    // reconnect 会置状态非 Crashed、手动 switch 会改变 active_agent，
                    // 循环内每轮复查后放弃。切换 agent 不会串扰其他 runtime。
                    if runtime_for_reconnect.auto_reconnect_active.swap(true, Ordering::AcqRel) == false {
                        let reconnect_runtime = runtime_for_reconnect.clone();
                        let window_for_reconnect = window.clone();
                        let reconnect_handles = AppStateHandles {
                            runtimes: runtimes.clone(),
                            agents: agents.clone(),
                            active_agent: active_agent.clone(),
                            pet: pet.clone(),
                            runtime_logs: runtime_logs.clone(),
                            gateway: gateway.clone(),
                            approval_mode: approval_mode.clone(),
                        };
                        tokio::spawn(async move {
                            // 手动 switch 会 abort 本 runtime 的 dispatcher，但不会
                            // cancel 自动重连闭包——每轮用 active_agent 复查拦截，
                            // 防止重连成功后把 active_agent 顶回本 agent。
                            let reconnect_agent_id = reconnect_handles.active_agent.lock().ok().map(|v| v.clone()).unwrap_or_default();
                            for attempt in 1..=agent_runtime::MAX_RECONNECT_ATTEMPTS {
                                tokio::time::sleep(Duration::from_millis(agent_runtime::reconnect_backoff_ms(attempt))).await;
                                // 用户已手动 reconnect（状态不再是 Crashed）→ 放弃自动重连
                                let still_stale = reconnect_runtime.agent_runtime.lock()
                                    .map(|r| r.status == AgentLifecycleStatus::Crashed)
                                    .unwrap_or(false);
                                if !still_stale {
                                    // 核验修复：提前放弃也必须释放防重入标志，
                                    // 否则后续崩溃将永远不再自动重连。
                                    reconnect_runtime.auto_reconnect_active.store(false, Ordering::Release);
                                    return;
                                }
                                // 用户已 switch 到其他 agent → 放弃（不把 active_agent 顶回）
                                let still_active = reconnect_handles.active_agent.lock()
                                    .map(|v| v.as_str() == reconnect_agent_id)
                                    .unwrap_or(false);
                                if !still_active {
                                    reconnect_runtime.auto_reconnect_active.store(false, Ordering::Release);
                                    return;
                                }
                                let agent = reconnect_handles.agents.lock().ok().and_then(|a| a.get(&reconnect_agent_id).cloned());
                                let Some(agent) = agent else {
                                    reconnect_runtime.auto_reconnect_active.store(false, Ordering::Release);
                                    return;
                                };
                                let _lifecycle_guard = reconnect_runtime.agent_lifecycle.lock().await;
                                match do_connect_and_replace(
                                    &reconnect_handles,
                                    &reconnect_runtime,
                                    &window_for_reconnect,
                                    &agent,
                                    None,
                                    AgentLifecycleStatus::Reconnecting,
                                    "auto-reconnect",
                                    true,
                                    true,
                                ).await {
                                    Ok(()) => break,
                                    Err(error) => log::warn!("auto-reconnect attempt {attempt} failed: {error}"),
                                }
                            }
                            reconnect_runtime.auto_reconnect_active.store(false, Ordering::Release);
                        });
                    }
                    continue;
                }
                // B9 权限审批：agent 主动 request_permission（带 id 请求，客户端必须应答）。
                // 模式判定：bypass/auto 自动批准；edit/default 挂起 + 前端事件。
                if raw.method.as_deref() == Some(acp::METHOD_SESSION_REQUEST_PERMISSION) {
                    let Some(request_id) = raw.id else { continue; };
                    let Some(permission) = parse_permission_request(raw.params.as_ref()) else {
                        log::warn!("ACP request_permission 解析失败 (id={request_id})，按拒绝处理");
                        let acp = acp.lock().await;
                        let _ = acp.send_response(request_id, permission_response("reject_once")).await;
                        continue;
                    };
                    let mode = approval_mode.lock().map(|m| m.clone()).unwrap_or_else(|_| "default".to_string());
                    if matches!(mode.as_str(), "bypass" | "auto") {
                        log::info!("权限模式 {mode}：自动批准工具调用 {}", permission.tool_call_id);
                        let acp = acp.lock().await;
                        let _ = acp.send_response(request_id, permission_response("allow_once")).await;
                    } else {
                        let _ = pending_permissions.lock().map(|mut pending| {
                            pending.insert(request_id, permission.clone());
                        });
                        emit_event(&window, "pylon:permission-request", serde_json::json!({
                            "requestId": request_id,
                            "sessionId": permission.session_id,
                            "toolCallId": permission.tool_call_id,
                            "title": permission.title,
                            "prompt": permission.prompt,
                            "options": permission.options,
                            "requestedAt": permission.requested_at,
                        }));
                    }
                    continue;
                }
                if raw.method.as_deref() != Some(acp::NOTIF_SESSION_UPDATE) { continue; }
                let mut payload = match raw.params {
                    Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
                    _ => { log::warn!("ACP session/update missing object params"); continue; }
                };
                let peri_id = match payload.get("sessionId").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => { log::warn!("ACP session/update missing sessionId"); continue; }
                };
                let (source, session_generation) = {
                    let mut mapped = None;
                    let mut ambiguous = false;
                    for _ in 0..20 {
                        if let Ok(items) = sessions.lock() {
                            let mappings = items.iter().map(|(source, info)| (source, &info.peri_id, info.generation));
                            mapped = source_for_peri_id_in_generation(mappings, &peri_id, generation);
                            ambiguous = items.values()
                                .filter(|info| info.peri_id == peri_id && info.generation == generation)
                                .count() > 1;
                        }
                        if mapped.is_some() || ambiguous { break; }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                    if ambiguous {
                        log::warn!("ACP notification rejected: periId {} maps to multiple local sources", peri_id);
                        continue;
                    }
                    let Some(mapped) = mapped else {
                        log::warn!("ACP notification for unknown session {}", peri_id);
                        continue;
                    };
                    mapped
                };
                // mapped/event 来自同一 session 映射（source/peri_id 相同），
                // 等价检查退化为 generation 一致性：session 与 dispatcher 必须同代。
                if session_generation != generation
                    || client_generation.load(Ordering::Acquire) != generation
                {
                    log::warn!("ACP notification rejected for stale session {}", peri_id);
                    continue;
                }
                let Some(update) = payload.get("update") else {
                    log::warn!("ACP session/update missing update payload");
                    continue;
                };
                let variant = update.get("sessionUpdate").and_then(|v| v.as_str());
                let is_replay = update.get("_meta")
                    .and_then(|meta| meta.get("periReplay"))
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
                let mapping_is_current = || {
                    client_generation.load(Ordering::Acquire) == generation
                        && sessions.lock().ok().and_then(|items| items.get(&source).map(|session| {
                            session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation)
                        })) == Some(true)
                };
                if !mapping_is_current() {
                    log::warn!("ACP notification rejected for stale session {}", peri_id);
                    continue;
                }
                if variant == Some("agent_message_chunk") {
                    let _ = pet.lock().map(|mut p| pet::on_first_chunk(&mut p));
                    // B11.2：流式收集当前回合回复文本（完成持久化 POST /persist 用）；
                    // 上限 64KB 截断防超长回复撑爆内存。
                    if let Ok(mut items) = sessions.lock() {
                        if let Some(session) = items.get_mut(&source) {
                            if let Some(text) = update.get("content").and_then(|c| c.get("text")).and_then(|v| v.as_str()) {
                                session.last_response_text.push_str(text);
                                if session.last_response_text.len() > 64 * 1024 {
                                    session.last_response_text.truncate(64 * 1024);
                                }
                            }
                        }
                    }
                }
                if variant == Some("user_message_chunk") {
                    if is_replay {
                        if let Some(text) = update.get("content").and_then(|c| c.get("text")).and_then(|v| v.as_str()) {
                            emit_event(&window, "peri:user", serde_json::json!({
                                "source": source,
                                "content": text,
                                "replay": is_replay,
                            }));
                        }
                    }
                    continue;
                }
                let mut mapping_current_at_mutation = false;
                if let Ok(mut items) = sessions.lock() {
                    if client_generation.load(Ordering::Acquire) == generation {
                        if let Some(session) = items.get(&source) {
                            mapping_current_at_mutation = session_mapping_matches(
                                &session.peri_id,
                                session.generation,
                                &peri_id,
                                generation,
                            );
                        }
                    }
                    if mapping_current_at_mutation {
                        if let Some(session) = items.get_mut(&source) {
                            match variant {
                            Some("usage_update") => {
                                session.tokens_total = update.get("used")
                                    .or_else(|| update.get("value"))
                                    .and_then(|v| v.as_u64())
                                    .unwrap_or(0);
                                if let Some(meta) = update.get("_meta") {
                                    session.tokens_in = meta.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                    session.tokens_out = meta.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                    if let Some(model) = meta.get("model").and_then(|v| v.as_str()) { session.model = model.to_string(); }
                                }
                                session.context_size = update.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                                let _ = pet.lock().map(|mut p| pet::on_usage_update(&mut p, session.tokens_total));
                            }
            Some("tool_call") => {
                                let _ = pet.lock().map(|mut p| pet::on_tool_started(&mut p));
                            }
                            Some("tool_call_update") => {
                                match update.get("status").and_then(|v| v.as_str()) {
                                    Some("completed") => { let _ = pet.lock().map(|mut p| pet::on_tool_success(&mut p)); }
                                    Some("failed") => { let _ = pet.lock().map(|mut p| pet::on_tool_failure(&mut p)); }
                                    _ => {}
                                }
                            }
                            Some("session_info_update") => {
                                if let Some(title) = update.get("title").and_then(|v| v.as_str()) { session.title = title.to_string(); }
                            }
                            Some("config_option_update") => {
                                if let Some(options) = update.get("configOptions").and_then(|v| v.as_array()) {
                                    session.config_options = options.clone();
                                    session.apply_config_options(options);
                                } else {
                                    let option_key = update.get("id").or_else(|| update.get("key"))
                                        .and_then(|v| v.as_str());
                                    let current = update.get("currentValue").or_else(|| update.get("value"))
                                        .and_then(value_as_string);
                                    match (option_key, current) {
                                        (Some("model"), Some(model)) => session.model = model,
                                        (Some("mode"), Some(mode)) => session.mode = Some(mode),
                                        _ => {}
                                    }
                                }
                            }
                            _ => {}
                            }
                        }
                    }
                }
                if client_generation.load(Ordering::Acquire) != generation {
                    break;
                }
                if let serde_json::Value::Object(ref mut map) = payload {
                    map.insert("source".to_string(), serde_json::Value::String(source.clone()));
                }
                emit_event_all(&window, &gateway, &source, "peri:update", payload);
            }
        }));
    }
}

pub(crate) struct SessionInfo {
    peri_id: String,
    persona: String,
    cwd: String,
    has_first_prompt: bool,
    title: String,
    generation: u64,
    mode: Option<String>,
    config_options: Vec<serde_json::Value>,
    model: String,
    tokens_in: u64,
    tokens_out: u64,
    tokens_total: u64,
    context_size: u64,
    /// 最后活动时间（Unix 毫秒，B10.3b 会话超时/重置判定）。
    updated_at: Option<String>,
    /// B11：回合计数（每次用户消息 +1；注入与完成持久化共用同一 round）。
    inject_round: u64,
    /// B11.2：当前回合 agent 回复文本（dispatcher 流式收集，完成持久化用）。
    last_response_text: String,
}

impl SessionInfo {
    fn new(peri_id: String, persona: String, cwd: String, has_first_prompt: bool, generation: u64) -> Self {
        Self {
            peri_id,
            persona,
            cwd,
            has_first_prompt,
            title: String::new(),
            generation,
            mode: None,
            config_options: Vec::new(),
            model: String::new(),
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            context_size: 0,
            updated_at: Some(runtime_log::timestamp()),
            inject_round: 0,
            last_response_text: String::new(),
        }
    }

    fn apply_session_response(&mut self, response: &serde_json::Value) {
        if let Some(options) = response.get("configOptions").and_then(|value| value.as_array()) {
            self.config_options = options.clone();
            self.apply_config_options(options);
        }
        self.mode = response.get("modes")
            .and_then(|modes| modes.get("currentModeId").or_else(|| modes.get("currentMode")).or_else(|| modes.get("current")))
            .and_then(value_as_string)
            .or_else(|| find_config_option(&self.config_options, "mode").and_then(config_option_current_value));
    }

    fn apply_config_options(&mut self, options: &[serde_json::Value]) {
        if let Some(model) = find_config_option(options, "model").and_then(config_option_current_value) {
            self.model = model;
        }
        if let Some(mode) = find_config_option(options, "mode").and_then(config_option_current_value) {
            self.mode = Some(mode);
        }
    }
}

fn value_as_string(value: &serde_json::Value) -> Option<String> {
    value.as_str().map(ToOwned::to_owned)
        .or_else(|| value.get("value").and_then(|nested| nested.as_str()).map(ToOwned::to_owned))
        .or_else(|| value.get("valueId").and_then(|nested| nested.get("value")).and_then(|nested| nested.as_str()).map(ToOwned::to_owned))
}

fn find_config_option<'a>(options: &'a [serde_json::Value], key: &str) -> Option<&'a serde_json::Value> {
    options.iter().find(|option| {
        option.get("id").or_else(|| option.get("key")).or_else(|| option.get("name"))
            .and_then(|value| value.as_str()) == Some(key)
    })
}

fn config_option_current_value(option: &serde_json::Value) -> Option<String> {
    option.get("currentValue").and_then(value_as_string)
        .or_else(|| option.get("value").and_then(value_as_string))
        .or_else(|| option.get("current").and_then(value_as_string))
        .or_else(|| option.get("selected").and_then(value_as_string))
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
        assert_eq!(std::fs::read_to_string(&output).expect("read export"), "first");
        assert!(write_export_atomically(&output, b"second").is_err());
        assert_eq!(std::fs::read_to_string(&output).expect("read export"), "first");
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
        let mut session = SessionInfo::new("peri-1".into(), "persona".into(), "G:/work".into(), false, 0);
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
        assert_eq!(config_option_current_value(&option).as_deref(), Some("deepseek-reasoner"));
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
        sessions.insert("source-a".into(), SessionInfo::new("peri-1".into(), "persona".into(), ".".into(), true, 1));
        sessions.insert("source-b".into(), SessionInfo::new("peri-2".into(), "persona".into(), ".".into(), true, 1));
        apply_client_replacement_sessions(&mut sessions, true, 9);
        assert_eq!(sessions.len(), 2);
        for session in sessions.values() {
            assert_eq!(session.generation, 9);
        }
    }

    #[test]
    fn keep_sessions_false_clears_sessions() {
        let mut sessions = HashMap::new();
        sessions.insert("source-a".into(), SessionInfo::new("peri-1".into(), "persona".into(), ".".into(), true, 1));
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
        sessions.insert("source-a".into(), s1);
        sessions.insert("source-b".into(), s2);
        let runtime = AgentRuntimeState {
            status: AgentLifecycleStatus::Connected,
            last_error: None,
            last_connected_at: Some("ts".into()),
        };
        let payload = build_inspector_payload(&sessions, &runtime, "agent-x");
        assert_eq!(payload["agent"]["id"], "agent-x");
        assert_eq!(payload["agent"]["status"], "connected");
        assert_eq!(payload["summary"]["sessionCount"], 2);
        assert_eq!(payload["summary"]["activeCount"], 1); // 仅 s1 有 first prompt
        assert_eq!(payload["summary"]["tokensTotal"], 180);
        assert_eq!(payload["summary"]["tokensIn"], 120);
        assert_eq!(payload["summary"]["tokensOut"], 60);
        let rows = payload["sessions"].as_array().expect("sessions must be array");
        assert_eq!(rows.len(), 2);
        let rows_by_source: HashMap<&str, &serde_json::Value> =
            rows.iter().map(|r| (r["source"].as_str().unwrap(), r)).collect();
        assert_eq!(rows_by_source["source-a"]["tokensTotal"], 150);
        assert_eq!(rows_by_source["source-b"]["cwd"], "/work");
        assert_eq!(rows_by_source["source-a"]["model"], "model-a");
    }

    #[test]
    fn session_expiry_idle_threshold_and_off_mode() {
        let now = "1722500000000";
        // idle：超过阈值过期
        assert_eq!(
            session_expired(Some("1722490000000"), now, "idle", 30).as_deref(),
            Some("超过 30 分钟无活动")
        );
        // 31 分钟前（1860000ms）应过期
        assert!(session_expired(Some("1722498140000"), now, "idle", 30).is_some(), "31 分钟前应过期");
        // 1 分钟内未过期
        assert!(session_expired(Some("1722499900000"), now, "idle", 30).is_none(), "1 分钟内未过期");
        // off：永不过期
        assert_eq!(session_expired(Some("1"), now, "off", 1), None);
        // updated_at 缺失：保守不过期
        assert_eq!(session_expired(None, now, "idle", 1), None);
    }

    #[test]
    fn session_expiry_daily_mode_compares_calendar_day() {
        let now = "1722500000000"; // 某日
        assert!(session_expired(Some("1722400000000"), now, "daily", 0).is_some(), "跨天应过期");
        assert!(session_expired(Some("1722500000000"), now, "daily", 0).is_none(), "同天未过期");
        // 同一天但 23 小时前：daily 不过期（idle 才看时长）
        let same_day_later = "1722490000000";
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
        assert!(!permission.prompt.contains("SECRET"), "prompt 不得含 secret 载荷: {}", permission.prompt);
        assert!(permission.prompt.contains("[REDACTED]"));
    }

    #[test]
    fn parse_permission_request_rejects_malformed_shapes() {
        // 缺 toolCall
        assert!(parse_permission_request(Some(&serde_json::json!({
            "sessionId": "s1", "options": [{"optionId": "allow_once"}]
        }))).is_none());
        // 缺 toolCallId
        assert!(parse_permission_request(Some(&serde_json::json!({
            "sessionId": "s1", "toolCall": {"title": "t"}, "options": [{"optionId": "allow_once"}]
        }))).is_none());
        // 空选项
        assert!(parse_permission_request(Some(&serde_json::json!({
            "sessionId": "s1", "toolCall": {"toolCallId": "c1"}, "options": []
        }))).is_none());
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
        }))).expect("parse");
        runtime.pending_permissions.lock().unwrap().insert(7, permission);
        // 非法选项拒绝
        assert!(resolve_permission(&runtime, 7, "allow_always").await.is_err());
        // 未找到拒绝
        assert!(resolve_permission(&runtime, 99, "allow_once").await.is_err());
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
        AgentDef {
            name: "fake-acp".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), FAKE_SCRIPT.to_string()],
            cwd: None,
            env,
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
}
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
            sessions.insert("source-a".to_string(), SessionInfo::new("fake-session-1".into(), "persona".into(), ".".into(), true, 0));
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
        }
    }

    #[tokio::test]
    async fn fake_acp_crash_triggers_auto_reconnect() {
        let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::External("https://example.com".parse().unwrap()))
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
                let status = runtime.agent_runtime.lock().map(|r| r.status).unwrap_or(AgentLifecycleStatus::Disconnected);
                if status == AgentLifecycleStatus::Crashed { break; }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("dispatcher must observe crash within 5s");
        assert!(runtime.auto_reconnect_active.load(Ordering::Acquire), "auto-reconnect must be scheduled on crash");

        // 注入重连成功：自动重连（2s 退避）开始前把 agents 表切到 alive 模式
        {
            let mut agents = state.agents.lock().unwrap();
            agents.insert("fake-acp".to_string(), fake_agent("alive"));
        }

        // 等待自动重连完成：Connected + generation 前进
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let status = runtime.agent_runtime.lock().map(|r| r.status).unwrap_or(AgentLifecycleStatus::Disconnected);
                if status == AgentLifecycleStatus::Connected { break; }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("auto-reconnect must restore Connected within 15s");

        // 断言：generation +1、sessions 保留且迁移到新代际、防重入标志释放
        assert_eq!(runtime.client_generation.load(Ordering::Acquire), 1, "auto-reconnect must bump generation");
        {
            let sessions = runtime.sessions.lock().unwrap();
            assert_eq!(sessions.len(), 1, "sessions must survive auto-reconnect");
            assert_eq!(sessions.get("source-a").map(|s| s.generation), Some(1), "kept sessions must migrate generation");
        }
        assert!(!runtime.auto_reconnect_active.load(Ordering::Acquire), "auto-reconnect flag must release after loop");
    }

    /// 核验回归：崩溃触发自动重连调度后，用户手动 reconnect 成功——
    /// 自动重连闭包复查 status!=Crashed 提前放弃时**必须释放防重入标志**，
    /// 否则下一次崩溃将永远不再自动重连。
    #[tokio::test]
    async fn manual_reconnect_releases_auto_reconnect_flag() {
        let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::External("https://example.com".parse().unwrap()))
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
                if runtime.auto_reconnect_active.load(Ordering::Acquire) { break; }
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
                if !runtime.auto_reconnect_active.load(Ordering::Acquire) { break; }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("auto-reconnect flag must release after manual reconnect");
        assert_eq!(runtime.client_generation.load(Ordering::Acquire), 1, "manual reconnect must bump generation");
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
        let trace_path = std::env::temp_dir().join(format!("pylon-permission-{}.jsonl", std::process::id()));
        let mut env = std::collections::HashMap::new();
        env.insert("FAKE_MODE".to_string(), "alive".to_string());
        let agent = AgentDef {
            name: "fake-permission".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), PERMISSION_SCRIPT.to_string(), trace_path.to_string_lossy().into_owned()],
            cwd: None,
            env,
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
        let initial_acp = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let state = build_state(initial_acp, agent).await;
        let handles = AppStateHandles::from_state(&state);
        let runtime = handles.active_runtime().expect("active runtime");
        let app = tauri::test::mock_builder().build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let window = tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::External("https://example.com".parse().unwrap()))
            .build()
            .expect("mock window must build");
        start_notification_dispatcher(&handles, &runtime, window);

        // 等 dispatcher 挂起权限请求
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let pending = runtime.pending_permissions.lock().unwrap();
                if pending.contains_key(&5) { break; }
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
        assert!(!permission.prompt.contains("SECRET"), "事件 prompt 必须脱敏");
        drop(pending);

        // 应答（approve_tool_call 等价路径）
        resolve_permission(&runtime, 5, "allow_once").await.expect("resolve must succeed");
        assert!(!runtime.pending_permissions.lock().unwrap().contains_key(&5), "应答后必须清理挂起");

        // 等 fake ACP 收到响应并写入 trace
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if std::fs::metadata(&trace_path).map(|m| m.len() > 0).unwrap_or(false) { break; }
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
        env.insert("PERSIST_CHUNK".to_string(), if chunk { "1".to_string() } else { "0".to_string() });
        AgentDef {
            name: "fake-acp-trace".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), TRACE_ACP_SCRIPT.to_string(), trace_path.to_string_lossy().into_owned()],
            cwd: None,
            env,
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
}
    }

    const STUB_RESPONSE_BODY: &str = r#"{"context":"注入上下文","activated":["uid-1"],"source":"vein"}"#;

    /// Prism /inject 桩：非阻塞轮询处理 expected_requests 次请求（超时自动退出，
    /// 防"不应有请求"的测试卡死 join），完整请求文本发 channel。
    fn spawn_inject_stub(expected_requests: usize) -> (std::net::SocketAddr, mpsc::Receiver<String>, thread::JoinHandle<()>) {
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
                                    if let Some(headers_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                                        let headers = String::from_utf8_lossy(&bytes[..headers_end]);
                                        let length = headers.lines()
                                            .find_map(|line| line.strip_prefix("Content-Length: "))
                                            .and_then(|value| value.trim().parse::<usize>().ok())
                                            .unwrap_or(0);
                                        if bytes.len() >= headers_end + 4 + length { break; }
                                    }
                                }
                                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                    if std::time::Instant::now() > deadline { return; }
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
                        if std::time::Instant::now() > deadline { return; }
                        thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => return,
                }
            }
        });
        (address, request_rx, server)
    }

    fn gateway_with_inject(yaml: &str) -> Arc<gateway::GatewayCore> {
        Arc::new(gateway::GatewayCore::from_config(route::parse_config(yaml).expect("合法配置")))
    }

    fn inject_prompt_text(trace_path: &std::path::Path) -> String {
        let trace = std::fs::read_to_string(trace_path).expect("read trace");
        let request: serde_json::Value = trace.lines()
            .map(|line| serde_json::from_str(line).expect("trace line"))
            .find(|value: &serde_json::Value| {
                value.get("method").and_then(|m| m.as_str()) == Some("session/prompt")
            })
            .expect("prompt request must be traced");
        request["params"]["prompt"][0]["text"].as_str().expect("prompt text").to_string()
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
            Self { app, window, _webview: webview }
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
        }
    }

    #[tokio::test]
    async fn inject_prepends_context_and_advances_round_per_message() {
        let (address, request_rx, server) = spawn_inject_stub(2);
        let trace_path = std::env::temp_dir().join(format!("pylon-b11-trace-{}.jsonl", std::process::id()));
        let agent = trace_acp_agent(&trace_path, false);
        let initial_acp = AcpClient::connect_with_logs(&agent, None).await.expect("fake ACP must initialize");
        let gateway = gateway_with_inject(r#"
gateway:
  inject:
    scenario: trpg
    sources: [vein]
"#);
        let prism = prism::PrismClient::for_testing(format!("http://{}", address), Some("test-token".to_string()));
        let state = build_state_with(initial_acp, agent, gateway, prism).await;
        let env = MockEnv::new(state);

        send_message(env.state(), env.window.clone(), "source-b11".to_string(), "你好".to_string(), String::new(), None, None, None)
            .await
            .expect("first message must send");
        assert_eq!(inject_prompt_text(&trace_path), "注入上下文\n\n你好");
        let first_request = request_rx.recv_timeout(Duration::from_secs(2)).expect("first inject request");
        let first_body: serde_json::Value = first_request.split("\r\n\r\n").nth(1).expect("body").parse().expect("body JSON");
        assert_eq!(first_body["scenario"], "trpg");
        assert_eq!(first_body["sources"], serde_json::json!(["vein"]));
        assert_eq!(first_body["user_msg"], "你好");
        assert_eq!(first_body["round"], 0);

        send_message(env.state(), env.window.clone(), "source-b11".to_string(), "继续".to_string(), String::new(), None, None, None)
            .await
            .expect("second message must send");
        let second_request = request_rx.recv_timeout(Duration::from_secs(2)).expect("second inject request");
        let second_body: serde_json::Value = second_request.split("\r\n\r\n").nth(1).expect("body").parse().expect("body JSON");
        assert_eq!(second_body["round"], 1);
        assert_eq!(second_body["user_msg"], "继续");

        server.join().expect("stub thread");
        std::fs::remove_file(&trace_path).ok();
    }

    #[tokio::test]
    async fn inject_disabled_passes_plain_text_through() {
        let (address, request_rx, server) = spawn_inject_stub(1);
        let trace_path = std::env::temp_dir().join(format!("pylon-b11-disabled-{}.jsonl", std::process::id()));
        let agent = trace_acp_agent(&trace_path, false);
        let initial_acp = AcpClient::connect_with_logs(&agent, None).await.expect("fake ACP must initialize");
        let gateway = gateway_with_inject(r#"
gateway:
  inject:
    enabled: false
"#);
        let prism = prism::PrismClient::for_testing(format!("http://{}", address), Some("t".to_string()));
        let state = build_state_with(initial_acp, agent, gateway, prism).await;
        let env = MockEnv::new(state);

        send_message(env.state(), env.window.clone(), "source-b11-off".to_string(), "你好".to_string(), String::new(), None, None, None)
            .await
            .expect("message must send");
        assert_eq!(inject_prompt_text(&trace_path), "你好");
        assert!(request_rx.try_recv().is_err(), "禁用注入时不得调用 /inject");
        server.join().expect("stub thread");
        std::fs::remove_file(&trace_path).ok();
    }

    #[tokio::test]
    async fn inject_unavailable_degrades_without_injection() {
        let trace_path = std::env::temp_dir().join(format!("pylon-b11-unavailable-{}.jsonl", std::process::id()));
        let agent = trace_acp_agent(&trace_path, false);
        let initial_acp = AcpClient::connect_with_logs(&agent, None).await.expect("fake ACP must initialize");
        let gateway = gateway_with_inject(r#"
gateway:
  inject:
    enabled: true
"#);
        let state = build_state_with(initial_acp, agent, gateway, prism::PrismClient::unavailable("test".to_string())).await;
        let env = MockEnv::new(state);

        send_message(env.state(), env.window.clone(), "source-b11-ua".to_string(), "你好".to_string(), String::new(), None, None, None)
            .await
            .expect("message must send without injection");
        assert_eq!(inject_prompt_text(&trace_path), "你好");
        std::fs::remove_file(&trace_path).ok();
    }

    #[tokio::test]
    async fn command_message_skips_injection() {
        let (address, request_rx, server) = spawn_inject_stub(1);
        let trace_path = std::env::temp_dir().join(format!("pylon-b11-cmd-{}.jsonl", std::process::id()));
        let agent = trace_acp_agent(&trace_path, false);
        let initial_acp = AcpClient::connect_with_logs(&agent, None).await.expect("fake ACP must initialize");
        let gateway = gateway_with_inject(r#"
gateway:
  inject:
    enabled: true
"#);
        let prism = prism::PrismClient::for_testing(format!("http://{}", address), Some("t".to_string()));
        let state = build_state_with(initial_acp, agent, gateway, prism).await;
        let env = MockEnv::new(state);

        send_message(env.state(), env.window.clone(), "source-b11-cmd".to_string(), "/status".to_string(), String::new(), None, None, None)
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
        let trace_path = std::env::temp_dir().join(format!("pylon-b11-persist-{}.jsonl", std::process::id()));
        let agent = trace_acp_agent(&trace_path, true);
        let initial_acp = AcpClient::connect_with_logs(&agent, None).await.expect("fake ACP must initialize");
        let gateway = gateway_with_inject(r#"
gateway:
  inject:
    enabled: true
    scenario: trpg
    persist: prism
"#);
        let prism = prism::PrismClient::for_testing(format!("http://{}", address), Some("test-token".to_string()));
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

        send_message(app.state::<AppState>(), window, "source-b11-persist".to_string(), "你好".to_string(), String::new(), None, None, None)
            .await
            .expect("message must send");

        // 第一个请求 = /inject（round 0）
        let first = request_rx.recv_timeout(Duration::from_secs(2)).expect("inject request");
        assert!(first.starts_with("POST /inject HTTP/1.1"));
        // 第二个请求 = /persist（round 0 + 流式回复文本）
        let second = request_rx.recv_timeout(Duration::from_secs(2)).expect("persist request");
        assert!(second.starts_with("POST /persist HTTP/1.1"));
        let body: serde_json::Value = second.split("\r\n\r\n").nth(1).expect("body").parse().expect("body JSON");
        assert_eq!(body["scenario"], "trpg");
        assert_eq!(body["user_msg"], "你好");
        assert_eq!(body["response"], "回复文本");
        assert_eq!(body["round"], 0);

        server.join().expect("stub thread");
        std::fs::remove_file(&trace_path).ok();
    }

    #[test]
    fn inject_prompt_composition_is_plain_and_conditional() {
        assert_eq!(compose_inject_prompt("世界书上下文", "用户消息"), "世界书上下文\n\n用户消息");
        assert_eq!(compose_inject_prompt("", "用户消息"), "用户消息");
        assert_eq!(compose_inject_prompt("   ", "用户消息"), "用户消息");
        assert_eq!(compose_inject_prompt("上下文", ""), "上下文\n\n");
        assert!(inject_applies_to("普通消息"));
        assert!(inject_applies_to("  hello"));
        assert!(!inject_applies_to("/command"));
        assert!(!inject_applies_to("  /command"));
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
                env: [("API_TOKEN".to_string(), "secret-value".to_string())].into_iter().collect(),
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
                headers: [("Authorization".to_string(), "Bearer x".to_string())].into_iter().collect(),
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
        assert_eq!(loaded[0].env.get("API_TOKEN").map(String::as_str), Some("secret-value"), "secret 必须保留（本地配置文件）");
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
        };
        app.manage(state);
        let path = match mcp_persist_path(&app.handle()) {
            Ok(path) => path,
            Err(_) => return, // mock 环境无 config dir 时跳过（不验证持久化）
        };
        let _ = std::fs::remove_file(&path);

        set_mcp_servers(app.handle().clone(), app.state::<AppState>(), Some(sample_servers())).await.expect("set_mcp_servers must succeed");
        let loaded = load_mcp_persisted(&path).expect("命令后文件必须存在且可加载");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].env.get("API_TOKEN").map(String::as_str), Some("secret-value"));

        // 清空配置 → 落盘空数组（非删除）
        set_mcp_servers(app.handle().clone(), app.state::<AppState>(), Some(Vec::new())).await.expect("clear must succeed");
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
        AgentDef {
            name: "fake-acp-echo".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), ECHO_ACP_SCRIPT.to_string()],
            cwd: None,
            env: std::collections::HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
}
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
        }
    }

    #[tokio::test]
    async fn expiry_watcher_skips_local_sessions_and_resets_platform_sessions() {
        let agent = echo_agent();
        let initial_acp = AcpClient::connect_with_logs(&agent, None).await.expect("fake ACP must initialize");
        let gateway = Arc::new(gateway::GatewayCore::from_config(
            gateway::route::parse_config(r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#).expect("合法配置"),
        ));
        let state = build_state_with(initial_acp, agent, gateway, prism::PrismClient::unavailable("test".to_string())).await;

        let runtime = state.active_runtime().expect("active runtime");
        {
            let mut sessions = runtime.sessions.lock().unwrap();
            // 清理 build_state_with 预置的 source-a，插入过期/平台两类会话
            sessions.clear();
            let mut local = SessionInfo::new("local-peri".into(), String::new(), ".".into(), true, 0);
            local.updated_at = Some("1".into()); // 1970 年，必然过期
            sessions.insert("local".to_string(), local);
            let mut platform = SessionInfo::new("platform-peri".into(), String::new(), ".".into(), true, 0);
            platform.updated_at = Some("1".into());
            sessions.insert("qq:group:123".to_string(), platform);
        }

        check_session_expiry(&state).await;

        let sessions = runtime.sessions.lock().unwrap();
        assert!(sessions.contains_key("local"), "GUI local 会话必须豁免过期重置");
        assert!(!sessions.contains_key("qq:group:123"), "平台会话过期必须 close + 移除");
    }
}

// ── AppState helpers ──

impl AppState {
    /// 当前 active agent 的 runtime；无 active agent 时返回 None。
    fn active_runtime(&self) -> Option<Arc<AgentRuntime>> {
        AppStateHandles::from_state(self).active_runtime()
    }

    /// 当前 active agent 的 runtime；缺失时返回错误（命令层统一错误路径）。
    fn require_runtime(&self) -> Result<Arc<AgentRuntime>, String> {
        self.active_runtime().ok_or_else(|| "no active agent configured".to_string())
    }

    /// 锁外 RPC：短锁仅覆盖同步准备（prepare_rpc），发送与等待在锁外执行——
    /// Peri 卡顿时不阻塞其他命令（V14「锁外写 prompt」模式推广到全部 RPC）。
    async fn acp_rpc(&self, runtime: &AgentRuntime, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let rpc = {
            let acp = runtime.acp.lock().await;
            acp.prepare_rpc(method, params)?
        };
        AcpClient::complete_rpc(rpc).await
    }

    /// 差异适配：Hermes 的 set_config_option 不切 model（只认 edit_approval_policy），
    /// 切 model 必须走 unstable 的 session/set_model。核验修复：按 AgentDef 配置
    /// `set_model_api` 判定（不再硬编码 agent id "hermes"）。
    fn uses_set_model_api(&self) -> bool {
        let active_id = self.active_agent.lock().ok().map(|v| v.clone()).unwrap_or_default();
        self.agents.lock().ok()
            .and_then(|agents| agents.get(&active_id).cloned())
            .map(|agent| agent.set_model_api)
            .unwrap_or(false)
    }

    fn current_generation(&self, runtime: &AgentRuntime) -> u64 {
        runtime.client_generation.load(Ordering::Acquire)
    }

    fn ensure_generation(&self, runtime: &AgentRuntime, expected: u64) -> Result<(), String> {
        let current = self.current_generation(runtime);
        if current == expected {
            Ok(())
        } else {
            Err(format!("stale ACP client generation: expected {expected}, current {current}"))
        }
    }

    fn get_active_agent(&self) -> Result<AgentDef, PylonError> {
        let name = self.active_agent.lock().map_err(|e| PylonError::Acp(e.to_string()))?;
        self.agents.lock().map_err(|e| PylonError::Acp(e.to_string()))?.get(&*name).cloned().ok_or(PylonError::NoActiveAgent)
    }

    fn agent_cwd(&self) -> String {
        self.active_agent.lock().ok()
            .and_then(|name| self.agents.lock().ok()?.get(&*name).cloned())
            .and_then(|a| a.cwd.clone())
            .unwrap_or_else(|| ".".to_string())
    }

    fn current_mcp_servers(&self) -> Result<Vec<mcp::McpServerConfig>, String> {
        Ok(self.runtime_mcp.lock().map_err(|error| error.to_string())?.clone().unwrap_or_default())
    }

    fn log_runtime_summary(
        &self,
        level: &str,
        source: &str,
        session: Option<String>,
        message: &str,
        fields: serde_json::Map<String, serde_json::Value>,
    ) {
        self.runtime_logs.push(runtime_log::timestamp(), level, source, session, message, fields);
    }

    fn workspace_root_for_source(&self, runtime: &AgentRuntime, source: &str) -> Result<String, String> {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(source).map(|session| session.cwd.clone())
            .ok_or_else(|| PylonError::SessionNotFound(source.to_string()).to_string())
    }

    fn agent_status_payload(&self) -> serde_json::Value {
        let handles = AppStateHandles::from_state(self);
        handles.agent_status_payload(handles.active_runtime().as_deref())
    }

    fn get_peri_id(&self, runtime: &AgentRuntime, source: &str) -> Result<String, PylonError> {
        let sessions = runtime.sessions.lock().map_err(|e| PylonError::Acp(e.to_string()))?;
        sessions.get(source)
            .map(|s| s.peri_id.clone())
            .ok_or_else(|| PylonError::SessionNotFound(source.to_string()))
    }

    fn export_session_owner(&self, runtime: &AgentRuntime, peri_id: &str) -> Result<(String, u64, String), String> {
        let generation = self.current_generation(runtime);
        let sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
        let matches: Vec<(&String, &SessionInfo)> = sessions
            .iter()
            .filter(|(_, session)| session.peri_id == peri_id && session.generation == generation)
            .collect();
        match matches.as_slice() {
            [(source, session)] => Ok(((*source).clone(), generation, session.cwd.clone())),
            [] => Err("export session not found in the active generation".to_string()),
            _ => Err("export session owner is ambiguous".to_string()),
        }
    }

    fn session_matches(&self, runtime: &AgentRuntime, source: &str, peri_id: &str, generation: u64) -> Result<bool, String> {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        Ok(sessions.get(source).map(|session| {
            session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
        }) == Some(true))
    }

    fn with_session_if_matches<T>(
        &self,
        runtime: &AgentRuntime,
        source: &str,
        peri_id: &str,
        generation: u64,
        update: impl FnOnce(&mut SessionInfo) -> T,
    ) -> Result<T, String> {
        self.ensure_generation(runtime, generation)?;
        let mut sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
        let session = sessions
            .get_mut(source)
            .ok_or_else(|| format!("stale session mapping for source: {source}"))?;
        if !session_mapping_matches(&session.peri_id, session.generation, peri_id, generation) {
            return Err(format!("stale session mapping for source: {source}"));
        }
        Ok(update(session))
    }

    fn mark_first_prompt_if_matches(&self, runtime: &AgentRuntime, source: &str, peri_id: &str, generation: u64) -> Result<(), String> {
        self.with_session_if_matches(runtime, source, peri_id, generation, |session| {
            session.has_first_prompt = true;
        })
    }

    fn remove_session_if_matches(&self, runtime: &AgentRuntime, source: &str, peri_id: &str, generation: u64) -> Result<bool, String> {
        let mut sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
        if sessions.get(source).map(|session| {
            session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
        }) == Some(true) {
            Ok(sessions.remove(source).is_some())
        } else {
            Ok(false)
        }
    }

    fn start_runtime_log_dispatcher(&self, window: tauri::WebviewWindow) {
        let mut events = self.runtime_logs.subscribe();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(entry) => match serde_json::to_value(entry) {
                        Ok(payload) => emit_event(&window, "pylon:runtime-log", payload),
                        Err(error) => log::warn!("serialize runtime log event failed: {error}"),
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                        log::warn!("runtime log event dispatcher lagged by {count} entries");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    async fn connect_and_replace(
        &self,
        runtime: &Arc<AgentRuntime>,
        window: &tauri::WebviewWindow,
        agent: &AgentDef,
        agent_id: Option<String>,
        start_status: AgentLifecycleStatus,
        log_action: &str,
    ) -> Result<(), String> {
        // 手动 switch/reconnect：跨 agent/全新进程语义，keep_sessions=false（清空映射）。
        // 实现委托给静态辅助，自动重连（keep_sessions=true）与手动路径共用同一份逻辑。
        let handles = AppStateHandles::from_state(self);
        do_connect_and_replace(&handles, runtime, window, agent, agent_id, start_status, log_action, false, true).await
    }

    /// 平台 ingest 目标 runtime 就绪检查（B10.3）：未连接时懒启动连接。
    /// announce=false——平台消息路由不切换/不广播 GUI active agent 状态。
    async fn ensure_runtime_ready(
        &self,
        runtime: &Arc<AgentRuntime>,
        agent_id: &str,
        window: &tauri::WebviewWindow,
    ) -> Result<(), String> {        let status = runtime.agent_runtime.lock()
            .map(|s| s.status)
            .unwrap_or(AgentLifecycleStatus::Disconnected);
        if matches!(
            status,
            AgentLifecycleStatus::Connected | AgentLifecycleStatus::Connecting | AgentLifecycleStatus::Reconnecting
        ) {
            return Ok(());
        }
        let agent = self.agents.lock().map_err(|e| e.to_string())?
            .get(agent_id)
            .cloned()
            .ok_or_else(|| format!("unknown agent: {agent_id}"))?;
        let keep = matches!(status, AgentLifecycleStatus::Crashed);
        let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
        // 双检查：拿到生命周期锁后重查（防并发连接）
        let status = runtime.agent_runtime.lock()
            .map(|s| s.status)
            .unwrap_or(AgentLifecycleStatus::Disconnected);
        if matches!(
            status,
            AgentLifecycleStatus::Connected | AgentLifecycleStatus::Connecting | AgentLifecycleStatus::Reconnecting
        ) {
            return Ok(());
        }
        let handles = AppStateHandles::from_state(self);
        do_connect_and_replace(
            &handles,
            runtime,
            window,
            &agent,
            None,
            AgentLifecycleStatus::Connecting,
            "platform-ingest",
            keep,
            false,
        )
        .await
    }
}

/// 挂起的权限请求超时检查（B9.2：超时默认拒绝，不悬挂 pending）。
async fn check_pending_permission_timeouts(state: &AppState) {
    let now_ms: u64 = runtime_log::timestamp().parse().unwrap_or(0);
    for runtime in state.runtimes.all() {
        let expired: Vec<(u64, String)> = runtime.pending_permissions.lock()
            .map(|pending| {
                pending.iter()
                    .filter(|(_, permission)| {
                        permission
                            .requested_at
                            .parse::<u64>()
                            .map(|at| now_ms.saturating_sub(at) > PERMISSION_REQUEST_TIMEOUT_SECS * 1000)
                            .unwrap_or(false)
                    })
                    .map(|(id, permission)| (*id, permission.tool_call_id.clone()))
                    .collect()
            })
            .unwrap_or_default();
        for (request_id, tool_call_id) in expired {
            let acp = runtime.acp.lock().await;
            let _ = acp.send_response(request_id, permission_response("reject_once")).await;
            drop(acp);
            let _ = runtime.pending_permissions.lock().map(|mut pending| pending.remove(&request_id));
            log::warn!("权限请求 {request_id} 超时默认拒绝（{tool_call_id}）");
        }
    }
}

/// 会话过期检查（B10.3b，expiry watcher 每轮调用）：
/// 遍历所有 runtime 的会话，按绑定 reset 策略判定过期；过期会话
/// close ACP + 移除映射 + 平台通知 + 日志。生成中会话（prompt 锁被占用）豁免。
async fn check_session_expiry(state: &AppState) {
    let now = runtime_log::timestamp();
    // 核验修复：平台 source 判定（适配器前缀或静态绑定命中）。GUI local 会话
    // 由前端/用户管理，不参与后台过期重置（watcher 是 B10.3b 为平台会话设计）。
    let platform_keys: Vec<String> = state.gateway.adapter_keys();
    let is_platform_source = |source: &str| -> bool {
        platform_keys.iter().any(|key| source.starts_with(&format!("{key}:")))
            || state.gateway.binding(source).is_some()
    };
    for runtime in state.runtimes.all() {
        let sessions: Vec<(String, String, Option<String>)> = runtime.sessions.lock()
            .map(|sessions| {
                sessions.iter()
                    .map(|(source, info)| (source.clone(), info.peri_id.clone(), info.updated_at.clone()))
                    .collect()
            })
            .unwrap_or_default();
        for (source, peri_id, updated_at) in sessions {
            if !is_platform_source(&source) {
                continue;
            }
            // 活跃豁免：生成中（prompt 锁被占用）永不视为过期
            let generating = runtime.prompt_locks.lock()
                .ok()
                .and_then(|locks| locks.get(&source).cloned())
                .map(|lock| lock.try_lock().is_err())
                .unwrap_or(false);
            if generating {
                continue;
            }
            let binding = state.gateway.binding(&source);
            let reset = binding.as_ref().and_then(|b| b.reset.as_deref()).unwrap_or("idle");
            let idle_minutes = binding.as_ref().and_then(|b| b.idle_minutes).unwrap_or(1440);
            let Some(reason) = session_expired(updated_at.as_deref(), &now, reset, idle_minutes) else {
                continue;
            };
            log::info!("会话过期 ({source}): {reason}");
            // close ACP session（失败不阻断本地清理）
            if let Ok(close_params) = acp::session_close_params(&peri_id) {
                if let Err(error) = state.acp_rpc(&runtime, acp::METHOD_SESSION_CLOSE, close_params).await {
                    log::warn!("close expired session {peri_id}: {error}");
                }
            }
            let _ = runtime.sessions.lock().map(|mut sessions| sessions.remove(&source));
            // 平台通知（用户可见重置原因）
            if let Some(adapter) = state.gateway.adapter("qq") {
                let _ = adapter.deliver_text(&source, &format!("[会话已重置] {reason}"));
            }
            state.log_runtime_summary(
                "warn",
                "session",
                Some(source),
                &format!("Session expired ({reason})"),
                serde_json::Map::new(),
            );
        }
    }
}

const MAX_SESSIONS: usize = 100;

/// 权限请求事件中 prompt 的安全上限（B9.4：事件不含完整 secret 载荷）。
const PERMISSION_PROMPT_MAX_CHARS: usize = 500;
/// 挂起的权限请求超时（B9.2：超时默认拒绝）。
const PERMISSION_REQUEST_TIMEOUT_SECS: u64 = 300;

/// 挂起的权限请求（B9，Peri agent 实证方向：agent 主动 request_permission，客户端应答）。
#[derive(Clone)]
pub(crate) struct PendingPermission {
    pub session_id: String,
    pub tool_call_id: String,
    pub title: String,
    /// raw_input 脱敏摘要（事件安全字段，不含完整载荷）。
    pub prompt: String,
    /// 可用选项 option_id（allow_once/reject_once/...），应答时校验。
    pub options: Vec<String>,
    pub requested_at: String,
}

/// 解析 agent 的 request_permission 请求参数（B9）：
/// `{ sessionId, toolCall: { toolCallId, title?, rawInput? }, options: [{ optionId, ... }] }`。
/// 解析失败（缺字段/无选项）返回 None——调用方按拒绝处理。
fn parse_permission_request(params: Option<&serde_json::Value>) -> Option<PendingPermission> {
    let params = params?;
    let session_id = params.get("sessionId")?.as_str()?.to_string();
    let tool_call = params.get("toolCall")?;
    let tool_call_id = tool_call.get("toolCallId")?.as_str()?.to_string();
    let title = tool_call
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let raw_input = tool_call
        .get("rawInput")
        .map(serde_json::Value::to_string)
        .unwrap_or_default();
    let prompt: String = runtime_log::sanitize_message(raw_input)
        .chars()
        .take(PERMISSION_PROMPT_MAX_CHARS)
        .collect();
    let options: Vec<String> = params
        .get("options")?
        .as_array()?
        .iter()
        .filter_map(|option| option.get("optionId").and_then(|v| v.as_str()))
        .map(str::to_string)
        .collect();
    if options.is_empty() {
        return None;
    }
    Some(PendingPermission {
        session_id,
        tool_call_id,
        title,
        prompt,
        options,
        requested_at: runtime_log::timestamp(),
    })
}

/// 构造 request_permission 应答（官方 schema 类型保证 wire 格式）。
fn permission_response(option_id: &str) -> serde_json::Value {
    use agent_client_protocol_schema::v1::{
        RequestPermissionOutcome, RequestPermissionResponse, SelectedPermissionOutcome,
    };
    serde_json::to_value(RequestPermissionResponse::new(
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id.to_string())),
    ))
    .unwrap_or_else(|_| serde_json::json!({"outcome": {"selected": {"optionId": option_id}}}))
}

/// request_permission 应答：Cancelled（session/cancel 时必须应答所有挂起请求）。
fn permission_response_cancelled() -> serde_json::Value {
    use agent_client_protocol_schema::v1::{RequestPermissionOutcome, RequestPermissionResponse};
    serde_json::to_value(RequestPermissionResponse::new(RequestPermissionOutcome::Cancelled))
        .unwrap_or_else(|_| serde_json::json!({"outcome": "cancelled"}))
}

/// 应答并移除指定 session 的全部挂起权限请求（Cancelled）——cancel/close 路径调用。
async fn respond_pending_permissions_cancelled(runtime: &AgentRuntime, session_id: &str) {
    let pending: Vec<u64> = runtime.pending_permissions.lock()
        .map(|pending| {
            pending.iter()
                .filter(|(_, p)| p.session_id == session_id)
                .map(|(id, _)| *id)
                .collect()
        })
        .unwrap_or_default();
    for request_id in pending {
        let acp = runtime.acp.lock().await;
        let _ = acp.send_response(request_id, permission_response_cancelled()).await;
        drop(acp);
        let _ = runtime.pending_permissions.lock().map(|mut pending| pending.remove(&request_id));
    }
}

/// 会话过期判定（B10.3b，参考 Hermes reset policy）：返回过期原因，None = 未过期。
///
/// - reset="off"：永不过期
/// - reset="daily"：按 UTC 日历天比较（updated_at 与 now 不同天 → 过期）
/// - 其他（默认 idle）：`now - updated_at > idle_minutes` → 过期
/// updated_at 缺失（历史数据）视为未过期（保守，防误杀）。
fn session_expired(
    updated_at_ms: Option<&str>,
    now_ms: &str,
    reset: &str,
    idle_minutes: u64,
) -> Option<String> {
    match reset {
        "off" => None,
        "daily" => {
            let day = |ms: &str| ms.parse::<u64>().ok().map(|v| v / 86_400_000);
            match (updated_at_ms.and_then(day), day(now_ms)) {
                (Some(updated), Some(now)) if updated != now => Some("每日重置".to_string()),
                _ => None,
            }
        }
        _ => {
            let idle_ms = idle_minutes.saturating_mul(60_000);
            let now: u64 = now_ms.parse().ok()?;
            let updated: u64 = updated_at_ms?.parse().ok()?;
            if now.saturating_sub(updated) > idle_ms {
                Some(format!("超过 {idle_minutes} 分钟无活动"))
            } else {
                None
            }
        }
    }
}

/// 客户端替换后的 sessions 处理：keep=false 清空（跨 agent/全新进程语义）；
/// keep=true 保留映射但迁移 generation——通知路由按新代际匹配，旧 session 才能继续收事件。
fn apply_client_replacement_sessions(
    sessions: &mut HashMap<String, SessionInfo>,
    keep_sessions: bool,
    new_generation: u64,
) {
    if !keep_sessions {
        sessions.clear();
    } else {
        for session in sessions.values_mut() {
            session.generation = new_generation;
        }
    }
}

/// B11.1 注入适用性：命令消息（`/` 开头，与 persona 拼接规则一致）不注入。
fn inject_applies_to(content: &str) -> bool {
    !content.trim_start().starts_with('/')
}

/// B11.1 prompt 拼装：注入 context 前置 + 双换行分隔；context 空白时原样返回。
fn compose_inject_prompt(context: &str, text: &str) -> String {
    let context = context.trim();
    if context.is_empty() {
        text.to_string()
    } else {
        format!("{context}\n\n{text}")
    }
}

fn write_export_atomically(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Err(format!("export output already exists: {}", path.display()));
    }
    let parent = path.parent().ok_or_else(|| "export output has no parent directory".to_string())?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|name| name.to_str()).unwrap_or("export"),
        std::process::id(),
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| format!("create temporary export failed: {error}"))?;
        use std::io::Write;
        file.write_all(content).map_err(|error| format!("write temporary export failed: {error}"))?;
        file.sync_all().map_err(|error| format!("sync temporary export failed: {error}"))?;
        std::fs::rename(&temp, path).map_err(|error| format!("commit export failed: {error}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[tauri::command]
async fn new_session(
    state: tauri::State<'_, AppState>,
    source: String,
    persona: String,
    cwd: Option<String>,
    mcp_servers: Option<Vec<mcp::McpServerConfig>>,
) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    state.inner().log_runtime_summary( "info", "session", Some(source.clone()), "Session creation started", serde_json::Map::new());
    let _creation_guard = runtime.session_creation.lock().await;
    {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= MAX_SESSIONS { return Err(PylonError::Protocol("max sessions reached".to_string())); }
    }
    let session_cwd = cwd.unwrap_or_else(|| state.agent_cwd());
    let generation = state.current_generation(&runtime);
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
    let response = match state.inner().acp_rpc(&runtime, acp::METHOD_SESSION_NEW, acp::session_new_params(&session_cwd, mcp_servers)?).await {
        Ok(response) => response,
        Err(error) => {
            state.inner().log_runtime_summary( "error", "session", Some(source.clone()), "Session creation failed", serde_json::Map::new());
            return Err(error.into());
        }
    };
    state.ensure_generation(&runtime, generation)?;
    let peri_id = AcpClient::session_id_from(&response)?;
    let mut session = SessionInfo::new(peri_id.clone(), persona, session_cwd, false, generation);
    session.apply_session_response(&response);
    let replaced = runtime.sessions.lock().map_err(|e| e.to_string())?
        .insert(source.clone(), session);
    if let Some(old) = replaced {
        if let Ok(close_params) = acp::session_close_params(&old.peri_id) {
            if let Err(error) = state.inner().acp_rpc(&runtime, acp::METHOD_SESSION_CLOSE, close_params).await {
                log::warn!("close replaced session: {}", error);
            }
        }
    }
    state.inner().log_runtime_summary( "info", "session", Some(source.clone()), "Session creation succeeded", serde_json::Map::new());
    // Return full response so frontend gets modes + configOptions + sessionId
    Ok(response)
}

#[tauri::command]
async fn send_message<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    window: tauri::Window<R>,
    source: String,
    content: String,
    persona: String,
    session_prompt: Option<String>,
    attachments: Option<Vec<String>>,
    mcp_servers: Option<Vec<mcp::McpServerConfig>>,
) -> Result<String, PylonError> {
    let runtime = state.inner().require_runtime()?;
    send_prompt_core(
        state.inner(),
        &runtime,
        Some(&window),
        &state.gateway,
        &source,
        &content,
        &persona,
        session_prompt.as_deref(),
        attachments.as_deref(),
        mcp_servers,
    )
    .await
}

/// 公共发送管线（GUI `send_message` 与 gateway 平台 ingest 共用，B10.3）：
/// per-runtime 会话创建/映射/prompt 锁/等待/cancel/事件广播。
/// 平台 ingest 经 handler 路由到绑定 agent 的 runtime 后调用本函数。
async fn send_prompt_core<R: tauri::Runtime>(
    state: &AppState,
    runtime: &Arc<AgentRuntime>,
    window: Option<&tauri::Window<R>>,
    gateway: &GatewayCore,
    source: &str,
    content: &str,
    persona: &str,
    session_prompt: Option<&str>,
    attachments: Option<&[String]>,
    mcp_servers: Option<Vec<mcp::McpServerConfig>>,
) -> Result<String, PylonError> {
    state.log_runtime_summary( "info", "prompt", Some(source.to_string()), "Prompt started", serde_json::Map::from_iter([
        ("contentLength".to_string(), serde_json::Value::from(content.len())),
        ("attachmentCount".to_string(), serde_json::Value::from(attachments.map_or(0, <[String]>::len))),
    ]));
    let requested_mcp_servers = mcp::validate_and_serialize(mcp_servers.or_else(|| state.current_mcp_servers().ok()))?;
    let prompt_lock = prompt_lock_for(&runtime.prompt_locks, source);
    let _prompt_guard = prompt_lock.lock().await;

    // 消息到达即活动：更新会话最后活动时间（B10.3b 会话超时判定）；
    // 生成中的会话另有 prompt 锁活跃豁免，双保险。
    if let Ok(mut sessions) = runtime.sessions.lock() {
        if let Some(session) = sessions.get_mut(source) {
            session.updated_at = Some(runtime_log::timestamp());
        }
    }

    if runtime.acp.lock().await.is_crashed() {
        if let Some(window) = window {
            emit_event_all(window, gateway, source, "peri:error", serde_json::json!({"source": source, "error": PylonError::AgentCrashed.to_string()}));
        }
        return Err(PylonError::AgentCrashed.into());
    }

    let (peri_id, is_first) = {
        let _creation_guard = runtime.session_creation.lock().await;
        let existing = {
            let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
            sessions.get(source).map(|session| {
                (session.peri_id.clone(), !session.has_first_prompt)
            })
        };
        if let Some(result) = existing {
            result
        } else {
            {
                let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
                if sessions.len() >= MAX_SESSIONS { return Err(PylonError::Protocol("max sessions reached".to_string())); }
            }
            let session_cwd = state.agent_cwd();
            let generation = state.current_generation(runtime);
            let response = match state.acp_rpc(runtime, acp::METHOD_SESSION_NEW, acp::session_new_params(&session_cwd, requested_mcp_servers.clone())?).await {
                Ok(response) => response,
                Err(error) => {
                    state.log_runtime_summary( "error", "session", Some(source.to_string()), "Session creation failed", serde_json::Map::new());
                    return Err(error.into());
                }
            };
            state.ensure_generation(runtime, generation)?;
            let pid = AcpClient::session_id_from(&response)?;
            let mut session = SessionInfo::new(pid.clone(), persona.to_string(), session_cwd, false, generation);
            session.apply_session_response(&response);
            runtime.sessions.lock().map_err(|e| e.to_string())?
                .insert(source.to_string(), session);
            (pid, true)
        }
    };

    let attachment_paths = attachments.unwrap_or_default();
    let prompt_generation = state.current_generation(runtime);

    let effective_persona = session_prompt
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(persona);

    let prompt_content = if is_first && !effective_persona.is_empty() && !content.starts_with('/') {
        format!("{}\n\n---\n\n{}", effective_persona, content)
    } else {
        content.to_string()
    };

    // B11.1：发送前置注入钩子（GUI 与平台 ingest 统一入口）——Prism 可用 +
    // gateway 配置开启 + 非命令消息 → POST /inject 拿 context 前置拼进 prompt。
    // Prism 不可用/请求失败 → 降级为不注入（消息照发，fail-open）。
    let mut inject_activated: Vec<String> = Vec::new();
    let message_round = {
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(source).map(|s| s.inject_round).unwrap_or(0)
    };
    let prompt_text = if gateway.inject_enabled() && inject_applies_to(content) {
        match state.prism.inject(
            gateway.inject_scenario().unwrap_or_default(),
            gateway.inject_sources(),
            content,
            message_round,
        ).await {
            Ok(result) => {
                if result.activated.is_empty() {
                    state.log_runtime_summary("info", "inject", Some(source.to_string()), "Prism inject returned empty context", serde_json::Map::from_iter([
                        ("contextLength".to_string(), serde_json::Value::from(result.context.len())),
                    ]));
                } else {
                    state.log_runtime_summary("info", "inject", Some(source.to_string()), "Prism inject activated", serde_json::Map::from_iter([
                        ("activatedCount".to_string(), serde_json::Value::from(result.activated.len())),
                        ("contextLength".to_string(), serde_json::Value::from(result.context.len())),
                    ]));
                }
                inject_activated = result.activated;
                compose_inject_prompt(&result.context, &prompt_content)
            }
            Err(error) => {
                log::warn!("Prism inject failed: {error}");
                state.log_runtime_summary("warn", "inject", Some(source.to_string()), "Prism inject failed; sent without injection", serde_json::Map::new());
                prompt_content
            }
        }
    } else {
        prompt_content
    };
    let prompt_blocks = AcpClient::prompt_blocks(prompt_text, &attachment_paths)?;

    state.pet.lock().map(|mut p| pet::on_user_sent(&mut p)).ok();
    if let Some(window) = window {
        let mut user_payload = serde_json::json!({ "source": source, "content": content });
        if !inject_activated.is_empty() {
            user_payload["injectActivated"] = serde_json::Value::Array(
                inject_activated.iter().map(|item| serde_json::Value::String(item.clone())).collect()
            );
        }
        emit_event(window, "peri:user", user_payload);
    }
    let (request_id, write_tx, prompt_line, mut rx) = {
        let acp = runtime.acp.lock().await;
        let (id, line, rx) = acp.prepare_prompt(&peri_id, prompt_blocks)?;
        (id, acp.write_tx.clone(), line, rx)
    };
    if write_tx.send(prompt_line).await.is_err() {
        runtime.acp.lock().await.remove_pending(request_id);
        let _ = state.remove_session_if_matches(runtime, source, &peri_id, prompt_generation);
        return Err(PylonError::Protocol("ACP connection closed".to_string()));
    }
    // B11：回合推进——该 session 用户回合 +1（注入/持久化共用同一 round）；
    // 清空上一回合回复文本（本轮回复由 dispatcher 重新收集）。
    if let Ok(mut sessions) = runtime.sessions.lock() {
        if let Some(session) = sessions.get_mut(source) {
            session.inject_round = session.inject_round.saturating_add(1);
            session.last_response_text.clear();
        }
    }
    let acp_for_cancel = runtime.acp.clone();
    let peri_id_for_cancel = peri_id.clone();
    let result = acp::wait_prompt_with_cancel(
        &mut rx,
        Duration::from_secs(acp::PROMPT_TIMEOUT_SECS),
        Duration::from_secs(acp::CANCEL_SETTLE_TIMEOUT_SECS),
        move || async move {
            acp_for_cancel.lock().await.cancel_session(&peri_id_for_cancel).await
        },
    ).await;

    match result {
        PromptWaitOutcome::Response(raw) => {
            state.ensure_generation(runtime, prompt_generation)?;
            if !state.session_matches(runtime, source, &peri_id, prompt_generation)? {
                return Err(PylonError::Protocol(format!("stale session mapping for source: {source}")));
            }
            if let Some(error) = raw.error {
                let error = error.to_string();
                if let Some(window) = window {
                    emit_event_all(window, gateway, source, "peri:error", serde_json::json!({"source": source, "error": error}));
                }
                let _ = state.pet.lock().map(|mut p| pet::on_error(&mut p));
                Err(PylonError::Protocol(error))
            } else {
                let data = raw.result.unwrap_or(serde_json::Value::Null);
                AcpClient::prompt_stop_reason(&data).map_err(|error| {
                    if let Some(window) = window {
                    emit_event_all(window, gateway, source, "peri:error", serde_json::json!({"source": source, "error": error}));
                }
                    let _ = state.pet.lock().map(|mut pet| pet::on_error(&mut pet));
                    error
                })?;
                if let Err(error) = state.ensure_generation(runtime, prompt_generation) {
                    let _ = state.remove_session_if_matches(runtime, source, &peri_id, prompt_generation);
                    if let Some(window) = window {
                    emit_event_all(window, gateway, source, "peri:error", serde_json::json!({"source": source, "error": error}));
                }
                    return Err(error.into());
                }
                if is_first {
                    state.mark_first_prompt_if_matches(runtime, source, &peri_id, prompt_generation)?;
                }
                if let Some(window) = window {
                    emit_event_all(window, gateway, source, "peri:done", serde_json::json!({"source": source, "data": data}));
                }
                let _ = state.pet.lock().map(|mut p| pet::on_done(&mut p));
                // B11.2：完成持久化（gateway.inject.persist = "prism"）——把本回合
                // （用户消息 + 流式收集的回复文本）交 Prism /persist（LLM 摘要 +
                // recent.json + active.round 推进）。失败只告警，不阻断。
                if gateway.inject_persist() == "prism" {
                    let response_text = {
                        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
                        sessions.get(source).map(|s| s.last_response_text.clone()).unwrap_or_default()
                    };
                    if !response_text.trim().is_empty() {
                        match state.prism.persist_round(
                            gateway.inject_scenario().unwrap_or_default(),
                            gateway.inject_sources(),
                            content,
                            &response_text,
                            message_round,
                        ).await {
                            Ok(value) => {
                                let ok = value.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                                if !ok {
                                    log::warn!("Prism persist 返回失败: {value}");
                                }
                                state.log_runtime_summary(
                                    "info",
                                    "persist",
                                    Some(source.to_string()),
                                    if ok { "Prism round persisted" } else { "Prism persist returned failure" },
                                    serde_json::Map::new(),
                                );
                            }
                            Err(error) => {
                                log::warn!("Prism persist failed: {error}");
                                state.log_runtime_summary("warn", "persist", Some(source.to_string()), "Prism persist failed", serde_json::Map::new());
                            }
                        }
                    }
                }
                state.log_runtime_summary( "info", "prompt", Some(source.to_string()), "Prompt completed", serde_json::Map::from_iter([
                    ("result".to_string(), serde_json::Value::String("success".to_string())),
                ]));
                Ok(peri_id)
            }
        }
        PromptWaitOutcome::ConnectionClosed => {
            runtime.acp.lock().await.remove_pending(request_id);
            let _ = state.remove_session_if_matches(runtime, source, &peri_id, prompt_generation);
            state.log_runtime_summary( "error", "prompt", Some(source.to_string()), "Prompt connection closed", serde_json::Map::new());
            Err(PylonError::Protocol("ACP connection closed".to_string()))
        }
        PromptWaitOutcome::CancelledAfterTimeout { response, cancel_error } => {
            runtime.acp.lock().await.remove_pending(request_id);
            if let Some(cancel_error) = cancel_error {
                log::warn!("cancel timed-out prompt {}: {}", peri_id, cancel_error);
            }
            // B9：cancel 后应答该 session 挂起的权限请求为 Cancelled
            respond_pending_permissions_cancelled(runtime, &peri_id).await;
            if response.is_none() {
                match state.remove_session_if_matches(runtime, source, &peri_id, prompt_generation) {
                    Ok(true) => {
                        log::error!(
                            "cancelled prompt {} did not settle within {}s; removed local session mapping",
                            peri_id,
                            acp::CANCEL_SETTLE_TIMEOUT_SECS
                        );
                        if let Ok(close_params) = acp::session_close_params(&peri_id) {
                            if let Err(close_error) = state.acp_rpc(runtime, acp::METHOD_SESSION_CLOSE, close_params).await {
                                log::warn!("close unsettled prompt session {}: {}", peri_id, close_error);
                            }
                        }
                    }
                    Ok(false) => {}
                    Err(error) => return Err(error.into()),
                }
            }
            let error = "timed out after 300s";
            if let Some(window) = window {
                emit_event_all(window, gateway, source, "peri:error", serde_json::json!({"source": source, "error": error}));
            }
            state.log_runtime_summary( "error", "prompt", Some(source.to_string()), "Prompt timed out", serde_json::Map::from_iter([
                ("result".to_string(), serde_json::Value::String("timeout".to_string())),
            ]));
            Err(PylonError::Protocol(error.to_string()))
        }
    }
}

#[tauri::command]
async fn set_mode(state: tauri::State<'_, AppState>, source: String, mode: String) -> Result<(), PylonError> {
    let runtime = state.inner().require_runtime()?;
    let generation = state.current_generation(&runtime);
    let peri_id = state.get_peri_id(&runtime, &source).map_err(|e| e.to_string())?;
    state.inner().acp_rpc(&runtime, acp::METHOD_SESSION_SET_MODE, acp::session_set_mode_params(&peri_id, &mode)?).await?;
    state.ensure_generation(&runtime, generation)?;
    state.with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
        session.mode = Some(mode);
    })?;
    Ok(())
}

#[tauri::command]
async fn set_config_option(state: tauri::State<'_, AppState>, source: String, key: String, value: String) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let generation = state.current_generation(&runtime);
    let peri_id = state.get_peri_id(&runtime, &source).map_err(|e| e.to_string())?;
    // 差异适配：Hermes 切 model 必须走 session/set_model（set_config_option 只认
    // edit_approval_policy，其余存 config_options 不生效）；Peri 走平铺 set_config_option。
    let use_set_model = key == "model" && state.inner().uses_set_model_api();
    let response = if use_set_model {
        state.inner().acp_rpc(&runtime, acp::METHOD_SESSION_SET_MODEL, acp::session_set_model_params(&peri_id, &value)?).await?
    } else {
        state.inner().acp_rpc(&runtime, acp::METHOD_SESSION_SET_CONFIG_OPTION, acp::session_set_config_option_params(&peri_id, &key, &value)?).await?
    };
    state.ensure_generation(&runtime, generation)?;
    state.with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
        if let Some(options) = response.get("configOptions").and_then(|value| value.as_array()) {
            session.config_options = options.clone();
            session.apply_config_options(options);
        } else if key == "model" {
            session.model = value.clone();
        } else if key == "mode" {
            session.mode = Some(value.clone());
        }
    })?;
    Ok(response)
}

#[tauri::command]
async fn close_session(state: tauri::State<'_, AppState>, source: String) -> Result<(), PylonError> {
    let runtime = state.inner().require_runtime()?;
    let _creation_guard = runtime.session_creation.lock().await;
    let generation = state.current_generation(&runtime);
    let peri_id = state.get_peri_id(&runtime, &source).map_err(|e| e.to_string())?;
    // 若该 session 有在途 prompt，先发 cancel（fire-and-forget）让 Peri 侧 settle，
    // 否则 pending oneshot 会挂到 PROMPT_TIMEOUT 才结束——close 后 prompt 卡死 300s。
    {
        let acp = runtime.acp.lock().await;
        let _ = acp.cancel_session(&peri_id).await;
    }
    // Hermes 未实现 session/close（-32601）——降级为本地清理（映射已删，见下）
    if let Err(error) = state.inner().acp_rpc(&runtime, acp::METHOD_SESSION_CLOSE, acp::session_close_params(&peri_id)?).await {
        if error.contains("-32601") || error.contains("Method not found") {
            log::warn!("agent does not support session/close ({error}); local cleanup only");
        } else {
            return Err(error.into());
        }
    }
    // B9：close 时应答该 session 全部挂起的权限请求为 Cancelled
    respond_pending_permissions_cancelled(&runtime, &peri_id).await;
    state.ensure_generation(&runtime, generation)?;
    if !state.session_matches(&runtime, &source, &peri_id, generation)? {
        return Err(PylonError::Protocol(format!("stale session mapping for source: {source}")));
    }
    let _ = state.remove_session_if_matches(&runtime, &source, &peri_id, generation)?;
    Ok(())
}

#[tauri::command]
async fn cancel_prompt(state: tauri::State<'_, AppState>, source: String) -> Result<(), PylonError> {
    let runtime = state.inner().require_runtime()?;
    let generation = state.current_generation(&runtime);
    let peri_id = state.get_peri_id(&runtime, &source).map_err(|e| e.to_string())?;
    // Fire-and-forget notification — Peri will respond with stopReason=cancelled
    runtime.acp.lock().await.cancel_session(&peri_id).await?;
    // B9：cancel 时应答该 session 全部挂起的权限请求为 Cancelled（协议要求）
    respond_pending_permissions_cancelled(&runtime, &peri_id).await;
    state.ensure_generation(&runtime, generation)?;
    if !state.session_matches(&runtime, &source, &peri_id, generation)? {
        return Err(PylonError::Protocol(format!("stale session mapping for source: {source}")));
    }
    Ok(())
}

#[tauri::command]
async fn load_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.iter().map(|(source, info)| {
        serde_json::json!({"source": source, "periId": info.peri_id, "persona": info.persona, "cwd": info.cwd,
            "title": info.title, "mode": info.mode, "configOptions": info.config_options, "model": info.model, "tokensIn": info.tokens_in, "tokensOut": info.tokens_out,
            "tokensTotal": info.tokens_total, "contextSize": info.context_size})
    }).collect())
}

/// Session Inspector 聚合 DTO：agent 状态 + 全量会话统计 + 会话明细。
/// 独立纯函数便于单测（sessions 快照 + runtime 快照 → payload）。
fn build_inspector_payload(
    sessions: &HashMap<String, SessionInfo>,
    runtime: &AgentRuntimeState,
    active_id: &str,
) -> serde_json::Value {
    let total_tokens: u64 = sessions.values().map(|s| s.tokens_total).sum();
    let total_in: u64 = sessions.values().map(|s| s.tokens_in).sum();
    let total_out: u64 = sessions.values().map(|s| s.tokens_out).sum();
    let active_count = sessions.values()
        .filter(|s| s.has_first_prompt)
        .count();

    let session_rows: Vec<serde_json::Value> = sessions.iter().map(|(source, s)| {
        serde_json::json!({
            "source": source,
            "periId": s.peri_id,
            "title": s.title,
            "model": s.model,
            "mode": s.mode,
            "tokensIn": s.tokens_in,
            "tokensOut": s.tokens_out,
            "tokensTotal": s.tokens_total,
            "contextSize": s.context_size,
            "cwd": s.cwd,
        })
    }).collect();

    serde_json::json!({
        "agent": {
            "id": active_id,
            "status": runtime.status.as_str(),
            "lastError": runtime.last_error,
            "lastConnectedAt": runtime.last_connected_at,
        },
        "summary": {
            "sessionCount": sessions.len(),
            "activeCount": active_count,
            "tokensTotal": total_tokens,
            "tokensIn": total_in,
            "tokensOut": total_out,
        },
        "sessions": session_rows,
    })
}

#[tauri::command]
async fn session_inspector(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
    let runtime_state = runtime.agent_runtime.lock().map(|v| v.clone()).unwrap_or_default();
    let active_id = state.active_agent.lock().map_err(|e| e.to_string())?.clone();
    Ok(build_inspector_payload(&sessions, &runtime_state, &active_id))
}

// ── Agent Registry commands ──

#[tauri::command]
async fn list_agents(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, PylonError> {
    let active_id = state.active_agent.lock().map_err(|e| e.to_string())?.clone();
    let active_status = state.active_runtime()
        .and_then(|runtime| runtime.agent_runtime.lock().ok().map(|state| state.status))
        .unwrap_or(AgentLifecycleStatus::Disconnected);
    Ok(state.agents.lock().map_err(|e| e.to_string())?.iter().map(|(id, a)| {
        agent_summary_payload(id, a, Some(&active_id), Some(active_status))
    }).collect())
}

#[tauri::command]
async fn validate_agents() -> Result<serde_json::Value, String> {
    let agents = agent_config::load()?;
    let default_agent_id = agent_config::default_agent_id(&agents)?;
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
async fn switch_agent(state: tauri::State<'_, AppState>, window: tauri::WebviewWindow, name: String) -> Result<(), PylonError> {
    let inner = state.inner();
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
async fn reconnect_agent(state: tauri::State<'_, AppState>, window: tauri::WebviewWindow) -> Result<(), PylonError> {
    let inner = state.inner();
    let active_id = inner.active_agent.lock().map_err(|error| error.to_string())?.clone();
    let runtime = inner.runtimes.get_or_create(&active_id);
    let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
    let agent = inner.get_active_agent().map_err(|error| error.to_string())?;
    inner.connect_and_replace(&runtime, &window, &agent, None, AgentLifecycleStatus::Reconnecting, "reconnect").await.map_err(PylonError::from)
}

#[tauri::command]
async fn agent_status(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, PylonError> {
    Ok(state.inner().agent_status_payload())
}

#[tauri::command]
async fn set_mcp_servers<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, AppState>,
    servers: Option<Vec<mcp::McpServerConfig>>,
) -> Result<Vec<serde_json::Value>, String> {
    let serialized = mcp::validate_and_serialize(servers.clone())?;
    let persisted = servers.clone();
    *state.runtime_mcp.lock().map_err(|error| error.to_string())? = servers;
    // B4.2：配置落盘（重启不丢）。写失败只 warn，不阻断本次设置。
    persist_mcp_if_possible(&app, persisted.as_deref().unwrap_or_default());
    Ok(serialized)
}

#[tauri::command]
async fn reload_agents(state: tauri::State<'_, AppState>, config_path: Option<String>) -> Result<(), PylonError> {
    let runtime = state.inner().require_runtime()?;
    let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
    let new_agents = if let Some(path) = config_path {
        agent_config::load_from_path(std::path::Path::new(&path))?
    } else {
        agent_config::load()?
    };
    agent_config::default_agent_id(&new_agents)?;
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

/// 宠物状态落盘路径：app_config_dir/pylon-pet.json。
fn pet_persist_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("pylon-pet.json"))
}

// ── B4.2 MCP 配置持久化 ──

/// MCP 配置落盘路径：app_config_dir/pylon-mcp.json。
/// 注意：env/headers 可能含 secret，文件是本地用户配置（写盘是持久化目的），
/// 但不进任何日志/输出。
fn mcp_persist_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("pylon-mcp.json"))
}

/// 原子写 MCP 配置：临时文件 + rename，中断不留半截 JSON。
/// 写失败只 warn，不阻断主流程（尽力持久化）。
fn persist_mcp_if_possible<R: tauri::Runtime>(app: &tauri::AppHandle<R>, servers: &[mcp::McpServerConfig]) {
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
    let temp = path.with_extension("json.tmp");
    let result = (|| {
        std::fs::write(&temp, json.as_bytes()).map_err(|error| format!("write temporary MCP config failed: {error}"))?;
        std::fs::rename(&temp, &path).map_err(|error| format!("commit MCP config failed: {error}"))
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temp);
        log::warn!("persist MCP config failed: {error}");
    }
}

/// 加载 MCP 持久化配置：文件缺失/损坏 → None（启动时静默降级为空配置）。
/// 内容过 validate_and_serialize（防手改文件注入非法配置）——校验失败视为损坏。
pub(crate) fn load_mcp_persisted(path: &std::path::Path) -> Option<Vec<mcp::McpServerConfig>> {
    let raw = std::fs::read_to_string(path).ok()?;
    let servers: Vec<mcp::McpServerConfig> = serde_json::from_str(&raw).ok()?;
    match mcp::validate_and_serialize(Some(servers.clone())) {
        Ok(_) => Some(servers),
        Err(error) => {
            log::warn!("loaded MCP config invalid; ignored: {error}");
            None
        }
    }
}

/// 尽力持久化：路径解析或写盘失败只 warn，不阻断主流程。
fn persist_pet_if_possible(app: &tauri::AppHandle, pet: &pet::PetState) {
    match pet_persist_path(app) {
        Ok(path) => {
            if let Err(error) = pet::save_to_file(pet, &path) {
                log::warn!("persist pet state failed: {error}");
            }
        }
        Err(error) => log::warn!("resolve pet persist path failed: {error}"),
    }
}

#[tauri::command]
async fn get_pet(app: tauri::AppHandle, state: tauri::State<'_, AppState>) -> Result<serde_json::Value, PylonError> {
    let mut pet = state.pet.lock().map_err(|e| e.to_string())?;
    pet::daily_visit(&mut pet);
    // 自动入睡：轮询时检查（首字后 30s 无互动 → sleepy），幂等
    pet::check_sleepy(&mut pet);
    let msg = pet.msg.take();
    let mut value = serde_json::to_value(pet::view(&pet)).map_err(|e| e.to_string())?;
    if let Some(message) = msg {
        value["msg"] = serde_json::Value::String(message);
    }
    persist_pet_if_possible(&app, &pet);
    Ok(value)
}

#[tauri::command]
async fn pet_action(app: tauri::AppHandle, state: tauri::State<'_, AppState>, action: String, value: Option<String>) -> Result<serde_json::Value, PylonError> {
    let mut pet = state.pet.lock().map_err(|e| e.to_string())?;
    let mut sleepy_result: Option<bool> = None;
    match action.as_str() {
        "poke" => { pet::on_poke(&mut pet); }
        "feed" => { pet::on_feed(&mut pet); }
        "rename" => { if let Some(v) = value { pet::rename(&mut pet, &v); } }
        "daily" => { pet::daily_visit(&mut pet); }
        "sleepy" => { sleepy_result = Some(pet::check_sleepy(&mut pet)); }
        "nostalgia" => { pet::recall_memory(&mut pet); }
        "restore" => {
            let raw = value.ok_or_else(|| "restore requires pet state".to_string())?;
            let saved = serde_json::from_str(&raw).map_err(|error| format!("invalid pet state: {error}"))?;
            pet::restore(&mut pet, saved);
        }
        _ => { return Err(PylonError::Protocol(format!("unknown action: {}", action))); }
    }
    let msg = pet.msg.take();
    let mut result = serde_json::to_value(pet::view(&pet)).map_err(|e| e.to_string())?;
    if let Some(sleepy) = sleepy_result {
        // 透传 check_sleepy 结果，前端据此切换睡眠动画/状态
        result["sleepy"] = serde_json::Value::Bool(sleepy);
    }
    if let Some(message) = msg {
        result["msg"] = serde_json::Value::String(message);
    }
    persist_pet_if_possible(&app, &pet);
    Ok(result)
}

// ── B9 权限审批 commands ──

/// 应答挂起的权限请求（B9.4 契约）：option_id 必须是请求提供的选项之一。
/// 拒绝走同一命令（option_id = "reject_once" 等）。返回 Err = 未找到或选项非法。
pub(crate) async fn resolve_permission(
    runtime: &AgentRuntime,
    request_id: u64,
    option_id: &str,
) -> Result<(), PylonError> {
    let found = {
        let pending = runtime.pending_permissions.lock().map_err(|e| e.to_string())?;
        pending.get(&request_id).map(|permission| (permission.tool_call_id.clone(), permission.options.clone()))
    };
    let Some((tool_call_id, options)) = found else {
        return Err(PylonError::Protocol(format!("permission request not found: {request_id}")));
    };
    if !options.iter().any(|option| option == option_id) {
        return Err(PylonError::Protocol(format!("invalid option {option_id} for request {request_id}")));
    }
    let acp = runtime.acp.lock().await;
    acp.send_response(request_id, permission_response(option_id)).await?;
    drop(acp);
    let _ = runtime.pending_permissions.lock().map(|mut pending| pending.remove(&request_id));
    log::info!("权限请求 {request_id} 已应答 {option_id}（{tool_call_id}）");
    Ok(())
}

/// 应答挂起的权限请求（命令入口，跨 runtime 定位）。
#[tauri::command]
async fn approve_tool_call(state: tauri::State<'_, AppState>, request_id: u64, option_id: String) -> Result<(), PylonError> {
    for runtime in state.inner().runtimes.all() {
        if resolve_permission(&runtime, request_id, &option_id).await.is_ok() {
            return Ok(());
        }
    }
    Err(PylonError::Protocol(format!("permission request not found: {request_id}")))
}

/// 设置权限审批模式（B9.3）：bypass/auto 自动批准；edit/default 挂起询问。
#[tauri::command]
async fn set_approval_mode(state: tauri::State<'_, AppState>, mode: String) -> Result<(), PylonError> {
    if !matches!(mode.as_str(), "bypass" | "auto" | "edit" | "default") {
        return Err(PylonError::Protocol(format!("unknown approval mode: {mode}")));
    }
    *state.approval_mode.lock().map_err(|e| e.to_string())? = mode;
    Ok(())
}

// ── Session persistence commands ──

#[tauri::command]
async fn load_persisted_session(
    state: tauri::State<'_, AppState>,
    source: String,
    peri_id: String,
    cwd: Option<String>,
    mcp_servers: Option<Vec<mcp::McpServerConfig>>,
) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let _creation_guard = runtime.session_creation.lock().await;
    let generation = state.current_generation(&runtime);
    let cwd = cwd.unwrap_or_else(|| state.agent_cwd());
    // mcp_servers 必须随 session/load 发送：ACP schema 1.4 该字段无 default，
    // Hermes（Pydantic）缺失即拒绝；Peri 容忍。无配置时 validate 产出空数组。
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
    {
        // 与 new_session / send_message 自动创建一致，恢复历史会话也受上限约束；
        // 同 source 重载（替换）不占新名额。
        let sessions = runtime.sessions.lock().map_err(|e| e.to_string())?;
        if !sessions.contains_key(&source) && sessions.len() >= MAX_SESSIONS {
            return Err(PylonError::Protocol("max sessions reached".to_string()));
        }
    }
    let previous = runtime.sessions.lock().map_err(|e| e.to_string())?
        .insert(source.clone(), SessionInfo::new(peri_id.clone(), String::new(), cwd.clone(), true, generation));
    let acp = runtime.acp.lock().await;
    let load_result = acp.load_session_with_replay(&peri_id, &cwd, mcp_servers).await;
    drop(acp);
    match load_result
    {
        Ok((response, _replay)) => {
            if let Err(error) = state.ensure_generation(&runtime, generation) {
                let mut sessions = runtime.sessions.lock().map_err(|lock_error| lock_error.to_string())?;
                if sessions.get(&source).map(|session| {
                    session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation)
                }) == Some(true) {
                    if let Some(previous) = previous {
                        sessions.insert(source.clone(), previous);
                    } else {
                        sessions.remove(&source);
                    }
                }
                return Err(error.into());
            }
            state.with_session_if_matches(&runtime, &source, &peri_id, generation, |session| {
                session.apply_session_response(&response);
            })?;
            Ok(response)
        }
        Err(error) => {
            let mut sessions = runtime.sessions.lock().map_err(|lock_error| lock_error.to_string())?;
            if sessions.get(&source).map(|session| {
                session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation)
            }) == Some(true) {
                if let Some(previous) = previous {
                    sessions.insert(source.clone(), previous);
                } else {
                    sessions.remove(&source);
                }
            }
            Err(PylonError::Protocol(error))
        }
    }
}

#[tauri::command]
async fn list_persisted_sessions(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, PylonError> {
    let runtime = state.inner().require_runtime()?;
    let generation = state.current_generation(&runtime);
    let cwd = state.get_active_agent().ok().and_then(|a| a.cwd);
    let mut params = serde_json::json!({});
    if let Some(c) = cwd {
        params["cwd"] = serde_json::Value::String(c);
    }
    let response = state.inner().acp_rpc(&runtime, acp::METHOD_SESSION_LIST, params).await?;
    state.ensure_generation(&runtime, generation)?;
    Ok(response)
}

fn is_export_sensitive_key(key: &str) -> bool {
    matches!(key.to_ascii_lowercase().as_str(), "rawinput" | "rawoutput" | "prompt" | "persona" | "headers" | "env" | "authorization")
        || key.to_ascii_lowercase().contains("token")
        || key.to_ascii_lowercase().contains("secret")
}

fn sanitize_export_value(value: &serde_json::Value) -> Option<serde_json::Value> {
    match value {
        serde_json::Value::Object(object) => Some(serde_json::Value::Object(
            object.iter()
                .filter(|(key, _)| !is_export_sensitive_key(key))
                .filter_map(|(key, value)| sanitize_export_value(value).map(|value| (key.clone(), value)))
                .collect(),
        )),
        serde_json::Value::Array(values) => Some(serde_json::Value::Array(
            values.iter().filter_map(sanitize_export_value).collect(),
        )),
        _ => Some(value.clone()),
    }
}

fn sanitize_export_messages(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    messages.iter().filter_map(sanitize_export_value).collect()
}

fn format_export_markdown(peri_id: &str, messages: &[serde_json::Value]) -> String {
    let mut markdown = format!("# Session {peri_id}\n\n");
    for message in messages {
        let Some(update) = message.get("update") else { continue };
        let variant = update.get("sessionUpdate").and_then(|value| value.as_str());
        match variant {
            Some("user_message_chunk") => {
                if let Some(text) = update.get("content").and_then(|content| content.get("text")).and_then(|value| value.as_str()) {
                    markdown.push_str("## User\n\n");
                    markdown.push_str(text);
                    markdown.push_str("\n\n");
                }
            }
            Some("agent_message_chunk") => {
                if let Some(text) = update.get("content").and_then(|content| content.get("text")).and_then(|value| value.as_str()) {
                    markdown.push_str("## Assistant\n\n");
                    markdown.push_str(text);
                    markdown.push_str("\n\n");
                }
            }
            Some("tool_call") | Some("tool_call_update") => {
                let title = update.get("title").or_else(|| update.get("name"))
                    .and_then(|value| value.as_str()).unwrap_or("Tool");
                markdown.push_str(&format!("## Tool: {title}\n\n"));
                let status = update.get("status").and_then(|value| value.as_str()).unwrap_or("unknown");
                markdown.push_str(&format!("### Tool status ({status})\n\n"));
            }
            _ => {}
        }
    }
    markdown
}

// ── Export command ──

#[tauri::command]
async fn export_session(
    state: tauri::State<'_, AppState>,
    peri_id: String,
    format: String,
    output_path: String,
) -> Result<(), PylonError> {
    if !matches!(format.as_str(), "markdown" | "json") {
        return Err(PylonError::Protocol(format!("unsupported export format: {format}")));
    }
    if peri_id.trim().is_empty() {
        return Err(PylonError::Protocol("export requires a non-empty session id".to_string()));
    }
    if output_path.trim().is_empty() {
        return Err(PylonError::Protocol("export requires a non-empty output path".to_string()));
    }
    let output = std::path::Path::new(&output_path);
    if output.is_dir() {
        return Err(PylonError::Protocol(format!("export output path is a directory: {}", output.display())));
    }
    if let Some(parent) = output.parent() {
        if !parent.is_dir() {
            return Err(PylonError::Protocol(format!("export output directory does not exist: {}", parent.display())));
        }
    }
    let runtime = state.inner().require_runtime()?;
    let (source, generation, cwd) = state.export_session_owner(&runtime, &peri_id)?;
    let mcp_servers = mcp::validate_and_serialize(Some(state.inner().current_mcp_servers()?))?;
    let (_, messages) = runtime.acp.lock().await
        .load_session_with_replay(&peri_id, &cwd, mcp_servers)
        .await?;
    state.ensure_generation(&runtime, generation)?;
    let sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
    if sessions.get(&source).map(|session| {
        session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation)
    }) != Some(true) {
        return Err(PylonError::Protocol("export session became stale".to_string()));
    }
    drop(sessions);
    let safe_messages = sanitize_export_messages(&messages);
    let content = match format.as_str() {
        "markdown" => format_export_markdown(&peri_id, &safe_messages),
        _ => serde_json::to_string_pretty(&safe_messages)
            .map_err(|error| format!("serialize export failed: {error}"))?,
    };
    write_export_atomically(output, content.as_bytes())?;
    Ok(())
}

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
                            state.last_connected_at = Some(runtime_log::timestamp());
                        }
                    }
                    Err(error) => {
                        eprintln!("Pylon ACP agent unavailable: {error}");
                        if let Ok(mut state) = default_runtime.agent_runtime.lock() {
                            state.status = AgentLifecycleStatus::Error;
                            state.last_error = Some(error);
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
            })
            .invoke_handler(tauri::generate_handler![
                prism_health, prism_status, prism_state, prism_scenarios, prism_sources, prism_aliases, prism_config,
                prism_logs, prism_chronicle, prism_history, prism_scenario, prism_blocks,
                prism_inject, prism_command, prism_create_scenario, prism_delete_scenario,
                prism_create_source, prism_delete_source, prism_source_detail, prism_source_files,
                prism_read_source_file, prism_write_source_file, prism_delete_source_file,
                prism_source_entries, prism_source_entry, prism_add_source_entry, prism_edit_source_entry,
                prism_delete_source_entry,
                prism_update_config, prism_update_scenario, prism_create_block, prism_update_block,
                prism_delete_block, prism_add_scenario_block, prism_edit_scenario_block,
                prism_delete_scenario_block, prism_reorder_scenario_blocks, prism_reload, prism_llm_test,
                new_session, send_message, set_mode, set_config_option, close_session, cancel_prompt, load_sessions,
                session_inspector, list_agents, switch_agent, reconnect_agent, agent_status, reload_agents, set_mcp_servers,
                validate_agents,
                approve_tool_call, set_approval_mode,
                get_pet, pet_action,
                load_persisted_session, list_persisted_sessions,
                export_session,
                list_runtime_logs, clear_runtime_logs, push_frontend_log,
                get_workspace_root, list_workspace_entries, read_workspace_text,
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
