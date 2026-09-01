use super::*;
use std::collections::HashMap;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, oneshot, watch};


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
    pub(crate) fn register_line(
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
                // Hermes on Windows executes local tools through Git Bash.  Resolve and
                // preflight the bundled runtime before spawning the ACP child; the helper is
                // a no-op for every other provider/transport and never mutates Pylon's
                // process-wide environment.
                let hermes_runtime = crate::hermes_runtime::prepare(agent)
                    .await
                    .map_err(|error| AgentConnectFailure::preflight(error.code, error.message))?;
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
                if let Some(selection) = hermes_runtime.as_ref() {
                    crate::hermes_runtime::apply_to_command(&mut cmd, agent, selection);
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
                    protocol: crate::hermes_runtime::effective_protocol(agent),
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
