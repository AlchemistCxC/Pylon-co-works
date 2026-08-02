//! 会话导出（markdown/json，脱敏管线；R1 拆分自 lib.rs；C1：值内容脱敏 + markdown 注入转义）。

use crate::agent_runtime::session_mapping_matches;
use crate::error::PylonError;
use crate::AppState;

/// O34：lowercase 一次收敛；C1：key 表扩充 password/api_key/apikey/cookie/credential。
pub(crate) fn is_export_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "rawinput"
            | "rawoutput"
            | "prompt"
            | "persona"
            | "headers"
            | "env"
            | "authorization"
            | "password"
            | "api_key"
            | "apikey"
            | "cookie"
            | "credential"
    ) || lower.contains("token")
        || lower.contains("secret")
}

/// C1：非敏感 key 的 String 值做内容检测（复用 A12 的 sanitize_value_content，REDACTED 替换），
/// 因此不再返回 None——filter_map 收敛为 map。
pub(crate) fn sanitize_export_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(object) => serde_json::Value::Object(
            object
                .iter()
                .filter(|(key, _)| !is_export_sensitive_key(key))
                .map(|(key, value)| (key.clone(), sanitize_export_value(value)))
                .collect(),
        ),
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(sanitize_export_value).collect())
        }
        serde_json::Value::String(value) => {
            serde_json::Value::String(crate::runtime_log::sanitize_value_content(value))
        }
        other => other.clone(),
    }
}

pub(crate) fn sanitize_export_messages(messages: &[serde_json::Value]) -> Vec<serde_json::Value> {
    messages.iter().map(sanitize_export_value).collect()
}

/// C1：行内转义（title/status/peri_id 注入面）——换行折叠为空格，`#` 转义。
fn escape_inline(value: &str) -> String {
    value.replace('\n', " ").replace('#', "\\#")
}

/// C1：正文文本转义——以 `#` 开头的行加 `\#` 前缀，防用户文本注入 markdown 标题结构。
fn escape_text_lines(text: &str) -> String {
    text.lines()
        .map(|line| {
            if line.starts_with('#') {
                format!("\\{line}")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn format_export_markdown(peri_id: &str, messages: &[serde_json::Value]) -> String {
    let mut markdown = format!("# Session {}\n\n", escape_inline(peri_id));
    for message in messages {
        let Some(update) = message.get("update") else {
            continue;
        };
        // R4：sessionUpdate 变体经枚举解析（wire 字符串契约不变）。
        let variant = update
            .get("sessionUpdate")
            .and_then(|value| value.as_str())
            .and_then(crate::acp::SessionUpdateVariant::from_str);
        match variant {
            Some(crate::acp::SessionUpdateVariant::UserMessageChunk) => {
                if let Some(text) = update
                    .get("content")
                    .and_then(|content| content.get("text"))
                    .and_then(|value| value.as_str())
                {
                    markdown.push_str("## User\n\n");
                    markdown.push_str(&escape_text_lines(text));
                    markdown.push_str("\n\n");
                }
            }
            Some(crate::acp::SessionUpdateVariant::AgentMessageChunk) => {
                if let Some(text) = update
                    .get("content")
                    .and_then(|content| content.get("text"))
                    .and_then(|value| value.as_str())
                {
                    markdown.push_str("## Assistant\n\n");
                    markdown.push_str(&escape_text_lines(text));
                    markdown.push_str("\n\n");
                }
            }
            Some(crate::acp::SessionUpdateVariant::ToolCall)
            | Some(crate::acp::SessionUpdateVariant::ToolCallUpdate) => {
                let title = update
                    .get("title")
                    .or_else(|| update.get("name"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("Tool");
                markdown.push_str(&format!("## Tool: {}\n\n", escape_inline(title)));
                let status = update
                    .get("status")
                    .and_then(|value| value.as_str())
                    .unwrap_or("unknown");
                markdown.push_str(&format!("### Tool status ({})\n\n", escape_inline(status)));
            }
            _ => {}
        }
    }
    markdown
}

/// 原子写导出文件：临时文件 + rename（已存在拒绝，防覆盖）。
pub(crate) fn write_export_atomically(
    path: &std::path::Path,
    content: &[u8],
) -> Result<(), String> {
    if path.exists() {
        return Err(format!("export output already exists: {}", path.display()));
    }
    let parent = path
        .parent()
        .ok_or_else(|| "export output has no parent directory".to_string())?;
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("export"),
        std::process::id(),
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| format!("create temporary export failed: {error}"))?;
        use std::io::Write;
        file.write_all(content)
            .map_err(|error| format!("write temporary export failed: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("sync temporary export failed: {error}"))?;
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
        return Err(PylonError::Protocol(format!(
            "unsupported export format: {format}"
        )));
    }
    if peri_id.trim().is_empty() {
        return Err(PylonError::Protocol(
            "export requires a non-empty session id".to_string(),
        ));
    }
    if output_path.trim().is_empty() {
        return Err(PylonError::Protocol(
            "export requires a non-empty output path".to_string(),
        ));
    }
    let output = std::path::Path::new(&output_path);
    if output.is_dir() {
        return Err(PylonError::Protocol(format!(
            "export output path is a directory: {}",
            output.display()
        )));
    }
    if let Some(parent) = output.parent() {
        if !parent.is_dir() {
            return Err(PylonError::Protocol(format!(
                "export output directory does not exist: {}",
                parent.display()
            )));
        }
    }
    let runtime = state.inner().require_runtime()?;
    let (source, generation, cwd) = state.export_session_owner(&runtime, &peri_id)?;
    let mcp_servers =
        crate::mcp::validate_and_serialize(Some(state.inner().current_mcp_servers()?))?;
    // O3：锁内仅提取回放句柄，等待在锁外进行——回放最长 30s，不阻塞其他命令。
    let handles = runtime.acp.lock().await.replay_handles();
    let (_, messages) =
        crate::acp::AcpClient::load_session_with_replay(handles, &peri_id, &cwd, mcp_servers)
            .await?;
    state.ensure_generation(&runtime, generation)?;
    let sessions = runtime.sessions.lock().map_err(|error| error.to_string())?;
    if sessions.get(&source).map(|session| {
        session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation)
    }) != Some(true)
    {
        return Err(PylonError::Protocol(
            "export session became stale".to_string(),
        ));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(variant: &str, text: &str) -> serde_json::Value {
        serde_json::json!({
            "sessionId": "peri-1",
            "update": { "sessionUpdate": variant, "content": { "text": text } }
        })
    }

    #[test]
    fn markdown_formats_user_assistant_and_tool() {
        let messages = vec![
            chunk("user_message_chunk", "你好"),
            chunk("agent_message_chunk", "回复文本"),
            serde_json::json!({
                "sessionId": "peri-1",
                "update": { "sessionUpdate": "tool_call", "title": "edit_file" }
            }),
            serde_json::json!({
                "sessionId": "peri-1",
                "update": { "sessionUpdate": "tool_call_update", "title": "edit_file", "status": "completed" }
            }),
        ];
        let md = format_export_markdown("peri-1", &messages);
        assert!(md.starts_with("# Session peri-1"));
        assert!(md.contains("## User\n\n你好"));
        assert!(md.contains("## Assistant\n\n回复文本"));
        assert!(md.contains("## Tool: edit_file"));
        assert!(md.contains("### Tool status (completed)"));
    }

    #[test]
    fn markdown_skips_unknown_and_missing_content() {
        // 未知变体（透传的 agent_thought_chunk 等）不进入 markdown 正文
        let messages = vec![
            chunk("agent_thought_chunk", "思考过程不应导出为正文"),
            serde_json::json!({ "sessionId": "peri-1", "update": { "sessionUpdate": "usage_update", "used": 100 } }),
            serde_json::json!({ "sessionId": "peri-1", "update": {} }),
        ];
        let md = format_export_markdown("peri-1", &messages);
        assert!(!md.contains("思考过程"));
        assert!(!md.contains("usage_update"));
        assert_eq!(
            md.lines().filter(|line| line.starts_with("## ")).count(),
            0,
            "无正文变体不得产生段落"
        );
    }

    #[test]
    fn sanitizer_strips_nested_secrets_recursively() {
        let messages = vec![serde_json::json!({
            "sessionId": "peri-1",
            "update": {
                "sessionUpdate": "tool_call",
                "title": "edit_file",
                "rawInput": "{\"path\":\"/tmp/x\",\"token\":\"sk-secret\"}",
                "headers": { "authorization": "Bearer abc" },
                "safe": { "nested": "kept", "apiKeyToken": "drop-me" }
            }
        })];
        let safe = sanitize_export_messages(&messages);
        let text = serde_json::to_string(&safe).unwrap();
        assert!(!text.contains("sk-secret"));
        assert!(!text.contains("Bearer"));
        assert!(!text.contains("drop-me"));
        assert!(text.contains("kept"));
    }

    #[test]
    fn sanitizer_strips_password_api_key_cookie_and_credential() {
        let messages = vec![serde_json::json!({
            "sessionId": "peri-1",
            "update": {
                "sessionUpdate": "tool_call",
                "password": "hunter2",
                "api_key": "sk-abcdef",
                "apiKey": "key-2",
                "cookie": "session=abc",
                "credential": "user:pass",
                "safe": "kept"
            }
        })];
        let safe = sanitize_export_messages(&messages);
        let text = serde_json::to_string(&safe).unwrap();
        for needle in ["hunter2", "sk-abcdef", "key-2", "session=abc", "user:pass"] {
            assert!(!text.contains(needle), "{needle} 必须被剔除");
        }
        assert!(text.contains("kept"));
    }

    #[test]
    fn sanitizer_redacts_secret_shapes_inside_non_sensitive_values() {
        let messages = vec![serde_json::json!({
            "sessionId": "peri-1",
            "update": { "detail": "Bearer sk-abc", "path": "safe" }
        })];
        let safe = sanitize_export_messages(&messages);
        assert_eq!(safe[0]["update"]["detail"], "[REDACTED]");
        assert_eq!(safe[0]["update"]["path"], "safe");
    }

    #[test]
    fn markdown_escapes_heading_injection_in_text() {
        let messages = vec![chunk("user_message_chunk", "# 伪造标题\n正文第二行")];
        let md = format_export_markdown("peri-1", &messages);
        assert!(md.contains("## User\n\n\\# 伪造标题\n正文第二行"), "{md}");
        assert_eq!(
            md.lines().filter(|line| line.starts_with("## ")).count(),
            1,
            "注入行不得产生额外标题段"
        );
    }

    #[test]
    fn markdown_escapes_inline_title_status_and_session_id() {
        let messages = vec![serde_json::json!({
            "sessionId": "peri-1",
            "update": { "sessionUpdate": "tool_call", "title": "edit\n#file", "status": "done\n#ok" }
        })];
        let md = format_export_markdown("peri\n#1", &messages);
        assert!(md.starts_with("# Session peri \\#1"), "{md}");
        assert!(md.contains("## Tool: edit \\#file"), "{md}");
        assert!(md.contains("### Tool status (done \\#ok)"), "{md}");
    }

    #[test]
    fn json_export_is_pretty_printed() {
        let messages = vec![chunk("agent_message_chunk", "x")];
        let content = serde_json::to_string_pretty(&sanitize_export_messages(&messages)).unwrap();
        assert!(content.contains('\n'), "pretty JSON 必须换行");
    }
}
