//! 通知分发器：ACP 事件广播 → 前端/平台 + 崩溃处理 + 自动重连调度 + B9 权限挂起。
//! R1 拆分自 lib.rs（行为零变化）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::acp::AcpClient;
use crate::agent_runtime;
use crate::agent_runtime::{
    session_mapping_matches, source_for_peri_id_in_generation, AgentLifecycleStatus,
};
use crate::lifecycle::do_connect_and_replace;
use crate::permission::{permission_response, pick_option, PendingPermission};
use crate::pet::PetState;
use crate::runtime::AgentRuntime;
use crate::session::{extract_tool_file_name, value_as_string, SessionInfo};
use crate::AppStateHandles;
use crate::{emit_event, emit_event_all};

mod routing;

/// Canonical ingest failure policy for a live ACP update.
///
/// A `SessionDeleted` result is an expected outcome when a delete transaction
/// wins the race with an update that was already in the ACP inbox. The
/// tombstone gate must still reject the event (so the session cannot be
/// resurrected), but reporting that expected rejection at error level creates
/// a misleading user-facing runtime error. Keep it at debug level while
/// retaining error-level visibility for actual persistence failures.
fn log_canonical_ingest_error(error: &crate::session::EventError, agent_id: &str, source: &str) {
    if matches!(error, crate::session::EventError::SessionDeleted(_)) {
        tracing::debug!(
            code = error.code(),
            agent_id,
            source,
            error = %error,
            "late ACP update ignored for deleted session"
        );
    } else {
        tracing::error!(
            code = error.code(),
            agent_id,
            source,
            error = %error,
            "canonical ingest failed; event was not published"
        );
    }
}

/// C11/O7：一条 session/update 事件需要施加到宠物的感知事件。
/// 按收集顺序产出，调用方在 sessions 锁外逐条应用——收集顺序 = 应用顺序。
/// G3 §2.2.1：agent_message_chunk 的 FirstChunk/CodeSeen 与 apply_update_event 产出
/// 统一走收集路径（原 :366/:374 语句级独立锁 → 同锁收集、锁外按序应用，E12 接受）。
/// C11：回放（is_replay）事件仅同步 session 状态，不产生宠物感知
/// （回放不刷 xp/bond/掉落）。
#[derive(Debug)]
enum PetEvent {
    /// 原 agent_message_chunk 分支 on_first_chunk（每 !replay chunk 一次）。
    FirstChunk,
    /// 原 on_code_seen（text.contains("```")）。
    CodeSeen,
    UsageUpdate(u64),
    ToolStarted(crate::pet::ToolKind),
    CodeFile(String),
    ToolSucceeded,
    ToolFailed,
    ToolCancelled,
    ModelChanged(String),
    ModeChanged(String),
}

impl PetEvent {
    fn apply(self, state: &mut crate::pet::PetState) {
        match self {
            PetEvent::FirstChunk => crate::pet::on_first_chunk(state),
            PetEvent::CodeSeen => crate::pet::on_code_seen(state),
            PetEvent::UsageUpdate(total) => crate::pet::on_usage_update(state, total),
            PetEvent::ToolStarted(kind) => crate::pet::on_tool_started_kind(state, kind),
            PetEvent::CodeFile(file) => crate::pet::record_code_file(state, &file),
            PetEvent::ToolSucceeded => crate::pet::on_tool_success(state),
            PetEvent::ToolFailed => crate::pet::on_tool_failure(state),
            PetEvent::ToolCancelled => crate::pet::on_tool_cancelled(state),
            PetEvent::ModelChanged(model) => crate::pet::on_model_changed(state, &model),
            PetEvent::ModeChanged(mode) => crate::pet::on_mode_changed(state, &mode),
        }
    }
}

/// O7：对一条 session/update 事件施加 session 状态变更，并返回需施加到宠物的
/// 感知事件（按收集顺序）。调用方持有 sessions 锁时调用、锁外逐条应用。
/// C11：回放（is_replay）事件仅同步 session 状态（tokens/title/model/mode），
/// 不产出任何宠物感知事件。
fn apply_update_event(
    session: &mut crate::session::SessionInfo,
    update: &serde_json::Value,
    variant: Option<crate::acp::SessionUpdateVariant>,
    is_replay: bool,
) -> Vec<PetEvent> {
    apply_update_event_with_pet_policy(session, update, variant, !is_replay)
}

/// Kernel-routed variant of [`apply_update_event`].  The typed decision is the
/// only source of live/replay Pet policy on the dispatcher path; the boolean
/// wrapper above remains for focused characterization tests and legacy callers.
fn apply_update_event_routed(
    session: &mut crate::session::SessionInfo,
    update: &serde_json::Value,
    variant: Option<crate::acp::SessionUpdateVariant>,
    decision: routing::RoutingDecision,
) -> Vec<PetEvent> {
    apply_update_event_with_pet_policy(session, update, variant, decision.apply_pet)
}

fn apply_update_event_with_pet_policy(
    session: &mut crate::session::SessionInfo,
    update: &serde_json::Value,
    variant: Option<crate::acp::SessionUpdateVariant>,
    apply_pet: bool,
) -> Vec<PetEvent> {
    let mut pet_events: Vec<PetEvent> = Vec::new();
    match variant {
        Some(crate::acp::SessionUpdateVariant::UsageUpdate) => {
            session.tokens_total = update
                .get("used")
                .or_else(|| update.get("value"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            if let Some(meta) = update.get("_meta") {
                session.tokens_in = meta
                    .get("inputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                session.tokens_out = meta
                    .get("outputTokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                if let Some(model) = meta.get("model").and_then(|v| v.as_str()) {
                    session.model = model.to_string();
                }
            }
            session.context_size = update.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
            if apply_pet {
                pet_events.push(PetEvent::UsageUpdate(session.tokens_total));
            }
        }
        Some(crate::acp::SessionUpdateVariant::ToolCall) => {
            if apply_pet {
                // M5 感知：title → 工具分类（吃代码/捏朋友）；rawInput 提取文件名（脱敏摘要）
                let title = update.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let kind = crate::pet::ToolKind::classify(title);
                pet_events.push(PetEvent::ToolStarted(kind));
                // rawInput 仅提取文件名白名单形态（"path":"..."），原文绝不下沉
                if let Some(raw) = update.get("rawInput").and_then(|v| v.as_str()) {
                    if let Some(file) = extract_tool_file_name(raw) {
                        pet_events.push(PetEvent::CodeFile(file.to_string()));
                    }
                }
            }
        }
        Some(crate::acp::SessionUpdateVariant::ToolCallUpdate) => {
            if apply_pet {
                match update.get("status").and_then(|v| v.as_str()) {
                    Some("completed") => pet_events.push(PetEvent::ToolSucceeded),
                    Some("failed") => pet_events.push(PetEvent::ToolFailed),
                    Some("cancelled") => pet_events.push(PetEvent::ToolCancelled),
                    _ => {}
                }
            }
        }
        Some(crate::acp::SessionUpdateVariant::SessionInfoUpdate) => {
            if let Some(title) = update.get("title").and_then(|v| v.as_str()) {
                session.title = title.to_string();
            }
        }
        Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate) => {
            if let Some(options) = update.get("configOptions").and_then(|v| v.as_array()) {
                session.config_options = options.clone();
                session.apply_config_options(options);
            } else {
                let option_key = update
                    .get("id")
                    .or_else(|| update.get("key"))
                    .and_then(|v| v.as_str());
                let current = update
                    .get("currentValue")
                    .or_else(|| update.get("value"))
                    .and_then(value_as_string);
                match (option_key, current) {
                    (Some("model"), Some(model)) => {
                        // M5 感知：模型切换。C11：回放不推送——回放时 session 为新对象，
                        // model 为空必误判 changed（对齐 usage/tool 全部门控）。
                        let changed = session.model != model;
                        session.model = model.clone();
                        if changed && apply_pet {
                            pet_events.push(PetEvent::ModelChanged(model));
                        }
                    }
                    (Some("mode"), Some(mode)) => {
                        let changed = session.mode.as_deref() != Some(mode.as_str());
                        session.mode = Some(mode.clone());
                        if changed && apply_pet {
                            // M5 感知：工作模式切换（C11：回放不推送）
                            pet_events.push(PetEvent::ModeChanged(mode));
                        }
                    }
                    _ => {}
                }
            }
        }
        Some(crate::acp::SessionUpdateVariant::AvailableCommandsUpdate) => {
            if let Some(commands) = update
                .get("availableCommands")
                .or_else(|| update.get("commands"))
            {
                session
                    .snapshots
                    .insert("commands".to_string(), commands.clone());
            }
        }
        Some(crate::acp::SessionUpdateVariant::CurrentModeUpdate) => {
            let mode = update
                .get("currentModeId")
                .or_else(|| update.get("modeId"))
                .or_else(|| update.get("mode"))
                .and_then(value_as_string);
            if let Some(mode) = mode {
                let changed = session.mode.as_deref() != Some(mode.as_str());
                // Keep the asynchronously advertised mode in the durable snapshot as
                // well as the typed field; session/load restores snapshots before the
                // response is rebuilt, so this survives agents that only emit updates
                // after session/new or session/load.
                session
                    .snapshots
                    .insert("mode".to_string(), serde_json::Value::String(mode.clone()));
                session.mode = Some(mode.clone());
                if changed && apply_pet {
                    pet_events.push(PetEvent::ModeChanged(mode));
                }
            }
        }
        _ => {}
    }
    pet_events
}

// R8：拆 handler 后共享状态经显式参数传递（闭包捕获收敛）——别名收敛复杂签名。
type AcpLock = tokio::sync::Mutex<AcpClient>;
type SessionsLock = std::sync::Mutex<std::collections::HashMap<String, SessionInfo>>;
type PermissionLock =
    std::sync::Mutex<std::collections::HashMap<crate::acp::RequestId, PendingPermission>>;

/// Reject an interaction request at the protocol boundary.  Every rejection is both
/// observable (a redacted Tauri event/runtime log) and, when the wire supplied an id,
/// answered with a JSON-RPC error so the provider cannot wait until its own timeout.
/// The helper intentionally accepts only summary fields; params are never emitted back
/// to the UI because interaction payloads may contain commands, paths, or credentials.
#[allow(clippy::too_many_arguments)]
async fn reject_interaction_request<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    acp: &AcpLock,
    provider: &str,
    agent_id: &str,
    method: Option<&str>,
    request_id: Option<crate::acp::RequestId>,
    params: Option<&serde_json::Value>,
    reason_code: &str,
    rpc_code: i64,
    message: &str,
) {
    let request_id_text = request_id.as_ref().map(ToString::to_string);
    let response_sent = if let Some(id) = request_id {
        let (write_tx, crashed) = {
            let acp = acp.lock().await;
            (acp.write_tx.clone(), acp.crashed.clone())
        };
        crate::permission::send_agent_error(write_tx, crashed, id, rpc_code, message).await
    } else {
        false
    };
    let session_id = params.and_then(|value| {
        value.as_object().and_then(|object| {
            object
                .get("sessionId")
                .or_else(|| object.get("session_id"))
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
    });
    tracing::warn!(
        provider,
        agent_id,
        method = ?method,
        request_id = ?request_id_text,
        reason_code,
        response_sent,
        "ACP interaction request rejected: {message}"
    );
    emit_event(
        window,
        crate::event_names::INTERACTION_REJECTED,
        serde_json::json!({
            "provider": provider,
            "agentId": agent_id,
            "sessionId": session_id,
            "requestId": request_id_text,
            "method": method,
            "reasonCode": reason_code,
            "message": message,
            "rpcCode": rpc_code,
            "responseSent": response_sent,
        }),
    );
}

/// P1-3（R2-WI03）：从活 agents 配置解析 agent 的 provider（reload 修改实例 provider
/// 后新请求即用新 provider，不再依赖 dispatcher 启动时捕获的快照）。
pub(crate) fn resolve_agent_provider(
    agents: &std::collections::HashMap<String, crate::agent_config::AgentDef>,
    agent_id: &str,
) -> Option<String> {
    agents
        .get(agent_id)
        .and_then(|agent| agent.provider.clone())
}

/// B9 权限审批（R8 自主循环拆分）：agent 主动 request_permission（带 id 请求，
/// 客户端必须应答）。C4/C5 语义保持：代复核（应答不误写新代进程）+ 模式判定
/// （bypass/auto 自动批准；edit/default 挂起 + 前端事件）。
/// P0-3（R2-WI03）：provider-scoped adapter dispatch——未注册 provider 明确
/// unsupported + runtime log 可观察，不生成 RPC；classify 非 interaction 同样丢弃。
async fn handle_permission_request<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    acp: &AcpLock,
    client_generation: &AtomicU64,
    approval_mode: &std::sync::Mutex<String>,
    pending_permissions: &PermissionLock,
    provider: &str,
    agent_id: &str,
    method: Option<&str>,
    request_id: crate::acp::RequestId,
    params: Option<&serde_json::Value>,
) {
    let Some(adapter) = crate::protocol_adapter::get_protocol_adapter(provider) else {
        reject_interaction_request(
            window,
            acp,
            provider,
            agent_id,
            method,
            Some(request_id),
            params,
            "provider_unsupported",
            -32601,
            &format!("interaction provider unsupported: {provider}"),
        )
        .await;
        return;
    };
    if adapter.classify(method) != crate::protocol_adapter::InteractionClassification::Interaction {
        reject_interaction_request(
            window,
            acp,
            provider,
            agent_id,
            method,
            Some(request_id),
            params,
            "method_unsupported",
            -32601,
            &format!("interaction method unsupported: {}", method.unwrap_or("<missing>")),
        )
        .await;
        return;
    }
    // C4：记录到达时 client_generation——应答时复核，客户端替换后
    // 旧进程同 id 请求不得被旧审批决策误写。
    let Some(permission) =
        adapter.normalize_request(params, client_generation.load(Ordering::Acquire))
    else {
        // ACP-04（§5.6）：解析失败 = protocol error，不是可 approve/reject 的 pending
        // permission——**不伪造 optionId**（旧实现按拒绝兜底回 reject_once，OBS-03
        // 已证实协议缺陷），按 ACP 标准发 JSON-RPC error（-32602 Invalid params），
        // 让 agent 按标准错误处理。未挂起 pending，无需清理。
        // O9/G3 §2.2.2：锁内只克隆发送句柄，锁外发送；同时发出独立拒绝事件，
        // 让前端能解释“为什么没有弹出权限卡”。
        reject_interaction_request(
            window,
            acp,
            provider,
            agent_id,
            method,
            Some(request_id),
            params,
            "invalid_params",
            -32602,
            // Keep the stable diagnostic phrase used by the OBS-03 evidence
            // surface while retaining the machine-readable invalid_params
            // reason code and JSON-RPC -32602 response above.
            "ACP request_permission 解析失败: invalid params",
        )
        .await;
        return;
    };
    let mode = approval_mode
        .lock()
        .map(|m| m.clone())
        .unwrap_or_else(|_| "default".to_string());
    if matches!(mode.as_str(), "bypass" | "auto") {
        tracing::info!(
            "权限模式 {mode}：自动批准工具调用 {}",
            permission.tool_call_id
        );
        // C5：自动批准按请求选项选 allow 语义项（无匹配取首个）。ACP-04（§5.6）：
        // 解析层保证 options 非空（空集不可能进此分支），pick_option 恒返回 Some；
        // 防御分支不得伪造 optionId——如异常出现则跳过应答并告警（agent 侧自会
        // 超时收敛），绝不硬编码不存在的选项。
        let Some(option_id) = pick_option(&permission.options, false) else {
            tracing::error!(
                "权限模式 {mode}：请求 options 为空（不应发生），跳过自动批准应答，不伪造 optionId"
            );
            reject_interaction_request(
                window,
                acp,
                provider,
                agent_id,
                method,
                Some(request_id),
                params,
                "invalid_options",
                -32602,
                "invalid params: permission request options 为空",
            )
            .await;
            return;
        };
        // O9/G3 §2.2.2：无 pending 直接应答——锁外发送（同解析失败分支）。
        let (write_tx, crashed) = {
            let acp = acp.lock().await;
            (acp.write_tx.clone(), acp.crashed.clone())
        };
        crate::permission::send_agent_response(
            write_tx,
            crashed,
            request_id,
            permission_response(option_id),
        )
        .await;
    } else {
        let _ = pending_permissions.lock().map(|mut pending| {
            pending.insert(request_id.clone(), permission.clone());
        });
        let payload = serde_json::json!({
            "title": permission.title,
            "prompt": permission.prompt,
            "options": permission.options,
            "requestedAt": permission.requested_at,
            // ACP-03（§5.6）：deadline 由后端单一来源（PERMISSION_REQUEST_TIMEOUT_SECS），
            // 前端只做倒计时展示，不自行持有 300s 常量。
            "deadlineMs": crate::permission::permission_deadline_ms(permission.requested_at),
        });
        emit_event(
            window,
            crate::event_names::INTERACTION,
            serde_json::json!({
                "provider": provider,
                "agentId": agent_id,
                "sessionId": permission.session_id,
                "eventType": "permission.request",
                "requestId": request_id.to_string(),
                "toolCallId": permission.tool_call_id,
                "clientGeneration": permission.client_generation,
                "payload": payload,
            }),
        );
    }
}

/// 剥离 replay 的 user 消息 persona/session_prompt 前缀（验收回归 D3）。
/// Pylon 首条消息发送"{effective_persona}\n\n---\n\n{content}"给 Hermes（prompt.rs
/// 的 effective_persona = session_prompt 优先于 persona），Hermes 持久化该完整
/// prompt;load 重放时 content 带前缀,与前端 live 的原文不一致导致内容签名去重
/// 失效（每次回到会话消息累积）。
///
/// 剥离策略：不依赖精确 persona 匹配（session_prompt 场景 persona 不匹配），
/// 而是检测 `\n\n---\n\n` 分隔符——它是 Pylon 发送首条消息时的固定分隔。存在
/// 则取分隔符后的原文；不存在（后续轮次消息无前缀）原样返回。用户原文若自身
/// 含该分隔符会误剥，但概率极低且仅影响重放去重。
pub(crate) fn strip_persona_prefix(text: &str, _persona: &str) -> String {
    const SEP: &str = "\n\n---\n\n";
    match text.find(SEP) {
        Some(idx) => {
            let content = &text[idx + SEP.len()..];
            if content.is_empty() {
                text.to_string()
            } else {
                content.to_string()
            }
        }
        None => text.to_string(),
    }
}

/// NOTIF_SESSION_UPDATE 处理（R8 自主循环拆分）：source 解析（重试循环）→ 代际
/// 复核 → session 状态 + 宠物感知应用（C11 回放守卫 / O7 锁外应用）→ 前端+平台
/// 转发（B10.1）。返回 false 表示本代已结束（主循环应退出）。
// clippy 2026-08-03：8 参为 R8 显式参数风格（window/gateway/sessions/pet/
// client_generation/generation/mapping_ready/payload），与调用点逐参对应，
// 结构体重构收益低。
#[allow(clippy::too_many_arguments)]
async fn handle_session_update<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    gateway: &crate::gateway::GatewayCore,
    sessions: &SessionsLock,
    binding_health: &std::sync::Mutex<
        std::collections::HashMap<String, crate::agent_runtime::SessionBindingHealth>,
    >,
    pet: &std::sync::Mutex<PetState>,
    update_channels: &crate::runtime::UpdateChannelMap,
    client_generation: &AtomicU64,
    generation: u64,
    mapping_ready: &tokio::sync::Notify,
    agent_id: &str,
    event_service: Option<&Arc<crate::session::EventService>>,
    message_service: Option<&Arc<crate::session::MessageService>>,
    classification: crate::acp::ReplayClassification,
    mut payload: serde_json::Value,
) -> bool {
    let peri_id = match payload.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            tracing::warn!("ACP session/update missing sessionId");
            return true;
        }
    };
    let binding_blocked = match sessions.lock() {
        Ok(items) => items
            .iter()
            .find(|(_, session)| session.peri_id == peri_id)
            .is_some_and(|(source, _)| match binding_health.lock() {
                Ok(health) => matches!(
                    health.get(source),
                    Some(
                        crate::agent_runtime::SessionBindingHealth::Probing { .. }
                            | crate::agent_runtime::SessionBindingHealth::Detached { .. }
                    )
                ),
                Err(_) => true,
            }),
        Err(_) => true,
    };
    if binding_blocked {
        tracing::warn!(
            "ACP notification rejected while session binding is not attached: {}",
            peri_id
        );
        return true;
    }
    let source = {
        let mut mapped = None;
        let mut ambiguous = false;
        // R6：映射就绪事件化（吸收 O5）——20×5ms 轮询改为事件驱动：RPC 先于
        // 插映射，通知可先到，故仍在 100ms 窗口内等待；insert 成功后
        // mapping_ready.notify_waiters() 唤醒，deadline 兜底总等待 ≤100ms。
        // 唤醒可能来自其他会话的插映射（并发建会话），每次唤醒后复核，
        // 未命中且未超时则继续等——与原轮询语义等价（最坏仍 100ms 丢弃）。
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
        loop {
            if let Ok(items) = sessions.lock() {
                let mappings = items
                    .iter()
                    .map(|(source, info)| (source, &info.peri_id, info.generation));
                mapped = source_for_peri_id_in_generation(mappings, &peri_id, generation);
                ambiguous = items
                    .values()
                    .filter(|info| info.peri_id == peri_id && info.generation == generation)
                    .count()
                    > 1;
            }
            if mapped.is_some() || ambiguous {
                break;
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let _ = tokio::time::timeout(remaining, mapping_ready.notified()).await;
        }
        if ambiguous {
            tracing::warn!(
                "ACP notification rejected: periId {} maps to multiple local sources",
                peri_id
            );
            return true;
        }
        let Some(mapped) = mapped else {
            tracing::warn!("ACP notification for unknown session {}", peri_id);
            return true;
        };
        mapped.0
    };
    // source_for_peri_id_in_generation 已按代过滤（返回的映射
    // generation 必等于本 dispatcher 代），此处仅复核客户端未替换。
    if client_generation.load(Ordering::Acquire) != generation {
        tracing::warn!("ACP notification rejected for stale session {}", peri_id);
        return true;
    }
    let Some(update) = payload.get("update") else {
        tracing::warn!("ACP session/update missing update payload");
        return true;
    };
    // R4：sessionUpdate 变体经枚举解析（未知变体 → None，与旧 _ => {} 忽略一致）。
    let variant = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .and_then(crate::acp::SessionUpdateVariant::from_str);
    // Replay/live is decided once at the transport boundary and passed through
    // the Kernel seam. Provider `_meta.periReplay` is compatibility metadata,
    // never an authority for side-effect policy.
    let is_replay = routing::classification_is_replay(classification);
    // G3 §2.2.1 锁收敛：单一临界区取代原 mapping_is_current 预检（锁 2）、
    // received_round 读取（锁 3）、collect_response_chunk（锁 4）、mutation（锁 5）四段。
    // early return 语义逐一保持：stale → return true（保持主循环）；user_message_chunk
    // → 回显后 return true（不转发 emit_event_all）；mutation 后 generation 变化 →
    // return false（结束主循环）。副作用顺序不变：FirstChunk → CodeSeen →
    // apply_update_event 产出（收集顺序 = 应用顺序，锁外统一 apply）。
    // 良性竞态修正：received_round 读取与 collect 合锁原子（原两次独立锁间
    // advance_round 可能推进回合——collect 内 round 比对兜底，行为只会更保守）。
    // C11：回放（is_replay）事件不触发宠物感知也不流式收集回复文本，事件照常转发。
    let mut pet_events: Vec<PetEvent> = Vec::new();
    let mut user_echo: Option<String> = None; // replay user_message_chunk 文本，锁外 emit
    let mut is_user_chunk = false;
    let mut session_state_to_persist: Option<(
        crate::session::DurableSessionOwner,
        serde_json::Value,
    )> = None;
    let routing_input: routing::RoutingInput;
    let routing_decision: routing::RoutingDecision;
    let durable_owner;
    {
        let Ok(mut items) = sessions.lock() else {
            // 锁中毒：丢弃本事件（原 mapping_is_current 同语义）
            return true;
        };
        if client_generation.load(Ordering::Acquire) != generation {
            tracing::warn!("ACP notification rejected for stale session {}", peri_id);
            return true;
        }
        let current = items.get(&source).is_some_and(|session| {
            session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation)
        });
        if !current {
            tracing::warn!("ACP notification rejected for stale session {}", peri_id);
            return true;
        }
        durable_owner = match items
            .get(&source)
            .expect("current mapping checked")
            .durable_owner(agent_id, &source)
        {
            Ok(owner) => owner,
            Err(error) => {
                tracing::error!(
                    code = "event_owner_invalid",
                    agent_id,
                    source,
                    error = %error,
                    "canonical ingest rejected an invalid durable owner"
                );
                return true;
            }
        };
        let replay_loading = items
            .get(&source)
            .is_some_and(|session| session.replay_loading);
        let input = routing::RoutingInput {
            source: source.clone(),
            remote_session_id: peri_id.clone(),
            generation,
            owner: durable_owner.clone(),
            classification,
            variant,
            replay_loading,
            payload: payload.clone(),
        };
        let decision = routing::decide(&input);
        routing_input = input;
        routing_decision = decision;
        // R-t5：任意被接受的 live ACP update 都刷新 liveness（活动即续命）。
        // 仅跳过回放事件（历史重放不是本回合的实时产出，不应当作活动信号）。
        if !is_replay {
            if let Some(session) = items.get_mut(&source) {
                session.last_activity = Some(std::time::Instant::now());
            }
        }
        if decision.collect_response {
            let effects = routing::agent_message_chunk_effects(update, decision);
            if effects.first_chunk {
                pet_events.push(PetEvent::FirstChunk);
            }
            if effects.code_seen {
                pet_events.push(PetEvent::CodeSeen);
            }
            // B11.2：流式收集当前回合回复文本（完成持久化 POST /persist 用）。
            // 回合绑定与截断逻辑仍由 SessionInfo 持有；routing 只决定该 chunk
            // 是否属于 live response，避免 replay 事件进入 live collector。
            if let Some(text) = effects.text.as_deref() {
                if let Some(session) = items.get_mut(&source) {
                    let received_round = session.inject_round;
                    session.collect_response_chunk(text, received_round);
                }
            }
        }
        if variant == Some(crate::acp::SessionUpdateVariant::UserMessageChunk) {
            is_user_chunk = true;
            if is_replay {
                // session/load 的历史由 load_persisted_session command 原子返回，
                // dispatcher 不再把 replay 事件广播给前端，避免与 snapshot 双写。
                let text = update
                    .get("content")
                    .and_then(|c| c.get("text"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string);
                user_echo = if items
                    .get(&source)
                    .is_some_and(|session| session.replay_loading)
                {
                    None
                } else {
                    text.map(|text| {
                        let persona = items
                            .get(&source)
                            .map(|session| session.persona.clone())
                            .unwrap_or_default();
                        strip_persona_prefix(&text, &persona)
                    })
                };
            }
        } else if let Some(session) = items.get_mut(&source) {
            if !decision.mutate_session {
                return true;
            }
            pet_events.extend(apply_update_event_routed(session, update, variant, decision));
            // Agents may advertise commands or mode changes asynchronously after
            // session/new or session/load. Persist the merged session snapshot so
            // a later reload retains those capabilities.
            if !is_replay
                && matches!(
                    variant,
                    Some(
                        crate::acp::SessionUpdateVariant::AvailableCommandsUpdate
                            | crate::acp::SessionUpdateVariant::CurrentModeUpdate
                    )
                )
            {
                if let Some(owner) = durable_owner.clone() {
                    let snapshot = serde_json::Value::Object(
                        session
                            .snapshots
                            .iter()
                            .map(|(key, value)| (key.clone(), value.clone()))
                            .collect(),
                    );
                    session_state_to_persist = Some((owner, snapshot));
                }
            }
            // 原 :417-433
        }
    }
    // 锁外副作用（原 :400-409 emit 本就在锁外；pet 感知 O7 锁外应用）
    if let Some(text) = user_echo {
        emit_event(
            window,
            crate::event_names::USER_ECHO,
            serde_json::json!({
                "source": source,
                "content": text,
                "replay": true,
            }),
        );
    }
    // Prompt user event 由 send_prompt_core 先行写入 journal；ACP user echo 不重复写。
    if is_user_chunk {
        return true; // 原 :411 语义：user_message_chunk 不转发 emit_event_all
    }
    // D1/D7：Kernel routing 先完成 live canonical append，只有 committed result
    // 才允许继续进入 Channel/Gateway。平台 owner=None 与 replay 都明确跳过持久化。
    let input = routing_input;
    let decision = routing_decision;
    let committed_event = match routing::commit_live_event(
        &input,
        decision,
        event_service,
    )
    .await
    {
        routing::CommitOutcome::Skipped => None,
        routing::CommitOutcome::MissingService => {
            tracing::error!(
                code = "event_db_unavailable",
                agent_id,
                source,
                "canonical ingest unavailable after startup readiness barrier"
            );
            return true;
        }
        routing::CommitOutcome::Committed(event) => Some(event),
        routing::CommitOutcome::Rejected(error) => {
            log_canonical_ingest_error(&error, agent_id, &source);
            return true;
        }
    };
    if let (Some((owner, snapshot)), Some(message_service)) =
        (session_state_to_persist, message_service)
    {
        if let Err(error) = message_service
            .set_session_state(owner, Some(peri_id.clone()), snapshot)
            .await
        {
            tracing::warn!(
                agent_id,
                source,
                error = %error,
                "ACP session state snapshot persistence failed"
            );
        }
    }
    for event in pet_events {
        let _ = pet.lock().map(|mut p| event.apply(&mut p));
    }
    if client_generation.load(Ordering::Acquire) != generation {
        return false; // 原 :437-439 语义：mutation 后本代已结束，主循环退出
    }
    if !decision.publish {
        return true;
    }
    if let serde_json::Value::Object(ref mut map) = payload {
        map.insert(
            "source".to_string(),
            serde_json::Value::String(source.clone()),
        );
        if let Some(committed_event) = committed_event {
            map.insert(
                "canonicalEvent".to_string(),
                serde_json::to_value(committed_event).unwrap_or(serde_json::Value::Null),
            );
        }
    }
    // C1：广播旧轨已拆除——SESSION_UPDATE 仅走 Channel（信封帧）；未注册 source
    // （平台会话 / 未升级前端）仍走既有 emit_event_all（gateway.deliver_all 同源独立）。
    // 平台源（qq:* 等）永远走广播路径：deliver_all 是其唯一出站通道，Channel 只服务
    // GUI 流式回显。即使未来误为平台源注册 channel 也不得截胡平台投递（防御深度）。
    let channel = if gateway.is_platform_source(&source) {
        None
    } else {
        update_channels
            .lock()
            .ok()
            .and_then(|map| map.get(&source).cloned())
    };
    if let Some(channel) = channel {
        let frame = serde_json::json!({
            "event": crate::event_names::SESSION_UPDATE,
            "payload": payload,
        });
        if let Err(error) = channel.send(frame) {
            tracing::warn!("channel update 帧发送失败 source={source}: {error}");
        }
        return true;
    }
    emit_event_all(
        window,
        gateway,
        &source,
        crate::event_names::SESSION_UPDATE,
        payload,
    );
    true
}

/// 启动（或重启）通知分发器：消费 ACP 单消费者无损通知 inbox，把事件路由到
/// 前端（WebView 事件）与平台（gateway deliver_all），并处理崩溃/权限/宠物感知。
pub(crate) fn start_notification_dispatcher<R: tauri::Runtime>(
    handles: &AppStateHandles,
    runtime: &Arc<AgentRuntime>,
    window: tauri::WebviewWindow<R>,
) {
    // O8：锁中毒（panic 时持有者遗弃）也恢复重启——into_inner 取出 guard，
    // 否则 dispatcher 永久静默下线，自动重连/崩溃通知全部失效。
    let mut task = runtime
        .notification_task
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(handle) = task.take() {
        handle.abort();
    }
    let acp = runtime.acp.clone();
    let sessions = runtime.sessions.clone();
    let binding_health = runtime.binding_health.clone();
    let pet = handles.pet.clone();
    let generation = runtime
        .client_generation
        .load(std::sync::atomic::Ordering::Acquire);
    let client_generation = runtime.client_generation.clone();
    let agents = handles.agents.clone();
    let active_agent = handles.active_agent.clone();
    let agent_runtime = runtime.agent_runtime.clone();
    let runtime_logs = handles.runtime_logs.clone();
    let runtimes = handles.runtimes.clone();
    let gateway = handles.gateway.clone();
    let approval_mode = handles.approval_mode.clone();
    let event_service_slot = handles.event_service.clone();
    let event_service = event_service_slot.lock().ok().and_then(|slot| slot.clone());
    let message_service_slot = handles.message_service.clone();
    let message_service = handles
        .message_service
        .lock()
        .ok()
        .and_then(|slot| slot.clone());
    let pending_permissions = runtime.pending_permissions.clone();
    let agent_id = handles
        .runtimes
        .all_with_ids()
        .into_iter()
        .find(|(_, candidate)| Arc::ptr_eq(candidate, runtime))
        .map(|(id, _)| id)
        .unwrap_or_else(|| "unknown".to_string());
    // P1-3（R2-WI03）：provider 不再启动时捕获——每次 PermissionRequest 从活配置解析
    // （见主循环对应分支），reload 修改实例 provider 后新请求即用新 provider。
    let runtime_for_reconnect = runtime.clone();
    *task = Some(tokio::spawn(async move {
        let notification_inbox = acp.lock().await.notification_inbox();
        // A7：崩溃信号独立 watch 通道——broadcast 洪泛 Lagged 时 NOTIF_AGENT_CRASHED
        // 会丢，自动重连依赖本通道（主循环 select! 双路监听，见下）。
        let mut crashed_rx = acp.lock().await.crashed_receiver();
        // R7：自动重连状态组（reconnect_epoch / remaining_attempts / pending_reconnect）。
        // - reconnect_epoch：本 dispatcher 实例（=本 runtime 代际）的崩溃通知计数，
        //   每次 handle_crash 通知 +1（含被防重入标志吸收的重复/新一轮通知——被吸收
        //   的通知以 epoch 变化表达"重连意图待消费"，不再被静默吞掉）。
        // - remaining_attempts：重连循环内的局部尝试计数（预算），epoch 变化时重置。
        // - pending_reconnect 概念：epoch 变化即"新一轮崩溃在重连循环期间到来"——
        //   重连循环每轮复查 epoch 未变；变了则旧循环放弃（消费旧 ticket），以最新
        //   epoch 重新武装（退避从 attempt 1 重新开始）。A5 的"成功分支复查"窄窗口
        //   由此结构性覆盖（不再依赖单一复查点）。
        let reconnect_epoch = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        // A7：崩溃处理提取为闭包，broadcast 分支与 watch 分支共用。幂等设计：
        // auto_reconnect_active 防重入，双通道都送达时最多多发一次同 payload 状态事件。
        // ISSUE-17 W1（LR2-WI06）：闭包接收 crash reason（稳定 code，transport.rs
        // CrashReason::as_str）——不再硬编码 stdout closed；用户可读文案保留原始 code
        // （不覆盖诊断字段）。
        let handle_crash = {
            // 闭包持克隆（原值供循环内其他路径使用）；每次调用再克隆入 future——
            // async move 拥有全部捕获，多次调用不互相移动。
            let agent_runtime = agent_runtime.clone();
            let pet = pet.clone();
            let runtimes = runtimes.clone();
            let agents = agents.clone();
            let active_agent = active_agent.clone();
            let runtime_logs = runtime_logs.clone();
            let gateway = gateway.clone();
            let approval_mode = approval_mode.clone();
            let window = window.clone();
            let runtime_for_reconnect = runtime_for_reconnect.clone();
            let reconnect_epoch = reconnect_epoch.clone();
            let event_service_slot = event_service_slot.clone();
            let message_service_slot = message_service_slot.clone();
            move |reason: String| {
                let agent_runtime = agent_runtime.clone();
                let pet = pet.clone();
                let runtimes = runtimes.clone();
                let agents = agents.clone();
                let active_agent = active_agent.clone();
                let runtime_logs = runtime_logs.clone();
                let gateway = gateway.clone();
                let approval_mode = approval_mode.clone();
                let window = window.clone();
                let runtime_for_reconnect = runtime_for_reconnect.clone();
                let reconnect_epoch = reconnect_epoch.clone();
                let event_service_slot = event_service_slot.clone();
                let message_service_slot = message_service_slot.clone();
                async move {
                    // ISSUE-17 目标行为 2：保留原始 code 生成用户可读文案（不覆盖诊断字段）
                    let last_error = format!("ACP 进程崩溃（{reason}）");
                    if let Ok(mut runtime_state) = agent_runtime.lock() {
                        runtime_state.status = AgentLifecycleStatus::Crashed;
                        runtime_state.last_error = Some(last_error.clone());
                    }
                    let _ = pet.lock().map(|mut p| crate::pet::on_agent_crashed(&mut p));
                    // P2-4：崩溃 payload 复用 agent_status_payload（状态已置 Crashed，
                    // 读出的形状与旧手工构造一致：status=crashed/available=false/
                    // crashed=true/lastError 注入），不再双份维护同一形状。
                    let reconnect_handles = AppStateHandles {
                        runtimes: runtimes.clone(),
                        agents: agents.clone(),
                        active_agent: active_agent.clone(),
                        pet: pet.clone(),
                        runtime_logs: runtime_logs.clone(),
                        gateway: gateway.clone(),
                        approval_mode: approval_mode.clone(),
                        event_service: event_service_slot.clone(),
                        message_service: message_service_slot.clone(),
                    };
                    emit_event(
                        &window,
                        crate::event_names::AGENT_STATUS,
                        reconnect_handles
                            .agent_status_payload(Some(runtime_for_reconnect.as_ref())),
                    );
                    // R7：每次崩溃通知推进 reconnect_epoch（防重入标志无论是否持有）——
                    // 被吸收的重复通知也会改变 epoch，重连循环据此感知"新一轮崩溃到来"。
                    reconnect_epoch.fetch_add(1, Ordering::AcqRel);
                    // 自动重连：崩溃后指数退避自动拉起（最多 5 次，~62s）。
                    // 防重入：多次崩溃通知只调度一次（auto_reconnect_active）。
                    // per-runtime 语义：只重连本 runtime 绑定的 agent；用户手动
                    // reconnect 会置状态非 Crashed、手动 switch 会改变 active_agent，
                    // 循环内每轮复查后放弃。切换 agent 不会串扰其他 runtime。
                    if !runtime_for_reconnect
                        .auto_reconnect_active
                        .swap(true, Ordering::AcqRel)
                    {
                        let reconnect_runtime = runtime_for_reconnect.clone();
                        let window_for_reconnect = window.clone();
                        let epoch_for_reconnect = reconnect_epoch.clone();
                        // 调度时读当前 epoch：本循环的 ticket。
                        let mut scheduled_epoch = reconnect_epoch.load(Ordering::Acquire);
                        tokio::spawn(async move {
                            // 手动 switch 会 abort 本 runtime 的 dispatcher，但不会
                            // cancel 自动重连闭包——每轮用 active_agent 复查拦截，
                            // 防止重连成功后把 active_agent 顶回本 agent。
                            let reconnect_agent_id = reconnect_handles
                                .active_agent
                                .lock()
                                .ok()
                                .map(|v| v.clone())
                                .unwrap_or_default();
                            // R7：remaining_attempts 局部预算 + attempt 退避指数。
                            // G2-07：重连策略参数化（默认值 = 现值 5/2000/30000，行为零变化）。
                            let mut remaining_attempts =
                                agent_runtime::ReconnectPolicy::default().max_attempts;
                            let mut attempt: u32 = 1;
                            // O-4：退出闸门（外层循环）——内层循环因成功复查通过/提前放弃/
                            // 预算耗尽退出时，期间可能恰有一轮崩溃通知被处理（epoch 已变，
                            // 防重入 swap 被吞）：其"重连意图"未消费，若此刻释放标志则该
                            // 崩溃不再调度新循环。闸门复查 epoch——未变才退出消费 ticket
                            // 并释放标志；已变则重新武装（预算与退避重置）继续重连（标志
                            // 持续持有，本循环仍是唯一重连权威，对齐 R7 每轮复查语义）。
                            'auto_reconnect: loop {
                                loop {
                                    if remaining_attempts == 0 {
                                        break;
                                    }
                                    // R7：每轮复查 epoch——重连期间到来新一轮崩溃通知（含被防重入
                                    // 标志吸收的）→ 本循环已失效：放弃旧 ticket、以最新 epoch 重新
                                    // 武装（预算与退避重置），本循环仍是唯一重连权威（标志持续持有）。
                                    if epoch_for_reconnect.load(Ordering::Acquire)
                                        != scheduled_epoch
                                    {
                                        tracing::info!(
                                "auto-reconnect superseded by a newer crash; re-arming from attempt 1"
                            );
                                        // 放弃旧 ticket：以最新 epoch 重新武装。
                                        scheduled_epoch =
                                            epoch_for_reconnect.load(Ordering::Acquire);
                                        remaining_attempts =
                                            agent_runtime::ReconnectPolicy::default().max_attempts;
                                        attempt = 1;
                                    }
                                    tokio::time::sleep(std::time::Duration::from_millis(
                                        agent_runtime::ReconnectPolicy::default()
                                            .backoff_ms(attempt),
                                    ))
                                    .await;
                                    // 用户已手动 reconnect（状态非 Crashed）或已 switch（active_agent
                                    // 已换）→ 放弃自动重连。两读在同一锁持有期内完成，消除
                                    // "已复查 stale、尚未复查 active"之间的切换窗口。
                                    let (still_stale, still_active) = {
                                        let runtime_guard = reconnect_runtime
                                            .agent_runtime
                                            .lock()
                                            .unwrap_or_else(|p| p.into_inner());
                                        let active_guard = reconnect_handles
                                            .active_agent
                                            .lock()
                                            .unwrap_or_else(|p| p.into_inner());
                                        (
                                            runtime_guard.status == AgentLifecycleStatus::Crashed,
                                            active_guard.as_str() == reconnect_agent_id,
                                        )
                                    };
                                    if !(still_stale && still_active) {
                                        // 核验修复：提前放弃也必须释放防重入标志，
                                        // 否则后续崩溃将永远不再自动重连。
                                        break;
                                    }
                                    let agent = reconnect_handles
                                        .agents
                                        .lock()
                                        .ok()
                                        .and_then(|a| a.get(&reconnect_agent_id).cloned());
                                    let Some(agent) = agent else {
                                        break;
                                    };
                                    let _lifecycle_guard =
                                        reconnect_runtime.agent_lifecycle.lock().await;
                                    // R9：自动重连是 LifecycleOp 状态机的一环——经本 runtime 的
                                    // agent_lifecycle 与 switch/reconnect/平台懒启动串行（无 kill，
                                    // 不持 switch_lock；状态机定义见 lifecycle.rs 模块文档）。
                                    // P2-1：拿到生命周期锁后重查"仍然需要连接"——复查 stale 与
                                    // 拿锁之间，用户手动 reconnect 可能已把状态置非 Crashed 并完成
                                    // 连接；此时再 do_connect_and_replace 会连续第二次连接。
                                    // 手动操作（switch/reconnect）同样在锁内改状态，锁串行后
                                    // 此处必能看到其结果。
                                    let still_stale = reconnect_runtime
                                        .agent_runtime
                                        .lock()
                                        .map(|r| r.status == AgentLifecycleStatus::Crashed)
                                        .unwrap_or(false);
                                    if !still_stale {
                                        break;
                                    }
                                    match do_connect_and_replace(
                                        &reconnect_handles,
                                        &reconnect_runtime,
                                        &window_for_reconnect,
                                        &agent,
                                        None,
                                        AgentLifecycleStatus::Reconnecting,
                                        "auto-reconnect",
                                        crate::agent_runtime::SessionContinuity::Unknown,
                                        true,
                                    )
                                    .await
                                    {
                                        Ok(()) => {
                                            // 连接成功后又立即崩溃时，新 dispatcher 的崩溃通知会被
                                            // "已重连"防重入标志吞掉（标志仍持有）——成功分支复查，
                                            // 仍 Crashed 则继续退避重连，避免 agent 永久下线。
                                            let still_stale = reconnect_runtime
                                                .agent_runtime
                                                .lock()
                                                .map(|r| r.status == AgentLifecycleStatus::Crashed)
                                                .unwrap_or(false);
                                            if still_stale {
                                                attempt += 1;
                                                remaining_attempts -= 1;
                                                continue;
                                            }
                                            break;
                                        }
                                        Err(error) => {
                                            tracing::warn!(
                                                "auto-reconnect attempt {attempt} failed: {error}"
                                            );
                                            attempt += 1;
                                            remaining_attempts -= 1;
                                        }
                                    }
                                }
                                if epoch_for_reconnect.load(Ordering::Acquire) == scheduled_epoch {
                                    break 'auto_reconnect;
                                }
                                tracing::info!(
                        "auto-reconnect ended but a newer crash arrived; re-arming from attempt 1"
                    );
                                scheduled_epoch = epoch_for_reconnect.load(Ordering::Acquire);
                                remaining_attempts =
                                    agent_runtime::ReconnectPolicy::default().max_attempts;
                                attempt = 1;
                            }
                            // R7：成功/放弃消费 ticket——循环结束（成功、提前放弃或预算耗尽）
                            // 统一推进 epoch，使后续通知的计数严格单调。
                            epoch_for_reconnect.fetch_add(1, Ordering::AcqRel);
                            reconnect_runtime
                                .auto_reconnect_active
                                .store(false, Ordering::Release);
                        });
                    }
                }
            }
        };
        // 订阅即查现值：崩溃发生在订阅之前（connect 成功后立刻 EOF、dispatcher
        // 尚未启动）时 changed() 不会触发，只能靠 watch 保留的最新值兜底。
        if *crashed_rx.borrow_and_update() {
            // watch 通道只携带 bool 不携带 reason → 缺省 stdout_closed（订阅前 EOF 场景）
            handle_crash(crate::acp::CrashReason::StdoutClosed.as_str().to_string()).await;
        }
        loop {
            if client_generation.load(Ordering::Acquire) != generation {
                break;
            }
            let raw = tokio::select! {
                biased;
                // A7：watch 分支——崩溃信号不依赖 broadcast 容量，洪泛 Lagged 后仍触发
                changed = crashed_rx.changed() => {
                    if changed.is_ok() && *crashed_rx.borrow_and_update() {
                        // watch 通道只携带 bool → 缺省 stdout_closed（reason 经 broadcast params 携带）
                        handle_crash(crate::acp::CrashReason::StdoutClosed.as_str().to_string()).await;
                    }
                    continue;
                }
                raw = notification_inbox.recv() => raw,
            };
            let classified = match raw {
                Some(classified) => classified,
                None => break,
            };
            let crate::acp::ClassifiedMessage {
                raw,
                classification,
            } = classified;
            if client_generation.load(Ordering::Acquire) != generation {
                break;
            }
            if raw.kind == crate::acp::AcpKind::Crashed {
                // ISSUE-17 W1：broadcast 携带 reason（params.reason，稳定 code）——
                // dispatcher 保留原始 code 生成用户可读文案；缺省 stdout_closed
                let reason = raw
                    .params
                    .as_ref()
                    .and_then(|p| p.get("reason"))
                    .and_then(|v| v.as_str())
                    .unwrap_or(crate::acp::CrashReason::StdoutClosed.as_str())
                    .to_string();
                handle_crash(reason).await;
                continue;
            }
            // B9 权限审批：agent 主动 request_permission（带 id 请求，客户端必须应答）。
            // ACP-01：id 为原始 variant（number/string）——string-id agent 请求不再丢弃。
            if raw.kind == crate::acp::AcpKind::PermissionRequest {
                if let Some(request_id) = raw.id {
                    // P1-3：provider 每次请求时从活 agents 配置解析（reload 生效）。
                    let provider = agents
                        .lock()
                        .ok()
                        .and_then(|agents| resolve_agent_provider(&agents, &agent_id))
                        .unwrap_or_else(|| "unknown".to_string());
                    handle_permission_request(
                        &window,
                        &acp,
                        &client_generation,
                        &approval_mode,
                        &pending_permissions,
                        &provider,
                        &agent_id,
                        raw.method.as_deref(),
                        request_id,
                        raw.params.as_ref(),
                    )
                    .await;
                } else {
                    // ACP-01：null/absent id 的 request_permission 是畸形协议请求——
                    // 不静默当 0（不臆造 id 应答），记录并发出不可提交的拒绝事件。
                    let provider = agents
                        .lock()
                        .ok()
                        .and_then(|agents| resolve_agent_provider(&agents, &agent_id))
                        .unwrap_or_else(|| "unknown".to_string());
                    reject_interaction_request(
                        &window,
                        &acp,
                        &provider,
                        &agent_id,
                        raw.method.as_deref(),
                        None,
                        raw.params.as_ref(),
                        "missing_request_id",
                        -32600,
                        "invalid request: interaction request requires a JSON-RPC id",
                    )
                    .await;
                }
                continue;
            }
            // Providers may expose a new approval/question/oauth method before a
            // dedicated AcpKind/adapter exists.  Do not silently drop an identified
            // request: answer it with Method Not Found and surface a diagnostic event.
            if crate::protocol_adapter::looks_like_interaction_method(raw.method.as_deref()) {
                let provider = agents
                    .lock()
                    .ok()
                    .and_then(|agents| resolve_agent_provider(&agents, &agent_id))
                    .unwrap_or_else(|| "unknown".to_string());
                // A request-shaped interaction without an id cannot receive a
                // JSON-RPC response, but it is still surfaced as a malformed
                // interaction so the UI/runtime log explains why no card can
                // be acted on.  Do not silently drop official client requests.
                let (reason_code, rpc_code, message) = if raw.id.is_none() {
                    (
                        "missing_request_id",
                        -32600,
                        "invalid request: interaction request requires a JSON-RPC id".to_string(),
                    )
                } else {
                    let reason = if crate::protocol_adapter::get_protocol_adapter(&provider).is_some() {
                        "method_unsupported"
                    } else {
                        "provider_unsupported"
                    };
                    (
                        reason,
                        -32601,
                        format!(
                            "interaction {} unsupported",
                            raw.method.as_deref().unwrap_or("method")
                        ),
                    )
                };
                reject_interaction_request(
                    &window,
                    &acp,
                    &provider,
                    &agent_id,
                    raw.method.as_deref(),
                    raw.id,
                    raw.params.as_ref(),
                    reason_code,
                    rpc_code,
                    &message,
                )
                .await;
                continue;
            }
            if raw.kind != crate::acp::AcpKind::SessionUpdate {
                // A1（探查修复）：未知通知不再静默丢弃——记 method，接新 agent 时
                // 从 runtime log 直接看到它发了哪些私有通道（如 peri/*），按需接入。
                // 正常响应（Response，method=None）已在 reader 经 pending 结算，不产生噪音。
                if raw.kind == crate::acp::AcpKind::OtherNotification {
                    tracing::warn!(
                        "ACP 收到未知通知 method={:?}（当前不处理，已丢弃）",
                        raw.method
                    );
                }
                continue;
            }
            let payload = match raw.params {
                Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
                _ => {
                    tracing::warn!("ACP session/update missing object params");
                    continue;
                }
            };
            if !handle_session_update(
                &window,
                &gateway,
                &sessions,
                &binding_health,
                &pet,
                &runtime_for_reconnect.update_channels,
                &client_generation,
                generation,
                &runtime_for_reconnect.mapping_ready,
                &agent_id,
                event_service.as_ref(),
                message_service.as_ref(),
                classification,
                payload,
            )
            .await
            {
                break;
            }
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tracing_subscriber::layer::Layer as _;

    #[test]
    fn deleted_session_ingest_failure_is_not_logged_as_user_error() {
        // The tombstone gate remains authoritative; only the presentation of
        // its expected late-write rejection changes from error to debug.
        let logs = crate::runtime_log::RuntimeLogHub::new(16);
        let dispatch = tracing::Dispatch::new(
            crate::runtime_log::RuntimeLogLayer::with_hub(logs.clone()).with_subscriber(
                tracing_subscriber::fmt()
                    .with_max_level(tracing::Level::TRACE)
                    .finish(),
            ),
        );
        let _guard = tracing::dispatcher::set_default(&dispatch);

        log_canonical_ingest_error(
            &crate::session::EventError::SessionDeleted("owner tombstone".to_string()),
            "agent",
            "local:session",
        );
        log_canonical_ingest_error(
            &crate::session::EventError::Unavailable("database unavailable".to_string()),
            "agent",
            "local:session",
        );

        let entries = logs.list(&crate::runtime_log::RuntimeLogQuery::default());
        assert!(
            entries.iter().all(|entry| !entry
                .message
                .contains("late ACP update ignored for deleted session")),
            "deleted-session race must stay below the runtime-log visibility threshold"
        );
        assert!(
            entries.iter().any(|entry| {
                entry.level == "error"
                    && entry
                        .message
                        .contains("canonical ingest failed; event was not published")
            }),
            "non-tombstone ingest failures must remain visible at error level"
        );
    }

    /// 验收回归 D3：replay 的 user 消息 persona 前缀剥离（基于分隔符）。
    #[test]
    fn strip_persona_prefix_removes_separator_prefix() {
        let persona = "你是测试 Agent，用于验收 persona 前缀剥离。";
        let text = format!("{persona}\n\n---\n\n你好");
        assert_eq!(strip_persona_prefix(&text, persona), "你好");
    }

    #[test]
    fn strip_persona_prefix_works_for_session_prompt_too() {
        // session_prompt 场景：persona 不匹配 session_prompt，但分隔符剥离不依赖 persona
        let persona = "profile persona";
        let session_prompt = "自定义会话提示";
        let text = format!("{session_prompt}\n\n---\n\n你好");
        assert_eq!(strip_persona_prefix(&text, persona), "你好");
    }

    #[test]
    fn strip_persona_prefix_keeps_non_prefixed_text() {
        // 后续轮次消息无前缀（无分隔符）→ 原样返回
        assert_eq!(strip_persona_prefix("你好", "persona"), "你好");
        // persona 为空也剥离分隔符（分隔符才是依据）
        assert_eq!(strip_persona_prefix("p\n\n---\n\n你好", ""), "你好");
    }

    #[test]
    fn strip_persona_prefix_keeps_text_with_trailing_separator() {
        // 分隔符后为空 → 原样返回（防误剥成空串）
        assert_eq!(
            strip_persona_prefix("persona\n\n---\n\n", "persona"),
            "persona\n\n---\n\n"
        );
    }

    /// A3 验收：source 已注册通道 → update 帧走 Channel（信封格式），不落广播。
    /// 用 Arc<Mutex<Vec>> 捕获 send 闭包收到的帧序。
    #[tokio::test]
    async fn dispatcher_channel_receives_update_frames() {
        let runtime = crate::test_utils::connected_runtime();
        let sent: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = sent.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    sink.lock().unwrap().push(value);
                }
            }
            Ok(())
        });
        runtime.register_update_channel("local:s1", channel);
        assert!(runtime.update_channels.lock().unwrap().contains_key("local:s1"));

        // 注册表语义：take 后不再持有（终帧注销路径依赖）。
        assert!(runtime.take_update_channel("local:s1").is_some());
        assert!(!runtime.update_channels.lock().unwrap().contains_key("local:s1"));

        // clear 语义（C7/generation bump 清理）。
        runtime.register_update_channel("local:s1", tauri::ipc::Channel::new(|_| Ok(())));
        runtime.register_update_channel("local:s2", tauri::ipc::Channel::new(|_| Ok(())));
        runtime.clear_update_channels();
        assert!(runtime.update_channels.lock().unwrap().is_empty());
    }

    /// C11：带 `_meta.periReplay=true` 的事件不产生宠物感知事件——pet xp/bond/
    /// recent_events 快照不变（回放不刷宠物状态）。覆盖 usage/tool 全部门控 +
    /// config_option（model/mode 感知，S2 补全）。对照：同事件不带回放标志 →
    /// 仍产出宠物事件（证明事件本身具备刷宠物状态的能力，守卫生效而非静默失效）。
    #[test]
    fn replay_updates_do_not_pollute_pet_state() {
        let snapshot = |state: &crate::pet::PetState| -> serde_json::Value {
            serde_json::json!({
                "xp": state.xp,
                "bond": state.bond,
                "recent_events": state.recent_events,
            })
        };
        let cases: Vec<(&str, serde_json::Value, crate::acp::SessionUpdateVariant)> = vec![
            (
                "usage_update",
                serde_json::json!({
                    "sessionUpdate": "usage_update",
                    "used": 12345,
                    "size": 32000,
                    "_meta": {"inputTokens": 9000, "outputTokens": 3345},
                }),
                crate::acp::SessionUpdateVariant::UsageUpdate,
            ),
            (
                "tool_call",
                serde_json::json!({
                    "sessionUpdate": "tool_call",
                    "title": "write_file",
                    "rawInput": "{\"path\":\"a.rs\"}",
                }),
                crate::acp::SessionUpdateVariant::ToolCall,
            ),
            (
                "tool_call_update completed",
                serde_json::json!({"sessionUpdate": "tool_call_update", "status": "completed"}),
                crate::acp::SessionUpdateVariant::ToolCallUpdate,
            ),
            (
                "tool_call_update failed",
                serde_json::json!({"sessionUpdate": "tool_call_update", "status": "failed"}),
                crate::acp::SessionUpdateVariant::ToolCallUpdate,
            ),
            (
                "tool_call_update cancelled",
                serde_json::json!({"sessionUpdate": "tool_call_update", "status": "cancelled"}),
                crate::acp::SessionUpdateVariant::ToolCallUpdate,
            ),
            (
                "config_option model",
                serde_json::json!({
                    "sessionUpdate": "config_option",
                    "id": "model",
                    "currentValue": "deepseek-v4-flash",
                }),
                crate::acp::SessionUpdateVariant::ConfigOptionUpdate,
            ),
            (
                "config_option mode",
                serde_json::json!({
                    "sessionUpdate": "config_option",
                    "id": "mode",
                    "currentValue": "code",
                }),
                crate::acp::SessionUpdateVariant::ConfigOptionUpdate,
            ),
        ];
        for (label, mut update, variant) in cases {
            update["_meta"] = serde_json::json!({"periReplay": true});
            let mut session = crate::session::SessionInfo::new(
                "peri-c11".to_string(),
                String::new(),
                "cwd".to_string(),
                true,
                1,
            );
            let events = apply_update_event(&mut session, &update, Some(variant), true);
            assert!(
                events.is_empty(),
                "{label}: replay must not emit pet events, got {events:?}"
            );
            let mut pet = crate::pet::PetState::default();
            let before = snapshot(&pet);
            for event in events {
                event.apply(&mut pet);
            }
            assert_eq!(
                before,
                snapshot(&pet),
                "{label}: replay must not change pet xp/bond/recent_events"
            );

            update["_meta"] = serde_json::json!({"periReplay": false});
            let mut live_session = crate::session::SessionInfo::new(
                "peri-c11".to_string(),
                String::new(),
                "cwd".to_string(),
                true,
                1,
            );
            let live_events = apply_update_event(&mut live_session, &update, Some(variant), false);
            assert!(
                !live_events.is_empty(),
                "{label}: live event must still emit pet events"
            );
        }
    }

    #[test]
    fn asynchronous_commands_and_mode_updates_refresh_session_state() {
        let mut session = crate::session::SessionInfo::new(
            "peri-async".to_string(),
            String::new(),
            "cwd".to_string(),
            true,
            1,
        );
        let commands = serde_json::json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": [{"name": "compact", "description": "Compact context"}],
        });
        let events = apply_update_event(
            &mut session,
            &commands,
            Some(crate::acp::SessionUpdateVariant::AvailableCommandsUpdate),
            false,
        );
        assert!(
            events.is_empty(),
            "command advertisement is not a pet event"
        );
        assert_eq!(
            session.snapshots["commands"][0]["name"],
            serde_json::json!("compact")
        );

        let mode = serde_json::json!({
            "sessionUpdate": "current_mode_update",
            "currentModeId": "high",
        });
        let events = apply_update_event(
            &mut session,
            &mode,
            Some(crate::acp::SessionUpdateVariant::CurrentModeUpdate),
            false,
        );
        assert_eq!(session.mode.as_deref(), Some("high"));
        assert!(matches!(events.as_slice(), [PetEvent::ModeChanged(value)] if value == "high"));

        // Replay restores the same state but never emits pet side effects.
        let replay_commands = serde_json::json!({
            "sessionUpdate": "available_commands_update",
            "commands": [{"name": "reload"}],
        });
        let replay_events = apply_update_event(
            &mut session,
            &replay_commands,
            Some(crate::acp::SessionUpdateVariant::AvailableCommandsUpdate),
            true,
        );
        assert!(replay_events.is_empty());
        assert_eq!(
            session.snapshots["commands"][0]["name"],
            serde_json::json!("reload")
        );

        let replay_mode = serde_json::json!({
            "sessionUpdate": "current_mode_update",
            "modeId": "balanced",
        });
        let replay_mode_events = apply_update_event(
            &mut session,
            &replay_mode,
            Some(crate::acp::SessionUpdateVariant::CurrentModeUpdate),
            true,
        );
        assert!(replay_mode_events.is_empty());
        assert_eq!(session.mode.as_deref(), Some("balanced"));

        let mut restored = serde_json::json!({});
        let mut snapshot_only = session.clone();
        snapshot_only.mode = None;
        crate::session::restore_session_state(&snapshot_only, &mut restored);
        assert_eq!(
            restored["modes"]["currentModeId"],
            serde_json::json!("balanced")
        );
    }

    /// P1-3（R2-WI03）：provider 从活配置解析——reload 修改实例 provider 后立即生效。
    #[test]
    fn resolve_agent_provider_follows_live_config() {
        use std::collections::HashMap;
        let mut agents = HashMap::new();
        let mut peri = crate::test_utils::fake_acp_agent("peri", "print('x')");
        peri.provider = Some("peri".to_string());
        agents.insert("peri-copy".to_string(), peri);
        assert_eq!(
            resolve_agent_provider(&agents, "peri-copy").as_deref(),
            Some("peri"),
            "活配置解析 provider"
        );
        // reload 把该实例 provider 改为 hermes → 新请求即用新 provider
        let mut reloaded = crate::test_utils::fake_acp_agent("peri", "print('x')");
        reloaded.provider = Some("hermes".to_string());
        agents.insert("peri-copy".to_string(), reloaded);
        assert_eq!(
            resolve_agent_provider(&agents, "peri-copy").as_deref(),
            Some("hermes"),
            "reload 后 provider 变更必须生效"
        );
        assert_eq!(
            resolve_agent_provider(&agents, "missing"),
            None,
            "未知 agent 无 provider"
        );
    }
}
