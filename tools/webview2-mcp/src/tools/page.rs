//! 页面级 CDP 工具：断言、采集、DOM、视觉、输入、导航。

use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};

use crate::args::Args;
use crate::cdp::events::Kind;
use crate::cdp::session::EvalOptions;
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
    let targets = match cx.cdp.targets().await {
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
    Ok(ToolResult::json(&value))
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

    let (outcome, stats) = cx
        .cdp
        .read_events(target, Kind::Console, since, scan, limit, |record| {
            console_matches(record, &types, pattern.as_deref())
        })
        .await?;

    Ok(ToolResult::json(&json!({
        "entries": outcome.entries,
        "returned": outcome.entries.len(),
        "scanned": outcome.scanned,
        "cursor": outcome.cursor,
        "explicitSinceSeq": since,
        "buffer": stats,
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
    })))
}

fn console_matches(record: &Value, types: &[String], pattern: Option<&str>) -> bool {
    if !types.is_empty() {
        let actual = record.get("type").and_then(Value::as_str).unwrap_or("");
        if !types.iter().any(|want| type_equals(want, actual)) {
            return false;
        }
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

    let (outcome, stats) = cx
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

    Ok(ToolResult::json(&json!({
        "entries": outcome.entries,
        "returned": outcome.entries.len(),
        "scanned": outcome.scanned,
        "cursor": outcome.cursor,
        "explicitSinceSeq": since,
        "buffer": stats,
        "bodyNote": "要看响应体请把 entries[].requestId 传给 webview_network_body。",
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
    let click_count = a.u64_or("click_count", 1)?;
    let settle_ms = a.u64_or("settle_ms", 80)?;

    if selector.is_none() && (x.is_none() || y.is_none()) {
        return Err(Error::bad_args(
            "webview_click",
            "需要 selector，或同时给出 x 与 y",
        ));
    }

    // 目标解析：selector 先滚进视口再算中心点，并做命中测试。
    let mut resolution = Value::Null;
    let (point_x, point_y) = match selector {
        Some(selector) => {
            let script = jsscript::resolve_click_target(selector);
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
            resolution = resolved;
            (point_x, point_y)
        }
        None => (x.unwrap_or(0.0), y.unwrap_or(0.0)),
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
    for params in [
        json!({ "type": "mouseMoved", "x": point_x, "y": point_y, "button": "none", "buttons": 0 }),
        json!({ "type": "mousePressed", "x": point_x, "y": point_y, "button": button, "buttons": buttons, "clickCount": click_count }),
        json!({ "type": "mouseReleased", "x": point_x, "y": point_y, "button": button, "buttons": 0, "clickCount": click_count }),
    ] {
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
            let specification = key_spec(&ch.to_string());
            dispatch_key(cx, target_arg, &specification, true).await?;
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
        dispatch_key(cx, target_arg, &key_spec("Enter"), true).await?;
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

    let specification = key_spec(name);
    for _ in 0..repeat {
        dispatch_key(cx, target_arg, &specification, true).await?;
    }
    sleep_ms(settle_ms).await;

    Ok(ToolResult::json(&json!({
        "pressed": true,
        "key": specification.key,
        "code": specification.code,
        "virtualKeyCode": specification.virtual_key_code,
        "repeat": repeat,
        "note": specification.note,
    })))
}

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
/// 分两层：先查命名键表（导航/编辑/提交这类「不产生字符但仍要有真实按键」的键），
/// 再退化成「当作单个字符处理」并带上说明，避免调用方以为任意名字都能用。
fn key_spec(name: &str) -> KeySpec {
    let lowered = name.to_ascii_lowercase();
    if let Some(spec) = named_key(&lowered) {
        return spec;
    }
    if let Some(index) = function_key_index(&lowered) {
        let code = format!("F{index}");
        return KeySpec {
            key: code.clone(),
            code,
            virtual_key_code: 111 + index as i64,
            text: None,
            note: None,
        };
    }

    // 单字符：按可打印字符派发。非 ASCII（中文等）没有 keydown 语义，
    // 应当走 webview_type，所以这里明确标出来。
    let mut chars = name.chars();
    match (chars.next(), chars.next()) {
        (Some(ch), None) if ch.is_ascii() => KeySpec {
            key: ch.to_string(),
            code: format!("Key{}", ch.to_ascii_uppercase()),
            virtual_key_code: ch.to_ascii_uppercase() as i64,
            text: Some(ch.to_string()),
            note: Some(format!("`{name}` 不在命名键表内，按可打印字符 `{ch}` 派发。")),
        },
        _ => KeySpec {
            key: name.to_string(),
            code: name.to_string(),
            virtual_key_code: 0,
            text: None,
            note: Some(format!(
                "`{name}` 不是已知命名键，也不是单个 ASCII 字符；已按字面量派发，行为可能不符合预期。\
                 要输入文字请用 webview_type。"
            )),
        },
    }
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
    with_events: bool,
) -> Result<()> {
    let mut down = json!({
        "type": "keyDown",
        "key": specification.key,
        "code": specification.code,
        "windowsVirtualKeyCode": specification.virtual_key_code,
        "nativeVirtualKeyCode": specification.virtual_key_code,
    });
    if let Some(text) = &specification.text {
        down["text"] = json!(text);
        down["unmodifiedText"] = json!(text);
    }
    if with_events {
        cx.cdp.call(target, "Input.dispatchKeyEvent", down).await?;
    }

    let up = json!({
        "type": "keyUp",
        "key": specification.key,
        "code": specification.code,
        "windowsVirtualKeyCode": specification.virtual_key_code,
        "nativeVirtualKeyCode": specification.virtual_key_code,
    });
    if with_events {
        cx.cdp.call(target, "Input.dispatchKeyEvent", up).await?;
    }
    Ok(())
}

// ───────────────────────────── 导航 ─────────────────────────────

pub async fn navigate(cx: &Context, args: &Value) -> Result<ToolResult> {
    let a = Args::new("webview_navigate", args);
    let target_arg = a.str("target")?;
    let action = a.required_str("action")?.to_string();
    let settle_ms = a.u64_or("settle_ms", 3000)?;
    let timeout = cx.timeout_from(a.u64("timeout_ms")?);

    let before = current_location(cx, target_arg).await;

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

    let settled = wait_for_ready(cx, target_arg, settle_ms).await;
    let after = current_location(cx, target_arg).await;

    Ok(ToolResult::json(&json!({
        "action": action,
        "settled": settled,
        "before": before,
        "after": after,
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

/// 轮询 `document.readyState` 直到 `complete` 或超时。
///
/// 不用 `Page.loadEventFired`：SPA 的路由切换根本不触发该事件，
/// 而这里真正想知道的是「现在能不能安全地对 DOM 做断言」。
async fn wait_for_ready(cx: &Context, target: Option<&str>, settle_ms: u64) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_millis(settle_ms);
    loop {
        let state = cx
            .cdp
            .evaluate(
                target,
                &jsscript::as_sync_body("return document.readyState;"),
                EvalOptions {
                    await_promise: false,
                    ..EvalOptions::default()
                },
            )
            .await;
        if let Ok(state) = state {
            if state.as_str() == Some("complete") {
                return true;
            }
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        sleep_ms(100).await;
    }
}

async fn sleep_ms(ms: u64) {
    if ms > 0 {
        tokio::time::sleep(Duration::from_millis(ms)).await;
    }
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
        let enter = key_spec("Enter");
        assert_eq!(enter.key, "Enter");
        assert_eq!(enter.virtual_key_code, 13);
        assert_eq!(enter.text.as_deref(), Some("\r"));

        let tab = key_spec("tab");
        assert_eq!(tab.key, "Tab");
        assert_eq!(tab.virtual_key_code, 9);

        let escape = key_spec("Esc");
        assert_eq!(escape.key, "Escape");
        assert!(escape.text.is_none());

        let down = key_spec("ArrowDown");
        assert_eq!(down.code, "ArrowDown");
        assert_eq!(down.virtual_key_code, 40);
    }

    #[test]
    fn function_keys_map_to_112_through_123() {
        assert_eq!(key_spec("F1").virtual_key_code, 112);
        assert_eq!(key_spec("f12").virtual_key_code, 123);
        assert_eq!(key_spec("F1").code, "F1");
        // F13 不存在，退化为字面量分支。
        assert!(key_spec("F13").note.is_some());
    }

    #[test]
    fn single_ascii_character_becomes_a_printable_key_with_a_note() {
        let spec = key_spec("a");
        assert_eq!(spec.key, "a");
        assert_eq!(spec.code, "KeyA");
        assert_eq!(spec.virtual_key_code, 65);
        assert_eq!(spec.text.as_deref(), Some("a"));
        assert!(spec.note.is_some());
    }

    #[test]
    fn unknown_multi_char_key_is_reported_as_unreliable() {
        let spec = key_spec("MetaLeft");
        assert!(spec.note.unwrap_or_default().contains("webview_type"));
    }

    #[test]
    fn non_ascii_single_char_is_flagged_rather_than_silently_dispatched() {
        let spec = key_spec("中");
        assert!(spec.note.unwrap_or_default().contains("webview_type"));
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
}
