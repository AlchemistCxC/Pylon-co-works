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
