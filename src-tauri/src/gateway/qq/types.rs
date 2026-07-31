//! QQ 开放平台类型定义（BE-B10-004 起步：OAuth + Gateway URL；BE-B10-005 补事件类型）。
//!
//! 对应 QQ Bot API v2（https://bot.q.qq.com/wiki/develop/api-v2/）。
//! 移植自 Prism `src/qq/types.rs`。
//! 已接线（B10.2）：WS/事件类型由 ws.rs 与适配器消费；Identify/Resume/
//! Ready/InboundEvent 等预留类型仍标 allow（B10.3 会话生命周期用）。

use serde::{Deserialize, Serialize};

/// QQ Bot API 基地址
pub const API_BASE: &str = "https://api.sgroup.qq.com";
/// 获取 access token 的端点
pub const TOKEN_URL: &str = "https://bots.qq.com/app/getAppAccessToken";
/// 获取 WebSocket Gateway URL 的路径
pub const GATEWAY_URL_PATH: &str = "/gateway";

/// op 2 Identify 所需的 intents
/// (1<<25)=GROUP_AT_MESSAGES | (1<<30)=PUBLIC_GUILD_MESSAGES | (1<<12)=DIRECT_MESSAGE | (1<<26)=INTERACTION
pub const DEFAULT_INTENTS: u32 = (1 << 25) | (1 << 30) | (1 << 12) | (1 << 26);

/// 消息类型: 纯文本
pub const MSG_TYPE_TEXT: u32 = 0;
/// 消息类型: Markdown
pub const MSG_TYPE_MARKDOWN: u32 = 2;

/// OAuth2 换取 access token 的请求体（wire 用 appId/clientSecret camelCase）。
#[derive(Debug, Serialize)]
pub struct TokenRequest {
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "clientSecret")]
    pub client_secret: String,
}

/// OAuth2 换取 access token 的响应（expires_in 可能缺失或为字符串）。
#[derive(Debug, Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    #[serde(default, deserialize_with = "deserialize_expires_in")]
    pub expires_in: Option<i64>,
}

fn deserialize_expires_in<'de, D>(d: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let v: serde_json::Value = serde::Deserialize::deserialize(d)?;
    match v {
        serde_json::Value::Number(n) => Ok(n.as_i64()),
        serde_json::Value::String(s) => Ok(s.parse().ok()),
        serde_json::Value::Null => Ok(None),
        _ => Ok(None),
    }
}

/// GET /gateway 响应（WS 连接地址）。
#[derive(Debug, Deserialize)]
pub struct GatewayResponse {
    pub url: String,
}

// ── WebSocket 事件 ──────────────────────────────────────────

/// QQ Gateway 推送的原始事件帧
#[derive(Debug, Deserialize)]
pub struct QqEvent {
    /// 操作码: 0=Dispatch, 10=Hello, 11=HeartbeatACK
    pub op: u32,
    /// 事件类型: "GROUP_AT_MESSAGE_CREATE" 等
    #[serde(default)]
    pub t: Option<String>,
    /// 序列号，用于 Resume 和 heartbeat
    #[serde(default)]
    pub s: Option<u64>,
    /// 事件载荷
    #[serde(default)]
    pub d: Option<serde_json::Value>,
}

// ── Identify / Resume ───────────────────────────────────────

#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct IdentifyPayload {
    pub op: u32, // 2
    pub d: IdentifyData,
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct IdentifyData {
    pub token: String,
    pub intents: u32,
    pub shard: [u32; 2],
    pub properties: serde_json::Value,
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct ResumePayload {
    pub op: u32, // 6
    pub d: ResumeData,
}

#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct ResumeData {
    pub token: String,
    pub session_id: String,
    pub seq: u64,
}

// ── Hello ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct HelloData {
    pub heartbeat_interval: u32, // 毫秒
}

// ── Ready ────────────────────────────────────────────────────

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct ReadyData {
    pub session_id: Option<String>,
}

// ── 消息事件 ─────────────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
pub struct QqAuthor {
    #[serde(default)]
    pub user_openid: Option<String>,
    /// 待 B10.3 群级白名单双控（member_openid 成员级）。
    #[serde(default)]
    #[allow(dead_code)]
    pub member_openid: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub id: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct QqMessageEvent {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    /// 待 B10.3 会话超时/重置策略消费。
    #[serde(default)]
    #[allow(dead_code)]
    pub timestamp: Option<String>,
    #[serde(default)]
    pub author: Option<QqAuthor>,
    #[serde(default)]
    pub group_openid: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub channel_id: Option<String>,
    #[serde(default)]
    #[allow(dead_code)]
    pub guild_id: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<QqAttachment>>,
    /// 待 B10.3 引用消息处理（message_type=103）消费。
    #[serde(default)]
    #[allow(dead_code)]
    pub message_type: Option<u32>,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct QqAttachment {
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
    #[serde(default)]
    pub file_type: Option<u32>,
}

// ── Shim 回调事件 ──────────────────────────────────────────

/// 适配器解析 QQ 事件后的干净消息格式。
/// Prism 原为转发给 Python shim 的格式；Pylon 以 ws.rs 的 Dispatch 结构
/// 取代其角色，本类型作为持久化/调试格式预留。
#[allow(dead_code)]
#[derive(Debug, Serialize)]
pub struct InboundEvent {
    /// 事件类型: GROUP_AT_MESSAGE_CREATE / C2C_MESSAGE_CREATE 等
    #[serde(rename = "type")]
    pub event_type: String,
    /// 消息 ID
    pub id: String,
    /// 消息内容（已去掉 @bot 前缀）
    pub content: String,
    /// 时间戳
    pub timestamp: String,
    /// 群 ID（群消息时有值）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_openid: Option<String>,
    /// 用户 ID（C2C 时有值）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_openid: Option<String>,
    /// 群内发件人 ID（群消息时有值）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_openid: Option<String>,
    /// 附件列表
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<QqAttachment>>,
}
