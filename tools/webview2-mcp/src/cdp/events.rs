//! CDP 事件归一化与环形缓冲。
//!
//! 上游事件是 CDP 原始 params（体积大、字段深、`Runtime.consoleAPICalled` 的
//! `args` 是 RemoteObject）。直接回灌给 agent 会淹没上下文，所以在**入缓冲时**
//! 就归一化成扁平形状，读时不再做二次解释。
//!
//! 游标语义（关键）：每条记录带单调递增 `seq`。默认读取推进游标，因此
//! 「动作 → 读增量」的排障循环天然可用；显式传 `since_seq` 则是无副作用的重读。

use std::collections::{HashMap, VecDeque};

use serde_json::{json, Value};

/// 控制台/异常/日志类缓冲容量。超限丢最旧并累加 `evicted`，
/// 让调用方知道「读到的不是全量」而不是静默丢失。
const CONSOLE_CAPACITY: usize = 3000;
/// 网络类缓冲容量。按 requestId 去重合并，所以 3000 条 ≈ 3000 个请求。
const NETWORK_CAPACITY: usize = 3000;
/// WebSocket 缓冲容量。帧是「每条一个记录」，比请求密集得多，所以容量单独给一份，
/// 避免聊天类长连接把网络缓冲挤空。
const WEBSOCKET_CAPACITY: usize = 2000;
/// WebSocket 帧载荷的截断长度。帧可能很大，而 agent 通常只需要看开头。
const WS_PAYLOAD_CLIP: usize = 512;
/// `requestId → ws url` 记忆表的容量上限。超出后整体清空（不常用），
/// 防止被大量短连接撑成无界增长。
const WS_URL_MEMORY: usize = 256;

/// 单条记录里长字符串的上限，防止一条巨型 console.log 撑爆上下文。
const FIELD_CLIP: usize = 2000;

/// `requestWillBeSent` 整体替换旧记录时，要从旧记录里带回来的字段。
///
/// 这些都由 `*ExtraInfo` 事件写入（线上真实的请求头 / 响应头 / 状态码），
/// 而它们可能先于 `requestWillBeSent` 到达——若无条件整体替换，CORS 现场会被抹掉。
const CARRIED_ON_REPLACE: [&str; 7] = [
    "startedAt",
    "rawRequestHeaders",
    "clientSecurityState",
    "extraStatus",
    "rawResponseHeaders",
    "blockedRequestCookiesCount",
    "resourceIPAddressSpace",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Console,
    Network,
    WebSocket,
}

impl Kind {
    pub fn key(self) -> &'static str {
        match self {
            Kind::Console => "console",
            Kind::Network => "network",
            Kind::WebSocket => "websocket",
        }
    }
}

/// 一次读取的结果。
#[derive(Debug, Clone)]
pub struct ReadOutcome {
    /// 命中的记录（已按 seq 升序）。
    pub entries: Vec<Value>,
    /// 本次实际检视过的记录数（含被过滤掉的）。用来说明「窗口有多大」。
    pub scanned: usize,
    /// 读取后游标位置。下次不传 `since_seq` 就从这里继续。
    pub cursor: u64,
    /// 游标**之前**已被容量淘汰的记录数（累计）。非零表示增量有缺口。
    pub evicted: u64,
}

#[derive(Debug, Clone)]
pub struct EventLog {
    console: VecDeque<Value>,
    network: VecDeque<Value>,
    websocket: VecDeque<Value>,
    /// requestId → ws url。帧事件本身不带 url，记忆一份让每条帧记录自解释，
    /// 省得 agent 自己去跟「created」记录对照。
    ws_urls: HashMap<String, String>,
    seq: u64,
    cursors: HashMap<&'static str, u64>,
    evicted_console: u64,
    evicted_network: u64,
    evicted_websocket: u64,
}

impl Default for EventLog {
    fn default() -> Self {
        Self::new()
    }
}

impl EventLog {
    pub fn new() -> Self {
        Self {
            console: VecDeque::new(),
            network: VecDeque::new(),
            websocket: VecDeque::new(),
            ws_urls: HashMap::new(),
            seq: 0,
            cursors: HashMap::new(),
            evicted_console: 0,
            evicted_network: 0,
            evicted_websocket: 0,
        }
    }

    pub fn cursor(&self, kind: Kind) -> u64 {
        self.cursors.get(kind.key()).copied().unwrap_or(0)
    }

    pub fn buffered(&self, kind: Kind) -> usize {
        match kind {
            Kind::Console => self.console.len(),
            Kind::Network => self.network.len(),
            Kind::WebSocket => self.websocket.len(),
        }
    }

    fn next_seq(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }

    /// 把一个 CDP 事件折进缓冲。无关方法直接丢弃。
    pub fn ingest(&mut self, method: &str, params: &Value) {
        match method {
            "Runtime.consoleAPICalled" => self.ingest_console(params),
            "Runtime.exceptionThrown" => self.ingest_exception(params),
            "Log.entryAdded" => self.ingest_log_entry(params),
            "Network.requestWillBeSent" => self.ingest_request(params),
            "Network.requestWillBeSentExtraInfo" => self.ingest_request_extra_info(params),
            "Network.responseReceived" => self.ingest_response(params),
            "Network.responseReceivedExtraInfo" => self.ingest_response_extra_info(params),
            "Network.loadingFailed" => self.ingest_loading_failed(params),
            "Network.loadingFinished" => self.ingest_loading_finished(params),
            "Network.webSocketCreated" => self.ingest_ws_created(params),
            "Network.webSocketWillSendHandshakeRequest" => self.ingest_ws_handshake_request(params),
            "Network.webSocketHandshakeResponseReceived" => {
                self.ingest_ws_handshake_response(params)
            }
            "Network.webSocketFrameSent" => self.ingest_ws_frame(params, "sent"),
            "Network.webSocketFrameReceived" => self.ingest_ws_frame(params, "received"),
            "Network.webSocketFrameError" => self.ingest_ws_frame_error(params),
            "Network.webSocketClosed" => self.ingest_ws_closed(params),
            _ => {}
        }
    }

    fn ingest_console(&mut self, params: &Value) {
        let args = params.get("args").and_then(Value::as_array);
        let text = args
            .map(|items| {
                items
                    .iter()
                    .map(format_remote_object)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();
        let stack = params
            .get("stackTrace")
            .and_then(|s| s.get("callFrames"))
            .and_then(Value::as_array)
            .and_then(|frames| frames.first())
            .map(describe_frame);
        let seq = self.next_seq();
        let record = json!({
            "seq": seq,
            "kind": "console",
            "type": params.get("type").and_then(Value::as_str).unwrap_or("log"),
            "text": clip(&text, FIELD_CLIP),
            "argCount": args.map(Vec::len).unwrap_or(0),
            "context": params.get("context").and_then(Value::as_str),
            "at": params.get("timestamp").and_then(Value::as_f64),
            "frame": stack,
        });
        push_capped(
            &mut self.console,
            record,
            CONSOLE_CAPACITY,
            &mut self.evicted_console,
        );
    }

    fn ingest_exception(&mut self, params: &Value) {
        let details = params
            .get("exceptionDetails")
            .cloned()
            .unwrap_or(Value::Null);
        let exception = details.get("exception").cloned().unwrap_or(Value::Null);
        let description = exception
            .get("description")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                details
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .or_else(|| {
                exception
                    .get("value")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "<无描述>".to_string());
        let seq = self.next_seq();
        let record = json!({
            "seq": seq,
            "kind": "exception",
            "type": "error",
            "text": clip(&description, FIELD_CLIP),
            "source": params.get("exceptionDetails").and_then(|d| d.get("url")).and_then(Value::as_str),
            "line": details.get("lineNumber").and_then(Value::as_i64),
            "column": details.get("columnNumber").and_then(Value::as_i64),
            "at": params.get("timestamp").and_then(Value::as_f64),
            "frame": details.get("stackTrace").and_then(|s| s.get("callFrames")).and_then(Value::as_array).and_then(|f| f.first()).map(describe_frame),
        });
        push_capped(
            &mut self.console,
            record,
            CONSOLE_CAPACITY,
            &mut self.evicted_console,
        );
    }

    fn ingest_log_entry(&mut self, params: &Value) {
        let entry = params.get("entry").cloned().unwrap_or(Value::Null);
        let seq = self.next_seq();
        let record = json!({
            "seq": seq,
            "kind": "log",
            "type": entry.get("level").and_then(Value::as_str).unwrap_or("info"),
            "text": clip(entry.get("text").and_then(Value::as_str).unwrap_or(""), FIELD_CLIP),
            "source": entry.get("source").and_then(Value::as_str),
            "url": entry.get("url").and_then(Value::as_str),
            "line": entry.get("lineNumber").and_then(Value::as_i64),
            "at": entry.get("timestamp").and_then(Value::as_f64),
            "frame": Value::Null,
        });
        push_capped(
            &mut self.console,
            record,
            CONSOLE_CAPACITY,
            &mut self.evicted_console,
        );
    }

    fn ingest_request(&mut self, params: &Value) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let request = params.get("request").cloned().unwrap_or(Value::Null);
        let seq = self.next_seq();
        let now = now_ms();
        let record = json!({
            "seq": seq,
            "kind": "network",
            "phase": "request",
            "requestId": request_id,
            "method": request.get("method").and_then(Value::as_str).unwrap_or("GET"),
            "url": clip(request.get("url").and_then(Value::as_str).unwrap_or(""), FIELD_CLIP),
            "resourceType": params.get("type").and_then(Value::as_str),
            "headers": clip_headers(request.get("headers")),
            "postDataPreview": request.get("postData").and_then(Value::as_str).map(|d| clip(d, 512)),
            "startedAt": now,
            "updatedAt": now,
            "status": Value::Null,
            "statusText": Value::Null,
            "mimeType": Value::Null,
            "responseHeaders": Value::Null,
            "fromCache": Value::Null,
            "encodedDataLength": Value::Null,
            "finished": false,
            "failed": Value::Null,
        });
        // 同一 requestId 重发（redirect）时整体替换：见 network_replace 的注释。
        self.network_replace(request_id, record);
    }

    fn ingest_response(&mut self, params: &Value) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let response = params.get("response").cloned().unwrap_or(Value::Null);
        let status = response.get("status").and_then(Value::as_i64);
        let status_text = response.get("statusText").and_then(Value::as_str);
        let mime = response
            .get("mimeType")
            .and_then(Value::as_str)
            .map(str::to_string);
        let headers = clip_headers(response.get("headers"));
        let from_cache = response.get("fromDiskCache").and_then(Value::as_bool);
        let from_service_worker = response.get("fromServiceWorker").and_then(Value::as_bool);
        let url = response
            .get("url")
            .and_then(Value::as_str)
            .map(|u| clip(u, FIELD_CLIP));
        let fallback = self.blank_network_record(request_id);
        self.network_merge(request_id, fallback, move |record| {
            let Some(object) = record.as_object_mut() else {
                return;
            };
            object.insert("phase".into(), json!("response"));
            object.insert("status".into(), json!(status));
            object.insert("statusText".into(), json!(status_text));
            object.insert("mimeType".into(), json!(mime));
            object.insert("responseHeaders".into(), headers);
            object.insert("fromCache".into(), json!(from_cache));
            object.insert("fromServiceWorker".into(), json!(from_service_worker));
            if let Some(url) = url {
                object.insert("url".into(), json!(url));
            }
        });
    }

    fn ingest_loading_failed(&mut self, params: &Value) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let error_text = params
            .get("errorText")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let canceled = params.get("canceled").and_then(Value::as_bool);
        let blocked = params
            .get("blockedReason")
            .and_then(Value::as_str)
            .map(str::to_string);
        let fallback = self.blank_network_record(request_id);
        self.network_merge(request_id, fallback, move |record| {
            let Some(object) = record.as_object_mut() else {
                return;
            };
            object.insert("phase".into(), json!("failed"));
            object.insert("failed".into(), json!(error_text));
            object.insert("canceled".into(), json!(canceled));
            object.insert("blockedReason".into(), json!(blocked));
        });
    }

    fn ingest_loading_finished(&mut self, params: &Value) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let length = params.get("encodedDataLength").and_then(Value::as_f64);
        let fallback = self.blank_network_record(request_id);
        self.network_merge(request_id, fallback, move |record| {
            let Some(object) = record.as_object_mut() else {
                return;
            };
            object.insert("finished".into(), json!(true));
            object.insert("encodedDataLength".into(), json!(length));
        });
    }

    /// `requestWillBeSentExtraInfo`：网络栈**实际发出**的请求头。
    ///
    /// 与 `requestWillBeSent` 里的 `headers` 不是一回事——后者是页面侧传下来的，
    /// 前者才是线上真实的一份（含 Cookie 与网络栈补的头部）。排 CORS / 认证 /
    /// 私有网络策略问题时，两份的差异往往就是答案，所以不覆盖，另存 `raw*`。
    fn ingest_request_extra_info(&mut self, params: &Value) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let headers = clip_headers(params.get("headers"));
        let security = params
            .get("clientSecurityState")
            .cloned()
            .unwrap_or(Value::Null);
        let fallback = self.blank_network_record(request_id);
        self.network_merge(request_id, fallback, move |record| {
            let Some(object) = record.as_object_mut() else {
                return;
            };
            object.insert("rawRequestHeaders".into(), headers);
            object.insert("clientSecurityState".into(), security);
        });
    }

    /// `responseReceivedExtraInfo`：网络栈**实际收到**的响应头与状态码。
    ///
    /// 被 CORS / 私有网络策略拦下的请求，只会在这里出现真实状态码——
    /// `responseReceived` 对这类请求根本不触发。同样不覆盖主字段，另存 `extra*`，
    /// 让「页面看到的」与「线上发生的」可以对照着看。
    fn ingest_response_extra_info(&mut self, params: &Value) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let status = params.get("statusCode").and_then(Value::as_i64);
        let headers = clip_headers(params.get("headers"));
        let blocked_cookies = params
            .get("blockedRequestCookies")
            .and_then(Value::as_array)
            .map(Vec::len);
        let address_space = params
            .get("resourceIPAddressSpace")
            .and_then(Value::as_str)
            .map(str::to_string);
        let fallback = self.blank_network_record(request_id);
        self.network_merge(request_id, fallback, move |record| {
            let Some(object) = record.as_object_mut() else {
                return;
            };
            object.insert("extraStatus".into(), json!(status));
            object.insert("rawResponseHeaders".into(), headers);
            object.insert("blockedRequestCookiesCount".into(), json!(blocked_cookies));
            object.insert("resourceIPAddressSpace".into(), json!(address_space));
        });
    }

    // ── WebSocket：连接级事件 + 帧 ──

    fn ws_url_for(&self, request_id: &str) -> Value {
        self.ws_urls
            .get(request_id)
            .map(|url| Value::String(url.clone()))
            .unwrap_or(Value::Null)
    }

    fn remember_ws_url(&mut self, request_id: &str, url: &str) {
        if self.ws_urls.len() >= WS_URL_MEMORY && !self.ws_urls.contains_key(request_id) {
            self.ws_urls.clear();
        }
        self.ws_urls.insert(request_id.to_string(), url.to_string());
    }

    /// 所有 WS 记录的唯一写路径：打 seq 与时间戳后入缓冲。
    ///
    /// 与 network 不同，这里不做按 requestId 合并——帧是一条流水，压成一条就看不见
    /// 顺序了。代价是缓冲按帧消耗，所以容量单独一份（[`WEBSOCKET_CAPACITY`]）。
    fn push_ws(&mut self, mut record: Value) {
        let seq = self.next_seq();
        if let Some(object) = record.as_object_mut() {
            object.insert("seq".into(), json!(seq));
            object.insert("at".into(), json!(now_ms()));
        }
        push_capped(
            &mut self.websocket,
            record,
            WEBSOCKET_CAPACITY,
            &mut self.evicted_websocket,
        );
    }

    fn ingest_ws_created(&mut self, params: &Value) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let url = clip(
            params.get("url").and_then(Value::as_str).unwrap_or(""),
            FIELD_CLIP,
        );
        self.remember_ws_url(request_id, &url);
        let initiator = params
            .get("initiator")
            .and_then(|initiator| initiator.get("type"))
            .and_then(Value::as_str)
            .map(str::to_string);
        let record = json!({
            "kind": "websocket",
            "phase": "created",
            "requestId": request_id,
            "url": url,
            "initiatorType": initiator,
        });
        self.push_ws(record);
    }

    fn ingest_ws_handshake_request(&mut self, params: &Value) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let headers = clip_headers(
            params
                .get("request")
                .and_then(|request| request.get("headers")),
        );
        let record = json!({
            "kind": "websocket",
            "phase": "handshake-request",
            "requestId": request_id,
            "url": self.ws_url_for(request_id),
            "headers": headers,
        });
        self.push_ws(record);
    }

    fn ingest_ws_handshake_response(&mut self, params: &Value) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let response = params.get("response").cloned().unwrap_or(Value::Null);
        let record = json!({
            "kind": "websocket",
            "phase": "handshake-response",
            "requestId": request_id,
            "url": self.ws_url_for(request_id),
            "status": response.get("status").and_then(Value::as_i64),
            "statusText": response.get("statusText").and_then(Value::as_str),
            "headers": clip_headers(response.get("headers")),
        });
        self.push_ws(record);
    }

    fn ingest_ws_frame(&mut self, params: &Value, direction: &'static str) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let frame = params.get("response").cloned().unwrap_or(Value::Null);
        let opcode = frame.get("opcode").and_then(Value::as_i64);
        let payload = frame
            .get("payloadData")
            .and_then(Value::as_str)
            .unwrap_or("");
        let full_length = payload.chars().count();
        let record = json!({
            "kind": "websocket",
            "phase": "frame",
            "direction": direction,
            "requestId": request_id,
            "url": self.ws_url_for(request_id),
            "opcode": opcode,
            "opcodeName": opcode_name(opcode),
            "payloadLength": full_length,
            "payload": clip(payload, WS_PAYLOAD_CLIP),
            "payloadTruncated": full_length > WS_PAYLOAD_CLIP,
        });
        self.push_ws(record);
    }

    fn ingest_ws_frame_error(&mut self, params: &Value) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let record = json!({
            "kind": "websocket",
            "phase": "frame-error",
            "requestId": request_id,
            "url": self.ws_url_for(request_id),
            "error": params.get("errorMessage").and_then(Value::as_str),
        });
        self.push_ws(record);
    }

    fn ingest_ws_closed(&mut self, params: &Value) {
        let Some(request_id) = params.get("requestId").and_then(Value::as_str) else {
            return;
        };
        let record = json!({
            "kind": "websocket",
            "phase": "closed",
            "requestId": request_id,
            "url": self.ws_url_for(request_id),
        });
        self.push_ws(record);
        // 连接已关，url 记忆表不必再留着它。
        self.ws_urls.remove(request_id);
    }

    fn blank_network_record(&self, request_id: &str) -> Value {
        json!({
            "seq": 0,
            "kind": "network",
            "phase": "unknown",
            "requestId": request_id,
            "method": Value::Null,
            "url": Value::Null,
            "resourceType": Value::Null,
            "headers": Value::Null,
            "postDataPreview": Value::Null,
            "startedAt": now_ms(),
            "updatedAt": now_ms(),
            "status": Value::Null,
            "statusText": Value::Null,
            "mimeType": Value::Null,
            "responseHeaders": Value::Null,
            "fromCache": Value::Null,
            "encodedDataLength": Value::Null,
            "finished": false,
            "failed": Value::Null,
        })
    }

    fn network_position(&self, request_id: &str) -> Option<usize> {
        self.network
            .iter()
            .position(|record| record.get("requestId").and_then(Value::as_str) == Some(request_id))
    }

    /// 打上 `seq` / `updatedAt` 后入队。
    ///
    /// 所有写路径都必须过这里，否则会漏掉「网络缓冲按最后变更时间排序」这条不变量，
    /// 而 `read` 依赖它来保证容量淘汰的总是最久没更新的请求。
    fn push_network(&mut self, mut record: Value) {
        let seq = self.next_seq();
        if let Some(object) = record.as_object_mut() {
            object.insert("seq".into(), json!(seq));
            object.insert("updatedAt".into(), json!(now_ms()));
        }
        push_capped(
            &mut self.network,
            record,
            NETWORK_CAPACITY,
            &mut self.evicted_network,
        );
    }

    /// `requestWillBeSent` 的写路径：**整体替换**同 requestId 的旧记录。
    ///
    /// redirect 链上同一 requestId 会多次 `requestWillBeSent`，旧记录里的 url
    /// 对新一跳已经不成立；合并会让缓冲里留一条自相矛盾的记录。
    /// 保留首次的 `startedAt`（redirect 链的起点比最后一次跳转更有诊断价值），
    /// 以及 [`CARRIED_ON_REPLACE`] 里的「线上真实信息」——那些由 `*ExtraInfo`
    /// 事件写入，可能先于本事件到达，替换时丢掉就等于把 CORS 现场抹掉。
    fn network_replace(&mut self, request_id: &str, mut record: Value) {
        if let Some(index) = self.network_position(request_id) {
            let previous = self.network.remove(index).unwrap_or(Value::Null);
            if let Some(object) = record.as_object_mut() {
                for key in CARRIED_ON_REPLACE {
                    let carried = previous.get(key).filter(|value| !value.is_null());
                    if let Some(carried) = carried {
                        object.insert(key.into(), carried.clone());
                    }
                }
            }
        }
        self.push_network(record);
    }

    /// `responseReceived` / `loadingFinished` / `loadingFailed` 的写路径：
    /// **就地合并**，保留 request 阶段已经拿到的 url / method / headers。
    fn network_merge<F>(&mut self, request_id: &str, fallback: Value, patch: F)
    where
        F: FnOnce(&mut Value),
    {
        let mut record = match self.network_position(request_id) {
            Some(index) => self.network.remove(index).unwrap_or(fallback),
            None => fallback,
        };
        patch(&mut record);
        self.push_network(record);
    }

    /// 读增量。
    ///
    /// - `since_seq = None`：从游标读，并把游标推进到本次扫描的最后一条。
    /// - `since_seq = Some(n)`：从 n 读，**不动游标**（无副作用重读）。
    /// - `scan`：本次最多检视多少条；`limit`：最多返回多少条命中。
    ///   分成两个上限是刻意的——「最近 50 条 error」不该因为中间夹了 1000 条
    ///   info 就搜不到，但也不能真的把整个缓冲拉满。
    pub fn read<F>(
        &mut self,
        kind: Kind,
        since_seq: Option<u64>,
        scan: usize,
        limit: usize,
        matches: F,
    ) -> ReadOutcome
    where
        F: Fn(&Value) -> bool,
    {
        let from = since_seq.unwrap_or_else(|| self.cursor(kind));
        let evicted = match kind {
            Kind::Console => self.evicted_console,
            Kind::Network => self.evicted_network,
            Kind::WebSocket => self.evicted_websocket,
        };

        let (entries, scanned, last_scanned) = {
            let buffer = match kind {
                Kind::Console => &self.console,
                Kind::Network => &self.network,
                Kind::WebSocket => &self.websocket,
            };
            // 一律按 seq 升序检视，保证增量不漏。排序在**索引**上做：
            // 整缓冲深拷贝（最多 3000 条带 headers 的 Value）是纯开销——
            // 读增量通常只关心末尾几条，只 clone 命中的那些就够了。
            let mut order: Vec<usize> = (0..buffer.len()).collect();
            order.sort_unstable_by_key(|index| seq_of(&buffer[*index]));

            let mut entries = Vec::new();
            let mut scanned = 0usize;
            let mut last_scanned = from;
            for index in order {
                let record = &buffer[index];
                let seq = seq_of(record);
                if seq <= from {
                    continue;
                }
                if scanned >= scan {
                    break;
                }
                scanned += 1;
                last_scanned = seq;
                if entries.len() < limit && matches(record) {
                    entries.push(record.clone());
                }
            }
            (entries, scanned, last_scanned)
        };

        if since_seq.is_none() {
            self.cursors.insert(kind.key(), last_scanned.max(from));
        }
        let cursor = self.cursor(kind);
        ReadOutcome {
            entries,
            scanned,
            cursor,
            evicted,
        }
    }

    /// 清空缓冲并把游标归零。用于「从现在开始看」。
    pub fn reset(&mut self, kind: Kind) {
        match kind {
            Kind::Console => {
                self.console.clear();
                self.evicted_console = 0;
            }
            Kind::Network => {
                self.network.clear();
                self.evicted_network = 0;
            }
            Kind::WebSocket => {
                self.websocket.clear();
                self.evicted_websocket = 0;
            }
        }
        self.cursors.insert(kind.key(), self.seq);
    }

    /// 供读类工具报告缓冲健康度。
    pub fn stats(&self, kind: Kind) -> Value {
        json!({
            "kind": kind.key(),
            "buffered": self.buffered(kind),
            "capacity": capacity_of(kind),
            "evicted": match kind {
                Kind::Console => self.evicted_console,
                Kind::Network => self.evicted_network,
                Kind::WebSocket => self.evicted_websocket,
            },
            "cursor": self.cursor(kind),
            "latestSeq": self.seq,
        })
    }
}

fn capacity_of(kind: Kind) -> usize {
    match kind {
        Kind::Console => CONSOLE_CAPACITY,
        Kind::Network => NETWORK_CAPACITY,
        Kind::WebSocket => WEBSOCKET_CAPACITY,
    }
}

fn seq_of(record: &Value) -> u64 {
    record.get("seq").and_then(Value::as_u64).unwrap_or(0)
}

/// WebSocket 帧的 opcode → 名字（RFC 6455 §5.2）。
fn opcode_name(opcode: Option<i64>) -> Value {
    match opcode {
        Some(0) => json!("continuation"),
        Some(1) => json!("text"),
        Some(2) => json!("binary"),
        Some(8) => json!("close"),
        Some(9) => json!("ping"),
        Some(10) => json!("pong"),
        Some(other) => json!(format!("opcode-{other}")),
        None => Value::Null,
    }
}

fn push_capped(buffer: &mut VecDeque<Value>, record: Value, capacity: usize, evicted: &mut u64) {
    buffer.push_back(record);
    while buffer.len() > capacity {
        buffer.pop_front();
        *evicted += 1;
    }
}

fn clip(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}…[截断，原文 {} 字符]", text.chars().count())
}

fn clip_headers(headers: Option<&Value>) -> Value {
    match headers.and_then(Value::as_object) {
        None => Value::Null,
        Some(map) => {
            let mut out = serde_json::Map::new();
            for (index, (key, value)) in map.iter().enumerate() {
                if index >= 48 {
                    out.insert("__truncated".into(), json!(map.len() - index));
                    break;
                }
                match value.as_str() {
                    Some(text) => {
                        out.insert(key.clone(), json!(clip(text, 512)));
                    }
                    None => {
                        out.insert(key.clone(), value.clone());
                    }
                }
            }
            Value::Object(out)
        }
    }
}

/// RemoteObject → 一行文本。
///
/// 顺序很重要：`value` 优先（字符串/数字/布尔都有），再 `description`（对象/函数），
/// 再 `preview`（有 objectId 的大对象只有预览），最后退化成 `<type>`。
fn format_remote_object(remote: &Value) -> String {
    if let Some(value) = remote.get("value") {
        return match value {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
    }
    if let Some(description) = remote.get("description").and_then(Value::as_str) {
        return description.to_string();
    }
    if let Some(preview) = remote.get("preview") {
        return format_preview(preview);
    }
    match remote.get("type").and_then(Value::as_str) {
        Some(kind) => format!("<{kind}>"),
        None => "<unknown>".to_string(),
    }
}

fn format_preview(preview: &Value) -> String {
    let subtype = preview.get("subtype").and_then(Value::as_str).unwrap_or("");
    let properties = preview
        .get("properties")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let parts: Vec<String> = properties
        .iter()
        .map(|property| {
            let name = property.get("name").and_then(Value::as_str).unwrap_or("?");
            match property.get("value").and_then(Value::as_str) {
                Some(value) => format!("{name}: {value}"),
                None => {
                    let kind = property
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    format!("{name}: <{kind}>")
                }
            }
        })
        .collect();
    let overflow = preview
        .get("overflow")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let tail = if overflow { ", …" } else { "" };
    let body = parts.join(", ");
    if subtype == "array" {
        format!("[{body}{tail}]")
    } else {
        format!("{{{body}{tail}}}")
    }
}

fn describe_frame(frame: &Value) -> Value {
    json!({
        "function": frame.get("functionName").and_then(Value::as_str).unwrap_or(""),
        "url": frame.get("url").and_then(Value::as_str),
        "line": frame.get("lineNumber").and_then(Value::as_i64),
        "column": frame.get("columnNumber").and_then(Value::as_i64),
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_with(events: &[(&str, Value)]) -> EventLog {
        let mut log = EventLog::new();
        for (method, params) in events {
            log.ingest(method, params);
        }
        log
    }

    #[test]
    fn console_events_get_monotonic_seq_and_flat_text() {
        let log = log_with(&[
            (
                "Runtime.consoleAPICalled",
                json!({ "type": "log", "args": [ { "type": "string", "value": "hello" }, { "type": "number", "value": 42 } ] }),
            ),
            (
                "Runtime.consoleAPICalled",
                json!({ "type": "error", "args": [ { "type": "string", "value": "boom" } ] }),
            ),
        ]);
        let outcome = log_read(&log, None, 100, 100, |_| true);
        assert_eq!(outcome.entries.len(), 2);
        assert_eq!(outcome.entries[0]["text"], "hello 42");
        assert_eq!(outcome.entries[1]["type"], "error");
        assert_eq!(outcome.entries[1]["seq"], 2);
    }

    fn log_read<F: Fn(&Value) -> bool>(
        log: &EventLog,
        since: Option<u64>,
        scan: usize,
        limit: usize,
        matches: F,
    ) -> ReadOutcome {
        log.clone().read(Kind::Console, since, scan, limit, matches)
    }

    #[test]
    fn read_advances_cursor_and_returns_only_the_delta() {
        let mut log = log_with(&[(
            "Runtime.consoleAPICalled",
            json!({ "type": "log", "args": [ { "type": "string", "value": "first" } ] }),
        )]);
        let first = log.read(Kind::Console, None, 100, 100, |_| true);
        assert_eq!(first.entries.len(), 1);
        assert_eq!(first.cursor, 1);

        // 没有新事件 → 空增量，而不是重放。
        let second = log.read(Kind::Console, None, 100, 100, |_| true);
        assert!(second.entries.is_empty());
        assert_eq!(second.cursor, 1);

        log.ingest(
            "Runtime.consoleAPICalled",
            &json!({ "type": "warn", "args": [ { "type": "string", "value": "second" } ] }),
        );
        let third = log.read(Kind::Console, None, 100, 100, |_| true);
        assert_eq!(third.entries.len(), 1);
        assert_eq!(third.entries[0]["text"], "second");
    }

    #[test]
    fn explicit_since_seq_does_not_move_the_cursor() {
        let mut log = log_with(&[(
            "Runtime.consoleAPICalled",
            json!({ "type": "log", "args": [ { "type": "string", "value": "a" } ] }),
        )]);
        let explicit = log.read(Kind::Console, Some(0), 100, 100, |_| true);
        assert_eq!(explicit.entries.len(), 1);
        // 显式读取不得推进游标：否则同一段日志会在两种读法之间凭空消失。
        assert_eq!(log.cursor(Kind::Console), 0);
        let implicit = log.read(Kind::Console, None, 100, 100, |_| true);
        assert_eq!(implicit.entries.len(), 1);
        assert_eq!(log.cursor(Kind::Console), 1);
    }

    #[test]
    fn filter_searches_past_matching_scan_window_not_just_the_first_n() {
        // 先塞 50 条 info，再塞 1 条 error。
        let mut events = Vec::new();
        for _ in 0..50 {
            events.push((
                "Runtime.consoleAPICalled",
                json!({ "type": "log", "args": [ { "type": "string", "value": "noise" } ] }),
            ));
        }
        events.push((
            "Runtime.consoleAPICalled",
            json!({ "type": "error", "args": [ { "type": "string", "value": "target" } ] }),
        ));
        let mut log = log_with(&events);

        let outcome = log.read(Kind::Console, None, 100, 10, |record| {
            record.get("type").and_then(Value::as_str) == Some("error")
        });
        assert_eq!(outcome.entries.len(), 1);
        assert_eq!(outcome.entries[0]["text"], "target");
        assert_eq!(outcome.scanned, 51);
        // 命中的记录在窗口末端，游标必须走到那里，否则下轮会重放噪声。
        assert_eq!(outcome.cursor, 51);
    }

    #[test]
    fn network_events_merge_by_request_id_into_one_record() {
        let mut log = EventLog::new();
        log.ingest(
            "Network.requestWillBeSent",
            &json!({ "requestId": "1.1", "type": "Fetch", "request": { "method": "POST", "url": "http://ipc.localhost/x", "headers": { "Tauri-Invoke-Key": "k" } } }),
        );
        log.ingest(
            "Network.responseReceived",
            &json!({ "requestId": "1.1", "response": { "status": 200, "statusText": "OK", "mimeType": "application/json", "url": "http://ipc.localhost/x" } }),
        );
        log.ingest(
            "Network.loadingFinished",
            &json!({ "requestId": "1.1", "encodedDataLength": 128.0 }),
        );
        let outcome = log.read(Kind::Network, None, 100, 100, |_| true);
        assert_eq!(outcome.entries.len(), 1, "合并后应只有一条记录");
        let record = &outcome.entries[0];
        assert_eq!(record["method"], "POST");
        assert_eq!(record["status"], 200);
        assert_eq!(record["finished"], true);
        assert_eq!(record["encodedDataLength"], 128.0);
        assert_eq!(record["headers"]["Tauri-Invoke-Key"], "k");
    }

    #[test]
    fn failed_request_keeps_its_url_from_the_request_phase() {
        let mut log = EventLog::new();
        log.ingest(
            "Network.requestWillBeSent",
            &json!({ "requestId": "2", "request": { "method": "GET", "url": "http://localhost:5173/missing.js" } }),
        );
        log.ingest(
            "Network.loadingFailed",
            &json!({ "requestId": "2", "errorText": "net::ERR_CONNECTION_REFUSED", "canceled": false }),
        );
        let outcome = log.read(Kind::Network, None, 100, 100, |_| true);
        assert_eq!(outcome.entries.len(), 1);
        assert_eq!(outcome.entries[0]["phase"], "failed");
        assert_eq!(outcome.entries[0]["failed"], "net::ERR_CONNECTION_REFUSED");
        // 合并不能丢 request 阶段的字段。
        assert_eq!(
            outcome.entries[0]["url"],
            "http://localhost:5173/missing.js"
        );
    }

    #[test]
    fn redirect_overwrites_instead_of_duplicating() {
        let mut log = EventLog::new();
        for url in ["http://a/1", "http://a/2", "http://a/3"] {
            log.ingest(
                "Network.requestWillBeSent",
                &json!({ "requestId": "r", "request": { "method": "GET", "url": url } }),
            );
        }
        let outcome = log.read(Kind::Network, None, 100, 100, |_| true);
        assert_eq!(outcome.entries.len(), 1);
        assert_eq!(outcome.entries[0]["url"], "http://a/3");
    }

    #[test]
    fn response_without_prior_request_still_produces_a_record() {
        let mut log = EventLog::new();
        log.ingest(
            "Network.responseReceived",
            &json!({ "requestId": "orphan", "response": { "status": 304, "mimeType": "text/css" } }),
        );
        let outcome = log.read(Kind::Network, None, 100, 100, |_| true);
        assert_eq!(outcome.entries.len(), 1);
        assert_eq!(outcome.entries[0]["status"], 304);
        assert_eq!(outcome.entries[0]["requestId"], "orphan");
    }

    #[test]
    fn exception_details_become_a_single_error_record() {
        let log = log_with(&[(
            "Runtime.exceptionThrown",
            json!({
                "timestamp": 1.5,
                "exceptionDetails": {
                    "text": "Uncaught",
                    "url": "tauri://localhost/assets/index.js",
                    "lineNumber": 12,
                    "columnNumber": 4,
                    "exception": { "type": "object", "description": "TypeError: x is not a function" },
                    "stackTrace": { "callFrames": [ { "functionName": "boot", "url": "app.js", "lineNumber": 9 } ] }
                }
            }),
        )]);
        let outcome = log_read(&log, None, 10, 10, |_| true);
        let record = &outcome.entries[0];
        assert_eq!(record["kind"], "exception");
        assert_eq!(record["text"], "TypeError: x is not a function");
        assert_eq!(record["line"], 12);
        assert_eq!(record["frame"]["function"], "boot");
    }

    #[test]
    fn log_entries_from_the_browser_are_captured_too() {
        let log = log_with(&[(
            "Log.entryAdded",
            json!({ "entry": { "level": "error", "source": "network", "text": "Failed to load resource", "url": "http://x/y", "lineNumber": 0 } }),
        )]);
        let outcome = log_read(&log, None, 10, 10, |_| true);
        assert_eq!(outcome.entries[0]["kind"], "log");
        assert_eq!(outcome.entries[0]["type"], "error");
        assert_eq!(outcome.entries[0]["source"], "network");
    }

    #[test]
    fn unrelated_cdp_events_are_ignored_not_buffered() {
        let log = log_with(&[
            ("Debugger.scriptParsed", json!({ "scriptId": "1" })),
            ("Page.frameNavigated", json!({ "frame": {} })),
            ("Runtime.executionContextCreated", json!({ "context": {} })),
        ]);
        assert_eq!(log.buffered(Kind::Console), 0);
        assert_eq!(log.buffered(Kind::Network), 0);
    }

    #[test]
    fn oversized_console_argument_is_clipped_with_a_visible_marker() {
        let huge = "x".repeat(FIELD_CLIP + 100);
        let log = log_with(&[(
            "Runtime.consoleAPICalled",
            json!({ "type": "log", "args": [ { "type": "string", "value": huge } ] }),
        )]);
        let outcome = log_read(&log, None, 10, 10, |_| true);
        let text = outcome.entries[0]["text"].as_str().unwrap_or_default();
        assert!(text.contains("截断"), "{text}");
        assert!(
            text.chars().count() < FIELD_CLIP + 64,
            "{}",
            text.chars().count()
        );
        // 多字节字符按字符截断，不能切断 UTF-8。
        assert!(text.is_char_boundary(text.len()));
    }

    #[test]
    fn eviction_is_reported_so_a_gap_in_the_delta_is_visible() {
        let mut log = EventLog::new();
        for _ in 0..(CONSOLE_CAPACITY + 5) {
            log.ingest(
                "Runtime.consoleAPICalled",
                &json!({ "type": "log", "args": [ { "type": "string", "value": "n" } ] }),
            );
        }
        let outcome = log.read(Kind::Console, None, 10, 10, |_| true);
        assert_eq!(outcome.evicted, 5);
        assert_eq!(log.buffered(Kind::Console), CONSOLE_CAPACITY);
    }

    #[test]
    fn object_arguments_fall_back_to_preview_then_description_then_type() {
        let log = log_with(&[(
            "Runtime.consoleAPICalled",
            json!({ "type": "log", "args": [
                { "type": "object", "subtype": "array", "preview": { "subtype": "array", "overflow": true, "properties": [ { "name": "0", "type": "number", "value": "1" }, { "name": "1", "type": "number", "value": "2" } ] } },
                { "type": "function", "description": "function boot() { … }" },
                { "type": "symbol" }
            ] }),
        )]);
        let outcome = log_read(&log, None, 10, 10, |_| true);
        let text = outcome.entries[0]["text"].as_str().unwrap_or_default();
        assert!(text.contains("[0: 1, 1: 2, …]"), "{text}");
        assert!(text.contains("function boot()"), "{text}");
        assert!(text.contains("<symbol>"), "{text}");
    }

    #[test]
    fn websocket_events_become_a_self_describing_frame_stream() {
        let mut log = EventLog::new();
        log.ingest(
            "Network.webSocketCreated",
            &json!({ "requestId": "ws1", "url": "ws://127.0.0.1:9000/agent", "initiator": { "type": "script" } }),
        );
        log.ingest(
            "Network.webSocketHandshakeResponseReceived",
            &json!({ "requestId": "ws1", "response": { "status": 101, "statusText": "Switching Protocols", "headers": { "Upgrade": "websocket" } } }),
        );
        log.ingest(
            "Network.webSocketFrameSent",
            &json!({ "requestId": "ws1", "response": { "opcode": 1, "mask": true, "payloadData": "{\"jsonrpc\":\"2.0\"}" } }),
        );
        log.ingest(
            "Network.webSocketFrameReceived",
            &json!({ "requestId": "ws1", "response": { "opcode": 2, "payloadData": "AQID" } }),
        );
        log.ingest(
            "Network.webSocketFrameError",
            &json!({ "requestId": "ws1", "errorMessage": "connection reset" }),
        );
        log.ingest("Network.webSocketClosed", &json!({ "requestId": "ws1" }));

        let outcome = log.read(Kind::WebSocket, None, 100, 100, |_| true);
        assert_eq!(outcome.entries.len(), 6, "连接级事件与帧各占一条");
        let phases: Vec<&str> = outcome
            .entries
            .iter()
            .map(|entry| entry["phase"].as_str().unwrap_or(""))
            .collect();
        assert_eq!(
            phases,
            vec![
                "created",
                "handshake-response",
                "frame",
                "frame",
                "frame-error",
                "closed"
            ]
        );
        assert_eq!(outcome.entries[0]["initiatorType"], "script");
        assert_eq!(outcome.entries[1]["status"], 101);
        assert_eq!(outcome.entries[2]["opcodeName"], "text");
        assert_eq!(outcome.entries[2]["payload"], "{\"jsonrpc\":\"2.0\"}");
        assert_eq!(outcome.entries[3]["opcodeName"], "binary");
        assert_eq!(outcome.entries[4]["error"], "connection reset");
        // 每条帧都自带 url，不必回头对照 created 记录。
        for entry in &outcome.entries[2..] {
            assert_eq!(entry["url"], "ws://127.0.0.1:9000/agent", "{entry}");
        }
        assert_eq!(log.buffered(Kind::WebSocket), 6);
        // WS 记录不污染网络/控制台缓冲。
        assert_eq!(log.buffered(Kind::Network), 0);
        assert_eq!(log.buffered(Kind::Console), 0);
    }

    #[test]
    fn websocket_cursor_follows_the_same_delta_semantics() {
        let mut log = EventLog::new();
        log.ingest(
            "Network.webSocketFrameSent",
            &json!({ "requestId": "ws", "response": { "opcode": 1, "payloadData": "first" } }),
        );
        let first = log.read(Kind::WebSocket, None, 100, 100, |_| true);
        assert_eq!(first.entries.len(), 1);
        assert_eq!(first.cursor, 1);

        let second = log.read(Kind::WebSocket, None, 100, 100, |_| true);
        assert!(second.entries.is_empty(), "没有新帧就没有增量");
        assert_eq!(second.entries.len(), 0);
    }

    #[test]
    fn a_long_websocket_payload_is_clipped_but_its_length_survives() {
        let mut log = EventLog::new();
        let payload = "x".repeat(WS_PAYLOAD_CLIP + 500);
        log.ingest(
            "Network.webSocketFrameReceived",
            &json!({ "requestId": "ws", "response": { "opcode": 1, "payloadData": payload } }),
        );
        let outcome = log.read(Kind::WebSocket, None, 10, 10, |_| true);
        let entry = &outcome.entries[0];
        assert_eq!(entry["payloadTruncated"], true);
        assert_eq!(entry["payloadLength"], WS_PAYLOAD_CLIP + 500);
        assert!(entry["payload"].as_str().unwrap_or("").contains("截断"));
    }

    #[test]
    fn extra_info_headers_are_kept_alongside_the_page_side_ones() {
        let mut log = EventLog::new();
        log.ingest(
            "Network.requestWillBeSent",
            &json!({ "requestId": "1", "request": { "method": "GET", "url": "http://ipc.localhost/x", "headers": { "X-Page": "yes" } } }),
        );
        log.ingest(
            "Network.requestWillBeSentExtraInfo",
            &json!({ "requestId": "1", "headers": { "X-Page": "yes", "Cookie": "sid=1" } }),
        );
        log.ingest(
            "Network.responseReceivedExtraInfo",
            &json!({ "requestId": "1", "statusCode": 403, "headers": { "Access-Control-Allow-Origin": "*" }, "resourceIPAddressSpace": "Private" }),
        );

        let outcome = log.read(Kind::Network, None, 100, 100, |_| true);
        assert_eq!(outcome.entries.len(), 1);
        let record = &outcome.entries[0];
        assert_eq!(record["headers"]["X-Page"], "yes", "页面侧头部保留");
        assert_eq!(
            record["rawRequestHeaders"]["Cookie"], "sid=1",
            "线上真实头部另存"
        );
        assert_eq!(
            record["extraStatus"], 403,
            "CORS 拦下时只有 extraInfo 有真实状态码"
        );
        assert_eq!(
            record["rawResponseHeaders"]["Access-Control-Allow-Origin"],
            "*"
        );
        assert_eq!(record["resourceIPAddressSpace"], "Private");
    }

    #[test]
    fn a_late_request_event_does_not_wipe_extra_info_fields() {
        // 实测顺序不保证：extraInfo 可能先到，随后 requestWillBeSent 会整体替换。
        let mut log = EventLog::new();
        log.ingest(
            "Network.responseReceivedExtraInfo",
            &json!({ "requestId": "1", "statusCode": 200, "headers": { "X-Real": "1" } }),
        );
        log.ingest(
            "Network.requestWillBeSent",
            &json!({ "requestId": "1", "request": { "method": "GET", "url": "http://x/y" } }),
        );

        let outcome = log.read(Kind::Network, None, 100, 100, |_| true);
        assert_eq!(outcome.entries.len(), 1);
        let record = &outcome.entries[0];
        assert_eq!(record["url"], "http://x/y", "替换生效");
        assert_eq!(record["extraStatus"], 200, "替换不得抹掉 extra 字段");
        assert_eq!(record["rawResponseHeaders"]["X-Real"], "1");
    }

    #[test]
    fn reset_clears_buffer_and_moves_cursor_past_history() {
        let mut log = log_with(&[(
            "Runtime.consoleAPICalled",
            json!({ "type": "log", "args": [ { "type": "string", "value": "old" } ] }),
        )]);
        log.reset(Kind::Console);
        assert_eq!(log.buffered(Kind::Console), 0);
        log.ingest(
            "Runtime.consoleAPICalled",
            &json!({ "type": "log", "args": [ { "type": "string", "value": "new" } ] }),
        );
        let outcome = log.read(Kind::Console, None, 10, 10, |_| true);
        assert_eq!(outcome.entries.len(), 1);
        assert_eq!(outcome.entries[0]["text"], "new");
    }
}
