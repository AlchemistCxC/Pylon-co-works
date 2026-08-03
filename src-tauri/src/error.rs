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
    #[error("no active agent configured")]
    NoActiveAgent,
    #[error("serialization error: {0}")]
    Serialize(String),
    #[error("I/O error: {0}")]
    Io(String),
    #[error("ACP protocol: {0}")]
    Protocol(String),
    #[error("{0}")]
    Workspace(String),
    #[error("Prism error: {0}")]
    Prism(String),
    /// B5：Git 只读操作错误（非 git 仓库 / git 不可用 / 命令失败）。
    #[error("Git error: {0}")]
    Git(String),
}

impl PylonError {
    /// 机器可读错误码（前端分支依据；稳定，不改拼写）。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Acp(_) => "acp_error",
            Self::AgentCrashed => "agent_crashed",
            Self::SessionNotFound(_) => "session_not_found",
            Self::NoActiveAgent => "no_active_agent",
            Self::Serialize(_) => "serialize_error",
            Self::Io(_) => "io_error",
            Self::Protocol(_) => "protocol_error",
            Self::Workspace(_) => "workspace_error",
            Self::Prism(_) => "prism_error",
            Self::Git(_) => "git_error",
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
    }

    #[test]
    fn error_codes_are_stable_and_machine_readable() {
        assert_eq!(PylonError::Acp("x".into()).code(), "acp_error");
        assert_eq!(PylonError::AgentCrashed.code(), "agent_crashed");
        assert_eq!(PylonError::NoActiveAgent.code(), "no_active_agent");
        assert_eq!(PylonError::Serialize("x".into()).code(), "serialize_error");
        assert_eq!(PylonError::Io("x".into()).code(), "io_error");
        assert_eq!(PylonError::Protocol("x".into()).code(), "protocol_error");
        assert_eq!(PylonError::Workspace("x".into()).code(), "workspace_error");
        assert_eq!(PylonError::Prism("x".into()).code(), "prism_error");
        assert_eq!(PylonError::Git("x".into()).code(), "git_error");
    }

    #[test]
    fn string_converts_to_protocol_error_preserving_message() {
        let error = PylonError::from("custom failure".to_string());
        assert_eq!(error.code(), "protocol_error");
        assert_eq!(error.to_string(), "ACP protocol: custom failure");
    }
}
