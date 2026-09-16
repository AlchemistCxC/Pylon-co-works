//! #110 F5：会话建立期的模型事实落 canonical journal。
//!
//! 验收（2026-09-17 裁决后的数据层断言）：会话建立后 journal 新增一条
//! `session.model-updated`，且取值符合「agent 显式 > profile.model」优先级。
//!
//! agent 侧行为：`pylon-fake-agent --scenario set-config-option`（session/new 宣告
//! configOptions 的 model 选项 currentValue=m-1）。

use prism_desktop_lib::test_harness::{HarnessConfig, TestHarness};

const OWNER_KEY: &str = r#"["profile-f5","f5-agent","local:f5"]"#;

async fn boot() -> TestHarness {
    TestHarness::boot(HarnessConfig::new().with_fake_agent(
        "f5-agent",
        &[
            "--scenario",
            "set-config-option",
            "--mode",
            "echo-empty",
            "--session-id",
            "f5-session",
        ],
    ))
    .await
}

/// 建立期必须把生效模型写进 journal（模型事实由 journal 拥有，不靠一次性事件）。
#[tokio::test]
async fn new_session_journals_established_model_fact() {
    let harness = boot().await;
    harness
        .new_session("f5-agent", "local:f5", "profile-f5", "persona", Some("."))
        .await
        .expect("session must be created");

    let session = harness
        .session_model_state("local:f5")
        .await
        .expect("session slot exists");
    assert_eq!(
        session.model.as_deref(),
        Some("m-1"),
        "建立响应宣告的 current model 必须进入会话模型面"
    );

    let rows = harness.journal_json(OWNER_KEY, 50).await;
    let model_events: Vec<&serde_json::Value> = rows
        .iter()
        .filter(|row| {
            row.get("eventType").and_then(|value| value.as_str()) == Some("session.model-updated")
        })
        .collect();
    assert_eq!(
        model_events.len(),
        1,
        "建立期必须恰好落一条 session.model-updated，实际 journal：{rows:#?}"
    );
    assert_eq!(
        model_events[0]
            .pointer("/typedPayload/model")
            .and_then(|value| value.as_str()),
        Some("m-1"),
        "模型取值必须等于建立期解析出的生效模型"
    );
}
