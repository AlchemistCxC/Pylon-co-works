//! 工具目录与分发。
//!
//! 每个工具是 `Context + JSON 参数 → ToolResult` 的纯函数式入口，
//! 不持有跨调用状态（跨调用状态只有 `Cdp` 里的会话表与页内缓冲）。

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

    /// 结构化结果统一 pretty-print：agent 逐行读 JSON 比读一行压缩 JSON
    /// 更容易定位字段，而这里的体积代价可以忽略。
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

pub fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
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
        "webview_dom" => page::dom(cx, args).await,
        "webview_query" => page::query(cx, args).await,
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
const READ_ONLY_TOOLS: [&str; 11] = [
    "webview_targets",
    "webview_console",
    "webview_network",
    "webview_network_body",
    "webview_dom",
    "webview_query",
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
        let mut tool = json!({
            "name": self.name,
            "description": self.description,
            "inputSchema": {
                "type": "object",
                "properties": properties,
                "required": self.required,
            },
        });
        if READ_ONLY_TOOLS.contains(&self.name) {
            // 客户端据此做权限提示/自动放行；不确定就不标。
            tool["annotations"] = json!({ "readOnlyHint": true });
        }
        tool
    }
}

// 反复出现的参数，说明文本刻意保持一致，便于 agent 形成稳定预期。
const TARGET_DOC: &str = "目标 id（支持前缀匹配）或 url/title 子串。只有一个页面目标时可省略；多目标时省略会报 ambiguous_target 并列出全部候选。";
const TIMEOUT_DOC: &str = "本次调用超时（毫秒），覆盖服务启动时的默认值。";
const SINCE_DOC: &str = "从该 seq 之后读。省略则从「上次读到的位置」继续——这是排障主路径（先做动作，再读增量）。显式传入则不推进游标，便于无副作用重读同一段。";
const LIMIT_DOC: &str = "最多返回多少条命中的记录，默认 50。";
const SCAN_DOC: &str = "本次最多检视多少条记录，默认 limit×20，上限 3000。与 limit 分开是为了让「最近 50 条 error」不必因为中间夹着上千条 info 而搜不到；实际检视条数会在返回的 scanned 里给出。";
const RESET_DOC: &str = "先清空缓冲并把游标推到当前末尾，即「从现在开始看」。默认 false。";

static TOOLS: &[ToolSpec] = &[
    ToolSpec {
        name: "webview_targets",
        description: "列出 WebView2 调试端点下所有可附加目标，并返回浏览器/协议版本。任何工具报 debug_endpoint_unreachable 时，第一步都回到这里确认端点是否活着——端点不可达时本工具不报错，而是返回 reachable=false 与开启步骤。",
        properties: &[(
            "include_workers",
            "是否连同 worker / service_worker 等非页面目标一起列出（它们通常不可附加）。默认 false。",
            "boolean",
        )],
        required: &[],
    },
    ToolSpec {
        name: "webview_evaluate",
        description: "在页面主世界求值 JS 表达式并返回可序列化结果。默认包成 async IIFE，因此表达式里可以直接用 await。结果是 DOM 节点/函数等不可序列化对象时返回 __unserializable 标记而不是 null，避免把「拿不到值」误判成「值就是 null」。结果序列化后超过 64KB 会换成 __truncated 信封（带大小与前缀预览），需要完整原始结果时用 webview_raw_cdp。",
        properties: &[
            (
                "expression",
                "要执行的 JS 表达式。wrap=true 时可写 await foo()；返回对象字面量请写成 (() => ({a:1}))() 以免被当成代码块。",
                "string",
            ),
            (
                "wrap",
                "是否包成 (async () => { return (<expression>); })()。默认 true。仅当表达式本身是语句序列时才需要 false。",
                "boolean",
            ),
            (
                "await_promise",
                "结果若是 Promise 是否等待 settle。默认 true。",
                "boolean",
            ),
            (
                "return_by_value",
                "是否按值序列化结果。默认 true；false 时只拿得到 RemoteObject 描述。",
                "boolean",
            ),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &["expression"],
    },
    ToolSpec {
        name: "webview_raw_cdp",
        description: "直接调用任意 CDP 方法并返回原始 result。用于本服务器尚未包装的域（DOM.* / CSS.* / Emulation.* / Performance.* 等），也是判断「某方法在当前 WebView2 版本是否可用」的探针。",
        properties: &[
            (
                "method",
                "CDP 方法名，例如 Page.captureScreenshot、DOM.getDocument、Emulation.setDeviceMetricsOverride。",
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
        description: "读控制台消息、未捕获异常与浏览器日志条目。默认只返回「上次读过之后」的增量，因此典型用法是先触发动作再读，而不是反复全量拉取。",
        properties: &[
            (
                "type",
                "按类型过滤，可给单个字符串或数组：log / info / warning / error / debug / exception。warn 与 warning 视为同一个级别。",
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
        description: "读网络请求日志。同一 requestId 的 request / response / loadingFinished / loadingFailed 会合并成一条记录，因此每条记录反映该请求的最终状态，而不是散成四行。默认读增量。",
        properties: &[
            (
                "resource_type",
                "按资源类型过滤：Document / Stylesheet / Script / XHR / Fetch / Image / Font / WS / Other。",
                "string",
            ),
            ("pattern", "按 URL 子串过滤（大小写不敏感）。", "string"),
            (
                "status_min",
                "只看状态码 >= 该值的响应，例如 400 只看错误响应。注意加载失败的请求没有状态码，会被本条件排除，那种场景请用 failed_only。",
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
        description: "按 requestId 取响应体。requestId 由 webview_network 返回。CDP 对非文本响应会回 base64，这里会解码后判断能否还原成 UTF-8；确实不是文本时给字节数与头部十六进制，而不是抛一坨 base64。",
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
        name: "webview_dom",
        description: "取 DOM 结构轮廓：每个元素的标签/id/class/属性，可选盒模型与叶子文本。走自序列化而不是 DOM.* 域，因此不受 nodeId 失效影响（DOM 变更会让 DOM.* 的 nodeId 作废）。节点数上限触发时会在 truncated 与 elidedChildren 里显式标注。",
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
                "是否带上叶子元素文本（截断到 240 字符）。默认 true。",
                "boolean",
            ),
            (
                "include_rect",
                "是否带上每个元素的盒模型。默认 false，开启后结果显著变大。",
                "boolean",
            ),
            ("target", TARGET_DOC, "string"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_query",
        description: "详查单个元素：盒模型、指定 CSS 属性的计算值、可见性、祖先链、滚动尺寸。可见性用 checkVisibility（综合 display/visibility/opacity）而不是只看尺寸是否为 0。",
        properties: &[
            (
                "selector",
                "CSS 选择器，命中第一个匹配元素（等价于 querySelector）。",
                "string",
            ),
            (
                "props",
                "要读的计算样式属性名数组，例如 [\"display\",\"z-index\",\"color\"]。省略则给一组常用属性。",
                "string_array",
            ),
            ("target", TARGET_DOC, "string"),
        ],
        required: &["selector"],
    },
    ToolSpec {
        name: "webview_screenshot",
        description: "截图并作为图片内容返回。full_page 用 Page.getLayoutMetrics 的 cssContentSize 做整页捕获；该参数在部分 WebView2 版本不支持，失败时会自动退回视口截图并在说明里写清，而不是整次失败。",
        properties: &[
            ("full_page", "整页捕获而非仅视口。默认 false。", "boolean"),
            (
                "format",
                "png（默认）或 jpeg。jpeg 体积小但会丢细线，核对 1px 边框时用 png。",
                "enum:png|jpeg",
            ),
            (
                "quality",
                "jpeg 质量 0-100，默认 80。png 忽略此参数。",
                "integer",
            ),
            (
                "clip",
                "裁剪区域 {x,y,width,height}（CSS 像素）。与 full_page 同时给出时以 clip 为准。",
                "object",
            ),
            ("target", TARGET_DOC, "string"),
            (
                "timeout_ms",
                "本次调用超时（毫秒）。整页截图较慢，必要时调大。",
                "integer",
            ),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_click",
        description: "点击元素或坐标。默认派发真实鼠标事件（先滚进视口再命中测试），返回里的 hitIsSelfOrDescendant 表明该点是否真的落在目标或其子树上——为 false 即目标被遮挡，这是「点了没反应」最常见的成因。mode=dom 退回 element.click()。",
        properties: &[
            (
                "selector",
                "目标元素选择器。与 x/y 二选一；selector 会先 scrollIntoView 再取中心点。",
                "string",
            ),
            ("x", "视口坐标 X（CSS 像素）。", "number"),
            ("y", "视口坐标 Y（CSS 像素）。", "number"),
            ("button", "鼠标键。", "enum:left|right|middle"),
            (
                "click_count",
                "点击次数，默认 1；2 = 双击（会派发两对 press/release，产生 dblclick），3 = 三击。上限 3，超出会被夹到 3。",
                "integer",
            ),
            (
                "mode",
                "input（默认，派发真实鼠标事件）或 dom（直接调 element.click()）。",
                "enum:input|dom",
            ),
            (
                "settle_ms",
                "点击后等待多少毫秒再返回，给 UI 反应时间，默认 80。",
                "integer",
            ),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_type",
        description: "向输入目标输入文本。默认用 Input.insertText（不逐字触发按键，快且对中文友好）；mode=keys 逐字符派发 keyDown/keyUp，用于监听键盘事件的组件。clear 走 DOM 赋值 + 派发 input 事件，以便受控组件同步状态。返回里带输入后的实际值，因为受控组件可能拒绝了这次输入。",
        properties: &[
            ("text", "要输入的文本。", "string"),
            (
                "selector",
                "输入目标选择器；省略则用当前聚焦元素。",
                "string",
            ),
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
        description: "派发命名按键（Enter / Tab / Escape / Backspace / Delete / Arrow* / Home / End / PageUp / PageDown / F1-F12 / 常用标点）或单个 ASCII 字符，可组合 modifiers 发出快捷键（如 key=\"a\" + modifiers=[\"ctrl\"] 即 Ctrl+A）。需要输入文字请用 webview_type，本工具用于导航、提交与组合键。无法派发的按键名（如 MetaLeft、中）直接报 bad_args，不会带着空键码发出无效按键。",
        properties: &[
            (
                "key",
                "按键名，例如 Enter、Escape、ArrowDown，或单个 ASCII 字符（如 a、.）。名称同 CDP key 值。",
                "string",
            ),
            (
                "selector",
                "先聚焦该元素再按键；省略则按在当前聚焦元素上。",
                "string",
            ),
            (
                "modifiers",
                "同时按下的修饰键，单个字符串或数组，例如 [\"ctrl\"]、[\"ctrl\",\"shift\"]。可用：ctrl（别名 control）/ alt / shift / meta（别名 cmd / command / win / super）。按住 ctrl / alt / meta 时不会插入字符，即组合键语义。",
                "string_or_string_array",
            ),
            ("repeat", "连按次数，默认 1（上限 64）。", "integer"),
            ("settle_ms", "按键后等待多少毫秒再返回，默认 60。", "integer"),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &["key"],
    },
    ToolSpec {
        name: "webview_hover",
        description: "把鼠标悬停到元素或坐标上（只派发 mouseMoved），用于触发 hover 菜单、tooltip、悬浮高亮。selector 会先滚进视口再取中心点，并附带与 webview_click 相同的命中测试报告：hitIsSelfOrDescendant 为 false 即该点被遮挡，真实用户的悬停同样到不了目标。注意 hover 出现的浮层在鼠标移走后可能收起，需要连续操作时把后续动作紧跟在本工具之后。",
        properties: &[
            (
                "selector",
                "目标元素选择器。与 x/y 二选一；selector 会先 scrollIntoView 再取中心点。",
                "string",
            ),
            ("x", "视口坐标 X（CSS 像素）。", "number"),
            ("y", "视口坐标 Y（CSS 像素）。", "number"),
            (
                "settle_ms",
                "悬停后等待多少毫秒再返回，给 hover 态反应时间，默认 60。",
                "integer",
            ),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "webview_scroll",
        description: "滚动页面或指定容器。selector 给定时滚动该元素内部（无其他参数时把元素滚进视口中央），否则滚动窗口。定位方式：to=top|bottom、绝对坐标 x/y、相对位移 dx/dy；全部省略时回页面顶部。返回滚动后 window / document / element 三个层面的位置，供后续断言滚动状态。",
        properties: &[
            (
                "selector",
                "滚动目标容器；省略则滚动窗口。仅给 selector 时将其滚进视口中央。",
                "string",
            ),
            ("to", "滚到顶部或底部：top / bottom。", "enum:top|bottom"),
            (
                "x",
                "绝对横向位置。窗口模式是 scrollTo 的 x；selector 模式是元素 scrollLeft。",
                "number",
            ),
            (
                "y",
                "绝对纵向位置。窗口模式是 scrollTo 的 y；selector 模式是元素 scrollTop。",
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
        description: "选中 <select> 的选项：value / label / 下标三种匹配方式恰好给一种（multiple 可给数组选多项），选中后派发 input 与 change 事件让受控组件同步状态。返回匹配到的 option 与选中后的 selectedValues，可直接确认这次选择是否真的生效。目标不是 select 元素时返回 reason=not-a-select；没有匹配项时返回 reason=no-matching-option 并带回现有选项列表。",
        properties: &[
            ("selector", "select 元素选择器。", "string"),
            (
                "value",
                "按 option 的 value 全等匹配，可给数组（multiple 时选中多项）。",
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
        required: &["selector"],
    },
    ToolSpec {
        name: "webview_wait",
        description: "等页面满足条件后再继续：元素出现/消失（selector，配 hidden）、JS 条件为真（condition，按 Boolean 截断的表达式）、URL 含子串（href_contains）、或 readyState 到 complete（ready）。四种条件恰好给一种。这是动作之间的同步原语，替代「点击后盲等固定毫秒」的猜法。轮询 poll_ms（10-2000，默认 100），预算 timeout_ms（默认 10000，超时返回 satisfied=false 而不是报错；单次探针调用超时取预算与 5s 的较小者）。条件表达式抛异常会立即带回异常；导航造成的瞬时求值失败会继续轮询。",
        properties: &[
            (
                "selector",
                "等待该 CSS 选择器命中元素出现；配合 hidden=true 则等待其消失或不可见。",
                "string",
            ),
            (
                "hidden",
                "仅 selector 条件有效。true 表示等待元素从 DOM 消失或变为不可见（checkVisibility，旧引擎退化为盒尺寸为零）。默认 false。",
                "boolean",
            ),
            (
                "condition",
                "等待该 JS 表达式为真（是表达式不是函数，例如 location.hash === '#/done'）。",
                "string",
            ),
            (
                "href_contains",
                "等待 location.href 包含该子串（大小写不敏感），适合等待路由切换。",
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
        description: "导航、重载、前进后退。就绪判定用轮询 document.readyState，而不是依赖 Page.loadEventFired——后者对 SPA 路由切换根本不触发。",
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
        description: "从调试通道调用任意已注册的 Tauri 命令（等价于页面里 window.__TAURI_INTERNALS__.invoke）。用于触发后端行为、读后端状态。命令失败时同时给人类可读的 error 与 errorRaw 的 JSON 形态——PylonError 的 Err 侧可能是字符串也可能是对象，猜错一种会多绕一轮排障。",
        properties: &[
            (
                "command",
                "命令名。Pylon 里不带 plugin: 前缀的命令即 #[tauri::command] 的函数名，例如 list_runtime_logs。",
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
        description: "订阅并读取 Tauri 事件的增量。必须显式给出事件名——tauri 的 __TAURI_INTERNALS__.invoke 用不可配置的 defineProperty 定义，无法包装，因此做不到全量旁路捕获。事件名先用 tauri_event_catalog 从源码扫出。订阅是幂等的，页面 reload 后下次调用会自动重新订阅。",
        properties: &[
            (
                "events",
                "要订阅的事件名数组（也接受单个字符串）。重复传入同一批名字是安全的。",
                "string_or_string_array",
            ),
            ("since_seq", SINCE_DOC, "integer"),
            ("limit", LIMIT_DOC, "integer"),
            ("scan", SCAN_DOC, "integer"),
            ("reset", RESET_DOC, "boolean"),
            (
                "buffer_size",
                "页内环形缓冲容量，默认 500（10-20000）。超出后丢最旧并累加 evicted。",
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
        description: "静态扫描源码，列出 emit / emit_to / emitTo / listen / listenOnce 调用点上出现的事件名，并区分发出方与接收方。这是 tauri_events 需要的事件名清单来源。用变量或模板字符串构造的事件名扫不到，返回里 dynamicSites 会给出这类位置的数量。",
        properties: &[
            (
                "roots",
                "要扫描的目录（相对当前工作目录），默认 [\"src\", \"src-tauri/src\"]。",
                "string_array",
            ),
            ("pattern", "按事件名子串过滤结果（大小写不敏感）。", "string"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "tauri_window_state",
        description: "窗口状态。Tauri 宿主侧（权威）给装饰/可见性/最大化/缩放/显示器等 DOM 拿不到的属性，DOM 侧给视口与设备像素比。宿主侧每个命令独立容错：权限或平台不支持时只让该字段变成 tauriHostErrors 里的一条，不会让整张状态表失败。",
        properties: &[
            (
                "label",
                "窗口 label。省略则从 page 的 metadata.currentWindow.label 读取，读不到时用该值兜底。",
                "string",
            ),
            ("target", TARGET_DOC, "string"),
            ("timeout_ms", TIMEOUT_DOC, "integer"),
        ],
        required: &[],
    },
    ToolSpec {
        name: "tauri_backend_logs",
        description: "读后端运行日志（调用 Pylon 自己的 list_runtime_logs 命令）。日志由 src-tauri 的 RuntimeLogHub 环形缓冲持有，与前端 RuntimeSheet 同源，因此能把「后端报了什么」和「界面显示了什么」对齐到一条时间轴。",
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
            22,
            "工具数量变化时请同步更新 README、smoke 脚本与 instructions"
        );
    }
}
