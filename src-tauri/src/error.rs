//! Structured error types for Pylon backend.
//!
//! B1.2：错误 DTO 结构化——`{ "code": "...", "message": "..." }`，
//! 前端按 code 分支处理，message 仅供展示。内部仍以 Display 传播细节。

use serde::ser::SerializeMap;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum PylonError {
    #[error("ACP error: {0}")]
    Acp(String),
    #[error("agent process crashed")]
    AgentCrashed,
    #[error("session not found: {0}")]
    SessionNotFound(String),
    /// OWNER-01（§5.8）：owner runtime 不存在（agent 未配置/未启动/未知）时返回，
    /// 禁止 fallback 到另一个 active runtime。agent_id 保留用于诊断（不落日志原文）。
    /// dead_code（预期）：契约卡 API——OWNER-02 起命令层显式 agentId 路由消费。
    #[allow(dead_code)]
    #[error("agent runtime unavailable for agent: {agent_id}")]
    AgentRuntimeUnavailable { agent_id: String },
    #[error("no active agent configured")]
    NoActiveAgent,
    #[error("serialization error: {0}")]
    Serialize(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("ACP protocol: {0}")]
    Protocol(String),
    /// canonical ingest 错误保留 EventError 的稳定机器码，避免 prompt 路径降级成
    /// 泛化 protocol_error 而丢失 recoverability 分类。
    #[error("Canonical event error: {0}")]
    CanonicalEvent(#[from] crate::session::EventError),
    /// session/load 会同时读取投影状态；保留 MessageError 的稳定机器码，便于前端
    /// 区分损坏、锁冲突、暂不可用与 tombstone，而不是统一降级为 protocol_error。
    #[error("Message persistence error: {0}")]
    MessagePersistence(#[from] crate::session::MessageError),
    #[error("database schema version {found} is newer than supported version {supported}")]
    DatabaseFutureSchema { found: i64, supported: i64 },
    #[error("database schema is invalid: {0}")]
    DatabaseSchemaInvalid(String),
    #[error("database integrity check failed: {0}")]
    DatabaseIntegrity(String),
    #[error("session replay truncated; dropped {dropped_count} events")]
    ReplayTruncated { dropped_count: u64 },
    #[error("{0}")]
    Workspace(String),
    #[error("Prism error: {0}")]
    Prism(String),
    /// B5：Git 只读操作错误（非 git 仓库 / git 不可用 / 命令失败）。
    #[error("Git error: {0}")]
    Git(String),
    /// 插件目录/状态错误（细分 code 经 PluginError::code 委派）。
    #[error("Plugin error: {0}")]
    Plugin(#[from] crate::plugin_cmds::PluginError),
    /// R7（P2-1）：配置加载领域错误（细分 code 经 ConfigError::code 委派）。
    #[error("Config error: {0}")]
    Config(#[from] crate::agent_config::ConfigError),
    /// R4/R7（P1-2/P2-1）：Gateway 域错误（细分 code 经 GatewayError::code 委派）。
    #[error("Gateway error: {0}")]
    Gateway(#[from] crate::gateway::GatewayError),
    /// I13-W3：保留策略写入 revision 冲突（旧写不覆盖新写；wire code 经
    /// RetentionError::Conflict 委派为 retention_revision_conflict）。
    #[error("保留策略 revision 冲突：期望 {expected}，实际 {actual}")]
    RevisionConflict { expected: i64, actual: i64 },
    /// I13-W4：prune 前策略 revision 已变化（用户预览后策略被改）→ 拒绝按旧统计执行清理
    /// （wire code 经 RetentionError::StalePreview 委派为 retention_stale_preview）。
    #[error("保留策略已变化：期望 revision {expected}，实际 {actual}；请重新预览")]
    StalePreview { expected: i64, actual: i64 },
}

impl PylonError {
    /// 机器可读错误码（前端分支依据；稳定，不改拼写）。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Acp(_) => "acp_error",
            Self::AgentCrashed => "agent_crashed",
            Self::SessionNotFound(_) => "session_not_found",
            Self::AgentRuntimeUnavailable { .. } => "agent_runtime_unavailable",
            Self::NoActiveAgent => "no_active_agent",
            Self::Serialize(_) => "serialize_error",
            Self::Io(_) => "io_error",
            Self::Protocol(_) => "protocol_error",
            Self::CanonicalEvent(error) => error.code(),
            Self::MessagePersistence(error) => error.code(),
            Self::DatabaseFutureSchema { .. } => "database_future_schema",
            Self::DatabaseSchemaInvalid(_) => "database_schema_invalid",
            Self::DatabaseIntegrity(_) => "database_integrity_failed",
            Self::ReplayTruncated { .. } => "replay_truncated",
            Self::Workspace(_) => "workspace_error",
            Self::Prism(_) => "prism_error",
            Self::Git(_) => "git_error",
            Self::Plugin(error) => error.code(),
            Self::Config(error) => error.code(),
            Self::Gateway(error) => error.code(),
            Self::RevisionConflict { .. } => "retention_revision_conflict",
            Self::StalePreview { .. } => "retention_stale_preview",
        }
    }
}

// Display/Error 由 thiserror derive（R2）；错误文案与手写 impl 逐字一致（契约不变）。

/// B1.2：结构化 DTO——`{ "code", "message" }`（前端按 code 分支，message 展示用）。
impl Serialize for PylonError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        map.serialize_entry("code", self.code())?;
        map.serialize_entry("message", &self.to_string())?;
        map.end()
    }
}

/// 内部 String 错误 → Protocol（保持消息，语义细化留待各子系统错误类型）。
impl From<String> for PylonError {
    fn from(msg: String) -> Self {
        PylonError::Protocol(msg)
    }
}

// ── Auto-conversion from std/third-party errors ──

impl From<std::io::Error> for PylonError {
    fn from(e: std::io::Error) -> Self {
        PylonError::Io(e.to_string())
    }
}

impl From<serde_json::Error> for PylonError {
    fn from(e: serde_json::Error) -> Self {
        PylonError::Serialize(e.to_string())
    }
}

impl From<tokio::sync::oneshot::error::RecvError> for PylonError {
    fn from(_: tokio::sync::oneshot::error::RecvError) -> Self {
        PylonError::Protocol("ACP connection closed".into())
    }
}

impl From<tokio::sync::broadcast::error::RecvError> for PylonError {
    fn from(e: tokio::sync::broadcast::error::RecvError) -> Self {
        PylonError::Protocol(format!("broadcast: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_dto_serializes_code_and_message() {
        let error = PylonError::SessionNotFound("source-a".to_string());
        let value = serde_json::to_value(&error).expect("serialize DTO");
        assert_eq!(value["code"], "session_not_found");
        assert_eq!(value["message"], "session not found: source-a");

        let truncated = serde_json::to_value(PylonError::ReplayTruncated { dropped_count: 3 })
            .expect("serialize replay error DTO");
        assert_eq!(truncated["code"], "replay_truncated");
        assert!(truncated["message"]
            .as_str()
            .is_some_and(|message| message.contains('3')));
    }

    #[test]
    fn error_codes_are_stable_and_machine_readable() {
        assert_eq!(PylonError::Acp("x".into()).code(), "acp_error");
        assert_eq!(PylonError::AgentCrashed.code(), "agent_crashed");
        assert_eq!(PylonError::NoActiveAgent.code(), "no_active_agent");
        assert_eq!(PylonError::Serialize("x".into()).code(), "serialize_error");
        assert_eq!(PylonError::Io("x".into()).code(), "io_error");
        assert_eq!(PylonError::Protocol("x".into()).code(), "protocol_error");
        assert_eq!(
            PylonError::CanonicalEvent(crate::session::EventError::Unavailable("x".into())).code(),
            "event_db_unavailable"
        );
        assert_eq!(
            PylonError::MessagePersistence(crate::session::MessageError::Conflict("x".into()))
                .code(),
            "message_repo_conflict"
        );
        assert_eq!(
            PylonError::DatabaseFutureSchema {
                found: 11,
                supported: 10,
            }
            .code(),
            "database_future_schema"
        );
        assert_eq!(
            PylonError::DatabaseSchemaInvalid("x".into()).code(),
            "database_schema_invalid"
        );
        assert_eq!(
            PylonError::DatabaseIntegrity("x".into()).code(),
            "database_integrity_failed"
        );
        assert_eq!(
            PylonError::ReplayTruncated { dropped_count: 3 }.code(),
            "replay_truncated"
        );
        assert_eq!(PylonError::Workspace("x".into()).code(), "workspace_error");
        assert_eq!(PylonError::Prism("x".into()).code(), "prism_error");
        assert_eq!(PylonError::Git("x".into()).code(), "git_error");
        assert_eq!(
            PylonError::Gateway(crate::gateway::GatewayError::ConfigLockPoisoned).code(),
            "gateway_config_lock_poisoned"
        );
        assert_eq!(
            PylonError::RevisionConflict {
                expected: 3,
                actual: 1
            }
            .code(),
            "retention_revision_conflict"
        );
        assert_eq!(
            PylonError::StalePreview {
                expected: 2,
                actual: 3
            }
            .code(),
            "retention_stale_preview"
        );
        assert_eq!(
            PylonError::Config(crate::agent_config::ConfigError::Parse("x".into())).code(),
            "config_parse_error"
        );
    }

    #[test]
    fn string_converts_to_protocol_error_preserving_message() {
        let error = PylonError::from("custom failure".to_string());
        assert_eq!(error.code(), "protocol_error");
        assert_eq!(error.to_string(), "ACP protocol: custom failure");
    }
}
