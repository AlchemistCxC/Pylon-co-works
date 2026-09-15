//! pylon-browser-bridge（issue #82）：把 Pylon 原生浏览器 Sheet 暴露为 MCP server。
//!
//! 协议链路：`agent ──(MCP stdio)── 本进程 ──(本地 named-pipe JSON-RPC,
//! client_type=agent-tool)── Pylon 主进程 ── 前端 command registry ──
//! browser_agent_* 命令（策略/claim/审计单点）`。
//!
//! 经 `pylon.exe browser-bridge` 子命令拉起（run() 顶部分发，GUI 之前退出）。
//! 本进程是无状态薄转换层：不做策略判断（Rust 命令层强制）、不持有浏览器
//! 状态。会话身份经 `--session <key>` 注入每个工具调用的 `sessionKey`。

use serde_json::{json, Value};
use std::io::{BufRead, Write};

const PROTOCOL_VERSION: &str = "2024-11-05";
const SERVER_NAME: &str = "pylon-browser";
const SERVER_VERSION: &str = env!("CARGO_PKG_VERSION");
/// 浏览器操作可能包含等待策略（最长 30s）+ 页面脚本超时。
const TOOL_TIMEOUT_MS: u64 = 45_000;

struct BridgeOptions {
    session_key: String,
    workspace_id: Option<String>,
}

fn usage() -> &'static str {
    "usage: pylon.exe browser-bridge [--session <key>] [--workspace <id>]\n\nMCP stdio server（newline-delimited JSON-RPC 2.0）。由 Pylon 在 session/new\n前经 mcpServers 配置注入，由支持 MCP 的 agent 自行拉起，不要手动运行。"
}

fn parse_options() -> Result<BridgeOptions, String> {
    let mut session_key = String::from("unnamed-session");
    let mut workspace_id = None;
    // 子命令形态：argv[0]=pylon.exe，argv[1]=browser-bridge，从 argv[2] 起解析。
    let mut args = std::env::args().skip(2);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--session" => {
                session_key = args.next().ok_or("--session 需要一个值")?;
            }
            "--workspace" => {
                workspace_id = Some(args.next().ok_or("--workspace 需要一个值")?);
            }
            "--help" | "-h" => {
                println!("{}", usage());
                std::process::exit(0);
            }
            other => return Err(format!("未知参数：{other}")),
        }
    }
    Ok(BridgeOptions {
        session_key,
        workspace_id,
    })
}

/// 工具入参 schema（JSON Schema 子集：type/properties/required）。
struct ToolDef {
    name: &'static str,
    description: &'static str,
    command_id: &'static str,
    /// MCP 参数名 → 前端命令 args 键（同名则省略）。
    properties: &'static [(&'static str, &'static str, bool)],
}

const T_TAB_ID: (&str, &str, bool) = ("tabId", "number", false);
const T_WORKSPACE: (&str, &str, bool) = ("workspaceId", "string", false);

const TOOLS: &[ToolDef] = &[
    ToolDef {
        name: "browser_ensure",
        description: "确保 Pylon Browser Sheet 已打开并就绪（首次使用浏览器前调用）",
        command_id: "browser.agent-ensure",
        properties: &[T_WORKSPACE],
    },
    ToolDef {
        name: "browser_navigate",
        description: "在当前（或指定）浏览器标签打开 http/https URL",
        command_id: "browser.agent-navigate",
        properties: &[("url", "string", true), T_TAB_ID, T_WORKSPACE],
    },
    ToolDef {
        name: "browser_snapshot",
        description: "读取当前页面：可交互元素列表（ref/role/name/坐标）+ 正文文本。先 snapshot 再用 ref 操作",
        command_id: "browser.agent-snapshot",
        properties: &[T_TAB_ID],
    },
    ToolDef {
        name: "browser_screenshot",
        description: "当前页面 PNG 截图（base64；仅 Windows）",
        command_id: "browser.agent-screenshot",
        properties: &[T_TAB_ID],
    },
    ToolDef {
        name: "browser_wait",
        description: "等待页面条件：until = load | network_idle | selector（selector 需提供 selector 参数）",
        command_id: "browser.agent-wait",
        properties: &[
            ("until", "string", true),
            ("selector", "string", false),
            ("timeoutMs", "number", false),
            T_TAB_ID,
        ],
    },
    ToolDef {
        name: "browser_read_network",
        description: "读取当前标签最近网络请求（URL/方法/状态/MIME）；提供 requestId 时返回该响应体文本预览（仅 Windows）",
        command_id: "browser.agent-read-network",
        properties: &[T_TAB_ID, ("limit", "number", false), ("requestId", "string", false)],
    },
    ToolDef {
        name: "browser_save_page",
        description: "把当前页面存为 MHTML 归档文件，返回保存路径（仅 Windows）",
        command_id: "browser.agent-save-page",
        properties: &[T_TAB_ID],
    },
    ToolDef {
        name: "browser_scroll",
        description: "滚动当前页面（deltaY 正值向下）",
        command_id: "browser.agent-scroll",
        properties: &[("deltaX", "number", false), ("deltaY", "number", false), T_TAB_ID],
    },
    ToolDef {
        name: "browser_tab_list",
        description: "列出浏览器标签（id/url/title/活动态）",
        command_id: "browser.agent-tab-list",
        properties: &[],
    },
    ToolDef {
        name: "browser_tab_new",
        description: "新建浏览器标签；background=true 时后台打开不切换视图",
        command_id: "browser.agent-tab-new",
        properties: &[("url", "string", false), ("background", "boolean", false), T_WORKSPACE],
    },
    ToolDef {
        name: "browser_tab_select",
        description: "切换活动浏览器标签",
        command_id: "browser.agent-tab-select",
        properties: &[("tabId", "number", true), T_WORKSPACE],
    },
    ToolDef {
        name: "browser_tab_close",
        description: "关闭浏览器标签（full 档）",
        command_id: "browser.agent-tab-close",
        properties: &[("tabId", "number", true), T_WORKSPACE],
    },
    ToolDef {
        name: "browser_click",
        description: "点击页面元素（full 档）。优先用 snapshot 返回的 ref；也接受 CSS selector",
        command_id: "browser.agent-click",
        properties: &[("ref", "string", false), ("selector", "string", false), T_TAB_ID, T_WORKSPACE],
    },
    ToolDef {
        name: "browser_type",
        description: "向输入元素写入文本（full 档）。可选 submit=true 追加回车",
        command_id: "browser.agent-type",
        properties: &[
            ("text", "string", true),
            ("ref", "string", false),
            ("selector", "string", false),
            ("submit", "boolean", false),
            T_TAB_ID,
            T_WORKSPACE,
        ],
    },
    ToolDef {
        name: "browser_press",
        description: "向当前焦点派发按键（full 档）：Enter/Tab/Escape/Arrow* 等命名键或单个字符",
        command_id: "browser.agent-press",
        properties: &[("key", "string", true), T_TAB_ID, T_WORKSPACE],
    },
    ToolDef {
        name: "browser_download",
        description: "从当前页面触发显式下载（full 档）",
        command_id: "browser.agent-download",
        properties: &[("url", "string", true), ("filename", "string", false), T_TAB_ID, T_WORKSPACE],
    },
    ToolDef {
        name: "browser_emulate",
        description: "设备仿真：viewport（width+height 成对）与 userAgent；clear=true 恢复（仅 Windows）",
        command_id: "browser.agent-emulate",
        properties: &[
            ("width", "number", false),
            ("height", "number", false),
            ("userAgent", "string", false),
            ("clear", "boolean", false),
            T_TAB_ID,
        ],
    },
    ToolDef {
        name: "browser_history",
        description: "读取 Browser Sheet 最近浏览历史（title/url/时间）",
        command_id: "browser.agent-history",
        properties: &[("limit", "number", false)],
    },
];

fn tools_list_payload() -> Value {
    let tools: Vec<Value> = TOOLS
        .iter()
        .map(|tool| {
            let mut properties = serde_json::Map::new();
            let mut required: Vec<Value> = Vec::new();
            for (name, kind, is_required) in tool.properties {
                let schema = match *kind {
                    "number" => json!({ "type": "number" }),
                    "boolean" => json!({ "type": "boolean" }),
                    _ => json!({ "type": "string" }),
                };
                properties.insert((*name).to_string(), schema);
                if *is_required {
                    required.push(json!(name));
                }
            }
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                },
            })
        })
        .collect();
    json!({ "tools": tools })
}

/// MCP 工具调用 → Pylon `command exec`。返回 (文本载荷, 是否错误)。
async fn call_tool(options: &BridgeOptions, name: &str, arguments: Value) -> (String, bool) {
    let Some(tool) = TOOLS.iter().find(|tool| tool.name == name) else {
        return (
            format!("{{\"code\":\"unknown_tool\",\"message\":\"未知工具 {name}\"}}"),
            true,
        );
    };
    let mut args = match arguments {
        Value::Object(map) => map,
        Value::Null => serde_json::Map::new(),
        other => {
            return (
                format!(
                    "{{\"code\":\"invalid_arguments\",\"message\":\"参数必须是对象：{other}\"}}"
                ),
                true,
            );
        }
    };
    // 会话/工作区身份注入（Rust 策略与 claim 的绑定键）。
    args.insert("sessionKey".into(), json!(options.session_key));
    if let Some(workspace_id) = &options.workspace_id {
        // 身份权威在 --workspace 注入侧：覆写而非 or_insert，防 agent 传参升权。
        args.insert("workspaceId".to_string(), json!(workspace_id));
    }
    let command_args = json!({ "commandId": tool.command_id, "args": Value::Object(args) });
    let outcome = pylon_core::cli_client::invoke_running_kernel(
        "command exec".to_string(),
        command_args,
        TOOL_TIMEOUT_MS,
        "agent-tool",
    )
    .await;
    match outcome {
        Ok(result) => {
            // CLI mutate 包装可能返回 {operationId, result}；浏览器命令信封本身
            // 携带 ok 字段，两种形状都向下兼容。
            let envelope = result.get("result").cloned().unwrap_or(result);
            let is_error = envelope.get("ok").and_then(Value::as_bool) == Some(false);
            (
                serde_json::to_string(&envelope).unwrap_or_else(|_| "{}".to_string()),
                is_error,
            )
        }
        Err(error) => (
            json!({ "code": "bridge_error", "message": error }).to_string(),
            true,
        ),
    }
}

fn rpc_result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// 子命令入口（`pylon.exe browser-bridge`）：返回进程退出码。
pub fn run_stdio_bridge() -> i32 {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("bridge runtime 启动失败: {error}");
            return 1;
        }
    };
    let options = match parse_options() {
        Ok(options) => options,
        Err(error) => {
            eprintln!("{}\n{}", error, usage());
            return 2;
        }
    };
    runtime.block_on(bridge_loop(options))
}

async fn bridge_loop(options: BridgeOptions) -> i32 {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut reader = stdin.lock();
    let mut line = String::new();
    loop {
        line.clear();
        let read = match reader.read_line(&mut line) {
            Ok(read) => read,
            Err(error) => {
                eprintln!("stdin 读取失败: {error}");
                return 1;
            }
        };
        if read == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(trimmed) {
            Ok(request) => request,
            Err(error) => {
                let _ = writeln!(
                    stdout,
                    "{}",
                    rpc_error(&Value::Null, -32700, &error.to_string())
                );
                let _ = stdout.flush();
                continue;
            }
        };
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let is_notification = request.get("id").is_none();
        let response = match method {
            "initialize" => rpc_result(
                &id,
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": SERVER_NAME, "version": SERVER_VERSION },
                }),
            ),
            "initialized" | "notifications/initialized" | "cancelled" => continue,
            "ping" => rpc_result(&id, json!({})),
            "tools/list" => rpc_result(&id, tools_list_payload()),
            "tools/call" => {
                let params = request.get("params").cloned().unwrap_or(json!({}));
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                let (text, is_error) = call_tool(&options, name, arguments).await;
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "content": [{ "type": "text", "text": text }],
                        "isError": is_error,
                    },
                })
            }
            other => {
                if is_notification {
                    continue;
                }
                rpc_error(&id, -32601, &format!("method not found: {other}"))
            }
        };
        if writeln!(stdout, "{response}").is_err() {
            break;
        }
        if stdout.flush().is_err() {
            break;
        }
    }
    0
}
