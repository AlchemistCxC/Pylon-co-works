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
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};

use agent_client_protocol::{
    ByteStreams, Channel, Client, ConnectTo, Dispatch, Handled, UntypedMessage,
};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::client::{ClassifiedMessage, NotificationInbox};
use super::error::AcpError;
use super::jsonrpc::{remove_pending_from, Pending, PreparedRpc, PENDING_SHARDS};
use super::transport::send_line;
use super::wire_trace::{AcpWireHub, WireDirection};
use super::RawMessage;

/// D11：`AcpClient` 的内部后端。
///
/// 只保存 **transport 专属** 状态；共享状态（`child`/`protocol`/
/// `capability_registry`/`stderr_tail`/`wire_trace`/`crashed`/`crashed_watch`）
/// 上提为 `AcpClient` facade 字段。A1c 删 legacy 后本枚举收敛为单变体再删除。
pub(crate) enum AcpBackend {
    Legacy(LegacyBackend),
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

/// D11：后端中立应答句柄（在锁外使用，避免持锁等待写通道）。
///
/// `write_tx` 封在本类型内部，不泄漏到 facade 公开 API；A1b 起 SDK 变体
/// 改由 `Responder` 实现，A1a 阶段只构造 legacy。
pub(crate) struct ResponderHandle {
    write_tx: mpsc::Sender<String>,
    crashed: Arc<AtomicBool>,
}

impl ResponderHandle {
    pub(crate) fn legacy(write_tx: mpsc::Sender<String>, crashed: Arc<AtomicBool>) -> Self {
        Self { write_tx, crashed }
    }

    /// 应答 agent 发来的 JSON-RPC 请求。
    pub(crate) async fn respond(
        self,
        request_id: super::RequestId,
        response: serde_json::Value,
    ) -> bool {
        crate::permission::send_agent_response(self.write_tx, self.crashed, request_id, response)
            .await
    }

    /// 以 JSON-RPC error 应答 agent 发来的请求。
    pub(crate) async fn respond_error(
        self,
        request_id: super::RequestId,
        rpc_code: i64,
        message: &str,
    ) -> bool {
        crate::permission::send_agent_error(
            self.write_tx,
            self.crashed,
            request_id,
            rpc_code,
            message,
        )
        .await
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

/// 一条入站原始帧（由 SDK dispatch handler 还原，投给 Pylon 既有消费链）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SdkInbound {
    /// agent → pylon 请求（method + params），需 Pylon 侧应答（A1b 的 Responder 化）。
    Request {
        method: String,
        params: serde_json::Value,
    },
    /// agent → pylon 通知。
    Notification {
        method: String,
        params: serde_json::Value,
    },
    /// 我方请求的响应。
    Response { error: Option<String> },
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
    let PreparedRpcBackend::Legacy(legacy) = prepared.backend else {
        return Err(AcpError::EngineUnsupported {
            engine: "sdk",
            operation: "send_keep_rx",
        });
    };
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
    AcpError::Rpc(error.to_string())
}

/// 把一条 SDK 非类型化消息还原为 Pylon 入站帧。
pub(crate) fn classify_untyped(message: Dispatch<UntypedMessage, UntypedMessage>) -> SdkInbound {
    match message {
        Dispatch::Request(request, _responder) => SdkInbound::Request {
            method: request.method().to_string(),
            params: request.params().clone(),
        },
        Dispatch::Notification(notification) => SdkInbound::Notification {
            method: notification.method().to_string(),
            params: notification.params().clone(),
        },
        Dispatch::Response(result, _router) => SdkInbound::Response {
            error: result.err().map(|error| error.to_string()),
        },
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
/// 必须在独立任务中运行；`AcpWireHub::record` 为 infallible best-effort，
/// 不会阻塞 SDK 的 dispatch loop。
pub(crate) async fn run_wire_bridge(
    inspect_left: Channel,
    inspect_right: Channel,
    hub: Arc<AcpWireHub>,
) -> Result<(), agent_client_protocol::Error> {
    let to_agent_hub = hub.clone();
    let to_pylon_hub = hub;
    Channel::bridge_with_inspection(
        inspect_left,
        inspect_right,
        move |message| {
            if let Ok(value) = serde_json::to_value(message) {
                to_agent_hub.record(WireDirection::PylonToAgent, &value);
            }
            Ok(())
        },
        move |message| {
            if let Ok(value) = serde_json::to_value(message) {
                to_pylon_hub.record(WireDirection::AgentToPylon, &value);
            }
            Ok(())
        },
    )
    .await
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
pub(crate) fn spawn_sdk_client(
    config: SdkEngineConfig,
    inbound_tx: tokio::sync::mpsc::Sender<SdkInbound>,
    mut outbound_rx: tokio::sync::mpsc::Receiver<SdkOutbound>,
    transport: impl ConnectTo<Client> + 'static,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    closed_tx: tokio::sync::watch::Sender<bool>,
) -> tokio::task::JoinHandle<Result<(), agent_client_protocol::Error>> {
    tokio::spawn(async move {
        let result = Client
            .builder()
            .name(config.name)
            .on_receive_dispatch(
                move |message: Dispatch<UntypedMessage, UntypedMessage>, _cx| {
                    let tx = inbound_tx.clone();
                    async move {
                        match message {
                            // 响应必须交回 SDK 的 SentRequest：若被 handler 认领而不路由，
                            // ResponseRouter 被丢弃，等响应的请求会以 oneshot canceled 失败。
                            Dispatch::Response(result, router) => {
                                router.route_with_result(result)?;
                            }
                            request_or_notification => {
                                let inbound = classify_untyped(request_or_notification);
                                if let Err(error) = tx.try_send(inbound) {
                                    match error {
                                        tokio::sync::mpsc::error::TrySendError::Full(_) => {
                                            tracing::warn!(
                                                "acp sdk engine: inbound queue full, dropping frame"
                                            );
                                        }
                                        tokio::sync::mpsc::error::TrySendError::Closed(_) => {}
                                    }
                                }
                            }
                        }
                        Ok(Handled::Yes)
                    }
                },
                agent_client_protocol::on_receive_dispatch!(),
            )
            .on_close(move |_cx| {
                let closed_tx = closed_tx.clone();
                async move {
                    let _ = closed_tx.send(true);
                    Ok(())
                }
            })
            .connect_with(transport, async move |cx| {
                // 出站泵：每个请求在独立任务中发送，绝不阻塞 dispatch loop。
                loop {
                    tokio::select! {
                        _ = shutdown.changed() => break,
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
        let (closed_tx, mut closed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            inbound_tx,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            closed_tx,
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
        assert_eq!(
            inbound,
            SdkInbound::Notification {
                method: "session/update".to_string(),
                params: serde_json::json!({
                    "sessionId": "s-1",
                    "update": {"sessionUpdate": "agent_message_chunk"}
                }),
            }
        );

        // A1a 步骤 4 证据：agent 端关闭 → SDK on_close 置位。
        drop(agent_write);
        tokio::time::timeout(Duration::from_secs(5), closed_rx.changed())
            .await
            .expect("on_close must fire after transport EOF")
            .expect("closed watch must stay open");
        assert!(*closed_rx.borrow());

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
        let (closed_tx, _closed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            inbound_tx,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            closed_tx,
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
        let (closed_tx, _closed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            inbound_tx,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            closed_tx,
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
        assert_eq!(
            first,
            SdkInbound::Notification {
                method: "session/update".to_string(),
                params: serde_json::json!({"sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk", "index": 0}}),
            }
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

    /// D12 证据：SDK 后端的 `send_keep_rx()` 必须 typed fail-closed（不是 Child(String)）。
    #[tokio::test]
    async fn sdk_send_keep_rx_fails_closed() {
        let (outbound_tx, _outbound_rx) = tokio::sync::mpsc::channel(1);
        let rpc = super::super::jsonrpc::PreparedRpc {
            id: 11,
            backend: PreparedRpcBackend::Sdk(SdkPreparedRpc {
                outbound: outbound_tx,
                method: "session/prompt".to_string(),
                params: serde_json::json!({"sessionId": "s-1"}),
                line: "test-line".to_string(),
                rpc_timeout: Duration::from_secs(1),
            }),
        };
        let error = rpc
            .send_keep_rx()
            .await
            .expect_err("sdk send_keep_rx must fail closed");
        assert!(matches!(
            error,
            AcpError::EngineUnsupported {
                engine: "sdk",
                operation: "send_keep_rx"
            }
        ));
    }
}
