//! 结构化运行时日志：固定容量、查询过滤、截断和敏感字段脱敏。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::time::Timestamp;

pub const DEFAULT_CAPACITY: usize = 2000;
const MAX_MESSAGE_BYTES: usize = 8 * 1024;
#[cfg(test)]
const REDACTED: &str = "[REDACTED]";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLogEntry {
    pub id: u64,
    /// R4：Timestamp 序列化为字符串（wire 契约 `"1722500000000"` 不变）。
    pub timestamp: Timestamp,
    pub level: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub message: String,
    #[serde(default)]
    pub fields: Map<String, Value>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLogQuery {
    pub level: Option<String>,
    pub source: Option<String>,
    pub session: Option<String>,
    pub search: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug)]
pub struct RuntimeLogHub {
    next_id: AtomicU64,
    entries: Mutex<VecDeque<RuntimeLogEntry>>,
    capacity: usize,
    events: tokio::sync::broadcast::Sender<RuntimeLogEntry>,
}

impl RuntimeLogHub {
    pub fn new(capacity: usize) -> Arc<Self> {
        let (events, _) = tokio::sync::broadcast::channel(256);
        Arc::new(Self {
            next_id: AtomicU64::new(1),
            entries: Mutex::new(VecDeque::with_capacity(capacity.min(DEFAULT_CAPACITY))),
            capacity: capacity.max(1),
            events,
        })
    }

    pub fn default() -> Arc<Self> {
        Self::new(DEFAULT_CAPACITY)
    }

    pub fn push(
        &self,
        timestamp: Timestamp,
        level: impl Into<String>,
        source: impl Into<String>,
        session: Option<String>,
        message: impl Into<String>,
        fields: Map<String, Value>,
    ) -> RuntimeLogEntry {
        let entry = RuntimeLogEntry {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            timestamp,
            level: normalize_level(level.into()),
            source: truncate(source.into(), MAX_MESSAGE_BYTES),
            session: session.map(|value| truncate(value, MAX_MESSAGE_BYTES)),
            message: sanitize_message(message.into()),
            fields: sanitize_fields(fields),
        };
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.push_back(entry.clone());
        while entries.len() > self.capacity {
            entries.pop_front();
        }
        let _ = self.events.send(entry.clone());
        entry
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<RuntimeLogEntry> {
        self.events.subscribe()
    }

    pub fn list(&self, query: &RuntimeLogQuery) -> Vec<RuntimeLogEntry> {
        let search = query.search.as_deref().map(str::to_lowercase);
        let limit = query.limit.unwrap_or(self.capacity).min(self.capacity);
        let entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        entries
            .iter()
            .rev()
            .filter(|entry| {
                query
                    .level
                    .as_deref()
                    .is_none_or(|value| entry.level == value)
            })
            .filter(|entry| {
                query
                    .source
                    .as_deref()
                    .is_none_or(|value| entry.source == value)
            })
            .filter(|entry| {
                query
                    .session
                    .as_deref()
                    .is_none_or(|value| entry.session.as_deref() == Some(value))
            })
            .filter(|entry| {
                search.as_deref().is_none_or(|needle| {
                    // P3：needle 已小写一次（上方）；字段按 键/值 迭代检查，
                    // 不再 clone 整个 map 再整体序列化。字符串值免 JSON 再序列化，
                    // 非字符串值才 to_string（保持与原"序列化整 map"的匹配面一致）。
                    entry.message.to_lowercase().contains(needle)
                        || entry.fields.iter().any(|(key, value)| {
                            key.to_lowercase().contains(needle)
                                || match value {
                                    Value::String(text) => text.to_lowercase().contains(needle),
                                    other => other.to_string().to_lowercase().contains(needle),
                                }
                        })
                })
            })
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn clear(&self) {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

fn normalize_level(level: String) -> String {
    match level.to_ascii_lowercase().as_str() {
        "trace" | "debug" | "info" | "warn" | "error" => level.to_ascii_lowercase(),
        _ => "info".to_string(),
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

/// R21：脱敏实现统一到 crate::sanitize（策略参数化：runtime_log 走 Redact）。
/// 此处仅保留 push/acp/permission 与测试所需的薄包装，hub 区（43-150）零改动。
pub(crate) fn sanitize_message(message: String) -> String {
    crate::sanitize::sanitize_message(message)
}

fn sanitize_fields(fields: Map<String, Value>) -> Map<String, Value> {
    crate::sanitize::sanitize_fields(fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(values: &[(&str, Value)]) -> Map<String, Value> {
        values
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone()))
            .collect()
    }

    #[test]
    fn ring_buffer_keeps_latest_entries_and_monotonic_ids() {
        let hub = RuntimeLogHub::new(2);
        hub.push(Timestamp::new(1), "info", "a", None, "one", Map::new());
        hub.push(Timestamp::new(2), "info", "a", None, "two", Map::new());
        hub.push(Timestamp::new(3), "info", "a", None, "three", Map::new());
        let entries = hub.list(&RuntimeLogQuery::default());
        assert_eq!(
            entries.iter().map(|entry| entry.id).collect::<Vec<_>>(),
            vec![3, 2]
        );
        assert_eq!(entries[0].message, "three");
    }

    #[test]
    fn filters_by_level_source_session_and_search() {
        let hub = RuntimeLogHub::default();
        hub.push(
            Timestamp::new(1),
            "error",
            "acp",
            Some("a".into()),
            "Parse failed",
            Map::new(),
        );
        hub.push(
            Timestamp::new(2),
            "info",
            "ui",
            Some("b".into()),
            "Clicked",
            Map::new(),
        );
        let query = RuntimeLogQuery {
            level: Some("error".into()),
            source: Some("acp".into()),
            session: Some("a".into()),
            search: Some("parse".into()),
            limit: Some(10),
        };
        assert_eq!(hub.list(&query).len(), 1);
    }

    #[test]
    fn redacts_sensitive_fields_and_truncates_message() {
        let hub = RuntimeLogHub::default();
        let entry = hub.push(
            Timestamp::new(1),
            "warn",
            "acp",
            None,
            "x".repeat(9000),
            fields(&[
                ("apiKey", json!("secret-value")),
                (
                    "nested",
                    json!({"authorization": "Bearer abc", "result": "safe"}),
                ),
            ]),
        );
        assert!(entry.message.len() <= MAX_MESSAGE_BYTES);
        assert_eq!(entry.fields["apiKey"], json!(REDACTED));
        assert_eq!(entry.fields["nested"]["authorization"], json!(REDACTED));
        assert_eq!(entry.fields["nested"]["result"], json!("safe"));
    }

    #[test]
    fn keeps_safe_diagnostic_words_in_message() {
        let hub = RuntimeLogHub::default();
        let entry = hub.push(
            Timestamp::new(1),
            "info",
            "runtime",
            None,
            "Prompt started; contentLength=42",
            Map::new(),
        );
        assert_eq!(entry.message, "Prompt started; contentLength=42");
    }

    #[test]
    fn redacts_sensitive_message_payload_markers() {
        let hub = RuntimeLogHub::default();
        for message in ["token=abc", "authorization: Bearer abc", "persona: hidden"] {
            let entry = hub.push(
                Timestamp::new(1),
                "error",
                "runtime",
                None,
                message,
                Map::new(),
            );
            assert_eq!(entry.message, REDACTED);
        }
    }

    #[test]
    fn redacts_bearer_and_json_token_shapes() {
        // 审查修复回归：无前缀 Bearer / JSON token 形态也必须脱敏
        let hub = RuntimeLogHub::default();
        for message in [
            "Bearer sk-abc123",
            "x-api-key: 12345",
            r#"{"token":"sk-abc"}"#,
            r#"{"data":{"apiKey":"sk-abc"}}"#,
            "client_secret=abc",
            "access_token=abc",
        ] {
            let entry = hub.push(
                Timestamp::new(1),
                "error",
                "runtime",
                None,
                message,
                Map::new(),
            );
            assert_eq!(entry.message, REDACTED, "message {message:?} 必须脱敏");
        }
    }

    #[test]
    fn redacts_delimiter_variants_and_bare_secrets() {
        // A12 回归：分隔符变体（含全角、含空白）与裸 secret 前缀形态必须脱敏
        let hub = RuntimeLogHub::default();
        for message in [
            "token: abc",
            "token = abc",
            "token：abc",
            "token ＝ abc",
            "sk-abc123",
            "ghp_abcdef",
            r#"{"data":"sk-abc"}"#,
            "x-api-key: 12345",
        ] {
            let entry = hub.push(
                Timestamp::new(1),
                "error",
                "runtime",
                None,
                message,
                Map::new(),
            );
            assert_eq!(entry.message, REDACTED, "message {message:?} 必须脱敏");
        }
        let safe = hub.push(
            Timestamp::new(2),
            "info",
            "runtime",
            None,
            "tokensTotal=42; prompt started",
            Map::new(),
        );
        assert_eq!(safe.message, "tokensTotal=42; prompt started");
    }

    #[test]
    fn value_content_redacts_variants_and_bare_secrets() {
        // A12 回归：值内容脱敏与消息脱敏共用检测，`token：`/裸 eyj 前缀等均覆盖
        // R21：实现已统一到 crate::sanitize，测试直接调用公共模块。
        assert_eq!(
            crate::sanitize::sanitize_value_content("token：abc"),
            REDACTED
        );
        assert_eq!(
            crate::sanitize::sanitize_value_content("token = abc"),
            REDACTED
        );
        assert_eq!(
            crate::sanitize::sanitize_value_content(r#"{"data":"sk-abc"}"#),
            REDACTED
        );
        assert_eq!(
            crate::sanitize::sanitize_value_content("eyJhbGciOiJIUzI1NiJ9"),
            REDACTED
        );
        assert_eq!(
            crate::sanitize::sanitize_value_content("tokenCount=5"),
            "tokenCount=5"
        );
        assert_eq!(
            crate::sanitize::sanitize_value_content("contentLength=42"),
            "contentLength=42"
        );
    }

    #[test]
    fn redacts_sensitive_content_inside_field_values() {
        // 审查修复回归：非敏感 key 下的敏感值内容也必须脱敏
        let hub = RuntimeLogHub::default();
        let entry = hub.push(
            Timestamp::new(1),
            "warn",
            "acp",
            None,
            "safe message",
            fields(&[
                ("detail", json!("api_key=sk-123")),
                ("items", json!(["Bearer secret-token", "safe"])),
                ("ok", json!("fine")),
            ]),
        );
        assert_eq!(
            entry.fields["detail"],
            json!(REDACTED),
            "值内 api_key= 必须脱敏"
        );
        assert_eq!(
            entry.fields["items"][0],
            json!(REDACTED),
            "数组内 Bearer 必须脱敏"
        );
        assert_eq!(entry.fields["items"][1], json!("safe"));
        assert_eq!(entry.fields["ok"], json!("fine"));
    }

    #[test]
    fn clear_keeps_id_sequence() {
        let hub = RuntimeLogHub::default();
        let first = hub.push(Timestamp::new(1), "info", "test", None, "first", Map::new());
        hub.clear();
        let second = hub.push(
            Timestamp::new(2),
            "info",
            "test",
            None,
            "second",
            Map::new(),
        );
        assert!(second.id > first.id);
        assert_eq!(hub.list(&RuntimeLogQuery::default()).len(), 1);
    }

    #[tokio::test]
    async fn subscribers_receive_sanitized_entries_after_ring_write() {
        let hub = RuntimeLogHub::new(2);
        let mut events = hub.subscribe();
        let entry = hub.push(
            Timestamp::new(1),
            "error",
            "acp",
            None,
            "token=hidden",
            fields(&[("nested", json!({"apiKey": "secret"}))]),
        );
        let event = events.recv().await.expect("log event should be published");
        assert_eq!(event, entry);
        assert_eq!(event.message, REDACTED);
        assert_eq!(event.fields["nested"]["apiKey"], json!(REDACTED));
        assert_eq!(hub.list(&RuntimeLogQuery::default()).first(), Some(&entry));
    }
}
