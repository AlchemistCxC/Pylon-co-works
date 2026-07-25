mod acp;
mod agent_config;

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use acp::AcpClient;
use agent_config::AgentDef;

struct AppState {
    acp: Arc<tokio::sync::Mutex<AcpClient>>,
    agents: HashMap<String, AgentDef>,
    active_agent: Mutex<String>,
    sessions: Mutex<HashMap<String, SessionInfo>>,
}

struct SessionInfo {
    peri_id: String,
    persona: String,
    has_first_prompt: bool,
}

#[tauri::command]
async fn new_session(
    state: tauri::State<'_, AppState>,
    source: String,
    persona: String,
) -> Result<String, String> {
    let agent = { let aa = state.active_agent.lock().map_err(|e| e.to_string())?; state.agents.get(&*aa).ok_or("no active agent")?.clone() };
    let cwd = agent.cwd.as_deref().unwrap_or(".");
    let peri_id = state.acp.lock().await.new_session(cwd).await?;
    state.sessions.lock().map_err(|e| e.to_string())?
        .insert(source.clone(), SessionInfo { peri_id: peri_id.clone(), persona, has_first_prompt: false });
    Ok(peri_id)
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
    let (peri_id, is_first) = 'session: {
        {
            let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(s) = sessions.get_mut(&source) {
                let first = !s.has_first_prompt;
                if first { s.has_first_prompt = true; }
                break 'session (s.peri_id.clone(), first);
            }
        }
        let agent = { let aa = state.active_agent.lock().map_err(|e| e.to_string())?; state.agents.get(&*aa).ok_or("no active agent")?.clone() };
        let cwd = agent.cwd.as_deref().unwrap_or(".");
        let peri_id = state.acp.lock().await.new_session(cwd).await?;
        state.sessions.lock().map_err(|e| e.to_string())?
            .insert(source.clone(), SessionInfo { peri_id: peri_id.clone(), persona: persona.clone(), has_first_prompt: true });
        (peri_id, true)
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
    let mut broadcast = state.acp.lock().await.rx.resubscribe();
    let (_request_id, mut rx) = state.acp.lock().await.send_prompt_atomic(&peri_id, &prompt_content)?;
    let _ = window.emit("peri:user", serde_json::json!({ "source": source, "content": user_content }));

    let pid = peri_id.clone();
    let win = window.clone();
    let src = source.clone();
    let result = tokio::time::timeout(Duration::from_secs(300), async move {
        loop {
            tokio::select! {
                msg = &mut rx => {
                    match msg {
                        Ok(raw) => {
                            if let Some(params) = raw.result {
                                let _ = win.emit("peri:done", serde_json::json!({"source": src, "data": params}));
                            }
                            if let Some(err) = raw.error {
                                let _ = win.emit("peri:error", serde_json::json!({"source": src, "error": err.to_string()}));
                            }
                            return Ok(());
                        }
                        Err(_) => return Err("ACP connection closed".to_string()),
                    }
                }
                notif = broadcast.recv() => {
                    match notif {
                        Ok(raw) => {
                            if raw.method.as_deref() == Some("session/update") {
                                let payload = raw.params.unwrap_or(serde_json::Value::Null);
                                // R3: filter by sessionId
                                if payload.get("sessionId").and_then(|v| v.as_str()) != Some(&pid) { continue; }
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
    let peri_id = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&source).map(|s| s.peri_id.clone()).ok_or("no session")?
    };
    state.acp.lock().await.set_mode(&peri_id, &mode).await?;
    Ok(())
}

#[tauri::command]
async fn load_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.iter().map(|(source, info)| {
        serde_json::json!({"source": source, "periId": info.peri_id, "persona": info.persona})
    }).collect())
}

// ── Agent Registry commands ──

#[tauri::command]
async fn list_agents(state: tauri::State<'_, AppState>) -> Result<Vec<serde_json::Value>, String> {
    Ok(state.agents.iter().map(|(id, a)| {
        serde_json::json!({"id": id, "name": a.name, "transport": a.transport})
    }).collect())
}

#[tauri::command]
async fn switch_agent(state: tauri::State<'_, AppState>, name: String) -> Result<(), String> {
    let agent = state.agents.get(&name).ok_or_else(|| format!("unknown agent: {}", name))?.clone();
    // R4: reconnect AcpClient
    let new_acp = AcpClient::connect(&agent).await?;
    let mut acp = state.acp.lock().await;
    *acp = new_acp;
    drop(acp);
    *state.active_agent.lock().map_err(|e| e.to_string())? = name;
    state.sessions.lock().map_err(|e| e.to_string())?.clear();
    Ok(())
}

// ── Session persistence commands ──

#[tauri::command]
async fn load_persisted_session(
    state: tauri::State<'_, AppState>,
    source: String,
    window: tauri::Window,
    peri_id: String,
) -> Result<(), String> {
    let agent = { let aa = state.active_agent.lock().map_err(|e| e.to_string())?; state.agents.get(&*aa).ok_or("no active agent")?.clone() };
    let mut broadcast = state.acp.lock().await.rx.resubscribe();
    let src = source.clone();
    let pid = peri_id.clone();
    let win = window.clone();
    let handle = tokio::spawn(async move {
        while let Ok(raw) = broadcast.recv().await {
            if raw.method.as_deref() == Some("session/update") {
                let payload = raw.params.unwrap_or(serde_json::Value::Null);
                // R3: filter by sessionId
                if payload.get("sessionId").and_then(|v| v.as_str()) != Some(&pid) { continue; }
                let mut payload = payload;
                if let serde_json::Value::Object(ref mut map) = payload {
                    map.insert("source".to_string(), serde_json::Value::String(src.clone()));
                }
                let _ = win.emit("peri:update", payload);
            }
        }
    });
    let cwd = agent.cwd.as_deref().unwrap_or(".");
    state.acp.lock().await.load_session(&peri_id, cwd).await?;
    handle.abort();  // R2: prevent task leak
    state.sessions.lock().map_err(|e| e.to_string())?
        .insert(source, SessionInfo { peri_id: peri_id.clone(), persona: String::new(), has_first_prompt: true });
    Ok(())
}

#[tauri::command]
async fn list_persisted_sessions(state: tauri::State<'_, AppState>) -> Result<serde_json::Value, String> {
    let agent = { let aa = state.active_agent.lock().map_err(|e| e.to_string())?; state.agents.get(&*aa).ok_or("no active agent")?.clone() };
    let cwd = agent.cwd.as_deref();
    state.acp.lock().await.list_persisted(cwd).await
}

// ── Export command ──

#[tauri::command]
async fn export_session(
    state: tauri::State<'_, AppState>,
    peri_id: String,
    format: String,
    output_path: String,
) -> Result<(), String> {
    let agent = { let aa = state.active_agent.lock().map_err(|e| e.to_string())?; state.agents.get(&*aa).ok_or("no active agent")?.clone() };
    let cwd = agent.cwd.as_deref().unwrap_or(".");
    let mut broadcast = state.acp.lock().await.rx.resubscribe();
    let messages: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
    let msgs = messages.clone();
    let handle = tokio::spawn(async move {
        while let Ok(raw) = broadcast.recv().await {
            if raw.method.as_deref() == Some("session/update") {
                if let Some(params) = raw.params {
                    msgs.lock().unwrap().push(params);
                }
            }
        }
    });
    state.acp.lock().await.load_session(&peri_id, cwd).await?;
    handle.abort();
    let msgs = messages.lock().map_err(|e| e.to_string())?;
    let content = match format.as_str() {
        "markdown" => {
            let mut md = format!("# Session {}\n\n", peri_id);
            for msg in msgs.iter() {
                // R1: use sessionUpdate value comparison, content is at same level
                if let Some(update) = msg.get("update") {
                    if update.get("sessionUpdate").and_then(|v| v.as_str()) == Some("agentMessageChunk") {
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
    let agents_sorted: BTreeMap<_, _> = agents.iter().collect();
    let default_agent_id = agents_sorted.keys().next().expect("no agents in agents.yaml").to_string();
    let default_agent = agents.get(&default_agent_id).expect("default agent not found").clone();
    let agents_for_state = agents;

    let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    rt.block_on(async {
        let acp = Arc::new(tokio::sync::Mutex::new(AcpClient::connect(&default_agent).await.expect("failed to connect ACP agent")));

        tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_fs::init())
            .manage(AppState {
                acp,
                agents: agents_for_state,
                active_agent: Mutex::new(default_agent_id),
                sessions: Mutex::new(HashMap::new()),
            })
            .invoke_handler(tauri::generate_handler![
                new_session, send_message, set_mode, load_sessions,
                list_agents, switch_agent,
                load_persisted_session, list_persisted_sessions,
                export_session,
            ])
            .setup(|app| {
                app.get_webview_window("main").unwrap().set_title("Pylon").ok();
                Ok(())
            })
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    });
}
