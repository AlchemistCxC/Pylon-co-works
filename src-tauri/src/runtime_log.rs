//! 结构化运行时日志：固定容量、查询过滤、截断和敏感字段脱敏。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const DEFAULT_CAPACITY: usize = 2000;
const MAX_MESSAGE_BYTES: usize = 8 * 1024;
const REDACTED: &str = "[REDACTED]";

pub(crate) fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis().to_string()).unwrap_or_else(|_| "0".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLogEntry {
    pub id: u64,
    pub timestamp: String,
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
        timestamp: String,
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
        let mut entries = self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
        let entries = self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        entries.iter().rev()
            .filter(|entry| query.level.as_deref().is_none_or(|value| entry.level == value))
            .filter(|entry| query.source.as_deref().is_none_or(|value| entry.source == value))
            .filter(|entry| query.session.as_deref().is_none_or(|value| entry.session.as_deref() == Some(value)))
            .filter(|entry| search.as_deref().is_none_or(|needle| {
                entry.message.to_lowercase().contains(needle)
                    || serde_json::Value::Object(entry.fields.clone()).to_string().to_lowercase().contains(needle)
            }))
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn clear(&self) {
        self.entries.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
    }
}

fn normalize_level(level: String) -> String {
    match level.to_ascii_lowercase().as_str() {
        "trace" | "debug" | "info" | "warn" | "error" => level.to_ascii_lowercase(),
        _ => "info".to_string(),
    }
}

fn truncate(value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes { return value; }
    let mut end = max_bytes.saturating_sub(3);
    while end > 0 && !value.is_char_boundary(end) { end -= 1; }
    format!("{}...", &value[..end])
}

pub(crate) fn sanitize_message(message: String) -> String {
    let lower = message.to_ascii_lowercase();
    let contains_sensitive_payload = [
        "password=", "secret=", "token=", "api_key=", "apikey=", "authorization:",
        "prompt:", "persona:",
    ].iter().any(|marker| lower.contains(marker));
    if contains_sensitive_payload {
        return REDACTED.to_string();
    }
    truncate(message, MAX_MESSAGE_BYTES)
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    ["password", "secret", "authorization", "headers", "header", "prompt", "persona", "content", "rawinput", "rawoutput", "attachment", "env"]
        .iter().any(|part| key == *part)
        || key.contains("token")
        || key.contains("apikey")
        || key.contains("api_key")
}

fn sanitize_value(key: &str, value: Value) -> Value {
    if is_sensitive_key(key) { return Value::String(REDACTED.to_string()); }
    match value {
        Value::Object(object) => Value::Object(object.into_iter().map(|(key, value)| (key.clone(), sanitize_value(&key, value))).collect()),
        Value::Array(values) => Value::Array(values.into_iter().map(|value| sanitize_value("value", value)).collect()),
        Value::String(value) => Value::String(truncate(value, MAX_MESSAGE_BYTES)),
        other => other,
    }
}

fn sanitize_fields(fields: Map<String, Value>) -> Map<String, Value> {
    fields.into_iter().map(|(key, value)| (key.clone(), sanitize_value(&key, value))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(values: &[(&str, Value)]) -> Map<String, Value> {
        values.iter().map(|(key, value)| ((*key).to_string(), value.clone())).collect()
    }

    #[test]
    fn ring_buffer_keeps_latest_entries_and_monotonic_ids() {
        let hub = RuntimeLogHub::new(2);
        hub.push("t1".into(), "info", "a", None, "one", Map::new());
        hub.push("t2".into(), "info", "a", None, "two", Map::new());
        hub.push("t3".into(), "info", "a", None, "three", Map::new());
        let entries = hub.list(&RuntimeLogQuery::default());
        assert_eq!(entries.iter().map(|entry| entry.id).collect::<Vec<_>>(), vec![3, 2]);
        assert_eq!(entries[0].message, "three");
    }

    #[test]
    fn filters_by_level_source_session_and_search() {
        let hub = RuntimeLogHub::default();
        hub.push("t1".into(), "error", "acp", Some("a".into()), "Parse failed", Map::new());
        hub.push("t2".into(), "info", "ui", Some("b".into()), "Clicked", Map::new());
        let query = RuntimeLogQuery { level: Some("error".into()), source: Some("acp".into()), session: Some("a".into()), search: Some("parse".into()), limit: Some(10) };
        assert_eq!(hub.list(&query).len(), 1);
    }

    #[test]
    fn redacts_sensitive_fields_and_truncates_message() {
        let hub = RuntimeLogHub::default();
        let entry = hub.push("t1".into(), "warn", "acp", None, "x".repeat(9000), fields(&[
            ("apiKey", json!("secret-value")),
            ("nested", json!({"authorization": "Bearer abc", "result": "safe"})),
        ]));
        assert!(entry.message.len() <= MAX_MESSAGE_BYTES);
        assert_eq!(entry.fields["apiKey"], json!(REDACTED));
        assert_eq!(entry.fields["nested"]["authorization"], json!(REDACTED));
        assert_eq!(entry.fields["nested"]["result"], json!("safe"));
    }

    #[test]
    fn keeps_safe_diagnostic_words_in_message() {
        let hub = RuntimeLogHub::default();
        let entry = hub.push("t1".into(), "info", "runtime", None, "Prompt started; contentLength=42", Map::new());
        assert_eq!(entry.message, "Prompt started; contentLength=42");
    }

    #[test]
    fn redacts_sensitive_message_payload_markers() {
        let hub = RuntimeLogHub::default();
        for message in ["token=abc", "authorization: Bearer abc", "persona: hidden"] {
            let entry = hub.push("t1".into(), "error", "runtime", None, message, Map::new());
            assert_eq!(entry.message, REDACTED);
        }
    }

    #[test]
    fn clear_keeps_id_sequence() {
        let hub = RuntimeLogHub::default();
        let first = hub.push("t1".into(), "info", "test", None, "first", Map::new());
        hub.clear();
        let second = hub.push("t2".into(), "info", "test", None, "second", Map::new());
        assert!(second.id > first.id);
        assert_eq!(hub.list(&RuntimeLogQuery::default()).len(), 1);
    }

    #[tokio::test]
    async fn subscribers_receive_sanitized_entries_after_ring_write() {
        let hub = RuntimeLogHub::new(2);
        let mut events = hub.subscribe();
        let entry = hub.push(
            "t1".into(),
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
