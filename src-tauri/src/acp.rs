//! ACP Client — spawn peri.exe as child process, JSON-RPC over stdin/stdout.
//!
//! Architecture: one dedicated reader thread dispatches messages by request_id
//! to per-session channels. No lock contention between concurrent sessions.
//! stderr is drained in a background thread to prevent pipe buffer deadlock.

use base64::Engine;
use std::collections::HashMap;
use std::future::Future;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::{broadcast, mpsc, oneshot};

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
pub const NOTIF_AGENT_CRASHED: &str = "pylon:agent-crashed";

// ── 类型化参数构造（官方 agent-client-protocol-schema v1）──
//
// 核心字段（sessionId/cwd/configId/value/modeId/prompt）用官方 Request 类型
// 构造，wire 格式由 schema 保证；扩展字段（mcpServers）保持 Value 直传——
// Pylon 的 MCP 配置格式（stdio 无 name）与官方 McpServer 不兼容，不能强转。
use agent_client_protocol_schema::v1::{
    CloseSessionRequest, ContentBlock, LoadSessionRequest, NewSessionRequest, PromptRequest,
    SetSessionConfigOptionRequest, SetSessionModeRequest,
};

fn to_params<T: serde::Serialize>(req: &T, what: &str) -> Result<serde_json::Value, String> {
    serde_json::to_value(req).map_err(|e| format!("serialize {what} params: {e}"))
}

fn content_blocks_from_values(values: Vec<serde_json::Value>) -> Result<Vec<ContentBlock>, String> {
    values.into_iter()
        .map(|v| serde_json::from_value(v).map_err(|e| format!("invalid prompt block: {e}")))
        .collect()
}

/// session/new 参数。mcpServers 以 Pylon 自有格式直传（官方 McpServer 需 name 字段）。
pub fn session_new_params(cwd: &str, mcp_servers: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    let req = NewSessionRequest::new(cwd.to_string());
    let mut params = to_params(&req, "session/new")?;
    if let Some(obj) = params.as_object_mut() {
        obj.insert("mcpServers".into(), serde_json::Value::Array(mcp_servers));
    }
    Ok(params)
}

/// session/load 参数。仅被 [`AcpClient::load_session_params`] 包装使用。
fn session_load_params(session_id: &str, cwd: &str, mcp_servers: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    let req = LoadSessionRequest::new(session_id.to_string(), cwd.to_string());
    let mut params = to_params(&req, "session/load")?;
    if let Some(obj) = params.as_object_mut() {
        obj.insert("mcpServers".into(), serde_json::Value::Array(mcp_servers));
    }
    Ok(params)
}

/// session/set_mode 参数。
pub fn session_set_mode_params(session_id: &str, mode: &str) -> Result<serde_json::Value, String> {
    let req = SetSessionModeRequest::new(session_id.to_string(), mode.to_string());
    to_params(&req, "session/set_mode")
}

/// session/set_config_option 参数（ValueId 平铺：{"configId","value"}）。
pub fn session_set_config_option_params(session_id: &str, key: &str, value: &str) -> Result<serde_json::Value, String> {
    let req = SetSessionConfigOptionRequest::new(
        session_id.to_string(),
        key.to_string(),
        value, // &str → SessionConfigOptionValue via From<&str>（ValueId）
    );
    to_params(&req, "session/set_config_option")
}

/// session/prompt 参数。仅被 [`AcpClient::prepare_prompt`] 内部使用。
fn session_prompt_params(session_id: &str, prompt: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
    let req = PromptRequest::new(session_id.to_string(), content_blocks_from_values(prompt)?);
    to_params(&req, "session/prompt")
}

/// session/close 参数。
pub fn session_close_params(session_id: &str) -> Result<serde_json::Value, String> {
    let req = CloseSessionRequest::new(session_id.to_string());
    to_params(&req, "session/close")
}

/// session/set_model 参数（Hermes unstable 扩展，字段与官方 SetSessionModelRequest 一致）。
pub fn session_set_model_params(session_id: &str, model_id: &str) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "sessionId": session_id,
        "modelId": model_id,
    }))
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

/// Broadcast channel capacity for ACP message fan-out.
pub const BROADCAST_CAP: usize = 256;
/// mpsc channel capacity for stdin writes — bounded to provide backpressure.
pub const WRITE_CHAN_CAP: usize = 256;
/// Default prompt timeout in seconds.
pub const PROMPT_TIMEOUT_SECS: u64 = 300;
/// Maximum time to wait for Peri's final prompt response after sending cancel.
pub const CANCEL_SETTLE_TIMEOUT_SECS: u64 = 30;
/// Write-channel send timeout. The writer thread blocks on writeln!/flush while the
/// agent is busy reading nothing, filling the mpsc; without a timeout `send().await`
/// hangs forever, breaking the 30s RPC timeout contract above. Timeout is treated as
/// a connection failure (warn + Err).
const WRITE_TIMEOUT_SECS: u64 = 10;
/// Maximum size for a single attachment.
pub const MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;
/// Maximum number of attachments in one prompt.
pub const MAX_ATTACHMENTS: usize = 8;

type Pending = HashMap<u64, oneshot::Sender<RawMessage>>;
const PENDING_SHARDS: usize = 16;

struct ManagedChild {
    child: Option<Child>,
}

impl ManagedChild {
    fn empty() -> Self {
        Self { child: None }
    }

    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn take_stdin(&mut self) -> Result<std::process::ChildStdin, String> {
        self.child
            .as_mut()
            .and_then(|child| child.stdin.take())
            .ok_or_else(|| "no stdin".to_string())
    }

    fn take_stdout(&mut self) -> Result<std::process::ChildStdout, String> {
        self.child
            .as_mut()
            .and_then(|child| child.stdout.take())
            .ok_or_else(|| "no stdout".to_string())
    }

    fn take_stderr(&mut self) -> Result<std::process::ChildStderr, String> {
        self.child
            .as_mut()
            .and_then(|child| child.stderr.take())
            .ok_or_else(|| "no stderr".to_string())
    }

    /// Windows：`taskkill /T /F` 递归杀进程树（`Child::kill` 只杀直接子进程，
    /// peri/hermes 派生的子进程会残留）。进程已退出时 taskkill 报错——静默返回
    /// false，由调用方回退普通 kill 路径。
    #[cfg(windows)]
    fn kill_process_tree(pid: u32) -> bool {
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn kill_and_wait(&mut self) -> Result<(), String> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            Ok(None) => {
                #[cfg(windows)]
                if Self::kill_process_tree(child.id()) {
                    // taskkill /T 已杀整个进程树；wait 回收句柄（进程可能已
                    // 抢先退出，wait 报错仅记 warn，不视为失败）。
                    if let Err(error) = child.wait() {
                        log::warn!("wait after taskkill: {error}");
                    }
                    return Ok(());
                }
                child.kill().map_err(|error| format!("kill failed: {error}"))?;
                child.wait().map_err(|error| format!("wait failed: {error}"))?;
                Ok(())
            }
            Err(error) => {
                // try_wait 失败时仍必须继续清理，不能把已取出的 Child
                // 直接丢弃，否则 initialize/switch/Drop 错误路径可能遗留子进程。
                let kill_result = child.kill();
                let wait_result = child.wait();
                match (kill_result, wait_result) {
                    (Ok(()), Ok(_)) => Err(format!("try_wait failed: {error}; child killed and waited")),
                    (kill_error, wait_error) => Err(format!(
                        "try_wait failed: {error}; kill: {}; wait: {}",
                        kill_error.map(|_| "ok".to_string()).unwrap_or_else(|err| err.to_string()),
                        wait_error.map(|_| "ok".to_string()).unwrap_or_else(|err| err.to_string()),
                    )),
                }
            }
        }
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        if let Err(error) = self.kill_and_wait() {
            log::warn!("cleanup ACP child: {}", error);
        }
    }
}

pub struct AcpClient {
    child: ManagedChild,
    /// mpsc channel for writing JSON-RPC lines to stdin. Single consumer = no lock contention.
    pub(crate) write_tx: mpsc::Sender<String>,
    next_id: AtomicU64,
    pending: Arc<[Mutex<Pending>; PENDING_SHARDS]>,
    /// Broadcast channel for all received messages (responses + notifications).
    pub rx: broadcast::Receiver<RawMessage>,
    /// Set when the child process exits unexpectedly.
    pub crashed: Arc<AtomicBool>,
}
#[derive(Debug, Clone)]
pub struct RawMessage {
    pub id: Option<u64>,
    pub method: Option<String>,
    pub result: Option<serde_json::Value>,
    pub params: Option<serde_json::Value>,
    pub error: Option<serde_json::Value>,
}

/// 一次 RPC 的同步准备阶段产物：id（用于清理 pending）、序列化行、写通道、响应接收器。
/// 携带 pending 分片引用——锁外发送/等待/清理不需要再持有 AcpClient。
pub struct PreparedRpc {
    pub id: u64,
    pub line: String,
    pub write_tx: mpsc::Sender<String>,
    pub rx: oneshot::Receiver<RawMessage>,
    pending: Arc<[Mutex<Pending>; PENDING_SHARDS]>,
}

impl RawMessage {
    fn connection_closed() -> Self {
        Self {
            id: None,
            method: None,
            result: None,
            params: None,
            error: Some(serde_json::json!("ACP connection closed")),
        }
    }
}

#[derive(Debug)]
pub enum PromptWaitOutcome {
    Response(RawMessage),
    CancelledAfterTimeout {
        response: Option<RawMessage>,
        cancel_error: Option<String>,
    },
    ConnectionClosed,
}

/// Wait for a prompt response. On timeout, send session/cancel and keep the
/// response receiver alive until Peri confirms the cancelled turn has settled.
pub async fn wait_prompt_with_cancel<F, Fut>(
    rx: &mut oneshot::Receiver<RawMessage>,
    prompt_timeout: std::time::Duration,
    cancel_settle_timeout: std::time::Duration,
    cancel: F,
) -> PromptWaitOutcome
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    match tokio::time::timeout(prompt_timeout, &mut *rx).await {
        Ok(Ok(raw)) => PromptWaitOutcome::Response(raw),
        Ok(Err(_)) => PromptWaitOutcome::ConnectionClosed,
        Err(_) => {
            let cancel_error = match tokio::time::timeout(
                std::time::Duration::from_secs(WRITE_TIMEOUT_SECS),
                cancel(),
            )
            .await
            {
                Ok(result) => result.err(),
                Err(_) => {
                    log::warn!("ACP: cancel timed out after {WRITE_TIMEOUT_SECS}s");
                    Some("ACP write timeout".to_string())
                }
            };
            let response = match tokio::time::timeout(cancel_settle_timeout, &mut *rx).await {
                Ok(Ok(raw)) => Some(raw),
                Ok(Err(_)) | Err(_) => None,
            };
            PromptWaitOutcome::CancelledAfterTimeout {
                response,
                cancel_error,
            }
        }
    }
}

/// 写通道发送统一入口：10s 超时防 writer 阻塞击穿超时契约——agent 忙碌不读 stdin
/// 时 writer 线程阻塞在 writeln!/flush，256 容量 mpsc 填满后 send 无限挂起。
/// 超时视为连接故障（warn 日志 + Err），由调用方按连接故障收敛。
async fn send_line(tx: mpsc::Sender<String>, line: String) -> Result<(), String> {
    match tokio::time::timeout(std::time::Duration::from_secs(WRITE_TIMEOUT_SECS), tx.send(line)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err("ACP connection closed".to_string()),
        Err(_) => {
            log::warn!("ACP write timeout after {WRITE_TIMEOUT_SECS}s: connection presumed dead");
            Err("ACP write timeout".to_string())
        }
    }
}

impl AcpClient {
    pub fn disconnected() -> Self {
        let (write_tx, write_rx) = mpsc::channel(1);
        drop(write_rx);
        let (_tx, rx) = broadcast::channel(BROADCAST_CAP);
        Self {
            child: ManagedChild::empty(),
            write_tx,
            next_id: AtomicU64::new(1),
            pending: Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new()))),
            rx,
            crashed: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn drain_pending(pending: &Arc<[Mutex<Pending>; PENDING_SHARDS]>) -> usize {
        let mut drained = 0;
        for shard in pending.iter() {
            if let Ok(mut requests) = shard.lock() {
                drained += requests.len();
                for (_, tx) in requests.drain() {
                    let _ = tx.send(RawMessage::connection_closed());
                }
            }
        }
        drained
    }

    pub fn remove_pending(&self, id: u64) {
        if let Ok(mut pending) = self.pending_shard(id).lock() {
            pending.remove(&id);
        }
    }

    fn pending_shard(&self, id: u64) -> &Mutex<Pending> {
        &self.pending[id as usize % PENDING_SHARDS]
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
    ) -> Result<(u64, String), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        if let Some(tx) = pending_tx {
            let mut pending = self.pending_shard(id).lock().map_err(|e| e.to_string())?;
            pending.insert(id, tx);
        }
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = match serde_json::to_string(&req) {
            Ok(line) => line,
            Err(error) => {
                self.remove_pending(id);
                return Err(format!("serialize failed: {}", error));
            }
        };
        Ok((id, line))
    }

    /// Send a JSON-RPC request and wait for the matching response.
    /// 同步准备一次 JSON-RPC 请求（注册 pending + 序列化），不写入 stdin。
    /// 调用方持锁只覆盖本方法；发送与等待经 [`Self::complete_rpc`] 在锁外进行，
    /// 避免 Peri 卡顿时全局串行化（一个慢 RPC 阻塞所有其他命令）。
    pub fn prepare_rpc(&self, method: &str, params: serde_json::Value) -> Result<PreparedRpc, String> {
        if self.is_crashed() {
            return Err("ACP connection closed".to_string());
        }
        let (tx, rx) = oneshot::channel();
        let (id, line) = self.register_request(method, &params, Some(tx))?;
        Ok(PreparedRpc {
            id,
            line,
            write_tx: self.write_tx.clone(),
            rx,
            pending: self.pending.clone(),
        })
    }

    /// 发送已准备的 RPC 并等待匹配响应（30s 超时）。不依赖 AcpClient 实例，可在锁外执行。
    pub async fn complete_rpc(rpc: PreparedRpc) -> Result<serde_json::Value, String> {
        let PreparedRpc { id, line, write_tx, rx, pending } = rpc;
        let remove_pending = |id: u64| {
            if let Ok(mut p) = pending[id as usize % PENDING_SHARDS].lock() {
                p.remove(&id);
            }
        };
        if let Err(error) = send_line(write_tx, line).await {
            remove_pending(id);
            return Err(error);
        }
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(msg)) => msg,
            Ok(Err(_)) => {
                remove_pending(id);
                return Err("ACP connection closed".to_string());
            }
            Err(_) => {
                remove_pending(id);
                return Err("RPC timeout after 30s".to_string());
            }
        };
        if let Some(err) = msg.error {
            return Err(format!("RPC error: {}", err));
        }
        Ok(msg.result.unwrap_or(serde_json::Value::Null))
    }

    async fn call_async(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let rpc = self.prepare_rpc(method, params)?;
        Self::complete_rpc(rpc).await
    }

    /// Extract and validate sessionId from a session/new response.
    pub fn session_id_from(response: &serde_json::Value) -> Result<String, String> {
        let session_id = response.get("sessionId")
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("invalid session/new response: {response}"))?
            .trim();
        if session_id.is_empty() || session_id.eq_ignore_ascii_case("error") {
            return Err(format!("session/new failed: invalid sessionId {session_id:?}"));
        }
        Ok(session_id.to_string())
    }

    /// Validate a session/prompt response and return its stop reason.
    pub fn prompt_stop_reason(response: &serde_json::Value) -> Result<&str, String> {
        let stop_reason = response.get("stopReason")
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("invalid session/prompt response: {response}"))?;
        match stop_reason {
            "end_turn" | "max_turn_requests" => Ok(stop_reason),
            "cancelled" => Err("prompt cancelled".to_string()),
            "refusal" => Err("prompt refused by agent".to_string()),
            other => Err(format!("unsupported prompt stopReason: {other}")),
        }
    }

    /// Build prompt blocks (text + attachments) for session/prompt.
    pub fn prompt_blocks(text: String, attachments: &[String]) -> Result<Vec<serde_json::Value>, String> {
        if attachments.len() > MAX_ATTACHMENTS {
            return Err(format!("too many attachments: maximum is {MAX_ATTACHMENTS}"));
        }
        let mut blocks = vec![serde_json::json!({"type": "text", "text": text})];
        for raw_path in attachments {
            let path = std::path::Path::new(raw_path);
            let metadata = std::fs::metadata(path)
                .map_err(|error| format!("attachment metadata failed for {}: {error}", path.display()))?;
            if !metadata.is_file() {
                return Err(format!("attachment is not a file: {}", path.display()));
            }
            if metadata.len() > MAX_ATTACHMENT_BYTES {
                return Err(format!(
                    "attachment too large: {} is {} bytes, maximum is {} bytes",
                    path.display(), metadata.len(), MAX_ATTACHMENT_BYTES
                ));
            }
            let bytes = std::fs::read(path)
                .map_err(|error| format!("attachment read failed for {}: {error}", path.display()))?;
            let mime = infer::get(&bytes).map(|kind| kind.mime_type());
            match mime {
                Some(mime) if matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp") => {
                    blocks.push(serde_json::json!({
                        "type": "image",
                        "mimeType": mime,
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                    }));
                }
                Some(mime) if mime.starts_with("text/") => {
                    let content = String::from_utf8(bytes)
                        .map_err(|error| format!("attachment is not valid UTF-8 text {}: {error}", path.display()))?;
                    blocks.push(serde_json::json!({"type": "text", "text": content}));
                }
                None => {
                    let content = String::from_utf8(bytes)
                        .map_err(|_| format!("unsupported attachment type: {}", path.display()))?;
                    blocks.push(serde_json::json!({"type": "text", "text": content}));
                }
                Some(mime) => return Err(format!("unsupported attachment MIME {mime}: {}", path.display())),
            }
        }
        Ok(blocks)
    }

    /// Prepare a prompt request without writing to stdin.
    pub fn prepare_prompt(&self, session_id: &str, prompt: Vec<serde_json::Value>) -> Result<(u64, String, oneshot::Receiver<RawMessage>), String> {
        // 审查修复：与 prepare_rpc 一致，死亡连接立即拒绝（否则挂满 300s 假超时）
        if self.is_crashed() {
            return Err("ACP connection closed".to_string());
        }
        // 先构造参数（可能因 block 格式失败），成功后再注册 pending，避免泄漏。
        let params = session_prompt_params(session_id, prompt)?;
        let (tx, rx) = oneshot::channel();
        let (id, line) = self.register_request(METHOD_SESSION_PROMPT, &params, Some(tx))?;
        Ok((id, line, rx))
    }

    /// Kill the child process. Called before switching agents to prevent orphans.
    pub fn kill(&mut self) -> Result<(), String> {
        self.child.kill_and_wait()
    }

    /// Check if the child process has exited unexpectedly.
    pub fn is_crashed(&self) -> bool {
        self.crashed.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    fn child_id(&self) -> Option<u32> {
        self.child.child.as_ref().map(Child::id)
    }

    /// Send a fire-and-forget notification (no id, no response expected).
    /// 仅被 [`Self::cancel_session`] 调用。
    async fn send_notification(&self, method: &str, params: serde_json::Value) -> Result<(), String> {
        if self.is_crashed() {
            return Err("ACP connection closed".to_string());
        }
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&req).map_err(|e| format!("serialize failed: {}", e))?;
        send_line(self.write_tx.clone(), line).await
    }

    /// 应答 agent 发来的 JSON-RPC 请求（B9：session/request_permission）。
    /// agent 侧 send_request 等待同 id 响应，不应答会挂起直到超时。
    pub async fn send_response(&self, id: u64, result: serde_json::Value) -> Result<(), String> {
        if self.is_crashed() {
            return Err("ACP connection closed".to_string());
        }
        let line = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        });
        let line = serde_json::to_string(&line).map_err(|e| format!("serialize failed: {e}"))?;
        send_line(self.write_tx.clone(), line).await
    }

    /// Cancel a running prompt. Fire-and-forget notification.
    pub async fn cancel_session(&self, session_id: &str) -> Result<(), String> {
        self.send_notification(METHOD_SESSION_CANCEL, serde_json::json!({
            "sessionId": session_id
        })).await
    }

    /// Connect from AgentDef with optional structured runtime log sink.
    pub async fn connect_with_logs(
        agent: &crate::agent_config::AgentDef,
        runtime_logs: Option<Arc<crate::runtime_log::RuntimeLogHub>>,
    ) -> Result<Self, String> {
        let resolved_agent;
        let agent = if let Some(config_path) = crate::agent_config::effective_config_path() {
            let base_dir = config_path.parent().unwrap_or_else(|| std::path::Path::new("."));
            resolved_agent = agent.resolve_paths(base_dir);
            &resolved_agent
        } else {
            agent
        };
        match agent.transport.as_str() {
            "subprocess" => {
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
                let child = cmd.spawn()
                    .map_err(|e| format!("spawn {} failed: {}", &agent.exe, e))?;
                let mut child = ManagedChild::new(child);

                let stdin = child.take_stdin()?;
                let (write_tx, mut write_rx) = mpsc::channel::<String>(WRITE_CHAN_CAP);
                // Spawn single-consumer writer task — writes JSON-RPC lines to stdin, with newline
                std::thread::spawn(move || {
                    let mut writer = BufWriter::new(stdin);
                    while let Some(line) = write_rx.blocking_recv() {
                        if writeln!(writer, "{}", line).is_err() { break; }
                        if writer.flush().is_err() { break; }
                    }
                });
                let stdout = BufReader::new(child.take_stdout()?);

                // Drain stderr
                let stderr = child.take_stderr()?;
                let agent_name_stderr = agent.name.clone();
                let stderr_logs = runtime_logs.clone();
                std::thread::spawn(move || {
                    for line in BufReader::new(stderr).lines() {
                        if let Ok(l) = line {
                            if !l.is_empty() {
                                let safe = crate::runtime_log::sanitize_message(l.clone());
                                log::error!("{} stderr: {}", agent_name_stderr, safe);
                                if let Some(hub) = &stderr_logs {
                                    hub.push(crate::runtime_log::timestamp(), "error", "agent-stderr", None, "Agent stderr output", serde_json::Map::from_iter([
                                        ("agent".to_string(), serde_json::Value::String(agent_name_stderr.clone())),
                                    ]));
                                }
                            }
                        }
                    }
                });

                let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
                    Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
                let (tx, rx) = broadcast::channel(BROADCAST_CAP);
                let crashed = Arc::new(AtomicBool::new(false));

                let pending_clone = pending.clone();
                let tx_clone = tx.clone();
                let crashed_reader = crashed.clone();
                let stdout_logs = runtime_logs.clone();
                std::thread::spawn(move || {
                    for line in stdout.lines() {
                        let line = match line { Ok(l) => l, Err(_) => break };
                        let line = line.trim().to_string();
                        if line.is_empty() { continue; }
                        let msg_val: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(e) => {
                                log::error!("ACP parse: {}", e);
                                if let Some(hub) = &stdout_logs {
                                    hub.push(crate::runtime_log::timestamp(), "error", "acp", None, "ACP stdout JSON parse error", serde_json::Map::from_iter([
                                        ("error".to_string(), serde_json::Value::String(e.to_string())),
                                    ]));
                                }
                                continue;
                            }
                        };
                        let raw = RawMessage {
                            id: msg_val.get("id").and_then(|v| v.as_u64()),
                            method: msg_val.get("method").and_then(|v| v.as_str()).map(|s| s.to_string()),
                            result: msg_val.get("result").cloned(),
                            params: msg_val.get("params").cloned(),
                            error: msg_val.get("error").cloned(),
                        };
                        let _ = tx_clone.send(raw.clone());
                        if raw.method.is_none() {
                            if let Some(id) = raw.id {
                                let shard = &pending_clone[id as usize % PENDING_SHARDS];
                                match shard.lock() {
                                    Ok(mut p) => {
                                        if let Some(tx) = p.remove(&id) { let _ = tx.send(raw); }
                                    }
                                    Err(_) => {
                                        // poison 时无法 resolve pending，标记 crashed 让上层收敛，
                                        // 避免读线程 panic 后 pending 悬挂到超时。
                                        crashed_reader.store(true, Ordering::Relaxed);
                                        log::error!("ACP: pending shard lock poisoned for id {id}");
                                    }
                                }
                            }
                        }
                    }
                    crashed_reader.store(true, Ordering::Relaxed);
                    let drained = Self::drain_pending(&pending_clone);
                    log::warn!("ACP: drained {} pending requests after stdout closed", drained);
                    let _ = tx_clone.send(RawMessage {
                        id: None,
                        method: Some(NOTIF_AGENT_CRASHED.to_string()),
                        result: None,
                        params: Some(serde_json::json!({"reason": "stdout_closed"})),
                        error: None,
                    });
                    if let Some(hub) = &stdout_logs {
                        hub.push(crate::runtime_log::timestamp(), "error", "acp", None, "ACP child stdout closed; agent crashed", serde_json::Map::new());
                    }
                    log::error!("ACP: child process stdout closed (agent crashed)");
                });

                let client = AcpClient {
                    child, write_tx, next_id: AtomicU64::new(1), pending, rx,
                    crashed,
                };
                // Initialize——clientCapabilities 支持 per-agent 覆盖（差异字典外置，
                // agents.yaml `acp.initialize_caps`）；缺省 = 统一默认（tokenStats +
                // _meta.peri.*，Hermes 忽略无害）。差异适配表见 acp.rs 头部注释与手册 §3.3。
                let capabilities = agent.acp
                    .as_ref()
                    .and_then(|acp| acp.initialize_caps.clone())
                    .unwrap_or_else(|| serde_json::json!({
                        "tokenStats": true,
                        "_meta": {
                            "peri.tokenStats": true,
                            "peri.skillNames": true,
                            "peri.replay": true
                        }
                    }));
                client.call_async(METHOD_INITIALIZE, serde_json::json!({
                    "protocolVersion": 1,
                    "clientCapabilities": capabilities,
                    "clientInfo": {"name": "Pylon", "version": "0.1.0"}
                })).await?;
                Ok(client)
            }
            other => Err(format!("unsupported transport: {}", other)),
        }
    }

    fn load_session_params(session_id: &str, cwd: &str, mcp_servers: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
        // ACP schema 1.4 LoadSessionRequest.mcp_servers 无 default（Hermes Pydantic 必填），
        // 字段必须存在；Peri 的 DefaultOnError 容忍缺失/空。无配置时传空数组而非缺字段。
        session_load_params(session_id, cwd, mcp_servers)
    }

    /// Load a persisted session and collect every replay notification before the response.
    /// The reader publishes notifications before resolving the matching response, so
    /// observing the response on this broadcast receiver is the deterministic replay boundary.
    pub async fn load_session_with_replay(
        &self,
        session_id: &str,
        cwd: &str,
        mcp_servers: Vec<serde_json::Value>,
    ) -> Result<(serde_json::Value, Vec<serde_json::Value>), String> {
        // 审查修复：与 prepare_rpc 一致，死亡连接立即拒绝
        if self.is_crashed() {
            return Err("ACP connection closed".to_string());
        }
        let mut events = self.rx.resubscribe();
        // 回放与响应均经 broadcast 收集，无需注册 pending：旧代码的 (tx, _rx)
        // 条目永不消费（reader 对已丢弃 rx 的 tx.send 必然失败），确认无功能
        // 依赖后删除；id 仅用于在广播流中匹配响应。
        let params = Self::load_session_params(session_id, cwd, mcp_servers)?;
        let (id, line) = self.register_request(METHOD_SESSION_LOAD, &params, None)?;
        if let Err(error) = send_line(self.write_tx.clone(), line).await {
            return Err(error);
        }

        let mut replay = Vec::new();
        loop {
            let raw = match tokio::time::timeout(std::time::Duration::from_secs(30), events.recv()).await {
                Ok(Ok(raw)) => raw,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(count))) => {
                    return Err(format!("session/load replay lagged by {count} messages"));
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                    return Err("ACP notification stream closed during session/load".to_string());
                }
                Err(_) => {
                    return Err("session/load replay timed out after 30s".to_string());
                }
            };
            if raw.method.as_deref() == Some(NOTIF_SESSION_UPDATE)
                && raw.params.as_ref().and_then(|params| params.get("sessionId")).and_then(|value| value.as_str()) == Some(session_id)
            {
                if let Some(params) = raw.params {
                    replay.push(params);
                }
                continue;
            }
            if raw.id != Some(id) {
                continue;
            }
            if let Some(error) = raw.error {
                return Err(format!("RPC error: {error}"));
            }
            return Ok((raw.result.unwrap_or(serde_json::Value::Null), replay));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// 测试辅助：经 prepare_rpc + complete_rpc 创建会话（生产调用点已锁外化）。
    async fn new_session_rpc(client: &AcpClient) -> Result<serde_json::Value, String> {
        AcpClient::complete_rpc(
            client
                .prepare_rpc(METHOD_SESSION_NEW, serde_json::json!({"cwd": ".", "mcpServers": []}))?,
        )
        .await
    }

    /// 测试辅助：经 prepare_rpc + complete_rpc 关闭会话。
    async fn close_session_rpc(client: &AcpClient, session_id: &str) -> Result<(), String> {
        AcpClient::complete_rpc(
            client
                .prepare_rpc(METHOD_SESSION_CLOSE, serde_json::json!({"sessionId": session_id}))?,
        )
        .await?;
        Ok(())
    }

    fn response() -> RawMessage {
        RawMessage {
            id: Some(1),
            method: None,
            result: Some(serde_json::json!({"stopReason": "cancelled"})),
            params: None,
            error: None,
        }
    }

    #[test]
    fn disconnected_client_is_not_marked_as_crashed() {
        assert!(!AcpClient::disconnected().is_crashed());
    }

    #[test]
    fn session_load_params_include_mcp_servers_field() {
        assert_eq!(
            AcpClient::load_session_params("session-1", "G:/workspace", Vec::new()).unwrap(),
            serde_json::json!({
                "sessionId": "session-1",
                "cwd": "G:/workspace",
                "mcpServers": [],
            })
        );
    }

    #[test]
    fn rejects_empty_and_error_session_ids() {
        for session_id in ["", "   ", "error", "ERROR"] {
            let response = serde_json::json!({"sessionId": session_id});
            assert!(AcpClient::session_id_from(&response).is_err());
        }
    }

    #[test]
    fn accepts_valid_session_id_after_trimming_whitespace() {
        let response = serde_json::json!({"sessionId": "  session-42  "});
        assert_eq!(AcpClient::session_id_from(&response).unwrap(), "session-42");
    }

    #[test]
    fn validates_prompt_stop_reasons() {
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "end_turn"})),
            Ok("end_turn")
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "max_turn_requests"})),
            Ok("max_turn_requests")
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "cancelled"}))
                .expect_err("cancelled must not complete normally"),
            "prompt cancelled"
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "refusal"}))
                .expect_err("refusal must not complete normally"),
            "prompt refused by agent"
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "paused"}))
                .expect_err("unknown stop reason must be rejected"),
            "unsupported prompt stopReason: paused"
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({}))
                .expect_err("missing stop reason must be rejected"),
            "invalid session/prompt response: {}"
        );
    }

    #[test]
    fn prompt_without_attachments_contains_one_text_block() {
        let blocks = AcpClient::prompt_blocks("hello".to_string(), &[]).unwrap();
        assert_eq!(blocks, vec![serde_json::json!({"type": "text", "text": "hello"})]);
    }

    #[test]
    fn prompt_rejects_more_than_maximum_attachments() {
        let attachments = vec!["missing.txt".to_string(); MAX_ATTACHMENTS + 1];
        let error = AcpClient::prompt_blocks("hello".to_string(), &attachments)
            .expect_err("attachment count limit must be enforced before file access");
        assert_eq!(error, format!("too many attachments: maximum is {MAX_ATTACHMENTS}"));
    }

    #[test]
    fn prompt_rejects_missing_attachment_with_explicit_error() {
        let error = AcpClient::prompt_blocks(
            "hello".to_string(),
            &["definitely-missing-pylon-attachment.txt".to_string()],
        )
        .expect_err("missing attachment must fail");
        assert!(error.starts_with("attachment metadata failed for definitely-missing-pylon-attachment.txt:"));
    }

    #[test]
    fn prompt_rejects_directory_attachment() {
        let directory = std::env::temp_dir().join(format!("pylon-attachment-dir-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let error = AcpClient::prompt_blocks("hello".to_string(), &[directory.to_string_lossy().into_owned()])
            .expect_err("directory attachment must fail");
        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(error, format!("attachment is not a file: {}", directory.display()));
    }

    #[test]
    fn prompt_rejects_unknown_binary_attachment() {
        let path = std::env::temp_dir().join(format!("pylon-attachment-binary-{}.bin", std::process::id()));
        std::fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
        let error = AcpClient::prompt_blocks("hello".to_string(), &[path.to_string_lossy().into_owned()])
            .expect_err("unknown binary attachment must fail");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(error, format!("unsupported attachment type: {}", path.display()));
    }

    #[tokio::test]
    async fn timeout_sends_cancel_and_waits_for_final_response() {
        let (tx, mut rx) = oneshot::channel();
        let cancel_called = Arc::new(AtomicBool::new(false));
        let cancel_called_for_task = cancel_called.clone();

        let outcome = wait_prompt_with_cancel(
            &mut rx,
            std::time::Duration::from_millis(10),
            std::time::Duration::from_millis(200),
            move || async move {
                cancel_called_for_task.store(true, Ordering::SeqCst);
                tx.send(response()).map_err(|_| "receiver closed".to_string())
            },
        )
        .await;

        assert!(cancel_called.load(Ordering::SeqCst));
        match outcome {
            PromptWaitOutcome::CancelledAfterTimeout { response, cancel_error } => {
                assert!(cancel_error.is_none());
                assert_eq!(
                    response.and_then(|raw| raw.result)
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
            std::time::Duration::from_secs(1),
            std::time::Duration::from_millis(10),
            move || async move {
                cancel_called_for_task.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;

        assert!(!cancel_called.load(Ordering::SeqCst));
        assert!(matches!(outcome, PromptWaitOutcome::Response(_)));
    }

    #[test]
    fn drain_pending_notifies_every_waiter_and_clears_registry() {
        let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
            Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
        let mut receivers = Vec::new();
        for id in [1_u64, 16, 31] {
            let (tx, rx) = oneshot::channel();
            pending[id as usize % PENDING_SHARDS].lock().unwrap().insert(id, tx);
            receivers.push(rx);
        }

        assert_eq!(AcpClient::drain_pending(&pending), 3);
        assert!(pending.iter().all(|shard| shard.lock().unwrap().is_empty()));
        for receiver in receivers {
            let message = receiver.blocking_recv().expect("EOF should wake pending request");
            assert_eq!(message.error, Some(serde_json::json!("ACP connection closed")));
        }
    }

    #[test]
    fn drain_pending_is_idempotent_after_first_close() {
        let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
            Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
        assert_eq!(AcpClient::drain_pending(&pending), 0);
        assert_eq!(AcpClient::drain_pending(&pending), 0);
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
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let child_id = client.child_id().expect("fake ACP child must exist");
        let new_response = AcpClient::complete_rpc(
            client
                .prepare_rpc(METHOD_SESSION_NEW, serde_json::json!({"cwd": ".", "mcpServers": []}))
                .expect("session/new must prepare"),
        )
        .await
        .expect("session/new must succeed");
        assert_eq!(AcpClient::session_id_from(&new_response).unwrap(), "fake-session-1");

        let (request_id, prompt_line, mut response_rx) = client
            .prepare_prompt("fake-session-1", vec![serde_json::json!({"type":"text","text":"hello"})])
            .expect("prompt must serialize");
        assert!(prompt_line.contains("session/prompt"));
        client.write_tx.send(prompt_line).await.expect("fake child stdin must remain open");
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), &mut response_rx)
            .await
            .expect("fake ACP prompt response must arrive")
            .expect("fake ACP prompt pending must settle");
        assert_eq!(response.id, Some(request_id));
        assert_eq!(AcpClient::prompt_stop_reason(&response.result.unwrap()).unwrap(), "end_turn");

        client.kill().expect("explicit child cleanup must succeed");
        assert!(!process_exists(child_id), "fake ACP child must exit after kill_and_wait");
    }

    #[tokio::test]
    async fn fake_acp_eof_drains_pending_requests() {
        let script = r#"import sys
sys.exit(0)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-eof".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
        let client = AcpClient::connect_with_logs(&agent, None).await;
        assert!(client.is_err(), "initialize must fail when fake ACP closes without a response");
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
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-replay".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP replay agent must initialize");
        let (response, replay) = client
            .load_session_with_replay("fake-session-replay", ".", Vec::new())
            .await
            .expect("session/load must return after replay response");
        assert_eq!(response, serde_json::json!({"loaded": true}));
        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0]["update"]["content"]["text"], "history-1");
        assert_eq!(replay[1]["update"]["content"]["text"], "history-2");
    }

    #[tokio::test]
    async fn fake_acp_cancel_and_close_send_expected_notifications() {
        let trace_path = std::env::temp_dir().join(format!("pylon-acp-control-{}.jsonl", std::process::id()));
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
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-control".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string(), trace_path.to_string_lossy().into_owned()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP control agent must initialize");
        client.cancel_session("fake-session-control").await.expect("cancel notification must write");
        close_session_rpc(&client, "fake-session-control").await.expect("close request must respond");
        let trace = std::fs::read_to_string(&trace_path).expect("fake ACP must record control requests");
        std::fs::remove_file(&trace_path).ok();
        let requests: Vec<serde_json::Value> = trace.lines()
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
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-eof-after-init".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
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
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            new_session_rpc(&client),
        )
        .await
        .expect("pending request must settle after EOF")
        .expect_err("EOF must reject a new request");
        assert!(error.contains("ACP connection closed"));
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
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-malformed".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("malformed line must not break initialize");
        let response = new_session_rpc(&client).await
            .expect("response after malformed line must arrive");
        assert_eq!(AcpClient::session_id_from(&response).unwrap(), "after-malformed");
    }

    #[tokio::test]
    async fn fake_acp_stderr_is_drained_into_safe_runtime_log() {
        let script = r#"import json,sys
print('fake stderr diagnostic', file=sys.stderr, flush=True)
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-stderr".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
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
        let entry = logs.list(&crate::runtime_log::RuntimeLogQuery::default())
            .into_iter()
            .find(|entry| entry.source == "agent-stderr")
            .expect("agent stderr log must exist");
        assert_eq!(entry.message, "Agent stderr output");
        assert_eq!(entry.fields.get("agent").and_then(|value| value.as_str()), Some("fake-acp-stderr"));
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
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-delayed".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("delayed fake ACP must initialize");
        let response = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            new_session_rpc(&client),
        )
        .await
        .expect("delayed response must not hit test timeout")
        .expect("delayed response must succeed");
        assert_eq!(AcpClient::session_id_from(&response).unwrap(), "delayed-session");
    }
    #[tokio::test]
    async fn fake_acp_prompt_timeout_sends_cancel_and_waits_for_cancelled_response() {
        let trace_path = std::env::temp_dir().join(format!("pylon-acp-prompt-{}.jsonl", std::process::id()));
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
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-prompt-timeout".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string(), trace_path.to_string_lossy().into_owned()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("timeout fake ACP must initialize");
        let (request_id, prompt_line, mut response_rx) = client
            .prepare_prompt("fake-session-timeout", vec![serde_json::json!({"type":"text","text":"hello"})])
            .expect("prompt must serialize");
        client.write_tx.send(prompt_line).await.expect("prompt must write");
        let cancel_tx = client.write_tx.clone();
        let outcome = wait_prompt_with_cancel(
            &mut response_rx,
            std::time::Duration::from_millis(20),
            std::time::Duration::from_millis(200),
            move || async move {
                cancel_tx.send(serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": METHOD_SESSION_CANCEL,
                    "params": {"sessionId": "fake-session-timeout"}
                }).to_string()).await.map_err(|_| "ACP connection closed".to_string())
            },
        ).await;
        assert!(matches!(outcome, PromptWaitOutcome::CancelledAfterTimeout { response: None, cancel_error: None }));
        client.remove_pending(request_id);
        let trace = std::fs::read_to_string(&trace_path).expect("fake ACP must record prompt and cancel");
        std::fs::remove_file(&trace_path).ok();
        assert!(trace.lines().any(|line| {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            value.get("method").and_then(|method| method.as_str()) == Some(METHOD_SESSION_CANCEL)
                && value["params"]["sessionId"] == "fake-session-timeout"
        }));
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
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-update-isolation".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("update isolation fake ACP must initialize");
        let (_response, replay) = client
            .load_session_with_replay("target-session", ".", Vec::new())
            .await
            .expect("target session load must succeed");
        let texts: Vec<&str> = replay.iter()
            .filter_map(|params| params["update"]["content"]["text"].as_str())
            .collect();
        assert_eq!(texts, vec!["target-1", "target-2"]);
        assert!(!texts.contains(&"must-not-leak"));
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
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-cancel-response".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("cancel-response fake ACP must initialize");
        let (_request_id, prompt_line, mut response_rx) = client
            .prepare_prompt("fake-session-cancel-response", vec![serde_json::json!({"type":"text","text":"hello"})])
            .expect("prompt must serialize");
        client.write_tx.send(prompt_line).await.expect("prompt must write");
        let cancel_tx = client.write_tx.clone();
        let outcome = wait_prompt_with_cancel(
            &mut response_rx,
            std::time::Duration::from_millis(20),
            std::time::Duration::from_millis(200),
            move || async move {
                cancel_tx.send(serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": METHOD_SESSION_CANCEL,
                    "params": {"sessionId": "fake-session-cancel-response"}
                }).to_string()).await.map_err(|_| "ACP connection closed".to_string())
            },
        ).await;
        match outcome {
            PromptWaitOutcome::CancelledAfterTimeout { response: Some(raw), cancel_error } => {
                assert!(cancel_error.is_none());
                assert_eq!(raw.result.and_then(|value| value.get("stopReason").cloned()), Some(serde_json::json!("cancelled")));
            }
            other => panic!("expected final cancelled response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn send_response_writes_result_with_matching_id() {
        let trace_path = std::env::temp_dir().join(format!("pylon-acp-response-{}.jsonl", std::process::id()));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    trace.write(line)
    trace.flush()
    request=json.loads(line)
    if request.get('method') == 'initialize':
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-response".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string(), trace_path.to_string_lossy().into_owned()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
        model: None,
        acp_args: Vec::new(),
acp: None,
};
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let result = serde_json::json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}});
        client.send_response(42, result.clone()).await.expect("send_response must write");
        // 等待写通道 flush（fake 脚本逐行写 trace）
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let lines: Vec<serde_json::Value> = trace.lines()
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect();
        let response = lines.iter().find(|line| line.get("id").and_then(|v| v.as_u64()) == Some(42))
            .expect("response line must exist");
        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["result"]["outcome"]["outcome"], "selected");
        assert_eq!(response["result"]["outcome"]["optionId"], "allow_once");
        client.kill().expect("cleanup");
    }

    #[tokio::test]
    async fn fake_acp_initialize_uses_configured_client_capabilities() {
        let trace_path = std::env::temp_dir().join(format!("pylon-acp-caps-{}.jsonl", std::process::id()));
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
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string(), trace_path.to_string_lossy().into_owned()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            acp_args: Vec::new(),
            acp: Some(crate::agent_config::AcpConfig {
                initialize_caps: Some(serde_json::json!({
                    "fs": {},
                    "auth": {},
                    "_meta": {"peri.skillNames": true}
                })),
            }),
        };
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP with configured caps must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let request: serde_json::Value = trace.lines()
            .map(|line| serde_json::from_str(line).expect("trace line"))
            .find(|value: &serde_json::Value| {
                value.get("method").and_then(|m| m.as_str()) == Some(METHOD_INITIALIZE)
            })
            .expect("initialize must be traced");
        assert_eq!(request["params"]["clientCapabilities"]["fs"], serde_json::json!({}));
        assert_eq!(request["params"]["clientCapabilities"]["_meta"]["peri.skillNames"], serde_json::json!(true));
        assert!(request["params"]["clientCapabilities"].get("tokenStats").is_none(), "覆盖后不再带统一默认 caps");
    }

    #[tokio::test]
    async fn fake_acp_initialize_defaults_to_unified_capabilities() {
        let trace_path = std::env::temp_dir().join(format!("pylon-acp-caps-default-{}.jsonl", std::process::id()));
        let script = r#"import json,sys
trace=open(sys.argv[1],'w',encoding='utf-8')
for line in sys.stdin:
    request=json.loads(line)
    trace.write(json.dumps(request)+'\n')
    trace.flush()
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-caps-default".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string(), trace_path.to_string_lossy().into_owned()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            acp_args: Vec::new(),
            acp: None,
        };
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP with default caps must initialize");
        client.kill().expect("cleanup");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let trace = std::fs::read_to_string(&trace_path).expect("read trace");
        std::fs::remove_file(&trace_path).ok();
        let request: serde_json::Value = trace.lines()
            .map(|line| serde_json::from_str(line).expect("trace line"))
            .find(|value: &serde_json::Value| {
                value.get("method").and_then(|m| m.as_str()) == Some(METHOD_INITIALIZE)
            })
            .expect("initialize must be traced");
        assert_eq!(request["params"]["clientCapabilities"]["tokenStats"], serde_json::json!(true));
        assert_eq!(request["params"]["clientCapabilities"]["_meta"]["peri.replay"], serde_json::json!(true));
    }

    fn process_exists(pid: u32) -> bool {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}