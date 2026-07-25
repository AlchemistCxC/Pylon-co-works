//! Structured error types for Pylon backend.

use serde::Serialize;
use std::fmt;

#[derive(Debug)]
pub enum PylonError {
    Acp(String),
    AgentCrashed,
    SessionNotFound(String),
    NoActiveAgent,
    UnknownAgent(String),
    Timeout(u64),
    Serialize(String),
    Io(String),
    Protocol(String),
}

impl fmt::Display for PylonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Acp(msg) => write!(f, "ACP error: {msg}"),
            Self::AgentCrashed => write!(f, "agent process crashed"),
            Self::SessionNotFound(id) => write!(f, "session not found: {id}"),
            Self::NoActiveAgent => write!(f, "no active agent configured"),
            Self::UnknownAgent(name) => write!(f, "unknown agent: {name}"),
            Self::Timeout(s) => write!(f, "timeout after {s}s"),
            Self::Serialize(msg) => write!(f, "serialization error: {msg}"),
            Self::Io(msg) => write!(f, "I/O error: {msg}"),
            Self::Protocol(msg) => write!(f, "ACP protocol: {msg}"),
        }
    }
}

impl std::error::Error for PylonError {}

impl Serialize for PylonError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<PylonError> for String {
    fn from(e: PylonError) -> String {
        e.to_string()
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
