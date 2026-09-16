//! #106 P5：b11 inject/persist/replay 端到端（自 lib 内嵌形态迁入，装配经
//! test_harness 门面，断言逐条保持——验收 8）。
//!
//! 覆盖：journal 落盘次序（user/done 同事务）、prompt 错误同事务提交、
//! 完整 replay 导入、/inject 注入上下文与 round 推进、注入禁用/不可用/命令
//! 消息跳过、persist(prism) round 携带流式回复。
//! 纯逻辑单测（compose_inject_prompt/inject_applies_to/extract_tool_file_name）
//! 留在 lib `session::mod` tests——不属于集成形态。

use prism_desktop_lib::test_harness::{HarnessConfig, TestHarness};
use std::time::Duration;

/// /inject 桩应答（应答字节对齐原自拷桩——Content-Length = body 的 UTF-8 字节数）。
const INJECT_STUB_RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 67\r\nConnection: close\r\n\r\n{\"context\":\"\xe6\xb3\xa8\xe5\x85\xa5\xe4\xb8\x8a\xe4\xb8\x8b\xe6\x96\x87\",\"activated\":[\"uid-1\"],\"source\":\"vein\"}";

/// trace 中 session/prompt 请求的首条文本（wire 证据源回读）。
fn inject_prompt_text(trace_path: &std::path::Path) -> String {
    let trace = std::fs::read_to_string(trace_path).expect("read trace");
    let request: serde_json::Value = trace
        .lines()
        .map(|line| serde_json::from_str(line).expect("trace line"))
        .find(|value: &serde_json::Value| {
            value.get("method").and_then(|m| m.as_str()) == Some("session/prompt")
        })
        .expect("prompt request must be traced");
    request["params"]["prompt"][0]["text"]
        .as_str()
        .expect("prompt text")
        .to_string()
}

fn trace_args(trace_path: &std::path::Path) -> Vec<String> {
    [
        "--trace-file",
        &trace_path.to_string_lossy(),
        "--trace-mode",
        "prompt-only",
    ]
    .iter()
    .map(|value| value.to_string())
    .collect()
}

#[tokio::test]
async fn gui_prompt_persists_user_and_done_before_publishing_terminal_state() {
    let trace_path = TestHarness::temp_file("b11-prompt-ingest").with_extension("jsonl");
    let mut args: Vec<&str> = vec![
        "--scenario",
        "stream",
        "--session-id",
        "fake-inject-session",
    ];
    for arg in trace_args(&trace_path) {
        args.push(Box::leak(arg.into_boxed_str()));
    }
    let harness =
        TestHarness::boot(HarnessConfig::new().with_fake_agent("fake-acp-trace", &args)).await;

    harness
        .send_message(
            "fake-acp-trace",
            "local:kernel-prompt",
            Some("profile-1"),
            "hello durable",
            "",
        )
        .await
        .expect("prompt must send");

    let owner = TestHarness::owner_key("profile-1", "fake-acp-trace", "local:kernel-prompt");
    let events = harness.journal_json(&owner, 10).await;
    let types: Vec<&str> = events
        .iter()
        .map(|event| event["eventType"].as_str().expect("eventType"))
        .collect();
    // #81 L2：kernel 终结写入时同事务追加 turn.unit（保序 segment 单元行）
    assert_eq!(types, vec!["user.message", "turn.completed", "turn.unit"]);
    assert_eq!(events[0]["typedPayload"]["text"], "hello durable");
    assert_eq!(events[0]["sequence"], 1);
    assert_eq!(events[1]["sequence"], 2);

    std::fs::remove_file(&trace_path).ok();
}

#[tokio::test]
async fn gui_prompt_failure_is_committed_after_user_in_the_same_journal() {
    let trace_path = TestHarness::temp_file("b11-prompt-failure").with_extension("jsonl");
    let harness = TestHarness::boot(HarnessConfig::new().with_fake_agent(
        "fake-acp-trace",
        &[
            "--scenario",
            "prompt-error",
            "--session-id",
            "fake-inject-session",
            "--prompt-error",
            "provider unavailable",
        ],
    ))
    .await;
    // trace 旗标走原始 argv（含动态路径）
    let _ = trace_args(&trace_path);

    let error = harness
        .send_message(
            "fake-acp-trace",
            "local:kernel-failure",
            Some("profile-1"),
            "will fail",
            "",
        )
        .await
        .expect_err("prompt must fail");
    assert!(error.contains("provider unavailable"));

    let owner = TestHarness::owner_key("profile-1", "fake-acp-trace", "local:kernel-failure");
    let events = harness.journal_json(&owner, 10).await;
    let types: Vec<&str> = events
        .iter()
        .map(|event| event["eventType"].as_str().expect("eventType"))
        .collect();
    assert_eq!(types, vec!["user.message", "turn.failed", "turn.unit"]);
    assert_eq!(
        events[1]["typedPayload"]["error"],
        "ACP protocol: \"RPC error: {\\\"code\\\":-32000,\\\"message\\\":\\\"provider unavailable\\\"}\""
    );
    assert_eq!(events[1]["typedPayload"]["code"], "protocol_error");

    std::fs::remove_file(&trace_path).ok();
}

#[tokio::test]
async fn complete_session_load_replay_is_imported_into_the_empty_kernel_journal() {
    let trace_path = TestHarness::temp_file("b11-replay-import").with_extension("jsonl");
    let harness = TestHarness::boot(HarnessConfig::new().with_fake_agent(
        "fake-acp-trace",
        &[
            "--scenario",
            "replay-load",
            "--session-id",
            "fake-inject-session",
            "--trace-file",
            &trace_path.to_string_lossy(),
            "--trace-mode",
            "prompt-only",
        ],
    ))
    .await;

    let result = harness
        .load_persisted_session(
            "profile-1",
            "fake-acp-trace",
            "local:replay-import",
            "remote-replay",
            Some("."),
        )
        .await
        .expect("complete replay load");
    assert_eq!(result["canonicalRevision"], 2);
    assert_eq!(result["replayJournalStatus"], "imported");
    assert_eq!(result["authority"], "recovery-import");
    assert_eq!(result["journalCoverage"], "unverified-import");
    assert_eq!(result["collection"]["complete"], true);

    let owner = TestHarness::owner_key("profile-1", "fake-acp-trace", "local:replay-import");
    let events = harness.journal_json(&owner, 10).await;
    let types: Vec<&str> = events
        .iter()
        .map(|event| event["eventType"].as_str().expect("eventType"))
        .collect();
    assert_eq!(types, vec!["user.message", "assistant.text.delta"]);
    assert_eq!(events[0]["typedPayload"]["text"], "old question");

    std::fs::remove_file(&trace_path).ok();
}

#[tokio::test]
async fn inject_prepends_context_and_advances_round_per_message() {
    let responses: &'static [&'static [u8]] =
        Box::leak(vec![INJECT_STUB_RESPONSE, INJECT_STUB_RESPONSE].into_boxed_slice());
    let (address, request_rx, server) = TestHarness::http_stub(responses);
    let trace_path = TestHarness::temp_file("b11-trace").with_extension("jsonl");
    let harness = TestHarness::boot(
        HarnessConfig::new()
            .with_fake_agent(
                "fake-acp-trace",
                &[
                    "--scenario",
                    "stream",
                    "--session-id",
                    "fake-inject-session",
                    "--trace-file",
                    &trace_path.to_string_lossy(),
                    "--trace-mode",
                    "prompt-only",
                ],
            )
            .with_gateway_yaml(
                r#"
gateway:
  inject:
    scenario: trpg
    sources: [vein]
"#,
            )
            .with_prism_stub(&format!("http://{address}"), Some("test-token")),
    )
    .await;

    harness
        .send_message("fake-acp-trace", "source-b11", None, "你好", "")
        .await
        .expect("first message must send");
    assert_eq!(inject_prompt_text(&trace_path), "注入上下文\n\n你好");
    let first_request = String::from_utf8(
        request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first inject request"),
    )
    .expect("request UTF-8");
    let first_body: serde_json::Value = first_request
        .split("\r\n\r\n")
        .nth(1)
        .expect("body")
        .parse()
        .expect("body JSON");
    assert_eq!(first_body["scenario"], "trpg");
    assert_eq!(first_body["sources"], serde_json::json!(["vein"]));
    assert_eq!(first_body["user_msg"], "你好");
    assert_eq!(first_body["round"], 0);

    harness
        .send_message("fake-acp-trace", "source-b11", None, "继续", "")
        .await
        .expect("second message must send");
    let second_request = String::from_utf8(
        request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("second inject request"),
    )
    .expect("request UTF-8");
    let second_body: serde_json::Value = second_request
        .split("\r\n\r\n")
        .nth(1)
        .expect("body")
        .parse()
        .expect("body JSON");
    assert_eq!(second_body["round"], 1);
    assert_eq!(second_body["user_msg"], "继续");

    server.join().expect("stub thread");
    std::fs::remove_file(&trace_path).ok();
}

#[tokio::test]
async fn inject_disabled_passes_plain_text_through() {
    let responses: &'static [&'static [u8]] =
        Box::leak(vec![INJECT_STUB_RESPONSE].into_boxed_slice());
    let (address, request_rx, server) = TestHarness::http_stub(responses);
    let trace_path = TestHarness::temp_file("b11-disabled").with_extension("jsonl");
    let harness = TestHarness::boot(
        HarnessConfig::new()
            .with_fake_agent(
                "fake-acp-trace",
                &[
                    "--scenario",
                    "stream",
                    "--session-id",
                    "fake-inject-session",
                    "--trace-file",
                    &trace_path.to_string_lossy(),
                    "--trace-mode",
                    "prompt-only",
                ],
            )
            .with_gateway_yaml(
                r#"
gateway:
  inject:
    enabled: false
"#,
            )
            .with_prism_stub(&format!("http://{address}"), Some("t")),
    )
    .await;

    harness
        .send_message("fake-acp-trace", "source-b11-off", None, "你好", "")
        .await
        .expect("message must send");
    assert_eq!(inject_prompt_text(&trace_path), "你好");
    assert!(request_rx.try_recv().is_err(), "禁用注入时不得调用 /inject");
    server.join().expect("stub thread");
    std::fs::remove_file(&trace_path).ok();
}

#[tokio::test]
async fn inject_unavailable_degrades_without_injection() {
    let trace_path = TestHarness::temp_file("b11-unavailable").with_extension("jsonl");
    let harness = TestHarness::boot(
        HarnessConfig::new()
            .with_fake_agent(
                "fake-acp-trace",
                &[
                    "--scenario",
                    "stream",
                    "--session-id",
                    "fake-inject-session",
                    "--trace-file",
                    &trace_path.to_string_lossy(),
                    "--trace-mode",
                    "prompt-only",
                ],
            )
            .with_gateway_yaml(
                r#"
gateway:
  inject:
    enabled: true
"#,
            ),
    )
    .await;

    harness
        .send_message("fake-acp-trace", "source-b11-ua", None, "你好", "")
        .await
        .expect("message must send without injection");
    assert_eq!(inject_prompt_text(&trace_path), "你好");
    std::fs::remove_file(&trace_path).ok();
}

#[tokio::test]
async fn command_message_skips_injection() {
    let responses: &'static [&'static [u8]] =
        Box::leak(vec![INJECT_STUB_RESPONSE].into_boxed_slice());
    let (address, request_rx, server) = TestHarness::http_stub(responses);
    let trace_path = TestHarness::temp_file("b11-cmd").with_extension("jsonl");
    let harness = TestHarness::boot(
        HarnessConfig::new()
            .with_fake_agent(
                "fake-acp-trace",
                &[
                    "--scenario",
                    "stream",
                    "--session-id",
                    "fake-inject-session",
                    "--trace-file",
                    &trace_path.to_string_lossy(),
                    "--trace-mode",
                    "prompt-only",
                ],
            )
            .with_gateway_yaml(
                r#"
gateway:
  inject:
    enabled: true
"#,
            )
            .with_prism_stub(&format!("http://{address}"), Some("t")),
    )
    .await;

    harness
        .send_message("fake-acp-trace", "source-b11-cmd", None, "/status", "")
        .await
        .expect("command message must send");
    assert_eq!(inject_prompt_text(&trace_path), "/status");
    assert!(request_rx.try_recv().is_err(), "命令消息不得触发 /inject");
    server.join().expect("stub thread");
    std::fs::remove_file(&trace_path).ok();
}

#[tokio::test]
async fn persist_prism_mode_sends_round_with_streamed_response() {
    let responses: &'static [&'static [u8]] =
        Box::leak(vec![INJECT_STUB_RESPONSE, INJECT_STUB_RESPONSE].into_boxed_slice());
    let trace_path = TestHarness::temp_file("b11-persist").with_extension("jsonl");
    let (address, request_rx, server) = TestHarness::http_stub(responses);
    let harness = TestHarness::boot(
        HarnessConfig::new()
            .with_fake_agent(
                "fake-acp-trace",
                &[
                    "--scenario",
                    "stream",
                    "--session-id",
                    "fake-inject-session",
                    "--prompt-chunk",
                    "回复文本",
                    "--prompt-delay-ms",
                    "200",
                    "--trace-file",
                    &trace_path.to_string_lossy(),
                    "--trace-mode",
                    "prompt-only",
                ],
            )
            .with_gateway_yaml(
                r#"
gateway:
  inject:
    enabled: true
    scenario: trpg
    persist: prism
"#,
            )
            .with_prism_stub(&format!("http://{address}"), Some("test-token")),
    )
    .await;
    // dispatcher：流式收集回复文本（persist 依赖）——boot 已自动启动。

    harness
        .send_message("fake-acp-trace", "source-b11-persist", None, "你好", "")
        .await
        .expect("message must send");

    // 第一个请求 = /inject（round 0）
    let first = String::from_utf8(
        request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("inject request"),
    )
    .expect("request UTF-8");
    assert!(first.starts_with("POST /inject HTTP/1.1"));
    // 第二个请求 = /persist（round 0 + 流式回复文本）
    let second = String::from_utf8(
        request_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("persist request"),
    )
    .expect("request UTF-8");
    assert!(second.starts_with("POST /persist HTTP/1.1"));
    let body: serde_json::Value = second
        .split("\r\n\r\n")
        .nth(1)
        .expect("body")
        .parse()
        .expect("body JSON");
    assert_eq!(body["scenario"], "trpg");
    assert_eq!(body["user_msg"], "你好");
    assert_eq!(body["response"], "回复文本");
    assert_eq!(body["round"], 0);

    server.join().expect("stub thread");
    std::fs::remove_file(&trace_path).ok();
}
