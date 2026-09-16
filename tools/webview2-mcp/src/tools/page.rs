//! 页面级 CDP 工具：断言、采集、DOM、视觉、输入、导航。

use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

use crate::args::Args;
use crate::cdp::events::Kind;
use crate::cdp::session::EvalOptions;
use crate::cdp::SessionOrigin;
use crate::error::{Error, Result};
use crate::jsscript;
use crate::tools::{pretty, resolve_scan, Context, ToolResult, DEFAULT_LIMIT};

// ───────────────────────────── 目标发现 ─────────────────────────────

pub async fn targets(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_targets", args);
    let include_workers = a.bool_or("include_workers", false)?;

    let endpoint = cx.cdp.endpoint();
    // 这是诊断工具：端点不可达时**不**报错，而是把不可达本身作为结果返回，
    // 这样 agent 拿到的是一份可读的状态表，而不是一个需要另外解释的失败。
    // 走 fresh 读取：它是「端口通不通」的探针，吃缓存会把「现在连不上」
    // 报成「刚才连得上」。
    let targets = match cx.cdp.targets_fresh().await {
        Ok(targets) => targets,
        Err(error) => {
            return Ok(ToolResult::json(&json!({
                "reachable": false,
                "endpoint": endpoint,
                "error": error.to_wire(),
                "howToEnable": how_to_enable(cx.cdp.port),
            })));
        }
    };

    let browser = cx.cdp.version().await.ok();
    let listed: Vec<&crate::cdp::http::TargetInfo> = targets
        .iter()
        .filter(|target| include_workers || target.is_page_like() || target.is_attachable())
        .collect();

    Ok(ToolResult::json(&json!({
        "reachable": true,
        "endpoint": endpoint,
        "browser": browser,
        "totalTargets": targets.len(),
        "listedTargets": listed.len(),
        "attachablePages": targets.iter().filter(|t| t.is_page_like() && t.is_attachable()).count(),
        "targets": listed.iter().map(|target| json!({
            "id": target.id,
            "type": target.kind,
            "title": target.title,
            "url": target.url,
            "attachable": target.is_attachable(),
        })).collect::<Vec<Value>>(),
        "nextStep": if listed.is_empty() {
            "端口可达但没有可附加目标：窗口可能还没创建，稍后重试。"
        } else if targets.iter().filter(|t| t.is_page_like() && t.is_attachable()).count() == 1 {
            "只有一个页面目标，后续工具可以省略 target 参数。"
        } else {
            "有多个可附加目标，后续工具请用 targets[].id 作为 target 参数。"
        },
    })))
}

fn how_to_enable(port: u16) -> Value {
    json!({
        "reason": "WebView2 只在启动时读取 --remote-debugging-port，运行中无法开启。",
        "config": {
            "file": "src-tauri/tauri.conf.json",
            "path": "app.windows[].additionalBrowserArgs",
            "requiredValue": format!(
                "--remote-debugging-port={port} --remote-allow-origins=* --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection"
            ),
            "note": "该字段会整串替换 wry 的默认参数，所以 --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection 必须自己写回，否则会丢掉「去掉 mini menu / SmartScreen」的行为。"
        },
        "checks": [
            "确认 Pylon 进程真的在跑",
            "确认改动后重新构建/重启了 app（配置在启动时读取）",
            "确认端口没有被别的 WebView2 应用占用：多个 WebView2 进程用同一个端口会冲突"
        ],
    })
}

// ───────────────────────────── 求值 ─────────────────────────────

/// 求值结果的序列化上限。这是唯一没有天然边界的返回值（其它工具要么按条数、
/// 要么按字符数封顶），而它的消费者是 LLM 的上下文——一次 `JSON.stringify(bigState)`
/// 就能灌进几十万 token。超过时返回截断信封而不是原值。
const MAX_EVALUATE_BYTES: usize = 64 * 1024;
/// 截断信封里保留的预览字符数（按字符截，不切坏 UTF-8）。
const EVALUATE_PREVIEW_CHARS: usize = 2_048;

pub async fn evaluate(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_evaluate", args);
    let expression = a.required_str("expression")?;
    let wrap = a.bool_or("wrap", true)?;
    let options = EvalOptions {
        await_promise: a.bool_or("await_promise", true)?,
        return_by_value: a.bool_or("return_by_value", true)?,
        user_gesture: false,
        timeout: a.u64("timeout_ms")?.map(Duration::from_millis),
    };
    let script = jsscript::as_async_expression(expression, wrap);
    let value = cx.cdp.evaluate(a.str("target")?, &script, options).await?;
    // 不套信封：求值的结果本身就是结果，多一层 {result: ...} 只会让
    // agent 在 chain 调用时多剥一层。
    Ok(ToolResult::json(&cap_evaluate_output(value)))
}

/// 超限时换成截断信封：保留结构信息（原样大小 + 前缀预览），
/// 而不是悄悄把上下文塞满。确实需要完整原始结果时走 `webview_raw_cdp`。
fn cap_evaluate_output(value: Value) -> Value {
    let serialized = match serde_json::to_string(&value) {
        Ok(text) => text,
        // 理论上不可达（Value 一定能序列化）；真撞上就把原值交回去，
        // 总比因为一个哨兵分支丢掉结果强。
        Err(_) => return value,
    };
    if serialized.len() <= MAX_EVALUATE_BYTES {
        return value;
    }
    let preview: String = serialized.chars().take(EVALUATE_PREVIEW_CHARS).collect();
    json!({
        "__truncated": true,
        "bytes": serialized.len(),
        "limitBytes": MAX_EVALUATE_BYTES,
        "preview": preview,
        "note": "求值结果序列化后超过上限，已截断为前缀预览。请缩小返回结构（只取需要的字段、加 .length、分页）后重试；\
                 确实需要完整原始结果时改用 webview_raw_cdp 调 Runtime.evaluate。",
    })
}

pub async fn raw_cdp(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_raw_cdp", args);
    let method = a.required_str("method")?;
    let params = a.raw().get("params").cloned().unwrap_or_else(|| json!({}));
    if !params.is_object() {
        return Err(Error::bad_args(
            "webview_raw_cdp",
            "params 必须是对象（CDP 方法参数）",
        ));
    }
    let timeout = cx.timeout_from(a.u64("timeout_ms")?);
    let value = cx
        .cdp
        .call_with_timeout(a.str("target")?, method, params, timeout)
        .await?;
    Ok(ToolResult::json(&value))
}

// ───────────────────────────── 事件采集 ─────────────────────────────

pub async fn console(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_console", args);
    let target = a.str("target")?;
    let types = a.str_list("type")?;
    let pattern = a.string("pattern")?.map(|text| text.to_lowercase());
    let since = a.u64("since_seq")?;
    let limit = a.u64_or("limit", DEFAULT_LIMIT as u64)? as usize;
    let scan = resolve_scan(a.u64("scan")?, limit);

    if a.bool_or("reset", false)? {
        cx.cdp.reset_events(target, Kind::Console).await?;
    }

    let (outcome, stats, origin) = cx
        .cdp
        .read_events(target, Kind::Console, since, scan, limit, |record| {
            console_matches(record, &types, pattern.as_deref())
        })
        .await?;
    let reconnected = origin == SessionOrigin::Reconnected;

    Ok(ToolResult::json(&json!({
        "entries": outcome.entries,
        "returned": outcome.entries.len(),
        "scanned": outcome.scanned,
        "cursor": outcome.cursor,
        "explicitSinceSeq": since,
        "buffer": stats,
        "reconnected": reconnected,
        "cursorNote": if since.is_none() {
            "游标已推进到本次扫描末尾；下次省略 since_seq 即从那里继续。"
        } else {
            "本次传入的是显式 since_seq，游标未推进，可无副作用重读。"
        },
        "gapNote": if outcome.evicted > 0 {
            "缓冲已淘汰过记录（见 buffer.evicted）；早期事件可能已不在缓冲内。"
        } else {
            "缓冲未发生淘汰。"
        },
        "reconnectNote": if reconnected {
            "本次调用前连接已断开并已自动重连；事件缓冲属于旧会话，无法带回，本返回从新会话的零点开始。"
        } else {
            "会话延续自上次调用，缓冲完整。"
        },
    })))
}

fn console_matches(record: &Value, types: &[String], pattern: Option<&str>) -> bool {
    if !types.is_empty() && !types.iter().any(|want| console_type_matches(want, record)) {
        return false;
    }
    if let Some(pattern) = pattern {
        let text = record
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        if !text.contains(pattern) {
            return false;
        }
    }
    true
}

/// 类型过滤要同时比对两个字段：
///
/// - `type`：控制台调用的类型（log / error / …）或浏览器日志的级别；
/// - `kind`：异常记录（`Runtime.exceptionThrown`）的 `type` 固定是 `"error"`
///   ——那是 CDP 的语义，只有比对 `kind` 才能命中，否则文档承诺的
///   `type=exception` 永远返回空。
fn console_type_matches(want: &str, record: &Value) -> bool {
    let actual = record.get("type").and_then(Value::as_str).unwrap_or("");
    if type_equals(want, actual) {
        return true;
    }
    want.eq_ignore_ascii_case("exception")
        && record.get("kind").and_then(Value::as_str) == Some("exception")
}

/// CDP 用 `warning`，习惯写法是 `warn`；两者不该因为拼法不同就漏掉。
fn type_equals(want: &str, actual: &str) -> bool {
    if want.eq_ignore_ascii_case(actual) {
        return true;
    }
    matches!(
        (
            want.to_ascii_lowercase().as_str(),
            actual.to_ascii_lowercase().as_str()
        ),
        ("warn", "warning") | ("warning", "warn")
    )
}

pub async fn network(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_network", args);
    let target = a.str("target")?;
    let resource_type = a.string("resource_type")?;
    let pattern = a.string("pattern")?.map(|text| text.to_lowercase());
    let status_min = a.u64("status_min")?;
    let failed_only = a.bool_or("failed_only", false)?;
    let since = a.u64("since_seq")?;
    let limit = a.u64_or("limit", DEFAULT_LIMIT as u64)? as usize;
    let scan = resolve_scan(a.u64("scan")?, limit);

    if a.bool_or("reset", false)? {
        cx.cdp.reset_events(target, Kind::Network).await?;
    }

    let (outcome, stats, origin) = cx
        .cdp
        .read_events(target, Kind::Network, since, scan, limit, |record| {
            network_matches(
                record,
                resource_type.as_deref(),
                pattern.as_deref(),
                status_min,
                failed_only,
            )
        })
        .await?;
    let reconnected = origin == SessionOrigin::Reconnected;

    Ok(ToolResult::json(&json!({
        "entries": outcome.entries,
        "returned": outcome.entries.len(),
        "scanned": outcome.scanned,
        "cursor": outcome.cursor,
        "explicitSinceSeq": since,
        "buffer": stats,
        "reconnected": reconnected,
        "bodyNote": "要看响应体请把 entries[].requestId 传给 webview_network_body。",
        "reconnectNote": if reconnected {
            "本次调用前连接已断开并已自动重连；网络记录属于旧会话，无法带回，且断线期间的请求没有进入任何缓冲。"
        } else {
            "会话延续自上次调用，缓冲完整。"
        },
    })))
}

fn network_matches(
    record: &Value,
    resource_type: Option<&str>,
    pattern: Option<&str>,
    status_min: Option<u64>,
    failed_only: bool,
) -> bool {
    if let Some(want) = resource_type {
        let actual = record
            .get("resourceType")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !want.eq_ignore_ascii_case(actual) {
            return false;
        }
    }
    if let Some(pattern) = pattern {
        let url = record
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_lowercase();
        if !url.contains(pattern) {
            return false;
        }
    }
    let failed = record.get("failed").map(|v| !v.is_null()).unwrap_or(false);
    if failed_only && !failed {
        return false;
    }
    if let Some(min) = status_min {
        let status = record.get("status").and_then(Value::as_u64).unwrap_or(0);
        // 加载失败的请求没有状态码；被 status_min 过滤掉是合理的——
        // 要看失败请求请用 failed_only。
        if status < min {
            return false;
        }
    }
    true
}

pub async fn network_body(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_network_body", args);
    let request_id = a.required_str("request_id")?;
    let max_chars = a.u64_or("max_chars", 20_000)? as usize;

    let raw = cx
        .cdp
        .call(
            a.str("target")?,
            "Network.getResponseBody",
            json!({ "requestId": request_id }),
        )
        .await?;

    let body = raw.get("body").and_then(Value::as_str).unwrap_or("");
    let base64_encoded = raw
        .get("base64Encoded")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if !base64_encoded {
        let clipped = clip_chars(body, max_chars);
        return Ok(ToolResult::json(&json!({
            "requestId": request_id,
            "encoding": "text",
            "length": body.chars().count(),
            "truncated": clipped.1,
            "body": clipped.0,
        })));
    }

    // 二进制响应：解码后能还原成 UTF-8 就给文本，否则给尺寸与十六进制头，
    // 让调用方判断这是图片/字体还是乱码，而不是收到一坨 base64。
    let bytes = base64::engine::general_purpose::STANDARD.decode(body);
    match bytes {
        Err(error) => Ok(ToolResult::json(&json!({
            "requestId": request_id,
            "encoding": "base64",
            "length": body.len(),
            "decoded": false,
            "error": format!("base64 解码失败：{error}"),
            "body": clip_chars(body, max_chars).0,
        }))),
        Ok(bytes) => match String::from_utf8(bytes.clone()) {
            Ok(text) => {
                let clipped = clip_chars(&text, max_chars);
                Ok(ToolResult::json(&json!({
                    "requestId": request_id,
                    "encoding": "base64→utf8",
                    "length": text.chars().count(),
                    "truncated": clipped.1,
                    "body": clipped.0,
                })))
            }
            Err(_) => {
                let hex: String = bytes
                    .iter()
                    .take(64)
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<Vec<_>>()
                    .join(" ");
                Ok(ToolResult::json(&json!({
                    "requestId": request_id,
                    "encoding": "binary",
                    "decoded": true,
                    "byteLength": bytes.len(),
                    "headHex": hex,
                    "note": "内容不是 UTF-8 文本，已给出解码后字节数与头部十六进制。",
                })))
            }
        },
    }
}

fn clip_chars(text: &str, max_chars: usize) -> (String, bool) {
    if text.chars().count() <= max_chars {
        return (text.to_string(), false);
    }
    (text.chars().take(max_chars).collect(), true)
}

// ───────────────────────────── DOM ─────────────────────────────

const DEFAULT_QUERY_PROPS: [&str; 18] = [
    "display",
    "position",
    "width",
    "height",
    "margin",
    "padding",
    "color",
    "background-color",
    "border",
    "border-radius",
    "font-size",
    "font-weight",
    "line-height",
    "opacity",
    "overflow",
    "z-index",
    "visibility",
    "pointer-events",
];

pub async fn dom(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_dom", args);
    let options = EvalOptions {
        await_promise: false,
        ..EvalOptions::default()
    };
    let script = jsscript::dom_outline(
        a.str("selector")?,
        a.u64_or("max_depth", 5)? as usize,
        a.u64_or("max_nodes", 300)? as usize,
        a.bool_or("include_text", true)?,
        a.bool_or("include_rect", false)?,
    );
    let value = cx.cdp.evaluate(a.str("target")?, &script, options).await?;
    Ok(ToolResult::json(&value))
}

pub async fn query(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_query", args);
    let selector = a.required_str("selector")?;
    let props = a.str_list("props")?;
    let props: Vec<String> = if props.is_empty() {
        DEFAULT_QUERY_PROPS.iter().map(|p| p.to_string()).collect()
    } else {
        props
    };
    let options = EvalOptions {
        await_promise: false,
        ..EvalOptions::default()
    };
    let script = jsscript::query_element(selector, &props);
    let value = cx.cdp.evaluate(a.str("target")?, &script, options).await?;
    Ok(ToolResult::json(&value))
}

// ───────────────────────────── 视觉 ─────────────────────────────

pub async fn screenshot(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_screenshot", args);
    let target_arg = a.str("target")?;
    let format = a.str("format")?.unwrap_or("png").to_string();
    if format != "png" && format != "jpeg" {
        return Err(Error::bad_args(
            "webview_screenshot",
            format!("format 只支持 png / jpeg，收到 {format:?}"),
        ));
    }
    let full_page = a.bool_or("full_page", false)?;
    let clip = a.raw().get("clip").cloned();
    let timeout = cx.timeout_from(a.u64("timeout_ms")?);

    let mut params = json!({ "format": format, "fromSurface": true });
    if format == "jpeg" {
        params["quality"] = json!(a.u64_or("quality", 80)?);
    }

    let mut captured_mode = "viewport".to_string();
    let mut notes: Vec<String> = Vec::new();

    if let Some(clip) = clip.filter(|v| v.is_object()) {
        params["clip"] = clip;
        params["captureBeyondViewport"] = json!(true);
        captured_mode = "clip".to_string();
    } else if full_page {
        // 整页高度只能从布局指标拿：DOM 侧 scrollHeight 不含 overflow 之外的内容，
        // 对长列表会低估。
        match cx
            .cdp
            .call(target_arg, "Page.getLayoutMetrics", json!({}))
            .await
        {
            Ok(metrics) => {
                let size = metrics
                    .get("cssContentSize")
                    .or_else(|| metrics.get("contentSize"));
                let width = size
                    .and_then(|s| s.get("width"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let height = size
                    .and_then(|s| s.get("height"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                if width > 0.0 && height > 0.0 {
                    params["clip"] =
                        json!({ "x": 0, "y": 0, "width": width, "height": height, "scale": 1 });
                    params["captureBeyondViewport"] = json!(true);
                    captured_mode = "full-page".to_string();
                    notes.push(format!("整页尺寸 {width}×{height}（cssContentSize）"));
                } else {
                    notes.push(
                        "Page.getLayoutMetrics 没给出有效内容尺寸，已退回视口截图".to_string(),
                    );
                }
            }
            Err(error) => {
                notes.push(format!(
                    "Page.getLayoutMetrics 失败（{error}），已退回视口截图"
                ));
            }
        }
    }

    let raw = match cx
        .cdp
        .call_with_timeout(
            target_arg,
            "Page.captureScreenshot",
            params.clone(),
            timeout,
        )
        .await
    {
        Ok(value) => value,
        Err(error) if captured_mode != "viewport" => {
            // captureBeyondViewport 在部分 WebView2 版本上不被支持；
            // 与其整次失败，不如退回视口截图并把原因带回去。
            notes.push(format!(
                "带 clip/captureBeyondViewport 的截图失败（{error}），已退回视口截图"
            ));
            if let Value::Object(map) = &mut params {
                map.remove("clip");
                map.remove("captureBeyondViewport");
            }
            captured_mode = "viewport".to_string();
            cx.cdp
                .call_with_timeout(target_arg, "Page.captureScreenshot", params, timeout)
                .await?
        }
        Err(error) => return Err(error),
    };

    let data = raw
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Cdp {
            method: "Page.captureScreenshot".to_string(),
            detail: format!("返回里没有 data 字段：{}", pretty(&raw)),
        })?
        .to_string();

    let viewport = viewport_metrics(cx, target_arg).await;
    let approx_bytes = data.len() * 3 / 4;
    let mut caption = format!(
        "{format} 截图，模式 {captured_mode}，base64 约 {} KB。",
        approx_bytes / 1024
    );
    if let Some(viewport) = &viewport {
        caption.push_str(&format!(
            " 视口 {}×{}，devicePixelRatio {}。",
            viewport["innerWidth"], viewport["innerHeight"], viewport["devicePixelRatio"]
        ));
        if viewport["scrollHeight"].as_f64().unwrap_or(0.0)
            > viewport["innerHeight"].as_f64().unwrap_or(0.0)
        {
            caption.push_str(&format!(
                " 注意：文档高 {} 超过视口，被折叠的内容需要 full_page=true 或滚动后才能看到。",
                viewport["scrollHeight"]
            ));
        }
    }
    if !notes.is_empty() {
        caption.push(' ');
        caption.push_str(&notes.join("；"));
        caption.push('。');
    }

    Ok(ToolResult::text_and_image(
        caption,
        &data,
        &format!("image/{format}"),
    ))
}

async fn viewport_metrics(cx: &Context, target: Option<&str>) -> Option<Value> {
    let options = EvalOptions {
        await_promise: false,
        ..EvalOptions::default()
    };
    cx.cdp
        .evaluate(
            target,
            &jsscript::as_sync_body(
                "return { innerWidth: window.innerWidth, innerHeight: window.innerHeight, devicePixelRatio: window.devicePixelRatio, scrollHeight: document.documentElement.scrollHeight };",
            ),
            options,
        )
        .await
        .ok()
}

// ───────────────────────────── 输入 ─────────────────────────────

pub async fn click(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_click", args);
    let target_arg = a.str("target")?;
    let selector = a.str("selector")?;
    let x = a.f64("x")?;
    let y = a.f64("y")?;
    let mode = a.str("mode")?.unwrap_or("input").to_string();
    let button = a.str("button")?.unwrap_or("left").to_string();
    // 上限 3：单击/双击/三击有浏览器语义，更高的次数没有对应行为。
    let click_count = a.u64_or("click_count", 1)?.clamp(1, 3);
    let settle_ms = a.u64_or("settle_ms", 80)?;

    if selector.is_none() && (x.is_none() || y.is_none()) {
        return Err(Error::bad_args(
            "webview_click",
            "需要 selector，或同时给出 x 与 y",
        ));
    }

    // 目标解析：selector 先滚进视口再算中心点，并做命中测试。
    let (point_x, point_y, resolution) = match selector {
        Some(selector) => {
            let script = jsscript::resolve_pointer_target(selector);
            let resolved = cx
                .cdp
                .evaluate(target_arg, &script, EvalOptions::interactive())
                .await?;
            if resolved.get("found").and_then(Value::as_bool) != Some(true) {
                return Ok(ToolResult::json(&json!({
                    "clicked": false,
                    "reason": "selector 未命中任何元素",
                    "selector": selector,
                    "hint": "用 webview_query 或 webview_dom 确认选择器与当前 DOM。",
                })));
            }
            let point_x = resolved.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let point_y = resolved.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            (point_x, point_y, resolved)
        }
        None => {
            let point_x = x.unwrap_or(0.0);
            let point_y = y.unwrap_or(0.0);
            // 坐标模式同样先做命中测试：点之前先知道这个坐标上是谁——
            // 「点了没反应」在坐标模式下同样要能看出打到了谁。
            let hit = cx
                .cdp
                .evaluate(
                    target_arg,
                    &jsscript::point_hit(point_x, point_y),
                    EvalOptions {
                        await_promise: false,
                        ..EvalOptions::default()
                    },
                )
                .await
                .unwrap_or(Value::Null);
            (point_x, point_y, hit)
        }
    };

    if mode == "dom" {
        let Some(selector) = selector else {
            return Err(Error::bad_args(
                "webview_click",
                "mode=dom 需要 selector（DOM 模式没有坐标可以点）",
            ));
        };
        let script = format!(
            "(() => {{ const el = document.querySelector({}); if (!el) return {{ clicked: false }}; el.click(); return {{ clicked: true, tag: el.tagName.toLowerCase(), disabled: !!el.disabled }}; }})()",
            jsscript::js_str(selector)
        );
        let outcome = cx
            .cdp
            .evaluate(target_arg, &script, EvalOptions::interactive())
            .await?;
        sleep_ms(settle_ms).await;
        return Ok(ToolResult::json(&json!({
            "clicked": outcome.get("clicked").and_then(Value::as_bool).unwrap_or(false),
            "mode": "dom",
            "selector": selector,
            "resolution": resolution,
            "note": "DOM 模式绕过命中测试：适合目标被覆盖层遮挡的场景，但无法暴露「点不到」这类真实交互缺陷。",
        })));
    }

    let buttons = match button.as_str() {
        "right" => 2,
        "middle" => 4,
        _ => 1,
    };
    for params in click_events(point_x, point_y, &button, buttons, click_count) {
        cx.cdp
            .call(target_arg, "Input.dispatchMouseEvent", params)
            .await?;
    }
    sleep_ms(settle_ms).await;

    let occluded = resolution
        .get("hitIsSelfOrDescendant")
        .and_then(Value::as_bool)
        .map(|hit| !hit);

    Ok(ToolResult::json(&json!({
        "clicked": true,
        "mode": "input",
        "button": button,
        "clickCount": click_count,
        "point": { "x": point_x, "y": point_y },
        "resolution": resolution,
        "occludedWarning": match occluded {
            Some(true) => Some(format!(
                "命中测试落在 {} 上，不是目标元素 —— 该点被遮挡，真实用户点击也会打到覆盖物上。\
                 这通常就是「点了没反应」的成因。需要绕过时用 mode=dom。",
                resolution.get("hitPath").and_then(Value::as_str).unwrap_or("其它元素")
            )),
            _ => None,
        },
    })))
}

/// 点击的事件序列：先把指针移到目标点，再按次数派发 **press/release 对**。
///
/// Chromium 判定 `dblclick` 靠的是第二对事件的 `clickCount=2`；
/// 只发一对（哪怕把 clickCount 写成 2）不会产生 dblclick。
fn click_events(x: f64, y: f64, button: &str, buttons: i64, click_count: u64) -> Vec<Value> {
    let mut events =
        vec![json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none", "buttons": 0 })];
    for index in 1..=click_count {
        events.push(json!({
            "type": "mousePressed", "x": x, "y": y,
            "button": button, "buttons": buttons, "clickCount": index,
        }));
        events.push(json!({
            "type": "mouseReleased", "x": x, "y": y,
            "button": button, "buttons": 0, "clickCount": index,
        }));
    }
    events
}

pub async fn type_text(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_type", args);
    let target_arg = a.str("target")?;
    let text = a.required_str("text")?;
    let selector = a.str("selector")?;
    let clear = a.bool_or("clear", false)?;
    let mode = a.str("mode")?.unwrap_or("insert").to_string();
    let delay_ms = a.u64_or("delay_ms", 12)?;
    let submit = a.bool_or("submit", false)?;

    let focus = cx
        .cdp
        .evaluate(
            target_arg,
            &jsscript::focus_for_typing(selector, clear),
            EvalOptions::interactive(),
        )
        .await?;
    if focus.get("found").and_then(Value::as_bool) != Some(true) {
        return Ok(ToolResult::json(&json!({
            "typed": false,
            "reason": focus.get("reason").cloned().unwrap_or(json!("输入目标不存在")),
            "selector": selector,
            "focus": focus,
        })));
    }

    if mode == "keys" {
        for ch in text.chars() {
            let specification = key_spec(&ch.to_string()).map_err(|_| {
                Error::bad_args(
                    "webview_type",
                    format!(
                        "mode=keys 无法派发字符 {ch:?}（它没有对应的键盘事件）。含中文等非 ASCII \
                         文本请用 mode=insert（默认）。"
                    ),
                )
            })?;
            dispatch_key(cx, target_arg, &specification, 0).await?;
            if delay_ms > 0 {
                sleep_ms(delay_ms).await;
            }
        }
    } else {
        cx.cdp
            .call(target_arg, "Input.insertText", json!({ "text": text }))
            .await?;
    }

    if submit {
        dispatch_key(cx, target_arg, &key_spec("Enter")?, 0).await?;
    }

    // 回读输入后状态：受控组件可能拒绝了这次输入（例如校验失败后清空），
    // 只看「我发了什么」不足以下结论。
    let after = cx
        .cdp
        .evaluate(
            target_arg,
            &jsscript::as_sync_body(
                "const el = document.activeElement; if (!el) return { activeTag: null }; \
                 return { activeTag: el.tagName.toLowerCase(), activePath: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), \
                 value: ('value' in el && el.value !== undefined) ? String(el.value) : null, \
                 textContent: el.isContentEditable ? (el.textContent || '') : null };",
            ),
            EvalOptions { await_promise: false, ..EvalOptions::default() },
        )
        .await
        .ok();

    Ok(ToolResult::json(&json!({
        "typed": true,
        "mode": mode,
        "submitted": submit,
        "focus": focus,
        "afterTyping": after,
        "note": if mode == "keys" {
            "逐字符派发了 keyDown/keyUp。"
        } else {
            "用 Input.insertText 一次性插入，不触发逐字符键盘事件；需要键盘事件请用 mode=keys。"
        },
    })))
}

pub async fn key(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_key", args);
    let target_arg = a.str("target")?;
    let name = a.required_str("key")?;
    let selector = a.str("selector")?;
    let repeat = a.u64_or("repeat", 1)?.clamp(1, 64);
    let settle_ms = a.u64_or("settle_ms", 60)?;
    let modifiers = parse_modifiers("webview_key", &a.str_list("modifiers")?)?;

    if let Some(selector) = selector {
        let script = jsscript::focus_for_typing(Some(selector), false);
        let focus = cx
            .cdp
            .evaluate(target_arg, &script, EvalOptions::interactive())
            .await?;
        if focus.get("found").and_then(Value::as_bool) != Some(true) {
            return Ok(ToolResult::json(&json!({
                "pressed": false,
                "reason": "selector 未命中，无法聚焦",
                "selector": selector,
            })));
        }
    }

    let mut specification = key_spec(name)?;
    if modifiers & MODIFIER_SHIFT != 0 {
        apply_shift(&mut specification);
    }
    for _ in 0..repeat {
        dispatch_key(cx, target_arg, &specification, modifiers).await?;
    }
    sleep_ms(settle_ms).await;

    Ok(ToolResult::json(&json!({
        "pressed": true,
        "key": specification.key,
        "code": specification.code,
        "virtualKeyCode": specification.virtual_key_code,
        "modifiers": modifiers,
        "repeat": repeat,
        "note": specification.note,
    })))
}

/// CDP `Input.dispatchKeyEvent` 的 `modifiers` 位掩码。
const MODIFIER_ALT: i64 = 1;
const MODIFIER_CTRL: i64 = 2;
const MODIFIER_META: i64 = 4;
const MODIFIER_SHIFT: i64 = 8;
/// 按住这几个键时 `text` 必须省略：组合键只触发快捷键，不插入字符。
const MODIFIER_TEXT_SUPPRESSING: i64 = MODIFIER_ALT | MODIFIER_CTRL | MODIFIER_META;

/// 修饰键名 → CDP `modifiers` 位掩码。
fn parse_modifiers(tool: &str, names: &[String]) -> Result<i64> {
    let mut mask = 0i64;
    for name in names {
        mask |= match name.to_ascii_lowercase().as_str() {
            "alt" => MODIFIER_ALT,
            "ctrl" | "control" => MODIFIER_CTRL,
            "meta" | "cmd" | "command" | "win" | "super" => MODIFIER_META,
            "shift" => MODIFIER_SHIFT,
            other => {
                return Err(Error::bad_args(
                    tool,
                    format!(
                        "未知修饰键 {other:?}；可用：ctrl / alt / shift / meta（meta 即 Win 键）"
                    ),
                ))
            }
        };
    }
    Ok(mask)
}

/// Shift 按住时，单字母键的 `key`/`text` 要变成大写（`Shift+a` 的 key 是 `A`，
/// 页面据此判断字符）。其它可打印字符的 Shift 映射（`Shift+1` → `!`）不在这里
/// 展开——需要输入具体文字时用 `webview_type` 更可靠。
fn apply_shift(specification: &mut KeySpec) {
    let mut chars = specification.key.chars();
    if let (Some(ch), None) = (chars.next(), chars.next()) {
        if ch.is_ascii_lowercase() {
            let upper = ch.to_ascii_uppercase().to_string();
            specification.key = upper.clone();
            specification.text = Some(upper);
        }
    }
}

#[derive(Debug)]
struct KeySpec {
    key: String,
    code: String,
    virtual_key_code: i64,
    /// 会产生字符的按键需要带 `text`（Enter 是 `\r`，Tab 是 `\t`）。
    text: Option<String>,
    note: Option<String>,
}

/// 按键名 → CDP 派发所需的信息。
///
/// 分三层：先查命名键表（导航/编辑/提交这类「不产生字符但仍要有真实按键」的键），
/// 再查标点表（VK 码在 OEM 区段，不等于 ASCII），最后退化成「当作单个 ASCII
/// 字符处理」并带上说明。都不是就报错——带着 VK=0 派发一颗无效按键，只会让
/// agent 把「页面没反应」当成被测应用的缺陷。
fn key_spec(name: &str) -> Result<KeySpec> {
    let lowered = name.to_ascii_lowercase();
    if let Some(spec) = named_key(&lowered) {
        return Ok(spec);
    }
    if let Some(index) = function_key_index(&lowered) {
        let code = format!("F{index}");
        return Ok(KeySpec {
            key: code.clone(),
            code,
            virtual_key_code: 111 + index as i64,
            text: None,
            note: None,
        });
    }
    if let Some((code, virtual_key_code)) = punctuation_key(&lowered) {
        return Ok(KeySpec {
            key: lowered.clone(),
            code: code.to_string(),
            virtual_key_code,
            text: Some(lowered.clone()),
            note: None,
        });
    }

    let mut chars = name.chars();
    match (chars.next(), chars.next()) {
        (Some(ch), None) if ch.is_ascii() => Ok(KeySpec {
            key: ch.to_string(),
            code: format!("Key{}", ch.to_ascii_uppercase()),
            virtual_key_code: ch.to_ascii_uppercase() as i64,
            text: Some(ch.to_string()),
            note: Some(format!(
                "`{name}` 不在命名键表内，按可打印字符 `{ch}` 派发。"
            )),
        }),
        _ => Err(Error::bad_args(
            "webview_key",
            format!(
                "`{name}` 不是已知命名键（Enter / Tab / Escape / Arrow* / Home / End / PageUp / \
                 PageDown / F1-F12 / 常用标点），也不是单个 ASCII 字符。要输入文字请用 \
                 webview_type；组合键请用 modifiers 参数（例如 key=\"a\" + modifiers=[\"ctrl\"]）。"
            ),
        )),
    }
}

/// 美式键盘标点的 `(KeyboardEvent.code, Windows VK)`。
///
/// 这一段是 VK_OEM 区段，**VK 码不等于 ASCII 码**：照 ASCII 派发会打错键——
/// 例如 `.` 的 ASCII 是 46，而 46 作为 VK 是 Delete。
fn punctuation_key(ch: &str) -> Option<(&'static str, i64)> {
    let (code, virtual_key_code) = match ch {
        ";" => ("Semicolon", 186),
        "=" => ("Equal", 187),
        "," => ("Comma", 188),
        "-" => ("Minus", 189),
        "." => ("Period", 190),
        "/" => ("Slash", 191),
        "`" => ("Backquote", 192),
        "[" => ("BracketLeft", 219),
        "\\" => ("Backslash", 220),
        "]" => ("BracketRight", 221),
        "'" => ("Quote", 222),
        _ => return None,
    };
    Some((code, virtual_key_code))
}

/// 命名键表。返回 `None` 表示不在表内。
fn named_key(lowered: &str) -> Option<KeySpec> {
    let (key, code, virtual_key_code, text) = match lowered {
        "enter" | "return" => ("Enter", "Enter", 13, Some("\r")),
        "tab" => ("Tab", "Tab", 9, Some("\t")),
        "escape" | "esc" => ("Escape", "Escape", 27, None),
        "backspace" => ("Backspace", "Backspace", 8, None),
        "delete" | "del" => ("Delete", "Delete", 46, None),
        "arrowup" | "up" => ("ArrowUp", "ArrowUp", 38, None),
        "arrowdown" | "down" => ("ArrowDown", "ArrowDown", 40, None),
        "arrowleft" | "left" => ("ArrowLeft", "ArrowLeft", 37, None),
        "arrowright" | "right" => ("ArrowRight", "ArrowRight", 39, None),
        "home" => ("Home", "Home", 36, None),
        "end" => ("End", "End", 35, None),
        "pageup" => ("PageUp", "PageUp", 33, None),
        "pagedown" => ("PageDown", "PageDown", 34, None),
        "space" | " " => (" ", "Space", 32, Some(" ")),
        _ => return None,
    };
    Some(KeySpec {
        key: key.to_string(),
        code: code.to_string(),
        virtual_key_code,
        text: text.map(str::to_string),
        note: None,
    })
}

fn function_key_index(name: &str) -> Option<u8> {
    let digits = name.strip_prefix('f')?;
    let index: u8 = digits.parse().ok()?;
    // JS 侧 F1..F12 的 virtualKeyCode 是 112..123。
    (1..=12).contains(&index).then_some(index)
}

async fn dispatch_key(
    cx: &Context,
    target: Option<&str>,
    specification: &KeySpec,
    modifiers: i64,
) -> Result<()> {
    cx.cdp
        .call(
            target,
            "Input.dispatchKeyEvent",
            key_down_params(specification, modifiers),
        )
        .await?;
    cx.cdp
        .call(
            target,
            "Input.dispatchKeyEvent",
            key_up_params(specification, modifiers),
        )
        .await?;
    Ok(())
}

fn key_down_params(specification: &KeySpec, modifiers: i64) -> Value {
    let mut down = json!({
        "type": "keyDown",
        "key": specification.key,
        "code": specification.code,
        "windowsVirtualKeyCode": specification.virtual_key_code,
        "nativeVirtualKeyCode": specification.virtual_key_code,
        "modifiers": modifiers,
    });
    // Ctrl/Alt/Meta 按住时不带 text：否则 Chromium 会把字符插进去，
    // Ctrl+A 变成「先插入 a 再全选」。
    if modifiers & MODIFIER_TEXT_SUPPRESSING == 0 {
        if let Some(text) = &specification.text {
            down["text"] = json!(text);
            down["unmodifiedText"] = json!(text);
        }
    }
    down
}

fn key_up_params(specification: &KeySpec, modifiers: i64) -> Value {
    json!({
        "type": "keyUp",
        "key": specification.key,
        "code": specification.code,
        "windowsVirtualKeyCode": specification.virtual_key_code,
        "nativeVirtualKeyCode": specification.virtual_key_code,
        "modifiers": modifiers,
    })
}

// ───────────────────────────── 导航 ─────────────────────────────

pub async fn navigate(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_navigate", args);
    let target_arg = a.str("target")?;
    let action = a.required_str("action")?.to_string();
    let settle_ms = a.u64_or("settle_ms", 3000)?;
    let timeout = cx.timeout_from(a.u64("timeout_ms")?);

    let before = current_location(cx, target_arg).await;
    let before_href = before
        .get("href")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    match action.as_str() {
        "goto" => {
            let url = a
                .str("url")?
                .ok_or_else(|| Error::bad_args("webview_navigate", "action=goto 需要 url"))?;
            cx.cdp
                .call_with_timeout(target_arg, "Page.navigate", json!({ "url": url }), timeout)
                .await?;
        }
        "reload" => {
            cx.cdp
                .call_with_timeout(
                    target_arg,
                    "Page.reload",
                    json!({ "ignoreCache": a.bool_or("ignore_cache", false)? }),
                    timeout,
                )
                .await?;
        }
        "back" => {
            cx.cdp
                .evaluate(
                    target_arg,
                    &jsscript::as_sync_body("history.back(); return true;"),
                    EvalOptions {
                        await_promise: false,
                        ..EvalOptions::default()
                    },
                )
                .await?;
        }
        "forward" => {
            cx.cdp
                .evaluate(
                    target_arg,
                    &jsscript::as_sync_body("history.forward(); return true;"),
                    EvalOptions {
                        await_promise: false,
                        ..EvalOptions::default()
                    },
                )
                .await?;
        }
        other => {
            return Err(Error::bad_args(
                "webview_navigate",
                format!("action 只支持 goto / reload / back / forward，收到 {other:?}"),
            ));
        }
    }

    let settled = wait_for_ready(cx, target_arg, settle_ms, &before_href).await;
    let after = current_location(cx, target_arg).await;

    Ok(ToolResult::json(&json!({
        "action": action,
        "settled": settled,
        "before": before,
        "after": after,
        "settleNote": if settled {
            "已等到导航后的文档就绪（以导航证据 + readyState=complete 判定）。"
        } else {
            "在 settle_ms 内未等到导航后的文档就绪；after 字段给出当前位置，可调大 settle_ms 或用 webview_wait 继续等。"
        },
        "injectedStateNote": "reload / goto 会清空页内 MCP 状态（事件订阅缓冲会随之消失，游标归零）；这是预期行为，不是故障。",
    })))
}

async fn current_location(cx: &Context, target: Option<&str>) -> Value {
    cx.cdp
        .evaluate(
            target,
            &jsscript::as_sync_body(
                "return { href: location.href, readyState: document.readyState, title: document.title };",
            ),
            EvalOptions {
                await_promise: false,
                ..EvalOptions::default()
            },
        )
        .await
        .unwrap_or(Value::Null)
}

/// 轮询直到「导航后的文档」就绪，分两个阶段：
///
/// 1. **等导航证据**：href 变化、readyState 离开 complete，或 evaluate 报错
///    （旧 execution context 已销毁）。`Page.navigate` 返回得比导航提交更早，
///    旧文档的 complete 会在 goto/reload 刚发出时就被读到——没有这一步，
///    `settled` 会立刻误报 true。
/// 2. **等 readyState 回到 complete**。
///
/// 同址导航（href 不变、readyState 始终 complete）在宽限期 [`READY_GRACE`]
/// 后按就绪放行，避免死等。
async fn wait_for_ready(
    cx: &Context,
    target: Option<&str>,
    settle_ms: u64,
    before_href: &str,
) -> bool {
    let started = std::time::Instant::now();
    let grace = started + Duration::from_millis(READY_GRACE_MS);
    let deadline = started + Duration::from_millis(settle_ms.max(READY_GRACE_MS));
    let mut saw_navigation = false;
    loop {
        let state = cx
            .cdp
            .evaluate(
                target,
                &jsscript::as_sync_body(
                    "return { href: location.href, readyState: document.readyState };",
                ),
                EvalOptions {
                    await_promise: false,
                    ..EvalOptions::default()
                },
            )
            .await;
        match state {
            Ok(state) => {
                let ready = state.get("readyState").and_then(Value::as_str) == Some("complete");
                let href = state
                    .get("href")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let href_changed = !before_href.is_empty() && href != before_href;
                if !ready || href_changed {
                    saw_navigation = true;
                }
                if ready && (saw_navigation || std::time::Instant::now() >= grace) {
                    return true;
                }
            }
            // 求值失败 = 旧上下文销毁中，本身就是导航证据。
            Err(_) => saw_navigation = true,
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        sleep_ms(100).await;
    }
}

/// 同址导航的放行宽限：href 不变且一直 complete 时，等这么久才承认「就绪」。
const READY_GRACE_MS: u64 = 250;

async fn sleep_ms(ms: u64) {
    if ms > 0 {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
}

// ───────────────────────────── 网页界面增强 ─────────────────────────────

pub async fn hover(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_hover", args);
    let target_arg = a.str("target")?;
    let selector = a.str("selector")?;
    let x = a.f64("x")?;
    let y = a.f64("y")?;
    let settle_ms = a.u64_or("settle_ms", 60)?;

    if selector.is_none() && (x.is_none() || y.is_none()) {
        return Err(Error::bad_args(
            "webview_hover",
            "需要 selector，或同时给出 x 与 y",
        ));
    }

    let (point_x, point_y, resolution) = match selector {
        Some(selector) => {
            let resolved = cx
                .cdp
                .evaluate(
                    target_arg,
                    &jsscript::resolve_pointer_target(selector),
                    EvalOptions::interactive(),
                )
                .await?;
            if resolved.get("found").and_then(Value::as_bool) != Some(true) {
                return Ok(ToolResult::json(&json!({
                    "hovered": false,
                    "reason": "selector 未命中任何元素",
                    "selector": selector,
                    "hint": "用 webview_query 或 webview_dom 确认选择器与当前 DOM。",
                })));
            }
            let point_x = resolved.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let point_y = resolved.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            (point_x, point_y, resolved)
        }
        None => {
            let point_x = x.unwrap_or(0.0);
            let point_y = y.unwrap_or(0.0);
            let hit = cx
                .cdp
                .evaluate(
                    target_arg,
                    &jsscript::point_hit(point_x, point_y),
                    EvalOptions {
                        await_promise: false,
                        ..EvalOptions::default()
                    },
                )
                .await
                .unwrap_or(Value::Null);
            (point_x, point_y, hit)
        }
    };

    cx.cdp
        .call(
            target_arg,
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": point_x, "y": point_y, "button": "none", "buttons": 0 }),
        )
        .await?;
    sleep_ms(settle_ms).await;

    let occluded = selector.as_ref().and_then(|_| {
        resolution
            .get("hitIsSelfOrDescendant")
            .and_then(Value::as_bool)
            .map(|hit| !hit)
    });

    Ok(ToolResult::json(&json!({
        "hovered": true,
        "point": { "x": point_x, "y": point_y },
        "resolution": resolution,
        "occludedWarning": match occluded {
            Some(true) => Some(format!(
                "命中测试落在 {} 上，不是目标元素 —— 该点被遮挡，真实用户的悬停也到不了目标上。",
                resolution.get("hitPath").and_then(Value::as_str).unwrap_or("其它元素")
            )),
            _ => None,
        },
        "note": "只派发了 mouseMoved。hover 触发的浮层（菜单/tooltip）在鼠标移走后可能收起，需要连续操作时把后续动作紧跟在本工具之后。",
    })))
}

pub async fn scroll(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_scroll", args);
    let target_arg = a.str("target")?;
    let selector = a.str("selector")?;
    let to = a.str("to")?;
    if let Some(to) = to {
        if to != "top" && to != "bottom" {
            return Err(Error::bad_args(
                "webview_scroll",
                format!("to 只支持 top / bottom，收到 {to:?}"),
            ));
        }
    }
    let x = a.f64("x")?;
    let y = a.f64("y")?;
    let dx = a.f64("dx")?;
    let dy = a.f64("dy")?;

    let script = jsscript::scroll_page(selector, to, x, y, dx, dy);
    let value = cx
        .cdp
        .evaluate(
            target_arg,
            &script,
            EvalOptions {
                await_promise: false,
                ..EvalOptions::default()
            },
        )
        .await?;
    Ok(ToolResult::json(&value))
}

pub async fn select(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_select", args);
    let target_arg = a.str("target")?;
    let selector = a.required_str("selector")?;
    let values = a.str_list("value")?;
    let labels = a.str_list("label")?;
    let indexes = a.u64_list("index")?;

    // 三种匹配方式互斥：全空与多给都报 bad_args，不让工具猜调用方想用哪种。
    let provided = [!values.is_empty(), !labels.is_empty(), !indexes.is_empty()]
        .into_iter()
        .filter(|given| *given)
        .count();
    if provided != 1 {
        return Err(Error::bad_args(
            "webview_select",
            "value / label / index 恰好给出一种",
        ));
    }
    let (mode, wanted) = if !values.is_empty() {
        ("value", json!(values))
    } else if !labels.is_empty() {
        ("label", json!(labels))
    } else {
        ("index", json!(indexes))
    };

    let value = cx
        .cdp
        .evaluate(
            target_arg,
            &jsscript::select_options(selector, mode, &wanted),
            EvalOptions {
                await_promise: false,
                ..EvalOptions::default()
            },
        )
        .await?;
    Ok(ToolResult::json(&value))
}

pub async fn wait(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_wait", args);
    let target_arg = a.str("target")?;
    let selector = a.str("selector")?;
    let hidden = a.bool_or("hidden", false)?;
    let condition = a.str("condition")?;
    let href_contains = a.str("href_contains")?;
    let ready = matches!(a.bool("ready")?, Some(true));
    let poll_ms = a.u64_or("poll_ms", 100)?.clamp(10, 2_000);
    let budget_ms = a.u64_or("timeout_ms", 10_000)?;

    if hidden && selector.is_none() {
        return Err(Error::bad_args(
            "webview_wait",
            "hidden 只在 selector 条件下有意义",
        ));
    }
    let conditions = [
        selector.is_some(),
        condition.is_some(),
        href_contains.is_some(),
        ready,
    ]
    .into_iter()
    .filter(|given| *given)
    .count();
    if conditions != 1 {
        return Err(Error::bad_args(
            "webview_wait",
            "selector / condition / href_contains / ready 四种等待条件恰好给出一种",
        ));
    }

    let probe = if let Some(selector) = selector {
        jsscript::wait_selector(selector, hidden)
    } else if let Some(condition) = condition {
        jsscript::wait_condition(condition)
    } else if let Some(fragment) = href_contains {
        jsscript::wait_href(fragment)
    } else {
        jsscript::wait_ready()
    };

    let started = std::time::Instant::now();
    let deadline = started + Duration::from_millis(budget_ms);
    // 单次探针的 CDP 调用超时取「等待预算」与 5s 的较小者：探针是同步表达式，
    // 正常几毫秒就返回，大超时只会让真正的故障（上下文卡死）拖满预算。
    let probe_timeout = Some(Duration::from_millis(budget_ms.min(5_000)));

    let mut last = Value::Null;
    let mut satisfied = false;
    loop {
        match cx
            .cdp
            .evaluate(
                target_arg,
                &probe,
                EvalOptions {
                    await_promise: false,
                    timeout: probe_timeout,
                    ..EvalOptions::default()
                },
            )
            .await
        {
            Ok(state) => {
                last = state.clone();
                if state.get("satisfied").and_then(Value::as_bool) == Some(true) {
                    satisfied = true;
                    break;
                }
            }
            // 条件表达式写错了：立即把异常带回，空转到预算耗尽只会浪费轮次。
            Err(error @ Error::JsException { .. }) => return Err(error),
            // 导航导致的瞬时求值失败（旧上下文销毁中）→ 继续轮询。
            Err(_) => {}
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
        sleep_ms(poll_ms).await;
    }

    let elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(ToolResult::json(&json!({
        "satisfied": satisfied,
        "timedOut": !satisfied,
        "elapsedMs": elapsed_ms,
        "lastProbe": last,
        "note": if satisfied {
            "条件已满足，可以继续下一步。"
        } else {
            "等待预算内条件未满足；lastProbe 给出最后一次探针读数，可调大 timeout_ms 重试或先排查页面状态。"
        },
    })))
}

#[cfg(test)]
mod tests {
    use super::*;
    // 只在测试里用到：产品代码通过 resolve_scan 间接使用这个上限。
    use crate::tools::MAX_SCAN;

    #[test]
    fn warn_and_warning_are_treated_as_the_same_level() {
        assert!(type_equals("warn", "warning"));
        assert!(type_equals("warning", "warn"));
        assert!(type_equals("ERROR", "error"));
        assert!(!type_equals("error", "log"));
    }

    #[test]
    fn console_filter_matches_type_and_pattern_together() {
        let record = json!({ "type": "error", "text": "Failed to fetch session" });
        assert!(console_matches(&record, &[], None));
        assert!(console_matches(&record, &["error".into()], None));
        assert!(!console_matches(&record, &["log".into()], None));
        assert!(console_matches(&record, &[], Some("failed")));
        assert!(!console_matches(&record, &[], Some("nope")));
        // 两个条件是与关系。
        assert!(!console_matches(&record, &["log".into()], Some("failed")));
    }

    #[test]
    fn network_filter_handles_status_and_failure() {
        let ok = json!({ "url": "http://x/a.js", "resourceType": "Script", "status": 200, "failed": null });
        let bad = json!({ "url": "http://x/b.js", "resourceType": "Script", "status": null, "failed": "net::ERR_FAILED" });

        assert!(network_matches(&ok, None, None, None, false));
        assert!(!network_matches(&ok, None, None, Some(400), false));
        assert!(!network_matches(&ok, None, None, None, true));
        assert!(network_matches(&bad, None, None, None, true));
        // 失败请求没有状态码，status_min 过滤应把它排除。
        assert!(!network_matches(&bad, None, None, Some(400), false));
        assert!(network_matches(
            &bad,
            Some("script"),
            Some("b.js"),
            None,
            true
        ));
        assert!(!network_matches(&bad, Some("Document"), None, None, true));
    }

    #[test]
    fn scan_defaults_to_twenty_times_limit_and_is_capped() {
        assert_eq!(resolve_scan(None, 50), 1000);
        assert_eq!(resolve_scan(None, 1), 20);
        // 请求 10 万条检视也不会突破上限。
        assert_eq!(resolve_scan(Some(100_000), 50), MAX_SCAN);
        // 0 与极端小值会被抬到至少 1，避免扫描窗口为空导致游标永不动。
        assert_eq!(resolve_scan(Some(0), 50), 1);
    }

    #[test]
    fn named_keys_carry_virtual_key_codes_and_text() {
        let enter = key_spec("Enter").unwrap();
        assert_eq!(enter.key, "Enter");
        assert_eq!(enter.virtual_key_code, 13);
        assert_eq!(enter.text.as_deref(), Some("\r"));

        let tab = key_spec("tab").unwrap();
        assert_eq!(tab.key, "Tab");
        assert_eq!(tab.virtual_key_code, 9);

        let escape = key_spec("Esc").unwrap();
        assert_eq!(escape.key, "Escape");
        assert!(escape.text.is_none());

        let down = key_spec("ArrowDown").unwrap();
        assert_eq!(down.code, "ArrowDown");
        assert_eq!(down.virtual_key_code, 40);
    }

    #[test]
    fn punctuation_keys_use_oem_virtual_key_codes_not_ascii() {
        // `.` 的 ASCII 是 46，而 46 作为 VK 是 Delete——标点绝不能按 ASCII 取 VK。
        let period = key_spec(".").unwrap();
        assert_eq!(period.code, "Period");
        assert_eq!(period.virtual_key_code, 190);
        assert_eq!(period.text.as_deref(), Some("."));
        assert!(period.note.is_none(), "表内标点是已知键，不该再提示不可靠");

        assert_eq!(key_spec(";").unwrap().virtual_key_code, 186);
        assert_eq!(key_spec("=").unwrap().virtual_key_code, 187);
        assert_eq!(key_spec("[").unwrap().code, "BracketLeft");
        assert_eq!(key_spec("]").unwrap().code, "BracketRight");
        assert_eq!(key_spec("'").unwrap().virtual_key_code, 222);
        assert_eq!(key_spec("\\").unwrap().code, "Backslash");
    }

    #[test]
    fn function_keys_map_to_112_through_123() {
        assert_eq!(key_spec("F1").unwrap().virtual_key_code, 112);
        assert_eq!(key_spec("f12").unwrap().virtual_key_code, 123);
        assert_eq!(key_spec("F1").unwrap().code, "F1");
    }

    #[test]
    fn single_ascii_character_becomes_a_printable_key_with_a_note() {
        let spec = key_spec("a").unwrap();
        assert_eq!(spec.key, "a");
        assert_eq!(spec.code, "KeyA");
        assert_eq!(spec.virtual_key_code, 65);
        assert_eq!(spec.text.as_deref(), Some("a"));
        assert!(spec.note.is_some());
    }

    #[test]
    fn undispatchable_key_names_are_rejected_instead_of_sent_with_vk_zero() {
        // 带 VK=0 派发一颗无效按键，只会让 agent 把「页面没反应」当成应用缺陷。
        for name in ["MetaLeft", "F13", "中", "ControlLeft"] {
            let error = key_spec(name).unwrap_err();
            assert_eq!(error.kind(), "bad_args", "{name}");
            let text = error.to_string();
            assert!(text.contains("webview_type"), "{name}: {text}");
            assert!(text.contains("modifiers"), "{name}: {text}");
        }
    }

    #[test]
    fn modifiers_parse_to_the_cdp_bitmask() {
        let ctrl = parse_modifiers("webview_key", &["ctrl".to_string()]).unwrap();
        assert_eq!(ctrl, MODIFIER_CTRL);
        let combo =
            parse_modifiers("webview_key", &["ctrl".to_string(), "shift".to_string()]).unwrap();
        assert_eq!(combo, MODIFIER_CTRL | MODIFIER_SHIFT);
        // 别名与大小写都接受。
        assert_eq!(
            parse_modifiers("webview_key", &["Meta".to_string()]).unwrap(),
            MODIFIER_META
        );
        assert_eq!(
            parse_modifiers("webview_key", &["CMD".to_string()]).unwrap(),
            MODIFIER_META
        );
        assert_eq!(
            parse_modifiers("webview_key", &[]).unwrap(),
            0,
            "不给修饰键就是普通按键"
        );

        let error = parse_modifiers("webview_key", &["hyper".to_string()]).unwrap_err();
        assert_eq!(error.kind(), "bad_args");
        assert!(error.to_string().contains("ctrl"), "{error}");
    }

    #[test]
    fn combining_ctrl_drops_the_text_so_it_does_not_insert_a_character() {
        let letter = key_spec("a").unwrap();
        let plain = key_down_params(&letter, 0);
        assert_eq!(plain["text"], "a");
        assert_eq!(plain["unmodifiedText"], "a");

        // Ctrl+A 是「全选」，不能先插入一个 a。
        let ctrl = key_down_params(&letter, MODIFIER_CTRL);
        assert!(ctrl.get("text").is_none(), "{ctrl}");
        assert_eq!(ctrl["modifiers"], MODIFIER_CTRL);
        // keyUp 本来就不带 text，但必须带同一个 modifiers 位。
        assert_eq!(
            key_up_params(&letter, MODIFIER_CTRL)["modifiers"],
            MODIFIER_CTRL
        );
    }

    #[test]
    fn shift_turns_a_letter_key_uppercase_and_leaves_everything_else_alone() {
        // 没有 Shift 时原样：小写字母就是小写。
        let letter = key_spec("b").unwrap();
        assert_eq!(letter.key, "b");
        assert_eq!(letter.virtual_key_code, 66, "VK 是位置码，与大小写无关");

        // Shift+字母：key/text 变成大写，页面据此判断字符。
        let mut shifted = key_spec("b").unwrap();
        apply_shift(&mut shifted);
        assert_eq!(shifted.key, "B");
        assert_eq!(shifted.text.as_deref(), Some("B"));
        assert_eq!(shifted.virtual_key_code, 66);

        // 命名键与标点不受 Shift 改写（不能把 Enter 变成别的键）。
        let mut enter = key_spec("Enter").unwrap();
        apply_shift(&mut enter);
        assert_eq!(enter.key, "Enter");
        assert_eq!(enter.text.as_deref(), Some("\r"));

        let mut period = key_spec(".").unwrap();
        apply_shift(&mut period);
        assert_eq!(period.key, ".");
    }

    #[test]
    fn click_events_emit_a_press_release_pair_per_click() {
        let single = click_events(10.0, 20.0, "left", 1, 1);
        assert_eq!(single.len(), 3, "移动 + 一对 press/release");
        assert_eq!(single[0]["type"], "mouseMoved");
        assert_eq!(single[1]["clickCount"], 1);
        assert_eq!(single[2]["clickCount"], 1);
        assert_eq!(single[1]["buttons"], 1);
        assert_eq!(single[2]["buttons"], 0);

        // 双击必须发两对：Chromium 靠第二对的 clickCount=2 判定 dblclick。
        let double = click_events(10.0, 20.0, "left", 1, 2);
        assert_eq!(double.len(), 5);
        assert_eq!(double[3]["type"], "mousePressed");
        assert_eq!(double[3]["clickCount"], 2);
        assert_eq!(double[4]["type"], "mouseReleased");
        assert_eq!(double[4]["clickCount"], 2);

        let triple = click_events(1.0, 2.0, "right", 2, 3);
        assert_eq!(triple.len(), 7);
        assert_eq!(triple[5]["clickCount"], 3);
        assert_eq!(triple[5]["button"], "right");
    }

    #[test]
    fn exception_filter_matches_the_kind_field_not_only_the_type() {
        // 异常记录的 type 固定是 "error"（CDP 语义），文档承诺的 exception 靠 kind 命中。
        let exception = json!({ "kind": "exception", "type": "error", "text": "boom" });
        assert!(console_type_matches("exception", &exception));
        assert!(console_type_matches("ERROR", &exception));
        assert!(!console_type_matches("log", &exception));

        let console_error = json!({ "kind": "console", "type": "error", "text": "boom" });
        assert!(!console_type_matches("exception", &console_error));
        assert!(console_type_matches("error", &console_error));
    }

    #[test]
    fn oversized_evaluate_result_is_replaced_by_a_truncated_envelope() {
        let huge = json!({ "rows": vec!["x".repeat(200); 1000] });
        let capped = cap_evaluate_output(huge);
        assert_eq!(capped["__truncated"], true);
        assert_eq!(capped["limitBytes"], MAX_EVALUATE_BYTES);
        assert!(
            capped["bytes"].as_u64().unwrap_or(0) > MAX_EVALUATE_BYTES as u64,
            "{capped}"
        );
        let preview = capped["preview"].as_str().unwrap_or_default();
        assert!(
            preview.chars().count() <= EVALUATE_PREVIEW_CHARS,
            "预览不该超长"
        );
        assert!(preview.starts_with('{'), "预览应是序列化结果的前缀");
        assert!(capped.get("rows").is_none(), "截断后不再带原结构");
    }

    #[test]
    fn ordinary_evaluate_results_pass_through_unchanged() {
        let value = json!({ "ok": true, "n": 3 });
        assert_eq!(cap_evaluate_output(value.clone()), value);
        // 边界：正好不超限时不该触发截断。
        let exact = json!("x".repeat(MAX_EVALUATE_BYTES - 2));
        assert_eq!(cap_evaluate_output(exact.clone()), exact);
    }

    #[test]
    fn clip_chars_is_char_boundary_safe() {
        let (clipped, truncated) = clip_chars("中文中文", 3);
        assert!(truncated);
        assert_eq!(clipped, "中文中");
        let (whole, truncated) = clip_chars("abc", 10);
        assert!(!truncated);
        assert_eq!(whole, "abc");
    }

    #[test]
    fn how_to_enable_reminds_that_additional_args_replace_wry_defaults() {
        let hint = how_to_enable(9222);
        let required = hint["config"]["requiredValue"].as_str().unwrap_or_default();
        assert!(required.contains("--remote-debugging-port=9222"));
        assert!(required.contains("--remote-allow-origins=*"));
        // 漏掉这一项会静默丢行为，所以必须在提示里出现。
        assert!(required.contains("msWebOOUI"));
    }

    // ── 网页界面增强工具的参数校验（校验发生在任何 CDP 调用之前）──

    use std::path::PathBuf;
    use std::sync::Arc;

    fn test_context() -> Context {
        Context {
            cdp: Arc::new(crate::cdp::Cdp::new(
                "127.0.0.1",
                9222,
                Duration::from_millis(100),
            )),
            cwd: Arc::new(PathBuf::from(".")),
            timeout_ms: 100,
        }
    }

    #[tokio::test]
    async fn wait_requires_exactly_one_condition() {
        let cx = test_context();
        let error = crate::tools::dispatch(&cx, "webview_wait", &json!({}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("恰好给出一种"), "{error}");

        let error = crate::tools::dispatch(
            &cx,
            "webview_wait",
            &json!({ "selector": "#a", "ready": true }),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("恰好给出一种"), "{error}");
    }

    #[tokio::test]
    async fn wait_hidden_is_only_meaningful_with_a_selector() {
        let cx = test_context();
        let error = crate::tools::dispatch(
            &cx,
            "webview_wait",
            &json!({ "condition": "true", "hidden": true }),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("hidden"), "{error}");
    }

    #[tokio::test]
    async fn select_requires_exactly_one_match_mode() {
        let cx = test_context();
        let error = crate::tools::dispatch(&cx, "webview_select", &json!({ "selector": "#s" }))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("恰好给出一种"), "{error}");

        let error = crate::tools::dispatch(
            &cx,
            "webview_select",
            &json!({ "selector": "#s", "value": "a", "index": 0 }),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("恰好给出一种"), "{error}");
    }

    #[tokio::test]
    async fn hover_requires_selector_or_both_coordinates() {
        let cx = test_context();
        let error = crate::tools::dispatch(&cx, "webview_hover", &json!({ "x": 1.0 }))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("selector"), "{error}");
    }

    #[tokio::test]
    async fn scroll_rejects_unknown_to_value() {
        let cx = test_context();
        let error = crate::tools::dispatch(&cx, "webview_scroll", &json!({ "to": "middle" }))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("top / bottom"), "{error}");
    }
}
