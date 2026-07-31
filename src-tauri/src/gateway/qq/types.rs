//! QQ 开放平台类型定义（BE-B10-004 起步：OAuth + Gateway URL）。
//!
//! 对应 QQ Bot API v2（https://bot.q.qq.com/wiki/develop/api-v2/）。
//! 事件类型（QqEvent/QqMessageEvent/附件等）随 BE-B10-005 移植补入本文件。
//! 移植自 Prism `src/qq/types.rs`。

use serde::{Deserialize, Serialize};

/// QQ Bot API 基地址
pub const API_BASE: &str = "https://api.sgroup.qq.com";
/// 获取 access token 的端点
pub const TOKEN_URL: &str = "https://bots.qq.com/app/getAppAccessToken";
/// 获取 WebSocket Gateway URL 的路径
pub const GATEWAY_URL_PATH: &str = "/gateway";

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
