//! Agent 浏览器操作审计：SQLite（user_data 表 `browser-agent-ops` 行）内的
//! 有界 ring buffer。每次 agent 工具调用追加一条；面板读取最近
//! [`AUDIT_MAX_ENTRIES`] 条展示。
//!
//! 写入策略：读 envelope → 追加 → 带 expected_revision 原子写；revision 冲突
//! 重读重试（浏览器命令可能并发触发）。持久化失败不阻断工具调用本身——审计
//! 尽力而为，失败记 warn。

use crate::session::{UserDataEnvelope, UserDataError, UserDataKey, UserDataService};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;

pub(crate) const AUDIT_MAX_ENTRIES: usize = 50;
pub(crate) const AUDIT_ENVELOPE_VERSION: i64 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserAuditEntry {
    /// 调用时间（epoch 毫秒）。
    pub(crate) at_ms: u64,
    /// 发起会话的 claim key（`--session` 注入；缺省 `unknown`）。
    pub(crate) session_key: String,
    /// 工具名（如 `browser_navigate`）。
    pub(crate) tool: String,
    /// 参数摘要（截断、无敏感面——URL/selector/key 名）。
    pub(crate) summary: String,
    /// `ok` | `denied:<code>` | `error`。
    pub(crate) outcome: String,
}

#[derive(Debug, Clone)]
pub(crate) struct AuditBuffer {
    entries: VecDeque<BrowserAuditEntry>,
}

impl Default for AuditBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl AuditBuffer {
    pub(crate) fn new() -> Self {
        Self {
            entries: VecDeque::new(),
        }
    }

    pub(crate) fn push(&mut self, entry: BrowserAuditEntry) {
        if self.entries.len() >= AUDIT_MAX_ENTRIES {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    pub(crate) fn entries(&self) -> impl Iterator<Item = &BrowserAuditEntry> {
        self.entries.iter()
    }

    #[allow(dead_code)] // 测试用
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    pub(crate) fn to_payload(&self) -> Value {
        serde_json::json!({
            "version": AUDIT_ENVELOPE_VERSION,
            "ops": self.entries.iter().collect::<Vec<_>>(),
        })
    }

    pub(crate) fn from_payload(payload: &Value) -> Self {
        let mut buffer = Self::new();
        if let Some(ops) = payload.get("ops").and_then(Value::as_array) {
            for entry in ops {
                if let Ok(entry) = serde_json::from_value::<BrowserAuditEntry>(entry.clone()) {
                    buffer.push(entry);
                }
            }
        }
        buffer
    }
}

/// 追加一条审计并持久化。冲突重试三次后放弃（审计尽力而为）。
pub(crate) async fn append_audit(
    service: &UserDataService,
    entry: BrowserAuditEntry,
) -> Result<(), String> {
    for _attempt in 0..3 {
        // 载入损坏：从空 buffer 重写（审计不是事实源，可牺牲）。
        let envelope: Option<UserDataEnvelope> = service
            .load(UserDataKey::BrowserAgentOps)
            .await
            .unwrap_or_default();
        let expected_revision = envelope.as_ref().map(|envelope| envelope.revision);
        let mut buffer = envelope
            .as_ref()
            .map(|envelope: &UserDataEnvelope| AuditBuffer::from_payload(&envelope.payload))
            .unwrap_or_default();
        buffer.push(entry.clone());
        let payload = buffer.to_payload();
        match service
            .save(UserDataKey::BrowserAgentOps, payload, expected_revision)
            .await
        {
            Ok(_) => return Ok(()),
            Err(UserDataError::RevisionConflict { .. }) => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("审计写入在 revision 冲突重试后放弃".to_string())
}

/// 读取最近审计（按时间升序，最旧在前）。
pub(crate) async fn recent_audit(
    service: &UserDataService,
) -> Result<Vec<BrowserAuditEntry>, String> {
    match service.load(UserDataKey::BrowserAgentOps).await {
        Ok(Some(envelope)) => {
            let buffer = AuditBuffer::from_payload(&envelope.payload);
            Ok(buffer.entries().cloned().collect())
        }
        Ok(None) => Ok(Vec::new()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(at_ms: u64, tool: &str) -> BrowserAuditEntry {
        BrowserAuditEntry {
            at_ms,
            session_key: "s1".into(),
            tool: tool.into(),
            summary: format!("{tool}-summary"),
            outcome: "ok".into(),
        }
    }

    #[test]
    fn ring_buffer_caps_at_limit_dropping_oldest() {
        let mut buffer = AuditBuffer::new();
        for index in 0..(AUDIT_MAX_ENTRIES as u64 + 10) {
            buffer.push(entry(index, "browser_navigate"));
        }
        assert_eq!(buffer.len(), AUDIT_MAX_ENTRIES);
        let first = buffer.entries().next().unwrap();
        assert_eq!(first.at_ms, 10, "最旧的 10 条应被挤出");
        let last = buffer.entries().last().unwrap();
        assert_eq!(last.at_ms, AUDIT_MAX_ENTRIES as u64 + 9);
    }

    #[test]
    fn payload_roundtrip_preserves_entries() {
        let mut buffer = AuditBuffer::new();
        buffer.push(entry(1, "browser_navigate"));
        buffer.push(entry(2, "browser_click"));
        let payload = buffer.to_payload();
        let restored = AuditBuffer::from_payload(&payload);
        assert_eq!(restored.len(), 2);
        let items: Vec<_> = restored.entries().cloned().collect();
        assert_eq!(items[0].tool, "browser_navigate");
        assert_eq!(items[1].tool, "browser_click");
        assert_eq!(items[1].session_key, "s1");
    }

    #[test]
    fn from_payload_skips_malformed_entries() {
        let payload = serde_json::json!({
            "version": 1,
            "ops": [
                { "atMs": 1, "sessionKey": "s1", "tool": "browser_navigate", "summary": "x", "outcome": "ok" },
                { "atMs": "bad" },
                { "atMs": 2, "sessionKey": "s1", "tool": "browser_press", "summary": "y", "outcome": "denied:readonly_restricted" },
            ],
        });
        let buffer = AuditBuffer::from_payload(&payload);
        assert_eq!(buffer.len(), 2);
    }

    #[tokio::test]
    async fn append_and_read_via_user_data_service() {
        let service = UserDataService::in_memory().unwrap();
        append_audit(&service, entry(1, "browser_navigate"))
            .await
            .unwrap();
        append_audit(&service, entry(2, "browser_click"))
            .await
            .unwrap();
        let ops = recent_audit(&service).await.unwrap();
        assert_eq!(ops.len(), 2);
        assert_eq!(ops[1].tool, "browser_click");
    }
}
