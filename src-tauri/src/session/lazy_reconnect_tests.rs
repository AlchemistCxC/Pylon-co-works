//! #379：GUI 发送/建会话前懒重连——`ensure_connected_for_send` 的触发集、
//! 幂等放行、失败传播与 `lastError` 落位回归。
//! 场景锚点：#363 连接级空闲回收（`stop_agent_runtime` → Disconnected 且不自愈）
//! 后，GUI 下一次发送必须经本入口自愈，而非 `ConnectionClosed` 硬错误。
use super::*;

/// 与 lifecycle/mod.rs 测试同形的 mock 窗口（announce 播报目标）。
async fn mock_window() -> tauri::Window<tauri::test::MockRuntime> {
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
    .as_ref()
    .window()
}

/// 触发集主案例：Disconnected runtime（真 fake agent）经懒重连拉起——
/// status=Connected、generation 前进（真实连接发生，非纸面放行）。
#[tokio::test]
async fn ensure_connected_for_send_rebuilds_disconnected_runtime() {
    let agent = crate::test_utils::fake_acp_agent("lazy-recv", &["--scenario", "alive"]);
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent.clone())
        .with_runtime("lazy-recv", runtime.clone())
        .build();
    let window = mock_window().await;
    state
        .ensure_connected_for_send(&runtime, "lazy-recv", &window)
        .await
        .expect("Disconnected runtime 必须被懒重连拉起");
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Connected,
        "重建成功后三灯必须收敛 Connected"
    );
    assert_eq!(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        1,
        "generation 必须前进（真实连接发生）"
    );
}

/// Connected 放行：不重连、不改 generation（幂等语义，与平台侧 ensure_runtime_ready 一致）。
#[tokio::test]
async fn ensure_connected_for_send_is_noop_when_connected() {
    let agent = crate::test_utils::fake_acp_agent_stub("lazy-keep");
    let runtime = crate::test_utils::connected_runtime();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent)
        .with_runtime("lazy-keep", runtime.clone())
        .build();
    let window = mock_window().await;
    state
        .ensure_connected_for_send(&runtime, "lazy-keep", &window)
        .await
        .expect("Connected 状态必须直接放行");
    assert_eq!(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        0,
        "Connected 不得触发重连（generation 不变）"
    );
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Connected
    );
}

/// #379 拍板：Crashed 不在发送路径重连——避免与 crash_reconnect 的退避序列抢
/// agent_lifecycle；放行后由既有 `is_crashed → AgentCrashed` 早退兜住。
#[tokio::test]
async fn ensure_connected_for_send_does_not_fight_crash_reconnect() {
    let agent = crate::test_utils::fake_acp_agent("lazy-crash", &["--scenario", "alive"]);
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    {
        let mut runtime_state = runtime.agent_runtime.lock().unwrap();
        runtime_state.status = AgentLifecycleStatus::Crashed;
        runtime_state.last_error = Some("ACP 进程崩溃（test）".to_string());
    }
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent)
        .with_runtime("lazy-crash", runtime.clone())
        .build();
    let window = mock_window().await;
    state
        .ensure_connected_for_send(&runtime, "lazy-crash", &window)
        .await
        .expect("Crashed 必须放行（交给 crash_reconnect + AgentCrashed 早退）");
    assert_eq!(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        0,
        "Crashed 不得在发送路径重连（generation 不变）"
    );
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Crashed,
        "状态必须保持 Crashed（自动重连的 still_stale 复查依据）"
    );
}

/// 失败传播：连接必然失败（exe 不存在）时 Err 原样上抛，status 回落
/// Disconnected（status_after_connection_failure）且 lastError 落位
/// （announce 面持久化，前端三灯 + 错误文本的数据源）。
#[tokio::test]
async fn ensure_connected_for_send_failure_propagates_and_records_last_error() {
    let mut agent = crate::test_utils::fake_acp_agent_stub("lazy-fail");
    agent.exe = std::env::temp_dir()
        .join("missing-pylon-lazy-reconnect-agent")
        .to_string_lossy()
        .to_string();
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_agent(agent)
        .with_runtime("lazy-fail", runtime.clone())
        .build();
    let window = mock_window().await;
    let error = state
        .ensure_connected_for_send(&runtime, "lazy-fail", &window)
        .await
        .expect_err("连接失败必须如实上抛（不吞）");
    assert!(!error.is_empty(), "错误文本不得为空");
    let runtime_state = runtime.agent_runtime.lock().unwrap();
    assert_eq!(
        runtime_state.status,
        AgentLifecycleStatus::Disconnected,
        "失败必须回落 Disconnected（不发明新状态）"
    );
    assert!(
        runtime_state.last_error.is_some(),
        "lastError 必须落 runtime 状态（三灯语义）"
    );
}

/// #363 场景回归：连接级空闲回收（stop_agent_runtime → Disconnected）后，
/// GUI 下一次发送路径的懒重连把 runtime 拉回 Connected——回收对用户不再表现为
/// 一次发送失败。
#[tokio::test]
async fn send_path_recovers_after_idle_reclaim_disconnected_runtime() {
    let agent = crate::test_utils::fake_acp_agent("lazy-reclaim", &["--scenario", "alive"]);
    let runtime = crate::test_utils::connected_runtime();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_active_agent("lazy-reclaim")
        .with_agent(agent.clone())
        .with_runtime("lazy-reclaim", runtime.clone())
        .build();
    // #363 回收路径：kill + 归还实例预算 + 状态置 Disconnected。
    crate::lifecycle::stop_agent_runtime("lazy-reclaim", &state).await;
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Disconnected,
        "前置：回收后 runtime 必须处于 Disconnected"
    );
    let window = mock_window().await;
    state
        .ensure_connected_for_send(&runtime, "lazy-reclaim", &window)
        .await
        .expect("回收后的 Disconnected runtime 必须能被发送路径懒重连拉起");
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Connected,
        "自愈后三灯必须收敛 Connected"
    );
    assert_eq!(
        runtime
            .client_generation
            .load(std::sync::atomic::Ordering::Acquire),
        1,
        "自愈必须发生真实连接（generation 前进）"
    );
}

/// 未知 agent：registry 查无此 agent 时报错，不得留下半途状态。
#[tokio::test]
async fn ensure_connected_for_send_unknown_agent_errors() {
    let runtime = crate::runtime::AgentRuntime::new_disconnected();
    let state = crate::test_utils::TestStateBuilder::bare()
        .with_runtime("ghost", runtime.clone())
        .build();
    let window = mock_window().await;
    let error = state
        .ensure_connected_for_send(&runtime, "ghost", &window)
        .await
        .expect_err("未知 agent 必须报错");
    assert!(error.contains("unknown agent"), "实际: {error}");
    assert_eq!(
        runtime.agent_runtime.lock().unwrap().status,
        AgentLifecycleStatus::Disconnected
    );
}
