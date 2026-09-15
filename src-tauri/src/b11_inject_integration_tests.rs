use super::*;

use crate::gateway::route;
use crate::session::EventService;
use std::time::Duration;

/// 记录收到 session/prompt 请求的 fake ACP（P1 后为 bin 场景 + trace 旗标）。
/// 可选流式 chunk——先发 agent_message_chunk 再响应 stopReason（延迟 0.2s 让
/// dispatcher 先收集回复文本）；错误注入与回放装载见 [`trace_acp_agent_error`] /
/// [`trace_acp_agent_replay`]。
fn trace_acp_agent(trace_path: &std::path::Path, chunk: bool) -> AgentDef {
    let mut args: Vec<String> = [
        "--scenario",
        "stream",
        "--session-id",
        "fake-inject-session",
        "--trace-file",
        &trace_path.to_string_lossy(),
        "--trace-mode",
        "prompt-only",
    ]
    .iter()
    .map(|value| value.to_string())
    .collect();
    if chunk {
        args.push("--prompt-chunk".into());
        args.push("回复文本".into());
        args.push("--prompt-delay-ms".into());
        args.push("200".into());
    }
    let mut agent = crate::test_utils::fake_acp_agent("fake-acp-trace", &[]);
    agent.args = args;
    agent
}

/// 错误注入变体：prompt 回 JSON-RPC error（-32000）。
fn trace_acp_agent_error(trace_path: &std::path::Path, message: &str) -> AgentDef {
    crate::test_utils::fake_acp_agent(
        "fake-acp-trace",
        &[
            "--scenario",
            "prompt-error",
            "--session-id",
            "fake-inject-session",
            "--prompt-error",
            message,
            "--trace-file",
            &trace_path.to_string_lossy(),
            "--trace-mode",
            "prompt-only",
        ],
    )
}

/// 回放装载变体：session/load 先发两条历史 chunk 再回 loaded:true。
fn trace_acp_agent_replay(trace_path: &std::path::Path) -> AgentDef {
    crate::test_utils::fake_acp_agent(
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
    )
}

/// /inject 桩应答（P91 批 D1：自拷 HTTP 桩收敛至共享
/// `crate::test_utils::spawn_http_stub`，应答字节对齐原自拷桩——
/// Content-Length = body 的 UTF-8 字节数）。
const INJECT_STUB_RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 67\r\nConnection: close\r\n\r\n{\"context\":\"\xe6\xb3\xa8\xe5\x85\xa5\xe4\xb8\x8a\xe4\xb8\x8b\xe6\x96\x87\",\"activated\":[\"uid-1\"],\"source\":\"vein\"}";

fn gateway_with_inject(yaml: &str) -> Arc<gateway::GatewayCore> {
    Arc::new(gateway::GatewayCore::from_config(
        route::parse_config(yaml).expect("合法配置"),
    ))
}

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

/// mock 环境：owned app + window；state() 借用 app（生命周期安全）。
struct MockEnv {
    app: tauri::App<tauri::test::MockRuntime>,
    window: tauri::Window<tauri::test::MockRuntime>,
    _webview: tauri::WebviewWindow<tauri::test::MockRuntime>,
}

impl MockEnv {
    fn new(state: AppState) -> Self {
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let webview = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
        )
        .build()
        .expect("mock webview must build");
        let window = webview.as_ref().window();
        Self {
            app,
            window,
            _webview: webview,
        }
    }

    fn state(&self) -> tauri::State<'_, AppState> {
        self.app.state::<AppState>()
    }
}

#[tokio::test]
async fn gui_prompt_persists_user_and_done_before_publishing_terminal_state() {
    let trace_path = std::env::temp_dir().join(format!(
        "pylon-kernel-prompt-ingest-{}.jsonl",
        std::process::id()
    ));
    let agent = trace_acp_agent(&trace_path, false);
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = crate::test_utils::test_state_with_acp(
        agent,
        initial_acp,
        Arc::new(gateway::GatewayCore::new()),
        prism::PrismClient::unavailable("test".to_string()),
    )
    .await;
    let events = Arc::new(EventService::in_memory().expect("event service"));
    *state.event_service.lock().unwrap() = Some(events.clone());
    let env = MockEnv::new(state);

    send_message(
        env.state(),
        env.window.clone(),
        "fake-acp-trace".to_string(),
        "local:kernel-prompt".to_string(),
        Some("profile-1".to_string()),
        "hello durable".to_string(),
        String::new(),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("prompt must send");

    let owner_key =
        serde_json::to_string(&["profile-1", "fake-acp-trace", "local:kernel-prompt"]).unwrap();
    let page = events
        .list_events(owner_key, None, 10)
        .await
        .expect("list committed events");
    assert_eq!(
        page.events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        // #81 L2：kernel 终结写入时同事务追加 turn.unit（保序 segment 单元行）
        vec!["user.message", "turn.completed", "turn.unit"]
    );
    assert_eq!(
        page.events[0].typed_payload.as_ref().unwrap()["text"],
        "hello durable"
    );
    assert_eq!(page.events[0].sequence, 1);
    assert_eq!(page.events[1].sequence, 2);

    let _ = std::fs::remove_file(trace_path);
}

#[tokio::test]
async fn gui_prompt_failure_is_committed_after_user_in_the_same_journal() {
    let trace_path = std::env::temp_dir().join(format!(
        "pylon-kernel-prompt-failure-{}.jsonl",
        std::process::id()
    ));
    let agent = trace_acp_agent_error(&trace_path, "provider unavailable");
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = crate::test_utils::test_state_with_acp(
        agent,
        initial_acp,
        Arc::new(gateway::GatewayCore::new()),
        prism::PrismClient::unavailable("test".to_string()),
    )
    .await;
    let events = Arc::new(EventService::in_memory().expect("event service"));
    *state.event_service.lock().unwrap() = Some(events.clone());
    let env = MockEnv::new(state);

    let error = send_message(
        env.state(),
        env.window.clone(),
        "fake-acp-trace".to_string(),
        "local:kernel-failure".to_string(),
        Some("profile-1".to_string()),
        "will fail".to_string(),
        String::new(),
        None,
        None,
        None,
        None,
    )
    .await
    .expect_err("prompt must fail");
    assert!(error.to_string().contains("provider unavailable"));

    let owner_key =
        serde_json::to_string(&["profile-1", "fake-acp-trace", "local:kernel-failure"]).unwrap();
    let page = events.list_events(owner_key, None, 10).await.unwrap();
    assert_eq!(
        page.events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        // #81 L2：kernel 终结写入时同事务追加 turn.unit（保序 segment 单元行）
        vec!["user.message", "turn.failed", "turn.unit"]
    );
    assert_eq!(
        page.events[1].typed_payload.as_ref().unwrap()["error"],
        "ACP protocol: \"RPC error: {\\\"code\\\":-32000,\\\"message\\\":\\\"provider unavailable\\\"}\""
    );
    assert_eq!(
        page.events[1].typed_payload.as_ref().unwrap()["code"],
        "protocol_error"
    );

    let _ = std::fs::remove_file(trace_path);
}

#[tokio::test]
async fn complete_session_load_replay_is_imported_into_the_empty_kernel_journal() {
    let trace_path = std::env::temp_dir().join(format!(
        "pylon-kernel-replay-import-{}.jsonl",
        std::process::id()
    ));
    let agent = trace_acp_agent_replay(&trace_path);
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = crate::test_utils::test_state_with_acp(
        agent,
        initial_acp,
        Arc::new(gateway::GatewayCore::new()),
        prism::PrismClient::unavailable("test".to_string()),
    )
    .await;
    let events = Arc::new(EventService::in_memory().expect("event service"));
    *state.event_service.lock().unwrap() = Some(events.clone());
    *state.message_service.lock().unwrap() = Some(Arc::new(
        crate::session::MessageService::in_memory().expect("message service"),
    ));
    let env = MockEnv::new(state);
    let owner = crate::session::DurableSessionOwner::new(
        "profile-1",
        "fake-acp-trace",
        "local:replay-import",
    );

    let result = crate::session::load_persisted_session(
        env.state(),
        owner.clone(),
        "remote-replay".to_string(),
        Some(".".to_string()),
        None,
        None,
    )
    .await
    .expect("complete replay load");
    assert_eq!(result["canonicalRevision"], 2);
    assert_eq!(result["replayJournalStatus"], "imported");
    assert_eq!(result["authority"], "recovery-import");
    assert_eq!(result["journalCoverage"], "unverified-import");
    assert_eq!(result["collection"]["complete"], true);

    let page = events
        .list_events(owner.key().unwrap(), None, 10)
        .await
        .unwrap();
    assert_eq!(
        page.events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        vec!["user.message", "assistant.text.delta"]
    );
    assert_eq!(
        page.events[0].typed_payload.as_ref().unwrap()["text"],
        "old question"
    );

    let _ = std::fs::remove_file(trace_path);
}

#[tokio::test]
async fn inject_prepends_context_and_advances_round_per_message() {
    let (address, request_rx, server) =
        crate::test_utils::spawn_http_stub(&[INJECT_STUB_RESPONSE, INJECT_STUB_RESPONSE]);
    let trace_path = crate::test_utils::unique_temp("b11-trace").with_extension("jsonl");
    let agent = trace_acp_agent(&trace_path, false);
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let gateway = gateway_with_inject(
        r#"
gateway:
  inject:
    scenario: trpg
    sources: [vein]
"#,
    );
    let prism = prism::PrismClient::for_testing(
        format!("http://{}", address),
        Some("test-token".to_string()),
    );
    let state = crate::test_utils::test_state_with_acp(agent, initial_acp, gateway, prism).await;
    let env = MockEnv::new(state);

    send_message(
        env.state(),
        env.window.clone(),
        "fake-acp-trace".to_string(),
        "source-b11".to_string(),
        None,
        "你好".to_string(),
        String::new(),
        None,
        None,
        None,
        None,
    )
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

    send_message(
        env.state(),
        env.window.clone(),
        "fake-acp-trace".to_string(),
        "source-b11".to_string(),
        None,
        "继续".to_string(),
        String::new(),
        None,
        None,
        None,
        None,
    )
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
    let (address, request_rx, server) = crate::test_utils::spawn_http_stub(&[INJECT_STUB_RESPONSE]);
    let trace_path = crate::test_utils::unique_temp("b11-disabled").with_extension("jsonl");
    let agent = trace_acp_agent(&trace_path, false);
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let gateway = gateway_with_inject(
        r#"
gateway:
  inject:
    enabled: false
"#,
    );
    let prism =
        prism::PrismClient::for_testing(format!("http://{}", address), Some("t".to_string()));
    let state = crate::test_utils::test_state_with_acp(agent, initial_acp, gateway, prism).await;
    let env = MockEnv::new(state);

    send_message(
        env.state(),
        env.window.clone(),
        "fake-acp-trace".to_string(),
        "source-b11-off".to_string(),
        None,
        "你好".to_string(),
        String::new(),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("message must send");
    assert_eq!(inject_prompt_text(&trace_path), "你好");
    assert!(request_rx.try_recv().is_err(), "禁用注入时不得调用 /inject");
    server.join().expect("stub thread");
    std::fs::remove_file(&trace_path).ok();
}

#[tokio::test]
async fn inject_unavailable_degrades_without_injection() {
    let trace_path = std::env::temp_dir().join(format!(
        "pylon-b11-unavailable-{}.jsonl",
        std::process::id()
    ));
    let agent = trace_acp_agent(&trace_path, false);
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let gateway = gateway_with_inject(
        r#"
gateway:
  inject:
    enabled: true
"#,
    );
    let state = crate::test_utils::test_state_with_acp(
        agent,
        initial_acp,
        gateway,
        prism::PrismClient::unavailable("test".to_string()),
    )
    .await;
    let env = MockEnv::new(state);

    send_message(
        env.state(),
        env.window.clone(),
        "fake-acp-trace".to_string(),
        "source-b11-ua".to_string(),
        None,
        "你好".to_string(),
        String::new(),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("message must send without injection");
    assert_eq!(inject_prompt_text(&trace_path), "你好");
    std::fs::remove_file(&trace_path).ok();
}

#[tokio::test]
async fn command_message_skips_injection() {
    let (address, request_rx, server) = crate::test_utils::spawn_http_stub(&[INJECT_STUB_RESPONSE]);
    let trace_path = crate::test_utils::unique_temp("b11-cmd").with_extension("jsonl");
    let agent = trace_acp_agent(&trace_path, false);
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let gateway = gateway_with_inject(
        r#"
gateway:
  inject:
    enabled: true
"#,
    );
    let prism =
        prism::PrismClient::for_testing(format!("http://{}", address), Some("t".to_string()));
    let state = crate::test_utils::test_state_with_acp(agent, initial_acp, gateway, prism).await;
    let env = MockEnv::new(state);

    send_message(
        env.state(),
        env.window.clone(),
        "fake-acp-trace".to_string(),
        "source-b11-cmd".to_string(),
        None,
        "/status".to_string(),
        String::new(),
        None,
        None,
        None,
        None,
    )
    .await
    .expect("command message must send");
    assert_eq!(inject_prompt_text(&trace_path), "/status");
    assert!(request_rx.try_recv().is_err(), "命令消息不得触发 /inject");
    server.join().expect("stub thread");
    std::fs::remove_file(&trace_path).ok();
}

#[tokio::test]
async fn persist_prism_mode_sends_round_with_streamed_response() {
    let (address, request_rx, server) =
        crate::test_utils::spawn_http_stub(&[INJECT_STUB_RESPONSE, INJECT_STUB_RESPONSE]);
    let trace_path = crate::test_utils::unique_temp("b11-persist").with_extension("jsonl");
    let agent = trace_acp_agent(&trace_path, true);
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let gateway = gateway_with_inject(
        r#"
gateway:
  inject:
    enabled: true
    scenario: trpg
    persist: prism
"#,
    );
    let prism = prism::PrismClient::for_testing(
        format!("http://{}", address),
        Some("test-token".to_string()),
    );
    let state = crate::test_utils::test_state_with_acp(agent, initial_acp, gateway, prism).await;
    let app = tauri::test::mock_builder()
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app must build");
    app.manage(state);
    let webview = tauri::WebviewWindowBuilder::new(
        &app,
        "main",
        tauri::WebviewUrl::External("https://example.com".parse().unwrap()),
    )
    .build()
    .expect("mock webview must build");
    // 启动 dispatcher：流式收集回复文本（persist 依赖）
    let handles = AppStateHandles::from_state(app.state::<AppState>().inner());
    let runtime = handles.active_runtime().expect("active runtime");
    start_notification_dispatcher(&handles, &runtime, webview.clone());
    let window = webview.as_ref().window();

    send_message(
        app.state::<AppState>(),
        window,
        "fake-acp-trace".to_string(),
        "source-b11-persist".to_string(),
        None,
        "你好".to_string(),
        String::new(),
        None,
        None,
        None,
        None,
    )
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

#[test]
fn inject_prompt_composition_is_plain_and_conditional() {
    assert_eq!(
        compose_inject_prompt("世界书上下文", "用户消息"),
        "世界书上下文\n\n用户消息"
    );
    assert_eq!(compose_inject_prompt("", "用户消息"), "用户消息");
    assert_eq!(compose_inject_prompt("   ", "用户消息"), "用户消息");
    assert_eq!(compose_inject_prompt("上下文", ""), "上下文\n\n");
    assert!(inject_applies_to("普通消息"));
    assert!(inject_applies_to("  hello"));
    assert!(!inject_applies_to("/command"));
    assert!(!inject_applies_to("  /command"));
}

#[test]
fn extract_tool_file_name_parses_sanitized_summary() {
    assert_eq!(
        extract_tool_file_name(r#"{"path": "G:/project/src/lib.rs"}"#).as_deref(),
        Some("G:/project/src/lib.rs")
    );
    assert_eq!(
        extract_tool_file_name(r#"{"file": "main.ts", "op": "edit"}"#).as_deref(),
        Some("main.ts")
    );
    assert_eq!(
        extract_tool_file_name(r#"{"command": "ls"}"#),
        None,
        "无文件名键不提取"
    );
    assert_eq!(
        extract_tool_file_name(r#"{"path": ""}"#),
        None,
        "空路径不提取"
    );
    assert_eq!(extract_tool_file_name("not json at all"), None);
    // 只取顶层 path 值，不把 rawInput（可能含 secret）带出
    let raw = r#"{"path": "src/x.rs", "token": "SECRET"}"#;
    assert_eq!(extract_tool_file_name(raw).as_deref(), Some("src/x.rs"));
}

#[test]
fn extract_tool_file_name_ignores_embedded_path_fragments() {
    // 审查修复回归：值内嵌的 "path": 片段不得被当作文件名（防 secret 以文件名形态落盘）
    let embedded = r#"{"input": "config says \"path\":\"sk-abc123\""}"#;
    assert_eq!(
        extract_tool_file_name(embedded),
        None,
        "非顶层键的内嵌 path 片段必须忽略"
    );
    // 非 JSON 形态一律不提取
    assert_eq!(extract_tool_file_name(r#"{path: x}"#), None);
    assert_eq!(extract_tool_file_name(r#""path":"src/x.rs""#), None);
}
