//! 错误类型。
//!
//! 每一条 `Display` 都要对使用方（AI agent）可操作：说清**哪一层**失败、**为什么**、
//! **下一步做什么**。agent 看不到 stack trace，只有这段文本。

use serde_json::Value;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, thiserror::Error)]
pub enum Error {
    /// 调试端口连不上：进程没起来，或没带 `--remote-debugging-port`。
    #[error(
        "WebView2 调试端点不可达：{endpoint}/json —— {detail}。\
         确认 Pylon 正在运行，且 src-tauri/tauri.conf.json 的 app.windows[].additionalBrowserArgs \
         含 `--remote-debugging-port={port}`（详见 tools/webview2-mcp/README.md）"
    )]
    Unreachable {
        endpoint: String,
        port: u16,
        detail: String,
    },

    /// 端口通了但没有可调试页面。
    #[error(
        "调试端点 {endpoint} 可达，但没有可附加的 page target。\
         窗口可能尚未创建，或该 WebView2 的 DevTools 被禁用"
    )]
    NoTargets { endpoint: String },

    /// 有多个 page，调用方没指定要哪一个。
    #[error(
        "调试端点 {endpoint} 下有多个可附加目标，请用 target 参数指定 id（或 id 前缀）：{available}"
    )]
    AmbiguousTarget { endpoint: String, available: String },

    /// 调用方给的 target 匹配不上任何目标。
    #[error("找不到匹配 {requested:?} 的调试目标；当前可用：{available}")]
    UnknownTarget {
        requested: String,
        available: String,
    },

    /// 连接在调用过程中断开——通常是页面 reload 或 app 重启。
    #[error("CDP 连接已断开（{detail}）。这通常意味着页面 reload 或 app 重启；重试即可，下次调用会自动重连")]
    TargetGone { detail: String },

    /// CDP 返回了 error 对象。
    #[error("CDP {method} 失败：{detail}")]
    Cdp { method: String, detail: String },

    /// 页面里的 JS 抛了异常。
    #[error("页面 JS 抛异常：{detail}{location}")]
    JsException { detail: String, location: String },

    /// 超时。CDP 侧可能仍在跑（例如一个永不 settle 的 Promise）。
    #[error("{what} 超时（{ms}ms）。CDP 侧可能仍在执行；若是 evaluate 卡在未 settle 的 Promise，请缩小表达式或调大 timeout_ms")]
    Timeout { what: String, ms: u64 },

    /// 工具入参不合法。
    #[error("tool {tool} 参数错误：{detail}")]
    BadArgs { tool: String, detail: String },

    /// 页面不是 Tauri webview 这类「语义上不适用」的情况，由各个工具在
    /// 返回体里以结构化字段表达（例如 `reason: not-a-tauri-webview`），
    /// 而不是抛错误——这属于「查清了事实」，不属于「工具失败」。
    #[error("本地 IO 失败：{0}")]
    Io(String),
}

impl Error {
    pub fn bad_args(tool: &str, detail: impl Into<String>) -> Self {
        Self::BadArgs {
            tool: tool.to_string(),
            detail: detail.into(),
        }
    }

    /// 稳定的机读码。与 `Display` 分离：文案会改，码是契约。
    pub fn kind(&self) -> &'static str {
        match self {
            Error::Unreachable { .. } => "debug_endpoint_unreachable",
            Error::NoTargets { .. } => "no_targets",
            Error::AmbiguousTarget { .. } => "ambiguous_target",
            Error::UnknownTarget { .. } => "unknown_target",
            Error::TargetGone { .. } => "target_gone",
            Error::Cdp { .. } => "cdp_error",
            Error::JsException { .. } => "js_exception",
            Error::Timeout { .. } => "timeout",
            Error::BadArgs { .. } => "bad_args",
            Error::Io(_) => "io_error",
        }
    }

    fn hint(&self) -> Option<&'static str> {
        match self {
            Error::Unreachable { .. } => {
                Some("确认 Pylon 已启动并带调试端口；见 tools/webview2-mcp/README.md「接线」一节")
            }
            Error::NoTargets { .. } => {
                Some("窗口可能还没创建；等界面起来再重试，或调 webview_targets 观察")
            }
            Error::AmbiguousTarget { .. } => Some("用返回列表里的 id 前缀作为 target 参数"),
            Error::UnknownTarget { .. } => Some("调 webview_targets 取当前可用 id"),
            Error::TargetGone { .. } => Some("直接重试同一调用，下次会自动重连"),
            Error::Cdp { .. } => Some("用 webview_raw_cdp 复核该方法在当前 WebView2 版本是否可用"),
            Error::JsException { .. } => {
                Some("先 webview_console 看上下文，或把表达式拆小逐步求值")
            }
            Error::Timeout { .. } => {
                Some("调大 timeout_ms；若卡在未 settle 的 Promise，改成先取句柄再轮询结果")
            }
            Error::BadArgs { .. } => Some("按 tools/list 里的 inputSchema 修正参数"),
            Error::Io(_) => None,
        }
    }

    /// 供工具层产出结构化错误块——agent 更容易按字段分支，而不是正则匹配散文。
    pub fn to_wire(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("isError".into(), Value::Bool(true));
        obj.insert("error".into(), Value::String(self.kind().into()));
        obj.insert("detail".into(), Value::String(self.to_string()));
        if let Some(hint) = self.hint() {
            obj.insert("hint".into(), Value::String(hint.into()));
        }
        if let Error::BadArgs { tool, .. } = self {
            obj.insert("tool".into(), Value::String(tool.clone()));
        }
        Value::Object(obj)
    }
}
