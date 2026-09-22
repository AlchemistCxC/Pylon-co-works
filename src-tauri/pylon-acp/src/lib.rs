//! ACP Client — spawn peri.exe as child process, JSON-RPC over stdin/stdout.
//!
//! Architecture: one dedicated reader thread dispatches messages by request_id
//! to per-session channels. No lock contention between concurrent sessions.
//! stderr is drained in a background thread to prevent pipe buffer deadlock.

pub mod adapter;
mod capabilities;
mod client;
mod engine;
mod error;
pub mod file_system_runtime;
pub mod fs_policy;
pub mod host_tools;
mod launch_plan;
pub use launch_plan::plan_for_agent;
pub mod cause;
pub mod initialize_plan;
pub mod interaction_queue;
pub mod negotiated;
pub mod runtime_sink;
#[allow(unused_imports)] // CapabilityFact 供测试/诊断按路径引用，主链路暂未直用
pub use negotiated::{CapabilityConsumer, CapabilityFact, NegotiatedCapabilitySnapshot};
pub mod plan_policy;
pub mod question_policy;
pub mod terminal_policy;
pub mod terminal_runtime;
pub use capabilities::CapabilityRegistry;
pub use client::*;
pub use error::*;

// #245：原 crate 根的两个 ACP 相关测试模块就近归入（模块 basename 保持不变，
// `cargo test --lib p1_wire` / `real_acp` 等既有 filter 命令继续有效）。

mod process;
pub use process::ManagedChild;
mod protocol;
mod replay;
pub use engine::RequestId;
pub mod stderr;
mod stderr_tail;
pub use stderr_tail::StderrTail;
mod state;
pub use state::{AcpSessionState, AcpStateDelta};
pub mod turn_ledger;
pub use turn_ledger::{
    empty_turn_cause, terminal_cause_from_prompt_result, BeginOutcome, SettleOutcome, TurnKey,
    TurnLedger, TurnTerminalCause,
};
pub mod wire_trace;
pub use engine::{
    wait_prompt_with_recovery, CancelSettleResolution, PreparedRpc, PromptTimeoutKind,
    PromptWaitOutcome,
};
pub use engine::{CrashReason, BROADCAST_CAP, DEFAULT_WRITE_TIMEOUT_SECS, NOTIFICATION_CHAN_CAP};
pub use protocol::{
    load_params, prompt_blocks, prompt_stop_reason, resume_capability_advertised, resume_params,
    session_id_from, session_prompt_params,
};
pub use protocol::{
    session_close_params, session_new_params, session_set_config_option_params,
    session_set_mode_params, session_set_model_params, SessionUpdateVariant,
};
pub use replay::{load_session_with_replay, ReplayMetadata};
pub use stderr::spawn_stderr_reader;
pub use wire_trace::AcpWireHub;
#[cfg_attr(not(test), allow(unused_imports))] // Wire* 类型仅测试消费（obs03/p1_wire 回归测试）
pub use wire_trace::{AcpWireCapture, CanonicalCorrelation, WireDirection, WireIdKind, WireRecord};
