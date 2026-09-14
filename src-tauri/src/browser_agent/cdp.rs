//! CdpDriver（Windows）：经 WebView2 `CallDevToolsProtocolMethod` 直调 CDP。
//!
//! 线程模型：`Webview::with_webview` 的闭包在 UI 线程事件循环执行；CDP 命令的
//! 完成回调经消息泵回到 UI 线程。因此：
//! - 命令调用：闭包里发起 COM 调用即返回，结果经 channel 交给
//!   `spawn_blocking` 接收（**不得在 UI 线程阻塞等待回调**——回调依赖泵）；
//! - 事件订阅：`GetDevToolsProtocolEventReceiver` + `add_*` 一次性注册，回调里
//!   仅做短临界区锁 + 队列写入；需要再发 CDP 命令（如 Fetch.failRequest）时走
//!   fire-and-forget，绝不等待。
//!
//! 域名白名单：只使用 Page/Runtime/DOM/Input/Network/Fetch/Emulation 的固定
//! 方法集，`CallDevToolsProtocolMethod` 的 method 参数不接受调用方透传。

#![cfg(windows)]

use super::driver::{NetworkEntry, NetworkRing};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Controller, ICoreWebView2DevToolsProtocolEventReceivedEventArgs,
};
use webview2_com::{
    take_pwstr, CallDevToolsProtocolMethodCompletedHandler,
    DevToolsProtocolEventReceivedEventHandler,
};
use windows::core::{HSTRING, PCWSTR, PWSTR};

/// CDP 命令默认超时（截图/MHTML 等大负载走宽松值）。
const CALL_TIMEOUT: Duration = Duration::from_secs(8);
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);

/// 响应体预览上限（与 spec 一致：≤64KiB，仅文本）。
const MAX_BODY_PREVIEW_BYTES: usize = 64 * 1024;

type NetworkRegistry = Arc<Mutex<HashMap<u64, NetworkRing>>>;

#[derive(Debug)]
struct CdpDispatch {
    /// 已注册过 Network 事件监听的 tab（监听器生命周期 = WebView 生命周期）。
    network_attached: bool,
    /// Fetch 拦截当前是否启用（随设置切换 enable/disable，监听器只注册一次）。
    fetch_enabled: bool,
}

impl Default for CdpDispatch {
    fn default() -> Self {
        Self {
            network_attached: false,
            fetch_enabled: false,
        }
    }
}

/// 每个 tab 的 CDP 状态（attach 标记 + 网络环形缓冲）。
#[derive(Debug, Default)]
pub(crate) struct CdpState {
    dispatch: HashMap<u64, CdpDispatch>,
    pub(crate) network: NetworkRegistry,
}

impl CdpState {
    pub(crate) fn new() -> Self {
        Self {
            dispatch: HashMap::new(),
            network: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(crate) fn drop_tab(&mut self, tab_id: u64) {
        self.dispatch.remove(&tab_id);
        self.network.lock().ok().map(|mut map| map.remove(&tab_id));
    }

    fn dispatch_mut(&mut self, tab_id: u64) -> &mut CdpDispatch {
        self.dispatch.entry(tab_id).or_default()
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 单次 CDP 命令调用（带超时）。`method` 只允许本模块内的固定白名单字面量。
async fn call_cdp(
    webview: &tauri::Webview,
    method: &'static str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let params_json = serde_json::to_string(&params).map_err(|error| error.to_string())?;
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let dispatch_result = webview.with_webview(move |platform| {
        let send_error = |message: String| {
            let _ = tx.send(Err(message));
        };
        let controller: ICoreWebView2Controller = platform.controller();
        let core = match unsafe { controller.CoreWebView2() } {
            Ok(core) => core,
            Err(error) => {
                send_error(format!("CoreWebView2 获取失败: {error}"));
                return;
            }
        };
        let method_h = HSTRING::from(method);
        let params_h = HSTRING::from(params_json.as_str());
        let tx_callback = tx.clone();
        let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
            move |error_code, return_json: String| {
                if error_code.is_ok() {
                    let _ = tx_callback.send(Ok(return_json));
                } else {
                    let _ = tx_callback.send(Err(format!(
                        "CDP {method} 失败: HRESULT {error_code:?} {return_json}"
                    )));
                }
                Ok(())
            },
        ));
        let call = unsafe {
            core.CallDevToolsProtocolMethod(
                PCWSTR(method_h.as_ptr()),
                PCWSTR(params_h.as_ptr()),
                &handler,
            )
        };
        if let Err(error) = call {
            send_error(format!("CDP {method} 发起失败: {error}"));
        }
    });
    if let Err(error) = dispatch_result {
        return Err(format!("with_webview 调度失败: {error}"));
    }
    let received = tokio::task::spawn_blocking(move || rx.recv_timeout(timeout))
        .await
        .map_err(|error| format!("CDP 接收任务失败: {error}"))?;
    let json = match received {
        Ok(Ok(json)) => json,
        Ok(Err(message)) => return Err(message),
        Err(timeout_error) => return Err(format!("CDP {method} 超时: {timeout_error}")),
    };
    serde_json::from_str(&json)
        .map_err(|error| format!("CDP 返回 JSON 非法: {error}（{json:.200}）"))
}

/// 在 UI 线程闭包内发一个不等待完成的 CDP 命令（事件回调里使用）。
fn fire_and_forget(core: &ICoreWebView2, method: &'static str, params: &Value) {
    let Ok(params_json) = serde_json::to_string(params) else {
        return;
    };
    let method_h = HSTRING::from(method);
    let params_h = HSTRING::from(params_json.as_str());
    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(|_, _| Ok(())));
    unsafe {
        let _ = core.CallDevToolsProtocolMethod(
            PCWSTR(method_h.as_ptr()),
            PCWSTR(params_h.as_ptr()),
            &handler,
        );
    }
}

/// CDP 事件参数 JSON 提取（COM out-param → `Value`）。
fn event_params(
    args: &Option<ICoreWebView2DevToolsProtocolEventReceivedEventArgs>,
) -> Option<Value> {
    let args = args.as_ref()?;
    let mut pointer = PWSTR::null();
    unsafe { args.ParameterObjectAsJson(&mut pointer) }.ok()?;
    let json = take_pwstr(pointer);
    serde_json::from_str(&json).ok()
}

/// 订阅一个 CDP 事件（receiver 路径；token 由 WebView 自管理，无需注销——
/// 监听器生命周期即 WebView 生命周期）。
fn subscribe_event(
    core: &ICoreWebView2,
    event: &'static str,
    handler: Box<
        dyn FnMut(
            Option<ICoreWebView2>,
            Option<ICoreWebView2DevToolsProtocolEventReceivedEventArgs>,
        ) -> windows::core::Result<()>,
    >,
) -> windows::core::Result<()> {
    let event_name = HSTRING::from(event);
    let boxed = DevToolsProtocolEventReceivedEventHandler::create(handler);
    unsafe {
        let receiver = core.GetDevToolsProtocolEventReceiver(PCWSTR(event_name.as_ptr()))?;
        let mut token: i64 = 0;
        receiver.add_DevToolsProtocolEventReceived(&boxed, &mut token)?;
    }
    Ok(())
}

/// 注册 Network/Fetch 事件监听并 enable（幂等：每个 tab 只注册一次监听器）。
/// Fetch.enable/disable 跟随 `ad_filter`；后续切换经 [`set_fetch_filter`]。
pub(crate) fn ensure_network_attached(
    webview: &tauri::Webview,
    tab_id: u64,
    state: &Mutex<CdpState>,
    ad_filter: bool,
) -> Result<(), String> {
    {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        let dispatch = guard.dispatch.entry(tab_id).or_default();
        if dispatch.network_attached && dispatch.fetch_enabled == ad_filter {
            return Ok(());
        }
    }
    let network = state.lock().ok().map(|guard| guard.network.clone());
    let Some(network) = network else {
        return Err("CdpState 锁不可用".to_string());
    };
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let fetch_requested = ad_filter;
    let dispatch_result = webview.with_webview(move |platform| {
        let setup = || -> windows::core::Result<()> {
            unsafe {
                let core = platform.controller().CoreWebView2()?;
                // 请求发出：入环 + 在飞计数。
                subscribe_event(&core, "Network.requestWillBeSent", {
                    let network = network.clone();
                    Box::new(move |_core, args| {
                        if let Some(params) = event_params(&args) {
                            if let Some(entry) = parse_request_will_be_sent(&params) {
                                if let Ok(mut map) = network.lock() {
                                    let ring = map.entry(tab_id).or_default();
                                    ring.push(entry);
                                    ring.inflight += 1;
                                    ring.note_activity(now_ms());
                                }
                            }
                        }
                        Ok(())
                    })
                })?;
                // 响应到达：补状态码/MIME。
                subscribe_event(&core, "Network.responseReceived", {
                    let network = network.clone();
                    Box::new(move |_core, args| {
                        if let Some(params) = event_params(&args) {
                            if let Some((request_id, status, mime, resource_type)) =
                                parse_response_received(&params)
                            {
                                if let Ok(mut map) = network.lock() {
                                    let ring = map.entry(tab_id).or_default();
                                    ring.upsert_finish(&request_id, "responded", Some(status), mime, now_ms());
                                    if let Some(resource_type) = resource_type {
                                        if let Some(entry) = ring
                                            .entries
                                            .iter_mut()
                                            .find(|entry| entry.request_id == request_id)
                                        {
                                            entry.resource_type = Some(resource_type);
                                        }
                                    }
                                }
                            }
                        }
                        Ok(())
                    })
                })?;
                // 完成/失败：在飞计数归位。
                for event in ["Network.loadingFinished", "Network.loadingFailed"] {
                    subscribe_event(&core, event, {
                        let network = network.clone();
                        Box::new(move |_core, args| {
                            if let Some(params) = event_params(&args) {
                                let request_id = params
                                    .get("requestId")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string();
                                if request_id.is_empty() {
                                    return Ok(());
                                }
                                if let Ok(mut map) = network.lock() {
                                    let ring = map.entry(tab_id).or_default();
                                    ring.inflight = (ring.inflight - 1).max(0);
                                    ring.upsert_finish(
                                        &request_id,
                                        if event.ends_with("Failed") { "failed" } else { "finished" },
                                        None,
                                        None,
                                        now_ms(),
                                    );
                                }
                            }
                            Ok(())
                        })
                    })?;
                }
                // 广告过滤：监听器常驻，Fetch.enable 才会产生 pause 事件。
                subscribe_event(&core, "Fetch.requestPaused", {
                    Box::new(move |core, args| {
                        if let Some(params) = event_params(&args) {
                            let request_id = params
                                .get("requestId")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string();
                            let blocked = params
                                .pointer("/request/url")
                                .and_then(Value::as_str)
                                .and_then(|url| url::Url::parse(url).ok())
                                .map(|url| super::driver::is_ad_domain(&url))
                                .unwrap_or(false);
                            if !request_id.is_empty() {
                                let command = if blocked {
                                    (
                                        "Fetch.failRequest",
                                        serde_json::json!({ "requestId": request_id, "errorReason": "BlockedByClient" }),
                                    )
                                } else {
                                    ("Fetch.continueRequest", serde_json::json!({ "requestId": request_id }))
                                };
                                if let Some(core) = core {
                                    fire_and_forget(&core, command.0, &command.1);
                                }
                            }
                        }
                        Ok(())
                    })
                })?;
                fire_and_forget(&core, "Network.enable", &serde_json::json!({}));
                if fetch_requested {
                    fire_and_forget(
                        &core,
                        "Fetch.enable",
                        &serde_json::json!({ "patterns": [{ "urlPattern": "*", "requestStage": "Request" }] }),
                    );
                }
            }
            Ok(())
        };
        let _ = tx.send(setup().map_err(|error| error.to_string()));
    });
    if let Err(error) = dispatch_result {
        return Err(format!("with_webview 调度失败: {error}"));
    }
    // setup 是同步执行的（with_webview 闭包内），短暂等待即可。
    let outcome = rx
        .recv_timeout(Duration::from_secs(3))
        .unwrap_or_else(|_| Err("CDP attach 无响应".to_string()));
    {
        let mut guard = state.lock().map_err(|error| error.to_string())?;
        let dispatch = guard.dispatch_mut(tab_id);
        dispatch.network_attached = true;
        dispatch.fetch_enabled = fetch_requested;
    }
    outcome
}

/// 动态开关某 tab 的广告/追踪拦截（监听器常驻，仅 enable/disable）。
pub(crate) async fn set_fetch_filter(
    webview: &tauri::Webview,
    tab_id: u64,
    state: &Mutex<CdpState>,
    enabled: bool,
) -> Result<(), String> {
    {
        let guard = state.lock().map_err(|error| error.to_string())?;
        match guard.dispatch.get(&tab_id) {
            Some(dispatch) if dispatch.fetch_enabled == enabled => return Ok(()),
            Some(dispatch) if !dispatch.network_attached => return Ok(()),
            _ => {}
        }
    }
    let method = if enabled {
        "Fetch.enable"
    } else {
        "Fetch.disable"
    };
    let params = if enabled {
        serde_json::json!({ "patterns": [{ "urlPattern": "*", "requestStage": "Request" }] })
    } else {
        serde_json::json!({})
    };
    call_cdp(webview, method, params, CALL_TIMEOUT).await?;
    let mut guard = state.lock().map_err(|error| error.to_string())?;
    guard.dispatch_mut(tab_id).fetch_enabled = enabled;
    Ok(())
}

fn parse_request_will_be_sent(params: &Value) -> Option<NetworkEntry> {
    let request_id = params.get("requestId")?.as_str()?.to_string();
    let url = params.pointer("/request/url")?.as_str()?.to_string();
    let method = params
        .pointer("/request/method")
        .and_then(Value::as_str)
        .unwrap_or("GET")
        .to_string();
    let resource_type = params
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(NetworkEntry {
        request_id,
        url,
        method,
        status: None,
        resource_type,
        mime_type: None,
        state: "pending",
        at_ms: now_ms(),
    })
}

fn parse_response_received(
    params: &Value,
) -> Option<(String, u32, Option<String>, Option<String>)> {
    let request_id = params.get("requestId")?.as_str()?.to_string();
    let status = params.pointer("/response/status")?.as_u64()? as u32;
    let mime_type = params
        .pointer("/response/mimeType")
        .and_then(Value::as_str)
        .map(str::to_string);
    let resource_type = params
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((request_id, status, mime_type, resource_type))
}

/// `Page.captureScreenshot` → PNG 字节。>2MiB 报错（提示缩小窗口/降缩放）。
pub(crate) async fn screenshot_png(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    const MAX_PNG_BYTES: usize = 2 * 1024 * 1024;
    let result = call_cdp(
        webview,
        "Page.captureScreenshot",
        serde_json::json!({ "format": "png", "captureBeyondViewport": false }),
        CAPTURE_TIMEOUT,
    )
    .await?;
    let data = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "截图结果缺少 data".to_string())?;
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| format!("截图 base64 解码失败: {error}"))?;
    if bytes.len() > MAX_PNG_BYTES {
        return Err(format!(
            "截图超过 {MAX_PNG_BYTES} 字节上限（当前 {} 字节）。请缩小窗口或降低浏览器缩放后重试。",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// `Page.captureSnapshot(format:'mhtml')` → MHTML 文本。
pub(crate) async fn capture_mhtml(webview: &tauri::Webview) -> Result<String, String> {
    const MAX_MHTML_BYTES: usize = 8 * 1024 * 1024;
    let result = call_cdp(
        webview,
        "Page.captureSnapshot",
        serde_json::json!({ "format": "mhtml" }),
        CAPTURE_TIMEOUT,
    )
    .await?;
    let data = result
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "MHTML 结果缺少 data".to_string())?;
    if data.len() > MAX_MHTML_BYTES {
        return Err(format!("MHTML 超过 {MAX_MHTML_BYTES} 字节上限"));
    }
    Ok(data.to_string())
}

/// `Network.getResponseBody`：文本类响应体预览（≤64KiB）。base64 负载解码后
/// 须为合法 UTF-8；二进制/超限返回 `Ok(None)`（信封层报 body_unavailable）。
pub(crate) async fn response_body(
    webview: &tauri::Webview,
    request_id: &str,
) -> Result<Option<String>, String> {
    let result = call_cdp(
        webview,
        "Network.getResponseBody",
        serde_json::json!({ "requestId": request_id }),
        CALL_TIMEOUT,
    )
    .await?;
    let body = result
        .get("body")
        .and_then(Value::as_str)
        .ok_or_else(|| "getResponseBody 缺少 body".to_string())?;
    let is_base64 = result
        .get("base64Encoded")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if is_base64 {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(body)
            .map_err(|error| format!("响应体 base64 解码失败: {error}"))?;
        if bytes.len() > MAX_BODY_PREVIEW_BYTES {
            return Ok(None);
        }
        return Ok(String::from_utf8(bytes).ok());
    }
    if body.len() > MAX_BODY_PREVIEW_BYTES {
        return Ok(None);
    }
    Ok(Some(body.to_string()))
}

/// 可信点击：mouseMoved → mousePressed → mouseReleased（viewport 坐标，CSS px）。
pub(crate) async fn trusted_click(webview: &tauri::Webview, x: f64, y: f64) -> Result<(), String> {
    for phase in ["mouseMoved", "mousePressed", "mouseReleased"] {
        let params = serde_json::json!({
            "type": phase,
            "x": x,
            "y": y,
            "button": if phase == "mouseMoved" { Value::Null } else { serde_json::json!("left") },
            "clickCount": if phase == "mouseMoved" { 0 } else { 1 },
            "pointerType": "mouse",
        });
        call_cdp(webview, "Input.dispatchMouseEvent", params, CALL_TIMEOUT).await?;
    }
    Ok(())
}

/// 可信文本注入：`Input.insertText`（composition 路径，等价输入法上屏）。
pub(crate) async fn trusted_insert_text(
    webview: &tauri::Webview,
    text: &str,
) -> Result<(), String> {
    call_cdp(
        webview,
        "Input.insertText",
        serde_json::json!({ "text": text }),
        CALL_TIMEOUT,
    )
    .await?;
    Ok(())
}

#[derive(Debug, Clone)]
pub(crate) struct CdpKey {
    pub(crate) key: String,
    pub(crate) code: String,
    pub(crate) windows_virtual_key_code: u32,
    pub(crate) text: Option<String>,
}

/// 常用命名键的 CDP 映射；单字符可打印键在 [`key_to_cdp`] 兜底。
pub(crate) fn named_key(name: &str) -> Option<CdpKey> {
    let mapped = match name {
        "Enter" => (13, "\r"),
        "Tab" => (9, "\t"),
        "Backspace" => (8, ""),
        "Delete" => (46, ""),
        "Escape" => (27, ""),
        "ArrowUp" => (38, ""),
        "ArrowDown" => (40, ""),
        "ArrowLeft" => (37, ""),
        "ArrowRight" => (39, ""),
        "Home" => (36, ""),
        "End" => (35, ""),
        "PageUp" => (33, ""),
        "PageDown" => (34, ""),
        _ => return None,
    };
    Some(CdpKey {
        key: name.to_string(),
        code: name.to_string(),
        windows_virtual_key_code: mapped.0,
        text: (!mapped.1.is_empty()).then(|| mapped.1.to_string()),
    })
}

/// 单个可打印字符 → CDP 键参数（虚拟键码按大写 ASCII 计算）。
pub(crate) fn printable_key(name: &str) -> Option<CdpKey> {
    let mut chars = name.chars();
    let (single, rest) = (chars.next()?, chars.next());
    if rest.is_some() {
        return None;
    }
    let upper = single.to_ascii_uppercase();
    if !upper.is_ascii_graphic() && !upper.is_ascii_whitespace() {
        return None;
    }
    Some(CdpKey {
        key: name.to_string(),
        code: format!("Key{upper}"),
        windows_virtual_key_code: u32::from(upper),
        text: (!upper.is_ascii_whitespace()).then(|| single.to_string()),
    })
}

pub(crate) fn key_to_cdp(name: &str) -> Result<CdpKey, String> {
    named_key(name)
        .or_else(|| printable_key(name))
        .ok_or_else(|| format!("不支持的按键名：{name}（受支持的命名键与单个 ASCII 字符）"))
}

/// 可信按键：rawKeyDown →（有 text 时）keyChar → keyUp。
pub(crate) async fn trusted_press(webview: &tauri::Webview, mapped: CdpKey) -> Result<(), String> {
    let down = serde_json::json!({
        "type": "rawKeyDown",
        "key": mapped.key,
        "code": mapped.code,
        "windowsVirtualKeyCode": mapped.windows_virtual_key_code,
        "nativeVirtualKeyCode": mapped.windows_virtual_key_code,
    });
    call_cdp(webview, "Input.dispatchKeyEvent", down, CALL_TIMEOUT).await?;
    if let Some(text) = &mapped.text {
        let character = serde_json::json!({
            "type": "keyChar",
            "key": mapped.key,
            "code": mapped.code,
            "windowsVirtualKeyCode": mapped.windows_virtual_key_code,
            "text": text,
        });
        call_cdp(webview, "Input.dispatchKeyEvent", character, CALL_TIMEOUT).await?;
    }
    let up = serde_json::json!({
        "type": "keyUp",
        "key": mapped.key,
        "code": mapped.code,
        "windowsVirtualKeyCode": mapped.windows_virtual_key_code,
        "nativeVirtualKeyCode": mapped.windows_virtual_key_code,
    });
    call_cdp(webview, "Input.dispatchKeyEvent", up, CALL_TIMEOUT).await?;
    Ok(())
}

/// 可信滚轮。
pub(crate) async fn trusted_scroll(
    webview: &tauri::Webview,
    x: f64,
    y: f64,
    delta_x: f64,
    delta_y: f64,
) -> Result<(), String> {
    call_cdp(
        webview,
        "Input.dispatchMouseEvent",
        serde_json::json!({
            "type": "mouseWheel",
            "x": x,
            "y": y,
            "deltaX": delta_x,
            "deltaY": delta_y,
            "pointerType": "mouse",
        }),
        CALL_TIMEOUT,
    )
    .await?;
    Ok(())
}

/// 设备仿真（viewport/UA）。`clear` 恢复默认。
pub(crate) async fn emulate(
    webview: &tauri::Webview,
    width: Option<u32>,
    height: Option<u32>,
    user_agent: Option<&str>,
) -> Result<(), String> {
    match (width, height) {
        (Some(width), Some(height)) => {
            call_cdp(
                webview,
                "Emulation.setDeviceMetricsOverride",
                serde_json::json!({
                    "width": width,
                    "height": height,
                    "deviceScaleFactor": 0,
                    "mobile": false,
                }),
                CALL_TIMEOUT,
            )
            .await?;
        }
        (None, None) => {
            call_cdp(
                webview,
                "Emulation.clearDeviceMetricsOverride",
                serde_json::json!({}),
                CALL_TIMEOUT,
            )
            .await?;
        }
        _ => return Err("viewport 需要同时提供 width 与 height，或都不提供".to_string()),
    }
    if let Some(user_agent) = user_agent {
        call_cdp(
            webview,
            "Emulation.setUserAgentOverride",
            serde_json::json!({ "userAgent": user_agent }),
            CALL_TIMEOUT,
        )
        .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_mapping_covers_named_and_printable() {
        let enter = key_to_cdp("Enter").unwrap();
        assert_eq!(enter.windows_virtual_key_code, 13);
        assert_eq!(enter.text.as_deref(), Some("\r"));
        let lower = key_to_cdp("a").unwrap();
        assert_eq!(lower.windows_virtual_key_code, 65);
        assert_eq!(lower.text.as_deref(), Some("a"));
        assert_eq!(lower.code, "KeyA");
        let digit = key_to_cdp("5").unwrap();
        assert_eq!(digit.windows_virtual_key_code, 53);
        assert!(key_to_cdp("Ctrl").is_err(), "修饰键组合不支持");
        assert!(key_to_cdp("F12").is_err());
        assert!(key_to_cdp("").is_err());
    }

    #[test]
    fn cdp_state_tracks_attach_and_filter() {
        let mut state = CdpState::new();
        assert!(!state
            .dispatch
            .get(&1)
            .map(|d| d.network_attached)
            .unwrap_or(false));
        state.dispatch_mut(1).network_attached = true;
        state.dispatch_mut(1).fetch_enabled = true;
        state.drop_tab(1);
        assert!(state.dispatch.get(&1).is_none());
    }
}
