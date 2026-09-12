use super::*;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, oneshot, watch};

use super::engine::{prepared_sdk_rpc, ResponderHandle, SdkBackend, SdkOutbound};

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
    /// A1c：SDK 引擎是唯一后端（legacy 传输 `AcpBackend::Legacy` 已删除）。
    /// 共享字段（child/protocol/capability_registry/stderr_tail/wire_trace/
    /// crashed/crashed_watch）保留在 facade。
    pub(crate) backend: SdkBackend,
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
    /// B2：initialize 是否完成。session/new 之前必须为 true——守卫在
    /// `session_ready()` 消费，禁止任何绕过握手的会话建立。
    session_ready: AtomicBool,
    /// B2：catalog 声明的会话建立顺序（connect 时按 provider 解析；无 catalog
    /// profile 时为默认 resume→load→new）。revive 链与
    /// `session_establishment_channels` 一起做「声明 ∩ 服务端广告」交集。
    establishment_order: Vec<String>,
}

/// Default establishment order when no catalog profile declares one: the
/// pre-B2 behavior (resume → load → new), which every current catalog entry
/// also declares.
fn default_establishment_order() -> Vec<String> {
    ["resume", "load", "new"]
        .into_iter()
        .map(String::from)
        .collect()
}

/// Catalog-declared establishment order for a provider; unknown/absent
/// provider keeps the default (fail-open here is deliberate: an unknown
/// provider must not silently lose session revival — the server advertisement
/// side still gates every channel).
fn declared_establishment_order(provider: Option<&str>) -> Vec<String> {
    let Some(provider) = provider else {
        return default_establishment_order();
    };
    let Ok(Some(profile)) = pylon_core::agent_catalog::provider_profile(provider) else {
        return default_establishment_order();
    };
    let order: Vec<String> = profile
        .session_establishment
        .order
        .iter()
        .map(|method| match method {
            pylon_core::agent_catalog::CatalogSessionMethod::Resume => "resume",
            pylon_core::agent_catalog::CatalogSessionMethod::Load => "load",
            pylon_core::agent_catalog::CatalogSessionMethod::New => "new",
        })
        .map(String::from)
        .collect();
    if order.is_empty() {
        default_establishment_order()
    } else {
        order
    }
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
    /// `RequestId::Number`。
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
    pub(crate) wire_ordinal: Option<u64>,
}

impl ClassifiedMessage {
    pub(crate) fn live(raw: RawMessage) -> Self {
        Self {
            raw,
            classification: ReplayClassification::Live,
            wire_ordinal: None,
        }
    }
}

impl AcpClient {
    pub fn disconnected() -> Self {
        let (outbound, outbound_rx) = mpsc::channel(1);
        drop(outbound_rx);
        let (inbound_tx, inbound_rx) = mpsc::channel(NOTIFICATION_CHAN_CAP);
        drop(inbound_tx);
        let (replay_events, _) = broadcast::channel(BROADCAST_CAP);
        let (shutdown, _) = watch::channel(false);
        let (crashed_watch, crashed_watch_rx) = watch::channel(false);
        Self {
            child: ManagedChild::empty(),
            protocol: crate::agent_config::AcpProtocolConfig::default(),
            capability_registry: CapabilityRegistry::default(),
            session_ready: AtomicBool::new(false),
            establishment_order: default_establishment_order(),
            backend: SdkBackend {
                outbound,
                next_id: Arc::new(AtomicU64::new(1)),
                inbound: NotificationInbox::new(inbound_rx),
                replay_events,
                active_replay_requests: Arc::new(Mutex::new(HashMap::new())),
                pending_requests: Arc::new(Mutex::new(HashMap::new())),
                shutdown,
                join: None,
            },
            crashed: Arc::new(AtomicBool::new(false)),
            crashed_watch,
            _crashed_watch_rx: crashed_watch_rx,
            wire_trace: None,
            stderr_tail: Arc::new(StderrTail::new()),
        }
    }

    /// D11：取后端中立应答句柄（锁内取、锁外 await）。
    pub(crate) fn responder(&self) -> ResponderHandle {
        ResponderHandle {
            pending_requests: self.backend.pending_requests.clone(),
        }
    }

    /// A1b：SDK 侧 pending 由 `SentRequest::cancel` / 响应路由自动清理，无需 facade 介入。
    pub fn remove_pending(&self, _id: u64) {}

    /// Send a JSON-RPC request and wait for the matching response.
    /// 同步准备一次 JSON-RPC 请求（登记 pending + 序列化），不写入 stdin。
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
        prepared_sdk_rpc(&self.backend, method, params, self.protocol.rpc_timeout())
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
    /// （含写超时与失败路径 pending 清理），等待经 [`wait_prompt_with_cancel`]。
    pub fn prepare_prompt(
        &self,
        session_id: &str,
        prompt: Vec<serde_json::Value>,
    ) -> Result<PreparedRpc, AcpError> {
        // 审查修复：与 prepare_rpc 一致，死亡连接立即拒绝（否则挂满 300s 假超时）
        if self.is_crashed() {
            return Err(AcpError::ConnectionClosed);
        }
        // 先构造参数（可能因 block 格式失败），成功后再登记请求，避免泄漏。
        let params = session_prompt_params(session_id, prompt)?;
        prepared_sdk_rpc(
            &self.backend,
            METHOD_SESSION_PROMPT,
            params,
            self.protocol.rpc_timeout(),
        )
    }

    /// Kill the child process. Called before switching agents to prevent orphans.
    /// R4：同时 abort 引擎任务——替换时旧任务可能正阻塞在写通道，随后在子进程
    /// 终止、写失败后自行结束。
    pub fn kill(&mut self) -> Result<(), AcpError> {
        if self.stderr_tail.tail_since(0, 1, 512).lines.is_empty() {
            tracing::debug!("ACP connection closing without stderr evidence");
        }
        let _ = self.backend.shutdown.send(true);
        if let Some(join) = self.backend.join.take() {
            join.abort();
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

    /// B2：initialize 是否完成（session/new 守卫的数据源）。
    pub fn session_ready(&self) -> bool {
        self.session_ready
            .load(std::sync::atomic::Ordering::Acquire)
    }

    /// B2：catalog 声明的会话建立顺序（revive 链交集的声明侧）。
    pub fn establishment_order(&self) -> &[String] {
        &self.establishment_order
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
        let (reply_tx, reply_rx) = oneshot::channel();
        self.backend
            .outbound
            .send(SdkOutbound::Notification {
                method: method.to_string(),
                params,
                reply: reply_tx,
            })
            .await
            .map_err(|_| AcpError::ConnectionClosed)?;
        reply_rx.await.unwrap_or(Err(AcpError::ConnectionClosed))
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
                let mut child =
                    super::engine::spawn_agent_child(agent, base_dir.as_deref()).await?;
                let (crashed_watch, crashed_watch_rx) = watch::channel(false);
                let crashed = Arc::new(AtomicBool::new(false));
                // OBS-02：hub 以连接级 correlation context（含 clientGeneration）构造。
                let wire_trace = AcpWireHub::for_agent(agent, client_generation);

                // Drain stderr（防管道缓冲死锁）
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
                        tracing::warn!("acp sdk engine: exit watcher unavailable for pid {pid}");
                    }
                }

                let mut client = AcpClient {
                    child,
                    protocol: crate::hermes_runtime::effective_protocol(agent),
                    capability_registry: CapabilityRegistry::default(),
                    backend: handles.backend,
                    crashed,
                    crashed_watch,
                    _crashed_watch_rx: crashed_watch_rx,
                    wire_trace: Some(wire_trace),
                    stderr_tail: stderr_tail.clone(),
                    session_ready: AtomicBool::new(false),
                    establishment_order: declared_establishment_order(agent.provider.as_deref()),
                };
                let stderr_mark = stderr_tail.mark();
                // Initialize——B2：握手三段由纯函数 `build_initialize_plan` 成形
                // （G1-03 覆盖制语义不变：clientCapabilities D1 / protocolVersion H3 /
                // clientInfo H4，wire 逐字节不变），client 只消费计划。
                // A3：caps 合并/形状失败即连接失败（不静默用默认 caps 继续握手）。
                let initialize_plan = super::initialize_plan::build_initialize_plan(
                    &client.protocol,
                    agent.provider.as_deref(),
                )?;
                let initialize_response = match client
                    .call_async(METHOD_INITIALIZE, initialize_plan.params())
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
                        let tail = stderr_tail.tail_since(stderr_mark, 8, 2048);
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
                            let tail = stderr_tail.tail_since(stderr_mark, 8, 2048);
                            if !tail.lines.is_empty() {
                                failure.stderr_excerpt = Some(tail.lines.join("\n"));
                            }
                            return Err(failure.into());
                        }
                    };
                // B2：initialize 完成（能力协商成功）之后，session/new 才被允许。
                client
                    .session_ready
                    .store(true, std::sync::atomic::Ordering::Release);
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
        self.backend.inbound.clone()
    }
}
