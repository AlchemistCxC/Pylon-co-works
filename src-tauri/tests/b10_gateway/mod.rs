//! #106 P5：b10 gateway 端到端（自 lib 内嵌形态迁入，装配经 test_harness 门面，
//! 断言逐条保持——验收 8）。
//!
//! 链路：QQ API 桩 → `handle_incoming`（去重/白名单/路由绑定）→ ingest handler
//! （send_prompt_core）→ 假 ACP 流式 chunk → dispatcher 转发 → deliver_all →
//! QQ 适配器回发（回复锚点取 chat 最新 msg_id）。

use prism_desktop_lib::test_harness::{HarnessConfig, TestHarness};
use std::time::Duration;

#[tokio::test]
async fn qq_ingest_to_deliver_end_to_end_with_reply_anchor() {
    let mut harness = TestHarness::boot(
        HarnessConfig::new()
            .with_fake_agent(
                "fake-acp-chunk",
                &[
                    "--scenario",
                    "stream",
                    "--session-id",
                    "b10-session",
                    "--prompt-chunk",
                    "QQ 回复内容",
                ],
            )
            .with_gateway_yaml(
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
            ),
    )
    .await;

    // QQ API 桩（P91 批 D1：自拷桩收敛至 harness::http_stub 门面）。
    let (_qq_api_address, qq_request_rx, qq_server) = harness.http_stub(&[
        b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{\"id\":\"sent-1\"}",
    ]);
    // QQ 适配器注册（test token + 桩地址，避免真实 QQ API）。
    harness.register_qq_platform(&format!("http://{_qq_api_address}"), "test-token");
    // ingest handler 接线（镜像 run() setup：绑定 agent 路由 + 发送）。
    harness.wire_gateway_ingest();

    // 平台消息入站：去重 + 白名单 + ingest + dispatch（B10.4 链路起点）
    let resolved = harness
        .qq_handle_incoming("qq:group:123", "msg-1", "你好", Some("member-1"))
        .expect("ingest must resolve")
        .expect("新消息必须处理");
    assert_eq!(resolved.source, "qq:group:123");
    assert_eq!(
        resolved.agent_id, "fake-acp-chunk",
        "路由必须绑定 fake-acp-chunk"
    );

    // 中间断言：send_prompt_core 必须建立平台会话（handler 链路通的证据）
    harness.wait_for_platform_session("qq:group:123", 5).await;

    // 等待 deliver 回发到达 QQ API 桩
    let request = String::from_utf8(
        qq_request_rx
            .recv_timeout(Duration::from_secs(10))
            .expect("QQ API 桩必须收到 deliver"),
    )
    .expect("request UTF-8");
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
    let _ = &mut harness; // harness 持有 app 生命周期，测末统一 drop
}
