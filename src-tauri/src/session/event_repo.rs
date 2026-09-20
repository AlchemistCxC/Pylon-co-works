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
    /// raw_payload 的入库序列化文本（与 `raw_payload.to_string()` 逐字节相等）。
    /// 写路径由 retain_raw_payload 直接产出复用（INSERT 免二次序列化）；
    /// 读路径承接 raw_payload_json 列原文。不入 wire（serde skip）。
    #[serde(skip)]
    pub(crate) raw_payload_json: String,
    /// #81 L2/L3：turn.unit 行的覆盖跨度（其余事件为 NULL）。裁剪迁移的查询列。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rollup_seq_start: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rollup_seq_end: Option<i64>,
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
        // 承接列原文作为入库文本缓存（读路径不重新序列化）。
        self.event.raw_payload_json = std::mem::take(&mut self.raw_payload_json);
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

// ── #155 T2（v15）存储收窄：15 列 + 读侧派生 ─────────────────────────────────
// wire/EVT-01 的 28 字段契约不变；event_id/owner 分维列/schema_version/provenance
// 四字段/raw_* 截断计数不落库，读侧由 `owner_triple`/`provenance_parts`/
// `derive_raw_metadata` 派生（推导依据与勘察记录见 .agents/spec/155-t2-schema-rebuild.md）。

/// v15：provenance (origin, trust) 合法的五组合整数编码。`parse_canonical_event`
/// 已把组合钉死为 local-observed ⇔ authoritative、其余 ⇔ unverified。
const PROVENANCE_LOCAL_OBSERVED: i64 = 0;
const PROVENANCE_RECOVERY_IMPORT: i64 = 1;
const PROVENANCE_OPTIMISTIC_LOCAL: i64 = 2;
const PROVENANCE_MIGRATION: i64 = 3;
const PROVENANCE_PLUGIN: i64 = 4;

fn provenance_code(origin: &str, trust: &str) -> i64 {
    match (origin, trust) {
        ("local-observed", "authoritative") => PROVENANCE_LOCAL_OBSERVED,
        ("recovery-import", "unverified") => PROVENANCE_RECOVERY_IMPORT,
        ("optimistic-local", "unverified") => PROVENANCE_OPTIMISTIC_LOCAL,
        ("migration", "unverified") => PROVENANCE_MIGRATION,
        ("plugin", "unverified") => PROVENANCE_PLUGIN,
        // 不可达（写入前已验证）；防御性归入 migration/unverified 保持读侧枚举合法。
        _ => PROVENANCE_MIGRATION,
    }
}

/// 读侧还原 wire provenance 四字段。provider/import_id 按组合派生：kernel 写入
/// provider 恒为 agent_id、recovery-import 的 importId 恒为 local_session_id
/// （全代码域唯一取值，2026-09-19 勘察）。
fn provenance_parts(
    code: i64,
    agent_id: &str,
    local_session_id: &str,
) -> (String, String, Option<String>, Option<String>) {
    match code {
        PROVENANCE_LOCAL_OBSERVED => (
            "local-observed".to_string(),
            "authoritative".to_string(),
            Some(agent_id.to_string()),
            None,
        ),
        PROVENANCE_RECOVERY_IMPORT => (
            "recovery-import".to_string(),
            "unverified".to_string(),
            Some(agent_id.to_string()),
            Some(local_session_id.to_string()),
        ),
        PROVENANCE_OPTIMISTIC_LOCAL => (
            "optimistic-local".to_string(),
            "unverified".to_string(),
            None,
            None,
        ),
        PROVENANCE_PLUGIN => ("plugin".to_string(), "unverified".to_string(), None, None),
        _ => (
            "migration".to_string(),
            "unverified".to_string(),
            None,
            None,
        ),
    }
}

/// owner 三元组自主键文本派生（owner_key = JSON 数组 [profile, agent, local]）。
/// 形状异常回退空串（与 TS `normalizeCanonicalEventRow` 对缺失 owner 的容错同向）。
fn owner_triple(owner_key: &str) -> (String, String, String) {
    serde_json::from_str::<Vec<String>>(owner_key)
        .ok()
        .and_then(|parts| {
            if parts.len() == 3 {
                Some((parts[0].clone(), parts[1].clone(), parts[2].clone()))
            } else {
                None
            }
        })
        .unwrap_or_default()
}

/// raw 截断元数据自 raw_payload 文本重算（wire 注释既有纪律：「截断信息由 rawPayload
/// 重算」）——截断 stub 自带 `_pylonTruncated`/`originalBytes`，retained = 入库文本长度。
/// 返回 (truncated, original_bytes, retained_bytes, omitted_bytes, reason)。
fn derive_raw_metadata(raw_payload_json: &str) -> (bool, i64, i64, i64, Option<String>) {
    let retained = raw_payload_json.len() as i64;
    let stub_original = serde_json::from_str::<serde_json::Value>(raw_payload_json)
        .ok()
        .filter(|value| {
            value
                .get("_pylonTruncated")
                .and_then(serde_json::Value::as_bool)
                == Some(true)
        })
        .and_then(|value| {
            value
                .get("originalBytes")
                .and_then(serde_json::Value::as_i64)
        });
    match stub_original {
        Some(original) => (
            true,
            original,
            retained,
            original.saturating_sub(retained),
            Some("size".to_string()),
        ),
        None => (false, retained, retained, 0, None),
    }
}

// 高频 SQL 常量：append/ingest 热路径共用同一 SQL 文本，
// 配合 Connection::prepare_cached 让语句只编译一次（缓存随连接存活）。
// 主键 (owner_key, sequence) 即去重键（v15 起无 event_id 列；eventId 由 rule 1 推导）。
const INSERT_EVENT_SQL: &str = "INSERT INTO canonical_events
     (owner_key, remote_session_id, sequence, client_generation, occurred_at,
      received_at, event_type, payload_version, identity, typed_payload,
      raw_payload, created_at, provenance)
 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
 ON CONFLICT(owner_key, sequence) DO NOTHING";
const TOMBSTONE_STATE_SQL: &str = "SELECT state FROM deleted_sessions
     WHERE owner_key = ?1 OR (session_id = ?2 AND owner_scope = 'legacy')
     LIMIT 1";
const MAX_SEQUENCE_SQL: &str = "SELECT MAX(sequence) FROM canonical_events WHERE owner_key = ?1";
/// #81 L2：终结边界查询（上一 turn 的 terminal/unit 最大 sequence）。
const LAST_TURN_BOUNDARY_SQL: &str = "SELECT COALESCE(MAX(sequence), 0) FROM canonical_events
     WHERE owner_key = ?1 AND event_type IN ('turn.completed', 'turn.failed', 'turn.unit') AND sequence < ?2";
/// v15 存储列序（list/compact/trim 三路共用；尾部 rollup 列为 turn.unit 专用）。
const EVENT_COLUMNS: &str = "owner_key, remote_session_id, sequence, client_generation, occurred_at, received_at, event_type, payload_version, identity, typed_payload, raw_payload, created_at, provenance, rollup_seq_start, rollup_seq_end";

/// v15 瘦身行写入（append/ingest/turn.unit 三路共用）：派生字段在 `map_event_row`
/// 读侧还原，这里只绑存储 15 列；rollup 覆盖跨度仅 turn.unit 行携带。
fn execute_insert_event(
    tx: &rusqlite::Transaction<'_>,
    event: &CanonicalEventRow,
    rollup: Option<(i64, i64)>,
) -> Result<usize, EventError> {
    let provenance = provenance_code(&event.provenance_origin, &event.provenance_trust);
    let identity = event.identity.as_ref().map(serde_json::Value::to_string);
    let typed_payload = event
        .typed_payload
        .as_ref()
        .map(serde_json::Value::to_string);
    match rollup {
        Some((rollup_seq_start, rollup_seq_end)) => tx
            .prepare_cached(
                "INSERT INTO canonical_events
                 (owner_key, remote_session_id, sequence, client_generation, occurred_at,
                  received_at, event_type, payload_version, identity, typed_payload,
                  raw_payload, created_at, provenance, rollup_seq_start, rollup_seq_end)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                 ON CONFLICT(owner_key, sequence) DO NOTHING",
            )
            .map_err(EventError::from)?
            .execute(params![
                event.owner_key,
                event.remote_session_id,
                event.sequence,
                event.client_generation,
                event.occurred_at,
                event.received_at,
                event.event_type,
                event.payload_version,
                identity,
                typed_payload,
                event.raw_payload_json,
                event.created_at,
                provenance,
                rollup_seq_start,
                rollup_seq_end,
            ])
            .map_err(EventError::from),
        None => tx
            .prepare_cached(INSERT_EVENT_SQL)
            .map_err(EventError::from)?
            .execute(params![
                event.owner_key,
                event.remote_session_id,
                event.sequence,
                event.client_generation,
                event.occurred_at,
                event.received_at,
                event.event_type,
                event.payload_version,
                identity,
                typed_payload,
                event.raw_payload_json,
                event.created_at,
                provenance,
            ])
            .map_err(EventError::from),
    }
}

fn is_journal_credential_key(key: &str, interaction_payload: bool) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if normalized.ends_with("redacted") {
        return false;
    }
    matches!(
        normalized.as_str(),
        "password" | "authorization" | "cookie" | "credential" | "credentials" | "tokenvalue"
    ) || normalized.ends_with("token")
        || normalized.ends_with("apikey")
        || normalized.ends_with("secret")
        || (interaction_payload && normalized == "value")
}

/// C12/DIC-C12-01：canonical journal 是 durable authority，credential 必须在 append
/// 之前递归替换为 omission metadata；projector/renderer 的后置遮挡不能补救落盘泄漏。
fn redact_journal_credentials(
    value: serde_json::Value,
    interaction_payload: bool,
) -> serde_json::Value {
    match value {
        serde_json::Value::Object(object) => {
            let nested_interaction = interaction_payload
                || object
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|kind| matches!(kind, "oauth" | "secret" | "sudo"));
            let nested_interaction = nested_interaction
                || object
                    .get("request")
                    .and_then(serde_json::Value::as_object)
                    .and_then(|request| request.get("kind"))
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|kind| matches!(kind, "oauth" | "secret" | "sudo"));
            let mut safe = serde_json::Map::new();
            for (key, child) in object {
                if is_journal_credential_key(&key, nested_interaction) {
                    if !child.is_null() && child != serde_json::Value::String(String::new()) {
                        safe.insert(format!("{key}Redacted"), serde_json::Value::Bool(true));
                    }
                    continue;
                }
                let sanitized = redact_journal_credentials(child, nested_interaction);
                safe.insert(key, sanitized);
            }
            serde_json::Value::Object(safe)
        }
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(|child| redact_journal_credentials(child, interaction_payload))
                .collect(),
        ),
        serde_json::Value::String(text) => {
            serde_json::Value::String(crate::sanitize::sanitize_value_content(&text))
        }
        other => other,
    }
}

/// 返回 (截断后的 raw_payload, 入库 JSON 文本, 截断标记, 字节统计…)。
/// 入库文本 = `raw_payload.to_string()`（serde_json 序列化确定 → 逐字节相等），
/// 调用方直接绑定 INSERT，免二次全量序列化；retained_bytes 统计复用同一文本。
fn retain_raw_payload(raw: serde_json::Value) -> (serde_json::Value, String, bool, i64, i64, i64) {
    let encoded = raw.to_string();
    let original = encoded.len() as i64;
    if encoded.len() <= MAX_CANONICAL_RAW_BYTES {
        return (raw, encoded, false, original, original, 0);
    }
    let preview_len = MAX_CANONICAL_RAW_BYTES.saturating_sub(96);
    let preview = encoded.chars().take(preview_len).collect::<String>();
    let retained = serde_json::json!({
        "_pylonTruncated": true,
        "preview": preview,
        "originalBytes": original,
    });
    let retained_encoded = retained.to_string();
    let retained_bytes = retained_encoded.len() as i64;
    (
        retained,
        retained_encoded,
        true,
        original,
        retained_bytes,
        original.saturating_sub(retained_bytes),
    )
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
    let provenance_provider = input.owner.agent_id.clone();
    let provenance_import_id = input.owner.local_session_id.clone();
    let owner_key = input
        .owner
        .key()
        .map_err(|error| EventError::Invalid(error.to_string()))?;
    // typed_payload/identity 提取必须看未脱敏原文（redact 只作用于入库 raw），
    // 因此先完成全部借用读取，再把 raw_payload move 进 redact（免整树 clone）。
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
        // Cancellation is a terminal turn failure with an explicit reason;
        // keep one canonical failure family instead of inventing a second
        // terminal event type that the semantic bridge cannot consume.
        Some("cancelled") => "turn.failed",
        Some("usage_update") => "usage.updated",
        Some("plan") => "plan.replaced",
        Some("current_mode_update") => "session.mode-updated",
        Some("session_info_update") => "session.model-updated",
        Some("config_option_update") => "session.config-updated",
        Some("available_commands_update") => "session.commands-updated",
        // #110 F7：`unknown` 归因。原先只落一个 "unknown" 死账——体检时 830 行
        // unknown 无法从库内归因，只能逐条反查 raw。现在把未识别的判别符与 update
        // 键集合打点，新形状一出现即可定位；raw 仍按 §5.10 原则 5 完整保留
        // （unknown 不静默丢弃，也不改写历史行）。
        _ => {
            tracing::warn!(
                target: "canonical_event",
                owner = %owner_key,
                discriminator = session_update.unwrap_or("<missing-update>"),
                update_keys = %update
                    .map(|map| map.keys().cloned().collect::<Vec<_>>().join(","))
                    .unwrap_or_default(),
                "unrecognized session/update discriminator: event recorded as 'unknown' with raw preserved"
            );
            "unknown"
        }
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
                    tool.insert(
                        canonical.to_string(),
                        redact_journal_credentials(value.clone(), false),
                    );
                }
            }
            typed_payload.insert("tool".to_string(), serde_json::Value::Object(tool));
        }
        if session_update == Some("error") || session_update == Some("cancelled") {
            if let Some(code) = non_empty_string(update.get("errorCode")) {
                typed_payload.insert("code".to_string(), serde_json::Value::String(code));
            }
            if let Some(error) = non_empty_string(update.get("error"))
                .or_else(|| non_empty_string(update.get("message")))
            {
                typed_payload.insert("error".to_string(), serde_json::Value::String(error));
            }
            if session_update == Some("cancelled") {
                typed_payload.insert(
                    "stopReason".to_string(),
                    serde_json::Value::String("cancelled".to_string()),
                );
            }
        }
        if session_update == Some("done") {
            for field in ["stopReason", "usage", "model"] {
                if let Some(value) = update.get(field) {
                    typed_payload.insert(field.to_string(), value.clone());
                }
            }
        }
        // #110 F5：`session_info_update` 的当前模型事实——`typed_payload.model` 是前端
        // `session.model-updated` 语义投影的唯一取值来源（与 P56/D2.3 同一组变体：
        // 嵌套 models.currentModelId camel/snake 优先，扁平 model 次之）。缺失则
        // journal 收不到模型事实，状态条只能退回兜底串。
        if session_update == Some("session_info_update") {
            let model = update
                .get("models")
                .and_then(serde_json::Value::as_object)
                .and_then(|models| {
                    [
                        "currentModelId",
                        "current_model_id",
                        "currentModel",
                        "current_model",
                        "current",
                    ]
                    .iter()
                    .find_map(|key| non_empty_string(models.get(*key)))
                })
                .or_else(|| non_empty_string(update.get("model")));
            if let Some(model) = model {
                typed_payload.insert("model".to_string(), serde_json::Value::String(model));
            }
        }
    }

    let identity = resolve_identity(update);
    // 借用已结束：原树 move 进 redact（纯函数，等价于原先的 clone 后重建，少一次整树拷贝）。
    let raw_for_storage = redact_journal_credentials(input.raw_payload, false);
    let (
        raw_payload,
        raw_payload_json,
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
    ) = retain_raw_payload(raw_for_storage);
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
        identity,
        typed_payload: (!typed_payload.is_empty()).then_some(redact_journal_credentials(
            serde_json::Value::Object(typed_payload),
            false,
        )),
        raw_payload,
        raw_payload_json,
        created_at: now_millis(),
        schema_version: 1,
        provenance_origin: if input.recovery_import {
            "recovery-import"
        } else {
            "local-observed"
        }
        .to_string(),
        provenance_trust: if input.recovery_import {
            "unverified"
        } else {
            "authoritative"
        }
        .to_string(),
        provenance_provider: Some(provenance_provider),
        provenance_import_id: input.recovery_import.then_some(provenance_import_id),
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
        raw_truncation_reason: raw_truncated.then(|| "size".to_string()),
        rollup_seq_start: None,
        rollup_seq_end: None,
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
    if !matches!(
        provenance_origin,
        "local-observed" | "optimistic-local" | "recovery-import" | "migration" | "plugin"
    ) {
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

    let event_type = event_type.expect("checked");
    let interaction_payload = event_type.starts_with("interaction.");
    let (
        raw_payload,
        raw_payload_json,
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
    ) = retain_raw_payload(redact_journal_credentials(
        obj.get("rawPayload")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        interaction_payload,
    ));

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
        event_type,
        payload_version: payload_version.expect("checked"),
        identity: obj.get("identity").cloned(),
        typed_payload: obj
            .get("typedPayload")
            .cloned()
            .map(|value| redact_journal_credentials(value, interaction_payload)),
        raw_payload,
        raw_payload_json,
        created_at: now_millis(),
        schema_version: obj
            .get("schemaVersion")
            .and_then(|v| v.as_i64())
            .unwrap_or(1),
        provenance_origin: provenance_origin.to_string(),
        provenance_trust: provenance_trust.to_string(),
        provenance_provider: obj
            .get("provenance")
            .and_then(|p| p.get("provider"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        provenance_import_id: obj
            .get("provenance")
            .and_then(|p| p.get("importId"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
        raw_truncation_reason: raw_truncated.then(|| "size".to_string()),
        rollup_seq_start: None,
        rollup_seq_end: None,
    })
}

/// `CanonicalEventRow` → EVT-01 canonical 事件 JSON（`parse_canonical_event` 的逆）。
///
/// #81 回归修复：turn 单元行的整行 segment 必须嵌入 canonical 事件（嵌套
/// `owner`/`provenance`），而不是数据库扁平列形状——前端唯一契约是嵌套 owner 的
/// canonical 事件，嵌入扁平行会绕过读边界的归一化。载荷因此自描述：任何读者
/// （前端展开、证据导出、未来消费者）拿到它都无需再猜落盘形状。
///
/// 不变量（由 `canonical_event_wire_round_trips_through_parse` 锁定）：
/// `parse_canonical_event(&canonical_event_wire(row))` 与原行逐字段相等，例外是
/// `created_at`（重取 now）与 `raw_*` 截断元数据：截断信息由 `rawPayload` 重算，
/// 已裁剪的载荷很短 ⇒ 重解析会报「未截断」。故 wire 显式携带 `rawMetadata`
/// （前端取证所需），但不指望它经 `parse_canonical_event` 往返（见
/// `canonical_event_wire_keeps_truncation_metadata_in_payload`）。
/// rollup 覆盖列属行存储细节，不属 EVT-01，故不输出。
pub(crate) fn canonical_event_wire(row: &CanonicalEventRow) -> serde_json::Value {
    let mut owner = serde_json::Map::new();
    owner.insert("profileId".into(), serde_json::json!(row.profile_id));
    owner.insert("agentId".into(), serde_json::json!(row.agent_id));
    owner.insert(
        "localSessionId".into(),
        serde_json::json!(row.local_session_id),
    );
    if let Some(remote) = &row.remote_session_id {
        owner.insert("remoteSessionId".into(), serde_json::json!(remote));
    }
    let mut provenance = serde_json::Map::new();
    provenance.insert("origin".into(), serde_json::json!(row.provenance_origin));
    provenance.insert("trust".into(), serde_json::json!(row.provenance_trust));
    if let Some(provider) = &row.provenance_provider {
        provenance.insert("provider".into(), serde_json::json!(provider));
    }
    if let Some(import_id) = &row.provenance_import_id {
        provenance.insert("importId".into(), serde_json::json!(import_id));
    }
    let mut raw_metadata = serde_json::Map::new();
    raw_metadata.insert("truncated".into(), serde_json::json!(row.raw_truncated));
    raw_metadata.insert(
        "originalBytes".into(),
        serde_json::json!(row.raw_original_bytes),
    );
    raw_metadata.insert(
        "retainedBytes".into(),
        serde_json::json!(row.raw_retained_bytes),
    );
    raw_metadata.insert(
        "omittedBytes".into(),
        serde_json::json!(row.raw_omitted_bytes),
    );
    if let Some(reason) = &row.raw_truncation_reason {
        raw_metadata.insert("reason".into(), serde_json::json!(reason));
    }
    let mut event = serde_json::Map::new();
    event.insert("eventId".into(), serde_json::json!(row.event_id));
    event.insert("owner".into(), serde_json::Value::Object(owner));
    event.insert(
        "clientGeneration".into(),
        serde_json::json!(row.client_generation),
    );
    event.insert("sequence".into(), serde_json::json!(row.sequence));
    event.insert("occurredAt".into(), serde_json::json!(row.occurred_at));
    event.insert("receivedAt".into(), serde_json::json!(row.received_at));
    event.insert("eventType".into(), serde_json::json!(row.event_type));
    event.insert(
        "payloadVersion".into(),
        serde_json::json!(row.payload_version),
    );
    event.insert(
        "schemaVersion".into(),
        serde_json::json!(row.schema_version),
    );
    if let Some(identity) = &row.identity {
        event.insert("identity".into(), identity.clone());
    }
    if let Some(typed) = &row.typed_payload {
        event.insert("typedPayload".into(), typed.clone());
    }
    event.insert("rawPayload".into(), row.raw_payload.clone());
    event.insert("provenance".into(), serde_json::Value::Object(provenance));
    event.insert(
        "rawMetadata".into(),
        serde_json::Value::Object(raw_metadata),
    );
    serde_json::Value::Object(event)
}

/// #205：读侧尾部折叠预算——与写侧 `canonicalEventBatch.CANONICAL_BATCH_LIMITS` 同口径
/// （48 KiB / 2000 chunk，落在 `retain_raw_payload` 的 64 KiB 截断线之内）。读侧不需要
/// 截断约束，沿用该预算只为产出「同一种 batch 行形状」，任何既有解析路径都认。
const MAX_FOLDED_CHUNKS: usize = 2000;
const MAX_FOLD_BYTES: usize = 48 * 1024;
/// #205：覆盖跨度进入 compact 读的 SQL 谓词（每跨度 2 个绑定参数）。超过此数退回整读
/// 后内存过滤——SQLite 对表达式深度/参数个数有上限，宁可慢也不要查询失败。
const MAX_COMPACT_SQL_RANGES: usize = 500;

/// 该行能否参与折叠：静态 delta 类型，且 `typed_payload.text` 是 string。
/// `.batch` 行不二次折叠。**text 门控与写侧同款**：无 string text 的 chunk 在逐行投影里
/// 该行承载了几个输入（写入侧配对用）：`*.delta.batch` 行按 `seqSpan` 宽度计，其余为 1。
///
/// 与 `mergeAdjacentDeltaChunks` 的跨度契约配套：span 内每一号都落在这唯一一行里，
/// 因此 dispatcher 把「一个输入一条结果」的配对改成「按跨度展开配对」。
pub(crate) fn row_input_span_width(row: &CanonicalEventRow) -> usize {
    if !row.event_type.ends_with(".batch") {
        return 1;
    }
    let span = row
        .typed_payload
        .as_ref()
        .and_then(|typed| typed.get("seqSpan"))
        .and_then(serde_json::Value::as_array);
    let Some(span) = span else { return 1 };
    let (Some(start), Some(end)) = (
        span.first().and_then(serde_json::Value::as_i64),
        span.get(1).and_then(serde_json::Value::as_i64),
    ) else {
        return 1;
    };
    if start < 1 || end < start || end != row.sequence {
        return 1;
    }
    usize::try_from(end - start + 1).unwrap_or(1)
}

/// 是 no-op（不新建消息），折进 batch 行会把 no-op 变成新建消息 ⇒ 破坏投影等价。
fn foldable_delta_base(row: &CanonicalEventRow) -> Option<&'static str> {
    if row.event_type.ends_with(".batch") {
        return None;
    }
    let base = super::turn_rollup::static_delta_type(&row.event_type)?;
    let has_text = row
        .typed_payload
        .as_ref()
        .and_then(|typed| typed.get("text"))
        .is_some_and(serde_json::Value::is_string);
    has_text.then_some(base)
}

/// identity 四键全等（与前端 `sameIdentity` 同口径：两边都缺失算相等，null 与缺失不等）。
fn identity_keys_equal(
    left: &Option<serde_json::Value>,
    right: &Option<serde_json::Value>,
) -> bool {
    const KEYS: [&str; 4] = ["messageId", "turnId", "toolCallId", "requestId"];
    KEYS.iter().all(|key| {
        match (
            left.as_ref().and_then(|value| value.get(*key)),
            right.as_ref().and_then(|value| value.get(*key)),
        ) {
            (None, None) => true,
            (Some(left), Some(right)) => left == right,
            _ => false,
        }
    })
}

/// 折叠预算按**入库序列化文本**计：`raw_payload_json` 与 `raw_payload.to_string()` 逐字节
/// 相等（v15 不变量），也正是前端 `encodedByteLength(JSON.stringify(raw))` 的口径——
/// 免掉逐行再序列化一次。
fn raw_payload_bytes(row: &CanonicalEventRow) -> usize {
    row.raw_payload_json.len()
}

/// run 收口：长度 < 2 原样放回（与写侧「单条 run 不合并」一致），≥ 2 产出 batch 行。
fn flush_delta_run(
    out: &mut Vec<CanonicalEventRow>,
    chunks: Vec<CanonicalEventRow>,
    base: Option<&'static str>,
) {
    let Some(base) = base else { return };
    if chunks.len() < 2 {
        out.extend(chunks);
        return;
    }
    let first_sequence = chunks[0].sequence;
    let last = chunks.last().expect("run is non-empty");
    let last_sequence = last.sequence;
    let last_event_id = last.event_id.clone();
    let folded_count = chunks.len();
    let mut row = chunks[0].clone();
    let mut text = String::new();
    let mut raw_items: Vec<serde_json::Value> = Vec::with_capacity(folded_count);
    for chunk in chunks {
        if let Some(part) = chunk
            .typed_payload
            .as_ref()
            .and_then(|typed| typed.get("text"))
            .and_then(serde_json::Value::as_str)
        {
            text.push_str(part);
        }
        raw_items.push(chunk.raw_payload);
    }
    row.event_type = format!("{base}.batch");
    // 跨度占用：行取段末的 sequence/eventId，段内编号不被任何行占用，读侧按
    // `owner#(seqSpan[0]+i)` 重建原始 id（`canonicalEventBatch` 的既有契约）。
    row.sequence = last_sequence;
    row.event_id = last_event_id;
    row.typed_payload = Some(serde_json::json!({
        "text": text,
        "foldedCount": folded_count,
        "seqSpan": [first_sequence, last_sequence],
    }));
    row.raw_payload = serde_json::Value::Array(raw_items);
    // 维持 v15 不变量：raw_payload_json == raw_payload.to_string()。
    row.raw_payload_json = row.raw_payload.to_string();
    row.rollup_seq_start = None;
    row.rollup_seq_end = None;
    out.push(row);
}

/// 相邻同类 delta 的行聚合（**读写两侧共用**；ADR-0016）：把 identity 全等、sequence 连续的
/// delta run 折成一条 `*.delta.batch` 行——span 占位，幸存行挪到跨度末位并带 `seqSpan`，
/// span 中间的裸行不再存在。形状与前端 `canonicalEventBatch.mergeAdjacentDeltaChunks` 同一契约，
/// `canonicalRowToWorkbench` 已有展开路径（逐 chunk 重建事件 id 与 coverage），故与逐行存储
/// **投影等价**。
///
/// - 读侧（#205）：compact 读过滤出「单元 + 未覆盖行」后调用，对存量 journal 立即生效；
/// - 写侧（ADR-0016 / #155 T3-1）：`ingest_kernel_events` 顺序折叠后落盘，行数随之下降。
///
/// 两侧共用同一实现与同一预算（48 KiB / 2000 chunk），不存在第二份规则。`evt_list` 分页读不折叠。
fn fold_adjacent_delta_runs(rows: Vec<CanonicalEventRow>) -> Vec<CanonicalEventRow> {
    let mut out: Vec<CanonicalEventRow> = Vec::with_capacity(rows.len());
    let mut run: Vec<CanonicalEventRow> = Vec::new();
    let mut run_base: Option<&'static str> = None;
    let mut run_bytes: usize = 0;
    for row in rows {
        let base = foldable_delta_base(&row);
        let extend = match (base, run.last(), run_base) {
            (Some(base), Some(last), Some(current)) => {
                current == base
                    && row.sequence == last.sequence + 1
                    && identity_keys_equal(&last.identity, &row.identity)
                    && run.len() < MAX_FOLDED_CHUNKS
                    && run_bytes + raw_payload_bytes(&row) <= MAX_FOLD_BYTES
            }
            _ => false,
        };
        if extend {
            run_bytes += raw_payload_bytes(&row);
            run.push(row);
            continue;
        }
        flush_delta_run(&mut out, std::mem::take(&mut run), run_base.take());
        run_bytes = 0;
        match base {
            // 单条自身就超预算的 delta 不成批（与写侧一致：不截断，原样保留）。
            Some(base) if raw_payload_bytes(&row) <= MAX_FOLD_BYTES => {
                run_bytes = raw_payload_bytes(&row);
                run_base = Some(base);
                run.push(row);
            }
            _ => out.push(row),
        }
    }
    flush_delta_run(&mut out, run, run_base);
    out
}

/// 事件行映射（v15 EVENT_COLUMNS 列序 → StoredCanonicalEventRow；list/compact/trim 共用）。
/// 派生字段（event_id/owner 三元组/provenance 四字段/raw_* 计数）在此还原。
fn map_event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<StoredCanonicalEventRow> {
    let owner_key: String = row.get(0)?;
    let sequence: i64 = row.get(2)?;
    let identity: Option<String> = row.get(8)?;
    let typed: Option<String> = row.get(9)?;
    let raw: String = row.get(10)?;
    let (profile_id, agent_id, local_session_id) = owner_triple(&owner_key);
    let (provenance_origin, provenance_trust, provenance_provider, provenance_import_id) =
        provenance_parts(row.get(12)?, &agent_id, &local_session_id);
    let (
        raw_truncated,
        raw_original_bytes,
        raw_retained_bytes,
        raw_omitted_bytes,
        raw_truncation_reason,
    ) = derive_raw_metadata(&raw);
    Ok(StoredCanonicalEventRow {
        event: CanonicalEventRow {
            event_id: format!("{owner_key}#{sequence}"),
            owner_key,
            profile_id,
            agent_id,
            local_session_id,
            remote_session_id: row.get(1)?,
            client_generation: row.get(3)?,
            sequence,
            occurred_at: row.get(4)?,
            received_at: row.get(5)?,
            event_type: row.get(6)?,
            payload_version: row.get(7)?,
            identity: None,
            typed_payload: None,
            raw_payload: serde_json::Value::Null,
            raw_payload_json: String::new(),
            created_at: row.get(11)?,
            schema_version: 1,
            provenance_origin,
            provenance_trust,
            provenance_provider,
            provenance_import_id,
            raw_truncated,
            raw_original_bytes,
            raw_retained_bytes,
            raw_omitted_bytes,
            raw_truncation_reason,
            rollup_seq_start: row.get(13)?,
            rollup_seq_end: row.get(14)?,
        },
        identity_json: identity,
        typed_payload_json: typed,
        raw_payload_json: raw,
    })
}

/// 读取升序行集 [start, end]（含端点；ingest 单元构建与 trim 校验共用）。
fn query_event_rows(
    conn: &Connection,
    owner_key: &str,
    start: i64,
    end: i64,
) -> Result<Vec<CanonicalEventRow>, EventError> {
    let sql = format!(
        "SELECT {EVENT_COLUMNS} FROM canonical_events WHERE owner_key = ?1 AND sequence >= ?2 AND sequence <= ?3 ORDER BY sequence ASC"
    );
    let mut stmt = conn.prepare_cached(&sql).map_err(EventError::from)?;
    let rows = stmt
        .query_map(params![owner_key, start, end], map_event_row)
        .map_err(EventError::from)?;
    let mut events = Vec::new();
    for row in rows {
        events.push(row.map_err(EventError::from)?.decode()?);
    }
    Ok(events)
}

/// #81 L3：裁剪迁移报告（wire camelCase）。
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RollupTrimReport {
    pub(crate) processed_units: i64,
    pub(crate) trimmed_units: i64,
    pub(crate) resumed_units: i64,
    pub(crate) mismatch_units: i64,
    pub(crate) remaining_units: i64,
    pub(crate) vacuumed: bool,
    pub(crate) policy_blocked: bool,
}

enum RollupUnitOutcome {
    Trimmed,
    AlreadyGone,
    ShaMismatch,
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
            .prepare_cached(MAX_SEQUENCE_SQL)
            .map_err(EventError::from)?
            .query_row(params![owner_key], |row| row.get::<_, Option<i64>>(0))
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
            .prepare_cached(TOMBSTONE_STATE_SQL)
            .map_err(EventError::from)?
            .query_row(params![owner_key, events[0].local_session_id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(EventError::from)?
            .flatten();
        if let Some(state) = tombstone_state {
            return Err(EventError::SessionDeleted(format!(
                "{owner_key}（tombstone state={state}）"
            )));
        }
        let current: i64 = tx
            .prepare_cached(MAX_SEQUENCE_SQL)
            .map_err(EventError::from)?
            .query_row(params![owner_key], |row| row.get::<_, Option<i64>>(0))
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
            let changed = execute_insert_event(&tx, event, None)?;
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
    /// 仅测试便捷入口：生产单事件路径经 `ingest_event` → `ingest_events`（批量版）。
    #[cfg(test)]
    fn ingest_kernel_event(
        &self,
        input: KernelEventInput,
    ) -> Result<EventAppendResult, EventError> {
        self.ingest_kernel_events(vec![input])
    }

    /// Kernel batch ingest：同一 owner 的输入共享一条 SQLite transaction，但仍保持
    /// 每个输入一条 append-only canonical 行。sequence 只在这里推进，因此批量路径与
    /// 单事件路径共享同一 revision/terminal-unit 语义，后续 dispatcher 窗口可以直接复用。
    fn ingest_kernel_events(
        &self,
        inputs: Vec<KernelEventInput>,
    ) -> Result<EventAppendResult, EventError> {
        let Some(first) = inputs.first() else {
            return Ok(EventAppendResult {
                events: Vec::new(),
                revision: 0,
            });
        };
        let owner_key = first
            .owner
            .key()
            .map_err(|error| EventError::Invalid(error.to_string()))?;
        for input in &inputs {
            let input_owner_key = input
                .owner
                .key()
                .map_err(|error| EventError::Invalid(error.to_string()))?;
            if input_owner_key != owner_key {
                return Err(EventError::Invalid(format!(
                    "kernel ingest batch crosses owners: {owner_key} vs {input_owner_key}"
                )));
            }
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let tx = conn.transaction().map_err(EventError::from)?;
        let tombstone_state: Option<String> = tx
            .prepare_cached(TOMBSTONE_STATE_SQL)
            .map_err(EventError::from)?
            .query_row(params![owner_key, first.owner.local_session_id], |row| {
                row.get(0)
            })
            .optional()
            .map_err(EventError::from)?
            .flatten();
        if let Some(state) = tombstone_state {
            return Err(EventError::SessionDeleted(format!(
                "{owner_key}（tombstone state={state}）"
            )));
        }
        let revision: i64 = tx
            .prepare_cached(MAX_SEQUENCE_SQL)
            .map_err(EventError::from)?
            .query_row(params![owner_key], |row| row.get::<_, Option<i64>>(0))
            .optional()
            .map_err(EventError::from)?
            .flatten()
            .unwrap_or(0);
        let mut final_revision = revision;
        let mut result_events = Vec::with_capacity(inputs.len());
        // ADR-0016（#155 T3-1）：写侧行聚合——**顺序流式**折叠（不是「先全归一化再折」）。
        //
        // 为什么必须顺序：终态行会在同一事务里追加 `turn.unit`（多占一个 sequence），若先把整窗
        // 归一化再折叠，终态之后那些行的编号会与新占的单元号冲突。顺序折叠下编号始终由「已写 +
        // 已保留」的最大 sequence 推出，单元的插入自然推进后续编号。
        //
        // run 判据与读侧 `fold_adjacent_delta_runs` 同一口径、同一预算；收口复用 `flush_delta_run`
        // （长度 < 2 原样、≥ 2 产 `*.delta.batch` 行），故不存在第二份规则。窗口边界处 run 自然
        // 断开（每行自带 seqSpan，消费方按跨度理解连续性）。
        let mut run: Vec<CanonicalEventRow> = Vec::new();
        let mut run_base: Option<&'static str> = None;
        let mut run_bytes: usize = 0;
        macro_rules! flush_run {
            () => {
                if !run.is_empty() {
                    let chunks = std::mem::take(&mut run);
                    let base = run_base.take();
                    run_bytes = 0;
                    let mut flushed: Vec<CanonicalEventRow> = Vec::with_capacity(1);
                    flush_delta_run(&mut flushed, chunks, base);
                    for row in flushed {
                        execute_insert_event(&tx, &row, None)?;
                        final_revision = row.sequence;
                        result_events.push(row);
                    }
                }
            };
        }
        for input in inputs {
            let event = normalize_kernel_event(input, final_revision + 1)?;
            let base = foldable_delta_base(&event);
            let extend = match (base, run.last(), run_base) {
                (Some(base), Some(last), Some(current)) => {
                    current == base
                        && event.sequence == last.sequence + 1
                        && identity_keys_equal(&last.identity, &event.identity)
                        && run.len() < MAX_FOLDED_CHUNKS
                        && run_bytes + raw_payload_bytes(&event) <= MAX_FOLD_BYTES
                }
                _ => false,
            };
            if extend {
                run_bytes += raw_payload_bytes(&event);
                final_revision = event.sequence;
                run.push(event);
                continue;
            }
            flush_run!();
            match base {
                // 单条自身就超预算的 delta 不成批（不截断，原样落盘）。
                Some(base) if raw_payload_bytes(&event) <= MAX_FOLD_BYTES => {
                    run_bytes = raw_payload_bytes(&event);
                    run_base = Some(base);
                    final_revision = event.sequence;
                    run.push(event);
                }
                _ => {
                    execute_insert_event(&tx, &event, None)?;
                    final_revision = event.sequence;
                    result_events.push(event.clone());

                    // #81 L2：终结事件 → 同一事务追加 turn 单元行（只加不减；未终结不折叠）。
                    // 单元构建失败不阻塞终态事实落盘（best effort：无单元的 turn 不被 L3 裁剪）。
                    if super::turn_rollup::is_turn_terminal(&event.event_type) {
                        let prev_boundary: i64 = tx
                            .prepare_cached(LAST_TURN_BOUNDARY_SQL)
                            .map_err(EventError::from)?
                            .query_row(params![owner_key, event.sequence], |row| row.get(0))
                            .optional()
                            .map_err(EventError::from)?
                            .flatten()
                            .unwrap_or(0);
                        let turn_rows =
                            query_event_rows(&tx, &owner_key, prev_boundary + 1, event.sequence)?;
                        match super::turn_rollup::build_turn_unit_row(
                            &event,
                            &turn_rows,
                            event.sequence + 1,
                        ) {
                            Ok(unit) => {
                                let unit_sequence = unit.sequence;
                                let inserted = execute_insert_event(
                                    &tx,
                                    &unit,
                                    unit.rollup_seq_start.zip(unit.rollup_seq_end),
                                )?;
                                // ON CONFLICT DO NOTHING 下 kernel 路径冲突不可达（sequence 恒新分配）；
                                // 防御：真被跳过时不得虚报写入/推进 revision（审核 P2）。
                                if inserted > 0 {
                                    result_events.push(unit);
                                    final_revision = unit_sequence;
                                }
                            }
                            Err(error) => {
                                tracing::warn!(
                                    owner = %owner_key,
                                    error = %error,
                                    "turn.unit 构建失败，本轮不折叠"
                                );
                            }
                        }
                    }
                }
            }
        }
        // 收口最后一段 run（未终结的尾巴也必须落盘——draft 尾巴不豁免，ADR-0016 决定 4）。
        flush_run!();
        tx.commit().map_err(EventError::from)?;
        Ok(EventAppendResult {
            events: result_events,
            revision: final_revision,
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
        let exists: i64 = conn
            .prepare_cached(
                "SELECT EXISTS(
                SELECT 1 FROM canonical_events
                WHERE owner_key = ?1 AND provenance = 0
            )",
            )
            .map_err(EventError::from)?
            .query_row(params![owner_key], |row| row.get::<_, i64>(0))
            .map_err(EventError::from)?;
        Ok(exists != 0)
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
            .prepare_cached(&format!(
                "SELECT {EVENT_COLUMNS} FROM canonical_events
                 WHERE owner_key = ?1 AND (?2 IS NULL OR sequence < ?2)
                 ORDER BY sequence DESC
                 LIMIT ?3"
            ))
            .map_err(EventError::from)?;
        let rows = stmt
            .query_map(
                params![owner_key, before_sequence, i64::from(limit)],
                map_event_row,
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

    /// #51 收口：owner journal 里 sequence 最大的指定类型事件行（无则 None）。
    /// (owner_key, sequence) 聚簇主键倒序走查 + event_type 谓词命中即停，
    /// 供写入侧做「payload 未变不重复追加」的幂等判定；不承担一般查询职责
    /// （一般读路径走 list_events / load_events_compact）。
    pub(crate) fn latest_event_of_type(
        &self,
        owner_key: &str,
        event_type: &str,
    ) -> Result<Option<CanonicalEventRow>, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let mut stmt = conn
            .prepare_cached(&format!(
                "SELECT {EVENT_COLUMNS} FROM canonical_events
                 WHERE owner_key = ?1 AND event_type = ?2
                 ORDER BY sequence DESC LIMIT 1"
            ))
            .map_err(EventError::from)?;
        let stored = stmt
            .query_row(params![owner_key, event_type], map_event_row)
            .optional()
            .map_err(EventError::from)?;
        stored.map(|row| row.decode()).transpose()
    }

    /// #81 L2：compact 读——返回「单元 + 未覆盖行」（升序）。被 turn.unit 覆盖的
    /// 行不再读取（L3 裁剪后这些行已删除），前端读/解析行数随单元粒度下降。
    ///
    /// #205：过滤下推到 SQL（两段查询）——原实现先把**整表**读成 `Vec<CanonicalEventRow>`
    /// （每行三个 payload 列都要解成 `serde_json::Value` 树）再在内存里过滤。实测生产库
    /// （单 owner 13.6 万行）一次 compact 读 `1188ms`、峰值数百 MB，而结果只有 12 行。
    /// 现在先只读单元行拿覆盖跨度，再按跨度在 WHERE 里剪掉被覆盖行 ⇒ 只读取真正要下发的行。
    pub(crate) fn load_events_compact(
        &self,
        owner_key: &str,
    ) -> Result<Vec<CanonicalEventRow>, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        // 1) 单元行：既是返回内容，也是覆盖跨度的唯一来源。
        let unit_sql = format!(
            "SELECT {EVENT_COLUMNS} FROM canonical_events WHERE owner_key = ?1 AND event_type = ?2 ORDER BY sequence ASC"
        );
        let mut unit_stmt = conn.prepare_cached(&unit_sql).map_err(EventError::from)?;
        let mut units: Vec<CanonicalEventRow> = Vec::new();
        for row in unit_stmt
            .query_map(
                params![owner_key, super::turn_rollup::TURN_UNIT_EVENT_TYPE],
                map_event_row,
            )
            .map_err(EventError::from)?
        {
            units.push(row.map_err(EventError::from)?.decode()?);
        }
        let ranges: Vec<(i64, i64)> = units
            .iter()
            .filter_map(|row| row.rollup_seq_start.zip(row.rollup_seq_end))
            .collect();
        // 跨度数量进入 SQL 谓词，超阈值退回「整读后内存过滤」：SQLite 对表达式深度与
        // 绑定参数个数都有上限，宁可慢也不要在极端 journal 上查询失败。
        if ranges.len() > MAX_COMPACT_SQL_RANGES {
            return self.load_events_compact_scan_then_filter(owner_key);
        }
        let mut uncovered_sql = format!(
            "SELECT {EVENT_COLUMNS} FROM canonical_events WHERE owner_key = ?1 AND event_type <> ?2"
        );
        for (index, _) in ranges.iter().enumerate() {
            uncovered_sql.push_str(&format!(
                " AND NOT (sequence BETWEEN ?{} AND ?{})",
                2 * index + 3,
                2 * index + 4
            ));
        }
        uncovered_sql.push_str(" ORDER BY sequence ASC");
        let mut bind: Vec<&dyn rusqlite::ToSql> =
            vec![&owner_key, &super::turn_rollup::TURN_UNIT_EVENT_TYPE];
        for (start, end) in &ranges {
            bind.push(start);
            bind.push(end);
        }
        let mut uncovered_stmt = conn
            .prepare_cached(&uncovered_sql)
            .map_err(EventError::from)?;
        let mut rows: Vec<CanonicalEventRow> = units;
        for row in uncovered_stmt
            .query_map(rusqlite::params_from_iter(bind.iter()), map_event_row)
            .map_err(EventError::from)?
        {
            rows.push(row.map_err(EventError::from)?.decode()?);
        }
        // 两段各自有序，合并后按 sequence 复原全序（单元行与其覆盖区间交错）。
        rows.sort_by_key(|row| row.sequence);
        // #205：未覆盖的尾部 delta run 在读侧折成 batch 行——回合进行中（其 turn.unit
        // 尚未产生）这些行占未覆盖集合的全部，不折叠就要把整段 chunk 逐行下发并逐行
        // 投影（实测单回合 79,682 行 ⇒ 前端空白数分钟、内核峰值数百 MB）。
        Ok(fold_adjacent_delta_runs(rows))
    }

    /// compact 读的回退路径：整读该 owner 全部行后在内存里过滤（覆盖跨度过多时的兜底）。
    fn load_events_compact_scan_then_filter(
        &self,
        owner_key: &str,
    ) -> Result<Vec<CanonicalEventRow>, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM canonical_events WHERE owner_key = ?1 ORDER BY sequence ASC"
        );
        let mut stmt = conn.prepare_cached(&sql).map_err(EventError::from)?;
        let mut all: Vec<CanonicalEventRow> = Vec::new();
        for row in stmt
            .query_map(params![owner_key], map_event_row)
            .map_err(EventError::from)?
        {
            all.push(row.map_err(EventError::from)?.decode()?);
        }
        let mut ranges: Vec<(i64, i64)> = Vec::new();
        for row in &all {
            if row.event_type == super::turn_rollup::TURN_UNIT_EVENT_TYPE {
                if let (Some(start), Some(end)) = (row.rollup_seq_start, row.rollup_seq_end) {
                    ranges.push((start, end));
                }
            }
        }
        let covered = |sequence: i64| {
            ranges
                .iter()
                .any(|(start, end)| sequence >= *start && sequence <= *end)
        };
        let filtered: Vec<CanonicalEventRow> = all
            .into_iter()
            .filter(|row| {
                row.event_type == super::turn_rollup::TURN_UNIT_EVENT_TYPE || !covered(row.sequence)
            })
            .collect();
        Ok(fold_adjacent_delta_runs(filtered))
    }

    /// #81 L3：破坏性裁剪迁移（可暂停 / 续跑；sha256 校验通过才删行）。
    /// 逐 turn 单事务；进度落 `rollup_migration_state`（trimmed/mismatch 永久跳过）。
    /// budget_ms 用尽即在 turn 边界暂停；全部完成后 VACUUM 回收（仅当本次有删行）。
    pub(crate) fn rollup_trim(
        &self,
        budget_ms: Option<u64>,
    ) -> Result<RollupTrimReport, EventError> {
        let started = std::time::Instant::now();
        let mut report = RollupTrimReport::default();
        loop {
            if let Some(budget) = budget_ms {
                if report.processed_units > 0 && started.elapsed().as_millis() as u64 >= budget {
                    break;
                }
            }
            let claimed = self.claim_next_rollup_unit()?;
            let Some((owner_key, unit)) = claimed else {
                break;
            };
            report.processed_units += 1;
            let outcome = self.trim_one_unit(&owner_key, &unit)?;
            match outcome {
                RollupUnitOutcome::Trimmed => report.trimmed_units += 1,
                RollupUnitOutcome::AlreadyGone => report.resumed_units += 1,
                RollupUnitOutcome::ShaMismatch => report.mismatch_units += 1,
            }
        }
        report.remaining_units = self.count_remaining_rollup_units()?;
        // resumed>0 也可能对应"此前运行删行未回收"的收尾（审核 P2：避免漏 VACUUM）
        if report.remaining_units == 0 && (report.trimmed_units > 0 || report.resumed_units > 0) {
            let conn = self
                .conn
                .lock()
                .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
            conn.execute_batch("VACUUM").map_err(EventError::from)?;
            report.vacuumed = true;
        }
        Ok(report)
    }

    /// 取下一个未处理单元（state 表无 trimmed/mismatch 记录；单事务内落 'verifying'）。
    fn claim_next_rollup_unit(&self) -> Result<Option<(String, CanonicalEventRow)>, EventError> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let tx = conn.transaction().map_err(EventError::from)?;
        let sql = format!(
            "SELECT {EVENT_COLUMNS} FROM canonical_events e
             WHERE e.event_type = 'turn.unit'
               AND NOT EXISTS (SELECT 1 FROM rollup_migration_state s
                               WHERE s.owner_key = e.owner_key AND s.unit_event_id = e.owner_key || '#' || e.sequence
                                 AND s.state IN ('trimmed', 'mismatch'))
             ORDER BY e.sequence ASC LIMIT 1"
        );
        let mapped = tx
            .prepare_cached(&sql)
            .map_err(EventError::from)?
            .query_row([], map_event_row)
            .optional()
            .map_err(EventError::from)?;
        let Some(stored) = mapped else {
            return Ok(None);
        };
        let unit = stored.decode()?;
        let owner_key = unit.owner_key.clone();
        tx.prepare_cached(
            "INSERT OR IGNORE INTO rollup_migration_state (owner_key, unit_event_id, state, updated_at)
             VALUES (?1, ?2, 'verifying', ?3)",
        )
        .map_err(EventError::from)?
        .execute(params![owner_key, unit.event_id, now_millis()])
        .map_err(EventError::from)?;
        tx.commit().map_err(EventError::from)?;
        Ok(Some((owner_key, unit)))
    }

    /// 校验并裁剪单个单元（独立事务；行已被删/校验失败均不删行）。
    fn trim_one_unit(
        &self,
        owner_key: &str,
        unit: &CanonicalEventRow,
    ) -> Result<RollupUnitOutcome, EventError> {
        let span = match (unit.rollup_seq_start, unit.rollup_seq_end) {
            (Some(start), Some(end)) => (start, end),
            // 迁移回填前的防御分支：从 typedPayload JSON 解析
            _ => {
                // 与"缺 seqStart/seqEnd"同口径：防御分支一律保留行并永久跳过，
                // 不得让整个迁移卡死（审核 P1：缺 typedPayload 曾直接 Err）。
                let Some(typed) = unit.typed_payload.clone() else {
                    return Ok(RollupUnitOutcome::ShaMismatch);
                };
                let start = typed.get("seqStart").and_then(serde_json::Value::as_i64);
                let end = typed.get("seqEnd").and_then(serde_json::Value::as_i64);
                match (start, end) {
                    (Some(start), Some(end)) => (start, end),
                    _ => return Ok(RollupUnitOutcome::ShaMismatch),
                }
            }
        };
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let tx = conn.transaction().map_err(EventError::from)?;
        let rows = query_event_rows(&tx, owner_key, span.0, span.1)?;
        if rows.is_empty() {
            // 续跑：行已删除（上次运行在标记前中断）→ 只补标记
            Self::mark_rollup_state(&tx, owner_key, &unit.event_id, "trimmed")?;
            tx.commit().map_err(EventError::from)?;
            return Ok(RollupUnitOutcome::AlreadyGone);
        }
        let rebuilt = super::turn_rollup::fold_turn_rows(&rows);
        let expected = unit
            .typed_payload
            .as_ref()
            .and_then(|typed| typed.get("contentSha256"))
            .and_then(serde_json::Value::as_str);
        if expected != Some(rebuilt.content_sha256.as_str()) {
            // 折叠前后文本等价校验失败：保留行（不丢弃），永久跳过并计入
            Self::mark_rollup_state(&tx, owner_key, &unit.event_id, "mismatch")?;
            tx.commit().map_err(EventError::from)?;
            return Ok(RollupUnitOutcome::ShaMismatch);
        }
        tx.prepare_cached("DELETE FROM canonical_events WHERE owner_key = ?1 AND sequence >= ?2 AND sequence <= ?3")
            .map_err(EventError::from)?
            .execute(params![owner_key, span.0, span.1])
            .map_err(EventError::from)?;
        Self::mark_rollup_state(&tx, owner_key, &unit.event_id, "trimmed")?;
        tx.commit().map_err(EventError::from)?;
        Ok(RollupUnitOutcome::Trimmed)
    }

    fn mark_rollup_state(
        tx: &rusqlite::Transaction<'_>,
        owner_key: &str,
        unit_event_id: &str,
        state: &str,
    ) -> Result<(), EventError> {
        tx.prepare_cached(
            "INSERT INTO rollup_migration_state (owner_key, unit_event_id, state, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(owner_key, unit_event_id) DO UPDATE SET state = ?3, updated_at = ?4",
        )
        .map_err(EventError::from)?
        .execute(params![owner_key, unit_event_id, state, now_millis()])
        .map_err(EventError::from)?;
        Ok(())
    }

    pub(crate) fn count_remaining_rollup_units(&self) -> Result<i64, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        let remaining: i64 = conn
            .prepare_cached(
                "SELECT COUNT(*) FROM canonical_events e
                 WHERE e.event_type = 'turn.unit'
                   AND NOT EXISTS (SELECT 1 FROM rollup_migration_state s
                                   WHERE s.owner_key = e.owner_key AND s.unit_event_id = e.owner_key || '#' || e.sequence
                                     AND s.state IN ('trimmed', 'mismatch'))",
            )
            .map_err(EventError::from)?
            .query_row([], |row| row.get(0))
            .map_err(EventError::from)?;
        Ok(remaining)
    }

    pub(crate) fn export_raw_event(
        &self,
        event_id: &str,
    ) -> Result<Option<CanonicalEventRawExport>, EventError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| EventError::Unavailable("event repo lock poisoned".into()))?;
        // v15 无 event_id 列：eventId = owner_key#sequence（rule 1），按最后一个 '#'
        // 拆分（owner_key 是 JSON 数组文本，串内可含 '#'，sequence 后缀不含）。
        let Some((owner_key, sequence_text)) = event_id.rsplit_once('#') else {
            return Ok(None);
        };
        let Ok(sequence) = sequence_text.parse::<i64>() else {
            return Ok(None);
        };
        let export = conn
            .prepare_cached(
                "SELECT event_type, identity, typed_payload, raw_payload
             FROM canonical_events WHERE owner_key = ?1 AND sequence = ?2",
            )
            .map_err(EventError::from)?
            .query_row(params![owner_key, sequence], |row| {
                Ok(CanonicalEventRawExport {
                    event_id: event_id.to_string(),
                    owner_key: owner_key.to_string(),
                    sequence,
                    event_type: row.get(0)?,
                    identity_json: row.get(1)?,
                    typed_payload_json: row.get(2)?,
                    raw_payload_json: row.get(3)?,
                })
            })
            .optional()
            .map_err(EventError::from)?;
        Ok(export)
    }

    /// B6：跨 owner 内容搜索——在 raw_payload / typed_payload / event_type 上做
    /// 大小写不敏感 LIKE，返回去重后的候选 owner（前端再对候选 owner loadAll +
    /// 消息投影 + 消息文本精确匹配）。limit 为候选 owner 上限。
    /// v15：owner 分维列不落库——DISTINCT 收窄到 (owner_key, remote_session_id)，
    /// 三元组经 `owner_triple` 派生后按 (profile, agent, local) 排序截断（与 v14
    /// 的 SQL ORDER BY 语义一致）。
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
            .prepare_cached(
                "SELECT DISTINCT owner_key, remote_session_id
                 FROM canonical_events
                 WHERE event_type LIKE ?1 COLLATE NOCASE
                    OR raw_payload LIKE ?1 COLLATE NOCASE
                    OR COALESCE(typed_payload, '') LIKE ?1 COLLATE NOCASE",
            )
            .map_err(EventError::from)?;
        let rows = stmt
            .query_map(params![pattern], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
            })
            .map_err(EventError::from)?;
        let mut candidates = Vec::new();
        for row in rows {
            let (owner_key, remote_session_id) = row.map_err(EventError::from)?;
            let (profile_id, agent_id, local_session_id) = owner_triple(&owner_key);
            candidates.push(EventSearchOwner {
                profile_id,
                agent_id,
                local_session_id,
                remote_session_id,
            });
        }
        candidates.sort_by(|a, b| {
            (&a.profile_id, &a.agent_id, &a.local_session_id).cmp(&(
                &b.profile_id,
                &b.agent_id,
                &b.local_session_id,
            ))
        });
        candidates.truncate(limit as usize);
        Ok(candidates)
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
        self.ingest_events(
            owner,
            remote_session_id,
            client_generation,
            vec![raw_payload],
        )
        .await
    }

    /// Kernel batch ingest boundary：同一 owner 的多条 live raw payload 共享一次
    /// repository transaction，仍逐条 normalize/append，并返回实际提交的行（含 terminal
    /// 触发的 turn.unit）。调用方负责在窗口/消息边界 flush；单事件入口委托到这里以保证
    /// 两条路径永远共享同一 sequence、tombstone 和 rollup 语义。
    pub(crate) async fn ingest_events(
        &self,
        owner: DurableSessionOwner,
        remote_session_id: Option<String>,
        client_generation: u64,
        raw_payloads: Vec<serde_json::Value>,
    ) -> Result<EventAppendResult, EventError> {
        let client_generation = i64::try_from(client_generation)
            .map_err(|_| EventError::Invalid("client generation exceeds i64".into()))?;
        let inputs = raw_payloads
            .into_iter()
            .map(|raw_payload| KernelEventInput {
                owner: owner.clone(),
                remote_session_id: remote_session_id.clone(),
                client_generation,
                received_at: chrono::Utc::now()
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                raw_payload,
                recovery_import: false,
            })
            .collect();
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.ingest_kernel_events(inputs))
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
                    status: if revision == 0 {
                        "empty"
                    } else {
                        "already-imported"
                    },
                });
            }
            let mut events = Vec::with_capacity(replay_events.len());
            for (index, raw_payload) in replay_events.into_iter().enumerate() {
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

    /// #51 收口：写入侧幂等判定的读支撑——owner journal 里最新一条指定类型事件。
    pub(crate) async fn latest_event_of_type(
        &self,
        owner_key: String,
        event_type: &'static str,
    ) -> Result<Option<CanonicalEventRow>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.latest_event_of_type(&owner_key, event_type))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo latest task failed: {error}"))
            })?
    }

    /// #81 L2：compact 读（单元 + 未覆盖行；文档投影/搜索的读取入口）。
    pub(crate) async fn load_events_compact(
        &self,
        owner_key: String,
    ) -> Result<Vec<CanonicalEventRow>, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.load_events_compact(&owner_key))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo compact task failed: {error}"))
            })?
    }

    /// #81 L3：裁剪迁移（应用关闭时调用；budget_ms 控制单次预算，可续跑）。
    pub(crate) async fn rollup_trim(
        &self,
        budget_ms: Option<u64>,
    ) -> Result<RollupTrimReport, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.rollup_trim(budget_ms))
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo trim task failed: {error}"))
            })?
    }

    /// #81 L3：剩余未裁剪单元数（策略关闭时的报告数据源）。
    pub(crate) async fn count_remaining_rollup_units(&self) -> Result<i64, EventError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.count_remaining_rollup_units())
            .await
            .map_err(|error| {
                EventError::Unavailable(format!("event repo trim count task failed: {error}"))
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
    fn kernel_batch_ingest_folds_adjacent_rows_and_advances_past_terminal_unit() {
        // ADR-0016（2026-09-20 已采用）改写本条判据：相邻同类 delta 现在折成**一行**（span 占位，
        // 幸存行落在跨度末位），不再逐 chunk 一行。编号语义未变——span 占位不重排后续行，
        // 故终态单元与终态之后那行的编号与旧契约逐字相同。
        let repo = repo();
        let delta = |text: &str| {
            serde_json::json!({
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": text }
                }
            })
        };
        let result = repo
            .ingest_kernel_events(vec![
                kernel_input(delta("a")),
                kernel_input(delta("b")),
                kernel_input(serde_json::json!({
                    "update": { "sessionUpdate": "done" }
                })),
                kernel_input(delta("after")),
            ])
            .expect("batch ingest");

        assert_eq!(result.revision, 5);
        assert_eq!(
            result
                .events
                .iter()
                .map(|event| (event.sequence, event.event_type.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (2, "assistant.text.delta.batch"),
                (3, "turn.completed"),
                (4, "turn.unit"),
                (5, "assistant.text.delta"),
            ]
        );
        let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
        assert_eq!(repo.revision(&owner_key).unwrap(), 5);
    }

    #[test]
    fn kernel_batch_ingest_rejects_mixed_owners_before_writing() {
        let repo = repo();
        let mut other = kernel_input(serde_json::json!({
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "b" } }
        }));
        other.owner = DurableSessionOwner::new("p2", "peri", "local:s2");
        let error = repo
            .ingest_kernel_events(vec![
                kernel_input(serde_json::json!({
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "a" } }
                })),
                other,
            ])
            .expect_err("mixed owners must be rejected");
        assert!(
            matches!(error, EventError::Invalid(message) if message.contains("crosses owners"))
        );
        let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
        assert_eq!(repo.revision(&owner_key).unwrap(), 0);
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
    fn kernel_ingest_normalizes_extended_session_update_variants() {
        let cases = [
            ("cancelled", "turn.failed"),
            ("usage_update", "usage.updated"),
            ("plan", "plan.replaced"),
            ("current_mode_update", "session.mode-updated"),
            ("session_info_update", "session.model-updated"),
            ("config_option_update", "session.config-updated"),
            ("available_commands_update", "session.commands-updated"),
        ];
        for (variant, expected) in cases {
            let event = repo()
                .ingest_kernel_event(kernel_input(serde_json::json!({
                    "source": "local:s1",
                    "update": { "sessionUpdate": variant }
                })))
                .expect("ingest")
                .events
                .remove(0);
            assert_eq!(event.event_type, expected, "variant {variant}");
        }
    }

    /// #110 F5：`session_info_update` 的模型事实必须进 typed_payload.model——
    /// 前端 `session.model-updated` 语义投影只从这里取值；缺失则模型事实丢失。
    #[test]
    fn kernel_ingest_session_info_update_carries_model_fact() {
        for (payload, expected) in [
            (
                serde_json::json!({"sessionUpdate": "session_info_update", "models": {"currentModelId": "nous:hermes-4"}}),
                Some("nous:hermes-4"),
            ),
            (
                serde_json::json!({"sessionUpdate": "session_info_update", "models": {"current_model_id": "snake:id"}}),
                Some("snake:id"),
            ),
            (
                serde_json::json!({"sessionUpdate": "session_info_update", "model": "flat:id"}),
                Some("flat:id"),
            ),
            // display name 不是 machine id：嵌套 current 为对象且无可提取机器值 → 不落 model。
            (
                serde_json::json!({"sessionUpdate": "session_info_update", "model": "   "}),
                None,
            ),
            (
                serde_json::json!({"sessionUpdate": "session_info_update", "title": "会话标题"}),
                None,
            ),
        ] {
            let event = repo()
                .ingest_kernel_event(kernel_input(serde_json::json!({
                    "source": "local:s1",
                    "update": payload
                })))
                .expect("ingest")
                .events
                .remove(0);
            assert_eq!(
                event.event_type, "session.model-updated",
                "payload {payload}"
            );
            let model = event
                .typed_payload
                .as_ref()
                .and_then(|typed| typed.get("model"))
                .and_then(serde_json::Value::as_str);
            assert_eq!(model, expected, "payload {payload}");
        }
    }

    /// #110 F7：体检时库内 31 行 `unknown` 的真实 raw 形状（camelCase `{sessionId,
    /// update:{sessionUpdate}}` 通知包）必须被当前分类器正确识别——证明残留是旧构建的
    /// 历史错标，而不是现行分类缺口。用例形状逐字节取自只读取证样本。
    #[test]
    fn kernel_ingest_recognizes_legacy_unknown_wire_shapes() {
        let cases = [
            (
                serde_json::json!({"sessionId": "99d58bd6", "update": {"size": 1000000, "used": 21793, "sessionUpdate": "usage_update"}}),
                "usage.updated",
            ),
            (
                serde_json::json!({"sessionId": "99d58bd6", "update": {"availableCommands": [{"name": "help", "description": "List available commands"}], "sessionUpdate": "available_commands_update"}}),
                "session.commands-updated",
            ),
            (
                serde_json::json!({"sessionId": "99d58bd6", "update": {"configOptions": [{"id": "model-selection", "category": "model"}], "sessionUpdate": "config_option_update"}}),
                "session.config-updated",
            ),
            (
                serde_json::json!({"sessionId": "99d58bd6", "update": {"_meta": {"periKind": "skill"}, "title": "会话标题", "updatedAt": "2026-09-01T00:00:00.000Z", "sessionUpdate": "session_info_update"}}),
                "session.model-updated",
            ),
        ];
        for (raw, expected) in cases {
            let event = repo()
                .ingest_kernel_event(kernel_input(raw.clone()))
                .expect("ingest")
                .events
                .remove(0);
            assert_eq!(event.event_type, expected, "raw {raw}");
            assert_eq!(event.raw_payload, raw, "raw 原文保真（不受分类影响）");
        }
    }

    /// #110 F7：真正未识别的判别符仍 fail-soft 成 `unknown` 且 raw 完整保留
    /// （归因打点走 tracing，不改事件行契约）。
    #[test]
    fn kernel_ingest_truly_unknown_discriminator_keeps_raw() {
        let raw = serde_json::json!({
            "sessionId": "peri-1",
            "update": {"sessionUpdate": "vendor_future_update", "payload": {"x": 1}},
        });
        let event = repo()
            .ingest_kernel_event(kernel_input(raw.clone()))
            .expect("ingest")
            .events
            .remove(0);
        assert_eq!(event.event_type, "unknown");
        assert_eq!(event.typed_payload, None);
        assert_eq!(event.raw_payload, raw);
    }

    #[test]
    fn kernel_ingest_done_keeps_additive_completion_fields() {
        let event = repo()
            .ingest_kernel_event(kernel_input(serde_json::json!({
                "source": "local:s1",
                "update": {
                    "sessionUpdate": "done",
                    "stopReason": "end_turn",
                    "usage": {"inputTokens": 2, "outputTokens": 3},
                    "model": "hermes-1"
                }
            })))
            .expect("ingest")
            .events
            .remove(0);
        assert_eq!(event.event_type, "turn.completed");
        let typed = event.typed_payload.expect("typed completion payload");
        assert_eq!(typed["stopReason"], "end_turn");
        assert_eq!(typed["usage"]["outputTokens"], 3);
        assert_eq!(typed["model"], "hermes-1");
        assert_eq!(event.payload_version, 1);
        assert!(!typed.as_object().unwrap().contains_key("durationMs"));
    }

    #[test]
    fn kernel_ingest_redacts_secret_interaction_values_before_raw_retention() {
        let credential = "c12-kernel-secret-value";
        let result = repo()
            .ingest_kernel_event(kernel_input(serde_json::json!({
                "source": "local:s1",
                "update": {
                    "sessionUpdate": "future_interaction",
                    "request": { "kind": "secret", "value": credential },
                    "response": { "value": credential }
                }
            })))
            .expect("ingest");
        let row = &result.events[0];
        let persisted = serde_json::to_string(row).unwrap();
        assert!(!persisted.contains(credential));
        assert_eq!(row.raw_payload["update"]["request"]["valueRedacted"], true);
        assert_eq!(row.raw_payload["update"]["response"]["valueRedacted"], true);
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
        assert_eq!(
            event.raw_omitted_bytes,
            event.raw_original_bytes - event.raw_retained_bytes
        );
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

    /// #81 L1：sink batch 行（跨度占用 sequence）在后端的落盘契约——
    /// event_type 原样接受、raw 数组不变形、revision = MAX(sequence)（跨度中间
    /// 编号不占用、无连续性假设）、expected_revision 语义不变。
    #[test]
    fn batch_row_occupies_span_tail_and_revision_follows_max_sequence() {
        let repo = repo();
        let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
        let first = parse_canonical_event(&event_json(
            "peri",
            "local:s1",
            1,
            "user.message",
            serde_json::json!({ "text": "q" }),
        ))
        .unwrap();
        let chunk = parse_canonical_event(&event_json(
            "peri",
            "local:s1",
            2,
            "assistant.text.delta",
            serde_json::json!({ "update": { "sessionUpdate": "agent_message_chunk" } }),
        ))
        .unwrap();
        let mut batch = event_json(
            "peri",
            "local:s1",
            5,
            "assistant.text.delta.batch",
            serde_json::json!([
                { "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "a" } } },
                { "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "b" } } },
                { "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "c" } } },
            ]),
        );
        batch["typedPayload"] =
            serde_json::json!({ "text": "abc", "foldedCount": 3, "seqSpan": [3, 5] });
        let batch = parse_canonical_event(&batch).unwrap();
        repo.append_events(&[first, chunk], None).unwrap();
        let result = repo.append_events(&[batch], Some(2)).unwrap();
        assert_eq!(
            result.revision, 5,
            "revision = MAX(sequence)，跨度中间编号不影响"
        );
        assert_eq!(repo.revision(&owner_key).unwrap(), 5);

        // expected_revision 以 MAX(sequence) 为基准：5 可写，4 冲突
        let next = parse_canonical_event(&event_json(
            "peri",
            "local:s1",
            6,
            "turn.completed",
            serde_json::json!({ "update": { "sessionUpdate": "done" } }),
        ))
        .unwrap();
        assert!(repo
            .append_events(std::slice::from_ref(&next), Some(5))
            .is_ok());
        let late = parse_canonical_event(&event_json(
            "peri",
            "local:s1",
            7,
            "turn.completed",
            serde_json::json!({ "update": { "sessionUpdate": "done" } }),
        ))
        .unwrap();
        assert!(matches!(
            repo.append_events(std::slice::from_ref(&late), Some(4)),
            Err(EventError::RevisionConflict { .. })
        ));

        // 回读：batch 行原样保留（raw 数组 + typedPayload 不变形、不截断）
        let page = repo.list_events(&owner_key, None, 10).unwrap();
        let batch_row = page
            .events
            .iter()
            .find(|event| event.event_type == "assistant.text.delta.batch")
            .expect("batch row persisted");
        assert_eq!(batch_row.sequence, 5);
        assert_eq!(batch_row.raw_payload.as_array().map(Vec::len), Some(3));
        assert_eq!(batch_row.typed_payload.as_ref().unwrap()["seqSpan"][0], 3);
        assert_eq!(batch_row.typed_payload.as_ref().unwrap()["seqSpan"][1], 5);
        assert!(!batch_row.raw_truncated);
    }

    /// #81 L1：batch 行同样受 rule 1 约束——eventId 与 owner+sequence 推导一致。
    #[test]
    fn batch_row_enforces_event_id_consistency() {
        let mut ev = event_json(
            "peri",
            "local:s1",
            4,
            "assistant.thinking.delta.batch",
            serde_json::json!([
                { "update": { "sessionUpdate": "agent_thought_chunk", "content": { "text": "a" } } },
            ]),
        );
        ev["typedPayload"] =
            serde_json::json!({ "text": "a", "foldedCount": 1, "seqSpan": [4, 4] });
        ev["eventId"] = serde_json::json!("[\"p1\",\"peri\",\"local:s1\"]#3".to_string());
        assert!(matches!(
            parse_canonical_event(&ev),
            Err(EventError::Invalid(_))
        ));
    }

    /// #81 L2：kernel 终结写入 → 同一事务追加 turn.unit（segment 折叠 + sha256 +
    /// rollup 列）；compact 读只返回单元 + 未覆盖行。
    #[test]
    fn terminal_ingest_appends_turn_unit_and_compact_read_skips_covered_rows() {
        let repo = repo();
        let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
        let delta = |text: &str| {
            serde_json::json!({
                "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": text } }
            })
        };
        repo.ingest_kernel_event(kernel_input(delta("你"))).unwrap();
        repo.ingest_kernel_event(kernel_input(delta("好"))).unwrap();
        repo.ingest_kernel_event(kernel_input(serde_json::json!({
            "update": { "sessionUpdate": "tool_call", "toolCallId": "tool-1", "title": "Read", "kind": "read" }
        }))).unwrap();
        let terminal = repo
            .ingest_kernel_event(kernel_input(serde_json::json!({
                "update": { "sessionUpdate": "done", "stopReason": "end_turn" }
            })))
            .expect("terminal ingest");

        // 终态事件 + 单元行原子追加
        assert_eq!(terminal.events.len(), 2, "terminal + turn.unit");
        let terminal_row = &terminal.events[0];
        let unit = &terminal.events[1];
        assert_eq!(terminal_row.sequence, 4);
        assert_eq!(unit.event_type, "turn.unit");
        assert_eq!(unit.sequence, 5);
        assert_eq!(terminal.revision, 5);
        assert_eq!(repo.revision(&owner_key).unwrap(), 5);

        // 单元 payload：跨度、折叠计数、segments 保序（delta-run / event 穿插）
        let typed = unit.typed_payload.as_ref().unwrap();
        assert_eq!(typed["aggregateKind"], "turn-rollup");
        assert_eq!(typed["seqStart"], 1);
        assert_eq!(typed["seqEnd"], 4);
        assert_eq!(typed["foldedCount"], 4);
        let segments = typed["segments"].as_array().unwrap();
        assert_eq!(segments.len(), 3);
        assert_eq!(segments[0]["kind"], "delta-run");
        assert_eq!(segments[0]["seqStart"], 1);
        assert_eq!(segments[0]["seqEnd"], 2);
        assert_eq!(segments[0]["text"], "你好");
        assert_eq!(segments[1]["kind"], "event");
        assert_eq!(segments[1]["event"]["eventType"], "tool.call.started");
        assert_eq!(segments[2]["kind"], "event");
        assert_eq!(segments[2]["event"]["eventType"], "turn.completed");
        // 回归（重启后无法重放）：嵌入事件必须是 EVT-01 canonical 事件（嵌套 owner），
        // 不得是数据库扁平列形状——前端 `canonicalRowToWorkbench` 以 `owner` 为门槛，
        // 扁平行会被判不可读而把整轮塔成 event.unknown。
        for segment in segments.iter().filter(|item| item["kind"] == "event") {
            assert!(
                segment["event"]["owner"].is_object(),
                "segment event 缺嵌套 owner: {segment}"
            );
            assert_eq!(segment["event"]["owner"]["agentId"], "peri");
            assert_eq!(segment["event"]["owner"]["localSessionId"], "local:s1");
            assert!(segment["event"]["provenance"].is_object());
            assert!(
                segment["event"]["profileId"].is_null(),
                "不得落数据库扁平列形状: {segment}"
            );
        }
        assert_eq!(typed["terminal"]["eventType"], "turn.completed");
        assert_eq!(unit.rollup_seq_start, Some(1));
        assert_eq!(unit.rollup_seq_end, Some(4));

        // compact 读：被单元覆盖的行不再返回；未覆盖新行保留
        let compact = repo.load_events_compact(&owner_key).unwrap();
        assert_eq!(compact.len(), 1);
        assert_eq!(compact[0].event_type, "turn.unit");

        repo.ingest_kernel_event(kernel_input(delta("后续")))
            .unwrap();
        let compact_after = repo.load_events_compact(&owner_key).unwrap();
        assert_eq!(compact_after.len(), 2);
        assert_eq!(compact_after[1].event_type, "assistant.text.delta");
        assert_eq!(compact_after[1].sequence, 6, "单元行占用 seq 5");
    }

    /// #81 回归修复：`CanonicalEventRow → EVT-01` 序列化器与 `parse_canonical_event` 互逆。
    #[test]
    fn canonical_event_wire_round_trips_through_parse() {
        let mut input = event_json(
            "peri",
            "local:s1",
            3,
            "tool.call.completed",
            serde_json::json!({ "update": { "sessionUpdate": "tool_call_update", "toolCallId": "tool-1" } }),
        );
        input["identity"] = serde_json::json!({ "toolCallId": "tool-1" });
        input["typedPayload"] =
            serde_json::json!({ "toolCallId": "tool-1", "status": "completed" });
        input["provenance"] = serde_json::json!({
            "origin": "local-observed",
            "trust": "authoritative",
            "provider": "peri",
        });
        let row = parse_canonical_event(&input).expect("canonical event parses");

        let wire = canonical_event_wire(&row);
        // 形状断言：嵌套 owner/provenance，不是扁平列。
        assert!(wire["owner"].is_object());
        assert!(wire["provenance"].is_object());
        assert!(wire["rawMetadata"].is_object());
        assert!(wire["profileId"].is_null());
        assert!(wire["ownerKey"].is_null());
        assert!(wire["rollupSeqStart"].is_null(), "rollup 列不属 EVT-01");

        let mut reparsed = parse_canonical_event(&wire).expect("wire reparses");
        // `created_at` 重取 now、`raw_payload_json` 是入库文本缓存 ⇒ 只归一这两项。
        reparsed.created_at = row.created_at;
        reparsed.raw_payload_json = row.raw_payload_json.clone();
        assert_eq!(reparsed, row, "wire 必须逐字段往返");
    }

    /// #81 回归修复：超限 rawPayload 的截断元数据由 wire 显式携带（重解析会按裁剪后
    /// 的短载荷重算而不报截断）——此不对称是已知且刻意的。
    #[test]
    fn canonical_event_wire_keeps_truncation_metadata_in_payload() {
        let oversized = "x".repeat(MAX_CANONICAL_RAW_BYTES + 1024);
        let input = event_json(
            "peri",
            "local:s1",
            7,
            "tool.call.started",
            serde_json::json!({ "update": { "sessionUpdate": "tool_call", "blob": oversized } }),
        );
        let row = parse_canonical_event(&input).expect("oversized raw still parses");
        assert!(row.raw_truncated);

        let wire = canonical_event_wire(&row);
        assert_eq!(wire["rawMetadata"]["truncated"], true);
        assert_eq!(wire["rawMetadata"]["reason"], "size");
        assert_eq!(
            wire["rawMetadata"]["originalBytes"],
            serde_json::json!(row.raw_original_bytes)
        );
        // 已裁剪载荷很短 ⇒ 重解析报未截断：前端取证依赖 rawMetadata，而非重解析。
        let reparsed = parse_canonical_event(&wire).expect("wire reparses");
        assert!(!reparsed.raw_truncated);
        assert_eq!(reparsed.raw_payload, row.raw_payload);
    }

    /// #81 L2：非终结事件不折叠（未终结 turn 不产生单元行）。
    #[test]
    fn non_terminal_ingest_does_not_build_unit() {
        let repo = repo();
        let result = repo.ingest_kernel_event(kernel_input(serde_json::json!({
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "未终结" } }
        }))).unwrap();
        assert_eq!(result.events.len(), 1);
        let compact = repo
            .load_events_compact(&serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap())
            .unwrap();
        assert_eq!(compact.len(), 1);
        assert_eq!(compact[0].event_type, "assistant.text.delta");
    }

    /// #81 L3：预算暂停 / 续跑 / 幂等；sha256 校验通过才删行；完成后 VACUUM。
    #[test]
    fn rollup_trim_pauses_on_budget_and_resumes() {
        let repo = repo();
        let delta = |text: &str| {
            serde_json::json!({
                "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": text } }
            })
        };
        // 两个 turn → 两个单元
        for text in ["a", "b"] {
            repo.ingest_kernel_event(kernel_input(delta(text))).unwrap();
            repo.ingest_kernel_event(kernel_input(serde_json::json!({
                "update": { "sessionUpdate": "done" }
            })))
            .unwrap();
        }

        // 预算 0：单事务边界暂停——一次只裁剪一个单元
        let first = repo.rollup_trim(Some(0)).unwrap();
        assert_eq!(first.processed_units, 1);
        assert_eq!(first.trimmed_units, 1);
        assert_eq!(first.remaining_units, 1);

        // 续跑：剩余单元完成并 VACUUM
        let second = repo.rollup_trim(None).unwrap();
        assert_eq!(second.trimmed_units, 1);
        assert_eq!(second.remaining_units, 0);
        assert!(second.vacuumed);

        // 幂等：再跑无事可做、不 VACUUM
        let again = repo.rollup_trim(None).unwrap();
        assert_eq!(again.processed_units, 0);
        assert_eq!(again.remaining_units, 0);
        assert!(!again.vacuumed);
    }

    /// #81 L3：行已删除（claim 后崩溃 / 部分删除）→ 续跑只补标记，不重复不丢失。
    #[test]
    fn rollup_trim_resume_when_rows_already_gone() {
        let repo = repo();
        let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
        repo.ingest_kernel_event(kernel_input(serde_json::json!({
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "ok" } }
        })))
        .unwrap();
        repo.ingest_kernel_event(kernel_input(serde_json::json!({
            "update": { "sessionUpdate": "done" }
        })))
        .unwrap();
        // 模拟"claim 后崩溃、行已被外部清理"：手工删除覆盖行
        {
            let conn = repo.conn.lock().unwrap();
            conn.execute("DELETE FROM canonical_events WHERE sequence <= 2", [])
                .unwrap();
        }
        let report = repo.rollup_trim(None).unwrap();
        assert_eq!(report.resumed_units, 1, "行已删路径只补标记");
        assert_eq!(report.trimmed_units, 0);
        let rows = repo.list_events(&owner_key, None, 100).unwrap();
        assert_eq!(rows.events.len(), 1, "只剩单元行");
    }

    /// #81 L3：sha256 不匹配 → 保留行（不丢弃）、永久跳过（不重试）。
    /// （行经 append_events 直写——不经 kernel ingest，因此无真实单元干扰。）
    #[test]
    fn rollup_trim_keeps_rows_on_sha_mismatch() {
        let repo = repo();
        let owner_key = serde_json::to_string(&["p1", "peri", "local:s1"]).unwrap();
        let rows = vec![
            parse_canonical_event(&event_json(
                "peri",
                "local:s1",
                1,
                "assistant.text.delta",
                serde_json::json!({ "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": "real" } } }),
            ))
            .unwrap(),
            parse_canonical_event(&event_json(
                "peri",
                "local:s1",
                2,
                "turn.completed",
                serde_json::json!({ "update": { "sessionUpdate": "done" } }),
            ))
            .unwrap(),
        ];
        repo.append_events(&rows, None).unwrap();
        let mut unit_value = event_json(
            "peri",
            "local:s1",
            3,
            "turn.unit",
            serde_json::json!({ "kind": "turn-unit" }),
        );
        unit_value["typedPayload"] = serde_json::json!({
            "aggregateKind": "turn-rollup",
            "seqStart": 1,
            "seqEnd": 2,
            "foldedCount": 2,
            "foldScheme": "adjacent-delta-fold-v1",
            "contentSha256": "deadbeef",
            "terminal": { "eventType": "turn.completed", "occurredAt": "2026-08-14T00:00:00.000Z" },
            "segments": [],
        });
        let unit_row = parse_canonical_event(&unit_value).unwrap();
        repo.append_events(&[unit_row], Some(2)).unwrap();

        let report = repo.rollup_trim(None).unwrap();
        assert_eq!(report.mismatch_units, 1, "sha 不匹配 → 保留行并跳过");
        let remaining = repo.list_events(&owner_key, None, 100).unwrap();
        let plain_rows = remaining
            .events
            .iter()
            .filter(|e| e.event_type != "turn.unit")
            .count();
        assert_eq!(plain_rows, 2, "行未被删除");
        let again = repo.rollup_trim(None).unwrap();
        assert_eq!(again.mismatch_units, 0, "mismatch 永久跳过不重试");
        assert_eq!(again.remaining_units, 0);
    }

    /// #81 L3：空 journal 上裁剪为 no-op（不 VACUUM）。
    #[test]
    fn rollup_trim_report_is_empty_on_fresh_journal() {
        let repo = repo();
        let report = repo.rollup_trim(None).unwrap();
        assert_eq!(report.processed_units, 0);
        assert_eq!(report.remaining_units, 0);
        assert!(!report.vacuumed);
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
            event.provenance_origin == "recovery-import" && event.provenance_trust == "unverified"
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
        assert_eq!(
            page.events[0].typed_payload.as_ref().unwrap()["text"],
            "local"
        );
        assert!(page
            .events
            .iter()
            .all(|event| event.event_type != "history.snapshot"));
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
        assert!(page
            .events
            .iter()
            .all(|event| event.event_type != "history.snapshot"));
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
        repo.append_events(std::slice::from_ref(&first), None)
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
    fn interaction_credentials_are_redacted_before_canonical_journal_append() {
        let repo = repo();
        let credential = "c12-journal-credential";
        let mut ev = event_json(
            "peri",
            "s1",
            1,
            "interaction.requested",
            serde_json::json!({
                "request": {
                    "kind": "sudo",
                    "command": "apt update",
                    "password": credential,
                    "nested": { "clientSecret": credential }
                }
            }),
        );
        ev["typedPayload"] = serde_json::json!({
            "request": { "kind": "sudo", "password": credential }
        });

        let result = repo
            .append_events(&[parse_canonical_event(&ev).unwrap()], None)
            .unwrap();
        let row = &result.events[0];
        let persisted = serde_json::to_string(row).unwrap();
        assert!(!persisted.contains(credential));
        assert_eq!(row.raw_payload["request"]["command"], "apt update");
        assert_eq!(row.raw_payload["request"]["passwordRedacted"], true);
        assert_eq!(
            row.raw_payload["request"]["nested"]["clientSecretRedacted"],
            true
        );
        assert_eq!(
            row.typed_payload.as_ref().unwrap()["request"]["passwordRedacted"],
            true
        );
        let exported = repo
            .export_raw_event(&row.event_id)
            .expect("export")
            .expect("row");
        assert!(!exported.raw_payload_json.contains(credential));
        assert!(exported.raw_payload_json.contains("passwordRedacted"));
        assert!(!exported
            .typed_payload_json
            .as_deref()
            .unwrap_or_default()
            .contains(credential));
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
            repo.append_events(std::slice::from_ref(&row), None)
                .expect("append");
            repo.conn
                .lock()
                .unwrap()
                .execute(
                    &format!(
                        "UPDATE canonical_events SET {column} = '{{broken' WHERE owner_key = ?1 AND sequence = ?2"
                    ),
                    params![row.owner_key, row.sequence],
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
        repo.append_events(std::slice::from_ref(&a_row), None)
            .unwrap();
        repo.append_events(std::slice::from_ref(&b_row), None)
            .unwrap();
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
        repo.append_events(std::slice::from_ref(&r1), None).unwrap();
        repo.append_events(std::slice::from_ref(&r2), None).unwrap();
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
            // #155 T2（v15）：存储列收窄为 15 列；v13 的 envelope/provenance/raw_* 列
            // 已由读侧派生取代（wire 28 字段契约不变）。
            for column in [
                "owner_key",
                "remote_session_id",
                "sequence",
                "client_generation",
                "occurred_at",
                "received_at",
                "event_type",
                "payload_version",
                "identity",
                "typed_payload",
                "raw_payload",
                "created_at",
                "provenance",
                "rollup_seq_start",
                "rollup_seq_end",
            ] {
                let present: bool = conn
                    .prepare("SELECT 1 FROM pragma_table_info('canonical_events') WHERE name = ?1")
                    .unwrap()
                    .query_row([column], |_| Ok(true))
                    .optional()
                    .unwrap()
                    .unwrap_or(false);
                assert!(present, "v15 canonical_events 缺少列 {column}");
            }
            for derived in [
                "event_id",
                "profile_id",
                "agent_id",
                "local_session_id",
                "schema_version",
                "provenance_origin",
                "provenance_trust",
                "raw_truncated",
            ] {
                let present: bool = conn
                    .prepare("SELECT 1 FROM pragma_table_info('canonical_events') WHERE name = ?1")
                    .unwrap()
                    .query_row([derived], |_| Ok(true))
                    .optional()
                    .unwrap()
                    .unwrap_or(false);
                assert!(!present, "v15 派生列不得落库: {derived}");
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

    /// #51 收口：latest_event_of_type 取同类型最新 sequence 行、跨类型过滤、
    /// 空结果返回 None——写入侧幂等判定的查询语义钉住。
    #[test]
    fn latest_event_of_type_returns_newest_matching_row() {
        let repo = repo();
        let selector = |value: &str| {
            serde_json::json!({
                "source": "local:s1",
                "update": {
                    "sessionUpdate": "config_option_update",
                    "configOptions": [{ "id": value }]
                }
            })
        };
        let owner_key = repo
            .ingest_kernel_event(kernel_input(selector("v1")))
            .expect("ingest v1")
            .events[0]
            .owner_key
            .clone();
        repo.ingest_kernel_event(kernel_input(serde_json::json!({
            "source": "local:s1",
            "update": {
                "sessionUpdate": "tool_call_update",
                "toolCallId": "root-tool",
                "content": { "toolCallId": "root-tool" },
                "title": "Write",
                "kind": "edit",
                "status": "completed",
                "rawOutput": { "ok": true }
            }
        })))
        .expect("ingest tool update");
        repo.ingest_kernel_event(kernel_input(selector("v2")))
            .expect("ingest v2");

        let latest = repo
            .latest_event_of_type(&owner_key, "session.config-updated")
            .expect("selector query")
            .expect("selector row exists");
        assert_eq!(latest.sequence, 3);
        assert_eq!(
            latest.raw_payload.pointer("/update/configOptions/0/id"),
            Some(&serde_json::json!("v2"))
        );

        let tool = repo
            .latest_event_of_type(&owner_key, "tool.call.completed")
            .expect("tool query")
            .expect("tool row exists");
        assert_eq!(tool.sequence, 2);

        assert!(repo
            .latest_event_of_type(&owner_key, "turn.completed")
            .expect("absent query")
            .is_none());
    }

    // ── #205：compact 读的尾部 delta 折叠 ───────────────────────────────────

    /// 该 owner 的 owner key（测试内固定 profile=p1 / agent=peri / session=local:s1）。
    fn owner_key() -> String {
        DurableSessionOwner::new("p1", "peri", "local:s1")
            .key()
            .expect("owner key")
    }

    fn text_delta(text: &str) -> serde_json::Value {
        serde_json::json!({
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "text": text } }
        })
    }

    fn thinking_delta(text: &str) -> serde_json::Value {
        serde_json::json!({
            "update": { "sessionUpdate": "agent_thought_chunk", "content": { "text": text } }
        })
    }

    #[test]
    fn compact_read_folds_adjacent_uncovered_delta_run_into_batch_row() {
        let repo = repo();
        repo.ingest_kernel_events(vec![
            kernel_input(text_delta("甲")),
            kernel_input(text_delta("乙")),
            kernel_input(text_delta("丙")),
        ])
        .expect("ingest");

        let rows = repo.load_events_compact(&owner_key()).expect("compact");

        assert_eq!(rows.len(), 1, "三条相邻同类 delta 折成一行");
        let row = &rows[0];
        assert_eq!(row.event_type, "assistant.text.delta.batch");
        assert_eq!(row.sequence, 3, "跨度占用段末 sequence");
        assert_eq!(row.event_id, format!("{}#3", owner_key()));
        let typed = row.typed_payload.as_ref().expect("typed payload");
        assert_eq!(typed["text"], "甲乙丙");
        assert_eq!(typed["foldedCount"], 3);
        assert_eq!(typed["seqSpan"], serde_json::json!([1, 3]));
        assert_eq!(
            row.raw_payload.as_array().expect("raw chunk array").len(),
            3,
            "rawPayload 是原始 chunk 数组（长度 == foldedCount == 跨度宽度）"
        );
        assert_eq!(
            row.raw_payload_json,
            row.raw_payload.to_string(),
            "v15 不变量：raw_payload_json 与 raw_payload 序列化逐字节相等"
        );
        assert!(row.rollup_seq_start.is_none() && row.rollup_seq_end.is_none());
    }

    #[test]
    fn compact_read_keeps_single_delta_unfolded() {
        let repo = repo();
        repo.ingest_kernel_events(vec![kernel_input(text_delta("独"))])
            .expect("ingest");

        let rows = repo.load_events_compact(&owner_key()).expect("compact");

        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].event_type, "assistant.text.delta",
            "单条 run 不合并"
        );
        assert_eq!(rows[0].sequence, 1);
    }

    #[test]
    fn compact_read_breaks_run_on_non_delta_row() {
        let repo = repo();
        repo.ingest_kernel_events(vec![
            kernel_input(text_delta("甲")),
            kernel_input(serde_json::json!({
                "update": {
                    "sessionUpdate": "tool_call_update",
                    "toolCallId": "c1",
                    "status": "completed"
                }
            })),
            kernel_input(text_delta("乙")),
        ])
        .expect("ingest");

        let rows = repo.load_events_compact(&owner_key()).expect("compact");

        assert_eq!(rows.len(), 3, "非 delta 行打断 run：两侧各剩单条");
        assert_eq!(rows[0].event_type, "assistant.text.delta");
        assert_eq!(rows[1].event_type, "tool.call.completed");
        assert_eq!(rows[2].event_type, "assistant.text.delta");
    }

    #[test]
    fn compact_read_breaks_run_on_identity_change() {
        let repo = repo();
        let identified = |text: &str, message_id: &str| {
            serde_json::json!({
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "messageId": message_id,
                    "content": { "text": text }
                }
            })
        };
        repo.ingest_kernel_events(vec![
            kernel_input(identified("甲", "m1")),
            kernel_input(identified("乙", "m1")),
            kernel_input(identified("丙", "m2")),
        ])
        .expect("ingest");

        let rows = repo.load_events_compact(&owner_key()).expect("compact");

        assert_eq!(rows.len(), 2, "identity 变化切断 run");
        assert_eq!(rows[0].event_type, "assistant.text.delta.batch");
        assert_eq!(rows[0].typed_payload.as_ref().unwrap()["text"], "甲乙");
        assert_eq!(rows[1].event_type, "assistant.text.delta");
    }

    #[test]
    fn compact_read_keeps_delta_kinds_in_separate_runs() {
        let repo = repo();
        repo.ingest_kernel_events(vec![
            kernel_input(thinking_delta("思")),
            kernel_input(thinking_delta("考")),
            kernel_input(text_delta("答")),
            kernel_input(text_delta("案")),
        ])
        .expect("ingest");

        let rows = repo.load_events_compact(&owner_key()).expect("compact");

        assert_eq!(rows.len(), 2, "text 与 thinking 各自成 run");
        assert_eq!(rows[0].event_type, "assistant.thinking.delta.batch");
        assert_eq!(rows[1].event_type, "assistant.text.delta.batch");
        assert_eq!(rows[0].typed_payload.as_ref().unwrap()["text"], "思考");
        assert_eq!(rows[1].typed_payload.as_ref().unwrap()["text"], "答案");
    }

    #[test]
    fn compact_read_cuts_run_at_fold_budget_without_losing_rows() {
        let repo = repo();
        // 48 KiB / 2000 chunk 两个预算里更紧的那个先触发（本用例是字节预算），
        // 契约是「切断成多行、跨段连续、不丢行」，不是具体切成几行。
        let total = MAX_FOLDED_CHUNKS + 1;
        let inputs = (1..=total)
            .map(|index| kernel_input(text_delta(&format!("{index},"))))
            .collect::<Vec<_>>();
        repo.ingest_kernel_events(inputs).expect("ingest");

        let rows = repo.load_events_compact(&owner_key()).expect("compact");

        assert!(rows.len() > 1, "预算用尽必须切断成多行（不截断）");
        let mut folded = 0usize;
        let mut expected_start = 1_i64;
        for row in &rows {
            if !row.event_type.ends_with(".batch") {
                assert_eq!(row.sequence, expected_start, "尾部单条按原序保留");
                folded += 1;
                expected_start += 1;
                continue;
            }
            let typed = row.typed_payload.as_ref().expect("typed payload");
            let span = typed["seqSpan"].as_array().expect("seqSpan");
            let count = typed["foldedCount"].as_i64().expect("foldedCount") as usize;
            assert_eq!(span[0].as_i64(), Some(expected_start), "跨度连续且不重叠");
            assert_eq!(
                span[1].as_i64(),
                Some(row.sequence),
                "跨度占用段末 sequence"
            );
            assert_eq!(row.raw_payload.as_array().expect("raw array").len(), count);
            assert!(count <= MAX_FOLDED_CHUNKS, "不得越 foldedCount 上限");
            assert!(count >= 2, "单条不成 batch 行");
            folded += count;
            expected_start = row.sequence + 1;
        }
        assert_eq!(folded, total, "切断不丢行");
    }
}

#[cfg(test)]
mod fold_tests {
    use super::*;

    fn repo() -> EventRepo {
        EventRepo::open_in_memory().expect("open in-memory")
    }

    fn owner() -> DurableSessionOwner {
        DurableSessionOwner::new("p1", "peri", "local:s1")
    }

    fn owner_key() -> String {
        owner().key().expect("owner key")
    }

    fn thinking(text: &str) -> KernelEventInput {
        KernelEventInput {
            owner: owner(),
            remote_session_id: Some("remote-1".to_string()),
            client_generation: 1,
            received_at: "2026-09-20T00:00:00.000Z".to_string(),
            raw_payload: serde_json::json!({
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "messageId": "thought-1",
                    "content": { "type": "text", "text": text }
                }
            }),
            recovery_import: false,
        }
    }

    /// ADR-0016 / #155 T3-1：同一窗口内的相邻同类 delta 折成**一行**，跨度占位。
    #[test]
    fn kernel_batch_ingest_folds_adjacent_deltas_into_one_span_row() {
        let repo = repo();
        let result = repo
            .ingest_kernel_events(vec![thinking("甲"), thinking("乙"), thinking("丙")])
            .expect("ingest");

        assert_eq!(result.events.len(), 1, "三条相邻同类 delta 折成一行");
        let row = &result.events[0];
        assert_eq!(row.event_type, "assistant.thinking.delta.batch");
        assert_eq!(row.sequence, 3, "跨度占位：行落在跨度末位");
        assert_eq!(result.revision, 3, "revision = max sequence，编号不重排");
        assert_eq!(
            row.typed_payload.as_ref().unwrap()["seqSpan"],
            serde_json::json!([1, 3])
        );
        assert_eq!(row.typed_payload.as_ref().unwrap()["foldedCount"], 3);
        assert_eq!(row.typed_payload.as_ref().unwrap()["text"], "甲乙丙");
        assert_eq!(row_input_span_width(row), 3, "承载三个输入");

        // span 中间的编号没有行（ADR-0016 明确允许的空洞）
        let compact = repo.load_events_compact(&owner_key()).expect("compact");
        assert_eq!(compact.len(), 1);
        assert_eq!(compact[0].sequence, 3);
    }

    /// 非 delta 行与 identity 变化都不得被并进同一行。
    #[test]
    fn kernel_batch_ingest_does_not_fold_across_boundaries() {
        let repo = repo();
        let identified = |text: &str, message_id: &str| KernelEventInput {
            owner: owner(),
            remote_session_id: Some("remote-1".to_string()),
            client_generation: 1,
            received_at: "2026-09-20T00:00:00.000Z".to_string(),
            raw_payload: serde_json::json!({
                "update": {
                    "sessionUpdate": "agent_thought_chunk",
                    "messageId": message_id,
                    "content": { "type": "text", "text": text }
                }
            }),
            recovery_import: false,
        };
        let tool = KernelEventInput {
            owner: owner(),
            remote_session_id: Some("remote-1".to_string()),
            client_generation: 1,
            received_at: "2026-09-20T00:00:00.000Z".to_string(),
            raw_payload: serde_json::json!({
                "update": { "sessionUpdate": "tool_call_update", "toolCallId": "c1", "status": "completed" }
            }),
            recovery_import: false,
        };

        let result = repo
            .ingest_kernel_events(vec![
                thinking("甲"),
                thinking("乙"),
                tool,
                identified("丙", "m2"),
                identified("丁", "m2"),
            ])
            .expect("ingest");

        assert_eq!(
            result.events.len(),
            3,
            "三类各成一行：span 行 + 工具行 + 另一个 span 行"
        );
        assert_eq!(
            result.events[0].event_type,
            "assistant.thinking.delta.batch"
        );
        assert_eq!(result.events[0].sequence, 2);
        assert_eq!(result.events[1].event_type, "tool.call.completed");
        assert_eq!(result.events[1].sequence, 3);
        assert_eq!(
            result.events[2].event_type,
            "assistant.thinking.delta.batch"
        );
        assert_eq!(result.events[2].sequence, 5);
        assert_eq!(result.revision, 5);
        assert_eq!(row_input_span_width(&result.events[1]), 1);
    }

    /// 窗口边界处 run 断开（每行自带跨度，跨窗口拆行不改变投影）。
    #[test]
    fn kernel_batch_ingest_folds_per_window_only() {
        let repo = repo();
        let first = repo
            .ingest_kernel_events(vec![thinking("甲"), thinking("乙")])
            .expect("w1");
        let second = repo
            .ingest_kernel_events(vec![thinking("丙"), thinking("丁")])
            .expect("w2");

        assert_eq!(first.events.len(), 1);
        assert_eq!(first.events[0].sequence, 2);
        assert_eq!(second.events.len(), 1);
        assert_eq!(second.events[0].sequence, 4);
        assert_eq!(
            second.events[0].typed_payload.as_ref().unwrap()["seqSpan"],
            serde_json::json!([3, 4])
        );
        assert_eq!(
            repo.load_events_compact(&owner_key())
                .expect("compact")
                .len(),
            2
        );
    }

    /// 终态行不被并入，且同一事务里仍能按库内行构建 turn.unit（含聚合行输入）。
    #[test]
    fn kernel_batch_ingest_terminal_still_builds_turn_unit() {
        let repo = repo();
        let done = KernelEventInput {
            owner: owner(),
            remote_session_id: Some("remote-1".to_string()),
            client_generation: 1,
            received_at: "2026-09-20T00:00:00.000Z".to_string(),
            raw_payload: serde_json::json!({ "update": { "sessionUpdate": "done" } }),
            recovery_import: false,
        };
        let result = repo
            .ingest_kernel_events(vec![thinking("甲"), thinking("乙"), done])
            .expect("ingest");

        assert_eq!(result.events.len(), 3, "span row + terminal + unit");
        assert_eq!(
            result.events[0].event_type,
            "assistant.thinking.delta.batch"
        );
        assert_eq!(result.events[0].sequence, 2);
        assert_eq!(result.events[1].event_type, "turn.completed");
        assert_eq!(result.events[1].sequence, 3);
        assert_eq!(result.events[2].event_type, "turn.unit");
        assert_eq!(
            result.revision, 4,
            "unit 在同事务内多占一个 sequence 并计入 revision"
        );
        let units = repo
            .latest_event_of_type(&owner_key(), "turn.unit")
            .expect("query")
            .expect("unit row");
        assert_eq!(
            units.sequence, result.revision,
            "单元行是本批最后写入的一行（revision 含单元）"
        );
        assert_eq!(
            repo.load_events_compact(&owner_key())
                .expect("compact")
                .len(),
            1
        );
    }
}
