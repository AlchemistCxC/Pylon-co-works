mod acp;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};
use acp::AcpClient;

struct AppState {
    acp: Arc<AcpClient>,
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
    let peri_id = state.acp.new_session("G:\\Project\\prism").await?;
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
) -> Result<String, String> {
    // Look up or create session — drop lock before any .await
    let (peri_id, is_first) = 'session: {
        {
            let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
            if let Some(s) = sessions.get_mut(&source) {
                let first = !s.has_first_prompt;
                if first { s.has_first_prompt = true; }
                break 'session (s.peri_id.clone(), first);
            }
        }
        // Lock dropped — safe to .await
        let peri_id = state.acp.new_session("G:\\Project\\prism").await?;
        state.sessions.lock().map_err(|e| e.to_string())?
            .insert(source.clone(), SessionInfo { peri_id: peri_id.clone(), persona: persona.clone(), has_first_prompt: true });
        (peri_id, true)
    };

    // Skip persona injection for slash commands
    let prompt_content = if is_first && !persona.is_empty() && !content.starts_with('/') {
        format!("{}\n\n---\n\n{}", persona, content)
    } else {
        content.clone()
    };

    let user_content = content.clone();

    // Subscribe to broadcast BEFORE sending prompt (no missed streaming events)
    let mut broadcast = state.acp.rx.resubscribe();

    // Atomic: register oneshot before writing to stdin (no timing hole)
    let (_request_id, mut rx) = state.acp.send_prompt_atomic(&peri_id, &prompt_content)?;

    // Echo user message
    let _ = window.emit("peri:user", serde_json::json!({
        "source": source,
        "content": user_content,
    }));

    let win = window.clone();
    let src = source.clone();

    // Read streaming notifications + final response with timeout
    let result = tokio::time::timeout(Duration::from_secs(300), async move {
        loop {
            tokio::select! {
                // Response from oneshot
                msg = &mut rx => {
                    match msg {
                        Ok(raw) => {
                            if let Some(params) = raw.result {
                                let _ = win.emit("peri:done", serde_json::json!({
                                    "source": src,
                                    "data": params,
                                }));
                            }
                            if let Some(err) = raw.error {
                                let _ = win.emit("peri:error", serde_json::json!({
                                    "source": src,
                                    "error": err.to_string(),
                                }));
                            }
                            return Ok(());
                        }
                        Err(_) => return Err("ACP connection closed".to_string()),
                    }
                }
                // Streaming notifications from broadcast
                notif = broadcast.recv() => {
                    match notif {
                        Ok(raw) => {
                            if raw.method.as_deref() == Some("session/update") {
                                // Inject source into the params (which already has {sessionId, update})
                                let mut payload = raw.params.unwrap_or(serde_json::Value::Null);
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
            let _ = window.emit("peri:error", serde_json::json!({
                "source": source,
                "error": "Request timed out after 300s",
            }));
            Err("timeout".to_string())
        }
    }
}

#[tauri::command]
async fn set_mode(
    state: tauri::State<'_, AppState>,
    source: String,
    mode: String,
) -> Result<(), String> {
    let peri_id = {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        sessions.get(&source).map(|s| s.peri_id.clone()).ok_or("no session")?
    };
    state.acp.set_mode(&peri_id, &mode).await?;
    Ok(())
}

#[tauri::command]
async fn load_sessions(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    use serde_json::json;
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    Ok(sessions.iter().map(|(source, info)| {
        json!({"source": source, "periId": info.peri_id, "persona": info.persona})
    }).collect())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Outer runtime for async initialization (tauri.run() creates its own runtime internally)
    let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");
    rt.block_on(async {
        let acp = Arc::new(AcpClient::spawn(
            "F:\\A-I\\Agent\\Peri\\target\\release\\peri.exe",
            "G:\\Project\\prism",
            "deepseek-v4-flash",
        ).await.expect("failed to start peri ACP"));

        // tauri.run() blocks until window closes; runtime not dropped until then (no leak)
        tauri::Builder::default()
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_dialog::init())
            .plugin(tauri_plugin_fs::init())
            .manage(AppState {
                acp,
                sessions: Mutex::new(HashMap::new()),
            })
            .invoke_handler(tauri::generate_handler![new_session, send_message, set_mode, load_sessions])
            .setup(|app| {
                app.get_webview_window("main").unwrap().set_title("Prism Desktop").ok();
                Ok(())
            })
            .run(tauri::generate_context!())
            .expect("error while running tauri application");
    });
}
