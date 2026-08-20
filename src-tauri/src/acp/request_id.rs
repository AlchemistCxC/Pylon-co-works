//! JSON-RPC 请求 id 的原始形态（ACP-01：RequestId 类型化，方案书 §5.4）。
//!
//! Pylon 自己生成的 outbound request id 恒为 `u64`（见 [`super::PreparedRpc`]），
//! 但 agent inbound 请求（如 `session/request_permission`）的 id 必须支持 string——
//! Hermes/Peri 均可发送 string id。响应必须用**原始 variant** 回写：
//! `Number(7)` → `"id": 7`，`String("perm-1")` → `"id": "perm-1"`。
//!
//! `null` 与 absent 不静默当 0：由 `Option<RequestId>` 表达（`from_json_value` 对
//! null/absent/布尔/浮点返回 None，调用方按协议判定，绝不臆造 `Number(0)`）。
//! 禁止用 `String(requestId)` 作为唯一内部类型后再猜数字——kind 必须保留。

use std::fmt;

/// JSON-RPC 请求 id 的原始形态（数字或字符串）。
///
/// `#[serde(untagged)]`：序列化时 `Number(n)` → JSON number、`String(s)` → JSON string，
/// 天然满足"响应用原始 variant 回写"。
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    String(String),
}

impl RequestId {
    /// 从 wire JSON value 原样解析（保留 variant）；null/absent/布尔/浮点 → None。
    /// stdout reader 用它替换 `as_u64()` 窄化——string/null/absent 形态不再丢失。
    pub fn from_json_value(value: &serde_json::Value) -> Option<RequestId> {
        match value {
            serde_json::Value::Number(n) => n.as_u64().map(RequestId::Number),
            serde_json::Value::String(s) => Some(RequestId::String(s.clone())),
            _ => None,
        }
    }

    /// 从前端回显字符串还原候选 id（ACP-01）：数字形态 → `Number`（命中原 numeric
    /// 请求），否则 `String`。不把 string 强转 number、不把 null/空串当 0——
    /// 最终 variant 由 pending 命中决定（见 `permission::canonical_pending_key`）。
    pub fn from_echo_string(value: &str) -> RequestId {
        match value.parse::<u64>() {
            Ok(n) => RequestId::Number(n),
            Err(_) => RequestId::String(value.to_string()),
        }
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequestId::Number(n) => write!(f, "{n}"),
            RequestId::String(s) => write!(f, "{s}"),
        }
    }
}
