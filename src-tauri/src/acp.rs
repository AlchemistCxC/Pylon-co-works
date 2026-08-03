//! ACP Client — spawn peri.exe as child process, JSON-RPC over stdin/stdout.
//!
//! Architecture: one dedicated reader thread dispatches messages by request_id
//! to per-session channels. No lock contention between concurrent sessions.
//! stderr is drained in a background thread to prevent pipe buffer deadlock.

use base64::Engine;
use std::collections::HashMap;
use std::future::Future;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::process::{Child, Command, Stdio};
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
pub const NOTIF_AGENT_CRASHED: &str = "pylon:agent-crashed";

/// ACP session/update 的 `update.sessionUpdate` 变体（R4：事件变体去字符串化——
/// dispatcher/gateway/export 不再手写字符串比较；wire 字符串契约不变）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionUpdateVariant {
    AgentMessageChunk,
    UserMessageChunk,
    UsageUpdate,
    ToolCall,
    ToolCallUpdate,
    SessionInfoUpdate,
    ConfigOptionUpdate,
}

impl SessionUpdateVariant {
    /// wire 字符串 → 变体；未知变体返回 None（调用方按忽略处理，与旧 `_ => {}` 一致）。
    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "agent_message_chunk" => Some(Self::AgentMessageChunk),
            "user_message_chunk" => Some(Self::UserMessageChunk),
            "usage_update" => Some(Self::UsageUpdate),
            "tool_call" => Some(Self::ToolCall),
            "tool_call_update" => Some(Self::ToolCallUpdate),
            "session_info_update" => Some(Self::SessionInfoUpdate),
            "config_option_update" => Some(Self::ConfigOptionUpdate),
            _ => None,
        }
    }
}

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
    values
        .into_iter()
        .map(|v| serde_json::from_value(v).map_err(|e| format!("invalid prompt block: {e}")))
        .collect()
}

/// session/new 参数。mcpServers 以 Pylon 自有格式直传（官方 McpServer 需 name 字段）。
/// E4 警告：OmitIfEmpty 与 agent 能力匹配——声明 omit_if_empty 且无配置时省字段，
/// Hermes（Pydantic 必填）会拒绝 session/new；配置与 agent 能力匹配是用户责任，
/// 默认 Always = 现状 wire，安全（mode 参数化入口见 G1-07a）。
pub fn session_new_params(
    cwd: &str,
    mcp_servers: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let req = NewSessionRequest::new(cwd.to_string());
    let mut params = to_params(&req, "session/new")?;
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
pub fn session_set_config_option_params(
    session_id: &str,
    key: &str,
    value: &str,
) -> Result<serde_json::Value, String> {
    let req = SetSessionConfigOptionRequest::new(
        session_id.to_string(),
        key.to_string(),
        value, // &str → SessionConfigOptionValue via From<&str>（ValueId）
    );
    to_params(&req, "session/set_config_option")
}

/// session/prompt 参数。仅被 [`AcpClient::prepare_prompt`] 内部使用。
fn session_prompt_params(
    session_id: &str,
    prompt: Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let req = PromptRequest::new(session_id.to_string(), content_blocks_from_values(prompt)?);
    to_params(&req, "session/prompt")
}

/// session/close 参数。
pub fn session_close_params(session_id: &str) -> Result<serde_json::Value, String> {
    let req = CloseSessionRequest::new(session_id.to_string());
    to_params(&req, "session/close")
}

/// session/set_model 参数（Hermes unstable 扩展，字段与官方 SetSessionModelRequest 一致）。
pub fn session_set_model_params(
    session_id: &str,
    model_id: &str,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "sessionId": session_id,
        "modelId": model_id,
    }))
}

// ── 操作层错误类型（R6e：中间层 Result<_, String> 类型化）──
//
// ACP 客户端操作层（RPC/连接/子进程）错误统一为 AcpError：调用方可按变体分支
// （ConnectionClosed 不重试 / RpcTimeout 可重试等），Display 文案与旧 String 逐字一致
// （wire 消息不变）。参数构造器/附件校验仍返回 String（纯序列化，低价值不类型化）。
// 边界经 From<AcpError> for PylonError 折回 protocol_error（wire code 不变）。

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
    /// 其余操作错误（spawn/kill/序列化/参数/传输等）——Display 为原样消息。
    #[error("{0}")]
    Child(String),
}

impl From<String> for AcpError {
    fn from(message: String) -> Self {
        Self::Child(message)
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
    #[allow(dead_code)]
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

/// Broadcast channel capacity for ACP message fan-out.
pub const BROADCAST_CAP: usize = 256;
/// mpsc channel capacity for stdin writes — bounded to provide backpressure.
pub const WRITE_CHAN_CAP: usize = 256;
/// Default prompt timeout in seconds (G1-05：DEFAULT_* 前缀统一；值不变)。
pub const DEFAULT_PROMPT_TIMEOUT_SECS: u64 = 300;
/// Maximum time to wait for Peri's final prompt response after sending cancel.
pub const DEFAULT_CANCEL_SETTLE_TIMEOUT_SECS: u64 = 30;
/// Write-channel send timeout. The writer thread blocks on writeln!/flush while the
/// agent is busy reading nothing, filling the mpsc; without a timeout `send().await`
/// hangs forever, breaking the RPC timeout contract above. Timeout is treated as
/// a connection failure (warn + Err). E2 已定：写超时是"连接活性"语义不参数化。
pub const DEFAULT_WRITE_TIMEOUT_SECS: u64 = 10;
/// Maximum size for a single attachment.
pub const DEFAULT_MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;
/// Maximum number of attachments in one prompt.
pub const DEFAULT_MAX_ATTACHMENTS: usize = 8;
/// G1-05 过渡别名：W2（G2-06 超时参数化消费）落地前 session.rs 仍引用旧名；
/// G2 波次完成后由 G2 链删除（值不变，wire 契约不变）。
pub const PROMPT_TIMEOUT_SECS: u64 = DEFAULT_PROMPT_TIMEOUT_SECS;
pub const CANCEL_SETTLE_TIMEOUT_SECS: u64 = DEFAULT_CANCEL_SETTLE_TIMEOUT_SECS;

type Pending = HashMap<u64, oneshot::Sender<RawMessage>>;
const PENDING_SHARDS: usize = 16;

/// Windows Job Object 句柄（RAII：drop 即 CloseHandle）。已设置
/// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE——句柄关闭（最后一个句柄）时内核终止
/// job 内全部进程（含子进程后续派生的整棵进程树，成员资格自动继承）。
#[cfg(windows)]
struct JobObject {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Drop for JobObject {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle) };
    }
}

// HANDLE 是内核对象句柄（数字 token），跨线程移动/共享安全；裸指针本身非
// Send/Sync，显式标记（CloseHandle 线程安全，AcpClient 需保持 Send/Sync 供
// tokio::spawn 使用）。
#[cfg(windows)]
unsafe impl Send for JobObject {}
#[cfg(windows)]
unsafe impl Sync for JobObject {}

struct ManagedChild {
    child: Option<Child>,
    /// Windows：进程树清理 job。句柄关闭即终止整棵进程树（KILL_ON_JOB_CLOSE）；
    /// 创建/挂接失败时为 None，kill 时回退 taskkill。
    #[cfg(windows)]
    job: Option<JobObject>,
}

impl ManagedChild {
    fn empty() -> Self {
        Self {
            child: None,
            #[cfg(windows)]
            job: None,
        }
    }

    fn new(child: Child) -> Self {
        let mut managed = Self {
            child: Some(child),
            #[cfg(windows)]
            job: None,
        };
        #[cfg(windows)]
        managed.attach_job();
        managed
    }

    /// Windows：spawn 后立即把子进程挂进 KILL_ON_JOB_CLOSE job。赋值发生在子进程
    /// 完成初始化（读 stdin）之前，其后续派生的进程自动继承 job 成员资格；
    /// 任一环节失败仅记 warn 并回退 taskkill（不阻塞 spawn）。
    #[cfg(windows)]
    fn attach_job(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        let Some(child) = self.child.as_ref() else {
            return;
        };
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            tracing::warn!(
                "ACP: CreateJobObjectW failed ({}); taskkill fallback",
                std::io::Error::last_os_error()
            );
            return;
        }
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let set_ok = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if set_ok == 0 {
            tracing::warn!(
                "ACP: SetInformationJobObject failed ({}); taskkill fallback",
                std::io::Error::last_os_error()
            );
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return;
        }
        if unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) } == 0 {
            tracing::warn!(
                "ACP: AssignProcessToJobObject failed ({}); taskkill fallback",
                std::io::Error::last_os_error()
            );
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
            return;
        }
        self.job = Some(JobObject { handle: job });
    }

    fn take_stdin(&mut self) -> Result<std::process::ChildStdin, AcpError> {
        self.child
            .as_mut()
            .and_then(|child| child.stdin.take())
            .ok_or(AcpError::Child("no stdin".to_string()))
    }

    fn take_stdout(&mut self) -> Result<std::process::ChildStdout, AcpError> {
        self.child
            .as_mut()
            .and_then(|child| child.stdout.take())
            .ok_or(AcpError::Child("no stdout".to_string()))
    }

    fn take_stderr(&mut self) -> Result<std::process::ChildStderr, AcpError> {
        self.child
            .as_mut()
            .and_then(|child| child.stderr.take())
            .ok_or(AcpError::Child("no stderr".to_string()))
    }

    /// Windows：`taskkill /T /F` 递归杀进程树（job 挂接失败时的兜底——job 成功
    /// 时 kill_and_wait 走 job 关闭路径）。`Child::kill` 只杀直接子进程，
    /// peri/hermes 派生的子进程会残留。进程已退出时 taskkill 报错——静默返回
    /// false，由调用方回退普通 kill 路径。
    #[cfg(windows)]
    fn kill_process_tree(pid: u32) -> bool {
        std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn kill_and_wait(&mut self) -> Result<(), AcpError> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        #[cfg(windows)]
        if self.job.is_some() {
            // Windows：关闭 job 句柄（KILL_ON_JOB_CLOSE）即终止整棵进程树，
            // 随后 wait 回收直接子进程（进程可能已抢先退出，wait 报错仅记 warn）。
            self.job = None;
            if let Err(error) = child.wait() {
                tracing::warn!("wait after job close: {error}");
            }
            return Ok(());
        }
        match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            Ok(None) => {
                #[cfg(windows)]
                if Self::kill_process_tree(child.id()) {
                    // taskkill /T 已杀整个进程树；wait 回收句柄（进程可能已
                    // 抢先退出，wait 报错仅记 warn，不视为失败）。
                    if let Err(error) = child.wait() {
                        tracing::warn!("wait after taskkill: {error}");
                    }
                    return Ok(());
                }
                child
                    .kill()
                    .map_err(|error| AcpError::Child(format!("kill failed: {error}")))?;
                child
                    .wait()
                    .map_err(|error| AcpError::Child(format!("wait failed: {error}")))?;
                Ok(())
            }
            Err(error) => {
                // try_wait 失败时仍必须继续清理，不能把已取出的 Child
                // 直接丢弃，否则 initialize/switch/Drop 错误路径可能遗留子进程。
                let kill_result = child.kill();
                let wait_result = child.wait();
                match (kill_result, wait_result) {
                    (Ok(()), Ok(_)) => Err(AcpError::Child(format!(
                        "try_wait failed: {error}; child killed and waited"
                    ))),
                    (kill_error, wait_error) => Err(AcpError::Child(format!(
                        "try_wait failed: {error}; kill: {}; wait: {}",
                        kill_error
                            .map(|_| "ok".to_string())
                            .unwrap_or_else(|err| err.to_string()),
                        wait_error
                            .map(|_| "ok".to_string())
                            .unwrap_or_else(|err| err.to_string()),
                    ))),
                }
            }
        }
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        if let Err(error) = self.kill_and_wait() {
            tracing::warn!("cleanup ACP child: {}", error);
        }
    }
}

pub struct AcpClient {
    child: ManagedChild,
    /// G1-02：per-agent 协议行为配置（connect_with_logs 从 agent.protocol() clone；
    /// disconnected() 用默认实例）。超时/限额/握手参数唯一读取点。
    protocol: crate::agent_config::AcpProtocolConfig,
    /// mpsc channel for writing JSON-RPC lines to stdin. Single consumer = no lock contention.
    pub(crate) write_tx: mpsc::Sender<String>,
    /// R4：writer tokio 任务句柄——kill/替换 agent 时 abort 掉可能阻塞在 stdin
    /// 写入的旧任务（`disconnected()` 无运行时，为 None）。
    writer_task: Option<tokio::task::JoinHandle<()>>,
    next_id: Arc<AtomicU64>,
    pending: Arc<[Mutex<Pending>; PENDING_SHARDS]>,
    /// Broadcast channel for all received messages (responses + notifications).
    pub rx: broadcast::Receiver<RawMessage>,
    /// Set when the child process exits unexpectedly.
    pub crashed: Arc<AtomicBool>,
    /// A7：EOF 崩溃信号独立 watch 通道（保留最新值，broadcast 洪泛 Lagged 丢消息
    /// 时 NOTIF_AGENT_CRASHED 可能丢失，本通道是自动重连的可靠信号源）。
    /// reader 线程 EOF 时 `send(true)`；dispatcher 经 [`Self::crashed_receiver`] 订阅。
    crashed_watch: watch::Sender<bool>,
    /// 保持通道开放的兜底接收端：reader 线程在外部订阅之前崩溃时，`send` 不会因
    /// "无接收者"失败——订阅方经 `has_changed`/`borrow` 仍能读到 true。
    _crashed_watch_rx: watch::Receiver<bool>,
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
    /// 写超时收敛目标：send_line 超时置位，让上层快速失败并触发自动重连。
    crashed: Arc<AtomicBool>,
    /// G1-02：RPC 超时（complete 读此值；prepare 时从 client 协议配置解析，
    /// 缺省 30s——句柄自足，锁外等待不依赖 client）。
    rpc_timeout: std::time::Duration,
}

/// 从 pending 分片移除指定 id（R3：发送失败 / 超时 / 连接关闭等失败路径统一清理入口，
/// 替换 complete_rpc 内闭包与 send_prompt_core 手工 remove_pending 的重复实现）。
fn remove_pending_from(pending: &Arc<[Mutex<Pending>; PENDING_SHARDS]>, id: u64) {
    if let Ok(mut shard) = pending[id as usize % PENDING_SHARDS].lock() {
        shard.remove(&id);
    }
}

impl PreparedRpc {
    /// 发送请求行（统一走 `send_line`：10s 写超时防 writer 阻塞击穿超时契约），
    /// 失败时清理已注册 pending。成功后返回响应接收器——prompt 路径用它在锁外
    /// 进入 [`wait_prompt_with_cancel`] 的超时/取消流程（响应未到的 pending 保留，
    /// 由 reader 到响应时移除或 EOF 时 drain，与 V14 模式一致）。
    pub async fn send_keep_rx(self) -> Result<oneshot::Receiver<RawMessage>, AcpError> {
        let PreparedRpc {
            id,
            line,
            write_tx,
            rx,
            pending,
            crashed,
            ..
        } = self;
        if let Err(error) = send_line(write_tx, line, &crashed).await {
            remove_pending_from(&pending, id);
            return Err(error);
        }
        // A6：发送后复检 crashed——reader EOF 先 store 后 drain：注册先于 drain 的
        // pending 会被 drain resolve；注册后于 drain 的在此命中（否则 prompt 悬挂
        // 300s 假超时）。crashed 已置位时 pending 不可能再被消费，直接清理返回。
        if crashed.load(Ordering::Acquire) {
            remove_pending_from(&pending, id);
            return Err(AcpError::ConnectionClosed);
        }
        Ok(rx)
    }

    /// 通用 RPC 结算（R3：原 `AcpClient::complete_rpc` 提取为 PreparedRpc 方法）：
    /// 发送 + RPC 超时等待匹配响应（G1-02：超时值来自协议配置，缺省 30s）+ 错误/结果解析。
    /// 不依赖 AcpClient 实例，可在锁外执行。
    pub async fn complete(self) -> Result<serde_json::Value, AcpError> {
        let PreparedRpc {
            id,
            line,
            write_tx,
            rx,
            pending,
            crashed,
            rpc_timeout,
        } = self;
        if let Err(error) = send_line(write_tx, line, &crashed).await {
            remove_pending_from(&pending, id);
            return Err(error);
        }
        // A6：与 send_keep_rx 相同的发送后复检，避免注册后于 drain 的 pending
        // 悬挂满超时假超时（同一次崩溃窗口内保持快速 ConnectionClosed 收敛）。
        if crashed.load(Ordering::Acquire) {
            remove_pending_from(&pending, id);
            return Err(AcpError::ConnectionClosed);
        }
        let msg = match tokio::time::timeout(rpc_timeout, rx).await {
            Ok(Ok(msg)) => msg,
            Ok(Err(_)) => {
                remove_pending_from(&pending, id);
                return Err(AcpError::ConnectionClosed);
            }
            Err(_) => {
                remove_pending_from(&pending, id);
                return Err(AcpError::RpcTimeout);
            }
        };
        if let Some(err) = msg.error {
            return Err(AcpError::Rpc(format!("{}", err)));
        }
        Ok(msg.result.unwrap_or(serde_json::Value::Null))
    }
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
                std::time::Duration::from_secs(DEFAULT_WRITE_TIMEOUT_SECS),
                cancel(),
            )
            .await
            {
                Ok(result) => result.err(),
                Err(_) => {
                    tracing::warn!("ACP: cancel timed out after {DEFAULT_WRITE_TIMEOUT_SECS}s");
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
/// 超时视为连接故障（warn 日志 + crashed 置位 + Err）：置位后上层快速失败
/// （后续命令立即 ConnectionClosed），dispatcher 收到崩溃通知自动重连。
async fn send_line(
    tx: mpsc::Sender<String>,
    line: String,
    crashed: &Arc<AtomicBool>,
) -> Result<(), AcpError> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(DEFAULT_WRITE_TIMEOUT_SECS),
        tx.send(line),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(AcpError::ConnectionClosed),
        Err(_) => {
            tracing::warn!(
                "ACP write timeout after {DEFAULT_WRITE_TIMEOUT_SECS}s: connection presumed dead"
            );
            crashed.store(true, Ordering::Release);
            Err(AcpError::WriteTimeout)
        }
    }
}

/// G1-05：writer 任务启动（S3 拆分；R4 自 std 线程改 tokio 任务：
/// spawn_blocking + 写超时）。每行经独立的 blocking 段写入并以 write_timeout
/// 竞争超时——agent 不读 stdin 时管道填满，旧 std 线程的 flush 永久阻塞
/// （无超时路径），写通道填满后 send_line 的超时兜底前已有多条命令排队失败。
/// 单消费者 + 逐行等待保证写入顺序不变。超时语义与 send_line 一致：
/// 置位 crashed 让上层快速失败并触发自动重连。
fn spawn_writer_task(
    stdin: std::process::ChildStdin,
    mut write_rx: mpsc::Receiver<String>,
    crashed: &Arc<AtomicBool>,
    write_timeout: u64,
) -> tokio::task::JoinHandle<()> {
    let writer_crashed = crashed.clone();
    tokio::task::spawn(async move {
        let stdin_writer = Arc::new(Mutex::new(BufWriter::new(stdin)));
        while let Some(line) = write_rx.recv().await {
            let stdin_writer = stdin_writer.clone();
            let write = tokio::task::spawn_blocking(move || {
                let mut guard = match stdin_writer.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                writeln!(guard, "{line}")?;
                guard.flush()
            });
            match tokio::time::timeout(std::time::Duration::from_secs(write_timeout), write).await
            {
                // 写入成功 → 取下一条
                Ok(Ok(Ok(()))) => {}
                // EPIPE 等写失败 → reader 线程经 EOF 置位 crashed + watch
                Ok(Ok(Err(_))) | Ok(Err(_)) => break,
                // 写超时：agent 存活但不读 stdin，reader 不会收到 EOF——
                // writer 自行置位 crashed（与 send_line 超时语义一致），
                // 上层快速失败并触发自动重连。
                Err(_) => {
                    tracing::warn!(
                        "ACP writer timeout after {write_timeout}s: connection presumed dead"
                    );
                    writer_crashed.store(true, Ordering::Release);
                    break;
                }
            }
        }
    })
}

/// G1-05：stderr drain 线程启动（S3 拆分；防管道缓冲死锁）。
/// clippy 2026-08-02：读失败即停（map_while）——stderr 一旦读失败后续必失败。
fn spawn_stderr_reader(
    stderr: std::process::ChildStderr,
    agent_name: &str,
    runtime_logs: &Option<Arc<crate::runtime_log::RuntimeLogHub>>,
) {
    let agent_name_stderr = agent_name.to_string();
    let stderr_logs = runtime_logs.clone();
    std::thread::spawn(move || {
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !l.is_empty() {
                let safe = crate::runtime_log::sanitize_message(l.clone());
                tracing::error!("{} stderr: {}", agent_name_stderr, safe);
                if let Some(hub) = &stderr_logs {
                    hub.push(
                        crate::time::Timestamp::now(),
                        "error",
                        "agent-stderr",
                        None,
                        "Agent stderr output",
                        serde_json::Map::from_iter([(
                            "agent".to_string(),
                            serde_json::Value::String(agent_name_stderr.clone()),
                        )]),
                    );
                }
            }
        }
    });
}

/// G1-05：stdout reader 线程启动（S3 拆分；行为与原内联实现逐字一致）：
/// 逐行解析 JSON → broadcast 转发 + pending 分片 resolve；EOF → store crashed →
/// watch 信号（A7 可靠投递）→ drain pending → NOTIF_AGENT_CRASHED 广播。
fn spawn_stdout_reader(
    stdout: std::io::BufReader<std::process::ChildStdout>,
    pending: Arc<[Mutex<Pending>; PENDING_SHARDS]>,
    tx: broadcast::Sender<RawMessage>,
    crashed: &Arc<AtomicBool>,
    crashed_watch: &watch::Sender<bool>,
    runtime_logs: &Option<Arc<crate::runtime_log::RuntimeLogHub>>,
) {
    let pending_clone = pending.clone();
    let tx_clone = tx.clone();
    let crashed_reader = crashed.clone();
    let crashed_watch_reader = crashed_watch.clone();
    let stdout_logs = runtime_logs.clone();
    std::thread::spawn(move || {
        for line in stdout.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            let msg_val: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!("ACP parse: {}", e);
                    if let Some(hub) = &stdout_logs {
                        hub.push(
                            crate::time::Timestamp::now(),
                            "error",
                            "acp",
                            None,
                            "ACP stdout JSON parse error",
                            serde_json::Map::from_iter([(
                                "error".to_string(),
                                serde_json::Value::String(e.to_string()),
                            )]),
                        );
                    }
                    continue;
                }
            };
            let raw = RawMessage {
                id: msg_val.get("id").and_then(|v| v.as_u64()),
                method: msg_val
                    .get("method")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
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
                            if let Some(tx) = p.remove(&id) {
                                let _ = tx.send(raw);
                            }
                        }
                        Err(_) => {
                            // poison 时无法 resolve pending，标记 crashed 让上层收敛，
                            // 避免读线程 panic 后 pending 悬挂到超时。
                            crashed_reader.store(true, Ordering::Relaxed);
                            tracing::error!("ACP: pending shard lock poisoned for id {id}");
                        }
                    }
                }
            }
        }
        crashed_reader.store(true, Ordering::Relaxed);
        // A7：EOF 崩溃信号经 watch 通道可靠投递——broadcast 在洪泛
        // Lagged 时会丢 NOTIF_AGENT_CRASHED，watch 保留最新值不丢，
        // 自动重连依赖此信号（dispatcher select! 双路监听）。
        let _ = crashed_watch_reader.send(true);
        let drained = AcpClient::drain_pending(&pending_clone);
        tracing::warn!(
            "ACP: drained {} pending requests after stdout closed",
            drained
        );
        let _ = tx_clone.send(RawMessage {
            id: None,
            method: Some(NOTIF_AGENT_CRASHED.to_string()),
            result: None,
            params: Some(serde_json::json!({"reason": "stdout_closed"})),
            error: None,
        });
        if let Some(hub) = &stdout_logs {
            hub.push(
                crate::time::Timestamp::now(),
                "error",
                "acp",
                None,
                "ACP child stdout closed; agent crashed",
                serde_json::Map::new(),
            );
        }
        tracing::error!("ACP: child process stdout closed (agent crashed)");
    });
}

impl AcpClient {
    pub fn disconnected() -> Self {
        let (write_tx, write_rx) = mpsc::channel(1);
        drop(write_rx);
        let (_tx, rx) = broadcast::channel(BROADCAST_CAP);
        let (crashed_watch, crashed_watch_rx) = watch::channel(false);
        Self {
            child: ManagedChild::empty(),
            protocol: crate::agent_config::AcpProtocolConfig::default(),
            write_tx,
            writer_task: None,
            next_id: Arc::new(AtomicU64::new(1)),
            pending: Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new()))),
            rx,
            crashed: Arc::new(AtomicBool::new(false)),
            crashed_watch,
            _crashed_watch_rx: crashed_watch_rx,
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

    /// Extract and validate sessionId from a session/new response.
    pub fn session_id_from(response: &serde_json::Value) -> Result<String, AcpError> {
        let session_id = response
            .get("sessionId")
            .and_then(|value| value.as_str())
            .ok_or_else(|| AcpError::Child(format!("invalid session/new response: {response}")))?
            .trim();
        if session_id.is_empty() || session_id.eq_ignore_ascii_case("error") {
            return Err(AcpError::Child(format!(
                "session/new failed: invalid sessionId {session_id:?}"
            )));
        }
        Ok(session_id.to_string())
    }

    /// Validate a session/prompt response and return its stop reason.
    pub fn prompt_stop_reason(response: &serde_json::Value) -> Result<&str, AcpError> {
        let stop_reason = response
            .get("stopReason")
            .and_then(|value| value.as_str())
            .ok_or_else(|| AcpError::Child(format!("invalid session/prompt response: {response}")))?
            .trim();
        match stop_reason {
            "end_turn" | "max_turn_requests" => Ok(stop_reason),
            "cancelled" => Err(AcpError::Child("prompt cancelled".to_string())),
            "refusal" => Err(AcpError::Child("prompt refused by agent".to_string())),
            other => Err(AcpError::Child(format!(
                "unsupported prompt stopReason: {other}"
            ))),
        }
    }

    /// Build prompt blocks (text + attachments) for session/prompt.
    /// G1-04：附件限制来自 AttachmentLimits（缺省 = 现状 8 / 10MB，wire 文案不变）。
    pub fn prompt_blocks(
        text: String,
        attachments: &[String],
        limits: crate::agent_config::AttachmentLimits,
    ) -> Result<Vec<serde_json::Value>, String> {
        if attachments.len() > limits.max_attachments {
            return Err(format!(
                "too many attachments: maximum is {}",
                limits.max_attachments
            ));
        }
        let mut blocks = vec![serde_json::json!({"type": "text", "text": text})];
        for raw_path in attachments {
            let path = std::path::Path::new(raw_path);
            let metadata = std::fs::metadata(path).map_err(|error| {
                format!("attachment metadata failed for {}: {error}", path.display())
            })?;
            if !metadata.is_file() {
                return Err(format!("attachment is not a file: {}", path.display()));
            }
            if metadata.len() > limits.max_attachment_bytes {
                return Err(format!(
                    "attachment too large: {} is {} bytes, maximum is {} bytes",
                    path.display(),
                    metadata.len(),
                    limits.max_attachment_bytes
                ));
            }
            // A9：metadata 校验后不能直接 std::fs::read 无上限读取——校验与读取间
            // 文件可被替换/增长（TOCTOU），超大文件导致 OOM。改为上限读取
            // （MAX + 1 字节探测超限），读后再校验一次。
            let file = std::fs::File::open(path).map_err(|error| {
                format!("attachment read failed for {}: {error}", path.display())
            })?;
            let mut bytes = Vec::new();
            file.take(limits.max_attachment_bytes + 1)
                .read_to_end(&mut bytes)
                .map_err(|error| {
                    format!("attachment read failed for {}: {error}", path.display())
                })?;
            if bytes.len() as u64 > limits.max_attachment_bytes {
                return Err(format!(
                    "attachment too large: {} is {} bytes, maximum is {} bytes",
                    path.display(),
                    bytes.len(),
                    limits.max_attachment_bytes
                ));
            }
            let mime = infer::get(&bytes).map(|kind| kind.mime_type());
            match mime {
                Some(mime)
                    if matches!(
                        mime,
                        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
                    ) =>
                {
                    blocks.push(serde_json::json!({
                        "type": "image",
                        "mimeType": mime,
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                    }));
                }
                Some(mime) if mime.starts_with("text/") => {
                    let content = String::from_utf8(bytes).map_err(|error| {
                        format!(
                            "attachment is not valid UTF-8 text {}: {error}",
                            path.display()
                        )
                    })?;
                    blocks.push(serde_json::json!({"type": "text", "text": content}));
                }
                None => {
                    let content = String::from_utf8(bytes)
                        .map_err(|_| format!("unsupported attachment type: {}", path.display()))?;
                    blocks.push(serde_json::json!({"type": "text", "text": content}));
                }
                Some(mime) => {
                    return Err(format!(
                        "unsupported attachment MIME {mime}: {}",
                        path.display()
                    ));
                }
            }
        }
        Ok(blocks)
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

    /// A7：订阅崩溃信号（EOF 后为 true）。watch 保留最新值——订阅晚于崩溃时
    /// `has_changed`/`borrow` 仍能读到 true，不依赖时序。
    pub fn crashed_receiver(&self) -> watch::Receiver<bool> {
        self.crashed_watch.subscribe()
    }

    #[cfg(test)]
    fn child_id(&self) -> Option<u32> {
        self.child.child.as_ref().map(Child::id)
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
    pub async fn connect_with_logs(
        agent: &crate::agent_config::AgentDef,
        runtime_logs: Option<Arc<crate::runtime_log::RuntimeLogHub>>,
    ) -> Result<Self, AcpError> {
        let resolved_agent;
        let agent = if let Some(config_path) = crate::agent_config::effective_config_path() {
            let base_dir = config_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."));
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
                let child = cmd
                    .spawn()
                    .map_err(|e| AcpError::Child(format!("spawn {} failed: {}", agent.exe, e)))?;
                let mut child = ManagedChild::new(child);

                let stdin = child.take_stdin()?;
                let (write_tx, write_rx) = mpsc::channel::<String>(WRITE_CHAN_CAP);
                let crashed = Arc::new(AtomicBool::new(false));
                // G1-05：三线程启动收敛为私有函数（S3 卫生，行为零变化）。
                let writer_task = spawn_writer_task(stdin, write_rx, &crashed, DEFAULT_WRITE_TIMEOUT_SECS);
                let stdout = BufReader::new(child.take_stdout()?);

                // Drain stderr（防管道缓冲死锁）
                let stderr = child.take_stderr()?;
                spawn_stderr_reader(stderr, &agent.name, &runtime_logs);

                let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
                    Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
                let (tx, rx) = broadcast::channel(BROADCAST_CAP);
                let (crashed_watch, crashed_watch_rx) = watch::channel(false);

                spawn_stdout_reader(stdout, pending.clone(), tx.clone(), &crashed, &crashed_watch, &runtime_logs);

                let client = AcpClient {
                    child,
                    protocol: agent.protocol().clone(),
                    write_tx,
                    writer_task: Some(writer_task),
                    next_id: Arc::new(AtomicU64::new(1)),
                    pending,
                    rx,
                    crashed,
                    crashed_watch,
                    _crashed_watch_rx: crashed_watch_rx,
                };
                // Initialize——G1-03：握手三段全部来自协议配置（覆盖制，缺省 = 现状
                // 现值，wire 逐字节不变）：clientCapabilities（D1，agents.yaml
                // `acp.initialize_caps` 覆盖；缺省 = 统一默认 tokenStats + _meta.peri.*，
                // Hermes 忽略无害）、protocolVersion（H3）、clientInfo（H4）。
                // 差异适配表见 acp.rs 头部注释与手册 §3.3。
                client
                    .call_async(
                        METHOD_INITIALIZE,
                        serde_json::json!({
                            "protocolVersion": client.protocol.protocol_version(),
                            "clientCapabilities": client.protocol.initialize_caps(),
                            "clientInfo": client.protocol.client_info()
                        }),
                    )
                    .await?;
                Ok(client)
            }
            other => Err(AcpError::Child(format!("unsupported transport: {}", other))),
        }
    }

    /// session/load 参数（G1-05：原顶层 session_load_params 内联收敛，消除 S2 命名混淆）。
    /// ACP schema 1.4 LoadSessionRequest.mcp_servers 无 default（Hermes Pydantic 必填），
    /// 字段必须存在；Peri 的 DefaultOnError 容忍缺失/空。无配置时传空数组而非缺字段。
    /// E4 警告：OmitIfEmpty 与 agent 能力匹配——声明 omit_if_empty 且无配置时省字段，
    /// Hermes（Pydantic 必填）会拒绝 session/load；配置与 agent 能力匹配是用户责任。
    fn load_params(
        session_id: &str,
        cwd: &str,
        mcp_servers: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value, String> {
        let req = LoadSessionRequest::new(session_id.to_string(), cwd.to_string());
        let mut params = to_params(&req, "session/load")?;
        if let Some(obj) = params.as_object_mut() {
            obj.insert("mcpServers".into(), serde_json::Value::Array(mcp_servers));
        }
        Ok(params)
    }

    /// Load a persisted session and collect every replay notification before the response.
    /// The reader publishes notifications before resolving the matching response, so
    /// observing the response on this broadcast receiver is the deterministic replay boundary.
    /// O3：接受 [`Self::replay_handles`] 产出的句柄而非 &self——调用方在锁内提取
    /// 句柄后释放锁，等待（最长 30s）在锁外进行，期间其他命令可执行。
    pub async fn load_session_with_replay(
        handles: ReplayHandles,
        session_id: &str,
        cwd: &str,
        mcp_servers: Vec<serde_json::Value>,
    ) -> Result<(serde_json::Value, Vec<serde_json::Value>), AcpError> {
        // 审查修复：与 prepare_rpc 一致，死亡连接立即拒绝
        if handles.crashed.load(Ordering::Relaxed) {
            return Err(AcpError::ConnectionClosed);
        }
        let mut events = handles.rx.resubscribe();
        // 回放与响应均经 broadcast 收集，无需注册 pending：旧代码的 (tx, _rx)
        // 条目永不消费（reader 对已丢弃 rx 的 tx.send 必然失败），确认无功能
        // 依赖后删除；id 仅用于在广播流中匹配响应。
        let params = Self::load_params(session_id, cwd, mcp_servers)?;
        let (id, line) = Self::register_line(&handles.next_id, METHOD_SESSION_LOAD, &params)?;
        send_line(handles.write_tx, line, &handles.crashed).await?;

        let mut replay = Vec::new();
        loop {
            // 优化 3：每轮复检 crashed——EOF 仅广播 NOTIF_AGENT_CRASHED（非目标
            // session/update 被跳过），reader 先 store crashed 后广播（acp.rs:1154-1164），
            // 此处命中即可立即 ConnectionClosed，与 send_keep_rx/complete 的发送后复检
            // 一致，避免挂满 30s 假超时。
            if handles.crashed.load(Ordering::Relaxed) {
                return Err(AcpError::ConnectionClosed);
            }
            let raw = match tokio::time::timeout(handles.rpc_timeout, events.recv()).await
            {
                Ok(Ok(raw)) => raw,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(count))) => {
                    return Err(AcpError::Child(format!(
                        "session/load replay lagged by {count} messages"
                    )));
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                    return Err(AcpError::Child(
                        "ACP notification stream closed during session/load".to_string(),
                    ));
                }
                Err(_) => {
                    return Err(AcpError::Child(format!(
                        "session/load replay timed out after {}s",
                        handles.rpc_timeout.as_secs()
                    )));
                }
            };
            if raw.method.as_deref() == Some(NOTIF_SESSION_UPDATE)
                && raw
                    .params
                    .as_ref()
                    .and_then(|params| params.get("sessionId"))
                    .and_then(|value| value.as_str())
                    == Some(session_id)
            {
                if let Some(params) = raw.params {
                    // O4：收集上限——超长历史回放截断，防止 Vec 无界增长。
                    // 达到上限后继续等待响应（不得 break 提前返回——响应缺失
                    // 会让调用方把 Null 当 session/load 结果，破坏会话配置）。
                    // G1-02：上限来自协议配置 replay_max（缺省 10_000，wire 文案不变）。
                    if replay.len() < handles.replay_max {
                        replay.push(params);
                    } else if replay.len() == handles.replay_max {
                        tracing::warn!(
                            "session/load replay 超过 {} 条，截断",
                            handles.replay_max
                        );
                        replay.truncate(handles.replay_max);
                    }
                }
                continue;
            }
            if raw.id != Some(id) {
                continue;
            }
            if let Some(error) = raw.error {
                return Err(AcpError::Rpc(format!("{}", error)));
            }
            return Ok((raw.result.unwrap_or(serde_json::Value::Null), replay));
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
        }
    }
}

/// O3：锁外执行 session/load 回放所需的句柄（写通道 / id 计数器 / 崩溃标记 /
/// 广播订阅 / G1-02 超时与收集上限）。调用方在锁内经 [`AcpClient::replay_handles`]
/// 一次性提取，锁外交给 [`AcpClient::load_session_with_replay`] 等待回放完成。
pub struct ReplayHandles {
    write_tx: mpsc::Sender<String>,
    next_id: Arc<AtomicU64>,
    crashed: Arc<AtomicBool>,
    rx: broadcast::Receiver<RawMessage>,
    /// G1-02：回放等待超时（缺省 30s，替代 H9 字面量）。
    rpc_timeout: std::time::Duration,
    /// G1-02：回放收集上限（缺省 10_000，替代 H12 字面量）。
    replay_max: usize,
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
        assert!(
            AcpError::Rpc(r#"{"message":"Method not found"}"#.into()).is_method_not_found()
        );
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
    fn session_update_variant_wire_strings_are_stable() {        // 契约锁定：wire 字符串 ↔ 变体映射（前端/平台依赖这些字符串，勿改拼写）。
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
            AcpClient::load_params("session-1", "G:/workspace", Vec::new()).unwrap(),
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
                .expect_err("cancelled must not complete normally")
                .to_string(),
            "prompt cancelled"
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "refusal"}))
                .expect_err("refusal must not complete normally")
                .to_string(),
            "prompt refused by agent"
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "paused"}))
                .expect_err("unknown stop reason must be rejected")
                .to_string(),
            "unsupported prompt stopReason: paused"
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({}))
                .expect_err("missing stop reason must be rejected")
                .to_string(),
            "invalid session/prompt response: {}"
        );
    }

    #[test]
    fn prompt_without_attachments_contains_one_text_block() {
        let blocks = AcpClient::prompt_blocks(
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
        let error = AcpClient::prompt_blocks(
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
        let error = AcpClient::prompt_blocks(
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
        let error = AcpClient::prompt_blocks(
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
        let error = AcpClient::prompt_blocks(
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
        let error = AcpClient::prompt_blocks(
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
        let error = AcpClient::prompt_blocks(
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
        let error = AcpClient::prompt_blocks(
            "hello".to_string(),
            &[path.to_string_lossy().into_owned()],
            limits,
        )
        .expect_err("超过自定义大小上限必须拒绝");
        assert!(error.starts_with("attachment too large:"));
        let blocks = AcpClient::prompt_blocks(
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
            std::time::Duration::from_millis(10),
            std::time::Duration::from_millis(200),
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
            pending[id as usize % PENDING_SHARDS]
                .lock()
                .unwrap()
                .insert(id, tx);
            receivers.push(rx);
        }

        assert_eq!(AcpClient::drain_pending(&pending), 3);
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
        assert_eq!(
            AcpClient::session_id_from(&new_response).unwrap(),
            "fake-session-1"
        );

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
        assert_eq!(response.id, Some(request_id));
        assert_eq!(
            AcpClient::prompt_stop_reason(&response.result.unwrap()).unwrap(),
            "end_turn"
        );

        client.kill().expect("explicit child cleanup must succeed");
        assert!(
            !process_exists(child_id),
            "fake ACP child must exit after kill_and_wait"
        );
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
        let (response, replay) = AcpClient::load_session_with_replay(
            client.replay_handles(),
            "fake-session-replay",
            ".",
            Vec::new(),
        )
        .await
        .expect("session/load must return after replay response");
        assert_eq!(response, serde_json::json!({"loaded": true}));
        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0]["update"]["content"]["text"], "history-1");
        assert_eq!(replay[1]["update"]["content"]["text"], "history-2");
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
        let mut agent =
            crate::test_utils::fake_acp_agent_with("fake-acp-rpc-timeout", script, Vec::new(), HashMap::new());
        agent.acp = Some(crate::agent_config::AcpProtocolConfig {
            rpc_timeout_secs: Some(1),
            ..Default::default()
        });
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let start = std::time::Instant::now();
        let result = client
            .prepare_rpc(METHOD_SESSION_NEW, serde_json::json!({"cwd": ".", "mcpServers": []}))
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
        let (response, replay) = AcpClient::load_session_with_replay(
            client.replay_handles(),
            "target-cap",
            ".",
            Vec::new(),
        )
        .await
        .expect("session/load must return after replay response");
        assert_eq!(response, serde_json::json!({"loaded": true}));
        assert_eq!(
            replay.len(),
            2,
            "回放必须按 replay_max=2 截断（3 条 fake 事件）"
        );
        assert_eq!(replay[0]["update"]["content"]["text"], "h0");
        assert_eq!(replay[1]["update"]["content"]["text"], "h1");
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
        assert_eq!(
            AcpClient::session_id_from(&response).unwrap(),
            "after-malformed"
        );
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
        assert_eq!(entry.message, "Agent stderr output");
        assert_eq!(
            entry.fields.get("agent").and_then(|value| value.as_str()),
            Some("fake-acp-stderr")
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
        assert_eq!(
            AcpClient::session_id_from(&response).unwrap(),
            "delayed-session"
        );
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
            std::time::Duration::from_millis(20),
            std::time::Duration::from_millis(200),
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
        let (_response, replay) = AcpClient::load_session_with_replay(
            client.replay_handles(),
            "target-session",
            ".",
            Vec::new(),
        )
        .await
        .expect("target session load must succeed");
        let texts: Vec<&str> = replay
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
            AcpClient::load_session_with_replay(
                client.replay_handles(),
                "fake-session-replay-eof",
                ".",
                Vec::new(),
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
            std::time::Duration::from_millis(20),
            std::time::Duration::from_millis(200),
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
            serde_json::json!({"name": "Pylon", "version": "0.1.0"})
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
            serde_json::json!({"name": "Pylon", "version": "0.1.0"})
        );
    }

    /// G1-03：声明 protocol_version/client_info 后按声明进 wire（覆盖路径）。
    #[tokio::test]
    async fn custom_protocol_version_and_client_info_reach_wire() {
        let trace_path = std::env::temp_dir().join(format!(
            "pylon-acp-handshake-{}.jsonl",
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
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-handshake".to_string(),
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

    fn process_exists(pid: u32) -> bool {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}
