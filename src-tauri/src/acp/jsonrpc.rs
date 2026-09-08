//! JSON-RPC pending 注册表与响应结算（R11/P3-3 拆分自 acp.rs；行为零变化）。
//!
//! pending 分片（`PENDING_SHARDS=16`）避免所有 JSON-RPC 请求竞争一把全局锁；
//! `PreparedRpc` 在锁内准备（注册 + 序列化）、锁外发送与等待，避免 ACP 卡顿时
//! 阻塞整个 AppState。EOF/超时/crash 路径统一清理 pending（不悬挂）。

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

use super::transport::DEFAULT_WRITE_TIMEOUT_SECS;
use super::{AcpError, AcpKind, RawMessage};

/// JSON-RPC 挂起请求表（request id → 响应通道）。分片锁：避免所有请求竞争
/// 一把全局锁。
pub(crate) type Pending = HashMap<u64, oneshot::Sender<RawMessage>>;

use super::engine::PreparedRpcBackend;

/// pending 分片数：`id % PENDING_SHARDS` 定位分片。
pub(crate) const PENDING_SHARDS: usize = 16;

/// 准备好的 JSON-RPC 请求（D12：后端专属状态封在 [`PreparedRpcBackend`]，
/// `line`/`write_tx`/`rx` 不再出现在公开面）。
pub struct PreparedRpc {
    /// Pylon 相关 id：legacy 恰等于 wire id（行为不变），SDK 用本地计数器；
    /// wire id 永不暴露。
    pub id: u64,
    pub(crate) backend: PreparedRpcBackend,
}

pub(crate) fn remove_pending_from(pending: &Arc<[Mutex<Pending>; PENDING_SHARDS]>, id: u64) {
    if let Ok(mut shard) = pending[id as usize % PENDING_SHARDS].lock() {
        shard.remove(&id);
    }
}

impl PreparedRpc {
    /// 发送请求行，返回响应接收器（legacy）；SDK 后端 typed fail-closed（A1b 接 prompt 等待）。
    pub async fn send_keep_rx(self) -> Result<oneshot::Receiver<RawMessage>, AcpError> {
        super::engine::send_keep_rx_prepared(self).await
    }

    /// 发送 + 等待匹配响应（两后端均实现；超时值来自协议配置）。
    pub async fn complete(self) -> Result<serde_json::Value, AcpError> {
        super::engine::complete_prepared(self).await
    }

    /// D12：仅测试读取请求行（`acp/tests.rs` 保留一条；A1c 删除）。
    #[cfg(test)]
    pub(crate) fn line(&self) -> &str {
        super::engine::prepared_line(&self.backend)
    }

    /// 测试专用：按 legacy 后端构造（保留既有单测形状，避免测试文件引入内部类型）。
    /// 全限定路径：这些类型仅在 cfg(test) 下使用，避免非测试构建被判为未用导入。
    #[cfg(test)]
    pub(crate) fn legacy_for_test(
        id: u64,
        line: String,
        write_tx: tokio::sync::mpsc::Sender<String>,
        rx: oneshot::Receiver<RawMessage>,
        pending: Arc<[Mutex<Pending>; PENDING_SHARDS]>,
        crashed: Arc<std::sync::atomic::AtomicBool>,
        rpc_timeout: std::time::Duration,
    ) -> Self {
        Self {
            id,
            backend: PreparedRpcBackend::Legacy(super::engine::LegacyPreparedRpc {
                write_tx,
                pending,
                rx,
                crashed,
                line,
                rpc_timeout,
            }),
        }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptTimeoutKind {
    FirstToken,
    Idle,
}

impl PromptTimeoutKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::FirstToken => "first-token",
            Self::Idle => "idle",
        }
    }
}

#[derive(Debug)]
pub enum PromptWaitOutcome {
    Response(RawMessage),
    CancelledAfterTimeout {
        response: Option<RawMessage>,
        cancel_error: Option<String>,
        timeout_kind: PromptTimeoutKind,
        timeout_bound: std::time::Duration,
        elapsed: std::time::Duration,
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
/// - `prompt_timeout` 仅作为未单独配置 `idle_timeout` 时的单步闲置超时；
///   不设整轮绝对墙钟。一个回合可以包含任意多个分析、思考和工具步骤，
///   每个步骤都必须分别获得完整的超时窗口。
///
/// 任一判死后进入 cancel + settle（与旧路径一致）。
#[allow(dead_code)]
pub async fn wait_prompt_with_cancel<F, Fut>(
    rx: &mut oneshot::Receiver<RawMessage>,
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
    wait_prompt_with_recovery(
        rx,
        cancel_settle_timeout,
        idle_timeout,
        first_token_timeout,
        last_activity,
        cancel,
        || async {},
    )
    .await
}

/// Variant of [`wait_prompt_with_cancel`] that can force-clean a wedged child
/// after cancellation failed to settle.  The recovery callback is deliberately
/// supplied by the caller so the generic ACP layer does not know about any
/// provider-specific process policy.  Non-Hermes callers continue to use the
/// wrapper above and therefore retain the historical behavior.
pub async fn wait_prompt_with_recovery<F, Fut, K, KF>(
    rx: &mut oneshot::Receiver<RawMessage>,
    cancel_settle_timeout: std::time::Duration,
    idle_timeout: std::time::Duration,
    first_token_timeout: std::time::Duration,
    last_activity: impl Fn() -> Option<std::time::Instant>,
    cancel: F,
    force_kill: K,
) -> PromptWaitOutcome
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
    K: FnOnce() -> KF,
    KF: Future<Output = ()>,
{
    let start = std::time::Instant::now();
    // 轮询粒度：取待判定的最小非零超时的一小段，既及时又不忙转。
    let poll = smallest_nonzero([idle_timeout, first_token_timeout, std::time::Duration::ZERO]) / 8;
    loop {
        // 先评估是否该判死（在 sleep 前，避免刚发完就等一个轮询周期的空档）。
        if let Some(fire_reason) =
            evaluate_truncation(start, idle_timeout, first_token_timeout, last_activity())
        {
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
            if response.is_none() {
                // A provider can acknowledge neither session/cancel nor the
                // pending prompt (the Hermes/MSYS deadlock observed on
                // Windows).  Give the provider-specific owner one chance to
                // terminate its process tree so the next ACP generation can
                // reconnect instead of leaving a wedged child behind.
                force_kill().await;
            }
            // fire_reason 用于日志（多少秒后因何截断）；对外文案仍是统一超时语义。
            tracing::warn!(
                "ACP: prompt truncated ({}) after {}ms (bound={}ms)",
                fire_reason.kind.as_str(),
                fire_reason.elapsed.as_millis(),
                fire_reason.bound.as_millis()
            );
            return PromptWaitOutcome::CancelledAfterTimeout {
                response,
                cancel_error,
                timeout_kind: fire_reason.kind,
                timeout_bound: fire_reason.bound,
                elapsed: fire_reason.elapsed,
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
    /// 触发的语义类别（首 token / 闲置）。
    kind: PromptTimeoutKind,
    /// 本次判定使用的配置边界。
    bound: std::time::Duration,
    /// 从 prompt wait 开始到触发的实际单调耗时。
    elapsed: std::time::Duration,
}

/// 评估是否该判死；返回 Some = 应立即截断。
fn evaluate_truncation(
    start: std::time::Instant,
    idle_timeout: std::time::Duration,
    first_token_timeout: std::time::Duration,
    last_activity: Option<std::time::Instant>,
) -> Option<TruncationFire> {
    let now = std::time::Instant::now();
    let elapsed = now.duration_since(start);
    // 活动"在本回合发送之后"才算本回合已开始（dispatcher 对历史回合的活动不计入）。
    let active_after_start = last_activity.map(|t| t >= start).unwrap_or(false);
    let reason = if active_after_start {
        // 已开始：按闲置判定。
        if let Some(last) = last_activity {
            if now.duration_since(last) >= idle_timeout {
                Some((PromptTimeoutKind::Idle, idle_timeout))
            } else {
                None
            }
        } else {
            None
        }
    } else if elapsed >= first_token_timeout {
        // 从未开始：按首 token 判定。
        Some((PromptTimeoutKind::FirstToken, first_token_timeout))
    } else {
        None
    };
    if let Some((kind, bound)) = reason {
        return Some(TruncationFire {
            kind,
            bound,
            elapsed,
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
