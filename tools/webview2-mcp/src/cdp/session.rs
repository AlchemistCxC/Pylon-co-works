//! 单个页面目标的 CDP 会话。
//!
//! 一条 WebSocket 上跑「请求/响应」与「事件推送」两条流（CDP 本身就是这么设计的），
//! 因此这里拆成两个 task：
//!
//! - **writer task**：把 `call` 排进来的报文写进 socket（`Sink` 不能跨 task 共享，
//!   所以用 mpsc 单点化写入）。
//! - **reader task**：读回流，带 `id` 的派发给等待中的 oneshot；
//!   不带 `id` 的按方法名归一到 [`EventLog`]。
//!
//! 连接断开时 reader 会把所有在途调用立即失败，而不是让每个调用各自等到超时——
//! 排查 app 重启时，「连接断了」和「方法卡住」是完全不同的结论。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::Message;

use crate::cdp::events::EventLog;
use crate::cdp::http::TargetInfo;
use crate::error::{Error, Result};

/// 会话建立时一次性打开的 CDP 域。
///
/// 不开这些域，事件流一条都不会来；`webview_console` / `webview_network` 就永远是空的。
/// 列表里的 `Network` 有固定开销（每个请求都要过一遍），但调试服务器取的是「别漏证据」。
const DOMAINS: [&str; 4] = [
    "Runtime.enable",
    "Log.enable",
    "Network.enable",
    "Page.enable",
];

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// `Runtime.evaluate` 的可选项。
#[derive(Debug, Clone, Copy)]
pub struct EvalOptions {
    /// 表达式求值出 Promise 时是否等待其 settle。
    pub await_promise: bool,
    /// 是否把结果按值序列化回来（false 只给 RemoteObject 句柄）。
    pub return_by_value: bool,
    /// 标记为「用户手势」发起 —— 剪贴板、全屏、播放等 API 需要它。
    pub user_gesture: bool,
    /// 覆盖默认超时。同时作用于 CDP 侧（若支持）与本地等待。
    pub timeout: Option<Duration>,
}

impl Default for EvalOptions {
    fn default() -> Self {
        Self {
            await_promise: true,
            return_by_value: true,
            user_gesture: false,
            timeout: None,
        }
    }
}

impl EvalOptions {
    /// 交互类工具（点击/输入）用：需要 user activation 才能触发受门控的 API。
    pub fn interactive() -> Self {
        Self {
            user_gesture: true,
            ..Self::default()
        }
    }
}

/// 在途调用表：id → (方法名, 回信通道)。
///
/// 存方法名是为了让「CDP 报了 error」时能说出是哪个方法报的 —— 光看
/// `{"code":-32601,"message":"'Foo' wasn't found"}` 无法定位是哪个工具触发的。
type Pending = Arc<StdMutex<HashMap<i64, (String, oneshot::Sender<Result<Value>>)>>>;

pub struct Session {
    writer: mpsc::UnboundedSender<Message>,
    pending: Pending,
    events: Arc<StdMutex<EventLog>>,
    next_id: AtomicI64,
    alive: Arc<AtomicBool>,
    default_timeout: Duration,
}

impl Session {
    /// 与目标建立 CDP 连接并打开所需域。
    ///
    /// `target` 只在建连阶段用到（拿 ws url、拼错误文案）；不存进 `Session`，
    /// 因为 `Cdp` 已经把 `TargetInfo` 随会话一起返回给调用方，存两份只会
    /// 多一处可能不一致的状态。
    pub async fn connect(target: TargetInfo, default_timeout: Duration) -> Result<Arc<Self>> {
        let ws_url = target.ws_url.clone().ok_or_else(|| Error::Cdp {
            method: "connect".to_string(),
            detail: format!(
                "目标 {} 没有 webSocketDebuggerUrl（url={}）—— 该目标不可附加，\
                 可能是 worker/service_worker 这类非页面目标",
                target.id,
                target.url_or_blank()
            ),
        })?;

        let (socket, _response) = tokio::time::timeout(
            CONNECT_TIMEOUT,
            tokio_tungstenite::connect_async(ws_url.as_str()),
        )
        .await
        .map_err(|_| Error::Timeout {
            what: format!("连接 CDP WebSocket {ws_url}"),
            ms: CONNECT_TIMEOUT.as_millis() as u64,
        })?
        .map_err(|error| Error::Cdp {
            method: "connect".to_string(),
            detail: format!("{ws_url}: {error}"),
        })?;

        let (mut sink, mut stream) = socket.split();
        let (writer, mut outbound) = mpsc::unbounded_channel::<Message>();
        let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
        let events = Arc::new(StdMutex::new(EventLog::new()));
        let alive = Arc::new(AtomicBool::new(true));

        tokio::spawn(async move {
            while let Some(message) = outbound.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        {
            let pending = Arc::clone(&pending);
            let events = Arc::clone(&events);
            let alive = Arc::clone(&alive);
            tokio::spawn(async move {
                while let Some(incoming) = stream.next().await {
                    match incoming {
                        Ok(Message::Text(text)) => dispatch(&text, &pending, &events),
                        Ok(Message::Binary(bytes)) => {
                            if let Ok(text) = std::str::from_utf8(&bytes) {
                                dispatch(text, &pending, &events);
                            }
                        }
                        Ok(Message::Close(_)) => break,
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
                alive.store(false, Ordering::SeqCst);
                fail_pending(&pending, "CDP websocket 已关闭");
            });
        }

        let session = Arc::new(Self {
            writer,
            pending,
            events,
            next_id: AtomicI64::new(1),
            alive,
            default_timeout,
        });

        session.open_domains().await;
        Ok(session)
    }

    /// 连接是否仍然存活。`Cdp` 用它决定复用还是重连。
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    pub fn events(&self) -> Arc<StdMutex<EventLog>> {
        Arc::clone(&self.events)
    }

    /// 打开事件域。失败不致命（例如旧 WebView2 缺某个域），逐条记到 stderr，
    /// 让「console 一直为空」这件事有可查的痕迹。
    async fn open_domains(&self) {
        for method in DOMAINS {
            if let Err(error) = self.call(method, json!({})).await {
                eprintln!("[pylon-webview2-mcp] {method} 失败（该域事件将缺失）：{error}");
            }
        }
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.call_with_timeout(method, params, self.default_timeout)
            .await
    }

    pub async fn call_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        if !self.is_alive() {
            return Err(Error::TargetGone {
                detail: format!("会话在调用 {method} 前已断开"),
            });
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut guard = lock(&self.pending);
            guard.insert(id, (method.to_string(), sender));
        }

        let payload = json!({ "id": id, "method": method, "params": params }).to_string();
        if self.writer.send(Message::Text(payload)).is_err() {
            lock(&self.pending).remove(&id);
            return Err(Error::TargetGone {
                detail: format!("writer task 已退出，无法发送 {method}"),
            });
        }

        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(Error::TargetGone {
                detail: format!("等待 {method} 期间连接被拆除"),
            }),
            Err(_) => {
                // 把在途条目摘掉，否则一个永不返回的方法会长期占着表。
                lock(&self.pending).remove(&id);
                Err(Error::Timeout {
                    what: format!("CDP {method}"),
                    ms: timeout.as_millis() as u64,
                })
            }
        }
    }

    /// 求值一个表达式并取出可序列化结果。
    pub async fn evaluate(&self, expression: &str, options: EvalOptions) -> Result<Value> {
        let mut params = json!({
            "expression": expression,
            "awaitPromise": options.await_promise,
            "returnByValue": options.return_by_value,
            "userGesture": options.user_gesture,
            // Pylon 的 CSP 很严（script-src 'self'），被求值的代码里若用了 eval
            // 会撞 CSP；打开这个开关让调试通道不受页面 CSP 限制。
            "allowUnsafeEvalBlockedByCSP": true,
            "includeCommandLineAPI": false,
        });
        if let Some(timeout) = options.timeout {
            // CDP 侧也设一份：这样「页面里的 Promise 永不 settle」时
            // CDP 自己会先报错，我们能拿到比本地超时更具体的现场。
            params["timeout"] = json!(timeout.as_millis() as u64);
        }
        let timeout = options.timeout.unwrap_or(self.default_timeout);
        let raw = self
            .call_with_timeout("Runtime.evaluate", params, timeout)
            .await?;
        extract_eval_result(&raw)
    }
}

/// 把 `Runtime.evaluate` 的返回折成「值」或「异常」。
///
/// `returnByValue` 只在结果可序列化时给 `value`；不可序列化的（DOM 节点、函数、
/// Symbol）只给 `description`——这种情况明确标 `__unserializable`，
/// 而不是返回 `null` 让调用方误以为求值结果就是 null。
pub fn extract_eval_result(raw: &Value) -> Result<Value> {
    if let Some(details) = raw.get("exceptionDetails").filter(|v| !v.is_null()) {
        let detail = details
            .get("exception")
            .and_then(|exception| exception.get("description"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                details
                    .get("exception")
                    .and_then(|exception| exception.get("value"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| {
                details
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| details.to_string());
        let line = details
            .get("lineNumber")
            .and_then(Value::as_i64)
            .map(|n| n + 1);
        let column = details.get("columnNumber").and_then(Value::as_i64);
        let url = details.get("url").and_then(Value::as_str);
        let location = match (url, line) {
            (Some(url), Some(line)) => format!(
                "（{url}:{line}{}）",
                column.map(|c| format!(":{c}")).unwrap_or_default()
            ),
            (None, Some(line)) => format!("（行 {line}）"),
            _ => String::new(),
        };
        return Err(Error::JsException { detail, location });
    }

    let remote = raw.get("result").cloned().unwrap_or(Value::Null);
    if let Some(value) = remote.get("value") {
        return Ok(value.clone());
    }
    match remote.get("type").and_then(Value::as_str) {
        None | Some("undefined") => Ok(Value::Null),
        Some(kind) => Ok(json!({
            "__unserializable": true,
            "type": kind,
            "description": remote.get("description").cloned().unwrap_or(Value::Null),
        })),
    }
}

fn dispatch(text: &str, pending: &Pending, events: &Arc<StdMutex<EventLog>>) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        return;
    };

    if let Some(id) = message.get("id").and_then(Value::as_i64) {
        let entry = lock(pending).remove(&id);
        let Some((method, sender)) = entry else {
            // 超时后迟到的响应：正常情况，静默丢弃。
            return;
        };
        let outcome = match message.get("error").filter(|v| !v.is_null()) {
            Some(error) => Err(Error::Cdp {
                method,
                detail: describe_cdp_error(error),
            }),
            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
        };
        let _ = sender.send(outcome);
        return;
    }

    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return;
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    lock(events).ingest(method, &params);
}

fn fail_pending(pending: &Pending, detail: &str) {
    let drained: Vec<_> = lock(pending).drain().map(|(_, entry)| entry).collect();
    for (method, sender) in drained {
        let _ = sender.send(Err(Error::TargetGone {
            detail: format!("{detail}（在途调用：{method}）"),
        }));
    }
}

fn describe_cdp_error(error: &Value) -> String {
    let code = error.get("code").and_then(Value::as_i64);
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("no message");
    let data = error
        .get("data")
        .map(|d| format!(" data={d}"))
        .unwrap_or_default();
    match code {
        Some(code) => format!("[{code}] {message}{data}"),
        None => format!("{message}{data}"),
    }
}

/// 所有锁点走同一个取毒策略：读事件缓冲/调用表的临界区都很短且不 panic，
/// 因此中毒后继续用（而不是把整个会话作废）是安全的。
fn lock<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 让 `Mutex<HashMap>` 的 `drain` 在 `MutexGuard` 上可直接用。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_value_passthrough() {
        let raw = json!({ "result": { "type": "object", "value": { "ok": true, "n": 3 } } });
        assert_eq!(
            extract_eval_result(&raw).unwrap(),
            json!({"ok": true, "n": 3})
        );
    }

    #[test]
    fn undefined_result_is_null_not_unserializable() {
        let raw = json!({ "result": { "type": "undefined" } });
        assert_eq!(extract_eval_result(&raw).unwrap(), Value::Null);
    }

    #[test]
    fn unserializable_result_keeps_its_description() {
        let raw =
            json!({ "result": { "type": "object", "subtype": "node", "description": "div#app" } });
        let value = extract_eval_result(&raw).unwrap();
        assert_eq!(value["__unserializable"], true);
        assert_eq!(value["description"], "div#app");
    }

    #[test]
    fn exception_details_become_a_js_exception_with_location() {
        let raw = json!({
            "result": { "type": "object" },
            "exceptionDetails": {
                "text": "Uncaught",
                "url": "app.js",
                "lineNumber": 9,
                "columnNumber": 2,
                "exception": { "type": "object", "description": "TypeError: nope" }
            }
        });
        let error = extract_eval_result(&raw).unwrap_err();
        assert_eq!(error.kind(), "js_exception");
        let text = error.to_string();
        assert!(text.contains("TypeError: nope"), "{text}");
        // lineNumber 是 0-based，展示要 +1。
        assert!(text.contains("app.js:10:2"), "{text}");
    }

    #[test]
    fn cdp_error_includes_code_message_and_data() {
        let error = json!({ "code": -32601, "message": "'Foo.bar' wasn't found", "data": "extra" });
        let described = describe_cdp_error(&error);
        assert!(described.contains("-32601"));
        assert!(described.contains("wasn't found"));
        assert!(described.contains("extra"));
    }

    #[test]
    fn dispatch_routes_response_to_waiter_and_event_to_log() {
        let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
        let events = Arc::new(StdMutex::new(EventLog::new()));
        let (sender, mut receiver) = oneshot::channel();
        lock(&pending).insert(7, ("Runtime.evaluate".to_string(), sender));

        dispatch(
            r#"{"id":7,"result":{"result":{"type":"number","value":1}}}"#,
            &pending,
            &events,
        );
        let outcome = receiver.try_recv().unwrap().unwrap();
        assert_eq!(outcome["result"]["value"], 1);
        assert!(lock(&pending).is_empty());

        dispatch(
            r#"{"method":"Runtime.consoleAPICalled","params":{"type":"log","args":[{"type":"string","value":"hi"}]}}"#,
            &pending,
            &events,
        );
        assert_eq!(lock(&events).buffered(crate::cdp::events::Kind::Console), 1);
    }

    #[test]
    fn dispatch_surfaces_cdp_error_with_the_originating_method() {
        let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
        let events = Arc::new(StdMutex::new(EventLog::new()));
        let (sender, mut receiver) = oneshot::channel();
        lock(&pending).insert(1, ("Page.captureScreenshot".to_string(), sender));

        dispatch(
            r#"{"id":1,"error":{"code":-32601,"message":"method not found"}}"#,
            &pending,
            &events,
        );
        let error = receiver.try_recv().unwrap().unwrap_err();
        assert_eq!(error.kind(), "cdp_error");
        assert!(error.to_string().contains("Page.captureScreenshot"));
    }

    #[test]
    fn late_response_for_unknown_id_does_not_panic() {
        let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
        let events = Arc::new(StdMutex::new(EventLog::new()));
        dispatch(r#"{"id":999,"result":{}}"#, &pending, &events);
    }

    #[test]
    fn malformed_frame_is_ignored() {
        let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
        let events = Arc::new(StdMutex::new(EventLog::new()));
        dispatch("not json at all", &pending, &events);
        dispatch(r#"{"id":1"#, &pending, &events);
    }

    #[test]
    fn disconnect_fails_every_inflight_call_immediately() {
        let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
        let (first, mut first_rx) = oneshot::channel();
        let (second, mut second_rx) = oneshot::channel();
        lock(&pending).insert(1, ("Runtime.evaluate".to_string(), first));
        lock(&pending).insert(2, ("Page.reload".to_string(), second));

        fail_pending(&pending, "CDP websocket 已关闭");

        for receiver in [&mut first_rx, &mut second_rx] {
            let error = receiver.try_recv().unwrap().unwrap_err();
            assert_eq!(error.kind(), "target_gone");
        }
        assert!(lock(&pending).is_empty());
    }
}
