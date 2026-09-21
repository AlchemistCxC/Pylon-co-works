//! Agent 浏览器命令族（issue #82）：策略单点强制 + claim + 审计 + 驱动调度。
//!
//! 所有 `browser_agent_*` 命令返回统一信封 `Value`：
//! `{ok:true, driver?, ...}` / `{ok:false, code, message}`——策略拒绝、claim
//! 冲突、平台不支持都是 200 信封（MCP 工具结果可见结构化错误码），只有
//! 基础设施故障才返回 `Err(PylonError)`。MCP 桥与 pylon_cli 两条通道都经过
//! 本层，策略不存在旁路。

use crate::browser_agent::audit::{
    append_audit, recent_audit, BrowserAuditEntry, AUDIT_MAX_ENTRIES,
};
use crate::browser_agent::claim::{ClaimAcquireError, ClaimUseError};
use crate::browser_agent::driver::js;
use crate::browser_agent::hub::{denial, BrowserAgentHub};
use crate::browser_agent::policy::{
    check_tool_allowed, check_url_allowed, AgentBrowserTool, BrowserAccessMode,
};
use crate::browser_agent::settings::BrowserAgentSettings;
use crate::browser_agent::{cdp, driver};
use crate::error::PylonError;
use crate::session::user_data_service_of;
use crate::AppState;
use serde_json::Value;
use std::sync::Arc;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 缺省会话键：pylon_cli 直连（无 `--session`）时使用。
fn session_key_of(session_key: Option<String>) -> String {
    match session_key {
        Some(key) if !key.trim().is_empty() => key.trim().to_string(),
        _ => "direct".to_string(),
    }
}

async fn audit_outcome(
    state: &AppState,
    session_key: &str,
    tool: &str,
    summary: &str,
    outcome: String,
) {
    let Ok(service) = user_data_service_of(state) else {
        return;
    };
    let entry = BrowserAuditEntry {
        at_ms: now_ms(),
        session_key: session_key.to_string(),
        tool: tool.to_string(),
        summary: summary.to_string(),
        outcome,
    };
    if let Err(error) = append_audit(&service, entry).await {
        tracing::warn!("browser agent 审计写入失败: {error}");
    }
}

/// 工具调用统一收口：审计 + 返回信封。成功/拒绝/错误共用。
async fn finish(
    state: &AppState,
    session_key: &str,
    tool: &str,
    summary: impl AsRef<str>,
    outcome: String,
    payload: Value,
) -> Value {
    let mut summary = summary.as_ref().to_string();
    if let Some(driver) = payload.get("driver").and_then(Value::as_str) {
        if !summary.is_empty() {
            summary.push(' ');
        }
        summary.push_str("driver=");
        summary.push_str(driver);
    }
    audit_outcome(state, session_key, tool, &summary, outcome.clone()).await;
    if outcome == "ok" {
        return payload;
    }
    let mut envelope = denial(
        payload
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("error"),
        payload
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    );
    if let (Some(envelope_obj), Some(payload_obj)) = (envelope.as_object_mut(), payload.as_object())
    {
        for (key, value) in payload_obj {
            if !envelope_obj.contains_key(key) {
                envelope_obj.insert(key.clone(), value.clone());
            }
        }
    }
    envelope
}

fn hub_of(state: &AppState) -> Arc<BrowserAgentHub> {
    state.browser_agent.clone()
}

/// 策略检查：off/readonly 分档矩阵。拒绝时返回 `Err(denial 信封)`。
fn authorize(
    hub: &BrowserAgentHub,
    workspace_id: Option<&str>,
    tool: AgentBrowserTool,
) -> Result<BrowserAccessMode, Value> {
    let mode = hub.resolve_access(workspace_id);
    check_tool_allowed(mode, tool)
        .map(|_| mode)
        .map_err(|d| denial(d.code, d.message))
}

/// 写操作 claim 检查：Free 时自动获取（首次写即持有），被其他会话持有则拒绝。
fn ensure_write_claim(hub: &BrowserAgentHub, session_key: &str) -> Result<(), Value> {
    let now = now_ms();
    let mut claim = hub
        .claim()
        .lock()
        .map_err(|error| denial("internal", error.to_string()))?;
    match claim.ensure_usable(session_key, now) {
        Ok(()) => Ok(()),
        Err(ClaimUseError::HeldBy {
            session_key: holder,
        }) => Err(denial(
            "claim_held",
            format!("浏览器正由会话 {holder} 持有；用户操作会自动抢占。"),
        )),
        Err(ClaimUseError::Lost | ClaimUseError::ClaimRequired) => {
            match claim.acquire(session_key, now) {
                Ok(()) => Ok(()),
                Err(ClaimAcquireError::HeldBy {
                    session_key: holder,
                }) => Err(denial(
                    "claim_held",
                    format!("浏览器正由会话 {holder} 持有；用户操作会自动抢占。"),
                )),
            }
        }
    }
}

/// tab 解析失败 → `browser_not_ready` 信封（浏览器未启动/标签不存在）。
fn resolve_tab(state: &AppState, tab_id: Option<u64>) -> Result<(u64, tauri::Webview), Value> {
    state
        .browser
        .tab_webview(tab_id)
        .map_err(|error| denial("browser_not_ready", error))
}

// ── 设置与状态面（非工具；Sheet Agent 面板与 sessionCreation 消费） ──

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_get_settings(
    state: tauri::State<'_, AppState>,
) -> Result<BrowserAgentSettings, PylonError> {
    Ok(hub_of(state.inner()).settings())
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_set_settings(
    state: tauri::State<'_, AppState>,
    settings: BrowserAgentSettings,
) -> Result<BrowserAgentSettings, PylonError> {
    let hub = hub_of(state.inner());
    let previous_filter = hub.settings().ad_filter_enabled;
    let normalized = hub
        .update_settings(settings)
        .map_err(PylonError::Protocol)?;
    // 广告过滤动态生效（spec 验收 9）：开关变化时对全部标签 enable/disable。
    // 未 attach CDP 的标签在 set_fetch_filter 内部短路，无副作用。
    #[cfg(windows)]
    if normalized.ad_filter_enabled != previous_filter {
        let tabs = state
            .browser
            .snapshot()
            .map(|snapshot| snapshot.tabs)
            .unwrap_or_default();
        for tab in tabs {
            if let Ok((tab_id, webview)) = state.browser.tab_webview(Some(tab.id)) {
                if let Err(error) =
                    cdp::set_fetch_filter(&webview, tab_id, &hub.cdp, normalized.ad_filter_enabled)
                        .await
                {
                    tracing::warn!("浏览器标签 {} 广告过滤切换失败: {error}", tab.id);
                }
            }
        }
    }
    Ok(normalized)
}

/// sessionCreation 注入判定：返回工作区有效档位；off 时前端不产出 mcpServers。
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_resolve_access(
    state: tauri::State<'_, AppState>,
    workspace_id: Option<String>,
) -> Result<Value, PylonError> {
    let hub = hub_of(state.inner());
    let effective = hub.resolve_access(workspace_id.as_deref());
    let settings = hub.settings();
    Ok(serde_json::json!({
        "mode": effective.as_str(),
        "defaultMode": settings.default_mode.as_str(),
        "adFilterEnabled": settings.ad_filter_enabled,
    }))
}

/// 桥进程注入用：当前可执行文件路径（`pylon.exe browser-bridge` 载体）。
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_exe_path() -> Result<Value, PylonError> {
    let path = std::env::current_exe()
        .map_err(|error| PylonError::Protocol(format!("无法解析可执行文件路径: {error}")))?;
    Ok(serde_json::json!({ "path": path.to_string_lossy() }))
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_claim_status(
    state: tauri::State<'_, AppState>,
    workspace_id: Option<String>,
) -> Result<Value, PylonError> {
    let hub = hub_of(state.inner());
    let holder = hub
        .claim()
        .lock()
        .ok()
        .and_then(|claim| claim.holder().map(str::to_string));
    let mode = hub.resolve_access(workspace_id.as_deref());
    Ok(serde_json::json!({
        "mode": mode.as_str(),
        "holder": holder,
    }))
}

/// 用户手动交互抢占（前端在地址栏/标签条/工具按钮上触发）。
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_user_activity(
    state: tauri::State<'_, AppState>,
) -> Result<Value, PylonError> {
    let hub = hub_of(state.inner());
    let previous = hub
        .claim()
        .lock()
        .ok()
        .map(|mut claim| claim.preempt_by_user())
        .unwrap_or(None);
    if let Some(holder) = &previous {
        audit_outcome(
            state.inner(),
            "(user)",
            "user_preempt",
            holder,
            "ok".to_string(),
        )
        .await;
    }
    Ok(serde_json::json!({ "preempted": previous }))
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_recent_ops(
    state: tauri::State<'_, AppState>,
) -> Result<Value, PylonError> {
    let ops = match user_data_service_of(state.inner()) {
        Ok(service) => recent_audit(&service).await.unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    let total = ops.len();
    let tail: Vec<_> = ops
        .into_iter()
        .skip(total.saturating_sub(AUDIT_MAX_ENTRIES))
        .collect();
    Ok(serde_json::json!({ "ops": tail }))
}

// ── 工具：观察类（readonly 默认可用） ──

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_navigate(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    workspace_id: Option<String>,
    tab_id: Option<u64>,
    url: String,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::Navigate;
    let summary = serde_json::to_string(&url).unwrap_or_default();
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let parsed = match url::Url::parse(&url) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "error".into(),
                denial("invalid_url", format!("URL 非法: {error}")),
            )
            .await)
        }
    };
    let blocklist = hub.settings().domain_blocklist;
    if let Err(d) = check_url_allowed(&parsed, &blocklist) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", d.code),
            denial(d.code, d.message),
        )
        .await);
    }
    let result = resolve_tab(state.inner(), tab_id);
    let (tab_id, _) = match result {
        Ok(resolved) => resolved,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    match state.browser.navigate_on(tab_id, &url) {
        Ok(snapshot) => {
            let payload = serde_json::json!({ "ok": true, "tabId": tab_id, "browser": snapshot });
            Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "ok".into(),
                payload,
            )
            .await)
        }
        Err(error) => Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            "error".into(),
            denial("navigate_failed", error),
        )
        .await),
    }
}

/// 结构化页面快照：JS 单轮枚举 + ref 分配（两平台一致）。
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_snapshot(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    tab_id: Option<u64>,
    workspace_id: Option<String>,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::Snapshot;
    let summary = "";
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let (resolved_tab, _) = match resolve_tab(state.inner(), tab_id) {
        Ok(resolved) => resolved,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    let raw = match state
        .browser
        .eval_json_on(Some(resolved_tab), js::ENUMERATE_SCRIPT)
        .await
    {
        Ok(raw) => raw,
        Err(error) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "error".into(),
                denial("snapshot_failed", error),
            )
            .await)
        }
    };
    let (mut elements, targets) = match js::parse_enumeration(&raw) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "error".into(),
                denial("snapshot_failed", error),
            )
            .await)
        }
    };
    let references = hub
        .refs()
        .lock()
        .ok()
        .map(|mut registry| registry.replace_tab(resolved_tab, targets));
    let Some(references) = references else {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            "error".into(),
            denial("internal", "ref 注册表锁不可用"),
        )
        .await);
    };
    for (index, element) in elements.iter_mut().enumerate() {
        element.reference = references.get(index).cloned().unwrap_or_default();
    }
    let payload = serde_json::json!({
        "ok": true,
        "driver": "host",
        "tabId": resolved_tab,
        "url": raw.get("url").cloned().unwrap_or(Value::Null),
        "title": raw.get("title").cloned().unwrap_or(Value::Null),
        "text": raw.get("text").cloned().unwrap_or(Value::Null),
        "scrollX": raw.get("scrollX").cloned().unwrap_or(Value::Null),
        "scrollY": raw.get("scrollY").cloned().unwrap_or(Value::Null),
        "innerWidth": raw.get("innerWidth").cloned().unwrap_or(Value::Null),
        "innerHeight": raw.get("innerHeight").cloned().unwrap_or(Value::Null),
        "elements": elements,
    });
    Ok(finish(
        state.inner(),
        &session_key,
        tool.as_str(),
        summary,
        "ok".into(),
        payload,
    )
    .await)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_tab_list(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    workspace_id: Option<String>,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::TabList;
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    match state.browser.snapshot() {
        Ok(snapshot) => {
            let payload = serde_json::json!({ "ok": true, "browser": snapshot });
            Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                "",
                "ok".into(),
                payload,
            )
            .await)
        }
        Err(error) => Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            "error".into(),
            denial("status_failed", error),
        )
        .await),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_tab_new(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    workspace_id: Option<String>,
    url: Option<String>,
    background: Option<bool>,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::TabNew;
    let summary = url.as_deref().unwrap_or("(blank)");
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let initial_url = url.as_deref().unwrap_or("about:blank");
    let parsed = match url::Url::parse(initial_url) {
        Ok(parsed) => parsed,
        Err(error) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "error".into(),
                denial("invalid_url", format!("URL 非法: {error}")),
            )
            .await)
        }
    };
    let blocklist = hub.settings().domain_blocklist;
    if let Err(d) = check_url_allowed(&parsed, &blocklist) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", d.code),
            denial(d.code, d.message),
        )
        .await);
    }
    let outcome = if background.unwrap_or(false) {
        state.browser.open_tab_background(initial_url)
    } else {
        state.browser.open_tab(initial_url)
    };
    match outcome {
        Ok(snapshot) => {
            let payload = serde_json::json!({ "ok": true, "browser": snapshot });
            Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "ok".into(),
                payload,
            )
            .await)
        }
        Err(error) => Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            "error".into(),
            denial("tab_new_failed", error),
        )
        .await),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_tab_select(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    workspace_id: Option<String>,
    tab_id: u64,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::TabSelect;
    let summary = &tab_id.to_string();
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    match state.browser.select_tab(tab_id) {
        Ok(snapshot) => {
            let payload = serde_json::json!({ "ok": true, "browser": snapshot });
            Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "ok".into(),
                payload,
            )
            .await)
        }
        Err(error) => Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            "error".into(),
            denial("tab_select_failed", error),
        )
        .await),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_tab_close(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    workspace_id: Option<String>,
    tab_id: u64,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::TabClose;
    let summary = &tab_id.to_string();
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    if let Err(denied) = ensure_write_claim(&hub, &session_key) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    match state.browser.close_tab(tab_id) {
        Ok(snapshot) => {
            #[cfg(windows)]
            if let Ok(mut cdp_state) = hub.cdp.lock() {
                cdp_state.drop_tab(tab_id);
            }
            let payload = serde_json::json!({ "ok": true, "browser": snapshot });
            Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "ok".into(),
                payload,
            )
            .await)
        }
        Err(error) => Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            "error".into(),
            denial("tab_close_failed", error),
        )
        .await),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_screenshot(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    tab_id: Option<u64>,
    workspace_id: Option<String>,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::Screenshot;
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let (_, webview) = match resolve_tab(state.inner(), tab_id) {
        Ok(resolved) => resolved,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                "",
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    #[cfg(windows)]
    {
        match cdp::screenshot_png(&webview).await {
            Ok(bytes) => {
                use base64::Engine as _;
                let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let payload = serde_json::json!({
                    "ok": true,
                    "driver": "cdp",
                    "pngBase64": encoded,
                    "byteLength": bytes.len(),
                });
                Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    "",
                    "ok".into(),
                    payload,
                )
                .await)
            }
            Err(error) => Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                "",
                "error".into(),
                denial("screenshot_failed", error),
            )
            .await),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            "denied:unsupported_on_platform".into(),
            denial(
                "unsupported_on_platform",
                "截图仅在 Windows（WebView2 CDP）可用",
            ),
        )
        .await)
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_save_page(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    tab_id: Option<u64>,
    workspace_id: Option<String>,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::SavePage;
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let (_, webview) = match resolve_tab(state.inner(), tab_id) {
        Ok(resolved) => resolved,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                "",
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    #[cfg(windows)]
    {
        let mhtml = match cdp::capture_mhtml(&webview).await {
            Ok(mhtml) => mhtml,
            Err(error) => {
                return Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    "",
                    "error".into(),
                    denial("save_page_failed", error),
                )
                .await)
            }
        };
        let save_result = state
            .inner()
            .data_dirs_cloned()
            .map_err(PylonError::Protocol)
            .and_then(|dirs| {
                let dir = dirs.data_root.join("agent-pages");
                std::fs::create_dir_all(&dir)
                    .map_err(|error| PylonError::Protocol(format!("创建存档目录失败: {error}")))?;
                let path = dir.join(format!(
                    "pylon-page-{}.mhtml",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0)
                ));
                std::fs::write(&path, mhtml.as_bytes())
                    .map_err(|error| PylonError::Protocol(format!("写 MHTML 失败: {error}")))?;
                Ok(path)
            });
        match save_result {
            Ok(path) => {
                let payload = serde_json::json!({ "ok": true, "driver": "cdp", "path": path.to_string_lossy(), "byteLength": mhtml.len() });
                Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    "",
                    "ok".into(),
                    payload,
                )
                .await)
            }
            Err(error) => Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                "",
                "error".into(),
                denial("save_page_failed", error.to_string()),
            )
            .await),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = webview;
        Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            "denied:unsupported_on_platform".into(),
            denial(
                "unsupported_on_platform",
                "MHTML 存档仅在 Windows（WebView2 CDP）可用",
            ),
        )
        .await)
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_read_network(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    tab_id: Option<u64>,
    limit: Option<usize>,
    request_id: Option<String>,
    workspace_id: Option<String>,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::ReadNetwork;
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let (resolved_tab, webview) = match resolve_tab(state.inner(), tab_id) {
        Ok(resolved) => resolved,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                "",
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    #[cfg(windows)]
    {
        let ad_filter = hub.settings().ad_filter_enabled;
        if let Err(error) =
            cdp::ensure_network_attached(&webview, resolved_tab, &hub.cdp, ad_filter)
        {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                "",
                "error".into(),
                denial("cdp_failed", error),
            )
            .await);
        }
        // 响应体预览：单个 requestId 的文本负载（≤64KiB，超限截断并标注）。
        if let Some(request_id) = request_id {
            let body = cdp::response_body(&webview, &request_id).await;
            return match body {
                Ok(Some((preview, truncated))) => {
                    let payload = serde_json::json!({
                        "ok": true,
                        "driver": "cdp",
                        "requestId": request_id,
                        "body": preview,
                        "truncated": truncated,
                    });
                    Ok(finish(
                        state.inner(),
                        &session_key,
                        tool.as_str(),
                        "",
                        "ok".into(),
                        payload,
                    )
                    .await)
                }
                Ok(None) => Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    "",
                    "error".into(),
                    denial("body_unavailable", "响应体缺失、二进制或超过 64KiB"),
                )
                .await),
                Err(error) => Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    "",
                    "error".into(),
                    denial("cdp_failed", error),
                )
                .await),
            };
        }
        let limit = limit.unwrap_or(50).min(200);
        let entries: Vec<Value> = {
            let cdp_state = hub
                .cdp
                .lock()
                .map_err(|error| PylonError::Protocol(error.to_string()))?;
            let network = cdp_state.network.clone();
            let map = network
                .lock()
                .map_err(|error| PylonError::Protocol(error.to_string()))?;
            match map.get(&resolved_tab) {
                Some(ring) => ring
                    .entries
                    .iter()
                    .rev()
                    .take(limit)
                    .rev()
                    .map(|entry| serde_json::to_value(entry).unwrap_or(Value::Null))
                    .collect(),
                None => Vec::new(),
            }
        };
        let inflight = {
            let cdp_state = hub
                .cdp
                .lock()
                .map_err(|error| PylonError::Protocol(error.to_string()))?;
            let network = cdp_state.network.clone();
            let map = network
                .lock()
                .map_err(|error| PylonError::Protocol(error.to_string()))?;
            map.get(&resolved_tab)
                .map(|ring| ring.inflight)
                .unwrap_or(0)
        };
        let payload = serde_json::json!({ "ok": true, "driver": "cdp", "tabId": resolved_tab, "inflight": inflight, "entries": entries });
        Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            "ok".into(),
            payload,
        )
        .await)
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, limit, request_id, resolved_tab);
        Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            "denied:unsupported_on_platform".into(),
            denial(
                "unsupported_on_platform",
                "网络观测仅在 Windows（WebView2 CDP）可用",
            ),
        )
        .await)
    }
}

/// browser.agent-wait 的条件轮询间隔。250ms 是「页面状态变化的可感知延迟」
/// 与「轮询本身对 WebView 的打扰（每次一轮 eval/状态读取）」之间的折中；
/// 上层预算由调用方的 timeout_ms（默认 8s、封顶 30s）控制。
/// 后续方向：改为 CDP 事件订阅（Page.loadEventFired / DOM 变更 / 网络空闲
/// 推送）消除轮询——涉及 cdp 模块事件管线改造，属独立 issue 面积。
const PAGE_SETTLE_POLL: std::time::Duration = std::time::Duration::from_millis(250);

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_wait(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    tab_id: Option<u64>,
    until: String,
    selector: Option<String>,
    timeout_ms: Option<u64>,
    workspace_id: Option<String>,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::Wait;
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let Some(kind) = driver::WaitUntil::parse(&until) else {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            "error".into(),
            denial(
                "invalid_wait",
                "until 仅支持 load | network_idle | selector",
            ),
        )
        .await);
    };
    let (resolved_tab, webview) = match resolve_tab(state.inner(), tab_id) {
        Ok(resolved) => resolved,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                "",
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(8_000).min(30_000));
    let deadline = tokio::time::Instant::now() + timeout;
    match kind {
        driver::WaitUntil::Load => loop {
            let ready = state
                .browser
                .eval_json_on(Some(resolved_tab), js::READY_STATE_SCRIPT)
                .await
                .ok()
                .and_then(|value| {
                    value
                        .get("readyState")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            if ready.as_deref() == Some("complete") {
                return Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    "",
                    "ok".into(),
                    serde_json::json!({ "ok": true, "until": "load" }),
                )
                .await);
            }
            if tokio::time::Instant::now() >= deadline {
                return Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    "",
                    "error".into(),
                    denial("wait_timeout", "等待页面加载超时"),
                )
                .await);
            }
            tokio::time::sleep(PAGE_SETTLE_POLL).await;
        },
        driver::WaitUntil::Selector => {
            let Some(selector) = selector else {
                return Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    "",
                    "error".into(),
                    denial("invalid_wait", "until=selector 需要 selector 参数"),
                )
                .await);
            };
            let script = js::build_selector_present_script(&selector);
            loop {
                let present = state
                    .browser
                    .eval_json_on(Some(resolved_tab), &script)
                    .await
                    .ok()
                    .and_then(|value| value.get("ok").and_then(Value::as_bool))
                    .unwrap_or(false);
                if present {
                    return Ok(finish(state.inner(), &session_key, tool.as_str(), "", "ok".into(), serde_json::json!({ "ok": true, "until": "selector", "selector": selector })).await);
                }
                if tokio::time::Instant::now() >= deadline {
                    return Ok(finish(
                        state.inner(),
                        &session_key,
                        tool.as_str(),
                        "",
                        "error".into(),
                        denial("wait_timeout", format!("等待元素超时：{selector}")),
                    )
                    .await);
                }
                tokio::time::sleep(PAGE_SETTLE_POLL).await;
            }
        }
        driver::WaitUntil::NetworkIdle => {
            #[cfg(windows)]
            {
                let ad_filter = hub.settings().ad_filter_enabled;
                if let Err(error) =
                    cdp::ensure_network_attached(&webview, resolved_tab, &hub.cdp, ad_filter)
                {
                    return Ok(finish(
                        state.inner(),
                        &session_key,
                        tool.as_str(),
                        "",
                        "error".into(),
                        denial("cdp_failed", error),
                    )
                    .await);
                }
                let network = hub.cdp.lock().ok().map(|state| state.network.clone());
                let Some(network) = network else {
                    return Ok(finish(
                        state.inner(),
                        &session_key,
                        tool.as_str(),
                        "",
                        "error".into(),
                        denial("internal", "CDP 状态锁不可用"),
                    )
                    .await);
                };
                loop {
                    let (inflight, idle_ms) = {
                        let map = network
                            .lock()
                            .map_err(|error| PylonError::Protocol(error.to_string()))?;
                        match map.get(&resolved_tab) {
                            Some(ring) => (
                                ring.inflight,
                                now_ms().saturating_sub(ring.last_activity_ms),
                            ),
                            None => (0, u64::MAX),
                        }
                    };
                    if inflight == 0 && idle_ms >= 500 {
                        return Ok(finish(
                            state.inner(),
                            &session_key,
                            tool.as_str(),
                            "",
                            "ok".into(),
                            serde_json::json!({ "ok": true, "until": "network_idle" }),
                        )
                        .await);
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return Ok(finish(
                            state.inner(),
                            &session_key,
                            tool.as_str(),
                            "",
                            "error".into(),
                            denial(
                                "wait_timeout",
                                format!("等待网络静默超时（在飞请求 {inflight}）"),
                            ),
                        )
                        .await);
                    }
                    tokio::time::sleep(PAGE_SETTLE_POLL).await;
                }
            }
            #[cfg(not(windows))]
            {
                let _ = (webview, resolved_tab, deadline);
                Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    "",
                    "denied:unsupported_on_platform".into(),
                    denial(
                        "unsupported_on_platform",
                        "network_idle 等待仅在 Windows（WebView2 CDP）可用",
                    ),
                )
                .await)
            }
        }
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_scroll(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    tab_id: Option<u64>,
    delta_x: Option<i32>,
    delta_y: Option<i32>,
    workspace_id: Option<String>,
) -> Result<Value, PylonError> {
    scroll_impl(
        state,
        session_key,
        workspace_id,
        tab_id,
        delta_x.unwrap_or(0),
        delta_y.unwrap_or(600),
    )
    .await
}

/// tauri command 签名即 invoke 参数面（参数名 = wire 字段），不可收敛入参。
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_emulate(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    tab_id: Option<u64>,
    width: Option<u32>,
    height: Option<u32>,
    user_agent: Option<String>,
    clear: Option<bool>,
    workspace_id: Option<String>,
) -> Result<Value, PylonError> {
    emulate_impl(
        state,
        session_key,
        workspace_id,
        tab_id,
        width,
        height,
        user_agent.as_deref(),
        clear.unwrap_or(false),
    )
    .await
}

// ── 工具：写操作（full 档 + claim） ──

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_click(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    workspace_id: Option<String>,
    tab_id: Option<u64>,
    reference: Option<String>,
    selector: Option<String>,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::Click;
    let summary = reference
        .as_deref()
        .or(selector.as_deref())
        .unwrap_or("")
        .to_string();
    let mode = match authorize(&hub, workspace_id.as_deref(), tool) {
        Ok(mode) => mode,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    if let Err(denied) = ensure_write_claim(&hub, &session_key) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let (resolved_tab, webview) = match resolve_tab(state.inner(), tab_id) {
        Ok(resolved) => resolved,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    let (selector, expected) = match resolve_click_target(&hub, resolved_tab, reference, selector) {
        Ok(target) => target,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    // 高亮 + 重查（滚动入视口 + 指纹复核 + 最新中心点）。
    let _ = state
        .browser
        .eval_json_on(Some(resolved_tab), &js::build_highlight_script(&selector))
        .await;
    let verify_raw = match state
        .browser
        .eval_json_on(
            Some(resolved_tab),
            &js::build_verify_script(&selector, &expected),
        )
        .await
    {
        Ok(raw) => raw,
        Err(error) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "error".into(),
                denial("click_failed", error),
            )
            .await)
        }
    };
    let verified = match js::parse_verify(&verify_raw) {
        Ok(verified) => verified,
        Err(code) if code == "stale_ref" => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "denied:stale_ref".into(),
                denial(
                    "stale_ref",
                    "元素已变化（stale_ref）；请重新 browser_snapshot",
                ),
            )
            .await)
        }
        Err(code) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "error".into(),
                denial(&code, "元素定位失败"),
            )
            .await)
        }
    };
    // 打开新标签的锚点直接走内部标签路径（与用户点击同语义）。
    if verified.get("opensTab").and_then(Value::as_bool) == Some(true) {
        if let Some(href) = verified.get("href").and_then(Value::as_str) {
            return match state.browser.open_tab(href) {
                Ok(snapshot) => {
                    let payload = serde_json::json!({ "ok": true, "driver": "host", "openedTab": true, "href": href, "browser": snapshot });
                    Ok(finish(
                        state.inner(),
                        &session_key,
                        tool.as_str(),
                        summary,
                        "ok".into(),
                        payload,
                    )
                    .await)
                }
                Err(error) => Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    summary,
                    "error".into(),
                    denial("click_failed", error),
                )
                .await),
            };
        }
    }
    let x = verified.get("x").and_then(Value::as_f64).unwrap_or(0.0);
    let y = verified.get("y").and_then(Value::as_f64).unwrap_or(0.0);
    // CDP 可信点击优先；失败降级合成点击。
    #[cfg(windows)]
    {
        if mode == BrowserAccessMode::Full && cdp::trusted_click(&webview, x, y).await.is_ok() {
            let payload = serde_json::json!({ "ok": true, "driver": "cdp", "x": x, "y": y, "detail": verified });
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "ok".into(),
                payload,
            )
            .await);
        }
    }
    let _ = mode;
    match state.browser.click(Some(selector.clone()), None).await {
        Ok(_) => {
            let payload = serde_json::json!({ "ok": true, "driver": "js", "detail": verified });
            Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "ok".into(),
                payload,
            )
            .await)
        }
        Err(error) => Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            "error".into(),
            denial("click_failed", error),
        )
        .await),
    }
}

/// tauri command 签名即 invoke 参数面（参数名 = wire 字段），不可收敛入参。
#[allow(clippy::too_many_arguments)]
#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_type(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    workspace_id: Option<String>,
    tab_id: Option<u64>,
    reference: Option<String>,
    selector: Option<String>,
    text: String,
    submit: Option<bool>,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::Type;
    let summary = reference
        .as_deref()
        .or(selector.as_deref())
        .unwrap_or("")
        .to_string();
    let mode = match authorize(&hub, workspace_id.as_deref(), tool) {
        Ok(mode) => mode,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    if let Err(denied) = ensure_write_claim(&hub, &session_key) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let (resolved_tab, webview) = match resolve_tab(state.inner(), tab_id) {
        Ok(resolved) => resolved,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    let (selector, expected) = match resolve_click_target(&hub, resolved_tab, reference, selector) {
        Ok(target) => target,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    let verify_raw = match state
        .browser
        .eval_json_on(
            Some(resolved_tab),
            &js::build_verify_script(&selector, &expected),
        )
        .await
    {
        Ok(raw) => raw,
        Err(error) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "error".into(),
                denial("type_failed", error),
            )
            .await)
        }
    };
    if js::parse_verify(&verify_raw).err().as_deref() == Some("stale_ref") {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            "denied:stale_ref".into(),
            denial(
                "stale_ref",
                "元素已变化（stale_ref）；请重新 browser_snapshot",
            ),
        )
        .await);
    }
    #[cfg(windows)]
    {
        if mode == BrowserAccessMode::Full {
            let x = verify_raw.get("x").and_then(Value::as_f64).unwrap_or(0.0);
            let y = verify_raw.get("y").and_then(Value::as_f64).unwrap_or(0.0);
            let typed = async {
                cdp::trusted_click(&webview, x, y).await?;
                cdp::trusted_insert_text(&webview, &text).await
            };
            if typed.await.is_ok() {
                if submit.unwrap_or(false) {
                    let enter = cdp::key_to_cdp("Enter").map_err(PylonError::Protocol)?;
                    if let Err(error) = cdp::trusted_press(&webview, enter).await {
                        return Ok(finish(
                            state.inner(),
                            &session_key,
                            tool.as_str(),
                            summary,
                            "error".into(),
                            denial("type_failed", error),
                        )
                        .await);
                    }
                }
                let payload =
                    serde_json::json!({ "ok": true, "driver": "cdp", "selector": selector });
                return Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    summary,
                    "ok".into(),
                    payload,
                )
                .await);
            }
        }
    }
    let _ = mode;
    // JS 兜底：setter + input/change 事件。
    if let Err(error) = state.browser.type_text(text, Some(selector.clone())).await {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            "error".into(),
            denial("type_failed", error),
        )
        .await);
    }
    if submit.unwrap_or(false) {
        if let Err(error) = state.browser.press("Enter".to_string()).await {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "error".into(),
                denial("type_failed", error),
            )
            .await);
        }
    }
    let payload = serde_json::json!({ "ok": true, "driver": "js", "selector": selector });
    Ok(finish(
        state.inner(),
        &session_key,
        tool.as_str(),
        summary,
        "ok".into(),
        payload,
    )
    .await)
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_press(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    workspace_id: Option<String>,
    tab_id: Option<u64>,
    key: String,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let summary = key.clone();
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::Press;
    let mode = match authorize(&hub, workspace_id.as_deref(), tool) {
        Ok(mode) => mode,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                &summary,
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    if let Err(denied) = ensure_write_claim(&hub, &session_key) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            &summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let (resolved_tab, webview) = match resolve_tab(state.inner(), tab_id) {
        Ok(resolved) => resolved,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                &summary,
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    let _ = resolved_tab;
    #[cfg(windows)]
    {
        if mode == BrowserAccessMode::Full {
            match cdp::key_to_cdp(&key) {
                Ok(mapped) => {
                    if cdp::trusted_press(&webview, mapped).await.is_ok() {
                        let payload =
                            serde_json::json!({ "ok": true, "driver": "cdp", "key": key });
                        return Ok(finish(
                            state.inner(),
                            &session_key,
                            tool.as_str(),
                            &summary,
                            "ok".into(),
                            payload,
                        )
                        .await);
                    }
                }
                Err(_) => {
                    return Ok(finish(
                        state.inner(),
                        &session_key,
                        tool.as_str(),
                        &summary,
                        "error".into(),
                        denial("unsupported_key", format!("CDP 路径不支持按键：{key}")),
                    )
                    .await)
                }
            }
        }
    }
    let _ = mode;
    match state.browser.press(key).await {
        Ok(_) => {
            let payload = serde_json::json!({ "ok": true, "driver": "js" });
            Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                &summary,
                "ok".into(),
                payload,
            )
            .await)
        }
        Err(error) => Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            &summary,
            "error".into(),
            denial("press_failed", error),
        )
        .await),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub(crate) async fn browser_agent_download(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    workspace_id: Option<String>,
    tab_id: Option<u64>,
    url: String,
    filename: Option<String>,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::Download;
    let summary = serde_json::to_string(&url).unwrap_or_default();
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    if let Err(denied) = ensure_write_claim(&hub, &session_key) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    if let Err(denied) = resolve_tab(state.inner(), tab_id) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    match state.browser.download(&url, filename).await {
        Ok(result) => {
            let payload = serde_json::json!({ "ok": true, "download": result });
            Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                summary,
                "ok".into(),
                payload,
            )
            .await)
        }
        Err(error) => Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            summary,
            "error".into(),
            denial("download_failed", error),
        )
        .await),
    }
}

// ── 内部共享 ──

/// 点击/输入目标解析：ref 优先（查注册表），selector 兜底。
/// ref 无法解析 → `stale_ref`。
fn resolve_click_target(
    hub: &BrowserAgentHub,
    tab_id: u64,
    reference: Option<String>,
    selector: Option<String>,
) -> Result<(String, String), Value> {
    if let Some(reference) = reference
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let target = hub
            .refs()
            .lock()
            .ok()
            .and_then(|registry| registry.resolve(tab_id, reference).cloned());
        return match target {
            Some(crate::browser_agent::refs::RefTarget::Js { selector, name, .. }) => {
                Ok((selector, name))
            }
            Some(crate::browser_agent::refs::RefTarget::Cdp { .. }) => Err(denial(
                "stale_ref",
                "ref 注册表不含选择器（CDP 型）；请重新 browser_snapshot",
            )),
            None => Err(denial(
                "stale_ref",
                format!("ref {reference} 不在当前快照中；请重新 browser_snapshot"),
            )),
        };
    }
    let selector = selector
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| denial("missing_target", "reference 或 selector 至少提供一个"))?;
    Ok((selector.to_string(), String::new()))
}

async fn scroll_impl(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    workspace_id: Option<String>,
    tab_id: Option<u64>,
    delta_x: i32,
    delta_y: i32,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::Scroll;
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let (resolved_tab, webview) = match resolve_tab(state.inner(), tab_id) {
        Ok(resolved) => resolved,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                "",
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    #[cfg(windows)]
    {
        let viewport = state
            .browser
            .eval_json_on(
                Some(resolved_tab),
                r#"(() => JSON.stringify({ w: innerWidth, h: innerHeight }))()"#,
            )
            .await
            .ok();
        let width = viewport
            .as_ref()
            .and_then(|value| value.get("w"))
            .and_then(Value::as_f64)
            .unwrap_or(800.0);
        let height = viewport
            .as_ref()
            .and_then(|value| value.get("h"))
            .and_then(Value::as_f64)
            .unwrap_or(600.0);
        if cdp::trusted_scroll(
            &webview,
            width / 2.0,
            height / 2.0,
            f64::from(delta_x),
            f64::from(delta_y),
        )
        .await
        .is_ok()
        {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                "",
                "ok".into(),
                serde_json::json!({ "ok": true, "driver": "cdp", "deltaX": delta_x, "deltaY": delta_y }),
            )
            .await);
        }
    }
    #[cfg(not(windows))]
    let _ = webview;
    match state.browser.scroll(delta_x, delta_y).await {
        Ok(result) => Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            "ok".into(),
            serde_json::json!({ "ok": true, "driver": "js", "scroll": result }),
        )
        .await),
        Err(error) => Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            "error".into(),
            denial("scroll_failed", error),
        )
        .await),
    }
}

/// 与 browser_agent_emulate 命令的 invoke 参数面逐参对应（命令层透传），保持显式签名。
#[allow(clippy::too_many_arguments)]
async fn emulate_impl(
    state: tauri::State<'_, AppState>,
    session_key: Option<String>,
    workspace_id: Option<String>,
    tab_id: Option<u64>,
    width: Option<u32>,
    height: Option<u32>,
    user_agent: Option<&str>,
    clear: bool,
) -> Result<Value, PylonError> {
    let session_key = session_key_of(session_key);
    let hub = hub_of(state.inner());
    let tool = AgentBrowserTool::Emulate;
    if let Err(denied) = authorize(&hub, workspace_id.as_deref(), tool) {
        return Ok(finish(
            state.inner(),
            &session_key,
            tool.as_str(),
            "",
            format!("denied:{}", denied["code"]),
            denied,
        )
        .await);
    }
    let (_, webview) = match resolve_tab(state.inner(), tab_id) {
        Ok(resolved) => resolved,
        Err(denied) => {
            return Ok(finish(
                state.inner(),
                &session_key,
                tool.as_str(),
                "",
                format!("denied:{}", denied["code"]),
                denied,
            )
            .await)
        }
    };
    #[cfg(windows)]
    {
        let effective = if clear { (None, None) } else { (width, height) };
        match cdp::emulate(&webview, effective.0, effective.1, user_agent).await {
            Ok(()) => {
                return Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    "",
                    "ok".into(),
                    serde_json::json!({ "ok": true, "driver": "cdp" }),
                )
                .await);
            }
            Err(error) => {
                return Ok(finish(
                    state.inner(),
                    &session_key,
                    tool.as_str(),
                    "",
                    "error".into(),
                    denial("emulate_failed", error),
                )
                .await);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, width, height, user_agent, clear);
        Ok(denial(
            "unsupported_on_platform",
            "设备仿真仅在 Windows（WebView2 CDP）可用",
        ))
    }
}
