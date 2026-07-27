mod acp;
mod agent_config;
mod error;
mod pet;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use acp::{AcpClient, PromptWaitOutcome};
use agent_config::AgentDef;
use error::PylonError;

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
        *task = Some(tokio::spawn(async move {
            let mut rx = acp.lock().await.rx.resubscribe();
            loop {
                let raw = match rx.recv().await {
                    Ok(raw) => raw,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        log::warn!("notification dispatcher lagged by {} messages", n);
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                };
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
                    if let Some(text) = update.get("content").and_then(|c| c.get("text")).and_then(|v| v.as_str()) {
                        let _ = window.emit("peri:user", serde_json::json!({
                            "source": source,
                            "content": text,
                            "replay": is_replay,
                        }));
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
                                session.tokens_total = update.get("value").and_then(|v| v.as_u64()).unwrap_or(0);
                                if let Some(meta) = update.get("_meta") {
                                    session.tokens_in = meta.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                    session.tokens_out = meta.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                    if let Some(model) = meta.get("model").and_then(|v| v.as_str()) { session.model = model.to_string(); }
                                }
                                session.context_size = update.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                                let _ = pet.lock().map(|mut p| pet::on_usage_update(&mut p, session.tokens_total));
                            }
                            Some("tool_call_update") if update.get("status").and_then(|v| v.as_str()) == Some("completed") => {
                                let _ = pet.lock().map(|mut p| pet::on_tool_success(&mut p));
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
                let _ = window.emit("peri:update", payload);
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

    fn remove_session(&self, source: &str) -> Result<String, PylonError> {
        let mut sessions = self.sessions.lock().map_err(|e| PylonError::Acp(e.to_string()))?;
        sessions.remove(source)
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
) -> Result<serde_json::Value, String> {
    let _creation_guard = state.session_creation.lock().await;
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= MAX_SESSIONS { return Err("max sessions reached".to_string()); }
    }
    let session_cwd = cwd.unwrap_or_else(|| state.agent_cwd());
    let response = state.acp.lock().await.new_session(&session_cwd).await?;
    let peri_id = AcpClient::session_id_from(&response)?;
    let replaced = state.sessions.lock().map_err(|e| e.to_string())?
        .insert(source.clone(), SessionInfo { peri_id: peri_id.clone(), persona, cwd: session_cwd, has_first_prompt: false, title: String::new(), model: String::new(), tokens_in: 0, tokens_out: 0, tokens_total: 0, context_size: 0 });
    if let Some(old) = replaced {
        if let Err(error) = state.acp.lock().await.close_session(&old.peri_id).await {
            log::warn!("close replaced session: {}", error);
        }
    }
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
) -> Result<String, String> {
    let prompt_lock = prompt_lock_for(&state.prompt_locks, &source).await;
    let _prompt_guard = prompt_lock.lock().await;

    if state.acp.lock().await.is_crashed() {
        let _ = window.emit("peri:error", serde_json::json!({"source": source, "error": PylonError::AgentCrashed.to_string()}));
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
            let response = state.acp.lock().await.new_session(&session_cwd).await?;
            let pid = AcpClient::session_id_from(&response)?;
            state.sessions.lock().map_err(|e| e.to_string())?
                .insert(source.clone(), SessionInfo { peri_id: pid.clone(), persona: persona.clone(), cwd: session_cwd, has_first_prompt: false, title: String::new(), model: String::new(), tokens_in: 0, tokens_out: 0, tokens_total: 0, context_size: 0 });
            (pid, true)
        }
    };

    let attach_prefix = attachments.unwrap_or_default().iter().fold(String::new(), |mut acc, p| {
        let name = std::path::Path::new(p).file_name().and_then(|n| n.to_str()).unwrap_or(p);
        acc.push_str(&format!("[Attached: {}]\n", name));
        acc
    });

    let effective_persona = session_prompt
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(persona);

    let prompt_content = if is_first && !effective_persona.is_empty() && !content.starts_with('/') {
        format!("{}{}\n\n---\n\n{}", attach_prefix, effective_persona, content)
    } else {
        format!("{}{}", attach_prefix, content)
    };

    state.pet.lock().map(|mut p| pet::on_user_sent(&mut p)).ok();
    let _ = window.emit("peri:user", serde_json::json!({ "source": source, "content": content }));
    let (request_id, write_tx, prompt_line, mut rx) = {
        let acp = state.acp.lock().await;
        let (id, line, rx) = acp.prepare_prompt(&peri_id, &prompt_content)?;
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
                let _ = window.emit("peri:error", serde_json::json!({"source": source, "error": error}));
                let _ = state.pet.lock().map(|mut p| pet::on_error(&mut p));
                Err(error)
            } else {
                if is_first {
                    if let Ok(mut sessions) = state.sessions.lock() {
                        if let Some(session) = sessions.get_mut(&source) {
                            session.has_first_prompt = true;
                        }
                    }
                }
                let data = raw.result.unwrap_or(serde_json::Value::Null);
                let _ = window.emit("peri:done", serde_json::json!({"source": source, "data": data}));
                let _ = state.pet.lock().map(|mut p| pet::on_done(&mut p));
                Ok(peri_id)
            }
        }
        PromptWaitOutcome::ConnectionClosed => Err("ACP connection closed".to_string()),
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
            let _ = window.emit("peri:error", serde_json::json!({"source": source, "error": error}));
            Err(error.to_string())
        }
    }
}

#[tauri::command]
async fn set_mode(state: tauri::State<'_, AppState>, source: String, mode: String) -> Result<(), String> {
    let peri_id = state.get_peri_id(&source).map_err(|e| e.to_string())?;
    state.acp.lock().await.set_mode(&peri_id, &mode).await?;
    Ok(())
}

#[tauri::command]
async fn set_config_option(state: tauri::State<'_, AppState>, source: String, key: String, value: String) -> Result<serde_json::Value, String> {
    let peri_id = state.get_peri_id(&source).map_err(|e| e.to_string())?;
    // Peri returns full configOptions in the response body — no pre-subscribe needed
    state.acp.lock().await.set_config_option(&peri_id, &key, &value).await
}

#[tauri::command]
async fn close_session(state: tauri::State<'_, AppState>, source: String) -> Result<(), String> {
    let peri_id = state.remove_session(&source).map_err(|e| e.to_string())?;
    // Best-effort: notify agent, but don't fail if agent already gone
    if let Err(e) = state.acp.lock().await.close_session(&peri_id).await {
        log::warn!("close_session ACP: {}", e);
    }
    Ok(())
}

#[tauri::command]
async fn cancel_prompt(state: tauri::State<'_, AppState>, source: String) -> Result<(), String> {
    let peri_id = state.get_peri_id(&source).map_err(|e| e.to_string())?;
    // Fire-and-forget notification — Peri will respond with stopReason=cancelled
    state.acp.lock().await.cancel_session(&peri_id).await
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
    let new_acp = AcpClient::connect(&agent).await?;
    replace_agent_client(state.inner(), Some(name), new_acp, window).await
}

#[tauri::command]
async fn reconnect_agent(state: tauri::State<'_, AppState>, window: tauri::WebviewWindow) -> Result<(), String> {
    let _lifecycle_guard = state.agent_lifecycle.lock().await;
    let agent = state.get_active_agent().map_err(|error| error.to_string())?;
    let new_acp = AcpClient::connect(&agent).await
        .map_err(|error| format!("reconnect failed: {}", error))?;
    replace_agent_client(state.inner(), None, new_acp, window.clone()).await?;
    let _ = window.emit("peri:agent-status", serde_json::json!({"status": "connected"}));
    Ok(())
}

#[tauri::command]
async fn agent_status(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let crashed = state.acp.lock().await.is_crashed();
    let agent_name = state.get_active_agent().map(|a| a.name).unwrap_or_default();
    Ok(serde_json::json!({"agent": agent_name, "crashed": crashed}))
}

#[tauri::command]
async fn reload_agents(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let new_agents = agent_config::load();
    let mut agents = state.agents.lock().map_err(|e| e.to_string())?;
    *agents = new_agents;
    Ok(())
}

#[tauri::command]
async fn get_pet(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mut pet = state.pet.lock().map_err(|e| e.to_string())?;
    let msg = pet.msg.take();
    let mut v = serde_json::to_value(&*pet).map_err(|e| e.to_string())?;
    if let Some(m) = msg { v["msg"] = serde_json::Value::String(m.to_string()); }
    Ok(v)
}

#[tauri::command]
async fn pet_action(state: tauri::State<'_, AppState>, action: String, value: Option<String>) -> Result<serde_json::Value, String> {
    let mut pet = state.pet.lock().map_err(|e| e.to_string())?;
    match action.as_str() {
        "poke" => { pet::on_poke(&mut pet); }
        "feed" => { pet::on_feed(&mut pet); }
        "rename" => { if let Some(v) = value { pet.name = v; } }
        "daily" => { pet::daily_decay(&mut pet); }
        "sleepy" => { pet::check_sleepy(&mut pet); }
        "nostalgia" => {
            if let Some((prefix, mem)) = pet::recall_memory(&mut pet) {
                pet.msg = Some(format!("{prefix} {mem}"));
            }
        }
        _ => { return Err(format!("unknown action: {}", action)); }
    }
    let msg = pet.msg.take();
    let mut v = serde_json::to_value(&*pet).map_err(|e| e.to_string())?;
    if let Some(m) = msg { v["msg"] = serde_json::Value::String(m.to_string()); }
    Ok(v)
}

// ── Session persistence commands ──

#[tauri::command]
async fn load_persisted_session(
    state: tauri::State<'_, AppState>,
    source: String,
    peri_id: String,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let generation = state.current_generation();
    let cwd = cwd.unwrap_or_else(|| state.agent_cwd());
    state.sessions.lock().map_err(|e| e.to_string())?
        .insert(source.clone(), SessionInfo { peri_id: peri_id.clone(), persona: String::new(), cwd: cwd.clone(), has_first_prompt: true, title: String::new(), model: String::new(), tokens_in: 0, tokens_out: 0, tokens_total: 0, context_size: 0 });
    match state.acp.lock().await.load_session(&peri_id, &cwd).await {
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
    let cwd = state.get_active_agent().ok().and_then(|a| a.cwd);
    state.acp.lock().await.list_persisted(cwd.as_deref()).await
}

// ── Export command ──

#[tauri::command]
async fn export_session(
    state: tauri::State<'_, AppState>,
    peri_id: String,
    format: String,
    output_path: String,
) -> Result<(), String> {
    let cwd = state.agent_cwd();
    let mut broadcast = state.acp.lock().await.rx.resubscribe();
    let messages: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let msgs = messages.clone();
    let pid = peri_id.clone();
    let handle = tokio::spawn(async move {
        while let Ok(raw) = broadcast.recv().await {
            if raw.method.as_deref() == Some(acp::NOTIF_SESSION_UPDATE) {
                if let Some(params) = raw.params {
                    // Filter by sessionId to avoid mixing messages from other sessions
                    if params.get("sessionId").and_then(|v| v.as_str()) != Some(&*pid) { continue; }
                    msgs.lock().unwrap().push(params);
                }
            }
        }
    });
    state.acp.lock().await.load_session(&peri_id, &cwd).await?;
    // 等 Peri 推送完重放消息
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    handle.abort();
    let msgs = messages.lock().map_err(|e| e.to_string())?;
    let content = match format.as_str() {
        "markdown" => {
            let mut md = format!("# Session {}\n\n", peri_id);
            for msg in msgs.iter() {
                // R1: use sessionUpdate value comparison, content is at same level
                if let Some(update) = msg.get("update") {
                    if update.get("sessionUpdate").and_then(|v| v.as_str()) == Some("agent_message_chunk") {
                        if let Some(text) = update.get("content").and_then(|c| c.get("text")).and_then(|v| v.as_str()) {
                            md.push_str(text);
                        }
                    }
                }
            }
            md
        }
        _ => {
            serde_json::to_string_pretty(&messages).unwrap_or_default()
        }
    };
    std::fs::write(&output_path, content).map_err(|e| format!("write failed: {}", e))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let agents = agent_config::load();
    let default_agent_id = agent_config::default_agent_id(&agents).to_string();
    let default_agent = agents.get(&default_agent_id).expect("default agent not found").clone();
    let agents_for_state = agents;

    let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    rt.block_on(async {
        let acp = Arc::new(tokio::sync::Mutex::new(AcpClient::connect(&default_agent).await.expect("failed to connect ACP agent")));
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
            })
            .invoke_handler(tauri::generate_handler![
                new_session, send_message, set_mode, set_config_option, close_session, cancel_prompt, load_sessions,
                list_agents, switch_agent, reconnect_agent, agent_status, reload_agents,
                get_pet, pet_action,
                load_persisted_session, list_persisted_sessions,
                export_session,
            ])
            .setup(|app| {
                let window = app.get_webview_window("main").ok_or("main window not found")?;
                window.set_title("Pylon").ok();
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
            .expect("error while running tauri application");
    });
}
