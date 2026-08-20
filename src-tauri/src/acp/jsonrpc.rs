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

/// Wait for a prompt response. On truncation, send session/cancel and keep the
/// response receiver alive until Peri confirms the cancelled turn has settled.
///
/// R-t5（2026-08-20）正确的截断语义——活动续命、无输出才截：
/// - `last_activity` 探针返回本回合会话最近一次活动（文本/思考/工具/usage）的单调时刻，
///   `None` 表示从未有活动。等待循环以"距上次活动"判闲置，而非"回合总时长"。
/// - 任一 ACP 活动即续命：只要持续产出，回合永不因总时长被截。
/// - 首次活动始终未出现（`activity` 不晚于 `start`）且超过 `first_token_timeout` → 判死（首 token 超时）。
/// - 已活动但距最近活动超过 `idle_timeout` 仍无终态 → 判死（闲置超时）。
/// - 兜底：总墙钟超过 `prompt_timeout` → 强制判死（最后防线）。
/// 任一判死后进入 cancel + settle（与旧路径一致）。
pub async fn wait_prompt_with_cancel<F, Fut>(
    rx: &mut oneshot::Receiver<RawMessage>,
    prompt_timeout: std::time::Duration,
    cancel_settle_timeout: std::time::Duration,
    idle_timeout: std::time::Duration,
    first_token_timeout: std::time::Duration,
    last_activity: impl Fn() -> Option<std::time::Instant>,
    cancel: F,
) -> PromptWaitOutcome
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let start = std::time::Instant::now();
    // 轮询粒度：取待判定的最小非零超时的一小段，既及时又不忙转。
    let poll = smallest_nonzero([idle_timeout, first_token_timeout, prompt_timeout]) / 8;
    loop {
        // 先评估是否该判死（在 sleep 前，避免刚发完就等一个轮询周期的空档）。
        if let Some(fire_reason) = evaluate_truncation(
            start,
            idle_timeout,
            first_token_timeout,
            prompt_timeout,
            last_activity(),
        ) {
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
            // fire_reason 用于日志（多少秒后因何截断）；对外文案仍是统一超时语义。
            tracing::warn!(
                "ACP: prompt truncated ({:?}) after {}s",
                fire_reason.reason,
                fire_reason.elapsed_secs
            );
            return PromptWaitOutcome::CancelledAfterTimeout {
                response,
                cancel_error,
            };
        }
        tokio::select! {
            r = &mut *rx => {
                match r {
                    Ok(raw) => return PromptWaitOutcome::Response(raw),
                    Err(_) => return PromptWaitOutcome::ConnectionClosed,
                }
            }
            _ = tokio::time::sleep(poll) => {}
        }
    }
}

/// 截断判据的触发结果。
struct TruncationFire {
    /// 触发的语义类别（首 token / 闲置 / 总上限）。
    reason: &'static str,
    /// 触发时的已等待秒数。
    elapsed_secs: u64,
}

/// 评估是否该判死；返回 Some = 应立即截断。
fn evaluate_truncation(
    start: std::time::Instant,
    idle_timeout: std::time::Duration,
    first_token_timeout: std::time::Duration,
    prompt_timeout: std::time::Duration,
    last_activity: Option<std::time::Instant>,
) -> Option<TruncationFire> {
    let now = std::time::Instant::now();
    let elapsed = now.duration_since(start);
    // 活动"在本回合发送之后"才算本回合已开始（dispatcher 对历史回合的活动不计入）。
    let active_after_start = last_activity
        .map(|t| t >= start)
        .unwrap_or(false);
    let reason = if active_after_start {
        // 已开始：按闲置判定。
        if let Some(last) = last_activity {
            if now.duration_since(last) >= idle_timeout {
                Some(("idle", idle_timeout))
            } else {
                None
            }
        } else {
            None
        }
    } else if elapsed >= first_token_timeout {
        // 从未开始：按首 token 判定。
        Some(("first_token", first_token_timeout))
    } else {
        None
    };
    if let Some((reason, bound)) = reason {
        return Some(TruncationFire {
            reason,
            elapsed_secs: bound.as_secs().max(1),
        });
    }
    // 总墙钟兜底上限（最后防线）——活动回合也只有超此值才强制截断。
    if elapsed >= prompt_timeout && !prompt_timeout.is_zero() {
        return Some(TruncationFire {
            reason: "total_ceiling",
            elapsed_secs: prompt_timeout.as_secs().max(1),
        });
    }
    None
}

/// 取一组非零 Duration 的最小值；全零则返回 1ms（避免除以零 / 忙转）。
fn smallest_nonzero(durations: [std::time::Duration; 3]) -> std::time::Duration {
    durations
        .iter()
        .copied()
        .filter(|d| !d.is_zero())
        .min()
        .unwrap_or(std::time::Duration::from_millis(1))
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
