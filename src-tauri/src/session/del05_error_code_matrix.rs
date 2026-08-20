//! DEL-05：P4 幂等/断线/重试矩阵与错误码契约（方案书任务表 DEL-05——测试卡，依赖 DEL-02~04）。
//!
//! 两层交付：
//! 1. **wire 错误码契约矩阵**——MessageError / UserDataError / EventError 的
//!    `{code, message}` 序列化形状与稳定 code 字符串快照（B1.2：前端按 code 分支）。
//!    任一 code 拼写变更即失败——这是前端 `asRepositoryError` / scheduler 终态分支
//!    （DEL-04）依赖的稳定契约。
//! 2. **P4 场景矩阵**——删除→迟到写 wire code=event_session_deleted（canonical evt_append
//!    终态）；owner_key 非法 wire code=invalid_owner_key（校验前置）。幂等/断线/重试的
//!    行为矩阵在前端 `del05_p4DeleteMatrix.test.ts` 组合交易+调度器验证。
//! B7：messages 表已删除，迟到写矩阵从 msg_append 迁移到 evt_append。

use super::event_repo::{parse_canonical_event, EventError, EventRepo};
use super::msg_repo::{MessageError, MsgRepo};
use super::{validate_delete_owner, UserDataError};

/// wire 序列化 `{code, message}` 中的 code 提取（断言形状稳定）。
fn wire_code<T: serde::Serialize>(error: &T) -> String {
    let value = serde_json::to_value(error).expect("wire serialization must not fail");
    let map = value.as_object().expect("wire 必须是对象 {code,message}");
    // LOG-03 消化 DEL-05 CR-001：wire 形状锁定为恰 {code,message} 两键——前端
    // asRepositoryError 只按这两键解析，多余键（若被未来实现夹带）会被静默忽略，
    // 必须在契约层拦截；LOG-03 的 RuntimeLogEntry.code 消费同词汇（不发明新码）。
    assert_eq!(
        map.len(),
        2,
        "wire 必须恰为 {{code,message}} 两键（键集锁定，CR-001）"
    );
    assert!(
        map.contains_key("message"),
        "wire 必须带 message（前端展示用）"
    );
    map.get("code")
        .and_then(|code| code.as_str())
        .expect("wire.code 必须是字符串")
        .to_string()
}

#[test]
fn message_error_wire_codes_are_stable_contract() {
    let cases: Vec<(MessageError, &str)> = vec![
        (MessageError::Corrupt("x".into()), "message_repo_corrupt"),
        (
            MessageError::Constraint("x".into()),
            "message_repo_constraint",
        ),
        (MessageError::Conflict("x".into()), "message_repo_conflict"),
        (
            MessageError::Unavailable("x".into()),
            "message_db_unavailable",
        ),
        (MessageError::SessionDeleted("s1".into()), "session_deleted"),
    ];
    for (error, expected_code) in cases {
        assert_eq!(
            wire_code(&error),
            expected_code,
            "MessageError wire code 契约（前端按此分支，不得改拼写）"
        );
    }
}

#[test]
fn event_error_wire_codes_are_stable_contract() {
    let cases: Vec<(EventError, &str)> = vec![
        (
            EventError::RevisionConflict {
                expected: 1,
                actual: 2,
            },
            "event_revision_conflict",
        ),
        (EventError::Corrupt("x".into()), "event_repo_corrupt"),
        (EventError::Constraint("x".into()), "event_repo_constraint"),
        (EventError::Conflict("x".into()), "event_repo_conflict"),
        (
            EventError::SessionDeleted("s1".into()),
            "event_session_deleted",
        ),
        (EventError::Unavailable("x".into()), "event_db_unavailable"),
        (EventError::Invalid("x".into()), "event_invalid"),
    ];
    for (error, expected_code) in cases {
        assert_eq!(
            wire_code(&error),
            expected_code,
            "EventError wire code 契约（evt_* 前端按此分支，不得改拼写）"
        );
    }
}

#[test]
fn user_data_error_wire_codes_are_stable_contract() {
    let cases: Vec<(UserDataError, &str)> = vec![
        (
            UserDataError::RevisionConflict {
                expected: 1,
                actual: 2,
            },
            "user_data_revision_conflict",
        ),
        (
            UserDataError::Unavailable("x".into()),
            "user_data_unavailable",
        ),
        (UserDataError::Corrupt("x".into()), "user_data_corrupt"),
        (UserDataError::NotFound("x".into()), "user_data_not_found"),
        (
            UserDataError::InvalidOwnerKey("x".into()),
            "invalid_owner_key",
        ),
    ];
    for (error, expected_code) in cases {
        assert_eq!(
            wire_code(&error),
            expected_code,
            "UserDataError wire code 契约（前端按此分支，不得改拼写）"
        );
    }
}

/// P4-终态矩阵：删除会话后迟到 evt_append → wire code=event_session_deleted（scheduler 依赖它判终态）。
#[test]
fn delete_then_evt_append_wire_code_is_event_session_deleted() {
    let path = unique_temp_db_path();
    let repo = MsgRepo::open(&path).expect("open file repo");
    repo.touch_session("s1").expect("touch s1");
    repo.delete_session("s1", Some(r#"["p1","a1","s1"]"#))
        .expect("delete s1");

    let late = parse_canonical_event(&serde_json::json!({
        "eventId": "[\"p1\",\"a1\",\"s1\"]#1",
        "owner": { "profileId": "p1", "agentId": "a1", "localSessionId": "s1" },
        "clientGeneration": 1,
        "sequence": 1,
        "occurredAt": "2026-01-01T00:00:00.000Z",
        "receivedAt": "2026-01-01T00:00:00.000Z",
        "eventType": "user.message",
        "payloadVersion": 1,
        "rawPayload": {}
    }))
    .expect("parse late event");
    let evt_repo = EventRepo::open(&path).expect("open event repo");
    let error = evt_repo
        .append_events(&[late], None)
        .expect_err("迟到写必须是 SessionDeleted");
    match error {
        EventError::SessionDeleted(_) => {}
        other => panic!("迟到写必须是 EventError::SessionDeleted，实际 {other:?}"),
    }
    // 矩阵断言 wire 形状：code=event_session_deleted 且 message 非空（前端 scheduler 按 code 分支）。
    let err = EventError::SessionDeleted("s1".into());
    assert_eq!(wire_code(&err), "event_session_deleted");
    let value = serde_json::to_value(&err).expect("serialize");
    assert!(value["message"].as_str().is_some_and(|m| !m.is_empty()));

    drop(repo);
    drop(evt_repo);
    let _ = std::fs::remove_file(&path);
}

/// P4-校验矩阵：owner_key 非法 → wire code=invalid_owner_key（删除前校验前置，拒绝污染 tombstone）。
#[test]
fn invalid_owner_key_wire_code_is_invalid_owner_key() {
    for bad in [
        "garbage",
        r#"["p1","a1"]"#,
        r#"{"a":1}"#,
        r#"["p1","a1",""]"#,
    ] {
        match validate_delete_owner(Some(bad.to_string())) {
            Err(UserDataError::InvalidOwnerKey(_)) => {
                let code = wire_code(&UserDataError::InvalidOwnerKey(bad.to_string()));
                assert_eq!(code, "invalid_owner_key", "非法 owner_key 必须带稳定 code");
            }
            other => panic!("owner_key {bad:?} 必须 InvalidOwnerKey，实际 {other:?}"),
        }
    }
    // None 放行（旧调用路径），合法 3 元数组放行。
    assert!(validate_delete_owner(None).is_ok());
    assert!(validate_delete_owner(Some(r#"["p","a","s"]"#.to_string())).is_ok());
}

fn unique_temp_db_path() -> std::path::PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nonce = COUNTER.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "del05-matrix-{}-{}.sqlite3",
        std::process::id(),
        nonce
    ))
}
