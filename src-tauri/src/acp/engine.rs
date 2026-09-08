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

use std::sync::Arc;

use agent_client_protocol::{
    ByteStreams, Channel, Client, ConnectTo, Dispatch, Handled, UntypedMessage,
};
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::wire_trace::{AcpWireHub, WireDirection};

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
                    let inbound = classify_untyped(message);
                    let tx = inbound_tx.clone();
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
                    std::future::ready(Ok::<_, agent_client_protocol::Error>(Handled::Yes))
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
            .connect_with(transport, async move |_cx| {
                // 连接存活直到调用方发出 shutdown（Drop 掉发送端也会唤醒）。
                let _ = shutdown.changed().await;
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
    use tokio::io::AsyncWriteExt;

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
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (closed_tx, mut closed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            inbound_tx,
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
}
