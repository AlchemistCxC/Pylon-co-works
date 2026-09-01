//! session/load 回放收集（R12/P3-5 拆分自 acp.rs；行为零变化）。
//!
//! 回放与响应均经 broadcast 收集（不注册 pending）：调用方在锁内经
//! `AcpClient::begin_replay_capture` 原子建立 capture 后释放锁，锁外交给
//! [`load_session_with_replay`] 等待回放完成（超时/EOF/lag 均有界）。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc};

use super::transport::send_line;
use super::{
    AcpClient, AcpError, ClassifiedMessage, ReplayClassification, METHOD_SESSION_LOAD,
    NOTIF_SESSION_UPDATE,
};
use crate::agent_config::McpServersMode;

/// A transport-owned session/load capture. The receiver, request id, session
/// binding and active registration are installed together by
/// [`AcpClient::begin_replay_capture`].
pub struct ReplayCapture {
    pub(crate) write_tx: mpsc::Sender<String>,
    pub(crate) request_id: u64,
    pub(crate) session_id: String,
    pub(crate) crashed: Arc<AtomicBool>,
    pub(crate) rx: broadcast::Receiver<ClassifiedMessage>,
    /// G1-02：回放等待超时（缺省 30s，替代 H9 字面量）。
    pub(crate) rpc_timeout: std::time::Duration,
    /// G1-02：回放收集上限（缺省 10_000，替代 H12 字面量）。
    pub(crate) replay_max: usize,
    /// RAII registration; dropping the capture clears the transport boundary.
    _active_replay: ActiveReplayRegistration,
}

/// Compatibility name retained for callers that still refer to the old handle
/// type; new code must construct captures through `begin_replay_capture`.
#[allow(dead_code)]
pub type ReplayHandles = ReplayCapture;

struct ActiveReplayRegistration {
    request_id: u64,
    requests: Arc<Mutex<HashMap<u64, String>>>,
}

impl ActiveReplayRegistration {
    fn registered(requests: Arc<Mutex<HashMap<u64, String>>>, request_id: u64) -> Self {
        Self {
            request_id,
            requests,
        }
    }
}

impl Drop for ActiveReplayRegistration {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.lock() {
            requests.remove(&self.request_id);
        }
    }
}

/// D6：session/load replay 的完整性契约。ACP update 本身没有可靠的全局 sequence，
/// 因此 boundary 使用本次 load 内 1-based observation ordinal，并以匹配 response
/// 作为确定性结束边界。
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplayBoundary {
    pub(crate) kind: &'static str,
    pub(crate) observed_count: u64,
    pub(crate) retained_start_ordinal: Option<u64>,
    pub(crate) retained_end_ordinal: Option<u64>,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReplayMetadata {
    pub(crate) complete: bool,
    pub(crate) truncated: bool,
    pub(crate) dropped_count: u64,
    pub(crate) boundary: ReplayBoundary,
}

#[derive(Debug)]
pub(crate) struct ReplayBatch {
    pub(crate) events: Vec<serde_json::Value>,
    pub(crate) metadata: ReplayMetadata,
}

impl AcpClient {
    /// Atomically establish the replay capture linearization point. The active
    /// registry mutex also serializes stdout classification, so no notification
    /// can observe the receiver without its request/session binding (or vice
    /// versa). Same-owner loads are rejected deterministically.
    pub(crate) fn begin_replay_capture(&self, session_id: &str) -> Result<ReplayCapture, AcpError> {
        if self.crashed.load(Ordering::Acquire) {
            return Err(AcpError::ConnectionClosed);
        }
        let mut requests = self
            .active_replay_requests
            .lock()
            .map_err(|_| AcpError::Child("active replay session registry poisoned".to_string()))?;
        if requests.values().any(|active| active == session_id) {
            return Err(AcpError::ReplayLoadInProgress);
        }
        // Keep receiver creation under the same mutex as registration. The
        // reader takes this lock before classifying each inbound message.
        let rx = self.rx.resubscribe();
        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        requests.insert(request_id, session_id.to_string());
        drop(requests);
        Ok(ReplayCapture {
            write_tx: self.write_tx.clone(),
            request_id,
            session_id: session_id.to_string(),
            crashed: self.crashed.clone(),
            rx,
            rpc_timeout: std::time::Duration::from_secs(self.protocol.rpc_timeout()),
            replay_max: self.protocol.replay_max(),
            _active_replay: ActiveReplayRegistration::registered(
                self.active_replay_requests.clone(),
                request_id,
            ),
        })
    }
}

/// Load a persisted session and collect every replay notification before the response.
/// The reader publishes notifications before resolving the matching response, so
/// observing the response on this broadcast receiver is the deterministic replay boundary.
pub(crate) async fn load_session_with_replay(
    capture: ReplayCapture,
    session_id: &str,
    cwd: &str,
    mcp_servers: Vec<serde_json::Value>,
    mode: McpServersMode,
) -> Result<(serde_json::Value, ReplayBatch), AcpError> {
    if capture.session_id != session_id {
        return Err(AcpError::Child(
            "replay capture session binding mismatch".to_string(),
        ));
    }
    // 审查修复：与 prepare_rpc 一致，死亡连接立即拒绝
    if capture.crashed.load(Ordering::Relaxed) {
        return Err(AcpError::ConnectionClosed);
    }
    // The receiver is created by `begin_replay_capture` and moved into this
    // collector; no downstream resubscription is allowed.
    let mut events = capture.rx;
    let params = super::protocol::load_params(&capture.session_id, cwd, mcp_servers, mode)?;
    let line = serde_json::to_string(&serde_json::json!({
        "jsonrpc": "2.0",
        "id": capture.request_id,
        "method": METHOD_SESSION_LOAD,
        "params": params,
    }))
    .map_err(|error| AcpError::Child(format!("serialize failed: {error}")))?;
    send_line(capture.write_tx, line, &capture.crashed).await?;

    let mut replay = VecDeque::with_capacity(capture.replay_max.min(10_000));
    let mut observed_count = 0_u64;
    let mut dropped_count = 0_u64;
    // 总预算 deadline：无关 notification 不能把每轮 timeout 重新续满而无限挂起。
    let deadline = tokio::time::Instant::now() + capture.rpc_timeout;
    loop {
        // 优化 3：每轮复检 crashed——EOF 仅广播 NOTIF_AGENT_CRASHED（非目标
        // session/update 被跳过），reader 先 store crashed 后广播（acp.rs:1154-1164），
        // 此处命中即可立即 ConnectionClosed，与 send_keep_rx/complete 的发送后复检
        // 一致，避免挂满 30s 假超时。
        if capture.crashed.load(Ordering::Relaxed) {
            return Err(AcpError::ConnectionClosed);
        }
        let message = match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Ok(message)) => message,
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
                    capture.rpc_timeout.as_secs()
                )));
            }
        };
        let ClassifiedMessage {
            raw,
            classification,
        } = message;
        if matches!(
            classification,
            ReplayClassification::Replay { request_id } if request_id == capture.request_id
        ) && raw.method.as_deref() == Some(NOTIF_SESSION_UPDATE)
        {
            if let Some(params) = raw.params {
                observed_count = observed_count.saturating_add(1);
                // O4 + D6：收集上限防止内存无界增长；截断时保留最近 N 条并记录
                // 完整性元数据。仍继续等待 response，不把截断伪装成完整 snapshot。
                // 达到上限后继续等待响应（不得 break 提前返回——响应缺失
                // 会让调用方把 Null 当 session/load 结果，破坏会话配置）。
                // G1-02：上限来自协议配置 replay_max（缺省 10_000）。
                if capture.replay_max == 0 {
                    dropped_count = dropped_count.saturating_add(1);
                } else {
                    if replay.len() == capture.replay_max {
                        replay.pop_front();
                        dropped_count = dropped_count.saturating_add(1);
                    }
                    replay.push_back(params);
                }
                if dropped_count == 1 {
                    tracing::warn!("session/load replay 超过 {} 条，截断", capture.replay_max);
                }
            }
            continue;
        }
        if !matches!(
            classification,
            ReplayClassification::Boundary { request_id } if request_id == capture.request_id
        ) {
            continue;
        }
        if let Some(error) = raw.error {
            return Err(AcpError::Rpc(format!("{}", error)));
        }
        let retained_count = replay.len() as u64;
        let metadata = ReplayMetadata {
            complete: dropped_count == 0,
            truncated: dropped_count > 0,
            dropped_count,
            boundary: ReplayBoundary {
                kind: "session-load-response",
                observed_count,
                retained_start_ordinal: (retained_count > 0).then_some(dropped_count + 1),
                retained_end_ordinal: (retained_count > 0).then_some(observed_count),
            },
        };
        return Ok((
            raw.result.unwrap_or(serde_json::Value::Null),
            ReplayBatch {
                events: replay.into_iter().collect(),
                metadata,
            },
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::{AcpKind, RawMessage};

    fn test_handles(
        rpc_timeout: std::time::Duration,
        replay_max: usize,
    ) -> (
        ReplayCapture,
        mpsc::Receiver<String>,
        broadcast::Sender<ClassifiedMessage>,
        Arc<Mutex<HashMap<u64, String>>>,
    ) {
        let (write_tx, write_rx) = mpsc::channel(1);
        let (events_tx, events_rx) = broadcast::channel(64);
        let active = Arc::new(Mutex::new(HashMap::new()));
        active
            .lock()
            .unwrap()
            .insert(1, "target-session".to_string());
        (
            ReplayCapture {
                write_tx,
                request_id: 1,
                session_id: "target-session".to_string(),
                crashed: Arc::new(AtomicBool::new(false)),
                rx: events_rx,
                rpc_timeout,
                replay_max,
                _active_replay: ActiveReplayRegistration::registered(active.clone(), 1),
            },
            write_rx,
            events_tx,
            active,
        )
    }

    fn replay_message(raw: RawMessage) -> ClassifiedMessage {
        let classification = if raw.kind == AcpKind::Response {
            ReplayClassification::Boundary { request_id: 1 }
        } else {
            ReplayClassification::Replay { request_id: 1 }
        };
        ClassifiedMessage {
            raw,
            classification,
        }
    }

    #[test]
    fn same_owner_replay_load_is_rejected_or_serialized() {
        let client = AcpClient::disconnected();
        let first = client
            .begin_replay_capture("same-owner")
            .expect("first capture must start");
        let second = client.begin_replay_capture("same-owner");
        assert!(matches!(second, Err(AcpError::ReplayLoadInProgress)));
        drop(first);
        assert!(client.begin_replay_capture("same-owner").is_ok());
    }

    fn response(id: u64, error: Option<serde_json::Value>) -> RawMessage {
        RawMessage {
            id: Some(super::super::RequestId::Number(id)),
            method: None,
            kind: AcpKind::Response,
            result: error
                .is_none()
                .then(|| serde_json::json!({"sessionId": "target-session"})),
            params: None,
            error,
        }
    }

    fn session_update(session_id: Option<&str>, text: &str) -> RawMessage {
        RawMessage {
            id: None,
            method: Some(super::super::NOTIF_SESSION_UPDATE.to_string()),
            kind: AcpKind::SessionUpdate,
            result: None,
            params: Some(match session_id {
                Some(session_id) => serde_json::json!({
                    "sessionId": session_id,
                    "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": text}}
                }),
                None => serde_json::json!({
                    "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": text}}
                }),
            }),
            error: None,
        }
    }

    #[tokio::test]
    async fn unrelated_broadcasts_cannot_extend_total_replay_deadline() {
        let (handles, mut write_rx, events_tx, active) =
            test_handles(std::time::Duration::from_millis(40), 100);

        let loading = tokio::spawn(load_session_with_replay(
            handles,
            "target-session",
            ".",
            Vec::new(),
            McpServersMode::Always,
        ));
        write_rx.recv().await.expect("session/load request line");

        let flooding = tokio::spawn(async move {
            for _ in 0..30 {
                let _ = events_tx.send(ClassifiedMessage::live(RawMessage {
                    id: None,
                    method: Some("unrelated/noise".to_string()),
                    kind: AcpKind::OtherNotification,
                    result: None,
                    params: Some(serde_json::json!({})),
                    error: None,
                }));
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        });

        let result = tokio::time::timeout(std::time::Duration::from_millis(150), loading)
            .await
            .expect("总 deadline 不得被噪声广播续期")
            .expect("replay task join");
        assert!(
            matches!(result, Err(AcpError::Child(ref message)) if message.contains("timed out")),
            "预期绝对 deadline timeout，实际: {result:?}"
        );
        flooding.abort();
        assert!(
            active.lock().unwrap().is_empty(),
            "timeout 后不得残留 replay 登记"
        );
    }

    #[tokio::test]
    async fn send_failure_drops_active_replay_registration() {
        let (handles, write_rx, _events_tx, active) =
            test_handles(std::time::Duration::from_secs(1), 100);
        drop(write_rx);

        let result = load_session_with_replay(
            handles,
            "target-session",
            ".",
            Vec::new(),
            McpServersMode::Always,
        )
        .await;

        assert!(matches!(result, Err(AcpError::ConnectionClosed)));
        assert!(
            active.lock().unwrap().is_empty(),
            "send failure 后不得残留 replay 登记"
        );
    }

    #[tokio::test]
    async fn cancelling_load_task_drops_active_replay_registration() {
        let (handles, mut write_rx, _events_tx, active) =
            test_handles(std::time::Duration::from_secs(1), 100);
        let loading = tokio::spawn(load_session_with_replay(
            handles,
            "target-session",
            ".",
            Vec::new(),
            McpServersMode::Always,
        ));
        write_rx.recv().await.expect("session/load request line");
        assert_eq!(active.lock().unwrap().len(), 1);

        loading.abort();
        let _ = loading.await;

        assert!(
            active.lock().unwrap().is_empty(),
            "aborted future 后 RAII 必须清理 replay 登记"
        );
    }

    #[tokio::test]
    async fn rpc_error_drops_registration_and_does_not_wait_for_timeout() {
        let (handles, mut write_rx, events_tx, active) =
            test_handles(std::time::Duration::from_secs(1), 100);
        let loading = tokio::spawn(load_session_with_replay(
            handles,
            "target-session",
            ".",
            Vec::new(),
            McpServersMode::Always,
        ));
        write_rx.recv().await.expect("session/load request line");
        events_tx
            .send(replay_message(response(
                1,
                Some(serde_json::json!({"code": -32000, "message": "load failed"})),
            )))
            .unwrap();

        let result = loading.await.expect("replay task join");

        assert!(
            matches!(result, Err(AcpError::Rpc(ref message)) if message.contains("load failed"))
        );
        assert!(
            active.lock().unwrap().is_empty(),
            "RPC error 后不得残留 replay 登记"
        );
    }

    #[tokio::test]
    async fn unrelated_response_and_mismatched_updates_do_not_end_or_enter_replay() {
        let (handles, mut write_rx, events_tx, active) =
            test_handles(std::time::Duration::from_secs(1), 100);
        let loading = tokio::spawn(load_session_with_replay(
            handles,
            "target-session",
            ".",
            Vec::new(),
            McpServersMode::Always,
        ));
        write_rx.recv().await.expect("session/load request line");
        events_tx
            .send(ClassifiedMessage::live(response(99, None)))
            .unwrap();
        events_tx
            .send(ClassifiedMessage::live(session_update(
                Some("other-session"),
                "other",
            )))
            .unwrap();
        events_tx
            .send(ClassifiedMessage::live(session_update(None, "missing-id")))
            .unwrap();
        events_tx
            .send(replay_message(session_update(
                Some("target-session"),
                "kept",
            )))
            .unwrap();
        events_tx.send(replay_message(response(1, None))).unwrap();

        let (_result, batch) = loading
            .await
            .expect("replay task join")
            .expect("load result");

        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0]["update"]["content"]["text"], "kept");
        assert_eq!(batch.metadata.boundary.observed_count, 1);
        assert!(active.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn replay_capture_pre_poll_event_is_retained() {
        let (handles, mut write_rx, events_tx, active) =
            test_handles(std::time::Duration::from_secs(1), 100);

        // The capture receiver already exists, but the load future has not been
        // polled yet. A second subscription in the collector would start after
        // this notification and lose it.
        events_tx
            .send(replay_message(session_update(
                Some("target-session"),
                "pre-poll",
            )))
            .unwrap();

        let loading = tokio::spawn(load_session_with_replay(
            handles,
            "target-session",
            ".",
            Vec::new(),
            McpServersMode::Always,
        ));
        write_rx.recv().await.expect("session/load request line");
        events_tx.send(replay_message(response(1, None))).unwrap();

        let (_result, batch) = loading
            .await
            .expect("replay task join")
            .expect("load result");

        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0]["update"]["content"]["text"], "pre-poll");
        assert_eq!(batch.metadata.boundary.observed_count, 1);
        assert!(active.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn replay_capture_rapid_fanout_is_ordered() {
        const COUNT: usize = 16;
        let (handles, mut write_rx, events_tx, active) =
            test_handles(std::time::Duration::from_secs(1), 100);
        let loading = tokio::spawn(load_session_with_replay(
            handles,
            "target-session",
            ".",
            Vec::new(),
            McpServersMode::Always,
        ));
        write_rx.recv().await.expect("session/load request line");

        for index in 0..COUNT {
            events_tx
                .send(replay_message(session_update(
                    Some("target-session"),
                    &format!("rapid-{index}"),
                )))
                .unwrap();
        }
        events_tx.send(replay_message(response(1, None))).unwrap();

        let (_result, batch) = loading
            .await
            .expect("replay task join")
            .expect("load result");
        let texts: Vec<String> = batch
            .events
            .iter()
            .filter_map(|event| event["update"]["content"]["text"].as_str())
            .map(str::to_owned)
            .collect();
        let expected: Vec<String> = (0..COUNT).map(|index| format!("rapid-{index}")).collect();

        assert_eq!(texts, expected);
        assert_eq!(batch.metadata.boundary.observed_count, COUNT as u64);
        assert!(active.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn zero_replay_limit_reports_every_observed_event_as_dropped() {
        let (handles, mut write_rx, events_tx, active) =
            test_handles(std::time::Duration::from_secs(1), 0);
        let loading = tokio::spawn(load_session_with_replay(
            handles,
            "target-session",
            ".",
            Vec::new(),
            McpServersMode::Always,
        ));
        write_rx.recv().await.expect("session/load request line");
        events_tx
            .send(replay_message(session_update(
                Some("target-session"),
                "one",
            )))
            .unwrap();
        events_tx
            .send(replay_message(session_update(
                Some("target-session"),
                "two",
            )))
            .unwrap();
        events_tx.send(replay_message(response(1, None))).unwrap();

        let (_result, batch) = loading
            .await
            .expect("replay task join")
            .expect("load result");

        assert!(batch.events.is_empty());
        assert_eq!(batch.metadata.boundary.observed_count, 2);
        assert_eq!(batch.metadata.dropped_count, 2);
        assert!(batch.metadata.truncated);
        assert!(!batch.metadata.complete);
        assert_eq!(batch.metadata.boundary.retained_start_ordinal, None);
        assert_eq!(batch.metadata.boundary.retained_end_ordinal, None);
        assert!(active.lock().unwrap().is_empty());
    }
}
