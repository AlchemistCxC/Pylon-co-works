//! MCP 的 stdio 传输与 JSON-RPC 2.0 分发。
//!
//! **stdout 是协议通道，只能出现 JSON-RPC 报文，一行一条。** 任何诊断输出
//! （包括 `eprintln!` 和 panic 信息）都必须走 stderr —— 往 stdout 混一个字符，
//! 客户端就会在解析层炸掉，而错误现场看起来跟本服务器毫无关系。
//!
//! 每个请求单独 spawn 一个 task：`webview_evaluate` 撞上永不 settle 的 Promise
//! 会一直占着直到超时，如果串行处理，后面所有请求都会陪着一起卡住。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::cdp::Cdp;
use crate::error::Result;
use crate::tools::{self, Context, ToolResult};

/// 我们实现的协议版本，新到旧。
///
/// `initialize` 时若客户端给的版本在表里就原样回；不在表里则回最新版
/// ——MCP 规范要求服务端在自身版本列表之外时回退到自己的最新版，
/// 由客户端决定是否继续。
const SUPPORTED_PROTOCOL_VERSIONS: [&str; 3] = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";

const SERVER_NAME: &str = "pylon-webview2-mcp";

const INSTRUCTIONS: &str = "\
驱动 Pylon（Tauri 2 + Windows WebView2）前端的调试服务器，通过 WebView2 的 \
--remote-debugging-port 走标准 CDP。

推荐排障顺序：
1. webview_targets —— 确认端点活着、拿到目标 id。任何工具报 debug_endpoint_unreachable 都先回到这一步。
2. webview_console —— 第一手证据。默认读「上次读过之后的增量」，所以先做动作再读，不要反复全量拉。
3. webview_network —— 请求/响应/失败三态合并成一条记录；要看响应体用 webview_network_body。
4. webview_query / webview_dom —— 布局与样式。webview_query 给盒模型与计算样式。
5. webview_screenshot —— 视觉确认；返回图片内容。
6. webview_click / webview_type / webview_key / webview_hover / webview_select —— 真实输入事件。\
webview_click / webview_hover 会报告 hitIsSelfOrDescendant，为 false 说明目标被遮挡，\
这是「点了没反应」的常见成因。
7. webview_wait —— 动作之间用它同步：等元素出现/消失、等条件为真、等 URL 或文档就绪，\
不要用盲等固定毫秒代替。
8. webview_scroll / webview_navigate —— 滚动容器或页面；导航与重载。
9. tauri_invoke —— 直接调后端命令（例如 list_runtime_logs 拿后端日志时间轴）。
10. tauri_event_catalog → tauri_events —— 先扫出事件名，再显式订阅并读增量。
   事件订阅必须给名字，无法全量旁路捕获（tauri 的 __TAURI_INTERNALS__.invoke 不可改写）。

多窗口时用 target 参数指定目标 id（支持前缀匹配）。所有工具都接受 timeout_ms。";

pub struct Server {
    context: Context,
}

impl Server {
    pub fn new(cwd: PathBuf, host: String, port: u16, timeout_ms: u64) -> Self {
        Self {
            // `Cdp` 必须在这里建一次并被所有请求共享：它持有 CDP WebSocket
            // 会话表，每次请求重建等于每次工具调用都重连一次。
            context: Context {
                cdp: Arc::new(Cdp::new(host, port, Duration::from_millis(timeout_ms))),
                cwd: Arc::new(cwd),
                timeout_ms,
            },
        }
    }

    /// 跑 stdio 主循环，直到 stdin 关闭。
    pub async fn serve(self) -> Result<()> {
        let server = Arc::new(self);
        let (outbound, mut inbound) = mpsc::unbounded_channel::<String>();

        let writer = tokio::spawn(async move {
            let mut stdout = tokio::io::stdout();
            while let Some(line) = inbound.recv().await {
                if stdout.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdout.write_all(b"\n").await.is_err() {
                    break;
                }
                if stdout.flush().await.is_err() {
                    break;
                }
            }
        });

        let stdin = BufReader::new(tokio::io::stdin());
        let mut lines = stdin.lines();
        loop {
            match lines.next_line().await {
                Ok(None) => break,
                Ok(Some(line)) => {
                    // 必须 own：`line` 在本轮结尾就被释放，而 handle_line 要在 spawn 出去的
                    // task 里跑。借用会让整个 loop 编译不过。
                    let trimmed = line.trim().to_string();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let server = Arc::clone(&server);
                    let outbound = outbound.clone();
                    tokio::spawn(async move {
                        if let Some(response) = server.handle_line(&trimmed).await {
                            let _ = outbound.send(response.to_string());
                        }
                    });
                }
                Err(error) => {
                    eprintln!("[pylon-webview2-mcp] 读取 stdin 失败：{error}");
                    break;
                }
            }
        }

        drop(outbound);
        let _ = writer.await;
        Ok(())
    }

    async fn handle_line(&self, line: &str) -> Option<Value> {
        let message: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                return Some(error_response(
                    &Value::Null,
                    -32700,
                    &format!("JSON 解析失败：{error}"),
                    None,
                ));
            }
        };
        self.handle(message).await
    }

    async fn handle(&self, message: Value) -> Option<Value> {
        let id = message.get("id").cloned();
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .map(str::to_string);
        let params = message.get("params").cloned().unwrap_or(json!({}));

        // 无 id 即通知：按 JSON-RPC 2.0 不得回包，回包会让客户端把它当成
        // 对不存在请求的响应而报错。
        let Some(id) = id else {
            if let Some(method) = method {
                if method != "notifications/initialized" && method != "notifications/cancelled" {
                    eprintln!("[pylon-webview2-mcp] 收到未处理的通知：{method}");
                }
            }
            return None;
        };

        let Some(method) = method else {
            return Some(error_response(&id, -32600, "缺少 method 字段", None));
        };

        let response = match method.as_str() {
            "initialize" => self.initialize(&params),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({ "tools": tools::catalog() })),
            "tools/call" => self.tools_call(&params).await,
            // 未声明这些能力；回空表比回 -32601 更友好，且不构成虚假能力声明。
            "resources/list" => Ok(json!({ "resources": [] })),
            "resources/templates/list" => Ok(json!({ "resourceTemplates": [] })),
            "prompts/list" => Ok(json!({ "prompts": [] })),
            "logging/setLevel" => Ok(json!({})),
            other => Err(((-32601), format!("不支持的方法：{other}"))),
        };

        Some(match response {
            Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
            Err((code, message)) => error_response(&id, code, &message, None),
        })
    }

    fn initialize(&self, params: &Value) -> std::result::Result<Value, (i64, String)> {
        let requested = params
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(LATEST_PROTOCOL_VERSION);
        let negotiated = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
            requested
        } else {
            LATEST_PROTOCOL_VERSION
        };
        if negotiated != requested {
            eprintln!(
                "[pylon-webview2-mcp] 客户端协议版本 {requested} 不在支持列表，回退到 {negotiated}"
            );
        }
        Ok(json!({
            "protocolVersion": negotiated,
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
            "instructions": INSTRUCTIONS,
        }))
    }

    async fn tools_call(&self, params: &Value) -> std::result::Result<Value, (i64, String)> {
        let name = params
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| (-32602, "tools/call 缺少 name 字段".to_string()))?;
        let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

        // 工具自身的失败（端点没起来、选择器没命中）走 `isError: true` 的内容块，
        // **不是** JSON-RPC 错误：协议级错误会让客户端把整次调用当传输故障，
        // 而这里需要的是让 agent 读到失败原因并自行调整。
        let result = match tools::dispatch(&self.context(), name, &arguments).await {
            Ok(result) => result,
            Err(error) => ToolResult::error(&error),
        };
        Ok(result.into_wire())
    }

    fn context(&self) -> Context {
        self.context.clone()
    }
}

fn error_response(id: &Value, code: i64, message: &str, data: Option<Value>) -> Value {
    let mut error = json!({ "code": code, "message": message });
    if let Some(data) = data {
        error["data"] = data;
    }
    json!({ "jsonrpc": "2.0", "id": id, "error": error })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server() -> Server {
        Server::new(
            std::path::PathBuf::from("."),
            "127.0.0.1".to_string(),
            9222,
            20_000,
        )
    }

    #[tokio::test]
    async fn initialize_echoes_a_supported_version() {
        let value = server()
            .initialize(&json!({ "protocolVersion": "2024-11-05" }))
            .unwrap();
        assert_eq!(value["protocolVersion"], "2024-11-05");
        assert_eq!(value["capabilities"]["tools"]["listChanged"], false);
        assert_eq!(value["serverInfo"]["name"], SERVER_NAME);
        assert!(value["instructions"].as_str().unwrap_or_default().len() > 100);
    }

    #[tokio::test]
    async fn initialize_falls_back_to_latest_for_unknown_version() {
        let value = server()
            .initialize(&json!({ "protocolVersion": "1999-01-01" }))
            .unwrap();
        assert_eq!(value["protocolVersion"], LATEST_PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn initialize_without_version_uses_latest() {
        let value = server().initialize(&json!({})).unwrap();
        assert_eq!(value["protocolVersion"], LATEST_PROTOCOL_VERSION);
    }

    #[tokio::test]
    async fn notifications_get_no_response() {
        let response = server()
            .handle(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        assert!(response.is_none());
    }

    #[tokio::test]
    async fn ping_is_answered() {
        let response = server()
            .handle(json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))
            .await
            .unwrap();
        assert_eq!(response["id"], 1);
        assert_eq!(response["result"], json!({}));
    }

    #[tokio::test]
    async fn unknown_method_is_method_not_found() {
        let response = server()
            .handle(json!({ "jsonrpc": "2.0", "id": "x", "method": "nope/nope" }))
            .await
            .unwrap();
        assert_eq!(response["error"]["code"], -32601);
        assert_eq!(response["id"], "x");
    }

    #[tokio::test]
    async fn parse_error_uses_the_reserved_code() {
        let response = server().handle_line("{not json").await.unwrap();
        assert_eq!(response["error"]["code"], -32700);
        assert_eq!(response["id"], Value::Null);
    }

    #[tokio::test]
    async fn request_without_method_is_invalid_request() {
        let response = server()
            .handle(json!({ "jsonrpc": "2.0", "id": 3 }))
            .await
            .unwrap();
        assert_eq!(response["error"]["code"], -32600);
    }

    #[tokio::test]
    async fn tools_list_is_non_empty_and_every_tool_has_a_schema() {
        let response = server()
            .handle(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
            .await
            .unwrap();
        let tools = response["result"]["tools"].as_array().unwrap();
        assert!(tools.len() >= 15, "工具数量偏少：{}", tools.len());
        for tool in tools {
            let name = tool["name"].as_str().unwrap();
            assert!(
                tool["description"].as_str().unwrap().len() > 20,
                "{name} 描述过短"
            );
            assert!(
                tool["inputSchema"]["type"] == "object",
                "{name} 缺少 object schema"
            );
        }
    }

    #[tokio::test]
    async fn tools_call_without_name_is_invalid_params() {
        let response = server()
            .handle(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {} }))
            .await
            .unwrap();
        assert_eq!(response["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn unknown_tool_is_reported_as_an_error_result_not_a_protocol_error() {
        let response = server()
            .handle(json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "no_such_tool", "arguments": {} }
            }))
            .await
            .unwrap();
        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(response["result"]["isError"], true);
        let text = response["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default();
        assert!(text.contains("no_such_tool"), "{text}");
    }

    #[tokio::test]
    async fn resources_and_prompts_are_not_advertised_but_answer_with_empty_lists() {
        for method in ["resources/list", "resources/templates/list", "prompts/list"] {
            let response = server()
                .handle(json!({ "jsonrpc": "2.0", "id": 1, "method": method }))
                .await
                .unwrap();
            assert!(response["result"].is_object(), "{method}: {response}");
        }
    }

    #[test]
    fn tool_failure_becomes_is_error_content_not_a_json_rpc_error() {
        let error = crate::error::Error::bad_args("webview_click", "缺少 selector");
        let wire = ToolResult::error(&error).into_wire();
        assert_eq!(wire["isError"], true);
        let text = wire["content"][0]["text"].as_str().unwrap();
        let parsed: Value = serde_json::from_str(text).unwrap();
        assert_eq!(parsed["error"], "bad_args");
        assert!(parsed["hint"].is_string());
    }
}
