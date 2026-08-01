//! 会话导出（markdown/json，脱敏管线；R1 拆分自 lib.rs；行为零变化）。

use crate::agent_runtime::session_mapping_matches;
use crate::error::PylonError;
use crate::AppState;

pub(crate) fn is_export_sensitive_key(key: &str) -> bool {
    matches!(key.to_ascii_lowercase().as_str(), "rawinput" | "rawoutput" | "prompt" | "persona" | "headers" | "env" | "authorization")
        || key.to_ascii_lowercase().contains("token")
        || key.to_ascii_lowercase().contains("secret")
}

pub(crate) fn sanitize_export_value(value: &serde_json::Value) -> Option<serde_json::Value> {
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

pub(crate) fn sanitize_export_messages(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    messages.iter().filter_map(sanitize_export_value).collect()
}

pub(crate) fn format_export_markdown(peri_id: &str, messages: &[serde_json::Value]) -> String {
    let mut markdown = format!("# Session {peri_id}\n\n");
    for message in messages {
        let Some(update) = message.get("update") else { continue };
        // R4：sessionUpdate 变体经枚举解析（wire 字符串契约不变）。
        let variant = update.get("sessionUpdate")
            .and_then(|value| value.as_str())
            .and_then(crate::acp::SessionUpdateVariant::from_str);
        match variant {
            Some(crate::acp::SessionUpdateVariant::UserMessageChunk) => {
                if let Some(text) = update.get("content").and_then(|content| content.get("text")).and_then(|value| value.as_str()) {
                    markdown.push_str("## User\n\n");
                    markdown.push_str(text);
                    markdown.push_str("\n\n");
                }
            }
            Some(crate::acp::SessionUpdateVariant::AgentMessageChunk) => {
                if let Some(text) = update.get("content").and_then(|content| content.get("text")).and_then(|value| value.as_str()) {
                    markdown.push_str("## Assistant\n\n");
                    markdown.push_str(text);
                    markdown.push_str("\n\n");
                }
            }
            Some(crate::acp::SessionUpdateVariant::ToolCall)
            | Some(crate::acp::SessionUpdateVariant::ToolCallUpdate) => {
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

/// 原子写导出文件：临时文件 + rename（已存在拒绝，防覆盖）。
pub(crate) fn write_export_atomically(path: &std::path::Path, content: &[u8]) -> Result<(), String> {
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
pub(crate) async fn export_session(
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
    let mcp_servers = crate::mcp::validate_and_serialize(Some(state.inner().current_mcp_servers()?))?;
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
