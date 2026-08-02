//! QQ 开放平台类型定义（BE-B10-004 起步：OAuth + Gateway URL；BE-B10-005 补事件类型）。
//!
//! 对应 QQ Bot API v2（https://bot.q.qq.com/wiki/develop/api-v2/）。
//! 移植自 Prism `src/qq/types.rs`。
//! 已接线（B10.2）：WS/事件类型由 ws.rs 与适配器消费。

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

// ── Hello ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct HelloData {
    pub heartbeat_interval: u32, // 毫秒
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
    /// 待 B10.3 会话超时/重置策略消费。O66：平台形态多变（数字/字符串/缺失），
    /// 放宽为 Value——结构微调不再导致整条消息反序列化失败被丢弃。
    #[serde(default)]
    #[allow(dead_code)]
    pub timestamp: Option<serde_json::Value>,
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
    /// 待 B10.3 引用消息处理（message_type=103）消费。O66：平台可能下发
    /// 字符串/未知数值，放宽为 Value 防止整条消息被丢弃。
    #[serde(default)]
    #[allow(dead_code)]
    pub message_type: Option<serde_json::Value>,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_event_tolerates_variant_platform_field_shapes() {
        // O66：message_type/timestamp 平台形态多变（数字/字符串/缺失）——
        // 放宽为 Value 后结构微调不再导致整条消息解析失败被丢弃。
        let msg: QqMessageEvent = serde_json::from_value(serde_json::json!({
            "id": "m1",
            "content": "hi",
            "message_type": 103,
            "timestamp": 1722500000,
            "attachments": []
        }))
        .expect("数字 message_type/timestamp 必须解析");
        assert_eq!(msg.id.as_deref(), Some("m1"));
        assert_eq!(msg.message_type, Some(serde_json::json!(103)));

        let msg: QqMessageEvent = serde_json::from_value(serde_json::json!({
            "id": "m2",
            "content": "hi",
            "message_type": "103",
            "timestamp": "1722500000"
        }))
        .expect("字符串 message_type/timestamp 必须解析");
        assert_eq!(msg.message_type, Some(serde_json::json!("103")));

        // 高变异字段整体缺失也容忍（原 Option 语义保留）。
        let msg: QqMessageEvent =
            serde_json::from_value(serde_json::json!({"id": "m3", "content": "hi"}))
                .expect("稀疏事件必须解析");
        assert!(msg.timestamp.is_none());
        assert!(msg.message_type.is_none());
    }
}
