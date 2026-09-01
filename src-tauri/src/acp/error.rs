
// ── Constants ──

/// JSON-RPC method names used by the ACP protocol.
// 方法名统一来自官方 schema v1 的 AGENT_METHOD_NAMES（消除手写字符串常量）。
use agent_client_protocol_schema::v1::{AGENT_METHOD_NAMES, CLIENT_METHOD_NAMES};

pub const METHOD_INITIALIZE: &str = AGENT_METHOD_NAMES.initialize;
pub const METHOD_SESSION_NEW: &str = AGENT_METHOD_NAMES.session_new;
pub const METHOD_SESSION_PROMPT: &str = AGENT_METHOD_NAMES.session_prompt;
pub const METHOD_SESSION_CLOSE: &str = AGENT_METHOD_NAMES.session_close;
pub const METHOD_SESSION_LOAD: &str = AGENT_METHOD_NAMES.session_load;
pub const METHOD_SESSION_LIST: &str = AGENT_METHOD_NAMES.session_list;
pub const METHOD_SESSION_SET_MODE: &str = AGENT_METHOD_NAMES.session_set_mode;
pub const METHOD_SESSION_SET_CONFIG_OPTION: &str = AGENT_METHOD_NAMES.session_set_config_option;
pub const METHOD_SESSION_CANCEL: &str = AGENT_METHOD_NAMES.session_cancel;
/// 客户端侧方法（B9）：agent 发起工具审批请求，客户端应答。
/// Peri（agent）实证：需要批准时主动发带 id 的 request_permission 请求，
/// 客户端以 RequestPermissionResponse（outcome）应答。
pub const METHOD_SESSION_REQUEST_PERMISSION: &str = CLIENT_METHOD_NAMES.session_request_permission;
/// Hermes unstable 扩展：session/set_model（官方 Rust schema 1.4 尚无此类型，
/// Hermes Python 0.11.2 已实现——切 model 必须走它，set_config_option 对 Hermes 不生效）。
pub const METHOD_SESSION_SET_MODEL: &str = "session/set_model";
/// session/update 通知名官方为 pub(crate)，保留本地常量。
pub const NOTIF_SESSION_UPDATE: &str = "session/update";
/// G3 Step 8a（4.2）：进程内崩溃伪通知常量迁移——事件名唯一来源收口到
/// event_names 常量表，本名保持既有引用（dispatcher/reader/测试）零改动。
pub use crate::event_names::AGENT_CRASHED as NOTIF_AGENT_CRASHED;

// ── 操作层错误类型（R6e：中间层 Result<_, String> 类型化）──
//
// ACP 客户端操作层（RPC/连接/子进程）错误统一为 AcpError：调用方可按变体分支
// （ConnectionClosed 不重试 / RpcTimeout 可重试等），Display 文案与旧 String 逐字一致
// （wire 消息不变）。参数构造器/附件校验仍返回 String（纯序列化，低价值不类型化）。
// 边界经 From<AcpError> for PylonError 折回 protocol_error（wire code 不变）。

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentConnectStage {
    Preflight,
    Spawn,
    Initialize,
    Capability,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentConnectFailure {
    pub stage: AgentConnectStage,
    pub code: String,
    pub message: String,
    pub exit_code: Option<i32>,
    pub stderr_excerpt: Option<String>,
    pub retryable: bool,
    pub io_kind: Option<String>,
    pub remote_code: Option<i64>,
    pub remote_data_summary: Option<String>,
}

impl AgentConnectFailure {
    pub(crate) fn new(stage: AgentConnectStage, code: &str, message: String, retryable: bool) -> Self {
        Self {
            stage,
            code: code.to_string(),
            message,
            exit_code: None,
            stderr_excerpt: None,
            retryable,
            io_kind: None,
            remote_code: None,
            remote_data_summary: None,
        }
    }

    pub(crate) fn preflight(code: &str, message: String) -> Self {
        Self::new(AgentConnectStage::Preflight, code, message, false)
    }

    pub(crate) fn spawn(executable: &str, error: std::io::Error) -> Self {
        let retryable = matches!(
            error.kind(),
            std::io::ErrorKind::Interrupted
                | std::io::ErrorKind::WouldBlock
                | std::io::ErrorKind::TimedOut
        );
        let mut failure = Self::new(
            AgentConnectStage::Spawn,
            "agent_spawn_failed",
            format!("spawn {executable} failed: {error}"),
            retryable,
        );
        failure.io_kind = Some(format!("{:?}", error.kind()));
        failure
    }

    pub(crate) fn spawn_setup(message: String) -> Self {
        Self::new(
            AgentConnectStage::Spawn,
            "agent_spawn_io_failed",
            message,
            false,
        )
    }

    pub(crate) fn initialize(error: AcpError, exit_code: Option<i32>) -> Self {
        let retryable = matches!(
            &error,
            AcpError::ConnectionClosed
                | AcpError::WriteTimeout
                | AcpError::RpcTimeout
                | AcpError::Child(_)
        );
        let mut failure = Self::new(
            AgentConnectStage::Initialize,
            match &error {
                AcpError::WriteTimeout | AcpError::RpcTimeout => "agent_connection_timeout",
                _ => "agent_initialize_failed",
            },
            error.to_string(),
            retryable,
        );
        failure.exit_code = exit_code;
        if let AcpError::Rpc(raw) = &error {
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
                failure.remote_code = value.get("code").and_then(serde_json::Value::as_i64);
                if let Some(message) = value.get("message").and_then(serde_json::Value::as_str) {
                    failure.message = format!(
                        "initialize RPC error{}: {}",
                        failure
                            .remote_code
                            .map(|code| format!(" {code}"))
                            .unwrap_or_default(),
                        message.chars().take(512).collect::<String>()
                    );
                }
                failure.remote_data_summary = value.get("data").map(|data| match data {
                    serde_json::Value::Null => "null".to_string(),
                    serde_json::Value::Bool(_) => "boolean".to_string(),
                    serde_json::Value::Number(_) => "number".to_string(),
                    serde_json::Value::String(value) => {
                        format!("string({} chars)", value.chars().count())
                    }
                    serde_json::Value::Array(value) => format!("array({} items)", value.len()),
                    serde_json::Value::Object(value) => format!("object({} keys)", value.len()),
                });
            }
        }
        failure
    }

    pub(crate) fn capability(message: String) -> Self {
        Self::new(
            AgentConnectStage::Capability,
            "agent_capability_invalid",
            message,
            false,
        )
    }
}

impl std::fmt::Display for AgentConnectFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum AcpError {
    #[error("ACP connection closed")]
    ConnectionClosed,
    /// 写通道超时（旧 send_line 返回文案，勿改拼写）。
    #[error("ACP write timeout")]
    WriteTimeout,
    #[error("RPC timeout after 30s")]
    RpcTimeout,
    /// `session/load` did not observe its response boundary before the
    /// absolute replay deadline.  This stays distinct from a generic child
    /// transport error so replay traces can preserve the failure class.
    #[error("session/load replay timed out after {seconds}s")]
    ReplayTimeout { seconds: u64 },
    /// The replay observer fell behind the bounded broadcast channel.  The
    /// dropped count is retained for diagnostics while the error code remains
    /// stable for callers.
    #[error("session/load replay lagged by {count} messages")]
    ReplayLagged { count: u64 },
    /// The replay observer's notification stream closed before a response
    /// boundary was observed.
    #[error("ACP notification stream closed during session/load")]
    ReplayStreamClosed,
    /// A replay load for the same remote session is already active.
    #[error("replay_load_in_progress")]
    ReplayLoadInProgress,
    #[error("RPC error: {0}")]
    Rpc(String),
    /// AgentConnectFailure 字段多（String×5），Box 化把 AcpError/Result 体积压回
    /// 小于 128B（clippy result_large_err）——RPC 准备等热路径不再搬运大 Err。
    #[error("{0}")]
    Connect(Box<AgentConnectFailure>),
    /// 其余操作错误（spawn/kill/序列化/参数/传输等）——Display 为原样消息。
    #[error("{0}")]
    Child(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RpcFailureKind {
    SessionMissing,
    MethodMissing,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RpcFailureDetails {
    pub(crate) code: Option<i64>,
    pub(crate) message: String,
    pub(crate) kind: RpcFailureKind,
}

impl AcpError {
    pub(crate) fn rpc_failure_details(&self) -> Option<RpcFailureDetails> {
        let Self::Rpc(raw) = self else {
            return None;
        };
        let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
        let code = value.get("code").and_then(serde_json::Value::as_i64);
        let message = value
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("remote RPC error")
            .chars()
            .take(512)
            .collect::<String>();
        let normalized_message = message.to_ascii_lowercase();
        let data_marker = value
            .get("data")
            .and_then(serde_json::Value::as_object)
            .and_then(|data| {
                ["code", "kind", "type"]
                    .into_iter()
                    .find_map(|field| data.get(field).and_then(serde_json::Value::as_str))
            })
            .map(|marker| marker.to_ascii_lowercase());
        let kind = if code == Some(-32601) {
            RpcFailureKind::MethodMissing
        } else if data_marker.as_deref().is_some_and(|marker| {
            matches!(
                marker,
                "session_missing" | "session_not_found" | "unknown_session"
            )
        }) || (normalized_message.contains("session")
            && [
                "not found",
                "does not exist",
                "unknown",
                "missing",
                "invalid",
            ]
            .into_iter()
            .any(|term| normalized_message.contains(term)))
        {
            RpcFailureKind::SessionMissing
        } else {
            RpcFailureKind::Other
        };
        Some(RpcFailureDetails {
            code,
            message,
            kind,
        })
    }

    pub(crate) fn rpc_failure_kind(&self) -> Option<RpcFailureKind> {
        self.rpc_failure_details().map(|details| details.kind)
    }

    pub(crate) fn is_retryable_transport_failure(&self) -> bool {
        matches!(
            self,
            Self::ConnectionClosed
                | Self::WriteTimeout
                | Self::RpcTimeout
                | Self::ReplayTimeout { .. }
                | Self::ReplayLagged { .. }
                | Self::ReplayStreamClosed
                | Self::Child(_)
        )
    }
}

impl From<String> for AcpError {
    fn from(message: String) -> Self {
        Self::Child(message)
    }
}

impl From<AgentConnectFailure> for AcpError {
    fn from(failure: AgentConnectFailure) -> Self {
        Self::Connect(Box::new(failure))
    }
}

impl From<AcpError> for String {
    fn from(error: AcpError) -> Self {
        error.to_string()
    }
}

impl From<AcpError> for crate::error::PylonError {
    fn from(error: AcpError) -> Self {
        if matches!(&error, AcpError::ReplayLoadInProgress) {
            return crate::error::PylonError::ReplayLoadInProgress;
        }
        // R6e：保持既有 wire 语义——ACP 操作错误折叠为 protocol_error（code 不变）。
        crate::error::PylonError::Protocol(error.to_string())
    }
}

impl AcpError {
    /// H14 类型化：close 降级判定（session.rs:1619 错误串 contains 的声明式替代，
    /// G2-03 消费点）。JSON-RPC error 信封的 `code` 字段解析优先（-32601 =
    /// MethodNotFound），字符串兜底（"-32601" / "Method not found"，保留现状
    /// 大小写敏感语义）。
    /// G2（W2 链 E）消费：`if error.is_method_not_found() { 降级本地清理 }`。
    pub fn is_method_not_found(&self) -> bool {
        let AcpError::Rpc(message) = self else {
            return false;
        };
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(message) {
            if value.get("code").and_then(|code| code.as_i64()) == Some(-32601) {
                return true;
            }
            let text = value.to_string();
            return text.contains("-32601") || text.contains("Method not found");
        }
        message.contains("-32601") || message.contains("Method not found")
    }
}

// ── 差异适配表（agent 协议差异，字典驱动）──
//
// 已知差异（2026-07-31 三方源码实证 + Hermes 0.18.2 真实 wire 验证）：
// | 差异点            | Peri (schema 1.4)              | Hermes (0.11.2 / 0.18.2)    |
// |-------------------|--------------------------------|-----------------------------|
// | 能力声明          | clientCapabilities._meta.peri.*| 标准 agentCapabilities，    |
// |                   |                                | 不校验客户端 caps（忽略）    |
// | 切 model          | set_config_option("model")     | session/set_model（unstable）|
// |                   |                                | set_config_option 不生效    |
// | session/close     | 支持                           | 0.18.2 实测支持（旧版 -32601）|
// | mcpServers        | 容忍缺失/空                    | 必填 List（缺字段即拒）      |
// | set_config_option | ValueId 平铺（untagged）       | Select 型平铺（兼容）        |
// | set_mode          | modeId                         | modeId                      |
// 结论：wire 分叉仅切 model 途径。initialize 统一带 _meta.peri.*（Hermes 忽略
// 无害）；close 降级保留为防御兜底（旧 Hermes 版本无此方法）。

/// G1-05：DEFAULT_* 前缀统一；值不变。超时访问器（prompt_timeout/
/// cancel_settle_timeout）在 AcpProtocolConfig（agent_config.rs），
/// DEFAULT_* 为"无声明=现状"默认值的唯一事实源。
pub const DEFAULT_PROMPT_TIMEOUT_SECS: u64 = 300;
/// Maximum time to wait for Peri's final prompt response after sending cancel.
pub const DEFAULT_CANCEL_SETTLE_TIMEOUT_SECS: u64 = 30;
/// Maximum size for a single attachment.
pub const DEFAULT_MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;
/// Maximum number of attachments in one prompt.
pub const DEFAULT_MAX_ATTACHMENTS: usize = 8;

