//! CDP 客户端门面：目标解析 + 会话复用 + 断线自愈。
//!
//! 工具层只跟 [`Cdp`] 打交道，不直接建连。这样「复用哪条会话」「什么时候重连」
//! 「目标怎么寻址」只有一处实现。

pub mod events;
pub mod http;
pub mod session;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use tokio::sync::Mutex;

use crate::cdp::events::Kind;
use crate::cdp::http::TargetInfo;
use crate::cdp::session::{EvalOptions, Session};
use crate::error::{Error, Result};

/// 断线重连的尝试次数（含首次）。2 = 一次重试。
const ATTEMPTS: usize = 2;

/// 一次 [`Cdp::session`] 取回的会话来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionOrigin {
    /// 表里有活会话，直接复用。
    Reused,
    /// 该目标第一次建会话（含并发对手先插入了活会话的情形）。
    New,
    /// 表里躺着的是死会话，本次已原位替换成新连接——即「重连后的第一次调用」。
    /// 会话内缓冲（console/network 的事件日志）随旧连接一起作废，读到的增量从零开始。
    Reconnected,
}

pub struct Cdp {
    pub host: String,
    pub port: u16,
    pub timeout: Duration,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl Cdp {
    pub fn new(host: impl Into<String>, port: u16, timeout: Duration) -> Self {
        Self {
            host: host.into(),
            port,
            timeout,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn endpoint(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    pub async fn targets(&self) -> Result<Vec<TargetInfo>> {
        http::fetch_targets(&self.host, self.port, self.timeout).await
    }

    pub async fn version(&self) -> Result<Value> {
        http::fetch_version(&self.host, self.port, self.timeout).await
    }

    /// 把 `target` 参数解析成唯一目标。
    ///
    /// 不传时：只有一个页面目标就直接用；多个则报错并列出全部，
    /// 让 agent 用返回值里的 id 前缀重新调用——而不是替它猜一个。
    pub async fn resolve(&self, requested: Option<&str>) -> Result<TargetInfo> {
        let endpoint = self.endpoint();
        let targets = self.targets().await?;
        let pages: Vec<TargetInfo> = targets
            .iter()
            .filter(|target| target.is_page_like() && target.is_attachable())
            .cloned()
            .collect();
        let candidates = if pages.is_empty() {
            // 有些 WebView2 版本把页面报成别的 type；退一步用「可附加」当筛选条件。
            targets
                .iter()
                .filter(|target| target.is_attachable())
                .cloned()
                .collect::<Vec<_>>()
        } else {
            pages
        };

        if candidates.is_empty() {
            return Err(Error::NoTargets { endpoint });
        }

        match requested {
            None => match candidates.len() {
                1 => candidates
                    .into_iter()
                    .next()
                    .ok_or(Error::NoTargets { endpoint }),
                _ => Err(Error::AmbiguousTarget {
                    endpoint,
                    available: describe_all(&candidates),
                }),
            },
            Some(needle) => {
                // 精确 id → id 前缀 → url 子串 → title 子串，逐级放宽。
                let found = candidates
                    .iter()
                    .find(|target| target.id == needle)
                    .or_else(|| {
                        candidates
                            .iter()
                            .find(|target| target.id.starts_with(needle))
                    })
                    .or_else(|| candidates.iter().find(|target| target.url.contains(needle)))
                    .or_else(|| {
                        candidates
                            .iter()
                            .find(|target| target.title.contains(needle))
                    });
                match found {
                    Some(target) => Ok(target.clone()),
                    None => Err(Error::UnknownTarget {
                        requested: needle.to_string(),
                        available: describe_all(&candidates),
                    }),
                }
            }
        }
    }

    /// 取得目标的活跃会话，必要时建连。
    ///
    /// 复用的前提是连接仍然活着（reader task 退出时会把 alive 置 false）。
    /// 表里的**死** entry 必须替换成新连接而不是原样交回：console/network
    /// 这类只读本地缓冲、不碰 socket 的调用路径若拿到死会话，会永远对空
    /// 缓冲做增量读取，且没有任何字段提示连接已死。
    pub async fn session(
        &self,
        requested: Option<&str>,
    ) -> Result<(TargetInfo, Arc<Session>, SessionOrigin)> {
        let target = self.resolve(requested).await?;
        {
            let guard = self.sessions.lock().await;
            if let Some(existing) = guard.get(&target.id) {
                if existing.is_alive() {
                    return Ok((target, Arc::clone(existing), SessionOrigin::Reused));
                }
            }
        }

        let session = Session::connect(target.clone(), self.timeout).await?;
        let mut guard = self.sessions.lock().await;
        let stored = guard
            .entry(target.id.clone())
            .or_insert_with(|| Arc::clone(&session));
        if stored.is_alive() {
            // 并发建连时以先插入的为准，丢弃自己这条多余连接；
            // 对手插进来的只会是活会话（它同样走本函数的替换逻辑）。
            Ok((target, Arc::clone(stored), SessionOrigin::New))
        } else {
            *stored = Arc::clone(&session);
            Ok((target, session, SessionOrigin::Reconnected))
        }
    }

    /// 丢弃某个目标的会话（重连前调用）。
    pub async fn invalidate(&self, target_id: &str) {
        self.sessions.lock().await.remove(target_id);
    }

    /// 调一个 CDP 方法，连接断开时自动重连并重试一次。
    pub async fn call(
        &self,
        requested: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let mut last_gone: Option<Error> = None;
        for _ in 0..ATTEMPTS {
            let (target, session, _) = self.session(requested).await?;
            match session.call(method, params.clone()).await {
                Ok(value) => return Ok(value),
                Err(Error::TargetGone { detail }) => {
                    self.invalidate(&target.id).await;
                    eprintln!(
                        "[pylon-webview2-mcp] 目标 {} 的连接断开（{detail}），重建后重试 {method}",
                        target.id
                    );
                    last_gone = Some(Error::TargetGone { detail });
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_gone.unwrap_or(Error::TargetGone {
            detail: format!("{method} 在 {ATTEMPTS} 次尝试后仍未成功"),
        }))
    }

    /// 跨超时调一个 CDP 方法（截图、全页布局这类慢操作）。
    pub async fn call_with_timeout(
        &self,
        requested: Option<&str>,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        let mut last_gone: Option<Error> = None;
        for _ in 0..ATTEMPTS {
            let (target, session, _) = self.session(requested).await?;
            match session
                .call_with_timeout(method, params.clone(), timeout)
                .await
            {
                Ok(value) => return Ok(value),
                Err(Error::TargetGone { detail }) => {
                    self.invalidate(&target.id).await;
                    last_gone = Some(Error::TargetGone { detail });
                }
                Err(error) => return Err(error),
            }
        }
        Err(last_gone.unwrap_or(Error::TargetGone {
            detail: format!("{method} 在 {ATTEMPTS} 次尝试后仍未成功"),
        }))
    }

    /// 求值表达式。连接断开时的处理分两种，语义刻意不同：
    ///
    /// - 会话在**调用前**就已断开 → [`Cdp::session`] 已经把它原位替换成新连接，
    ///   表达式在新会话上正常执行。这种情形表达式根本没跑过，重连是安全的。
    /// - 表达式**执行中途**断开 → 不重试：重放写操作（如 `emit`）会执行两次。
    ///   直接把错误交给调用方判断。
    pub async fn evaluate(
        &self,
        requested: Option<&str>,
        expression: &str,
        options: EvalOptions,
    ) -> Result<Value> {
        let (target, session, _) = self.session(requested).await?;
        match session.evaluate(expression, options).await {
            Ok(value) => Ok(value),
            Err(Error::TargetGone { detail }) => {
                self.invalidate(&target.id).await;
                Err(Error::TargetGone {
                    detail: format!(
                        "{detail}（表达式可能已执行过；本次未自动重放以避免重复副作用，请重试）"
                    ),
                })
            }
            Err(error) => Err(error),
        }
    }

    /// 取事件缓冲句柄（读日志类工具用），并带回会话来源供工具层报告重连。
    pub async fn read_events(
        &self,
        requested: Option<&str>,
        kind: Kind,
        since_seq: Option<u64>,
        scan: usize,
        limit: usize,
        matches: impl Fn(&Value) -> bool,
    ) -> Result<(events::ReadOutcome, Value, SessionOrigin)> {
        let (_, session, origin) = self.session(requested).await?;
        let log = session.events();
        let mut guard = log.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let outcome = guard.read(kind, since_seq, scan, limit, matches);
        let stats = guard.stats(kind);
        drop(guard);
        Ok((outcome, stats, origin))
    }

    /// 清空某类事件缓冲。
    pub async fn reset_events(
        &self,
        requested: Option<&str>,
        kind: Kind,
    ) -> Result<(Value, SessionOrigin)> {
        let (_, session, origin) = self.session(requested).await?;
        let log = session.events();
        let mut guard = log.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.reset(kind);
        let stats = guard.stats(kind);
        drop(guard);
        Ok((stats, origin))
    }
}

fn describe_all(targets: &[TargetInfo]) -> String {
    targets
        .iter()
        .map(TargetInfo::describe)
        .collect::<Vec<_>>()
        .join(" | ")
}

/// 回归用假 DevTools 端点。真实的 Chromium 在同一个端口上多路复用 HTTP 与
/// WebSocket；这里拆成两个端口——`/json/list` 的响应里给出指向 WS 端口的
/// `webSocketDebuggerUrl`，而 `Session::connect` 恰恰原样信任这个 url。
/// 这避开了「先读请求再决定路由」会吞掉 WebSocket 握手报文的问题。
/// WS 侧对每个 CDP 请求回一个空 result，让 open_domains 快速通过。
/// 用途：驱动 `Cdp::session` 的复用/替换判定，见下方测试。
#[cfg(test)]
mod reconnect {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex as SyncMutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::task::JoinSet;
    use tokio_tungstenite::tungstenite::Message;

    use futures_util::{SinkExt, StreamExt};

    const TARGET_ID: &str = "reconnect-test-target";

    #[derive(Clone)]
    struct FakeDevtools {
        http: Arc<TcpListener>,
        ws: Arc<TcpListener>,
        running: Arc<AtomicBool>,
        tasks: Arc<SyncMutex<JoinSet<()>>>,
    }

    impl FakeDevtools {
        async fn bind() -> Self {
            Self {
                http: Arc::new(TcpListener::bind("127.0.0.1:0").await.unwrap()),
                ws: Arc::new(TcpListener::bind("127.0.0.1:0").await.unwrap()),
                running: Arc::new(AtomicBool::new(false)),
                tasks: Arc::new(SyncMutex::new(JoinSet::new())),
            }
        }

        /// CDP 的 HTTP 发现端口（`Cdp` 持有的那一个）。
        fn port(&self) -> u16 {
            self.http.local_addr().unwrap().port()
        }

        fn start(&self) {
            self.running.store(true, Ordering::SeqCst);
            self.spawn_accept_loop(Arc::clone(&self.http), serve_http);
            self.spawn_accept_loop(Arc::clone(&self.ws), serve_ws);
        }

        fn spawn_accept_loop<F, Fut>(&self, listener: Arc<TcpListener>, handler: F)
        where
            F: Fn(TcpStream, u16, Arc<AtomicBool>) -> Fut + Send + Copy + 'static,
            Fut: std::future::Future<Output = ()> + Send + 'static,
        {
            let running = Arc::clone(&self.running);
            let tasks = Arc::clone(&self.tasks);
            let ws_port = self.ws.local_addr().unwrap().port();
            self.tasks.lock().unwrap().spawn(async move {
                while running.load(Ordering::SeqCst) {
                    let Ok((stream, _)) = listener.accept().await else {
                        break;
                    };
                    if !running.load(Ordering::SeqCst) {
                        break;
                    }
                    let running = Arc::clone(&running);
                    tasks.lock().unwrap().spawn(async move {
                        handler(stream, ws_port, running).await;
                    });
                }
            });
        }

        /// 断开全部连接并停止 accept。旧 WebSocket 的对端随之收到 EOF，
        /// 这正是 `Session` reader 判定断线的路径。
        fn stop(&self) {
            self.running.store(false, Ordering::SeqCst);
            let mut tasks = self.tasks.lock().unwrap();
            tasks.abort_all();
        }
    }

    async fn read_http_head(stream: &mut TcpStream) -> Option<String> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let read = tokio::time::timeout(Duration::from_secs(2), stream.read(&mut chunk)).await;
            match read {
                Ok(Ok(0)) | Ok(Err(_)) | Err(_) => return None,
                Ok(Ok(n)) => {
                    buffer.extend_from_slice(&chunk[..n]);
                    if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
                        return Some(String::from_utf8_lossy(&buffer).into_owned());
                    }
                }
            }
        }
    }

    async fn serve_http(mut stream: TcpStream, ws_port: u16, _running: Arc<AtomicBool>) {
        let Some(head) = read_http_head(&mut stream).await else {
            return;
        };
        if !head.starts_with("GET /json") {
            return;
        }
        let body = format!(
            r#"[{{"id":"{TARGET_ID}","type":"page","title":"reconnect test","url":"tauri://localhost/index.html","webSocketDebuggerUrl":"ws://127.0.0.1:{ws_port}/devtools/page/{TARGET_ID}"}}]"#
        );
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
    }

    async fn serve_ws(stream: TcpStream, _ws_port: u16, running: Arc<AtomicBool>) {
        let upgrade = tokio::time::timeout(
            Duration::from_secs(2),
            tokio_tungstenite::accept_async(stream),
        )
        .await;
        let Ok(Ok(ws)) = upgrade else {
            return;
        };
        let (mut sink, mut source) = ws.split();
        while running.load(Ordering::SeqCst) {
            let incoming = tokio::time::timeout(Duration::from_millis(200), source.next()).await;
            match incoming {
                Ok(Some(Ok(Message::Text(text)))) => {
                    // 对每个 CDP 请求回空 result，让 open_domains 快速通过。
                    let id = serde_json::from_str::<Value>(&text)
                        .ok()
                        .and_then(|value| value.get("id").cloned())
                        .unwrap_or(Value::Null);
                    let reply = format!("{{\"id\":{},\"result\":{{}}}}", id);
                    if sink.send(Message::Text(reply)).await.is_err() {
                        return;
                    }
                }
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(_))) | Ok(None) | Err(_) => return,
            }
        }
    }

    async fn wait_until(deadline_ms: u64, mut predicate: impl FnMut() -> bool) -> bool {
        let deadline = tokio::time::Instant::now() + Duration::from_millis(deadline_ms);
        loop {
            if predicate() {
                return true;
            }
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    fn cdp(server: &FakeDevtools) -> Cdp {
        Cdp::new("127.0.0.1", server.port(), Duration::from_millis(2_000))
    }

    #[tokio::test]
    async fn a_dead_session_is_replaced_instead_of_returned() {
        let server = FakeDevtools::bind().await;
        server.start();
        let cdp = cdp(&server);

        let (_, first, origin) = cdp.session(None).await.unwrap();
        assert_eq!(origin, SessionOrigin::New);
        let (_, second, origin) = cdp.session(None).await.unwrap();
        assert_eq!(origin, SessionOrigin::Reused);
        assert!(
            Arc::ptr_eq(&first, &second),
            "活会话必须被复用，而不是另建一条"
        );

        // 断线：reader task 应把 alive 置 false。
        server.stop();
        assert!(
            wait_until(3_000, || !first.is_alive()).await,
            "服务端断开后会话应在限时内标记为死"
        );

        // 重连：同一个 target id，死 entry 必须被替换成新会话。
        server.start();
        let (target, third, origin) = cdp.session(None).await.unwrap();
        assert_eq!(target.id, TARGET_ID);
        assert_eq!(origin, SessionOrigin::Reconnected, "死会话必须被替换");
        assert!(third.is_alive());
        assert!(!Arc::ptr_eq(&first, &third));
        assert_eq!(
            cdp.session(None).await.unwrap().2,
            SessionOrigin::Reused,
            "替换后的新会话此后应正常复用"
        );

        server.stop();
    }

    #[tokio::test]
    async fn a_fresh_target_starts_at_new_not_reconnected() {
        let server = FakeDevtools::bind().await;
        server.start();
        let origin = cdp(&server).session(None).await.unwrap().2;
        assert_eq!(origin, SessionOrigin::New);
        server.stop();
    }
}
