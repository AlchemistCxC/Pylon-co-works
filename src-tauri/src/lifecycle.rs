//! Agent 生命周期：连接/切换/registry 命令 + MCP 配置持久化（R1 拆分自 lib.rs；行为零变化）。

use std::sync::Arc;

use crate::acp::AcpClient;
use crate::agent_config::AgentDef;
use crate::agent_runtime::{status_after_connection_failure, AgentLifecycleStatus};
use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::AppState;
use crate::AppStateHandles;
use tauri::Manager;

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
    let new_acp =
        match AcpClient::connect_with_logs(agent, Some(handles.runtime_logs.clone())).await {
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
) -> serde_json::Value {
    let available = active_id.is_some_and(|aid| id == aid)
        && active_status == Some(AgentLifecycleStatus::Connected);
    let active = active_id.is_some_and(|aid| id == aid);
    serde_json::json!({
        // list_agents 的 id 是 registry key，name 仅用于展示。
        "id": id,
        "name": agent.name,
        "transport": agent.transport,
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
        .map(|(id, a)| agent_summary_payload(id, a, Some(&active_id), Some(active_status)))
        .collect())
}

#[tauri::command]
pub(crate) async fn validate_agents() -> Result<serde_json::Value, PylonError> {
    let agents = crate::agent_config::load()?;
    let default_agent_id = crate::agent_config::default_agent_id(&agents)?;
    let summaries = agents
        .iter()
        .map(|(id, agent)| agent_summary_payload(id, agent, None, None))
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

#[tauri::command]
pub(crate) async fn set_mcp_servers<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
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
        // B4.2：配置落盘（重启不丢）。写失败只 warn，不阻断本次设置。
        persist_mcp_if_possible(&app, guard.as_deref().unwrap_or_default());
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
    let active_agent = state
        .active_agent
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    if !new_agents.contains_key(&active_agent) {
        return Err(PylonError::Protocol(format!(
            "agent config cannot remove active agent: {active_agent}"
        )));
    }
    let agent_count = new_agents.len();
    // C6：reload 删除 agent 时清理幽灵 runtime——新旧表 diff，删除且非 active 的
    // agent 在注册表替换后 abort notification_task + kill acp（防旧进程继续
    // 运行/崩溃通知复活；与 switch_agent 清理旧 runtime 同款操作）。
    let removed: Vec<String> = {
        let mut agents = state.agents.lock().map_err(|e| e.to_string())?;
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

// ── B4.2 MCP 配置持久化 ──

/// MCP 配置落盘路径：app_config_dir/pylon-mcp.json。
/// 注意：env/headers 可能含 secret，文件是本地用户配置（写盘是持久化目的），
/// 但不进任何日志/输出。
pub(crate) fn mcp_persist_path<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("pylon-mcp.json"))
}

/// 原子写 MCP 配置：临时文件 + rename，中断不留半截 JSON。
/// 写失败只 warn，不阻断主流程（尽力持久化）。
pub(crate) fn persist_mcp_if_possible<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    servers: &[crate::mcp::McpServerConfig],
) {
    let path = match mcp_persist_path(app) {
        Ok(path) => path,
        Err(error) => {
            log::warn!("resolve MCP persist path failed: {error}");
            return;
        }
    };
    let json = match serde_json::to_string(servers) {
        Ok(json) => json,
        Err(error) => {
            log::warn!("serialize MCP config failed: {error}");
            return;
        }
    };
    if let Some(parent) = path.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log::warn!("create MCP persist directory failed: {error}");
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
        log::warn!("persist MCP config failed: {error}");
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
            log::warn!("loaded MCP config invalid; ignored: {error}");
            None
        }
    }
}

// ── B9 权限审批 commands ──
// ── Session persistence commands ──

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

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
        );
        assert_eq!(disconnected["active"], true);
        assert_eq!(disconnected["available"], false, "未连接不算可用");
        let connected = agent_summary_payload(
            "peri",
            &a,
            Some("peri"),
            Some(AgentLifecycleStatus::Connected),
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
        let payload = agent_summary_payload("peri", &a, None, None);
        assert_eq!(payload["active"], false);
        assert_eq!(payload["available"], false);
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
        use crate::runtime::AgentRuntimeManager;
        use std::collections::HashMap;

        let mut agents = HashMap::new();
        agents.insert(
            "peri".to_string(),
            crate::test_utils::fake_acp_agent("peri", "print('x')"),
        );
        let runtimes = Arc::new(AgentRuntimeManager::new());
        let runtime = AgentRuntime::new_disconnected();
        *runtime.agent_runtime.lock().unwrap() = crate::agent_runtime::AgentRuntimeState {
            status: AgentLifecycleStatus::Connected,
            last_error: None,
            last_connected_at: None,
        };
        runtimes.insert("peri".into(), runtime.clone());
        let state = AppState {
            runtimes,
            agents: Arc::new(Mutex::new(agents)),
            active_agent: Arc::new(Mutex::new("peri".to_string())),
            pet: Arc::new(Mutex::new(crate::pet::PetState::default())),
            runtime_logs: crate::runtime_log::RuntimeLogHub::default(),
            runtime_mcp: Mutex::new(None),
            prism: crate::prism::PrismClient::unavailable("test".to_string()),
            gateway: Arc::new(crate::gateway::GatewayCore::new()),
            approval_mode: Arc::new(Mutex::new("default".to_string())),
            pet_last_persist_ms: std::sync::atomic::AtomicU64::new(0),
            pet_write_lock: tokio::sync::Mutex::new(()),
            switch_lock: tokio::sync::Mutex::new(()),
            mcp_write_lock: tokio::sync::Mutex::new(()),
        };
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
        use crate::runtime::AgentRuntimeManager;
        use std::collections::HashMap;

        let mut agents = HashMap::new();
        agents.insert(
            "a".to_string(),
            crate::test_utils::fake_acp_agent("a", "print('x')"),
        );
        agents.insert(
            "b".to_string(),
            crate::test_utils::fake_acp_agent("b", "print('x')"),
        );
        let runtimes = Arc::new(AgentRuntimeManager::new());
        let runtime_a = AgentRuntime::new_disconnected();
        let runtime_b = AgentRuntime::new_disconnected();
        *runtime_a.agent_runtime.lock().unwrap() = crate::agent_runtime::AgentRuntimeState {
            status: AgentLifecycleStatus::Connected,
            last_error: None,
            last_connected_at: None,
        };
        *runtime_b.agent_runtime.lock().unwrap() = crate::agent_runtime::AgentRuntimeState {
            status: AgentLifecycleStatus::Connected,
            last_error: None,
            last_connected_at: None,
        };
        runtimes.insert("a".into(), runtime_a.clone());
        runtimes.insert("b".into(), runtime_b.clone());
        let state = AppState {
            runtimes,
            agents: Arc::new(Mutex::new(agents)),
            active_agent: Arc::new(Mutex::new("a".to_string())),
            pet: Arc::new(Mutex::new(crate::pet::PetState::default())),
            runtime_logs: crate::runtime_log::RuntimeLogHub::default(),
            runtime_mcp: Mutex::new(None),
            prism: crate::prism::PrismClient::unavailable("test".to_string()),
            gateway: Arc::new(crate::gateway::GatewayCore::new()),
            approval_mode: Arc::new(Mutex::new("default".to_string())),
            pet_last_persist_ms: std::sync::atomic::AtomicU64::new(0),
            pet_write_lock: tokio::sync::Mutex::new(()),
            switch_lock: tokio::sync::Mutex::new(()),
            mcp_write_lock: tokio::sync::Mutex::new(()),
        };
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

    #[tokio::test]
    async fn reload_agents_cleans_up_ghost_runtimes_of_deleted_agents() {
        use crate::runtime::AgentRuntimeManager;
        use std::collections::HashMap;

        let dir = std::env::temp_dir().join(format!("pylon-reload-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agents.yaml");
        std::fs::write(
            &path,
            "agents:\n  keep:\n    name: Keep\n    transport: subprocess\n    exe: keep-agent\n",
        )
        .unwrap();
        let mut agents = HashMap::new();
        agents.insert(
            "keep".to_string(),
            crate::test_utils::fake_acp_agent("Keep", "print('x')"),
        );
        agents.insert(
            "remove-me".to_string(),
            crate::test_utils::fake_acp_agent("RemoveMe", "print('x')"),
        );
        let runtimes = Arc::new(AgentRuntimeManager::new());
        runtimes.insert("keep".into(), AgentRuntime::new_disconnected());
        let doomed = AgentRuntime::new_disconnected();
        runtimes.insert("remove-me".into(), doomed.clone());
        let state = AppState {
            runtimes,
            agents: Arc::new(Mutex::new(agents)),
            active_agent: Arc::new(Mutex::new("keep".to_string())),
            pet: Arc::new(Mutex::new(crate::pet::PetState::default())),
            runtime_logs: crate::runtime_log::RuntimeLogHub::default(),
            runtime_mcp: Mutex::new(None),
            prism: crate::prism::PrismClient::unavailable("test".to_string()),
            gateway: Arc::new(crate::gateway::GatewayCore::new()),
            approval_mode: Arc::new(Mutex::new("default".to_string())),
            pet_last_persist_ms: std::sync::atomic::AtomicU64::new(0),
            pet_write_lock: tokio::sync::Mutex::new(()),
            switch_lock: tokio::sync::Mutex::new(()),
            mcp_write_lock: tokio::sync::Mutex::new(()),
        };
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
