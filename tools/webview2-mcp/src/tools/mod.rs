//! 工具目录与分发。
//!
//! 每个工具是 `Context + JSON 参数 → ToolResult` 的纯函数式入口，
//! 不持有跨调用状态（跨调用状态只有 `Cdp` 里的会话表与页内缓冲）。
//!
//! 描述体积是每个 MCP 会话的固定上下文成本（#218 实测基线 22,258 字符），
//! 因此文字按「调用时需要什么」取舍：怎么填、互斥/边界、结果怎么判读；
//! 「为什么这样设计」与长例子留在 README 与开发记录里。

pub mod host;
pub mod page;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Map, Value};

use crate::cdp::Cdp;
use crate::error::{Error, Result};

/// 工具执行上下文。
///
/// `cdp` 是 `Arc`：会话表（CDP WebSocket 连接）必须跨调用复用，
/// 每次调用新建 `Cdp` 会让「复用连接」失效并退化成「每次工具调用重连一次」。
#[derive(Clone)]
pub struct Context {
    pub cdp: Arc<Cdp>,
    pub cwd: Arc<PathBuf>,
    pub timeout_ms: u64,
}

impl Context {
    /// 单次调用可覆盖的超时。
    pub fn timeout_from(&self, tool_args_ms: Option<u64>) -> Duration {
        Duration::from_millis(tool_args_ms.unwrap_or(self.timeout_ms))
    }
}

/// 工具输出 = 若干 MCP content block + 是否失败。
#[derive(Debug)]
pub struct ToolResult {
    pub content: Vec<Value>,
    pub is_error: bool,
}

impl ToolResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![text_block(text)],
            is_error: false,
        }
    }

    /// 小结果 pretty（逐行读 JSON 更容易定位字段），大结果紧凑——
    /// 缩进对 50 条日志级别的结果放大的 token 数不再「可以忽略」（#218）。
    pub fn json(value: &Value) -> Self {
        Self::text(pretty(value))
    }

    /// 文本 + 图片（截图用）。文本在前，让「先读摘要再决定要不要看图」成为默认路径。
    pub fn text_and_image(text: impl Into<String>, data: &str, mime: &str) -> Self {
        Self {
            content: vec![text_block(text), image_block(data, mime)],
            is_error: false,
        }
    }

    pub fn error(error: &Error) -> Self {
        Self {
            content: vec![text_block(pretty(&error.to_wire()))],
            is_error: true,
        }
    }

    pub fn into_wire(self) -> Value {
        json!({ "content": self.content, "isError": self.is_error })
    }
}

pub fn text_block(text: impl Into<String>) -> Value {
    json!({ "type": "text", "text": text.into() })
}

pub fn image_block(data: &str, mime: &str) -> Value {
    json!({ "type": "image", "data": data, "mimeType": mime })
}

/// 紧凑序列化不超过该字符数时用 pretty，超过则紧凑输出。
/// 小结果（单元素详查、错误判读）的可读性收益是真实的；
/// 大结果（50 条网络/控制台日志）缩进放大约 1.5-2 倍 token，压过收益。
pub(crate) const PRETTY_BELOW_CHARS: usize = 4_000;

pub fn pretty(value: &Value) -> String {
    let compact = value.to_string();
    if compact.chars().count() > PRETTY_BELOW_CHARS {
        compact
    } else {
        serde_json::to_string_pretty(value).unwrap_or(compact)
    }
}

// ── 读增量工具的公共窗口参数 ──

/// 未指定 `limit` 时返回多少条命中记录。
pub(crate) const DEFAULT_LIMIT: usize = 50;

/// `scan` 的绝对值上限。无论调用方给多大，单次检视都不超过这个数，
/// 避免一次调用把整个缓冲（约 3000 条）物化出来。
pub(crate) const MAX_SCAN: usize = 3000;

/// 解析 `scan`：默认 limit×20，并夹到 `[1, MAX_SCAN]`。
///
/// `scan` 与 `limit` 分开是刻意的：要「最近 50 条 error」时，中间可能夹着上千条 info，
/// 只检视 `limit` 条会一条都搜不到。但也不能真把缓冲拉满，所以给了独立的扫描上限，
/// 并在返回里报 `scanned` 让调用方判断窗口是否够大。
pub(crate) fn resolve_scan(requested: Option<u64>, limit: usize) -> usize {
    requested
        .map(|value| value as usize)
        .unwrap_or_else(|| limit.saturating_mul(20))
        .clamp(1, MAX_SCAN)
}

/// 分发到具体工具。
pub async fn dispatch(cx: &Context, name: &str, args: &Value) -> Result<ToolResult> {
    match name {
        "webview_targets" => page::targets(cx, args).await,
        "webview_evaluate" => page::evaluate(cx, args).await,
        "webview_raw_cdp" => page::raw_cdp(cx, args).await,
        "webview_console" => page::console(cx, args).await,
        "webview_network" => page::network(cx, args).await,
        "webview_network_body" => page::network_body(cx, args).await,
        "webview_websocket" => page::websocket(cx, args).await,
        "webview_dom" => page::dom(cx, args).await,
        "webview_query" => page::query(cx, args).await,
        "webview_snapshot" => page::snapshot(cx, args).await,
        "webview_screenshot" => page::screenshot(cx, args).await,
        "webview_click" => page::click(cx, args).await,
        "webview_type" => page::type_text(cx, args).await,
        "webview_key" => page::key(cx, args).await,
        "webview_hover" => page::hover(cx, args).await,
        "webview_scroll" => page::scroll(cx, args).await,
        "webview_select" => page::select(cx, args).await,
        "webview_wait" => page::wait(cx, args).await,
        "webview_navigate" => page::navigate(cx, args).await,
        "tauri_invoke" => host::invoke(cx, args).await,
        "tauri_events" => host::events(cx, args).await,
        "tauri_event_catalog" => host::event_catalog(cx, args).await,
        "tauri_window_state" => host::window_state(cx, args).await,
        "tauri_backend_logs" => host::backend_logs(cx, args).await,
        other => Err(Error::bad_args(other, "未知工具。可用工具见 tools/list。")),
    }
}

/// 参数类型描述的取值集合，仅在测试里用于抦住「类型描述打错字」。
///
/// 写成 `&'static str` 而不是 `Value`，是因为整张工具表必须是 `static`，
/// 而 `json!` 不能在 `static` 里求值（`serde_json::to_value` 不是 const fn）。
/// schema 在 `catalog()` 时构建。
#[cfg(test)]
const KNOWN_TYPE_SPECS: &[&str] = &[
    "string",
    "integer",
    "number",
    "boolean",
    "object",
    "string_array",
    "string_or_string_array",
    "integer_or_array",
];

/// 类型描述 → JSON Schema 片段。
fn type_schema(spec: &str) -> Value {
    // `enum:a|b|c` —— 枚举值域。分隔符用 `|`，因为字面量里不会出现它。
    if let Some(values) = spec.strip_prefix("enum:") {
        let options: Vec<&str> = values.split('|').collect();
        return json!({ "type": "string", "enum": options });
    }
    match spec {
        "string" => json!({ "type": "string" }),
        "integer" => json!({ "type": "integer" }),
        "number" => json!({ "type": "number" }),
        "boolean" => json!({ "type": "boolean" }),
        "object" => json!({ "type": "object" }),
        "string_array" => json!({ "type": "array", "items": { "type": "string" } }),
        "string_or_string_array" => {
            json!({ "type": ["string", "array"], "items": { "type": "string" } })
        }
        "integer_or_array" => {
            json!({ "type": ["integer", "array"], "items": { "type": "integer" } })
        }
        // 兜底成 string：未知描述由测试兜住，运行期不 panic。
        _ => json!({ "type": "string" }),
    }
}

/// 只读工具：不改变**被调试应用**的状态。
///
/// 这条例线按「对 app 的影响」划，不按「对 MCP 自己缓冲的影响」：
/// `tauri_events` 会往页面里注册订阅、输入类工具会改 UI 状态，
/// 因此都不在这里——标注成只读会让客户端在权限 UI 上给出错误的承诺。
const READ_ONLY_TOOLS: [&str; 13] = [
    "webview_targets",
    "webview_console",
    "webview_network",
    "webview_network_body",
    "webview_websocket",
    "webview_dom",
    "webview_query",
    "webview_snapshot",
    "webview_screenshot",
    "webview_wait",
    "tauri_event_catalog",
    "tauri_window_state",
    "tauri_backend_logs",
];

/// `tools/list` 的返回体。
pub fn catalog() -> Vec<Value> {
    TOOLS.iter().map(ToolSpec::build).collect()
}

struct ToolSpec {
    name: &'static str,
    description: &'static str,
    /// (参数名, 说明, 类型描述)
    properties: &'static [(&'static str, &'static str, &'static str)],
    required: &'static [&'static str],
}

impl ToolSpec {
    fn build(&self) -> Value {
        let mut properties = Map::new();
        for (key, description, type_spec) in self.properties {
            let mut schema = type_schema(type_spec);
            if let Value::Object(map) = &mut schema {
                map.insert("description".into(), Value::String((*description).into()));
            }
            properties.insert((*key).into(), schema);
        }
        let mut schema = json!({
            "type": "object",
            "properties": properties,
        });
        // 空的 required 数组是纯开销：省下这一行 schema 字节（#218）。
        if !self.required.is_empty() {
            schema["required"] = json!(self.required);
        }
        let mut tool = json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": schema,
        });
        if READ_ONLY_TOOLS.contains(&self.name) {
            // 客户端据此做权限提示/自动放行；不确定就不标。
            tool["annotations"] = json!({ "readOnlyHint": true });
        }
        tool
    }
}

// 反复出现的参数，说明文本刻意保持一致，便于 agent 形成稳定预期。
// 体积口径见本文件头：只留「怎么填 + 边界」，设计与缘由进 README。
const TARGET_DOC: &str = "目标 id 前缀或 url/title 子串；多目标必填。";
const TIMEOUT_DOC: &str = "超时毫秒数，覆盖默认。";
const SINCE_DOC: &str = "从该 seq 之后读；省略续读上次位置；显式传入可重读。";
const LIMIT_DOC: &str = "命中记录数上限，默认 50。";
const SCAN_DOC: &str = "检视窗口（含未命中），默认 limit×20、上限 3000；见 scanned。";
const RESET_DOC: &str = "清缓冲、游标推到末尾（从现在看）。默认 false。";
// 指针三件套（click / hover 共用）与 ref 类参数。
const POINTER_SELECTOR_DOC: &str = "目标选择器，与 ref、x/y 三选一。";
const POINTER_REF_DOC: &str = "快照 ref（如 e12）；与 selector、x/y 三选一。";
const REF_VS_SELECTOR_DOC: &str = "快照 ref（如 e12），来自 webview_snapshot；与 selector 二选一。";

static TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "webview_targets",
        description: "列出可附加目标与浏览器/协议版本，是「端口通不通」的探针：端点不可达时不报错，返回 reachable=false 与开启步骤；报 debug_endpoint_unreachable 先回这里。",
        properties: &[
            (
                "include_workers",
                "连同 worker 等非页面目标列出（通常不可附加）。默认 false。",
                "boolean",
            ),
            (
                "scan_ports",
                "扫相邻端口（+1..+9）列其它调试端点，默认 false；仅多实例忘了端口分配时用。",
                "boolean",
            ),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_evaluate",
        description: "在页面主世界求值 JS 并返回结果，默认包成 async IIFE（可直接写 await）。不可序列化结果返回 __unserializable 而非 null；超 64KB 换 __truncated 信封，要完整结果用 webview_raw_cdp。",
        properties: &[
            (
                "expression",
                "JS 表达式，wrap=true 可写 await；对象字面量写成 (() => ({a:1}))()。",
                "string",
            ),
            (
                "wrap",
                "包成 async IIFE（默认 true）；表达式是语句序列时才需 false。",
                "boolean",
            ),
            (
                "await_promise",
                "结果若是 Promise 是否等待 settle。默认 true。",
                "boolean",
            ),
            (
                "return_by_value",
                "按值序列化结果（默认 true）；false 只拿 RemoteObject 描述。",
                "boolean",
            ),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &["expression"],
    },
    ToolSpec {
        name: "webview_raw_cdp",
        description: "直调任意 CDP 方法返回原始 result。用于未包装的域（DOM.* / CSS.* / Emulation.* 等），也是方法可用性探针。",
        properties: &[
            (
                "method",
                "CDP 方法名，如 Page.captureScreenshot。",
                "string",
            ),
            ("params", "CDP 方法的参数对象，原样透传。", "object"),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &["method"],
    },
    ToolSpec {
        name: "webview_console",
        description: "读控制台消息、未捕获异常与浏览器日志条目。默认只返回「上次读过之后」的增量——先触发动作再读，不要反复全量拉。",
        properties: &[
            (
                "type",
                "类型过滤：log / info / warning / error / debug / exception；warn 同 warning。",
                "string_or_string_array",
            ),
            ("pattern", "按文本子串过滤（大小写不敏感）。", "string"),
            ("since_seq", SINCE_DOC, "integer"),
            ("limit", LIMIT_DOC, "integer"),
            ("scan", SCAN_DOC, "integer"),
            ("reset", RESET_DOC, "boolean"),
            ("target", TARGET_DOC, "string"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_network",
        description: "读网络请求日志。同一 requestId 的请求/响应/完成/失败事件合并成一条记录，反映最终状态。默认读增量。",
        properties: &[
            (
                "resource_type",
                "资源类型过滤：Document / Stylesheet / Script / XHR / Fetch / Image / Font / WS / Other。",
                "string",
            ),
            ("pattern", "按 URL 子串过滤（大小写不敏感）。", "string"),
            (
                "status_min",
                "只看状态码 >= 该值；加载失败无状态码会被排除，用 failed_only。",
                "integer",
            ),
            ("failed_only", "只看加载失败的请求。默认 false。", "boolean"),
            ("since_seq", SINCE_DOC, "integer"),
            ("limit", LIMIT_DOC, "integer"),
            ("scan", SCAN_DOC, "integer"),
            ("reset", RESET_DOC, "boolean"),
            ("target", TARGET_DOC, "string"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_network_body",
        description: "按 requestId 取响应体（id 来自 webview_network）。base64 解码后判断能否还原 UTF-8；非文本给字节数与头部十六进制。",
        properties: &[
            (
                "request_id",
                "webview_network 返回记录里的 requestId。",
                "string",
            ),
            ("max_chars", "响应体截断长度，默认 20000 字符。", "integer"),
            ("target", TARGET_DOC, "string"),
        ],
        required: &["request_id"],
    },
    ToolSpec {
        name: "webview_websocket",
        description: "读 WebSocket 流：连接级事件与每一帧各占一条、保持往返次序（webview_network 只压成一条）。默认读增量，游标语义同 webview_console。",
        properties: &[
            (
                "pattern",
                "按连接 url 子串过滤（大小写不敏感）。",
                "string",
            ),
            (
                "payload_pattern",
                "按帧载荷文本子串过滤（大小写不敏感）。",
                "string",
            ),
            (
                "direction",
                "只看某方向；省略则双向。",
                "enum:sent|received",
            ),
            (
                "phase",
                "只看某个阶段的记录。",
                "enum:created|handshake-request|handshake-response|frame|frame-error|closed",
            ),
            (
                "request_id",
                "只看某条连接（webview_network 返回的 requestId）。",
                "string",
            ),
            ("since_seq", SINCE_DOC, "integer"),
            ("limit", LIMIT_DOC, "integer"),
            ("scan", SCAN_DOC, "integer"),
            ("reset", RESET_DOC, "boolean"),
            ("target", TARGET_DOC, "string"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_dom",
        description: "取 DOM 结构轮廓：标签/id/class/属性，可选盒模型与叶子文本；自序列化，不受 nodeId 失效影响，截断处显式标注。",
        properties: &[
            (
                "selector",
                "从这里开始遍历；省略则从 <html> 开始。",
                "string",
            ),
            ("max_depth", "遍历深度上限，默认 5。", "integer"),
            ("max_nodes", "遍历节点数上限，默认 300。", "integer"),
            (
                "include_text",
                "带叶子元素文本（截断 240 字符），默认 true。",
                "boolean",
            ),
            (
                "include_rect",
                "带每个元素的盒模型，默认 false（结果显著变大）。",
                "boolean",
            ),
            ("target", TARGET_DOC, "string"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_query",
        description: "详查单个元素：盒模型、指定 CSS 属性计算值、可见性（checkVisibility）、祖先链与滚动尺寸。",
        properties: &[
            (
                "selector",
                "CSS 选择器，命中第一个匹配元素（等价 querySelector）。",
                "string",
            ),
            (
                "props",
                "计算样式属性名，如 [\"display\",\"z-index\"]；省略给常用属性。",
                "string_array",
            ),
            ("target", TARGET_DOC, "string"),
        ],
        required: &["selector"],
    },
    ToolSpec {
        name: "webview_snapshot",
        description: "无障碍快照：「角色 + 名字 + ref」文本树（如 - button \"发送\" [ref=e3]），ref 可传给 click/type/key/select/hover，比猜选择器稳；随重载/重渲染失效并提示重新快照。",
        properties: &[
            (
                "selector",
                "只快照该子树；省略整页，页面大时避免触上限。",
                "string",
            ),
            (
                "max_nodes",
                "节点上限，默认 300；触顶即停并标 truncated。",
                "integer",
            ),
            (
                "include_values",
                "带输入框当前值（value=...），默认 true；敏感时关掉。",
                "boolean",
            ),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_screenshot",
        description: "截图并作为图片内容返回。full_page 在部分 WebView2 版本不支持，失败时自动退回视口截图并在返回里写明，不会整次失败。",
        properties: &[
            ("full_page", "整页捕获而非仅视口。默认 false。", "boolean"),
            (
                "format",
                "png（默认）或 jpeg；jpeg 体积小但丢细线。",
                "enum:png|jpeg",
            ),
            (
                "quality",
                "jpeg 质量 0-100，默认 80。png 忽略此参数。",
                "integer",
            ),
            (
                "clip",
                "裁剪区域 {x,y,width,height}（CSS 像素），与 full_page 并存时以 clip 为准。",
                "object",
            ),
            ("target", TARGET_DOC, "string"),
            (
                "timeout_ms",
                "超时毫秒；整页截图较慢可调大。",
                "integer",
            ),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_click",
        description: "点击元素或坐标，默认派发真实鼠标事件（先滚进视口再命中测试）。hitIsSelfOrDescendant 为 false 即被遮挡——「点了没反应」最常见成因。mode=dom 用 element.click()。",
        properties: &[
            ("selector", POINTER_SELECTOR_DOC, "string"),
            ("ref", POINTER_REF_DOC, "string"),
            ("x", "视口坐标 X（CSS 像素）。", "number"),
            ("y", "视口坐标 Y（CSS 像素）。", "number"),
            ("button", "鼠标键。", "enum:left|right|middle"),
            (
                "click_count",
                "点击次数，默认 1；2=双击、3=三击，上限 3。",
                "integer",
            ),
            (
                "mode",
                "input（默认，派发真实鼠标事件）或 dom（直接调 element.click()）。",
                "enum:input|dom",
            ),
            (
                "settle_ms",
                "点击后等待毫秒，默认 80。",
                "integer",
            ),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_type",
        description: "向输入目标输入文本。默认 Input.insertText（快且对中文友好）；mode=keys 逐字符真实按键。返回输入后的实际值——受控组件可能拒绝。",
        properties: &[
            ("text", "要输入的文本。", "string"),
            (
                "selector",
                "输入目标，与 ref 二选一；都省略用当前聚焦元素。",
                "string",
            ),
            ("ref", REF_VS_SELECTOR_DOC, "string"),
            ("clear", "输入前清空。默认 false。", "boolean"),
            (
                "mode",
                "insert（默认）或 keys（逐字符真实按键）。",
                "enum:insert|keys",
            ),
            (
                "delay_ms",
                "mode=keys 时每个字符之间的间隔，默认 12。",
                "integer",
            ),
            ("submit", "输入完成后按一次 Enter。默认 false。", "boolean"),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &["text"],
    },
    ToolSpec {
        name: "webview_key",
        description: "派发命名按键（Enter / Arrow* / F1-F12 等）或单个 ASCII 字符，可组合 modifiers 发快捷键（key=\"a\"+ctrl 即 Ctrl+A）。输入文字用 webview_type；派发不了的按键名报 bad_args。",
        properties: &[
            (
                "key",
                "按键名（如 Enter、ArrowDown）或单 ASCII 字符，同 CDP key 值。",
                "string",
            ),
            (
                "selector",
                "先聚焦该元素再按键；与 ref 二选一，省略按在聚焦元素上。",
                "string",
            ),
            ("ref", REF_VS_SELECTOR_DOC, "string"),
            (
                "modifiers",
                "修饰键（字符串或数组）：ctrl / alt / shift / meta。按住 ctrl/alt/meta 不插入字符（组合键语义）。",
                "string_or_string_array",
            ),
            ("repeat", "连按次数，默认 1（上限 64）。", "integer"),
            ("settle_ms", "按键后等待毫秒数，默认 60。", "integer"),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &["key"],
    },
    ToolSpec {
        name: "webview_hover",
        description: "悬停到元素或坐标（只派发 mouseMoved），触发 hover 菜单 / tooltip。命中测试同 click：hitIsSelfOrDescendant 为 false 即被遮挡；浮层可能随鼠标移走收起。",
        properties: &[
            ("selector", POINTER_SELECTOR_DOC, "string"),
            ("ref", POINTER_REF_DOC, "string"),
            ("x", "视口坐标 X（CSS 像素）。", "number"),
            ("y", "视口坐标 Y（CSS 像素）。", "number"),
            (
                "settle_ms",
                "悬停后等待毫秒，默认 60。",
                "integer",
            ),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_scroll",
        description: "滚动窗口或容器：to=top|bottom、绝对 x/y、相对 dx/dy；仅给 selector 滚进视口中央，全省略回顶部。返回 window/document/element 三层位置。",
        properties: &[
            (
                "selector",
                "滚动目标容器；省略则滚动窗口。仅给 selector 时将其滚进视口中央。",
                "string",
            ),
            ("to", "滚到顶部或底部。", "enum:top|bottom"),
            (
                "x",
                "绝对位置：窗口模式是 scrollTo，selector 模式是元素 scrollLeft。",
                "number",
            ),
            (
                "y",
                "绝对位置：窗口模式是 scrollTo，selector 模式是元素 scrollTop。",
                "number",
            ),
            ("dx", "相对横向位移（scrollBy）。", "number"),
            ("dy", "相对纵向位移（scrollBy）。", "number"),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_select",
        description: "选中 <select> 选项：value / label / index 恰好给一种（multiple 可给数组）。派发 input+change 同步受控组件，返回 selectedValues 确认生效。非 select 或无匹配时返回对应 reason。",
        properties: &[
            ("selector", "select 元素选择器；与 ref 恰好给出一个。", "string"),
            ("ref", "快照 ref（如 e12）；与 selector 恰好给出一个。", "string"),
            (
                "value",
                "按 option 的 value 全等匹配，multiple 时可给数组。",
                "string_or_string_array",
            ),
            (
                "label",
                "按 option 显示文本（trim 后全等）匹配，可给数组。",
                "string_or_string_array",
            ),
            ("index", "按 option 下标匹配，可给数组。", "integer_or_array"),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_wait",
        description: "动作间同步原语：等元素出现/消失（selector+hidden）、条件为真（condition）、URL 含子串（href_contains）或 readyState complete（ready），恰好给一种。poll_ms 默认 100；timeout_ms 默认 10000，超时返回 satisfied=false 不算失败；条件抛异常立即带回。",
        properties: &[
            (
                "selector",
                "等该选择器命中元素出现；配 hidden=true 等其消失。",
                "string",
            ),
            (
                "hidden",
                "仅 selector 有效：true = 等元素消失或不可见。默认 false。",
                "boolean",
            ),
            (
                "condition",
                "等该 JS 表达式为真（不是函数，如 location.hash === '#/done'）。",
                "string",
            ),
            (
                "href_contains",
                "等 location.href 含该子串（不区分大小写）。",
                "string",
            ),
            ("ready", "等待 document.readyState 变为 complete。", "boolean"),
            ("poll_ms", "轮询间隔毫秒，10-2000，默认 100。", "integer"),
            (
                "timeout_ms",
                "等待预算毫秒，默认 10000。超时返回 satisfied=false，不算工具失败。",
                "integer",
            ),
            ("target", TARGET_DOC, "string"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_navigate",
        description: "导航 / 重载 / 前进后退。就绪判定轮询 document.readyState——Page.loadEventFired 对 SPA 路由切换不触发。",
        properties: &[
            (
                "action",
                "要执行的导航动作。",
                "enum:goto|reload|back|forward",
            ),
            ("url", "action=goto 时的目标地址。", "string"),
            ("ignore_cache", "reload 时忽略缓存。默认 false。", "boolean"),
            (
                "settle_ms",
                "等待就绪的最长时间，默认 3000。",
                "integer",
            ),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &["action"],
    },
    ToolSpec {
        name: "tauri_invoke",
        description: "调用任意已注册的 Tauri 命令（等价页面里 invoke）。失败同时给 error 与 errorRaw——PylonError 的 Err 可能是字符串也可能是对象，两种都给省一轮排障。",
        properties: &[
            (
                "command",
                "命令名，不带 plugin: 前缀即 #[tauri::command] 函数名，如 list_runtime_logs。",
                "string",
            ),
            (
                "args",
                "传给命令的参数对象，键名按该命令的参数名（camelCase）。",
                "object",
            ),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &["command"],
    },
    ToolSpec {
        name: "tauri_events",
        description: "订阅并读取 Tauri 事件增量。必须显式给事件名（无法全量旁路捕获），用 tauri_event_catalog 扫名字。订阅幂等且注册成「新文档注入」，reload 后自动重建（见 reloadSubscription）。",
        properties: &[
            (
                "events",
                "要订阅的事件名（数组或单个字符串），重复订阅安全。",
                "string_or_string_array",
            ),
            ("since_seq", SINCE_DOC, "integer"),
            ("limit", LIMIT_DOC, "integer"),
            ("scan", SCAN_DOC, "integer"),
            ("reset", RESET_DOC, "boolean"),
            (
                "buffer_size",
                "页内环形缓冲容量，默认 500（10-20000），超出丢最旧。",
                "integer",
            ),
            (
                "target_kind",
                "事件目标类型。",
                "enum:Any|AnyLabel",
            ),
            ("target_label", "target_kind=AnyLabel 时的窗口 label。", "string"),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "tauri_event_catalog",
        description: "静态扫描源码，列出 emit / emitTo / listen 调用点的事件名并区分收发双方，是 tauri_events 的名字来源。动态拼接的扫不到，见 dynamicSites。",
        properties: &[
            (
                "roots",
                "要扫描的目录（相对 cwd），默认 [\"src\", \"src-tauri/src\"]。",
                "string_array",
            ),
            ("pattern", "按事件名子串过滤结果（大小写不敏感）。", "string"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "tauri_window_state",
        description: "窗口状态：宿主侧（装饰/可见性/最大化/缩放/显示器等权威值）+ DOM 侧（视口/DPR）。个别宿主命令失败只进 tauriHostErrors。",
        properties: &[
            (
                "label",
                "窗口 label。省略则读当前页面的 currentWindow.label。",
                "string",
            ),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "tauri_backend_logs",
        description: "读后端运行日志（Pylon 的 list_runtime_logs），与前端「运行日志」面板同源，可对齐后端与界面时间轴；容量有限，旧条目会被覆盖。",
        properties: &[
            (
                "level",
                "按级别过滤，例如 error / warn / info（大小写不敏感）。",
                "string",
            ),
            ("source", "按来源过滤，例如 frontend / runtime。", "string"),
            ("session", "按会话过滤。", "string"),
            ("search", "消息全文子串搜索（大小写不敏感）。", "string"),
            ("limit", "最多返回多少条，默认 100。", "integer"),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &[],
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_names_are_unique_and_prefixed() {
        let tools = catalog();
        let mut names: Vec<String> = tools
            .iter()
            .map(|tool| tool["name"].as_str().unwrap_or_default().to_string())
            .collect();
        let count = names.len();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), count, "工具名有重复");
        for name in &names {
            assert!(
                name.starts_with("webview_") || name.starts_with("tauri_"),
                "{name} 缺少前缀"
            );
        }
    }

    #[test]
    fn every_declared_type_spec_is_known() {
        // 类型描述是字符串 DSL：写错会静默降级成 string 且 schema 依然「合法」。
        // 这条断言是那个降级的唯一防线。
        for tool in TOOLS {
            for (key, _, type_spec) in tool.properties {
                let known = KNOWN_TYPE_SPECS.contains(type_spec) || type_spec.starts_with("enum:");
                assert!(
                    known,
                    "{}.{} 用了未知的类型描述 {:?}；请加入 KNOWN_TYPE_SPECS 或改用 enum: 形式",
                    tool.name, key, type_spec
                );
            }
        }
    }

    #[test]
    fn every_required_property_exists_and_is_described() {
        for tool in TOOLS {
            for key in tool.required {
                let property = tool
                    .properties
                    .iter()
                    .find(|(name, _, _)| name == key)
                    .unwrap_or_else(|| {
                        panic!("{}: required 字段 {} 不在 properties 里", tool.name, key)
                    });
                assert!(
                    property.1.len() >= 5,
                    "{}.{} 的说明太短，agent 无法据此判断怎么填",
                    tool.name,
                    key
                );
            }
        }
    }

    #[test]
    fn every_property_gets_both_a_type_and_a_description() {
        for tool in catalog() {
            let name = tool["name"].as_str().unwrap_or_default();
            for (key, property) in tool["inputSchema"]["properties"].as_object().unwrap() {
                assert!(property.get("type").is_some(), "{name}.{key} 缺少 type");
                assert!(
                    property
                        .get("description")
                        .and_then(Value::as_str)
                        .map(|text| text.len() >= 5)
                        .unwrap_or(false),
                    "{name}.{key} 缺少有意义的说明"
                );
            }
        }
    }

    #[test]
    fn enum_specs_become_json_schema_enum_constraints() {
        let schema = type_schema("enum:png|jpeg");
        assert_eq!(schema["type"], "string");
        assert_eq!(schema["enum"], json!(["png", "jpeg"]));

        let single = type_schema("enum:Any|AnyLabel");
        assert_eq!(single["enum"], json!(["Any", "AnyLabel"]));
    }

    #[test]
    fn array_specs_declare_their_item_type() {
        assert_eq!(type_schema("string_array")["items"]["type"], "string");
        assert_eq!(
            type_schema("string_or_string_array")["items"]["type"],
            "string"
        );
        // 单值或数组：type 是列表，否则客户端做校验时会拒掉裸字符串写法。
        assert_eq!(
            type_schema("string_or_string_array")["type"],
            json!(["string", "array"])
        );
        assert_eq!(type_schema("integer_or_array")["items"]["type"], "integer");
        assert_eq!(
            type_schema("integer_or_array")["type"],
            json!(["integer", "array"])
        );
    }

    #[test]
    fn optional_enum_valued_properties_are_not_marked_required() {
        // click 的 button / mode 都有默认值，不能进 required，
        // 否则客户端会在调用方省略它们时拒掉请求。
        let click = TOOLS.iter().find(|t| t.name == "webview_click").unwrap();
        assert!(!click.required.contains(&"mode"));
        assert!(!click.required.contains(&"button"));
        assert!(!click.required.contains(&"selector"));
    }

    #[test]
    fn read_tools_expose_the_full_window_control_set() {
        for name in ["webview_console", "webview_network"] {
            let tool = TOOLS.iter().find(|t| t.name == name).unwrap();
            for key in ["since_seq", "limit", "scan", "reset"] {
                assert!(
                    tool.properties.iter().any(|(name, _, _)| *name == key),
                    "{name} 缺少窗口控制参数 {key}"
                );
            }
        }
    }

    #[test]
    fn tool_descriptions_explain_rather_than_restate_the_name() {
        for tool in TOOLS {
            assert!(
                tool.description.len() >= 60,
                "{} 的描述过短：{}",
                tool.name,
                tool.description
            );
        }
    }

    /// #218 的体积回归闸：`tools/list` 是每个 MCP 会话的固定上下文成本。
    /// 基线 22,258 字符（2026-09-21 实测），瘦身后上限 16,500。
    /// 新增工具或加长描述导致超限时，先砍描述再考虑放宽本闸。
    #[test]
    fn tools_list_payload_stays_under_the_slimming_budget() {
        let payload = serde_json::to_string(&json!({ "tools": catalog() })).unwrap();
        let chars = payload.chars().count();
        assert!(
            chars <= 16_500,
            "tools/list 返回体 {chars} 字符，超过 #218 瘦身上限 16500"
        );
    }

    #[tokio::test]
    async fn unknown_tool_reports_bad_args_and_points_at_tools_list() {
        let cx = Context {
            cdp: Arc::new(Cdp::new("127.0.0.1", 9222, Duration::from_millis(100))),
            cwd: Arc::new(PathBuf::from(".")),
            timeout_ms: 100,
        };
        let error = dispatch(&cx, "webview_nope", &json!({})).await.unwrap_err();
        assert_eq!(error.kind(), "bad_args");
        assert!(error.to_string().contains("tools/list"));
    }

    #[test]
    fn read_only_tools_are_annotated_and_mutating_ones_are_left_unannotated() {
        for name in READ_ONLY_TOOLS {
            let tool = TOOLS
                .iter()
                .find(|t| t.name == name)
                .unwrap_or_else(|| panic!("只读名单里的 {name} 不在工具表里"));
            assert_eq!(
                tool.build()["annotations"]["readOnlyHint"],
                true,
                "{name} 应带 readOnlyHint"
            );
        }
        // 输入、导航、任意求值/调用都会改变 app 状态，不能承诺只读。
        for name in [
            "webview_evaluate",
            "webview_click",
            "webview_type",
            "webview_navigate",
            "tauri_invoke",
            "tauri_events",
        ] {
            let tool = TOOLS.iter().find(|t| t.name == name).unwrap();
            assert!(
                tool.build().get("annotations").is_none(),
                "{name} 不该被标成只读"
            );
        }
    }

    #[test]
    fn webview_key_declares_the_modifiers_argument() {
        let key = TOOLS.iter().find(|t| t.name == "webview_key").unwrap();
        let (_, description, type_spec) = key
            .properties
            .iter()
            .find(|(name, _, _)| *name == "modifiers")
            .expect("webview_key 缺 modifiers 参数");
        assert_eq!(*type_spec, "string_or_string_array");
        assert!(description.contains("ctrl"), "{description}");
        // 修饰键有默认（无），不能进 required，否则省略即被客户端拒。
        assert!(!key.required.contains(&"modifiers"));
    }

    #[test]
    fn every_dispatched_name_exists_in_the_catalog() {
        // dispatch 的 match 分支与 TOOLS 表是两份人工维护的清单，
        // 这里保证 catalog 里的每个名字都真的能被 dispatch 到一个已实现的分支。
        for tool in TOOLS {
            assert!(
                tool.name.starts_with("webview_") || tool.name.starts_with("tauri_"),
                "{} 不在 dispatch 的命名空间内",
                tool.name
            );
        }
        assert_eq!(
            TOOLS.len(),
            24,
            "工具数量变化时请同步更新 README、smoke 脚本与 instructions"
        );
    }

    // ── pretty 的阈值行为（#218）──

    #[test]
    fn small_results_stay_pretty_printed() {
        let value = json!({ "ok": true, "items": [1, 2, 3] });
        let rendered = pretty(&value);
        assert!(rendered.contains('\n'), "小结果应逐行 pretty：{rendered}");
    }

    #[test]
    fn large_results_switch_to_compact_json() {
        // 超过 PRETTY_BELOW_CHARS 的结果：pretty 的缩进开销压过可读性收益。
        let items: Vec<Value> = (0..400)
            .map(|i| json!({ "seq": i, "text": "一些日志内容，用来把紧凑长度推过阈值" }))
            .collect();
        let value = json!({ "records": items });
        let compact_len = value.to_string().chars().count();
        assert!(compact_len > PRETTY_BELOW_CHARS, "前置：紧凑长度应超阈值");
        let rendered = pretty(&value);
        assert_eq!(rendered, value.to_string(), "大结果应为单行紧凑 JSON");
    }
}
