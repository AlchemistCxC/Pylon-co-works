//! Prism Sidecar 管理 API 客户端。
//!
//! 只允许连接本机 Prism HTTP 服务；读请求不带管理 token，写请求使用
//! `PRISM_ADMIN_API_TOKEN`。客户端不暴露任意 URL/HTTP method，避免把
//! Tauri command 变成通用 SSRF 或本地管理接口代理。

use reqwest::{Client, Method, Url};
use serde_json::Value;
use std::env;
use std::time::Duration;

const DEFAULT_BASE_URL: &str = "http://127.0.0.1:9337";
const MAX_ERROR_BODY: usize = 4096;
/// 成功响应体上限（防御性；本机服务正常响应远小于此）。
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PrismStatusCode {
    Connected,
    Unavailable,
    Unauthorized,
    ConfigurationError,
    Error,
}

impl PrismStatusCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Connected => "connected",
            Self::Unavailable => "unavailable",
            Self::Unauthorized => "unauthorized",
            Self::ConfigurationError => "configuration_error",
            Self::Error => "error",
        }
    }
}

#[derive(Clone)]
pub struct PrismClient {
    client: Client,
    base_url: Url,
    admin_token: Option<String>,
    configuration_error: Option<String>,
}

/// B11：Prism /inject 响应（注入上下文 + 激活条目）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectResult {
    pub context: String,
    pub activated: Vec<String>,
    pub source: String,
}

impl InjectResult {
    fn from_value(value: &Value) -> Result<Self, String> {
        Ok(Self {
            context: value.get("context").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
            activated: value.get("activated")
                .and_then(|v| v.as_array())
                .map(|items| items.iter().filter_map(|item| item.as_str()).map(str::to_string).collect())
                .unwrap_or_default(),
            source: value.get("source").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        })
    }
}

impl PrismClient {
    pub fn from_env() -> Result<Self, String> {
        let raw = env::var("PYLON_PRISM_URL")
            .unwrap_or_else(|_| DEFAULT_BASE_URL.to_string());
        let base_url = Url::parse(&raw)
            .map_err(|error| format!("invalid PYLON_PRISM_URL: {error}"))?;
        validate_loopback_url(&base_url)?;
        let admin_token = env::var("PRISM_ADMIN_API_TOKEN")
            .ok()
            .filter(|token| !token.trim().is_empty());
        Ok(Self {
            // 审查修复：禁重定向——本地 Prism 被攻陷/返回 3xx 时不得把请求（写接口带
            // Bearer）转发到外网 host。
            client: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| format!("create Prism HTTP client failed: {error}"))?,
            base_url,
            admin_token,
            configuration_error: None,
        })
    }

    pub fn unavailable(error: String) -> Self {
        // P3：不直接 expect。DEFAULT_BASE_URL 为编译期常量（单测
        // default_base_url_parses 钉死可解析）；万一被误改，把解析错误并入
        // configuration_error 而不是 panic——错误态客户端所有请求本就会
        // 立即失败，base_url 仅作 status() 展示占位（请求层不可达）。
        let base_url = match Url::parse(DEFAULT_BASE_URL) {
            Ok(url) => url,
            Err(parse_error) => {
                return Self {
                    client: Client::new(),
                    base_url: Url::parse("http://127.0.0.1:9337")
                        .expect("fallback 字面量与 DEFAULT_BASE_URL 相同，正常不可达"),
                    admin_token: None,
                    configuration_error: Some(format!("{error}；默认 Prism URL 不可解析: {parse_error}")),
                };
            }
        };
        Self {
            client: Client::new(),
            base_url,
            admin_token: None,
            configuration_error: Some(error),
        }
    }

    async fn request(&self, method: Method, url: Url, body: Option<Value>) -> Result<Value, String> {
        if let Some(error) = &self.configuration_error {
            return Err(format!("Prism configuration error: {error}"));
        }
        let is_write = method != Method::GET && method != Method::HEAD;
        let mut request = self.client.request(method.clone(), url);
        if is_write {
            let token = self.admin_token.as_deref()
                .ok_or_else(|| "PRISM_ADMIN_API_TOKEN 未配置，无法调用 Prism 写接口".to_string())?;
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await
            .map_err(|error| format!("Prism 请求失败: {error}"))?;
        let status = response.status();
        // P3：响应体上限——reqwest 未启用 "stream" feature（Cargo.toml 不可改），
        // bytes_stream 不可用，采用最小防护：Content-Length 预检 + 读完后二次校验。
        // 本机服务低危，仅防服务异常时大响应进入内存/JSON 解析。
        if let Some(len) = response.content_length() {
            if len > MAX_RESPONSE_BYTES as u64 {
                return Err(format!("Prism 响应超过 {MAX_RESPONSE_BYTES} 字节上限"));
            }
        }
        let text = response.text().await
            .map_err(|error| format!("读取 Prism 响应失败: {error}"))?;
        if text.len() > MAX_RESPONSE_BYTES {
            return Err(format!("Prism 响应超过 {MAX_RESPONSE_BYTES} 字节上限"));
        }
        if !status.is_success() {
            let detail: String = text.chars().take(MAX_ERROR_BODY).collect();
            return Err(format!("Prism HTTP {}: {}", status.as_u16(), detail));
        }
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text)
            .map_err(|error| format!("Prism 返回非法 JSON: {error}"))
    }

    fn endpoint(&self, path: &str) -> Result<Url, String> {
        // 审查修复：拒绝 `//host` 形态（RFC 3986 network-path reference 会经
        // Url::join 覆盖 authority → SSRF 潜伏洞）；`..`/`\` 仍拒绝。
        if !path.starts_with('/') || path.starts_with("//") || path.contains("..") || path.contains('\\') {
            return Err("非法 Prism API 路径".to_string());
        }
        self.base_url.join(path)
            .map_err(|error| format!("构造 Prism API URL 失败: {error}"))
    }

    pub async fn get(&self, path: &str) -> Result<Value, String> {
        self.request(Method::GET, self.endpoint(path)?, None).await
    }

    pub async fn status(&self) -> Value {
        if self.configuration_error.is_some() {
            return serde_json::json!({
                "status": PrismStatusCode::ConfigurationError.as_str(),
                "baseUrl": self.base_url.as_str(),
                "checkedAt": crate::runtime_log::timestamp(),
            });
        }
        let status = match self.get("/health").await {
            Ok(_) => PrismStatusCode::Connected,
            Err(error) => classify_status_error(&error),
        };
        serde_json::json!({
            "status": status.as_str(),
            "baseUrl": self.base_url.as_str(),
            "checkedAt": crate::runtime_log::timestamp(),
        })
    }

    pub async fn get_query<I, K, V>(&self, path: &str, query: I) -> Result<Value, String>
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
    {
        let mut url = self.endpoint(path)?;
        url.query_pairs_mut().extend_pairs(query);
        self.request(Method::GET, url, None).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        self.request(Method::POST, self.endpoint(path)?, Some(body)).await
    }

    /// B11：发送前置注入——POST /inject { scenario, sources, user_msg, round }。
    /// 返回 { context, activated, source }（字段缺失按空/默认容错）。
    pub async fn inject(&self, scenario: &str, sources: &[String], user_msg: &str, round: u64) -> Result<InjectResult, String> {
        let body = serde_json::json!({
            "scenario": scenario,
            "sources": sources,
            "user_msg": user_msg,
            "round": round,
        });
        let value = self.post("/inject", body).await?;
        InjectResult::from_value(&value)
    }

    /// B11.2：回合完成持久化——POST /persist { scenario, sources, user_msg, response, round }。
    /// 返回原始响应（ok/writes/errors 由调用方记录）。
    pub async fn persist_round(&self, scenario: &str, sources: &[String], user_msg: &str, response: &str, round: u64) -> Result<Value, String> {
        let body = serde_json::json!({
            "scenario": scenario,
            "sources": sources,
            "user_msg": user_msg,
            "response": response,
            "round": round,
        });
        self.post("/persist", body).await
    }

    /// 测试构造：任意 URL（桩服务），无 configuration_error（lib.rs 集成测试用）。
    #[cfg(test)]
    pub(crate) fn for_testing(url: String, token: Option<String>) -> Self {
        Self {
            client: Client::builder().build().expect("test HTTP client"),
            base_url: Url::parse(&url).expect("test base URL"),
            admin_token: token,
            configuration_error: None,
        }
    }

    pub async fn post_query<I, K, V>(&self, path: &str, query: I, body: Value) -> Result<Value, String>
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
    {
        let mut url = self.endpoint(path)?;
        url.query_pairs_mut().extend_pairs(query);
        self.request(Method::POST, url, Some(body)).await
    }

    pub async fn put_query<I, K, V>(&self, path: &str, query: I, body: Value) -> Result<Value, String>
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
    {
        let mut url = self.endpoint(path)?;
        url.query_pairs_mut().extend_pairs(query);
        self.request(Method::PUT, url, Some(body)).await
    }

    pub async fn delete_query<I, K, V>(&self, path: &str, query: I) -> Result<Value, String>
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
    {
        let mut url = self.endpoint(path)?;
        url.query_pairs_mut().extend_pairs(query);
        self.request(Method::DELETE, url, None).await
    }
}

fn validate_loopback_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("PYLON_PRISM_URL 只允许 http/https".to_string());
    }
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if !matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return Err("PYLON_PRISM_URL 必须指向 localhost/127.0.0.1/::1".to_string());
    }
    Ok(())
}

fn classify_status_error(error: &str) -> PrismStatusCode {
    if error.contains("Prism HTTP 401") || error.contains("Prism HTTP 403") {
        PrismStatusCode::Unauthorized
    } else if error.contains("invalid PYLON_PRISM_URL") || error.contains("PYLON_PRISM_URL") {
        PrismStatusCode::ConfigurationError
    } else if error.contains("Prism 请求失败") {
        PrismStatusCode::Unavailable
    } else {
        PrismStatusCode::Error
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    #[test]
    fn only_loopback_urls_are_allowed() {
        assert!(Url::parse("http://127.0.0.1:9337").is_ok());
        assert!(validate_loopback_url(&Url::parse("http://127.0.0.1:9337").unwrap()).is_ok());
        assert!(validate_loopback_url(&Url::parse("http://localhost:9337").unwrap()).is_ok());
        assert!(validate_loopback_url(&Url::parse("http://192.168.1.2:9337").unwrap()).is_err());
        assert!(validate_loopback_url(&Url::parse("file:///tmp/prism").unwrap()).is_err());
    }

    #[test]
    fn default_base_url_parses() {
        // P3：unavailable() 依赖该常量可解析（不再 expect，靠此测试钉死）
        assert!(Url::parse(DEFAULT_BASE_URL).is_ok(), "默认常量必须可解析");
    }

    #[test]
    fn api_paths_cannot_escape_the_fixed_base() {
        let client = PrismClient {
            client: Client::new(),
            base_url: Url::parse(DEFAULT_BASE_URL).unwrap(),
            admin_token: None,
            configuration_error: None,
        };
        assert!(client.endpoint("/health").is_ok());
        assert!(client.endpoint("/../etc/passwd").is_err());
        assert!(client.endpoint("http://evil.invalid/").is_err());
        // 审查修复回归：//host 形态不得覆盖 authority（SSRF）
        assert!(client.endpoint("//evil.invalid/").is_err());
    }

    #[test]
    fn status_error_classification_is_stable_and_secret_free() {
        assert_eq!(classify_status_error("Prism HTTP 401: secret"), PrismStatusCode::Unauthorized);
        assert_eq!(classify_status_error("Prism 请求失败: connection refused"), PrismStatusCode::Unavailable);
        assert_eq!(classify_status_error("invalid PYLON_PRISM_URL: bad URL"), PrismStatusCode::ConfigurationError);
        assert_eq!(classify_status_error("Prism 返回非法 JSON"), PrismStatusCode::Error);
        assert_eq!(PrismStatusCode::Unauthorized.as_str(), "unauthorized");
        assert_eq!(PrismStatusCode::ConfigurationError.as_str(), "configuration_error");
    }

    fn test_client(address: std::net::SocketAddr, token: Option<&str>) -> PrismClient {
        PrismClient {
            client: Client::builder().build().expect("test HTTP client"),
            base_url: Url::parse(&format!("http://{}", address)).expect("test base URL"),
            admin_token: token.map(str::to_owned),
            configuration_error: None,
        }
    }

    fn spawn_response_server(response: &'static [u8]) -> (std::net::SocketAddr, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let address = listener.local_addr().expect("listener address");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept request");
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer);
            stream.write_all(response).expect("write response");
        });
        (address, server)
    }

    #[tokio::test]
    async fn post_query_sends_delete_name_in_query_and_admin_bearer() {
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
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}")
                .expect("write response");
        });
        let client = test_client(address, Some("test-admin-token"));
        let response = client
            .post_query("/api/sources/delete", [("name", "source A")], serde_json::json!({}))
            .await
            .expect("delete request");
        assert_eq!(response["ok"], true);
        let request = request_rx.recv().expect("captured request");
        assert!(request.starts_with("POST /api/sources/delete?name=source+A HTTP/1.1"));
        assert!(request.contains("authorization: Bearer test-admin-token") || request.contains("Authorization: Bearer test-admin-token"));
        assert!(request.ends_with("{}"));
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn write_without_admin_token_fails_before_network_request() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind test server");
        let client = test_client(listener.local_addr().expect("listener address"), None);
        let error = client.post("/api/reload", serde_json::json!({})).await.expect_err("missing token must fail");
        assert!(error.contains("PRISM_ADMIN_API_TOKEN"));
    }

    #[tokio::test]
    async fn empty_success_body_is_normalized_to_null() {
        let (address, server) = spawn_response_server(
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        let value = test_client(address, Some("test-admin-token"))
            .post("/reload", serde_json::json!({}))
            .await
            .expect("empty response");
        assert!(value.is_null());
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn invalid_json_success_body_is_rejected() {
        let (address, server) = spawn_response_server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nnot-json",
        );
        let error = test_client(address, None)
            .get("/health")
            .await
            .expect_err("invalid JSON must fail");
        assert!(error.contains("非法 JSON"));
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn http_error_includes_status_and_truncates_body() {
        let body = "x".repeat(MAX_ERROR_BODY + 100);
        let response = format!(
            "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(), body
        );
        let leaked_response: &'static [u8] = Box::leak(response.into_bytes().into_boxed_slice());
        let (address, server) = spawn_response_server(leaked_response);
        let error = test_client(address, None)
            .get("/health")
            .await
            .expect_err("HTTP error must fail");
        assert!(error.starts_with("Prism HTTP 500: "));
        assert!(error.len() <= "Prism HTTP 500: ".len() + MAX_ERROR_BODY);
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn inject_shapes_request_and_parses_response() {
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
            let body = r#"{"context":"注入上下文","activated":["uid-1"],"source":"vein"}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });
        let client = test_client(address, Some("test-admin-token"));
        let result = client.inject("trpg", &["vein".to_string()], "你好", 3).await.expect("inject must succeed");
        assert_eq!(result.context, "注入上下文");
        assert_eq!(result.activated, vec!["uid-1".to_string()]);
        assert_eq!(result.source, "vein");
        let request = request_rx.recv().expect("captured request");
        assert!(request.starts_with("POST /inject HTTP/1.1"));
        assert!(request.contains("authorization: Bearer test-admin-token") || request.contains("Authorization: Bearer test-admin-token"));
        let body: serde_json::Value = request.split("\r\n\r\n").nth(1).expect("body").parse().expect("body JSON");
        assert_eq!(body["scenario"], "trpg");
        assert_eq!(body["sources"], serde_json::json!(["vein"]));
        assert_eq!(body["user_msg"], "你好");
        assert_eq!(body["round"], 3);
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn inject_tolerates_missing_response_fields() {
        let (address, server) = spawn_response_server(
            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        );
        let result = test_client(address, Some("t")).inject("", &[], "", 0).await.expect("empty response must parse");
        assert_eq!(result.context, "");
        assert!(result.activated.is_empty());
        assert_eq!(result.source, "");
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn persist_round_shapes_request_with_response_text() {
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
            let body = r#"{"ok":true,"writes":[]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(), body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });
        let client = test_client(address, Some("test-admin-token"));
        let response = client.persist_round("trpg", &[], "用户消息", "回复文本", 4).await.expect("persist must succeed");
        assert_eq!(response["ok"], true);
        let request = request_rx.recv().expect("captured request");
        assert!(request.starts_with("POST /persist HTTP/1.1"));
        assert!(request.contains("authorization: Bearer test-admin-token") || request.contains("Authorization: Bearer test-admin-token"));
        let body: serde_json::Value = request.split("\r\n\r\n").nth(1).expect("body").parse().expect("body JSON");
        assert_eq!(body["scenario"], "trpg");
        assert_eq!(body["user_msg"], "用户消息");
        assert_eq!(body["response"], "回复文本");
        assert_eq!(body["round"], 4);
        server.join().expect("server thread");
    }

    #[tokio::test]
    async fn inject_fails_closed_on_configuration_error_without_network() {
        let client = PrismClient {
            client: Client::new(),
            base_url: Url::parse(DEFAULT_BASE_URL).unwrap(),
            admin_token: None,
            configuration_error: Some("bad env".into()),
        };
        let error = client.inject("", &[], "x", 0).await.expect_err("configuration error must fail fast");
        assert!(error.contains("Prism configuration error"));
    }
}