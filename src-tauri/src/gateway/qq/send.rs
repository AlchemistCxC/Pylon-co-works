//! QQ Bot REST API 消息发送（BE-B10-006）。
//!
//! POST /v2/{users|groups}/{id}/messages。移植自 Prism `src/qq/send.rs`。
//! 请求走 reqwest，错误返回 String；不依赖 tauri。
//! 已接线（B10.2）：send_message 由 QQ 适配器 deliver 消费；
//! 媒体上传/typing 属出站媒体二期（BE-B10 范围外），未移植。

use reqwest::Client;

use super::types::QqMsgType;
use super::QqChatType;

use std::sync::atomic::{AtomicU32, Ordering};

static MSG_SEQ: AtomicU32 = AtomicU32::new(1);
/// 生成消息序列号：进程级单调递增（修复：随机 16bit 碰撞致 QQ 幂等去重
/// 静默吞消息；31bit 单调回绕周期 2^31，去重窗口内不可能碰撞）。
fn msg_seq() -> u32 {
    MSG_SEQ.fetch_add(1, Ordering::Relaxed) & 0x7FFF_FFFF
}

/// 发送文本消息到 C2C 或群聊。
///
/// chat_type: C2C → /v2/users/{chat_id}/messages；Group → /v2/groups/{chat_id}/messages。
/// reply_to 存在时附带 msg_id（回复锚点）。msg_type 支持 Text/Markdown（§3-8：
/// 裸数字类型化为 QqMsgType，wire 数值不变）。
/// R14：chat_type 为枚举——非法值在类型层不可表达（FromStr 拒绝），
/// 拼错不再可能静默走群发路径。
// clippy 2026-08-02：8 参均为独立发送参数（client/base_url/token/chat_id/chat_type/content/reply_to/msg_type），
// 保持显式签名（重构参数结构体收益低）。
#[allow(clippy::too_many_arguments)]
pub async fn send_message(
    client: &Client,
    base_url: &str,
    token: &str,
    chat_id: &str,
    chat_type: &QqChatType,
    content: &str,
    reply_to: Option<&str>,
    msg_type: QqMsgType,
) -> Result<String, String> {
    // 修复（P3）+ R14：枚举匹配，非法 chat_type 由类型系统拒绝
    let path = match chat_type {
        QqChatType::C2C => format!("/v2/users/{chat_id}/messages"),
        QqChatType::Group => format!("/v2/groups/{chat_id}/messages"),
    };

    let seq = msg_seq();

    let mut body = if msg_type == QqMsgType::Markdown {
        serde_json::json!({
            "content": content,
            "markdown": { "content": content },
            "msg_type": msg_type.as_u32(),
            "msg_seq": seq,
        })
    } else {
        serde_json::json!({
            "content": content,
            "msg_type": msg_type.as_u32(),
            "msg_seq": seq,
        })
    };

    if let Some(rid) = reply_to {
        body["msg_id"] = serde_json::Value::String(rid.to_string());
    }

    let resp = client
        .post(format!("{base_url}{path}"))
        .header("Authorization", format!("QQBot {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("发送消息失败: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        // 修复（P2-2）：错误字符串携带 HTTP 状态码——classify_send_error 的
        // 403/404/429 匹配依赖它（原来只含 body 文本，死目标/限流永不命中）
        return Err(format!("HTTP {status}: {body}"));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析发送响应失败: {e}"))?;

    // 修复（B3）：QQ 业务错误以 HTTP 200 + code 返回；原来只读 id，
    // 限流/无权限/群不存在被静默判成功。Err 文案携带 code 与 message，
    // classify_send_error 的中文匹配（频率限制/禁言/无权限等）才能命中。
    let biz_code = data.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
    if biz_code != 0 {
        let message = data
            .get("message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        return Err(format!("HTTP 200 业务错误 code={biz_code}: {message}"));
    }

    // 方案 1F：HTTP 200 但缺有效 id（缺失/null/空串/全空白）视为协议漂移，
    // 不得报发送成功——否则消息实际未送达却返回成功，错误静默。
    let msg_id = data
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("HTTP 200 响应缺有效 id 字段: {data}"))?;

    Ok(msg_id.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    /// 本地 TCP 桩：捕获请求头与 body，返回固定响应（prism.rs 同款模式）。
    fn spawn_capture_server(
        response: &'static [u8],
    ) -> (
        std::net::SocketAddr,
        mpsc::Receiver<String>,
        thread::JoinHandle<()>,
    ) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("listener address");
        let (request_tx, request_rx) = mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut bytes = Vec::new();
            let mut buffer = [0_u8; 1024];
            let _content_length = loop {
                let count = stream.read(&mut buffer).expect("read request");
                if count == 0 {
                    break 0;
                }
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(headers_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let headers = String::from_utf8_lossy(&bytes[..headers_end]);
                    let length = headers
                        .lines()
                        .find_map(|line| line.strip_prefix("Content-Length: "))
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if bytes.len() >= headers_end + 4 + length {
                        break length;
                    }
                }
            };
            request_tx
                .send(String::from_utf8(bytes).expect("request UTF-8"))
                .expect("send request");
            stream.write_all(response).expect("write response");
        });
        (address, request_rx, server)
    }

    fn test_client() -> Client {
        Client::builder().build().expect("test HTTP client")
    }

    #[test]
    fn msg_seq_is_monotonic_and_unique() {
        // 修复（B2）：随机 16bit 碰撞致 QQ 幂等去重静默吞消息；改为进程级单调递增
        let mut seen = std::collections::HashSet::new();
        let mut last = 0;
        for _ in 0..1000 {
            let seq = msg_seq();
            assert!(seq > last, "msg_seq 必须单调递增: {seq} <= {last}");
            assert!(seen.insert(seq), "msg_seq 重复: {seq}");
            last = seq;
        }
        assert_eq!(seen.len(), 1000);
    }

    #[tokio::test]
    async fn send_message_c2c_shapes_url_auth_and_body() {
        let (address, request_rx, server) = spawn_capture_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"id\":\"msg-1\"}",
        );
        let client = test_client();
        let msg_id = send_message(
            &client,
            &format!("http://{}", address),
            "test-token",
            "openid-123",
            &QqChatType::C2C,
            "你好",
            Some("parent-msg"),
            QqMsgType::Text,
        )
        .await
        .expect("send message must succeed");
        assert_eq!(msg_id, "msg-1");
        let request = request_rx.recv().expect("captured request");
        assert!(request.starts_with("POST /v2/users/openid-123/messages HTTP/1.1"));
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
        assert_eq!(body["content"], "你好");
        assert_eq!(body["msg_type"], 0);
        assert_eq!(body["msg_id"], "parent-msg");
        assert!(body["msg_seq"].as_u64().unwrap() < 65536);
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn send_message_group_and_markdown_shape() {
        let (address, request_rx, server) = spawn_capture_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"id\":\"msg-2\"}",
        );
        let client = test_client();
        let msg_id = send_message(
            &client,
            &format!("http://{}", address),
            "test-token",
            "group-456",
            &QqChatType::Group,
            "**bold**",
            None,
            QqMsgType::Markdown,
        )
        .await
        .expect("send message must succeed");
        assert_eq!(msg_id, "msg-2");
        let request = request_rx.recv().expect("captured request");
        assert!(request.starts_with("POST /v2/groups/group-456/messages HTTP/1.1"));
        let body: serde_json::Value = request
            .split("\r\n\r\n")
            .nth(1)
            .expect("body")
            .parse()
            .expect("body JSON");
        assert_eq!(body["markdown"]["content"], "**bold**");
        assert_eq!(body["msg_type"], 2);
        assert!(body.get("msg_id").is_none(), "无 reply_to 时不得带 msg_id");
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn send_message_reports_business_error_code() {
        // 修复（B3）：HTTP 200 + code!=0 是 QQ 业务错误（限流/禁言/无权限），
        // 原来被静默判成功返回 "unknown"
        let (address, _request_rx, server) = spawn_capture_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 52\r\nConnection: close\r\n\r\n{\"code\":304023,\"message\":\"\xe5\x8f\x91\xe9\x80\x81\xe6\xb6\x88\xe6\x81\xaf\xe9\xa2\x91\xe7\x8e\x87\xe9\x99\x90\xe5\x88\xb6\"}",
        );
        let client = test_client();
        let error = send_message(
            &client,
            &format!("http://{}", address),
            "t",
            "chat-1",
            &QqChatType::C2C,
            "x",
            None,
            QqMsgType::Text,
        )
        .await
        .expect_err("code!=0 必须失败");
        assert!(error.contains("code=304023"));
        assert!(error.contains("发送消息频率限制"));
        server.join().expect("server thread");
    }

    async fn expect_send_error(response: &'static [u8]) -> String {
        let (address, _request_rx, server) = spawn_capture_server(response);
        let client = test_client();
        let error = send_message(
            &client,
            &format!("http://{}", address),
            "t",
            "chat-1",
            &QqChatType::C2C,
            "x",
            None,
            QqMsgType::Text,
        )
        .await
        .expect_err("缺有效 id 必须失败");
        server.join().expect("server thread");
        error
    }

    #[tokio::test]
    async fn send_message_rejects_missing_or_blank_id_on_http_200() {
        // 方案 1F：HTTP 200 但缺有效 id = 协议漂移，不得报发送成功。
        let err = expect_send_error(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        ).await;
        assert!(err.contains("id"), "空对象必须指明缺 id: {err}");

        let err = expect_send_error(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"id\":null}",
        ).await;
        assert!(err.contains("id"), "id:null 必须失败: {err}");

        let err = expect_send_error(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 9\r\nConnection: close\r\n\r\n{\"id\":\"\"}",
        ).await;
        assert!(err.contains("id"), "id 空串必须失败: {err}");

        let err = expect_send_error(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"id\":\"  \"}",
        ).await;
        assert!(err.contains("id"), "id 全空白必须失败: {err}");
    }

    #[tokio::test]
    async fn send_message_accepts_non_blank_id() {
        // 方案 1F：有效 id 判成功。
        let (address, _request_rx, server) = spawn_capture_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"id\":\"msg-1\"}",
        );
        let client = test_client();
        let msg_id = send_message(
            &client,
            &format!("http://{}", address),
            "t",
            "chat-1",
            &QqChatType::C2C,
            "x",
            None,
            QqMsgType::Text,
        )
        .await
        .expect("有效 id 必须成功");
        assert_eq!(msg_id, "msg-1");
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn send_message_reports_http_error_with_status() {
        let (address, _request_rx, server) = spawn_capture_server(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"bad\":true}",
        );
        let client = test_client();
        let error = send_message(
            &client,
            &format!("http://{}", address),
            "t",
            "chat-1",
            &QqChatType::C2C,
            "x",
            None,
            QqMsgType::Text,
        )
        .await
        .expect_err("400 must fail");
        // 修复（P2-2）：错误携带 HTTP 状态码，classify_send_error 才能命中 403/404/429
        assert!(error.contains("HTTP 400"));
        assert!(error.contains("{\"bad\":true}"));
        server.join().expect("server thread");
    }
}
