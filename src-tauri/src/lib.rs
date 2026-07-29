mod acp;
mod agent_config;
mod error;
mod mcp;
mod pet;
mod runtime_log;
mod workspace;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, Runtime};
use acp::{AcpClient, PromptWaitOutcome};
use agent_config::AgentDef;
use error::PylonError;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentLifecycleStatus {
    Connecting,
    Connected,
    Reconnecting,
    Crashed,
    Disconnected,
    Error,
}

impl AgentLifecycleStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Reconnecting => "reconnecting",
            Self::Crashed => "crashed",
            Self::Disconnected => "disconnected",
            Self::Error => "error",
        }
    }
}

#[derive(Debug, Clone)]
struct AgentRuntimeState {
    status: AgentLifecycleStatus,
    last_error: Option<String>,
    last_connected_at: Option<String>,
}

impl Default for AgentRuntimeState {
    fn default() -> Self {
        Self { status: AgentLifecycleStatus::Disconnected, last_error: None, last_connected_at: None }
    }
}

struct AppState {
    acp: Arc<tokio::sync::Mutex<AcpClient>>,
    notification_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    session_creation: Arc<tokio::sync::Mutex<()>>,
    agent_lifecycle: Arc<tokio::sync::Mutex<()>>,
    client_generation: Arc<AtomicU64>,
    prompt_locks: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    agents: Mutex<HashMap<String, AgentDef>>,
    active_agent: Mutex<String>,
    sessions: Arc<Mutex<HashMap<String, SessionInfo>>>,
    pet: Arc<Mutex<pet::PetState>>,
    runtime_logs: Arc<runtime_log::RuntimeLogHub>,
    runtime_mcp: Mutex<Option<Vec<mcp::McpServerConfig>>>,
    agent_runtime: Mutex<AgentRuntimeState>,
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
    state: tauri::State<'_, AppState>, window: tauri::Window, level: String, source: Option<String>, session: Option<String>, message: String,
    fields: Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<runtime_log::RuntimeLogEntry, String> {
    let entry = state.runtime_logs.push(runtime_log::timestamp(), level, source.unwrap_or_else(|| "frontend".into()), session, message, fields.unwrap_or_default());
    emit_event(&window, "pylon:runtime-log", serde_json::to_value(&entry).map_err(|error| error.to_string())?);
    Ok(entry)
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
    let runtime = state.agent_runtime.lock().map(|value| value.clone()).unwrap_or_default();
    let agent = state.get_active_agent().ok();
    let crashed = matches!(runtime.status, AgentLifecycleStatus::Crashed) || state.acp.try_lock().map(|acp| acp.is_crashed()).unwrap_or(false);
    serde_json::json!({
        "agent": agent.as_ref().map(|value| value.name.clone()).unwrap_or_default(),
        "status": if crashed { AgentLifecycleStatus::Crashed.as_str() } else { runtime.status.as_str() },
        "transport": agent.as_ref().map(|value| value.transport.clone()).unwrap_or_default(),
        "cwd": agent.and_then(|value| value.cwd).unwrap_or_default(),
        "lastError": runtime.last_error,
        "lastConnectedAt": runtime.last_connected_at,
        "generation": state.current_generation(),
        "crashed": crashed,
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
                map.insert("lastError".to_string(), serde_json::Value::String(error));
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
                if raw.method.as_deref() != Some(acp::NOTIF_SESSION_UPDATE) { continue; }
                let mut payload = match raw.params {
                    Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
                    _ => { log::warn!("ACP session/update missing object params"); continue; }
                };
                let peri_id = match payload.get("sessionId").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => { log::warn!("ACP session/update missing sessionId"); continue; }
                };
                let mut source = None;
                for _ in 0..20 {
                    source = sessions.lock().ok().and_then(|items| items.iter()
                        .find(|(_, info)| info.peri_id == peri_id)
                        .map(|(source, _)| source.clone()));
                    if source.is_some() { break; }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
                let Some(source) = source else {
                    log::warn!("ACP notification for unknown session {}", peri_id);
                    continue;
                };
                let Some(update) = payload.get("update") else {
                    log::warn!("ACP session/update missing update payload");
                    continue;
                };
                let variant = update.get("sessionUpdate").and_then(|v| v.as_str());
                let is_replay = update.get("_meta")
                    .and_then(|meta| meta.get("periReplay"))
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false);
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
                if variant == Some("agent_message_chunk") {
                    let _ = pet.lock().map(|mut p| pet::on_first_chunk(&mut p));
                }
                if let Ok(mut items) = sessions.lock() {
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
                                    for option in options {
                                        if option.get("id").or_else(|| option.get("configId")).and_then(|v| v.as_str()) == Some("model") {
                                            if let Some(model) = option.get("currentValue").and_then(|v| v.as_str())
                                                .or_else(|| option.get("valueId").and_then(|v| v.get("value")).and_then(|v| v.as_str())) {
                                                session.model = model.to_string();
                                            }
                                        }
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
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
    model: String,
    tokens_in: u64,
    tokens_out: u64,
    tokens_total: u64,
    context_size: u64,
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
}

const MAX_SESSIONS: usize = 100;

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
    let replaced = state.sessions.lock().map_err(|e| e.to_string())?
        .insert(source.clone(), SessionInfo { peri_id: peri_id.clone(), persona, cwd: session_cwd, has_first_prompt: false, title: String::new(), model: String::new(), tokens_in: 0, tokens_out: 0, tokens_total: 0, context_size: 0 });
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
            state.sessions.lock().map_err(|e| e.to_string())?
                .insert(source.clone(), SessionInfo { peri_id: pid.clone(), persona: persona.clone(), cwd: session_cwd, has_first_prompt: false, title: String::new(), model: String::new(), tokens_in: 0, tokens_out: 0, tokens_total: 0, context_size: 0 });
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
                state.ensure_generation(prompt_generation)?;
                if is_first {
                    if let Ok(mut sessions) = state.sessions.lock() {
                        if let Some(session) = sessions.get_mut(&source) {
                            session.has_first_prompt = true;
                        }
                    }
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
            log_runtime_summary(&state, "error", "prompt", Some(source.clone()), "Prompt connection closed", serde_json::Map::new());
            Err("ACP connection closed".to_string())
        }
        PromptWaitOutcome::CancelledAfterTimeout { response, cancel_error } => {
            state.acp.lock().await.remove_pending(request_id);
            if let Some(cancel_error) = cancel_error {
                log::warn!("cancel timed-out prompt {}: {}", peri_id, cancel_error);
            }
            if response.is_none() {
                let removed = {
                    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
                    if sessions.get(&source).map(|session| session.peri_id.as_str()) == Some(peri_id.as_str()) {
                        sessions.remove(&source)
                    } else {
                        None
                    }
                };
                if removed.is_some() {
                    log::error!(
                        "cancelled prompt {} did not settle within {}s; removed local session mapping",
                        peri_id,
                        acp::CANCEL_SETTLE_TIMEOUT_SECS
                    );
                    if let Err(close_error) = state.acp.lock().await.close_session(&peri_id).await {
                        log::warn!("close unsettled prompt session {}: {}", peri_id, close_error);
                    }
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
    Ok(())
}

#[tauri::command]
async fn set_config_option(state: tauri::State<'_, AppState>, source: String, key: String, value: String) -> Result<serde_json::Value, String> {
    let generation = state.current_generation();
    let peri_id = state.get_peri_id(&source).map_err(|e| e.to_string())?;
    // Peri returns full configOptions in the response body — no pre-subscribe needed
    let response = state.acp.lock().await.set_config_option(&peri_id, &key, &value).await?;
    state.ensure_generation(generation)?;
    Ok(response)
}

#[tauri::command]
async fn close_session(state: tauri::State<'_, AppState>, source: String) -> Result<(), String> {
    let _creation_guard = state.session_creation.lock().await;
    let generation = state.current_generation();
    let peri_id = state.get_peri_id(&source).map_err(|e| e.to_string())?;
    state.acp.lock().await.close_session(&peri_id).await?;
    state.ensure_generation(generation)?;
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if sessions.get(&source).map(|session| session.peri_id.as_str()) == Some(peri_id.as_str()) {
        sessions.remove(&source);
    }
    Ok(())
}

#[tauri::command]
async fn cancel_prompt(state: tauri::State<'_, AppState>, source: String) -> Result<(), String> {
    let generation = state.current_generation();
    let peri_id = state.get_peri_id(&source).map_err(|e| e.to_string())?;
    // Fire-and-forget notification — Peri will respond with stopReason=cancelled
    state.acp.lock().await.cancel_session(&peri_id).await?;
    state.ensure_generation(generation)?;
    Ok(())
}

#[tauri::command]
async fn load_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.iter().map(|(source, info)| {
        serde_json::json!({"source": source, "periId": info.peri_id, "persona": info.persona, "cwd": info.cwd,
            "title": info.title, "model": info.model, "tokensIn": info.tokens_in, "tokensOut": info.tokens_out,
            "tokensTotal": info.tokens_total, "contextSize": info.context_size})
    }).collect())
}

// ── Agent Registry commands ──

#[tauri::command]
async fn list_agents(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    Ok(state.agents.lock().map_err(|e| e.to_string())?.iter().map(|(id, a)| {
        serde_json::json!({"id": id, "name": a.name, "transport": a.transport})
    }).collect())
}

async fn replace_agent_client(
    state: &AppState,
    agent_id: Option<String>,
    new_acp: AcpClient,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let mut old_acp = {
        let mut acp = state.acp.lock().await;
        std::mem::replace(&mut *acp, new_acp)
    };
    state.client_generation.fetch_add(1, Ordering::AcqRel);
    if let Some(agent_id) = agent_id {
        *state.active_agent.lock().map_err(|error| error.to_string())? = agent_id;
    }
    state.sessions.lock().map_err(|error| error.to_string())?.clear();
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
    emit_agent_status(&state, &window, AgentLifecycleStatus::Connecting, None);
    log_runtime_summary(&state, "info", "agent", Some(name.clone()), "Agent switch started", serde_json::Map::new());
    let new_acp = match AcpClient::connect_with_logs(&agent, Some(state.runtime_logs.clone())).await {
        Ok(client) => client,
        Err(error) => {
            emit_agent_status(&state, &window, AgentLifecycleStatus::Error, Some(error.clone()));
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
    emit_agent_status(&state, &window, AgentLifecycleStatus::Reconnecting, None);
    log_runtime_summary(&state, "info", "agent", None, "Agent reconnect started", serde_json::Map::new());
    let new_acp = match AcpClient::connect_with_logs(&agent, Some(state.runtime_logs.clone())).await {
        Ok(client) => client,
        Err(error) => {
            emit_agent_status(&state, &window, AgentLifecycleStatus::Error, Some(error.clone()));
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
    let path = config_path
        .or_else(|| agent_config::config_path().map(|path| path.to_string_lossy().into_owned()))
        .ok_or_else(|| "reload_agents requires configPath or PYLON_AGENTS_CONFIG".to_string())?;
    let new_agents = agent_config::load_from_path(std::path::Path::new(&path))?;
    let mut agents = state.agents.lock().map_err(|e| e.to_string())?;
    *agents = new_agents;
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
    let generation = state.current_generation();
    let cwd = cwd.unwrap_or_else(|| state.agent_cwd());
    state.sessions.lock().map_err(|e| e.to_string())?
        .insert(source.clone(), SessionInfo { peri_id: peri_id.clone(), persona: String::new(), cwd: cwd.clone(), has_first_prompt: true, title: String::new(), model: String::new(), tokens_in: 0, tokens_out: 0, tokens_total: 0, context_size: 0 });
    let mcp_servers = mcp::validate_and_serialize(mcp_servers)?;
    match state.acp.lock().await.load_session(&peri_id, &cwd, mcp_servers).await {
        Ok(response) => {
            if let Err(error) = state.ensure_generation(generation) {
                let mut sessions = state.sessions.lock().map_err(|lock_error| lock_error.to_string())?;
                if sessions.get(&source).map(|session| session.peri_id.as_str()) == Some(peri_id.as_str()) {
                    sessions.remove(&source);
                }
                return Err(error);
            }
            Ok(response)
        }
        Err(error) => {
            let mut sessions = state.sessions.lock().map_err(|lock_error| lock_error.to_string())?;
            if sessions.get(&source).map(|session| session.peri_id.as_str()) == Some(peri_id.as_str()) {
                sessions.remove(&source);
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
            Some("agent_thought_chunk") => {
                if let Some(text) = update.get("content").and_then(|content| content.get("text")).and_then(|value| value.as_str()) {
                    markdown.push_str("## Reasoning\n\n");
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
            Some("tool_call") => {
                let title = update.get("title").or_else(|| update.get("name"))
                    .and_then(|value| value.as_str()).unwrap_or("Tool");
                markdown.push_str(&format!("## Tool: {title}\n\n"));
                if let Some(input) = update.get("rawInput") {
                    markdown.push_str("```json\n");
                    markdown.push_str(&serde_json::to_string_pretty(input).unwrap_or_else(|_| input.to_string()));
                    markdown.push_str("\n```\n\n");
                }
            }
            Some("tool_call_update") => {
                let status = update.get("status").and_then(|value| value.as_str()).unwrap_or("unknown");
                markdown.push_str(&format!("### Tool result ({status})\n\n"));
                if let Some(output) = update.get("rawOutput") {
                    match output.as_str() {
                        Some(text) => markdown.push_str(text),
                        None => markdown.push_str(&serde_json::to_string_pretty(output).unwrap_or_else(|_| output.to_string())),
                    }
                    markdown.push_str("\n\n");
                }
            }
            Some("usage_update" | "session_info_update" | "config_option_update") => {
                markdown.push_str("<details><summary>Metadata</summary>\n\n```json\n");
                markdown.push_str(&serde_json::to_string_pretty(update).unwrap_or_else(|_| update.to_string()));
                markdown.push_str("\n```\n\n</details>\n\n");
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
    let generation = state.current_generation();
    let cwd = state.agent_cwd();
    let mut broadcast = state.acp.lock().await.rx.resubscribe();
    let messages: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let replay_error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let msgs = messages.clone();
    let replay_error_for_task = replay_error.clone();
    let pid = peri_id.clone();
    let handle = tokio::spawn(async move {
        loop {
            match broadcast.recv().await {
                Ok(raw) => {
                    if raw.method.as_deref() == Some(acp::NOTIF_SESSION_UPDATE) {
                        if let Some(params) = raw.params {
                            if params.get("sessionId").and_then(|value| value.as_str()) != Some(&*pid) { continue; }
                            msgs.lock().unwrap().push(params);
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(count)) => {
                    *replay_error_for_task.lock().unwrap() = Some(format!("export replay lagged by {count} messages"));
                    break;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    *replay_error_for_task.lock().unwrap() = Some("ACP notification stream closed during export".to_string());
                    break;
                }
            }
        }
    });
    let mcp_servers = mcp::validate_and_serialize(Some(current_mcp_servers(&state)?))?;
    state.acp.lock().await.load_session(&peri_id, &cwd, mcp_servers).await?;
    state.ensure_generation(generation)?;
    handle.abort();
    if let Some(error) = replay_error.lock().map_err(|lock_error| lock_error.to_string())?.take() {
        return Err(error);
    }
    let msgs = messages.lock().map_err(|e| e.to_string())?;
    let content = match format.as_str() {
        "markdown" => format_export_markdown(&peri_id, &msgs),
        _ => serde_json::to_string_pretty(&*msgs).map_err(|error| format!("serialize export failed: {error}"))?,
    };
    std::fs::write(&output_path, content).map_err(|e| format!("write failed: {}", e))?;
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
    let default_agent_id = agent_config::default_agent_id(&agents).unwrap_or("").to_string();
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
        let runtime_logs = runtime_log::RuntimeLogHub::default();
        let acp = Arc::new(tokio::sync::Mutex::new(match default_agent {
            Some(agent) => match AcpClient::connect_with_logs(&agent, Some(runtime_logs.clone())).await {
                Ok(client) => client,
                Err(error) => {
                    eprintln!("Pylon ACP agent unavailable: {error}");
                    AcpClient::disconnected()
                }
            },
            None => {
                eprintln!("Pylon has no configured Agent; start in disconnected mode");
                AcpClient::disconnected()
            }
        }));
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
                agents: Mutex::new(agents_for_state),
                active_agent: Mutex::new(default_agent_id),
                sessions: Arc::new(Mutex::new(HashMap::new())),
                pet: Arc::new(Mutex::new(pet::PetState::default())),
                runtime_logs,
                runtime_mcp: Mutex::new(None),
                agent_runtime: Mutex::new(AgentRuntimeState {
                    status: AgentLifecycleStatus::Connected,
                    ..AgentRuntimeState::default()
                }),
            })
            .invoke_handler(tauri::generate_handler![
                new_session, send_message, set_mode, set_config_option, close_session, cancel_prompt, load_sessions,
                list_agents, switch_agent, reconnect_agent, agent_status, reload_agents, set_mcp_servers,
                get_pet, pet_action,
                load_persisted_session, list_persisted_sessions,
                export_session,
                list_runtime_logs, clear_runtime_logs, push_frontend_log,
                get_workspace_root, list_workspace_entries, read_workspace_text,
            ])
            .setup(|app| {
                let window = app.get_webview_window("main").ok_or("main window not found")?;
                if let Err(error) = window.set_title("Pylon") { log::warn!("set window title failed: {error}"); }
                start_notification_dispatcher(app.state::<AppState>().inner(), window);
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
