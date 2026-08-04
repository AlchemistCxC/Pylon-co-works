//! session/load 回放收集（R12/P3-5 拆分自 acp.rs；行为零变化）。
//!
//! 回放与响应均经 broadcast 收集（不注册 pending）：调用方在锁内经
//! `AcpClient::replay_handles` 一次性提取句柄后释放锁，锁外交给
//! [`load_session_with_replay`] 等待回放完成（超时/EOF/lag 均有界）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};

use super::transport::send_line;
use super::{AcpError, RawMessage, METHOD_SESSION_LOAD, NOTIF_SESSION_UPDATE};
use crate::agent_config::McpServersMode;

/// O3：锁外执行 session/load 回放所需的句柄（写通道 / id 计数器 / 崩溃标记 /
/// 广播订阅 / G1-02 超时与收集上限）。调用方在锁内经 [`super::AcpClient::replay_handles`]
/// 一次性提取，锁外交给 [`load_session_with_replay`] 等待回放完成。
pub struct ReplayHandles {
    pub(crate) write_tx: mpsc::Sender<String>,
    pub(crate) next_id: Arc<AtomicU64>,
    pub(crate) crashed: Arc<AtomicBool>,
    pub(crate) rx: broadcast::Receiver<RawMessage>,
    /// G1-02：回放等待超时（缺省 30s，替代 H9 字面量）。
    pub(crate) rpc_timeout: std::time::Duration,
    /// G1-02：回放收集上限（缺省 10_000，替代 H12 字面量）。
    pub(crate) replay_max: usize,
}

/// Load a persisted session and collect every replay notification before the response.
/// The reader publishes notifications before resolving the matching response, so
/// observing the response on this broadcast receiver is the deterministic replay boundary.
pub(crate) async fn load_session_with_replay(
    handles: ReplayHandles,
    session_id: &str,
    cwd: &str,
    mcp_servers: Vec<serde_json::Value>,
    mode: McpServersMode,
) -> Result<(serde_json::Value, Vec<serde_json::Value>), AcpError> {
    // 审查修复：与 prepare_rpc 一致，死亡连接立即拒绝
    if handles.crashed.load(Ordering::Relaxed) {
        return Err(AcpError::ConnectionClosed);
    }
    let mut events = handles.rx.resubscribe();
    // 回放与响应均经 broadcast 收集，无需注册 pending：旧代码的 (tx, _rx)
    // 条目永不消费（reader 对已丢弃 rx 的 tx.send 必然失败），确认无功能
    // 依赖后删除；id 仅用于在广播流中匹配响应。
    let params = super::protocol::load_params(session_id, cwd, mcp_servers, mode)?;
    let (id, line) =
        super::AcpClient::register_line(&handles.next_id, METHOD_SESSION_LOAD, &params)?;
    send_line(handles.write_tx, line, &handles.crashed).await?;

    let mut replay = Vec::new();
    loop {
        // 优化 3：每轮复检 crashed——EOF 仅广播 NOTIF_AGENT_CRASHED（非目标
        // session/update 被跳过），reader 先 store crashed 后广播（acp.rs:1154-1164），
        // 此处命中即可立即 ConnectionClosed，与 send_keep_rx/complete 的发送后复检
        // 一致，避免挂满 30s 假超时。
        if handles.crashed.load(Ordering::Relaxed) {
            return Err(AcpError::ConnectionClosed);
        }
        let raw = match tokio::time::timeout(handles.rpc_timeout, events.recv()).await {
            Ok(Ok(raw)) => raw,
            Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(count))) => {
                return Err(AcpError::Child(format!(
                    "session/load replay lagged by {count} messages"
                )));
            }
            Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                return Err(AcpError::Child(
                    "ACP notification stream closed during session/load".to_string(),
                ));
            }
            Err(_) => {
                return Err(AcpError::Child(format!(
                    "session/load replay timed out after {}s",
                    handles.rpc_timeout.as_secs()
                )));
            }
        };
        if raw.method.as_deref() == Some(NOTIF_SESSION_UPDATE)
            && raw
                .params
                .as_ref()
                .and_then(|params| params.get("sessionId"))
                .and_then(|value| value.as_str())
                == Some(session_id)
        {
            if let Some(params) = raw.params {
                // O4：收集上限——超长历史回放截断，防止 Vec 无界增长。
                // 达到上限后继续等待响应（不得 break 提前返回——响应缺失
                // 会让调用方把 Null 当 session/load 结果，破坏会话配置）。
                // G1-02：上限来自协议配置 replay_max（缺省 10_000，wire 文案不变）。
                if replay.len() < handles.replay_max {
                    replay.push(params);
                } else if replay.len() == handles.replay_max {
                    tracing::warn!("session/load replay 超过 {} 条，截断", handles.replay_max);
                    replay.truncate(handles.replay_max);
                }
            }
            continue;
        }
        if raw.id != Some(id) {
            continue;
        }
        if let Some(error) = raw.error {
            return Err(AcpError::Rpc(format!("{}", error)));
        }
        return Ok((raw.result.unwrap_or(serde_json::Value::Null), replay));
    }
}
