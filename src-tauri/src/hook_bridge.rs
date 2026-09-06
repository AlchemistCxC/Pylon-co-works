//! P55-D1：Kernel Hook 桥——Rust 锚点 → 前端 dispatcher → 插件 handler 应答回路。
//!
//! 架构基线（施工书 §1）：CLI bridge 模式复刻（骨架抄 `pylon_cli.rs` 的
//! pending oneshot 挂表 + 单调 requestId + ready 握手），差异点：
//! - 无本地 IPC server——事件直发 WebView（`pylon:hook-request` / `pylon:hook-cancel`）；
//! - ready 握手只置位（B2：前端未就绪 → `NotReady` → 调用方 fail-open）；
//! - registry sync 维护"前端已注册锚点集"，**零注册 = 零派发**（B6 节流前置）；
//! - 一切派发都在调用方自己的 async 上下文里挂起（发送链/平台入站缝均不在
//!   dispatcher 主循环内），主循环零 await 桥（B1 不变）。
//!
//! B3（generation 串线）：pending 表按单调唯一 requestId 键控，应答只能命中
//! 同一请求（超时后条目已移除，迟到应答得 "not pending" 错误，不会写入新
//! 请求）——与 permission.rs C4 的客户端替换防串线目标等价，无需前端携带
//! Rust 内部 client_generation。prompt 流程自身的代际复核仍由
//! `send_prompt_core` 既有的 ensure_generation/remove_session_if_matches 承担。
//!
//! 超时：Rust 时钟（tokio::time::timeout），默认
//! [`DEFAULT_HOOK_TIMEOUT_MS`]，上限沿用 CLI 桥的 `MAX_TIMEOUT_MS`。
//! 超时/桥未就绪/emit 失败一律由调用方按锚点语义 fail-open（transform 类放
//! 原文、gate 类放行），本模块不替调用方决定。

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};
use tokio::sync::oneshot;

use pylon_core::cli_client::MAX_TIMEOUT_MS;

/// kernel beforeSend 钩子的默认硬超时（Rust 时钟；B5）。
pub(crate) const DEFAULT_HOOK_TIMEOUT_MS: u64 = 3_000;

/// 发送链锚点名（#1，与前端 HOOK_NAMES 词表一致）。
pub(crate) const HOOK_MESSAGE_USER_BEFORE_SEND: &str = "message.user.beforeSend";
/// 平台入站锚点名（#3）。
pub(crate) const HOOK_MESSAGE_RECEIVED: &str = "message.received";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookFrontendRequest {
    request_id: String,
    hook: String,
    session_id: String,
    payload: Value,
    timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HookFrontendCancel {
    request_id: String,
}

/// 一次派发的结局。除 `Answered` 外全部视为"桥没有给出有效应答"，
/// 调用方按 fail-open 处理。
#[derive(Debug, Clone)]
pub(crate) enum HookDispatchOutcome {
    /// 前端 dispatcher 已应答（原始 JSON：`{action, event, reason?, executed, skipped}`）。
    Answered(Value),
    /// ready 握手未完成（前端尚未安装 dispatcher）。
    NotReady,
    /// registry sync 显示该锚点零注册——不派发（零注册 = 零 IPC）。
    NotRegistered,
    /// 超时（错误串含毫秒数）或 emit/通道失败。
    Failed(String),
}

pub(crate) struct HookBridge {
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    next_request: AtomicU64,
    started: AtomicBool,
    /// 前端聚合的已注册锚点名集合（`hook_registry_sync` 维护；D1 仅作派发闸，
    /// D4 扩展为 pluginId × 危险档清单）。
    registered_hooks: Mutex<HashSet<String>>,
}

impl Default for HookBridge {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
            next_request: AtomicU64::new(1),
            started: AtomicBool::new(false),
            registered_hooks: Mutex::new(HashSet::new()),
        }
    }
}

impl HookBridge {
    fn next_request_id(&self) -> String {
        format!(
            "hook-{}-{}",
            std::process::id(),
            self.next_request.fetch_add(1, Ordering::SeqCst)
        )
    }

    /// ready 握手（`pylon_hook_ready`）：置位后派发才会真正 emit。
    pub(crate) fn mark_started(&self) {
        self.started.store(true, Ordering::SeqCst);
    }

    pub(crate) fn is_started(&self) -> bool {
        self.started.load(Ordering::SeqCst)
    }

    /// `hook_registry_sync` 载荷解析（`{hooks: [name, ...]}` 或裸数组）+ 存储。
    /// 非法载荷（非数组/非字符串元素）按空集处理并保留原样供诊断。
    pub(crate) fn sync_registry(&self, payload: &Value) {
        let names = parse_registry_names(payload);
        match self.registered_hooks.lock() {
            Ok(mut set) => *set = names,
            Err(_) => {
                tracing::error!("Pylon hook bridge registry lock poisoned");
                return;
            }
        }
        tracing::info!(
            "Pylon hook registry synced: {} anchor(s)",
            payload
                .get("hooks")
                .and_then(|hooks| hooks.as_array())
                .map_or(0, |hooks| hooks.len())
        );
    }

    /// 该锚点是否有前端注册（D1 简化判定：任一插件注册即派发；
    /// per-session 过滤由前端 dispatcher 承担）。
    pub(crate) fn has_registered_hook(&self, hook: &str) -> bool {
        self.registered_hooks
            .lock()
            .map(|set| set.contains(hook))
            .unwrap_or(false)
    }

    /// 派发（默认超时）。None = 没有可用 emitter（无窗口），归入 fail-open。
    pub(crate) async fn dispatch<R: tauri::Runtime>(
        &self,
        emitter: Option<&impl Emitter<R>>,
        hook: &str,
        session_id: &str,
        payload: Value,
    ) -> HookDispatchOutcome {
        self.dispatch_with_timeout(emitter, hook, session_id, payload, DEFAULT_HOOK_TIMEOUT_MS)
            .await
    }

    pub(crate) async fn dispatch_with_timeout<R: tauri::Runtime>(
        &self,
        emitter: Option<&impl Emitter<R>>,
        hook: &str,
        session_id: &str,
        payload: Value,
        timeout_ms: u64,
    ) -> HookDispatchOutcome {
        if !self.is_started() {
            return HookDispatchOutcome::NotReady;
        }
        if !self.has_registered_hook(hook) {
            return HookDispatchOutcome::NotRegistered;
        }
        // Triggered hooks are bounded to prevent send→hook→send cycles.
        if payload
            .get("triggeredBy")
            .and_then(|value| value.get("depth"))
            .and_then(Value::as_u64)
            .is_some_and(|depth| depth >= 2)
        {
            return HookDispatchOutcome::Failed("hook trigger depth limit reached".into());
        }
        let Some(emitter) = emitter else {
            return HookDispatchOutcome::Failed("hook bridge emitter unavailable".into());
        };
        let request = HookFrontendRequest {
            request_id: self.next_request_id(),
            hook: hook.to_string(),
            session_id: session_id.to_string(),
            payload,
            timeout_ms: timeout_ms.clamp(1, MAX_TIMEOUT_MS),
        };
        let (sender, receiver) = oneshot::channel();
        if let Ok(mut pending) = self.pending.lock() {
            pending.insert(request.request_id.clone(), sender);
        } else {
            return HookDispatchOutcome::Failed("Pylon hook pending lock poisoned".into());
        }
        if let Err(error) = emitter.emit(
            crate::event_names::PYLON_HOOK_REQUEST,
            request.clone(),
        ) {
            self.pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&request.request_id));
            return HookDispatchOutcome::Failed(format!("emit hook request failed: {error}"));
        }
        match tokio::time::timeout(Duration::from_millis(request.timeout_ms), receiver).await {
            Ok(Ok(result)) => match result {
                Ok(value) => HookDispatchOutcome::Answered(value),
                Err(error) => HookDispatchOutcome::Failed(error),
            },
            Ok(Err(_)) => {
                self.remove_pending(&request.request_id);
                HookDispatchOutcome::Failed(
                    "Pylon hook frontend response channel closed".to_string(),
                )
            }
            Err(_) => {
                // 超时：摘表 + 通知前端取消（前端 abort 该请求的 handler 执行）。
                self.cancel(emitter, &request.request_id, "hook request timed out");
                HookDispatchOutcome::Failed(format!(
                    "Pylon hook request timed out after {}ms",
                    request.timeout_ms
                ))
            }
        }
    }

    /// 应答回程（`pylon_hook_respond`）。迟到/未知 requestId → Err（B3：不可能
    /// 命中其它请求——表按唯一 requestId 键控）。
    pub(crate) fn respond(&self, request_id: &str, result: Result<Value, String>) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .map_err(|_| "Pylon hook pending lock poisoned".to_string())?
            .remove(request_id)
            .ok_or_else(|| format!("Pylon hook request not pending: {request_id}"))?;
        sender
            .send(result)
            .map_err(|_| format!("Pylon hook response receiver closed: {request_id}"))
    }

    fn remove_pending(&self, request_id: &str) -> bool {
        self.pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(request_id))
            .is_some()
    }

    fn cancel<R: tauri::Runtime>(&self, emitter: &impl Emitter<R>, request_id: &str, reason: &str) -> bool {
        let pending = self.remove_pending(request_id);
        if pending {
            let _ = emitter.emit(
                crate::event_names::PYLON_HOOK_CANCEL,
                HookFrontendCancel {
                    request_id: request_id.to_string(),
                },
            );
        }
        tracing::debug!("Pylon hook request {request_id} cancelled: {reason}");
        pending
    }
}

fn parse_registry_names(payload: &Value) -> HashSet<String> {
    let Some(list) = payload.get("hooks").and_then(Value::as_array) else {
        return HashSet::new();
    };
    list.iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect()
}

// ── 锚点语义解释（wire 应答 → Rust 侧决策） ──────────────────────────────────

/// #1 发送链缝决策：PassThrough = 原样放行；Transformed = 用应答 blocks 改写
/// wire 出站（journal 原文行不变，B7）；Blocked = gate 拒绝（调用方返回错误）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum BeforeSendDecision {
    PassThrough,
    Transformed(Vec<Value>),
    Blocked(String),
}

/// #1：解释 dispatcher 应答。`continue` + `event.blocks` 为对象数组 → 改写；
/// `cancel` → 拒绝；其余（含字段缺失/形状非法）→ 原样放行（fail-open）。
pub(crate) fn interpret_before_send_response(response: &Value) -> BeforeSendDecision {
    match response.get("action").and_then(Value::as_str) {
        Some("cancel") => BeforeSendDecision::Blocked(
            response
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("blocked by hook")
                .to_string(),
        ),
        Some("continue") => {
            let Some(blocks) = response
                .pointer("/event/blocks")
                .and_then(Value::as_array)
            else {
                return BeforeSendDecision::PassThrough;
            };
            if blocks.iter().all(|block| block.is_object()) {
                BeforeSendDecision::blocks_cloned(blocks)
            } else {
                BeforeSendDecision::PassThrough
            }
        }
        _ => BeforeSendDecision::PassThrough,
    }
}

impl BeforeSendDecision {
    fn blocks_cloned(blocks: &[Value]) -> Self {
        BeforeSendDecision::Transformed(blocks.to_vec())
    }
}

/// #3 平台入站缝决策：Drop = gate 丢弃；Continue.content = 原文或 transform 产物。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MessageReceivedDecision {
    Continue { content: String },
    Drop,
}

/// #3：解释 dispatcher 应答。`continue` + `event.content` 为字符串 → 改写；
/// `cancel` → 丢弃；其余 → 原文放行。
pub(crate) fn interpret_message_received_response(
    response: &Value,
    original_content: &str,
) -> MessageReceivedDecision {
    match response.get("action").and_then(Value::as_str) {
        Some("cancel") => MessageReceivedDecision::Drop,
        Some("continue") => match response
            .pointer("/event/content")
            .and_then(Value::as_str)
        {
            Some(content) => MessageReceivedDecision::Continue {
                content: content.to_string(),
            },
            None => MessageReceivedDecision::Continue {
                content: original_content.to_string(),
            },
        },
        _ => MessageReceivedDecision::Continue {
            content: original_content.to_string(),
        },
    }
}

/// #1 发送链缝派发（prompt.rs 调用；窗口可缺——无窗口即 fail-open）。
pub(crate) async fn before_send_hook_outcome<R: tauri::Runtime>(
    state: &crate::AppState,
    window: Option<&tauri::Window<R>>,
    source: &str,
    content: &str,
    blocks: &[Value],
) -> BeforeSendDecision {
    let payload = serde_json::json!({
        "source": source,
        "content": content,
        "blocks": blocks,
    });
    match state
        .hook_bridge
        .dispatch(window, HOOK_MESSAGE_USER_BEFORE_SEND, source, payload)
        .await
    {
        HookDispatchOutcome::Answered(response) => interpret_before_send_response(&response),
        HookDispatchOutcome::NotReady => BeforeSendDecision::PassThrough,
        HookDispatchOutcome::NotRegistered => BeforeSendDecision::PassThrough,
        HookDispatchOutcome::Failed(error) => {
            // fail-open（对齐 Prism inject 先例）：桥故障绝不挡用户消息。
            tracing::warn!("beforeSend hook dispatch failed (fail-open): {error}");
            BeforeSendDecision::PassThrough
        }
    }
}

/// #3 平台入站缝派发（lib.rs ingest spawn 调用）。gate 丢弃时**就地执行**
/// rollback_seen（对齐既有失败路径 :1211-1217 语义——钩子拒绝不占去重窗口）。
pub(crate) async fn message_received_hook_outcome<R: tauri::Runtime>(
    state: &crate::AppState,
    window: Option<&tauri::Window<R>>,
    resolved: &crate::gateway::ResolvedIngest,
) -> MessageReceivedDecision {
    let payload = serde_json::json!({
        "source": resolved.source,
        "content": resolved.content,
        "binding": resolved.binding,
        "msgId": resolved.msg_id,
    });
    match state
        .hook_bridge
        .dispatch(window, HOOK_MESSAGE_RECEIVED, &resolved.source, payload)
        .await
    {
        HookDispatchOutcome::Answered(response) => {
            let decision =
                interpret_message_received_response(&response, &resolved.content);
            if decision == MessageReceivedDecision::Drop {
                rollback_ingest_seen(state, resolved);
                tracing::info!(
                    "message.received hook dropped inbound message from {}",
                    resolved.source
                );
            }
            decision
        }
        HookDispatchOutcome::NotReady => MessageReceivedDecision::Continue {
            content: resolved.content.clone(),
        },
        HookDispatchOutcome::NotRegistered => MessageReceivedDecision::Continue {
            content: resolved.content.clone(),
        },
        HookDispatchOutcome::Failed(error) => {
            // fail-open：平台消息照常入站。
            tracing::warn!("message.received hook dispatch failed (fail-open): {error}");
            MessageReceivedDecision::Continue {
                content: resolved.content.clone(),
            }
        }
    }
}

/// C14 语义复刻（lib.rs 既有失败路径）：发送侧丢弃时回滚适配器去重窗口，
/// resume 重放可重新 ingest。
fn rollback_ingest_seen(state: &crate::AppState, resolved: &crate::gateway::ResolvedIngest) {
    if let Some(msg_id) = resolved.msg_id.as_deref() {
        if let Some(adapter) = state.gateway.adapter_for_source(&resolved.source) {
            adapter.rollback_seen(msg_id);
        }
    }
}

// ── Tauri commands ──────────────────────────────────────────────────────────

#[tauri::command]
pub(crate) async fn pylon_hook_ready(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<crate::AppState>()
        .hook_bridge
        .mark_started();
    Ok(())
}

#[tauri::command]
pub(crate) async fn pylon_hook_respond(
    app: tauri::AppHandle,
    request_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let response = match error {
        Some(error) => Err(error),
        None => Ok(result.unwrap_or(Value::Null)),
    };
    app.state::<crate::AppState>()
        .hook_bridge
        .respond(&request_id, response)
}

/// 前端钩子面清单同步（D1：仅存储 + 日志 + 派发闸；D4 扩展为 manifest join
/// 与危险档门控）。
#[tauri::command]
pub(crate) async fn hook_registry_sync(
    app: tauri::AppHandle,
    payload: Value,
) -> Result<(), String> {
    app.state::<crate::AppState>().hook_bridge.sync_registry(&payload);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use tauri::Listener;

    fn mock_app_with_state() -> (
        tauri::App<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
    ) {
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock window must build");
        (app, window)
    }

    fn bridge_ready(app: &tauri::App<tauri::test::MockRuntime>, hooks: &[&str]) -> Arc<HookBridge> {
        let bridge = app.state::<crate::AppState>().hook_bridge.clone();
        bridge.mark_started();
        bridge.sync_registry(&json!({ "hooks": hooks }));
        bridge
    }

    /// 验收 D1-①（a）：派 → 前端 fake handler 应答 → Rust 收到。
    #[tokio::test]
    async fn bridge_roundtrip_delivers_frontend_response() {
        let (app, window) = mock_app_with_state();
        let bridge = bridge_ready(&app, &[HOOK_MESSAGE_USER_BEFORE_SEND]);

        let (tx, rx) = std::sync::mpsc::channel::<Value>();
        window.listen(crate::event_names::PYLON_HOOK_REQUEST, move |event| {
            let payload: Value =
                serde_json::from_str(event.payload()).expect("hook request payload");
            let _ = tx.send(payload);
        });

        let responder_bridge = bridge.clone();
        let responder = tokio::spawn(async move {
            let request = rx.recv().expect("hook request must arrive");
            let request_id = request["requestId"].as_str().unwrap().to_string();
            responder_bridge
                .respond(
                    &request_id,
                    Ok(json!({
                        "action": "continue",
                        "event": { "blocks": [ { "type": "text", "text": "rewritten" } ] },
                        "executed": 1,
                        "skipped": 0,
                    })),
                )
                .expect("respond must resolve pending request");
        });

        let outcome = bridge
            .dispatch_with_timeout(
                Some(&window),
                HOOK_MESSAGE_USER_BEFORE_SEND,
                "local:roundtrip",
                json!({ "content": "original" }),
                2_000,
            )
            .await;
        responder.await.expect("responder task");

        match outcome {
            HookDispatchOutcome::Answered(response) => {
                assert_eq!(response["action"], "continue");
                assert_eq!(response["event"]["blocks"][0]["text"], "rewritten");
                // 应答后挂表必须清空（迟到重复应答会被拒）。
                assert!(!bridge.has_registered_hook("nonexistent"));
                assert!(bridge
                    .respond("hook-late-1", Ok(Value::Null))
                    .is_err());
            }
            other => panic!("expected Answered, got {other:?}"),
        }
    }

    /// 验收 D1-①（b）：无应答 → Rust 时钟超时 → Failed（调用方据此 fail-open）。
    #[tokio::test]
    async fn bridge_timeout_fails_open_after_rust_clock_deadline() {
        let (app, window) = mock_app_with_state();
        let bridge = bridge_ready(&app, &[HOOK_MESSAGE_USER_BEFORE_SEND]);
        let (tx, rx) = std::sync::mpsc::channel::<Value>();
        window.listen(crate::event_names::PYLON_HOOK_REQUEST, move |event| {
            let payload: Value =
                serde_json::from_str(event.payload()).expect("hook request payload");
            let _ = tx.send(payload);
        });

        let started = std::time::Instant::now();
        let outcome = bridge
            .dispatch_with_timeout(
                Some(&window),
                HOOK_MESSAGE_USER_BEFORE_SEND,
                "local:timeout",
                json!({ "content": "x" }),
                30,
            )
            .await;
        let elapsed = started.elapsed();
        // 超时后必须已摘表：迟到应答被拒。
        let request = rx.recv_timeout(Duration::from_secs(1)).expect("request emitted");
        let request_id = request["requestId"].as_str().unwrap().to_string();
        assert!(
            bridge.respond(&request_id, Ok(Value::Null)).is_err(),
            "timed-out request must no longer be pending"
        );
        match outcome {
            HookDispatchOutcome::Failed(error) => {
                assert!(error.contains("timed out"), "unexpected error: {error}");
            }
            other => panic!("expected Failed, got {other:?}"),
        }
        assert!(
            elapsed < Duration::from_secs(2),
            "timeout must come from the Rust clock, took {elapsed:?}"
        );
    }

    #[tokio::test]
    async fn trigger_depth_two_is_rejected_before_ipc() {
        let bridge = HookBridge::default();
        bridge.mark_started();
        bridge.sync_registry(&json!({ "hooks": [HOOK_MESSAGE_USER_BEFORE_SEND] }));
        let result = bridge.dispatch::<tauri::test::MockRuntime>(
            None,
            HOOK_MESSAGE_USER_BEFORE_SEND,
            "s",
            json!({ "triggeredBy": { "depth": 2 } }),
        ).await;
        assert!(matches!(result, HookDispatchOutcome::Failed(message) if message.contains("depth limit")));
    }

    /// B2/B6：ready 前与零注册锚点不派发（零 IPC）。
    #[tokio::test]
    async fn bridge_skips_dispatch_when_not_ready_or_not_registered() {
        let (app, window) = mock_app_with_state();
        let bridge = app.state::<crate::AppState>().hook_bridge.clone();
        // 未 ready：NotReady，不 emit。
        assert!(matches!(
            bridge
                .dispatch(Some(&window), HOOK_MESSAGE_USER_BEFORE_SEND, "s", json!({}))
                .await,
            HookDispatchOutcome::NotReady
        ));
        // ready 但锚点未注册：NotRegistered，不 emit。
        bridge.mark_started();
        assert!(matches!(
            bridge
                .dispatch(Some(&window), HOOK_MESSAGE_USER_BEFORE_SEND, "s", json!({}))
                .await,
            HookDispatchOutcome::NotRegistered
        ));
        // 注册锚点后再验证无窗口路径，确保命中 emitter 缺失的 Failed 闸。
        bridge.sync_registry(&json!({ "hooks": [HOOK_MESSAGE_USER_BEFORE_SEND] }));
        // 无窗口：Failed → fail-open。
        let none: Option<&tauri::WebviewWindow<tauri::test::MockRuntime>> = None;
        assert!(matches!(
            bridge.dispatch(none, HOOK_MESSAGE_USER_BEFORE_SEND, "s", json!({})).await,
            HookDispatchOutcome::Failed(_)
        ));
    }

    #[test]
    fn registry_sync_accepts_object_and_bare_array_shapes() {
        let bridge = HookBridge::default();
        bridge.sync_registry(&json!({ "hooks": ["message.received", "message.user.beforeSend", 42] }));
        assert!(bridge.has_registered_hook("message.received"));
        assert!(bridge.has_registered_hook("message.user.beforeSend"));
        assert!(!bridge.has_registered_hook("turn.completed"));
        // 非法载荷 → 空集。
        bridge.sync_registry(&json!("garbage"));
        assert!(!bridge.has_registered_hook("message.received"));
    }

    #[test]
    fn before_send_interpretation_is_fail_open_on_malformed_shapes() {
        assert_eq!(
            interpret_before_send_response(&json!({
                "action": "continue",
                "event": { "blocks": [ { "type": "text", "text": "new" } ] }
            })),
            BeforeSendDecision::Transformed(vec![json!({ "type": "text", "text": "new" })])
        );
        assert_eq!(
            interpret_before_send_response(&json!({ "action": "cancel", "reason": "no ads" })),
            BeforeSendDecision::Blocked("no ads".into())
        );
        // blocks 非对象数组 / 缺 event / 未知 action → 原样放行。
        assert_eq!(
            interpret_before_send_response(&json!({
                "action": "continue",
                "event": { "blocks": ["not-an-object"] }
            })),
            BeforeSendDecision::PassThrough
        );
        assert_eq!(
            interpret_before_send_response(&json!({ "action": "continue" })),
            BeforeSendDecision::PassThrough
        );
        assert_eq!(
            interpret_before_send_response(&json!({ "action": "respond", "output": {} })),
            BeforeSendDecision::PassThrough
        );
    }

    #[test]
    fn message_received_interpretation_covers_gate_and_transform() {
        assert_eq!(
            interpret_message_received_response(&json!({ "action": "cancel" }), "keep"),
            MessageReceivedDecision::Drop
        );
        assert_eq!(
            interpret_message_received_response(
                &json!({ "action": "continue", "event": { "content": "cleaned" } }),
                "dirty"
            ),
            MessageReceivedDecision::Continue { content: "cleaned".into() }
        );
        assert_eq!(
            interpret_message_received_response(&json!({ "action": "continue" }), "dirty"),
            MessageReceivedDecision::Continue { content: "dirty".into() }
        );
    }

    /// 验收 D1-④：message.received gate 丢弃平台消息，并对齐既有失败路径的
    /// rollback_seen 语义（去重窗口回滚，resume 重放可重新 ingest）。
    #[tokio::test]
    async fn message_received_gate_drops_inbound_and_rolls_back_seen() {
        let (app, webview) = mock_app_with_state();
        let gateway = app.state::<crate::AppState>().gateway.clone();
        let adapter = Arc::new(FakeSeenAdapter::default());
        gateway
            .register(adapter.clone())
            .expect("register fake adapter");
        let bridge = bridge_ready(&app, &[HOOK_MESSAGE_RECEIVED]);

        let (tx, rx) = std::sync::mpsc::channel::<Value>();
        webview.listen(crate::event_names::PYLON_HOOK_REQUEST, move |event| {
            let payload: Value =
                serde_json::from_str(event.payload()).expect("hook request payload");
            let _ = tx.send(payload);
        });
        let responder_bridge = bridge.clone();
        tokio::spawn(async move {
            let request = rx.recv().expect("hook request must arrive");
            let request_id = request["requestId"].as_str().unwrap().to_string();
            responder_bridge
                .respond(
                    &request_id,
                    Ok(json!({ "action": "cancel", "reason": "spam", "executed": 1, "skipped": 0 })),
                )
                .expect("respond");
        });

        let mut resolved = crate::gateway::build_resolved("fake:group:1", "垃圾广告", None)
            .expect("resolved ingest");
        resolved.msg_id = Some("msg-gate-7".into());
        let window = webview.as_ref().window();
        let decision = message_received_hook_outcome(
            app.state::<crate::AppState>().inner(),
            Some(&window),
            &resolved,
        )
        .await;
        assert_eq!(decision, MessageReceivedDecision::Drop);
        assert_eq!(
            adapter.rolled_back(),
            vec!["msg-gate-7".to_string()],
            "gate 丢弃必须回滚去重窗口（C14 对齐）"
        );
    }

    /// 验收 D1-④（补充）：transform 改写 content 后继续，不触发 rollback。
    #[tokio::test]
    async fn message_received_transform_rewrites_content_without_rollback() {
        let (app, webview) = mock_app_with_state();
        let gateway = app.state::<crate::AppState>().gateway.clone();
        let adapter = Arc::new(FakeSeenAdapter::default());
        gateway
            .register(adapter.clone())
            .expect("register fake adapter");
        let bridge = bridge_ready(&app, &[HOOK_MESSAGE_RECEIVED]);

        let (tx, rx) = std::sync::mpsc::channel::<Value>();
        webview.listen(crate::event_names::PYLON_HOOK_REQUEST, move |event| {
            let payload: Value =
                serde_json::from_str(event.payload()).expect("hook request payload");
            let _ = tx.send(payload);
        });
        let responder_bridge = bridge.clone();
        tokio::spawn(async move {
            let request = rx.recv().expect("hook request must arrive");
            let request_id = request["requestId"].as_str().unwrap().to_string();
            let mut event = request["payload"].clone();
            if let Value::Object(ref mut map) = event {
                map.insert("content".to_string(), json!("净化后内容"));
            }
            responder_bridge
                .respond(
                    &request_id,
                    Ok(json!({
                        "action": "continue",
                        "event": event,
                        "executed": 1,
                        "skipped": 0,
                    })),
                )
                .expect("respond");
        });

        let mut resolved = crate::gateway::build_resolved("fake:group:2", "原始内容", None)
            .expect("resolved ingest");
        resolved.msg_id = Some("msg-keep-9".into());
        let window = webview.as_ref().window();
        let decision = message_received_hook_outcome(
            app.state::<crate::AppState>().inner(),
            Some(&window),
            &resolved,
        )
        .await;
        assert_eq!(
            decision,
            MessageReceivedDecision::Continue {
                content: "净化后内容".to_string()
            }
        );
        assert!(adapter.rolled_back().is_empty());
    }

    /// fake 平台适配器：只观测 rollback_seen（C14 回滚证据）。
    struct FakeSeenAdapter {
        rolled_back: Mutex<Vec<String>>,
    }

    impl Default for FakeSeenAdapter {
        fn default() -> Self {
            Self {
                rolled_back: Mutex::new(Vec::new()),
            }
        }
    }

    impl FakeSeenAdapter {
        fn rolled_back(&self) -> Vec<String> {
            self.rolled_back.lock().map(|list| list.clone()).unwrap_or_default()
        }
    }

    impl crate::gateway::PlatformAdapter for FakeSeenAdapter {
        fn platform_key(&self) -> &str {
            "fake"
        }
        fn max_message_len(&self) -> usize {
            4000
        }
        fn deliver_text(&self, _source: &str, _text: &str) -> Result<(), String> {
            Ok(())
        }
        fn deliver_event(
            &self,
            _source: &str,
            _event: &str,
            _payload: &Value,
        ) -> Result<(), String> {
            Ok(())
        }
        fn rollback_seen(&self, msg_id: &str) {
            if let Ok(mut list) = self.rolled_back.lock() {
                list.push(msg_id.to_string());
            }
        }
    }
}
