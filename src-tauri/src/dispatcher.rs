//! 通知分发器：ACP 事件广播 → 前端/平台 + 崩溃处理 + 自动重连调度 + B9 权限挂起。
//! R1 拆分自 lib.rs（行为零变化）。

use std::sync::Arc;

use crate::agent_runtime;
use crate::agent_runtime::{
    session_mapping_matches, source_for_peri_id_in_generation, AgentLifecycleStatus,
};
use crate::lifecycle::do_connect_and_replace;
use crate::permission::{parse_permission_request, permission_response};
use crate::runtime::AgentRuntime;
use crate::session::{extract_tool_file_name, value_as_string};
use crate::AppStateHandles;
use crate::{emit_event, emit_event_all};

/// 启动（或重启）通知分发器：订阅 ACP broadcast 流，把事件路由到
/// 前端（WebView 事件）与平台（gateway deliver_all），并处理崩溃/权限/宠物感知。
pub(crate) fn start_notification_dispatcher<R: tauri::Runtime>(
    handles: &AppStateHandles,
    runtime: &Arc<AgentRuntime>,
    window: tauri::WebviewWindow<R>,
) {
    if let Ok(mut task) = runtime.notification_task.lock() {
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
            use std::sync::atomic::Ordering;
            let mut rx = acp.lock().await.rx.resubscribe();
            // A7：崩溃信号独立 watch 通道——broadcast 洪泛 Lagged 时 NOTIF_AGENT_CRASHED
            // 会丢，自动重连依赖本通道（主循环 select! 双路监听，见下）。
            let mut crashed_rx = acp.lock().await.crashed_receiver();
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
                        for attempt in 1..=agent_runtime::MAX_RECONNECT_ATTEMPTS {
                            tokio::time::sleep(std::time::Duration::from_millis(
                                agent_runtime::reconnect_backoff_ms(attempt),
                            ))
                            .await;
                            // 用户已手动 reconnect（状态不再是 Crashed）→ 放弃自动重连
                            let still_stale = reconnect_runtime
                                .agent_runtime
                                .lock()
                                .map(|r| r.status == AgentLifecycleStatus::Crashed)
                                .unwrap_or(false);
                            if !still_stale {
                                // 核验修复：提前放弃也必须释放防重入标志，
                                // 否则后续崩溃将永远不再自动重连。
                                reconnect_runtime
                                    .auto_reconnect_active
                                    .store(false, Ordering::Release);
                                return;
                            }
                            // 用户已 switch 到其他 agent → 放弃（不把 active_agent 顶回）
                            let still_active = reconnect_handles
                                .active_agent
                                .lock()
                                .map(|v| v.as_str() == reconnect_agent_id)
                                .unwrap_or(false);
                            if !still_active {
                                reconnect_runtime
                                    .auto_reconnect_active
                                    .store(false, Ordering::Release);
                                return;
                            }
                            let agent = reconnect_handles
                                .agents
                                .lock()
                                .ok()
                                .and_then(|a| a.get(&reconnect_agent_id).cloned());
                            let Some(agent) = agent else {
                                reconnect_runtime
                                    .auto_reconnect_active
                                    .store(false, Ordering::Release);
                                return;
                            };
                            let _lifecycle_guard = reconnect_runtime.agent_lifecycle.lock().await;
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
                                reconnect_runtime
                                    .auto_reconnect_active
                                    .store(false, Ordering::Release);
                                return;
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
                                Ok(()) => break,
                                Err(error) => {
                                    log::warn!("auto-reconnect attempt {attempt} failed: {error}")
                                }
                            }
                        }
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
                    let Some(request_id) = raw.id else {
                        continue;
                    };
                    let Some(permission) = parse_permission_request(raw.params.as_ref()) else {
                        log::warn!("ACP request_permission 解析失败 (id={request_id})，按拒绝处理");
                        let acp = acp.lock().await;
                        let _ = acp
                            .send_response(request_id, permission_response("reject_once"))
                            .await;
                        continue;
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
                        let acp = acp.lock().await;
                        let _ = acp
                            .send_response(request_id, permission_response("allow_once"))
                            .await;
                    } else {
                        let _ = pending_permissions.lock().map(|mut pending| {
                            pending.insert(request_id, permission.clone());
                        });
                        emit_event(
                            &window,
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
                    continue;
                }
                if raw.method.as_deref() != Some(crate::acp::NOTIF_SESSION_UPDATE) {
                    continue;
                }
                let mut payload = match raw.params {
                    Some(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
                    _ => {
                        log::warn!("ACP session/update missing object params");
                        continue;
                    }
                };
                let peri_id = match payload.get("sessionId").and_then(|v| v.as_str()) {
                    Some(id) => id.to_string(),
                    None => {
                        log::warn!("ACP session/update missing sessionId");
                        continue;
                    }
                };
                let (source, session_generation) = {
                    let mut mapped = None;
                    let mut ambiguous = false;
                    for _ in 0..20 {
                        if let Ok(items) = sessions.lock() {
                            let mappings = items
                                .iter()
                                .map(|(source, info)| (source, &info.peri_id, info.generation));
                            mapped =
                                source_for_peri_id_in_generation(mappings, &peri_id, generation);
                            ambiguous = items
                                .values()
                                .filter(|info| {
                                    info.peri_id == peri_id && info.generation == generation
                                })
                                .count()
                                > 1;
                        }
                        if mapped.is_some() || ambiguous {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                    }
                    if ambiguous {
                        log::warn!(
                            "ACP notification rejected: periId {} maps to multiple local sources",
                            peri_id
                        );
                        continue;
                    }
                    let Some(mapped) = mapped else {
                        log::warn!("ACP notification for unknown session {}", peri_id);
                        continue;
                    };
                    mapped
                };
                // mapped/event 来自同一 session 映射（source/peri_id 相同），
                // 等价检查退化为 generation 一致性：session 与 dispatcher 必须同代。
                if session_generation != generation
                    || client_generation.load(Ordering::Acquire) != generation
                {
                    log::warn!("ACP notification rejected for stale session {}", peri_id);
                    continue;
                }
                let Some(update) = payload.get("update") else {
                    log::warn!("ACP session/update missing update payload");
                    continue;
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
                    continue;
                }
                if variant == Some(crate::acp::SessionUpdateVariant::AgentMessageChunk) {
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
                        // B11.2：流式收集当前回合回复文本（完成持久化 POST /persist 用）；
                        // 上限 64KB 截断防超长回复撑爆内存。审查修复：必须落在字符边界
                        // （String::truncate 在非边界处 panic，会 poison sessions 锁）。
                        if let Ok(mut items) = sessions.lock() {
                            if let Some(session) = items.get_mut(&source) {
                                session.last_response_text.push_str(text);
                                if session.last_response_text.len() > 64 * 1024 {
                                    let mut end = 64 * 1024;
                                    while end > 0
                                        && !session.last_response_text.is_char_boundary(end)
                                    {
                                        end -= 1;
                                    }
                                    session.last_response_text.truncate(end);
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
                                &window,
                                "peri:user",
                                serde_json::json!({
                                    "source": source,
                                    "content": text,
                                    "replay": is_replay,
                                }),
                            );
                        }
                    }
                    continue;
                }
                let mut mapping_current_at_mutation = false;
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
                                        if let Some(model) =
                                            meta.get("model").and_then(|v| v.as_str())
                                        {
                                            session.model = model.to_string();
                                        }
                                    }
                                    session.context_size =
                                        update.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                                    let _ = pet.lock().map(|mut p| {
                                        crate::pet::on_usage_update(&mut p, session.tokens_total)
                                    });
                                }
                                Some(crate::acp::SessionUpdateVariant::ToolCall) => {
                                    // M5 感知：title → 工具分类（吃代码/捏朋友）；rawInput 提取文件名（脱敏摘要）
                                    let title =
                                        update.get("title").and_then(|v| v.as_str()).unwrap_or("");
                                    let kind = crate::pet::ToolKind::classify(title);
                                    let _ = pet.lock().map(|mut p| {
                                        crate::pet::on_tool_started_kind(&mut p, kind)
                                    });
                                    // rawInput 仅提取文件名白名单形态（"path":"..."），原文绝不下沉
                                    if let Some(raw) =
                                        update.get("rawInput").and_then(|v| v.as_str())
                                    {
                                        if let Some(file) = extract_tool_file_name(raw) {
                                            let _ = pet.lock().map(|mut p| {
                                                crate::pet::record_code_file(&mut p, &file)
                                            });
                                        }
                                    }
                                }
                                Some(crate::acp::SessionUpdateVariant::ToolCallUpdate) => {
                                    match update.get("status").and_then(|v| v.as_str()) {
                                        Some("completed") => {
                                            let _ = pet
                                                .lock()
                                                .map(|mut p| crate::pet::on_tool_success(&mut p));
                                        }
                                        Some("failed") => {
                                            let _ = pet
                                                .lock()
                                                .map(|mut p| crate::pet::on_tool_failure(&mut p));
                                        }
                                        Some("cancelled") => {
                                            let _ = pet
                                                .lock()
                                                .map(|mut p| crate::pet::on_tool_cancelled(&mut p));
                                        }
                                        _ => {}
                                    }
                                }
                                Some(crate::acp::SessionUpdateVariant::SessionInfoUpdate) => {
                                    if let Some(title) =
                                        update.get("title").and_then(|v| v.as_str())
                                    {
                                        session.title = title.to_string();
                                    }
                                }
                                Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate) => {
                                    if let Some(options) =
                                        update.get("configOptions").and_then(|v| v.as_array())
                                    {
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
                                                    let _ = pet.lock().map(|mut p| {
                                                        crate::pet::on_model_changed(&mut p, &model)
                                                    });
                                                }
                                            }
                                            (Some("mode"), Some(mode)) => {
                                                let changed =
                                                    session.mode.as_deref() != Some(mode.as_str());
                                                session.mode = Some(mode.clone());
                                                if changed {
                                                    // M5 感知：工作模式切换
                                                    let _ = pet.lock().map(|mut p| {
                                                        crate::pet::on_mode_changed(&mut p, &mode)
                                                    });
                                                }
                                            }
                                            _ => {}
                                        }
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
                if client_generation.load(Ordering::Acquire) != generation {
                    break;
                }
                if let serde_json::Value::Object(ref mut map) = payload {
                    map.insert(
                        "source".to_string(),
                        serde_json::Value::String(source.clone()),
                    );
                }
                emit_event_all(&window, &gateway, &source, "peri:update", payload);
            }
        }));
    }
}
