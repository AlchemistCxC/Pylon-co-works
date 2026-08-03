use super::*;

use crate::gateway::qq::{auth::QqAuth, QqAdapter};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// fake ACP：prompt 时先发一条流式 chunk（deliver 回发的文本），再响应 end_turn。
const CHUNK_ACP_SCRIPT: &str = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'session/new':
        response['result']={'sessionId':'b10-session'}
    elif method == 'session/prompt':
        session_id=request['params']['sessionId']
        print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':'QQ 回复内容'}}}}), flush=True)
        response['result']={'stopReason':'end_turn'}
    print(json.dumps(response), flush=True)
"#;

fn chunk_acp_agent() -> AgentDef {
    crate::test_utils::fake_acp_agent("fake-acp-chunk", CHUNK_ACP_SCRIPT)
}

/// QQ API 桩：捕获发送请求（Content-Length 完整读取），返回 {"id":"sent-1"}。
fn spawn_qq_api_stub() -> (
    std::net::SocketAddr,
    mpsc::Receiver<String>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub");
    let address = listener.local_addr().expect("address");
    let (request_tx, request_rx) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept request");
        let mut bytes = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = stream.read(&mut buffer).expect("read request");
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
            if let Some(headers_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
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
        request_tx
            .send(String::from_utf8(bytes).expect("request UTF-8"))
            .expect("send request");
        let body = r#"{"id":"sent-1"}"#;
        let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
        let _ = stream.write_all(response.as_bytes());
    });
    (address, request_rx, server)
}

#[tokio::test]
async fn qq_ingest_to_deliver_end_to_end_with_reply_anchor() {
    let (_qq_api_address, qq_request_rx, qq_server) = spawn_qq_api_stub();
    // gateway：qq:group:123 → peri 绑定；注入关闭（本测试不依赖 Prism）
    let gateway = Arc::new(gateway::GatewayCore::from_config(
        gateway::route::parse_config(
            r#"
gateway:
  inject:
    enabled: false
  routes:
    - source: qq:group:123
      agent: fake-acp-chunk
      profile: trpg
      session: 战役1
"#,
        )
        .expect("合法配置"),
    ));
    // QQ 适配器注册（test token + 桩地址，避免真实 QQ API）
    let qq_http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .build()
        .expect("http client");
    let qq_auth = Arc::new(QqAuth::for_testing("test-token".to_string()));
    let qq_adapter = QqAdapter::for_testing(
        gateway.clone(),
        qq_http.clone(),
        qq_auth.clone(),
        format!("http://{_qq_api_address}"),
    );
    gateway.register(qq_adapter.clone()).expect("register qq");

    let agent = chunk_acp_agent();
    let initial_acp = AcpClient::connect_with_logs(&agent, None)
        .await
        .expect("fake ACP must initialize");
    let state = crate::test_utils::test_state_with_acp(
        agent,
        initial_acp,
        gateway.clone(),
        prism::PrismClient::unavailable("test".to_string()),
    )
    .await;
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
    // dispatcher：chunk 转发 → deliver_all → QQ 适配器
    let handles = AppStateHandles::from_state(app.state::<AppState>().inner());
    let runtime = handles.active_runtime().expect("active runtime");
    start_notification_dispatcher(&handles, &runtime, webview.clone());
    let main_window = webview.as_ref().window();

    // ingest handler 接线（模拟 run() setup：绑定 agent 路由 + 发送）
    let app_handle = app.handle().clone();
    let window_for_handler = main_window.clone();
    gateway.set_ingest_handler(Arc::new(move |resolved: &gateway::ResolvedIngest| {
        let app = app_handle.clone();
        let window = window_for_handler.clone();
        let resolved = resolved.clone();
        tokio::spawn(async move {
            let state = app.state::<AppState>();
            let agent_id = resolved
                .binding
                .as_ref()
                .map(|b| b.agent_id.clone())
                .unwrap_or_default();
            let runtime = state.inner().runtimes.get_or_create(&agent_id);
            if let Err(error) = send_prompt_core(
                state.inner(),
                &runtime,
                Some(&window),
                &state.gateway,
                &crate::session::PromptContext {
                    source: resolved.source.clone(),
                    content: resolved.content.clone(),
                    persona: String::new(),
                    session_prompt: None,
                    attachments: None,
                    mcp_servers: None,
                    cwd: None,
                },
            )
            .await
            {
                tracing::warn!("ingest send failed: {error}");
            }
        });
    }));

    // 平台消息入站：去重 + 白名单 + ingest + dispatch（B10.4 链路起点）
    let resolved = qq_adapter
        .handle_incoming("qq:group:123", "msg-1", "你好", Some("member-1"), None)
        .expect("ingest must resolve")
        .expect("新消息必须处理");
    assert_eq!(resolved.source, "qq:group:123");
    assert_eq!(
        resolved.binding.as_ref().unwrap().agent_id,
        "fake-acp-chunk"
    );

    // 中间断言：send_prompt_core 必须建立平台会话（handler 链路通的证据）
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let sessions = app
                .state::<AppState>()
                .inner()
                .active_runtime()
                .map(|r| {
                    r.sessions
                        .lock()
                        .map(|s| s.contains_key("qq:group:123"))
                        .unwrap_or(false)
                })
                .unwrap_or(false);
            if sessions {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("ingest handler 必须建立平台会话（send_prompt_core 链路）");

    // 等待 deliver 回发到达 QQ API 桩
    let request = qq_request_rx
        .recv_timeout(Duration::from_secs(10))
        .expect("QQ API 桩必须收到 deliver");
    assert!(
        request.starts_with("POST /v2/groups/123/messages HTTP/1.1"),
        "URL: {request:.100}"
    );
    assert!(
        request.contains("authorization: QQBot test-token")
            || request.contains("Authorization: QQBot test-token")
    );
    let body: serde_json::Value = request
        .split("\r\n\r\n")
        .nth(1)
        .expect("body")
        .parse()
        .expect("body JSON");
    assert_eq!(
        body["content"], "QQ 回复内容",
        "deliver 文本必须来自 fake ACP 流式 chunk"
    );
    assert_eq!(body["msg_type"], 0);
    assert_eq!(
        body["msg_id"], "msg-1",
        "回复锚点必须取 chat 最新 msg_id（dedup latest_for）"
    );

    qq_server.join().expect("stub thread");
}
