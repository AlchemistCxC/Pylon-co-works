//! JSON-RPC pending 注册表与响应结算（R11/P3-3 拆分自 acp.rs；行为零变化）。
//!
//! pending 分片（`PENDING_SHARDS=16`）避免所有 JSON-RPC 请求竞争一把全局锁；
//! `PreparedRpc` 在锁内准备（注册 + 序列化）、锁外发送与等待，避免 ACP 卡顿时
//! 阻塞整个 AppState。EOF/超时/crash 路径统一清理 pending（不悬挂）。

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, oneshot};

use super::transport::{send_line, DEFAULT_WRITE_TIMEOUT_SECS};
use super::{AcpError, AcpKind, RawMessage};

/// JSON-RPC 挂起请求表（request id → 响应通道）。分片锁：避免所有请求竞争
/// 一把全局锁。
pub(crate) type Pending = HashMap<u64, oneshot::Sender<RawMessage>>;

/// pending 分片数：`id % PENDING_SHARDS` 定位分片。
pub(crate) const PENDING_SHARDS: usize = 16;

/// 准备好的 JSON-RPC 请求：注册 pending 后的完整发送单元（发送与等待在锁外）。
pub struct PreparedRpc {
    pub id: u64,
    pub line: String,
    pub write_tx: mpsc::Sender<String>,
    pub rx: oneshot::Receiver<RawMessage>,
    pub(crate) pending: Arc<[Mutex<Pending>; PENDING_SHARDS]>,
    pub(crate) crashed: Arc<AtomicBool>,
    pub(crate) rpc_timeout: std::time::Duration,
}

pub(crate) fn remove_pending_from(pending: &Arc<[Mutex<Pending>; PENDING_SHARDS]>, id: u64) {
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
    pub(crate) fn connection_closed() -> Self {
        Self {
            id: None,
            method: None,
            kind: AcpKind::Response,
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

/// EOF/崩溃时唤醒全部挂起请求（发送 connection_closed 哨兵），返回 drained 数量。
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
