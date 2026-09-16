//! 调试端点的目标发现。
//!
//! WebView2 的 `--remote-debugging-port` 起的是 Chromium 内建 DevTools HTTP 端点，
//! `GET /json` 返回该调试端口下所有可附加目标。这里只做纯发现，不持有连接。

use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};

/// `/json` 列表里的一条目标。
///
/// 字段名对齐 DevTools HTTP 端点的 wire（camelCase），因为这就是契约本身。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetInfo {
    pub id: String,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub url: String,
    #[serde(default, rename = "webSocketDebuggerUrl")]
    pub ws_url: Option<String>,
    #[serde(default, rename = "devtoolsFrontendUrl")]
    pub devtools_frontend_url: Option<String>,
}

impl TargetInfo {
    /// WebView2 的页面目标在不同 WebView2 版本上出现过 `page` 与 `webview` 两种 type。
    /// 两者都算「可调试页面」。
    pub fn is_page_like(&self) -> bool {
        matches!(self.kind.as_str(), "page" | "webview")
    }

    pub fn is_attachable(&self) -> bool {
        self.ws_url.is_some()
    }

    /// 给 agent 看的一行摘要。`webview_targets` 与歧义报错共用。
    pub fn describe(&self) -> String {
        format!(
            "{} [{}] {}{}",
            self.id,
            if self.kind.is_empty() {
                "?"
            } else {
                &self.kind
            },
            if self.title.is_empty() {
                "<无标题>".to_string()
            } else {
                self.title.clone()
            },
            if self.is_attachable() {
                ""
            } else {
                " (不可附加：无 webSocketDebuggerUrl)"
            }
        )
    }

    /// 给 agent 看的 URL：`tauri://localhost/...` 之类原样保留。
    pub fn url_or_blank(&self) -> &str {
        if self.url.is_empty() {
            "-"
        } else {
            &self.url
        }
    }
}

/// `GET {endpoint}/json` —— 目标列表。
///
/// 端点未起来时返回 [`Error::Unreachable`]，并带上 reqwest 的原始原因
/// （connection refused / timeout / DNS），因为区分「app 没开」和
/// 「app 开了但没带调试端口」全靠这条文本。
pub async fn fetch_targets(host: &str, port: u16, timeout: Duration) -> Result<Vec<TargetInfo>> {
    let endpoint = format!("http://{host}:{port}");
    let url = format!("{endpoint}/json/list");
    let client = shared_client()?;
    let response = client
        .get(&url)
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| Error::Unreachable {
            endpoint: endpoint.clone(),
            port,
            detail: describe_reqwest(&error),
        })?;

    let status = response.status();
    if !status.is_success() {
        // 老版本 WebView2 只实现了 `/json`，`/json/list` 可能 404 —— 回退一次。
        let fallback = format!("{endpoint}/json");
        let response = client
            .get(&fallback)
            .timeout(timeout)
            .send()
            .await
            .map_err(|error| Error::Unreachable {
                endpoint: endpoint.clone(),
                port,
                detail: describe_reqwest(&error),
            })?;
        return decode_list(response, &endpoint, port).await;
    }
    decode_list(response, &endpoint, port).await
}

async fn decode_list(
    response: reqwest::Response,
    endpoint: &str,
    port: u16,
) -> Result<Vec<TargetInfo>> {
    let text = response.text().await.map_err(|error| Error::Unreachable {
        endpoint: endpoint.to_string(),
        port,
        detail: format!("读取 /json 响应体失败：{error}"),
    })?;
    serde_json::from_str::<Vec<TargetInfo>>(&text).map_err(|error| Error::Unreachable {
        endpoint: endpoint.to_string(),
        port,
        detail: format!(
            "/json 响应不是目标数组（{error}）；前 200 字符：{}",
            truncate(&text, 200)
        ),
    })
}

/// `GET /json/version` —— 浏览器/协议版本。诊断「连上了但是旧 WebView2」时用。
pub async fn fetch_version(host: &str, port: u16, timeout: Duration) -> Result<Value> {
    let endpoint = format!("http://{host}:{port}");
    let client = shared_client()?;
    let response = client
        .get(format!("{endpoint}/json/version"))
        .timeout(timeout)
        .send()
        .await
        .map_err(|error| Error::Unreachable {
            endpoint: endpoint.clone(),
            port,
            detail: describe_reqwest(&error),
        })?;
    response
        .json::<Value>()
        .await
        .map_err(|error| Error::Unreachable {
            endpoint,
            port,
            detail: format!("/json/version 响应不是 JSON：{error}"),
        })
}

/// 全进程共享一个 client：目标发现是热路径（每次工具调用都要走），
/// 每次现建 client 等于每次丢弃连接池、重做一遍 TCP 握手。
/// 超时改为按请求设置（见两个 `fetch_*`），因为不同调用方的预算不同。
fn shared_client() -> Result<&'static reqwest::Client> {
    static CLIENT: OnceLock<std::result::Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                // 调试端点是本机回调，代理只会把它转发坏掉。
                .no_proxy()
                .build()
                .map_err(|error| format!("构造 HTTP client 失败：{error}"))
        })
        .as_ref()
        .map_err(|message| Error::Io(message.clone()))
}

/// reqwest 的错误链要摊平：`error.to_string()` 只给最外层的 "error sending request"，
/// 真正决定下一步的 "connection refused" 在被 source 里。
fn describe_reqwest(error: &reqwest::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(error);
    let mut depth = 0;
    while let Some(current) = source {
        parts.push(current.to_string());
        source = std::error::Error::source(current);
        depth += 1;
        if depth > 6 {
            break;
        }
    }
    parts.join(" ← ")
}

fn truncate(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_devtools_target_list() {
        let raw = r#"[
          {
            "description": "",
            "devtoolsFrontendUrl": "/devtools/inspector.html?ws=127.0.0.1:9222/devtools/page/ABC",
            "id": "ABC",
            "title": "Prism Desktop",
            "type": "page",
            "url": "tauri://localhost/index.html",
            "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/ABC"
          },
          { "id": "DEF", "type": "worker", "title": "sw", "url": "blob:xyz" }
        ]"#;
        let targets: Vec<TargetInfo> = serde_json::from_str(raw).unwrap();
        assert_eq!(targets.len(), 2);
        assert!(targets[0].is_page_like());
        assert!(targets[0].is_attachable());
        assert!(!targets[1].is_page_like());
        assert!(!targets[1].is_attachable());
        assert!(targets[0]
            .describe()
            .starts_with("ABC [page] Prism Desktop"));
        assert!(targets[1].describe().contains("不可附加"));
    }

    #[test]
    fn tolerates_missing_optional_fields() {
        let raw = r#"[{ "id": "X" }]"#;
        let targets: Vec<TargetInfo> = serde_json::from_str(raw).unwrap();
        assert_eq!(targets[0].kind, "");
        assert_eq!(targets[0].url_or_blank(), "-");
    }

    #[test]
    fn truncate_respects_utf8_boundaries() {
        let text = "中文中文中文";
        // 截到 5 字节会落在第二个「中」中间（每字 3 字节）→ 必须回退到 3。
        assert_eq!(truncate(text, 5), "中…");
        assert_eq!(truncate("abc", 10), "abc");
    }

    #[tokio::test]
    async fn unreachable_endpoint_names_host_and_port() {
        // 端口 1 上不会有 DevTools 端点；断言的是错误形状而非环境。
        let error = fetch_targets("127.0.0.1", 1, Duration::from_millis(500))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), "debug_endpoint_unreachable");
        let text = error.to_string();
        assert!(text.contains("127.0.0.1:1"), "{text}");
        assert!(text.contains("--remote-debugging-port=1"), "{text}");
    }
}
