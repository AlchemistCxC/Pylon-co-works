mod acp;
mod agent_config;
mod agent_runtime;
mod error;
mod mcp;
mod pet;
mod prism;
mod runtime_log;
mod workspace;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, Runtime};
use acp::{AcpClient, PromptWaitOutcome};
use agent_config::AgentDef;
use agent_runtime::{notification_is_current, session_mapping_matches, source_for_peri_id_in_generation, status_after_connection_failure, AgentLifecycleStatus, AgentRuntimeState};
use error::PylonError;
use prism::PrismClient;

fn emit_event<R, W>(window: &W, event: &str, payload: serde_json::Value)
where
    R: Runtime,
    W: Emitter<R>,
{
    if let Err(error) = window.emit(event, payload) {
        log::warn!("emit {event} failed: {error}");
    }
}

fn should_forward_user_update(is_replay: bool) -> bool {
    is_replay
}

struct AppState {
    acp: Arc<tokio::sync::Mutex<AcpClient>>,
    notification_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    session_creation: Arc<tokio::sync::Mutex<()>>,
    agent_lifecycle: Arc<tokio::sync::Mutex<()>>,
    client_generation: Arc<AtomicU64>,
    prompt_locks: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    agents: Arc<Mutex<HashMap<String, AgentDef>>>,
    active_agent: Arc<Mutex<String>>,
    sessions: Arc<Mutex<HashMap<String, SessionInfo>>>,
    pet: Arc<Mutex<pet::PetState>>,
    runtime_logs: Arc<runtime_log::RuntimeLogHub>,
    runtime_mcp: Mutex<Option<Vec<mcp::McpServerConfig>>>,
    agent_runtime: Arc<Mutex<AgentRuntimeState>>,
    prism: PrismClient,
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
async fn list_runtime_logs(state: tauri::State<'_, AppState>, query: Option<runtime_log::RuntimeLogQuery>) -> Result<Vec<runtime_log::RuntimeLogEntry>, String> {
    Ok(state.runtime_logs.list(&query.unwrap_or_default()))
}

#[tauri::command]
async fn clear_runtime_logs(state: tauri::State<'_, AppState>) -> Result<(), String> {
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

fn start_runtime_log_dispatcher(state: &AppState, window: tauri::WebviewWindow) {
    let mut events = state.runtime_logs.subscribe();
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

fn log_runtime_summary(
    state: &AppState,
    level: &str,
    source: &str,
    session: Option<String>,
    message: &str,
    fields: serde_json::Map<String, serde_json::Value>,
) {
    state.runtime_logs.push(runtime_log::timestamp(), level, source, session, message, fields);
}

fn agent_status_payload(state: &AppState) -> serde_json::Value {
    let crashed = state.acp.try_lock().map(|acp| acp.is_crashed()).unwrap_or(false);
    if crashed {
        if let Ok(mut runtime) = state.agent_runtime.lock() {
            runtime.status = AgentLifecycleStatus::Crashed;
            if runtime.last_error.is_none() {
                runtime.last_error = Some("ACP child process stdout closed".to_string());
            }
        }
    }
    let runtime = state.agent_runtime.lock().map(|value| value.clone()).unwrap_or_default();
    let active_agent_id = state.active_agent.lock().ok().map(|value| value.clone()).unwrap_or_default();
    let agent = state.agents.lock().ok().and_then(|agents| agents.get(&active_agent_id).cloned());
    let crashed = matches!(runtime.status, AgentLifecycleStatus::Crashed) || state.acp.try_lock().map(|acp| acp.is_crashed()).unwrap_or(false);
    let status = if crashed { AgentLifecycleStatus::Crashed } else { runtime.status };
    let available = agent.is_some() && status == AgentLifecycleStatus::Connected;
    let last_error = runtime.last_error.clone();
    let recent_error = last_error.clone();
    let legacy_error = last_error.clone();
    serde_json::json!({
        // agentId 是唯一稳定身份；agentName 仅用于展示。
        "agentId": active_agent_id,
        "agentName": agent.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
        // 旧前端兼容字段：值仍是 display name，不得作为 registry key。
        "agent": agent.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
        "status": status.as_str(),
        "transport": agent.as_ref().map(|value| value.transport.clone()).unwrap_or_default(),
        "cwd": agent.as_ref().and_then(|value| value.cwd.clone()).unwrap_or_default(),
        "lastError": last_error,
        "recentError": recent_error,
        // 旧前端兼容字段；新消费者使用 recentError。
        "error": legacy_error,
        "lastConnectedAt": runtime.last_connected_at,
        "generation": state.current_generation(),
        "active": agent.is_some(),
        "available": available,
        "crashed": crashed,
    })
}

fn agent_summary_payload(id: &str, agent: &AgentDef, active_id: &str, active_status: AgentLifecycleStatus) -> serde_json::Value {
    serde_json::json!({
        // list_agents 的 id 是 registry key，name 仅用于展示。
        "id": id,
        "name": agent.name,
        "transport": agent.transport,
        "available": id == active_id && active_status == AgentLifecycleStatus::Connected,
        "active": id == active_id,
        "cwd": agent.cwd.clone(),
    })
}

fn configured_agent_summary(id: &str, agent: &AgentDef) -> serde_json::Value {
    serde_json::json!({
        "id": id,
        "name": agent.name,
        "transport": agent.transport,
        "available": false,
        "active": false,
        "cwd": agent.cwd.clone(),
    })
}

fn set_agent_runtime_status(state: &AppState, status: AgentLifecycleStatus, last_error: Option<String>) {
    if let Ok(mut runtime) = state.agent_runtime.lock() {
        runtime.status = status;
        runtime.last_error = last_error;
        if status == AgentLifecycleStatus::Connected {
            runtime.last_connected_at = Some(runtime_log::timestamp());
        }
    }
}

fn emit_agent_status<R, W>(state: &AppState, window: &W, status: AgentLifecycleStatus, last_error: Option<String>)
where
    R: Runtime,
    W: Emitter<R>,
{
    set_agent_runtime_status(state, status, last_error.clone());
    emit_event(window, "peri:agent-status", {
        let mut payload = agent_status_payload(state);
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

fn workspace_root_for_source(state: &AppState, source: &str) -> Result<String, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    sessions.get(source).map(|session| session.cwd.clone())
        .ok_or_else(|| PylonError::SessionNotFound(source.to_string()).to_string())
}

#[tauri::command]
async fn get_workspace_root(state: tauri::State<'_, AppState>, source: String) -> Result<workspace::WorkspaceRoot, String> {
    let root = workspace_root_for_source(state.inner(), &source)?;
    Ok(workspace::workspace_root(source, std::path::Path::new(&root)))
}

#[tauri::command]
async fn list_workspace_entries(
    state: tauri::State<'_, AppState>, source: String, relative_path: Option<String>, include_hidden: Option<bool>,
) -> Result<Vec<workspace::WorkspaceEntry>, String> {
    let root = workspace_root_for_source(state.inner(), &source)?;
    workspace::list_entries(std::path::Path::new(&root), relative_path.as_deref().unwrap_or("."), include_hidden.unwrap_or(false)).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_workspace_text(
    state: tauri::State<'_, AppState>, source: String, relative_path: String, max_bytes: Option<usize>,
) -> Result<workspace::WorkspaceTextPreview, String> {
    let root = workspace_root_for_source(state.inner(), &source)?;
    workspace::read_text(std::path::Path::new(&root), &relative_path, max_bytes).map_err(|e| e.to_string())
}

async fn prompt_lock_for(
    locks: &Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    source: &str,
) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = locks.lock().await;
    locks
        .entry(source.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn start_notification_dispatcher(state: &AppState, window: tauri::WebviewWindow) {
    if let Ok(mut task) = state.notification_task.lock() {
        if let Some(handle) = task.take() { handle.abort(); }
        let acp = state.acp.clone();
        let sessions = state.sessions.clone();
        let pet = state.pet.clone();
        let generation = state.current_generation();
        let client_generation = state.client_generation.clone();
        let agents = state.agents.clone();
        let active_agent = state.active_agent.clone();
        let agent_runtime = state.agent_runtime.clone();
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
                    if let Ok(mut runtime) = agent_runtime.lock() {
                        runtime.status = AgentLifecycleStatus::Crashed;
                        runtime.last_error = Some(last_error.clone());
                    }
                    let runtime = agent_runtime.lock().map(|value| value.clone()).unwrap_or_default();
                    let active_id = active_agent.lock().ok().map(|value| value.clone()).unwrap_or_default();
                    let agent = agents.lock().ok().and_then(|items| items.get(&active_id).cloned());
                    let last_error = runtime.last_error.clone();
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
                        "lastConnectedAt": runtime.last_connected_at,
                        "generation": client_generation.load(Ordering::Acquire),
                        "active": agent.is_some(),
                        "available": false,
                        "crashed": true,
                    }));
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
                if !notification_is_current(
                    &source,
                    &source,
                    &peri_id,
                    &peri_id,
                    generation,
                    session_generation,
                    client_generation.load(Ordering::Acquire),
                ) {
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
                }
                if variant == Some("user_message_chunk") {
                    if should_forward_user_update(is_replay) {
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
                    map.insert("source".to_string(), serde_json::Value::String(source));
                }
                emit_event(&window, "peri:update", payload);
            }
        }));
    }
}

struct SessionInfo {
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
}

// ── AppState helpers ──

impl AppState {
    fn current_generation(&self) -> u64 {
        self.client_generation.load(Ordering::Acquire)
    }

    fn ensure_generation(&self, expected: u64) -> Result<(), String> {
        let current = self.current_generation();
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

    fn get_peri_id(&self, source: &str) -> Result<String, PylonError> {
        let sessions = self.sessions.lock().map_err(|e| PylonError::Acp(e.to_string()))?;
        sessions.get(source)
            .map(|s| s.peri_id.clone())
            .ok_or_else(|| PylonError::SessionNotFound(source.to_string()))
    }

    fn export_session_owner(&self, peri_id: &str) -> Result<(String, u64, String), String> {
        let generation = self.current_generation();
        let sessions = self.sessions.lock().map_err(|error| error.to_string())?;
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

    fn with_session_if_matches<T>(
        &self,
        source: &str,
        peri_id: &str,
        generation: u64,
        update: impl FnOnce(&mut SessionInfo) -> T,
    ) -> Result<T, String> {
        self.ensure_generation(generation)?;
        let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        let session = sessions
            .get_mut(source)
            .ok_or_else(|| format!("stale session mapping for source: {source}"))?;
        if !session_mapping_matches(&session.peri_id, session.generation, peri_id, generation) {
            return Err(format!("stale session mapping for source: {source}"));
        }
        Ok(update(session))
    }

    fn mark_first_prompt_if_matches(&self, source: &str, peri_id: &str, generation: u64) -> Result<(), String> {
        self.with_session_if_matches(source, peri_id, generation, |session| {
            session.has_first_prompt = true;
        })
    }

    fn remove_session_if_matches(&self, source: &str, peri_id: &str, generation: u64) -> Result<bool, String> {
        let mut sessions = self.sessions.lock().map_err(|error| error.to_string())?;
        if sessions.get(source).map(|session| {
            session_mapping_matches(&session.peri_id, session.generation, peri_id, generation)
        }) == Some(true) {
            Ok(sessions.remove(source).is_some())
        } else {
            Ok(false)
        }
    }
}

const MAX_SESSIONS: usize = 100;

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
) -> Result<serde_json::Value, String> {
    log_runtime_summary(&state, "info", "session", Some(source.clone()), "Session creation started", serde_json::Map::new());
    let _creation_guard = state.session_creation.lock().await;
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= MAX_SESSIONS { return Err("max sessions reached".to_string()); }
    }
    let session_cwd = cwd.unwrap_or_else(|| state.agent_cwd());
    let generation = state.current_generation();
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
    let response = match state.acp.lock().await.new_session(&session_cwd, mcp_servers).await {
        Ok(response) => response,
        Err(error) => {
            log_runtime_summary(&state, "error", "session", Some(source.clone()), "Session creation failed", serde_json::Map::new());
            return Err(error);
        }
    };
    state.ensure_generation(generation)?;
    let peri_id = AcpClient::session_id_from(&response)?;
    let mut session = SessionInfo::new(peri_id.clone(), persona, session_cwd, false, generation);
    session.apply_session_response(&response);
    let replaced = state.sessions.lock().map_err(|e| e.to_string())?
        .insert(source.clone(), session);
    if let Some(old) = replaced {
        if let Err(error) = state.acp.lock().await.close_session(&old.peri_id).await {
            log::warn!("close replaced session: {}", error);
        }
    }
    log_runtime_summary(&state, "info", "session", Some(source.clone()), "Session creation succeeded", serde_json::Map::new());
    // Return full response so frontend gets modes + configOptions + sessionId
    Ok(response)
}

#[tauri::command]
async fn send_message(
    state: tauri::State<'_, AppState>,
    window: tauri::Window,
    source: String,
    content: String,
    persona: String,
    session_prompt: Option<String>,
    attachments: Option<Vec<String>>,
    mcp_servers: Option<Vec<mcp::McpServerConfig>>,
) -> Result<String, String> {
    log_runtime_summary(&state, "info", "prompt", Some(source.clone()), "Prompt started", serde_json::Map::from_iter([
        ("contentLength".to_string(), serde_json::Value::from(content.len())),
        ("attachmentCount".to_string(), serde_json::Value::from(attachments.as_ref().map_or(0, Vec::len))),
    ]));
    let requested_mcp_servers = mcp::validate_and_serialize(mcp_servers.or_else(|| current_mcp_servers(&state).ok()))?;
    let prompt_lock = prompt_lock_for(&state.prompt_locks, &source).await;
    let _prompt_guard = prompt_lock.lock().await;

    if state.acp.lock().await.is_crashed() {
        emit_event(&window, "peri:error", serde_json::json!({"source": source, "error": PylonError::AgentCrashed.to_string()}));
        return Err(PylonError::AgentCrashed.into());
    }

    let (peri_id, is_first) = {
        let _creation_guard = state.session_creation.lock().await;
        let existing = {
            let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
            sessions.get(&source).map(|session| {
                (session.peri_id.clone(), !session.has_first_prompt)
            })
        };
        if let Some(result) = existing {
            result
        } else {
            {
                let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
                if sessions.len() >= MAX_SESSIONS { return Err("max sessions reached".to_string()); }
            }
            let session_cwd = state.agent_cwd();
            let generation = state.current_generation();
            let response = match state.acp.lock().await.new_session(&session_cwd, requested_mcp_servers.clone()).await {
                Ok(response) => response,
                Err(error) => {
                    log_runtime_summary(&state, "error", "session", Some(source.clone()), "Session creation failed", serde_json::Map::new());
                    return Err(error);
                }
            };
            state.ensure_generation(generation)?;
            let pid = AcpClient::session_id_from(&response)?;
            let mut session = SessionInfo::new(pid.clone(), persona.clone(), session_cwd, false, generation);
            session.apply_session_response(&response);
            state.sessions.lock().map_err(|e| e.to_string())?
                .insert(source.clone(), session);
            (pid, true)
        }
    };

    let attachment_paths = attachments.unwrap_or_default();
    let prompt_generation = state.current_generation();

    let effective_persona = session_prompt
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(persona);

    let prompt_content = if is_first && !effective_persona.is_empty() && !content.starts_with('/') {
        format!("{}\n\n---\n\n{}", effective_persona, content)
    } else {
        content.clone()
    };
    let prompt_blocks = AcpClient::prompt_blocks(prompt_content, &attachment_paths)?;

    state.pet.lock().map(|mut p| pet::on_user_sent(&mut p)).ok();
    emit_event(&window, "peri:user", serde_json::json!({ "source": source, "content": content }));
    let (request_id, write_tx, prompt_line, mut rx) = {
        let acp = state.acp.lock().await;
        let (id, line, rx) = acp.prepare_prompt(&peri_id, prompt_blocks)?;
        (id, acp.write_tx.clone(), line, rx)
    };
    if write_tx.send(prompt_line).await.is_err() {
        state.acp.lock().await.remove_pending(request_id);
        let _ = state.remove_session_if_matches(&source, &peri_id, prompt_generation);
        return Err("ACP connection closed".to_string());
    }
    let acp_for_cancel = state.acp.clone();
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
            state.ensure_generation(prompt_generation)?;
            if !state.session_matches(&source, &peri_id, prompt_generation)? {
                return Err(format!("stale session mapping for source: {source}"));
            }
            if let Some(error) = raw.error {
                let error = error.to_string();
                emit_event(&window, "peri:error", serde_json::json!({"source": source, "error": error}));
                let _ = state.pet.lock().map(|mut p| pet::on_error(&mut p));
                Err(error)
            } else {
                let data = raw.result.unwrap_or(serde_json::Value::Null);
                AcpClient::prompt_stop_reason(&data).map_err(|error| {
                    emit_event(&window, "peri:error", serde_json::json!({"source": source, "error": error}));
                    let _ = state.pet.lock().map(|mut pet| pet::on_error(&mut pet));
                    error
                })?;
                if let Err(error) = state.ensure_generation(prompt_generation) {
                    let _ = state.remove_session_if_matches(&source, &peri_id, prompt_generation);
                    emit_event(&window, "peri:error", serde_json::json!({"source": source, "error": error}));
                    return Err(error);
                }
                if is_first {
                    state.mark_first_prompt_if_matches(&source, &peri_id, prompt_generation)?;
                }
                emit_event(&window, "peri:done", serde_json::json!({"source": source, "data": data}));
                let _ = state.pet.lock().map(|mut p| pet::on_done(&mut p));
                log_runtime_summary(&state, "info", "prompt", Some(source.clone()), "Prompt completed", serde_json::Map::from_iter([
                    ("result".to_string(), serde_json::Value::String("success".to_string())),
                ]));
                Ok(peri_id)
            }
        }
        PromptWaitOutcome::ConnectionClosed => {
            state.acp.lock().await.remove_pending(request_id);
            let _ = state.remove_session_if_matches(&source, &peri_id, prompt_generation);
            log_runtime_summary(&state, "error", "prompt", Some(source.clone()), "Prompt connection closed", serde_json::Map::new());
            Err("ACP connection closed".to_string())
        }
        PromptWaitOutcome::CancelledAfterTimeout { response, cancel_error } => {
            state.acp.lock().await.remove_pending(request_id);
            if let Some(cancel_error) = cancel_error {
                log::warn!("cancel timed-out prompt {}: {}", peri_id, cancel_error);
            }
            if response.is_none() {
                match state.remove_session_if_matches(&source, &peri_id, prompt_generation) {
                    Ok(true) => {
                        log::error!(
                            "cancelled prompt {} did not settle within {}s; removed local session mapping",
                            peri_id,
                            acp::CANCEL_SETTLE_TIMEOUT_SECS
                        );
                        if let Err(close_error) = state.acp.lock().await.close_session(&peri_id).await {
                            log::warn!("close unsettled prompt session {}: {}", peri_id, close_error);
                        }
                    }
                    Ok(false) => {}
                    Err(error) => return Err(error),
                }
            }
            let error = "timed out after 300s";
            emit_event(&window, "peri:error", serde_json::json!({"source": source, "error": error}));
            log_runtime_summary(&state, "error", "prompt", Some(source.clone()), "Prompt timed out", serde_json::Map::from_iter([
                ("result".to_string(), serde_json::Value::String("timeout".to_string())),
            ]));
            Err(error.to_string())
        }
    }
}

#[tauri::command]
async fn set_mode(state: tauri::State<'_, AppState>, source: String, mode: String) -> Result<(), String> {
    let generation = state.current_generation();
    let peri_id = state.get_peri_id(&source).map_err(|e| e.to_string())?;
    state.acp.lock().await.set_mode(&peri_id, &mode).await?;
    state.ensure_generation(generation)?;
    state.with_session_if_matches(&source, &peri_id, generation, |session| {
        session.mode = Some(mode);
    })?;
    Ok(())
}

#[tauri::command]
async fn set_config_option(state: tauri::State<'_, AppState>, source: String, key: String, value: String) -> Result<serde_json::Value, String> {
    let generation = state.current_generation();
    let peri_id = state.get_peri_id(&source).map_err(|e| e.to_string())?;
    // Peri returns full configOptions in the response body — no pre-subscribe needed
    let response = state.acp.lock().await.set_config_option(&peri_id, &key, &value).await?;
    state.ensure_generation(generation)?;
    state.with_session_if_matches(&source, &peri_id, generation, |session| {
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
async fn close_session(state: tauri::State<'_, AppState>, source: String) -> Result<(), String> {
    let _creation_guard = state.session_creation.lock().await;
    let generation = state.current_generation();
    let peri_id = state.get_peri_id(&source).map_err(|e| e.to_string())?;
    state.acp.lock().await.close_session(&peri_id).await?;
    state.ensure_generation(generation)?;
    if !state.session_matches(&source, &peri_id, generation)? {
        return Err(format!("stale session mapping for source: {source}"));
    }
    let _ = state.remove_session_if_matches(&source, &peri_id, generation)?;
    Ok(())
}

#[tauri::command]
async fn cancel_prompt(state: tauri::State<'_, AppState>, source: String) -> Result<(), String> {
    let generation = state.current_generation();
    let peri_id = state.get_peri_id(&source).map_err(|e| e.to_string())?;
    // Fire-and-forget notification — Peri will respond with stopReason=cancelled
    state.acp.lock().await.cancel_session(&peri_id).await?;
    state.ensure_generation(generation)?;
    if !state.session_matches(&source, &peri_id, generation)? {
        return Err(format!("stale session mapping for source: {source}"));
    }
    Ok(())
}

#[tauri::command]
async fn load_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.iter().map(|(source, info)| {
        serde_json::json!({"source": source, "periId": info.peri_id, "persona": info.persona, "cwd": info.cwd,
            "title": info.title, "mode": info.mode, "configOptions": info.config_options, "model": info.model, "tokensIn": info.tokens_in, "tokensOut": info.tokens_out,
            "tokensTotal": info.tokens_total, "contextSize": info.context_size})
    }).collect())
}

// ── Agent Registry commands ──

#[tauri::command]
async fn list_agents(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let active_id = state.active_agent.lock().map_err(|e| e.to_string())?.clone();
    let active_status = state.agent_runtime.lock().map(|runtime| runtime.status).unwrap_or(AgentLifecycleStatus::Disconnected);
    Ok(state.agents.lock().map_err(|e| e.to_string())?.iter().map(|(id, a)| {
        agent_summary_payload(id, a, &active_id, active_status)
    }).collect())
}

#[tauri::command]
async fn validate_agents() -> Result<serde_json::Value, String> {
    let agents = agent_config::load()?;
    let default_agent_id = agent_config::default_agent_id(&agents)?;
    let summaries = agents.iter()
        .map(|(id, agent)| configured_agent_summary(id, agent))
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "valid": true,
        "defaultAgentId": default_agent_id,
        "agents": summaries,
    }))
}

async fn replace_agent_client(
    state: &AppState,
    agent_id: Option<String>,
    new_acp: AcpClient,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    if new_acp.is_crashed() {
        return Err("new ACP client crashed before activation".to_string());
    }

    let mut old_acp = {
        let mut acp = state.acp.lock().await;
        // 所有可能失败的同步锁都在替换前获取；失败时 new_acp 仍未接管，
        // 旧 client、generation、active agent 和 sessions 保持不变。
        let mut active_agent = state.active_agent.lock().map_err(|error| error.to_string())?;
        let mut sessions = state.sessions.lock().map_err(|error| error.to_string())?;
        let old_acp = std::mem::replace(&mut *acp, new_acp);
        let new_generation = state.client_generation.fetch_add(1, Ordering::AcqRel) + 1;
        set_agent_runtime_status(state, AgentLifecycleStatus::Connected, None);
        if let Some(agent_id) = agent_id {
            *active_agent = agent_id;
        }
        sessions.clear();
        log::info!("ACP client activated; generation is now {}", new_generation);
        old_acp
    };
    start_notification_dispatcher(state, window);
    if let Err(error) = old_acp.kill() {
        log::warn!("kill replaced agent: {}", error);
    }
    Ok(())
}

#[tauri::command]
async fn switch_agent(state: tauri::State<'_, AppState>, window: tauri::WebviewWindow, name: String) -> Result<(), String> {
    let _lifecycle_guard = state.agent_lifecycle.lock().await;
    let agent = state.agents.lock().map_err(|error| error.to_string())?
        .get(&name)
        .ok_or_else(|| format!("unknown agent: {}", name))?
        .clone();
    let previous_status = state.agent_runtime.lock().map(|runtime| runtime.status).unwrap_or(AgentLifecycleStatus::Disconnected);
    emit_agent_status(&state, &window, AgentLifecycleStatus::Connecting, None);
    log_runtime_summary(&state, "info", "agent", Some(name.clone()), "Agent switch started", serde_json::Map::new());
    let new_acp = match AcpClient::connect_with_logs(&agent, Some(state.runtime_logs.clone())).await {
        Ok(client) => client,
        Err(error) => {
            let fallback_status = status_after_connection_failure(previous_status);
            emit_agent_status(&state, &window, fallback_status, Some(error.clone()));
            log_runtime_summary(&state, "error", "agent", Some(name.clone()), "Agent switch failed", serde_json::Map::new());
            return Err(error);
        }
    };
    replace_agent_client(state.inner(), Some(name), new_acp, window.clone()).await?;
    emit_agent_status(&state, &window, AgentLifecycleStatus::Connected, None);
    log_runtime_summary(&state, "info", "agent", None, "Agent switch succeeded", serde_json::Map::new());
    Ok(())
}

#[tauri::command]
async fn reconnect_agent(state: tauri::State<'_, AppState>, window: tauri::WebviewWindow) -> Result<(), String> {
    let _lifecycle_guard = state.agent_lifecycle.lock().await;
    let agent = state.get_active_agent().map_err(|error| error.to_string())?;
    let previous_status = state.agent_runtime.lock().map(|runtime| runtime.status).unwrap_or(AgentLifecycleStatus::Disconnected);
    emit_agent_status(&state, &window, AgentLifecycleStatus::Reconnecting, None);
    log_runtime_summary(&state, "info", "agent", None, "Agent reconnect started", serde_json::Map::new());
    let new_acp = match AcpClient::connect_with_logs(&agent, Some(state.runtime_logs.clone())).await {
        Ok(client) => client,
        Err(error) => {
            let fallback_status = status_after_connection_failure(previous_status);
            emit_agent_status(&state, &window, fallback_status, Some(error.clone()));
            log_runtime_summary(&state, "error", "agent", None, "Agent reconnect failed", serde_json::Map::new());
            return Err(format!("reconnect failed: {error}"));
        }
    };
    replace_agent_client(state.inner(), None, new_acp, window.clone()).await?;
    emit_agent_status(&state, &window, AgentLifecycleStatus::Connected, None);
    log_runtime_summary(&state, "info", "agent", None, "Agent reconnect succeeded", serde_json::Map::new());
    Ok(())
}

#[tauri::command]
async fn agent_status(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    Ok(agent_status_payload(state.inner()))
}

#[tauri::command]
async fn set_mcp_servers(state: tauri::State<'_, AppState>, servers: Option<Vec<mcp::McpServerConfig>>) -> Result<Vec<serde_json::Value>, String> {
    let serialized = mcp::validate_and_serialize(servers.clone())?;
    *state.runtime_mcp.lock().map_err(|error| error.to_string())? = servers;
    Ok(serialized)
}

fn current_mcp_servers(state: &AppState) -> Result<Vec<mcp::McpServerConfig>, String> {
    Ok(state.runtime_mcp.lock().map_err(|error| error.to_string())?.clone().unwrap_or_default())
}

#[tauri::command]
async fn reload_agents(state: tauri::State<'_, AppState>, config_path: Option<String>) -> Result<(), String> {
    let _lifecycle_guard = state.agent_lifecycle.lock().await;
    let new_agents = if let Some(path) = config_path {
        agent_config::load_from_path(std::path::Path::new(&path))?
    } else {
        agent_config::load()?
    };
    agent_config::default_agent_id(&new_agents)?;
    let active_agent = state.active_agent.lock().map_err(|error| error.to_string())?.clone();
    if !new_agents.contains_key(&active_agent) {
        return Err(format!("agent config cannot remove active agent: {active_agent}"));
    }
    let agent_count = new_agents.len();
    let mut agents = state.agents.lock().map_err(|e| e.to_string())?;
    *agents = new_agents;
    log_runtime_summary(&state, "info", "agent", None, "Agent registry reloaded", serde_json::Map::from_iter([
        ("agentCount".to_string(), serde_json::Value::from(agent_count)),
    ]));
    Ok(())
}

#[tauri::command]
async fn get_pet(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut pet = state.pet.lock().map_err(|e| e.to_string())?;
    pet::daily_visit(&mut pet);
    let msg = pet.msg.take();
    let mut value = serde_json::to_value(pet::view(&pet)).map_err(|e| e.to_string())?;
    if let Some(message) = msg {
        value["msg"] = serde_json::Value::String(message);
    }
    Ok(value)
}

#[tauri::command]
async fn pet_action(state: tauri::State<'_, AppState>, action: String, value: Option<String>) -> Result<serde_json::Value, String> {
    let mut pet = state.pet.lock().map_err(|e| e.to_string())?;
    match action.as_str() {
        "poke" => { pet::on_poke(&mut pet); }
        "feed" => { pet::on_feed(&mut pet); }
        "rename" => { if let Some(v) = value { pet::rename(&mut pet, &v); } }
        "daily" => { pet::daily_visit(&mut pet); }
        "sleepy" => { pet::check_sleepy(&mut pet); }
        "nostalgia" => { pet::recall_memory(&mut pet); }
        "restore" => {
            let raw = value.ok_or_else(|| "restore requires pet state".to_string())?;
            let saved = serde_json::from_str(&raw).map_err(|error| format!("invalid pet state: {error}"))?;
            pet::restore(&mut pet, saved);
        }
        _ => { return Err(format!("unknown action: {}", action)); }
    }
    let msg = pet.msg.take();
    let mut result = serde_json::to_value(pet::view(&pet)).map_err(|e| e.to_string())?;
    if let Some(message) = msg {
        result["msg"] = serde_json::Value::String(message);
    }
    Ok(result)
}

// ── Session persistence commands ──

#[tauri::command]
async fn load_persisted_session(
    state: tauri::State<'_, AppState>,
    source: String,
    peri_id: String,
    cwd: Option<String>,
    mcp_servers: Option<Vec<mcp::McpServerConfig>>,
) -> Result<serde_json::Value, String> {
    let _creation_guard = state.session_creation.lock().await;
    let generation = state.current_generation();
    let cwd = cwd.unwrap_or_else(|| state.agent_cwd());
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
    let previous = state.sessions.lock().map_err(|e| e.to_string())?
        .insert(source.clone(), SessionInfo::new(peri_id.clone(), String::new(), cwd.clone(), true, generation));
    match state.acp.lock().await
        .load_session_with_replay(&peri_id, &cwd, mcp_servers)
        .await
    {
        Ok((response, _replay)) => {
            if let Err(error) = state.ensure_generation(generation) {
                let mut sessions = state.sessions.lock().map_err(|lock_error| lock_error.to_string())?;
                if sessions.get(&source).map(|session| {
                    session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation)
                }) == Some(true) {
                    if let Some(previous) = previous {
                        sessions.insert(source.clone(), previous);
                    } else {
                        sessions.remove(&source);
                    }
                }
                return Err(error);
            }
            state.with_session_if_matches(&source, &peri_id, generation, |session| {
                session.apply_session_response(&response);
            })?;
            Ok(response)
        }
        Err(error) => {
            let mut sessions = state.sessions.lock().map_err(|lock_error| lock_error.to_string())?;
            if sessions.get(&source).map(|session| {
                session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation)
            }) == Some(true) {
                if let Some(previous) = previous {
                    sessions.insert(source.clone(), previous);
                } else {
                    sessions.remove(&source);
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
async fn list_persisted_sessions(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let generation = state.current_generation();
    let cwd = state.get_active_agent().ok().and_then(|a| a.cwd);
    let response = state.acp.lock().await.list_persisted(cwd.as_deref()).await?;
    state.ensure_generation(generation)?;
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
) -> Result<(), String> {
    if !matches!(format.as_str(), "markdown" | "json") {
        return Err(format!("unsupported export format: {format}"));
    }
    if peri_id.trim().is_empty() {
        return Err("export requires a non-empty session id".to_string());
    }
    if output_path.trim().is_empty() {
        return Err("export requires a non-empty output path".to_string());
    }
    let output = std::path::Path::new(&output_path);
    if output.is_dir() {
        return Err(format!("export output path is a directory: {}", output.display()));
    }
    if let Some(parent) = output.parent() {
        if !parent.is_dir() {
            return Err(format!("export output directory does not exist: {}", parent.display()));
        }
    }
    let (source, generation, cwd) = state.export_session_owner(&peri_id)?;
    let mcp_servers = mcp::validate_and_serialize(Some(current_mcp_servers(&state)?))?;
    let (_, messages) = state.acp.lock().await
        .load_session_with_replay(&peri_id, &cwd, mcp_servers)
        .await?;
    state.ensure_generation(generation)?;
    let sessions = state.sessions.lock().map_err(|error| error.to_string())?;
    if sessions.get(&source).map(|session| {
        session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation)
    }) != Some(true) {
        return Err("export session became stale".to_string());
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
        let (initial_acp, initial_agent_runtime) = match default_agent {
            Some(agent) => match AcpClient::connect_with_logs(&agent, Some(runtime_logs.clone())).await {
                Ok(client) => (client, AgentRuntimeState {
                    status: AgentLifecycleStatus::Connected,
                    last_error: None,
                    last_connected_at: Some(runtime_log::timestamp()),
                }),
                Err(error) => {
                    eprintln!("Pylon ACP agent unavailable: {error}");
                    (AcpClient::disconnected(), AgentRuntimeState {
                        status: AgentLifecycleStatus::Error,
                        last_error: Some(error),
                        last_connected_at: None,
                    })
                }
            },
            None => {
                eprintln!("Pylon has no configured Agent; start in disconnected mode");
                (AcpClient::disconnected(), AgentRuntimeState::default())
            }
        };
        let acp = Arc::new(tokio::sync::Mutex::new(initial_acp));
        let acp_for_shutdown = acp.clone();

        tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_fs::init())
            .manage(AppState {
                acp,
                notification_task: Mutex::new(None),
                session_creation: Arc::new(tokio::sync::Mutex::new(())),
                agent_lifecycle: Arc::new(tokio::sync::Mutex::new(())),
                client_generation: Arc::new(AtomicU64::new(0)),
                prompt_locks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
                agents: Arc::new(Mutex::new(agents_for_state)),
                active_agent: Arc::new(Mutex::new(default_agent_id)),
                sessions: Arc::new(Mutex::new(HashMap::new())),
                pet: Arc::new(Mutex::new(pet::PetState::default())),
                runtime_logs,
                runtime_mcp: Mutex::new(None),
                agent_runtime: Arc::new(Mutex::new(initial_agent_runtime)),
                prism,
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
                list_agents, switch_agent, reconnect_agent, agent_status, reload_agents, set_mcp_servers,
                validate_agents,
                get_pet, pet_action,
                load_persisted_session, list_persisted_sessions,
                export_session,
                list_runtime_logs, clear_runtime_logs, push_frontend_log,
                get_workspace_root, list_workspace_entries, read_workspace_text,
            ])
            .setup(|app| {
                let window = app.get_webview_window("main").ok_or("main window not found")?;
                if let Err(error) = window.set_title("Pylon") { log::warn!("set window title failed: {error}"); }
                start_notification_dispatcher(app.state::<AppState>().inner(), window.clone());
                start_runtime_log_dispatcher(app.state::<AppState>().inner(), window);
                Ok(())
            })
            .on_window_event(move |_window, event| {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    // Kill child process on close to prevent orphans on Windows
                    let acp = acp_for_shutdown.clone();
                    let rt = tokio::runtime::Handle::current();
                    rt.block_on(async {
                        if let Err(e) = acp.lock().await.kill() {
                            log::warn!("shutdown kill: {}", e);
                        }
                    });
                }
            })
            .run(tauri::generate_context!())
            .unwrap_or_else(|error| eprintln!("error while running tauri application: {error}"));
    });
}
