//! 通知分发器：ACP 事件广播 → 前端/平台 + 崩溃处理 + 自动重连调度 + B9 权限挂起。
//! R1 拆分自 lib.rs（行为零变化）。

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::acp::AcpClient;
use crate::agent::runtime::{session_mapping_matches, source_for_peri_id_in_generation};
use crate::permission::{
    permission_response, pick_allow_option, pick_option, pick_reject_option, PendingPermission,
};
use crate::pet::PetState;
use crate::runtime::AgentRuntime;
use crate::session::{
    config_option_key_matches, extract_tool_file_name, value_as_string, SessionInfo,
};
// #317 批次二 ④：flush 正身迁 canonical_flush.rs。
#[cfg(test)]
use crate::session::DurableSessionOwner;
use crate::AppStateHandles;
use crate::{emit_event, emit_event_all};
use agent_client_protocol_schema::v1::ErrorCode as WireErrorCode;

mod routing;

// #317 批次二 ④：主泵六缝提取——决策归子模块、副作用适配归调用点（同 routing 惯例）。
mod canonical_flush;
// #331/U4：逐帧热路径基准（cfg(test)，--nocapture 读数）。
mod crash_reconnect;
mod fallback_route;
#[cfg(test)]
mod frame_path_bench;
mod host_tools_gate;
mod interaction_route;
mod permission_route;

use canonical_flush::{
    flush_pending_canonical, should_flush_batch, CanonicalFlushContext, PendingCanonicalPublish,
    PENDING_CANONICAL_FLUSH_INTERVAL,
};
use crash_reconnect::CrashReconnectHandler;
use fallback_route::route_unknown_notification;
use host_tools_gate::{route_fs_request, route_terminal_request};
use interaction_route::{route_elicitation_complete, route_private_interaction};
use permission_route::route_permission_request;

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
/// 生产路径已由 38dad290 全量改走 apply_update_event_routed（typed kernel seam）；
/// 本布尔包装仅剩 C11 宠物策略 characterization 测试消费，故 cfg(test)。
#[cfg(test)]
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
    // Keep the ACP reducer alongside the legacy SessionInfo fields during the
    // migration. It emits no UI events; canonical commit/publication remains
    // governed by the existing routing transaction below.
    // P2（#334）：零拷贝直喂——原实现按 `{"update": update}` 重包一份整树深拷贝
    // 喂 `apply`，逐帧成本随 payload 体量放大（frame_path_bench 读数一）。
    let deltas = session.acp_state.apply_session_update(update);
    // Typed reducer output is consumed here at the kernel boundary. Existing
    // canonical/session updates below remain the publication authority; this
    // adapter only mirrors reducer-owned scalar domains into the live session.
    for delta in deltas {
        match delta {
            crate::acp::AcpStateDelta::Usage {
                used,
                size,
                input,
                output,
            } => {
                session.tokens_total = used;
                session.context_size = size.unwrap_or(0);
                if let Some(input) = input {
                    session.tokens_in = input;
                }
                if let Some(output) = output {
                    session.tokens_out = output;
                }
            }
            // Mode/model remain handled by the existing event transaction below;
            // consuming them here would suppress its change detection.
            crate::acp::AcpStateDelta::Mode { .. }
            | crate::acp::AcpStateDelta::Model { .. }
            | crate::acp::AcpStateDelta::PermissionQueueDepth { .. }
            | crate::acp::AcpStateDelta::PermissionRequested { .. }
            | crate::acp::AcpStateDelta::Text { .. }
            | crate::acp::AcpStateDelta::Reasoning { .. }
            | crate::acp::AcpStateDelta::UserText { .. }
            | crate::acp::AcpStateDelta::ToolStarted { .. }
            | crate::acp::AcpStateDelta::ToolUpdated { .. }
            | crate::acp::AcpStateDelta::Plan { .. }
            | crate::acp::AcpStateDelta::Unknown { .. } => {}
        }
    }
    let mut pet_events: Vec<PetEvent> = Vec::new();
    match variant {
        Some(crate::acp::SessionUpdateVariant::UsageUpdate) => {
            if let Some(meta) = update.get("_meta") {
                if let Some(model) = meta.get("model").and_then(|v| v.as_str()) {
                    session.model = model.to_string();
                    // #97/D97-3（评审修正）：usage _meta.model 是权威 current 通道，
                    // 与单值 config_option_update 分支同契约——清除客户端 requested
                    // 未确认态，三态收敛不留漏口。
                    session.model_pending = None;
                }
            }
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
            // P56/D2.3 + #97/D97-3：payload 带 models 状态（camelCase/snake_case）时
            // 全量消费——current 提取 + 模型面/choices 完整刷新（不再只更新当前值），
            // 并清除客户端 requested 未确认态（Agent 推送的完整状态是权威）。
            // apply_models_state 内置 fingerprint 幂等（#97/D97-4）：完全相同的
            // models push 重复到达只提交一次，丢弃计数留在 session 诊断字段。
            if let Some(models) = update.get("models") {
                session.apply_models_state(models);
            }
        }
        Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate) => {
            if let Some(options) = update.get("configOptions").and_then(|v| v.as_array()) {
                // #97/D97-4：有界替换——超限 envelope 拒绝入库（已知 selector 状态
                // 保持不变 + 计数），未知 option kind 随原样数组保留。
                // N1（第二轮评审）：数组携带可提取 model currentValue（权威回显的
                // model 维度）时清除 requested 未确认态，pending 生命周期无漏口。
                session.apply_config_options_push(options);
            } else {
                // P56/D2.2：option_key 读取补官方 configId/config_id 键；与 "model"/
                // "mode" 比较前按 find_config_option 同款归一化规则精确匹配（不做
                // 子串包含猜测）。
                let option_key = update
                    .get("configId")
                    .or_else(|| update.get("config_id"))
                    .or_else(|| update.get("id"))
                    .or_else(|| update.get("key"))
                    .and_then(|v| v.as_str());
                let is_model_key =
                    option_key.is_some_and(|key| config_option_key_matches(key, "model"));
                let is_mode_key =
                    option_key.is_some_and(|key| config_option_key_matches(key, "mode"));
                // N4（第二轮评审）：model 值走 machine-id-only 提取（显示名不当 id，
                // 与 models-state 通道同一不变量）；mode 等其余语义保持宽容提取。
                let current = update
                    .get("currentValue")
                    .or_else(|| update.get("value"))
                    .and_then(|value| {
                        if is_model_key {
                            crate::session::value_as_machine_id(value)
                        } else {
                            value_as_string(value)
                        }
                    });
                if is_model_key {
                    if let Some(model) = current {
                        // M5 感知：模型切换。C11：回放不推送——回放时 session 为新对象，
                        // model 为空必误判 changed（对齐 usage/tool 全部门控）。
                        // #97/D97-3：Agent 推送的 current 是权威值——清除客户端
                        // requested 未确认态。
                        let changed = session.model != model;
                        session.model = model.clone();
                        session.model_pending = None;
                        if changed && apply_pet {
                            pet_events.push(PetEvent::ModelChanged(model));
                        }
                    }
                } else if is_mode_key {
                    if let Some(mode) = current {
                        let changed = session.mode.as_deref() != Some(mode.as_str());
                        session.mode = Some(mode.clone());
                        if changed && apply_pet {
                            // M5 感知：工作模式切换（C11：回放不推送）
                            pet_events.push(PetEvent::ModeChanged(mode));
                        }
                    }
                }
            }
        }
        Some(crate::acp::SessionUpdateVariant::AvailableCommandsUpdate) => {
            if let Some(commands) = update
                .get("availableCommands")
                .or_else(|| update.get("commands"))
            {
                session.commands_snapshot = Some(commands.clone());
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
// clippy 2026-09-22：10 参均为独立拒绝摘要入参（window/acp/provider/agent_id/method/
// request_id/params/reason_code/rpc_code/message），语义互不分组，结构体重构收益低。
#[allow(clippy::too_many_arguments)]
async fn reject_interaction_request<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    acp: &AcpLock,
    provider: &str,
    agent_id: &str,
    method: Option<&str>,
    request_id: Option<crate::acp::RequestId>,
    params: Option<&serde_json::Value>,
    reason_code: &str,
    rpc_code: WireErrorCode,
    message: &str,
) {
    let request_id_text = request_id.as_ref().map(ToString::to_string);
    let response_sent = if let Some(id) = request_id {
        let responder = {
            let acp = acp.lock().await;
            acp.responder()
        };
        responder.respond_error(id, rpc_code, message).await
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

/// #316：strict fs 沙箱根解析——按 periId+generation 查会话工作区
/// （`SessionInfo.cwd`），不信任 agent 自报参数。查无映射/代际不符/cwd 为空
/// → None（调用方以 -32602 拒绝）。
fn session_workspace_root(
    sessions: &SessionsLock,
    peri_session: &str,
    generation: u64,
) -> Option<std::path::PathBuf> {
    sessions.lock().ok().and_then(|items| {
        items
            .values()
            .find(|session| session.peri_id == peri_session && session.generation == generation)
            .map(|session| std::path::PathBuf::from(&session.cwd))
            .filter(|cwd| !cwd.as_os_str().is_empty())
    })
}

/// #316：在私有交互快照中按 elicitationId 匹配挂起的 URL elicitation
/// （method 必须是 elicitation/create 且 params.elicitationId 相等）。纯函数
/// 便于测试（官方契约：未知/已完成 id 忽略）。
fn match_pending_elicitation(
    snapshot: &[(
        crate::acp::RequestId,
        crate::private_interaction::PendingPrivateInteraction,
    )],
    elicitation_id: &str,
) -> Option<(
    crate::acp::RequestId,
    crate::private_interaction::PendingPrivateInteraction,
)> {
    snapshot
        .iter()
        .find(|(_, pending)| {
            pending.method == "elicitation/create"
                && pending.params.get("elicitationId").and_then(|v| v.as_str())
                    == Some(elicitation_id)
        })
        .map(|(id, pending)| (id.clone(), pending.clone()))
}

async fn handle_terminal_request(
    acp: &AcpLock,
    registry: &crate::acp::terminal_runtime::TerminalRegistry,
    method: &str,
    request_id: crate::acp::RequestId,
    params: Option<&serde_json::Value>,
) {
    let object = params.and_then(serde_json::Value::as_object);
    let session_id = object
        .and_then(|p| p.get("sessionId").or_else(|| p.get("session_id")))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let result = match method {
        "terminal/create" => {
            let command = match object
                .and_then(|p| p.get("command"))
                .and_then(serde_json::Value::as_str)
            {
                Some(command) => command,
                None => {
                    return {
                        let responder = { acp.lock().await.responder() };
                        let _ = responder
                            .respond_error(
                                request_id,
                                WireErrorCode::InvalidParams,
                                "terminal/create requires command",
                            )
                            .await;
                    }
                }
            };
            let args = object
                .and_then(|p| p.get("args"))
                .and_then(serde_json::Value::as_array)
                .map(|args| {
                    args.iter()
                        .filter_map(serde_json::Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let line = shell_words::join(std::iter::once(command.to_owned()).chain(args));
            let cwd = object
                .and_then(|p| p.get("cwd"))
                .and_then(serde_json::Value::as_str)
                .map(std::path::Path::new);
            let limit = object
                .and_then(|p| p.get("outputByteLimit"))
                .and_then(serde_json::Value::as_u64)
                .and_then(|value| usize::try_from(value).ok());
            registry
                .create_shell(session_id.to_owned(), None, &line, cwd, limit)
                .await
                .and_then(|terminal_id| {
                    // #316：响应由官方 Response 类型构造（wire 与手写 json!
                    // 逐字节一致）。序列化失败显式入 Err 走 -32602 应答路径，
                    // 不静默回 null（#316 审查 P2-1）。
                    serde_json::to_value(
                        agent_client_protocol_schema::v1::CreateTerminalResponse::new(terminal_id),
                    )
                    .map_err(|error| format!("serialize terminal/create response: {error}"))
                })
        }
        "terminal/output" => registry
            .snapshot(
                object
                    .and_then(|p| p.get("terminalId"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
                session_id,
            )
            .await
            .and_then(|snapshot| {
                serde_json::to_value(
                    agent_client_protocol_schema::v1::TerminalOutputResponse::new(
                        snapshot.output,
                        snapshot.truncated,
                    ),
                )
                .map_err(|error| format!("serialize terminal/output response: {error}"))
            }),
        "terminal/wait_for_exit" | "terminal/waitForExit" => registry
            .wait_for_exit(
                object
                    .and_then(|p| p.get("terminalId"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
                session_id,
            )
            .await
            .map(|status| serde_json::json!({"exitStatus": status})),
        "terminal/kill" => registry
            .kill(
                object
                    .and_then(|p| p.get("terminalId"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
                session_id,
            )
            .await
            .and_then(|_| {
                serde_json::to_value(agent_client_protocol_schema::v1::KillTerminalResponse::new())
                    .map_err(|error| format!("serialize terminal/kill response: {error}"))
            }),
        "terminal/release" => registry
            .release(
                object
                    .and_then(|p| p.get("terminalId"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(""),
                session_id,
            )
            .await
            .and_then(|_| {
                serde_json::to_value(
                    agent_client_protocol_schema::v1::ReleaseTerminalResponse::new(),
                )
                .map_err(|error| format!("serialize terminal/release response: {error}"))
            }),
        _ => Err("unsupported terminal method".to_string()),
    };
    match result {
        Ok(value) => {
            let responder = { acp.lock().await.responder() };
            let _ = responder.respond(request_id, value).await;
        }
        Err(error) => {
            let responder = { acp.lock().await.responder() };
            let _ = responder
                .respond_error(request_id, WireErrorCode::InvalidParams, &error)
                .await;
        }
    }
}

async fn handle_filesystem_request(
    acp: &AcpLock,
    method: &str,
    request_id: crate::acp::RequestId,
    params: Option<&serde_json::Value>,
    runtime: crate::acp::file_system_runtime::FileSystemRuntime,
) {
    let object = params.and_then(serde_json::Value::as_object);
    let result: Result<serde_json::Value, String> = match method {
        "fs/read_text_file" => {
            match object
                .and_then(|p| p.get("path"))
                .and_then(serde_json::Value::as_str)
            {
                Some(path) => runtime
                    .read_text_file(std::path::Path::new(path))
                    .await
                    .and_then(|content| {
                        serde_json::to_value(
                            agent_client_protocol_schema::v1::ReadTextFileResponse::new(content),
                        )
                        .map_err(|error| format!("serialize fs/read_text_file response: {error}"))
                    }),
                None => Err("fs/read_text_file requires path".to_string()),
            }
        }
        "fs/write_text_file" => {
            match (
                object
                    .and_then(|p| p.get("path"))
                    .and_then(serde_json::Value::as_str),
                object
                    .and_then(|p| p.get("content"))
                    .and_then(serde_json::Value::as_str),
            ) {
                (Some(path), Some(content)) => runtime
                    .write_text_file(std::path::Path::new(path), content)
                    .await
                    .and_then(|_| {
                        serde_json::to_value(
                            agent_client_protocol_schema::v1::WriteTextFileResponse::new(),
                        )
                        .map_err(|error| format!("serialize fs/write_text_file response: {error}"))
                    }),
                (None, _) => Err("fs/write_text_file requires path".to_string()),
                (_, None) => Err("fs/write_text_file requires content".to_string()),
            }
        }
        _ => Err("unsupported filesystem method".to_string()),
    };
    let responder = { acp.lock().await.responder() };
    match result {
        Ok(value) => {
            let _ = responder.respond(request_id, value).await;
        }
        Err(error) => {
            let _ = responder
                .respond_error(request_id, WireErrorCode::InvalidParams, &error)
                .await;
        }
    }
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
/// 参数多为各锁/上下文的按引用透传（与同文件 L316/L751 同类），故保留显式形参。
#[allow(clippy::too_many_arguments)]
async fn handle_permission_request<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    acp: &AcpLock,
    client_generation: &AtomicU64,
    approval_mode: &std::sync::Mutex<String>,
    pending_permissions: &PermissionLock,
    sessions: &SessionsLock,
    hook_bridge: &Arc<crate::hook_bridge::HookBridge>,
    runtimes: &crate::runtime::AgentRuntimeManager,
    provider: &str,
    agent_id: &str,
    method: Option<&str>,
    request_id: crate::acp::RequestId,
    params: Option<&serde_json::Value>,
) {
    // #98: method-driven dispatch - adapter lookup by ACP method, provider name
    // no longer a gate; unknown methods get a stable method_unsupported with the
    // raw params kept observable via the rejection event.
    let Some(adapter) =
        crate::protocol_adapter::get_protocol_adapter_for_method(method.unwrap_or(""))
    else {
        reject_interaction_request(
            window,
            acp,
            provider,
            agent_id,
            method,
            Some(request_id),
            params,
            "method_unsupported",
            WireErrorCode::MethodNotFound,
            &format!(
                "interaction method unsupported: {}",
                method.unwrap_or("<missing>")
            ),
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
            WireErrorCode::MethodNotFound,
            &format!(
                "interaction method unsupported: {}",
                method.unwrap_or("<missing>")
            ),
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
            WireErrorCode::InvalidParams,
            // Keep the stable diagnostic phrase used by the OBS-03 evidence
            // surface while retaining the machine-readable invalid_params
            // reason code and JSON-RPC -32602 response above.
            "ACP request_permission 解析失败: invalid params",
        )
        .await;
        return;
    };
    // Reducer ownership is resolved by the protocol session id, never by the
    // request id alone (request ids may be reused across sessions).
    let remember_permission = |sessions: &SessionsLock| {
        let _ = sessions.lock().map(|mut sessions| {
            if let Some(session) = sessions.get_mut(&permission.session_id) {
                // R-t5 续命：**等用户答复不算沉默**。本回合此前只有 `session/update` 刷新
                // `last_activity`，于是 agent 发出权限请求后静默等待用户点击的那段时间被当成
                // "无输出"，闲置窗口到点即判死——真机实测一次 `elapsed 472535ms` 的截断正卡在
                // 等权限答复上，并留下一个无法关闭的悬空模态（#209）。用户答复后 agent 恢复产出
                // 会自然续命，故只在**收到请求**这一刻打点。
                session.last_activity = Some(std::time::Instant::now());
                let deltas = session.acp_state.apply(&crate::acp::RawMessage {
                    id: Some(request_id.clone()),
                    method: Some("session/request_permission".into()),
                    kind: crate::acp::AcpKind::PermissionRequest,
                    result: None,
                    params: params.cloned(),
                    error: None,
                });
                if let Some(depth) = deltas.iter().find_map(|delta| match delta {
                    crate::acp::AcpStateDelta::PermissionQueueDepth { depth } => Some(*depth),
                    _ => None,
                }) {
                    tracing::trace!(
                        session_id = %permission.session_id,
                        request_id = %request_id,
                        depth,
                        "ACP permission reducer queue updated"
                    );
                }
            }
        });
    };
    let mode = approval_mode
        .lock()
        .map(|m| m.clone())
        .unwrap_or_else(|_| "default".to_string());
    // API 1.3（#37）：钩子缝——先把 ACP 远端 sessionId 规范化为本地 source，
    // 再依次派发 tool.beforeCall（gate）与 permission.request（allow/deny/modify）。
    // 不可映射 = 可诊断跳过（fail-open 至常规审批流）；桥故障/超时/未注册不阻断。
    // modify 仅接受原选项的过滤/重排（interpret 侧校验），后续 bypass/auto 与
    // 前端事件均使用过滤后的选项集。
    let local_source =
        crate::hook_bridge::resolve_local_source(runtimes, Some(agent_id), &permission.session_id);
    let mut effective_permission = permission.clone();
    if let Some(local_source) = local_source {
        let tool_payload = serde_json::json!({
            "source": local_source,
            "toolCallId": permission.tool_call_id,
            "title": permission.title,
            "prompt": permission.prompt,
            "options": permission.options,
        });
        if let crate::hook_bridge::HookDispatchOutcome::Answered(response) = hook_bridge
            .dispatch(
                Some(window),
                crate::hook_bridge::HOOK_TOOL_BEFORE_CALL,
                &local_source,
                tool_payload,
            )
            .await
        {
            if response.get("action").and_then(serde_json::Value::as_str) == Some("cancel") {
                let reason = response
                    .get("reason")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("denied by tool.beforeCall hook");
                tracing::info!(
                    source = %local_source,
                    tool_call_id = %permission.tool_call_id,
                    reason = %reason,
                    "tool.beforeCall hook denied tool call"
                );
                // 钩子驱动的拒绝用严格 reject 选择（无 first() 回退）：请求不含
                // reject 语义项时不伪造 optionId（ACP-04 §5.6），落回常规流程。
                if let Some(option_id) = pick_reject_option(&permission.options) {
                    if client_generation.load(Ordering::Acquire) != permission.client_generation {
                        // C4：钩子派发窗口（最长 ~3s）内客户端已换代——旧决策不得
                        // 写到新进程同 id 请求，丢弃应答交由 agent 侧超时收敛。
                        tracing::warn!(
                            request_id = %request_id,
                            "hook deny decision dropped: client generation advanced during hook dispatch"
                        );
                        return;
                    }
                    let responder = {
                        let acp = acp.lock().await;
                        acp.responder()
                    };
                    responder
                        .respond(request_id, permission_response(option_id))
                        .await;
                    return;
                }
                tracing::warn!("tool.beforeCall 拒绝但请求无 reject 选项，跳过应答交回常规流程");
            }
        }
        let permission_payload = serde_json::json!({
            "source": local_source,
            "provider": provider,
            "agentId": agent_id,
            "requestId": request_id.to_string(),
            "toolCallId": permission.tool_call_id,
            "title": permission.title,
            "prompt": permission.prompt,
            "options": permission.options,
        });
        if let crate::hook_bridge::HookDispatchOutcome::Answered(response) = hook_bridge
            .dispatch(
                Some(window),
                crate::hook_bridge::HOOK_PERMISSION_REQUEST,
                &local_source,
                permission_payload,
            )
            .await
        {
            match crate::hook_bridge::interpret_permission_hook_response(
                &response,
                &permission.options,
            ) {
                crate::hook_bridge::PermissionHookDecision::Allow => {
                    // 钩子驱动的批准用严格 allow 选择 + C4 代际复核（同 deny 路径）。
                    if let Some(option_id) = pick_allow_option(&permission.options) {
                        if client_generation.load(Ordering::Acquire) != permission.client_generation
                        {
                            tracing::warn!(
                                request_id = %request_id,
                                "hook allow decision dropped: client generation advanced during hook dispatch"
                            );
                            return;
                        }
                        let responder = {
                            let acp = acp.lock().await;
                            acp.responder()
                        };
                        responder
                            .respond(request_id, permission_response(option_id))
                            .await;
                        return;
                    }
                    tracing::warn!(
                        "permission.request 钩子允许但请求无 allow 语义项，跳过应答交回常规流程"
                    );
                }
                crate::hook_bridge::PermissionHookDecision::Deny => {
                    if let Some(option_id) = pick_reject_option(&permission.options) {
                        if client_generation.load(Ordering::Acquire) != permission.client_generation
                        {
                            tracing::warn!(
                                request_id = %request_id,
                                "hook deny decision dropped: client generation advanced during hook dispatch"
                            );
                            return;
                        }
                        let responder = {
                            let acp = acp.lock().await;
                            acp.responder()
                        };
                        responder
                            .respond(request_id, permission_response(option_id))
                            .await;
                        return;
                    }
                    tracing::warn!(
                        "permission.request 钩子拒绝但请求无 reject 语义项，跳过应答交回常规流程"
                    );
                }
                crate::hook_bridge::PermissionHookDecision::Modify(options) => {
                    tracing::info!(
                        source = %local_source,
                        option_count = options.len(),
                        "permission.request hook modified permission options"
                    );
                    effective_permission.options = options;
                }
                crate::hook_bridge::PermissionHookDecision::Pass => {}
            }
        }
    } else {
        tracing::warn!(
            session_id = %permission.session_id,
            agent_id = %agent_id,
            request_id = %request_id,
            "Pylon hook bridge: permission request sessionId not mappable to a local session; hooks skipped"
        );
    }
    if matches!(mode.as_str(), "bypass" | "auto") {
        tracing::info!(
            "权限模式 {mode}：自动批准工具调用 {}",
            permission.tool_call_id
        );
        // C5：自动批准按请求选项选 allow 语义项（无匹配取首个）。ACP-04（§5.6）：
        // 解析层保证 options 非空（空集不可能进此分支），pick_option 恒返回 Some；
        // 防御分支不得伪造 optionId——如异常出现则跳过应答并告警（agent 侧自会
        // 超时收敛），绝不硬编码不存在的选项。
        let Some(option_id) = pick_option(&effective_permission.options, false) else {
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
                WireErrorCode::InvalidParams,
                "invalid params: permission request options 为空",
            )
            .await;
            return;
        };
        // O9/G3 §2.2.2：无 pending 直接应答——锁外发送（同解析失败分支）。
        let responder = {
            let acp = acp.lock().await;
            acp.responder()
        };
        responder
            .respond(request_id, permission_response(option_id))
            .await;
    } else {
        remember_permission(sessions);
        let _ = pending_permissions.lock().map(|mut pending| {
            pending.insert(request_id.clone(), effective_permission.clone());
        });
        // #98：统一交互队列登记（FIFO / 单一 Active / queued depth）。队列是
        // cancel/timeout/disconnect drain 终态与冷挂载快照的数据源；permission
        // 即 kind="approval"，队列里的事件载荷与 pylon:interaction 完全同构。
        let payload = serde_json::json!({
            "title": effective_permission.title,
            "prompt": effective_permission.prompt,
            "options": effective_permission.options,
            "requestedAt": effective_permission.requested_at,
            // ACP-03（§5.6）：deadline 由后端单一来源（PERMISSION_REQUEST_TIMEOUT_SECS），
            // 前端只做倒计时展示，不自行持有 300s 常量。
            "deadlineMs": crate::permission::permission_deadline_ms(permission.requested_at),
        });
        // #98: unified interaction queue admission (FIFO / single Active /
        // queued depth). The queue feeds cancel/timeout/disconnect drain
        // terminal states and the cold-mount snapshot; kind = "approval" and
        // the stored event payload is identical to pylon:interaction.
        let interaction_event = serde_json::json!({
            "provider": provider,
            "agentId": agent_id,
            "sessionId": permission.session_id,
            "eventType": "permission.request",
            "requestId": request_id.to_string(),
            "toolCallId": permission.tool_call_id,
            "clientGeneration": permission.client_generation,
            "payload": payload,
        });
        if let Some(runtime) = runtimes.get(agent_id) {
            match runtime
                .interactions
                .admit(crate::acp::interaction_queue::InteractionQueueEntry {
                    request_id: request_id.to_string(),
                    method: crate::acp::METHOD_SESSION_REQUEST_PERMISSION.to_string(),
                    kind: "approval".to_string(),
                    session_id: permission.session_id.clone(),
                    agent_id: agent_id.to_string(),
                    client_generation: permission.client_generation,
                    enqueued_at: permission.requested_at,
                    event: interaction_event.clone(),
                    state: crate::acp::interaction_queue::InteractionEntryState::Waiting,
                }) {
                Ok(admission) => {
                    let (_, waiting) = runtime.interactions.depth().unwrap_or((None, 0));
                    tracing::trace!(
                        agent_id = %agent_id,
                        request_id = %request_id,
                        promoted = matches!(admission, crate::acp::interaction_queue::AdmissionOutcome::Promoted),
                        waiting,
                        "interaction queue admitted permission request"
                    );
                }
                Err(error) => tracing::warn!("interaction queue admit failed: {error}"),
            }
        }
        emit_event(window, crate::event_names::INTERACTION, interaction_event);
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
// clippy 2026-09-22：参数为各锁/上下文的按引用透传（window/gateway/sessions/
// binding_health/pet/update_channels/generation），与 flush_pending_canonical 同一
// 调用点形态，结构体重构收益低。
#[allow(clippy::too_many_arguments)]
async fn handle_session_update<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    gateway: &crate::gateway::GatewayCore,
    sessions: &SessionsLock,
    binding_health: &std::sync::Mutex<
        std::collections::HashMap<String, crate::agent::runtime::SessionBindingHealth>,
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
    wire_ordinal: Option<u64>,
    turn_ledger: &Arc<crate::acp::TurnLedger>,
    probe_sessions: &crate::runtime::ProbeSessionRegistry,
    ingress_seq: u64,
    wire: Option<Arc<crate::acp::AcpWireCapture>>,
    pending_batch: Option<&mut Vec<PendingCanonicalPublish>>,
    payload: serde_json::Value,
) -> bool {
    // P2（#334）：payload 以 Arc 共享——routing::decide 在锁内需要完整 input，
    // 而 `update` 借用贯穿锁内 reducer 调用，深拷贝无法换成 move；改为引用计数
    // 共享后逐帧不再有 payload 级深拷贝（发布侧在 ingest 完成后取回唯一引用，
    // 消费顺序已核实：ingest 先于 publish）。
    let payload = Arc::new(payload);
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
                        crate::agent::runtime::SessionBindingHealth::Probing { .. }
                            | crate::agent::runtime::SessionBindingHealth::Detached { .. }
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
            // #250：探测会话（#53 空态选择器探测）不落会话槽位，其建会话后的
            // 元数据通知按设计查无映射——按预期孤儿静默降级，不作异常告警。
            if probe_sessions.contains(&peri_id) {
                tracing::debug!("ACP notification for probe session {} dropped", peri_id);
                return true;
            }
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
    // R4→#316：sessionUpdate 变体经官方 schema typed-first 分类
    // （classify_session_update；解析失败落 from_str 宽容别名，未知 → None，
    // 与旧 `_ => {}` 忽略一致）。
    let variant = crate::acp::classify_session_update(update);
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
        // 单次查表替代「is_some_and 校验后再 expect 取值」：None 与映射不匹配
        // 一样按过期通知拒绝（原 expect("current mapping checked")，锁内无
        // TOCTOU，语义不变）。
        let Some(session) = items.get(&source) else {
            tracing::warn!("ACP notification rejected for stale session {}", peri_id);
            return true;
        };
        if !session_mapping_matches(&session.peri_id, session.generation, &peri_id, generation) {
            tracing::warn!("ACP notification rejected for stale session {}", peri_id);
            return true;
        }
        durable_owner = match session.durable_owner(agent_id, &source) {
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
        let replay_loading = session.replay_loading;
        let input = routing::RoutingInput {
            source: source.clone(),
            remote_session_id: peri_id.clone(),
            generation,
            owner: durable_owner.clone(),
            classification,
            variant,
            replay_loading,
            // P2（#334）：Arc 引用计数共享，原整份 payload 深拷贝已拆除；
            // 原件继续由本函数持有，发布侧消费。
            payload: Arc::clone(&payload),
            wire_ordinal,
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
            // #99：live 活动 → turn 账本推进（Streaming 阶段 + ingress cursor +
            // 文本标志）；回合未登记或已终态时为迟到活动，仅计诊断，不产生终态。
            let _ = turn_ledger.note_session_activity(
                &source,
                &peri_id,
                generation,
                ingress_seq,
                crate::acp::ActivityFlags {
                    saw_text: effects.text.is_some(),
                    saw_tool: false,
                    saw_thinking: false,
                },
            );
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
            // #99（评审 E3）：live 工具活动同样喂给账本——saw_tool 是
            // empty-turn 判定（tool-only vs agent-empty）的输入；文本 chunk
            // 与工具调用都会在 dispatcher 处理瞬间写入账本，settle 侧以此
            // 为判定源（残余窗口见 refine_empty_turn 注释）。
            if !is_replay
                && matches!(
                    variant,
                    Some(
                        crate::acp::SessionUpdateVariant::ToolCall
                            | crate::acp::SessionUpdateVariant::ToolCallUpdate
                    )
                )
            {
                let _ = turn_ledger.note_session_activity(
                    &source,
                    &peri_id,
                    generation,
                    ingress_seq,
                    crate::acp::ActivityFlags {
                        saw_text: false,
                        saw_tool: true,
                        saw_thinking: false,
                    },
                );
            }
            // #316：live 思考流喂账本 saw_thinking——thinking-only 回合
            // （长推理无正文无工具）empty-turn 判定算有产出，不再误报
            // agent-empty。思考文本本身不进 collect（与旧行为一致）。
            if !is_replay && variant == Some(crate::acp::SessionUpdateVariant::AgentThoughtChunk) {
                let _ = turn_ledger.note_session_activity(
                    &source,
                    &peri_id,
                    generation,
                    ingress_seq,
                    crate::acp::ActivityFlags {
                        saw_text: false,
                        saw_tool: false,
                        saw_thinking: true,
                    },
                );
            }
            pet_events.extend(apply_update_event_routed(
                session, update, variant, decision,
            ));
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
                    let mut snapshot = serde_json::Map::new();
                    if let Some(commands) = &session.commands_snapshot {
                        snapshot.insert("commands".into(), commands.clone());
                    }
                    if let Some(usage) = &session.usage_snapshot {
                        snapshot.insert("usage".into(), usage.clone());
                    }
                    if let Some(mode) = &session.mode {
                        snapshot.insert("mode".into(), serde_json::Value::String(mode.clone()));
                    }
                    let snapshot = serde_json::Value::Object(snapshot);
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
    if decision.persist_canonical {
        if let Some(batch) = pending_batch {
            batch.push(PendingCanonicalPublish {
                input,
                decision,
                pet_events,
                session_state_to_persist,
                wire,
            });
            return true;
        }
    }
    let committed_event = match routing::commit_live_event(&input, decision, event_service).await {
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
        routing::CommitOutcome::Committed { event, revision } => {
            if let (Some(ordinal), Some(wire)) = (input.wire_ordinal, wire.as_ref()) {
                wire.record_canonical_commit(
                    ordinal,
                    crate::acp::CanonicalCorrelation {
                        event_id: event.event_id.clone(),
                        sequence: event.sequence,
                        revision,
                    },
                );
            }
            Some(event)
        }
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
    // P2（#334）：发布取回唯一引用。ingest 已完成（commit await 返回）且
    // `input` 不再被读取，drop 后 Arc 引用计数回到 1，`try_unwrap` 零拷贝
    // 取回原件注入 source/canonicalEvent；计数非 1 理论不可达，克隆兜底。
    drop(input);
    let mut payload = match Arc::try_unwrap(payload) {
        Ok(value) => value,
        Err(arc) => (*arc).clone(),
    };
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

/// 单帧泵取的失败/跳过策略（#336/U2b：select! 封装为具名函数后，循环骨架凭此
/// 分流）。Frame = 产出本帧进入路由分支；Skipped = 本迭代副作用已完成（崩溃
/// watch 触发处理 / 窗口 flush 完成），跳过路由直接下一轮；Stop = 主循环退出
/// （inbox 关闭 / 窗口 flush 失败）。
// Frame 变体按值携带整帧 ClassifiedMessage（含 raw payload，与其他变体的
// 尺寸差超过 lint 的 200 字节阈值）——Box 化需每帧一次堆分配，与 #334 逐帧
// 热路径降分配目标相悖；本枚举是泵取流程控制面，值语义保留属有意取舍，
// 故定点豁免本 lint。
#[allow(
    clippy::large_enum_variant,
    reason = "Frame 按值携带整帧以避免每帧堆分配；Box 化与 #334 降分配方向相悖"
)]
enum PumpStep {
    Frame(crate::acp::ClassifiedMessage),
    Skipped,
    Stop,
}

/// 启动（或重启）通知分发器：消费 ACP 单消费者无损通知 inbox，把事件路由到
/// 前端（WebView 事件）与平台（gateway deliver_all），并处理崩溃/权限/宠物感知。
///
/// #336/U2b：本函数降为「复位旧任务 + 装配 + spawn」编排入口；句柄克隆/
/// agent_id 解析/崩溃处理器装配收敛进 [`NotificationPump::new`]，主循环骨架在
/// [`NotificationPump::run`]，泵取与路由分支各为具名方法（失败/跳过策略见
/// [`PumpStep`] 与 `route_frame` 返回值文档）。语句次序、锁获取点、generation
/// 校验点与拆分前逐一对照保持。
pub(crate) fn start_notification_dispatcher<R: tauri::Runtime>(
    handles: &AppStateHandles,
    runtime: &Arc<AgentRuntime>,
    window: tauri::Window<R>,
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
    // 装配在 spawn 前同步完成（new 仅克隆字段，原克隆段同样在任务复位后、
    // 首次 poll 前执行，无可观察时序差异）；pump 所有权移入任务。
    let pump = NotificationPump::new(handles, runtime, window);
    *task = Some(tokio::spawn(async move {
        pump.run().await;
    }));
}

/// 通知泵主循环的共享环境束（#336/U2b：原 spawn 闭包捕获的局部变量逐一收敛为
/// 字段，分支具名方法经 `self` 访问，消除逐参手抄传递）。字段与原克隆段一一
/// 对应。`handle_crash`/reconnect_epoch 原在任务内构造——纯字段装配无副作用、
/// 无 await，提前到 `new()`（spawn 前）不改变任何可观察时序（首个 await 仍是
/// `run()` 内的 inbox 获取）。
struct NotificationPump<R: tauri::Runtime> {
    acp: Arc<tokio::sync::Mutex<AcpClient>>,
    sessions: Arc<std::sync::Mutex<std::collections::HashMap<String, SessionInfo>>>,
    binding_health: Arc<
        std::sync::Mutex<
            std::collections::HashMap<String, crate::agent::runtime::SessionBindingHealth>,
        >,
    >,
    pet: Arc<std::sync::Mutex<PetState>>,
    /// 本 dispatcher 代际（构造时刻快照；每轮循环与 client_generation 复核）。
    generation: u64,
    client_generation: Arc<std::sync::atomic::AtomicU64>,
    agent_id: String,
    agents: Arc<std::sync::Mutex<std::collections::HashMap<String, crate::agent_config::AgentDef>>>,
    runtimes: Arc<crate::runtime::AgentRuntimeManager>,
    gateway: Arc<crate::gateway::GatewayCore>,
    approval_mode: Arc<std::sync::Mutex<String>>,
    event_service: Option<Arc<crate::session::EventService>>,
    message_service: Option<Arc<crate::session::MessageService>>,
    hook_bridge: Arc<crate::hook_bridge::HookBridge>,
    pending_permissions:
        Arc<std::sync::Mutex<std::collections::HashMap<crate::acp::RequestId, PendingPermission>>>,
    terminal_registry: Arc<crate::acp::terminal_runtime::TerminalRegistry>,
    host_tools_policy: Arc<std::sync::Mutex<crate::acp::host_tools::HostToolsPolicy>>,
    private_interactions: crate::private_interaction::PrivateInteractionOwner,
    /// 本泵所属 runtime（重连/update_channels/mapping_ready/账本等 per-agent 状态入口）。
    runtime: Arc<AgentRuntime>,
    window: tauri::Window<R>,
    handle_crash: CrashReconnectHandler<R>,
    /// 任务启动时从 acp 一次性捕获（需 async 锁，`run()` 开头赋值；时序与
    /// 原任务内获取一致——inbox/crashed_receiver 之后、进循环之前）。
    wire_trace: Option<Arc<crate::acp::AcpWireCapture>>,
    /// 在途 canonical 批次（窗口未 flush 的 durable+publish 待办）。
    pending_batch: Vec<PendingCanonicalPublish>,
}

impl<R: tauri::Runtime> NotificationPump<R> {
    /// 原主循环前置克隆段（O8 复位之后的句柄准备）原样收敛：字段逐一对应原
    /// 局部变量；agent_id 解析、CrashReconnectHandler 装配原样保留。
    fn new(
        handles: &AppStateHandles,
        runtime: &Arc<AgentRuntime>,
        window: tauri::Window<R>,
    ) -> Self {
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
        let hook_bridge = handles.hook_bridge.clone();
        let pending_permissions = runtime.pending_permissions.clone();
        let terminal_registry = runtime.terminal_registry.clone();
        let host_tools_policy = runtime.host_tools_policy.clone();
        let private_interactions = runtime.private_interactions.clone();
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
        // R7：自动重连状态组（reconnect_epoch / remaining_attempts / pending_reconnect）。
        // - reconnect_epoch：本 dispatcher 实例（=本 runtime 代际）的崩溃通知计数，
        //   每次 handle 通知 +1（含被防重入标志吸收的重复/新一轮通知——被吸收
        //   的通知以 epoch 变化表达"重连意图待消费"，不再被静默吞掉）。
        // - remaining_attempts：重连循环内的局部尝试计数（预算），epoch 变化时重置。
        // - pending_reconnect 概念：epoch 变化即"新一轮崩溃在重连循环期间到来"——
        //   重连循环每轮复查 epoch 未变；变了则旧循环放弃（消费旧 ticket），以最新
        //   epoch 重新武装（退避从 attempt 1 重新开始）。A5 的"成功分支复查"窄窗口
        //   由此结构性覆盖（不再依赖单一复查点）。
        let reconnect_epoch = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        // A7：崩溃处理提取为 CrashReconnectHandler（#317 批次二 ④，原内联闭包），
        // broadcast 分支与 watch 分支共用。幂等设计：auto_reconnect_active 防重入，
        // 双通道都送达时最多多发一次同 payload 状态事件。
        // ISSUE-17 W1（LR2-WI06）：handle 接收 crash reason（稳定 code，transport.rs
        // CrashReason::as_str）——不再硬编码 stdout closed；用户可读文案保留原始 code
        // （不覆盖诊断字段）。
        let handle_crash = CrashReconnectHandler::new(
            AppStateHandles {
                runtimes: runtimes.clone(),
                agents: agents.clone(),
                active_agent,
                pet: pet.clone(),
                runtime_logs,
                gateway: gateway.clone(),
                approval_mode: approval_mode.clone(),
                event_service: event_service_slot,
                message_service: message_service_slot,
                hook_bridge: hook_bridge.clone(),
            },
            agent_runtime,
            window.clone(),
            runtime_for_reconnect,
            reconnect_epoch,
        );
        Self {
            acp,
            sessions,
            binding_health,
            pet,
            generation,
            client_generation,
            agent_id,
            agents,
            runtimes,
            gateway,
            approval_mode,
            event_service,
            message_service,
            hook_bridge,
            pending_permissions,
            terminal_registry,
            host_tools_policy,
            private_interactions,
            runtime: runtime.clone(),
            window,
            handle_crash,
            wire_trace: None,
            pending_batch: Vec::new(),
        }
    }

    /// 主循环骨架（#336/U2b）：代际复核 → 泵取一帧 → 代际复核 → 路由分支；
    /// 循环后为退出统一收口（兜底 flush + 账本代际清理）。
    async fn run(mut self) {
        let notification_inbox = self.acp.lock().await.notification_inbox();
        // A7：崩溃信号独立 watch 通道——broadcast 洪泛 Lagged 时 NOTIF_AGENT_CRASHED
        // 会丢，自动重连依赖本通道（主循环 select! 双路监听，见下）。
        let mut crashed_rx = self.acp.lock().await.crashed_receiver();
        // 订阅即查现值：崩溃发生在订阅之前（connect 成功后立刻 EOF、dispatcher
        // 尚未启动）时 changed() 不会触发，只能靠 watch 保留的最新值兜底。
        if *crashed_rx.borrow_and_update() {
            // watch 通道只携带 bool 不携带 reason → 缺省 stdout_closed（订阅前 EOF 场景）
            self.handle_crash
                .handle(crate::acp::CrashReason::StdoutClosed.as_str().to_string())
                .await;
        }
        self.wire_trace = self.acp.lock().await.wire_trace();
        loop {
            if self.client_generation.load(Ordering::Acquire) != self.generation {
                // #99：代际失配退出（清理统一在循环结束后收口，评审 E6）。
                break;
            }
            match self.pump_step(&notification_inbox, &mut crashed_rx).await {
                PumpStep::Frame(classified) => {
                    let crate::acp::ClassifiedMessage {
                        raw,
                        classification,
                        wire_ordinal,
                        ingress_seq,
                    } = classified;
                    if self.client_generation.load(Ordering::Acquire) != self.generation {
                        break;
                    }
                    // 路由分支链：false = 主循环退出（flush 失败 / 代际结束）。
                    if !self
                        .route_frame(raw, classification, wire_ordinal, ingress_seq)
                        .await
                    {
                        break;
                    }
                }
                PumpStep::Skipped => continue,
                PumpStep::Stop => break,
            }
        }
        if !self.pending_batch.is_empty() {
            let batch = std::mem::take(&mut self.pending_batch);
            let _ = flush_pending_canonical(&self.flush_context(), batch).await;
        }
        // #99（评审 E6）：dispatcher 退出统一收口——循环后的单点清理覆盖全部
        // break 路径（代际失配 / inbox 关闭 / handle_session_update false）。
        // 旧代际 turn 条目整体收敛；此后旧代际的迟到结算归 UnknownTurn
        // （可观测，且永远无法改写新代际状态）。
        let dropped = self.runtime.turn_ledger.drop_generation(self.generation);
        if dropped > 0 {
            tracing::info!(
                dropped,
                generation = self.generation,
                "stale-generation turn entries dropped by turn ledger"
            );
        }
    }

    /// 泵取一步（原 tokio::select! 原样迁入）：biased 优先级 = 崩溃 watch >
    /// 控制帧（agent 请求/崩溃广播）> 普通通知 > 窗口 flush 定时（仅在途批次
    /// 非空时参与竞争）；每帧携带 ingress_seq，优先级不改变同一连接的序列语义。
    async fn pump_step(
        &mut self,
        inbox: &crate::acp::NotificationInbox,
        crashed_rx: &mut tokio::sync::watch::Receiver<bool>,
    ) -> PumpStep {
        tokio::select! {
            biased;
            changed = crashed_rx.changed() => {
                if changed.is_ok() && *crashed_rx.borrow_and_update() {
                    // watch 通道只携带 bool → 缺省 stdout_closed（reason 经 broadcast params 携带）
                    self.handle_crash
                        .handle(crate::acp::CrashReason::StdoutClosed.as_str().to_string())
                        .await;
                }
                PumpStep::Skipped
            }
            raw = inbox.recv_control() => match raw {
                Some(classified) => PumpStep::Frame(classified),
                None => PumpStep::Stop,
            },
            raw = inbox.recv() => match raw {
                Some(classified) => PumpStep::Frame(classified),
                None => PumpStep::Stop,
            },
            _ = tokio::time::sleep(PENDING_CANONICAL_FLUSH_INTERVAL), if !self.pending_batch.is_empty() => {
                let batch = std::mem::take(&mut self.pending_batch);
                if !flush_pending_canonical(&self.flush_context(), batch).await {
                    PumpStep::Stop
                } else {
                    PumpStep::Skipped
                }
            }
        }
    }

    /// 路由分支链（原主循环体内联分支逐一迁入，次序不变）：ProviderExtension
    /// 包络 → 窗口 flush 判定 → 崩溃 / elicitation 完成 / 权限请求 / terminal /
    /// fs / 私有交互 / 未知通知 / session/update 内核路径。每分支副作用完成后
    /// 返回 true（继续下一帧）；返回 false = 主循环退出——出自三处窗口 flush
    /// 失败，或 `handle_session_update` 返回 false（mutation 后本代结束/锁异常
    /// 等该函数自身的退出判定，见其文档）。
    async fn route_frame(
        &mut self,
        mut raw: crate::acp::RawMessage,
        classification: crate::acp::ReplayClassification,
        wire_ordinal: Option<u64>,
        ingress_seq: u64,
    ) -> bool {
        // #315：provider 私有扩展通知（peri/agent_event 等）就地包络为
        // session/update 形状——载荷字段原样保留，只补通道判别符；此后与本
        // 批窗口内的标准 update 完全同质（durable canonical + publish 共用
        // 通路，routing 对未知 sessionUpdate 变体照常 publish/persist）。
        if !wrap_provider_extension_frame(&mut raw) {
            return true;
        }
        let flush_batch = should_flush_batch(
            &self.pending_batch,
            &raw,
            &classification,
            &self.sessions,
            self.generation,
            &self.agent_id,
        );
        if flush_batch && !self.pending_batch.is_empty() {
            let batch = std::mem::take(&mut self.pending_batch);
            if !flush_pending_canonical(&self.flush_context(), batch).await {
                return false;
            }
        }
        if raw.kind == crate::acp::AcpKind::Crashed {
            // ISSUE-17 W1：broadcast 携带 reason（params.reason，稳定 code）——
            // dispatcher 保留原始 code 生成用户可读文案；缺省 stdout_closed
            let reason = crash_reason_from_params(raw.params.as_ref());
            self.handle_crash.handle(reason).await;
            return true;
        }
        if raw.kind == crate::acp::AcpKind::ElicitationComplete {
            // #316：elicitation/complete —— URL 模式外带交互完成通知（form 模式
            // 同步应答不产生本通知）。官方契约：客户端忽略未知/已完成 id。
            // 收敛匹配中的 pending elicitation 卡（URL 模式 UI 本期不做）。
            route_elicitation_complete(
                &self.window,
                &self.runtimes,
                &self.agent_id,
                raw.params.as_ref(),
            )
            .await;
            return true;
        }
        if raw.kind == crate::acp::AcpKind::PermissionRequest {
            // B9 权限审批：agent 主动 request_permission（带 id 请求，客户端必须应答）。
            // ACP-01：id 为原始 variant（number/string）——string-id agent 请求不再丢弃。
            route_permission_request(
                &self.window,
                &self.acp,
                &self.client_generation,
                &self.approval_mode,
                &self.pending_permissions,
                &self.sessions,
                &self.hook_bridge,
                &self.runtimes,
                &self.agents,
                &self.agent_id,
                raw,
            )
            .await;
            return true;
        }
        if matches!(
            raw.method.as_deref(),
            Some("terminal/create")
                | Some("terminal/output")
                | Some("terminal/wait_for_exit")
                | Some("terminal/waitForExit")
                | Some("terminal/kill")
                | Some("terminal/release")
        ) {
            route_terminal_request(
                &self.acp,
                &self.terminal_registry,
                &self.host_tools_policy,
                raw,
            )
            .await;
            return true;
        }
        if matches!(
            raw.method.as_deref(),
            Some("fs/read_text_file") | Some("fs/write_text_file")
        ) {
            route_fs_request(
                &self.acp,
                &self.host_tools_policy,
                &self.sessions,
                self.generation,
                raw,
            )
            .await;
            return true;
        }
        // Providers may expose a new approval/question/oauth method before a
        // dedicated AcpKind/adapter exists.  Do not silently drop an identified
        // request: answer it with Method Not Found and surface a diagnostic event.
        if crate::protocol_adapter::looks_like_interaction_method(raw.method.as_deref()) {
            route_private_interaction(
                &self.window,
                &self.acp,
                &self.agents,
                &self.private_interactions,
                &self.runtimes,
                &self.agent_id,
                self.generation,
                raw,
            )
            .await;
            return true;
        }
        if raw.kind != crate::acp::AcpKind::SessionUpdate {
            route_unknown_notification(&self.acp, &raw).await;
            return true;
        }
        let payload = match raw.params {
            Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
            _ => {
                tracing::warn!("ACP session/update missing object params");
                return true;
            }
        };
        let terminal_boundary = payload
            .get("update")
            .and_then(|update| update.get("sessionUpdate"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(|kind| matches!(kind, "done" | "error" | "cancelled"));
        if !handle_session_update(
            &self.window,
            &self.gateway,
            &self.sessions,
            &self.binding_health,
            &self.pet,
            &self.runtime.update_channels,
            &self.client_generation,
            self.generation,
            &self.runtime.mapping_ready,
            &self.agent_id,
            self.event_service.as_ref(),
            self.message_service.as_ref(),
            classification,
            wire_ordinal,
            &self.runtime.turn_ledger,
            &self.runtime.probe_sessions,
            ingress_seq,
            self.wire_trace.clone(),
            Some(&mut self.pending_batch),
            payload,
        )
        .await
        {
            return false;
        }
        if terminal_boundary && !self.pending_batch.is_empty() {
            let batch = std::mem::take(&mut self.pending_batch);
            if !flush_pending_canonical(&self.flush_context(), batch).await {
                return false;
            }
        }
        true
    }

    /// flush 环境上下文（#335/U1b 收敛面）：字段清单唯一处（原四调用点手抄 ×4
    /// 的去重靠本方法）；纯引用装配，无副作用，值与调用点逐参形态一致。
    fn flush_context(&self) -> CanonicalFlushContext<'_, R> {
        CanonicalFlushContext {
            window: &self.window,
            gateway: &self.gateway,
            update_channels: &self.runtime.update_channels,
            pet: &self.pet,
            client_generation: &self.client_generation,
            agent_id: &self.agent_id,
            event_service: self.event_service.as_ref(),
            message_service: self.message_service.as_ref(),
        }
    }
}

/// #315：provider 私有扩展通知就地包络（原主循环内联分支抽出）。载荷字段原样
/// 保留，只补通道判别符，包络为 session/update 形状；返回 false = 缺 object
/// params/sessionId（帧丢弃，仅告警）。
fn wrap_provider_extension_frame(raw: &mut crate::acp::RawMessage) -> bool {
    if raw.kind != crate::acp::AcpKind::ProviderExtension {
        return true;
    }
    let method = raw.method.clone().unwrap_or_default();
    match crate::acp::wrap_provider_extension_notification(&method, raw.params.take()) {
        Some(wrapped) => {
            tracing::debug!("provider 扩展通知 {} 已包络为 session/update", method);
            raw.kind = crate::acp::AcpKind::SessionUpdate;
            raw.params = Some(wrapped);
            true
        }
        None => {
            tracing::warn!(
                "provider 扩展通知 {} 缺 object params/sessionId，丢弃",
                method
            );
            false
        }
    }
}

/// Crashed 帧的 reason 提取（ISSUE-17 W1）：broadcast 携带 reason（params.reason，
/// 稳定 code）；缺省 stdout_closed。
fn crash_reason_from_params(params: Option<&serde_json::Value>) -> String {
    params
        .and_then(|p| p.get("reason"))
        .and_then(|v| v.as_str())
        .unwrap_or(crate::acp::CrashReason::StdoutClosed.as_str())
        .to_string()
}

#[cfg(test)]
mod tests {
    use crate::private_interaction::PendingPrivateInteraction;

    fn pending_elicitation(elicitation_id: &str) -> PendingPrivateInteraction {
        PendingPrivateInteraction {
            provider: "peri".into(),
            agent_id: "a1".into(),
            session_id: "peri-s1".into(),
            method: "elicitation/create".into(),
            bridge: crate::acp::adapter::private_ext::PrivateBridge::Elicitation,
            params: serde_json::json!({
                "sessionId": "peri-s1",
                "elicitationId": elicitation_id,
                "url": "https://example.com/auth",
                "message": "完成登录",
            }),
            question_specs: None,
            client_generation: 1,
            enqueued_at: crate::time::Timestamp::now(),
        }
    }

    /// #316：elicitation/complete 按 elicitationId 匹配 pending 私有交互。
    #[test]
    fn match_pending_elicitation_finds_only_exact_id_and_method() {
        let a = crate::acp::RequestId::Number(11);
        let b = crate::acp::RequestId::Number(12);
        let snapshot = vec![
            (a.clone(), pending_elicitation("el-1")),
            (b.clone(), pending_elicitation("el-2")),
        ];
        let (hit, pending) = match_pending_elicitation(&snapshot, "el-2").expect("el-2 必须命中");
        assert_eq!(hit, b);
        assert_eq!(pending.session_id, "peri-s1");
        // 未知 id → None（官方契约：忽略）
        assert!(match_pending_elicitation(&snapshot, "el-404").is_none());
    }

    #[test]
    fn match_pending_elicitation_ignores_other_methods_and_malformed_params() {
        let mut other_method = pending_elicitation("el-1");
        other_method.method = "session/request_permission".into();
        let mut malformed = pending_elicitation("el-1");
        malformed.params = serde_json::json!({"message": "form 模式无 elicitationId"});
        let snapshot = vec![
            (crate::acp::RequestId::Number(21), other_method),
            (crate::acp::RequestId::Number(22), malformed),
        ];
        assert!(
            match_pending_elicitation(&snapshot, "el-1").is_none(),
            "方法不符或缺 elicitationId 的条目不得命中"
        );
    }

    #[test]
    fn session_workspace_root_resolves_by_peri_id_and_generation() {
        let sessions: SessionsLock = std::sync::Mutex::new(std::collections::HashMap::new());
        let mut s1 = SessionInfo::new("peri-1".into(), String::new(), "G:/ws/one".into(), true, 1);
        s1.generation = 1;
        let mut s2 = SessionInfo::new("peri-1".into(), String::new(), "G:/ws/two".into(), true, 2);
        s2.generation = 2;
        sessions.lock().unwrap().insert("local:1".into(), s1);
        sessions.lock().unwrap().insert("local:2".into(), s2);

        // 命中：periId + generation 双键，各代各归其工作区
        assert_eq!(
            session_workspace_root(&sessions, "peri-1", 1),
            Some(std::path::PathBuf::from("G:/ws/one"))
        );
        assert_eq!(
            session_workspace_root(&sessions, "peri-1", 2),
            Some(std::path::PathBuf::from("G:/ws/two"))
        );
        // 代际不符 → None（旧代际请求不进新代际沙箱）
        assert_eq!(session_workspace_root(&sessions, "peri-1", 3), None);
        // 未知 periId → None
        assert_eq!(session_workspace_root(&sessions, "peri-404", 1), None);
    }

    #[test]
    fn session_workspace_root_rejects_empty_cwd() {
        let sessions: SessionsLock = std::sync::Mutex::new(std::collections::HashMap::new());
        sessions.lock().unwrap().insert(
            "local:1".into(),
            SessionInfo::new("peri-empty".into(), String::new(), String::new(), true, 1),
        );
        assert_eq!(session_workspace_root(&sessions, "peri-empty", 1), None);
    }

    #[test]
    fn runtime_store_roundtrip_supports_complete_matching() {
        let runtime = crate::test_utils::connected_runtime();
        let request_id = crate::acp::RequestId::Number(31);
        runtime
            .private_interactions
            .insert(request_id.clone(), pending_elicitation("el-9"))
            .expect("insert 必须成功");
        let matched = match_pending_elicitation(&runtime.private_interactions.snapshot(), "el-9")
            .expect("inserted pending must match");
        assert_eq!(matched.0, request_id);
        assert!(
            runtime
                .private_interactions
                .take(&request_id)
                .map(|taken| taken.is_some())
                .unwrap_or(false),
            "take 成功才 settle+emit（P2-2 守卫的数据前提）"
        );
        assert!(
            match_pending_elicitation(&runtime.private_interactions.snapshot(), "el-9").is_none()
        );
    }

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
        assert!(runtime
            .update_channels
            .lock()
            .unwrap()
            .contains_key("local:s1"));

        // 注册表语义：take 后不再持有（终帧注销路径依赖）。
        assert!(runtime.take_update_channel("local:s1").is_some());
        assert!(!runtime
            .update_channels
            .lock()
            .unwrap()
            .contains_key("local:s1"));

        // clear 语义（C7/generation bump 清理）。
        runtime.register_update_channel("local:s1", tauri::ipc::Channel::new(|_| Ok(())));
        runtime.register_update_channel("local:s2", tauri::ipc::Channel::new(|_| Ok(())));
        runtime.clear_update_channels();
        assert!(runtime.update_channels.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn pending_batch_commits_rows_before_ordered_channel_publish() {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app");
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock window");
        let frames: Arc<std::sync::Mutex<Vec<serde_json::Value>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = frames.clone();
        let channel = tauri::ipc::Channel::new(move |body| {
            if let tauri::ipc::InvokeResponseBody::Json(text) = body {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    sink.lock().unwrap().push(value);
                }
            }
            Ok(())
        });
        let update_channels = crate::runtime::UpdateChannelMap::new(
            std::collections::HashMap::from([("local:s1".to_string(), channel)]),
        );
        let gateway = crate::gateway::GatewayCore::new();
        let event_service = Arc::new(crate::session::EventService::in_memory().expect("events"));
        let owner = DurableSessionOwner::new("profile", "agent", "local:s1");
        let wire = crate::acp::AcpWireHub::new(
            crate::correlation::RuntimeCorrelation {
                agent_id: "agent".to_string(),
                provider: None,
                source: "local:s1".to_string(),
                local_session_id: Some("local:s1".to_string()),
                remote_session_id: Some("peri-s1".to_string()),
                peri_id: Some("peri-s1".to_string()),
                client_generation: 1,
                request_id: None,
                tool_call_id: None,
            },
            16,
        );
        let decision = routing::RoutingDecision {
            class: routing::RoutingClass::Live,
            variant: Some(crate::acp::SessionUpdateVariant::AgentMessageChunk),
            mutate_session: true,
            collect_response: true,
            apply_pet: true,
            persist_canonical: true,
            publish: true,
        };
        let pending = (1_u64..=3)
            .map(|ordinal| PendingCanonicalPublish {
                input: routing::RoutingInput {
                    source: "local:s1".to_string(),
                    remote_session_id: "peri-s1".to_string(),
                    generation: 1,
                    owner: Some(owner.clone()),
                    classification: crate::acp::ReplayClassification::Live,
                    variant: Some(crate::acp::SessionUpdateVariant::AgentMessageChunk),
                    replay_loading: false,
                    payload: std::sync::Arc::new(serde_json::json!({
                        "sessionId": "peri-s1",
                        "update": {
                            "sessionUpdate": if ordinal == 3 {"done"} else {"agent_message_chunk"},
                            "content": {"text": if ordinal == 1 {"a"} else {"b"}}
                        }
                    })),
                    wire_ordinal: Some(ordinal),
                },
                decision,
                pet_events: if ordinal == 1 {
                    vec![PetEvent::FirstChunk]
                } else {
                    Vec::new()
                },
                session_state_to_persist: None,
                wire: Some(wire.clone()),
            })
            .collect();
        // #335/U1b：上下文结构体化后，测试侧的临时值需具名绑定（结构体字段
        // 借用不能指向语句级临时）。
        let flush_pet = std::sync::Mutex::new(crate::pet::PetState::default());
        let flush_generation = AtomicU64::new(1);
        let flush_window = window.as_ref().window();
        let flush_context = CanonicalFlushContext {
            window: &flush_window,
            gateway: &gateway,
            update_channels: &update_channels,
            pet: &flush_pet,
            client_generation: &flush_generation,
            agent_id: "agent",
            event_service: Some(&event_service),
            message_service: None,
        };
        assert!(flush_pending_canonical(&flush_context, pending).await);
        assert_eq!(
            event_service.revision(owner.key().unwrap()).await.unwrap(),
            4
        );
        let frames = frames.lock().unwrap().clone();
        assert_eq!(
            frames.len(),
            3,
            "每个输入帧仍然各发一条（配对按跨度展开，不合并发布）"
        );
        // ADR-0016：前两条是相邻同类 delta，写侧折成**一行**（span [1,2]，行落在跨度末位）。
        // 两条 wire 帧的 durable 事实都是这一行 ⇒ canonicalEvent.sequence 都是 2，相关性亦指向同一行。
        // 第三条终态行不受折叠影响（编号 3），单元在同事务占 4。
        assert_eq!(frames[0]["payload"]["canonicalEvent"]["sequence"], 2);
        assert_eq!(frames[1]["payload"]["canonicalEvent"]["sequence"], 2);
        assert_eq!(frames[2]["payload"]["canonicalEvent"]["sequence"], 3);
        assert_eq!(wire.correlate(1).unwrap().sequence, 2);
        assert_eq!(wire.correlate(2).unwrap().sequence, 2);
        assert_eq!(wire.correlate(3).unwrap().sequence, 3);
        assert_eq!(wire.correlate(1).unwrap().revision, 4);
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
        for (label, update, variant) in cases {
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
            session.commands_snapshot.as_ref().unwrap()[0]["name"],
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
            session.commands_snapshot.as_ref().unwrap()[0]["name"],
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
        let snapshot_only = session.clone();
        crate::session::restore_session_state(&snapshot_only, &mut restored);
        assert_eq!(
            restored["modes"]["currentModeId"],
            serde_json::json!("balanced")
        );
    }

    #[test]
    fn acp_reducer_is_updated_without_emitting_ui_side_effects() {
        let mut session = crate::session::SessionInfo::new(
            "peri-reducer".to_string(),
            String::new(),
            "cwd".to_string(),
            true,
            1,
        );
        let update = serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"text": "hello"}
        });
        let events = apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::AgentMessageChunk),
            false,
        );
        assert!(events.is_empty(), "text chunks do not create pet events");
        assert_eq!(
            session.acp_state.apply(&crate::acp::RawMessage {
                id: None,
                method: Some(crate::acp::NOTIF_SESSION_UPDATE.to_string()),
                kind: crate::acp::AcpKind::SessionUpdate,
                result: None,
                params: Some(serde_json::json!({"update": update})),
                error: None,
            }),
            vec![crate::acp::AcpStateDelta::Text {
                text: "hello".into()
            }]
        );

        let usage = serde_json::json!({
            "sessionUpdate": "usage_update",
            "used": 7,
            "size": 100,
            "_meta": {"inputTokens": 5, "outputTokens": 2},
        });
        let events = apply_update_event(
            &mut session,
            &usage,
            Some(crate::acp::SessionUpdateVariant::UsageUpdate),
            false,
        );
        assert!(matches!(events.as_slice(), [PetEvent::UsageUpdate(7)]));
        assert_eq!(session.acp_state.usage, Some((7, Some(100))));
        assert_eq!(session.acp_state.usage_input, Some(5));
        assert_eq!(session.acp_state.usage_output, Some(2));
        assert_eq!(session.tokens_total, 7);
        assert_eq!(session.context_size, 100);
        assert_eq!(session.tokens_in, 5);
        assert_eq!(session.tokens_out, 2);
    }

    /// P1-3（R2-WI03）：provider 从活配置解析——reload 修改实例 provider 后立即生效。
    #[test]
    fn resolve_agent_provider_follows_live_config() {
        use std::collections::HashMap;
        let mut agents = HashMap::new();
        let mut peri = crate::test_utils::fake_acp_agent_stub("peri");
        peri.provider = Some("peri".to_string());
        agents.insert("peri-copy".to_string(), peri);
        assert_eq!(
            resolve_agent_provider(&agents, "peri-copy").as_deref(),
            Some("peri"),
            "活配置解析 provider"
        );
        // reload 把该实例 provider 改为 hermes → 新请求即用新 provider
        let mut reloaded = crate::test_utils::fake_acp_agent_stub("peri");
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

    // ── P56/D2：单值 config_option_update 键归一化 + session_info_update models 消费 ──

    fn dispatcher_session() -> crate::session::SessionInfo {
        crate::session::SessionInfo::new(
            "peri-p56".to_string(),
            String::new(),
            "cwd".to_string(),
            true,
            1,
        )
    }

    /// 验收 7：单值 config_option_update 以 `configId`（camelCase）推送 → 更新
    /// session.model；snake_case `config_id` 与归一化别名同效。
    #[test]
    fn config_option_update_reads_config_id_key_and_normalizes() {
        for key in ["configId", "config_id"] {
            let mut session = dispatcher_session();
            let update = serde_json::json!({
                "sessionUpdate": "config_option_update",
                key: "model",
                "currentValue": "nous:hermes-4",
            });
            let events = apply_update_event(
                &mut session,
                &update,
                Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
                false,
            );
            assert_eq!(session.model, "nous:hermes-4", "key {key} must be read");
            assert!(
                matches!(events.as_slice(), [PetEvent::ModelChanged(model)] if model == "nous:hermes-4"),
                "model change must stay a pet event"
            );
        }
        // 归一化：model_selection / MODEL 均精确命中 model 语义键。
        for key in ["model_selection", "MODEL"] {
            let mut session = dispatcher_session();
            let update = serde_json::json!({
                "sessionUpdate": "config_option_update",
                "configId": key,
                "currentValue": "m-1",
            });
            apply_update_event(
                &mut session,
                &update,
                Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
                false,
            );
            assert_eq!(session.model, "m-1", "normalized key {key} must match");
        }
        // 无语义键的 update 不误写 model。
        let mut session = dispatcher_session();
        session.model = "keep".to_string();
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configId": "reasoning_effort",
            "currentValue": "low",
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "keep");
    }

    /// P56/D2.3：session_info_update 带 models.currentModelId（camel/snake）→
    /// 更新 session.model（对齐 usage _meta.model 现状；hermes 未来推此通道即消费）。
    #[test]
    fn session_info_update_consumes_models_current_model() {
        for (wire, expected) in [
            (
                serde_json::json!({"currentModelId": "nous:hermes-4"}),
                "nous:hermes-4",
            ),
            (
                serde_json::json!({"current_model_id": "nous:hermes-3"}),
                "nous:hermes-3",
            ),
        ] {
            let mut session = dispatcher_session();
            let update = serde_json::json!({
                "sessionUpdate": "session_info_update",
                "models": wire,
            });
            apply_update_event(
                &mut session,
                &update,
                Some(crate::acp::SessionUpdateVariant::SessionInfoUpdate),
                false,
            );
            assert_eq!(session.model, expected);
        }
        // 显示名-only 的 current 不得进入 typed 字段（machine-id-only）。
        let mut session = dispatcher_session();
        session.model = "keep".to_string();
        let update = serde_json::json!({
            "sessionUpdate": "session_info_update",
            "models": {"currentModelId": {"name": "Display Only"}},
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::SessionInfoUpdate),
            false,
        );
        assert_eq!(session.model, "keep");
    }

    /// #97/D97-3：session_info_update 的完整模型列表同步刷新 choices/current
    /// （验收 4），并清除客户端 requested 未确认态。
    #[test]
    fn session_info_update_refreshes_full_model_catalog_and_clears_pending() {
        let mut session = dispatcher_session();
        session.model = "m-old".to_string();
        session.model_pending = Some("m-old".to_string());
        let update = serde_json::json!({
            "sessionUpdate": "session_info_update",
            "models": {
                "currentModelId": "m-new",
                "availableModels": [{"modelId": "m-new", "name": "New"}, {"modelId": "m-legacy"}],
            },
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::SessionInfoUpdate),
            false,
        );
        assert_eq!(session.model, "m-new");
        assert_eq!(
            session.model_choices,
            vec!["m-new".to_string(), "m-legacy".to_string()]
        );
        assert_eq!(session.model_pending, None);
    }

    /// #97/D97-4：完全相同的 models push 重复两次只提交一次状态；丢弃计数留在
    /// 诊断字段，且不产生第二次 model 变更。
    #[test]
    fn duplicate_session_info_push_is_deduplicated_with_diagnostic_count() {
        let mut session = dispatcher_session();
        let update = serde_json::json!({
            "sessionUpdate": "session_info_update",
            "models": {
                "currentModelId": "m-new",
                "availableModels": [{"modelId": "m-new"}, {"modelId": "m-legacy"}],
            },
        });
        for _ in 0..2 {
            apply_update_event(
                &mut session,
                &update,
                Some(crate::acp::SessionUpdateVariant::SessionInfoUpdate),
                false,
            );
        }
        assert_eq!(session.model, "m-new");
        assert_eq!(session.selector_duplicate_pushes, 1);
        assert_eq!(
            session.model_choices,
            vec!["m-new".to_string(), "m-legacy".to_string()]
        );
    }

    /// #97/D97-4：config_option_update 的超限 configOptions envelope 被拒绝入库，
    /// 已知 selector 状态保持不变。
    #[test]
    fn oversized_config_option_envelope_does_not_corrupt_session_catalog() {
        use crate::session::SELECTOR_ENVELOPE_MAX_BYTES;
        let mut session = dispatcher_session();
        let known = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [{
                "id": "model-selection",
                "category": "model",
                "options": [{"valueId": "m-a"}],
                "currentValue": "m-a"
            }],
        });
        apply_update_event(
            &mut session,
            &known,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-a");
        let blob = "x".repeat(SELECTOR_ENVELOPE_MAX_BYTES + 1);
        let oversized = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [{"id": "future-kind", "payload": blob}],
        });
        apply_update_event(
            &mut session,
            &oversized,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.selector_envelope_dropped, 1);
        assert_eq!(session.model, "m-a");
        assert_eq!(
            session.model_surface,
            crate::session::ModelSurface::ConfigOption {
                config_id: "model-selection".to_string()
            }
        );
    }

    /// #97/D97-7（评审补强）：config_option_update 全量数组同时含已知 model 选项与
    /// 未知 kind 时，已知 selector 照常刷新，未知 kind 不降级已知面。
    #[test]
    fn config_option_update_with_unknown_kind_preserves_known_selector() {
        let mut session = dispatcher_session();
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [
                {
                    "id": "model-selection",
                    "category": "model",
                    "options": [{"valueId": "m-b"}],
                    "currentValue": "m-b"
                },
                {"id": "future-kind", "payload": {"opaque": true}}
            ],
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-b");
        assert_eq!(
            session.model_surface,
            crate::session::ModelSurface::ConfigOption {
                config_id: "model-selection".to_string()
            }
        );
        assert_eq!(session.config_options.len(), 2, "未知 kind 原样保留");
    }

    /// #97/D97-3（评审补强）：usage _meta.model 是权威 current 通道——清除客户端
    /// requested 未确认态，与单值 config_option_update 分支同契约。
    #[test]
    fn usage_meta_model_clears_pending_state() {
        let mut session = dispatcher_session();
        session.model_pending = Some("m-old".to_string());
        let update = serde_json::json!({"_meta": {"model": "usage-channel-model"}});
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::UsageUpdate),
            false,
        );
        assert_eq!(session.model, "usage-channel-model");
        assert_eq!(session.model_pending, None);
    }

    /// #97/N1（第二轮评审回归）：config_option_update 全量数组携带可提取 model
    /// currentValue 时清除 pending（权威回显的 model 维度）；无 model 维度的数组
    /// 不构成确认，pending 保留——pending 生命周期在全量数组分支无漏口。
    #[test]
    fn config_option_update_full_array_clears_pending_only_with_model_dimension() {
        // 有 model 维度：current + pending 一致收敛，pending 清除。
        let mut session = dispatcher_session();
        session.model_pending = Some("m-stale".to_string());
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [{
                "id": "model-selection",
                "category": "model",
                "options": [{"valueId": "m-b"}],
                "currentValue": "m-b"
            }],
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-b");
        assert_eq!(session.model_pending, None);

        // 无 model 维度（仅 reasoning 选项）：model 与 pending 均不动。
        let mut session = dispatcher_session();
        session.model = "m-keep".to_string();
        session.model_pending = Some("m-keep".to_string());
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configOptions": [{
                "id": "reasoning_effort",
                "category": "thought_level",
                "options": [{"valueId": "low"}, {"valueId": "high"}],
                "currentValue": "high"
            }],
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-keep");
        assert_eq!(session.model_pending.as_deref(), Some("m-keep"));
    }

    /// #97/N4（第二轮评审回归）：单值 config_option_update 的 model 值走
    /// machine-id-only 提取——显示名不得进入 session.model（与 models-state
    /// 通道同一不变量）；mode 通道保持宽容提取不受影响。
    #[test]
    fn single_value_model_push_is_machine_id_only() {
        let mut session = dispatcher_session();
        session.model = "m-keep".to_string();
        session.model_pending = Some("m-keep".to_string());
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configId": "model",
            "currentValue": {"name": "Display Only"},
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-keep", "显示名不得当 model id");
        assert_eq!(session.model_pending.as_deref(), Some("m-keep"));

        // machine id 照常消费。
        let update = serde_json::json!({
            "sessionUpdate": "config_option_update",
            "configId": "model",
            "currentValue": {"modelId": "m-real"},
        });
        apply_update_event(
            &mut session,
            &update,
            Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate),
            false,
        );
        assert_eq!(session.model, "m-real");
        assert_eq!(session.model_pending, None);
    }
}
