//! Agent 生命周期：连接/切换/registry 命令 + MCP 配置持久化（R1 拆分自 lib.rs；行为零变化）。
//!
//! # R9：LifecycleOp 状态机与统一串行化
//!
//! 生命周期操作（switch / reconnect / 自动重连 / 平台懒启动）统一走
//! [`do_connect_and_replace`]，并按下表串行约束执行（C7 落地 switch_lock，
//! R9 复核全部入口后整理为显式状态机文档化）：
//!
//! | 入口 | switch_lock | agent_lifecycle | 锁后复查 | 清理 |
//! |------|------------|-----------------|---------|------|
//! | `switch_agent` | ✓ | ✓（目标 runtime） | ✓ 目标状态（C7） | ✓ stop_agent_runtime(旧 active) |
//! | `reconnect_agent` | ✓ | ✓（active runtime） | —（强制重连语义，锁已串行） | — |
//! | 自动重连（dispatcher.rs） | —（无 kill，无交叉清理面） | ✓（本 runtime） | ✓ P2-1 锁后 stale 复查 + 每轮 active 复查 | — |
//! | `ensure_runtime_ready`（平台懒启动，session.rs） | —（无 kill） | ✓（目标 runtime） | ✓ 双检查 | — |
//!
//! 状态机（状态载体 = [`AgentLifecycleStatus`]；LifecycleOp 是操作视角的命名，
//! 不引入平行枚举——状态已由该字段承载，避免双份类型漂移）：
//! `Idle(Disconnected)` → `Connecting` → `Connected`；`Connected` →
//! `Reconnecting`（手动/自动重连）→ `Connected`；`Crashed`/`Error` 是
//! 崩溃/失败终态（崩溃通知、连接失败路径进入），自动重连在 `Crashed` 上以
//! 退避序列回到 `Reconnecting` → `Connected`。
//!
//! 统一序列：**取锁**（switch_lock 串行手动操作避免交叉杀进程；agent_lifecycle
//! 串行同一 runtime 的所有连接）→ **复查**（锁后按现状决策，不盲杀在途连接）→
//! **连接**（[`do_connect_and_replace`]，四入口共用）→ **清理**（switch 停旧
//! active 进程）。锁序一致：switch_lock 先于 agent_lifecycle（switch/reconnect），
//! 无锁序反转；无 kill 的入口（自动重连/懒启动）不持 switch_lock，与持锁入口
//! 仅共享 agent_lifecycle，无死锁环。`reload_agents` 是 C6 的 registry 操作
//! （持 active runtime 的 agent_lifecycle，仅杀被移除且非 active 的 runtime，
//! 与 switch 的清理集合不相交），不在 R9 的 switch_lock 串行范围内。

use std::collections::HashMap;
use std::sync::Arc;

use futures_util::{stream, StreamExt};

use crate::acp::{AcpClient, AcpError};
use crate::agent_config::{AgentDef, ToolDictEntry};
use crate::agent_runtime::{
    status_after_connection_failure, AgentLifecycleStatus, ClientActivation, ClientEpoch,
    SessionContinuity,
};
use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::AppState;
use crate::AppStateHandles;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentConfigActivationState {
    Stored,
    PendingRestart,
    Activated,
}

fn config_activation_state(
    agent: &AgentDef,
    active: bool,
    status: Option<AgentLifecycleStatus>,
    activated_fingerprint: Option<&str>,
) -> AgentConfigActivationState {
    let live = active
        && matches!(
            status,
            Some(
                AgentLifecycleStatus::Connected
                    | AgentLifecycleStatus::Connecting
                    | AgentLifecycleStatus::Reconnecting
            )
        );
    if !live {
        return AgentConfigActivationState::Stored;
    }
    match activated_fingerprint {
        Some(fingerprint) if fingerprint == agent.runtime_fingerprint() => {
            AgentConfigActivationState::Activated
        }
        Some(_) => AgentConfigActivationState::PendingRestart,
        None => AgentConfigActivationState::Stored,
    }
}

/// 连接 + 原子替换客户端（手动/自动重连/平台懒启动共用）。
// clippy 2026-08-02：9 参为连接全参数（handles/runtime/window/agent/agent_id/start_status/
// log_action/continuity/announce），跨 4 个调用点共享签名，保持显式（结构体重构收益低）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn do_connect_and_replace<R: tauri::Runtime>(
    handles: &AppStateHandles,
    runtime: &Arc<AgentRuntime>,
    window: &tauri::WebviewWindow<R>,
    agent: &AgentDef,
    agent_id: Option<String>,
    start_status: AgentLifecycleStatus,
    log_action: &str,
    continuity: SessionContinuity,
    announce: bool,
) -> Result<(), String> {
    let previous_status = runtime
        .agent_runtime
        .lock()
        .map(|state| state.status)
        .unwrap_or(AgentLifecycleStatus::Disconnected);
    if announce {
        handles.emit_agent_status(runtime, window, start_status, None);
    }
    handles.log_runtime_summary(
        "info",
        "agent",
        agent_id.clone(),
        &format!("Agent {log_action} started"),
        serde_json::Map::new(),
    );
    let new_acp = match AcpClient::connect_with_generation(
        agent,
        Some(handles.runtime_logs.clone()),
        // OBS-02：新连接将激活为 current+1 代际（replace_agent_client 的
        // fetch_add(1)+1 一致），wire trace 据此记录 clientGeneration。
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire)
            + 1,
    )
    .await
    {
        Ok(client) => client,
        Err(error) => {
            let fallback_status = status_after_connection_failure(previous_status);
            if announce {
                handles.emit_agent_status(
                    runtime,
                    window,
                    fallback_status,
                    Some(error.to_string()),
                );
            }
            handles.log_runtime_summary(
                "error",
                "agent",
                agent_id,
                &format!("Agent {log_action} failed"),
                serde_json::Map::new(),
            );
            return Err(error.into());
        }
    };
    // 本地 client epoch 与远端 Session continuity 分开表达。Unknown 不迁移旧映射；
    // replace 后由有界 probe 收敛，Invalidated 直接清除，Preserved 才直接迁移。
    let activation = ClientActivation {
        epoch: ClientEpoch(
            runtime
                .client_generation
                .load(std::sync::atomic::Ordering::Acquire)
                .checked_add(1)
                .ok_or_else(|| "agent client generation exhausted".to_string())?,
        ),
        continuity,
    };
    tracing::debug!(
        "client activation: epoch={:?} continuity={:?} log_action={log_action}",
        activation.epoch.0,
        activation.continuity
    );
    let probe_candidates = match handles
        .replace_agent_client(runtime, agent_id, new_acp, window.clone(), activation)
        .await
    {
        Ok(candidates) => candidates,
        Err(error) => {
            // C7：replace 失败收敛——连接成功但客户端激活失败（如新 acp 已崩溃），
            // 不得停留在 start_status（Connecting/Reconnecting）卡死；广播失败
            // 状态 + 错误后返回（announce 路径才广播，事件次数不变）。
            if announce {
                handles.emit_agent_status(
                    runtime,
                    window,
                    status_after_connection_failure(previous_status),
                    Some(error.clone()),
                );
            }
            return Err(error);
        }
    };
    if let Ok(mut state) = runtime.agent_runtime.lock() {
        state.activated_config_fingerprint = Some(agent.runtime_fingerprint());
    }
    probe_unknown_session_continuity(runtime, agent, probe_candidates, activation.epoch.0).await;
    if announce {
        handles.emit_agent_status(runtime, window, AgentLifecycleStatus::Connected, None);
    }
    let _ = handles
        .pet
        .lock()
        .map(|mut p| crate::pet::on_agent_connected(&mut p));
    handles.log_runtime_summary(
        "info",
        "agent",
        None,
        &format!("Agent {log_action} succeeded"),
        serde_json::Map::new(),
    );
    Ok(())
}

const SESSION_PROBE_CONCURRENCY: usize = 4;
const SESSION_PROBE_HARD_CAP_SECS: u64 = 30;

async fn probe_unknown_session_continuity(
    runtime: &Arc<AgentRuntime>,
    agent: &AgentDef,
    candidates: Vec<crate::session_store::SessionProbeCandidate>,
    target_generation: u64,
) {
    if candidates.is_empty() {
        return;
    }
    let load_capability = runtime
        .acp
        .lock()
        .await
        .agent_capabilities()
        .and_then(|capabilities| capabilities.get("loadSession"))
        .and_then(serde_json::Value::as_bool);
    if load_capability == Some(false) {
        for candidate in candidates {
            let _ = crate::session_store::mark_detached_if_current(
                runtime,
                &candidate.source,
                &candidate.peri_id,
                candidate.from_generation,
                target_generation,
                "session-load-capability-unavailable".into(),
                false,
                false,
            );
        }
        return;
    }

    let budget = std::time::Duration::from_secs(
        agent
            .protocol()
            .rpc_timeout()
            .min(SESSION_PROBE_HARD_CAP_SECS),
    );
    let deadline = tokio::time::Instant::now() + budget;
    let mode = agent.protocol().mcp_servers;
    let results = stream::iter(candidates)
        .map(|candidate| {
            let runtime = runtime.clone();
            async move {
                let handles = runtime.acp.lock().await.replay_handles();
                let probe = tokio::time::timeout_at(
                    deadline,
                    crate::acp::load_session_with_replay(
                        handles,
                        &candidate.peri_id,
                        &candidate.cwd,
                        Vec::new(),
                        mode,
                    ),
                )
                .await;
                (candidate, probe)
            }
        })
        .buffer_unordered(SESSION_PROBE_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    for (candidate, result) in results {
        match result {
            Ok(Ok((response, _replay))) => {
                let returned_id = response
                    .get("sessionId")
                    .or_else(|| response.get("session_id"))
                    .and_then(serde_json::Value::as_str);
                if returned_id.is_some_and(|id| id != candidate.peri_id) {
                    let _ = crate::session_store::mark_detached_if_current(
                        runtime,
                        &candidate.source,
                        &candidate.peri_id,
                        candidate.from_generation,
                        target_generation,
                        "session-probe-identity-mismatch".into(),
                        false,
                        false,
                    );
                } else {
                    let _ = crate::session_store::mark_attached_if_current(
                        runtime,
                        &candidate.source,
                        &candidate.peri_id,
                        candidate.from_generation,
                        target_generation,
                    );
                }
            }
            Ok(Err(error))
                if error.rpc_failure_kind() == Some(crate::acp::RpcFailureKind::SessionMissing) =>
            {
                let _ = crate::session_store::mark_detached_if_current(
                    runtime,
                    &candidate.source,
                    &candidate.peri_id,
                    candidate.from_generation,
                    target_generation,
                    "remote-session-missing".into(),
                    false,
                    true,
                );
            }
            Ok(Err(error)) => {
                let retryable = error.is_retryable_transport_failure()
                    || error.rpc_failure_kind() == Some(crate::acp::RpcFailureKind::Other);
                let reason = match error.rpc_failure_details() {
                    Some(details) => details
                        .code
                        .map(|code| format!("session-probe-rpc-{code}"))
                        .unwrap_or_else(|| "session-probe-rpc-error".into()),
                    None if matches!(error, AcpError::ConnectionClosed) => {
                        "session-probe-connection-closed".into()
                    }
                    None => "session-probe-transport-error".into(),
                };
                let _ = crate::session_store::mark_detached_if_current(
                    runtime,
                    &candidate.source,
                    &candidate.peri_id,
                    candidate.from_generation,
                    target_generation,
                    reason,
                    retryable,
                    false,
                );
            }
            Err(_) => {
                let _ = crate::session_store::mark_detached_if_current(
                    runtime,
                    &candidate.source,
                    &candidate.peri_id,
                    candidate.from_generation,
                    target_generation,
                    "session-probe-timeout".into(),
                    true,
                    false,
                );
            }
        }
    }
}

pub(crate) fn agent_summary_payload(
    id: &str,
    agent: &AgentDef,
    active_id: Option<&str>,
    active_status: Option<AgentLifecycleStatus>,
    crashed: bool,
) -> serde_json::Value {
    agent_summary_payload_with_activation(id, agent, active_id, active_status, crashed, None)
}

fn agent_summary_payload_with_activation(
    id: &str,
    agent: &AgentDef,
    active_id: Option<&str>,
    active_status: Option<AgentLifecycleStatus>,
    crashed: bool,
    activated_fingerprint: Option<&str>,
) -> serde_json::Value {
    // 方案 3（漂移修复）：统一状态推导与 agent_status_payload 一致——
    // process_crashed 时有效状态为 crashed，available 只看有效状态是否 Connected。
    // 修复前 crashed=true, available=true 的矛盾（前端状态灯误判可用）。
    let effective_connected = !crashed && active_status == Some(AgentLifecycleStatus::Connected);
    let available = active_id.is_some_and(|aid| id == aid) && effective_connected;
    let active = active_id.is_some_and(|aid| id == aid);
    let activation = config_activation_state(
        agent,
        active,
        if crashed {
            Some(AgentLifecycleStatus::Crashed)
        } else {
            active_status
        },
        activated_fingerprint,
    );
    serde_json::json!({
        // list_agents 的 id 是 registry key，name 仅用于展示。
        "id": id,
        "name": agent.name,
        "provider": agent.provider,
        "transport": agent.transport,
        // 施工文档 §4.2：结构化表单需要 exe/default，list_agents 直接输出，
        // 不新增 get_agent_config 命令（避免 secret 出前端）。
        "exe": agent.exe.clone(),
        "args": agent.args.clone(),
        "effectiveArgs": agent.command_args(),
        "default": agent.default,
        "crashed": crashed,
        "available": available,
        "active": active,
        "cwd": agent.cwd.clone(),
        "configActivationState": activation,
    })
}

/// registry 是否包含指定 agent（switch 前置存在性检查用，不克隆）。
fn agent_exists_in_registry(state: &AppState, agent_id: &str) -> bool {
    state.agents.lock().map(|agents| agents.contains_key(agent_id)).unwrap_or(false)
}

/// 从 registry 读取指定 agent 定义（克隆）；不存在报 unknown agent（多处命令共用）。
fn agent_from_registry(state: &AppState, agent_id: &str) -> Result<AgentDef, PylonError> {
    state
        .agents
        .lock()
        .map_err(|error| error.to_string())?
        .get(agent_id)
        .cloned()
        .ok_or_else(|| PylonError::Protocol(format!("unknown agent: {agent_id}")))
}

fn stored_agent_activation(state: &AppState, agent_id: &str) -> Option<AgentConfigActivationState> {
    let agent = state.agents.lock().ok()?.get(agent_id)?.clone();
    let active = state.active_agent.lock().ok()?.as_str() == agent_id;
    let runtime = state.runtimes.get(agent_id);
    let runtime_state = runtime
        .as_ref()
        .and_then(|runtime| runtime.agent_runtime.lock().ok().map(|state| state.clone()));
    Some(config_activation_state(
        &agent,
        active,
        runtime_state.as_ref().map(|state| state.status),
        runtime_state
            .as_ref()
            .and_then(|state| state.activated_config_fingerprint.as_deref()),
    ))
}

#[tauri::command]
pub(crate) async fn list_agents(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, PylonError> {
    let active_id = state
        .active_agent
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let active_status = state
        .active_runtime()
        .and_then(|runtime| runtime.agent_runtime.lock().ok().map(|state| state.status))
        .unwrap_or(AgentLifecycleStatus::Disconnected);
    Ok(state
        .agents
        .lock()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|(id, a)| {
            // O11：crashed 感知——per-agent runtime 的 acp 是否已死
            // （try_lock：读路径不等待 acp 锁；锁被占用时视为未崩溃）。
            let runtime = state.runtimes.get(id);
            let crashed = runtime.as_ref().is_some_and(|runtime| {
                runtime
                    .acp
                    .try_lock()
                    .map(|acp| acp.is_crashed())
                    .unwrap_or(false)
            });
            let activated_fingerprint = runtime.as_ref().and_then(|runtime| {
                runtime
                    .agent_runtime
                    .lock()
                    .ok()
                    .and_then(|state| state.activated_config_fingerprint.clone())
            });
            agent_summary_payload_with_activation(
                id,
                a,
                Some(&active_id),
                Some(active_status),
                crashed,
                activated_fingerprint.as_deref(),
            )
        })
        .collect())
}

#[tauri::command]
pub(crate) async fn set_session_state(
    owner: crate::session::DurableSessionOwner,
    remote_session_id: Option<String>,
    state: serde_json::Value,
    app_state: tauri::State<'_, crate::AppState>,
) -> Result<(), crate::session::MessageError> {
    let service = crate::session::message_service_of(&app_state)?;
    service
        .set_session_state(owner, remote_session_id, state)
        .await
}

#[tauri::command]
pub(crate) async fn list_tool_dictionary() -> Result<HashMap<String, Vec<ToolDictEntry>>, PylonError>
{
    Ok(crate::agent_config::load_tool_dictionary()?)
}

#[tauri::command]
pub(crate) async fn validate_agents() -> Result<serde_json::Value, PylonError> {
    let agents = crate::agent_config::load()?;
    let default_agent_id = crate::agent_config::default_agent_id(&agents)?;
    let summaries = agents
        .iter()
        .map(|(id, agent)| agent_summary_payload(id, agent, None, None, false))
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "valid": true,
        "defaultAgentId": default_agent_id,
        "agents": summaries,
    }))
}

/// 清理被移除 agent 的幽灵 runtime（abort 通知任务 + kill + 从注册表移除）。
/// reload/update/initialize 三条配置提交路径共用（同款清理语义）。
async fn remove_stale_runtimes(inner: &AppState, removed: Vec<String>) {
    for id in removed {
        stop_agent_runtime(&id, inner).await;
        inner.runtimes.remove(&id);
    }
}

/// C7：停掉旧 runtime 的进程——先 abort notification_task（防 kill 触发的崩溃
/// 通知被旧 dispatcher 处理并调度自动重连）再 kill acp，状态置 Disconnected。
/// switch 换目标 / reload 删除 agent 共用。
async fn stop_agent_runtime(agent_id: &str, inner: &AppState) {
    if let Some(old) = inner.runtimes.get(agent_id) {
        if let Ok(mut task) = old.notification_task.lock() {
            if let Some(handle) = task.take() {
                handle.abort();
            }
        }
        // A4：清空流式通道注册——旧 runtime 的 channel 随 dispatcher 一起失效，
        // 防 kill 后残留帧投递到已被前端废弃的通道对象。
        old.clear_update_channels();
        let mut acp = old.acp.lock().await;
        let _ = acp.kill();
        drop(acp);
        if let Ok(mut state) = old.agent_runtime.lock() {
            state.status = AgentLifecycleStatus::Disconnected;
        }
    }
}

#[tauri::command]
pub(crate) async fn switch_agent<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow<R>,
    name: String,
) -> Result<(), PylonError> {
    let inner = state.inner();
    // C7：switch/reconnect 串行锁——并发 switch 不得交叉 kill 同一批旧进程。
    // R9：LifecycleOp 统一序列的"取锁"步（switch_lock → agent_lifecycle，见模块文档）。
    let _switch_guard = inner.switch_lock.lock().await;
    // P3：先查 registry 确认 agent 存在，再 get_or_create——未知 agent 直接报错，
    // 不得留下幽灵 runtime（disconnected 且永不连接的空注册项）。
    if !agent_exists_in_registry(inner, &name) {
        return Err(PylonError::Protocol(format!("unknown agent: {name}")));
    }
    // 目标 runtime 懒启动（首次切换创建 disconnected runtime）
    let runtime = inner.runtimes.get_or_create(&name);
    let previous_active = inner
        .active_agent
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
    // C7：锁后复查——目标 runtime 的生命周期锁排队期间状态可能已推进（并发
    // 连接/自动重连完成），拿到锁后按现状决策，不得盲杀在途连接。
    let target_status = runtime
        .agent_runtime
        .lock()
        .map(|state| state.status)
        .unwrap_or(AgentLifecycleStatus::Disconnected);
    let agent = agent_from_registry(inner, &name)?;
    if matches!(
        target_status,
        AgentLifecycleStatus::Connected
            | AgentLifecycleStatus::Connecting
            | AgentLifecycleStatus::Reconnecting
    ) {
        if previous_active == name {
            // 同 agent 幂等：已连接/连接中，无需重复连接。
            return Ok(());
        }
        if target_status == AgentLifecycleStatus::Connected {
            // 非 active 目标已连接：只更新 active_agent + 清理旧进程，
            // 跳过 connect_and_replace（不重复连接、不换客户端）。
            if let Ok(mut active) = inner.active_agent.lock() {
                *active = name;
            }
            stop_agent_runtime(&previous_active, inner).await;
            return Ok(());
        }
        // 目标 Connecting/Reconnecting（如自动重连在途）：继续走连接路径，
        // connect_and_replace 会在 lifecycle 锁下收敛为新客户端。
    }
    // 直接调泛型 do_connect_and_replace（与 AppState::connect_and_replace 包装器
    // 同一实现：continuity=Invalidated + announce=true）；窗口类型随调用方 Runtime。
    let handles = AppStateHandles::from_state(inner);
    do_connect_and_replace(
        &handles,
        &runtime,
        &window,
        &agent,
        Some(name.clone()),
        AgentLifecycleStatus::Connecting,
        "switch",
        SessionContinuity::Invalidated,
        true,
    )
    .await?;
    // 切到不同 agent 时：先停旧 dispatcher 再 kill 旧 acp，防止 kill 触发旧
    // runtime 的崩溃通知被旧 dispatcher 处理并调度自动重连；旧状态置 Disconnected。
    if previous_active != name {
        stop_agent_runtime(&previous_active, inner).await;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn reconnect_agent(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow,
) -> Result<(), PylonError> {
    let inner = state.inner();
    // C7：switch/reconnect 串行锁（与 switch_agent 共用，防交叉杀进程）。
    // R9：LifecycleOp 统一序列"取锁"步（switch_lock → agent_lifecycle，见模块文档）。
    let _switch_guard = inner.switch_lock.lock().await;
    let active_id = inner
        .active_agent
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let runtime = inner.runtimes.get_or_create(&active_id);
    let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
    let agent = inner.get_active_agent()?;
    inner
        .connect_and_replace(
            &runtime,
            &window,
            &agent,
            None,
            AgentLifecycleStatus::Reconnecting,
            "reconnect",
        )
        .await
        .map_err(PylonError::from)
}

#[tauri::command]
pub(crate) async fn restart_agent_runtime<R: tauri::Runtime>(
    state: tauri::State<'_, AppState>,
    window: tauri::WebviewWindow<R>,
    agent_id: String,
) -> Result<serde_json::Value, PylonError> {
    let inner = state.inner();
    let _switch_guard = inner.switch_lock.lock().await;
    let active_id = inner
        .active_agent
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    if active_id != agent_id {
        return Err(PylonError::Protocol(format!(
            "agent runtime restart requires active agent: requested {agent_id}, active {active_id}"
        )));
    }
    let runtime = inner.runtimes.get_or_create(&agent_id);
    let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
    let agent = agent_from_registry(inner, &agent_id)?;
    let handles = AppStateHandles::from_state(inner);
    do_connect_and_replace(
        &handles,
        &runtime,
        &window,
        &agent,
        None,
        AgentLifecycleStatus::Reconnecting,
        "config-restart",
        SessionContinuity::Invalidated,
        true,
    )
    .await
    .map_err(PylonError::from)?;
    Ok(serde_json::json!({
        "agentId": agent_id,
        "generation": runtime.client_generation.load(std::sync::atomic::Ordering::Acquire),
        "configActivationState": stored_agent_activation(inner, &active_id),
    }))
}

#[tauri::command]
pub(crate) async fn agent_status(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    let inner = state.inner();
    // P2-3：崩溃检测显式前置（acp 已死 → 记录 Crashed + lastError），
    // 随后 getter 只读构造 payload——响应形状（status/lastError/recentError/error）
    // 是前端契约，保持不变。
    let runtime = inner.active_runtime();
    AppStateHandles::detect_and_record_crashes(runtime.as_deref());
    Ok(inner.agent_status_payload())
}

/// OBS-01/OBS-02 读取端：返回当前 active agent 的 ACP wire 记录快照。
/// 记录器在 transport 边界持续写入（脱敏、环形 4096 条有界）；此前只有写没有读。
/// 本命令把读取路径接通，供 devtools/诊断面板后续消费。
#[tauri::command]
pub(crate) async fn acp_wire_trace_snapshot(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    let inner = state.inner();
    let runtime = inner.active_runtime().ok_or(PylonError::NoActiveAgent)?;
    let acp = runtime.acp.lock().await;
    let trace = acp
        .wire_trace()
        .ok_or_else(|| PylonError::Acp("wire trace unavailable".to_string()))?;
    Ok(serde_json::json!({
        "traceId": trace.trace_id(),
        "length": trace.len(),
        "records": trace.snapshot(),
    }))
}

pub(crate) mod config_cmds;
pub(crate) mod connection_test;
pub(crate) mod mcp;

// 拆分后的命令经此 re-export：tauri::generate_handler 与测试的 `use super::*` 路径不变。
// `__cmd__*` 是 tauri::command 宏生成的隐藏项，必须一并 re-export 才能被 generate_handler 解析。
pub(crate) use config_cmds::__tauri_command_name_agent_config_snapshot;
pub(crate) use config_cmds::__tauri_command_name_initialize_agents_config;
pub(crate) use config_cmds::__tauri_command_name_reload_agents;
pub(crate) use config_cmds::__tauri_command_name_update_agents_config;
#[allow(unused_imports)]
pub(crate) use config_cmds::__cmd__agent_config_snapshot;
#[allow(unused_imports)]
pub(crate) use config_cmds::__cmd__initialize_agents_config;
#[allow(unused_imports)]
pub(crate) use config_cmds::__cmd__reload_agents;
#[allow(unused_imports)]
pub(crate) use config_cmds::__cmd__update_agents_config;
pub(crate) use config_cmds::{
    agent_config_snapshot, initialize_agents_config, reload_agents, update_agents_config,
};
pub(crate) use connection_test::__tauri_command_name_test_agent_candidate;
pub(crate) use connection_test::__tauri_command_name_test_agent_connection;
#[allow(unused_imports)]
pub(crate) use connection_test::__cmd__test_agent_candidate;
#[allow(unused_imports)]
pub(crate) use connection_test::__cmd__test_agent_connection;
pub(crate) use connection_test::{test_agent_candidate, test_agent_connection};
#[cfg(test)]
use connection_test::connection_test_error_payload;
#[cfg(test)]
use connection_test::{candidate_stderr, AGENT_VALIDATION_TIMEOUT_SECS};
#[cfg(test)]
use crate::acp::{AgentConnectFailure, AgentConnectStage};
pub(crate) use mcp::__tauri_command_name_get_mcp_servers;
pub(crate) use mcp::__tauri_command_name_set_mcp_servers;
#[allow(unused_imports)]
pub(crate) use mcp::__cmd__get_mcp_servers;
#[allow(unused_imports)]
pub(crate) use mcp::__cmd__set_mcp_servers;
pub(crate) use mcp::{get_mcp_servers, load_mcp_persisted, set_mcp_servers};

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager;

    fn agent() -> AgentDef {
        crate::test_utils::fake_acp_agent("peri", "print('x')")
    }

    #[test]
    fn summary_marks_active_and_available_only_when_connected() {
        let a = agent();
        let disconnected = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Disconnected),
            false,
        );
        assert_eq!(disconnected["active"], true);
        assert_eq!(disconnected["available"], false, "未连接不算可用");
        let connected = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Connected),
            false,
        );
        assert_eq!(connected["available"], true, "连接后 available 才为 true");
    }

    #[test]
    fn summary_non_active_agent_is_neither_active_nor_available() {
        let a = agent();
        let payload = agent_summary_payload(
            "peri",
            &a,
            Some("hermes"),
            Some(AgentLifecycleStatus::Connected),
            false,
        );
        assert_eq!(payload["id"], "peri");
        assert_eq!(payload["name"], "peri");
        assert_eq!(payload["transport"], "subprocess");
        assert_eq!(payload["active"], false);
        assert_eq!(
            payload["available"], false,
            "非 active agent 即使有连接也不可用"
        );
    }

    #[test]
    fn summary_without_active_context_is_inactive() {
        let a = agent();
        let payload = agent_summary_payload("peri", &a, None, None, false);
        assert_eq!(payload["active"], false);
        assert_eq!(payload["available"], false);
    }

    #[test]
    fn summary_preserves_editable_args_and_reports_effective_command_args() {
        let mut a = agent();
        a.args = vec!["acp".to_string(), "work space".to_string(), String::new()];
        a.model = Some("demo".to_string());
        a.acp_args = vec!["--verbose".to_string()];

        let payload = agent_summary_payload("peri", &a, None, None, false);

        assert_eq!(
            payload["args"],
            serde_json::json!(["acp", "work space", ""])
        );
        assert_eq!(
            payload["effectiveArgs"],
            serde_json::json!(["acp", "work space", "", "--model", "demo", "--verbose"])
        );
        assert!(payload.get("env").is_none(), "summary 不得暴露环境变量");
    }

    #[test]
    fn config_activation_state_distinguishes_display_and_runtime_changes() {
        let stored = agent();
        let activated = stored.runtime_fingerprint();
        assert_eq!(
            config_activation_state(
                &stored,
                true,
                Some(AgentLifecycleStatus::Connected),
                Some(&activated),
            ),
            AgentConfigActivationState::Activated
        );

        let mut display_only = stored.clone();
        display_only.name = "renamed".into();
        display_only.default = !display_only.default;
        assert_eq!(
            config_activation_state(
                &display_only,
                true,
                Some(AgentLifecycleStatus::Connected),
                Some(&activated),
            ),
            AgentConfigActivationState::Activated
        );

        let mut changed = stored.clone();
        changed.args.push("--new-runtime-option".into());
        assert_eq!(
            config_activation_state(
                &changed,
                true,
                Some(AgentLifecycleStatus::Connected),
                Some(&activated),
            ),
            AgentConfigActivationState::PendingRestart
        );
        assert_eq!(
            config_activation_state(
                &changed,
                false,
                Some(AgentLifecycleStatus::Connected),
                Some(&activated),
            ),
            AgentConfigActivationState::Stored
        );
    }

    /// P0-1：parse 推断出的 provider 必须进入 list_agents 摘要（旧配置无 provider 也能正确分类）。
    #[test]
    fn summary_reports_resolved_provider_from_parse() {
        let path = std::env::temp_dir().join(format!(
            "pylon-agents-summary-provider-{}.yaml",
            std::process::id()
        ));
        std::fs::write(
            &path,
            "agents:\n  peri-copy:\n    name: Peri Copy\n    transport: subprocess\n    exe: peri.exe\n",
        )
        .expect("write temp agent config");
        let agents = crate::agent_config::load_from_path(&path).expect("load runtime agent config");
        std::fs::remove_file(&path).ok();
        let agent = &agents["peri-copy"];
        assert_eq!(
            agent.provider.as_deref(),
            Some("peri"),
            "解析时须按 exe 类型推断 provider"
        );
        let payload = agent_summary_payload("peri-copy", agent, None, None, false);
        assert_eq!(
            payload["provider"], "peri",
            "list_agents 摘要必须携带解析后的 provider"
        );
    }

    #[test]
    fn summary_available_follows_effective_status() {
        // 方案 3（漂移修复）：crashed=true 时 status 有效值为 crashed、available=false
        // ——与 agent_status_payload 的推导一致（修复前 crashed=true, available=true
        // 的矛盾组合，前端状态灯会误判可用）。
        let a = agent();
        let payload = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Connected),
            true,
        );
        assert_eq!(payload["crashed"], true, "crashed 必须透传");
        assert_eq!(
            payload["available"], false,
            "process_crashed 时即使 lifecycle=Connected 也不可用"
        );
        let alive = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Connected),
            false,
        );
        assert_eq!(alive["available"], true, "未崩溃 + active + Connected 可用");
        let crashed_disconnected = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Disconnected),
            true,
        );
        assert_eq!(crashed_disconnected["available"], false);
        assert_eq!(crashed_disconnected["crashed"], true);
    }

    #[test]
    fn summary_matrix_matches_agent_status_semantics() {
        // 方案 3 一致性矩阵（与 agent_status_payload 的 effective_status/available
        // 语义一致）：lifecycle + process_crashed → (status 是否 crashed, available)。
        let a = agent();
        // (lifecycle, crashed, status 是否为 crashed —— 与 agent_status_payload
        // 的 effective_status 语义参照，list_agents wire 不输出 status 字段,
        // expected_available)
        let cases: &[(AgentLifecycleStatus, bool, bool, bool)] = &[
            (AgentLifecycleStatus::Connected, false, false, true),
            (AgentLifecycleStatus::Connected, true, true, false),
            (AgentLifecycleStatus::Reconnecting, false, false, false),
            (AgentLifecycleStatus::Disconnected, false, false, false),
            (AgentLifecycleStatus::Crashed, true, true, false),
        ];
        for (lifecycle, crashed, _status_crashed, available) in cases {
            let payload =
                agent_summary_payload("peri", &a, Some("peri"), Some(*lifecycle), *crashed);
            assert_eq!(
                payload["available"],
                serde_json::Value::Bool(*available),
                "lifecycle={lifecycle:?} crashed={crashed} available 不符"
            );
            assert_eq!(payload["crashed"], serde_json::Value::Bool(*crashed));
        }
    }

    async fn mock_window() -> tauri::WebviewWindow<tauri::test::MockRuntime> {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock window must build")
    }

    #[tokio::test]
    async fn switch_to_same_agent_already_connected_is_idempotent() {
        let runtime = crate::test_utils::connected_runtime();
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(crate::test_utils::fake_acp_agent("peri", "print('x')"))
            .with_runtime("peri", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        switch_agent(
            app.state::<AppState>(),
            mock_window().await,
            "peri".to_string(),
        )
        .await
        .expect("同 agent 已连接时 switch 必须幂等成功");
        let state = app.state::<AppState>().inner();
        let runtime = state.runtimes.get("peri").expect("runtime must exist");
        assert_eq!(
            runtime
                .client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            0,
            "幂等路径不得触发 connect_and_replace（generation 不变）"
        );
        assert_eq!(
            runtime.agent_runtime.lock().unwrap().status,
            AgentLifecycleStatus::Connected,
            "目标状态必须保持 Connected"
        );
    }

    #[tokio::test]
    async fn restart_runtime_success_activates_stored_fingerprint_and_advances_generation() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("peri", script);
        let expected_fingerprint = agent.runtime_fingerprint();
        let runtime = crate::test_utils::connected_runtime();
        runtime
            .client_generation
            .store(4, std::sync::atomic::Ordering::Release);
        runtime
            .agent_runtime
            .lock()
            .unwrap()
            .activated_config_fingerprint = Some("old-definition".into());
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(agent.clone())
            .with_runtime("peri", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);

        let payload =
            restart_agent_runtime(app.state::<AppState>(), mock_window().await, "peri".into())
                .await
                .expect("restart succeeds");
        assert_eq!(payload["generation"], 5);
        assert_eq!(payload["configActivationState"], "activated");
        assert_eq!(
            runtime
                .agent_runtime
                .lock()
                .unwrap()
                .activated_config_fingerprint
                .as_deref(),
            Some(expected_fingerprint.as_str())
        );
    }

    #[tokio::test]
    async fn restart_runtime_failure_keeps_old_generation_and_pending_fingerprint() {
        let mut agent = crate::test_utils::fake_acp_agent("peri", "print('unused')");
        agent.exe = std::env::temp_dir()
            .join("missing-pylon-restart-agent")
            .to_string_lossy()
            .to_string();
        let runtime = crate::test_utils::connected_runtime();
        runtime
            .client_generation
            .store(7, std::sync::atomic::Ordering::Release);
        runtime
            .agent_runtime
            .lock()
            .unwrap()
            .activated_config_fingerprint = Some("old-definition".into());
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(agent)
            .with_runtime("peri", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);

        let error =
            restart_agent_runtime(app.state::<AppState>(), mock_window().await, "peri".into())
                .await
                .expect_err("restart must fail");
        assert_eq!(error.code(), "protocol_error");
        assert_eq!(
            runtime
                .client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            7
        );
        let state = runtime.agent_runtime.lock().unwrap();
        assert_eq!(state.status, AgentLifecycleStatus::Connected);
        assert_eq!(
            state.activated_config_fingerprint.as_deref(),
            Some("old-definition")
        );
    }

    #[tokio::test]
    async fn restart_runtime_session_migration_failure_is_atomic() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let agent = crate::test_utils::fake_acp_agent("peri", script);
        let runtime = crate::test_utils::connected_runtime();
        runtime
            .client_generation
            .store(7, std::sync::atomic::Ordering::Release);
        runtime
            .agent_runtime
            .lock()
            .unwrap()
            .activated_config_fingerprint = Some("old-definition".into());
        let sessions = runtime.sessions.clone();
        let _ = std::thread::spawn(move || {
            let _guard = sessions.lock().expect("sessions lock starts healthy");
            panic!("poison sessions lock");
        })
        .join();
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(agent)
            .with_runtime("peri", runtime.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);

        restart_agent_runtime(app.state::<AppState>(), mock_window().await, "peri".into())
            .await
            .expect_err("poisoned session migration must fail");

        assert_eq!(
            runtime
                .client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            7,
            "failed migration must not activate the candidate client"
        );
        let state = runtime.agent_runtime.lock().unwrap();
        assert_eq!(state.status, AgentLifecycleStatus::Connected);
        assert_eq!(
            state.activated_config_fingerprint.as_deref(),
            Some("old-definition")
        );
    }

    #[tokio::test]
    async fn unknown_continuity_probes_each_session_and_converges_health() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    if method == 'initialize':
        result={'agentCapabilities':{'loadSession':True}}
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':result}), flush=True)
    elif method == 'session/load':
        session_id=request.get('params',{}).get('sessionId')
        if session_id == 'remote-missing':
            print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'error':{'code':-32602,'message':'session not found'}}), flush=True)
        elif session_id != 'remote-timeout':
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'probe-replay-must-not-apply'}}}}), flush=True)
            print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{'sessionId':session_id}}), flush=True)
    else:
        print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
"#;
        let mut agent = crate::test_utils::fake_acp_agent("peri", script);
        agent.acp = Some(crate::agent_config::AcpProtocolConfig {
            rpc_timeout_secs: Some(1),
            ..Default::default()
        });
        let runtime = crate::test_utils::connected_runtime();
        runtime
            .client_generation
            .store(4, std::sync::atomic::Ordering::Release);
        for (source, remote) in [
            ("source-ok", "remote-ok"),
            ("source-missing", "remote-missing"),
            ("source-timeout", "remote-timeout"),
        ] {
            crate::session_store::insert(
                &runtime,
                source,
                crate::session::SessionInfo::new(remote.into(), String::new(), ".".into(), true, 4),
                true,
                100,
            )
            .unwrap();
        }
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("peri")
            .with_agent(agent.clone())
            .with_runtime("peri", runtime.clone())
            .build();
        let handles = AppStateHandles::from_state(&state);
        let window = mock_window().await;

        do_connect_and_replace(
            &handles,
            &runtime,
            &window,
            &agent,
            None,
            AgentLifecycleStatus::Reconnecting,
            "auto-reconnect",
            SessionContinuity::Unknown,
            false,
        )
        .await
        .expect("client reconnect succeeds even when one binding probe times out");

        let sessions = runtime.sessions.lock().unwrap();
        assert_eq!(sessions["source-ok"].generation, 5);
        assert!(
            sessions["source-ok"].last_response_text.is_empty(),
            "probe replay must be rejected before the binding becomes Attached"
        );
        assert!(!sessions.contains_key("source-missing"));
        assert_eq!(sessions["source-timeout"].generation, 4);
        drop(sessions);
        let health = runtime.binding_health.lock().unwrap();
        assert!(matches!(
            health["source-ok"],
            crate::agent_runtime::SessionBindingHealth::Attached { generation: 5 }
        ));
        assert!(matches!(
            health["source-missing"],
            crate::agent_runtime::SessionBindingHealth::Detached {
                retryable: false,
                ..
            }
        ));
        assert!(matches!(
            health["source-timeout"],
            crate::agent_runtime::SessionBindingHealth::Detached {
                retryable: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn switch_to_non_active_agent_already_connected_skips_reconnect() {
        let runtime_a = crate::test_utils::connected_runtime();
        let runtime_b = crate::test_utils::connected_runtime();
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("a")
            .with_agent(crate::test_utils::fake_acp_agent("a", "print('x')"))
            .with_agent(crate::test_utils::fake_acp_agent("b", "print('x')"))
            .with_runtime("a", runtime_a.clone())
            .with_runtime("b", runtime_b.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        switch_agent(
            app.state::<AppState>(),
            mock_window().await,
            "b".to_string(),
        )
        .await
        .expect("非 active 已连接目标 switch 必须成功");
        let state = app.state::<AppState>().inner();
        assert_eq!(
            &*state.active_agent.lock().unwrap(),
            "b",
            "active_agent 必须切到 b"
        );
        assert_eq!(
            runtime_b
                .client_generation
                .load(std::sync::atomic::Ordering::Acquire),
            0,
            "已连接目标不得被重新连接（generation 不变）"
        );
        assert_eq!(
            runtime_b.agent_runtime.lock().unwrap().status,
            AgentLifecycleStatus::Connected,
            "目标 b 必须保持 Connected"
        );
        assert_eq!(
            runtime_a.agent_runtime.lock().unwrap().status,
            AgentLifecycleStatus::Disconnected,
            "旧 active（a）必须被停掉并置 Disconnected"
        );
    }

    #[test]
    fn summary_includes_exe_and_default_for_structured_form() {
        let mut a = agent();
        a.exe = "F:/Agent/peri.exe".to_string();
        a.default = true;
        let payload = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Disconnected),
            false,
        );
        assert_eq!(payload["exe"], "F:/Agent/peri.exe");
        assert_eq!(payload["default"], true);
        assert_eq!(payload["active"], true);
    }

    #[test]
    fn connection_test_error_payload_maps_executable_missing() {
        let failure = |stage, code: &str, message: &str, retryable| {
            AcpError::Connect(AgentConnectFailure {
                stage,
                code: code.into(),
                message: message.into(),
                exit_code: None,
                stderr_excerpt: None,
                retryable,
                io_kind: None,
                remote_code: None,
                remote_data_summary: None,
            })
        };
        let payload = connection_test_error_payload(&failure(
            AgentConnectStage::Preflight,
            "agent_executable_missing",
            "missing",
            false,
        ));
        assert_eq!(payload["code"], "agent_executable_missing");
        assert_eq!(payload["action"], "select_executable");
        assert_eq!(payload["stage"], "preflight");
        assert!(payload["exitCode"].is_null());
        assert!(payload["stderr"].is_null());
        let timeout = connection_test_error_payload(&failure(
            AgentConnectStage::Initialize,
            "agent_connection_timeout",
            "timeout",
            true,
        ));
        assert_eq!(timeout["code"], "agent_connection_timeout");
        assert_eq!(timeout["stage"], "initialize");
        let spawn = connection_test_error_payload(&failure(
            AgentConnectStage::Spawn,
            "agent_spawn_failed",
            "spawn",
            false,
        ));
        assert_eq!(spawn["code"], "agent_spawn_failed");
        assert_eq!(AGENT_VALIDATION_TIMEOUT_SECS, 15);
    }

    #[test]
    fn candidate_stderr_is_bounded_and_preserves_chronological_order() {
        let logs = crate::runtime_log::RuntimeLogHub::new(8);
        for line in ["first diagnostic", "second diagnostic"] {
            logs.push(
                crate::time::Timestamp::now(),
                "error",
                "agent-stderr",
                None,
                line,
                serde_json::Map::new(),
            );
        }
        assert_eq!(
            candidate_stderr(&logs).as_deref(),
            Some("first diagnostic\nsecond diagnostic")
        );
    }

    #[tokio::test]
    async fn test_agent_candidate_native_process_returns_failure_diagnostics() {
        let agent = crate::test_utils::fake_acp_agent(
            "candidate-native-failure",
            r#"
import sys
print("Provider profile was not selected", file=sys.stderr, flush=True)
sys.exit(7)
"#,
        );
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);

        let payload = test_agent_candidate(
            app.state::<AppState>(),
            "candidate-native-failure".to_string(),
            agent,
        )
        .await
        .expect("candidate validation should return a diagnostic payload");

        assert_eq!(payload["ok"], false);
        assert_eq!(payload["error"]["code"], "agent_initialize_failed");
        assert_eq!(payload["error"]["stage"], "initialize");
        assert!(payload["error"]["exitCode"].is_null());
        assert!(payload["error"]["stderr"]
            .as_str()
            .unwrap_or_default()
            .contains("Provider profile was not selected"));
        assert!(payload["durationMs"].as_u64().unwrap_or(u64::MAX) < 15_000);
    }

    #[tokio::test]
    async fn test_agent_connection_unknown_agent_reports_error() {
        let state = crate::test_utils::TestStateBuilder::bare().build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let result = test_agent_connection(app.state::<AppState>(), "ghost".to_string()).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn update_agents_config_write_failure_keeps_memory_and_disk_unchanged() {
        // 施工文档 §2.1 必测失败链：目标文件可读但 backup replace 失败
        // → 主文件与内存 registry 都不变。
        struct EnvGuard(Option<std::ffi::OsString>);
        impl EnvGuard {
            fn set(key: &str, value: &std::path::Path) -> Self {
                let previous = std::env::var_os(key);
                std::env::set_var(key, value.as_os_str());
                Self(previous)
            }
        }
        impl Drop for EnvGuard {
            fn drop(&mut self) {
                match &self.0 {
                    Some(value) => std::env::set_var("PYLON_AGENTS_CONFIG", value),
                    None => std::env::remove_var("PYLON_AGENTS_CONFIG"),
                }
            }
        }

        let dir = std::env::temp_dir().join(format!(
            "pylon-config-write-fail-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.yaml");
        let original =
            "agents:\n  keep:\n    name: Keep\n    transport: subprocess\n    exe: keep-agent\n";
        std::fs::write(&path, original).unwrap();
        let backup_blocker = path.with_extension("yaml.bak");
        std::fs::create_dir_all(&backup_blocker).unwrap();
        let revision = crate::agent_config::config_revision_for_bytes(original.as_bytes());

        let _guard = EnvGuard::set("PYLON_AGENTS_CONFIG", &path);
        let agent = crate::test_utils::fake_acp_agent("keep", "print('x')");
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("keep")
            .with_agent(agent)
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);

        let result = update_agents_config(
            app.state::<AppState>(),
            "agent".to_string(),
            Some("keep".to_string()),
            serde_json::json!("name: Renamed\n  transport: subprocess\n  exe: keep-agent\n"),
            Some(revision),
        )
        .await;
        assert!(result.is_err(), "写盘失败必须返回错误");

        let state = app.state::<AppState>().inner();
        let agents = state.agents.lock().unwrap();
        assert_eq!(
            agents.get("keep").map(|agent| agent.name.as_str()),
            Some("keep"),
            "写盘失败后内存 registry 必须不变"
        );
        let disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(disk, original, "写盘失败后磁盘内容必须不变");

        std::fs::remove_dir_all(&backup_blocker).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn reload_agents_cleans_up_ghost_runtimes_of_deleted_agents() {
        let dir = std::env::temp_dir().join(format!("pylon-reload-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.yaml");
        std::fs::write(
            &path,
            "agents:\n  keep:\n    name: Keep\n    transport: subprocess\n    exe: keep-agent\n",
        )
        .unwrap();
        // G5-3：with_agent 以 AgentDef.name 为键——agents 键与 name 一致（"keep"/"remove-me"），
        // reload 后 agents 表整体替换为配置文件内容（name=Keep），断言不受影响。
        let doomed = AgentRuntime::new_disconnected();
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_active_agent("keep")
            .with_agent(crate::test_utils::fake_acp_agent("keep", "print('x')"))
            .with_agent(crate::test_utils::fake_acp_agent("remove-me", "print('x')"))
            .with_runtime("keep", AgentRuntime::new_disconnected())
            .with_runtime("remove-me", doomed.clone())
            .build();
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        app.manage(state);
        reload_agents(
            app.state::<AppState>(),
            Some(path.to_string_lossy().into_owned()),
        )
        .await
        .expect("reload must succeed");
        let state = app.state::<AppState>().inner();
        assert!(
            state.runtimes.get("keep").is_some(),
            "保留 agent 的 runtime 必须还在"
        );
        assert!(
            state.runtimes.get("remove-me").is_none(),
            "删除 agent 的幽灵 runtime 必须被清理"
        );
        assert_eq!(
            doomed.agent_runtime.lock().unwrap().status,
            AgentLifecycleStatus::Disconnected,
            "被清理 runtime 的状态必须置回 Disconnected"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
