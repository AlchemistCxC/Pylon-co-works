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
use crate::permission::{
    parse_permission_request_with_generation, permission_response, pick_option, PendingPermission,
};
use crate::pet::PetState;
use crate::runtime::AgentRuntime;
use crate::session::{extract_tool_file_name, value_as_string, SessionInfo};
use crate::AppStateHandles;
use crate::{emit_event, emit_event_all};

/// C11/O7：一条 session/update 事件需要施加到宠物的感知事件。
/// 按收集顺序产出，调用方在 sessions 锁外逐条应用——收集顺序 = 应用顺序。
/// C11：回放（is_replay）事件仅同步 session 状态，不产生宠物感知
/// （回放不刷 xp/bond/掉落）。
#[derive(Debug)]
enum PetEvent {
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
            if !is_replay {
                pet_events.push(PetEvent::UsageUpdate(session.tokens_total));
            }
        }
        Some(crate::acp::SessionUpdateVariant::ToolCall) => {
            if !is_replay {
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
            if !is_replay {
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
                        // M5 感知：模型切换
                        let changed = session.model != model;
                        session.model = model.clone();
                        if changed {
                            pet_events.push(PetEvent::ModelChanged(model));
                        }
                    }
                    (Some("mode"), Some(mode)) => {
                        let changed = session.mode.as_deref() != Some(mode.as_str());
                        session.mode = Some(mode.clone());
                        if changed {
                            // M5 感知：工作模式切换
                            pet_events.push(PetEvent::ModeChanged(mode));
                        }
                    }
                    _ => {}
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
type PermissionLock = std::sync::Mutex<std::collections::HashMap<u64, PendingPermission>>;

/// B9 权限审批（R8 自主循环拆分）：agent 主动 request_permission（带 id 请求，
/// 客户端必须应答）。C4/C5 语义保持：代复核（应答不误写新代进程）+ 模式判定
/// （bypass/auto 自动批准；edit/default 挂起 + 前端事件）。
async fn handle_permission_request<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    acp: &AcpLock,
    client_generation: &AtomicU64,
    approval_mode: &std::sync::Mutex<String>,
    pending_permissions: &PermissionLock,
    request_id: u64,
    params: Option<&serde_json::Value>,
) {
    // C4：记录到达时 client_generation——应答时复核，客户端替换后
    // 旧进程同 id 请求不得被旧审批决策误写。
    let Some(permission) =
        parse_permission_request_with_generation(params, client_generation.load(Ordering::Acquire))
    else {
        log::warn!("ACP request_permission 解析失败 (id={request_id})，按拒绝处理");
        let acp = acp.lock().await;
        // C5：解析失败无选项可用 → pick_option 空集 → reject_once 兜底
        let option_id = pick_option(&[], true).unwrap_or("reject_once");
        let _ = acp
            .send_response(request_id, permission_response(option_id))
            .await;
        return;
    };
    let mode = approval_mode
        .lock()
        .map(|m| m.clone())
        .unwrap_or_else(|_| "default".to_string());
    if matches!(mode.as_str(), "bypass" | "auto") {
        log::info!(
            "权限模式 {mode}：自动批准工具调用 {}",
            permission.tool_call_id
        );
        // C5：自动批准按请求选项选 allow 语义项（无匹配取首个）。
        let option_id = pick_option(&permission.options, false).unwrap_or("allow_once");
        let acp = acp.lock().await;
        let _ = acp
            .send_response(request_id, permission_response(option_id))
            .await;
    } else {
        let _ = pending_permissions.lock().map(|mut pending| {
            pending.insert(request_id, permission.clone());
        });
        emit_event(
            window,
            "pylon:permission-request",
            serde_json::json!({
                "requestId": request_id,
                "sessionId": permission.session_id,
                "toolCallId": permission.tool_call_id,
                "title": permission.title,
                "prompt": permission.prompt,
                "options": permission.options,
                "requestedAt": permission.requested_at,
            }),
        );
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
    pet: &std::sync::Mutex<PetState>,
    client_generation: &AtomicU64,
    generation: u64,
    mapping_ready: &tokio::sync::Notify,
    mut payload: serde_json::Value,
) -> bool {
    let peri_id = match payload.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            log::warn!("ACP session/update missing sessionId");
            return true;
        }
    };
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
            log::warn!(
                "ACP notification rejected: periId {} maps to multiple local sources",
                peri_id
            );
            return true;
        }
        let Some(mapped) = mapped else {
            log::warn!("ACP notification for unknown session {}", peri_id);
            return true;
        };
        mapped.0
    };
    // source_for_peri_id_in_generation 已按代过滤（返回的映射
    // generation 必等于本 dispatcher 代），此处仅复核客户端未替换。
    if client_generation.load(Ordering::Acquire) != generation {
        log::warn!("ACP notification rejected for stale session {}", peri_id);
        return true;
    }
    let Some(update) = payload.get("update") else {
        log::warn!("ACP session/update missing update payload");
        return true;
    };
    // R4：sessionUpdate 变体经枚举解析（未知变体 → None，与旧 _ => {} 忽略一致）。
    let variant = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .and_then(crate::acp::SessionUpdateVariant::from_str);
    let is_replay = update
        .get("_meta")
        .and_then(|meta| meta.get("periReplay"))
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    let mapping_is_current = || {
        client_generation.load(Ordering::Acquire) == generation
            && sessions.lock().ok().and_then(|items| {
                items.get(&source).map(|session| {
                    session_mapping_matches(
                        &session.peri_id,
                        session.generation,
                        &peri_id,
                        generation,
                    )
                })
            }) == Some(true)
    };
    if !mapping_is_current() {
        log::warn!("ACP notification rejected for stale session {}", peri_id);
        return true;
    }
    if variant == Some(crate::acp::SessionUpdateVariant::AgentMessageChunk) {
        // C11：回放事件不触发宠物感知（on_first_chunk/on_code_seen）也不流式
        // 收集回复文本（last_response_text 不得被回放内容污染）。事件本身仍
        // 照常转发前端（emit_event_all 不变）。
        if !is_replay {
            let _ = pet.lock().map(|mut p| crate::pet::on_first_chunk(&mut p));
            // M5 感知：输出含代码块 → 宠物蹲在屏幕前看
            if let Some(text) = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
            {
                if text.contains("```") {
                    let _ = pet.lock().map(|mut p| crate::pet::on_code_seen(&mut p));
                }
                // B11.2：流式收集当前回合回复文本（完成持久化 POST /persist 用）。
                // 回合绑定：接收事件时捕获 session.inject_round，collect_response_chunk
                // 内与追加时刻的当前回合比对——Round N 迟到 chunk 在 Round N+1
                // 推进（clear）之后才被追加 → 丢弃，防跨回合污染。截断逻辑在方法内。
                let received_round = sessions
                    .lock()
                    .ok()
                    .and_then(|items| items.get(&source).map(|session| session.inject_round))
                    .unwrap_or(0);
                if let Ok(mut items) = sessions.lock() {
                    if let Some(session) = items.get_mut(&source) {
                        session.collect_response_chunk(text, received_round);
                    }
                }
            }
        }
    }
    if variant == Some(crate::acp::SessionUpdateVariant::UserMessageChunk) {
        if is_replay {
            if let Some(text) = update
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|v| v.as_str())
            {
                emit_event(
                    window,
                    "peri:user",
                    serde_json::json!({
                        "source": source,
                        "content": text,
                        "replay": is_replay,
                    }),
                );
            }
        }
        return true;
    }
    let mut mapping_current_at_mutation = false;
    // O7：pet 感知事件在 sessions 锁内收集、锁外统一应用——
    // 消除 sessions → pet 锁嵌套；收集顺序 = 应用顺序，行为等价。
    let mut pet_events: Vec<PetEvent> = Vec::new();
    if let Ok(mut items) = sessions.lock() {
        if client_generation.load(Ordering::Acquire) == generation {
            if let Some(session) = items.get(&source) {
                mapping_current_at_mutation = session_mapping_matches(
                    &session.peri_id,
                    session.generation,
                    &peri_id,
                    generation,
                );
            }
        }
        if mapping_current_at_mutation {
            if let Some(session) = items.get_mut(&source) {
                pet_events = apply_update_event(session, update, variant, is_replay);
            }
        }
    }
    for event in pet_events {
        let _ = pet.lock().map(|mut p| event.apply(&mut p));
    }
    if client_generation.load(Ordering::Acquire) != generation {
        return false;
    }
    if let serde_json::Value::Object(ref mut map) = payload {
        map.insert(
            "source".to_string(),
            serde_json::Value::String(source.clone()),
        );
    }
    emit_event_all(window, gateway, &source, "peri:update", payload);
    true
}

/// 启动（或重启）通知分发器：订阅 ACP broadcast 流，把事件路由到
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
    let pending_permissions = runtime.pending_permissions.clone();
    let runtime_for_reconnect = runtime.clone();
    *task = Some(tokio::spawn(async move {
        let mut rx = acp.lock().await.rx.resubscribe();
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
        let handle_crash = || async {
            let last_error = "ACP child process stdout closed".to_string();
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
            };
            emit_event(
                &window,
                "peri:agent-status",
                reconnect_handles.agent_status_payload(Some(runtime_for_reconnect.as_ref())),
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
                    let mut remaining_attempts = agent_runtime::MAX_RECONNECT_ATTEMPTS;
                    let mut attempt: u32 = 1;
                    loop {
                        if remaining_attempts == 0 {
                            break;
                        }
                        // R7：每轮复查 epoch——重连期间到来新一轮崩溃通知（含被防重入
                        // 标志吸收的）→ 本循环已失效：放弃旧 ticket、以最新 epoch 重新
                        // 武装（预算与退避重置），本循环仍是唯一重连权威（标志持续持有）。
                        if epoch_for_reconnect.load(Ordering::Acquire) != scheduled_epoch {
                            log::info!(
                                "auto-reconnect superseded by a newer crash; re-arming from attempt 1"
                            );
                            // 放弃旧 ticket：以最新 epoch 重新武装。
                            scheduled_epoch = epoch_for_reconnect.load(Ordering::Acquire);
                            remaining_attempts = agent_runtime::MAX_RECONNECT_ATTEMPTS;
                            attempt = 1;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(
                            agent_runtime::reconnect_backoff_ms(attempt),
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
                        let _lifecycle_guard = reconnect_runtime.agent_lifecycle.lock().await;
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
                            true,
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
                                log::warn!("auto-reconnect attempt {attempt} failed: {error}");
                                attempt += 1;
                                remaining_attempts -= 1;
                            }
                        }
                    }
                    // R7：成功/放弃消费 ticket——循环结束（成功、提前放弃或预算耗尽）
                    // 统一推进 epoch，使后续通知的计数严格单调。
                    epoch_for_reconnect.fetch_add(1, Ordering::AcqRel);
                    reconnect_runtime
                        .auto_reconnect_active
                        .store(false, Ordering::Release);
                });
            }
        };
        // 订阅即查现值：崩溃发生在订阅之前（connect 成功后立刻 EOF、dispatcher
        // 尚未启动）时 changed() 不会触发，只能靠 watch 保留的最新值兜底。
        if *crashed_rx.borrow_and_update() {
            handle_crash().await;
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
                        handle_crash().await;
                    }
                    continue;
                }
                raw = rx.recv() => raw,
            };
            let raw = match raw {
                Ok(raw) => raw,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    log::warn!("notification dispatcher lagged by {} messages", n);
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            };
            if client_generation.load(Ordering::Acquire) != generation {
                break;
            }
            if raw.method.as_deref() == Some(crate::acp::NOTIF_AGENT_CRASHED) {
                handle_crash().await;
                continue;
            }
            // B9 权限审批：agent 主动 request_permission（带 id 请求，客户端必须应答）。
            // 模式判定：bypass/auto 自动批准；edit/default 挂起 + 前端事件。
            if raw.method.as_deref() == Some(crate::acp::METHOD_SESSION_REQUEST_PERMISSION) {
                if let Some(request_id) = raw.id {
                    handle_permission_request(
                        &window,
                        &acp,
                        &client_generation,
                        &approval_mode,
                        &pending_permissions,
                        request_id,
                        raw.params.as_ref(),
                    )
                    .await;
                }
                continue;
            }
            if raw.method.as_deref() != Some(crate::acp::NOTIF_SESSION_UPDATE) {
                continue;
            }
            let payload = match raw.params {
                Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
                _ => {
                    log::warn!("ACP session/update missing object params");
                    continue;
                }
            };
            if !handle_session_update(
                &window,
                &gateway,
                &sessions,
                &pet,
                &client_generation,
                generation,
                &runtime_for_reconnect.mapping_ready,
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

    /// C11：带 `_meta.periReplay=true` 的事件不产生宠物感知事件——pet xp/bond/
    /// recent_events 快照不变（回放不刷宠物状态）。对照：同事件不带回放标志 →
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
}
