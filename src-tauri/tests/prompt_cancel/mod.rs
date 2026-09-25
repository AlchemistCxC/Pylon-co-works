//! #324：用户主动停止（cancel）→ 中性结算 E2E。
//!
//! fake agent `prompt-cancel-respond`：prompt 挂起，cancel 后对原 prompt id 回
//! `stopReason=cancelled`（ACP 规范对 session/cancel 的标准回包）。断言三面：
//! ① `send_message` 命令返回 Ok（旧路径为 Err("prompt cancelled")）；
//! ② journal 只落 `done` update、无 `error` update（旧路径 error → turn.failed）；
//! ③ done update 携带 `stopReason: "cancelled"`（前端凭此呈现「已停止」，
//!    `GenerationFooter` reason='cancelled' 分支 / 账本摘要 `cancelled` 映射）。

use prism_desktop_lib::test_harness::{HarnessConfig, TestHarness};
use std::time::Duration;

/// 递归收集对象树里全部 `{"sessionUpdate": kind}` 载荷（与行内字段形状解耦：
/// typedPayload/rawPayload 的包裹层级不是本切片的被测契约）。
fn collect_updates(value: &serde_json::Value, found: &mut Vec<(String, serde_json::Value)>) {
    match value {
        serde_json::Value::Object(map) => {
            if let Some(kind) = map.get("sessionUpdate").and_then(|v| v.as_str()) {
                found.push((kind.to_string(), value.clone()));
            }
            for item in map.values() {
                collect_updates(item, found);
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|item| collect_updates(item, found)),
        _ => {}
    }
}

#[tokio::test]
async fn user_cancel_settles_via_done_channel_not_error() {
    let harness = TestHarness::boot(HarnessConfig::new().with_fake_agent(
        "cancel-agent",
        &[
            "--scenario",
            "prompt-cancel-respond",
            "--session-id",
            "cancel-session",
        ],
    ))
    .await;

    // send_message 挂在 prompt 终态上，cancel 侧并发推进；join! 共享借用即可。
    let (send_result, cancel_result) = tokio::join!(
        async {
            harness
                .send_message("cancel-agent", "local:cancel", Some("profile-1"), "hello", "")
                .await
        },
        async {
            // 等 send_message 完成 session/new 并进入 prompt 等待窗
            // （first-token 预算远大于此，不会抢先触发判死）。
            tokio::time::sleep(Duration::from_millis(400)).await;
            harness.cancel_prompt("cancel-agent", "local:cancel").await
        }
    );
    cancel_result.expect("cancel must send session/cancel");
    let peri_id = send_result.expect("cancelled prompt must settle Ok via done channel (#324)");
    let _ = peri_id;

    let owner = TestHarness::owner_key("profile-1", "cancel-agent", "local:cancel");
    let events = harness.journal_json(&owner, 50).await;
    let mut updates = Vec::new();
    for row in &events {
        collect_updates(row, &mut updates);
    }
    let kinds: Vec<&str> = updates.iter().map(|(kind, _)| kind.as_str()).collect();
    assert!(
        !kinds.contains(&"error"),
        "cancelled turn must not commit an error update; got {kinds:?}"
    );
    assert!(
        kinds.contains(&"done"),
        "cancelled turn must commit a done update; got {kinds:?}"
    );
    assert!(
        updates
            .iter()
            .any(|(kind, update)| kind == "done"
                && update.get("stopReason") == Some(&serde_json::json!("cancelled"))),
        "done update must carry stopReason=cancelled"
    );
}
