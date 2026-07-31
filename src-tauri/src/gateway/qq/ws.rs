//! QQ WebSocket 事件循环（B10.2 组装）。
//!
//! 移植自 Prism `src/qq/ws.rs` + `ws_proxy.rs`：
//! 获取 Gateway URL → WSS（直连或 HTTPS_PROXY CONNECT 隧道）→ Hello →
//! Identify/Resume → 事件 + 心跳 → 重连（close code 分类 + 指数退避 + 快速断开检测）。
//!
//! 与 Prism 差异：
//! - 事件不再回传 HTTP callback——`process_dispatch_event` 提取干净消息后
//!   直接调用 QqAdapter::handle_incoming（去重 → gateway.ingest）
//! - 无 shutdown 机制：循环任务随 tokio runtime 终止（桌面进程退出即清理）

use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use reqwest::Client;
use tokio::net::TcpStream;
use tokio::time::sleep;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::WebSocketStream;
use url::Url;

use super::auth::{self, QqAuth};
use super::events::{process_attachments, strip_at_mention};
use super::types::{HelloData, QqEvent, QqMessageEvent};
use super::QqAdapter;

const RECONNECT_BACKOFF: [u64; 5] = [2, 5, 10, 30, 60];
const MAX_RECONNECT_ATTEMPTS: usize = 100;
const QUICK_DISCONNECT_THRESHOLD: f64 = 5.0;
const MAX_QUICK_DISCONNECTS: u32 = 3;
const RATE_LIMIT_DELAY: u64 = 60;

/// QQ WebSocket close code 对应的重连策略。
#[derive(Debug, PartialEq, Eq)]
enum CloseAction {
    Fatal(&'static str),
    ReconnectBackoff,
    ReconnectClearToken,
    ReconnectClearSession,
    ReconnectRateLimit,
}

fn classify_close_code(code: u16) -> CloseAction {
    match code {
        4001 | 4002 | 4010 | 4011 | 4012 | 4013 | 4014 => {
            CloseAction::Fatal("invalid auth/permission")
        }
        4914 => CloseAction::Fatal("bot offline/sandbox"),
        4915 => CloseAction::Fatal("bot banned"),
        4004 => CloseAction::ReconnectClearToken,
        4006 | 4007 | 4009 | 4900..=4913 => CloseAction::ReconnectClearSession,
        4008 => CloseAction::ReconnectRateLimit,
        _ => CloseAction::ReconnectBackoff,
    }
}

/// 从 WS 错误消息中提取 close code。
fn parse_ws_close_code(err: &str) -> u16 {
    if let Some(pos) = err.find("code=") {
        let rest = &err[pos + 5..];
        if let Some(end) = rest.find(|c: char| !c.is_ascii_digit()) {
            return rest[..end].parse().unwrap_or(0);
        }
    }
    0
}

/// 消息分发结果：平台消息 → gateway 入站（白名单/去重/ACP 发送由适配器层处理）。
pub struct Dispatch {
    pub source: String,
    pub msg_id: String,
    pub content: String,
    /// 群内发件人 openid（白名单成员级检查用）。
    pub member_openid: Option<String>,
    /// 私聊用户 openid（白名单检查用）。
    pub user_openid: Option<String>,
}

/// 从 Dispatch 事件（op 0）中提取干净消息：
/// - GROUP_AT_MESSAGE_CREATE → `qq:group:{group_openid}`，内容剥离 @bot 前缀
/// - C2C_MESSAGE_CREATE → `qq:user:{user_openid}`，内容原样
/// - 附件：图片 URL / 语音占位 / 文件描述拼进文本（events.rs）
/// 其他事件/缺 id/缺路由标识 → None（不 ingest）。
pub fn process_dispatch_event(event: &QqEvent) -> Option<Dispatch> {
    if event.op != 0 {
        return None;
    }
    let t = event.t.as_deref()?;
    let d = event.d.as_ref()?;
    let msg: QqMessageEvent = serde_json::from_value(d.clone()).ok()?;
    let msg_id = msg.id.as_deref()?.to_string();

    let is_group = t == "GROUP_AT_MESSAGE_CREATE";
    let is_c2c = t == "C2C_MESSAGE_CREATE";
    if !is_group && !is_c2c {
        return None;
    }
    let source = if is_group {
        format!("qq:group:{}", msg.group_openid.as_deref()?)
    } else {
        format!("qq:user:{}", msg.author.as_ref()?.user_openid.as_deref()?)
    };
    let member_openid = msg.author.as_ref().and_then(|a| a.member_openid.clone());
    let user_openid = if is_c2c {
        msg.author.as_ref().and_then(|a| a.user_openid.clone())
    } else {
        None
    };

    let mut content = msg.content.unwrap_or_default();
    if is_group {
        content = strip_at_mention(&content);
    }
    let attachments = process_attachments(&msg.attachments);
    let mut parts = vec![content];
    if !attachments.image_urls.is_empty() {
        parts.push(format!("[图片: {}]", attachments.image_urls.join(", ")));
    }
    if !attachments.voice_transcripts.is_empty() {
        parts.extend(attachments.voice_transcripts);
    }
    if !attachments.attachment_info.is_empty() {
        parts.push(attachments.attachment_info);
    }

    Some(Dispatch {
        source,
        msg_id,
        content: parts.join("\n"),
        member_openid,
        user_openid,
    })
}

/// WS 事件循环：连接失败/断开按 close code 分类重连（指数退避 2s→60s，
/// 上限 100 次；3 次快速断开视为凭证问题停止）。
pub async fn run_ws_loop(http_client: Client, auth: Arc<QqAuth>, adapter: Arc<QqAdapter>) {
    let mut backoff_idx = 0;
    let mut session = SessionState {
        session_id: None,
        last_seq: None,
    };
    let mut quick_count = 0u32;

    loop {
        let connect_time = Instant::now();
        match run_connection(&http_client, &auth, &adapter, &mut session).await {
            Ok(()) => {
                backoff_idx = 0;
                quick_count = 0;
            }
            Err(ref e) if e.contains("op 7") || e.contains("op 9") => {
                backoff_idx = 0;
                quick_count = 0;
                log::info!("QQ WS: 协议层重连、保持 session");
            }
            Err(e) => {
                let duration = connect_time.elapsed().as_secs_f64();
                // 审查修复：连接存活足够久（>60s）说明本次是健康断线（服务端维护等），
                // 重置退避/快速断开计数——否则任何正常断开都会累积，100 次后永久死亡。
                if duration > 60.0 {
                    backoff_idx = 0;
                    quick_count = 0;
                }
                if duration < QUICK_DISCONNECT_THRESHOLD {
                    quick_count += 1;
                    if quick_count >= MAX_QUICK_DISCONNECTS {
                        log::error!("QQ WS: {quick_count} 次快速断开，检查凭证和权限");
                        return;
                    }
                } else {
                    quick_count = 0;
                }

                let code = parse_ws_close_code(&e);
                let action = classify_close_code(code);
                log::warn!("QQ WS: 连接断开 (code={code}, action={action:?}): {e}");

                match action {
                    CloseAction::Fatal(desc) => {
                        log::error!("QQ WS: 致命错误 — {desc}，停止重连");
                        return;
                    }
                    CloseAction::ReconnectClearToken => {
                        auth.invalidate();
                    }
                    CloseAction::ReconnectClearSession => {
                        session.session_id = None;
                        session.last_seq = None;
                    }
                    CloseAction::ReconnectRateLimit => {
                        sleep(Duration::from_secs(RATE_LIMIT_DELAY)).await;
                        backoff_idx = 0;
                        quick_count = 0;
                        continue;
                    }
                    CloseAction::ReconnectBackoff => {}
                }

                if backoff_idx >= MAX_RECONNECT_ATTEMPTS {
                    log::error!("QQ WS: 超过最大重连次数");
                    return;
                }

                let delay = RECONNECT_BACKOFF.get(backoff_idx).copied().unwrap_or(60);
                log::info!("QQ WS: {}s 后重连 (第 {} 次)", delay, backoff_idx + 1);
                sleep(Duration::from_secs(delay)).await;
                backoff_idx += 1;
            }
        }
    }
}

struct SessionState {
    session_id: Option<String>,
    last_seq: Option<u64>,
}

async fn run_connection(
    http_client: &Client,
    auth: &QqAuth,
    adapter: &QqAdapter,
    session: &mut SessionState,
) -> Result<(), String> {
    let token = auth.get_token().await?;
    let gateway_url = auth::get_gateway_url(http_client, &token).await?;
    log::info!("QQ WS: Gateway URL 已获取");

    let ws_stream = connect(&gateway_url).await.map_err(|e| format!("WS 连接失败: {e}"))?;
    log::info!("QQ WS: 已连接");

    let (mut write, mut read) = ws_stream.split();

    // Hello → 提取 heartbeat_interval
    let heartbeat_interval = loop {
        let msg = read
            .next()
            .await
            .ok_or("WS 提前关闭")?
            .map_err(|e| format!("读: {e}"))?;
        if let Message::Text(text) = msg {
            let event: QqEvent =
                serde_json::from_str(&text).map_err(|e| format!("解析 Hello: {e}"))?;
            if event.op == 10 {
                let hello: HelloData = serde_json::from_value(event.d.unwrap_or_default())
                    .unwrap_or(HelloData {
                        heartbeat_interval: 30000,
                    });
                break Duration::from_millis((hello.heartbeat_interval as f64 * 0.8) as u64);
            }
        }
    };

    // Identify 或 Resume
    if session.session_id.is_some() {
        let resume = serde_json::json!({
            "op": 6,
            "d": {
                "token": format!("QQBot {token}"),
                "session_id": session.session_id,
                "seq": session.last_seq.unwrap_or(0),
            }
        });
        write
            .send(Message::Text(resume.to_string()))
            .await
            .map_err(|e| format!("Resume: {e}"))?;
        log::info!("QQ WS: Resume 已发送");
    } else {
        let identify = serde_json::json!({
            "op": 2,
            "d": {
                "token": format!("QQBot {token}"),
                "intents": super::types::DEFAULT_INTENTS,
                "shard": [0, 1],
                "properties": {"$os":"windows","$browser":"pylon","$device":"pylon"}
            }
        });
        write
            .send(Message::Text(identify.to_string()))
            .await
            .map_err(|e| format!("Identify: {e}"))?;
        log::info!("QQ WS: Identify 已发送");
    }

    // 事件 + 心跳
    let mut last_heartbeat = Instant::now();
    let max_silence = heartbeat_interval * 3;

    loop {
        tokio::select! {
            _ = sleep(max_silence) => {
                return Err(format!("WS 超时: {}s 无数据", max_silence.as_secs()));
            }
            result = read.next() => {
                match result {
                    None => return Err("WS 流关闭".into()),
                    Some(Err(e)) => return Err(format!("WS 错误: {e}")),
                    Some(Ok(msg)) => match msg {
                        Message::Text(text) => {
                            if let Ok(event) = serde_json::from_str::<QqEvent>(&text) {
                                let t = event.t.as_deref().unwrap_or("");
                                let op = event.op;

                                if let Some(s) = event.s { session.last_seq = Some(s); }

                                // op 7: 服务端要求重连
                                if op == 7 {
                                    log::info!("QQ WS: 服务端要求重连 (op 7)");
                                    return Err("op 7 reconnect".into());
                                }

                                // op 9: session 失效
                                if op == 9 {
                                    let resumable = event.d.as_ref().and_then(|d| d.as_bool()).unwrap_or(false);
                                    if !resumable {
                                        session.session_id = None;
                                        session.last_seq = None;
                                        log::info!("QQ WS: session 已清除 (op 9)");
                                    }
                                    return Err(format!("op 9 invalid session (resumable={resumable})"));
                                }

                                // READY → 存 session_id（resume 用）
                                if op == 0 && t == "READY" {
                                    if let Some(ref d) = event.d {
                                        if let Some(sid) = d.get("session_id").and_then(|v| v.as_str()) {
                                            session.session_id = Some(sid.to_string());
                                            log::info!("QQ WS: READY session={}", sid);
                                        }
                                    }
                                }

                                // 消息事件 → 去重/白名单 → gateway dispatch（ACP 发送）
                                if let Some(dispatch) = process_dispatch_event(&event) {
                                    match adapter.handle_incoming(
                                        &dispatch.source,
                                        &dispatch.msg_id,
                                        &dispatch.content,
                                        dispatch.member_openid.as_deref(),
                                        dispatch.user_openid.as_deref(),
                                    ) {
                                        Ok(Some(resolved)) => {
                                            log::info!("QQ WS: ingest {} ({})", dispatch.source, dispatch.msg_id);
                                            if let Some(binding) = resolved.binding {
                                                log::info!("QQ WS: 路由命中 {} / {} / {}", binding.agent_id, binding.profile_id, binding.session_key);
                                            }
                                        }
                                        Ok(None) => log::debug!("QQ WS: 丢弃消息 {}（重放/白名单）", dispatch.msg_id),
                                        Err(error) => log::warn!("QQ WS: ingest 失败: {error}"),
                                    }
                                }
                            }
                        }
                        // 审查修复：提取 Close frame 的 code——否则 4008 限流/4006 清
                        // session/4001 致命 code 全被吞掉，重连策略全部失效。
                        Message::Close(frame) => {
                            let code: u16 = frame.map(|f| f.code.into()).unwrap_or(1000);
                            return Err(format!("服务器关闭 code={code}"));
                        }
                        Message::Ping(data) => { let _ = write.send(Message::Pong(data)).await; }
                        _ => {}
                    },
                }
            }
            _ = sleep(heartbeat_interval.saturating_sub(last_heartbeat.elapsed())) => {
                let hb = serde_json::json!({"op": 1, "d": session.last_seq});
                if write.send(Message::Text(hb.to_string())).await.is_err() {
                    return Err("心跳发送失败".into());
                }
                last_heartbeat = Instant::now();
            }
        }
    }
}

pub type WsStream = WebSocketStream<tokio_rustls::client::TlsStream<TcpStream>>;

/// 建立 WSS 连接：优先 HTTPS_PROXY/https_proxy/ALL_PROXY/all_proxy CONNECT 隧道，否则直连。
fn proxy_url() -> Option<String> {
    std::env::var("HTTPS_PROXY")
        .or_else(|_| std::env::var("https_proxy"))
        .or_else(|_| std::env::var("ALL_PROXY"))
        .or_else(|_| std::env::var("all_proxy"))
        .ok()
        .filter(|s| !s.is_empty())
}

pub async fn connect(url: &str) -> Result<WsStream, String> {
    let parsed = Url::parse(url).map_err(|e| format!("URL: {e}"))?;
    let target_host = parsed.host_str().unwrap_or("api.sgroup.qq.com");
    let target_port = parsed.port().unwrap_or(443);
    let proxy = proxy_url();

    let tls_stream = match proxy {
        Some(ref p) => tunnel(p, target_host, target_port).await?,
        None => {
            let stream = TcpStream::connect(format!("{target_host}:{target_port}"))
                .await
                .map_err(|e| format!("直连: {e}"))?;
            tls_wrap(stream, target_host).await?
        }
    };

    let request = url
        .into_client_request()
        .map_err(|e| format!("req: {e}"))?;
    let (ws, _) = tokio_tungstenite::client_async_with_config(request, tls_stream, None)
        .await
        .map_err(|e| format!("WS 握手: {e}"))?;

    match proxy {
        Some(_) => log::info!("QQ WS: 通过代理已连接"),
        None => log::info!("QQ WS: 直连已连接"),
    }
    Ok(ws)
}

async fn tunnel(
    proxy_raw: &str,
    target_host: &str,
    target_port: u16,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let proxy = proxy_raw
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let (host, port) = if let Some((h, p)) = proxy.split_once(':') {
        (h, p.parse::<u16>().unwrap_or(7897))
    } else {
        (proxy, 7897)
    };

    let mut stream = TcpStream::connect(format!("{host}:{port}"))
        .await
        .map_err(|e| format!("连代理: {e}"))?;

    let req = format!(
        "CONNECT {target_host}:{target_port} HTTP/1.1\r\n\
         Host: {target_host}:{target_port}\r\n\r\n"
    );
    use tokio::io::AsyncWriteExt;
    stream.write_all(req.as_bytes()).await.map_err(|e| format!("CONNECT: {e}"))?;

    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 512];
    let n = stream.read(&mut buf).await.map_err(|e| format!("read: {e}"))?;
    let resp = String::from_utf8_lossy(&buf[..n]);
    if !resp.contains("200") {
        return Err(format!("CONNECT 被拒: {}", resp.lines().next().unwrap_or("")));
    }
    log::info!("QQ WS: 代理隧道 → {target_host}:{target_port}");

    tls_wrap(stream, target_host).await
}

async fn tls_wrap(
    stream: TcpStream,
    domain: &str,
) -> Result<tokio_rustls::client::TlsStream<TcpStream>, String> {
    let mut root_store = rustls::RootCertStore::empty();
    let certs = rustls_native_certs::load_native_certs();
    if !certs.errors.is_empty() {
        log::warn!("QQ WS: 加载系统证书 {n} 个错误", n = certs.errors.len());
    }
    for cert in certs.certs {
        let _ = root_store.add(cert);
    }

    let config = rustls::ClientConfig::builder()
        .with_root_certificates(root_store)
        .with_no_client_auth();

    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let server_name: rustls::pki_types::ServerName<'static> =
        domain.to_string().try_into().map_err(|_| "域名无效".to_string())?;

    connector
        .connect(server_name, stream)
        .await
        .map_err(|e| format!("TLS: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(op: u32, t: Option<&str>, d: serde_json::Value) -> QqEvent {
        QqEvent {
            op,
            t: t.map(str::to_string),
            s: Some(1),
            d: Some(d),
        }
    }

    #[test]
    fn group_at_message_extracts_source_strips_mention_and_attachments() {
        let e = event(0, Some("GROUP_AT_MESSAGE_CREATE"), serde_json::json!({
            "id": "msg-1",
            "content": "@bot 你好世界",
            "timestamp": "1722500000",
            "group_openid": "group-123",
            "author": {"member_openid": "mem-1", "user_openid": "user-1"},
            "attachments": [
                {"url": "https://cdn/a.png", "content_type": "image/png", "filename": "a.png"}
            ]
        }));
        let dispatch = process_dispatch_event(&e).expect("group message must dispatch");
        assert_eq!(dispatch.source, "qq:group:group-123");
        assert_eq!(dispatch.msg_id, "msg-1");
        assert!(dispatch.content.starts_with("你好世界"));
        assert!(dispatch.content.contains("[图片: https://cdn/a.png]"));
    }

    #[test]
    fn c2c_message_keeps_content_and_uses_user_openid() {
        let e = event(0, Some("C2C_MESSAGE_CREATE"), serde_json::json!({
            "id": "msg-2",
            "content": "@bot 私聊原文（不剥离）",
            "author": {"user_openid": "user-9"}
        }));
        let dispatch = process_dispatch_event(&e).expect("c2c message must dispatch");
        assert_eq!(dispatch.source, "qq:user:user-9");
        assert_eq!(dispatch.content, "@bot 私聊原文（不剥离）");
    }

    #[test]
    fn non_message_events_are_ignored() {
        // op 0 但非消息类型（如 READY / MESSAGE_AUDIT_PASS）
        assert!(process_dispatch_event(&event(0, Some("READY"), serde_json::json!({"session_id": "s1"}))).is_none());
        // op 10 Hello
        assert!(process_dispatch_event(&event(10, None, serde_json::json!({"heartbeat_interval": 30000}))).is_none());
        // 缺 id 的消息
        assert!(process_dispatch_event(&event(0, Some("C2C_MESSAGE_CREATE"), serde_json::json!({
            "content": "no id",
            "author": {"user_openid": "u1"}
        }))).is_none());
        // 缺 group_openid 的群消息
        assert!(process_dispatch_event(&event(0, Some("GROUP_AT_MESSAGE_CREATE"), serde_json::json!({
            "id": "m3", "content": "x"
        }))).is_none());
    }

    #[test]
    fn voice_and_file_attachments_are_appended() {
        let e = event(0, Some("C2C_MESSAGE_CREATE"), serde_json::json!({
            "id": "msg-3",
            "content": "看这个",
            "author": {"user_openid": "u1"},
            "attachments": [
                {"url": "https://cdn/v.silk", "content_type": "audio/silk", "filename": "v.silk"},
                {"url": "https://cdn/doc.pdf", "content_type": "application/pdf", "filename": "doc.pdf"}
            ]
        }));
        let dispatch = process_dispatch_event(&e).expect("dispatch");
        assert!(dispatch.content.contains("[Voice] [语音消息]"));
        assert!(dispatch.content.contains("[file: doc.pdf]"));
    }

    #[test]
    fn close_code_classification_is_stable() {
        assert_eq!(classify_close_code(4001), CloseAction::Fatal("invalid auth/permission"));
        assert_eq!(classify_close_code(4004), CloseAction::ReconnectClearToken);
        assert_eq!(classify_close_code(4006), CloseAction::ReconnectClearSession);
        assert_eq!(classify_close_code(4008), CloseAction::ReconnectRateLimit);
        assert_eq!(classify_close_code(4900), CloseAction::ReconnectClearSession);
        assert_eq!(classify_close_code(4914), CloseAction::Fatal("bot offline/sandbox"));
        assert_eq!(classify_close_code(1000), CloseAction::ReconnectBackoff);
    }

    #[test]
    fn ws_close_code_is_parsed_from_error_message() {
        assert_eq!(parse_ws_close_code("code=4008 rate limited"), 4008);
        assert_eq!(parse_ws_close_code("no code here"), 0);
    }
}
