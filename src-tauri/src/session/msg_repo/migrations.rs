use super::*;

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

