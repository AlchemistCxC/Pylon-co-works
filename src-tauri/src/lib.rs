mod acp;
mod agent_config;
mod error;
mod pet;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use acp::AcpClient;
use agent_config::AgentDef;
use error::PylonError;

struct AppState {
    acp: Arc<tokio::sync::Mutex<AcpClient>>,
    agents: Mutex<HashMap<String, AgentDef>>,
    active_agent: Mutex<String>,
    sessions: Arc<Mutex<HashMap<String, SessionInfo>>>,
    pet: Arc<Mutex<pet::PetState>>,
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
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= MAX_SESSIONS { return Err("max sessions reached".to_string()); }
    }
    let session_cwd = cwd.unwrap_or_else(|| state.agent_cwd());
    let response = state.acp.lock().await.new_session(&session_cwd).await?;
    let peri_id = AcpClient::session_id_from(&response)?;
    state.sessions.lock().map_err(|e| e.to_string())?
        .insert(source.clone(), SessionInfo { peri_id: peri_id.clone(), persona, cwd: session_cwd, has_first_prompt: false, title: String::new(), model: String::new(), tokens_in: 0, tokens_out: 0, tokens_total: 0, context_size: 0 });
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
    if state.acp.lock().await.is_crashed() {
        let _ = window.emit("peri:error", serde_json::json!({"source": source, "error": PylonError::AgentCrashed.to_string()}));
        return Err(PylonError::AgentCrashed.into());
    }

    let (peri_id, is_first) = {
        let found = {
            let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
            sessions.get_mut(&source).map(|s| {
                let first = !s.has_first_prompt;
                if first { s.has_first_prompt = true; }
                (s.peri_id.clone(), first)
            })
        };
        if let Some(result) = found {
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
                .insert(source.clone(), SessionInfo { peri_id: pid.clone(), persona: persona.clone(), cwd: session_cwd, has_first_prompt: true, title: String::new(), model: String::new(), tokens_in: 0, tokens_out: 0, tokens_total: 0, context_size: 0 });
            (pid, true)
        }
    };

    let attach_prefix = attachments.unwrap_or_default().iter().fold(String::new(), |mut acc, p| {
        let name = std::path::Path::new(p).file_name().and_then(|n| n.to_str()).unwrap_or(p);
        acc.push_str(&format!("[Attached: {}]\n", name));
        acc
    });

    let effective_persona = session_prompt.unwrap_or(persona);

    let prompt_content = if is_first && !effective_persona.is_empty() && !content.starts_with('/') {
        format!("{}{}\n\n---\n\n{}", attach_prefix, effective_persona, content)
    } else {
        format!("{}{}", attach_prefix, content)
    };

    let user_content = content.clone();
    let (mut broadcast, write_tx, (_id, prompt_line, mut rx)) = {
        let acp = state.acp.lock().await;
        let tx = acp.write_tx.clone();
        let prompt = acp.prepare_prompt(&peri_id, &prompt_content)?;
        (acp.rx.resubscribe(), tx, prompt)
    };
    write_tx.send(prompt_line).await.map_err(|_| "ACP connection closed".to_string())?;
    state.pet.lock().map(|mut p| pet::on_user_sent(&mut p)).ok();
    let _ = window.emit("peri:user", serde_json::json!({ "source": source, "content": user_content }));

    let pid = peri_id.clone();
    let win = window.clone();
    let src = source.clone();
    let sessions = state.sessions.clone();
    let pet = state.pet.clone();
    let result = tokio::time::timeout(Duration::from_secs(acp::PROMPT_TIMEOUT_SECS), async move {
        loop {
            tokio::select! {
                msg = &mut rx => {
                    match msg {
                        Ok(raw) => {
                            let has_error = raw.error.is_some();
                            if let Some(ref params) = raw.result {
                                let _ = win.emit("peri:done", serde_json::json!({"source": src, "data": params}));
                            }
                            if has_error {
                                let _ = win.emit("peri:error", serde_json::json!({"source": src, "error": raw.error.unwrap_or_default().to_string()}));
                                let _ = pet.lock().map(|mut p| pet::on_error(&mut p));
                            } else {
                                let _ = pet.lock().map(|mut p| pet::on_done(&mut p));
                            }
                            return Ok(());
                        }
                        Err(_) => {
                            let _ = pet.lock().map(|mut p| pet::on_error(&mut p));
                            return Err("ACP connection closed".to_string());
                        }
                    }
                }
                notif = broadcast.recv() => {
                    match notif {
                        Ok(raw) => {
                            if raw.method.as_deref() == Some(acp::NOTIF_SESSION_UPDATE) {
                                let payload = raw.params.unwrap_or(serde_json::Value::Null);
                                if payload.get("sessionId").and_then(|v| v.as_str()) != Some(&pid) { continue; }
                                // Check for userMessageChunk (history replay) → emit as user message
                                if let Some(update) = payload.get("update") {
                                    if update.get("sessionUpdate").and_then(|v| v.as_str()) == Some("user_message_chunk") {
                                        if let Some(text) = update.get("content").and_then(|c| c.get("text")).and_then(|v| v.as_str()) {
                                            let _ = win.emit("peri:user", serde_json::json!({"source": src, "content": text}));
                                            continue;
                                        }
                                    }
                                    // First agent chunk → pet gets curious
                                    if update.get("sessionUpdate").and_then(|v| v.as_str()) == Some("agent_message_chunk") {
                                        let _ = pet.lock().map(|mut p| pet::on_first_chunk(&mut p));
                                    }
                                }
                                // Update session metadata from notifications
                                {
                                    let payload_ref = &payload;
                                    let update = match payload_ref.get("update") { Some(u) => u, None => unreachable!() };
                                    let variant = update.get("sessionUpdate").and_then(|v| v.as_str());
                                    if let Ok(mut sessions) = sessions.lock() {
                                        if let Some(s) = sessions.get_mut(&src) {
                                            match variant {
                                                Some("usage_update") => {
                                                    s.tokens_total = update.get("value").and_then(|v| v.as_u64()).unwrap_or(0);
                                                    if let Some(meta) = update.get("_meta") {
                                                        s.tokens_in = meta.get("inputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                                        s.tokens_out = meta.get("outputTokens").and_then(|v| v.as_u64()).unwrap_or(0);
                                                        if let Some(m) = meta.get("model").and_then(|v| v.as_str()) { s.model = m.to_string(); }
                                                    }
                                                    s.context_size = update.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                                                    // Pet growth: track cumulative tokens
                                                    let _ = pet.lock().map(|mut p| pet::on_usage_update(&mut p, s.tokens_total));
                                                }
                                                Some("tool_call_update") => {
                                                    // Pet growth: count successful tool calls
                                                    if update.get("status").and_then(|v| v.as_str()) == Some("completed") {
                                                        let _ = pet.lock().map(|mut p| pet::on_tool_success(&mut p));
                                                    }
                                                }
                                                Some("session_info_update") => {
                                                    if let Some(t) = update.get("title").and_then(|v| v.as_str()) {
                                                        s.title = t.to_string();
                                                        // Pet memory: capture every 100th message's session title
                                                        let _ = pet.lock().map(|mut p| {
                                                            if p.messages > 0 && p.messages % 100 == 0 {
                                                                pet::add_memory(&mut p, t.to_string());
                                                            }
                                                        });
                                                    }
                                                }
                                                Some("config_option_update") => {
                                                    if let Some(opts) = update.get("configOptions").and_then(|v| v.as_array()) {
                                                        for opt in opts {
                                                            if opt.get("configId").and_then(|v| v.as_str()) == Some("model") {
                                                                if let Some(vid) = opt.get("valueId").and_then(|v| v.get("value")).and_then(|v| v.as_str()) {
                                                                    s.model = vid.to_string();
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                                _ => {}
                                            }
                                        }
                                    }
                                }
                                let mut payload = payload;
                                if let serde_json::Value::Object(ref mut map) = payload {
                                    map.insert("source".to_string(), serde_json::Value::String(src.clone()));
                                }
                                let _ = win.emit("peri:update", payload);
                            }
                        }
                        Err(e) => {
                            if let tokio::sync::broadcast::error::RecvError::Lagged(n) = e {
                                log::warn!("broadcast lagged by {} messages", n);
                            }
                        }
                    }
                }
            }
        }
    }).await;

    match result {
        Ok(Ok(())) => Ok(peri_id),
        Ok(Err(e)) => Err(e),
        Err(_) => {
            let _ = window.emit("peri:error", serde_json::json!({"source": source, "error": "timed out after 300s"}));
            Err("timeout".to_string())
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

#[tauri::command]
async fn switch_agent(state: tauri::State<'_, AppState>, name: String) -> Result<(), String> {
    let agent = state.agents.lock().map_err(|e| e.to_string())?.get(&name).ok_or_else(|| format!("unknown agent: {}", name))?.clone();
    // Kill old agent process before connecting new one (prevents orphans on Windows)
    if let Err(e) = state.acp.lock().await.kill() {
        log::warn!("kill old agent: {}", e);
    }
    let new_acp = AcpClient::connect(&agent).await?;
    {
        let mut acp = state.acp.lock().await;
        *acp = new_acp;
    }
    *state.active_agent.lock().map_err(|e| e.to_string())? = name;
    state.sessions.lock().map_err(|e| e.to_string())?.clear();
    Ok(())
}

#[tauri::command]
async fn reconnect_agent(state: tauri::State<'_, AppState>, window: tauri::Window) -> Result<(), String> {
    let agent = state.get_active_agent().map_err(|e| e.to_string())?;
    // Kill old (may already be dead)
    let _ = state.acp.lock().await.kill();
    let new_acp = AcpClient::connect(&agent).await.map_err(|e| format!("reconnect failed: {}", e))?;
    {
        let mut acp = state.acp.lock().await;
        *acp = new_acp;
    }
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
                pet.msg = Some(Box::leak(format!("{prefix} {mem}").into_boxed_str())); // lives 'static
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
    window: tauri::Window,
    peri_id: String,
) -> Result<(), String> {
    let cwd = state.agent_cwd();
    let mut broadcast = state.acp.lock().await.rx.resubscribe();
    let src = source.clone();
    let pid = peri_id.clone();
    let win = window.clone();
    let handle = tokio::spawn(async move {
        while let Ok(raw) = broadcast.recv().await {
            if raw.method.as_deref() == Some(acp::NOTIF_SESSION_UPDATE) {
                let payload = raw.params.unwrap_or(serde_json::Value::Null);
                // R3: filter by sessionId
                if payload.get("sessionId").and_then(|v| v.as_str()) != Some(&pid) { continue; }
                // 重放中的 user_message_chunk → peri:user；其余 → peri:update
                if let Some(update) = payload.get("update") {
                    if update.get("sessionUpdate").and_then(|v| v.as_str()) == Some("user_message_chunk") {
                        if let Some(text) = update.get("content").and_then(|c| c.get("text")).and_then(|v| v.as_str()) {
                            let _ = win.emit("peri:user", serde_json::json!({"source": src, "content": text}));
                        }
                        continue;
                    }
                }
                let mut payload = payload;
                if let serde_json::Value::Object(ref mut map) = payload {
                    map.insert("source".to_string(), serde_json::Value::String(src.clone()));
                }
                let _ = win.emit("peri:update", payload);
            }
        }
    });
    state.acp.lock().await.load_session(&peri_id, &cwd).await?;
    // 等 Peri 推送完重放消息（session/update 通知在 RPC 返回后异步到达）
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    handle.abort();
    // 标记重放完成
    let _ = win.emit("peri:done", serde_json::json!({"source": src}));
    state.sessions.lock().map_err(|e| e.to_string())?
        .insert(source, SessionInfo { peri_id: peri_id.clone(), persona: String::new(), cwd, has_first_prompt: false, title: String::new(), model: String::new(), tokens_in: 0, tokens_out: 0, tokens_total: 0, context_size: 0 });
    Ok(())
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
                app.get_webview_window("main").unwrap().set_title("Pylon").ok();
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
