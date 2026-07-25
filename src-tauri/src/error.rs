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
