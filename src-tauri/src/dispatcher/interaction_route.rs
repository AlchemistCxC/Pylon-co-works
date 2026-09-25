//! 私有交互路由缝（#317 批次二 ④ 自 mod.rs 主泵分支迁入）：
//! elicitation/complete 收敛（#316）与 provider 私有方法桥接（grok/pi/elicitation，
//! #98/AC11）。两个分支在主泵中均为纯 `continue` 语义——所有路径都在本模块内终结。

use super::{match_pending_elicitation, reject_interaction_request, AcpLock};
use crate::emit_event;
use crate::runtime::AgentRuntimeManager;
use agent_client_protocol_schema::v1::ErrorCode as WireErrorCode;

/// #316：elicitation/complete —— URL 模式外带交互完成通知（form 模式
/// 同步应答不产生本通知）。官方契约：客户端忽略未知/已完成 id。当前
/// 只做两件事：可观测日志 + 收敛匹配中的 pending elicitation 卡
/// （URL 模式 UI 本期不做，但队列里的挂起条目必须能被终态）。
pub(crate) async fn route_elicitation_complete<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    runtimes: &AgentRuntimeManager,
    agent_id: &str,
    params: Option<&serde_json::Value>,
) {
    let note = params.and_then(|params| {
        serde_json::from_value::<agent_client_protocol_schema::v1::CompleteElicitationNotification>(
            params.clone(),
        )
        .ok()
    });
    let Some(note) = note else {
        tracing::debug!("elicitation/complete unparseable; ignoring per spec");
        return;
    };
    let elicitation_id: &str = note.elicitation_id.0.as_ref();
    let Some(runtime) = runtimes.get(agent_id) else {
        tracing::debug!(elicitation_id, "elicitation/complete: no runtime; ignored");
        return;
    };
    let matched =
        match_pending_elicitation(&runtime.private_interactions.snapshot(), elicitation_id);
    if let Some((request_id, pending)) = matched {
        // P2-2（#316 审查）：take 成功（Some）才 settle+emit——
        // 并发 respond_interaction 抢先收口时不再发 spurious 事件。
        if runtime
            .private_interactions
            .take(&request_id)
            .map(|taken| taken.is_some())
            .unwrap_or(false)
        {
            let request_id_text = request_id.to_string();
            let _ = runtime.interactions.settle(
                &request_id_text,
                crate::acp::interaction_queue::InteractionTerminalReason::Answered,
            );
            emit_event(
                window,
                crate::event_names::INTERACTION,
                serde_json::json!({
                    "eventType": "interaction.resolved",
                    "agentId": agent_id,
                    "sessionId": pending.session_id,
                    "requestId": request_id_text,
                    "clientGeneration": pending.client_generation,
                    "kind": "elicitation",
                    "reason": "completed",
                }),
            );
        }
    } else {
        tracing::debug!(
            elicitation_id,
            "elicitation/complete for unknown id; ignored per spec"
        );
    }
}

/// Providers may expose a new approval/question/oauth method before a
/// dedicated AcpKind/adapter exists.  Do not silently drop an identified
/// request: answer it with Method Not Found and surface a diagnostic event.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn route_private_interaction<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    acp: &AcpLock,
    agents: &std::sync::Mutex<std::collections::HashMap<String, crate::agent_config::AgentDef>>,
    private_interactions: &crate::private_interaction::PrivateInteractionOwner,
    runtimes: &AgentRuntimeManager,
    agent_id: &str,
    generation: u64,
    raw: crate::acp::RawMessage,
) {
    let provider = agents
        .lock()
        .ok()
        .and_then(|agents| super::resolve_agent_provider(&agents, agent_id))
        .unwrap_or_else(|| "unknown".to_string());
    let private_validation = raw.method.as_deref().map(|method| {
        crate::acp::adapter::private_ext::validate_request(
            method,
            raw.params.as_ref().unwrap_or(&serde_json::Value::Null),
        )
    });
    if let (Some(request_id), Some(method), Ok(())) = (
        raw.id.clone(),
        raw.method.as_deref(),
        private_validation.clone().unwrap_or(Ok(())),
    ) {
        let bridge = match method {
            "_x.ai/ask_user_question" => {
                Some(crate::acp::adapter::private_ext::PrivateBridge::GrokExtQuestions)
            }
            "pi/select_ask" => Some(crate::acp::adapter::private_ext::PrivateBridge::PiSelectAsk),
            "_x.ai/exit_plan_mode" => {
                Some(crate::acp::adapter::private_ext::PrivateBridge::GrokExitPlan)
            }
            // #98: elicitation/create generic protocol bridge - routed
            // by method name, no provider match required (AC11).
            "elicitation/create" => {
                Some(crate::acp::adapter::private_ext::PrivateBridge::Elicitation)
            }
            _ => None,
        };
        if let Some(bridge) = bridge {
            let params = raw.params.clone().unwrap_or(serde_json::Value::Null);
            let question_specs = match bridge {
                crate::acp::adapter::private_ext::PrivateBridge::GrokExtQuestions
                | crate::acp::adapter::private_ext::PrivateBridge::PiSelectAsk => {
                    crate::acp::adapter::private_ext::parse_questions(bridge, &params).ok()
                }
                crate::acp::adapter::private_ext::PrivateBridge::GrokExitPlan
                | crate::acp::adapter::private_ext::PrivateBridge::Elicitation => None,
            };
            let session_id = params
                .get("sessionId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if !session_id.is_empty() {
                let arrived_at = crate::time::Timestamp::now();
                let _ = private_interactions.insert(
                    request_id.clone(),
                    crate::private_interaction::PendingPrivateInteraction {
                        provider: provider.clone(),
                        agent_id: agent_id.to_string(),
                        session_id: session_id.clone(),
                        method: method.to_string(),
                        bridge,
                        params: params.clone(),
                        question_specs,
                        client_generation: generation,
                        enqueued_at: arrived_at,
                    },
                );
                let interaction_event = serde_json::json!({
                    "provider": provider, "agentId": agent_id, "sessionId": session_id,
                    "eventType": match bridge {
                        crate::acp::adapter::private_ext::PrivateBridge::GrokExitPlan => "approval.request",
                        crate::acp::adapter::private_ext::PrivateBridge::Elicitation => "elicitation.request",
                        _ => "ask-user",
                    }, "requestId": request_id.to_string(),
                    "clientGeneration": generation, "payload": params,
                });
                // #98: unified interaction queue admission (drain
                // terminal states + cold-mount snapshot source).
                if let Some(runtime) = runtimes.get(agent_id) {
                    if let Err(error) = runtime.interactions.admit(
                        crate::acp::interaction_queue::InteractionQueueEntry {
                            request_id: request_id.to_string(),
                            method: method.to_string(),
                            kind: bridge.queue_kind().to_string(),
                            session_id,
                            agent_id: agent_id.to_string(),
                            client_generation: generation,
                            enqueued_at: arrived_at,
                            event: interaction_event.clone(),
                            state: crate::acp::interaction_queue::InteractionEntryState::Waiting,
                        },
                    ) {
                        tracing::warn!("interaction queue admit failed: {error}");
                    }
                }
                emit_event(window, crate::event_names::INTERACTION, interaction_event);
                return;
            }
        }
    }
    // A request-shaped interaction without an id cannot receive a
    // JSON-RPC response, but it is still surfaced as a malformed
    // interaction so the UI/runtime log explains why no card can
    // be acted on.  Do not silently drop official client requests.
    let (reason_code, rpc_code, message) = if let Some(Err(error)) = private_validation {
        (
            "invalid_private_payload",
            WireErrorCode::InvalidParams,
            format!("invalid private interaction payload: {error}"),
        )
    } else if raw.id.is_none() {
        (
            "missing_request_id",
            WireErrorCode::InvalidRequest,
            "invalid request: interaction request requires a JSON-RPC id".to_string(),
        )
    } else {
        // #98: provider name is no longer a dispatch gate - unknown
        // client requests report a stable method-level unsupported
        // (raw diagnostics kept on the rejection event).
        let reason = "method_unsupported";
        (
            reason,
            WireErrorCode::MethodNotFound,
            format!(
                "interaction {} unsupported",
                raw.method.as_deref().unwrap_or("method")
            ),
        )
    };
    reject_interaction_request(
        window,
        acp,
        &provider,
        agent_id,
        raw.method.as_deref(),
        raw.id,
        raw.params.as_ref(),
        reason_code,
        rpc_code,
        &message,
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::RawMessage;
    use crate::private_interaction::PrivateInteractionOwner;
    use crate::runtime::AgentRuntime;
    use std::collections::HashMap;

    /// mock 窗口 + INTERACTION/INTERACTION_REJECTED 事件捕获（与 test_harness
    /// boot 同源监听形态），返回 (window, webview, 事件接收端)。webview 与 app
    /// 必须在被调方存活期间留在作用域内。
    fn mock_window_with_events() -> (
        tauri::Window<tauri::test::MockRuntime>,
        tauri::WebviewWindow<tauri::test::MockRuntime>,
        tauri::App<tauri::test::MockRuntime>,
        std::sync::mpsc::Receiver<serde_json::Value>,
    ) {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock webview must build");
        let (tx, rx) = std::sync::mpsc::channel();
        for event in [
            crate::event_names::INTERACTION,
            crate::event_names::INTERACTION_REJECTED,
        ] {
            let tx = tx.clone();
            let _ = tauri::Listener::listen(&webview, event, move |e| {
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                    let _ = tx.send(payload);
                }
            });
        }
        let window = webview.as_ref().window().clone();
        (window, webview, app, rx)
    }

    fn elicitation_request(id: u64, params: serde_json::Value) -> RawMessage {
        RawMessage {
            id: Some(crate::acp::RequestId::Number(id)),
            method: Some("elicitation/create".to_string()),
            kind: crate::acp::AcpKind::from_method(Some("elicitation/create")),
            result: None,
            params: Some(params),
            error: None,
        }
    }

    fn raw_request(id: u64, method: &str, params: serde_json::Value) -> RawMessage {
        RawMessage {
            id: Some(crate::acp::RequestId::Number(id)),
            method: Some(method.to_string()),
            kind: crate::acp::AcpKind::from_method(Some(method)),
            result: None,
            params: Some(params),
            error: None,
        }
    }

    fn empty_agents() -> std::sync::Mutex<HashMap<String, crate::agent_config::AgentDef>> {
        std::sync::Mutex::new(HashMap::new())
    }

    /// 回归（#349 B2 回退 / #356 前置）：elicitation 桥 + 空 sessionId 必须
    /// 仍按 method_unsupported / -32601 拒绝——前端对空串 sessionId 的卡片
    /// 既渲染不出也提交不了，且私有交互无超时回包，入队只会让 agent 挂等
    /// 一个永不来的响应。完整修法见 issue #356。
    #[tokio::test]
    async fn elicitation_without_session_id_is_rejected_method_not_found() {
        let (window, _webview, _app, rx) = mock_window_with_events();
        let runtime = AgentRuntime::new_disconnected();
        let agents = empty_agents();
        let private_interactions = PrivateInteractionOwner::default();
        let runtimes = crate::runtime::AgentRuntimeManager::new();
        let raw = elicitation_request(
            7,
            serde_json::json!({
                "mode": "form",
                "message": "auth configuration needed",
                "requestedSchema": {"type": "object"},
                "requestId": 7
            }),
        );
        route_private_interaction(
            &window,
            &runtime.acp,
            &agents,
            &private_interactions,
            &runtimes,
            "a1",
            3,
            raw,
        )
        .await;
        assert!(
            private_interactions.snapshot().is_empty(),
            "sessionless elicitation must not be enqueued"
        );
        let event = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("rejection event must be emitted");
        assert_eq!(event["reasonCode"], "method_unsupported");
        assert_eq!(event["rpcCode"], -32601);
    }

    /// 回归（#349 B2 回退）：非 elicitation 桥（grok/pi/exit_plan）+ 空
    /// sessionId 同样必须落 -32601——准入宽化曾让这些桥在 sessionId 缺失
    /// 时也入队（规格未授权），回退后恢复既有守卫。
    #[tokio::test]
    async fn non_elicitation_bridge_without_session_id_is_rejected_method_not_found() {
        let (window, _webview, _app, rx) = mock_window_with_events();
        let runtime = AgentRuntime::new_disconnected();
        let agents = empty_agents();
        let private_interactions = PrivateInteractionOwner::default();
        let runtimes = crate::runtime::AgentRuntimeManager::new();
        let raw = raw_request(
            11,
            "_x.ai/ask_user_question",
            serde_json::json!({
                "questions": [{
                    "question": "Pick",
                    "header": "Choice",
                    "options": [{"label": "A"}, {"label": "B"}]
                }]
            }),
        );
        route_private_interaction(
            &window,
            &runtime.acp,
            &agents,
            &private_interactions,
            &runtimes,
            "a1",
            3,
            raw,
        )
        .await;
        assert!(
            private_interactions.snapshot().is_empty(),
            "sessionless ask-user must not be enqueued"
        );
        let event = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("rejection event must be emitted");
        assert_eq!(event["reasonCode"], "method_unsupported");
        assert_eq!(event["rpcCode"], -32601);
    }

    /// 回归守卫：session-scoped elicitation（带 sessionId）正常入桥入队。
    #[tokio::test]
    async fn session_scoped_elicitation_keeps_session_id_projection() {
        let (window, _webview, _app, rx) = mock_window_with_events();
        let runtime = AgentRuntime::new_disconnected();
        let agents = empty_agents();
        let private_interactions = PrivateInteractionOwner::default();
        let runtimes = crate::runtime::AgentRuntimeManager::new();
        let raw = elicitation_request(
            8,
            serde_json::json!({
                "sessionId": "peri-s1",
                "message": "pick one",
                "requestedSchema": {"type": "object"}
            }),
        );
        route_private_interaction(
            &window,
            &runtime.acp,
            &agents,
            &private_interactions,
            &runtimes,
            "a1",
            3,
            raw,
        )
        .await;
        let snapshot = private_interactions.snapshot();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].1.session_id, "peri-s1");
        let event = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("interaction event must be emitted");
        assert_eq!(event["sessionId"], "peri-s1");
    }

    /// #349 B2：未广告的 `mode:"url"` 必须按参数类错误拒绝
    /// （invalid_private_payload / -32602），不伪造入队。
    #[tokio::test]
    async fn unadvertised_url_mode_is_rejected_as_invalid_params() {
        let (window, _webview, _app, rx) = mock_window_with_events();
        let runtime = AgentRuntime::new_disconnected();
        let agents = empty_agents();
        let private_interactions = PrivateInteractionOwner::default();
        let runtimes = crate::runtime::AgentRuntimeManager::new();
        let raw = elicitation_request(
            9,
            serde_json::json!({
                "sessionId": "peri-s1",
                "mode": "url",
                "elicitationId": "el-1",
                "url": "https://example.com/auth"
            }),
        );
        route_private_interaction(
            &window,
            &runtime.acp,
            &agents,
            &private_interactions,
            &runtimes,
            "a1",
            3,
            raw,
        )
        .await;
        assert!(
            private_interactions.snapshot().is_empty(),
            "url-mode elicitation must not be enqueued"
        );
        let event = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("rejection event must be emitted");
        assert_eq!(event["reasonCode"], "invalid_private_payload");
        assert_eq!(event["rpcCode"], -32602);
    }
}
