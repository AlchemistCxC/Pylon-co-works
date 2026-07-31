//! QQ Bot REST API 消息发送（BE-B10-006）。
//!
//! POST /v2/{users|groups}/{id}/messages。移植自 Prism `src/qq/send.rs`。
//! 请求走 reqwest，错误返回 String；不依赖 tauri。
//! 分块上传（upload.rs）不在本任务范围——>10MB 文件返回明确错误，
//! >100MB 由 MAX_QQ_FILE_BYTES 守护拒绝（Prism routes.rs 实证上限）。
//! 占位期无消费者，与 route/truncate/dedup/auth 一致标 allow(dead_code)；
//! B10.1 骨架接线时必须移除。

use std::path::Path;

use rand::RngExt;
use reqwest::Client;

use super::types::MSG_TYPE_MARKDOWN;

/// 文件大小上限：100 MiB（Prism routes.rs MAX_QQ_FILE_BYTES 实证值）。
const MAX_QQ_FILE_BYTES: u64 = 100 * 1024 * 1024;
/// 简单上传阈值：10MB 内走 base64 inline（QQ Bot API v2 上限）。
const SIMPLE_THRESHOLD: u64 = 10 * 1024 * 1024;

/// 生成消息序列号（0..65536，用于 QQ 消息去重/乱序）。
fn msg_seq() -> u32 {
    rand::rng().random_range(0..65536u32)
}

/// 发送文本消息到 C2C 或群聊。
///
/// chat_type: "c2c" → /v2/users/{chat_id}/messages；其他 → /v2/groups/{chat_id}/messages。
/// reply_to 存在时附带 msg_id（回复锚点）。msg_type 支持 MSG_TYPE_TEXT/MSG_TYPE_MARKDOWN。
#[allow(dead_code)]
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
    let path = match chat_type {
        "c2c" => format!("/v2/users/{chat_id}/messages"),
        "group" | _ => format!("/v2/groups/{chat_id}/messages"),
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
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("发送消息 API 错误: {body}"));
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

/// 简单上传 — URL 直传或 base64 <10MB。
#[allow(dead_code)]
pub async fn upload_simple(
    client: &Client,
    base_url: &str,
    token: &str,
    chat_type: &str,
    target_id: &str,
    file_type: u32,
    url: Option<&str>,
    file_data: Option<&str>,
    file_name: Option<&str>,
) -> Result<serde_json::Value, String> {
    let base = if chat_type == "c2c" { "/v2/users" } else { "/v2/groups" };
    let path = format!("{base}/{target_id}/files");

    let mut body = serde_json::json!({
        "file_type": file_type,
        "srv_send_msg": false,
    });
    if let Some(u) = url {
        body["url"] = serde_json::Value::String(u.to_string());
    }
    if let Some(d) = file_data {
        body["file_data"] = serde_json::Value::String(d.to_string());
    }
    if let Some(n) = file_name {
        body["file_name"] = serde_json::Value::String(n.to_string());
    }

    let resp = client.post(format!("{base_url}{path}"))
        .header("Authorization", format!("QQBot {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("上传文件失败: {e}"))?;

    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("上传 API 错误: {body}"));
    }

    resp.json().await.map_err(|e| format!("解析上传响应失败: {e}"))
}

/// 上传媒体文件 — 自动选择简单/分块上传。
///
/// - 文件 ≤10MB → base64 inline（简单上传）
/// - 10MB < 文件 ≤100MB → 分块上传尚未接线（BE-B10 范围外），返回明确错误
/// - 文件 >100MB → 拒绝（上限守护，Prism 实证值）
#[allow(dead_code)]
pub async fn upload_media(
    api_client: &Client,
    base_url: &str,
    token: &str,
    chat_type: &str,
    target_id: &str,
    file_path: &Path,
    file_type: u32,
    file_name: &str,
) -> Result<serde_json::Value, String> {
    let file_size = std::fs::metadata(file_path)
        .map_err(|e| format!("无法读取文件: {e}"))?
        .len();

    if file_size > MAX_QQ_FILE_BYTES {
        return Err(format!(
            "文件超过 {MAX_QQ_FILE_BYTES} 字节上限（100 MiB）: {file_name}"
        ));
    }

    if file_size <= SIMPLE_THRESHOLD {
        // base64 编码
        use base64::Engine;
        let data = std::fs::read(file_path).map_err(|e| format!("读取文件失败: {e}"))?;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        upload_simple(api_client, base_url, token, chat_type, target_id, file_type, None, Some(&b64), Some(file_name)).await
    } else {
        Err(format!(
            "分块上传尚未接线（>10MB）: {file_name}（{} 字节）",
            file_size
        ))
    }
}

/// 发送媒体消息（上传完成后的第二步，msg_type=7 + media.file_info）。
#[allow(dead_code)]
pub async fn send_media_message(
    client: &Client,
    base_url: &str,
    token: &str,
    chat_type: &str,
    target_id: &str,
    file_info: &serde_json::Value,
    caption: Option<&str>,
    reply_to: Option<&str>,
) -> Result<String, String> {
    let base = if chat_type == "c2c" { "/v2/users" } else { "/v2/groups" };
    let path = format!("{base}/{target_id}/messages");

    let seq = msg_seq();

    let mut body = serde_json::json!({
        "msg_type": 7,
        "media": { "file_info": file_info },
        "msg_seq": seq,
    });
    if let Some(c) = caption {
        body["content"] = serde_json::Value::String(c.to_string());
    }
    if let Some(r) = reply_to {
        body["msg_id"] = serde_json::Value::String(r.to_string());
    }

    let resp = client.post(format!("{base_url}{path}"))
        .header("Authorization", format!("QQBot {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("发送媒体消息失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("发送媒体消息 API 错误: {}", resp.text().await.unwrap_or_default()));
    }

    let data: serde_json::Value = resp.json().await.map_err(|e| format!("解析响应失败: {e}"))?;
    Ok(data.get("id").and_then(|v| v.as_str()).unwrap_or("unknown").to_string())
}

/// 发送"正在输入"状态（仅 C2C）。
#[allow(dead_code)]
pub async fn send_typing(
    client: &Client,
    base_url: &str,
    token: &str,
    chat_id: &str,
    chat_type: &str,
    msg_id: &str,
) -> Result<(), String> {
    if chat_type != "c2c" {
        return Ok(());
    }
    let seq = msg_seq();
    let body = serde_json::json!({
        "msg_type": 5,
        "msg_id": msg_id,
        "input_notify": {
            "input_type": 1,
            "input_second": 60,
        },
        "msg_seq": seq,
    });

    let resp = client
        .post(format!("{base_url}/v2/users/{chat_id}/messages"))
        .header("Authorization", format!("QQBot {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("typing: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("typing API: {}", resp.text().await.unwrap_or_default()));
    }
    Ok(())
}

/// 取消"正在输入"。
#[allow(dead_code)]
pub async fn stop_typing(client: &Client, base_url: &str, token: &str, chat_id: &str) -> Result<(), String> {
    let seq = msg_seq();
    let body = serde_json::json!({
        "msg_type": 5,
        "msg_id": chat_id,
        "input_notify": { "input_type": 2 },
        "msg_seq": seq,
    });

    let resp = client
        .post(format!("{base_url}/v2/users/{chat_id}/messages"))
        .header("Authorization", format!("QQBot {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("stop: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("stop API: {}", resp.text().await.unwrap_or_default()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;
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
    async fn send_message_reports_http_error() {
        let (address, _request_rx, server) = spawn_capture_server(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 14\r\nConnection: close\r\n\r\n{\"bad\":true}",
        );
        let client = test_client();
        let error = send_message(&client, &format!("http://{}", address), "t", "chat-1", "c2c", "x", None, 0)
            .await
            .expect_err("400 must fail");
        assert!(error.contains("发送消息 API 错误"));
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn send_media_message_and_typing_shape() {
        let (address, request_rx, server) = spawn_capture_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"id\":\"media-1\"}",
        );
        let client = test_client();
        let msg_id = send_media_message(
            &client,
            &format!("http://{}", address),
            "test-token",
            "c2c",
            "openid-1",
            &serde_json::json!({"file_uuid": "abc"}),
            Some("看图"),
            None,
        )
        .await
        .expect("media message must succeed");
        assert_eq!(msg_id, "media-1");
        let request = request_rx.recv().expect("captured request");
        assert!(request.starts_with("POST /v2/users/openid-1/messages HTTP/1.1"));
        let body: serde_json::Value = request.split("\r\n\r\n").nth(1).expect("body").parse().expect("body JSON");
        assert_eq!(body["msg_type"], 7);
        assert_eq!(body["media"]["file_info"]["file_uuid"], "abc");
        assert_eq!(body["content"], "看图");
        server.join().expect("server thread");

        // typing：仅 C2C 发送，group 直接跳过
        let (address2, request_rx2, server2) = spawn_capture_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let client2 = test_client();
        send_typing(&client2, &format!("http://{}", address2), "test-token", "openid-1", "c2c", "last-msg").await.expect("typing must send");
        let request = request_rx2.recv().expect("captured request");
        assert!(request.starts_with("POST /v2/users/openid-1/messages HTTP/1.1"));
        let body: serde_json::Value = request.split("\r\n\r\n").nth(1).expect("body").parse().expect("body JSON");
        assert_eq!(body["msg_type"], 5);
        assert_eq!(body["input_notify"]["input_type"], 1);
        server2.join().expect("server thread");
        assert!(send_typing(&client2, &format!("http://{}", address2), "test-token", "group-1", "group", "m").await.is_ok(), "group typing 应跳过");
    }

    #[tokio::test]
    async fn upload_media_rejects_over_limit_and_uses_base64_under_threshold() {
        // 超 100MB：不发起网络请求，直接拒绝
        let root = std::env::temp_dir().join(format!("pylon-qq-upload-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let big = root.join("big.bin");
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(MAX_QQ_FILE_BYTES + 1).unwrap();
        drop(file);
        let client = Client::builder().build().unwrap();
        let error = upload_media(&client, "http://127.0.0.1:9", "t", "c2c", "openid-1", &big, 1, "big.bin")
            .await
            .expect_err(">100MB must be rejected");
        assert!(error.contains("100 MiB"));
        std::fs::remove_dir_all(&root).ok();

        // ≤10MB 走简单上传（base64）——用本地桩验证 file_data 形状
        let (address, request_rx, server) = spawn_capture_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
        );
        let client = test_client();
        let small = std::env::temp_dir().join(format!("pylon-qq-small-{}.bin", std::process::id()));
        std::fs::write(&small, b"hello").unwrap();
        let response = upload_media(&client, &format!("http://{}", address), "t", "group", "group-9", &small, 4, "small.bin")
            .await
            .expect("small file must upload");
        assert_eq!(response["ok"], true);
        let request = request_rx.recv().expect("captured request");
        assert!(request.starts_with("POST /v2/groups/group-9/files HTTP/1.1"));
        let body: serde_json::Value = request.split("\r\n\r\n").nth(1).expect("body").parse().expect("body JSON");
        assert_eq!(body["file_type"], 4);
        assert_eq!(body["file_name"], "small.bin");
        assert_eq!(body["file_data"], base64::engine::general_purpose::STANDARD.encode(b"hello"));
        assert_eq!(body["srv_send_msg"], false);
        std::fs::remove_file(&small).ok();
        server.join().expect("server thread");
    }
}
