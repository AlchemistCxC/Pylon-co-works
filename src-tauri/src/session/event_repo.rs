//! EVT-02：canonical 事件仓库（SQLite 持久化，方案书 §5.10）。
//!
//! 与消息仓库共用同一 SQLite 文件（`pylon-data-v1.sqlite3`，schema 由 msg_repo 的
//! 统一迁移链管理——`SCHEMA_SQL` v6 新增 `canonical_events` 表，`connect()` 复用）；
//! 本模块持独立 Connection（busy_timeout 序列化同文件写）。
//!
//! 契约（§5.10 迁移原则）：
//! - 原则 1：新事件表先上线；B7（v9）起旧 messages/MessageRecord 已删除，
//!   `canonical_events` 是唯一会话数据源。
//! - 原则 5：unknown event 不得静默丢弃——`raw_payload` 恒存（NOT NULL）。
//! - rule 1：event_id = `owner_key#sequence` 确定性推导（禁 content 哈希）。
//! - rule 3：sequence 按 owner/session 范围分配——`UNIQUE(owner_key, sequence)`；
//!   owner_key 为 JSON 数组序列化（禁冒号拼接，与 `toCanonicalOwnerKey` 同纪律）。
//! - rule 4：payloadVersion 版本化；occurred_at/received_at 存原始 ISO 文本。
//! - append 输入按 unknown 处理（前端 EVT-01 schema 序列化 JSON；TS 类型在此失效），
//!   后端做结构校验（不抛异常，返回问题列表式错误），坏形状拒绝写入而非静默丢弃。
//! - 本表不设 FK（事件流先于/独立于 messages 会话行）；DEL-04 起 append 显式查
//!   deleted_sessions 做 tombstone gate（deleting/deleted 均拒绝，不复活已删会话）。
//!
//! 同步访问（`Mutex<Connection>`，SQLite 单写者）；上层须经 spawn_blocking 调用。

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde::ser::SerializeMap;
use serde::Serialize;

use super::DurableSessionOwner;

/// canonical 事件行（canonical_events 表）。camelCase wire 与 EVT-01 schema 对齐；
/// identity/typed_payload/raw_payload 以 JSON 文本存取，回读原样还原。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanonicalEventRow {
    pub(crate) event_id: String,
    pub(crate) owner_key: String,
    pub(crate) profile_id: String,
    pub(crate) agent_id: String,
    pub(crate) local_session_id: String,
    pub(crate) remote_session_id: Option<String>,
    pub(crate) client_generation: i64,
    pub(crate) sequence: i64,
    pub(crate) occurred_at: String,
    pub(crate) received_at: String,
    pub(crate) event_type: String,
    pub(crate) payload_version: i64,
    pub(crate) identity: Option<serde_json::Value>,
    pub(crate) typed_payload: Option<serde_json::Value>,
    pub(crate) raw_payload: serde_json::Value,
    pub(crate) created_at: i64,
    pub(crate) schema_version: i64,
    pub(crate) provenance_origin: String,
    pub(crate) provenance_trust: String,
    pub(crate) provenance_provider: Option<String>,
    pub(crate) provenance_import_id: Option<String>,
    pub(crate) raw_truncated: bool,
    pub(crate) raw_original_bytes: i64,
    pub(crate) raw_retained_bytes: i64,
    pub(crate) raw_omitted_bytes: i64,
    pub(crate) raw_truncation_reason: Option<String>,
}

struct StoredCanonicalEventRow {
    event: CanonicalEventRow,
    identity_json: Option<String>,
    typed_payload_json: Option<String>,
    raw_payload_json: String,
}

impl StoredCanonicalEventRow {
    fn decode(mut self) -> Result<CanonicalEventRow, EventError> {
        let event_id = self.event.event_id.clone();
        self.event.identity = self
            .identity_json
            .map(|json| decode_event_json(&event_id, "identity", &json))
            .transpose()?;
        self.event.typed_payload = self
            .typed_payload_json
            .map(|json| decode_event_json(&event_id, "typed_payload", &json))
            .transpose()?;
        self.event.raw_payload =
            decode_event_json(&event_id, "raw_payload", &self.raw_payload_json)?;
        Ok(self.event)
    }
}

fn decode_event_json(
    event_id: &str,
    column: &str,
    json: &str,
) -> Result<serde_json::Value, EventError> {
    serde_json::from_str(json).map_err(|error| {
        EventError::Corrupt(format!(
            "event={event_id} column={column} invalid JSON ({} bytes): {error}",
            json.len()
        ))
    })
}

/// append 结果：实际写入事件（跳过 event_id 去重）+ 该 owner 最新 sequence（revision）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventAppendResult {
    pub(crate) events: Vec<CanonicalEventRow>,
    pub(crate) revision: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ReplayJournalIngestResult {
    pub(crate) events: Vec<CanonicalEventRow>,
    pub(crate) revision: i64,
    pub(crate) status: &'static str,
}

/// Kernel ingest 输入。owner 来自已证明的 runtime session 绑定；remote id 仅是
/// 当前 binding，raw payload 永久保留。sequence 由 EventRepo 事务内分配。
#[derive(Debug, Clone)]
struct KernelEventInput {
    owner: DurableSessionOwner,
    remote_session_id: Option<String>,
    client_generation: i64,
    received_at: String,
    raw_payload: serde_json::Value,
    recovery_import: bool,
}

const MAX_CANONICAL_RAW_BYTES: usize = 64 * 1024;

fn retain_raw_payload(raw: serde_json::Value) -> (serde_json::Value, bool, i64, i64, i64) {
    let encoded = raw.to_string();
    let original = encoded.len() as i64;
    if encoded.len() <= MAX_CANONICAL_RAW_BYTES {
        return (raw, false, original, original, 0);
    }
    let preview_len = MAX_CANONICAL_RAW_BYTES.saturating_sub(96);
    let preview = encoded.chars().take(preview_len).collect::<String>();
    let retained = serde_json::json!({
        "_pylonTruncated": true,
        "preview": preview,
        "originalBytes": original,
    });
    let retained_bytes = retained.to_string().len() as i64;
    (retained, true, original, retained_bytes, original.saturating_sub(retained_bytes))
}

/// 事件页（游标分页，升序）：事件 + 下一页游标（None = 已到最早，无更旧事件）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventPage {
    pub(crate) events: Vec<CanonicalEventRow>,
    pub(crate) next_before_sequence: Option<i64>,
}

/// evt_search 候选 owner（B6）：内容命中 canonical_events 的 owner 三元组 +
/// remote_session_id（前端据此 loadAll 后做消息级精确过滤）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EventSearchOwner {
    pub(crate) profile_id: String,
    pub(crate) agent_id: String,
    pub(crate) local_session_id: String,
    pub(crate) remote_session_id: Option<String>,
}

/// Forensic export deliberately bypasses JSON decoding so one corrupt row can be isolated without
/// making the rest of the owner stream appear healthy or leaking payload text into error logs.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanonicalEventRawExport {
    pub(crate) event_id: String,
    pub(crate) owner_key: String,
    pub(crate) sequence: i64,
    pub(crate) event_type: String,
    pub(crate) identity_json: Option<String>,
    pub(crate) typed_payload_json: Option<String>,
    pub(crate) raw_payload_json: String,
}

/// 事件仓库结构化错误（B1.2：前端按 code 分支，message 展示用）。
#[derive(Debug, thiserror::Error)]
pub(crate) enum EventError {
    /// 批量 append 的 expected_revision 与仓库当前 revision 不匹配（旧写不覆盖新写）。
    #[error("事件仓库 revision 冲突：期望 {expected}，实际 {actual}")]
    RevisionConflict { expected: i64, actual: i64 },
    /// SQLITE_CORRUPT / SQLITE_NOTADB：数据库镜像损坏或非数据库文件。
    #[error("事件仓库损坏：{0}")]
    Corrupt(String),
    /// SQLITE_CONSTRAINT：唯一性/FK 等约束冲突。
    #[error("事件仓库约束冲突：{0}")]
    Constraint(String),
    /// SQLITE_BUSY / SQLITE_LOCKED：并发写锁冲突（可重试）。
    #[error("事件仓库并发锁冲突：{0}")]
    Conflict(String),
    /// DEL-04：owner 已 tombstone（deleting/deleted）——迟到 append 被拒绝，不复活已删会话。
    #[error("会话已删除（tombstone）：{0}")]
    SessionDeleted(String),
    /// DB 不可用（open/迁移/任务失败等其余 rusqlite 错误）。
    #[error("事件仓库不可用：{0}")]
    Unavailable(String),
    /// append 输入事件形状非法（后端结构校验拒绝，不静默丢弃）。
    #[error("事件输入非法：{0}")]
    Invalid(String),
}

impl EventError {
    /// 机器可读错误码（稳定，不改拼写）。
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::RevisionConflict { .. } => "event_revision_conflict",
            Self::Corrupt(_) => "event_repo_corrupt",
            Self::Constraint(_) => "event_repo_constraint",
            Self::Conflict(_) => "event_repo_conflict",
            Self::SessionDeleted(_) => "event_session_deleted",
            Self::Unavailable(_) => "event_db_unavailable",
            Self::Invalid(_) => "event_invalid",
        }
    }
}

/// B1.2：结构化错误 wire `{ code, message }`（与 MessageError/UserDataError 同形）。
impl Serialize for EventError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("code", self.code())?;
        map.serialize_entry("message", &self.to_string())?;
        map.end()
    }
}

impl From<rusqlite::Error> for EventError {
    fn from(error: rusqlite::Error) -> Self {
        if let rusqlite::Error::SqliteFailure(failure, _) = &error {
            return match failure.code {
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase => {
                    Self::Corrupt(format!("event repo: {error}"))
                }
                rusqlite::ErrorCode::ConstraintViolation => {
                    Self::Constraint(format!("event repo: {error}"))
                }
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => {
                    Self::Conflict(format!("event repo: {error}"))
                }
                _ => Self::Unavailable(format!("event repo: {error}")),
            };
        }
        Self::Unavailable(format!("event repo: {error}"))
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn non_empty_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn first_string(
    record: Option<&serde_json::Map<String, serde_json::Value>>,
    aliases: &[&str],
) -> Option<String> {
    aliases
        .iter()
        .find_map(|alias| non_empty_string(record.and_then(|value| value.get(*alias))))
}

fn extract_update(raw: &serde_json::Value) -> Option<&serde_json::Map<String, serde_json::Value>> {
    let root = raw.as_object()?;
    let params = root.get("params").and_then(serde_json::Value::as_object);
    params
        .and_then(|value| value.get("update"))
        .and_then(serde_json::Value::as_object)
        .or_else(|| root.get("update").and_then(serde_json::Value::as_object))
        .or_else(|| {
            root.get("sessionUpdate")
                .and_then(serde_json::Value::as_str)
                .map(|_| root)
        })
        .or_else(|| {
            params.and_then(|value| {
                value
                    .get("sessionUpdate")
                    .and_then(serde_json::Value::as_str)
                    .map(|_| value)
            })
        })
}

fn strip_replay_prompt_prefix(text: &str) -> &str {
    const SEPARATOR: &str = "\n\n---\n\n";
    text.rsplit_once(SEPARATOR)
        .map(|(_, content)| content)
        .filter(|content| !content.is_empty())
        .unwrap_or(text)
}

fn mark_replay_import(
    owner: &DurableSessionOwner,
    mut raw_payload: serde_json::Value,
) -> serde_json::Value {
    if let serde_json::Value::Object(root) = &mut raw_payload {
        root.insert(
            "source".to_string(),
            serde_json::Value::String(owner.local_session_id.clone()),
        );
        if let Some(update) = replay_update_mut(root) {
            let meta = update
                .entry("_meta")
                .or_insert_with(|| serde_json::json!({}));
            if let Some(meta) = meta.as_object_mut() {
                meta.insert(
                    "pylonReplayImport".to_string(),
                    serde_json::Value::Bool(true),
                );
            }
        }
    }
    raw_payload
}

fn replay_update_mut(
    root: &mut serde_json::Map<String, serde_json::Value>,
) -> Option<&mut serde_json::Map<String, serde_json::Value>> {
    if root.get("update").is_some() {
        return root
            .get_mut("update")
            .and_then(serde_json::Value::as_object_mut);
    }
    root.get_mut("params")
        .and_then(serde_json::Value::as_object_mut)
        .and_then(|params| params.get_mut("update"))
        .and_then(serde_json::Value::as_object_mut)
}

fn resolve_identity(
    update: Option<&serde_json::Map<String, serde_json::Value>>,
) -> Option<serde_json::Value> {
    let root = update?;
    let content = root.get("content").and_then(serde_json::Value::as_object);
    let meta = root.get("_meta").and_then(serde_json::Value::as_object);
    let mut identity = serde_json::Map::new();
    for (field, aliases, root_first) in [
        (
            "toolCallId",
            &["toolCallId", "tool_call_id", "toolUseId", "tool_use_id"][..],
            true,
        ),
        ("messageId", &["messageId", "message_id"][..], false),
        ("turnId", &["turnId", "turn_id"][..], false),
        ("requestId", &["requestId", "request_id"][..], false),
    ] {
        let records = if root_first {
            [Some(root), content, meta]
        } else {
            [content, Some(root), meta]
        };
        if let Some(value) = records
            .into_iter()
            .find_map(|record| first_string(record, aliases))
        {
            identity.insert(field.to_string(), serde_json::Value::String(value));
        }
    }
    (!identity.is_empty()).then_some(serde_json::Value::Object(identity))
}

fn normalize_kernel_event(
    input: KernelEventInput,
    sequence: i64,
) -> Result<CanonicalEventRow, EventError> {
    let raw_for_storage = input.raw_payload.clone();
    let provenance_provider = input.owner.agent_id.clone();
    let provenance_import_id = input.owner.local_session_id.clone();
    let owner_key = input
        .owner
        .key()
        .map_err(|error| EventError::Invalid(error.to_string()))?;
    let update = extract_update(&input.raw_payload);
    let session_update = update
        .and_then(|value| value.get("sessionUpdate"))
        .and_then(serde_json::Value::as_str);
    let status = update
        .and_then(|value| value.get("status"))
        .and_then(serde_json::Value::as_str);
    let event_type = match session_update {
        Some("user_message_chunk") => "user.message",
        Some("agent_message_chunk") => "assistant.text.delta",
        Some("agent_thought_chunk") => "assistant.thinking.delta",
        Some("tool_call") => "tool.call.started",
        Some("tool_call_update") if status == Some("completed") => "tool.call.completed",
        Some("tool_call_update") if matches!(status, Some("failed" | "error")) => {
            "tool.call.failed"
        }
        Some("tool_call_update") => "tool.call.updated",
        Some("done") => "turn.completed",
        Some("error") => "turn.failed",
        _ => "unknown",
    };

    let mut typed_payload = serde_json::Map::new();
    if let Some(update) = update {
        let text = update
            .get("content")
            .and_then(serde_json::Value::as_object)
            .and_then(|content| content.get("text"))
            .or_else(|| update.get("text"))
            .and_then(serde_json::Value::as_str)
            .filter(|text| !text.is_empty());
        if let Some(text) = text {
            let text = if session_update == Some("user_message_chunk")
                && update
                    .get("_meta")
                    .and_then(serde_json::Value::as_object)
                    .and_then(|meta| meta.get("pylonReplayImport"))
                    .and_then(serde_json::Value::as_bool)
                    == Some(true)
            {
                strip_replay_prompt_prefix(text)
            } else {
                text
            };
            typed_payload.insert(
                "text".to_string(),
                serde_json::Value::String(text.to_string()),
            );
        }
        if matches!(session_update, Some("tool_call" | "tool_call_update")) {
            let mut tool = serde_json::Map::new();
            for field in ["title", "kind", "status"] {
                if let Some(value) = non_empty_string(update.get(field)) {
                    tool.insert(field.to_string(), serde_json::Value::String(value));
                }
            }
            for (wire, canonical) in [
                ("rawInput", "rawInput"),
                ("rawOutput", "rawOutput"),
                ("content", "contentBlocks"),
            ] {
                if let Some(value) = update.get(wire) {
                    tool.insert(canonical.to_string(), value.clone());
                }
            }
            typed_payload.insert("tool".to_string(), serde_json::Value::Object(tool));
        }
        if session_update == Some("error") {
            if let Some(code) = non_empty_string(update.get("errorCode")) {
                typed_payload.insert("code".to_string(), serde_json::Value::String(code));
            }
            if let Some(error) = non_empty_string(update.get("error"))
                .or_else(|| non_empty_string(update.get("message")))
            {
                typed_payload.insert("error".to_string(), serde_json::Value::String(error));
            }
        }
    }

    let (raw_payload, raw_truncated, raw_original_bytes, raw_retained_bytes, raw_omitted_bytes) =
        retain_raw_payload(raw_for_storage);
    Ok(CanonicalEventRow {
        event_id: format!("{owner_key}#{sequence}"),
        owner_key,
        profile_id: input.owner.profile_id,
        agent_id: input.owner.agent_id,
        local_session_id: input.owner.local_session_id,
        remote_session_id: input.remote_session_id,
        client_generation: input.client_generation,
        sequence,
        occurred_at: input.received_at.clone(),
        received_at: input.received_at,
        event_type: event_type.to_string(),
        payload_version: 1,
        identity: resolve_identity(update),
        typed_payload: (!typed_payload.is_empty())
            .then_some(serde_json::Value::Object(typed_payload)),
        raw_payload,
        created_at: now_millis(),
        schema_version: 1,
        provenance_origin: if input.recovery_import { "recovery-import" } else { "local-observed" }.to_string(),
        provenance_trust: if input.recovery_import { "unverified" } else { "authoritative" }.to_string(),
        provenance_provider: Some(provenance_provider),
        provenance_import_id: input.recovery_import.then_some(provenance_import_id),
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
        raw_truncation_reason: raw_truncated.then(|| "size".to_string()),
    })
}

/// 从 EVT-01 前端 schema JSON 校验并提取事件行（append-only 完整性守卫）。
/// 不抛异常：坏形状返回问题列表（拼接为一条 Invalid 错误），空问题 = 合法。
/// 覆盖：eventId 非空、owner 五字段、generation/sequence 正整数域、eventType 非空、
/// payloadVersion 版本化、occurred_at/received_at 存在、raw_payload 恒存、
/// eventId 与 owner+sequence 推导一致性（rule 1）。unknown eventType 原样接受。
pub(crate) fn parse_canonical_event(
    value: &serde_json::Value,
) -> Result<CanonicalEventRow, EventError> {
    let mut problems: Vec<String> = Vec::new();
    if !value.is_object() {
        problems.push("event 必须是对象".into());
        return Err(EventError::Invalid(problems.join("; ")));
    }
    let obj = value.as_object().expect("checked object");
    let get_str = |key: &str| obj.get(key).and_then(|v| v.as_str()).map(str::to_owned);
    let get_i64 = |key: &str| obj.get(key).and_then(|v| v.as_i64());

    let event_id = get_str("eventId");
    let owner = obj.get("owner").and_then(|v| v.as_object());
    let profile_id = owner
        .and_then(|o| o.get("profileId"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let agent_id = owner
        .and_then(|o| o.get("agentId"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let local_session_id = owner
        .and_then(|o| o.get("localSessionId"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let remote_session_id = owner
        .and_then(|o| o.get("remoteSessionId"))
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let client_generation = get_i64("clientGeneration");
    let sequence = get_i64("sequence");
    let occurred_at = get_str("occurredAt");
    let received_at = get_str("receivedAt");
    let event_type = get_str("eventType");
    let payload_version = get_i64("payloadVersion");
    let provenance = obj.get("provenance").and_then(|value| value.as_object());
    let provenance_origin = provenance
        .and_then(|value| value.get("origin"))
        .and_then(|value| value.as_str())
        .unwrap_or("migration");
    let provenance_trust = provenance
        .and_then(|value| value.get("trust"))
        .and_then(|value| value.as_str())
        .unwrap_or("unverified");

    if event_id.is_none() {
        problems.push("eventId 必填".into());
    }
    if profile_id.is_none() || agent_id.is_none() || local_session_id.is_none() {
        problems.push("owner 必填 profileId/agentId/localSessionId".into());
    }
    if !client_generation.is_some_and(|v| v >= 0) {
        problems.push("clientGeneration 必须为非负整数".into());
    }
    if !sequence.is_some_and(|v| v >= 1) {
        problems.push("sequence 必须为正整数".into());
    }
    if occurred_at.is_none() {
        problems.push("occurredAt 必填".into());
    }
    if received_at.is_none() {
        problems.push("receivedAt 必填".into());
    }
    if event_type.is_none() {
        problems.push("eventType 必填".into());
    }
    if !payload_version.is_some_and(|v| v >= 1) {
        problems.push("payloadVersion 必须为正整数（schema 版本化）".into());
    }
    if !obj.contains_key("rawPayload") {
        problems.push("rawPayload 必填（unknown event 不得静默丢弃）".into());
    }
    if !matches!(provenance_origin, "local-observed" | "optimistic-local" | "recovery-import" | "migration" | "plugin") {
        problems.push("provenance.origin 非法".into());
    }
    if !matches!(provenance_trust, "authoritative" | "unverified") {
        problems.push("provenance.trust 非法".into());
    }
    if (provenance_origin == "local-observed") != (provenance_trust == "authoritative") {
        problems.push("local-observed 只能 authoritative，其他来源只能 unverified".into());
    }

    if !problems.is_empty() {
        return Err(EventError::Invalid(problems.join("; ")));
    }

    let event_id = event_id.expect("checked");
    let profile_id = profile_id.expect("checked");
    let agent_id = agent_id.expect("checked");
    let local_session_id = local_session_id.expect("checked");
    // owner_key = JSON 数组序列化（禁冒号拼接——source 可含冒号，与 toCanonicalOwnerKey 同纪律）。
    let owner_key = serde_json::to_string(&[&profile_id, &agent_id, &local_session_id])
        .map_err(|e| EventError::Invalid(format!("owner_key 序列化失败: {e}")))?;
    // rule 1：event_id = owner_key#sequence 确定性推导（禁 content 哈希）。
    let expected_id = format!("{owner_key}#{}", sequence.expect("checked"));
    if event_id != expected_id {
        return Err(EventError::Invalid(format!(
            "eventId 与 owner+sequence 推导不一致: 期望 {expected_id}，实际 {event_id}"
        )));
    }

    let (raw_payload, raw_truncated, raw_original_bytes, raw_retained_bytes, raw_omitted_bytes) =
        retain_raw_payload(obj.get("rawPayload").cloned().unwrap_or(serde_json::Value::Null));

    Ok(CanonicalEventRow {
        event_id,
        owner_key,
        profile_id,
        agent_id,
        local_session_id,
        remote_session_id,
        client_generation: client_generation.expect("checked"),
        sequence: sequence.expect("checked"),
        occurred_at: occurred_at.expect("checked"),
        received_at: received_at.expect("checked"),
        event_type: event_type.expect("checked"),
        payload_version: payload_version.expect("checked"),
        identity: obj.get("identity").cloned(),
        typed_payload: obj.get("typedPayload").cloned(),
        raw_payload,
        created_at: now_millis(),
        schema_version: obj.get("schemaVersion").and_then(|v| v.as_i64()).unwrap_or(1),
        provenance_origin: provenance_origin.to_string(),
        provenance_trust: provenance_trust.to_string(),
        provenance_provider: obj.get("provenance").and_then(|p| p.get("provider")).and_then(|v| v.as_str()).map(str::to_string),
        provenance_import_id: obj.get("provenance").and_then(|p| p.get("importId")).and_then(|v| v.as_str()).map(str::to_string),
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
        raw_truncation_reason: raw_truncated.then(|| "size".to_string()),
    })
}

/// 事件仓库：单一 SQLite 连接 + 互斥（SQLite 单写者）。
pub(crate) struct EventRepo {
    conn: Mutex<Connection>,
}

impl EventRepo {
    /// 打开（或创建）仓库并迁移到最新 schema（D-02 版本化迁移）。
    pub(crate) fn open(path: &Path) -> Result<EventRepo, EventError> {
        let mut conn = Connection::open(path).map_err(EventError::from)?;
        crate::session::connect(&mut conn)
            .map_err(|error| EventError::Unavailable(error.to_string()))?;
        Ok(EventRepo {
            conn: Mutex::new(conn),
        })
    }

    /// 内存仓库（测试用）。
    #[allow(dead_code)] // 测试用内存仓库
    pub(crate) fn open_in_memory() -> Result<EventRepo, EventError> {
        let mut conn = Connection::open_in_memory().map_err(EventError::from)?;
        crate::session::connect(&mut conn)
            .map_err(|error| EventError::Unavailable(error.to_string()))?;
        Ok(EventRepo {
            conn: Mutex::new(conn),
        })
    }

    /// owner 当前 revision = 该 owner 最大 sequence（空 = 0）。expected_revision 冲突
    /// 检测基准：单写者（Mutex）下 MAX(sequence) 单调递增，旧写落后即判定过期。
    pub(crate) fn revision(&self, owner_key: &str) -> Result<i64, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let max: Option<i64> = conn
            .query_row(
                "SELECT MAX(sequence) FROM canonical_events WHERE owner_key = ?1",
                params![owner_key],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(EventError::from)?
            .flatten();
        Ok(max.unwrap_or(0))
    }

    /// 批量 append（单事务）：expected_revision（Some）与当前 revision 不匹配 →
    /// `RevisionConflict`，不写任何行（旧写不覆盖新写）。
    /// event_id 已存在（重启去重）跳过不重复写入、不消耗 sequence（事件 sequence 由
    /// 前端 allocateEventSequence 分配，rule 3）。返回实际写入事件与写入后 revision。
    pub(crate) fn append_events(
        &self,
        events: &[CanonicalEventRow],
        expected_revision: Option<i64>,
    ) -> Result<EventAppendResult, EventError> {
        if events.is_empty() {
            return Ok(EventAppendResult {
                events: Vec::new(),
                revision: 0,
            });
        }
        let owner_key = &events[0].owner_key;
        // 批量必须同属一个 owner（单事件流写入；跨 owner 混批视为输入非法）。
        if let Some(cross) = events.iter().find(|e| e.owner_key != *owner_key) {
            return Err(EventError::Invalid(format!(
                "append 批次跨 owner：{} 与 {}",
                owner_key, cross.owner_key
            )));
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let tx = conn.transaction().map_err(EventError::from)?;
        // DEL-04：tombstone gate——owner 已删除（deleting/deleted）时拒绝迟到 append，
        // 不复活已删会话（canonical_events 无 FK 级联，必须显式查 deleted_sessions）。
        let tombstone_state: Option<String> = tx
            .query_row(
                "SELECT state FROM deleted_sessions
                 WHERE owner_key = ?1 OR (session_id = ?2 AND owner_scope = 'legacy')
                 LIMIT 1",
                params![owner_key, events[0].local_session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(EventError::from)?
            .flatten();
        if let Some(state) = tombstone_state {
            return Err(EventError::SessionDeleted(format!(
                "{owner_key}（tombstone state={state}）"
            )));
        }
        let current: i64 = tx
            .query_row(
                "SELECT MAX(sequence) FROM canonical_events WHERE owner_key = ?1",
                params![owner_key],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(EventError::from)?
            .flatten()
            .unwrap_or(0);
        if let Some(expected) = expected_revision {
            if expected != current {
                return Err(EventError::RevisionConflict {
                    expected,
                    actual: current,
                });
            }
        }
        let mut inserted = Vec::new();
        let mut revision = current;
        for event in events {
            let changed = tx
                .execute(
                    "INSERT INTO canonical_events
                         (event_id, owner_key, profile_id, agent_id, local_session_id,
                          remote_session_id, client_generation, sequence, occurred_at,
                          received_at, event_type, payload_version, identity, typed_payload,
                          raw_payload, created_at, schema_version, provenance_origin,
                          provenance_trust, provenance_provider, provenance_import_id,
                          raw_truncated, raw_original_bytes, raw_retained_bytes,
                          raw_omitted_bytes, raw_truncation_reason)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
                     ON CONFLICT(event_id) DO NOTHING",
                    params![
                        event.event_id,
                        event.owner_key,
                        event.profile_id,
                        event.agent_id,
                        event.local_session_id,
                        event.remote_session_id,
                        event.client_generation,
                        event.sequence,
                        event.occurred_at,
                        event.received_at,
                        event.event_type,
                        event.payload_version,
                        event.identity.as_ref().map(serde_json::Value::to_string),
                        event
                            .typed_payload
                            .as_ref()
                            .map(serde_json::Value::to_string),
                        event.raw_payload.to_string(),
                        event.created_at,
                        event.schema_version,
                        event.provenance_origin,
                        event.provenance_trust,
                        event.provenance_provider,
                        event.provenance_import_id,
                        event.raw_truncated,
                        event.raw_original_bytes,
                        event.raw_retained_bytes,
                        event.raw_omitted_bytes,
                        event.raw_truncation_reason,
                    ],
                )
                .map_err(EventError::from)?;
            if changed > 0 {
                revision = revision.max(event.sequence);
                inserted.push(event.clone());
            }
        }
        tx.commit().map_err(EventError::from)?;
        Ok(EventAppendResult {
            events: inserted,
            revision,
        })
    }

    /// Kernel single-writer ingest：在同一 SQLite transaction 内读取 revision、分配
    /// sequence、normalize 并 append。调用方不持有第二份 sequence 状态。
    fn ingest_kernel_event(
        &self,
        input: KernelEventInput,
    ) -> Result<EventAppendResult, EventError> {
        let owner_key = input
            .owner
            .key()
            .map_err(|error| EventError::Invalid(error.to_string()))?;
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let tx = conn.transaction().map_err(EventError::from)?;
        let tombstone_state: Option<String> = tx
            .query_row(
                "SELECT state FROM deleted_sessions
                 WHERE owner_key = ?1 OR (session_id = ?2 AND owner_scope = 'legacy')
                 LIMIT 1",
                params![owner_key, input.owner.local_session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(EventError::from)?
            .flatten();
        if let Some(state) = tombstone_state {
            return Err(EventError::SessionDeleted(format!(
                "{owner_key}（tombstone state={state}）"
            )));
        }
        let revision: i64 = tx
            .query_row(
                "SELECT MAX(sequence) FROM canonical_events WHERE owner_key = ?1",
                params![owner_key],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(EventError::from)?
            .flatten()
            .unwrap_or(0);
        let event = normalize_kernel_event(input, revision + 1)?;
        tx.execute(
            "INSERT INTO canonical_events
                 (event_id, owner_key, profile_id, agent_id, local_session_id,
                  remote_session_id, client_generation, sequence, occurred_at,
                 received_at, event_type, payload_version, identity, typed_payload,
                 raw_payload, created_at, schema_version, provenance_origin, provenance_trust,
                 provenance_provider, provenance_import_id, raw_truncated, raw_original_bytes,
                 raw_retained_bytes, raw_omitted_bytes, raw_truncation_reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
            params![
                event.event_id,
                event.owner_key,
                event.profile_id,
                event.agent_id,
                event.local_session_id,
                event.remote_session_id,
                event.client_generation,
                event.sequence,
                event.occurred_at,
                event.received_at,
                event.event_type,
                event.payload_version,
                event.identity.as_ref().map(serde_json::Value::to_string),
                event
                    .typed_payload
                    .as_ref()
                    .map(serde_json::Value::to_string),
                event.raw_payload.to_string(),
                event.created_at,
                event.schema_version,
                event.provenance_origin,
                event.provenance_trust,
                event.provenance_provider,
                event.provenance_import_id,
                event.raw_truncated,
                event.raw_original_bytes,
                event.raw_retained_bytes,
                event.raw_omitted_bytes,
                event.raw_truncation_reason,
            ],
        )
        .map_err(EventError::from)?;
        tx.commit().map_err(EventError::from)?;
        Ok(EventAppendResult {
            events: vec![event],
            revision: revision + 1,
        })
    }

    /// Return whether this owner already has a trusted local observation. Replay is only a
    /// recovery source when the journal has no such row; recovery-import rows never establish
    /// local authority and therefore cannot make a later replay overwrite local facts.
    fn has_authoritative_local_events(&self, owner_key: &str) -> Result<bool, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM canonical_events
                WHERE owner_key = ?1
                  AND provenance_origin = 'local-observed'
                  AND provenance_trust = 'authoritative'
            )",
            params![owner_key],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(EventError::from)
    }

    /// 游标分页：返回 sequence < before_seq 的最新 limit 条（升序，无 OFFSET）。
    /// before_seq = None 取最新一页；上页最旧一条的 sequence 为下一页游标。
    pub(crate) fn list_events(
        &self,
        owner_key: &str,
        before_sequence: Option<i64>,
        limit: u32,
    ) -> Result<EventPage, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let mut stmt = conn
            .prepare(
                "SELECT event_id, owner_key, profile_id, agent_id, local_session_id,
                        remote_session_id, client_generation, sequence, occurred_at,
                        received_at, event_type, payload_version, identity, typed_payload,
                        raw_payload, created_at, schema_version, provenance_origin, provenance_trust,
                        provenance_provider, provenance_import_id, raw_truncated, raw_original_bytes,
                        raw_retained_bytes, raw_omitted_bytes, raw_truncation_reason
                 FROM canonical_events
                 WHERE owner_key = ?1 AND (?2 IS NULL OR sequence < ?2)
                 ORDER BY sequence DESC
                 LIMIT ?3",
            )
            .map_err(EventError::from)?;
        let rows = stmt
            .query_map(
                params![owner_key, before_sequence, i64::from(limit)],
                |row| {
                    let identity: Option<String> = row.get(12)?;
                    let typed: Option<String> = row.get(13)?;
                    let raw: String = row.get(14)?;
                    Ok(StoredCanonicalEventRow {
                        event: CanonicalEventRow {
                            event_id: row.get(0)?,
                            owner_key: row.get(1)?,
                            profile_id: row.get(2)?,
                            agent_id: row.get(3)?,
                            local_session_id: row.get(4)?,
                            remote_session_id: row.get(5)?,
                            client_generation: row.get(6)?,
                            sequence: row.get(7)?,
                            occurred_at: row.get(8)?,
                            received_at: row.get(9)?,
                            event_type: row.get(10)?,
                            payload_version: row.get(11)?,
                            identity: None,
                            typed_payload: None,
                            raw_payload: serde_json::Value::Null,
                            created_at: row.get(15)?,
                            schema_version: row.get(16)?,
                            provenance_origin: row.get(17)?,
                            provenance_trust: row.get(18)?,
                            provenance_provider: row.get(19)?,
                            provenance_import_id: row.get(20)?,
                            raw_truncated: row.get::<_, i64>(21)? != 0,
                            raw_original_bytes: row.get(22)?,
                            raw_retained_bytes: row.get(23)?,
                            raw_omitted_bytes: row.get(24)?,
                            raw_truncation_reason: row.get(25)?,
                        },
                        identity_json: identity,
                        typed_payload_json: typed,
                        raw_payload_json: raw,
                    })
                },
            )
            .map_err(EventError::from)?;
        let mut events: Vec<CanonicalEventRow> = Vec::new();
        for row in rows {
            events.push(row.map_err(EventError::from)?.decode()?);
        }
        // DESC 查询 → 升序返回（与历史消息仓库分页语义一致；v9 后为 canonical 唯一读路径）
        events.reverse();
        let next_before_sequence = events.first().map(|e| e.sequence);
        Ok(EventPage {
            events,
            next_before_sequence,
        })
    }

    pub(crate) fn export_raw_event(
        &self,
        event_id: &str,
    ) -> Result<Option<CanonicalEventRawExport>, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        conn.query_row(
            "SELECT event_id, owner_key, sequence, event_type, identity, typed_payload, raw_payload
             FROM canonical_events WHERE event_id = ?1",
            params![event_id],
            |row| {
                Ok(CanonicalEventRawExport {
                    event_id: row.get(0)?,
                    owner_key: row.get(1)?,
                    sequence: row.get(2)?,
                    event_type: row.get(3)?,
                    identity_json: row.get(4)?,
                    typed_payload_json: row.get(5)?,
                    raw_payload_json: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(EventError::from)
    }

    /// B6：跨 owner 内容搜索——在 raw_payload / typed_payload / event_type 上做
    /// 大小写不敏感 LIKE，返回去重后的候选 owner（前端再对候选 owner loadAll +
    /// 消息投影 + 消息文本精确匹配）。limit 为候选 owner 上限。
    pub(crate) fn search_owners(
        &self,
        query: &str,
        limit: u32,
    ) -> Result<Vec<EventSearchOwner>, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let pattern = format!("%{query}%");
        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT profile_id, agent_id, local_session_id, remote_session_id
                 FROM canonical_events
                 WHERE event_type LIKE ?1 COLLATE NOCASE
                    OR raw_payload LIKE ?1 COLLATE NOCASE
                    OR COALESCE(typed_payload, '') LIKE ?1 COLLATE NOCASE
                 ORDER BY profile_id, agent_id, local_session_id
                 LIMIT ?2",
            )
            .map_err(EventError::from)?;
        let rows = stmt
            .query_map(params![pattern, i64::from(limit)], |row| {
                Ok(EventSearchOwner {
                    profile_id: row.get(0)?,
                    agent_id: row.get(1)?,
                    local_session_id: row.get(2)?,
                    remote_session_id: row.get(3)?,
                })
            })
            .map_err(EventError::from)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(EventError::from)?);
        }
        Ok(out)
    }
}

/// 事件仓库 service：spawn_blocking 边界 + DTO 透传（镜像 MessageService）。
pub(crate) struct EventService {
    repo: Arc<EventRepo>,
}

impl EventService {
    /// 打开（或创建）生产仓库并迁移到最新 schema。调用方须先创建 DB 父目录；
    /// 失败返回 Err——启动路径不得静默回退。
    pub(crate) fn open_db(path: &Path) -> Result<EventService, EventError> {
        let repo = EventRepo::open(path)?;
        Ok(EventService {
            repo: Arc::new(repo),
        })
    }

    /// 内存仓库（测试用）。
    #[allow(dead_code)] // 测试用内存服务
    pub(crate) fn in_memory() -> Result<EventService, EventError> {
        let repo = EventRepo::open_in_memory()?;
        Ok(EventService {
            repo: Arc::new(repo),
        })
    }

    /// 校验 + 批量 append（spawn_blocking 边界）。输入为前端 EVT-01 schema JSON。
    pub(crate) async fn append_events(
        &self,
        input: Vec<serde_json::Value>,
        expected_revision: Option<i64>,
    ) -> Result<EventAppendResult, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            let events = input
                .iter()
                .map(parse_canonical_event)
                .collect::<Result<Vec<_>, _>>()?;
            repo.append_events(&events, expected_revision)
        })
        .await
        .map_err(|error| {
            EventError::Unavailable(format!("event repo append task failed: {error}"))
        })?
    }

    /// Kernel ingest boundary：sequence/revision 在 repository transaction 内分配，
    /// 返回 committed row，供 dispatcher 在 durable append 后发布 projection。
    pub(crate) async fn ingest_event(
        &self,
        owner: DurableSessionOwner,
        remote_session_id: Option<String>,
        client_generation: u64,
        raw_payload: serde_json::Value,
    ) -> Result<EventAppendResult, EventError> {
        let client_generation = i64::try_from(client_generation)
            .map_err(|_| EventError::Invalid("client generation exceeds i64".into()))?;
        let input = KernelEventInput {
            owner,
            remote_session_id,
            client_generation,
            received_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            raw_payload,
            recovery_import: false,
        };
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.ingest_kernel_event(input))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("kernel event ingest task failed: {error}"))
            })?
    }

    /// Import a complete session/load replay into the single owner journal. Only an empty journal
    /// may be imported. Any trusted local observation wins; a revision race is treated as local
    /// authority (or an idempotent unverified import), never as permission to append a snapshot.
    pub(crate) async fn ingest_complete_replay(
        &self,
        owner: DurableSessionOwner,
        remote_session_id: Option<String>,
        client_generation: u64,
        raw_events: Vec<serde_json::Value>,
    ) -> Result<ReplayJournalIngestResult, EventError> {
        let client_generation = i64::try_from(client_generation)
            .map_err(|_| EventError::Invalid("client generation exceeds i64".into()))?;
        let received_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            let owner_key = owner
                .key()
                .map_err(|error| EventError::Invalid(error.to_string()))?;
            if repo.has_authoritative_local_events(&owner_key)? {
                return Ok(ReplayJournalIngestResult {
                    events: Vec::new(),
                    revision: repo.revision(&owner_key)?,
                    status: "local-authoritative",
                });
            }
            let replay_events = raw_events
                .into_iter()
                .map(|raw| mark_replay_import(&owner, raw))
                .collect::<Vec<_>>();
            if replay_events.is_empty() {
                let owner_key = owner
                    .key()
                    .map_err(|error| EventError::Invalid(error.to_string()))?;
                let revision = repo.revision(&owner_key)?;
                return Ok(ReplayJournalIngestResult {
                    events: Vec::new(),
                    revision,
                    status: if revision == 0 { "empty" } else { "already-imported" },
                });
            }
            let mut events = Vec::with_capacity(replay_events.len());
            for (index, raw_payload) in replay_events.iter().cloned().enumerate() {
                events.push(normalize_kernel_event(
                    KernelEventInput {
                        owner: owner.clone(),
                        remote_session_id: remote_session_id.clone(),
                        client_generation,
                        received_at: received_at.clone(),
                        raw_payload,
                        recovery_import: true,
                    },
                    i64::try_from(index + 1).map_err(|_| {
                        EventError::Invalid("replay event count exceeds i64".into())
                    })?,
                )?);
            }
            match repo.append_events(&events, Some(0)) {
                Ok(result) => Ok(ReplayJournalIngestResult {
                    events: result.events,
                    revision: result.revision,
                    status: "imported",
                }),
                Err(EventError::RevisionConflict { .. }) => {
                    let local_authority = repo.has_authoritative_local_events(&owner_key)?;
                    Ok(ReplayJournalIngestResult {
                        events: Vec::new(),
                        revision: repo.revision(&owner_key)?,
                        status: if local_authority {
                            "local-authoritative"
                        } else {
                            "already-imported"
                        },
                    })
                }
                Err(error) => Err(error),
            }
        })
        .await
        .map_err(|error| {
            EventError::Unavailable(format!("replay event ingest task failed: {error}"))
        })?
    }

    /// owner 当前 revision（MAX(sequence)，空 = 0）。
    pub(crate) async fn revision(&self, owner_key: String) -> Result<i64, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.revision(&owner_key))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo revision task failed: {error}"))
            })?
    }

    /// Read-only authority probe used before deciding how an incomplete replay may be surfaced.
    /// It deliberately ignores recovery-import rows: only durable local observations establish
    /// the local journal as the load authority.
    pub(crate) async fn has_authoritative_local_events(
        &self,
        owner_key: String,
    ) -> Result<bool, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.has_authoritative_local_events(&owner_key))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo authority task failed: {error}"))
            })?
    }

    /// 游标分页读取（最新页 before_seq=null；limit 缺省 100）。
    pub(crate) async fn list_events(
        &self,
        owner_key: String,
        before_sequence: Option<i64>,
        limit: u32,
    ) -> Result<EventPage, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.list_events(&owner_key, before_sequence, limit))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo list task failed: {error}"))
            })?
    }

    pub(crate) async fn export_raw_event(
        &self,
        event_id: String,
    ) -> Result<Option<CanonicalEventRawExport>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.export_raw_event(&event_id))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event raw export task failed: {error}"))
            })?
    }

    /// B6：跨 owner 内容搜索候选（前端消息级精确过滤的第二阶段数据源）。
    pub(crate) async fn search_owners(
        &self,
        query: String,
        limit: u32,
    ) -> Result<Vec<EventSearchOwner>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.search_owners(&query, limit))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo search task failed: {error}"))
            })?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个合法的 canonical 事件 JSON（EVT-01 schema 形状）。
    fn event_json(
        agent_id: &str,
        local_session_id: &str,
        sequence: i64,
        event_type: &str,
        raw: serde_json::Value,
    ) -> serde_json::Value {
        let owner_key = serde_json::to_string(&["p1", agent_id, local_session_id]).unwrap();
        serde_json::json!({
            "eventId": format!("{owner_key}#{sequence}"),
            "owner": {
                "profileId": "p1",
                "agentId": agent_id,
                "localSessionId": local_session_id,
                "remoteSessionId": "remote-1",
            },
            "clientGeneration": 5,
            "sequence": sequence,
            "occurredAt": "2026-08-14T00:00:00.000Z",
            "receivedAt": "2026-08-14T00:00:00.000Z",
            "eventType": event_type,
            "payloadVersion": 1,
            "rawPayload": raw,
        })
    }

    fn repo() -> EventRepo {
        EventRepo::open_in_memory().expect("open in-memory")
    }

    fn kernel_input(raw_payload: serde_json::Value) -> KernelEventInput {
        KernelEventInput {
            owner: DurableSessionOwner::new("p1", "peri", "local:s1"),
            remote_session_id: Some("remote-1".to_string()),
            client_generation: 5,
            received_at: "2026-08-20T00:00:00.000Z".to_string(),
            raw_payload,
            recovery_import: false,
        }
    }

    #[test]
    fn kernel_ingest_normalizes_with_the_existing_canonical_contract() {
        let repo = repo();
        let raw = serde_json::json!({
            "source": "local:s1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "root-tool",
                "content": { "toolCallId": "content-tool" },
                "title": "Write",
                "kind": "edit",
                "status": "completed",
                "rawOutput": { "ok": true }
            }
        });

        let result = repo
            .ingest_kernel_event(kernel_input(raw.clone()))
            .expect("ingest");
        let event = &result.events[0];

        assert_eq!(result.revision, 1);
        assert_eq!(event.sequence, 1);
        assert_eq!(event.event_type, "tool.call.completed");
        assert_eq!(event.identity.as_ref().unwrap()["toolCallId"], "root-tool");
        assert_eq!(
            event.typed_payload.as_ref().unwrap()["tool"]["title"],
            "Write"
        );
        assert_eq!(
            event.typed_payload.as_ref().unwrap()["tool"]["rawOutput"]["ok"],
            true
        );
        assert_eq!(event.raw_payload, raw);
    }

    #[test]
    fn kernel_ingest_keeps_unknown_and_malformed_raw_payloads() {
        let repo = repo();
        let malformed = serde_json::json!({ "unexpected": [1, 2, 3] });

        let result = repo
            .ingest_kernel_event(kernel_input(malformed.clone()))
            .expect("ingest malformed raw");
        let event = &result.events[0];

        assert_eq!(event.event_type, "unknown");
        assert_eq!(event.typed_payload, None);
        assert_eq!(event.raw_payload, malformed);
    }

    #[test]
    fn kernel_ingest_does_not_accept_caller_provenance_spoof() {
        let repo = repo();
        let result = repo
            .ingest_kernel_event(kernel_input(serde_json::json!({
                "source": "local:s1",
                "provenance": { "origin": "recovery-import", "trust": "authoritative", "provider": "spoof" },
                "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "live" } }
            })))
            .expect("ingest");
        let event = &result.events[0];
        assert_eq!(event.schema_version, 1);
        assert_eq!(event.provenance_origin, "local-observed");
        assert_eq!(event.provenance_trust, "authoritative");
        assert_eq!(event.provenance_provider.as_deref(), Some("peri"));
    }

    #[test]
    fn kernel_ingest_records_raw_truncation_metadata_without_losing_event_identity() {
        let repo = repo();
        let large = "x".repeat(70 * 1024);
        let result = repo
            .ingest_kernel_event(kernel_input(serde_json::json!({
                "source": "local:s1",
                "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "kept" } },
                "large": large,
            })))
            .expect("ingest");
        let event = &result.events[0];
        assert!(event.raw_truncated);
        assert!(event.raw_original_bytes > event.raw_retained_bytes);
        assert_eq!(event.raw_omitted_bytes, event.raw_original_bytes - event.raw_retained_bytes);
        assert_eq!(event.raw_truncation_reason.as_deref(), Some("size"));
        assert_eq!(event.typed_payload.as_ref().unwrap()["text"], "kept");
        assert_eq!(event.event_id, "[\"p1\",\"peri\",\"local:s1\"]#1");
    }

    #[test]
    fn kernel_ingest_allocates_after_existing_frontend_revision() {
        let repo = repo();
        let existing = parse_canonical_event(&event_json(
            "peri",
            "local:s1",
            5,
            "assistant.text.delta",
            serde_json::json!({ "old": true }),
        ))
        .unwrap();
        repo.append_events(&[existing], None).unwrap();

        let result = repo
            .ingest_kernel_event(kernel_input(serde_json::json!({
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": "next" }
                }
            })))
            .expect("ingest after existing history");

        assert_eq!(result.revision, 6);
        assert_eq!(result.events[0].sequence, 6);
        assert_eq!(result.events[0].event_type, "assistant.text.delta");
        assert_eq!(
            result.events[0].typed_payload.as_ref().unwrap()["text"],
            "next"
        );
    }

    #[tokio::test]
    async fn complete_replay_imports_atomically_only_into_an_empty_journal() {
        let service = EventService::in_memory().expect("event service");
        let owner = DurableSessionOwner::new("p1", "peri", "local:s1");
        let replay = vec![
            serde_json::json!({
                "sessionId": "remote-1",
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "text": "persona\n\n---\n\nquestion" }
                }
            }),
            serde_json::json!({
                "sessionId": "remote-1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": "answer" }
                }
            }),
        ];

        let imported = service
            .ingest_complete_replay(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                replay.clone(),
            )
            .await
            .expect("first import");
        assert_eq!(imported.revision, 2);
        assert_eq!(imported.status, "imported");
        assert_eq!(
            imported
                .events
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            vec!["user.message", "assistant.text.delta"]
        );
        assert_eq!(
            imported.events[0].typed_payload.as_ref().unwrap()["text"],
            "question"
        );
        assert_eq!(imported.events[0].raw_payload["sessionId"], "remote-1");
        assert_eq!(
            imported.events[0].raw_payload["update"]["_meta"]["pylonReplayImport"],
            true
        );
        assert!(imported.events.iter().all(|event| {
            event.provenance_origin == "recovery-import"
                && event.provenance_trust == "unverified"
        }));
        let skipped = service
            .ingest_complete_replay(owner, Some("remote-1".to_string()), 7, replay)
            .await
            .expect("existing journal wins");
        assert!(skipped.events.is_empty());
        assert_eq!(skipped.revision, 2);
        assert_eq!(skipped.status, "already-imported");

        let empty_observation = service
            .ingest_complete_replay(
                DurableSessionOwner::new("p1", "peri", "local:s1"),
                Some("remote-1".to_string()),
                7,
                Vec::new(),
            )
            .await
            .expect("empty replay still reports the journal revision");
        assert!(empty_observation.events.is_empty());
        assert_eq!(empty_observation.revision, 2);
        assert_eq!(empty_observation.status, "already-imported");

        let empty_session = service
            .ingest_complete_replay(
                DurableSessionOwner::new("p1", "peri", "local:empty"),
                Some("remote-empty".to_string()),
                7,
                Vec::new(),
            )
            .await
            .expect("empty journal and replay");
        assert_eq!(empty_session.status, "empty");
        assert_eq!(empty_session.revision, 0);
        assert!(empty_session.events.is_empty());
    }

    #[tokio::test]
    async fn complete_replay_does_not_reconcile_a_partial_local_journal() {
        let service = EventService::in_memory().expect("event service");
        let owner = DurableSessionOwner::new("p1", "peri", "local:s1");
        service
            .ingest_event(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                serde_json::json!({
                    "source": "local:s1",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "partial" } }
                }),
            )
            .await
            .expect("partial live row");
        let replay = vec![serde_json::json!({
            "sessionId": "remote-1",
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "complete" } }
        })];

        let reconciled = service
            .ingest_complete_replay(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                replay.clone(),
            )
            .await
            .expect("reconcile partial journal");
        assert_eq!(reconciled.status, "local-authoritative");
        assert_eq!(reconciled.revision, 1);
        assert!(reconciled.events.is_empty());

        let repeated = service
            .ingest_complete_replay(owner, Some("remote-1".to_string()), 7, replay)
            .await
            .expect("same snapshot is idempotent");
        assert_eq!(repeated.status, "local-authoritative");
        assert_eq!(repeated.revision, 1);
        assert!(repeated.events.is_empty());
    }

    #[tokio::test]
    async fn local_journal_authority_never_imports_replay_or_snapshot() {
        let service = EventService::in_memory().expect("event service");
        let owner = DurableSessionOwner::new("p1", "peri", "local:local-wins");
        service
            .ingest_event(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                serde_json::json!({
                    "source": "local:local-wins",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "local" } }
                }),
            )
            .await
            .expect("local row");

        let result = service
            .ingest_complete_replay(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                vec![serde_json::json!({
                    "sessionId": "remote-1",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "replay" } }
                })],
            )
            .await
            .expect("local authority should short-circuit replay import");

        assert_eq!(result.status, "local-authoritative");
        assert!(result.events.is_empty());
        assert_eq!(result.revision, 1);

        let page = service
            .list_events(owner.key().expect("owner key"), None, 100)
            .await
            .expect("list local journal");
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].typed_payload.as_ref().unwrap()["text"], "local");
        assert!(page.events.iter().all(|event| event.event_type != "history.snapshot"));
    }

    #[tokio::test]
    async fn untrusted_existing_rows_never_trigger_snapshot_reconciliation() {
        let service = EventService::in_memory().expect("event service");
        let owner = DurableSessionOwner::new("p1", "peri", "local:untrusted");
        service
            .append_events(
                vec![event_json(
                    "peri",
                    "local:untrusted",
                    1,
                    "assistant.text.delta",
                    serde_json::json!({ "text": "forensic" }),
                )],
                None,
            )
            .await
            .expect("existing untrusted row");

        let result = service
            .ingest_complete_replay(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                vec![serde_json::json!({
                    "sessionId": "remote-1",
                    "update": { "sessionUpdate": "assistant_message_chunk", "content": { "text": "replay" } }
                })],
            )
            .await
            .expect("replay must remain non-destructive");
        assert_eq!(result.status, "already-imported");
        assert_eq!(result.revision, 1);
        assert!(result.events.is_empty());

        let page = service
            .list_events(owner.key().expect("owner key"), None, 100)
            .await
            .expect("list journal");
        assert_eq!(page.events.len(), 1);
        assert!(page.events.iter().all(|event| event.event_type != "history.snapshot"));
    }

    #[tokio::test]
    async fn partial_replay_does_not_fill_missing_user_turns_when_local_rows_exist() {
        let service = EventService::in_memory().expect("event service");
        let owner = DurableSessionOwner::new("p1", "peri", "local:s1");
        service
            .ingest_event(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                serde_json::json!({
                    "source": "local:s1",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "partial" } }
                }),
            )
            .await
            .expect("partial live row");
        let replay = vec![
            serde_json::json!({
                "sessionId": "remote-1",
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "text": "persona\n\n---\n\nquestion" }
                }
            }),
            serde_json::json!({
                "sessionId": "remote-1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": "answer" }
                }
            }),
        ];

        let reconciled = service
            .ingest_complete_replay(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                replay.clone(),
            )
            .await
            .expect("reconcile partial journal");
        assert_eq!(reconciled.status, "local-authoritative");
        assert_eq!(reconciled.revision, 1);
        assert!(reconciled.events.is_empty());
        let repeated = service
            .ingest_complete_replay(owner, Some("remote-1".to_string()), 7, replay)
            .await
            .expect("recovery is idempotent");
        assert_eq!(repeated.status, "local-authoritative");
        assert_eq!(repeated.revision, 1);
        assert!(repeated.events.is_empty());
    }

    #[tokio::test]
    async fn existing_snapshot_only_journal_is_not_repaired_when_local_authority_exists() {
        let service = EventService::in_memory().expect("event service");
        let owner = DurableSessionOwner::new("p1", "peri", "local:s1");
        service
            .ingest_event(
                owner.clone(),
                Some("remote-1".to_string()),
                7,
                serde_json::json!({
                    "source": "local:s1",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "answer" } }
                }),
            )
            .await
            .expect("partial live row");
        let replay = vec![
            serde_json::json!({
                "sessionId": "remote-1",
                "update": {
                    "sessionUpdate": "user_message_chunk",
                    "content": { "text": "question" }
                }
            }),
            serde_json::json!({
                "sessionId": "remote-1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": "answer" }
                }
            }),
        ];
        let marked_replay = replay
            .iter()
            .cloned()
            .map(|raw| mark_replay_import(&owner, raw))
            .collect::<Vec<_>>();
        let snapshot = parse_canonical_event(&event_json(
            "peri",
            "local:s1",
            2,
            "history.snapshot",
            serde_json::json!({
                "kind": "complete-session-replay",
                "replayEvents": marked_replay,
            }),
        ))
        .expect("snapshot row");
        service
            .repo
            .append_events(&[snapshot], Some(1))
            .expect("old snapshot-only row");

        let repaired = service
            .ingest_complete_replay(owner, Some("remote-1".to_string()), 7, replay)
            .await
            .expect("repair snapshot-only journal");
        assert_eq!(repaired.status, "local-authoritative");
        assert_eq!(repaired.revision, 2);
        assert!(repaired.events.is_empty());
    }

    #[tokio::test]
    async fn concurrent_kernel_ingest_allocates_one_contiguous_sequence() {
        let service = Arc::new(EventService::in_memory().expect("service"));
        let mut tasks = Vec::new();
        for index in 0..20 {
            let service = service.clone();
            tasks.push(tokio::spawn(async move {
                service
                    .ingest_event(
                        DurableSessionOwner::new("p1", "peri", "local:s1"),
                        Some("remote-1".to_string()),
                        5,
                        serde_json::json!({
                            "update": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": { "text": index.to_string() }
                            }
                        }),
                    )
                    .await
                    .expect("ingest")
                    .revision
            }));
        }
        let mut revisions = Vec::new();
        for task in tasks {
            revisions.push(task.await.unwrap());
        }
        revisions.sort_unstable();

        assert_eq!(revisions, (1..=20).collect::<Vec<_>>());
        assert_eq!(
            service
                .revision(serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap())
                .await
                .unwrap(),
            20
        );
    }

    #[test]
    fn fresh_db_has_canonical_events_table_and_version() {
        let repo = repo();
        let conn = repo.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, crate::session::msg_repo::SCHEMA_VERSION);
        let count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='canonical_events'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1, "v6 新库必须包含 canonical_events 表");
    }

    #[test]
    fn tombstoned_owner_append_rejected_events_kept() {
        // DEL-04：删除（tombstone）后迟到 evt_append 拒绝且不复活；已落盘事件留存。
        let repo = repo();
        let first = parse_canonical_event(&event_json(
            "peri",
            "s1",
            1,
            "user.message",
            serde_json::json!({"text": "before delete"}),
        ))
        .unwrap();
        repo.append_events(&[first.clone()], None)
            .expect("first append");
        let owner_key = first.owner_key.clone();
        {
            let conn = repo.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO deleted_sessions
                     (owner_key, session_id, owner_scope, deleted_at, state, deletion_revision)
                 VALUES (?1, 's1', 'exact', 1, 'deleted', 0)",
                params![owner_key],
            )
            .expect("insert tombstone");
        }
        let late = parse_canonical_event(&event_json(
            "peri",
            "s1",
            2,
            "user.message",
            serde_json::json!({"text": "late write"}),
        ))
        .unwrap();
        let error = repo
            .append_events(&[late], None)
            .expect_err("tombstone 必须拒绝迟到写");
        assert!(matches!(error, EventError::SessionDeleted(_)));
        assert_eq!(error.code(), "event_session_deleted");
        let page = repo.list_events(&owner_key, None, 10).unwrap();
        assert_eq!(page.events.len(), 1, "canonical_events 行不随删除清除");
        assert_eq!(page.events[0].sequence, 1);
        assert_eq!(repo.revision(&owner_key).unwrap(), 1);
    }

    #[test]
    fn exact_tombstone_does_not_block_another_owner_with_same_source() {
        let repo = repo();
        let deleted_key = serde_json::to_string(&["p1", "peri", "shared"]).unwrap();
        {
            let conn = repo.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO deleted_sessions
                     (owner_key, session_id, owner_scope, deleted_at, state, deletion_revision)
                 VALUES (?1, 'metadata-a', 'exact', 1, 'deleted', 0)",
                params![deleted_key],
            )
            .unwrap();
        }
        let other_owner = parse_canonical_event(&event_json(
            "vega",
            "shared",
            1,
            "user.message",
            serde_json::json!({"text": "independent"}),
        ))
        .unwrap();
        repo.append_events(&[other_owner], None)
            .expect("exact tombstone must not leak across owners");
    }

    #[test]
    fn legacy_tombstone_conservatively_blocks_all_owners_for_same_source() {
        let repo = repo();
        {
            let conn = repo.conn.lock().unwrap();
            conn.execute(
                "INSERT INTO deleted_sessions
                     (owner_key, session_id, owner_scope, deleted_at, state, deletion_revision)
                 VALUES ('[\"*\",\"*\",\"shared\"]', 'shared', 'legacy', 1, 'deleted', 0)",
                [],
            )
            .unwrap();
        }
        let late = parse_canonical_event(&event_json(
            "vega",
            "shared",
            1,
            "user.message",
            serde_json::json!({"text": "late"}),
        ))
        .unwrap();
        assert!(matches!(
            repo.append_events(&[late], None),
            Err(EventError::SessionDeleted(_))
        ));
    }

    #[test]
    fn search_owners_matches_content_case_insensitive_and_dedupes() {
        let repo = repo();
        let hit = parse_canonical_event(&event_json(
            "peri",
            "s1",
            1,
            "user.message",
            serde_json::json!({"text": "Needle in raw payload"}),
        ))
        .unwrap();
        let miss = parse_canonical_event(&event_json(
            "peri",
            "s2",
            1,
            "user.message",
            serde_json::json!({"text": "nothing here"}),
        ))
        .unwrap();
        repo.append_events(&[hit.clone(), hit.clone()], None)
            .expect("append hit");
        repo.append_events(&[miss], None).expect("append miss");

        let owners = repo.search_owners("NEEDLE", 10).unwrap();
        assert_eq!(owners.len(), 1, "内容匹配去重后只剩一个 owner");
        assert_eq!(owners[0].profile_id, "p1");
        assert_eq!(owners[0].agent_id, "peri");
        assert_eq!(owners[0].local_session_id, "s1");
        assert_eq!(owners[0].remote_session_id.as_deref(), Some("remote-1"));

        let none = repo.search_owners("absent-term", 10).unwrap();
        assert!(none.is_empty());
    }

    #[test]
    fn append_and_list_roundtrip_preserves_fields() {
        let repo = repo();
        let ev = event_json(
            "peri",
            "local:同名",
            1,
            "user.message",
            serde_json::json!({"text": "hi"}),
        );
        let result = repo
            .append_events(&[parse_canonical_event(&ev).unwrap()], None)
            .unwrap();
        assert_eq!(result.revision, 1);
        assert_eq!(result.events.len(), 1);
        let page = repo
            .list_events(&result.events[0].owner_key, None, 10)
            .unwrap();
        assert_eq!(page.events.len(), 1);
        let row = &page.events[0];
        assert_eq!(row.event_type, "user.message");
        assert_eq!(row.sequence, 1);
        assert_eq!(row.raw_payload, serde_json::json!({"text": "hi"}));
        assert_eq!(row.local_session_id, "local:同名");
        assert_eq!(row.remote_session_id.as_deref(), Some("remote-1"));
        assert_eq!(row.client_generation, 5);
        assert_eq!(row.payload_version, 1);
        assert!(row.occurred_at.starts_with("2026-08-14"));
    }

    #[test]
    fn unknown_event_type_accepted_raw_payload_kept() {
        let repo = repo();
        let ev = event_json(
            "peri",
            "s1",
            1,
            "unknown",
            serde_json::json!({"future": "thing"}),
        );
        let result = repo
            .append_events(&[parse_canonical_event(&ev).unwrap()], None)
            .unwrap();
        let page = repo
            .list_events(&result.events[0].owner_key, None, 10)
            .unwrap();
        assert_eq!(page.events[0].event_type, "unknown");
        assert_eq!(
            page.events[0].raw_payload,
            serde_json::json!({"future": "thing"})
        );
    }

    #[test]
    fn corrupt_json_columns_fail_with_event_and_column_context() {
        for column in ["identity", "typed_payload", "raw_payload"] {
            let repo = repo();
            let row = parse_canonical_event(&event_json(
                "peri",
                "s1",
                1,
                "user.message",
                serde_json::json!({"text": "kept"}),
            ))
            .expect("event");
            repo.append_events(&[row.clone()], None).expect("append");
            repo.conn
                .lock()
                .unwrap()
                .execute(
                    &format!(
                        "UPDATE canonical_events SET {column} = '{{broken' WHERE event_id = ?1"
                    ),
                    params![row.event_id],
                )
                .expect("inject malformed JSON");

            let error = repo
                .list_events(&row.owner_key, None, 10)
                .expect_err("malformed JSON must not normalize to null/none");
            assert_eq!(error.code(), "event_repo_corrupt");
            let message = error.to_string();
            assert!(message.contains(&format!("event={}", row.event_id)));
            assert!(message.contains(&format!("column={column}")));
            assert!(
                !message.contains("kept"),
                "diagnostic must not leak payload content"
            );
            let exported = repo
                .export_raw_event(&row.event_id)
                .expect("raw export")
                .expect("corrupt row remains isolatable");
            let corrupt_value = match column {
                "identity" => exported.identity_json.as_deref(),
                "typed_payload" => exported.typed_payload_json.as_deref(),
                _ => Some(exported.raw_payload_json.as_str()),
            };
            assert_eq!(corrupt_value, Some("{broken"));
        }
    }

    #[test]
    fn duplicate_event_id_idempotent() {
        let repo = repo();
        let ev = event_json(
            "peri",
            "s1",
            1,
            "user.message",
            serde_json::json!({"text": "x"}),
        );
        repo.append_events(&[parse_canonical_event(&ev).unwrap()], None)
            .unwrap();
        // 同 event_id 重复写入 → 跳过不报错、不新增行
        let result = repo
            .append_events(&[parse_canonical_event(&ev).unwrap()], Some(1))
            .unwrap();
        assert_eq!(result.events.len(), 0, "去重后无新增行");
        let page = repo
            .list_events(
                &result.events.first().map_or_else(
                    || "[\"p1\",\"peri\",\"s1\"]".to_string(),
                    |e| e.owner_key.clone(),
                ),
                None,
                10,
            )
            .unwrap();
        assert_eq!(page.events.len(), 1);
    }

    #[test]
    fn double_agent_same_source_sequences_isolated() {
        let repo = repo();
        let a1 = event_json(
            "peri",
            "local:同名",
            1,
            "user.message",
            serde_json::json!({"a": 1}),
        );
        let b1 = event_json(
            "hermes",
            "local:同名",
            1,
            "user.message",
            serde_json::json!({"b": 1}),
        );
        let a_row = parse_canonical_event(&a1).unwrap();
        let b_row = parse_canonical_event(&b1).unwrap();
        assert_ne!(
            a_row.owner_key, b_row.owner_key,
            "双 Agent 同名 source → owner key 隔离"
        );
        repo.append_events(&[a_row.clone()], None).unwrap();
        repo.append_events(&[b_row.clone()], None).unwrap();
        let page_a = repo.list_events(&a_row.owner_key, None, 10).unwrap();
        let page_b = repo.list_events(&b_row.owner_key, None, 10).unwrap();
        assert_eq!(page_a.events.len(), 1);
        assert_eq!(page_b.events.len(), 1);
        assert_eq!(repo.revision(&a_row.owner_key).unwrap(), 1);
        assert_eq!(repo.revision(&b_row.owner_key).unwrap(), 1);
    }

    #[test]
    fn sequence_monotonic_within_owner_revision_tracks_max() {
        let repo = repo();
        let e1 = event_json("peri", "s1", 1, "user.message", serde_json::json!({"n": 1}));
        let e2 = event_json(
            "peri",
            "s1",
            2,
            "tool.call.started",
            serde_json::json!({"n": 2}),
        );
        let r1 = parse_canonical_event(&e1).unwrap();
        let r2 = parse_canonical_event(&e2).unwrap();
        repo.append_events(&[r1.clone()], None).unwrap();
        repo.append_events(&[r2.clone()], None).unwrap();
        assert_eq!(repo.revision(&r1.owner_key).unwrap(), 2);
        let page = repo.list_events(&r1.owner_key, None, 10).unwrap();
        let seqs: Vec<i64> = page.events.iter().map(|e| e.sequence).collect();
        assert_eq!(seqs, vec![1, 2], "升序返回");
        // 旧 expected_revision 落后 → conflict，不写任何行
        let e3 = event_json("peri", "s1", 3, "turn.completed", serde_json::json!({}));
        let err = repo
            .append_events(&[parse_canonical_event(&e3).unwrap()], Some(1))
            .unwrap_err();
        assert!(matches!(
            err,
            EventError::RevisionConflict {
                expected: 1,
                actual: 2
            }
        ));
        let page = repo.list_events(&r1.owner_key, None, 10).unwrap();
        assert_eq!(page.events.len(), 2, "冲突后无新行写入");
    }

    #[test]
    fn cursor_paging_no_offset() {
        let repo = repo();
        let mut rows = Vec::new();
        for i in 1..=5 {
            let ev = event_json("peri", "s1", i, "user.message", serde_json::json!({"i": i}));
            rows.push(parse_canonical_event(&ev).unwrap());
        }
        repo.append_events(&rows, None).unwrap();
        let owner = &rows[0].owner_key;
        // 最新一页：seq 4,5（升序）
        let page1 = repo.list_events(owner, None, 2).unwrap();
        let seqs1: Vec<i64> = page1.events.iter().map(|e| e.sequence).collect();
        assert_eq!(seqs1, vec![4, 5]);
        // 游标 = 上页最旧 seq（4）→ 翻旧一页 2,3
        let page2 = repo
            .list_events(owner, page1.next_before_sequence, 2)
            .unwrap();
        let seqs2: Vec<i64> = page2.events.iter().map(|e| e.sequence).collect();
        assert_eq!(seqs2, vec![2, 3]);
        // 再翻：仅剩 1
        let page3 = repo
            .list_events(owner, page2.next_before_sequence, 2)
            .unwrap();
        let seqs3: Vec<i64> = page3.events.iter().map(|e| e.sequence).collect();
        assert_eq!(seqs3, vec![1]);
        assert_eq!(page3.next_before_sequence, Some(1));
        let page4 = repo
            .list_events(owner, page3.next_before_sequence, 2)
            .unwrap();
        assert!(page4.events.is_empty());
        assert_eq!(page4.next_before_sequence, None);
    }

    #[test]
    fn malformed_input_rejected_not_silently_dropped() {
        let repo = repo();
        // 非对象
        assert!(matches!(
            parse_canonical_event(&serde_json::json!("raw")),
            Err(EventError::Invalid(_))
        ));
        // 缺 owner
        let missing_owner = serde_json::json!({
            "eventId": "[\"p1\",\"peri\",\"s1\"]#1",
            "clientGeneration": 0, "sequence": 1,
            "occurredAt": "2026-08-14T00:00:00.000Z", "receivedAt": "2026-08-14T00:00:00.000Z",
            "eventType": "user.message", "payloadVersion": 1, "rawPayload": {}
        });
        assert!(matches!(
            parse_canonical_event(&missing_owner),
            Err(EventError::Invalid(msg)) if msg.contains("owner")
        ));
        // sequence 0
        let seq0 = event_json("peri", "s1", 0, "user.message", serde_json::json!({}));
        assert!(matches!(
            parse_canonical_event(&seq0),
            Err(EventError::Invalid(msg)) if msg.contains("sequence")
        ));
        // eventId 与推导不一致（改内容但同 id → 不依赖 content，但 id 本身错）
        let mut mismatched = event_json("peri", "s1", 2, "user.message", serde_json::json!({}));
        if let Some(id) = mismatched.get_mut("eventId") {
            *id = serde_json::json!("[\"p1\",\"peri\",\"s1\"]#9");
        }
        assert!(matches!(
            parse_canonical_event(&mismatched),
            Err(EventError::Invalid(msg)) if msg.contains("eventId")
        ));
        // 缺 rawPayload → 拒绝（不得静默丢弃）
        let mut no_raw = event_json("peri", "s1", 3, "unknown", serde_json::json!({}));
        if let serde_json::Value::Object(map) = &mut no_raw {
            map.remove("rawPayload");
        }
        assert!(matches!(
            parse_canonical_event(&no_raw),
            Err(EventError::Invalid(msg)) if msg.contains("rawPayload")
        ));
        // 跨 owner 混批拒绝
        let a = parse_canonical_event(&event_json(
            "peri",
            "s1",
            1,
            "user.message",
            serde_json::json!({}),
        ))
        .unwrap();
        let b = parse_canonical_event(&event_json(
            "hermes",
            "s1",
            1,
            "user.message",
            serde_json::json!({}),
        ))
        .unwrap();
        let err = repo.append_events(&[a, b], None).unwrap_err();
        assert!(matches!(err, EventError::Invalid(_)));
    }

    #[test]
    fn fresh_db_migration_includes_table_after_reopen() {
        // 复用 msg_repo 的迁移链：打开内存仓库验证 v6 表存在（迁移测试见 msg_repo tests）
        let path = std::env::temp_dir().join(format!(
            "pylon-evt-test-{}-{}.db",
            std::process::id(),
            now_millis()
        ));
        {
            let repo = EventRepo::open(&path).expect("open");
            let conn = repo.conn.lock().unwrap();
            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(version, crate::session::msg_repo::SCHEMA_VERSION);
            for column in [
                "schema_version",
                "provenance_origin",
                "provenance_trust",
                "provenance_provider",
                "provenance_import_id",
                "raw_truncated",
                "raw_original_bytes",
                "raw_retained_bytes",
                "raw_omitted_bytes",
                "raw_truncation_reason",
            ] {
                let present: bool = conn
                    .prepare("SELECT 1 FROM pragma_table_info('canonical_events') WHERE name = ?1")
                    .unwrap()
                    .query_row([column], |_| Ok(true))
                    .optional()
                    .unwrap()
                    .unwrap_or(false);
                assert!(present, "v13 canonical_events 缺少列 {column}");
            }
        }
        // 重开幂等
        {
            let repo = EventRepo::open(&path).expect("reopen");
            let conn = repo.conn.lock().unwrap();
            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(version, crate::session::msg_repo::SCHEMA_VERSION);
        }
        let _ = std::fs::remove_file(&path);
    }
}
