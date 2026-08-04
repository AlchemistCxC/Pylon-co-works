//! ACP 协议层：wire 请求构造器 + 响应解析（R13/P3-4 拆分自 acp.rs；行为零变化）。
//!
//! 核心字段（sessionId/cwd/configId/value/modeId/prompt）用官方
//! agent-client-protocol-schema v1 Request 类型构造，wire 格式由 schema 保证；
//! 扩展字段（mcpServers）保持 Value 直传——Pylon 的 MCP 配置格式（stdio 无
//! name）与官方 McpServer 不兼容，不能强转。

use base64::Engine;
use std::io::Read;

use agent_client_protocol_schema::v1::{
    CloseSessionRequest, ContentBlock, LoadSessionRequest, NewSessionRequest, PromptRequest,
    SetSessionConfigOptionRequest, SetSessionModeRequest,
};

use crate::agent_config::McpServersMode;
use super::AcpError;

/// session/update 变体（wire 字符串 → 枚举；dispatcher/export 分支依据）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionUpdateVariant {
    AgentMessageChunk,
    UserMessageChunk,
    UsageUpdate,
    ToolCall,
    ToolCallUpdate,
    SessionInfoUpdate,
    ConfigOptionUpdate,
}

impl SessionUpdateVariant {
    /// wire 字符串 → 变体；未知变体返回 None（调用方按忽略处理，与旧 `_ => {}` 一致）。
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "agent_message_chunk" => Some(Self::AgentMessageChunk),
            "user_message_chunk" => Some(Self::UserMessageChunk),
            "usage_update" => Some(Self::UsageUpdate),
            "tool_call" => Some(Self::ToolCall),
            "tool_call_update" => Some(Self::ToolCallUpdate),
            "session_info_update" => Some(Self::SessionInfoUpdate),
            "config_option_update" => Some(Self::ConfigOptionUpdate),
            _ => None,
        }
    }
}

fn to_params<T: serde::Serialize>(req: &T, what: &str) -> Result<serde_json::Value, String> {
    serde_json::to_value(req).map_err(|e| format!("serialize {what} params: {e}"))
}

fn content_blocks_from_values(values: Vec<serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    values
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(|e| format!("invalid prompt block: {e}")))
        .collect()
}

/// session/new 参数（G1-07a mode 参数化）：Always = 恒发 mcpServers 字段
/// （现状 wire）；OmitIfEmpty = 空数组时省略字段（v2 语义，07 文档 §8.2）。
/// E4 警告：OmitIfEmpty 与 agent 能力匹配——声明 omit_if_empty 且无配置时省字段，
/// Hermes（Pydantic 必填）会拒绝 session/new；配置与 agent 能力匹配是用户责任。
/// 调用方经 `agent.protocol().mcp_servers` 传 mode（session.rs 统一接线）。
pub fn session_new_params(
    cwd: &str,
    mcp_servers: Vec<serde_json::Value>,
    mode: McpServersMode,
) -> Result<serde_json::Value, String> {
    let req = NewSessionRequest::new(cwd.to_string());
    let mut params = to_params(&req, "session/new")?;
    if let Some(obj) = params.as_object_mut() {
        match mode {
            McpServersMode::Always => {
                obj.insert("mcpServers".into(), serde_json::Value::Array(mcp_servers));
            }
            McpServersMode::OmitIfEmpty => {
                // schema 类型恒序列化 mcpServers（v1 必填无 skip）——省略需显式删键
                if mcp_servers.is_empty() {
                    obj.remove("mcpServers");
                } else {
                    obj.insert("mcpServers".into(), serde_json::Value::Array(mcp_servers));
                }
            }
        }
    }
    Ok(params)
}

/// session/set_mode 参数。
pub fn session_set_mode_params(session_id: &str, mode: &str) -> Result<serde_json::Value, String> {
    let req = SetSessionModeRequest::new(session_id.to_string(), mode.to_string());
    to_params(&req, "session/set_mode")
}

/// session/set_config_option 参数（ValueId 平铺：{"configId","value"}）。
pub fn session_set_config_option_params(
    session_id: &str,
    key: &str,
    value: &str,
) -> Result<serde_json::Value, String> {
    let req = SetSessionConfigOptionRequest::new(
        session_id.to_string(),
        key.to_string(),
        value, // &str → SessionConfigOptionValue via From<&str>（ValueId）
    );
    to_params(&req, "session/set_config_option")
}

/// session/prompt 参数。仅被 `AcpClient::prepare_prompt` 内部使用。
pub(crate) fn session_prompt_params(
    session_id: &str,
    prompt: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let req = PromptRequest::new(session_id.to_string(), content_blocks_from_values(prompt)?);
    to_params(&req, "session/prompt")
}

/// session/close 参数。
pub fn session_close_params(session_id: &str) -> Result<serde_json::Value, String> {
    let req = CloseSessionRequest::new(session_id.to_string());
    to_params(&req, "session/close")
}

/// session/set_model 参数（Hermes unstable 扩展，字段与官方 SetSessionModelRequest 一致）。
pub fn session_set_model_params(
    session_id: &str,
    model_id: &str,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "sessionId": session_id,
        "modelId": model_id,
    }))
}

/// Extract and validate sessionId from a session/new response.
pub(crate) fn session_id_from(response: &serde_json::Value) -> Result<String, AcpError> {
    let session_id = response
        .get("sessionId")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AcpError::Child(format!("invalid session/new response: {response}")))?
        .trim();
    if session_id.is_empty() || session_id.eq_ignore_ascii_case("error") {
        return Err(AcpError::Child(format!(
            "session/new failed: invalid sessionId {session_id:?}"
        )));
    }
    Ok(session_id.to_string())
}

/// Validate a session/prompt response and return its stop reason.
pub(crate) fn prompt_stop_reason(response: &serde_json::Value) -> Result<&str, AcpError> {
    let stop_reason = response
        .get("stopReason")
        .and_then(|value| value.as_str())
        .ok_or_else(|| AcpError::Child(format!("invalid session/prompt response: {response}")))?
        .trim();
    match stop_reason {
        "end_turn" | "max_turn_requests" => Ok(stop_reason),
        "cancelled" => Err(AcpError::Child("prompt cancelled".to_string())),
        "refusal" => Err(AcpError::Child("prompt refused by agent".to_string())),
        other => Err(AcpError::Child(format!(
            "unsupported prompt stopReason: {other}"
        ))),
    }
}

/// Build prompt blocks (text + attachments) for session/prompt.
/// G1-04：附件限制来自 AttachmentLimits（缺省 = 现状 8 / 10MB，wire 文案不变）。
pub(crate) fn prompt_blocks(
    text: String,
    attachments: &[String],
    limits: crate::agent_config::AttachmentLimits,
) -> Result<Vec<serde_json::Value>, String> {
    if attachments.len() > limits.max_attachments {
        return Err(format!(
            "too many attachments: maximum is {}",
            limits.max_attachments
        ));
    }
    let mut blocks = vec![serde_json::json!({"type": "text", "text": text})];
    for raw_path in attachments {
        let path = std::path::Path::new(raw_path);
        let metadata = std::fs::metadata(path).map_err(|error| {
            format!("attachment metadata failed for {}: {error}", path.display())
        })?;
        if !metadata.is_file() {
            return Err(format!("attachment is not a file: {}", path.display()));
        }
        if metadata.len() > limits.max_attachment_bytes {
            return Err(format!(
                "attachment too large: {} is {} bytes, maximum is {} bytes",
                path.display(),
                metadata.len(),
                limits.max_attachment_bytes
            ));
        }
        // A9：metadata 校验后不能直接 std::fs::read 无上限读取——校验与读取间
        // 文件可被替换/增长（TOCTOU），超大文件导致 OOM。改为上限读取
        // （MAX + 1 字节探测超限），读后再校验一次。
        let file = std::fs::File::open(path).map_err(|error| {
            format!("attachment read failed for {}: {error}", path.display())
        })?;
        let mut bytes = Vec::new();
        file.take(limits.max_attachment_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("attachment read failed for {}: {error}", path.display()))?;
        if bytes.len() as u64 > limits.max_attachment_bytes {
            return Err(format!(
                "attachment too large: {} is {} bytes, maximum is {} bytes",
                path.display(),
                bytes.len(),
                limits.max_attachment_bytes
            ));
        }
        let mime = infer::get(&bytes).map(|kind| kind.mime_type());
        match mime {
            Some(mime)
                if matches!(
                    mime,
                    "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                ) =>
            {
                blocks.push(serde_json::json!({
                    "type": "image",
                    "mimeType": mime,
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                }));
            }
            Some(mime) if mime.starts_with("text/") => {
                let content = String::from_utf8(bytes).map_err(|error| {
                    format!(
                        "attachment is not valid UTF-8 text {}: {error}",
                        path.display()
                    )
                })?;
                blocks.push(serde_json::json!({"type": "text", "text": content}));
            }
            None => {
                let content = String::from_utf8(bytes)
                    .map_err(|_| format!("unsupported attachment type: {}", path.display()))?;
                blocks.push(serde_json::json!({"type": "text", "text": content}));
            }
            Some(mime) => {
                return Err(format!(
                    "unsupported attachment MIME {mime}: {}",
                    path.display()
                ));
            }
        }
    }
    Ok(blocks)
}

/// session/load 参数（G1-07a mode 参数化，语义同 session/new）。schema 的
/// mcpServers 字段必须存在；Peri 的 DefaultOnError 容忍缺失/空。无配置时传空
/// 数组而非缺字段。E4 警告：OmitIfEmpty 与 agent 能力匹配（同 session/new）。
pub(crate) fn load_params(
    session_id: &str,
    cwd: &str,
    mcp_servers: Vec<serde_json::Value>,
    mode: McpServersMode,
) -> Result<serde_json::Value, String> {
    let req = LoadSessionRequest::new(session_id.to_string(), cwd.to_string());
    let mut params = to_params(&req, "session/load")?;
    if let Some(obj) = params.as_object_mut() {
        match mode {
            McpServersMode::Always => {
                obj.insert("mcpServers".into(), serde_json::Value::Array(mcp_servers));
            }
            McpServersMode::OmitIfEmpty => {
                // schema 类型恒序列化 mcpServers（v1 必填无 skip）——省略需显式删键
                if mcp_servers.is_empty() {
                    obj.remove("mcpServers");
                } else {
                    obj.insert("mcpServers".into(), serde_json::Value::Array(mcp_servers));
                }
            }
        }
    }
    Ok(params)
}
