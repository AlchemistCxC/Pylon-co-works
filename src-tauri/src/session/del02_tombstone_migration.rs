//! DEL-02：现有 tombstone 升级为 owner/deletion state（方案书 §5.12、任务表 DEL-02）。
//!
//! 兼容迁移（v6→v7）：deleted_sessions 增列 owner_key/state/deletion_revision/reason；
//! 旧行兼容为 state='deleted'；owner_key 优先自 canonical_events 反查（同 local_session_id
//! 最新事件 profile/agent），无则标记 legacy scope；v12 原表升级为 owner_key 主键并保留
//! v11 forensic archive，不另建活动 tombstone。
//!
//! DEL-01 审计基线随本迁移演进（列/索引/版本断言更新）——审计→迁移顺序门禁的落地。

use rusqlite::Connection;

use super::msg_repo::{connect, MsgRepo};
use super::SCHEMA_VERSION;

/// 模拟 v6 旧库：老形状 deleted_sessions + canonical_events（含反查行）+ user_version=6。
/// 其余表由 migrate() 的 SCHEMA_SQL 补齐——与真实 v6 库升版路径一致。
fn v6_simulation(conn: &mut Connection) {
    conn.execute_batch(
        "CREATE TABLE deleted_sessions (
            session_id TEXT PRIMARY KEY NOT NULL,
            deleted_at INTEGER NOT NULL
         );
         CREATE TABLE canonical_events (
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
            created_at INTEGER NOT NULL
         );
         INSERT INTO deleted_sessions (session_id, deleted_at) VALUES ('legacy-no-events', 1000);
         INSERT INTO deleted_sessions (session_id, deleted_at) VALUES ('legacy-with-events', 2000);
         INSERT INTO canonical_events
             (event_id, owner_key, profile_id, agent_id, local_session_id, client_generation,
              sequence, occurred_at, received_at, event_type, payload_version, raw_payload, created_at)
         VALUES ('e1', '[\"p1\",\"a1\",\"legacy-with-events\"]', 'p1', 'a1',
                 'legacy-with-events', 1, 1, '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z', 'user.message', 1, '{}', 1);
        ",
    )
    .expect("seed v6 simulation");
    conn.pragma_update(None, "user_version", 6).expect("set v6");
}

/// 读 deleted_sessions 单行（owner_key, state, deletion_revision, reason）。
fn tombstone_row(
    conn: &Connection,
    session_id: &str,
) -> (String, String, String, i64, Option<String>) {
    conn.query_row(
        "SELECT owner_key, owner_scope, state, deletion_revision, reason
         FROM deleted_sessions WHERE session_id = ?1",
        [session_id],
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
    .expect("read tombstone row")
}

#[test]
fn migrate_upgrades_v6_tombstone_to_latest_owner_state() {
    let mut conn = Connection::open_in_memory().expect("in-memory");
    v6_simulation(&mut conn);

    connect(&mut conn).expect("migrate v6 → current");

    // 版本推进 + 列补齐 + 旧行兼容为 deleted。
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("user_version");
    assert_eq!(version, SCHEMA_VERSION, "v6 库升版后必须等于当前版本");
    assert_eq!(version, 12, "v12 tombstone 必须以 durable owner 为主键");

    let cols: Vec<String> = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(deleted_sessions)")
            .expect("prepare");
        stmt.query_map([], |row| row.get::<_, String>(1))
            .expect("query")
            .map(|item| item.expect("col"))
            .collect()
    };
    assert_eq!(
        cols,
        vec![
            "owner_key",
            "session_id",
            "owner_scope",
            "deleted_at",
            "state",
            "deletion_revision",
            "reason"
        ],
        "v6 旧表升版后必须得到 v12 owner-keyed active schema"
    );

    // 无事件旧行：转换为唯一的会话作用域 legacy owner + state=deleted
    // （兼容规则——§5.12“兼容旧行时视为 deleted”）。
    let (owner_no, scope_no, state_no, rev_no, _) = tombstone_row(&conn, "legacy-no-events");
    assert_eq!(
        owner_no, "[\"*\",\"*\",\"legacy-no-events\"]",
        "无事件旧行转为唯一 legacy owner key"
    );
    assert_eq!(scope_no, "legacy");
    assert_eq!(state_no, "deleted", "旧行兼容为 deleted");
    assert_eq!(rev_no, 0, "旧行 deletion_revision 初始 0");

    // 有事件旧行：owner_key 自 canonical_events 反查回填（真实 owner）。
    let (owner_ev, scope_ev, state_ev, _, _) = tombstone_row(&conn, "legacy-with-events");
    assert_eq!(
        owner_ev, "[\"p1\",\"a1\",\"legacy-with-events\"]",
        "反查回填真实 owner_key"
    );
    assert_eq!(scope_ev, "exact");
    assert_eq!(state_ev, "deleted");
    let archived: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM deleted_sessions_v11_archive",
            [],
            |row| row.get(0),
        )
        .expect("archive count");
    assert_eq!(archived, 2, "v11 source tombstones 必须完整保留供取证");
}

#[test]
fn migrate_adds_state_deleted_at_index() {
    let mut conn = Connection::open_in_memory().expect("in-memory");
    v6_simulation(&mut conn);
    connect(&mut conn).expect("migrate");

    let idx: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_deleted_sessions_state_deleted_at'",
            [],
            |row| row.get(0),
        )
        .expect("index count");
    assert_eq!(
        idx, 1,
        "v6 升版后必须新增 idx_deleted_sessions_state_deleted_at（§5.12 索引建议）"
    );
    let session_idx: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_deleted_sessions_session_id'",
            [],
            |row| row.get(0),
        )
        .expect("session index count");
    assert_eq!(
        session_idx, 1,
        "owner-keyed 表必须保留 session_id lookup index"
    );
}

#[test]
fn fresh_db_gets_latest_tombstone_directly() {
    let mut conn = Connection::open_in_memory().expect("in-memory");
    connect(&mut conn).expect("migrate fresh");
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .expect("user_version");
    assert_eq!(version, SCHEMA_VERSION, "fresh DB 直接建当前版本");
    let mut stmt = conn
        .prepare("PRAGMA table_info(deleted_sessions)")
        .expect("prepare");
    let cols: Vec<String> = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query")
        .map(|item| item.expect("col"))
        .collect();
    assert_eq!(
        cols,
        vec![
            "owner_key",
            "session_id",
            "owner_scope",
            "deleted_at",
            "state",
            "deletion_revision",
            "reason"
        ],
        "fresh DB 列集与升版库一致（列顺序同步，避免审计基线分叉）"
    );
}

#[test]
fn delete_session_writes_full_owner_tombstone() {
    let path = unique_temp_db_path();
    let repo = MsgRepo::open(&path).expect("open file repo");
    repo.touch_session("s2").expect("touch s2");
    repo.delete_session("s2", Some("[\"p1\",\"a1\",\"s2\"]"))
        .expect("delete s2");
    drop(repo);
    let conn = Connection::open(&path).expect("read file repo");
    let (owner, scope, state, rev, reason) = tombstone_row(&conn, "s2");
    assert_eq!(
        owner, "[\"p1\",\"a1\",\"s2\"]",
        "tombstone 记录真实 owner_key"
    );
    assert_eq!(scope, "exact");
    assert_eq!(state, "deleted", "delete_session 终态 deleted");
    assert_eq!(rev, 0, "初始 deletion_revision 0");
    assert_eq!(reason, None, "未传 reason 时 NULL");
    drop(conn);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn delete_session_without_owner_uses_session_scoped_legacy_owner() {
    let path = unique_temp_db_path();
    let repo = MsgRepo::open(&path).expect("open file repo");
    repo.touch_session("s1").expect("touch");
    // 旧调用路径（未携带 owner）→ 回退到唯一的会话作用域 legacy owner，
    // 不报错（DEL-02 兼容；DEL-03 起传真实 ownerKey）。
    repo.delete_session("s1", None)
        .expect("delete without owner");
    drop(repo);
    let conn = Connection::open(&path).expect("read");
    let (owner, scope, state, rev, _) = tombstone_row(&conn, "s1");
    assert_eq!(
        owner, "[\"*\",\"*\",\"s1\"]",
        "None → session-scoped legacy key"
    );
    assert_eq!(scope, "legacy");
    assert_eq!(state, "deleted");
    assert_eq!(rev, 0);
    drop(conn);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn delete_session_same_owner_is_idempotent_but_distinct_owners_coexist() {
    let path = unique_temp_db_path();
    let repo = MsgRepo::open(&path).expect("open file repo");
    repo.touch_session("s1").expect("touch");
    repo.delete_session("s1", Some("[\"p1\",\"a1\",\"s1\"]"))
        .expect("first delete");
    repo.delete_session("s1", Some("[\"p1\",\"a1\",\"s1\"]"))
        .expect("same owner repeat idempotent");
    // 不同 durable owner 不得被裸 session_id 主键遮蔽。
    repo.delete_session("s1", Some("[\"p2\",\"b2\",\"s1\"]"))
        .expect("second owner delete");
    drop(repo);
    let conn = Connection::open(&path).expect("read");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM deleted_sessions", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert_eq!(count, 2, "同 owner 幂等、不同 owner 共存");
    drop(conn);
    let _ = std::fs::remove_file(&path);
}

fn unique_temp_db_path() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NONCE: AtomicU64 = AtomicU64::new(0);
    let nonce = NONCE.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "del02-tombstone-{}-{}.sqlite3",
        std::process::id(),
        nonce
    ))
}
