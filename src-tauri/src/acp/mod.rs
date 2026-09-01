//! ACP Client — spawn peri.exe as child process, JSON-RPC over stdin/stdout.
//!
//! Architecture: one dedicated reader thread dispatches messages by request_id
//! to per-session channels. No lock contention between concurrent sessions.
//! stderr is drained in a background thread to prevent pipe buffer deadlock.


mod error;
mod client;
pub use error::*;
pub use client::*;

#[cfg(test)]
mod tests;


mod process;
pub(crate) use process::ManagedChild;
mod jsonrpc;
mod protocol;
mod replay;
pub(crate) mod request_id;
pub(crate) use request_id::RequestId;
mod transport;
pub(crate) mod wire_trace;
#[cfg(test)]
pub(crate) use jsonrpc::drain_pending;
#[cfg(test)]
pub(crate) use jsonrpc::wait_prompt_with_cancel;
pub(crate) use jsonrpc::{
    remove_pending_from, wait_prompt_with_recovery, Pending, PreparedRpc, PromptWaitOutcome,
    PENDING_SHARDS,
};
#[cfg(test)]
pub(crate) use protocol::load_params;
pub(crate) use protocol::{
    prompt_blocks, prompt_stop_reason, session_id_from, session_prompt_params,
};
pub use protocol::{
    session_close_params, session_new_params, session_set_config_option_params,
    session_set_mode_params, session_set_model_params, SessionUpdateVariant,
};
pub use replay::ReplayHandles;
pub(crate) use replay::{load_session_with_replay, ReplayMetadata};
pub(crate) use transport::{
    send_line, spawn_stderr_reader, spawn_stdout_reader, spawn_writer_task, CrashReason,
};
pub use transport::{
    BROADCAST_CAP, DEFAULT_WRITE_TIMEOUT_SECS, NOTIFICATION_CHAN_CAP, WRITE_CHAN_CAP,
};
#[cfg_attr(not(test), allow(unused_imports))] // Wire* 类型仅测试消费（obs03/p1_wire 回归测试）
pub(crate) use wire_trace::{AcpWireHub, WireDirection, WireIdKind, WireRecord};
