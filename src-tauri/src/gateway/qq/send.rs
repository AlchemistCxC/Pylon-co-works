//! QQ Bot REST API 消息发送（BE-B10-006）。
//!
//! POST /v2/{users|groups}/{id}/messages。移植自 Prism `src/qq/send.rs`。
//! 请求走 reqwest，错误返回 String；不依赖 tauri。
//! 已接线（B10.2）：send_message 由 QQ 适配器 deliver 消费；
//! 媒体上传/typing 属出站媒体二期（BE-B10 范围外），未移植。

use rand::RngExt;
use reqwest::Client;

use super::types::MSG_TYPE_MARKDOWN;

/// 生成消息序列号（0..65536，用于 QQ 消息去重/乱序）。
fn msg_seq() -> u32 {
    rand::rng().random_range(0..65536u32)
}

/// 发送文本消息到 C2C 或群聊。
///
/// chat_type: "c2c" → /v2/users/{chat_id}/messages；"group" → /v2/groups/{chat_id}/messages。
/// reply_to 存在时附带 msg_id（回复锚点）。msg_type 支持 MSG_TYPE_TEXT/MSG_TYPE_MARKDOWN。
pub async fn send_message(
    client: &Client,
    base_url: &str,
    token: &str,
    chat_id: &str,
    chat_type: &str, // "c2c" | "group"
    content: &str,
    reply_to: Option<&str>,
    msg_type: u32,
) -> Result<String, String> {
    // 修复（P3）：明确枚举匹配，拼错的 chat_type 不再静默走群发路径
    let path = match chat_type {
        "c2c" => format!("/v2/users/{chat_id}/messages"),
        "group" => format!("/v2/groups/{chat_id}/messages"),
        other => return Err(format!("不支持的 chat_type: {other}")),
    };

    let seq = msg_seq();

    let body = if msg_type == MSG_TYPE_MARKDOWN {
        serde_json::json!({
            "markdown": { "content": content },
            "msg_type": msg_type,
            "msg_seq": seq,
        })
    } else {
        serde_json::json!({
            "content": content,
            "msg_type": msg_type,
            "msg_seq": seq,
        })
    };

    let mut body = body.as_object().unwrap().clone();
    if let Some(rid) = reply_to {
        body.insert("msg_id".into(), serde_json::Value::String(rid.to_string()));
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

    let msg_id = data
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    Ok(msg_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    /// 本地 TCP 桩：捕获请求头与 body，返回固定响应（prism.rs 同款模式）。
    fn spawn_capture_server(response: &'static [u8]) -> (std::net::SocketAddr, mpsc::Receiver<String>, thread::JoinHandle<()>) {
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
                if let Some(headers_end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
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
            request_tx.send(String::from_utf8(bytes).expect("request UTF-8")).expect("send request");
            stream
                .write_all(response)
                .expect("write response");
        });
        (address, request_rx, server)
    }

    fn test_client() -> Client {
        Client::builder().build().expect("test HTTP client")
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
            "c2c",
            "你好",
            Some("parent-msg"),
            0,
        )
        .await
        .expect("send message must succeed");
        assert_eq!(msg_id, "msg-1");
        let request = request_rx.recv().expect("captured request");
        assert!(request.starts_with("POST /v2/users/openid-123/messages HTTP/1.1"));
        assert!(request.contains("authorization: QQBot test-token") || request.contains("Authorization: QQBot test-token"));
        let body: serde_json::Value = request.split("\r\n\r\n").nth(1).expect("body").parse().expect("body JSON");
        assert_eq!(body["content"], "你好");
        assert_eq!(body["msg_type"], 0);
        assert_eq!(body["msg_id"], "parent-msg");
        assert_eq!(body["msg_seq"].as_u64().unwrap() < 65536, true);
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
            "group",
            "**bold**",
            None,
            2,
        )
        .await
        .expect("send message must succeed");
        assert_eq!(msg_id, "msg-2");
        let request = request_rx.recv().expect("captured request");
        assert!(request.starts_with("POST /v2/groups/group-456/messages HTTP/1.1"));
        let body: serde_json::Value = request.split("\r\n\r\n").nth(1).expect("body").parse().expect("body JSON");
        assert_eq!(body["markdown"]["content"], "**bold**");
        assert_eq!(body["msg_type"], 2);
        assert!(body.get("msg_id").is_none(), "无 reply_to 时不得带 msg_id");
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn send_message_reports_http_error_with_status() {
        let (address, _request_rx, server) = spawn_capture_server(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"bad\":true}",
        );
        let client = test_client();
        let error = send_message(&client, &format!("http://{}", address), "t", "chat-1", "c2c", "x", None, 0)
            .await
            .expect_err("400 must fail");
        // 修复（P2-2）：错误携带 HTTP 状态码，classify_send_error 才能命中 403/404/429
        assert!(error.contains("HTTP 400"));
        assert!(error.contains("{\"bad\":true}"));
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn send_message_rejects_unknown_chat_type() {
        let client = test_client();
        let error = send_message(&client, "http://127.0.0.1:9", "t", "chat-1", "groupp", "x", None, 0)
            .await
            .expect_err("拼错的 chat_type 必须报错");
        assert!(error.contains("不支持的 chat_type: groupp"));
    }
}
