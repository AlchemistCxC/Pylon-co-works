//! A1a：官方 SDK 连接引擎（D1=①）。
//!
//! 本模块只承载**协议栈接缝**：把 `agent-client-protocol 2.1.0` 的连接、字节桥与
//! wire 观测接到 Pylon 既有的 `AcpWireHub` 上。Pylon 的业务纪律（canonical 单一
//! 写者、owner/generation 校验、commit-before-publish）仍由 dispatcher/session 层
//! 负责，本模块不复制第二套状态。
//!
//! 接缝要点（对应施工书 §4/A1a 步骤 2–4）：
//!
//! 1. 进程归属不变：子进程仍由 `ManagedChild`（Windows Job Object）持有，SDK 只做协议；
//! 2. 字节桥：`tokio_util::compat::Compat` 把 tokio 流适配为 futures 流后交给 `ByteStreams`；
//! 3. wire capture：在 SDK 与字节流之间插 `Channel`，用 `Channel::bridge_with_inspection`
//!    逐帧观测后**原样转发**，因此 `id` 的 number/string/null 形态不会被改写
//!    （施工书写作 `Channel::bridge`，实名为 `bridge_with_inspection`，已记台账勘误）；
//! 4. 入站分发走**非类型化** `Dispatch<UntypedMessage, UntypedMessage>`：handler 内
//!    只做转发，不做同步阻塞（施工书 §3 第 9 条）。
//!
//! A1a 步骤 5–7 接线前，本模块仅供测试与后续接线使用（`allow(dead_code)`）。

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::{
    ByteStreams, Channel, Client, ConnectTo, Dispatch, Handled, Responder, TransportBatchEntry,
    TransportFrame, UntypedMessage,
};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::client::{ClassifiedMessage, NotificationInbox};
use super::error::AcpError;
use super::jsonrpc::{remove_pending_from, Pending, PreparedRpc, PENDING_SHARDS};
use super::transport::send_line;
use super::wire_trace::{AcpWireCapture, AcpWireHub, WireDirection};
use super::RawMessage;

/// D11：`AcpClient` 的内部后端。
///
/// 只保存 **transport 专属** 状态；共享状态（`child`/`protocol`/
/// `capability_registry`/`stderr_tail`/`wire_trace`/`crashed`/`crashed_watch`）
/// 上提为 `AcpClient` facade 字段。A1c 删 legacy 后本枚举收敛为单变体再删除。
pub(crate) enum AcpBackend {
    Legacy(LegacyBackend),
    Sdk(SdkBackend),
}

/// legacy（手写 JSON-RPC）后端的传输状态。
///
/// 名义可见性为 `pub` 仅为让 `#[cfg(test)]` 的 `Deref` 实现通过 `E0446` 检查；
/// 它位于私有 `mod engine` 下，**不在任何公开签名中出现**，字段仍为 `pub(crate)`。
pub struct LegacyBackend {
    pub(crate) write_tx: mpsc::Sender<String>,
    pub(crate) writer_task: Option<tokio::task::JoinHandle<()>>,
    pub(crate) next_id: Arc<AtomicU64>,
    pub(crate) pending: Arc<[Mutex<Pending>; PENDING_SHARDS]>,
    pub(crate) rx: broadcast::Receiver<ClassifiedMessage>,
    pub(crate) notification_inbox: NotificationInbox,
    pub(crate) active_replay_requests: Arc<Mutex<HashMap<u64, String>>>,
}

/// SDK 后端（官方 `agent-client-protocol` 连接）的传输状态。
///
/// 出站经有界 `outbound` 队列交给 `cx.spawn` 泵；入站直接产出
/// [`ClassifiedMessage`]，与 legacy 共用同一条 Kernel inbox 语义。
pub(crate) struct SdkBackend {
    pub(crate) outbound: mpsc::Sender<SdkOutbound>,
    /// D12：Pylon 相关 id 的本地计数器（wire id 永不暴露）。
    pub(crate) next_id: Arc<AtomicU64>,
    pub(crate) inbound: NotificationInbox,
    /// A1b：入站帧的 replay 观察扇出（legacy `rx` 的对应物）。
    pub(crate) replay_events: broadcast::Sender<ClassifiedMessage>,
    /// A1b：进行中的 replay 采集（Pylon id → sessionId），用于把匹配通知标记为 Replay。
    pub(crate) active_replay_requests: Arc<Mutex<HashMap<u64, String>>>,
    /// A1b：agent 发来的请求应答器（Pylon request id → Responder），供
    /// `ResponderHandle::Sdk` 在锁外应答。
    pub(crate) pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>>,
    pub(crate) shutdown: watch::Sender<bool>,
    pub(crate) join: tokio::task::JoinHandle<Result<(), agent_client_protocol::Error>>,
}

/// D11：后端中立应答句柄（在锁外使用，避免持锁等待写通道）。
///
/// `write_tx` 封在本类型内部，不泄漏到 facade 公开 API；A1b 起 SDK 变体
/// 改由 `Responder` 实现，A1a 阶段只构造 legacy。
pub(crate) enum ResponderHandle {
    Legacy {
        write_tx: mpsc::Sender<String>,
        crashed: Arc<AtomicBool>,
    },
    /// A1b：SDK 应答经引擎登记的 `Responder` 完成。
    Sdk {
        pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>>,
    },
}

impl ResponderHandle {
    pub(crate) fn legacy(write_tx: mpsc::Sender<String>, crashed: Arc<AtomicBool>) -> Self {
        Self::Legacy { write_tx, crashed }
    }

    /// 应答 agent 发来的 JSON-RPC 请求。
    pub(crate) async fn respond(
        self,
        request_id: super::RequestId,
        response: serde_json::Value,
    ) -> bool {
        match self {
            Self::Legacy { write_tx, crashed } => {
                crate::permission::send_agent_response(write_tx, crashed, request_id, response)
                    .await
            }
            Self::Sdk { pending_requests } => {
                let responder = pending_requests
                    .lock()
                    .ok()
                    .and_then(|mut pending| pending.remove(&request_id));
                match responder {
                    Some(responder) => responder.respond(response).is_ok(),
                    None => false,
                }
            }
        }
    }

    /// 以 JSON-RPC error 应答 agent 发来的请求。
    pub(crate) async fn respond_error(
        self,
        request_id: super::RequestId,
        rpc_code: i64,
        message: &str,
    ) -> bool {
        match self {
            Self::Legacy { write_tx, crashed } => {
                crate::permission::send_agent_error(
                    write_tx, crashed, request_id, rpc_code, message,
                )
                .await
            }
            Self::Sdk { pending_requests } => {
                let responder = pending_requests
                    .lock()
                    .ok()
                    .and_then(|mut pending| pending.remove(&request_id));
                match responder {
                    Some(responder) => responder
                        .respond_with_error(agent_client_protocol::Error::new(
                            rpc_code as i32,
                            message,
                        ))
                        .is_ok(),
                    None => false,
                }
            }
        }
    }
}

/// D11 ③：连接引擎选择（`connect_with_generation` 构造时读一次，运行中不得切换）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AcpEngineKind {
    Legacy,
    Sdk,
}

impl AcpEngineKind {
    /// 解析 `PYLON_ACP_ENGINE` 值：缺省 `legacy`；**非法值直接报错，不回退**。
    /// 旧实现将来会整体删除，不留「静默回退 legacy」这类需要清理的路径。
    pub(crate) fn parse(value: Option<&str>) -> Result<Self, AcpError> {
        match value {
            None | Some("legacy") => Ok(Self::Legacy),
            Some("sdk") => Ok(Self::Sdk),
            Some(other) => Err(AcpError::Child(format!(
                "invalid PYLON_ACP_ENGINE={other}: expected legacy|sdk"
            ))),
        }
    }

    /// 从环境变量读取（唯一入口；未设置 → legacy）。
    pub(crate) fn from_env() -> Result<Self, AcpError> {
        Self::parse(std::env::var("PYLON_ACP_ENGINE").ok().as_deref())
    }
}

/// 引擎连接配置（仅用于日志/诊断，不参与 canonical 身份）。
#[derive(Debug, Clone)]
pub(crate) struct SdkEngineConfig {
    /// 连接名（SDK 日志用）。
    pub name: String,
    /// 连接所属 client 代际（wire capture 用，与 legacy 一致）。
    pub client_generation: u64,
}

/// D12：`PreparedRpc` 的后端专属状态（`id` 与 `line` 由 facade 持有）。
///
/// `id` 是 **Pylon 相关 id**：legacy 恰等于 wire id（行为不变），SDK 用本地计数器；
/// wire id 永不暴露。
pub(crate) enum PreparedRpcBackend {
    Legacy(LegacyPreparedRpc),
    Sdk(SdkPreparedRpc),
}

pub(crate) struct LegacyPreparedRpc {
    pub(crate) write_tx: mpsc::Sender<String>,
    pub(crate) pending: Arc<[Mutex<Pending>; PENDING_SHARDS]>,
    pub(crate) rx: oneshot::Receiver<RawMessage>,
    pub(crate) crashed: Arc<AtomicBool>,
    pub(crate) line: String,
    pub(crate) rpc_timeout: std::time::Duration,
}

pub(crate) struct SdkPreparedRpc {
    pub(crate) outbound: mpsc::Sender<SdkOutbound>,
    pub(crate) method: String,
    pub(crate) params: serde_json::Value,
    pub(crate) line: String,
    pub(crate) rpc_timeout: std::time::Duration,
}

/// D12：`line` 仅供测试读取（A1c 删除）。
pub(crate) fn prepared_line(backend: &PreparedRpcBackend) -> &str {
    match backend {
        PreparedRpcBackend::Legacy(legacy) => &legacy.line,
        PreparedRpcBackend::Sdk(sdk) => &sdk.line,
    }
}

/// 发送请求行，成功时返回响应接收器（legacy 路径；SDK 后端 typed fail-closed）。
pub(crate) async fn send_keep_rx_prepared(
    prepared: PreparedRpc,
) -> Result<oneshot::Receiver<RawMessage>, AcpError> {
    let pylon_id = prepared.id;
    match prepared.backend {
        PreparedRpcBackend::Legacy(legacy) => {
            let LegacyPreparedRpc {
                write_tx,
                pending,
                rx,
                crashed,
                line,
                ..
            } = legacy;
            if let Err(error) = send_line(write_tx, line, &crashed).await {
                remove_pending_from(&pending, prepared.id);
                return Err(error);
            }
            // A6：发送后复检 crashed——reader EOF 先 store 后 drain。
            if crashed.load(std::sync::atomic::Ordering::Acquire) {
                remove_pending_from(&pending, prepared.id);
                return Err(AcpError::ConnectionClosed);
            }
            Ok(rx)
        }
        PreparedRpcBackend::Sdk(sdk) => {
            // A1b：把 SDK 的响应回调转回 `oneshot::Receiver<RawMessage>`，
            // 让 `wait_prompt_with_cancel` 的 legacy 机制（双超时/cancel/settle）原样复用。
            let (ready_tx, ready_rx) = oneshot::channel();
            sdk.outbound
                .send(SdkOutbound::RequestKeepRx {
                    method: sdk.method,
                    params: sdk.params,
                    ready: ready_tx,
                })
                .await
                .map_err(|_| AcpError::ConnectionClosed)?;
            let response_rx = ready_rx.await.map_err(|_| AcpError::ConnectionClosed)??;
            let (out_tx, out_rx) = oneshot::channel();
            tokio::spawn(async move {
                let raw = match response_rx.await {
                    Ok(Ok(value)) => RawMessage {
                        id: Some(super::RequestId::Number(pylon_id)),
                        method: None,
                        kind: super::AcpKind::Response,
                        result: Some(value),
                        params: None,
                        error: None,
                    },
                    Ok(Err(error)) => RawMessage {
                        id: Some(super::RequestId::Number(pylon_id)),
                        method: None,
                        kind: super::AcpKind::Response,
                        result: None,
                        params: None,
                        error: Some(serde_json::json!(error.to_string())),
                    },
                    Err(_) => return,
                };
                let _ = out_tx.send(raw);
            });
            Ok(out_rx)
        }
    }
}

/// 发送 + 等待匹配响应（legacy 走写通道/pending；SDK 走 outbound 泵 + `block_task`）。
pub(crate) async fn complete_prepared(
    prepared: PreparedRpc,
) -> Result<serde_json::Value, AcpError> {
    match prepared.backend {
        PreparedRpcBackend::Legacy(legacy) => {
            let LegacyPreparedRpc {
                write_tx,
                pending,
                rx,
                crashed,
                line,
                rpc_timeout,
            } = legacy;
            if let Err(error) = send_line(write_tx, line, &crashed).await {
                remove_pending_from(&pending, prepared.id);
                return Err(error);
            }
            if crashed.load(std::sync::atomic::Ordering::Acquire) {
                remove_pending_from(&pending, prepared.id);
                return Err(AcpError::ConnectionClosed);
            }
            let msg = match tokio::time::timeout(rpc_timeout, rx).await {
                Ok(Ok(msg)) => msg,
                Ok(Err(_)) => {
                    remove_pending_from(&pending, prepared.id);
                    return Err(AcpError::ConnectionClosed);
                }
                Err(_) => {
                    remove_pending_from(&pending, prepared.id);
                    return Err(AcpError::RpcTimeout);
                }
            };
            if let Some(err) = msg.error {
                return Err(AcpError::Rpc(format!("{}", err)));
            }
            Ok(msg.result.unwrap_or(serde_json::Value::Null))
        }
        PreparedRpcBackend::Sdk(sdk) => {
            let (reply_tx, reply_rx) = oneshot::channel();
            sdk.outbound
                .send(SdkOutbound::Request {
                    method: sdk.method,
                    params: sdk.params,
                    reply: reply_tx,
                })
                .await
                .map_err(|_| AcpError::ConnectionClosed)?;
            match tokio::time::timeout(sdk.rpc_timeout, reply_rx).await {
                Ok(Ok(result)) => result,
                Ok(Err(_)) => Err(AcpError::ConnectionClosed),
                Err(_) => Err(AcpError::RpcTimeout),
            }
        }
    }
}

/// 启动子进程（两后端共用）：preflight + Hermes runtime + env/cwd + `ManagedChild`。
///
/// 进程归属不变（Windows Job Object / taskkill / Drop 均在 `ManagedChild`）。
pub(crate) async fn spawn_agent_child(
    agent: &crate::agent_config::AgentDef,
    base_dir: Option<&std::path::Path>,
) -> Result<super::ManagedChild, AcpError> {
    use std::process::{Command, Stdio};

    if (agent.exe.contains('/') || agent.exe.contains('\\'))
        && !std::path::Path::new(&agent.exe).is_file()
    {
        return Err(super::error::AgentConnectFailure::preflight(
            "agent_executable_missing",
            format!(
                "agent {} 的 exe 路径不存在：{}（请在 设置 → Agent 中修改 agents.yaml 配置）",
                agent.name, agent.exe
            ),
        )
        .into());
    }
    let hermes_runtime = crate::hermes_runtime::prepare(agent)
        .await
        .map_err(|error| super::error::AgentConnectFailure::preflight(error.code, error.message))?;
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
    if let Some(hermes_home) = crate::hermes::hermes_home_override(agent, base_dir) {
        cmd.env("HERMES_HOME", &hermes_home);
        tracing::info!(
            "agent {}: HERMES_HOME set to {} (hermes_profile)",
            agent.name,
            hermes_home
        );
    }
    let child = cmd
        .spawn()
        .map_err(|error| super::error::AgentConnectFailure::spawn(&agent.exe, error))?;
    Ok(super::ManagedChild::new(child))
}

/// D12：SDK 后端的 `PreparedRpc` 构造（本地计数器分配 Pylon id，wire id 永不暴露）。
pub(crate) fn prepared_sdk_rpc(
    sdk: &SdkBackend,
    method: &str,
    params: serde_json::Value,
    rpc_timeout_secs: u64,
) -> Result<PreparedRpc, AcpError> {
    let id = sdk.next_id.fetch_add(1, Ordering::Relaxed);
    let line = serde_json::to_string(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params.clone()
    }))
    .map_err(|error| AcpError::Child(format!("serialize failed: {error}")))?;
    Ok(PreparedRpc {
        id,
        backend: PreparedRpcBackend::Sdk(SdkPreparedRpc {
            outbound: sdk.outbound.clone(),
            method: method.to_string(),
            params,
            line,
            rpc_timeout: std::time::Duration::from_secs(rpc_timeout_secs),
        }),
    })
}

/// 一条出站请求/通知（由 Pylon 既有 `prepare_rpc`/`prepare_prompt` 语义产生）。
///
/// SDK 的 dispatch loop 是单任务串行，因此出站一律经 `cx.spawn` 在独立任务中发送；
/// 本类型只承载「方法 + 参数 + 应答通道」，不复制 Pylon 的 pending 表。
pub(crate) enum SdkOutbound {
    /// 需要响应的 JSON-RPC 请求（非类型化）。
    Request {
        method: String,
        params: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<Result<serde_json::Value, AcpError>>,
    },
    /// A1b：发送后把响应接收器交回调用方（prompt 等待/取消语义复用 legacy 机制）。
    RequestKeepRx {
        method: String,
        params: serde_json::Value,
        ready: tokio::sync::oneshot::Sender<
            Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, AcpError>>, AcpError>,
        >,
    },
    /// 不需要响应的 JSON-RPC 通知。
    Notification {
        method: String,
        params: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<Result<(), AcpError>>,
    },
}

/// SDK 错误 → Pylon `AcpError`。
///
/// 四个 Pylon 独有变体（`ReplayTimeout`/`ReplayLagged`/`ReplayStreamClosed`/
/// `ReplayLoadInProgress`）由 Pylon 侧合成，不由 SDK 映射而来（施工书 A1-C6）。
pub(crate) fn map_sdk_error(error: agent_client_protocol::Error) -> AcpError {
    if agent_client_protocol::is_incoming_transport_closed(&error) {
        return AcpError::ConnectionClosed;
    }
    // 与 legacy 一致：把 JSON-RPC error 对象序列化为文本，下游
    // `AgentConnectFailure::initialize` 才能提取 `code`/`message`（远端 code 不丢）。
    match serde_json::to_string(&error) {
        Ok(raw) => AcpError::Rpc(raw),
        Err(_) => AcpError::Rpc(error.to_string()),
    }
}

/// 把一条 SDK 非类型化消息还原为 Pylon 入站帧（`Response` 返回 `None`，
/// 由 handler 内的 `ResponseRouter` 处理）。
pub(crate) fn classify_untyped(
    message: Dispatch<UntypedMessage, UntypedMessage>,
) -> Option<ClassifiedMessage> {
    let (method, params) = match message {
        Dispatch::Request(request, _responder) => {
            (request.method().to_string(), request.params().clone())
        }
        Dispatch::Notification(notification) => (
            notification.method().to_string(),
            notification.params().clone(),
        ),
        Dispatch::Response(_, _) => return None,
    };
    Some(ClassifiedMessage::live(RawMessage {
        id: None,
        kind: super::AcpKind::from_method(Some(&method)),
        method: Some(method),
        result: None,
        params: Some(params),
        error: None,
    }))
}

/// SDK wire request id → Pylon `RequestId`（null/absent → None）。
fn sdk_request_id_to_pylon(
    id: &agent_client_protocol::schema::v1::RequestId,
) -> Option<super::RequestId> {
    match id {
        agent_client_protocol::schema::v1::RequestId::Number(number) => {
            u64::try_from(*number).ok().map(super::RequestId::Number)
        }
        agent_client_protocol::schema::v1::RequestId::Str(text) => {
            Some(super::RequestId::String(text.clone()))
        }
        agent_client_protocol::schema::v1::RequestId::Null => None,
    }
}

/// A1b：标记 replay 分类并发布（broadcast 扇出 + 有界 inbox，满时丢帧不阻塞）。
fn publish_inbound(
    mut classified: ClassifiedMessage,
    replay_events: &broadcast::Sender<ClassifiedMessage>,
    active_replay_requests: &Arc<Mutex<HashMap<u64, String>>>,
    tx: &mpsc::Sender<ClassifiedMessage>,
) {
    if let Some(session_id) = classified
        .raw
        .params
        .as_ref()
        .and_then(|params| params.get("sessionId"))
        .and_then(serde_json::Value::as_str)
    {
        if let Ok(active) = active_replay_requests.lock() {
            if let Some((request_id, _)) = active.iter().find(|(_, id)| id.as_str() == session_id) {
                classified.classification = super::ReplayClassification::Replay {
                    request_id: *request_id,
                };
            }
        }
    }
    let _ = replay_events.send(classified.clone());
    if let Err(error) = tx.try_send(classified) {
        match error {
            tokio::sync::mpsc::error::TrySendError::Full(_) => {
                tracing::warn!("acp sdk engine: inbound queue full, dropping frame");
            }
            tokio::sync::mpsc::error::TrySendError::Closed(_) => {}
        }
    }
}

/// 构造 SDK 侧 transport 与观测桥之间的四端 `Channel` 拓扑。
///
/// 拓扑：`sdk_end <-> inspect_left  ==bridge==  inspect_right <-> child_end`。
/// `child_end` 由调用方接到子进程字节流（`ConnectTo`）。
pub(crate) fn bridge_channels() -> (Channel, Channel, Channel, Channel) {
    let (sdk_end, inspect_left) = Channel::duplex();
    let (inspect_right, child_end) = Channel::duplex();
    (sdk_end, inspect_left, inspect_right, child_end)
}

/// 运行观测桥：两个方向逐帧写入 `AcpWireHub`，原帧原样转发。
///
/// **自实现而非 SDK 的 `bridge_with_inspection`**：后者用 `try_join!` 等两个方向
/// 都结束，子进程 EOF 不会传播给 SDK 侧（实测 `crashed_watch` 永不触发）；
/// 这里任一方向结束即返回，两侧 sender 随之 drop，对端立即看到关闭。
///
/// 必须在独立任务中运行；`AcpWireHub::record` 为 infallible best-effort。
pub(crate) async fn run_wire_bridge(
    inspect_left: Channel,
    inspect_right: Channel,
    hub: Arc<AcpWireHub>,
) -> Result<(), agent_client_protocol::Error> {
    use futures_util::StreamExt as _;

    let Channel {
        rx: mut left_rx,
        tx: left_tx,
    } = inspect_left;
    let Channel {
        rx: mut right_rx,
        tx: right_tx,
    } = inspect_right;
    let to_agent = hub.clone();
    let to_pylon = hub;

    let left_to_right = async move {
        while let Some(frame) = left_rx.next().await {
            observe_frame(&frame, &to_agent, WireDirection::PylonToAgent);
            if right_tx.unbounded_send(frame).is_err() {
                break;
            }
        }
    };
    let right_to_left = async move {
        while let Some(frame) = right_rx.next().await {
            observe_frame(&frame, &to_pylon, WireDirection::AgentToPylon);
            if left_tx.unbounded_send(frame).is_err() {
                break;
            }
        }
    };
    tokio::select! {
        _ = left_to_right => {},
        _ = right_to_left => {},
    }
    Ok(())
}

/// 观测一条传输帧内的全部有效消息（batch 逐条）。
fn observe_frame(frame: &TransportFrame, hub: &AcpWireHub, direction: WireDirection) {
    let observe = |message: &agent_client_protocol::RawJsonRpcMessage| {
        if let Ok(value) = serde_json::to_value(message) {
            hub.record(direction, &value);
        }
    };
    match frame {
        TransportFrame::Single(message) => observe(message),
        TransportFrame::Malformed { .. } => {}
        TransportFrame::Batch(batch) => {
            for entry in batch.entries() {
                if let TransportBatchEntry::Message(message) = entry {
                    observe(message);
                }
            }
        }
    }
}

/// 用 `tokio_util::compat::Compat` 把 tokio 读写半流适配成 SDK 需要的 futures 字节流。
pub(crate) fn byte_streams<R, W>(read: R, write: W) -> ByteStreams<Compat<W>, Compat<R>>
where
    R: tokio::io::AsyncRead + Send + 'static,
    W: tokio::io::AsyncWrite + Send + 'static,
{
    ByteStreams::new(write.compat_write(), read.compat())
}

/// 启动 SDK 客户端连接任务：非类型化 dispatch → 有界入站队列（满时丢帧不阻塞），
/// `on_close` 置关闭信号；`shutdown` 触发时 `main_fn` 返回、连接收敛。
#[allow(
    clippy::too_many_arguments,
    reason = "装配函数：参数量随 A1b replay 扇出增加；A1c 收敛后端后合并为结构体"
)]
pub(crate) fn spawn_sdk_client(
    config: SdkEngineConfig,
    inbound_tx: tokio::sync::mpsc::Sender<ClassifiedMessage>,
    mut outbound_rx: tokio::sync::mpsc::Receiver<SdkOutbound>,
    transport: impl ConnectTo<Client> + 'static,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    crashed: Arc<AtomicBool>,
    crashed_watch: watch::Sender<bool>,
    replay_events: broadcast::Sender<ClassifiedMessage>,
    active_replay_requests: Arc<Mutex<HashMap<u64, String>>>,
    pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>>,
) -> tokio::task::JoinHandle<Result<(), agent_client_protocol::Error>> {
    let crashed_eof = crashed.clone();
    let crashed_watch_eof = crashed_watch.clone();
    tokio::spawn(async move {
        let result = Client
            .builder()
            .name(config.name)
            .on_receive_dispatch(
                move |message: Dispatch<UntypedMessage, UntypedMessage>, _cx| {
                    let tx = inbound_tx.clone();
                    let replay_events = replay_events.clone();
                    let active_replay_requests = active_replay_requests.clone();
                    let pending_requests = pending_requests.clone();
                    async move {
                        match message {
                            // 响应必须交回 SDK 的 SentRequest：若被 handler 认领而不路由，
                            // ResponseRouter 被丢弃，等响应的请求会以 oneshot canceled 失败。
                            Dispatch::Response(result, router) => {
                                router.route_with_result(result)?;
                            }
                            Dispatch::Request(request, responder) => {
                                // A1b：登记 Responder 供 `ResponderHandle::Sdk` 锁外应答。
                                let id = sdk_request_id_to_pylon(responder.id());
                                if let Some(id) = &id {
                                    if let Ok(mut pending) = pending_requests.lock() {
                                        pending.insert(id.clone(), responder);
                                    }
                                }
                                let classified = ClassifiedMessage::live(RawMessage {
                                    id,
                                    kind: super::AcpKind::from_method(Some(request.method())),
                                    method: Some(request.method().to_string()),
                                    result: None,
                                    params: Some(request.params().clone()),
                                    error: None,
                                });
                                publish_inbound(
                                    classified,
                                    &replay_events,
                                    &active_replay_requests,
                                    &tx,
                                );
                            }
                            Dispatch::Notification(notification) => {
                                let classified = ClassifiedMessage::live(RawMessage {
                                    id: None,
                                    kind: super::AcpKind::from_method(Some(notification.method())),
                                    method: Some(notification.method().to_string()),
                                    result: None,
                                    params: Some(notification.params().clone()),
                                    error: None,
                                });
                                publish_inbound(
                                    classified,
                                    &replay_events,
                                    &active_replay_requests,
                                    &tx,
                                );
                            }
                        }
                        Ok(Handled::Yes)
                    }
                },
                agent_client_protocol::on_receive_dispatch!(),
            )
            .on_close(move |_cx| {
                let crashed = crashed.clone();
                let crashed_watch = crashed_watch.clone();
                async move {
                    crashed.store(true, Ordering::Release);
                    let _ = crashed_watch.send(true);
                    Ok(())
                }
            })
            .connect_with(transport, async move |cx| {
                // 出站泵：每个请求在独立任务中发送，绝不阻塞 dispatch loop。
                loop {
                    tokio::select! {
                        _ = shutdown.changed() => break,
                        // 入站 EOF（子进程退出）等价 legacy reader 的崩溃信号：
                        // SDK 的 on_close 只在错误关闭时回调，干净 EOF 需在此显式置位。
                        _ = cx.incoming_closed() => {
                            crashed_eof.store(true, Ordering::Release);
                            let _ = crashed_watch_eof.send(true);
                            break;
                        }
                        outbound = outbound_rx.recv() => {
                            let Some(outbound) = outbound else { break };
                            let spawn_cx = cx.clone();
                            let task_cx = cx.clone();
                            let _ = spawn_cx.spawn(async move {
                                match outbound {
                                    SdkOutbound::Request { method, params, reply } => {
                                        let result = async {
                                            let message = UntypedMessage::new(&method, params)
                                                .map_err(map_sdk_error)?;
                                            task_cx.send_request(message).block_task().await
                                                .map_err(map_sdk_error)
                                        }
                                        .await;
                                        let _ = reply.send(result);
                                    }
                                    SdkOutbound::Notification { method, params, reply } => {
                                        let result = async {
                                            let message = UntypedMessage::new(&method, params)
                                                .map_err(map_sdk_error)?;
                                            task_cx.send_notification(message).map_err(map_sdk_error)
                                        }
                                        .await;
                                        let _ = reply.send(result);
                                    }
                                    SdkOutbound::RequestKeepRx { method, params, ready } => {
                                        let result = async {
                                            let message = UntypedMessage::new(&method, params)
                                                .map_err(map_sdk_error)?;
                                            let (resp_tx, resp_rx) = oneshot::channel();
                                            task_cx.send_request(message).on_receiving_result(
                                                move |response| {
                                                    let mapped = response.map_err(map_sdk_error);
                                                    async move {
                                                        let _ = resp_tx.send(mapped);
                                                        Ok(())
                                                    }
                                                },
                                            )
                                            .map_err(map_sdk_error)?;
                                            Ok(resp_rx)
                                        }
                                        .await;
                                        let _ = ready.send(result);
                                    }
                                }
                                Ok(())
                            });
                        }
                    }
                }
                Ok(())
            })
            .await;
        result
    })
}

/// 出站队列容量（有界；满时调用方拿到 `ConnectionClosed` 而不是无限堆积）。
const OUTBOUND_CHAN_CAP: usize = 256;

/// SDK 引擎构造产物（backend + 本连接 wire capture）。
pub(crate) struct SdkEngineHandles {
    pub(crate) backend: SdkBackend,
    pub(crate) wire: Arc<AcpWireCapture>,
}

/// 用 SDK 连接已由 Pylon spawn 的子进程（D1=①）。
///
/// 进程归属不变：子进程仍由 `ManagedChild`（Windows Job Object）持有；本函数只接
/// 协议栈：std 管道 → `tokio::process::ChildStdin/Stdout::from_std`（非阻塞 + 注册
/// runtime）→ `compat` → `ByteStreams` → 观测桥 → SDK client。
pub(crate) fn spawn_sdk_engine(
    agent: &crate::agent_config::AgentDef,
    client_generation: u64,
    stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
    wire: Arc<AcpWireCapture>,
    crashed: Arc<AtomicBool>,
    crashed_watch: watch::Sender<bool>,
) -> Result<SdkEngineHandles, AcpError> {
    let stdin = tokio::process::ChildStdin::from_std(stdin)
        .map_err(|error| AcpError::Child(format!("sdk engine stdin setup failed: {error}")))?;
    let stdout = tokio::process::ChildStdout::from_std(stdout)
        .map_err(|error| AcpError::Child(format!("sdk engine stdout setup failed: {error}")))?;

    let (sdk_end, sdk_bridge_side) = Channel::duplex();

    // 子进程字节流 → Channel（自持 relay，避免 SDK `Channel::connect_to` 的
    // `try_join!` 在单向 EOF 时不传播关闭）。
    let transport = byte_streams(stdout, stdin);
    let (child_channel, child_future) =
        <_ as ConnectTo<Client>>::into_channel_and_future(transport);

    // 观测桥：逐帧写入 wire hub，原帧原样转发；任一方向结束即返回。
    let bridge_wire = wire.clone();
    tokio::spawn(async move {
        let _ = run_wire_bridge(sdk_bridge_side, child_channel, bridge_wire).await;
    });
    let child_crashed = crashed.clone();
    let child_crashed_watch = crashed_watch.clone();
    tokio::spawn(async move {
        let _ = child_future.await;
        // 子侧传输结束 = 子进程退出（含 EOF）：等价 legacy reader 的崩溃信号。
        // 不依赖 SDK 的 EOF 语义（`incoming_closed` 在洪泛/批量场景未必及时完成）。
        child_crashed.store(true, Ordering::Release);
        let _ = child_crashed_watch.send(true);
    });

    let (inbound_tx, inbound_rx) = mpsc::channel(super::NOTIFICATION_CHAN_CAP);
    let (outbound_tx, outbound_rx) = mpsc::channel(OUTBOUND_CHAN_CAP);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (replay_events, _) = broadcast::channel(super::BROADCAST_CAP);
    let active_replay_requests: Arc<Mutex<HashMap<u64, String>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>> =
        Arc::new(Mutex::new(HashMap::new()));

    let join = spawn_sdk_client(
        SdkEngineConfig {
            name: agent.name.clone(),
            client_generation,
        },
        inbound_tx,
        outbound_rx,
        sdk_end,
        shutdown_rx,
        crashed,
        crashed_watch,
        replay_events.clone(),
        active_replay_requests.clone(),
        pending_requests.clone(),
    );

    Ok(SdkEngineHandles {
        backend: SdkBackend {
            outbound: outbound_tx,
            next_id: Arc::new(AtomicU64::new(1)),
            inbound: NotificationInbox::new(inbound_rx),
            replay_events,
            active_replay_requests,
            pending_requests,
            shutdown: shutdown_tx,
            join,
        },
        wire,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::RequestId;
    use agent_client_protocol::{RawJsonRpcMessage, TransportFrame};
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    fn engine_config() -> SdkEngineConfig {
        SdkEngineConfig {
            name: "pylon-engine-test".to_string(),
            client_generation: 1,
        }
    }

    /// A1a 步骤 2/4 证据：SDK 客户端连上字节流并**非类型化**收到 agent 通知。
    #[tokio::test]
    async fn sdk_engine_dispatches_untyped_notification() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (_, mut agent_write) = tokio::io::split(agent_io);

        let (inbound_tx, mut inbound_rx) = tokio::sync::mpsc::channel(8);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let _outbound_tx = outbound_tx;
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let crashed = Arc::new(AtomicBool::new(false));
        let (crashed_watch, mut crashed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            inbound_tx,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            crashed.clone(),
            crashed_watch,
            tokio::sync::broadcast::channel(8).0,
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        );

        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk"}}
        });
        agent_write
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .expect("agent write");
        agent_write.flush().await.expect("agent flush");

        let inbound = tokio::time::timeout(Duration::from_secs(5), inbound_rx.recv())
            .await
            .expect("inbound notification must arrive")
            .expect("inbound channel must stay open");
        assert_eq!(inbound.raw.method.as_deref(), Some("session/update"));
        assert_eq!(
            inbound.raw.params,
            Some(serde_json::json!({
                "sessionId": "s-1",
                "update": {"sessionUpdate": "agent_message_chunk"}
            }))
        );

        // A1a 步骤 4 证据：agent 端关闭 → SDK on_close 置位。
        drop(agent_write);
        tokio::time::timeout(Duration::from_secs(5), crashed_rx.changed())
            .await
            .expect("on_close must fire after transport EOF")
            .expect("crashed watch must stay open");
        assert!(*crashed_rx.borrow());
        assert!(crashed.load(Ordering::Acquire));

        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1a 步骤 5 证据：出站非类型化请求经 `cx.spawn` 发送并拿回响应。
    #[tokio::test]
    async fn sdk_engine_outbound_request_returns_response() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, mut agent_write) = tokio::io::split(agent_io);

        let (inbound_tx, _inbound_rx) = tokio::sync::mpsc::channel(8);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (crashed_watch, _crashed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            inbound_tx,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            Arc::new(AtomicBool::new(false)),
            crashed_watch,
            tokio::sync::broadcast::channel(8).0,
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        );

        // agent 端：读一条请求，按原 id 回一条 result；保持写端存活直到测试拿到响应，
        // 避免 EOF 与响应处理竞态。
        let (hold_tx, hold_rx) = tokio::sync::oneshot::channel::<()>();
        let agent_task = tokio::spawn(async move {
            let mut reader = BufReader::new(agent_read);
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
                .await
                .expect("agent must receive outbound request")
                .expect("agent read must succeed");
            let request: serde_json::Value =
                serde_json::from_str(line.trim()).expect("request json");
            assert_eq!(request["method"], "session/new");
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {"sessionId": "outbound-session"}
            });
            agent_write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .expect("agent write");
            agent_write.flush().await.expect("agent flush");
            let _ = hold_rx.await;
        });

        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        outbound_tx
            .send(SdkOutbound::Request {
                method: "session/new".to_string(),
                params: serde_json::json!({"cwd": "."}),
                reply: reply_tx,
            })
            .await
            .expect("outbound queue");
        let response = tokio::time::timeout(Duration::from_secs(5), reply_rx)
            .await
            .expect("outbound reply must arrive")
            .expect("reply channel must stay open")
            .expect("outbound request must succeed");
        assert_eq!(response["sessionId"], "outbound-session");

        let _ = hold_tx.send(());
        agent_task.await.expect("agent task");
        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1a 步骤 6（**硬门**）：入站队列满时丢帧、不阻塞 dispatch loop。
    #[tokio::test]
    async fn inbox_full_does_not_block_dispatch() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, mut agent_write) = tokio::io::split(agent_io);

        // 入站队列容量 1：连发 3 条通知必有 2 条被丢。
        let (inbound_tx, mut inbound_rx) = tokio::sync::mpsc::channel(1);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (crashed_watch, _crashed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            inbound_tx,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            Arc::new(AtomicBool::new(false)),
            crashed_watch,
            tokio::sync::broadcast::channel(8).0,
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        );

        let (hold_tx, hold_rx) = tokio::sync::oneshot::channel::<()>();
        let agent_task = tokio::spawn(async move {
            for index in 0..3 {
                let frame = serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {"sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk", "index": index}}
                });
                agent_write
                    .write_all(format!("{frame}\n").as_bytes())
                    .await
                    .expect("agent write");
            }
            agent_write.flush().await.expect("agent flush");
            // 入站队列已满仍必须能处理出站请求（否则 dispatch loop 被阻塞）。
            let mut reader = BufReader::new(agent_read);
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
                .await
                .expect("dispatch loop must stay responsive while inbox is full")
                .expect("agent read must succeed");
            let request: serde_json::Value =
                serde_json::from_str(line.trim()).expect("request json");
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {"ok": true}
            });
            agent_write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .expect("agent response write");
            agent_write.flush().await.expect("agent response flush");
            let _ = hold_rx.await;
        });

        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        outbound_tx
            .send(SdkOutbound::Request {
                method: "session/new".to_string(),
                params: serde_json::json!({"cwd": "."}),
                reply: reply_tx,
            })
            .await
            .expect("outbound queue");
        let response = tokio::time::timeout(Duration::from_secs(5), reply_rx)
            .await
            .expect("outbound reply must arrive while inbox is full")
            .expect("reply channel must stay open")
            .expect("outbound request must succeed");
        assert_eq!(response["ok"], true);

        // 队列只保留 1 条，其余被丢帧（try_send 失败不影响转发）。
        let first = inbound_rx.recv().await.expect("first notification kept");
        assert_eq!(first.raw.method.as_deref(), Some("session/update"));
        assert_eq!(
            first.raw.params,
            Some(
                serde_json::json!({"sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk", "index": 0}})
            )
        );

        let _ = hold_tx.send(());
        agent_task.await.expect("agent task");
        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1a 步骤 3 证据：观测桥逐帧写入 `AcpWireHub`（两个方向、id 形态保持）。
    #[tokio::test]
    async fn wire_bridge_records_both_directions_with_id_kind() {
        let (mut sdk_end, inspect_left, inspect_right, child_end) = bridge_channels();
        let agent = crate::test_utils::fake_acp_agent("fake-acp-bridge", "");
        let hub = AcpWireHub::for_agent(&agent, 1);
        let bridge = tokio::spawn(run_wire_bridge(inspect_left, inspect_right, hub.clone()));

        // agent → pylon：string id 请求帧（形态必须原样保留）
        let inbound = RawJsonRpcMessage::request(
            "session/request_permission".to_string(),
            serde_json::json!({"sessionId": "s-1"}),
            RequestId::Str("str-1".to_string()),
        )
        .expect("inbound request frame");
        child_end
            .tx
            .unbounded_send(TransportFrame::Single(inbound))
            .expect("child send");
        let forwarded = tokio::time::timeout(Duration::from_secs(5), sdk_end.rx.recv())
            .await
            .expect("bridge must forward frame")
            .expect("sdk side must stay open");
        assert!(matches!(forwarded, TransportFrame::Single(_)));

        // pylon → agent：number id 请求帧
        let outbound = RawJsonRpcMessage::request(
            "session/prompt".to_string(),
            serde_json::json!({"sessionId": "s-1"}),
            RequestId::Number(7),
        )
        .expect("outbound request frame");
        sdk_end
            .tx
            .unbounded_send(TransportFrame::Single(outbound))
            .expect("sdk send");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let records = loop {
            let records = hub.snapshot();
            if records.len() >= 2 {
                break records;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "wire hub must record both frames"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].direction, WireDirection::AgentToPylon);
        assert_eq!(
            records[0].id_kind,
            super::super::wire_trace::WireIdKind::String
        );
        assert_eq!(records[1].direction, WireDirection::PylonToAgent);
        assert_eq!(
            records[1].id_kind,
            super::super::wire_trace::WireIdKind::Number
        );

        bridge.abort();
        let _ = bridge.await;
    }

    /// A1b 步骤 7：agent 请求经 `ResponderHandle::Sdk` 在锁外应答（原值 id 回写）。
    #[tokio::test]
    async fn sdk_responder_answers_agent_request() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, mut agent_write) = tokio::io::split(agent_io);

        let (inbound_tx, _inbound_rx) = tokio::sync::mpsc::channel(8);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let _outbound_tx = outbound_tx;
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (crashed_watch, _crashed_rx) = tokio::sync::watch::channel(false);
        let pending: Arc<Mutex<HashMap<super::super::RequestId, Responder>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let handle = spawn_sdk_client(
            engine_config(),
            inbound_tx,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            Arc::new(AtomicBool::new(false)),
            crashed_watch,
            tokio::sync::broadcast::channel(8).0,
            Arc::new(Mutex::new(HashMap::new())),
            pending.clone(),
        );

        // agent 发一条 string-id 的 permission 请求。
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "perm-1",
            "method": "session/request_permission",
            "params": {"sessionId": "s-1", "toolCallId": "tc-1", "options": []}
        });
        agent_write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .expect("agent write");
        agent_write.flush().await.expect("agent flush");

        // 等引擎登记 Responder（Pylon id 为 String("perm-1")）。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if pending
                .lock()
                .unwrap()
                .contains_key(&super::super::RequestId::String("perm-1".to_string()))
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "engine must register the agent responder"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let responder = ResponderHandle::Sdk {
            pending_requests: pending,
        };
        assert!(
            responder
                .respond(
                    super::super::RequestId::String("perm-1".to_string()),
                    serde_json::json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}}),
                )
                .await,
            "sdk responder must answer"
        );

        // agent 读到同 id 的响应。
        let mut reader = BufReader::new(agent_read);
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
            .await
            .expect("agent must receive response")
            .expect("agent read must succeed");
        let response: serde_json::Value = serde_json::from_str(line.trim()).expect("response json");
        assert_eq!(response["id"], "perm-1");
        assert_eq!(response["result"]["outcome"]["optionId"], "allow_once");

        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1b 步骤 4 前置：进行中 replay 采集的 session 通知必须被标记为 Replay。
    #[tokio::test]
    async fn sdk_inbound_replay_notification_is_classified() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (_, mut agent_write) = tokio::io::split(agent_io);

        let (inbound_tx, _inbound_rx) = tokio::sync::mpsc::channel(8);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let _outbound_tx = outbound_tx;
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (crashed_watch, _crashed_rx) = tokio::sync::watch::channel(false);
        let (replay_tx, mut replay_rx) = tokio::sync::broadcast::channel(8);
        let active: Arc<Mutex<HashMap<u64, String>>> = Arc::new(Mutex::new(HashMap::new()));
        active.lock().unwrap().insert(42, "s-1".to_string());

        let handle = spawn_sdk_client(
            engine_config(),
            inbound_tx,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            Arc::new(AtomicBool::new(false)),
            crashed_watch,
            replay_tx,
            active,
            Arc::new(Mutex::new(HashMap::new())),
        );

        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "x"}}}
        });
        agent_write
            .write_all(
                format!(
                    "{frame}
"
                )
                .as_bytes(),
            )
            .await
            .expect("agent write");
        agent_write.flush().await.expect("agent flush");

        let classified = tokio::time::timeout(Duration::from_secs(5), replay_rx.recv())
            .await
            .expect("broadcast must deliver")
            .expect("broadcast must stay open");
        assert!(matches!(
            classified.classification,
            super::super::ReplayClassification::Replay { request_id: 42 }
        ));

        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1b 步骤 3 前置：SDK 的 `SentRequest` 被 drop 会自动发 `$/cancel_request`
    /// （与 Pylon「丢弃 pending 不发取消」不同——A1b 必须显式审计并锁定该差异）。
    #[tokio::test]
    async fn sent_request_drop_sends_cancel_request() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, _agent_write) = tokio::io::split(agent_io);

        let agent_task = tokio::spawn(async move {
            let mut reader = BufReader::new(agent_read);
            let mut request_line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut request_line))
                .await
                .expect("agent must receive request")
                .expect("agent read must succeed");
            let request: serde_json::Value =
                serde_json::from_str(request_line.trim()).expect("request json");
            assert_eq!(request["method"], "session/prompt");

            let mut cancel_line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut cancel_line))
                .await
                .expect("drop must send $/cancel_request")
                .expect("agent read must succeed");
            let cancel: serde_json::Value =
                serde_json::from_str(cancel_line.trim()).expect("cancel json");
            assert_eq!(cancel["method"], "$/cancel_request");
        });

        let transport = byte_streams(client_read, client_write);
        let handle = tokio::spawn(async move {
            Client
                .builder()
                .name("drop-cancel-probe")
                .connect_with(transport, async |cx| {
                    let request = UntypedMessage::new(
                        "session/prompt",
                        serde_json::json!({"sessionId": "s-1"}),
                    )?;
                    // 立即 drop：SDK 契约 = 自动发 $/cancel_request。
                    drop(cx.send_request(request));
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    Ok(())
                })
                .await
        });

        agent_task.await.expect("agent task");
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// D11 ③：flag 解析——缺省 legacy，非法值报错（**不回退**）。
    #[test]
    fn acp_engine_kind_parsing_rejects_invalid() {
        assert_eq!(AcpEngineKind::parse(None), Ok(AcpEngineKind::Legacy));
        assert_eq!(
            AcpEngineKind::parse(Some("legacy")),
            Ok(AcpEngineKind::Legacy)
        );
        assert_eq!(AcpEngineKind::parse(Some("sdk")), Ok(AcpEngineKind::Sdk));
        assert!(AcpEngineKind::parse(Some("SDK")).is_err());
        assert!(AcpEngineKind::parse(Some("")).is_err());
        assert!(AcpEngineKind::parse(Some("sacp")).is_err());
    }
}
