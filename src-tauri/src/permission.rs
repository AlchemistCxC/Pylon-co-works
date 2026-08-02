//! B9 权限审批：挂起请求解析/应答/超时（R1 拆分自 lib.rs；行为零变化）。

use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::runtime_log;
use crate::time::Timestamp;
use crate::AppState;

/// 权限请求事件中 prompt 的安全上限（B9.4：事件不含完整 secret 载荷）。
const PERMISSION_PROMPT_MAX_CHARS: usize = 500;
/// 挂起的权限请求超时（B9.2：超时默认拒绝）。
const PERMISSION_REQUEST_TIMEOUT_SECS: u64 = 300;

/// 挂起的权限请求（B9，Peri agent 实证方向：agent 主动 request_permission，客户端应答）。
#[derive(Clone)]
pub(crate) struct PendingPermission {
    pub session_id: String,
    pub tool_call_id: String,
    pub title: String,
    /// raw_input 脱敏摘要（事件安全字段，不含完整载荷）。
    pub prompt: String,
    /// 可用选项 option_id（allow_once/reject_once/...），应答时校验。
    pub options: Vec<String>,
    /// R4：Timestamp（事件 payload 序列化为字符串，契约不变）。
    pub requested_at: Timestamp,
}

/// 解析 agent 的 request_permission 请求参数（B9）：
/// `{ sessionId, toolCall: { toolCallId, title?, rawInput? }, options: [{ optionId, ... }] }`。
/// 解析失败（缺字段/无选项）返回 None——调用方按拒绝处理。
pub(crate) fn parse_permission_request(
    params: Option<&serde_json::Value>,
) -> Option<PendingPermission> {
    let params = params?;
    let session_id = params.get("sessionId")?.as_str()?.to_string();
    let tool_call = params.get("toolCall")?;
    let tool_call_id = tool_call.get("toolCallId")?.as_str()?.to_string();
    let title = tool_call
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let raw_input = tool_call
        .get("rawInput")
        .map(serde_json::Value::to_string)
        .unwrap_or_default();
    let prompt: String = runtime_log::sanitize_message(raw_input)
        .chars()
        .take(PERMISSION_PROMPT_MAX_CHARS)
        .collect();
    let options: Vec<String> = params
        .get("options")?
        .as_array()?
        .iter()
        .filter_map(|option| option.get("optionId").and_then(|v| v.as_str()))
        .map(str::to_string)
        .collect();
    if options.is_empty() {
        return None;
    }
    Some(PendingPermission {
        session_id,
        tool_call_id,
        title,
        prompt,
        options,
        requested_at: Timestamp::now(),
    })
}

/// 构造 request_permission 应答（官方 schema 类型保证 wire 格式）。
pub(crate) fn permission_response(option_id: &str) -> serde_json::Value {
    use agent_client_protocol_schema::v1::{
        RequestPermissionOutcome, RequestPermissionResponse, SelectedPermissionOutcome,
    };
    serde_json::to_value(RequestPermissionResponse::new(
        RequestPermissionOutcome::Selected(SelectedPermissionOutcome::new(option_id.to_string())),
    ))
    .unwrap_or_else(|_| serde_json::json!({"outcome": {"selected": {"optionId": option_id}}}))
}

/// request_permission 应答：Cancelled（session/cancel 时必须应答所有挂起请求）。
pub(crate) fn permission_response_cancelled() -> serde_json::Value {
    use agent_client_protocol_schema::v1::{RequestPermissionOutcome, RequestPermissionResponse};
    serde_json::to_value(RequestPermissionResponse::new(
        RequestPermissionOutcome::Cancelled,
    ))
    .unwrap_or_else(|_| serde_json::json!({"outcome": "cancelled"}))
}

/// 统一权限应答（P1-2 TOCTOU 修复）：acp 锁内复核 pending 再发送。
/// 客户端替换（replace_agent_client）在 acp 锁内清空 pending——若"锁外读 pending
/// → 锁 acp 发送"，替换发生在两者之间时，旧进程的 request_id 会写到新进程。
/// 返回 true = 已应答并移除；false = 请求已不存在（跳过）或发送失败（保留 pending
/// 供重试/超时/客户端替换清理）。
pub(crate) async fn respond_permission(
    runtime: &AgentRuntime,
    request_id: u64,
    response: serde_json::Value,
) -> bool {
    let acp = runtime.acp.lock().await;
    let still_pending = runtime
        .pending_permissions
        .lock()
        .map(|pending| pending.contains_key(&request_id))
        .unwrap_or(false);
    if !still_pending {
        return false;
    }
    if acp.send_response(request_id, response).await.is_err() {
        return false;
    }
    let _ = runtime
        .pending_permissions
        .lock()
        .map(|mut pending| pending.remove(&request_id));
    true
}

/// 应答并移除指定 session 的全部挂起权限请求（Cancelled）——cancel/close 路径调用。
pub(crate) async fn respond_pending_permissions_cancelled(
    runtime: &AgentRuntime,
    session_id: &str,
) {
    let pending: Vec<u64> = runtime
        .pending_permissions
        .lock()
        .map(|pending| {
            pending
                .iter()
                .filter(|(_, p)| p.session_id == session_id)
                .map(|(id, _)| *id)
                .collect()
        })
        .unwrap_or_default();
    for request_id in pending {
        // P1-2：统一走 respond_permission（锁内复核）；发送失败时保留 pending
        // （进程已死则由崩溃处理/客户端替换清理，不向新进程误写）。
        let _ = respond_permission(runtime, request_id, permission_response_cancelled()).await;
    }
}

/// 应答挂起的权限请求（B9.4 契约）：option_id 必须是请求提供的选项之一。
/// 拒绝走同一命令（option_id = "reject_once" 等）。返回 Err = 未找到或选项非法。
pub(crate) async fn resolve_permission(
    runtime: &AgentRuntime,
    request_id: u64,
    option_id: &str,
) -> Result<(), PylonError> {
    let found = {
        let pending = runtime
            .pending_permissions
            .lock()
            .map_err(|e| e.to_string())?;
        pending
            .get(&request_id)
            .map(|permission| (permission.tool_call_id.clone(), permission.options.clone()))
    };
    let Some((tool_call_id, options)) = found else {
        return Err(PylonError::Protocol(format!(
            "permission request not found: {request_id}"
        )));
    };
    if !options.iter().any(|option| option == option_id) {
        return Err(PylonError::Protocol(format!(
            "invalid option {option_id} for request {request_id}"
        )));
    }
    // P1-2：选项校验通过后统一走 respond_permission——acp 锁内复核 pending 仍存在
    // 再发送，客户端替换（替换时清空 pending）发生在读与发之间时不会把旧进程的
    // request_id 写到新进程。发送失败保留 pending（可重试）。
    if !respond_permission(runtime, request_id, permission_response(option_id)).await {
        return Err(PylonError::Protocol(format!(
            "permission request not found: {request_id}"
        )));
    }
    log::info!("权限请求 {request_id} 已应答 {option_id}（{tool_call_id}）");
    Ok(())
}

/// 应答挂起的权限请求（命令入口，跨 runtime 定位）。
#[tauri::command]
pub(crate) async fn approve_tool_call(
    state: tauri::State<'_, AppState>,
    request_id: u64,
    option_id: String,
) -> Result<(), PylonError> {
    for runtime in state.inner().runtimes.all() {
        if resolve_permission(&runtime, request_id, &option_id)
            .await
            .is_ok()
        {
            return Ok(());
        }
    }
    Err(PylonError::Protocol(format!(
        "permission request not found: {request_id}"
    )))
}

/// 设置权限审批模式（B9.3）：bypass/auto 自动批准；edit/default 挂起询问。
#[tauri::command]
pub(crate) async fn set_approval_mode(
    state: tauri::State<'_, AppState>,
    mode: String,
) -> Result<(), PylonError> {
    if !matches!(mode.as_str(), "bypass" | "auto" | "edit" | "default") {
        return Err(PylonError::Protocol(format!(
            "unknown approval mode: {mode}"
        )));
    }
    *state.approval_mode.lock().map_err(|e| e.to_string())? = mode;
    Ok(())
}

/// 挂起的权限请求超时检查（B9.2：超时默认拒绝，不悬挂 pending）。
pub(crate) async fn check_pending_permission_timeouts(state: &AppState) {
    let now = Timestamp::now();
    for runtime in state.runtimes.all() {
        let expired: Vec<(u64, String)> = runtime
            .pending_permissions
            .lock()
            .map(|pending| {
                pending
                    .iter()
                    .filter(|(_, permission)| {
                        now.elapsed_since(permission.requested_at)
                            > PERMISSION_REQUEST_TIMEOUT_SECS * 1000
                    })
                    .map(|(id, permission)| (*id, permission.tool_call_id.clone()))
                    .collect()
            })
            .unwrap_or_default();
        for (request_id, tool_call_id) in expired {
            // P1-2：统一走 respond_permission（acp 锁内复核 pending 再发送，
            // 防客户端替换竞态）；发送失败保留 pending，下轮 watcher 重试或
            // 客户端替换清理。超时日志无条件保留（记录本次判定）。
            let _ =
                respond_permission(&runtime, request_id, permission_response("reject_once")).await;
            log::warn!("权限请求 {request_id} 超时默认拒绝（{tool_call_id}）");
        }
    }
}
