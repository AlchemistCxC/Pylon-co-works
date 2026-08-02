//! 公共脱敏模块：敏感 key 表 + 值内容检测（regex）+ 递归 sanitize（策略参数化）。
//! R21：合并 export.rs（C1）与 runtime_log.rs（A12/R19）的脱敏实现，语义统一。

use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

pub(crate) const REDACTED: &str = "[REDACTED]";
const MAX_MESSAGE_BYTES: usize = 8 * 1024;

/// runtime_log 语义 key 表：敏感 key 的值整体 REDACTED 替换。
/// O26：token/apikey/api_key 改为精确或后缀匹配（tokensTotal 等共享后缀名不再误伤）；
/// `content` 移出精确表（值内容由 sanitize_value_content 兜底）。
pub(crate) fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "password",
        "secret",
        "authorization",
        "headers",
        "header",
        "prompt",
        "persona",
        "rawinput",
        "rawoutput",
        "attachment",
        "env",
    ]
    .iter()
    .any(|part| key == *part)
        || key.ends_with("token")
        || key.ends_with("apikey")
        || key.ends_with("api_key")
}

/// export 语义 key 表：敏感 key 子树整体剔除（不含 content——markdown 正文结构键）。
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

static SENSITIVE_KEY_PATTERN: OnceLock<Regex> = OnceLock::new();
static BARE_SECRET_PATTERN: OnceLock<Regex> = OnceLock::new();

/// R19：敏感 key + 分隔符（半角/全角冒号等号、引号，允许中间空白）或 `bearer ` 前缀检测。
pub(crate) fn contains_sensitive_pattern(lower: &str) -> bool {
    SENSITIVE_KEY_PATTERN
        .get_or_init(|| {
            Regex::new(
                r#"(?:password|secret|token|api_key|apikey|authorization|client_secret|access_token|x-api-key|prompt|persona)\s*[:=："＝"]|bearer\s+"#,
            )
            .expect("SENSITIVE_KEY_PATTERN must compile")
        })
        .is_match(lower)
}

/// R19：裸 secret 前缀形态（sk-/ghp_/xoxb-/akia/eyj 等）检测。
pub(crate) fn contains_bare_secret(lower: &str) -> bool {
    BARE_SECRET_PATTERN
        .get_or_init(|| {
            Regex::new(r"sk-|ghp_|xoxb-|akia|eyj").expect("BARE_SECRET_PATTERN must compile")
        })
        .is_match(lower)
}

/// 值内容脱敏：值中若出现 secret 形态（分隔符变体/裸 secret 前缀），整体替换。
pub(crate) fn sanitize_value_content(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if contains_sensitive_pattern(&lower) || contains_bare_secret(&lower) {
        REDACTED.to_string()
    } else {
        value.to_string()
    }
}

fn truncate(value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes.saturating_sub(3);
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &value[..end])
}

/// 递归 sanitize 策略。
#[derive(Clone, Copy)]
pub(crate) enum SanitizePolicy {
    /// export：敏感 key 子树剔除，字符串值内容检测（不截断）。
    Strip,
    /// runtime_log：敏感 key 值 REDACTED 替换，字符串值内容检测 + 截断。
    Redact,
}

impl SanitizePolicy {
    fn strips_sensitive_key(self) -> bool {
        matches!(self, SanitizePolicy::Strip)
    }

    fn truncates_strings(self) -> bool {
        matches!(self, SanitizePolicy::Redact)
    }

    /// key 表按策略选择：Strip 用 export 表（content 是正文结构键，不可剔除），
    /// Redact 用 runtime_log 表。
    fn key_is_sensitive(self, key: &str) -> bool {
        match self {
            SanitizePolicy::Strip => is_export_sensitive_key(key),
            SanitizePolicy::Redact => is_sensitive_key(key),
        }
    }
}

/// 递归 sanitize：敏感 key 按策略剔除/REDACTED，非敏感子树递归，字符串值内容检测。
pub(crate) fn sanitize_value(policy: SanitizePolicy, key: &str, value: Value) -> Option<Value> {
    if policy.key_is_sensitive(key) {
        return if policy.strips_sensitive_key() {
            None
        } else {
            Some(Value::String(REDACTED.to_string()))
        };
    }
    match value {
        Value::Object(object) => Some(Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key.clone(), sanitize_value(policy, &key, value)))
                .filter_map(|(key, value)| value.map(|value| (key, value)))
                .collect(),
        )),
        Value::Array(values) => Some(Value::Array(
            values
                .into_iter()
                .filter_map(|value| sanitize_value(policy, "value", value))
                .collect(),
        )),
        Value::String(value) => {
            let value = sanitize_value_content(&value);
            let value = if policy.truncates_strings() {
                truncate(value, MAX_MESSAGE_BYTES)
            } else {
                value
            };
            Some(Value::String(value))
        }
        other => Some(other),
    }
}

/// 消息 sanitize（runtime_log 语义：整体 REDACTED 或截断）。
pub(crate) fn sanitize_message(message: String) -> String {
    let lower = message.to_ascii_lowercase();
    if contains_sensitive_pattern(&lower) || contains_bare_secret(&lower) {
        REDACTED.to_string()
    } else {
        truncate(message, MAX_MESSAGE_BYTES)
    }
}

/// 字段 map sanitize（runtime_log 语义）。
pub(crate) fn sanitize_fields(fields: Map<String, Value>) -> Map<String, Value> {
    fields
        .into_iter()
        .map(|(key, value)| {
            (
                key.clone(),
                sanitize_value(SanitizePolicy::Redact, &key, value),
            )
        })
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect()
}

/// 导出消息 sanitize（export 语义）：敏感 key 剔除 + 值内容检测。
pub(crate) fn sanitize_export_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|value| sanitize_value(SanitizePolicy::Strip, "message", value.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strip_policy_drops_sensitive_keys_and_redacts_string_content() {
        let value = json!({
            "password": "hunter2",
            "detail": "api_key=sk-123",
            "nested": {"safe": "kept"},
            "ok": "fine"
        });
        let sanitized = sanitize_value(SanitizePolicy::Strip, "root", value).unwrap();
        assert!(sanitized.get("password").is_none(), "敏感 key 必须剔除");
        assert_eq!(sanitized["detail"], json!(REDACTED));
        assert_eq!(sanitized["ok"], json!("fine"));
        assert_eq!(sanitized["nested"]["safe"], json!("kept"));
    }

    #[test]
    fn redact_policy_replaces_sensitive_keys_and_truncates_strings() {
        let value = json!({
            "apiKey": "sk-secret",
            "detail": "x".repeat(9000),
            "kept": {"a": "b"}
        });
        let sanitized = sanitize_value(SanitizePolicy::Redact, "root", value).unwrap();
        assert_eq!(sanitized["apiKey"], json!(REDACTED));
        assert_eq!(
            sanitized["detail"],
            json!(format!("{}...", "x".repeat(8189))),
            "非敏感字符串值必须截断"
        );
        assert_eq!(sanitized["kept"]["a"], json!("b"));
    }

    #[test]
    fn export_messages_strip_sensitive_keys_and_redact_value_content() {
        let messages = vec![json!({
            "sessionId": "s",
            "update": {"password": "x", "detail": "Bearer sk-abc", "safe": "kept"}
        })];
        let safe = sanitize_export_messages(&messages);
        let text = serde_json::to_string(&safe).unwrap();
        assert!(!text.contains("password"));
        assert!(text.contains("[REDACTED]"));
        assert!(text.contains("kept"));
    }

    #[test]
    fn redact_policy_never_drops_entries() {
        let value = json!([{"password": "x"}, "Bearer abc", {"a": 1}]);
        let sanitized = sanitize_value(SanitizePolicy::Redact, "root", value).unwrap();
        assert_eq!(sanitized[0]["password"], json!(REDACTED));
        assert_eq!(sanitized[1], json!(REDACTED));
        assert_eq!(sanitized[2]["a"], json!(1));
    }
}
