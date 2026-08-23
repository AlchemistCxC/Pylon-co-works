//! 会话仓库：SQLite 持久化（sessions / deleted_sessions / user_data /
//! retention_policy / canonical_events）。
//!
//! 契约：
//! - `canonical_events` 是唯一会话历史权威（A1-c + B7）。v11 升级不再物理删除
//!   v8 message 表：可证明部分回填到同一 journal，全部源表改名保留供取证。
//! - `canonical_events` append-only 事件流由 event_repo 读写；本模块负责统一
//!   schema 迁移与 sessions/tombstone/retention/user_data 同库持久化。
//! - 同步访问（`Mutex<Connection>`，SQLite 单写者）；上层须经 spawn_blocking
//!   调用，不得在 async 执行器线程上直接执行。

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::ser::SerializeMap;
use serde::Serialize;

use crate::error::PylonError;

/// 当前 schema 版本（PRAGMA user_version）。新增迁移必须同步递增。
/// v3：I14-W5 增加 user_data 表（versioned Profile/Session/activeProfileId 后端存储）。
/// v4：I14-W7 增加 deleted_sessions 表（tombstone——删除的会话拒绝迟到写复活）。
/// v5：I14-W9 增加 retention_policy 表（versioned 保留策略 + revision 后端权威存储）。
/// v6：EVT-02 增加 canonical_events 表（canonical 事件流——方案书 §5.10 迁移原则 1：
///     新表先上线，旧 messages/MessageRecord 不删除；append-only + owner 维 sequence）。
/// v7：DEL-02 升级 deleted_sessions 为 owner/deletion state（方案书 §5.12——现有 tombstone
///     加 owner_key/state/deletion_revision/reason；兼容旧行视为 deleted；不重复建第二套）。
/// v8：会话级可恢复状态快照列 session_state（usage/commands 等）。
/// v9：历史版本曾删除 messages/send_attempts/message_migrations；v11 起旧库升级改为归档。
/// v10：会话状态快照改用完整 durable owner 键；旧 sessions.state 只做保留/可证明迁移。
/// v11：旧 message 表不再直接 DROP；可证明消息 backfill 为同 journal snapshot，原表
///      事务内改名为 forensic archive，并写 legacy_message_backfill_audit。
/// v12：deleted_sessions 原表迁移为 owner_key 主键；legacy tombstone 显式标 scope，
///      v11 源表保留为 forensic archive，避免同 source 多 owner 互相覆盖。
/// v13：canonical_events 增加 versioned envelope/provenance/raw 截断元数据；旧行
///      append-only 保留并默认标记 migration/unverified。
pub(crate) const SCHEMA_VERSION: i64 = 13;

/// 当前 schema DDL（CREATE IF NOT EXISTS；升版迁移在 migrate() 内按版本补齐）。
/// - sessions：会话行 + v8 会话级可恢复状态快照列（usage/commands 等）。
/// - user_data：versioned Profile/Session/activeProfileId（与会话同库）。
/// - deleted_sessions：DEL-02 owner/deletion state tombstone（deleting/deleted）。
/// - retention_policy：保留策略后端权威存储（单行）。
/// - canonical_events：canonical 事件流（append-only；唯一会话历史权威）。
/// - legacy_message_backfill_audit：v11 旧 message 数据的回填/归档结果；不是第二份历史权威。
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    session_state TEXT
);
-- v10：usage/commands 等可恢复快照。它不是历史存储；canonical_events 仍是唯一 durable
-- history。remote_session_id 仅记录最近映射，不参与 identity 或查询主键。
CREATE TABLE IF NOT EXISTS session_state_snapshots (
    owner_key TEXT PRIMARY KEY NOT NULL,
    profile_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    local_session_id TEXT NOT NULL,
    remote_session_id TEXT,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(profile_id, agent_id, local_session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_state_snapshots_remote
    ON session_state_snapshots(agent_id, remote_session_id);
-- I14-W5：用户数据仓库（versioned Profile/Session/activeProfileId）——与消息同库。
-- key ∈ {profiles, sessions}；version = envelope version；revision 单调递增（乐观并发）；
-- payload = 前端 envelope 原文（自描述含 version）；原子写/损坏报错见 user_data.rs。
CREATE TABLE IF NOT EXISTS user_data (
    key TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
-- I14-W7 + DEL-02（v7）：会话删除 tombstone——删除时写入本表；touch/append 先查本表，
-- 命中即拒绝（session_deleted），防止 controller/scheduler 迟到写复活已删会话。
-- DEL-02（方案书 §5.12）：升级为 owner/deletion state——owner_key（JSON 数组序列化，
-- [profileId, agentId, localSessionId]，与 event_repo 同纪律）、state（deleting/deleted，
-- 兼容旧行恒为 deleted）、deletion_revision（删除 revision 乐观并发）、reason（删除原因）。
-- v12 以 owner_key 为唯一 identity；session_id 仅供 legacy wildcard gate 与诊断。
-- owner_scope=exact 只 gate 该 owner；legacy gate 同 local_session_id 的所有 owner。
CREATE TABLE IF NOT EXISTS deleted_sessions (
    owner_key TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    owner_scope TEXT NOT NULL CHECK (owner_scope IN ('exact', 'legacy')),
    deleted_at INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'deleted',
    deletion_revision INTEGER NOT NULL DEFAULT 0,
    reason TEXT
);
-- I14-W9：保留策略后端权威存储（单行；version + revision 乐观并发；payload 为
-- RetentionPolicy JSON——mode/days/count 档位契约见 retention.rs）。
CREATE TABLE IF NOT EXISTS retention_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
-- EVT-02（v6）+ B7（v9）：canonical 事件流表（方案书 §5.10 append-only 事件模型）。
-- active schema 不再使用旧 messages/MessageRecord；本表是唯一会话历史权威。
-- 原则 5：unknown event 不得静默丢弃——raw_payload 恒存。owner_key = JSON 数组序列化
-- （禁冒号拼接，与 toCanonicalOwnerKey 同纪律）；UNIQUE(owner_key, sequence) 保证
-- owner/session 范围内 sequence 单调不重复（§5.10 rule 3）；event_id 为 owner_key#sequence
-- 确定性推导（rule 1，禁 content 哈希）。occurred_at/received_at 存原始 ISO 文本，
-- payloadVersion 版本化（rule 4）。本表不设 FK（事件流先于/独立于 messages 会话行；
-- DEL-02 owner 化 tombstone 在 M4 处理，禁止第二套删除语义）。
CREATE TABLE IF NOT EXISTS canonical_events (
    event_id TEXT PRIMARY KEY NOT NULL,
    owner_key TEXT NOT NULL,
    profile_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    local_session_id TEXT NOT NULL,
    remote_session_id TEXT,
    client_generation INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    event_type TEXT NOT NULL,
    payload_version INTEGER NOT NULL,
    identity TEXT,
    typed_payload TEXT,
    raw_payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    provenance_origin TEXT NOT NULL DEFAULT 'migration',
    provenance_trust TEXT NOT NULL DEFAULT 'unverified',
    provenance_provider TEXT,
    provenance_import_id TEXT,
    raw_truncated INTEGER NOT NULL DEFAULT 0,
    raw_original_bytes INTEGER NOT NULL DEFAULT 0,
    raw_retained_bytes INTEGER NOT NULL DEFAULT 0,
    raw_omitted_bytes INTEGER NOT NULL DEFAULT 0,
    raw_truncation_reason TEXT,
    UNIQUE(owner_key, sequence)
);
CREATE INDEX IF NOT EXISTS idx_canonical_events_session_seq
    ON canonical_events(local_session_id, sequence);
CREATE TABLE IF NOT EXISTS legacy_message_backfill_audit (
    session_id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    message_count INTEGER NOT NULL,
    owner_key TEXT,
    created_at INTEGER NOT NULL
);
"#;

/// 会话仓库：单一 SQLite 连接 + 互斥（SQLite 单写者）。
pub(crate) struct MsgRepo {
    conn: Mutex<Connection>,
}

/// I14-W9：保留策略行（单行；version + revision + payload JSON；wire camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetentionPolicyRow {
    pub(crate) version: i64,
    pub(crate) revision: i64,
    pub(crate) payload: String,
}

/// I14-W9：保留候选（preview）与执行结果（prune）的每会话计数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionCandidateCount {
    pub(crate) session_id: String,
    pub(crate) count: i64,
}

/// I14-W9：保留 preview/prune 结果（preview 不删除；prune 返回实际删除计数）。
/// I13-W4：增 affected_sessions / oldest_deleted_at（by_time 为 cutoff，其余 None）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetentionPreview {
    pub(crate) total_candidates: i64,
    pub(crate) affected_sessions: i64,
    /// by_time：最早将被删除的 cutoff（毫秒）；by_count/permanent：None。
    pub(crate) oldest_deleted_at: Option<i64>,
    pub(crate) per_session: Vec<SessionCandidateCount>,
}

/// MessageService 结构化错误（B1.2：前端按 code 分支，message 展示用）。
/// ISSUE-20 W4：rusqlite 错误不再全部折叠为 unavailable——按 SQLite 错误码区分
/// corrupt（库损坏/非库文件）/ constraint（约束冲突）/ conflict（并发锁）/
/// unavailable（其余不可用），前端可据 code 区分诊断与重试策略。
#[derive(Debug, thiserror::Error)]
pub(crate) enum MessageError {
    /// SQLITE_CORRUPT / SQLITE_NOTADB：数据库镜像损坏或非数据库文件。
    #[error("消息仓库损坏：{0}")]
    Corrupt(String),
    /// SQLITE_CONSTRAINT：唯一性/FK 等约束冲突。
    #[error("消息仓库约束冲突：{0}")]
    Constraint(String),
    /// SQLITE_BUSY / SQLITE_LOCKED：并发写锁冲突（可重试）。
    #[error("消息仓库并发锁冲突：{0}")]
    Conflict(String),
    /// DB 不可用（open/迁移/任务失败等其余 rusqlite 错误）；命令对 None/Err 报该码。
    #[error("消息仓库不可用：{0}")]
    Unavailable(String),
    /// I14-W7：会话已删除（tombstone）——迟到写被拒绝，不复活已删会话。
    #[error("会话已删除（tombstone）：{0}")]
    SessionDeleted(String),
}

impl MessageError {
    /// 机器可读错误码（稳定，不改拼写）。
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Corrupt(_) => "message_repo_corrupt",
            Self::Constraint(_) => "message_repo_constraint",
            Self::Conflict(_) => "message_repo_conflict",
            Self::Unavailable(_) => "message_db_unavailable",
            Self::SessionDeleted(_) => "session_deleted",
        }
    }
}

/// B1.2：结构化错误 wire `{ code, message }`（W2 IPC——Tauri command 直接返回
/// `Result<T, MessageError>`，前端按 code 分支，message 仅展示）。与 PylonError 同形。
impl Serialize for MessageError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("code", self.code())?;
        map.serialize_entry("message", &self.to_string())?;
        map.end()
    }
}

impl From<rusqlite::Error> for MessageError {
    fn from(error: rusqlite::Error) -> Self {
        // ISSUE-20 W4：按 SQLite 错误码分类，不再全部折叠为 unavailable
        if let rusqlite::Error::SqliteFailure(failure, _) = &error {
            return match failure.code {
                rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase => {
                    Self::Corrupt(format!("message repo: {error}"))
                }
                rusqlite::ErrorCode::ConstraintViolation => {
                    Self::Constraint(format!("message repo: {error}"))
                }
                rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => {
                    Self::Conflict(format!("message repo: {error}"))
                }
                _ => Self::Unavailable(format!("message repo: {error}")),
            };
        }
        Self::Unavailable(format!("message repo: {error}"))
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// I14-W7：会话 tombstone 检查——deleted_sessions 命中即拒绝（迟到写不复活已删会话）。
fn ensure_session_not_deleted(conn: &Connection, session_id: &str) -> Result<(), MessageError> {
    let deleted: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM deleted_sessions WHERE session_id = ?1)",
            params![session_id],
            |row| row.get(0),
        )
        .map_err(MessageError::from)?;
    if deleted {
        return Err(MessageError::SessionDeleted(session_id.to_string()));
    }
    Ok(())
}

fn ensure_owner_not_deleted(
    conn: &Connection,
    owner: &crate::session::DurableSessionOwner,
    owner_key: &str,
) -> Result<(), MessageError> {
    let deleted: bool = conn
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM deleted_sessions
                 WHERE owner_key = ?1
                    OR (session_id = ?2 AND owner_scope = 'legacy')
             )",
            params![owner_key, owner.local_session_id],
            |row| row.get(0),
        )
        .map_err(MessageError::from)?;
    if deleted {
        return Err(MessageError::SessionDeleted(owner_key.to_string()));
    }
    Ok(())
}

fn get_session_state_for_owner_inner(
    conn: &Connection,
    owner_key: &str,
) -> Result<Option<serde_json::Value>, MessageError> {
    let value: Option<String> = conn
        .query_row(
            "SELECT state FROM session_state_snapshots WHERE owner_key = ?1",
            params![owner_key],
            |row| row.get(0),
        )
        .optional()
        .map_err(MessageError::from)?;
    value
        .map(|json| {
            serde_json::from_str(&json).map_err(|error| {
                MessageError::Corrupt(format!("session state snapshot owner={owner_key}: {error}"))
            })
        })
        .transpose()
}

/// DEL-03（§5.13 步骤 1）：校验 owner_key（JSON 数组序列化 [profileId, agentId,
/// localSessionId]——与 event_repo/eventSchema toCanonicalOwnerKey 同纪律，禁止冒号拼接
/// 与任意字符串污染 tombstone owner）。仅当前端显式传 owner_key 时校验（legacy 调用
/// None 走哨兵不校验）。
pub(crate) fn validate_owner_key(owner_key: &str) -> Result<(), PylonError> {
    let parsed: serde_json::Value = serde_json::from_str(owner_key)
        .map_err(|error| PylonError::from(format!("owner_key 不是合法 JSON：{error}")))?;
    let arr = parsed
        .as_array()
        .ok_or_else(|| PylonError::from("owner_key 必须是 JSON 数组".to_string()))?;
    if arr.len() != 3 {
        return Err(PylonError::from(format!(
            "owner_key 必须是 [profileId, agentId, localSessionId] 三元素数组，实际 {} 个",
            arr.len()
        )));
    }
    for (index, item) in arr.iter().enumerate() {
        match item.as_str() {
            Some(value) if !value.is_empty() => {}
            _ => {
                return Err(PylonError::from(format!(
                    "owner_key[{index}] 必须是非空字符串"
                )))
            }
        }
    }
    Ok(())
}

fn legacy_tombstone_owner_key(session_id: &str) -> Result<String, PylonError> {
    serde_json::to_string(&["*", "*", session_id])
        .map_err(|error| PylonError::from(format!("legacy tombstone owner encode failed: {error}")))
}

fn repo_err(error: rusqlite::Error) -> PylonError {
    PylonError::from(format!("message repo: {error}"))
}

fn lock_err<E>(_: E) -> PylonError {
    PylonError::from("message repo lock poisoned".to_string())
}

/// DEL-02（v6→v7）：deleted_sessions 升级为 owner/deletion state（方案书 §5.12）。
/// - 旧表（v6 及更早）无新列：ALTER ADD COLUMN 补齐（SQLite 不允许事务内中途 ALTER 后
///   再用旧列集合的语句——补齐后继续即可；NOT NULL 需 DEFAULT 兜底）。
/// - 回填：兼容旧行视为 deleted（DEFAULT）；owner_key 优先自 canonical_events 反查
///   （同 local_session_id 的最新事件 profile/agent），无则暂用固定 legacy 标记；
///   v12 再转换为唯一的会话作用域 legacy owner。
/// - 幂等门控：以列存在性判定（新库 SCHEMA_SQL 已建新列，跳过 ALTER；旧库执行）。
/// - 复合索引 INDEX(state, deleted_at) 不在本脚本（升版库在 ALTER 后由
///   DEL_02_TOMBSTONE_INDEX_SQL 统一补建——见 migrate()）。
const DEL_02_TOMBSTONE_UPGRADE_SQL: &str = r#"
ALTER TABLE deleted_sessions ADD COLUMN owner_key TEXT NOT NULL DEFAULT '["*","*","legacy"]';
ALTER TABLE deleted_sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'deleted';
ALTER TABLE deleted_sessions ADD COLUMN deletion_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deleted_sessions ADD COLUMN reason TEXT;
UPDATE deleted_sessions SET owner_key = COALESCE(
    (
        SELECT json_array(profile_id, agent_id, local_session_id)
        FROM canonical_events
        WHERE local_session_id = deleted_sessions.session_id
        ORDER BY sequence DESC LIMIT 1
    ),
    owner_key
) WHERE owner_key = '["*","*","legacy"]';
"#;

/// DEL-02：deleted_sessions(state, deleted_at) 复合索引（§5.12 索引建议——deleting/deleted
/// 列表过滤与 orphan cleanup 扫描）。**两路径都要建**：升版库在 ALTER 后、新库 SCHEMA_SQL
/// 已建新列但未含本索引——故在 migrate() 中无条件执行（IF NOT EXISTS 幂等）。
const DEL_02_TOMBSTONE_INDEX_SQL: &str = r#"
CREATE INDEX IF NOT EXISTS idx_deleted_sessions_state_deleted_at
    ON deleted_sessions (state, deleted_at);
CREATE INDEX IF NOT EXISTS idx_deleted_sessions_session_id
    ON deleted_sessions (session_id);
"#;

/// v10 legacy state backfill. A bare `sessions.session_id` is only a source, so
/// migrate it when the existing canonical journal proves exactly one owner.
/// Ambiguous/unmapped rows remain untouched in `sessions` for later recovery.
const V10_SESSION_STATE_BACKFILL_SQL: &str = r#"
WITH owner_map AS (
    SELECT
        local_session_id,
        MIN(owner_key) AS owner_key,
        MIN(profile_id) AS profile_id,
        MIN(agent_id) AS agent_id
    FROM canonical_events
    GROUP BY local_session_id
    HAVING COUNT(DISTINCT owner_key) = 1
)
INSERT OR IGNORE INTO session_state_snapshots
    (owner_key, profile_id, agent_id, local_session_id, remote_session_id,
     state, created_at, updated_at)
SELECT
    owner_map.owner_key,
    owner_map.profile_id,
    owner_map.agent_id,
    sessions.session_id,
    (
        SELECT remote_session_id
        FROM canonical_events
        WHERE owner_key = owner_map.owner_key AND remote_session_id IS NOT NULL
        ORDER BY sequence DESC
        LIMIT 1
    ),
    sessions.session_state,
    sessions.created_at,
    sessions.updated_at
FROM sessions
JOIN owner_map ON owner_map.local_session_id = sessions.session_id
WHERE sessions.session_state IS NOT NULL;
"#;

#[derive(Debug)]
struct LegacyMessageRow {
    message_id: String,
    role: String,
    content: String,
    created_at: i64,
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool, PylonError> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
        params![table],
        |row| row.get(0),
    )
    .map_err(repo_err)
}

fn write_legacy_backfill_audit(
    tx: &rusqlite::Transaction<'_>,
    session_id: &str,
    status: &str,
    reason: Option<&str>,
    message_count: usize,
    owner_key: Option<&str>,
) -> Result<(), PylonError> {
    tx.execute(
        "INSERT INTO legacy_message_backfill_audit
             (session_id, status, reason, message_count, owner_key, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(session_id) DO UPDATE SET
             status = excluded.status,
             reason = excluded.reason,
             message_count = excluded.message_count,
             owner_key = excluded.owner_key,
             created_at = excluded.created_at",
        params![
            session_id,
            status,
            reason,
            i64::try_from(message_count).unwrap_or(i64::MAX),
            owner_key,
            now_millis(),
        ],
    )
    .map_err(repo_err)?;
    Ok(())
}

fn backfill_legacy_messages(tx: &rusqlite::Transaction<'_>) -> Result<(), PylonError> {
    if !table_exists(tx, "messages")? {
        return Ok(());
    }
    let session_ids = {
        let mut stmt = tx
            .prepare("SELECT DISTINCT session_id FROM messages ORDER BY session_id")
            .map_err(repo_err)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(repo_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(repo_err)?;
        rows
    };
    for session_id in session_ids {
        let messages = {
            let mut stmt = tx
                .prepare(
                    "SELECT message_id, role, content, created_at
                     FROM messages WHERE session_id = ?1 ORDER BY seq ASC, created_at ASC",
                )
                .map_err(repo_err)?;
            let rows = stmt
                .query_map(params![session_id], |row| {
                    Ok(LegacyMessageRow {
                        message_id: row.get(0)?,
                        role: row.get(1)?,
                        content: row.get(2)?,
                        created_at: row.get(3)?,
                    })
                })
                .map_err(repo_err)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(repo_err)?;
            rows
        };
        let owner_count: i64 = tx
            .query_row(
                "SELECT COUNT(DISTINCT owner_key) FROM canonical_events WHERE local_session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(repo_err)?;
        if owner_count != 1 {
            write_legacy_backfill_audit(
                tx,
                &session_id,
                "archived-unmapped",
                Some(if owner_count == 0 {
                    "no canonical owner evidence"
                } else {
                    "ambiguous canonical owner evidence"
                }),
                messages.len(),
                None,
            )?;
            continue;
        }
        let owner: (String, String, String, Option<String>, i64) = tx
            .query_row(
                "SELECT owner_key, profile_id, agent_id, remote_session_id, client_generation
                 FROM canonical_events WHERE local_session_id = ?1
                 ORDER BY sequence DESC LIMIT 1",
                params![session_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .map_err(repo_err)?;
        let unsupported_roles = messages
            .iter()
            .filter(|message| !matches!(message.role.as_str(), "user" | "assistant" | "reasoning"))
            .map(|message| message.role.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        if !unsupported_roles.is_empty() {
            write_legacy_backfill_audit(
                tx,
                &session_id,
                "archived-unsupported",
                Some(&format!(
                    "roles cannot be losslessly mapped: {}",
                    unsupported_roles.into_iter().collect::<Vec<_>>().join(",")
                )),
                messages.len(),
                Some(&owner.0),
            )?;
            continue;
        }
        let replay_events = messages
            .iter()
            .map(|message| {
                let session_update = match message.role.as_str() {
                    "user" => "user_message_chunk",
                    "reasoning" => "agent_thought_chunk",
                    _ => "agent_message_chunk",
                };
                serde_json::json!({
                    "source": session_id,
                    "update": {
                        "sessionUpdate": session_update,
                        "content": { "text": message.content },
                        "_meta": {
                            "pylonReplayImport": true,
                            "legacyMessageId": message.message_id,
                            "legacyCreatedAt": message.created_at,
                        }
                    }
                })
            })
            .collect::<Vec<_>>();
        let revision: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(sequence), 0) FROM canonical_events WHERE owner_key = ?1",
                params![owner.0],
                |row| row.get(0),
            )
            .map_err(repo_err)?;
        let sequence = revision.checked_add(1).ok_or_else(|| {
            PylonError::DatabaseSchemaInvalid("canonical revision exceeds i64".into())
        })?;
        let received_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let raw_payload = serde_json::json!({
            "kind": "legacy-message-backfill",
            "baseRevision": revision,
            "replayEvents": replay_events,
        });
        tx.execute(
            "INSERT INTO canonical_events
                 (event_id, owner_key, profile_id, agent_id, local_session_id,
                  remote_session_id, client_generation, sequence, occurred_at,
                  received_at, event_type, payload_version, typed_payload, raw_payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9,
                     'history.snapshot', 1, ?10, ?11, ?12)",
            params![
                format!("{}#{sequence}", owner.0),
                owner.0,
                owner.1,
                owner.2,
                session_id,
                owner.3,
                owner.4,
                sequence,
                received_at,
                serde_json::json!({
                    "complete": true,
                    "source": "legacy-messages-v8",
                    "baseRevision": revision,
                    "replayEventCount": messages.len(),
                })
                .to_string(),
                raw_payload.to_string(),
                now_millis(),
            ],
        )
        .map_err(repo_err)?;
        let stored_raw: String = tx
            .query_row(
                "SELECT raw_payload FROM canonical_events WHERE owner_key = ?1 AND sequence = ?2",
                params![owner.0, sequence],
                |row| row.get(0),
            )
            .map_err(repo_err)?;
        let stored_count = serde_json::from_str::<serde_json::Value>(&stored_raw)
            .ok()
            .and_then(|value| {
                value
                    .get("replayEvents")
                    .and_then(serde_json::Value::as_array)
                    .map(Vec::len)
            });
        if stored_count != Some(messages.len()) {
            return Err(PylonError::DatabaseSchemaInvalid(format!(
                "legacy backfill verification failed for session {session_id}"
            )));
        }
        write_legacy_backfill_audit(
            tx,
            &session_id,
            "backfilled",
            None,
            messages.len(),
            Some(&owner.0),
        )?;
    }
    Ok(())
}

fn migrate_legacy_message_tables(tx: &rusqlite::Transaction<'_>) -> Result<(), PylonError> {
    const ARCHIVES: &[(&str, &str)] = &[
        ("messages", "legacy_messages_v8_archive"),
        ("send_attempts", "legacy_send_attempts_v8_archive"),
        ("message_migrations", "legacy_message_migrations_v8_archive"),
    ];
    for (active, archive) in ARCHIVES {
        if table_exists(tx, active)? && table_exists(tx, archive)? {
            return Err(PylonError::DatabaseSchemaInvalid(format!(
                "cannot archive legacy table {active}: target {archive} already exists"
            )));
        }
    }
    backfill_legacy_messages(tx)?;
    for (active, archive) in ARCHIVES {
        if table_exists(tx, active)? {
            tx.execute_batch(&format!("ALTER TABLE {active} RENAME TO {archive}"))
                .map_err(repo_err)?;
        }
    }
    Ok(())
}

fn migrate_owner_keyed_tombstones(tx: &rusqlite::Transaction<'_>) -> Result<(), PylonError> {
    if has_column(tx, "deleted_sessions", "owner_scope") {
        return Ok(());
    }
    const ARCHIVE: &str = "deleted_sessions_v11_archive";
    if table_exists(tx, ARCHIVE)? {
        return Err(PylonError::DatabaseSchemaInvalid(format!(
            "cannot migrate deleted_sessions: target {ARCHIVE} already exists"
        )));
    }
    {
        let mut stmt = tx
            .prepare(
                "SELECT owner_key FROM deleted_sessions
                 WHERE owner_key != '[\"*\",\"*\",\"legacy\"]'",
            )
            .map_err(repo_err)?;
        let owner_keys = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(repo_err)?;
        for owner_key in owner_keys {
            let owner_key = owner_key.map_err(repo_err)?;
            if let Err(error) = validate_owner_key(&owner_key) {
                return Err(PylonError::DatabaseSchemaInvalid(format!(
                    "cannot migrate deleted_sessions: invalid owner_key {owner_key:?}: {error}"
                )));
            }
        }
    }
    let source_count: i64 = tx
        .query_row("SELECT COUNT(*) FROM deleted_sessions", [], |row| {
            row.get(0)
        })
        .map_err(repo_err)?;
    tx.execute_batch(
        "ALTER TABLE deleted_sessions RENAME TO deleted_sessions_v11_archive;
         DROP INDEX IF EXISTS idx_deleted_sessions_state_deleted_at;
         CREATE TABLE deleted_sessions (
             owner_key TEXT PRIMARY KEY NOT NULL,
             session_id TEXT NOT NULL,
             owner_scope TEXT NOT NULL CHECK (owner_scope IN ('exact', 'legacy')),
             deleted_at INTEGER NOT NULL,
             state TEXT NOT NULL DEFAULT 'deleted',
             deletion_revision INTEGER NOT NULL DEFAULT 0,
             reason TEXT
         );
         INSERT INTO deleted_sessions
             (owner_key, session_id, owner_scope, deleted_at, state, deletion_revision, reason)
         SELECT CASE
                    WHEN owner_key = '[\"*\",\"*\",\"legacy\"]'
                    THEN json_array('*', '*', session_id)
                    ELSE owner_key
                END,
                session_id,
                CASE WHEN owner_key = '[\"*\",\"*\",\"legacy\"]' THEN 'legacy' ELSE 'exact' END,
                deleted_at, state, deletion_revision, reason
         FROM deleted_sessions_v11_archive;",
    )
    .map_err(repo_err)?;
    let migrated_count: i64 = tx
        .query_row("SELECT COUNT(*) FROM deleted_sessions", [], |row| {
            row.get(0)
        })
        .map_err(repo_err)?;
    if migrated_count != source_count {
        return Err(PylonError::DatabaseSchemaInvalid(format!(
            "deleted_sessions migration count mismatch: source={source_count}, migrated={migrated_count}"
        )));
    }
    Ok(())
}

const SCHEMA_MANIFEST: &[(&str, &[&str])] = &[
    (
        "sessions",
        &["session_id", "created_at", "updated_at", "session_state"],
    ),
    (
        "session_state_snapshots",
        &[
            "owner_key",
            "profile_id",
            "agent_id",
            "local_session_id",
            "remote_session_id",
            "state",
            "created_at",
            "updated_at",
        ],
    ),
    (
        "user_data",
        &["key", "version", "revision", "payload", "updated_at"],
    ),
    (
        "deleted_sessions",
        &[
            "owner_key",
            "session_id",
            "owner_scope",
            "deleted_at",
            "state",
            "deletion_revision",
            "reason",
        ],
    ),
    (
        "retention_policy",
        &["singleton", "version", "revision", "payload", "updated_at"],
    ),
    (
        "canonical_events",
        &[
            "event_id",
            "owner_key",
            "profile_id",
            "agent_id",
            "local_session_id",
            "remote_session_id",
            "client_generation",
            "sequence",
            "occurred_at",
            "received_at",
            "event_type",
            "payload_version",
            "identity",
            "typed_payload",
            "raw_payload",
            "created_at",
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
        ],
    ),
    (
        "legacy_message_backfill_audit",
        &[
            "session_id",
            "status",
            "reason",
            "message_count",
            "owner_key",
            "created_at",
        ],
    ),
];

const REQUIRED_INDEXES: &[&str] = &[
    "idx_session_state_snapshots_remote",
    "idx_deleted_sessions_state_deleted_at",
    "idx_deleted_sessions_session_id",
    "idx_canonical_events_session_seq",
];

fn validate_schema_manifest(conn: &Connection) -> Result<(), PylonError> {
    let mut problems = Vec::new();
    for (table, required_columns) in SCHEMA_MANIFEST {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(repo_err)?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(repo_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(repo_err)?;
        if columns.is_empty() {
            problems.push(format!("missing table {table}"));
            continue;
        }
        for column in *required_columns {
            if !columns.iter().any(|existing| existing == column) {
                problems.push(format!("missing column {table}.{column}"));
            }
        }
    }
    for index in REQUIRED_INDEXES {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?1)",
                params![index],
                |row| row.get(0),
            )
            .map_err(repo_err)?;
        if !exists {
            problems.push(format!("missing index {index}"));
        }
    }
    let deleted_session_pk = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(deleted_sessions)")
            .map_err(repo_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
            })
            .map_err(repo_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(repo_err)?;
        let mut primary = rows
            .into_iter()
            .filter(|(_, order)| *order > 0)
            .collect::<Vec<_>>();
        primary.sort_by_key(|(_, order)| *order);
        primary
            .into_iter()
            .map(|(name, _)| name)
            .collect::<Vec<_>>()
    };
    if deleted_session_pk != ["owner_key"] {
        problems.push(format!(
            "deleted_sessions primary key must be owner_key, found {deleted_session_pk:?}"
        ));
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(PylonError::DatabaseSchemaInvalid(problems.join("; ")))
    }
}

fn validate_quick_check(conn: &Connection) -> Result<(), PylonError> {
    let integrity_error = |error: rusqlite::Error| PylonError::DatabaseIntegrity(error.to_string());
    let mut stmt = conn
        .prepare("PRAGMA quick_check(1)")
        .map_err(integrity_error)?;
    let results = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(integrity_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(integrity_error)?;
    if results.len() == 1 && results[0].eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(PylonError::DatabaseIntegrity(if results.is_empty() {
            "quick_check returned no result".to_string()
        } else {
            results.join("; ")
        }))
    }
}

/// 版本化迁移：PRAGMA user_version 低于 SCHEMA_VERSION 时，在单个事务内
/// 补齐 DDL 并写入新版本号；失败回滚，半迁移状态不残留（D-02）。
fn migrate(conn: &mut Connection) -> Result<(), PylonError> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(repo_err)?;
    if current > SCHEMA_VERSION {
        return Err(PylonError::DatabaseFutureSchema {
            found: current,
            supported: SCHEMA_VERSION,
        });
    }
    if current == SCHEMA_VERSION {
        return validate_schema_manifest(conn);
    }
    let tx = conn.transaction().map_err(repo_err)?;
    tx.execute_batch(SCHEMA_SQL).map_err(repo_err)?;
    // v8：会话级可恢复状态快照列（usage/commands 等），旧库补列，新库 SCHEMA_SQL 已含。
    if !has_column(&tx, "sessions", "session_state") {
        tx.execute_batch("ALTER TABLE sessions ADD COLUMN session_state TEXT")
            .map_err(repo_err)?;
    }
    // DEL-02：tombstone owner/deletion state 升版（旧库补列；新库 SCHEMA_SQL 已建新列）。
    if !has_column(&tx, "deleted_sessions", "owner_key") {
        tx.execute_batch(DEL_02_TOMBSTONE_UPGRADE_SQL)
            .map_err(repo_err)?;
    }
    // DEL-02：复合索引无条件补建——升版库 ALTER 后列已齐，新库直接建（IF NOT EXISTS 幂等）。
    tx.execute_batch(DEL_02_TOMBSTONE_INDEX_SQL)
        .map_err(repo_err)?;
    if current < 10 {
        tx.execute_batch(V10_SESSION_STATE_BACKFILL_SQL)
            .map_err(repo_err)?;
    }
    if current < 11 {
        migrate_legacy_message_tables(&tx)?;
    }
    if current < 12 {
        migrate_owner_keyed_tombstones(&tx)?;
    }
    if current < 13 {
        for (column, statement) in [
            ("schema_version", "ALTER TABLE canonical_events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1"),
            ("provenance_origin", "ALTER TABLE canonical_events ADD COLUMN provenance_origin TEXT NOT NULL DEFAULT 'migration'"),
            ("provenance_trust", "ALTER TABLE canonical_events ADD COLUMN provenance_trust TEXT NOT NULL DEFAULT 'unverified'"),
            ("provenance_provider", "ALTER TABLE canonical_events ADD COLUMN provenance_provider TEXT"),
            ("provenance_import_id", "ALTER TABLE canonical_events ADD COLUMN provenance_import_id TEXT"),
            ("raw_truncated", "ALTER TABLE canonical_events ADD COLUMN raw_truncated INTEGER NOT NULL DEFAULT 0"),
            ("raw_original_bytes", "ALTER TABLE canonical_events ADD COLUMN raw_original_bytes INTEGER NOT NULL DEFAULT 0"),
            ("raw_retained_bytes", "ALTER TABLE canonical_events ADD COLUMN raw_retained_bytes INTEGER NOT NULL DEFAULT 0"),
            ("raw_omitted_bytes", "ALTER TABLE canonical_events ADD COLUMN raw_omitted_bytes INTEGER NOT NULL DEFAULT 0"),
            ("raw_truncation_reason", "ALTER TABLE canonical_events ADD COLUMN raw_truncation_reason TEXT"),
        ] {
            if !has_column(&tx, "canonical_events", column) {
                tx.execute_batch(statement).map_err(repo_err)?;
            }
        }
    }
    tx.execute_batch(DEL_02_TOMBSTONE_INDEX_SQL)
        .map_err(repo_err)?;
    validate_schema_manifest(&tx)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(repo_err)?;
    tx.commit().map_err(repo_err)
}

/// 检查表是否已含某列（迁移幂等门控；PRAGMA table_info 读元数据，事务内可安全调用）。
fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({table})")) else {
        return false;
    };
    stmt.query_map([], |row| row.get::<_, String>(1))
        .map(|rows| rows.filter_map(|item| item.ok()).any(|name| name == column))
        .unwrap_or(false)
}

/// 打开并迁移仓库；FK 开启（历史 ON DELETE CASCADE 依赖已随 messages 表移除，
/// 保留开启以维持 SQLite 外键一致性纪律）。
/// I14-W5：busy_timeout 序列化同文件多连接写（MessageService 与 UserDataService
/// 各自持连接，避免并发写 SQLITE_BUSY）。本函数 pub(crate) 供 user_data.rs 复用
/// 同一迁移链（user_data 表随 SCHEMA_SQL 一并创建/升级）。
pub(crate) fn connect(conn: &mut Connection) -> Result<(), PylonError> {
    conn.busy_timeout(Duration::from_millis(5000))
        .map_err(repo_err)?;
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(repo_err)?;
    validate_quick_check(conn)?;
    migrate(conn)?;
    // WAL：流式期间 canonical journal 每 chunk 一次事务（dispatcher ingest_event），
    // delete 模式每事务两次 fsync + 写锁表；WAL + NORMAL 将提交降为一次 WAL append。
    // 置于完整性校验/迁移之后：损坏或非 SQLite 文件先走既定 fail-closed 路径，
    // 不得被 journal_mode pragma 的 protocol_error 抢先改变错误码。pragma 持久化
    // 于 DB 文件，重复设置幂等；synchronous=NORMAL 在 WAL 下仅可能丢最后一次
    // checkpoint 之前的落盘，事务完整性由 WAL 自身保证。
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(repo_err)?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(repo_err)?;
    validate_schema_manifest(conn)
}

impl MsgRepo {
    /// 打开（或创建）仓库并迁移到最新 schema（D-02 版本化迁移）。
    pub(crate) fn open(path: &Path) -> Result<MsgRepo, PylonError> {
        let mut conn = Connection::open(path).map_err(repo_err)?;
        connect(&mut conn)?;
        Ok(MsgRepo {
            conn: Mutex::new(conn),
        })
    }

    /// 内存仓库（测试用）。
    #[allow(dead_code)] // 测试用内存仓库
    pub(crate) fn open_in_memory() -> Result<MsgRepo, PylonError> {
        let mut conn = Connection::open_in_memory().map_err(repo_err)?;
        connect(&mut conn)?;
        Ok(MsgRepo {
            conn: Mutex::new(conn),
        })
    }

    /// Owner-keyed state write. The state snapshot is shallow-merged so usage
    /// and commands arriving in separate ACP updates do not clear each other.
    pub(crate) fn set_session_state_for_owner(
        &self,
        owner: &crate::session::DurableSessionOwner,
        remote_session_id: Option<&str>,
        state: &serde_json::Value,
    ) -> Result<(), MessageError> {
        let owner_key = owner
            .key()
            .map_err(|error| MessageError::Unavailable(error.to_string()))?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| MessageError::Unavailable("message repo lock poisoned".to_string()))?;
        ensure_owner_not_deleted(&conn, owner, &owner_key)?;
        let mut merged = state.clone();
        if let Some(existing) = get_session_state_for_owner_inner(&conn, &owner_key)? {
            if let (Some(obj), Some(existing_obj)) = (merged.as_object_mut(), existing.as_object())
            {
                for (key, value) in existing_obj {
                    if !obj.contains_key(key) {
                        obj.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        let json = serde_json::to_string(&merged)
            .map_err(|error| MessageError::Unavailable(error.to_string()))?;
        let now = now_millis();
        conn.execute(
            "INSERT INTO session_state_snapshots
                 (owner_key, profile_id, agent_id, local_session_id, remote_session_id,
                  state, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(owner_key) DO UPDATE SET
                 remote_session_id = COALESCE(excluded.remote_session_id, remote_session_id),
                 state = excluded.state,
                 updated_at = excluded.updated_at",
            params![
                owner_key,
                owner.profile_id,
                owner.agent_id,
                owner.local_session_id,
                remote_session_id,
                json,
                now,
            ],
        )
        .map_err(MessageError::from)?;
        Ok(())
    }

    pub(crate) fn get_session_state_for_owner(
        &self,
        owner: &crate::session::DurableSessionOwner,
    ) -> Result<Option<serde_json::Value>, MessageError> {
        let owner_key = owner
            .key()
            .map_err(|error| MessageError::Unavailable(error.to_string()))?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| MessageError::Unavailable("message repo lock poisoned".to_string()))?;
        get_session_state_for_owner_inner(&conn, &owner_key)
    }

    /// 写入会话级可恢复状态快照（usage/commands 等，v8 session_state 列）。
    /// merge 语义：与已存对象浅合并，新增 key 不覆盖已有 key，避免 usage 与 commands 分事件写入互相清空。
    #[cfg(test)]
    pub(crate) fn set_session_state(
        &self,
        session_id: &str,
        state: &serde_json::Value,
    ) -> Result<(), PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        ensure_session_not_deleted(&conn, session_id)
            .map_err(|error| PylonError::from(error.to_string()))?;
        let mut merged = state.clone();
        if let Some(existing) = self.get_session_state_inner(&conn, session_id)? {
            if let (Some(obj), Some(existing_obj)) = (merged.as_object_mut(), existing.as_object())
            {
                for (key, value) in existing_obj {
                    if !obj.contains_key(key) {
                        obj.insert(key.clone(), value.clone());
                    }
                }
            }
        }
        let json = serde_json::to_string(&merged)
            .map_err(|error| PylonError::Protocol(error.to_string()))?;
        conn.execute(
            "INSERT INTO sessions (session_id, created_at, updated_at, session_state) VALUES (?1, ?2, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET session_state = excluded.session_state, updated_at = excluded.updated_at",
            params![session_id, now_millis(), json],
        )
        .map_err(repo_err)?;
        Ok(())
    }

    #[cfg(test)]
    fn get_session_state_inner(
        &self,
        conn: &Connection,
        session_id: &str,
    ) -> Result<Option<serde_json::Value>, PylonError> {
        let value: Option<String> = conn
            .query_row(
                "SELECT session_state FROM sessions WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(repo_err)?;
        value
            .map(|json| {
                serde_json::from_str(&json).map_err(|error| PylonError::Protocol(error.to_string()))
            })
            .transpose()
    }

    /// 读取会话级可恢复状态快照（无则 None；损坏时报错）。
    #[cfg(test)]
    pub(crate) fn get_session_state(
        &self,
        session_id: &str,
    ) -> Result<Option<serde_json::Value>, PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let value: Option<String> = conn
            .query_row(
                "SELECT session_state FROM sessions WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(repo_err)?;
        value
            .map(|json| {
                serde_json::from_str(&json).map_err(|error| PylonError::Protocol(error.to_string()))
            })
            .transpose()
    }

    /// 记录会话（首次插入 / 已存在仅刷新 updated_at）。
    /// I14-W7：已删除会话（tombstone）拒绝复活。
    #[allow(dead_code)] // 测试/历史兼容路径保留；生产会话行由 user_data sessions envelope 维护
    pub(crate) fn touch_session(&self, session_id: &str) -> Result<(), PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        ensure_session_not_deleted(&conn, session_id)
            .map_err(|error| PylonError::from(error.to_string()))?;
        let now = now_millis();
        conn.execute(
            "INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?1, ?2, ?2)
             ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at",
            params![session_id, now],
        )
        .map_err(repo_err)?;
        Ok(())
    }

    /// D-02 + DEL-02 事务删除：删除 session 行并写 tombstone。
    /// tombstone 记录 owner/deletion state（§5.12）：owner_key 由调用方传入（None 时回退
    /// 会话作用域 legacy owner）；state 恒为 deleted；同一 owner 重复删除 INSERT OR IGNORE 幂等，
    /// 不同 owner 的 tombstone 可并存。
    /// canonical_events 行不随 delete_session 删除（append-only 事件流独立于 sessions 行）。
    #[allow(dead_code)] // 测试/直通车变体：生产走 DEL-03 两阶段（begin_delete_session → finalize）
    pub(crate) fn delete_session(
        &self,
        session_id: &str,
        owner_key: Option<&str>,
    ) -> Result<(), PylonError> {
        self.delete_session_with_state(session_id, owner_key, "deleted")
    }

    /// DEL-03（§5.13 步骤 2-4）：本地优先删除开始——同一事务内写 state='deleting'
    /// tombstone 并删除会话行；前端随后远端 close best effort 并调
    /// `finalize_session_delete` 转终态 'deleted'。'deleting' 同样被迟到写 gate（不复活）。
    pub(crate) fn begin_delete_session(
        &self,
        session_id: &str,
        owner_key: Option<&str>,
    ) -> Result<(), PylonError> {
        self.delete_session_with_state(session_id, owner_key, "deleting")
    }

    /// DEL-03（§5.13）：删除终态化——deleting → deleted。幂等：不存在/已终态均为 no-op。
    /// 失败不阻断：tombstone 保持 'deleting' 仍被 ensure_session_not_deleted gate（不复活）。
    pub(crate) fn finalize_session_delete(
        &self,
        session_id: &str,
        owner_key: Option<&str>,
    ) -> Result<(), PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        if let Some(owner_key) = owner_key {
            validate_owner_key(owner_key)?;
            conn.execute(
                "UPDATE deleted_sessions SET state = 'deleted'
                 WHERE owner_key = ?1 AND state = 'deleting'",
                params![owner_key],
            )
            .map_err(repo_err)?;
        } else {
            conn.execute(
                "UPDATE deleted_sessions SET state = 'deleted'
                 WHERE session_id = ?1 AND owner_scope = 'legacy' AND state = 'deleting'",
                params![session_id],
            )
            .map_err(repo_err)?;
        }
        Ok(())
    }

    /// tombstone 当前 state（None = 无 tombstone）。测试消费（DEL-03/05）；生产 gate 只查存在性。
    #[allow(dead_code)]
    pub(crate) fn tombstone_state(&self, session_id: &str) -> Result<Option<String>, PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let state: Option<String> = conn
            .query_row(
                "SELECT state FROM deleted_sessions WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(repo_err)?;
        Ok(state)
    }

    /// 事务删除实现（tombstone state 由调用方指定：'deleting' 两阶段 / 'deleted' 终态）。
    fn delete_session_with_state(
        &self,
        session_id: &str,
        owner_key: Option<&str>,
        state: &str,
    ) -> Result<(), PylonError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(repo_err)?;
        if let Some(owner_key) = owner_key {
            validate_owner_key(owner_key)?;
        }
        tx.execute(
            "DELETE FROM sessions WHERE session_id = ?1",
            params![session_id],
        )
        .map_err(repo_err)?;
        if let Some(owner_key) = owner_key {
            tx.execute(
                "DELETE FROM session_state_snapshots WHERE owner_key = ?1",
                params![owner_key],
            )
            .map_err(repo_err)?;
        } else {
            tx.execute(
                "DELETE FROM session_state_snapshots WHERE local_session_id = ?1",
                params![session_id],
            )
            .map_err(repo_err)?;
        }
        // I14-W7 + DEL-02/03：tombstone——写入 owner/deletion state 完整行（deleting/deleted）；
        // 迟到写被拒绝（不复活）；INSERT OR IGNORE 幂等保留首次 tombstone。
        let legacy_owner;
        let (tombstone_owner, owner_scope) = if let Some(owner_key) = owner_key {
            (owner_key, "exact")
        } else {
            legacy_owner = legacy_tombstone_owner_key(session_id)?;
            (legacy_owner.as_str(), "legacy")
        };
        tx.execute(
            "INSERT OR IGNORE INTO deleted_sessions
                 (owner_key, session_id, owner_scope, deleted_at, state, deletion_revision, reason)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, NULL)",
            params![
                tombstone_owner,
                session_id,
                owner_scope,
                now_millis(),
                state
            ],
        )
        .map_err(repo_err)?;
        tx.commit().map_err(repo_err)?;
        Ok(())
    }

    // ── I14-W9：保留策略执行（policy 读写 + preview/prune 同一筛选） ──

    /// 读取保留策略行（单行；无 → None）。
    pub(crate) fn retention_policy_get(&self) -> Result<Option<RetentionPolicyRow>, PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        conn.query_row(
            "SELECT version, revision, payload FROM retention_policy WHERE singleton = 1",
            [],
            |row| {
                Ok(RetentionPolicyRow {
                    version: row.get(0)?,
                    revision: row.get(1)?,
                    payload: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(repo_err)
    }

    /// 写入保留策略（upsert 单行，revision+1）。校验（档位契约）由调用方经
    /// RetentionPolicy::parse + is_valid 完成；本方法只负责原子落盘。
    /// I13-W3：expected_revision Some(e) 且与当前 revision 不匹配（无行 = 0）→
    /// RevisionConflict（旧写不覆盖新写，事务回滚）；None → 盲写（首写/import 用）。
    pub(crate) fn retention_policy_set(
        &self,
        version: i64,
        payload: &str,
        expected_revision: Option<i64>,
    ) -> Result<i64, PylonError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(repo_err)?;
        let current: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(revision), 0) FROM retention_policy WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(repo_err)?;
        if let Some(expected) = expected_revision {
            if expected != current {
                return Err(PylonError::RevisionConflict {
                    expected,
                    actual: current,
                });
            }
        }
        let new_revision = current + 1;
        tx.execute(
            "INSERT INTO retention_policy (singleton, version, revision, payload, updated_at)
             VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(singleton) DO UPDATE SET
                 version = excluded.version,
                 revision = excluded.revision,
                 payload = excluded.payload,
                 updated_at = excluded.updated_at",
            params![version, new_revision, payload, now_millis()],
        )
        .map_err(repo_err)?;
        tx.commit().map_err(repo_err)?;
        Ok(new_revision)
    }

    /// 每 owner 候选计数（preview 与 prune 共用同一筛选，D-11 语义）。
    /// A1-c/B5：执行目标 = canonical_events（canonical 事件流为唯一会话数据源）——
    /// - ByTime：created_at < cutoff（now - days 天，毫秒严格小于）；
    /// - ByCount：每 owner 按 sequence DESC 保留最新 count 条事件，其余为候选；
    /// - Permanent：无候选。
    /// per_session.session_id 使用 owner_key（canonical 事件流按 owner 键控）。
    ///
    /// CR-003：now 由调用方单次取时传入——统计与删除共用同一 cutoff，避免边界事件
    /// 计数与实际删除不一致。
    fn retention_candidate_counts(
        conn: &Connection,
        policy: &crate::session::retention::RetentionPolicy,
        now: i64,
    ) -> Result<Vec<SessionCandidateCount>, PylonError> {
        match policy.mode {
            super::retention::RetentionMode::Permanent => Ok(Vec::new()),
            super::retention::RetentionMode::ByTime => {
                let cutoff = now - policy.days.unwrap_or(0) as i64 * 86_400_000;
                let mut stmt = conn
                    .prepare(
                        "SELECT owner_key, COUNT(*) FROM canonical_events
                         WHERE created_at < ?1 GROUP BY owner_key",
                    )
                    .map_err(repo_err)?;
                let rows = stmt
                    .query_map([cutoff], |row| {
                        Ok(SessionCandidateCount {
                            session_id: row.get(0)?,
                            count: row.get(1)?,
                        })
                    })
                    .map_err(repo_err)?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row.map_err(repo_err)?);
                }
                Ok(out)
            }
            super::retention::RetentionMode::ByCount => {
                let limit = policy.count.unwrap_or(0) as i64;
                let mut stmt = conn
                    .prepare(
                        "SELECT owner_key, COUNT(*) - ?1 FROM canonical_events
                         GROUP BY owner_key HAVING COUNT(*) > ?1",
                    )
                    .map_err(repo_err)?;
                let rows = stmt
                    .query_map([limit], |row| {
                        Ok(SessionCandidateCount {
                            session_id: row.get(0)?,
                            count: row.get(1)?,
                        })
                    })
                    .map_err(repo_err)?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row.map_err(repo_err)?);
                }
                Ok(out)
            }
        }
    }

    /// preview：统计将删除的候选（不执行删除）。
    pub(crate) fn retention_candidates(
        &self,
        policy: &crate::session::retention::RetentionPolicy,
    ) -> Result<RetentionPreview, PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let now = now_millis();
        let per_session = Self::retention_candidate_counts(&conn, policy, now)?;
        Ok(preview_result(policy, now, per_session))
    }

    /// prune：事务内统计候选 + 执行删除（与 preview 同一筛选）；返回删除结果。
    /// CR-003：now 单次取时——统计与删除共用同一 cutoff，边界计数一致。
    /// I13-W4：expected_policy_revision Some(e) 且与策略行当前 revision（无行 = 0）不匹配 →
    /// StalePreview（用户预览后策略被改，拒绝按旧统计执行清理，回滚不删）。
    pub(crate) fn prune_by_policy(
        &self,
        policy: &crate::session::retention::RetentionPolicy,
        expected_policy_revision: Option<i64>,
    ) -> Result<RetentionPreview, PylonError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(repo_err)?;
        let policy_revision: i64 = tx
            .query_row(
                "SELECT COALESCE(MAX(revision), 0) FROM retention_policy WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(repo_err)?;
        if let Some(expected) = expected_policy_revision {
            if expected != policy_revision {
                return Err(PylonError::StalePreview {
                    expected,
                    actual: policy_revision,
                });
            }
        }
        let now = now_millis();
        let per_session = Self::retention_candidate_counts(&tx, policy, now)?;
        match policy.mode {
            super::retention::RetentionMode::Permanent => {}
            super::retention::RetentionMode::ByTime => {
                let cutoff = now - policy.days.unwrap_or(0) as i64 * 86_400_000;
                tx.execute(
                    "DELETE FROM canonical_events WHERE created_at < ?1",
                    [cutoff],
                )
                .map_err(repo_err)?;
            }
            super::retention::RetentionMode::ByCount => {
                let limit = policy.count.unwrap_or(0) as i64;
                // canonical_events 按 owner 键控：保留每 owner 最新 limit 条事件
                // （sequence DESC）；event_id 全局唯一，按 event_id 删除不受跨 owner
                // 同名 sequence 影响。
                tx.execute(
                    "DELETE FROM canonical_events WHERE event_id NOT IN (
                         SELECT event_id FROM canonical_events c2
                         WHERE c2.owner_key = canonical_events.owner_key
                         ORDER BY sequence DESC LIMIT ?1
                     )",
                    [limit],
                )
                .map_err(repo_err)?;
            }
        }
        tx.commit().map_err(repo_err)?;
        Ok(preview_result(policy, now, per_session))
    }
}

/// I13-W4：由候选计数构造 preview/prune 结果（affected_sessions + oldest_deleted_at）。
fn preview_result(
    policy: &crate::session::retention::RetentionPolicy,
    now: i64,
    per_session: Vec<SessionCandidateCount>,
) -> RetentionPreview {
    let total_candidates: i64 = per_session.iter().map(|c| c.count).sum();
    let oldest_deleted_at = match policy.mode {
        crate::session::retention::RetentionMode::ByTime => {
            Some(now - policy.days.unwrap_or(0) as i64 * 86_400_000)
        }
        _ => None,
    };
    RetentionPreview {
        total_candidates,
        affected_sessions: per_session.len() as i64,
        oldest_deleted_at,
        per_session,
    }
}

/// service 内每 Session 单 writer（Mutex 串行化）。active schema 中本 service 只承担
/// session_state / tombstone / retention 转发；canonical 事件流由 EventService 承担。
pub(crate) struct MessageService {
    repo: Arc<MsgRepo>,
}

impl MessageService {
    /// I14-W9：暴露底层 repo（RetentionService 复用同一连接；只读共享）。
    pub(crate) fn repo(&self) -> Arc<MsgRepo> {
        self.repo.clone()
    }

    pub(crate) async fn set_session_state(
        &self,
        owner: crate::session::DurableSessionOwner,
        remote_session_id: Option<String>,
        state: serde_json::Value,
    ) -> Result<(), MessageError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            repo.set_session_state_for_owner(&owner, remote_session_id.as_deref(), &state)
        })
        .await
        .map_err(|error| {
            MessageError::Unavailable(format!(
                "message repo set_session_state task failed: {error}"
            ))
        })?
    }

    pub(crate) async fn get_session_state(
        &self,
        owner: crate::session::DurableSessionOwner,
    ) -> Result<Option<serde_json::Value>, MessageError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || repo.get_session_state_for_owner(&owner))
            .await
            .map_err(|error| {
                MessageError::Unavailable(format!(
                    "message repo get_session_state task failed: {error}"
                ))
            })?
    }

    /// 打开（或创建）生产仓库并迁移到最新 schema（D-02 版本化迁移）。
    /// 调用方须先创建 DB 父目录；失败返回 Err——启动路径不得静默回退
    /// localStorage 形成双主（ISSUE-14 W1：失败进入 blocked）。
    pub(crate) fn open_db(path: &Path) -> Result<MessageService, MessageError> {
        let repo =
            MsgRepo::open(path).map_err(|error| MessageError::Unavailable(error.to_string()))?;
        Ok(MessageService {
            repo: Arc::new(repo),
        })
    }

    /// 内存仓库（测试用）。
    #[allow(dead_code)] // 测试用内存服务
    pub(crate) fn in_memory() -> Result<MessageService, MessageError> {
        let repo = MsgRepo::open_in_memory()
            .map_err(|error| MessageError::Unavailable(error.to_string()))?;
        Ok(MessageService {
            repo: Arc::new(repo),
        })
    }

    /// DEL-03（§5.13 步骤 2-4）：本地优先删除开始——tombstone 写 'deleting' + 删除会话行。
    pub(crate) async fn begin_delete_session(
        &self,
        session_id: String,
        owner_key: Option<String>,
    ) -> Result<(), MessageError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            repo.begin_delete_session(&session_id, owner_key.as_deref())
                .map_err(|error| MessageError::Unavailable(error.to_string()))
        })
        .await
        .map_err(|error| {
            MessageError::Unavailable(format!("message repo begin delete task failed: {error}"))
        })?
    }

    /// DEL-03（§5.13）：删除终态化——deleting → deleted（幂等；失败不阻断）。
    pub(crate) async fn finalize_session_delete(
        &self,
        session_id: String,
        owner_key: Option<String>,
    ) -> Result<(), MessageError> {
        let repo = self.repo.clone();
        tokio::task::spawn_blocking(move || {
            repo.finalize_session_delete(&session_id, owner_key.as_deref())
                .map_err(|error| MessageError::Unavailable(error.to_string()))
        })
        .await
        .map_err(|error| {
            MessageError::Unavailable(format!("message repo finalize delete task failed: {error}"))
        })?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_db_path() -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!(
            "pylon-session-repo-test-{}-{}-{}.db",
            std::process::id(),
            n,
            nanos
        ))
    }

    fn table_names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap();
        stmt.query_map([], |row| row.get(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect()
    }

    #[test]
    fn migrate_fresh_db_to_current_version_without_message_tables() {
        let repo = MsgRepo::open_in_memory().expect("open");
        let conn = repo.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION, "新库迁移到当前版本");
        let tables = table_names(&conn);
        for required in [
            "sessions",
            "user_data",
            "deleted_sessions",
            "retention_policy",
            "canonical_events",
            "legacy_message_backfill_audit",
        ] {
            assert!(
                tables.iter().any(|t| t == required),
                "缺少核心表 {required}: {tables:?}"
            );
        }
        for legacy in ["messages", "send_attempts", "message_migrations"] {
            assert!(
                !tables.iter().any(|t| t == legacy),
                "v12 fresh DB 不得包含 legacy active table {legacy}: {tables:?}"
            );
        }
    }

    #[test]
    fn migrate_idempotent_across_reopen() {
        let path = unique_temp_db_path();
        {
            let repo = MsgRepo::open(&path).expect("open");
            let conn = repo.conn.lock().unwrap();
            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(version, SCHEMA_VERSION);
        }
        // 重新打开不重跑迁移、不报错（幂等）
        {
            let repo = MsgRepo::open(&path).expect("reopen");
            let conn = repo.conn.lock().unwrap();
            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(version, SCHEMA_VERSION);
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn current_version_with_missing_schema_is_rejected_instead_of_assumed_valid() {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)
            .expect("set current version");
        let error = connect(&mut conn).expect_err("version alone must not bypass schema manifest");
        assert_eq!(error.code(), "database_schema_invalid");
        assert!(error.to_string().contains("missing table canonical_events"));
    }

    #[test]
    fn future_schema_version_is_rejected_without_running_downgrade_ddl() {
        let mut conn = Connection::open_in_memory().expect("open");
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 1)
            .expect("set future version");
        let error = connect(&mut conn).expect_err("future schema must be explicit");
        assert_eq!(error.code(), "database_future_schema");
        assert!(
            table_names(&conn).is_empty(),
            "future database must not be mutated"
        );
    }

    #[test]
    fn non_database_file_fails_the_startup_integrity_check() {
        let path = unique_temp_db_path();
        std::fs::write(&path, b"not a sqlite database").expect("write invalid database");
        let error = MsgRepo::open(&path)
            .err()
            .expect("invalid database must fail closed");
        assert_eq!(error.code(), "database_integrity_failed");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn wal_pragmas_tolerate_in_memory_database() {
        // 边界（A1）：in-memory 连接同样走 connect()——SQLite 规定 :memory: 上
        // journal_mode=WAL 请求返回 "memory" 且不报错；pragma_update 对非空返回
        // 值的 pragma 不视为失败。断言连接可用且 journal_mode 保持 memory。
        let repo = MsgRepo::open_in_memory().expect("in-memory open with WAL pragmas");
        let conn = repo.conn.lock().unwrap();
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .expect("journal_mode readable");
        assert_eq!(mode, "memory", ":memory: stays memory even after WAL request");
    }

    #[test]
    fn migrate_backfills_provable_legacy_messages_and_archives_all_v8_tables() {
        // 模拟 v8：唯一 owner 的基础文本角色可无损组成 history.snapshot；原表只改名归档。
        let path = unique_temp_db_path();
        {
            let repo = MsgRepo::open(&path).expect("open fresh current schema");
            let conn = repo.conn.lock().unwrap();
            conn.execute_batch(
                r#"CREATE TABLE messages (
                     message_id TEXT PRIMARY KEY NOT NULL,
                     session_id TEXT NOT NULL,
                     seq INTEGER NOT NULL,
                     role TEXT NOT NULL,
                     content TEXT NOT NULL,
                     client_msg_id TEXT,
                     created_at INTEGER NOT NULL
                 );
                 CREATE TABLE send_attempts (
                     session_id TEXT NOT NULL,
                     message_id TEXT PRIMARY KEY NOT NULL,
                     status TEXT NOT NULL,
                     retry_of TEXT,
                     created_at INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE message_migrations (
                     session_id TEXT PRIMARY KEY NOT NULL,
                     source_kind TEXT NOT NULL,
                     completed_at INTEGER,
                     source_fingerprint TEXT,
                     error TEXT
                 );
                 INSERT INTO canonical_events
                   (event_id, owner_key, profile_id, agent_id, local_session_id,
                    remote_session_id, client_generation, sequence, occurred_at,
                    received_at, event_type, payload_version, raw_payload, created_at)
                 VALUES ('base', '["p1","peri","legacy-s1"]', 'p1', 'peri', 'legacy-s1',
                         'remote-1', 7, 1, 't', 't', 'turn.completed', 1, '{}', 1),
                        ('tool-base', '["p1","peri","legacy-tool"]', 'p1', 'peri', 'legacy-tool',
                         'remote-2', 7, 1, 't', 't', 'turn.completed', 1, '{}', 1);
                 INSERT INTO messages
                   (message_id, session_id, seq, role, content, client_msg_id, created_at)
                 VALUES ('m1', 'legacy-s1', 1, 'user', 'question', NULL, 10),
                        ('m2', 'legacy-s1', 2, 'assistant', 'answer', NULL, 11),
                        ('m3', 'unmapped', 1, 'user', 'preserve', NULL, 12),
                        ('m4', 'legacy-tool', 1, 'tool', 'opaque tool card', NULL, 13);
                 PRAGMA user_version = 8;"#,
            )
            .unwrap();
        }
        let upgraded = MsgRepo::open(&path).expect("reopen upgrades to current schema");
        let conn = upgraded.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION, "v8 库重开必须升级到当前版本");
        let tables = table_names(&conn);
        for legacy in ["messages", "send_attempts", "message_migrations"] {
            assert!(
                !tables.iter().any(|t| t == legacy),
                "升级后 active legacy name 必须退出: {legacy}: {tables:?}"
            );
        }
        for archive in [
            "legacy_messages_v8_archive",
            "legacy_send_attempts_v8_archive",
            "legacy_message_migrations_v8_archive",
        ] {
            assert!(
                tables.iter().any(|table| table == archive),
                "缺少 forensic archive {archive}"
            );
        }
        let archived_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM legacy_messages_v8_archive",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(archived_count, 4, "archive 必须保留全部源行");
        let (status, message_count): (String, i64) = conn
            .query_row(
                "SELECT status, message_count FROM legacy_message_backfill_audit WHERE session_id = 'legacy-s1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "backfilled");
        assert_eq!(message_count, 2);
        let unmapped_status: String = conn
            .query_row(
                "SELECT status FROM legacy_message_backfill_audit WHERE session_id = 'unmapped'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let unsupported_status: String = conn
            .query_row(
                "SELECT status FROM legacy_message_backfill_audit WHERE session_id = 'legacy-tool'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(unmapped_status, "archived-unmapped");
        assert_eq!(unsupported_status, "archived-unsupported");
        let raw: String = conn
            .query_row(
                "SELECT raw_payload FROM canonical_events
                 WHERE owner_key = ?1 AND event_type = 'history.snapshot'",
                params![r#"["p1","peri","legacy-s1"]"#],
                |row| row.get(0),
            )
            .unwrap();
        let snapshot: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let replay = snapshot["replayEvents"].as_array().unwrap();
        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0]["update"]["sessionUpdate"], "user_message_chunk");
        assert_eq!(replay[0]["update"]["content"]["text"], "question");
        assert_eq!(replay[1]["update"]["sessionUpdate"], "agent_message_chunk");
        assert_eq!(replay[1]["update"]["content"]["text"], "answer");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_archive_collision_rolls_back_without_touching_source_or_version() {
        let path = unique_temp_db_path();
        {
            let repo = MsgRepo::open(&path).expect("open current");
            let conn = repo.conn.lock().unwrap();
            conn.execute_batch(
                "CREATE TABLE messages (
                     message_id TEXT PRIMARY KEY NOT NULL,
                     session_id TEXT NOT NULL,
                     seq INTEGER NOT NULL,
                     role TEXT NOT NULL,
                     content TEXT NOT NULL,
                     client_msg_id TEXT,
                     created_at INTEGER NOT NULL
                 );
                 INSERT INTO messages VALUES ('m1', 's1', 1, 'user', 'keep', NULL, 1);
                 CREATE TABLE legacy_messages_v8_archive (sentinel TEXT);
                 PRAGMA user_version = 8;",
            )
            .unwrap();
        }
        let error = MsgRepo::open(&path)
            .err()
            .expect("archive collision must fail closed");
        assert!(error
            .to_string()
            .contains("target legacy_messages_v8_archive already exists"));

        let conn = Connection::open(&path).expect("inspect rollback");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let source_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM messages", [], |row| row.get(0))
            .unwrap();
        let audit_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM legacy_message_backfill_audit",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(version, 8);
        assert_eq!(
            source_count, 1,
            "source table and rows must survive rollback"
        );
        assert_eq!(
            audit_count, 0,
            "audit/backfill writes must roll back with archive failure"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn session_state_roundtrip_merge_keeps_existing_keys() {
        let repo = MsgRepo::open_in_memory().expect("open");
        repo.set_session_state("s1", &serde_json::json!({"usage": {"n": 1}}))
            .expect("set usage");
        repo.set_session_state("s1", &serde_json::json!({"commands": ["ls"]}))
            .expect("set commands");
        let state = repo.get_session_state("s1").expect("get").expect("present");
        assert_eq!(state["usage"]["n"], 1, "merge 不覆盖已有 key");
        assert_eq!(state["commands"][0], "ls");
        assert!(repo.get_session_state("ghost").expect("get").is_none());
    }

    #[test]
    fn durable_session_state_isolated_by_full_owner_when_sources_match() {
        let repo = MsgRepo::open_in_memory().expect("open");
        let owner_a = crate::session::DurableSessionOwner::new("p1", "agent-a", "shared");
        let owner_b = crate::session::DurableSessionOwner::new("p2", "agent-b", "shared");

        repo.set_session_state_for_owner(
            &owner_a,
            Some("remote-a"),
            &serde_json::json!({"usage": {"n": 1}}),
        )
        .expect("set owner a");
        repo.set_session_state_for_owner(
            &owner_b,
            Some("remote-b"),
            &serde_json::json!({"usage": {"n": 2}}),
        )
        .expect("set owner b");

        assert_eq!(
            repo.get_session_state_for_owner(&owner_a)
                .expect("get a")
                .expect("owner a state")["usage"]["n"],
            1,
        );
        assert_eq!(
            repo.get_session_state_for_owner(&owner_b)
                .expect("get b")
                .expect("owner b state")["usage"]["n"],
            2,
        );
    }

    #[test]
    fn owner_tombstone_deletes_and_blocks_only_the_matching_snapshot() {
        let repo = MsgRepo::open_in_memory().expect("open");
        let owner_a = crate::session::DurableSessionOwner::new("p1", "agent-a", "shared");
        let owner_b = crate::session::DurableSessionOwner::new("p2", "agent-b", "shared");
        for owner in [&owner_a, &owner_b] {
            repo.set_session_state_for_owner(owner, None, &serde_json::json!({"usage": {"n": 1}}))
                .expect("seed owner state");
        }

        let owner_a_key = owner_a.key().expect("owner key");
        repo.delete_session("shared", Some(&owner_a_key))
            .expect("delete owner a");

        assert!(repo
            .get_session_state_for_owner(&owner_a)
            .expect("read deleted owner")
            .is_none(),);
        let late_error = repo
            .set_session_state_for_owner(&owner_a, None, &serde_json::json!({"commands": ["late"]}))
            .expect_err("exact owner tombstone must reject late state");
        assert!(matches!(late_error, MessageError::SessionDeleted(_)));
        assert_eq!(late_error.code(), "session_deleted");
        assert!(
            repo.get_session_state_for_owner(&owner_b)
                .expect("read surviving owner")
                .is_some(),
            "same source under another profile/agent must survive",
        );
        repo.set_session_state_for_owner(
            &owner_b,
            None,
            &serde_json::json!({"commands": ["still-alive"]}),
        )
        .expect("other owner remains writable");
    }

    #[test]
    fn v10_migrates_legacy_state_only_when_journal_proves_one_owner() {
        let path = unique_temp_db_path();
        {
            let repo = MsgRepo::open(&path).expect("open current");
            let conn = repo.conn.lock().unwrap();
            conn.execute_batch(
                "DROP TABLE session_state_snapshots;
                 INSERT INTO sessions (session_id, created_at, updated_at, session_state)
                 VALUES ('unique', 1, 1, '{\"usage\":{\"n\":1}}'),
                        ('ambiguous', 1, 1, '{\"usage\":{\"n\":9}}');
                 INSERT INTO canonical_events
                   (event_id, owner_key, profile_id, agent_id, local_session_id,
                    remote_session_id, client_generation, sequence, occurred_at,
                    received_at, event_type, payload_version, raw_payload, created_at)
                 VALUES
                   ('u1', '[\"p1\",\"a1\",\"unique\"]', 'p1', 'a1', 'unique', 'remote-u', 1, 1, 't', 't', 'message', 1, '{}', 1),
                   ('a1', '[\"p1\",\"a1\",\"ambiguous\"]', 'p1', 'a1', 'ambiguous', NULL, 1, 1, 't', 't', 'message', 1, '{}', 1),
                   ('a2', '[\"p2\",\"a2\",\"ambiguous\"]', 'p2', 'a2', 'ambiguous', NULL, 1, 1, 't', 't', 'message', 1, '{}', 1);
                 PRAGMA user_version = 9;",
            )
            .expect("prepare v9 fixture");
        }

        let upgraded = MsgRepo::open(&path).expect("upgrade to v10");
        let unique = crate::session::DurableSessionOwner::new("p1", "a1", "unique");
        let ambiguous = crate::session::DurableSessionOwner::new("p1", "a1", "ambiguous");
        assert_eq!(
            upgraded
                .get_session_state_for_owner(&unique)
                .expect("read migrated")
                .expect("unique owner migrated")["usage"]["n"],
            1,
        );
        assert!(
            upgraded
                .get_session_state_for_owner(&ambiguous)
                .expect("read ambiguous")
                .is_none(),
            "多个 owner 的 legacy source 必须保留原数据但不得猜测回填",
        );
        let conn = upgraded.conn.lock().unwrap();
        let retained: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE session_id = 'ambiguous' AND session_state IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retained, 1, "歧义 legacy state 必须原样保留");
        drop(conn);
        drop(upgraded);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tombstone_owner_key_collision_rolls_back_v12_migration() {
        let path = unique_temp_db_path();
        {
            let repo = MsgRepo::open(&path).expect("open current");
            let conn = repo.conn.lock().unwrap();
            conn.execute_batch(
                r#"DROP TABLE deleted_sessions;
                   CREATE TABLE deleted_sessions (
                       session_id TEXT PRIMARY KEY NOT NULL,
                       deleted_at INTEGER NOT NULL,
                       owner_key TEXT NOT NULL,
                       state TEXT NOT NULL,
                       deletion_revision INTEGER NOT NULL,
                       reason TEXT
                   );
                   INSERT INTO deleted_sessions VALUES
                       ('metadata-a', 1, '["p","a","shared"]', 'deleted', 0, NULL),
                       ('metadata-b', 2, '["p","a","shared"]', 'deleting', 0, NULL);
                   PRAGMA user_version = 11;"#,
            )
            .expect("prepare v11 collision fixture");
        }

        assert!(
            MsgRepo::open(&path).is_err(),
            "duplicate owner evidence must fail closed"
        );
        let conn = Connection::open(&path).expect("inspect rollback");
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        let source_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM deleted_sessions", [], |row| {
                row.get(0)
            })
            .unwrap();
        let archive_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='deleted_sessions_v11_archive')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            version, 11,
            "failed migration must not advance user_version"
        );
        assert_eq!(
            source_count, 2,
            "source rows must survive transaction rollback"
        );
        assert!(
            !archive_exists,
            "rename must roll back with conflicting backfill"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn touch_session_rejects_tombstoned_session() {
        let repo = MsgRepo::open_in_memory().expect("open");
        repo.touch_session("s1").expect("touch");
        repo.delete_session("s1", None).expect("delete");
        assert!(
            repo.touch_session("s1").is_err(),
            "已删除会话 touch 必须被 tombstone 拒绝（不复活）"
        );
    }

    #[test]
    fn session_state_write_rejects_tombstoned_session_without_resurrection() {
        let repo = MsgRepo::open_in_memory().expect("open");
        repo.set_session_state("s1", &serde_json::json!({"usage": {"n": 1}}))
            .expect("initial state");
        repo.delete_session("s1", None).expect("delete");

        assert!(
            repo.set_session_state("s1", &serde_json::json!({"commands": ["late"]}))
                .is_err(),
            "tombstone 后迟到 state write 必须被拒绝"
        );
        assert!(
            repo.get_session_state("s1").expect("read").is_none(),
            "拒绝迟到写后 sessions 行不得复活"
        );
    }

    #[test]
    fn delete_session_writes_tombstone_and_keeps_canonical_events() {
        let repo = MsgRepo::open_in_memory().expect("open");
        repo.touch_session("s1").expect("touch");
        repo.delete_session("s1", Some(r#"["p1","a1","s1"]"#))
            .expect("delete");
        assert_eq!(
            repo.tombstone_state("s1").expect("state").as_deref(),
            Some("deleted")
        );
        assert_eq!(repo.tombstone_state("ghost").expect("state"), None);
        let conn = repo.conn.lock().unwrap();
        let sessions: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE session_id='s1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(sessions, 0, "删除后 sessions 行清除");
        let events: i64 = conn
            .query_row("SELECT COUNT(*) FROM canonical_events", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            events, 0,
            "无事件场景保持 0；delete_session 不清理 canonical_events 行"
        );
    }

    #[test]
    fn begin_delete_and_finalize_transitions_deleting_to_deleted() {
        let repo = MsgRepo::open_in_memory().expect("open");
        repo.touch_session("s1").expect("touch");
        repo.begin_delete_session("s1", Some(r#"["p1","a1","s1"]"#))
            .expect("begin");
        assert_eq!(
            repo.tombstone_state("s1").expect("state").as_deref(),
            Some("deleting")
        );
        // deleting 同样 gate 迟到 touch（不复活）
        assert!(
            repo.touch_session("s1").is_err(),
            "deleting 进行中迟到写必须拒绝"
        );
        repo.finalize_session_delete("s1", Some(r#"["p1","a1","s1"]"#))
            .expect("finalize");
        assert_eq!(
            repo.tombstone_state("s1").expect("state").as_deref(),
            Some("deleted")
        );
        // 幂等：重复 begin/finalize
        repo.begin_delete_session("s1", Some(r#"["p1","a1","s1"]"#))
            .expect("begin idempotent");
        repo.finalize_session_delete("s1", Some(r#"["p1","a1","s1"]"#))
            .expect("finalize idempotent");
        assert_eq!(
            repo.tombstone_state("s1").expect("state").as_deref(),
            Some("deleted")
        );
    }

    // ── ISSUE-20 W4：rusqlite 错误分类（corrupt/constraint/conflict/unavailable）──

    fn sqlite_err(code: rusqlite::ErrorCode) -> rusqlite::Error {
        rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error {
                code,
                extended_code: code as i32,
            },
            None,
        )
    }

    #[test]
    fn rusqlite_error_classifies_corrupt_and_notadb() {
        for code in [
            rusqlite::ErrorCode::DatabaseCorrupt,
            rusqlite::ErrorCode::NotADatabase,
        ] {
            let error = MessageError::from(sqlite_err(code));
            assert_eq!(
                error.code(),
                "message_repo_corrupt",
                "{code:?} 应分类为 corrupt"
            );
        }
    }

    #[test]
    fn rusqlite_error_classifies_constraint() {
        let error = MessageError::from(sqlite_err(rusqlite::ErrorCode::ConstraintViolation));
        assert_eq!(error.code(), "message_repo_constraint");
    }

    #[test]
    fn rusqlite_error_classifies_busy_and_locked_as_conflict() {
        for code in [
            rusqlite::ErrorCode::DatabaseBusy,
            rusqlite::ErrorCode::DatabaseLocked,
        ] {
            let error = MessageError::from(sqlite_err(code));
            assert_eq!(
                error.code(),
                "message_repo_conflict",
                "{code:?} 应分类为 conflict"
            );
        }
    }

    #[test]
    fn rusqlite_error_other_codes_stay_unavailable() {
        for code in [
            rusqlite::ErrorCode::PermissionDenied,
            rusqlite::ErrorCode::SystemIoFailure,
            rusqlite::ErrorCode::DiskFull,
            rusqlite::ErrorCode::CannotOpen,
        ] {
            let error = MessageError::from(sqlite_err(code));
            assert_eq!(
                error.code(),
                "message_db_unavailable",
                "{code:?} 应保持 unavailable"
            );
        }
    }

    #[test]
    fn rusqlite_error_non_sqlite_failure_stays_unavailable() {
        let error = MessageError::from(rusqlite::Error::InvalidQuery);
        assert_eq!(error.code(), "message_db_unavailable");
    }

    #[test]
    fn message_error_serializes_b1_2_code_message_shape() {
        let unavailable = MessageError::Unavailable("db gone".into());
        let json = serde_json::to_value(&unavailable).expect("serialize");
        assert_eq!(json["code"], "message_db_unavailable");
        assert_eq!(json["message"], "消息仓库不可用：db gone");

        let deleted = MessageError::SessionDeleted("s1".into());
        let json = serde_json::to_value(&deleted).expect("serialize");
        assert_eq!(json["code"], "session_deleted");
    }

    // ── I14-W9：保留策略（policy 读写 + preview/prune 同一筛选；B5 执行目标 canonical_events） ──

    /// 直插一条 canonical 事件测试行（canonical_events 全列 NOT NULL 必填）。
    fn insert_event_at(repo: &MsgRepo, owner_key: &str, seq: i64, created_at: i64) {
        let conn = repo.conn.lock().expect("lock");
        conn.execute(
            "INSERT INTO canonical_events
                 (event_id, owner_key, profile_id, agent_id, local_session_id, remote_session_id,
                  client_generation, sequence, occurred_at, received_at, event_type, payload_version,
                  identity, typed_payload, raw_payload, created_at)
             VALUES (?1, ?2, 'p1', 'peri', 'local:s1', NULL,
                  0, ?3, '2026-08-14T00:00:00.000Z', '2026-08-14T00:00:00.000Z',
                  'user.message', 1, NULL, NULL, '{}', ?4)",
            params![format!("{owner_key}#{seq}"), owner_key, seq, created_at],
        )
        .expect("insert canonical event");
    }

    fn canonical_event_count(repo: &MsgRepo) -> i64 {
        let conn = repo.conn.lock().expect("lock");
        conn.query_row("SELECT COUNT(*) FROM canonical_events", [], |row| {
            row.get(0)
        })
        .expect("count")
    }

    fn owner_key_of(local_session_id: &str) -> String {
        serde_json::to_string(&["p1", "peri", local_session_id]).expect("owner key")
    }

    fn by_time_policy(days: u32) -> crate::session::retention::RetentionPolicy {
        serde_json::from_str(&format!(r#"{{"mode":"by_time","days":{days}}}"#)).expect("policy")
    }

    fn by_count_policy(count: u32) -> crate::session::retention::RetentionPolicy {
        serde_json::from_str(&format!(r#"{{"mode":"by_count","count":{count}}}"#)).expect("policy")
    }

    fn permanent_policy() -> crate::session::retention::RetentionPolicy {
        serde_json::from_str(r#"{"mode":"permanent"}"#).expect("policy")
    }

    #[test]
    fn retention_policy_set_get_roundtrip_bumps_revision() {
        let repo = MsgRepo::open_in_memory().expect("open");
        assert!(
            repo.retention_policy_get().expect("get").is_none(),
            "初始无策略"
        );
        let rev1 = repo
            .retention_policy_set(1, r#"{"mode":"by_time","days":30}"#, None)
            .expect("set1");
        assert_eq!(rev1, 1);
        let rev2 = repo
            .retention_policy_set(1, r#"{"mode":"by_count","count":1000}"#, None)
            .expect("set2");
        assert_eq!(rev2, 2);
        let row = repo.retention_policy_get().expect("get").expect("present");
        assert_eq!(row.version, 1);
        assert_eq!(row.revision, 2);
        assert!(row.payload.contains("by_count"));
    }

    #[test]
    fn retention_policy_set_expected_revision_conflicts_and_rolls_back() {
        let repo = MsgRepo::open_in_memory().expect("open");
        // 无行时 expected=0 通过（首写）
        assert_eq!(
            repo.retention_policy_set(1, r#"{"mode":"permanent"}"#, Some(0))
                .expect("blind first"),
            1
        );
        // expected 与实际不符 → 冲突，不写任何行（旧写不覆盖新写）
        let err = repo
            .retention_policy_set(1, r#"{"mode":"by_time","days":30}"#, Some(5))
            .expect_err("must conflict");
        assert!(
            matches!(
                err,
                PylonError::RevisionConflict {
                    expected: 5,
                    actual: 1
                }
            ),
            "{err:?}"
        );
        let row = repo.retention_policy_get().expect("get").expect("present");
        assert_eq!(row.revision, 1, "冲突后 revision 不得推进");
        assert!(
            row.payload.contains("permanent"),
            "冲突后 payload 不得被覆盖"
        );
        // expected 正确 → 通过并推进
        assert_eq!(
            repo.retention_policy_set(1, r#"{"mode":"by_count","count":1000}"#, Some(1))
                .expect("ok"),
            2
        );
    }

    #[test]
    fn retention_prune_stale_when_policy_revision_changed() {
        let repo = MsgRepo::open_in_memory().expect("open");
        let now = now_millis();
        let owner = owner_key_of("s1");
        insert_event_at(&repo, &owner, 1, now - 40 * 86_400_000);
        // 策略 rev 1
        let rev = repo
            .retention_policy_set(1, r#"{"mode":"by_time","days":30}"#, None)
            .expect("set");
        assert_eq!(rev, 1);
        // expected 匹配 → 正常清理
        let pruned = repo
            .prune_by_policy(&by_time_policy(30), Some(1))
            .expect("prune with current revision");
        assert_eq!(pruned.total_candidates, 1);
        assert_eq!(canonical_event_count(&repo), 0);
        // 策略再改（rev 2）→ 用旧 expected 1 prune → StalePreview，回滚不删
        insert_event_at(&repo, &owner, 2, now - 40 * 86_400_000);
        repo.retention_policy_set(1, r#"{"mode":"by_time","days":90}"#, None)
            .expect("set2");
        let err = repo
            .prune_by_policy(&by_time_policy(30), Some(1))
            .expect_err("stale expected must reject");
        assert!(
            matches!(
                err,
                PylonError::StalePreview {
                    expected: 1,
                    actual: 2
                }
            ),
            "{err:?}"
        );
        assert_eq!(canonical_event_count(&repo), 1, "stale 回滚不删");
        // 无行时 expected=0 通过（首写即清理）
        let repo2 = MsgRepo::open_in_memory().expect("open");
        insert_event_at(&repo2, &owner_key_of("s2"), 1, now);
        assert!(
            repo2
                .prune_by_policy(&permanent_policy(), Some(0))
                .expect("ok")
                .total_candidates
                == 0
        );
    }

    #[test]
    fn retention_preview_by_time_counts_old_events_only() {
        let repo = MsgRepo::open_in_memory().expect("open");
        let now = now_millis();
        let owner = owner_key_of("s1");
        // 旧事件（30 天前）+ 新事件（当前）
        insert_event_at(&repo, &owner, 1, now - 40 * 86_400_000);
        insert_event_at(&repo, &owner, 2, now - 31 * 86_400_000);
        insert_event_at(&repo, &owner, 3, now);
        let preview = repo
            .retention_candidates(&by_time_policy(30))
            .expect("preview");
        assert_eq!(preview.total_candidates, 2, "30 天前的 2 条为候选");
        assert_eq!(preview.per_session.len(), 1);
        assert_eq!(preview.affected_sessions, 1, "I13-W4 受影响 owner 数");
        assert!(
            preview.oldest_deleted_at.is_some(),
            "I13-W4 by_time 给出 cutoff"
        );
        assert_eq!(
            preview.per_session[0].session_id, owner,
            "候选按 owner_key 分组"
        );
        assert_eq!(preview.per_session[0].count, 2);
        // 不执行删除
        assert_eq!(canonical_event_count(&repo), 3);
    }

    #[test]
    fn retention_preview_by_count_keeps_newest_n_events_per_owner() {
        let repo = MsgRepo::open_in_memory().expect("open");
        let owner = owner_key_of("s1");
        for seq in 1..=5 {
            insert_event_at(&repo, &owner, seq, now_millis());
        }
        let preview = repo
            .retention_candidates(&by_count_policy(3))
            .expect("preview");
        assert_eq!(
            preview.total_candidates, 2,
            "每 owner 保留最新 3 条事件，删 2"
        );
        assert_eq!(preview.per_session[0].session_id, owner);
        assert_eq!(preview.per_session[0].count, 2);
        // permanent → 无候选
        assert_eq!(
            repo.retention_candidates(&permanent_policy())
                .expect("preview")
                .total_candidates,
            0
        );
    }

    #[test]
    fn retention_prune_deletes_and_is_idempotent() {
        let repo = MsgRepo::open_in_memory().expect("open");
        let now = now_millis();
        let owner = owner_key_of("s1");
        for seq in 1..=5 {
            insert_event_at(&repo, &owner, seq, now);
        }
        let pruned = repo
            .prune_by_policy(&by_count_policy(3), None)
            .expect("prune");
        assert_eq!(pruned.total_candidates, 2);
        assert_eq!(pruned.affected_sessions, 1, "I13-W4 单 owner 受影响");
        assert_eq!(pruned.oldest_deleted_at, None, "I13-W4 by_count 无 cutoff");
        assert_eq!(canonical_event_count(&repo), 3);
        // 重复 prune：无新候选（幂等）
        let again = repo
            .prune_by_policy(&by_count_policy(3), None)
            .expect("prune again");
        assert_eq!(again.total_candidates, 0, "重复 prune 幂等，二次无删除");
        assert_eq!(canonical_event_count(&repo), 3);
    }

    #[test]
    fn retention_prune_by_time_multi_owner_and_boundary() {
        let repo = MsgRepo::open_in_memory().expect("open");
        let now = now_millis();
        let owner1 = owner_key_of("s1");
        let owner2 = owner_key_of("s2");
        // owner1：2 条旧 + 1 条新；owner2：1 条旧
        insert_event_at(&repo, &owner1, 1, now - 40 * 86_400_000);
        insert_event_at(&repo, &owner1, 2, now - 32 * 86_400_000);
        insert_event_at(&repo, &owner1, 3, now);
        insert_event_at(&repo, &owner2, 1, now - 60 * 86_400_000);
        let pruned = repo
            .prune_by_policy(&by_time_policy(30), None)
            .expect("prune");
        assert_eq!(pruned.total_candidates, 3, "多 owner 各按时间边界删旧");
        assert_eq!(pruned.affected_sessions, 2, "I13-W4 两个 owner 受影响");
        assert!(
            pruned.oldest_deleted_at.is_some(),
            "I13-W4 by_time 给出 cutoff"
        );
        assert_eq!(canonical_event_count(&repo), 1);
        // 同 timestamp 边界：created_at 恰在 cutoff（严格 < 不删）——用 1 秒余量放在
        // cutoff 之后（测试开始 now 与查询 now_millis 有毫秒级漂移，余量避免误判）
        insert_event_at(&repo, &owner1, 4, now - 30 * 86_400_000 + 1000);
        let preview = repo
            .retention_candidates(&by_time_policy(30))
            .expect("preview");
        assert_eq!(
            preview.total_candidates, 0,
            "cutoff 之后的事件不删（严格 <）"
        );
    }

    #[test]
    fn retention_permanent_prune_deletes_nothing() {
        let repo = MsgRepo::open_in_memory().expect("open");
        insert_event_at(&repo, &owner_key_of("s1"), 1, now_millis());
        let pruned = repo
            .prune_by_policy(&permanent_policy(), None)
            .expect("prune");
        assert_eq!(pruned.total_candidates, 0);
        assert_eq!(canonical_event_count(&repo), 1);
    }
}
