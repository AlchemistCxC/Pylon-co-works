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

use crate::acp::AcpClient;
use crate::agent_config::{AgentDef, ToolDictEntry};
use crate::agent_runtime::{
    client_activation_for_action, status_after_connection_failure, AgentLifecycleStatus,
};
use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::AppState;
use crate::AppStateHandles;

/// 连接 + 原子替换客户端（手动/自动重连/平台懒启动共用）。
// clippy 2026-08-02：9 参为连接全参数（handles/runtime/window/agent/agent_id/start_status/
// log_action/keep_sessions/announce），跨 4 个调用点共享签名，保持显式（结构体重构收益低）。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn do_connect_and_replace<R: tauri::Runtime>(
    handles: &AppStateHandles,
    runtime: &Arc<AgentRuntime>,
    window: &tauri::WebviewWindow<R>,
    agent: &AgentDef,
    agent_id: Option<String>,
    start_status: AgentLifecycleStatus,
    log_action: &str,
    keep_sessions: bool,
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
    // 方案 9（首期只观测）：显式记录远端 session 延续性语义——不再把
    // keep_sessions 混同"远端 session 仍有效"。auto-reconnect → Unknown
    // （仍按 keep_sessions=true 迁移，仅标记待验证）；手动 switch/reconnect →
    // Invalidated。只打日志，不改变任何行为（不进前端 wire）。
    let activation = client_activation_for_action(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        log_action,
    );
    tracing::debug!(
        "client activation: epoch={:?} continuity={:?} keep_sessions={keep_sessions} log_action={log_action}",
        activation.epoch.0,
        activation.continuity
    );
    if let Err(error) = handles
        .replace_agent_client(runtime, agent_id, new_acp, window.clone(), keep_sessions)
        .await
    {
        // C7：replace 失败收敛——连接成功但客户端激活失败（如新 acp 已崩溃），
        // 不得停留在 start_status（Connecting/Reconnecting）卡死；广播失败
        // 状态 + 错误后返回（announce 路径才广播，事件次数不变）。
        if announce {
            handles.emit_agent_status(
                runtime,
                window,
                AgentLifecycleStatus::Disconnected,
                Some(error.clone()),
            );
        }
        return Err(error);
    }
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

pub(crate) fn agent_summary_payload(
    id: &str,
    agent: &AgentDef,
    active_id: Option<&str>,
    active_status: Option<AgentLifecycleStatus>,
    crashed: bool,
) -> serde_json::Value {
    // 方案 3（漂移修复）：统一状态推导与 agent_status_payload 一致——
    // process_crashed 时有效状态为 crashed，available 只看有效状态是否 Connected。
    // 修复前 crashed=true, available=true 的矛盾（前端状态灯误判可用）。
    let effective_connected = !crashed && active_status == Some(AgentLifecycleStatus::Connected);
    let available = active_id.is_some_and(|aid| id == aid) && effective_connected;
    let active = active_id.is_some_and(|aid| id == aid);
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
    })
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
            let crashed = state.runtimes.get(id).is_some_and(|runtime| {
                runtime
                    .acp
                    .try_lock()
                    .map(|acp| acp.is_crashed())
                    .unwrap_or(false)
            });
            agent_summary_payload(id, a, Some(&active_id), Some(active_status), crashed)
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
    if !inner
        .agents
        .lock()
        .map_err(|error| error.to_string())?
        .contains_key(&name)
    {
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
    let agent = inner
        .agents
        .lock()
        .map_err(|error| error.to_string())?
        .get(&name)
        .ok_or_else(|| format!("unknown agent: {name}"))?
        .clone();
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
    // 同一实现：keep_sessions=false + announce=true）；窗口类型随调用方 Runtime。
    let handles = AppStateHandles::from_state(inner);
    do_connect_and_replace(
        &handles,
        &runtime,
        &window,
        &agent,
        Some(name.clone()),
        AgentLifecycleStatus::Connecting,
        "switch",
        false,
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

/// 返回当前 agent 级暴露的 MCP server 配置（cwd 设置据此选择启用哪些）。
#[tauri::command]
pub(crate) async fn get_mcp_servers(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<crate::mcp::McpServerConfig>, PylonError> {
    state
        .inner()
        .current_mcp_servers()
        .map_err(PylonError::Protocol)
}

#[tauri::command]
pub(crate) async fn set_mcp_servers(
    state: tauri::State<'_, AppState>,
    servers: Option<Vec<crate::mcp::McpServerConfig>>,
) -> Result<Vec<serde_json::Value>, String> {
    // O13：单次 clone（validate 消耗 clone，原值 move 进 runtime_mcp；
    // persist 在锁内借用 guard——原实现 serialized/persisted 两次 clone）。
    let serialized = crate::mcp::validate_and_serialize(servers.clone())?;
    // C8：写 runtime_mcp + 落盘全程持写序锁——并发 set_mcp_servers 串行，
    // 磁盘必为最后一次设置（重启不回滚到旧配置）。
    let _mcp_write_guard = state.inner().mcp_write_lock.lock().await;
    {
        let mut guard = state
            .runtime_mcp
            .lock()
            .map_err(|error| error.to_string())?;
        *guard = servers;
        // P1（E10）：wire 缓存与 runtime_mcp 同锁写入（读路径 miss 时回退重算并回填）。
        if let Ok(mut cache) = state.inner().mcp_wire.lock() {
            *cache = Some(serialized.clone());
        }
        // B4.2：配置落盘（重启不丢）。写失败只 warn，不阻断本次设置。
        persist_mcp_if_possible(&state, guard.as_deref().unwrap_or_default());
    }
    Ok(serialized)
}

#[tauri::command]
pub(crate) async fn reload_agents(
    state: tauri::State<'_, AppState>,
    config_path: Option<String>,
) -> Result<(), PylonError> {
    let runtime = state.inner().require_runtime()?;
    let _lifecycle_guard = runtime.agent_lifecycle.lock().await;
    let new_agents = if let Some(path) = config_path {
        crate::agent_config::load_from_path(std::path::Path::new(&path))?
    } else {
        crate::agent_config::load()?
    };
    crate::agent_config::default_agent_id(&new_agents)?;
    // O12：config 读（read_to_string + parse）在锁外完成（load_from_path/load
    // 在取得 agents 锁之前执行）；active 存在性检查 + 新旧表 diff + 原子替换
    // 合并为单次持锁操作——无"检查通过但替换未完成"的中间态。
    let agent_count = new_agents.len();
    let removed: Vec<String> = {
        let active_agent = state
            .active_agent
            .lock()
            .map_err(|error| error.to_string())?
            .clone();
        let mut agents = state.agents.lock().map_err(|e| e.to_string())?;
        if !new_agents.contains_key(&active_agent) {
            return Err(PylonError::Protocol(format!(
                "agent config cannot remove active agent: {active_agent}"
            )));
        }
        // C6：reload 删除 agent 时清理幽灵 runtime——新旧表 diff，删除且非 active 的
        // agent 在注册表替换后 abort notification_task + kill acp（防旧进程继续
        // 运行/崩溃通知复活；与 switch_agent 清理旧 runtime 同款操作）。
        let removed = agents
            .keys()
            .filter(|id| !new_agents.contains_key(*id) && **id != active_agent)
            .cloned()
            .collect();
        *agents = new_agents;
        removed
    };
    for id in removed {
        stop_agent_runtime(&id, state.inner()).await;
        state.inner().runtimes.remove(&id);
    }
    state.inner().log_runtime_summary(
        "info",
        "agent",
        None,
        "Agent registry reloaded",
        serde_json::Map::from_iter([(
            "agentCount".to_string(),
            serde_json::Value::from(agent_count),
        )]),
    );
    Ok(())
}

/// Phase 3：update_agents_config（意见稿 §5.1 显式 scope 契约，用户拍板）。
///
/// scope="agent"：config 为 agent 整块 YAML 字符串（agentId 必填）；
/// scope="gateway"：config 为 `{ gateway: { routes: [...] } }` JSON。
/// 事务（§5.3.B）：写序锁 → embedded 只读检查 → 读当前 → 生成候选 → 双域校验 +
/// active agent 保护（写盘前）→ 原子写盘 → 内存提交（agents 域刷新 + 幽灵 runtime
/// 清理对齐 reload_agents；gateway 域 reload，失败报 config_not_applied）。
#[tauri::command]
pub(crate) async fn update_agents_config(
    state: tauri::State<'_, AppState>,
    scope: String,
    agent_id: Option<String>,
    config: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    use crate::agent_config::ConfigError;
    let inner = state.inner();
    // 写序锁：读当前→生成候选→校验→写盘→内存提交全程串行，防基于旧版本互相覆盖
    let _write_guard = inner.config_write_lock.lock().await;
    // 1. 来源检查：embedded 无外部写入目标 → config_read_only（绝不 fallback 当前目录）
    let path = crate::agent_config::effective_config_path()
        .ok_or(PylonError::Config(ConfigError::ReadOnly))?;
    // 2. 读当前原文（tokio::fs 异步读，不阻塞 async 运行时）
    let content = tokio::fs::read_to_string(&path).await.map_err(|error| {
        PylonError::Config(ConfigError::Read(format!(
            "读取 {} 失败: {error}",
            path.display()
        )))
    })?;
    // 3. 生成候选 + 双域校验 + 解析 agents（同步 YAML/fs，spawn_blocking；base_dir 绝对化）
    let scope_owned = scope.clone();
    let agent_id_owned = agent_id.clone();
    let config_owned = config.clone();
    let base_dir = path.parent().map(|p| p.to_path_buf());
    let candidate = tokio::task::spawn_blocking(move || {
        let candidate = match scope_owned.as_str() {
            "agent" => {
                let agent_id = agent_id_owned
                    .ok_or_else(|| ConfigError::Invalid("scope=agent 缺少 agentId".to_string()))?;
                let patch_yaml = config_owned.as_str().ok_or_else(|| {
                    ConfigError::Invalid("scope=agent 的 config 必须为 YAML 字符串".to_string())
                })?;
                crate::agent_config::apply_agent_patch(&content, &agent_id, patch_yaml)?
            }
            "agent_fields" => {
                let agent_id = agent_id_owned.ok_or_else(|| {
                    ConfigError::Invalid("scope=agent_fields 缺少 agentId".to_string())
                })?;
                crate::agent_config::apply_agent_field_patch(&content, &agent_id, &config_owned)?
            }
            "agent_create" => {
                let agent_id = agent_id_owned.ok_or_else(|| {
                    ConfigError::Invalid("scope=agent_create 缺少 agentId".to_string())
                })?;
                crate::agent_config::apply_agent_create(&content, &agent_id, &config_owned)?
            }
            "gateway" => crate::agent_config::apply_gateway_patch(&content, &config_owned)?,
            other => return Err(ConfigError::Invalid(format!("未知 scope: {other}"))),
        };
        let agents = crate::agent_config::validate_candidate(&candidate, base_dir.as_deref())?;
        Ok::<
            (
                String,
                std::collections::HashMap<String, crate::agent_config::AgentDef>,
            ),
            ConfigError,
        >((candidate, agents))
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;
    let (candidate, new_agents) = candidate;
    crate::agent_config::default_agent_id(&new_agents)?;
    // 4. active agent 保护（写盘前，只读不写）：候选不得删除当前 active agent；
    // 同时计算 removed diff，供写盘成功后再清理（施工文档 §2.1）。
    let removed: Vec<String> = {
        let active = inner.active_agent.lock().map_err(|e| e.to_string())?;
        let agents = inner.agents.lock().map_err(|e| e.to_string())?;
        if !new_agents.contains_key(&*active) {
            return Err(PylonError::Config(ConfigError::ActiveAgentProtected(
                format!("候选配置删除了当前 active agent: {}", *active),
            )));
        }
        agents
            .keys()
            .filter(|id| !new_agents.contains_key(*id) && **id != *active)
            .cloned()
            .collect()
    };
    // 5. 原子写盘（替换语义）。先落盘、后提交内存：写盘失败时 registry 不变
    // （施工文档 §2.1 必测失败链）。
    let write_content = candidate.clone();
    let write_path = path.clone();
    tokio::task::spawn_blocking(move || {
        crate::agent_config::write_config_atomically(&write_path, &write_content)
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;
    // 6. 磁盘成功后提交内存 registry（与 reload_agents 的原子替换同语义）。
    {
        let mut agents = inner.agents.lock().map_err(|e| e.to_string())?;
        *agents = new_agents;
    }
    // 7. 幽灵 runtime 清理（与 reload_agents 同款：abort + kill + 移除）
    for id in removed {
        stop_agent_runtime(&id, inner).await;
        inner.runtimes.remove(&id);
    }
    // 8. gateway 域提交（scope=gateway 才需要；失败=磁盘已写但未生效 → config_not_applied）
    if scope == "gateway" {
        let gateway_config = crate::gateway::route::parse_config(&candidate).map_err(|e| {
            PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
        })?;
        inner.gateway.reload(gateway_config).map_err(|e| {
            PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
        })?;
    }
    inner.log_runtime_summary(
        "info",
        "config",
        None,
        &format!("Config updated (scope={scope})"),
        serde_json::Map::from_iter([(
            "scope".to_string(),
            serde_json::Value::String(scope.clone()),
        )]),
    );
    // 9. 返回摘要（不返回完整敏感配置）
    let agent_count = inner.agents.lock().map(|a| a.len()).unwrap_or(0);
    Ok(serde_json::json!({
        "applied": true,
        "scope": scope,
        "agentCount": agent_count,
    }))
}

// ── 施工文档 Phase 2：首次外部配置初始化 + 连接测试 ──

/// embedded → exe 旁 `agents.yaml` 的首次外部配置初始化（施工文档 §4.6）。
/// 只允许当前 source 为 Embedded 时执行；目标固定 exe 同目录 `agents.yaml`，
/// 不写 `data/agents.yaml`，不写 AppData。走与 `update_agents_config` 相同的
/// 候选校验、原子写盘、内存提交与 gateway reload。
#[tauri::command]
pub(crate) async fn initialize_agents_config(
    state: tauri::State<'_, AppState>,
    agent_id: Option<String>,
    config: serde_json::Value,
) -> Result<serde_json::Value, PylonError> {
    use crate::agent_config::ConfigError;
    let inner = state.inner();
    let _write_guard = inner.config_write_lock.lock().await;

    // 1. 仅 embedded source 允许初始化（已有外部配置时直接走 update_agents_config）
    if crate::agent_config::effective_config_path().is_some() {
        return Err(PylonError::Config(ConfigError::ReadOnly));
    }
    let exe_dir = std::env::current_exe()
        .map_err(|error| PylonError::Io(format!("resolve current_exe failed: {error}")))?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| PylonError::Io("current_exe has no parent".to_string()))?;
    let target = exe_dir.join("agents.yaml");

    // 2. 候选生成 + 双域校验（base_dir = exe 目录；同步 YAML/fs 移出 async 运行时）
    let content_owned = if config.get("agents").is_some() {
        crate::agent_config::serialize_agents_document(&config)?
    } else if config.is_object() {
        let requested_id = agent_id.as_deref().ok_or_else(|| {
            PylonError::Config(ConfigError::Invalid("结构化初始化缺少 agentId".to_string()))
        })?;
        let current = crate::agent_config::read_config_document()?;
        crate::agent_config::apply_agent_field_patch(&current.content, requested_id, &config)?
    } else {
        return Err(PylonError::Config(ConfigError::Invalid(
            "initialize_agents_config 的 config 必须为结构化 agents document 或字段 patch"
                .to_string(),
        )));
    };
    let base_dir = exe_dir.clone();
    let candidate = tokio::task::spawn_blocking(move || {
        let agents = crate::agent_config::validate_candidate(&content_owned, Some(&base_dir))?;
        Ok::<
            (
                String,
                std::collections::HashMap<String, crate::agent_config::AgentDef>,
            ),
            ConfigError,
        >((content_owned, agents))
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;
    let (candidate, new_agents) = candidate;
    let default_agent_id = crate::agent_config::default_agent_id(&new_agents)?.unwrap_or_default();
    if let Some(requested_id) = agent_id.as_deref() {
        if !new_agents.contains_key(requested_id) {
            return Err(PylonError::Config(ConfigError::Invalid(format!(
                "初始化配置不包含 agentId: {requested_id}"
            ))));
        }
    }

    // 3. 原子写盘（先磁盘）
    let write_content = candidate.clone();
    let write_path = target.clone();
    tokio::task::spawn_blocking(move || {
        crate::agent_config::write_config_atomically(&write_path, &write_content)
    })
    .await
    .map_err(|error| PylonError::Io(error.to_string()))??;

    // 4. 磁盘成功后提交内存（embedded → external；active 不在新配置时切到新默认）
    let removed: Vec<String> = {
        let mut agents = inner.agents.lock().map_err(|e| e.to_string())?;
        let mut active = inner.active_agent.lock().map_err(|e| e.to_string())?;
        let removed = agents
            .keys()
            .filter(|id| !new_agents.contains_key(*id))
            .cloned()
            .collect();
        *agents = new_agents;
        if !agents.contains_key(&*active) {
            *active = default_agent_id.clone();
        }
        removed
    };
    // 5. 清理被移除的旧 runtime（与 reload_agents 同款）
    for id in removed {
        stop_agent_runtime(&id, inner).await;
        inner.runtimes.remove(&id);
    }
    // 6. gateway 域提交（配置文档已通过双域校验；reload 失败 → config_not_applied）
    let gateway_config = crate::gateway::route::parse_config(&candidate).map_err(|e| {
        PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
    })?;
    inner.gateway.reload(gateway_config).map_err(|e| {
        PylonError::Config(ConfigError::NotApplied(format!("gateway reload 失败: {e}")))
    })?;

    inner.log_runtime_summary(
        "info",
        "config",
        None,
        "Agent config initialized to external file",
        serde_json::Map::from_iter([
            (
                "scope".to_string(),
                serde_json::Value::String("initialize".to_string()),
            ),
            (
                "agentCount".to_string(),
                serde_json::Value::from(inner.agents.lock().map(|a| a.len()).unwrap_or(0)),
            ),
        ]),
    );
    Ok(serde_json::json!({
        "applied": true,
        "scope": "initialize",
        "agentCount": inner.agents.lock().map(|a| a.len()).unwrap_or(0),
        "defaultAgentId": inner.active_agent.lock().map(|a| a.clone()).unwrap_or_default(),
    }))
}

/// 连接测试错误码映射（施工文档 §5.2）：不在 ACP 内部大改错误体系，
/// 在 lifecycle 出口按已知错误文案/上下文映射稳定 code。
const AGENT_VALIDATION_TIMEOUT_SECS: u64 = 15;

fn connection_test_stage(error: &str) -> &'static str {
    if error.contains("exe 路径不存在") {
        "preflight"
    } else if error.contains("ACP") || error.contains("RPC") {
        "initialize"
    } else {
        "spawn"
    }
}

fn connection_test_error_payload_with_diagnostics(
    error: &str,
    stderr: Option<&str>,
    exit_code: Option<i32>,
) -> serde_json::Value {
    let (code, action) = if error.contains("exe 路径不存在") {
        ("agent_executable_missing", "select_executable")
    } else if error.contains("ACP write timeout") || error.contains("RPC timeout") {
        ("agent_connection_timeout", "open-runtime-log")
    } else if error.contains("ACP connection closed") {
        ("agent_initialize_failed", "open-runtime-log")
    } else {
        ("agent_spawn_failed", "open-runtime-log")
    };
    serde_json::json!({
        "code": code,
        "message": error,
        "action": action,
        "stage": connection_test_stage(error),
        "exitCode": exit_code,
        "stderr": stderr,
    })
}

fn connection_test_error_payload(error: &str) -> serde_json::Value {
    connection_test_error_payload_with_diagnostics(error, None, None)
}

fn candidate_stderr(logs: &crate::runtime_log::RuntimeLogHub) -> Option<String> {
    let lines = logs
        .list(&crate::runtime_log::RuntimeLogQuery {
            source: Some("agent-stderr".to_string()),
            limit: Some(16),
            ..Default::default()
        })
        .into_iter()
        .rev()
        .map(|entry| entry.message)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return None;
    }
    let joined = lines.join("\n");
    Some(joined.chars().take(4096).collect())
}

async fn settle_candidate_stderr(started: std::time::Instant) {
    // stdout/RPC 关闭与 stderr reader 在不同异步任务中收敛。只使用握手总预算内
    // 尚未消耗的极短窗口，避免错误返回抢在最后一行安全诊断之前，同时保证命令
    // 从开始到返回仍不超过 15 秒的候选验证上限。
    let remaining = std::time::Duration::from_secs(AGENT_VALIDATION_TIMEOUT_SECS)
        .saturating_sub(started.elapsed());
    let settle = remaining.min(std::time::Duration::from_millis(50));
    if !settle.is_zero() {
        tokio::time::sleep(settle).await;
    }
}

/// 隔离连接测试（施工文档 §4.5）：复用 ACP connect 做一次真实握手，成功后立即
/// kill 子进程。不修改 active agent、不写 runtimes registry、不触发 agent-switched。
#[tauri::command]
pub(crate) async fn test_agent_connection(
    state: tauri::State<'_, AppState>,
    agent_id: String,
) -> Result<serde_json::Value, PylonError> {
    let inner = state.inner();
    let agent = inner
        .agents
        .lock()
        .map_err(|e| e.to_string())?
        .get(&agent_id)
        .cloned()
        .ok_or_else(|| PylonError::Protocol(format!("unknown agent: {agent_id}")))?;

    let started = std::time::Instant::now();
    // 施工文档 §4.5：后端用 tokio::time::timeout 包裹整个 connect；禁止无限等待。
    let timeout_secs = AGENT_VALIDATION_TIMEOUT_SECS;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        AcpClient::connect_with_generation(&agent, Some(inner.runtime_logs.clone()), 0),
    )
    .await;
    let duration_ms = started.elapsed().as_millis() as u64;

    match result {
        Ok(Ok(mut client)) => {
            let _ = client.kill();
            Ok(serde_json::json!({
                "ok": true,
                "agentId": agent_id,
                "durationMs": duration_ms,
                "error": null,
            }))
        }
        Ok(Err(error)) => Ok(serde_json::json!({
            "ok": false,
            "agentId": agent_id,
            "durationMs": duration_ms,
            "error": connection_test_error_payload(&error.to_string()),
        })),
        Err(_elapsed) => Ok(serde_json::json!({
            "ok": false,
            "agentId": agent_id,
            "durationMs": duration_ms,
            "error": {
                "code": "agent_connection_timeout",
                "message": format!("连接测试超时（{timeout_secs}s）"),
                "action": "open-runtime-log",
                "stage": "timeout",
                "exitCode": null,
                "stderr": null,
            },
        })),
    }
}

/// Candidate validation is isolated like test_agent_connection, but consumes an ephemeral
/// definition and never writes agents.yaml or mutates the runtime registry.
#[tauri::command]
pub(crate) async fn test_agent_candidate(
    _state: tauri::State<'_, AppState>,
    agent_id: String,
    agent: AgentDef,
) -> Result<serde_json::Value, PylonError> {
    let started = std::time::Instant::now();
    let timeout_secs = AGENT_VALIDATION_TIMEOUT_SECS;
    // 候选验证使用隔离日志池：既能返回该次握手的安全 stderr，又不污染运行时日志。
    let diagnostic_logs = crate::runtime_log::RuntimeLogHub::new(64);
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        AcpClient::connect_with_generation(&agent, Some(diagnostic_logs.clone()), 0),
    )
    .await;
    match result {
        Ok(Ok(mut client)) => {
            let _ = client.kill();
            let duration_ms = started.elapsed().as_millis() as u64;
            Ok(
                serde_json::json!({ "ok": true, "agentId": agent_id, "durationMs": duration_ms, "error": null }),
            )
        }
        Ok(Err(error)) => {
            settle_candidate_stderr(started).await;
            let duration_ms = started.elapsed().as_millis() as u64;
            let stderr = candidate_stderr(&diagnostic_logs);
            Ok(serde_json::json!({
                "ok": false,
                "agentId": agent_id,
                "durationMs": duration_ms,
                "error": connection_test_error_payload_with_diagnostics(&error.to_string(), stderr.as_deref(), None),
            }))
        }
        Err(_) => {
            let duration_ms = started.elapsed().as_millis() as u64;
            Ok(
                serde_json::json!({ "ok": false, "agentId": agent_id, "durationMs": duration_ms, "error": { "code": "agent_connection_timeout", "message": format!("连接测试超时（{timeout_secs}s）"), "action": "open-runtime-log", "stage": "timeout", "exitCode": null, "stderr": candidate_stderr(&diagnostic_logs) } }),
            )
        }
    }
}

// ── B4.2 MCP 配置持久化 ──

/// MCP 配置落盘路径（统一从 AppState 的一次性 DataDirs 取）。
/// 注意：env/headers 可能含 secret，文件是本地用户配置（写盘是持久化目的），
/// 但不进任何日志/输出。
pub(crate) fn mcp_persist_path(state: &AppState) -> Result<std::path::PathBuf, String> {
    Ok(crate::paths::mcp_persist_path(state.data_dirs()?))
}

/// 原子写 MCP 配置：临时文件 + rename，中断不留半截 JSON。
/// 写失败只 warn，不阻断主流程（尽力持久化）。
pub(crate) fn persist_mcp_if_possible(state: &AppState, servers: &[crate::mcp::McpServerConfig]) {
    let path = match mcp_persist_path(state) {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!("resolve MCP persist path failed: {error}");
            return;
        }
    };
    let json = match serde_json::to_string(servers) {
        Ok(json) => json,
        Err(error) => {
            tracing::warn!("serialize MCP config failed: {error}");
            return;
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            tracing::warn!("create MCP persist directory failed: {error}");
            return;
        }
    }
    // 审查修复：唯一 temp（pid+时间戳）——并发 set_mcp_servers 不得互相截断写坏
    let unique = path.with_file_name(format!(
        ".{}.{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("mcp"),
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0),
    ));
    let result = (|| {
        std::fs::write(&unique, json.as_bytes())
            .map_err(|error| format!("write temporary MCP config failed: {error}"))?;
        std::fs::rename(&unique, &path)
            .map_err(|error| format!("commit MCP config failed: {error}"))
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&unique);
        tracing::warn!("persist MCP config failed: {error}");
    }
}

/// 加载 MCP 持久化配置：文件缺失/损坏 → None（启动时静默降级为空配置）。
/// 内容过 validate_and_serialize（防手改文件注入非法配置）——校验失败视为损坏。
pub(crate) fn load_mcp_persisted(
    path: &std::path::Path,
) -> Option<Vec<crate::mcp::McpServerConfig>> {
    let raw = std::fs::read_to_string(path).ok()?;
    let servers: Vec<crate::mcp::McpServerConfig> = serde_json::from_str(&raw).ok()?;
    match crate::mcp::validate_and_serialize(Some(servers.clone())) {
        Ok(_) => Some(servers),
        Err(error) => {
            tracing::warn!("loaded MCP config invalid; ignored: {error}");
            None
        }
    }
}

// ── B9 权限审批 commands ──
// ── Session persistence commands ──

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
        let payload = connection_test_error_payload(
            "agent peri 的 exe 路径不存在：F:/x.exe（请在 设置 → Agent 中修改 agents.yaml 配置）",
        );
        assert_eq!(payload["code"], "agent_executable_missing");
        assert_eq!(payload["action"], "select_executable");
        assert_eq!(payload["stage"], "preflight");
        assert!(payload["exitCode"].is_null());
        assert!(payload["stderr"].is_null());
        let timeout = connection_test_error_payload("RPC timeout after 30s");
        assert_eq!(timeout["code"], "agent_connection_timeout");
        assert_eq!(timeout["stage"], "initialize");
        let spawn = connection_test_error_payload("CreateProcess failed: 2");
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
        // 施工文档 §2.1 必测失败链：目标文件可读但原子写失败（用目录占住
        // write_config_atomically 的固定临时文件名）→ 磁盘与内存 registry 都不变。
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
        // 占住 write_config_atomically 的固定临时文件路径（目录同名）→ File::create 失败。
        let temp_blocker = dir.join(format!(".agents.yaml.tmp-{}", std::process::id()));
        std::fs::create_dir_all(&temp_blocker).unwrap();

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

        std::fs::remove_dir_all(&temp_blocker).ok();
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
