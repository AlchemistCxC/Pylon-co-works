//! DEL-03：本地优先删除事务（方案书 §5.13、任务表 DEL-03）。
//!
//! 覆盖 §5.13 推荐顺序的落地：
//! 1. 校验 OwnerKey（步骤 1）——validate_owner_key / validate_delete_owner 契约；
//! 2. 写 deleting tombstone + 本地事务删除（步骤 2-4）——begin_delete_session 两阶段入口；
//! 3. 终态化 deleting → deleted（步骤 6 远端 close best effort 之后）——finalize_session_delete；
//! 4. 'deleting' 同样 gate 迟到写（不复活）；finalize/重复 begin 幂等。
//! 依赖 DEL-02（v7 tombstone owner/deletion state）；DEL-04 处理 canonical evt_append gate。
//! B7：messages 表已删除，迟到写 gate 验证对象改为 evt_append（EventError::SessionDeleted）。

use rusqlite::Connection;
use std::sync::Arc;

use super::event_repo::{parse_canonical_event, EventError, EventRepo};
use super::msg_repo::{validate_owner_key, MsgRepo};
use super::{delete_session_core, validate_delete_owner, UserDataError};

/// 读 deleted_sessions 单行 owner_key/state。
fn tombstone_owner_state(conn: &Connection, session_id: &str) -> (String, String) {
    conn.query_row(
        "SELECT owner_key, state FROM deleted_sessions WHERE session_id = ?1",
        [session_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .expect("read tombstone row")
}

/// 构造一条 canonical 事件 JSON（owner_key = [p1,a1,s1] 或调用方覆盖）。
fn event_json(owner: [&str; 3], sequence: i64) -> serde_json::Value {
    serde_json::json!({
        "eventId": format!("{}#{}", serde_json::to_string(&owner).unwrap(), sequence),
        "owner": { "profileId": owner[0], "agentId": owner[1], "localSessionId": owner[2] },
        "clientGeneration": 1,
        "sequence": sequence,
        "occurredAt": "2026-01-01T00:00:00.000Z",
        "receivedAt": "2026-01-01T00:00:00.000Z",
        "eventType": "user.message",
        "payloadVersion": 1,
        "rawPayload": {}
    })
}

/// 独立临时库路径（Windows 上释放写连接后才能删文件）。
fn unique_temp_db_path() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NONCE: AtomicU64 = AtomicU64::new(0);
    let nonce = NONCE.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "del03-local-first-{}-{}.sqlite3",
        std::process::id(),
        nonce
    ))
}

// ── 步骤 1：OwnerKey 校验 ──

#[test]
fn validate_owner_key_accepts_valid_three_element_array() {
    // 与 event_repo/eventSchema toCanonicalOwnerKey 同纪律：JSON 数组序列化。
    validate_owner_key(r#"["p1","peri","local:s1"]"#)
        .expect("source 含冒号也应合法（禁冒号拼接故用数组）");
    validate_owner_key(r#"["*","*","local:s1"]"#)
        .expect("会话作用域 legacy owner 是合法 3 元素数组");
    validate_owner_key(r#"["p1","a1","s1"]"#).expect("标准 owner key");
}

#[test]
fn validate_owner_key_rejects_malformed() {
    for bad in [
        "not-json",
        "42",
        "{}",
        r#"["p1","peri"]"#,
        r#"["p1","peri","s1","extra"]"#,
        r#"["p1",42,"s1"]"#,
        r#"["p1","peri",""]"#,
    ] {
        assert!(
            validate_owner_key(bad).is_err(),
            "必须拒绝非法 owner_key：{bad}"
        );
    }
}

#[test]
fn validate_delete_owner_none_passthrough_some_validated() {
    assert!(validate_delete_owner(None).expect("None 放行").is_none());
    let Some(valid) =
        validate_delete_owner(Some(r#"["p1","a1","s1"]"#.into())).expect("合法 key 放行")
    else {
        panic!("Some 应保留")
    };
    assert_eq!(valid, r#"["p1","a1","s1"]"#);
    match validate_delete_owner(Some("garbage".into())) {
        Err(UserDataError::InvalidOwnerKey(_)) => {}
        other => panic!("非法 key 必须 InvalidOwnerKey，实际 {other:?}"),
    }
}

// ── 步骤 2-4：begin（deleting）+ 本地事务删除 ──

#[test]
fn begin_delete_writes_deleting_tombstone_and_keeps_canonical_events() {
    let path = unique_temp_db_path();
    let repo = MsgRepo::open(&path).expect("open file repo");
    repo.touch_session("s1").expect("touch s1");
    let evt = parse_canonical_event(&event_json(["p1", "a1", "s1"], 1)).expect("parse event");
    let evt_repo = EventRepo::open(&path).expect("open event repo");
    evt_repo.append_events(&[evt], None).expect("append event");
    repo.begin_delete_session("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("begin delete");
    drop(repo);
    drop(evt_repo);
    let conn = Connection::open(&path).expect("read file repo");
    let (owner, state) = tombstone_owner_state(&conn, "s1");
    assert_eq!(owner, r#"["p1","a1","s1"]"#, "tombstone 记录真实 owner_key");
    assert_eq!(
        state, "deleting",
        "本地优先两阶段：先写 deleting（终态由 finalize 转）"
    );
    let sessions: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .expect("count sessions");
    assert_eq!(sessions, 0, "begin 事务内已删除 sessions 行（原子）");
    let events: i64 = conn
        .query_row("SELECT COUNT(*) FROM canonical_events", [], |row| {
            row.get(0)
        })
        .expect("count canonical events");
    assert_eq!(events, 1, "canonical_events 行不随删除清除（append-only）");
    drop(conn);
    let _ = std::fs::remove_file(&path);
}

// ── 步骤 6 之后：finalize（deleting → deleted）──

#[test]
fn finalize_transitions_deleting_to_deleted() {
    let path = unique_temp_db_path();
    let repo = MsgRepo::open(&path).expect("open");
    repo.touch_session("s1").expect("touch");
    repo.begin_delete_session("s1", None).expect("begin");
    assert_eq!(
        repo.tombstone_state("s1").expect("state").as_deref(),
        Some("deleting")
    );
    repo.finalize_session_delete("s1", None).expect("finalize");
    assert_eq!(
        repo.tombstone_state("s1").expect("state").as_deref(),
        Some("deleted"),
        "远端 close best effort 后转终态 deleted"
    );
    drop(repo);
    let _ = std::fs::remove_file(&path);
}

// ── 'deleting' 同样 gate 迟到写（不复活）──

#[test]
fn deleting_tombstone_still_gates_late_evt_append() {
    let path = unique_temp_db_path();
    let repo = MsgRepo::open(&path).expect("open");
    repo.touch_session("s1").expect("touch");
    repo.begin_delete_session("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("begin delete");
    let late = parse_canonical_event(&event_json(["p1", "a1", "s1"], 2)).expect("parse late");
    let evt_repo = EventRepo::open(&path).expect("open event repo");
    let result = evt_repo.append_events(&[late], None);
    match result.unwrap_err() {
        EventError::SessionDeleted(_) => {}
        other => panic!("deleting 进行中迟到写必须 SessionDeleted（不复活），实际 {other:?}"),
    }
    drop(repo);
    drop(evt_repo);
    let _ = std::fs::remove_file(&path);
}

// ── 幂等：同 owner 重复 no-op；同 session_id 的不同 owner 必须隔离 ──

#[test]
fn finalize_is_owner_scoped_and_same_owner_begin_is_idempotent() {
    let path = unique_temp_db_path();
    let repo = MsgRepo::open(&path).expect("open");
    // 无 tombstone：finalize no-op（不报错）。
    repo.finalize_session_delete("ghost", None)
        .expect("finalize missing is no-op");
    repo.touch_session("s1").expect("touch");
    repo.begin_delete_session("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("begin 1");
    // 相同 owner 重复 begin：INSERT OR IGNORE 幂等。
    repo.begin_delete_session("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("same owner begin idempotent");
    // 相同 metadata id 的另一个 durable owner 是独立 tombstone，不能被裸 session PK 遮蔽。
    repo.begin_delete_session("s1", Some(r#"["p2","b2","s1"]"#))
        .expect("second owner begin");
    // finalize 只推进 owner1；owner2 必须保持 deleting。
    repo.finalize_session_delete("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("finalize");
    repo.finalize_session_delete("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("finalize again no-op");
    drop(repo);
    let conn = Connection::open(&path).expect("read");
    let owner1_state: String = conn
        .query_row(
            "SELECT state FROM deleted_sessions WHERE owner_key = ?1",
            [r#"["p1","a1","s1"]"#],
            |row| row.get(0),
        )
        .expect("owner1 state");
    let owner2_state: String = conn
        .query_row(
            "SELECT state FROM deleted_sessions WHERE owner_key = ?1",
            [r#"["p2","b2","s1"]"#],
            |row| row.get(0),
        )
        .expect("owner2 state");
    assert_eq!(owner1_state, "deleted");
    assert_eq!(owner2_state, "deleting");
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM deleted_sessions", [], |row| {
            row.get(0)
        })
        .expect("count");
    assert_eq!(count, 2, "同 owner 不重复，不同 owner 不碰撞");
    drop(conn);
    let _ = std::fs::remove_file(&path);
}

// ── 命令层：delete_session_core 写 deleting（两阶段入口）──

#[tokio::test]
async fn delete_session_core_writes_deleting_tombstone() {
    // 与既有 CR-01 幂等补删测试同构：真实服务 → 命令核心 → tombstone 为 deleting。
    let state = crate::test_utils::TestStateBuilder::bare().build();
    let user = Arc::new(crate::session::UserDataService::in_memory().expect("user service"));
    let msg = Arc::new(crate::session::MessageService::in_memory().expect("msg service"));
    *state.user_data_service.lock().unwrap() = Some(user.clone());
    *state.message_service.lock().unwrap() = Some(msg.clone());
    let envelope = serde_json::json!({
        "version": 2,
        "sessions": [{ "id": "s1", "agentId": "peri", "name": "S", "source": "qq:g:1", "profileId": "p" }]
    });
    user.save(
        crate::session::user_data::UserDataKey::Sessions,
        envelope,
        None,
    )
    .await
    .expect("save sessions");

    let owner_key = r#"["p","peri","qq:g:1"]"#;
    delete_session_core(&state, "s1".into(), Some(owner_key.into()))
        .await
        .expect("delete core");

    // 命令层入口写出的是 deleting（未 finalize）——远端 close best effort 后才终态化。
    let state_deleting = msg.repo().tombstone_state("s1").expect("read state");
    assert_eq!(
        state_deleting.as_deref(),
        Some("deleting"),
        "delete_session_core 必须走两阶段 deleting 入口"
    );

    // 终态化命令：deleting → deleted。
    msg.finalize_session_delete("s1".into(), Some(owner_key.into()))
        .await
        .expect("finalize");
    let state_deleted = msg.repo().tombstone_state("s1").expect("read state");
    assert_eq!(state_deleted.as_deref(), Some("deleted"));
}
