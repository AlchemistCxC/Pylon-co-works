//! ACP Client — spawn peri.exe as child process, JSON-RPC over stdin/stdout.
//!
//! Architecture: one dedicated reader thread dispatches messages by request_id
//! to per-session channels. No lock contention between concurrent sessions.
//! stderr is drained in a background thread to prevent pipe buffer deadlock.

#[cfg(test)]
use crate::agent_config::McpServersMode;
use std::collections::HashMap;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

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
    fn new(stage: AgentConnectStage, code: &str, message: String, retryable: bool) -> Self {
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

    fn preflight(code: &str, message: String) -> Self {
        Self::new(AgentConnectStage::Preflight, code, message, false)
    }

    fn spawn(executable: &str, error: std::io::Error) -> Self {
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

    fn spawn_setup(message: String) -> Self {
        Self::new(
            AgentConnectStage::Spawn,
            "agent_spawn_io_failed",
            message,
            false,
        )
    }

    fn initialize(error: AcpError, exit_code: Option<i32>) -> Self {
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

    fn capability(message: String) -> Self {
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
    #[error("RPC error: {0}")]
    Rpc(String),
    #[error("{0}")]
    Connect(AgentConnectFailure),
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
            Self::ConnectionClosed | Self::WriteTimeout | Self::RpcTimeout | Self::Child(_)
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
        Self::Connect(failure)
    }
}

impl From<AcpError> for String {
    fn from(error: AcpError) -> Self {
        error.to_string()
    }
}

impl From<AcpError> for crate::error::PylonError {
    fn from(error: AcpError) -> Self {
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
pub(crate) use jsonrpc::{
    remove_pending_from, wait_prompt_with_cancel, Pending, PreparedRpc, PromptWaitOutcome,
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

pub struct AcpClient {
    child: ManagedChild,
    /// G1-02：per-agent 协议行为配置（connect_with_logs 从 agent.protocol() clone；
    /// disconnected() 用默认实例）。超时/限额/握手参数唯一读取点。
    protocol: crate::agent_config::AcpProtocolConfig,
    /// P1（能力协商暴露）：initialize 握手返回的 agentCapabilities（原始 Value，
    /// 含 loadSession/promptCapabilities/sessionCapabilities/mcpCapabilities 及
    /// _meta 私有扩展）。连接成功才有；断开/未连接为 None。客户端替换时随新
    /// AcpClient 自然更新（generation 隔离保证旧客户端不污染）。
    agent_capabilities: Option<serde_json::Value>,
    /// mpsc channel for writing JSON-RPC lines to stdin. Single consumer = no lock contention.
    pub(crate) write_tx: mpsc::Sender<String>,
    /// R4：writer tokio 任务句柄——kill/替换 agent 时 abort 掉可能阻塞在 stdin
    /// 写入的旧任务（`disconnected()` 无运行时，为 None）。
    writer_task: Option<tokio::task::JoinHandle<()>>,
    next_id: Arc<AtomicU64>,
    pending: Arc<[Mutex<Pending>; PENDING_SHARDS]>,
    /// Broadcast channel for all received messages (responses + notifications).
    pub rx: broadcast::Receiver<RawMessage>,
    /// Lossless, single-consumer notification inbox for the Kernel dispatcher.
    /// The broadcast receiver remains a replay/observation fan-out and is not a
    /// durable-ingest source.
    notification_inbox: NotificationInbox,
    /// Remote session ids whose `session/load` response boundary has not been observed yet.
    /// The stdout reader uses this to classify replay before queueing notifications.
    active_replay_requests: Arc<Mutex<HashMap<u64, String>>>,
    /// Set when the child process exits unexpectedly.
    pub crashed: Arc<AtomicBool>,
    /// A7：EOF 崩溃信号独立 watch 通道（保留最新值，broadcast 洪泛 Lagged 丢消息
    /// 时 NOTIF_AGENT_CRASHED 可能丢失，本通道是自动重连的可靠信号源）。
    /// reader 线程 EOF 时 `send(true)`；dispatcher 经 [`Self::crashed_receiver`] 订阅。
    crashed_watch: watch::Sender<bool>,
    /// 保持通道开放的兜底接收端：reader 线程在外部订阅之前崩溃时，`send` 不会因
    /// "无接收者"失败——订阅方经 `has_changed`/`borrow` 仍能读到 true。
    _crashed_watch_rx: watch::Receiver<bool>,
    /// OBS-01：本连接的 ACP wire 只读记录器（transport 边界，infallible）。
    /// 断开态为 None；连接后始终存在（容量上限 ring buffer，可 set_enabled 关闭）。
    wire_trace: Option<Arc<AcpWireHub>>,
}

/// Cloneable handle to the connection's single-consumer Kernel notification stream.
/// Receiver ownership and locking stay inside ACP; callers only learn ordered recv.
#[derive(Clone)]
pub(crate) struct NotificationInbox {
    rx: Arc<tokio::sync::Mutex<mpsc::Receiver<RawMessage>>>,
}

impl NotificationInbox {
    fn new(rx: mpsc::Receiver<RawMessage>) -> Self {
        Self {
            rx: Arc::new(tokio::sync::Mutex::new(rx)),
        }
    }

    pub(crate) async fn recv(&self) -> Option<RawMessage> {
        self.rx.lock().await.recv().await
    }
}
/// B1：消息类型化分类（reader 一次分类，dispatcher 枚举匹配——method 拼写错误
/// 编译期拦截；未知 method 归 OtherNotification，行为与旧 `_ => {}` 忽略一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpKind {
    /// 带 id 的 JSON-RPC 响应（method 为 None）。
    Response,
    /// session/update 通知（dispatcher 主通道）。
    SessionUpdate,
    /// session/request_permission 请求（B9 权限审批）。
    PermissionRequest,
    /// pylon:agent-crashed 崩溃广播。
    Crashed,
    /// 其他通知（透传忽略，dispatcher 不处理）。
    OtherNotification,
}

impl AcpKind {
    pub fn from_method(method: Option<&str>) -> Self {
        match method {
            None => Self::Response,
            Some(NOTIF_AGENT_CRASHED) => Self::Crashed,
            Some(METHOD_SESSION_REQUEST_PERMISSION) => Self::PermissionRequest,
            Some(NOTIF_SESSION_UPDATE) => Self::SessionUpdate,
            Some(_) => Self::OtherNotification,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RawMessage {
    /// ACP-01：JSON-RPC id 原始形态（number/string）——response 必须用原 variant
    /// 回写；null/absent → None（不静默当 0）。Pylon outbound 自生成 id 恒为
    /// `RequestId::Number`（见 jsonrpc.rs Pending）。
    pub id: Option<RequestId>,
    pub method: Option<String>,
    pub kind: AcpKind,
    pub result: Option<serde_json::Value>,
    pub params: Option<serde_json::Value>,
    pub error: Option<serde_json::Value>,
}

/// 一次 RPC 的同步准备阶段产物：id（用于清理 pending）、序列化行、写通道、响应接收器。
/// 携带 pending 分片引用——锁外发送/等待/清理不需要再持有 AcpClient。
impl AcpClient {
    pub fn disconnected() -> Self {
        let (write_tx, write_rx) = mpsc::channel(1);
        drop(write_rx);
        let (_tx, rx) = broadcast::channel(BROADCAST_CAP);
        let (_notification_tx, notification_rx) = mpsc::channel(NOTIFICATION_CHAN_CAP);
        let (crashed_watch, crashed_watch_rx) = watch::channel(false);
        Self {
            child: ManagedChild::empty(),
            protocol: crate::agent_config::AcpProtocolConfig::default(),
            agent_capabilities: None,
            write_tx,
            writer_task: None,
            next_id: Arc::new(AtomicU64::new(1)),
            pending: Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new()))),
            rx,
            notification_inbox: NotificationInbox::new(notification_rx),
            active_replay_requests: Arc::new(Mutex::new(HashMap::new())),
            crashed: Arc::new(AtomicBool::new(false)),
            crashed_watch,
            _crashed_watch_rx: crashed_watch_rx,
            wire_trace: None,
        }
    }

    pub fn remove_pending(&self, id: u64) {
        remove_pending_from(&self.pending, id);
    }

    fn pending_shard(&self, id: u64) -> &Mutex<Pending> {
        &self.pending[id as usize % PENDING_SHARDS]
    }
    /// 分配 id + 构造 json! 信封 + 序列化（O3：与 register_request 共享，
    /// 供锁外回放路径复用——该路径无需注册 pending）。
    fn register_line(
        next_id: &AtomicU64,
        method: &str,
        params: &serde_json::Value,
    ) -> Result<(u64, String), AcpError> {
        let id = next_id.fetch_add(1, Ordering::Relaxed);
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&req)
            .map_err(|e| AcpError::Child(format!("serialize failed: {e}")))?;
        Ok((id, line))
    }
    /// 公共 RPC 请求准备：分配 id → 注册 pending（`pending_tx` 为 None 表示不需要
    /// pending 响应，如 session/load 回放经 broadcast 收集）→ 构造 json! 信封 →
    /// 序列化。返回 (id, 序列化行)。任何失败（锁中毒/序列化）时清理已注册的
    /// pending，不留悬挂条目。
    fn register_request(
        &self,
        method: &str,
        params: &serde_json::Value,
        pending_tx: Option<oneshot::Sender<RawMessage>>,
    ) -> Result<(u64, String), AcpError> {
        let (id, line) = Self::register_line(&self.next_id, method, params)?;
        if let Some(tx) = pending_tx {
            let mut pending = self.pending_shard(id).lock().map_err(|e| e.to_string())?;
            pending.insert(id, tx);
        }
        Ok((id, line))
    }

    /// Send a JSON-RPC request and wait for the matching response.
    /// 同步准备一次 JSON-RPC 请求（注册 pending + 序列化），不写入 stdin。
    /// 调用方持锁只覆盖本方法；发送与等待经 [`PreparedRpc::complete`] 在锁外进行，
    /// 避免 Peri 卡顿时全局串行化（一个慢 RPC 阻塞所有其他命令）。
    pub fn prepare_rpc(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<PreparedRpc, AcpError> {
        if self.is_crashed() {
            return Err(AcpError::ConnectionClosed);
        }
        let (tx, rx) = oneshot::channel();
        let (id, line) = self.register_request(method, &params, Some(tx))?;
        Ok(PreparedRpc {
            id,
            line,
            write_tx: self.write_tx.clone(),
            rx,
            pending: self.pending.clone(),
            crashed: self.crashed.clone(),
            rpc_timeout: std::time::Duration::from_secs(self.protocol.rpc_timeout()),
        })
    }

    async fn call_async(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, AcpError> {
        self.prepare_rpc(method, params)?.complete().await
    }

    /// Prepare a prompt request without writing to stdin.
    /// R3：与 [`Self::prepare_rpc`] 统一返回 [`PreparedRpc`]——发送经 `send_keep_rx`
    /// （含 10s 写超时与失败路径 pending 清理），等待经 [`wait_prompt_with_cancel`]。
    pub fn prepare_prompt(
        &self,
        session_id: &str,
        prompt: Vec<serde_json::Value>,
    ) -> Result<PreparedRpc, AcpError> {
        // 审查修复：与 prepare_rpc 一致，死亡连接立即拒绝（否则挂满 300s 假超时）
        if self.is_crashed() {
            return Err(AcpError::ConnectionClosed);
        }
        // 先构造参数（可能因 block 格式失败），成功后再注册 pending，避免泄漏。
        let params = session_prompt_params(session_id, prompt)?;
        let (tx, rx) = oneshot::channel();
        let (id, line) = self.register_request(METHOD_SESSION_PROMPT, &params, Some(tx))?;
        Ok(PreparedRpc {
            id,
            line,
            write_tx: self.write_tx.clone(),
            rx,
            pending: self.pending.clone(),
            crashed: self.crashed.clone(),
            rpc_timeout: std::time::Duration::from_secs(self.protocol.rpc_timeout()),
        })
    }

    /// Kill the child process. Called before switching agents to prevent orphans.
    /// R4：同时 abort writer 任务——替换时旧 writer 可能正阻塞在 stdin 写（agent
    /// 不读 stdin，管道填满），任务随后在子进程终止、写失败后自行结束。
    pub fn kill(&mut self) -> Result<(), AcpError> {
        if let Some(task) = self.writer_task.take() {
            task.abort();
        }
        self.child.kill_and_wait()
    }

    /// Check if the child process has exited unexpectedly.
    pub fn is_crashed(&self) -> bool {
        self.crashed.load(Ordering::Relaxed)
    }

    /// P1：initialize 握手返回的 agentCapabilities（连接成功才有）。
    pub(crate) fn agent_capabilities(&self) -> Option<&serde_json::Value> {
        self.agent_capabilities.as_ref()
    }

    /// OBS-01：本连接的 ACP wire 只读记录器（断开态为 None）。
    pub fn wire_trace(&self) -> Option<Arc<AcpWireHub>> {
        self.wire_trace.clone()
    }

    /// A7：订阅崩溃信号（EOF 后为 true）。watch 保留最新值——订阅晚于崩溃时
    /// `has_changed`/`borrow` 仍能读到 true，不依赖时序。
    pub fn crashed_receiver(&self) -> watch::Receiver<bool> {
        self.crashed_watch.subscribe()
    }

    #[cfg(test)]
    pub(crate) fn child_id(&self) -> Option<u32> {
        self.child.pid()
    }

    /// Send a fire-and-forget notification (no id, no response expected).
    /// 仅被 [`Self::cancel_session`] 调用。
    async fn send_notification(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), AcpError> {
        if self.is_crashed() {
            return Err(AcpError::ConnectionClosed);
        }
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&req)
            .map_err(|e| AcpError::Child(format!("serialize failed: {e}")))?;
        send_line(self.write_tx.clone(), line, &self.crashed).await
    }

    /// 应答 agent 发来的 JSON-RPC 请求（B9：session/request_permission）。
    /// agent 侧 send_request 等待同 id 响应，不应答会挂起直到超时。
    /// G3 §4.2（8a）：生产已无调用方——dispatcher 直接应答与 permission::resolve_pending
    /// 均收敛为锁外 permission::send_agent_response（H-4/H-5）；唯一调用方是
    /// 本文件单测 send_response_writes_result_with_matching_id，标 cfg(test)。
    #[cfg(test)]
    pub async fn send_response(&self, id: u64, result: serde_json::Value) -> Result<(), AcpError> {
        if self.is_crashed() {
            return Err(AcpError::ConnectionClosed);
        }
        let line = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        });
        let line = serde_json::to_string(&line)
            .map_err(|e| AcpError::Child(format!("serialize failed: {e}")))?;
        send_line(self.write_tx.clone(), line, &self.crashed).await
    }

    /// Cancel a running prompt. Fire-and-forget notification.
    pub async fn cancel_session(&self, session_id: &str) -> Result<(), AcpError> {
        self.send_notification(
            METHOD_SESSION_CANCEL,
            serde_json::json!({
                "sessionId": session_id
            }),
        )
        .await
    }

    /// Connect from AgentDef with optional structured runtime log sink.
    /// OBS-02：client_generation 固定为 0（旧调用点/测试）。生产路径请用
    /// [`Self::connect_with_generation`] 传入连接所属真实代际。
    pub async fn connect_with_logs(
        agent: &crate::agent_config::AgentDef,
        runtime_logs: Option<Arc<crate::runtime_log::RuntimeLogHub>>,
    ) -> Result<Self, AcpError> {
        Self::connect_with_generation(agent, runtime_logs, 0).await
    }

    /// 连接 ACP 子进程并指定连接所属 client 代际（OBS-02 correlation）。
    /// generation 在 runtime replacement 时递增（lifecycle::do_connect_and_replace
    /// 传 `runtime.client_generation + 1`），wire trace 据此区分代际记录。
    pub(crate) async fn connect_with_generation(
        agent: &crate::agent_config::AgentDef,
        runtime_logs: Option<Arc<crate::runtime_log::RuntimeLogHub>>,
        client_generation: u64,
    ) -> Result<Self, AcpError> {
        let resolved_agent;
        let base_dir: Option<PathBuf> = crate::agent_config::effective_config_path()
            .and_then(|path| path.parent().map(Path::to_path_buf));
        let agent = if let Some(base_dir) = &base_dir {
            resolved_agent = agent.resolve_paths(base_dir);
            &resolved_agent
        } else {
            agent
        };
        match agent.transport.as_str() {
            "subprocess" => {
                // 部署易用性：exe 写成路径形态（含分隔符）时先做存在性预检，
                // 给出可行动的配置修改提示；裸命令名（PATH 查找）不做预检。
                if (agent.exe.contains('/') || agent.exe.contains('\\'))
                    && !std::path::Path::new(&agent.exe).is_file()
                {
                    return Err(AgentConnectFailure::preflight(
                        "agent_executable_missing",
                        format!(
                            "agent {} 的 exe 路径不存在：{}（请在 设置 → Agent 中修改 agents.yaml 配置）",
                            agent.name, agent.exe
                        ),
                    )
                    .into());
                }
                let mut cmd = Command::new(&agent.exe);
                cmd.args(agent.command_args())
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());
                if let Some(cwd) = &agent.cwd {
                    cmd.current_dir(cwd);
                }
                for (k, v) in &agent.env {
                    cmd.env(k, v);
                }
                // hermes_profile（方案 G 演进）：注入 HERMES_HOME=<profile 目录>，
                // 确保 Hermes 使用指定 profile 的 provider/密钥（见 hermes.rs doc）。
                if let Some(hermes_home) =
                    crate::hermes::hermes_home_override(agent, base_dir.as_deref())
                {
                    cmd.env("HERMES_HOME", &hermes_home);
                    tracing::info!(
                        "agent {}: HERMES_HOME set to {} (hermes_profile)",
                        agent.name,
                        hermes_home
                    );
                }
                let child = cmd
                    .spawn()
                    .map_err(|error| AgentConnectFailure::spawn(&agent.exe, error))?;
                let mut child = ManagedChild::new(child);

                let stdin = child
                    .take_stdin()
                    .map_err(|error| AgentConnectFailure::spawn_setup(error.to_string()))?;
                let (write_tx, write_rx) = mpsc::channel::<String>(WRITE_CHAN_CAP);
                let crashed = Arc::new(AtomicBool::new(false));
                let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
                    Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
                let (tx, rx) = broadcast::channel(BROADCAST_CAP);
                let (notification_tx, notification_rx) = mpsc::channel(NOTIFICATION_CHAN_CAP);
                let active_replay_requests = Arc::new(Mutex::new(HashMap::new()));
                let (crashed_watch, crashed_watch_rx) = watch::channel(false);
                // G1-05：三线程启动收敛为私有函数（S3 卫生，行为零变化）。
                // 方案 2A：writer 持有结算句柄（watch/pending/tx），写失败统一结算。
                // OBS-01：wire recorder 在 transport 边界记录（outbound writer / inbound reader）。
                // OBS-02：hub 以连接级 correlation context（含 clientGeneration）构造。
                let wire_trace = AcpWireHub::for_agent(agent, client_generation);
                let writer_task = spawn_writer_task(
                    stdin,
                    write_rx,
                    &crashed,
                    &crashed_watch,
                    &pending,
                    &tx,
                    notification_tx.clone(),
                    DEFAULT_WRITE_TIMEOUT_SECS,
                    Some(wire_trace.clone()),
                );
                let stdout = BufReader::new(
                    child
                        .take_stdout()
                        .map_err(|error| AgentConnectFailure::spawn_setup(error.to_string()))?,
                );

                // Drain stderr（防管道缓冲死锁）
                let stderr = child
                    .take_stderr()
                    .map_err(|error| AgentConnectFailure::spawn_setup(error.to_string()))?;
                spawn_stderr_reader(
                    stderr,
                    &agent.name,
                    &runtime_logs,
                    Some(wire_trace.correlation().clone()),
                );

                spawn_stdout_reader(
                    stdout,
                    pending.clone(),
                    tx.clone(),
                    notification_tx,
                    &crashed,
                    &crashed_watch,
                    &runtime_logs,
                    Some(wire_trace.clone()),
                    active_replay_requests.clone(),
                );

                let mut client = AcpClient {
                    child,
                    protocol: agent.protocol().clone(),
                    agent_capabilities: None,
                    write_tx,
                    writer_task: Some(writer_task),
                    next_id: Arc::new(AtomicU64::new(1)),
                    pending,
                    rx,
                    notification_inbox: NotificationInbox::new(notification_rx),
                    active_replay_requests,
                    crashed,
                    crashed_watch,
                    _crashed_watch_rx: crashed_watch_rx,
                    wire_trace: Some(wire_trace),
                };
                // Initialize——G1-03：握手三段全部来自协议配置（覆盖制，缺省 = 现状
                // 现值，wire 逐字节不变）：clientCapabilities（D1，agents.yaml
                // `acp.initialize_caps` 覆盖；缺省 = 统一默认 tokenStats + _meta.peri.*，
                // Hermes 忽略无害）、protocolVersion（H3）、clientInfo（H4）。
                // 差异适配表见 acp.rs 头部注释与手册 §3.3。
                let initialize_response = match client
                    .call_async(
                        METHOD_INITIALIZE,
                        serde_json::json!({
                            "protocolVersion": client.protocol.protocol_version(),
                            "clientCapabilities": client.protocol.initialize_caps(),
                            "clientInfo": client.protocol.client_info()
                        }),
                    )
                    .await
                {
                    Ok(response) => response,
                    Err(error) => {
                        let exit_code = client
                            .child
                            .try_wait()
                            .ok()
                            .flatten()
                            .and_then(|status| status.code());
                        return Err(AgentConnectFailure::initialize(error, exit_code).into());
                    }
                };
                // P1（能力协商暴露）：握手响应的 agentCapabilities 存起来——前端
                // 能力驱动 UI（loadSession/image/fork/resume/mcp）经 agent_status
                // 读取；未声明时保持 None。
                client.agent_capabilities = initialize_response.get("agentCapabilities").cloned();
                if client
                    .agent_capabilities
                    .as_ref()
                    .is_some_and(|capabilities| !capabilities.is_object())
                {
                    return Err(AgentConnectFailure::capability(
                        "initialize agentCapabilities 必须为 object".to_string(),
                    )
                    .into());
                }
                Ok(client)
            }
            other => Err(AgentConnectFailure::preflight(
                "agent_transport_unsupported",
                format!("unsupported transport: {other}"),
            )
            .into()),
        }
    }

    /// 提取锁外回放所需句柄。调用方应在锁内调用后立即释放锁，再以句柄等待。
    /// G1-05：原独立 impl 块并入主块（S1 卫生，行为零变化）。
    pub fn replay_handles(&self) -> ReplayHandles {
        ReplayHandles {
            write_tx: self.write_tx.clone(),
            next_id: self.next_id.clone(),
            crashed: self.crashed.clone(),
            rx: self.rx.resubscribe(),
            rpc_timeout: std::time::Duration::from_secs(self.protocol.rpc_timeout()),
            replay_max: self.protocol.replay_max(),
            active_replay_requests: self.active_replay_requests.clone(),
        }
    }

    /// Obtain the one Kernel notification inbox for this connection generation.
    pub(crate) fn notification_inbox(&self) -> NotificationInbox {
        self.notification_inbox.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// 测试辅助：经 prepare_rpc + complete 创建会话（生产调用点已锁外化）。
    async fn new_session_rpc(client: &AcpClient) -> Result<serde_json::Value, AcpError> {
        client
            .prepare_rpc(
                METHOD_SESSION_NEW,
                serde_json::json!({"cwd": ".", "mcpServers": []}),
            )?
            .complete()
            .await
    }

    /// 测试辅助：经 prepare_rpc + complete 关闭会话。
    async fn close_session_rpc(client: &AcpClient, session_id: &str) -> Result<(), AcpError> {
        client
            .prepare_rpc(
                METHOD_SESSION_CLOSE,
                serde_json::json!({"sessionId": session_id}),
            )?
            .complete()
            .await?;
        Ok(())
    }

    fn response() -> RawMessage {
        RawMessage {
            id: Some(RequestId::Number(1)),
            method: None,
            kind: AcpKind::Response,
            result: Some(serde_json::json!({"stopReason": "cancelled"})),
            params: None,
            error: None,
        }
    }

    #[test]
    fn acp_kind_classification_is_stable() {
        // B1：wire method 字符串 → 类型化分类契约（dispatcher 匹配依赖）。
        assert_eq!(AcpKind::from_method(None), AcpKind::Response);
        assert_eq!(
            AcpKind::from_method(Some(NOTIF_SESSION_UPDATE)),
            AcpKind::SessionUpdate
        );
        assert_eq!(
            AcpKind::from_method(Some(METHOD_SESSION_REQUEST_PERMISSION)),
            AcpKind::PermissionRequest
        );
        assert_eq!(
            AcpKind::from_method(Some(NOTIF_AGENT_CRASHED)),
            AcpKind::Crashed
        );
        assert_eq!(
            AcpKind::from_method(Some("unknown/method")),
            AcpKind::OtherNotification
        );
    }

    #[test]
    fn disconnected_client_is_not_marked_as_crashed() {
        assert!(!AcpClient::disconnected().is_crashed());
    }

    /// G1-06：close 降级判定类型化——-32601 信封（code 优先）与字符串兜底。
    #[test]
    fn method_not_found_detection() {
        // code 优先解析：-32601 信封命中
        assert!(
            AcpError::Rpc(r#"{"code":-32601,"message":"Method not found"}"#.into())
                .is_method_not_found()
        );
        assert!(AcpError::Rpc(r#"{"code":-32601}"#.into()).is_method_not_found());
        // 字符串兜底：纯文案 / 无 code 信封
        assert!(AcpError::Rpc("RPC error: Method not found".into()).is_method_not_found());
        assert!(AcpError::Rpc("RPC error: -32601".into()).is_method_not_found());
        assert!(AcpError::Rpc(r#"{"message":"Method not found"}"#.into()).is_method_not_found());
        // 非 -32601 错误 → false
        assert!(
            !AcpError::Rpc(r#"{"code":-32602,"message":"Invalid params"}"#.into())
                .is_method_not_found()
        );
        assert!(
            !AcpError::Rpc(r#"{"code":-32000,"message":"session missing"}"#.into())
                .is_method_not_found()
        );
        assert!(!AcpError::Rpc("RPC error: connection closed".into()).is_method_not_found());
        assert!(!AcpError::Rpc("ACP write timeout".into()).is_method_not_found());
        // 非 Rpc 变体 → false
        assert!(!AcpError::ConnectionClosed.is_method_not_found());
        assert!(!AcpError::RpcTimeout.is_method_not_found());
        assert!(!AcpError::WriteTimeout.is_method_not_found());
    }

    #[test]
    fn session_update_variant_wire_strings_are_stable() {
        // 契约锁定：wire 字符串 ↔ 变体映射（前端/平台依赖这些字符串，勿改拼写）。
        assert_eq!(
            SessionUpdateVariant::from_str("agent_message_chunk"),
            Some(SessionUpdateVariant::AgentMessageChunk)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("user_message_chunk"),
            Some(SessionUpdateVariant::UserMessageChunk)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("usage_update"),
            Some(SessionUpdateVariant::UsageUpdate)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("tool_call"),
            Some(SessionUpdateVariant::ToolCall)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("tool_call_update"),
            Some(SessionUpdateVariant::ToolCallUpdate)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("session_info_update"),
            Some(SessionUpdateVariant::SessionInfoUpdate)
        );
        assert_eq!(
            SessionUpdateVariant::from_str("config_option_update"),
            Some(SessionUpdateVariant::ConfigOptionUpdate)
        );
        assert_eq!(SessionUpdateVariant::from_str("unknown_variant"), None);
    }

    #[test]
    fn load_params_include_mcp_servers_field() {
        assert_eq!(
            load_params(
                "session-1",
                "G:/workspace",
                Vec::new(),
                crate::agent_config::McpServersMode::Always
            )
            .unwrap(),
            serde_json::json!({
                "sessionId": "session-1",
                "cwd": "G:/workspace",
                "mcpServers": [],
            })
        );
    }

    /// G1-07a：OmitIfEmpty 且空数组 → params 无 mcpServers 键（v2 语义）；
    /// 非空数组 → 照常插入。new/load 双路径。
    #[test]
    fn omit_if_empty_mode_omits_empty_field() {
        let params = crate::acp::session_new_params(
            "G:/workspace",
            Vec::new(),
            crate::agent_config::McpServersMode::OmitIfEmpty,
        )
        .unwrap();
        assert!(
            params.get("mcpServers").is_none(),
            "OmitIfEmpty + 空数组必须省略 mcpServers 键: {params}"
        );
        let params = crate::acp::session_new_params(
            "G:/workspace",
            vec![serde_json::json!({"name": "mcp-1"})],
            crate::agent_config::McpServersMode::OmitIfEmpty,
        )
        .unwrap();
        assert_eq!(params["mcpServers"][0]["name"], "mcp-1");
        // load 路径同语义
        let params = load_params(
            "session-1",
            "G:/workspace",
            Vec::new(),
            crate::agent_config::McpServersMode::OmitIfEmpty,
        )
        .unwrap();
        assert!(
            params.get("mcpServers").is_none(),
            "load OmitIfEmpty + 空数组必须省略 mcpServers 键: {params}"
        );
        let params = load_params(
            "session-1",
            "G:/workspace",
            vec![serde_json::json!({"name": "mcp-1"})],
            crate::agent_config::McpServersMode::OmitIfEmpty,
        )
        .unwrap();
        assert_eq!(params["mcpServers"][0]["name"], "mcp-1");
    }

    /// G1-07a：Always = 现状 wire——空数组恒发 mcpServers 字段（new/load 双路径）。
    #[test]
    fn always_mode_keeps_field() {
        let params =
            crate::acp::session_new_params("G:/workspace", Vec::new(), McpServersMode::Always)
                .unwrap();
        assert_eq!(params["mcpServers"], serde_json::json!([]));
        let params = crate::acp::session_new_params(
            "G:/workspace",
            Vec::new(),
            crate::agent_config::McpServersMode::Always,
        )
        .unwrap();
        assert_eq!(params["mcpServers"], serde_json::json!([]));
        let params = load_params(
            "session-1",
            "G:/workspace",
            Vec::new(),
            crate::agent_config::McpServersMode::Always,
        )
        .unwrap();
        assert_eq!(params["mcpServers"], serde_json::json!([]));
    }

    #[test]
    fn rejects_empty_and_error_session_ids() {
        for session_id in ["", "   ", "error", "ERROR"] {
            let response = serde_json::json!({"sessionId": session_id});
            assert!(session_id_from(&response).is_err());
        }
    }

    #[test]
    fn accepts_valid_session_id_after_trimming_whitespace() {
        let response = serde_json::json!({"sessionId": "  session-42  "});
        assert_eq!(session_id_from(&response).unwrap(), "session-42");
    }

    #[test]
    fn validates_prompt_stop_reasons() {
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({"stopReason": "end_turn"})),
            Ok("end_turn")
        );
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({"stopReason": "max_turn_requests"})),
            Ok("max_turn_requests")
        );
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({"stopReason": "cancelled"}))
                .expect_err("cancelled must not complete normally")
                .to_string(),
            "prompt cancelled"
        );
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({"stopReason": "refusal"}))
                .expect_err("refusal must not complete normally")
                .to_string(),
            "prompt refused by agent"
        );
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({"stopReason": "paused"}))
                .expect_err("unknown stop reason must be rejected")
                .to_string(),
            "unsupported prompt stopReason: paused"
        );
        assert_eq!(
            prompt_stop_reason(&serde_json::json!({}))
                .expect_err("missing stop reason must be rejected")
                .to_string(),
            "invalid session/prompt response: {}"
        );
    }

    #[test]
    fn prompt_without_attachments_contains_one_text_block() {
        let blocks = prompt_blocks(
            "hello".to_string(),
            &[],
            crate::agent_config::AttachmentLimits::default(),
        )
        .unwrap();
        assert_eq!(
            blocks,
            vec![serde_json::json!({"type": "text", "text": "hello"})]
        );
    }

    #[test]
    fn prompt_rejects_more_than_maximum_attachments() {
        let attachments = vec!["missing.txt".to_string(); DEFAULT_MAX_ATTACHMENTS + 1];
        let error = prompt_blocks(
            "hello".to_string(),
            &attachments,
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect_err("attachment count limit must be enforced before file access");
        assert_eq!(
            error,
            format!("too many attachments: maximum is {DEFAULT_MAX_ATTACHMENTS}")
        );
    }

    #[test]
    fn prompt_rejects_missing_attachment_with_explicit_error() {
        let error = prompt_blocks(
            "hello".to_string(),
            &["definitely-missing-pylon-attachment.txt".to_string()],
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect_err("missing attachment must fail");
        assert!(error.starts_with(
            "attachment metadata failed for definitely-missing-pylon-attachment.txt:"
        ));
    }

    #[test]
    fn prompt_rejects_directory_attachment() {
        let directory =
            std::env::temp_dir().join(format!("pylon-attachment-dir-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let error = prompt_blocks(
            "hello".to_string(),
            &[directory.to_string_lossy().into_owned()],
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect_err("directory attachment must fail");
        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(
            error,
            format!("attachment is not a file: {}", directory.display())
        );
    }

    #[test]
    fn prompt_rejects_unknown_binary_attachment() {
        let path = std::env::temp_dir().join(format!(
            "pylon-attachment-binary-{}.bin",
            std::process::id()
        ));
        std::fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
        let error = prompt_blocks(
            "hello".to_string(),
            &[path.to_string_lossy().into_owned()],
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect_err("unknown binary attachment must fail");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            error,
            format!("unsupported attachment type: {}", path.display())
        );
    }

    #[test]
    fn prompt_rejects_attachment_grown_beyond_limit_after_metadata_check() {
        // A9：metadata 校验与读取间文件被增长（TOCTOU）时必须拒绝，不能无上限读取。
        let path = std::env::temp_dir().join(format!(
            "pylon-attachment-toctou-{}.bin",
            std::process::id()
        ));
        std::fs::write(&path, vec![0u8; DEFAULT_MAX_ATTACHMENT_BYTES as usize + 1]).unwrap();
        let error = prompt_blocks(
            "hello".to_string(),
            &[path.to_string_lossy().into_owned()],
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect_err("oversized attachment must fail");
        std::fs::remove_file(&path).unwrap();
        assert!(
            error.starts_with("attachment too large:"),
            "must reject with the bounded-read too-large message, got: {error}"
        );
    }

    /// G1-04：缩小附件限制后边界拒绝——数量上限先行、大小上限按自定义值生效。
    #[test]
    fn custom_attachment_limits_apply() {
        let limits = crate::agent_config::AttachmentLimits {
            max_attachments: 1,
            max_attachment_bytes: 1024,
        };
        // 数量上限：2 个附件在文件访问前即拒绝（数量检查先行）
        let error = prompt_blocks(
            "hello".to_string(),
            &["a.txt".to_string(), "b.txt".to_string()],
            limits,
        )
        .expect_err("超过自定义数量上限必须拒绝");
        assert_eq!(error, "too many attachments: maximum is 1");
        // 大小上限：1KB 限制下 2KB 文本拒绝；默认限制（10MB）下通过
        let path = std::env::temp_dir().join(format!(
            "pylon-attachment-custom-{}.txt",
            std::process::id()
        ));
        std::fs::write(&path, "x".repeat(2048)).unwrap();
        let error = prompt_blocks(
            "hello".to_string(),
            &[path.to_string_lossy().into_owned()],
            limits,
        )
        .expect_err("超过自定义大小上限必须拒绝");
        assert!(error.starts_with("attachment too large:"));
        let blocks = prompt_blocks(
            "hello".to_string(),
            &[path.to_string_lossy().into_owned()],
            crate::agent_config::AttachmentLimits::default(),
        )
        .expect("默认限制下必须通过");
        assert_eq!(blocks.len(), 2, "text + attachment 两个块");
        std::fs::remove_file(&path).unwrap();
    }

    #[tokio::test]
    async fn timeout_sends_cancel_and_waits_for_final_response() {
        let (tx, mut rx) = oneshot::channel();
        let cancel_called = Arc::new(AtomicBool::new(false));
        let cancel_called_for_task = cancel_called.clone();

        let outcome = wait_prompt_with_cancel(
            &mut rx,
            std::time::Duration::from_millis(200),
            std::time::Duration::from_millis(10),
            std::time::Duration::from_millis(10),
            || None,
            move || async move {
                cancel_called_for_task.store(true, Ordering::SeqCst);
                tx.send(response())
                    .map_err(|_| "receiver closed".to_string())
            },
        )
        .await;

        assert!(cancel_called.load(Ordering::SeqCst));
        match outcome {
            PromptWaitOutcome::CancelledAfterTimeout {
                response,
                cancel_error,
            } => {
                assert!(cancel_error.is_none());
                assert_eq!(
                    response
                        .and_then(|raw| raw.result)
                        .and_then(|value| value.get("stopReason").cloned()),
                    Some(serde_json::json!("cancelled"))
                );
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[tokio::test]
    async fn response_before_timeout_does_not_send_cancel() {
        let (tx, mut rx) = oneshot::channel();
        tx.send(response()).expect("receiver must be open");
        let cancel_called = Arc::new(AtomicBool::new(false));
        let cancel_called_for_task = cancel_called.clone();

        let outcome = wait_prompt_with_cancel(
            &mut rx,
            std::time::Duration::from_millis(10),
            std::time::Duration::from_secs(1),
            std::time::Duration::from_secs(1),
            || None,
            move || async move {
                cancel_called_for_task.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;

        assert!(!cancel_called.load(Ordering::SeqCst));
        assert!(matches!(outcome, PromptWaitOutcome::Response(_)));
    }

    #[tokio::test]
    async fn sustained_activity_is_not_limited_by_prompt_total_timeout() {
        let (_tx, mut rx) = tokio::sync::oneshot::channel();
        let wait = wait_prompt_with_cancel(
            &mut rx,
            std::time::Duration::from_millis(5),
            std::time::Duration::from_millis(20),
            std::time::Duration::from_millis(20),
            // A real dispatcher updates this value for every thinking/tool/output step.
            // Returning now on every poll models an indefinitely active turn.
            || Some(std::time::Instant::now()),
            || async { Ok(()) },
        );

        // The whole turn must remain alive despite prompt_timeout being shorter than
        // this observation window; only a quiet step may trigger cancellation.
        let result = tokio::time::timeout(std::time::Duration::from_millis(80), wait).await;
        assert!(
            result.is_err(),
            "持续活动不得受 prompt total timeout 截断，实际结果: {result:?}"
        );
    }

    #[test]
    fn drain_pending_notifies_every_waiter_and_clears_registry() {
        let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
            Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
        let mut receivers = Vec::new();
        for id in [1_u64, 16, 31] {
            let (tx, rx) = oneshot::channel();
            pending[id as usize % PENDING_SHARDS]
                .lock()
                .unwrap()
                .insert(id, tx);
            receivers.push(rx);
        }

        assert_eq!(drain_pending(&pending), 3);
        assert!(pending.iter().all(|shard| shard.lock().unwrap().is_empty()));
        for receiver in receivers {
            let message = receiver
                .blocking_recv()
                .expect("EOF should wake pending request");
            assert_eq!(
                message.error,
                Some(serde_json::json!("ACP connection closed"))
            );
        }
    }

    #[test]
    fn drain_pending_is_idempotent_after_first_close() {
        let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
            Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
        assert_eq!(drain_pending(&pending), 0);
        assert_eq!(drain_pending(&pending), 0);
    }

    #[tokio::test]
    async fn fake_acp_subprocess_completes_initialize_new_and_prompt_wire() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'session/new':
        response['result']={'sessionId':'fake-session-1'}
    elif method == 'session/prompt':
        response['result']={'stopReason':'end_turn'}
    print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp", script);
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let child_id = client.child_id().expect("fake ACP child must exist");
        let new_response = client
            .prepare_rpc(
                METHOD_SESSION_NEW,
                serde_json::json!({"cwd": ".", "mcpServers": []}),
            )
            .expect("session/new must prepare")
            .complete()
            .await
            .expect("session/new must succeed");
        assert_eq!(session_id_from(&new_response).unwrap(), "fake-session-1");

        let rpc = client
            .prepare_prompt(
                "fake-session-1",
                vec![serde_json::json!({"type":"text","text":"hello"})],
            )
            .expect("prompt must serialize");
        assert!(rpc.line.contains("session/prompt"));
        let request_id = rpc.id;
        let mut response_rx = rpc
            .send_keep_rx()
            .await
            .expect("fake child stdin must remain open");
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), &mut response_rx)
            .await
            .expect("fake ACP prompt response must arrive")
            .expect("fake ACP prompt pending must settle");
        assert_eq!(response.id, Some(RequestId::Number(request_id)));
        assert_eq!(
            prompt_stop_reason(&response.result.unwrap()).unwrap(),
            "end_turn"
        );

        client.kill().expect("explicit child cleanup must succeed");
        assert!(
            !process_exists(child_id),
            "fake ACP child must exit after kill_and_wait"
        );
    }

    #[tokio::test]
    async fn wire_trace_preserves_id_kinds_and_full_sequence() {
        // OBS-01 验收：fake ACP 发送 number/string/null/无 id 四类报文，trace 保留
        // 四类差异；一次 permission 闭环按 seq 排出完整顺序；方向/身份逐条保留。
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'initialize':
        print(json.dumps(response), flush=True)
        # unsolicited：absent-id 通知、string-id 消息、null-id 消息
        print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'s-1'}}), flush=True)
        print(json.dumps({'jsonrpc':'2.0','id':'str-id-1','result':{'ok':True}}), flush=True)
        print(json.dumps({'jsonrpc':'2.0','id':None,'result':None}), flush=True)
    elif method == 'session/new':
        response['result']={'sessionId':'fake-session-1'}
        print(json.dumps(response), flush=True)
    elif method == 'session/prompt':
        # P1 场景：string-id 的 request_permission 先到，再 update 通知，最后响应
        print(json.dumps({'jsonrpc':'2.0','id':'perm-1','method':'session/request_permission','params':{'sessionId':'fake-session-1','toolCallId':'tc-1','options':[{'optionId':'allow_once'},{'optionId':'deny'}]}}), flush=True)
        print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'fake-session-1','toolCallId':'tc-1','type':'tool_call_update'}}), flush=True)
        response['result']={'stopReason':'end_turn'}
        print(json.dumps(response), flush=True)
    else:
        print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-trace", script);
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let trace = client
            .wire_trace()
            .expect("connected client must expose wire trace");
        assert!(trace.is_enabled());

        let new_response = client
            .prepare_rpc(
                METHOD_SESSION_NEW,
                serde_json::json!({"cwd": ".", "mcpServers": []}),
            )
            .expect("session/new must prepare")
            .complete()
            .await
            .expect("session/new must succeed");
        assert_eq!(session_id_from(&new_response).unwrap(), "fake-session-1");

        let rpc = client
            .prepare_prompt(
                "fake-session-1",
                vec![serde_json::json!({"type":"text","text":"hello"})],
            )
            .expect("prompt must serialize");
        let mut response_rx = rpc
            .send_keep_rx()
            .await
            .expect("fake child stdin must remain open");
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), &mut response_rx)
            .await
            .expect("fake ACP prompt response must arrive")
            .expect("fake ACP prompt pending must settle");
        assert_eq!(
            prompt_stop_reason(&response.result.unwrap()).unwrap(),
            "end_turn"
        );

        // 轮询等待 writer/reader 线程把全部 wire 记录落进 ring buffer。
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        let snap = loop {
            let snap = trace.snapshot();
            if snap.len() >= 11 {
                break snap;
            }
            if tokio::time::Instant::now() >= deadline {
                break snap;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };

        // 四条 id 形态必须全部保留（number/string/null/absent）。
        let kinds: Vec<WireIdKind> = snap.iter().map(|record| record.id_kind).collect();
        assert!(
            kinds.contains(&WireIdKind::Number),
            "number id 必须保留，实际 {kinds:?}"
        );
        assert!(
            kinds.contains(&WireIdKind::String),
            "string id 必须保留，实际 {kinds:?}"
        );
        assert!(
            kinds.contains(&WireIdKind::Null),
            "null id 必须保留，实际 {kinds:?}"
        );
        assert!(
            kinds.contains(&WireIdKind::Absent),
            "absent id 必须保留，实际 {kinds:?}"
        );

        // monotonicSeq 严格单调（CR-003 命名；CR-001 snapshot 已排齐）。
        let seqs: Vec<u64> = snap.iter().map(|record| record.monotonic_seq).collect();
        let mut sorted = seqs.clone();
        sorted.sort_unstable();
        assert_eq!(seqs, sorted, "seq 必须可排出完整顺序");
        assert!(
            seqs.windows(2).all(|pair| pair[1] > pair[0]),
            "seq 严格递增"
        );

        // string-id request_permission（P1 场景）必须按原样记录。
        let permission = snap
            .iter()
            .find(|record| record.method.as_deref() == Some("session/request_permission"))
            .expect("request_permission 必须在 trace 中");
        assert_eq!(permission.id_kind, WireIdKind::String);
        assert_eq!(permission.id_value, Some(serde_json::json!("perm-1")));
        assert_eq!(permission.direction, WireDirection::AgentToPylon);
        assert_eq!(permission.tool_call_id.as_deref(), Some("tc-1"));
        assert_eq!(
            permission.remote_session_id.as_deref(),
            Some("fake-session-1")
        );
        assert_eq!(
            permission.request_id.as_deref(),
            Some("perm-1"),
            "OBS-02：request_permission 的 wire id 必须记为 requestId"
        );

        // 方向/状态：至少存在 outbound 与 inbound 记录，状态与方向一致。
        assert!(
            snap.iter().any(|record| {
                record.direction == WireDirection::PylonToAgent && record.status == "sent"
            }),
            "必须存在 outbound(sent) 记录"
        );
        assert!(
            snap.iter().any(|record| {
                record.direction == WireDirection::AgentToPylon && record.status == "received"
            }),
            "必须存在 inbound(received) 记录"
        );
        // 身份逐条保留。
        for record in &snap {
            assert_eq!(record.agent_id, "fake-acp-trace");
            assert_eq!(record.source, "subprocess");
        }

        client.kill().expect("explicit child cleanup must succeed");
    }

    #[tokio::test]
    async fn fake_acp_initialize_stores_agent_capabilities() {
        // P1（能力协商暴露）：initialize 响应里的 agentCapabilities 必须存进
        // AcpClient——前端能力驱动 UI（agent_status.capabilities）依赖此存储。
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'initialize':
        response['result']={'protocolVersion':1,'agentCapabilities':{'loadSession':True,'promptCapabilities':{'image':True}}}
    print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-caps", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let caps = client
            .agent_capabilities()
            .expect("agentCapabilities 必须从握手响应存储");
        assert_eq!(caps["loadSession"], true);
        assert_eq!(caps["promptCapabilities"]["image"], true);
        // 断开态无 capabilities
        assert!(AcpClient::disconnected().agent_capabilities().is_none());
    }

    #[tokio::test]
    async fn connect_failures_have_typed_preflight_and_spawn_stages() {
        let mut missing = crate::test_utils::fake_acp_agent("missing", "print('x')");
        missing.exe = std::env::temp_dir()
            .join("definitely-missing-pylon-agent")
            .to_string_lossy()
            .to_string();
        let error = AcpClient::connect_with_logs(&missing, None)
            .await
            .err()
            .expect("missing executable path must fail preflight");
        let AcpError::Connect(failure) = error else {
            panic!("expected typed connect failure")
        };
        assert_eq!(failure.stage, AgentConnectStage::Preflight);
        assert_eq!(failure.code, "agent_executable_missing");
        assert!(!failure.retryable);

        let mut spawn = crate::test_utils::fake_acp_agent("spawn", "print('x')");
        spawn.exe = format!("pylon-command-that-does-not-exist-{}", std::process::id());
        let error = AcpClient::connect_with_logs(&spawn, None)
            .await
            .err()
            .expect("unknown PATH command must fail spawn");
        let AcpError::Connect(failure) = error else {
            panic!("expected typed spawn failure")
        };
        assert_eq!(failure.stage, AgentConnectStage::Spawn);
        assert_eq!(failure.code, "agent_spawn_failed");
        assert!(failure.io_kind.is_some());
    }

    #[tokio::test]
    async fn initialize_rpc_failure_keeps_safe_remote_summary() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'error':{'code':-32041,'message':'profile invalid','data':{'token':'must-not-leak','attempt':1}}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("typed-init-error", script);
        let error = AcpClient::connect_with_logs(&agent, None)
            .await
            .err()
            .expect("initialize RPC error must fail connect");
        let AcpError::Connect(failure) = error else {
            panic!("expected typed initialize failure")
        };
        assert_eq!(failure.stage, AgentConnectStage::Initialize);
        assert_eq!(failure.code, "agent_initialize_failed");
        assert_eq!(failure.remote_code, Some(-32041));
        assert_eq!(
            failure.remote_data_summary.as_deref(),
            Some("object(2 keys)")
        );
        assert!(!failure.message.contains("must-not-leak"));
    }

    #[tokio::test]
    async fn malformed_capabilities_have_capability_stage() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{'agentCapabilities':[]}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("typed-capability-error", script);
        let error = AcpClient::connect_with_logs(&agent, None)
            .await
            .err()
            .expect("non-object capabilities must fail connect");
        let AcpError::Connect(failure) = error else {
            panic!("expected typed capability failure")
        };
        assert_eq!(failure.stage, AgentConnectStage::Capability);
        assert_eq!(failure.code, "agent_capability_invalid");
        assert!(!failure.retryable);
    }

    #[test]
    fn rpc_failure_kind_distinguishes_missing_session_from_method_and_transient_errors() {
        for raw in [
            r#"{"code":-32602,"message":"session not found: s-1"}"#,
            r#"{"code":-32000,"message":"invalid session: s-1"}"#,
            r#"{"code":-32000,"message":"request rejected","data":{"kind":"session_missing"}}"#,
        ] {
            assert_eq!(
                AcpError::Rpc(raw.into()).rpc_failure_kind(),
                Some(RpcFailureKind::SessionMissing),
                "{raw}"
            );
        }
        for raw in [
            r#"{"code":-32601,"message":"Method not found"}"#,
            r#"{"code":-32602,"message":"invalid params: missing content"}"#,
            r#"{"code":-32001,"message":"rate limited"}"#,
        ] {
            assert_ne!(
                AcpError::Rpc(raw.into()).rpc_failure_kind(),
                Some(RpcFailureKind::SessionMissing),
                "{raw}"
            );
        }
    }

    #[tokio::test]
    async fn fake_acp_eof_drains_pending_requests() {
        let script = r#"import sys
sys.exit(0)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-eof", script);
        let client = AcpClient::connect_with_logs(&agent, None).await;
        assert!(
            client.is_err(),
            "initialize must fail when fake ACP closes without a response"
        );
    }

    #[tokio::test]
    async fn crashed_watch_signals_eof_after_broadcast_overflow() {
        // A7：洪泛 300 条（> BROADCAST_CAP=256）后 EOF——NOTIF_AGENT_CRASHED 广播
        // 必然被 Lagged 丢弃；崩溃信号必须经独立 watch 通道仍可靠送达（watch 保留
        // 最新值：订阅晚于崩溃时 has_changed 直接可读，订阅早于崩溃时 changed 触发）。
        let script = r#"import json,sys
for line in sys.stdin:
    request = json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
        for i in range(300):
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':'flood','update':{'sessionUpdate':'agent_message_chunk','content':{'text':'x'}}}}), flush=True)
        break
sys.exit(0)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-flood-crash", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("flood fake ACP must initialize");
        let mut crashed_rx = client.crashed_receiver();
        if crashed_rx.has_changed().unwrap_or(false) {
            // 崩溃发生在订阅之前（connect 成功后立刻 EOF）——watch 保留最新值，直接可读
        } else {
            tokio::time::timeout(std::time::Duration::from_secs(5), crashed_rx.changed())
                .await
                .expect("watch must signal crash within 5s")
                .expect("watch channel must stay open");
        }
        assert!(
            *crashed_rx.borrow_and_update(),
            "crashed watch value must be true after EOF"
        );
        assert!(client.is_crashed());
    }

    #[tokio::test]
    async fn fake_acp_session_load_collects_replay_before_response() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'initialize':
        response['result']={}
    elif method == 'session/load':
        session_id=request['params']['sessionId']
        for text in ['history-1','history-2']:
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':text}}}}), flush=True)
        response['result']={'loaded':True}
    else:
        response['result']={}
    print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-replay", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP replay agent must initialize");
        let (response, replay) = load_session_with_replay(
            client.replay_handles(),
            "fake-session-replay",
            ".",
            Vec::new(),
            McpServersMode::Always,
        )
        .await
        .expect("session/load must return after replay response");
        assert_eq!(response, serde_json::json!({"loaded": true}));
        assert_eq!(replay.events.len(), 2);
        assert_eq!(replay.events[0]["update"]["content"]["text"], "history-1");
        assert_eq!(replay.events[1]["update"]["content"]["text"], "history-2");
        assert!(replay.metadata.complete);
        assert!(!replay.metadata.truncated);
        assert_eq!(replay.metadata.dropped_count, 0);
        assert_eq!(replay.metadata.boundary.observed_count, 2);
        assert_eq!(replay.metadata.boundary.retained_start_ordinal, Some(1));
        assert_eq!(replay.metadata.boundary.retained_end_ordinal, Some(2));
    }

    /// G1-02：rpc_timeout 参数化——配置短 rpc_timeout 的 client 在 fake 慢响应上
    /// 必须按配置超时返回 RpcTimeout（而非默认 30s 等待）。
    #[tokio::test]
    async fn rpc_timeout_from_config_is_used() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    else:
        pass
"#;
        let mut agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-rpc-timeout",
            script,
            Vec::new(),
            HashMap::new(),
        );
        agent.acp = Some(crate::agent_config::AcpProtocolConfig {
            rpc_timeout_secs: Some(1),
            ..Default::default()
        });
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let start = std::time::Instant::now();
        let result = client
            .prepare_rpc(
                METHOD_SESSION_NEW,
                serde_json::json!({"cwd": ".", "mcpServers": []}),
            )
            .expect("session/new must prepare")
            .complete()
            .await;
        assert!(
            matches!(result, Err(AcpError::RpcTimeout)),
            "慢响应必须按配置短超时超时，实际: {result:?}"
        );
        assert!(
            start.elapsed() < std::time::Duration::from_secs(10),
            "必须用配置的短超时（1s）而非默认 30s，实际耗时 {:?}",
            start.elapsed()
        );
    }

    /// G1-02：replay_max 参数化——回放超过配置上限时截断且继续等响应（响应不得丢）。
    #[tokio::test]
    async fn replay_max_truncation_respects_config() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    elif request.get('method') == 'session/load':
        session_id=request['params']['sessionId']
        for i in range(3):
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'h%d' % i}}}}), flush=True)
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{'loaded':True}}), flush=True)
"#;
        let mut agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-replay-cap",
            script,
            Vec::new(),
            HashMap::new(),
        );
        agent.acp = Some(crate::agent_config::AcpProtocolConfig {
            replay_max_events: Some(2),
            ..Default::default()
        });
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP replay cap agent must initialize");
        let (response, replay) = load_session_with_replay(
            client.replay_handles(),
            "target-cap",
            ".",
            Vec::new(),
            McpServersMode::Always,
        )
        .await
        .expect("session/load must return after replay response");
        assert_eq!(response, serde_json::json!({"loaded": true}));
        assert_eq!(
            replay.events.len(),
            2,
            "回放必须按 replay_max=2 截断（3 条 fake 事件）"
        );
        assert_eq!(replay.events[0]["update"]["content"]["text"], "h1");
        assert_eq!(replay.events[1]["update"]["content"]["text"], "h2");
        assert!(!replay.metadata.complete);
        assert!(replay.metadata.truncated);
        assert_eq!(replay.metadata.dropped_count, 1);
        assert_eq!(replay.metadata.boundary.kind, "session-load-response");
        assert_eq!(replay.metadata.boundary.observed_count, 3);
        assert_eq!(replay.metadata.boundary.retained_start_ordinal, Some(2));
        assert_eq!(replay.metadata.boundary.retained_end_ordinal, Some(3));
        assert_eq!(
            serde_json::to_value(&replay.metadata).expect("replay metadata serializes"),
            serde_json::json!({
                "complete": false,
                "truncated": true,
                "droppedCount": 1,
                "boundary": {
                    "kind": "session-load-response",
                    "observedCount": 3,
                    "retainedStartOrdinal": 2,
                    "retainedEndOrdinal": 3
                }
            })
        );
    }

    #[tokio::test]
    async fn fake_acp_cancel_and_close_send_expected_notifications() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-acp-control-{}.jsonl", std::process::id()));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'session/close':
        response['result']={'closed':True}
    if request.get('id') is not None:
        print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-control",
            script,
            vec![trace_path.to_string_lossy().into_owned()],
            HashMap::new(),
        );
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP control agent must initialize");
        client
            .cancel_session("fake-session-control")
            .await
            .expect("cancel notification must write");
        close_session_rpc(&client, "fake-session-control")
            .await
            .expect("close request must respond");
        let trace =
            std::fs::read_to_string(&trace_path).expect("fake ACP must record control requests");
        std::fs::remove_file(&trace_path).ok();
        let requests: Vec<serde_json::Value> = trace
            .lines()
            .map(|line| serde_json::from_str(line).expect("trace line must be JSON"))
            .collect();
        assert!(requests.iter().any(|request| {
            request.get("method").and_then(|value| value.as_str()) == Some(METHOD_SESSION_CANCEL)
                && request.get("id").is_none()
                && request["params"]["sessionId"] == "fake-session-control"
        }));
        assert!(requests.iter().any(|request| {
            request.get("method").and_then(|value| value.as_str()) == Some(METHOD_SESSION_CLOSE)
                && request.get("id").and_then(|value| value.as_u64()).is_some()
                && request["params"]["sessionId"] == "fake-session-control"
        }));
    }
    #[tokio::test]
    async fn fake_acp_eof_wakes_pending_request_after_initialize() {
        let script = r#"import json,sys
line=sys.stdin.readline()
request=json.loads(line)
print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
sys.exit(0)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-eof-after-init", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("initialize response must arrive before EOF");
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if client.is_crashed() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fake child EOF must be observed");
        let error =
            tokio::time::timeout(std::time::Duration::from_secs(2), new_session_rpc(&client))
                .await
                .expect("pending request must settle after EOF")
                .expect_err("EOF must reject a new request");
        assert!(error.to_string().contains("ACP connection closed"));
    }

    #[tokio::test]
    async fn fake_acp_malformed_json_does_not_break_following_response() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print('{malformed-json', flush=True)
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if request.get('method') == 'session/new':
        response['result']={'sessionId':'after-malformed'}
    print(json.dumps(response), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-malformed", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("malformed line must not break initialize");
        let response = new_session_rpc(&client)
            .await
            .expect("response after malformed line must arrive");
        assert_eq!(session_id_from(&response).unwrap(), "after-malformed");
    }

    #[tokio::test]
    async fn fake_acp_stderr_is_drained_into_safe_runtime_log() {
        let script = r#"import json,sys
print('fake stderr diagnostic', file=sys.stderr, flush=True)
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-stderr", script);
        let logs = crate::runtime_log::RuntimeLogHub::new(16);
        let client = AcpClient::connect_with_logs(&agent, Some(logs.clone()))
            .await
            .expect("stderr fake ACP must initialize");
        let _ = client;
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let entries = logs.list(&crate::runtime_log::RuntimeLogQuery::default());
                if entries.iter().any(|entry| entry.source == "agent-stderr") {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("stderr reader must publish runtime log");
        let entry = logs
            .list(&crate::runtime_log::RuntimeLogQuery::default())
            .into_iter()
            .find(|entry| entry.source == "agent-stderr")
            .expect("agent stderr log must exist");
        // LOG-01：message 必须是真实行文本（原占位 "Agent stderr output" 改为真实行，
        // 真实错误可检索）；同一 stderr 行只进 hub 一次（A 型 tracing 回声已被 target 跳过）。
        assert_eq!(entry.message, "fake stderr diagnostic");
        // LOG-02：普通 stderr 行不再默认 error——非结构化、无致命信号的普通行 → info。
        assert_eq!(entry.level, "info", "LOG-02：普通 stderr 行不得默认 error");
        assert_eq!(
            entry.fields.get("agent").and_then(|value| value.as_str()),
            Some("fake-acp-stderr")
        );
        let entries = logs.list(&crate::runtime_log::RuntimeLogQuery::default());
        let stderr_line_entries = entries
            .iter()
            .filter(|entry| {
                entry.source == "agent-stderr" || entry.message.contains("fake stderr diagnostic")
            })
            .count();
        // LOG-01 CR-001 消化（玉衡 MINOR）：本断言只守护"stderr reader 显式 push 恰好
        // 一次"（读线程是 `logs` 唯一来源）；A/B 双写中 A 型（tracing layer 捕获回声）
        // 在本测试 harness 下不可达——connect 未把 RuntimeLogLayer 绑定到本 hub，
        // tracing 事件到不了 `logs`。A/B 去重由 runtime_log 层单测
        // layer_skips_agent_stderr_echo_target_but_keeps_other_errors 真实兜底
        // （旧代码该测试必失败，非 vacuous）。
        assert_eq!(
            stderr_line_entries, 1,
            "stderr 行显式 push 恰好一次（A/B 去重另由 layer 单测守护）"
        );
    }

    #[tokio::test]
    async fn fake_acp_delayed_response_stays_pending_until_response() {
        let script = r#"import json,sys,time
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'session/new':
        time.sleep(0.15)
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{'sessionId':'delayed-session'}}), flush=True)
    else:
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-delayed", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("delayed fake ACP must initialize");
        let response =
            tokio::time::timeout(std::time::Duration::from_secs(2), new_session_rpc(&client))
                .await
                .expect("delayed response must not hit test timeout")
                .expect("delayed response must succeed");
        assert_eq!(session_id_from(&response).unwrap(), "delayed-session");
    }
    #[tokio::test]
    async fn fake_acp_prompt_timeout_sends_cancel_and_waits_for_cancelled_response() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-acp-prompt-{}.jsonl", std::process::id()));
        let script = r#"import json,sys,time
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    method=request.get('method')
    if method == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    elif method == 'session/prompt':
        time.sleep(0.2)
    elif method == 'session/cancel':
        print(json.dumps({'jsonrpc':'2.0','id':None,'method':'session/update','params':{'sessionId':request['params']['sessionId'],'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'cancelled'}}}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-prompt-timeout",
            script,
            vec![trace_path.to_string_lossy().into_owned()],
            HashMap::new(),
        );
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("timeout fake ACP must initialize");
        let rpc = client
            .prepare_prompt(
                "fake-session-timeout",
                vec![serde_json::json!({"type":"text","text":"hello"})],
            )
            .expect("prompt must serialize");
        let request_id = rpc.id;
        let mut response_rx = rpc.send_keep_rx().await.expect("prompt must write");
        let cancel_tx = client.write_tx.clone();
        let outcome = wait_prompt_with_cancel(
            &mut response_rx,
            std::time::Duration::from_millis(200),
            std::time::Duration::from_millis(20),
            std::time::Duration::from_millis(20),
            || None,
            move || async move {
                cancel_tx
                    .send(
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": METHOD_SESSION_CANCEL,
                            "params": {"sessionId": "fake-session-timeout"}
                        })
                        .to_string(),
                    )
                    .await
                    .map_err(|_| "ACP connection closed".to_string())
            },
        )
        .await;
        assert!(matches!(
            outcome,
            PromptWaitOutcome::CancelledAfterTimeout {
                response: None,
                cancel_error: None
            }
        ));
        client.remove_pending(request_id);
        let trace =
            std::fs::read_to_string(&trace_path).expect("fake ACP must record prompt and cancel");
        std::fs::remove_file(&trace_path).ok();
        assert!(trace.lines().any(|line| {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            value.get("method").and_then(|method| method.as_str()) == Some(METHOD_SESSION_CANCEL)
                && value["params"]["sessionId"] == "fake-session-timeout"
        }));
    }

    #[tokio::test]
    async fn send_line_write_timeout_marks_connection_crashed() {
        // 假死连接：容量 1 的写通道被填满且无人消费（writer 卡死），send_line 超时 →
        // WriteTimeout + crashed 置位，后续命令快速失败并触发自动重连。
        // 与 fake_acp_* 一致用真实时钟，超时等待 DEFAULT_WRITE_TIMEOUT_SECS。
        let (write_tx, _write_rx) = mpsc::channel::<String>(1);
        write_tx
            .send("first-line".to_string())
            .await
            .expect("empty channel must accept the first line");
        let crashed = Arc::new(AtomicBool::new(false));
        let error = send_line(write_tx, "second-line".to_string(), &crashed)
            .await
            .expect_err("full channel with no consumer must time out");
        assert!(matches!(error, AcpError::WriteTimeout));
        assert!(
            crashed.load(Ordering::Relaxed),
            "write timeout must mark the connection as crashed"
        );
    }

    #[tokio::test]
    async fn writer_failure_signals_watch_and_pending_settles() {
        // 方案 2A 测试门：writer 写失败（EPIPE）必须经 fail_connection 统一结算——
        // crashed=true、watch 发 true、pending waiter 立即 ConnectionClosed，
        // 不再只置 crashed 等下次 EOF（agent 僵死时 EOF 永不来）。
        let trace_path = std::env::temp_dir().join(format!(
            "pylon-acp-writer-fail-{}.jsonl",
            std::process::id()
        ));
        // 读一行后立即退出：initialize 写入成功，后续写触发 EPIPE。
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
line=sys.stdin.readline()
request=json.loads(line)
trace.write(json.dumps(request)+'\n')
trace.flush()
print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-writer-fail".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: crate::test_utils::test_python_exe().to_string(),
            args: vec![
                "-u".to_string(),
                "-c".to_string(),
                script.to_string(),
                trace_path.to_string_lossy().into_owned(),
            ],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        };
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("initialize 应成功（首行写入正常）");
        let mut crashed_rx = client.crashed_receiver();
        // 子进程已退出，writer 下次写必 EPIPE → fail_connection → watch 发 true。
        let rpc = client
            .prepare_rpc(
                METHOD_SESSION_NEW,
                serde_json::json!({"cwd": ".", "mcpServers": []}),
            )
            .expect("prepare_rpc 不依赖进程状态");
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), rpc.complete())
            .await
            .expect("写失败必须在 5s 内收敛（不得悬挂）");
        assert!(outcome.is_err(), "写失败必须返回 Err");
        assert!(client.is_crashed(), "crashed 必须置位");
        // watch 通道必须送达 true（dispatcher 依赖它触发自动重连）
        let watch_hit = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            if *crashed_rx.borrow_and_update() {
                return true;
            }
            crashed_rx.changed().await.is_ok() && *crashed_rx.borrow_and_update()
        })
        .await
        .unwrap_or(false);
        assert!(watch_hit, "writer failure 必须经 watch 信号送达");
        client.kill().expect("cleanup");
        std::fs::remove_file(&trace_path).ok();
    }

    #[tokio::test]
    async fn fail_connection_signals_watch_drains_pending_and_is_idempotent() {
        // 方案 2A：fail_connection 统一结算——crashed=true、watch 发 true、
        // pending drain 一次、重复调用幂等（不 double-resolve）。
        let crashed = Arc::new(AtomicBool::new(false));
        let (crashed_watch, mut crashed_rx) = watch::channel(false);
        let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
            Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
        // 预注册 2 个 pending waiter
        for id in [3u64, 9] {
            let (tx, _rx) = tokio::sync::oneshot::channel();
            pending[id as usize % PENDING_SHARDS]
                .lock()
                .unwrap()
                .insert(id, tx);
        }
        let drained = super::transport::fail_connection(&crashed, &crashed_watch, &pending);
        assert_eq!(drained, 2, "首次结算必须 drain 全部 pending");
        assert!(crashed.load(Ordering::Relaxed), "crashed 必须置位");
        // watch 通道已送达最新值 true（dispatcher 依赖它触发自动重连）
        assert!(*crashed_rx.borrow_and_update(), "watch 最新值必须为 true");
        // 幂等：重复调用不 double-resolve
        let drained_again = super::transport::fail_connection(&crashed, &crashed_watch, &pending);
        assert_eq!(drained_again, 0, "重复调用不得重复 drain");
        assert!(*crashed_rx.borrow_and_update());
    }

    #[tokio::test]
    async fn send_after_crash_returns_connection_closed_without_pending_stall() {
        // A6：模拟 EOF 竞态窗口——pending 注册后于 drain（drain 未 resolve 该 id），
        // 但 reader 已 store crashed。send 成功后复检 crashed 必须立即返回
        // ConnectionClosed 并清理 pending（修复前 send_keep_rx 挂满 300s / complete
        // 挂满 30s 假超时）。
        for complete in [false, true] {
            let (write_tx, _write_rx) = mpsc::channel::<String>(1);
            let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
                Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
            let crashed = Arc::new(AtomicBool::new(true));
            let (_tx, rx) = oneshot::channel();
            let rpc = PreparedRpc {
                id: 7,
                line: "test-line".to_string(),
                write_tx,
                rx,
                pending: pending.clone(),
                crashed,
                rpc_timeout: std::time::Duration::from_secs(30),
            };
            let result = tokio::time::timeout(std::time::Duration::from_secs(2), async move {
                if complete {
                    rpc.complete().await.map(|_| ())
                } else {
                    rpc.send_keep_rx().await.map(|_| ())
                }
            })
            .await
            .expect("crashed path must return immediately, not stall");
            assert!(matches!(result, Err(AcpError::ConnectionClosed)));
            assert!(
                !pending[7 % PENDING_SHARDS].lock().unwrap().contains_key(&7),
                "pending must be cleaned up on the crashed path"
            );
        }
    }

    #[tokio::test]
    async fn fake_acp_session_load_ignores_updates_from_other_sessions() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    elif request.get('method') == 'session/load':
        session_id=request['params']['sessionId']
        updates=[
            (session_id, 'target-1'),
            ('other-session', 'must-not-leak'),
            (session_id, 'target-2'),
        ]
        for update_session, text in updates:
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':update_session,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':text}}}}), flush=True)
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{'loaded':True}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-update-isolation", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("update isolation fake ACP must initialize");
        let (_response, replay) = load_session_with_replay(
            client.replay_handles(),
            "target-session",
            ".",
            Vec::new(),
            McpServersMode::Always,
        )
        .await
        .expect("target session load must succeed");
        let texts: Vec<&str> = replay
            .events
            .iter()
            .filter_map(|params| params["update"]["content"]["text"].as_str())
            .collect();
        assert_eq!(texts, vec!["target-1", "target-2"]);
        assert!(!texts.contains(&"must-not-leak"));
    }

    #[tokio::test]
    async fn fake_acp_session_load_replay_eof_returns_connection_closed() {
        // 优化 3：回放期间 EOF（崩溃）——每轮复检 crashed 立即 ConnectionClosed，
        // 而非依赖 NOTIF_AGENT_CRASHED 广播被跳过（非目标 session/update）后
        // 挂满 30s 假超时。
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    elif request.get('method') == 'session/load':
        session_id=request['params']['sessionId']
        print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'history-1'}}}}), flush=True)
        break
sys.exit(0)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-replay-eof", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP replay EOF agent must initialize");
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            load_session_with_replay(
                client.replay_handles(),
                "fake-session-replay-eof",
                ".",
                Vec::new(),
                McpServersMode::Always,
            ),
        )
        .await
        .expect("replay EOF must fail fast, not hang until the 30s timeout");
        assert!(matches!(result, Err(AcpError::ConnectionClosed)));
        assert!(client.is_crashed(), "EOF must mark the connection crashed");
    }

    #[tokio::test]
    async fn fake_acp_prompt_cancel_returns_final_cancelled_response() {
        let script = r#"import json,sys
prompt_id=None
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    if method == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
    elif method == 'session/prompt':
        prompt_id=request.get('id')
    elif method == 'session/cancel':
        print(json.dumps({'jsonrpc':'2.0','id':prompt_id,'result':{'stopReason':'cancelled'}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("fake-acp-cancel-response", script);
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("cancel-response fake ACP must initialize");
        let rpc = client
            .prepare_prompt(
                "fake-session-cancel-response",
                vec![serde_json::json!({"type":"text","text":"hello"})],
            )
            .expect("prompt must serialize");
        let mut response_rx = rpc.send_keep_rx().await.expect("prompt must write");
        let cancel_tx = client.write_tx.clone();
        let outcome = wait_prompt_with_cancel(
            &mut response_rx,
            std::time::Duration::from_millis(200),
            std::time::Duration::from_millis(20),
            std::time::Duration::from_millis(20),
            || None,
            move || async move {
                cancel_tx
                    .send(
                        serde_json::json!({
                            "jsonrpc": "2.0",
                            "method": METHOD_SESSION_CANCEL,
                            "params": {"sessionId": "fake-session-cancel-response"}
                        })
                        .to_string(),
                    )
                    .await
                    .map_err(|_| "ACP connection closed".to_string())
            },
        )
        .await;
        match outcome {
            PromptWaitOutcome::CancelledAfterTimeout {
                response: Some(raw),
                cancel_error,
            } => {
                assert!(cancel_error.is_none());
                assert_eq!(
                    raw.result
                        .and_then(|value| value.get("stopReason").cloned()),
                    Some(serde_json::json!("cancelled"))
                );
            }
            other => panic!("expected final cancelled response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_response_writes_result_with_matching_id() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-acp-response-{}.jsonl", std::process::id()));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    trace.write(line)
    trace.flush()
    request=json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-response",
            script,
            vec![trace_path.to_string_lossy().into_owned()],
            HashMap::new(),
        );
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let result =
            serde_json::json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}});
        client
            .send_response(42, result.clone())
            .await
            .expect("send_response must write");
        // 等待写通道 flush（fake 脚本逐行写 trace）
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let lines: Vec<serde_json::Value> = trace
            .lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let response = lines
            .iter()
            .find(|line| line.get("id").and_then(|v| v.as_u64()) == Some(42))
            .expect("response line must exist");
        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["result"]["outcome"]["outcome"], "selected");
        assert_eq!(response["result"]["outcome"]["optionId"], "allow_once");
        client.kill().expect("cleanup");
    }

    #[tokio::test]
    async fn fake_acp_initialize_uses_configured_client_capabilities() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-acp-caps-{}.jsonl", std::process::id()));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-caps".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec![
                "-u".to_string(),
                "-c".to_string(),
                script.to_string(),
                trace_path.to_string_lossy().into_owned(),
            ],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: Some(crate::agent_config::AcpProtocolConfig {
                initialize_caps: Some(serde_json::json!({
                    "fs": {},
                    "auth": {},
                    "_meta": {"peri.skillNames": true}
                })),
                ..Default::default()
            }),
        };
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP with configured caps must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let request: serde_json::Value = trace
            .lines()
            .map(|line| serde_json::from_str(line).expect("trace line"))
            .find(|value: &serde_json::Value| {
                value.get("method").and_then(|m| m.as_str()) == Some(METHOD_INITIALIZE)
            })
            .expect("initialize must be traced");
        assert_eq!(
            request["params"]["clientCapabilities"]["fs"],
            serde_json::json!({})
        );
        assert_eq!(
            request["params"]["clientCapabilities"]["_meta"]["peri.skillNames"],
            serde_json::json!(true)
        );
        assert!(
            request["params"]["clientCapabilities"]
                .get("tokenStats")
                .is_none(),
            "覆盖后不再带统一默认 caps"
        );
        // G1-03：未配置的 protocolVersion/clientInfo 保持默认现值（wire 不变）
        assert_eq!(request["params"]["protocolVersion"], serde_json::json!(1));
        assert_eq!(
            request["params"]["clientInfo"],
            serde_json::json!({"name": "Pylon", "version": "1.0.0"})
        );
    }

    #[tokio::test]
    async fn fake_acp_initialize_defaults_to_unified_capabilities() {
        let trace_path = std::env::temp_dir().join(format!(
            "pylon-acp-caps-default-{}.jsonl",
            std::process::id()
        ));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent_with(
            "fake-acp-caps-default",
            script,
            vec![trace_path.to_string_lossy().into_owned()],
            HashMap::new(),
        );
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP with default caps must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let request: serde_json::Value = trace
            .lines()
            .map(|line| serde_json::from_str(line).expect("trace line"))
            .find(|value: &serde_json::Value| {
                value.get("method").and_then(|m| m.as_str()) == Some(METHOD_INITIALIZE)
            })
            .expect("initialize must be traced");
        assert_eq!(
            request["params"]["clientCapabilities"]["tokenStats"],
            serde_json::json!(true)
        );
        assert_eq!(
            request["params"]["clientCapabilities"]["_meta"]["peri.replay"],
            serde_json::json!(true)
        );
        // G1-03：默认路径 protocolVersion/clientInfo 为现状现值（wire 逐字节不变）
        assert_eq!(request["params"]["protocolVersion"], serde_json::json!(1));
        assert_eq!(
            request["params"]["clientInfo"],
            serde_json::json!({"name": "Pylon", "version": "1.0.0"})
        );
    }

    /// G1-03：声明 protocol_version/client_info 后按声明进 wire（覆盖路径）。
    #[tokio::test]
    async fn custom_protocol_version_and_client_info_reach_wire() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-acp-handshake-{}.jsonl", std::process::id()));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-handshake".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: crate::test_utils::test_python_exe().to_string(),
            args: vec![
                "-u".to_string(),
                "-c".to_string(),
                script.to_string(),
                trace_path.to_string_lossy().into_owned(),
            ],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: Some(crate::agent_config::AcpProtocolConfig {
                protocol_version: Some(2),
                client_info: Some(serde_json::json!({"name": "Pylon", "version": "9.9.9"})),
                ..Default::default()
            }),
        };
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP with custom handshake must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let request: serde_json::Value = trace
            .lines()
            .map(|line| serde_json::from_str(line).expect("trace line"))
            .find(|value: &serde_json::Value| {
                value.get("method").and_then(|m| m.as_str()) == Some(METHOD_INITIALIZE)
            })
            .expect("initialize must be traced");
        assert_eq!(
            request["params"]["protocolVersion"],
            serde_json::json!(2),
            "声明的 protocol_version 必须进 wire"
        );
        assert_eq!(
            request["params"]["clientInfo"],
            serde_json::json!({"name": "Pylon", "version": "9.9.9"}),
            "声明的 client_info 必须进 wire"
        );
        // caps 未声明 → 默认统一 caps 不受影响
        assert_eq!(
            request["params"]["clientCapabilities"]["tokenStats"],
            serde_json::json!(true)
        );
    }

    /// 方案 G 演进：hermes_profile 绝对路径 → 子进程 HERMES_HOME 注入。
    /// fake 脚本把 HERMES_HOME 写入 trace 文件，回读断言注入生效。
    #[tokio::test]
    async fn hermes_profile_injects_hermes_home_env() {
        let profile_dir =
            std::env::temp_dir().join(format!("pylon-profile-{}", std::process::id()));
        std::fs::create_dir_all(&profile_dir).unwrap();
        let trace_path =
            std::env::temp_dir().join(format!("pylon-hermes-env-{}.jsonl", std::process::id()));
        let script = r#"import json,sys,os
with open(sys.argv[1],'w',encoding='utf-8') as f:
    f.write(os.environ.get('HERMES_HOME','')+'\n')
print(json.dumps({'jsonrpc':'2.0','id':1,'result':{}}), flush=True)
"#;
        let mut agent = crate::agent_config::AgentDef {
            name: "fake-hermes".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: crate::test_utils::test_python_exe().to_string(),
            args: vec![
                "-u".to_string(),
                "-c".to_string(),
                script.to_string(),
                trace_path.to_string_lossy().into_owned(),
            ],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: true,
            model: None,
            hermes_profile: Some(profile_dir.to_string_lossy().into_owned()),
            acp_args: Vec::new(),
            acp: None,
        };
        // 绝对路径形态不需要 Hermes home 探测，测试不依赖本机环境。
        agent.hermes_profile = Some(profile_dir.to_string_lossy().into_owned());
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake hermes must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read env trace");
        std::fs::remove_file(&trace_path).ok();
        std::fs::remove_dir_all(&profile_dir).ok();
        assert_eq!(
            trace.trim(),
            profile_dir.to_string_lossy(),
            "HERMES_HOME 必须注入为 hermes_profile 解析目录"
        );
    }

    /// 方案 G 演进：未配置 hermes_profile 时不注入 HERMES_HOME（现状行为不回归）。
    #[tokio::test]
    async fn unset_hermes_profile_does_not_inject_env() {
        let trace_path =
            std::env::temp_dir().join(format!("pylon-hermes-noenv-{}.jsonl", std::process::id()));
        let script = r#"import json,sys,os
with open(sys.argv[1],'w',encoding='utf-8') as f:
    f.write(os.environ.get('HERMES_HOME','<absent>')+'\n')
print(json.dumps({'jsonrpc':'2.0','id':1,'result':{}}), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-hermes-plain".to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: crate::test_utils::test_python_exe().to_string(),
            args: vec![
                "-u".to_string(),
                "-c".to_string(),
                script.to_string(),
                trace_path.to_string_lossy().into_owned(),
            ],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: true,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        };
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake hermes must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read env trace");
        std::fs::remove_file(&trace_path).ok();
        // 子进程默认继承 Pylon 进程环境——测试进程若本身有 HERMES_HOME 则透传。
        // 断言只能区分"显式注入的 profile 路径"与"未注入"两种：未配置时子进程
        // 读到的是进程环境原值（非注入产物），不可能等于临时 profile 目录。
        assert_ne!(
            trace.trim(),
            format!(
                "{}",
                std::env::temp_dir()
                    .join(format!("pylon-profile-{}", std::process::id()))
                    .to_string_lossy()
            ),
            "未配置 hermes_profile 时不得注入临时 profile 路径"
        );
    }

    fn process_exists(pid: u32) -> bool {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}
