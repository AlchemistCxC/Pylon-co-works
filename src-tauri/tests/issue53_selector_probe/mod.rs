//! #53/#51：选择器面全套——空态探测 + 建立期/恢复期 configOptions 落 canonical journal。
//!
//! agent 侧行为：
//! - `pylon-fake-agent --scenario set-config-option`（session/new 宣告
//!   `model-selection`（category=model，m-1/m-2）与 `reasoning_effort`
//!   （category=thought_level，low/high）两个选项）。
//! - `--scenario revive-load --advertise-models <JSON>`（session/load 按旗标回
//!   任意响应体，此处携带同一份 configOptions envelope）。
//!
//! 验收：探测返回完整模型面且不落会话槽位；建立/恢复各恰好落一条
//! `session.config-updated`（rawPayload 携带完整 envelope，前端重放据此恢复
//! `document.session.options`，即 #51 的「重启后选择器消失」根因修复）。

use prism_desktop_lib::test_harness::{HarnessConfig, TestHarness};

fn selector_boot() -> HarnessConfig {
    HarnessConfig::new().with_fake_agent(
        "selector-agent",
        &[
            "--scenario",
            "set-config-option",
            "--mode",
            "echo-empty",
            "--session-id",
            "selector-session",
        ],
    )
}

/// #53：探测返回 Agent 广告的完整选择器面（模型面 configId + choices + current，
/// 含 thought_level 选项），configOptions 原样透传。
#[tokio::test]
async fn probe_returns_advertised_selector_surface() {
    let harness = TestHarness::boot(selector_boot()).await;

    let snapshot = harness
        .probe_agent_selectors("selector-agent")
        .await
        .expect("probe must succeed against a session-capable agent");

    assert_eq!(
        snapshot
            .pointer("/modelSurface/kind")
            .and_then(|v| v.as_str()),
        Some("config_option"),
        "模型面必须是标准 config option 通道：{snapshot:#?}"
    );
    assert_eq!(
        snapshot
            .pointer("/modelSurface/configId")
            .and_then(|v| v.as_str()),
        Some("model-selection"),
        "必须保留广告的真实 config id，不得降级成语义键 model"
    );
    let choices: Vec<&str> = snapshot["modelChoices"]
        .as_array()
        .expect("modelChoices array")
        .iter()
        .filter_map(|v| v.as_str())
        .collect();
    assert_eq!(choices, vec!["m-1", "m-2"]);
    assert_eq!(
        snapshot.pointer("/currentModel").and_then(|v| v.as_str()),
        Some("m-1")
    );
    let option_ids: Vec<&str> = snapshot["configOptions"]
        .as_array()
        .expect("configOptions array")
        .iter()
        .filter_map(|o| o.get("id").and_then(|v| v.as_str()))
        .collect();
    assert_eq!(option_ids, vec!["model-selection", "reasoning_effort"]);
}

/// #51：建立期必须把完整 configOptions 落 journal（`session.config-updated`），
/// rawPayload 携带标准 `session/update` 形状——前端重放据此恢复中控区选择器。
#[tokio::test]
async fn new_session_journals_selector_surface() {
    let harness = TestHarness::boot(selector_boot()).await;
    harness
        .new_session(
            "selector-agent",
            "local:f53",
            "profile-f53",
            "persona",
            Some("."),
        )
        .await
        .expect("session must be created");

    let owner = TestHarness::owner_key("profile-f53", "selector-agent", "local:f53");
    let rows = harness.journal_json(&owner, 50).await;
    let selector_rows: Vec<&serde_json::Value> = rows
        .iter()
        .filter(|row| {
            row.get("eventType").and_then(|value| value.as_str()) == Some("session.config-updated")
        })
        .collect();
    assert_eq!(
        selector_rows.len(),
        1,
        "建立期必须恰好落一条 session.config-updated，实际 journal：{rows:#?}"
    );
    let options = selector_rows[0]
        .pointer("/rawPayload/update/configOptions")
        .and_then(|value| value.as_array())
        .expect("rawPayload 必须保留标准 session/update 形状的 configOptions");
    let ids: Vec<&str> = options
        .iter()
        .filter_map(|o| o.get("id").and_then(|v| v.as_str()))
        .collect();
    assert_eq!(ids, vec!["model-selection", "reasoning_effort"]);
}

/// #51：恢复期（session/load）同样落选择器事实——重启后打开历史会话时
/// journal 重放即恢复选择器，不依赖 agent 再次主动 push。
#[tokio::test]
async fn load_persisted_session_journals_selector_surface() {
    let mut load_result = serde_json::json!({ "sessionId": "load-session" });
    load_result["configOptions"] = serde_json::json!([
        {"id": "model-selection", "category": "model",
         "options": [{"valueId": "m-1", "name": "One"}, {"valueId": "m-2", "name": "Two"}],
         "currentValue": "m-1"},
        {"id": "reasoning_effort", "category": "thought_level",
         "options": [{"valueId": "low"}, {"valueId": "high"}],
         "currentValue": "low"}
    ]);
    let harness = TestHarness::boot(HarnessConfig::new().with_fake_agent(
        "load-selector-agent",
        &[
            "--scenario",
            "revive-load",
            "--advertise-models",
            &load_result.to_string(),
        ],
    ))
    .await;

    harness
        .load_persisted_session(
            "profile-load",
            "load-selector-agent",
            "local:load53",
            "remote-load53",
            Some("."),
        )
        .await
        .expect("persisted session load must succeed");

    let owner = TestHarness::owner_key("profile-load", "load-selector-agent", "local:load53");
    let rows = harness.journal_json(&owner, 50).await;
    let selector_rows: Vec<&serde_json::Value> = rows
        .iter()
        .filter(|row| {
            row.get("eventType").and_then(|value| value.as_str()) == Some("session.config-updated")
        })
        .collect();
    assert_eq!(
        selector_rows.len(),
        1,
        "恢复期必须恰好落一条 session.config-updated，实际 journal：{rows:#?}"
    );
    let ids: Vec<String> = selector_rows[0]
        .pointer("/rawPayload/update/configOptions")
        .and_then(|value| value.as_array())
        .expect("raw configOptions")
        .iter()
        .filter_map(|o| o.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .collect();
    assert!(ids.contains(&"model-selection".to_string()));
    assert!(ids.contains(&"reasoning_effort".to_string()));
}
