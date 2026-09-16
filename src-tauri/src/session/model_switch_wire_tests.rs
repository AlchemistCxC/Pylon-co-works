//! #97（通用 ACP 模型选择器与切换闭环）wire 级集成测试——**P5 回退保留片**。
//!
//! #106 P5 已将本文件 8 测中的 7 测迁入 `tests/model_switch/`（经 test_harness
//! 门面）；`rebind_on_other_runtime_starts_with_clean_selector_snapshot` 依 spec
//! 回退条款**保留 lib 内嵌**：它需要同时持有两个 runtime 的会话快照做白盒比对
//! （per-runtime sessions 的 model_surface/choices/config_options 逐字段断言），
//! 门面窄值视图无法承载——强迁等于暴露 AppState 字段级访问，违反 spec P5
//! 「内部一律不加 pub」约束（dev record 有同步记录）。

use super::*;
use crate::acp::AcpClient;
use crate::agent_config::{AcpProtocolConfig, SetModelApi};
use crate::test_utils::TestStateBuilder;
use tauri::Manager;

/// 验收（跨 runtime/Agent 重绑不泄漏）：同一 source 在不同 Agent runtime 上重建
/// 会话时，新 selector snapshot 不得沿用旧 Agent 的 config id/model id/choices。
#[tokio::test]
async fn rebind_on_other_runtime_starts_with_clean_selector_snapshot() {
    let mut agent_a = crate::test_utils::fake_acp_agent(
        "rebind-a",
        &[
            "--scenario",
            "set-config-option",
            "--mode",
            "echo-empty",
            "--session-id",
            "ms-session",
        ],
    );
    agent_a.acp = Some(AcpProtocolConfig {
        set_model_api: Some(SetModelApi::ConfigOption),
        ..Default::default()
    });
    let agent_b = crate::test_utils::fake_acp_agent(
        "rebind-b",
        &["--scenario", "empty", "--session-id", "empty-session"],
    );
    let runtime_a = AgentRuntime::new_disconnected();
    *runtime_a.acp.lock().await = AcpClient::connect_with_logs(&agent_a, None)
        .await
        .expect("fake ACP must initialize");
    let runtime_b = AgentRuntime::new_disconnected();
    *runtime_b.acp.lock().await = AcpClient::connect_with_logs(&agent_b, None)
        .await
        .expect("fake ACP must initialize");
    let state = TestStateBuilder::bare()
        .with_active_agent("rebind-a")
        .with_agent(agent_a)
        .with_agent(agent_b)
        .with_runtime("rebind-a", runtime_a.clone())
        .with_runtime("rebind-b", runtime_b.clone())
        .build();
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app must build");
    app.manage(state);

    // runtime A：带模型目录的会话。
    new_session(
        app.state::<AppState>(),
        "rebind-a".to_string(),
        "local:rebind".to_string(),
        "profile-ms".to_string(),
        "persona".to_string(),
        Some(".".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("session must be created");
    // runtime B：同一 source 重建（不同 agent、无模型宣告）。
    new_session(
        app.state::<AppState>(),
        "rebind-b".to_string(),
        "local:rebind".to_string(),
        "profile-ms".to_string(),
        "persona".to_string(),
        Some(".".to_string()),
        None,
        None,
        None,
        None,
        None,
    )
    .await
    .expect("session must be created");

    let snapshot_b = runtime_b
        .sessions
        .lock()
        .unwrap()
        .get("local:rebind")
        .cloned()
        .unwrap();
    assert_eq!(
        snapshot_b.model_surface,
        ModelSurface::None,
        "新 owner 空面"
    );
    assert!(
        snapshot_b.model_choices.is_empty(),
        "旧 Agent choices 不得泄漏"
    );
    assert_eq!(snapshot_b.model, "", "旧 Agent model id 不得泄漏");
    assert!(
        !serde_json::to_string(&snapshot_b.config_options)
            .unwrap()
            .contains("model-selection"),
        "旧 Agent config id 不得泄漏：{:?}",
        snapshot_b.config_options
    );
    // runtime A 的会话不受影响（per-runtime sessions 隔离）。
    let snapshot_a = runtime_a
        .sessions
        .lock()
        .unwrap()
        .get("local:rebind")
        .cloned()
        .unwrap();
    assert_eq!(
        snapshot_a.model_surface,
        ModelSurface::ConfigOption {
            config_id: "model-selection".to_string()
        }
    );
}
