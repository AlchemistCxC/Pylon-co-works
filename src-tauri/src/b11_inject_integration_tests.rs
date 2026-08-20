use super::*;

use crate::gateway::route;
use crate::session::EventService;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// 记录收到 session/prompt 请求的 fake ACP（trace 文件 + 标准响应）。
/// 可选流式 chunk（PERSIST_CHUNK 环境变量开启）——先发 agent_message_chunk
/// 再响应 stopReason（延迟 0.2s 让 dispatcher 先收集回复文本）。
const TRACE_ACP_SCRIPT: &str = r#"import json,sys,os,time
trace=open(sys.argv[1],'w',encoding='utf-8')
persist_chunk = os.environ.get('PERSIST_CHUNK', '') == '1'
prompt_error = os.environ.get('PROMPT_ERROR', '')
replay_load = os.environ.get('REPLAY_LOAD', '') == '1'
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'session/new':
        response['result']={'sessionId':'fake-inject-session'}
    elif method == 'session/load' and replay_load:
        session_id=request['params']['sessionId']
        for update in [
            {'sessionUpdate':'user_message_chunk','content':{'text':'persona\n\n---\n\nold question'},'_meta':{'periReplay':True}},
            {'sessionUpdate':'agent_message_chunk','content':{'text':'old answer'},'_meta':{'periReplay':True}}
        ]:
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':update}}), flush=True)
        response['result']={'loaded':True}
    elif method == 'session/prompt':
        if persist_chunk:
            session_id=request['params']['sessionId']
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'回复文本'}}}}), flush=True)
            time.sleep(0.2)
        trace.write(json.dumps(request)+'\n')
        trace.flush()
        if prompt_error:
            response.pop('result', None)
            response['error']={'code':-32000,'message':prompt_error}
        else:
            response['result']={'stopReason':'end_turn'}
    print(json.dumps(response), flush=True)
"#;

fn trace_acp_agent(trace_path: &std::path::Path, chunk: bool) -> AgentDef {
    let mut env = std::collections::HashMap::new();
    env.insert("FAKE_MODE".to_string(), "alive".to_string());
    env.insert(
        "PERSIST_CHUNK".to_string(),
        if chunk {
            "1".to_string()
        } else {
            "0".to_string()
        },
    );
    crate::test_utils::fake_acp_agent_with(
        "fake-acp-trace",
        TRACE_ACP_SCRIPT,
        vec![trace_path.to_string_lossy().into_owned()],
        env,
    )
}

const STUB_RESPONSE_BODY: &str =
    r#"{"context":"注入上下文","activated":["uid-1"],"source":"vein"}"#;

/// Prism /inject 桩：非阻塞轮询处理 expected_requests 次请求（超时自动退出，
/// 防"不应有请求"的测试卡死 join），完整请求文本发 channel。
fn spawn_inject_stub(
    expected_requests: usize,
) -> (
    std::net::SocketAddr,
    mpsc::Receiver<String>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
    listener.set_nonblocking(true).expect("nonblocking");
    let address = listener.local_addr().expect("address");
    let (request_tx, request_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut handled = 0usize;
        while handled < expected_requests {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut bytes = Vec::new();
                    let mut buffer = [0_u8; 1024];
                    loop {
                        match stream.read(&mut buffer) {
                            Ok(0) => break,
                            Ok(count) => {
                                bytes.extend_from_slice(&buffer[..count]);
                                if let Some(headers_end) =
                                    bytes.windows(4).position(|window| window == b"\r\n\r\n")
                                {
                                    let headers = String::from_utf8_lossy(&bytes[..headers_end]);
                                    let length = headers
                                        .lines()
                                        .find_map(|line| line.strip_prefix("Content-Length: "))
                                        .and_then(|value| value.trim().parse::<usize>().ok())
                                        .unwrap_or(0);
                                    if bytes.len() >= headers_end + 4 + length {
                                        break;
                                    }
                                }
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                if std::time::Instant::now() > deadline {
                                    return;
                                }
                                thread::sleep(Duration::from_millis(20));
                            }
                            Err(_) => return,
                        }
                    }
                    let _ = request_tx.send(String::from_utf8(bytes).expect("request UTF-8"));
                    handled += 1;
                    let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                            STUB_RESPONSE_BODY.len(),
                            STUB_RESPONSE_BODY
                        );
                    let _ = stream.write_all(response.as_bytes());
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() > deadline {
                        return;
                    }
                    thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return,
            }
        }
    });
    (address, request_rx, server)
}

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
        vec!["user.message", "turn.completed"]
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
    let mut agent = trace_acp_agent(&trace_path, false);
    agent.env.insert(
        "PROMPT_ERROR".to_string(),
        "provider unavailable".to_string(),
    );
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
        vec!["user.message", "turn.failed"]
    );
    assert_eq!(
        page.events[1].typed_payload.as_ref().unwrap()["error"],
        "ACP protocol: {\"code\":-32000,\"message\":\"provider unavailable\"}"
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
    let mut agent = trace_acp_agent(&trace_path, false);
    agent.env.insert("REPLAY_LOAD".to_string(), "1".to_string());
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
    let (address, request_rx, server) = spawn_inject_stub(2);
    let trace_path =
        std::env::temp_dir().join(format!("pylon-b11-trace-{}.jsonl", std::process::id()));
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
    )
    .await
    .expect("first message must send");
    assert_eq!(inject_prompt_text(&trace_path), "注入上下文\n\n你好");
    let first_request = request_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("first inject request");
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
    )
    .await
    .expect("second message must send");
    let second_request = request_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("second inject request");
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
    let (address, request_rx, server) = spawn_inject_stub(1);
    let trace_path =
        std::env::temp_dir().join(format!("pylon-b11-disabled-{}.jsonl", std::process::id()));
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
    )
    .await
    .expect("message must send without injection");
    assert_eq!(inject_prompt_text(&trace_path), "你好");
    std::fs::remove_file(&trace_path).ok();
}

#[tokio::test]
async fn command_message_skips_injection() {
    let (address, request_rx, server) = spawn_inject_stub(1);
    let trace_path =
        std::env::temp_dir().join(format!("pylon-b11-cmd-{}.jsonl", std::process::id()));
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
    let (address, request_rx, server) = spawn_inject_stub(2);
    let trace_path =
        std::env::temp_dir().join(format!("pylon-b11-persist-{}.jsonl", std::process::id()));
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
    )
    .await
    .expect("message must send");

    // 第一个请求 = /inject（round 0）
    let first = request_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("inject request");
    assert!(first.starts_with("POST /inject HTTP/1.1"));
    // 第二个请求 = /persist（round 0 + 流式回复文本）
    let second = request_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("persist request");
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
