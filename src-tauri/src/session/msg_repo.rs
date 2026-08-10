//! 消息仓库：SQLite 持久化（sessions / messages / send_attempts）。
//! 契约来源：ISSUE-06 D-02（版本化 schema + 迁移、UNIQUE 去重、事务级联删除、
//! 游标分页无 OFFSET）、D-17（启动扫描将未完成 attempt 收敛为 interrupted，
//! 扫描+收敛单事务、幂等、失败阻止发送；retryOf 新 attempt identity）、
//! D-16（原始 ACP chunks 不落库，仅内存环形缓冲——本库只存最终文本）。
//!
//! 同步访问（`Mutex<Connection>`，SQLite 单写者）；上层须经 spawn_blocking
//! 调用，不得在 async 执行器线程上直接执行。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::PylonError;

/// 当前 schema 版本（PRAGMA user_version）。新增迁移必须同步递增。
pub(crate) const SCHEMA_VERSION: i64 = 1;

/// v1 schema DDL（CREATE IF NOT EXISTS；升版迁移在 migrate() 内按版本补齐）。
/// - messages.message_id UNIQUE：跨重启去重键（D-02）。
/// - messages(session_id, seq) UNIQUE：会话内单调序号——游标分页基准（D-02）。
/// - send_attempts.status CHECK：pending | succeeded | interrupted（D-17 契约）。
/// - send_attempts.retry_of：重试时新 attempt 指向前一 attempt 的 message（D-17）。
/// - ON DELETE CASCADE：删除 session 事务内级联清空 messages / send_attempts（D-02）。
/// - D-16：无 chunk 存储表——原始 ACP chunks 不落库。
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    client_msg_id TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(session_id, seq)
);
CREATE TABLE IF NOT EXISTS send_attempts (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    message_id TEXT PRIMARY KEY NOT NULL REFERENCES messages(message_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending','succeeded','interrupted')),
    retry_of TEXT REFERENCES messages(message_id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
"#;

/// 消息仓库：单一 SQLite 连接 + 互斥（SQLite 单写者）。
pub(crate) struct MsgRepo {
    conn: Mutex<Connection>,
}

/// 消息行（messages 表）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MessageRecord {
    pub(crate) message_id: String,
    pub(crate) session_id: String,
    pub(crate) seq: i64,
    pub(crate) role: String,
    pub(crate) content: String,
    pub(crate) client_msg_id: Option<String>,
    pub(crate) created_at: i64,
}

/// 发送 attempt 行（send_attempts 表）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AttemptRow {
    pub(crate) message_id: String,
    pub(crate) status: String,
    pub(crate) retry_of: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

/// attempt 生命周期状态（D-17 契约枚举）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AttemptStatus {
    Pending,
    Succeeded,
    Interrupted,
}

impl AttemptStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Succeeded => "succeeded",
            Self::Interrupted => "interrupted",
        }
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn repo_err(error: rusqlite::Error) -> PylonError {
    PylonError::from(format!("message repo: {error}"))
}

fn lock_err<E>(_: E) -> PylonError {
    PylonError::from("message repo lock poisoned".to_string())
}

fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRecord> {
    Ok(MessageRecord {
        message_id: row.get(0)?,
        session_id: row.get(1)?,
        seq: row.get(2)?,
        role: row.get(3)?,
        content: row.get(4)?,
        client_msg_id: row.get(5)?,
        created_at: row.get(6)?,
    })
}

fn row_to_attempt(row: &rusqlite::Row<'_>) -> rusqlite::Result<AttemptRow> {
    Ok(AttemptRow {
        message_id: row.get(0)?,
        status: row.get(1)?,
        retry_of: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

/// 版本化迁移：PRAGMA user_version 低于 SCHEMA_VERSION 时，在单个事务内
/// 补齐 DDL 并写入新版本号；失败回滚，半迁移状态不残留（D-02）。
fn migrate(conn: &mut Connection) -> Result<(), PylonError> {
    let current: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(repo_err)?;
    if current >= SCHEMA_VERSION {
        return Ok(());
    }
    let tx = conn.transaction().map_err(repo_err)?;
    tx.execute_batch(SCHEMA_SQL).map_err(repo_err)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(repo_err)?;
    tx.commit().map_err(repo_err)
}

/// 打开并迁移仓库；FK 开启（ON DELETE CASCADE 级联删除依赖）。
fn connect(conn: &mut Connection) -> Result<(), PylonError> {
    conn.pragma_update(None, "foreign_keys", true)
        .map_err(repo_err)?;
    migrate(conn)
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
    pub(crate) fn open_in_memory() -> Result<MsgRepo, PylonError> {
        let mut conn = Connection::open_in_memory().map_err(repo_err)?;
        connect(&mut conn)?;
        Ok(MsgRepo {
            conn: Mutex::new(conn),
        })
    }

    /// 记录会话（首次插入 / 已存在仅刷新 updated_at）。
    pub(crate) fn touch_session(&self, session_id: &str) -> Result<(), PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let now = now_millis();
        conn.execute(
            "INSERT INTO sessions (session_id, created_at, updated_at) VALUES (?1, ?2, ?2)
             ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at",
            params![session_id, now],
        )
        .map_err(repo_err)?;
        Ok(())
    }

    /// 生成会话内下一个消息序号（游标分页基准）。
    pub(crate) fn next_seq(&self, session_id: &str) -> Result<i64, PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        // MAX(seq) 空会话返回一行 NULL：行内再解包一层 Option，flatten 后统一为 None。
        let max: Option<i64> = conn
            .query_row(
                "SELECT MAX(seq) FROM messages WHERE session_id = ?1",
                params![session_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map_err(repo_err)?
            .flatten();
        Ok(max.unwrap_or(0) + 1)
    }

    /// 写入消息；message_id 冲突幂等忽略（重启去重，D-02）。
    /// UNIQUE(session_id, seq) 冲突仍报错（会话内序号唯一是硬约束）。
    pub(crate) fn insert_message(&self, msg: &MessageRecord) -> Result<(), PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        conn.execute(
            "INSERT INTO messages
                 (message_id, session_id, seq, role, content, client_msg_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(message_id) DO NOTHING",
            params![
                msg.message_id,
                msg.session_id,
                msg.seq,
                msg.role,
                msg.content,
                msg.client_msg_id,
                msg.created_at
            ],
        )
        .map_err(repo_err)?;
        Ok(())
    }

    /// 游标分页：返回 seq < before_seq 的最新 limit 条（升序，无 OFFSET）。
    /// before_seq 为 None 表示最新一页。上页最旧一条的 seq 即下一页游标。
    pub(crate) fn list_messages(
        &self,
        session_id: &str,
        before_seq: Option<i64>,
        limit: u32,
    ) -> Result<Vec<MessageRecord>, PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let mut stmt = conn
            .prepare(
                "SELECT message_id, session_id, seq, role, content, client_msg_id, created_at
                 FROM messages
                 WHERE session_id = ?1 AND (?2 IS NULL OR seq < ?2)
                 ORDER BY seq DESC
                 LIMIT ?3",
            )
            .map_err(repo_err)?;
        let rows = stmt
            .query_map(params![session_id, before_seq, i64::from(limit)], row_to_message)
            .map_err(repo_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(repo_err)?);
        }
        out.reverse(); // 升序返回（最新一条在尾部）
        Ok(out)
    }

    /// D-06 去重：按 clientMsgId 查已有消息（乐观重试识别原始消息）。
    pub(crate) fn find_by_client_msg_id(
        &self,
        client_msg_id: &str,
    ) -> Result<Option<MessageRecord>, PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let msg = conn
            .query_row(
                "SELECT message_id, session_id, seq, role, content, client_msg_id, created_at
                 FROM messages
                 WHERE client_msg_id = ?1
                 ORDER BY seq DESC
                 LIMIT 1",
                params![client_msg_id],
                row_to_message,
            )
            .optional()
            .map_err(repo_err)?;
        Ok(msg)
    }

    /// 新建发送 attempt（status=pending）。retry_of：重试时新 attempt 指向前一
    /// attempt 的 message_id（None 为首发）。同 message 已存在时幂等忽略。
    pub(crate) fn begin_attempt(
        &self,
        session_id: &str,
        message_id: &str,
        retry_of: Option<&str>,
    ) -> Result<(), PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let now = now_millis();
        conn.execute(
            "INSERT OR IGNORE INTO send_attempts
                 (session_id, message_id, status, retry_of, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![
                session_id,
                message_id,
                AttemptStatus::Pending.as_str(),
                retry_of,
                now
            ],
        )
        .map_err(repo_err)?;
        Ok(())
    }

    /// 标记 attempt 完成（succeeded / interrupted）；无对应行报错。
    pub(crate) fn finish_attempt(
        &self,
        message_id: &str,
        status: AttemptStatus,
    ) -> Result<(), PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let updated = conn
            .execute(
                "UPDATE send_attempts SET status = ?1, updated_at = ?2 WHERE message_id = ?3",
                params![status.as_str(), now_millis(), message_id],
            )
            .map_err(repo_err)?;
        if updated == 0 {
            return Err(PylonError::from(format!(
                "message repo: no attempt for message {message_id}"
            )));
        }
        Ok(())
    }

    /// D-17 启动扫描：单事务内将所有 pending attempt 收敛为 interrupted。
    /// 幂等（二次执行 0 行）；返回收敛行数；失败返回 Err——调用方须阻止发送。
    pub(crate) fn converge_interrupted(&self) -> Result<usize, PylonError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(repo_err)?;
        let count = tx
            .execute(
                "UPDATE send_attempts SET status = ?1, updated_at = ?2
                 WHERE status = ?3",
                params![
                    AttemptStatus::Interrupted.as_str(),
                    now_millis(),
                    AttemptStatus::Pending.as_str()
                ],
            )
            .map_err(repo_err)?;
        tx.commit().map_err(repo_err)?;
        Ok(count)
    }

    /// D-02 事务级联删除：删除 session 及其 messages / send_attempts（FK CASCADE）。
    pub(crate) fn delete_session(&self, session_id: &str) -> Result<(), PylonError> {
        let mut conn = self.conn.lock().map_err(lock_err)?;
        let tx = conn.transaction().map_err(repo_err)?;
        tx.execute("DELETE FROM sessions WHERE session_id = ?1", params![session_id])
            .map_err(repo_err)?;
        tx.commit().map_err(repo_err)?;
        Ok(())
    }

    /// 会话内全部 attempt 行（测试断言与后续 FE 读取用）。
    pub(crate) fn attempts(&self, session_id: &str) -> Result<Vec<AttemptRow>, PylonError> {
        let conn = self.conn.lock().map_err(lock_err)?;
        let mut stmt = conn
            .prepare(
                "SELECT message_id, status, retry_of, created_at, updated_at
                 FROM send_attempts
                 WHERE session_id = ?1
                 ORDER BY created_at, message_id",
            )
            .map_err(repo_err)?;
        let rows = stmt
            .query_map(params![session_id], row_to_attempt)
            .map_err(repo_err)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(repo_err)?);
        }
        Ok(out)
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
            "pylon-msg-repo-test-{}-{}-{}.db",
            std::process::id(),
            n,
            nanos
        ))
    }

    fn msg(message_id: &str, session_id: &str, seq: i64, client_msg_id: Option<&str>) -> MessageRecord {
        MessageRecord {
            message_id: message_id.into(),
            session_id: session_id.into(),
            seq,
            role: "user".into(),
            content: "hi".into(),
            client_msg_id: client_msg_id.map(ToOwned::to_owned),
            created_at: now_millis(),
        }
    }

    /// 打开内存仓库并建立会话 s1。
    fn repo_with_session() -> MsgRepo {
        let repo = MsgRepo::open_in_memory().expect("open in-memory repo");
        repo.touch_session("s1").expect("touch s1");
        repo
    }

    #[test]
    fn migrate_fresh_db_to_current_version() {
        let repo = MsgRepo::open_in_memory().expect("open");
        let conn = repo.conn.lock().unwrap();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION, "新库迁移到当前版本");
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for required in ["sessions", "messages", "send_attempts"] {
            assert!(
                tables.iter().any(|t| t == required),
                "缺少核心表 {required}: {tables:?}"
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
    fn insert_message_requires_existing_session() {
        let repo = MsgRepo::open_in_memory().expect("open");
        let ghost = msg("m1", "ghost-session", 1, None);
        assert!(
            repo.insert_message(&ghost).is_err(),
            "FK：sessions 无对应行时写入必须失败"
        );
    }

    #[test]
    fn duplicate_message_id_idempotent() {
        let repo = repo_with_session();
        let m1 = msg("m1", "s1", 1, Some("c1"));
        repo.insert_message(&m1).expect("insert m1");
        // 重启去重：同 message_id 重复写入被忽略（不报错、不新增行）
        repo.insert_message(&m1).expect("insert m1 again (idempotent)");
        let rows = repo.list_messages("s1", None, 10).expect("list");
        assert_eq!(rows.len(), 1, "message_id 去重后仍只有一行");
    }

    #[test]
    fn duplicate_seq_within_session_rejected() {
        let repo = repo_with_session();
        let m1 = msg("m1", "s1", 1, None);
        repo.insert_message(&m1).expect("insert m1");
        let dup = msg("m2", "s1", 1, None);
        assert!(
            repo.insert_message(&dup).is_err(),
            "UNIQUE(session_id, seq)：同会话同 seq 必须拒绝"
        );
        // 不同会话允许相同 seq
        repo.touch_session("s2").expect("touch s2");
        let other = msg("m3", "s2", 1, None);
        repo.insert_message(&other).expect("同 seq 不同会话可写");
    }

    #[test]
    fn cursor_paging_no_offset() {
        let repo = repo_with_session();
        for i in 1..=5 {
            repo.insert_message(&msg(&format!("m{i}"), "s1", i, None))
                .expect("insert");
        }
        // 最新一页：seq 4,5（升序）
        let page1 = repo.list_messages("s1", None, 2).expect("page1");
        let seqs1: Vec<i64> = page1.iter().map(|m| m.seq).collect();
        assert_eq!(seqs1, vec![4, 5], "最新页取最新 2 条");
        // 游标 = 上页最旧 seq（4），翻旧一页：2,3
        let page2 = repo
            .list_messages("s1", Some(4), 2)
            .expect("page2");
        let seqs2: Vec<i64> = page2.iter().map(|m| m.seq).collect();
        assert_eq!(seqs2, vec![2, 3], "游标翻页无 OFFSET");
        // 再翻：仅剩 1
        let page3 = repo
            .list_messages("s1", Some(2), 2)
            .expect("page3");
        let seqs3: Vec<i64> = page3.iter().map(|m| m.seq).collect();
        assert_eq!(seqs3, vec![1]);
    }

    #[test]
    fn next_seq_starts_at_one_and_increments() {
        let repo = repo_with_session();
        assert_eq!(repo.next_seq("s1").expect("first seq"), 1);
        repo.insert_message(&msg("m1", "s1", 1, None)).expect("insert");
        assert_eq!(repo.next_seq("s1").expect("next seq"), 2);
    }

    #[test]
    fn find_by_client_msg_id_returns_latest() {
        let repo = repo_with_session();
        repo.insert_message(&msg("m1", "s1", 1, Some("c1"))).expect("insert m1");
        let found = repo
            .find_by_client_msg_id("c1")
            .expect("query")
            .expect("命中");
        assert_eq!(found.message_id, "m1");
        assert!(repo.find_by_client_msg_id("missing").expect("query").is_none());
    }

    #[test]
    fn begin_attempt_idempotent_for_same_message() {
        let repo = repo_with_session();
        repo.insert_message(&msg("m1", "s1", 1, None)).expect("insert");
        repo.begin_attempt("s1", "m1", None).expect("begin");
        repo.begin_attempt("s1", "m1", None).expect("begin again (idempotent)");
        let rows = repo.attempts("s1").expect("attempts");
        assert_eq!(rows.len(), 1, "同 message 重复 begin 不重复计数");
        assert_eq!(rows[0].status, "pending");
    }

    #[test]
    fn finish_attempt_transitions_and_errors_when_unknown() {
        let repo = repo_with_session();
        repo.insert_message(&msg("m1", "s1", 1, None)).expect("insert");
        repo.begin_attempt("s1", "m1", None).expect("begin");
        repo.finish_attempt("m1", AttemptStatus::Succeeded)
            .expect("finish succeeded");
        let rows = repo.attempts("s1").expect("attempts");
        assert_eq!(rows[0].status, "succeeded");
        assert!(
            repo.finish_attempt("no-such-message", AttemptStatus::Succeeded)
                .is_err(),
            "未知 attempt 必须报错"
        );
    }

    #[test]
    fn converge_interrupted_is_idempotent_and_single_transaction() {
        let repo = repo_with_session();
        for i in 1..=2 {
            let id = format!("m{i}");
            repo.insert_message(&msg(&id, "s1", i, None)).expect("insert");
            repo.begin_attempt("s1", &id, None).expect("begin");
        }
        // 一个已完成的 attempt 不受收敛影响
        repo.insert_message(&msg("m3", "s1", 3, None)).expect("insert");
        repo.begin_attempt("s1", "m3", None).expect("begin");
        repo.finish_attempt("m3", AttemptStatus::Succeeded).expect("finish");
        assert_eq!(repo.converge_interrupted().expect("converge"), 2);
        let rows = repo.attempts("s1").expect("attempts");
        assert_eq!(rows.iter().filter(|r| r.status == "interrupted").count(), 2);
        assert_eq!(rows.iter().filter(|r| r.status == "succeeded").count(), 1);
        // 幂等：pending 清零后二次收敛 0 行
        assert_eq!(repo.converge_interrupted().expect("converge again"), 0);
    }

    #[test]
    fn retry_creates_new_attempt_identity_with_retry_of() {
        let repo = repo_with_session();
        repo.insert_message(&msg("m1", "s1", 1, Some("c1"))).expect("insert m1");
        repo.begin_attempt("s1", "m1", None).expect("begin m1");
        // 进程崩溃/重启：启动扫描收敛未完成 attempt
        assert_eq!(repo.converge_interrupted().expect("converge"), 1);
        let rows = repo.attempts("s1").expect("attempts");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "interrupted");
        assert_eq!(rows[0].retry_of, None);
        // 用户重试：新 message（新 message_id/seq）+ 新 attempt（新身份），retry_of → m1
        repo.insert_message(&msg("m2", "s1", 2, Some("c1"))).expect("insert m2");
        repo.begin_attempt("s1", "m2", Some("m1")).expect("begin m2 retry");
        let rows = repo.attempts("s1").expect("attempts");
        assert_eq!(rows.len(), 2, "重试产生独立 attempt 身份，不覆盖旧行");
        let retry = rows.iter().find(|r| r.message_id == "m2").unwrap();
        assert_eq!(retry.status, "pending");
        assert_eq!(retry.retry_of.as_deref(), Some("m1"), "retryOf 指向前一 attempt");
        let original = rows.iter().find(|r| r.message_id == "m1").unwrap();
        assert_eq!(original.status, "interrupted", "旧 attempt 保持 interrupted");
        // 新 attempt 再收敛 1 行，随后幂等 0 行
        assert_eq!(repo.converge_interrupted().expect("converge"), 1);
        assert_eq!(repo.converge_interrupted().expect("converge again"), 0);
    }

    #[test]
    fn delete_session_cascades_messages_and_attempts() {
        let repo = repo_with_session();
        repo.insert_message(&msg("m1", "s1", 1, None)).expect("insert m1");
        repo.begin_attempt("s1", "m1", None).expect("begin m1");
        // 无关会话不受级联影响
        repo.touch_session("s2").expect("touch s2");
        repo.insert_message(&msg("m2", "s2", 1, None)).expect("insert m2");
        repo.delete_session("s1").expect("delete s1");
        assert_eq!(repo.list_messages("s1", None, 10).expect("list s1").len(), 0);
        assert_eq!(repo.attempts("s1").expect("attempts s1").len(), 0);
        assert_eq!(
            repo.list_messages("s2", None, 10).expect("list s2").len(),
            1,
            "其他会话数据保留"
        );
    }

    #[test]
    fn schema_has_no_chunk_storage_d16() {
        let repo = MsgRepo::open_in_memory().expect("open");
        let conn = repo.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(
            !tables.iter().any(|t| t.to_lowercase().contains("chunk")),
            "D-16：原始 ACP chunks 不得落库，schema 无 chunk 表"
        );
    }

    #[test]
    fn converge_interrupted_failure_returns_err() {
        // 锁被 poison（模拟连接不可用）→ 收敛必须返回 Err（D-17：扫描失败阻止发送）
        let poisoned: Mutex<Connection> = Mutex::new(Connection::open_in_memory().unwrap());
        {
            let guard = poisoned.lock().unwrap();
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
                let _ = &guard;
                panic!("poison the mutex for failure-path test");
            }));
        }
        let repo = MsgRepo { conn: poisoned };
        assert!(repo.converge_interrupted().is_err());
    }
}
