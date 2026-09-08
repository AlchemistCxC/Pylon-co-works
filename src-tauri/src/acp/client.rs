use super::*;
use std::collections::HashMap;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use super::engine::{
    prepared_sdk_rpc, AcpBackend, AcpEngineKind, LegacyBackend, LegacyPreparedRpc,
    PreparedRpcBackend, ResponderHandle, SdkOutbound,
};

pub struct AcpClient {
    child: ManagedChild,
    /// G1-02：per-agent 协议行为配置（connect_with_logs 从 agent.protocol() clone；
    /// disconnected() 用默认实例）。超时/限额/握手参数唯一读取点。
    pub(crate) protocol: crate::agent_config::AcpProtocolConfig,
    /// P1（能力协商暴露）：initialize 握手返回的 agentCapabilities（原始 Value，
    /// 含 loadSession/promptCapabilities/sessionCapabilities/mcpCapabilities 及
    /// _meta 私有扩展）。连接成功才有；断开/未连接为 None。客户端替换时随新
    /// AcpClient 自然更新（generation 隔离保证旧客户端不污染）。
    capability_registry: CapabilityRegistry,
    /// D11：transport 专属状态按后端存放（见 `acp/engine.rs` 的 [`AcpBackend`]）。
    /// 共享字段（child/protocol/capability_registry/stderr_tail/wire_trace/
    /// crashed/crashed_watch）保留在 facade。
    pub(crate) backend: AcpBackend,
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
    wire_trace: Option<Arc<AcpWireCapture>>,
    pub(crate) stderr_tail: Arc<StderrTail>,
}

/// Cloneable handle to the connection's single-consumer Kernel notification stream.
/// Receiver ownership and locking stay inside ACP; callers only learn ordered recv.
#[derive(Clone)]
pub(crate) struct NotificationInbox {
    rx: Arc<tokio::sync::Mutex<mpsc::Receiver<ClassifiedMessage>>>,
}

impl NotificationInbox {
    pub(crate) fn new(rx: mpsc::Receiver<ClassifiedMessage>) -> Self {
        Self {
            rx: Arc::new(tokio::sync::Mutex::new(rx)),
        }
    }

    pub(crate) async fn recv(&self) -> Option<ClassifiedMessage> {
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

/// Transport-owned classification produced once by the stdout reader and shared
/// by the Kernel inbox and replay observer. `_meta.periReplay` remains only a
/// compatibility projection of this decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReplayClassification {
    Live,
    Replay { request_id: u64 },
    Boundary { request_id: u64 },
}

#[derive(Debug, Clone)]
pub(crate) struct ClassifiedMessage {
    pub(crate) raw: RawMessage,
    pub(crate) classification: ReplayClassification,
}

impl ClassifiedMessage {
    pub(crate) fn live(raw: RawMessage) -> Self {
        Self {
            raw,
            classification: ReplayClassification::Live,
        }
    }
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
            capability_registry: CapabilityRegistry::default(),
            backend: AcpBackend::Legacy(LegacyBackend {
                write_tx,
                writer_task: None,
                next_id: Arc::new(AtomicU64::new(1)),
                pending: Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new()))),
                rx,
                notification_inbox: NotificationInbox::new(notification_rx),
                active_replay_requests: Arc::new(Mutex::new(HashMap::new())),
            }),
            crashed: Arc::new(AtomicBool::new(false)),
            crashed_watch,
            _crashed_watch_rx: crashed_watch_rx,
            wire_trace: None,
            stderr_tail: Arc::new(StderrTail::new()),
        }
    }

    /// D11：legacy 后端访问器（仅 legacy 路径与 `#[cfg(test)]` 使用；A1c 收敛后删除）。
    pub(crate) fn legacy(&self) -> &LegacyBackend {
        match &self.backend {
            AcpBackend::Legacy(legacy) => legacy,
            AcpBackend::Sdk(_) => unreachable!("legacy backend accessor used on sdk client"),
        }
    }

    #[cfg(test)]
    pub(crate) fn legacy_mut(&mut self) -> &mut LegacyBackend {
        match &mut self.backend {
            AcpBackend::Legacy(legacy) => legacy,
            AcpBackend::Sdk(_) => unreachable!("legacy backend accessor used on sdk client"),
        }
    }

    /// D11：取后端中立应答句柄（锁内取、锁外 await）。
    pub(crate) fn responder(&self) -> ResponderHandle {
        match &self.backend {
            AcpBackend::Legacy(legacy) => {
                ResponderHandle::legacy(legacy.write_tx.clone(), self.crashed.clone())
            }
            AcpBackend::Sdk(sdk) => ResponderHandle::Sdk {
                pending_requests: sdk.pending_requests.clone(),
            },
        }
    }

    pub fn remove_pending(&self, id: u64) {
        match &self.backend {
            AcpBackend::Legacy(legacy) => remove_pending_from(&legacy.pending, id),
            // A1b：SDK 侧改走 `SentRequest::cancel`。
            AcpBackend::Sdk(_) => {}
        }
    }

    fn pending_shard(&self, id: u64) -> &Mutex<Pending> {
        &self.legacy().pending[id as usize % PENDING_SHARDS]
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
        let (id, line) = Self::register_line(&self.legacy().next_id, method, params)?;
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
        match &self.backend {
            AcpBackend::Legacy(_) => {
                let (tx, rx) = oneshot::channel();
                let (id, line) = self.register_request(method, &params, Some(tx))?;
                Ok(PreparedRpc {
                    id,
                    backend: PreparedRpcBackend::Legacy(LegacyPreparedRpc {
                        write_tx: self.legacy().write_tx.clone(),
                        pending: self.legacy().pending.clone(),
                        rx,
                        crashed: self.crashed.clone(),
                        line,
                        rpc_timeout: std::time::Duration::from_secs(self.protocol.rpc_timeout()),
                    }),
                })
            }
            AcpBackend::Sdk(sdk) => Ok(prepared_sdk_rpc(
                sdk,
                method,
                params,
                self.protocol.rpc_timeout(),
            )?),
        }
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
        match &self.backend {
            AcpBackend::Legacy(_) => {
                let (tx, rx) = oneshot::channel();
                let (id, line) = self.register_request(METHOD_SESSION_PROMPT, &params, Some(tx))?;
                Ok(PreparedRpc {
                    id,
                    backend: PreparedRpcBackend::Legacy(LegacyPreparedRpc {
                        write_tx: self.legacy().write_tx.clone(),
                        pending: self.legacy().pending.clone(),
                        rx,
                        crashed: self.crashed.clone(),
                        line,
                        rpc_timeout: std::time::Duration::from_secs(self.protocol.rpc_timeout()),
                    }),
                })
            }
            AcpBackend::Sdk(sdk) => Ok(prepared_sdk_rpc(
                sdk,
                METHOD_SESSION_PROMPT,
                params,
                self.protocol.rpc_timeout(),
            )?),
        }
    }

    /// Kill the child process. Called before switching agents to prevent orphans.
    /// R4：同时 abort writer 任务——替换时旧 writer 可能正阻塞在 stdin 写（agent
    /// 不读 stdin，管道填满），任务随后在子进程终止、写失败后自行结束。
    pub fn kill(&mut self) -> Result<(), AcpError> {
        if self.stderr_tail.tail_since(0, 1, 512).lines.is_empty() {
            tracing::debug!("ACP connection closing without stderr evidence");
        }
        match &mut self.backend {
            AcpBackend::Legacy(legacy) => {
                if let Some(task) = legacy.writer_task.take() {
                    task.abort();
                }
            }
            AcpBackend::Sdk(sdk) => {
                let _ = sdk.shutdown.send(true);
                sdk.join.abort();
            }
        }
        self.child.kill_and_wait()
    }

    /// Check if the child process has exited unexpectedly.
    pub fn is_crashed(&self) -> bool {
        self.crashed.load(Ordering::Relaxed)
    }

    /// P1：initialize 握手返回的 agentCapabilities（连接成功才有）。
    pub(crate) fn agent_capabilities(&self) -> Option<&serde_json::Value> {
        self.capabilities().raw()
    }

    /// Typed, fail-closed view of the initialize negotiation.
    pub fn capabilities(&self) -> &CapabilityRegistry {
        &self.capability_registry
    }

    /// OBS-01：本连接的 ACP wire 只读记录器（断开态为 None）。
    pub fn wire_trace(&self) -> Option<Arc<AcpWireCapture>> {
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
        match &self.backend {
            AcpBackend::Legacy(_) => {
                let req = serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": method,
                    "params": params,
                });
                let line = serde_json::to_string(&req)
                    .map_err(|e| AcpError::Child(format!("serialize failed: {e}")))?;
                send_line(self.legacy().write_tx.clone(), line, &self.crashed).await
            }
            AcpBackend::Sdk(sdk) => {
                let (reply_tx, reply_rx) = oneshot::channel();
                sdk.outbound
                    .send(SdkOutbound::Notification {
                        method: method.to_string(),
                        params,
                        reply: reply_tx,
                    })
                    .await
                    .map_err(|_| AcpError::ConnectionClosed)?;
                reply_rx.await.unwrap_or(Err(AcpError::ConnectionClosed))
            }
        }
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
        send_line(self.legacy().write_tx.clone(), line, &self.crashed).await
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
                // D11 ③：引擎选择在构造时读一次（非法值报错，无回退）。
                let engine_kind = AcpEngineKind::from_env()?;
                let mut child =
                    super::engine::spawn_agent_child(agent, base_dir.as_deref()).await?;
                let (crashed_watch, crashed_watch_rx) = watch::channel(false);
                let crashed = Arc::new(AtomicBool::new(false));
                // OBS-02：hub 以连接级 correlation context（含 clientGeneration）构造。
                let wire_trace = AcpWireHub::for_agent(agent, client_generation);

                // Drain stderr（防管道缓冲死锁；两后端共用）
                let stderr = child
                    .take_stderr()
                    .map_err(|error| AgentConnectFailure::spawn_setup(error.to_string()))?;
                let stderr_tail = Arc::new(StderrTail::new());
                spawn_stderr_reader(
                    stderr,
                    &agent.name,
                    &runtime_logs,
                    Some(wire_trace.correlation().clone()),
                    stderr_tail.clone(),
                );

                let backend = match engine_kind {
                    AcpEngineKind::Legacy => {
                        let stdin = child
                            .take_stdin()
                            .map_err(|error| AgentConnectFailure::spawn_setup(error.to_string()))?;
                        let (write_tx, write_rx) = mpsc::channel::<String>(WRITE_CHAN_CAP);
                        let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
                            Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
                        let (tx, rx) = broadcast::channel(BROADCAST_CAP);
                        let (notification_tx, notification_rx) =
                            mpsc::channel(NOTIFICATION_CHAN_CAP);
                        let active_replay_requests = Arc::new(Mutex::new(HashMap::new()));
                        // G1-05：三线程启动收敛为私有函数（S3 卫生，行为零变化）。
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
                        let stdout = BufReader::new(child.take_stdout().map_err(|error| {
                            AgentConnectFailure::spawn_setup(error.to_string())
                        })?);
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
                        AcpBackend::Legacy(LegacyBackend {
                            write_tx,
                            writer_task: Some(writer_task),
                            next_id: Arc::new(AtomicU64::new(1)),
                            pending,
                            rx,
                            notification_inbox: NotificationInbox::new(notification_rx),
                            active_replay_requests,
                        })
                    }
                    AcpEngineKind::Sdk => {
                        let stdin = child
                            .take_stdin()
                            .map_err(|error| AgentConnectFailure::spawn_setup(error.to_string()))?;
                        let stdout = child
                            .take_stdout()
                            .map_err(|error| AgentConnectFailure::spawn_setup(error.to_string()))?;
                        let pid = child.pid();
                        let handles = super::engine::spawn_sdk_engine(
                            agent,
                            client_generation,
                            stdin,
                            stdout,
                            wire_trace.clone(),
                            crashed.clone(),
                            crashed_watch.clone(),
                        )?;
                        // 子进程退出是权威崩溃信号（SDK 的 EOF 语义在洪泛/批量场景不可靠）。
                        if let Some(pid) = pid {
                            let crashed = crashed.clone();
                            let crashed_watch = crashed_watch.clone();
                            if !ManagedChild::spawn_exit_watcher(pid, move || {
                                crashed.store(true, std::sync::atomic::Ordering::Release);
                                let _ = crashed_watch.send(true);
                            }) {
                                tracing::warn!(
                                    "acp sdk engine: exit watcher unavailable for pid {pid}"
                                );
                            }
                        }
                        AcpBackend::Sdk(handles.backend)
                    }
                };

                let mut client = AcpClient {
                    child,
                    protocol: crate::hermes_runtime::effective_protocol(agent),
                    capability_registry: CapabilityRegistry::default(),
                    backend,
                    crashed,
                    crashed_watch,
                    _crashed_watch_rx: crashed_watch_rx,
                    wire_trace: Some(wire_trace),
                    stderr_tail: stderr_tail.clone(),
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
                        let mut failure = AgentConnectFailure::initialize(error, exit_code);
                        let tail = stderr_tail.tail_since(0, 8, 2048);
                        if !tail.lines.is_empty() {
                            failure.stderr_excerpt = Some(tail.lines.join("\n"));
                        }
                        return Err(failure.into());
                    }
                };
                // P1（能力协商暴露）：握手响应的 agentCapabilities 存起来——前端
                // 能力驱动 UI（loadSession/image/fork/resume/mcp）经 agent_status
                // 读取；未声明时保持 None。
                client.capability_registry =
                    match CapabilityRegistry::from_initialize_response(&initialize_response) {
                        Ok(registry) => registry,
                        Err(message) => {
                            let mut failure = AgentConnectFailure::capability(message);
                            let tail = stderr_tail.tail_since(0, 8, 2048);
                            if !tail.lines.is_empty() {
                                failure.stderr_excerpt = Some(tail.lines.join("\n"));
                            }
                            return Err(failure.into());
                        }
                    };
                Ok(client)
            }
            other => Err(AgentConnectFailure::preflight(
                "agent_transport_unsupported",
                format!("unsupported transport: {other}"),
            )
            .into()),
        }
    }

    /// Obtain the one Kernel notification inbox for this connection generation.
    pub(crate) fn notification_inbox(&self) -> NotificationInbox {
        match &self.backend {
            AcpBackend::Legacy(legacy) => legacy.notification_inbox.clone(),
            AcpBackend::Sdk(sdk) => sdk.inbound.clone(),
        }
    }
}

// D11 过渡：测试代码仍按旧字段名访问 legacy 传输状态（`client.write_tx` /
// `client.active_replay_requests`）。用 `#[cfg(test)]` 的 Deref 保持测试文件零改动，
// 生产代码必须经 `legacy()` / `responder()` 访问；A1c 删 legacy 后一并删除。
#[cfg(test)]
impl std::ops::Deref for AcpClient {
    type Target = LegacyBackend;

    fn deref(&self) -> &LegacyBackend {
        self.legacy()
    }
}

#[cfg(test)]
impl std::ops::DerefMut for AcpClient {
    fn deref_mut(&mut self) -> &mut LegacyBackend {
        self.legacy_mut()
    }
}
