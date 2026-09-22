//! 存储核错误类型（#247）。
//!
//! 变体集、Display 文案与 `code()` 机器码自宿主 SessionError 原样迁入（DEL-05
//! 错误码矩阵测试随 crate 看守）；宿主侧经 `SessionError::Storage(#[from])`
//! 委托保持 wire code 不变。CanonicalEvent/MessagePersistence 委派
//! EventError/MessageError 各自的稳定机器码。

use crate::event_repo::EventError;
use crate::msg_repo::MessageError;

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    /// canonical ingest 错误保留 EventError 的稳定机器码，避免 prompt 路径降级成
    /// 泛化 protocol_error 而丢失 recoverability 分类。
    #[error("Canonical event error: {0}")]
    CanonicalEvent(#[from] EventError),
    /// session/load 会同时读取投影状态；保留 MessageError 的稳定机器码，便于前端
    /// 区分损坏、锁冲突、暂不可用与 tombstone，而不是统一降级为 protocol_error。
    #[error("Message persistence error: {0}")]
    MessagePersistence(#[from] MessageError),
    #[error("database schema version {found} is newer than supported version {supported}")]
    DatabaseFutureSchema { found: i64, supported: i64 },
    #[error("database schema is invalid: {0}")]
    DatabaseSchemaInvalid(String),
    #[error("database integrity check failed: {0}")]
    DatabaseIntegrity(String),
    #[error("session replay truncated; dropped {dropped_count} events")]
    ReplayTruncated { dropped_count: u64 },
    #[error("replay load already in progress")]
    ReplayLoadInProgress,
    /// I13-W3：保留策略写入 revision 冲突（旧写不覆盖新写）。
    #[error("保留策略 revision 冲突：期望 {expected}，实际 {actual}")]
    RevisionConflict { expected: i64, actual: i64 },
    /// I13-W4：prune 前策略 revision 已变化（用户预览后策略被改）→ 拒绝按旧统计执行清理。
    #[error("保留策略已变化：期望 revision {expected}，实际 {actual}；请重新预览")]
    StalePreview { expected: i64, actual: i64 },
    /// 保留历史 From<serde_json::Error> → PylonError::Serialize 的 wire code。
    #[error("serialization error: {0}")]
    Serialize(String),
    #[error("{0}")]
    Generic(String),
}

impl SessionError {
    /// 机器可读错误码（前端分支依据；稳定，不改拼写）。
    pub fn code(&self) -> &'static str {
        match self {
            Self::CanonicalEvent(error) => error.code(),
            Self::MessagePersistence(error) => error.code(),
            Self::DatabaseFutureSchema { .. } => "database_future_schema",
            Self::DatabaseSchemaInvalid(_) => "database_schema_invalid",
            Self::DatabaseIntegrity(_) => "database_integrity_failed",
            Self::ReplayTruncated { .. } => "replay_truncated",
            Self::ReplayLoadInProgress => "replay_load_in_progress",
            Self::RevisionConflict { .. } => "retention_revision_conflict",
            Self::StalePreview { .. } => "retention_stale_preview",
            // 保留历史 From<String> → SessionError::Protocol 的 wire code（契约不变）。
            Self::Serialize(_) => "serialize_error",
            // 保留历史 From<String> → PylonError::Protocol 的 wire code（契约不变）。
            Self::Generic(_) => "protocol_error",
        }
    }
}

impl From<serde_json::Error> for SessionError {
    fn from(error: serde_json::Error) -> Self {
        Self::Serialize(error.to_string())
    }
}

impl From<String> for SessionError {
    fn from(message: String) -> Self {
        Self::Generic(message)
    }
}
