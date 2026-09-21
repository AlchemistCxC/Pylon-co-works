//! 事件仓库结构化错误。

use serde::ser::SerializeMap;
use serde::Serialize;

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
