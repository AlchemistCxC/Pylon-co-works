//! JSON-RPC prompt 等待层（原 engine.rs 的 E 段，A1c 后拆分归位；行为零变化）。
//!
//! 承载 prompt 回合的等待/判死/cancel-settle 状态机（[`wait_prompt_with_recovery`]
//! 族）与崩溃原因稳定词表 [`CrashReason`]。宿主（session/prompt.rs）经 lib.rs
//! re-export 消费；本层不感知 provider 进程策略（force_kill 由调用方注入）。

use std::future::Future;

use tokio::sync::oneshot;

use super::RawMessage;
use super::DEFAULT_WRITE_TIMEOUT_SECS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptTimeoutKind {
    FirstToken,
    Idle,
    /// #352：用户已发出 cancel（一等判死输入）——跳过闲置/首 token 评估，直接
    /// 进入 cancel-settle 窗口；`bound` 记录 settle 窗口配置。
    UserCancel,
}

impl PromptTimeoutKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FirstToken => "first-token",
            Self::Idle => "idle",
            Self::UserCancel => "user-cancel",
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
        /// #99：cancel 后 settle 窗口的可判定解析——Agent 在窗口内回终态、
        /// 窗口超时、或响应通道消失（引擎任务已终止），三者不再合并为 None。
        settle: CancelSettleResolution,
    },
    ConnectionClosed,
}

/// #99：超时触发 cancel 后 settle 窗口的解析结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelSettleResolution {
    /// Agent 在 settle 窗口内回终态——使用该终态（issue #99 验收：窗口内回的
    /// 终态必须胜出）。
    Responded,
    /// settle 窗口超时且无终态。
    SettleTimeout,
    /// 响应 oneshot 被丢弃（引擎任务终止 = 连接级失败）。
    ResponderDropped,
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
/// 任一判死后进入 cancel + settle。`force_kill` 在 cancel 后仍未 settle 时给
/// 调用方一次进程树强清机会（Windows 上观察到的 Hermes/MSYS 死锁）；回调由
/// 调用方显式传入，本层不感知 provider 进程策略——非 Hermes 调用方传 no-op
/// `|| async {}`（原 `wait_prompt_with_cancel` 薄包装无独有语义，已并入本参数删除）。
///
/// #352：`cancel_requested` 是**一等判死输入**——置位（用户已对当前会话发出
/// cancel）即跳过闲置/首 token 评估，直接进入 cancel + settle 路径。没有这一路
/// 输入时，agent 在 cancel 后继续产出会不断刷新 `last_activity`，闲置判死被
/// 无限续命，settle 窗口永远进不去，回合可能永不收敛。命中 flag 后活动刷新
/// 自然失效（完全绕开 liveness 评估）。
#[allow(clippy::too_many_arguments)]
pub async fn wait_prompt_with_recovery<F, Fut, K, KF>(
    rx: &mut oneshot::Receiver<RawMessage>,
    cancel_settle_timeout: std::time::Duration,
    idle_timeout: std::time::Duration,
    first_token_timeout: std::time::Duration,
    last_activity: impl Fn() -> Option<std::time::Instant>,
    cancel_requested: impl Fn() -> bool,
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
        // #352：用户 cancel 置位优先于闲置/首 token 评估——判死边界记为 settle
        // 窗口配置（判死本身无墙钟，flag 命中即触发）。
        let fire_reason = if cancel_requested() {
            Some(TruncationFire {
                kind: PromptTimeoutKind::UserCancel,
                bound: cancel_settle_timeout,
                elapsed: start.elapsed(),
            })
        } else {
            evaluate_truncation(start, idle_timeout, first_token_timeout, last_activity())
        };
        if let Some(fire_reason) = fire_reason {
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
            let (response, settle) =
                match tokio::time::timeout(cancel_settle_timeout, &mut *rx).await {
                    Ok(Ok(raw)) => (Some(raw), CancelSettleResolution::Responded),
                    Ok(Err(_)) => (None, CancelSettleResolution::ResponderDropped),
                    Err(_) => (None, CancelSettleResolution::SettleTimeout),
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
                settle,
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
    /// 触发的语义类别（首 token / 闲置 / 用户 cancel，#352）。
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

/// ISSUE-17 W1（LR2-WI06）：ACP crash 原因稳定枚举（wire snake_case 字符串）。
/// 禁止用错误文本正则区分 crash 类型（ISSUE-17 禁止事项）——writer 失败/EOF
/// 必须用稳定 code 区分，供 dispatcher 消费 reason 生成用户可读文案并保留诊断字段。
/// 词表纪律（#348 A1）：每个变体必须有可指出的产生点，不留无产生者的死变体。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashReason {
    /// 物理传输失败（stdin 写 EPIPE / stdout 读 IO 错误）。产生点 =
    /// `spawn_sdk_engine` 子侧传输收尾的 `transport_failure_reason` 分类。
    WriterFailed,
    /// stdout EOF（agent 进程退出/管道关闭）。
    StdoutClosed,
    /// pending 分片锁中毒（保守收敛，fail-closed）。
    ///
    /// 豁免保留（#348 返工裁定）：本仓**无产生点**——release 为
    /// `panic = "abort"`，锁中毒即进程终止，本变体描述的「保守收敛」在
    /// release 下不可达。未按词表纪律摘除，因前端错误码词表
    /// （`src/app/errorCodeExplanations.ts` 的 `pending_lock_poisoned` 词条）
    /// 已承载该 code 的文案，前端域属另一在途批次；反向映射
    /// `crash_reason_from_code` 对远端传入的该 code 仍按词表放行。
    /// 前端词条收编或删除后应一并摘除本变体。
    PendingLockPoisoned,
    /// #99：入站投递过载（inbox+spill 均满，显式 gap 终止连接）。
    Overloaded,
}

impl CrashReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            CrashReason::WriterFailed => "writer_failed",
            CrashReason::StdoutClosed => "stdout_closed",
            CrashReason::PendingLockPoisoned => "pending_lock_poisoned",
            CrashReason::Overloaded => "overloaded",
        }
    }
}
