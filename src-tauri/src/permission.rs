//! B9 权限审批：挂起请求解析/应答/超时（R1 拆分自 lib.rs；行为零变化）。
//! ACP-01：挂起键从 `u64` 升级为 [`RequestId`]（number/string 原始形态），
//! 响应 id 用原始 variant 回写。
//! ACP-02：options 从 `Vec<String>` 升级为 [`PermissionOption`]（typed wire），
//! kind/name 宽容保留、optionId 原值不正规化（§5.5）。

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::acp::RequestId;
use crate::dispatcher::resolve_agent_provider;
use crate::error::PylonError;
use crate::runtime::AgentRuntime;
use crate::runtime_log;
use crate::time::Timestamp;
use crate::AppState;

/// 权限请求事件中 prompt 的安全上限（B9.4：事件不含完整 secret 载荷）。
const PERMISSION_PROMPT_MAX_CHARS: usize = 500;
/// 挂起的权限请求超时（B9.2：超时默认拒绝）。
const PERMISSION_REQUEST_TIMEOUT_SECS: u64 = 300;

/// ACP-02（§5.5）：wire option 项的后端保留形态。
///
/// `option_id` 是唯一协议值（response 必须回写原值，禁止正规化/小写化）；
/// `kind`/`name` 仅供 UI 分类与展示，不参与应答；`raw` 保留原文供前端宽容读取。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionOption {
    pub option_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
}

impl PermissionOption {
    /// 仅携带 optionId 的选项（测试与精简构造）。
    #[allow(dead_code)] // 测试便捷构造器（permission/protocol_adapter 测试使用）
    pub(crate) fn plain(option_id: impl Into<String>) -> Self {
        Self {
            option_id: option_id.into(),
            kind: None,
            name: None,
            raw: None,
        }
    }
}

/// 挂起的权限请求（B9，Peri agent 实证方向：agent 主动 request_permission，客户端应答）。
#[derive(Clone)]
pub(crate) struct PendingPermission {
    pub session_id: String,
    pub tool_call_id: String,
    pub title: String,
    /// raw_input 脱敏摘要（事件安全字段，不含完整载荷）。
    pub prompt: String,
    /// 可用选项 option_id（allow_once/reject_once/...），应答时校验。
    pub options: Vec<PermissionOption>,
    /// C4：应答身份复核——解析时记录的 client_generation。客户端替换
    /// （generation 前进）后，旧进程的应答决策不得误写新进程同 id 请求。
    pub client_generation: u64,
    /// R4：Timestamp（事件 payload 序列化为字符串，契约不变）。
    pub requested_at: Timestamp,
}

/// 解析 agent 的 request_permission 请求参数（B9）：
/// `{ sessionId, toolCall: { toolCallId, title?, rawInput? }, options: [{ optionId, ... }] }`。
/// 解析失败（缺字段/无选项）返回 None——调用方按 protocol error 处理（ACP-04
/// §5.6：JSON-RPC error 应答，不伪造 optionId）。
/// 兼容入口（仅 lib.rs 测试调用，无 runtime 上下文）：client_generation 置 0——
/// 生产路径（dispatcher）必须走 [`parse_permission_request_with_generation`]。
#[cfg(test)]
pub(crate) fn parse_permission_request(
    params: Option<&serde_json::Value>,
) -> Option<PendingPermission> {
    parse_permission_request_with_generation(params, 0)
}

/// C4：带 client_generation 的解析入口——记录请求到达时的身份 generation，
/// 应答时复核（见 [`respond_permission`]）。
pub(crate) fn parse_permission_request_with_generation(
    params: Option<&serde_json::Value>,
    client_generation: u64,
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
    // ACP-02（§5.5）：typed options——optionId 原值保留（禁止正规化），
    // kind/name 宽容保留（未知 kind 不丢弃，交前端显示），raw 原样透传。
    let options: Vec<PermissionOption> = params
        .get("options")?
        .as_array()?
        .iter()
        .filter_map(|option| {
            let option_id = option.get("optionId")?.as_str()?.to_string();
            Some(PermissionOption {
                option_id,
                kind: option
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                name: option
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                raw: option.get("raw").cloned(),
            })
        })
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
        client_generation,
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

/// C5：按请求提供选项选择应答 option_id（协议合规）——自动批准/超时默认拒绝不再
/// 硬编码 allow_once/reject_once，而是优先命中语义选项，否则取首个可用项。
/// 语义匹配（忽略大小写）作用于 option_id 与 kind（Hermes 兼容：kind=reject_once
/// 是语义类别）；**返回值永远是 option_id 原值**——kind 只参与选择不参与应答。
/// 语义优先级：
/// - prefer_reject（超时默认拒绝）：`reject_once` → 前缀 `reject` → 首个
/// - prefer_reject=false（自动批准）：`allow_once` → 首个
///
/// 无选项返回 None——调用方（dispatcher auto/bypass 分支与 check_pending_permission_timeouts
/// 超时默认拒绝路径）视为防御异常：跳过应答并告警（ACP-04 §5.6：绝不伪造 optionId，
/// 旧实现 unwrap_or("reject_once") 的伪造路径已移除；解析层保证 pending 恒非空）。
pub(crate) fn pick_option(options: &[PermissionOption], prefer_reject: bool) -> Option<&str> {
    let semantic = |option: &PermissionOption, needle: &str, prefix: bool| {
        std::iter::once(option.option_id.as_str())
            .chain(option.kind.iter().map(String::as_str))
            .any(|value| {
                // 语义归一：去下划线后比较——Hermes kind 用 camelCase（allowOnce/rejectOnce），
                // option_id 用 snake_case（allow_once/reject_once），视为同义。
                let value = value.to_ascii_lowercase().replace('_', "");
                let needle = needle.replace('_', "");
                if prefix {
                    value.starts_with(&needle)
                } else {
                    value == needle
                }
            })
    };
    let chosen = if prefer_reject {
        options
            .iter()
            .find(|option| semantic(option, "reject_once", false))
            .or_else(|| {
                options
                    .iter()
                    .find(|option| semantic(option, "reject", true))
            })
    } else {
        options
            .iter()
            .find(|option| semantic(option, "allow_once", false))
    }
    .or_else(|| options.first());
    // 返回值永远是 option_id 原值（kind 只参与选择不参与应答）。
    chosen.map(|option| option.option_id.as_str())
}

/// 锁外应答发送共享 helper（G3 §2.2.2）：构造 {jsonrpc,id,result} 信封 → 序列化 →
/// 超时发送（方案 2B：超时值与 acp::DEFAULT_WRITE_TIMEOUT_SECS 单一来源）→
/// 超时置 crashed（语义对齐 acp::send_line）。
/// 收敛 dispatcher::send_direct_permission_response 与 resolve_pending 的锁外发送段
/// （三份同形拷贝 → 一份）；调用方（resolve_pending）在返回 false 时恢复 pending。
pub(crate) async fn send_agent_response(
    write_tx: tokio::sync::mpsc::Sender<String>,
    crashed: Arc<std::sync::atomic::AtomicBool>,
    request_id: RequestId,
    result: serde_json::Value,
) -> bool {
    if crashed.load(Ordering::Acquire) {
        return false; // 已崩溃不发送（原两处同语义）
    }
    // ACP-01：untagged 序列化——Number(n) → "id": n、String(s) → "id": "s"，原 variant 回写。
    let line = serde_json::json!({ "jsonrpc": "2.0", "id": request_id, "result": result });
    let Ok(line) = serde_json::to_string(&line) else {
        return false;
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(crate::acp::DEFAULT_WRITE_TIMEOUT_SECS),
        write_tx.send(line),
    )
    .await
    {
        Ok(Ok(())) => true,
        Ok(Err(_)) => false,
        Err(_) => {
            tracing::warn!(
                "ACP write timeout after {}s: connection presumed dead",
                crate::acp::DEFAULT_WRITE_TIMEOUT_SECS
            );
            crashed.store(true, Ordering::Release);
            false
        }
    }
}

/// ACP-04（§5.6）：协议错误应答——解析失败不属于可 approve/reject 的 pending
/// permission，**不伪造 optionId**，按 ACP 标准发 JSON-RPC error 信封（-32602
/// Invalid params），让 agent 按标准错误处理。与 [`send_agent_response`] 同发送
/// 路径（锁外 send_line，10s 超时语义一致）；id 回显原始 variant（number/string）。
pub(crate) async fn send_agent_error(
    write_tx: tokio::sync::mpsc::Sender<String>,
    crashed: Arc<std::sync::atomic::AtomicBool>,
    request_id: RequestId,
    code: i64,
    message: &str,
) -> bool {
    if crashed.load(Ordering::Acquire) {
        return false; // 已崩溃不发送（同 send_agent_response）
    }
    let line = serde_json::json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "error": { "code": code, "message": message },
    });
    let Ok(line) = serde_json::to_string(&line) else {
        return false;
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(crate::acp::DEFAULT_WRITE_TIMEOUT_SECS),
        write_tx.send(line),
    )
    .await
    {
        Ok(Ok(())) => true,
        Ok(Err(_)) => false,
        Err(_) => {
            tracing::warn!(
                "ACP write timeout after {}s: connection presumed dead",
                crate::acp::DEFAULT_WRITE_TIMEOUT_SECS
            );
            crashed.store(true, Ordering::Release);
            false
        }
    }
}

/// R34：四路应答统一核心（由 respond_permission 演进——四路：应答 / cancel /
/// resolve / 超时 全部收敛于此，单一临界区 + 锁外发送）。
///
/// 单临界区（P1-2 TOCTOU 修复）：acp 锁内查条目 + C4 generation 校验 +
/// tool_call_id 校验 + 选项校验 + claim；锁外发送（O9：10s 超时，语义对齐
/// acp::send_line），不再持 acp 锁 await。客户端替换（replace_agent_client）
/// 在 acp 锁内清空 pending——复核与 claim 同锁，替换瞬间旧审批决策不会写到
/// 新进程同 id 请求。
///
/// 参数：
/// - `expected_tool_call_id`：Some 时要求条目 tool_call_id 一致（cancel 路径按
///   收集时的原 id 校验，防同 id 被新工具调用复用后误 cancel）。
/// - `option_id`：空串 = Cancelled 应答（cancel/close 路径，无选项概念）；
///   非空必须 ∈ 条目的 options（C5 选项契约）。
///
/// 返回 true = 已应答并移除；false = 任一校验失败（跳过）或发送失败
/// （恢复 pending 供重试/超时/客户端替换清理）。
/// ACP-01（CR-001 修正）：候选 id → pending 规范键（resolve_pending / protocol_adapter
/// 共用）。精确命中优先；跨形态回退**双向**（CR-002）——Number 候选未命中回退 String
/// 形态（前端把 requestId 以字符串回显——原 numeric 请求以 "7" 回显，不能丢）；
/// String 候选未命中时若可解析为数字则回退 Number 形态（approve_tool_call 以字符串
/// 调用 numeric 请求）。两者并存时优先精确候选；均未命中返回 None。
pub(crate) fn canonical_pending_key(
    pending: &HashMap<RequestId, crate::permission::PendingPermission>,
    candidate: &RequestId,
) -> Option<RequestId> {
    if pending.contains_key(candidate) {
        return Some(candidate.clone());
    }
    match candidate {
        RequestId::Number(n) => {
            let alt = RequestId::String(n.to_string());
            if pending.contains_key(&alt) {
                return Some(alt);
            }
        }
        RequestId::String(s) => {
            if let Ok(n) = s.parse::<u64>() {
                let alt = RequestId::Number(n);
                if pending.contains_key(&alt) {
                    return Some(alt);
                }
            }
        }
    }
    None
}

async fn resolve_pending(
    runtime: &AgentRuntime,
    request_id: RequestId,
    expected_tool_call_id: Option<&str>,
    option_id: &str,
) -> bool {
    // 锁内复核 + 取 write_tx 克隆 + claim（发送全部在锁外）。
    let (write_tx, crashed, claimed, canonical_id) = {
        let acp = runtime.acp.lock().await;
        let mut pending = match runtime.pending_permissions.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        let Some(canonical_id) = canonical_pending_key(&pending, &request_id) else {
            return false;
        };
        let Some(permission) = pending.get(&canonical_id) else {
            return false;
        };
        // C4：身份复核——客户端替换（generation 前进）后不误写新进程同 id 请求。
        if permission.client_generation != runtime.client_generation.load(Ordering::Acquire) {
            return false;
        }
        // tool_call_id 复核（cancel 路径用）。
        if let Some(expected) = expected_tool_call_id {
            if permission.tool_call_id != expected {
                return false;
            }
        }
        // C5 选项契约：空 option_id = Cancelled；非空必须 ∈ options（option_id 原值）。
        if !option_id.is_empty()
            && !permission
                .options
                .iter()
                .any(|option| option.option_id == option_id)
        {
            return false;
        }
        (
            acp.write_tx.clone(),
            acp.crashed.clone(),
            pending.remove(&canonical_id),
            canonical_id,
        )
    };
    // 锁外发送（G3 §2.2.2 收敛）：构造应答 → send_agent_response（信封 + 序列化 +
    // 10s 超时 + crashed 预检/置位）。失败恢复 pending（保留可重试）；原 :190-194
    // 的 crashed 预检分支自然落入 helper 返回 false → restore，行为一致。
    let outcome = if option_id.is_empty() {
        permission_response_cancelled()
    } else {
        permission_response(option_id)
    };
    if !send_agent_response(write_tx, crashed, canonical_id.clone(), outcome).await {
        restore_pending(runtime, canonical_id, claimed);
        return false;
    }
    true
}

/// 发送失败后恢复已 claim 的挂起条目（O9：保留 pending 供重试/超时/客户端替换
/// 清理）。同 id 已有更新条目时保留更新条目（不覆盖新请求）。
fn restore_pending(
    runtime: &AgentRuntime,
    request_id: RequestId,
    claimed: Option<PendingPermission>,
) {
    if let Some(permission) = claimed {
        let _ = runtime.pending_permissions.lock().map(|mut pending| {
            pending.entry(request_id).or_insert(permission);
        });
    }
}

/// 应答并移除指定 session 的全部挂起权限请求（Cancelled）——cancel/close 路径调用。
pub(crate) async fn respond_pending_permissions_cancelled(
    runtime: &AgentRuntime,
    session_id: &str,
) {
    let pending: Vec<(RequestId, String)> = runtime
        .pending_permissions
        .lock()
        .map(|pending| {
            pending
                .iter()
                .filter(|(_, p)| p.session_id == session_id)
                .map(|(id, p)| (id.clone(), p.tool_call_id.clone()))
                .collect()
        })
        .unwrap_or_default();
    for (request_id, tool_call_id) in pending {
        // R34：统一走 resolve_pending（锁内复核身份 + tool_call_id，锁外发送）；
        // 空 option_id = Cancelled 应答。校验/发送失败时保留 pending（进程已死
        // 则由崩溃处理/客户端替换清理，不向新进程误写）。
        let _ = resolve_pending(runtime, request_id, Some(&tool_call_id), "").await;
    }
}

/// 应答挂起的权限请求（B9.4 契约）：option_id 必须是请求提供的选项之一。
/// 拒绝走同一命令（option_id = "reject_once" 等）。返回 Err = 未找到/选项非法/
/// 身份不匹配（C4）/发送失败。
/// R34：统一收敛到 resolve_pending——单一临界区（锁内查条目 + 校验选项 +
/// C4 generation 校验 + claim）+ 锁外发送（O9/O36 合并落点）。
pub(crate) async fn resolve_permission(
    runtime: &AgentRuntime,
    request_id: RequestId,
    option_id: &str,
) -> Result<(), PylonError> {
    if !resolve_pending(runtime, request_id.clone(), None, option_id).await {
        return Err(PylonError::Protocol(format!(
            "permission request not found: {request_id}"
        )));
    }
    tracing::info!("权限请求 {request_id} 已应答 {option_id}");
    Ok(())
}

/// 应答挂起的权限请求（命令入口，跨 runtime 定位）。
/// ACP-01：request_id 接受 number 或 string（untagged 反序列化），兼容新旧前端。
#[tauri::command]
pub(crate) async fn approve_tool_call(
    state: tauri::State<'_, AppState>,
    request_id: RequestId,
    option_id: String,
) -> Result<(), PylonError> {
    for runtime in state.inner().runtimes.all() {
        if resolve_permission(&runtime, request_id.clone(), &option_id)
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

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionIdentityInput {
    pub provider: String,
    pub agent_id: String,
    pub request_id: String,
    pub session_id: String,
    pub tool_call_id: Option<String>,
    pub client_generation: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InteractionAnswerInput {
    pub option_id: Option<String>,
    pub text: Option<String>,
    pub values: Option<serde_json::Value>,
}

/// 统一 Interaction response transport 的后端入口。
/// P0-3（R2-WI03）：按 provider 从协议适配器注册表 dispatch——不再硬编码 provider=="peri"；
/// 未注册 provider 返回明确 unsupported，不生成假 RPC。
#[tauri::command]
pub(crate) async fn respond_interaction(
    state: tauri::State<'_, AppState>,
    identity: InteractionIdentityInput,
    kind: String,
    answer: InteractionAnswerInput,
) -> Result<(), PylonError> {
    let adapter =
        crate::protocol_adapter::get_protocol_adapter(&identity.provider).ok_or_else(|| {
            PylonError::Protocol(format!(
                "interaction response unsupported: provider={}",
                identity.provider
            ))
        })?;
    let runtime = state.runtimes.get(&identity.agent_id).ok_or_else(|| {
        PylonError::Protocol(format!("agent runtime not found: {}", identity.agent_id))
    })?;
    adapter
        .respond_interaction(&runtime, &identity, &kind, &answer)
        .await
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

/// CLI 增强（contract.bridge 前置）：读取当前全局审批模式。
/// 此前只有 set 无 get——外部自动化无法确认模式即盲跑。
#[tauri::command]
pub(crate) async fn get_approval_mode(
    state: tauri::State<'_, AppState>,
) -> Result<String, PylonError> {
    state
        .approval_mode
        .lock()
        .map(|mode| mode.clone())
        .map_err(|e| PylonError::Protocol(format!("approval mode lock poisoned: {e}")))
}

/// CLI 增强：遍历全部 runtime 的挂起权限请求快照（含应答所需完整 identity）。
/// provider 由 agent_id 反查 agents 配置（与 dispatcher emit 同源）。
#[tauri::command]
pub(crate) async fn interaction_list(
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value, PylonError> {
    let mut items: Vec<serde_json::Value> = Vec::new();
    for (agent_id, runtime) in state.runtimes.iter() {
        let provider = {
            let agents = state
                .agents
                .lock()
                .map_err(|e| PylonError::Protocol(format!("agents lock poisoned: {e}")))?;
            resolve_agent_provider(&agents, &agent_id).unwrap_or_else(|| agent_id.clone())
        };
        let pending = runtime.pending_permissions.lock().map_err(|e| {
            PylonError::Protocol(format!("pending permissions lock poisoned: {e}"))
        })?;
        for (request_id, permission) in pending.iter() {
            items.push(serde_json::json!({
                "provider": provider,
                "agentId": agent_id,
                "requestId": request_id.to_string(),
                "sessionId": permission.session_id,
                "toolCallId": permission.tool_call_id,
                "clientGeneration": permission.client_generation,
                "title": permission.title,
                "prompt": permission.prompt,
                "options": permission.options.iter().map(|option| serde_json::json!({
                    "optionId": option.option_id,
                    "kind": option.kind,
                    "name": option.name,
                })).collect::<Vec<_>>(),
                "requestedAt": permission.requested_at.to_string(),
                "deadlineMs": permission_deadline_ms(permission.requested_at),
            }));
        }
    }
    Ok(serde_json::json!({ "items": items }))
}

/// ACP-03（§5.6）：权限请求的展示截止时刻——deadline 由后端单一来源
/// （PERMISSION_REQUEST_TIMEOUT_SECS）给出，前端只做倒计时展示，不自行持有
/// 超时常量。返回 epoch-ms number（与 requestedAt 字符串区分的展示字段）。
pub(crate) fn permission_deadline_ms(requested_at: Timestamp) -> u64 {
    requested_at.as_u64() + PERMISSION_REQUEST_TIMEOUT_SECS * 1000
}

/// ACP-03（§5.6）：超时已结算的挂起请求（后端 watcher 发出的 permission.resolved
/// terminal 事件载荷）。前端据此 settle active/queued 请求——后端唯一计时/应答，
/// 前端不自行宣称超时结果（invariant 5）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TimeoutOutcome {
    pub agent_id: String,
    pub session_id: String,
    pub request_id: RequestId,
    pub client_generation: u64,
    pub option_id: String,
}

/// 挂起的权限请求超时检查（B9.2：超时默认拒绝，不悬挂 pending）。
/// C5：默认拒绝选项按请求提供的选项选择（reject 优先），不再硬编码 reject_once。
/// O37：已崩溃 runtime 的 pending 永久悬挂（写通道已死，任何应答都不可能送达）
/// ——直接清空并 log；多条超时应答 join_all 并行（不再逐条 await 串行）。
pub(crate) async fn check_pending_permission_timeouts(state: &AppState) -> Vec<TimeoutOutcome> {
    let now = Timestamp::now();
    let mut outcomes = Vec::new();
    for (agent_id, runtime) in state.runtimes.all_with_ids() {
        // O37：已崩溃 runtime 的挂起请求永久无法应答（O9 锁外发送依赖写通道，
        // 崩溃后 send 必失败、restore 后下轮 watcher 重试仍失败）——直接清空。
        let crashed = runtime
            .acp
            .try_lock()
            .map(|acp| acp.is_crashed())
            .unwrap_or(false);
        if crashed {
            let dropped = runtime
                .pending_permissions
                .lock()
                .map(|pending| pending.len())
                .unwrap_or(0);
            if dropped > 0 {
                tracing::warn!("runtime 已崩溃，清空 {dropped} 条挂起权限请求");
            }
            let _ = runtime
                .pending_permissions
                .lock()
                .map(|mut pending| pending.clear());
            continue;
        }
        let expired: Vec<(RequestId, String, String, u64, Vec<PermissionOption>)> = runtime
            .pending_permissions
            .lock()
            .map(|pending| {
                pending
                    .iter()
                    .filter(|(_, permission)| {
                        now.elapsed_since(permission.requested_at)
                            > PERMISSION_REQUEST_TIMEOUT_SECS * 1000
                    })
                    .map(|(id, permission)| {
                        (
                            id.clone(),
                            permission.tool_call_id.clone(),
                            permission.session_id.clone(),
                            permission.client_generation,
                            permission.options.clone(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        if expired.is_empty() {
            continue;
        }
        // O37：多条超时应答互不依赖——join_all 并行，避免写通道阻塞时逐条串行
        // 放大整体耗时。R34：统一走 resolve_pending（锁内复核 + 锁外发送，
        // 防客户端替换竞态）；发送失败恢复 pending，下轮 watcher 重试或客户端
        // 替换清理。超时日志无条件保留（记录本次判定）。
        // ACP-03：仅成功结算（应答送达）的请求收集 outcome——后端据此发出
        // permission.resolved terminal 事件，前端 settle 该请求（不自行宣称超时）。
        let responses = expired
            .into_iter()
            .map(|(request_id, tool_call_id, session_id, client_generation, options)| {
                let runtime = runtime.clone();
                let agent_id = agent_id.clone();
                async move {
                    // ACP-04（§5.6 invariant 4）：超时只能选原 options 中的合法
                    // option——解析层保证 pending 恒非空、pick_option 必 Some；
                    // 防御分支不得伪造 optionId（旧 unwrap_or("reject_once") 是
                    // OBS-03 登记的伪造路径），如异常出现则跳过结算并告警。
                    let Some(option_id) = pick_option(&options, true).map(str::to_string) else {
                        tracing::error!(
                            "权限请求 {request_id} 超时但 options 为空（不应发生），跳过结算，不伪造 optionId"
                        );
                        return None;
                    };
                    let resolved =
                        resolve_pending(&runtime, request_id.clone(), None, &option_id).await;
                    tracing::warn!(
                        "权限请求 {request_id} 超时默认拒绝 {option_id}（{tool_call_id}）"
                    );
                    resolved.then_some(TimeoutOutcome {
                        agent_id,
                        session_id,
                        request_id,
                        client_generation,
                        option_id,
                    })
                }
            });
        outcomes.extend(
            futures_util::future::join_all(responses)
                .await
                .into_iter()
                .flatten(),
        );
    }
    outcomes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::AgentRuntime;

    fn request_params() -> serde_json::Value {
        serde_json::json!({
            "sessionId": "s1",
            "toolCall": {"toolCallId": "call-1", "title": "tool"},
            "options": [{"optionId": "allow_once"}, {"optionId": "reject_once"}]
        })
    }

    fn parsed(generation: u64) -> PendingPermission {
        parse_permission_request_with_generation(Some(&request_params()), generation)
            .expect("合法请求必须解析")
    }

    fn opts(items: &[&str]) -> Vec<PermissionOption> {
        items.iter().map(|s| PermissionOption::plain(*s)).collect()
    }

    /// 带 kind 的选项（kind 作为语义类别参与选择）。
    fn opts_kind(items: &[(&str, Option<&str>)]) -> Vec<PermissionOption> {
        items
            .iter()
            .map(|(id, kind)| PermissionOption {
                option_id: (*id).to_string(),
                kind: kind.map(|k| k.to_string()),
                name: None,
                raw: None,
            })
            .collect()
    }

    #[test]
    fn pick_option_reject_prefers_reject_once_then_prefix_then_first() {
        // reject_once 优先（忽略大小写）
        assert_eq!(
            pick_option(&opts(&["allow_once", "REJECT_ONCE"]), true),
            Some("REJECT_ONCE")
        );
        // 无 reject_once 时前缀 reject 优先
        assert_eq!(
            pick_option(&opts(&["allow_once", "reject_forever"]), true),
            Some("reject_forever")
        );
        // 无 reject 语义项时取首个
        assert_eq!(
            pick_option(&opts(&["allow_once", "ask_again"]), true),
            Some("allow_once")
        );
        // ACP-02：kind=reject_once 是语义类别——optionId 非 reject 字面也命中
        assert_eq!(
            pick_option(
                &opts_kind(&[("allow_once", None), ("deny", Some("reject_once"))]),
                true
            ),
            Some("deny")
        );
        // Hermes camelCase kind（rejectOnce）与 snake_case 视为同义（下划线归一）
        assert_eq!(
            pick_option(
                &opts_kind(&[("allow_once", None), ("deny", Some("rejectOnce"))]),
                true
            ),
            Some("deny")
        );
        // kind 前缀 reject 同样命中；返回值恒为 option_id 原值
        assert_eq!(
            pick_option(
                &opts_kind(&[("allow_once", None), ("deny", Some("reject"))]),
                true
            ),
            Some("deny")
        );
        // 空集无兜底项
        assert_eq!(pick_option(&[], true), None);
    }

    #[test]
    fn pick_option_allow_prefers_allow_once_then_first() {
        assert_eq!(
            pick_option(&opts(&["allow_always", "ALLOW_ONCE"]), false),
            Some("ALLOW_ONCE")
        );
        assert_eq!(
            pick_option(&opts(&["allow_always", "reject_once"]), false),
            Some("allow_always")
        );
        // ACP-02：kind=allowOnce 语义类别同样命中 allow 分支
        assert_eq!(
            pick_option(
                &opts_kind(&[("allow_always", None), ("yes", Some("allowOnce"))]),
                false
            ),
            Some("yes")
        );
        assert_eq!(pick_option(&[], false), None);
    }

    #[test]
    fn parse_retains_kind_name_and_raw_acp02() {
        // ACP-02：typed options——kind/name/raw 必须宽容保留，optionId 原值不正规化。
        let params = serde_json::json!({
            "sessionId": "s1",
            "toolCall": {"toolCallId": "call-1", "title": "tool"},
            "options": [
                {"optionId": "ALLOW_ONCE", "kind": "allowOnce", "name": "Allow", "raw": {"x": 1}},
                {"optionId": "custom_approve", "kind": "UNKNOWN_KIND"}
            ]
        });
        let permission = parse_permission_request(Some(&params)).expect("合法请求必须解析");
        assert_eq!(permission.options.len(), 2);
        assert_eq!(
            permission.options,
            vec![
                PermissionOption {
                    option_id: "ALLOW_ONCE".to_string(),
                    kind: Some("allowOnce".to_string()),
                    name: Some("Allow".to_string()),
                    raw: Some(serde_json::json!({"x": 1})),
                },
                PermissionOption {
                    option_id: "custom_approve".to_string(),
                    kind: Some("UNKNOWN_KIND".to_string()),
                    name: None,
                    raw: None,
                },
            ]
        );
        // optionId 原样保存（ALLOW_ONCE 未被小写化）——事件序列化必须回写原值。
        assert_eq!(permission.options[0].option_id, "ALLOW_ONCE");
    }

    /// fake ACP：把收到的请求行追加写入 trace 文件并逐个应答（writer 不阻塞）。
    fn trace_script(trace_path: &std::path::Path) -> String {
        format!(
            r#"import json,sys
with open({trace:?}, 'a') as f:
    for line in sys.stdin:
        request = json.loads(line)
        f.write(line)
        f.flush()
        print(json.dumps({{'jsonrpc':'2.0','id':request.get('id'),'result':{{}}}}), flush=True)
"#,
            trace = trace_path.to_string_lossy()
        )
    }

    #[tokio::test]
    async fn respond_permission_rejects_stale_generation() {
        let runtime = AgentRuntime::new_disconnected();
        // 客户端替换场景：pending 记录的是旧 generation（1），当前 generation 为 0
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(RequestId::Number(7), parsed(1));
        assert!(
            !resolve_pending(&runtime, RequestId::Number(7), None, "allow_once").await,
            "generation 不匹配必须拒绝应答"
        );
        assert!(
            runtime
                .pending_permissions
                .lock()
                .unwrap()
                .contains_key(&RequestId::Number(7)),
            "拒绝应答后 pending 保留（由客户端替换清理）"
        );
    }

    #[tokio::test]
    async fn respond_permission_stale_generation_never_reaches_client() {
        let trace_path = std::env::temp_dir().join(format!(
            "prism_perm_stale_{}_{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&trace_path);
        let agent = crate::test_utils::fake_acp_agent("fake-acp-perm", &trace_script(&trace_path));
        let acp = crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP 必须初始化");
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = acp;

        // 旧 generation（1）的挂起：不匹配 → 不应答且不发送
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(RequestId::Number(7), parsed(1));
        assert!(
            !resolve_pending(&runtime, RequestId::Number(7), None, "allow_once").await,
            "stale generation 必须拒绝"
        );
        assert!(runtime
            .pending_permissions
            .lock()
            .unwrap()
            .contains_key(&RequestId::Number(7)));

        // 当前 generation（0）的挂起：匹配 → 应答发送成功并清理
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(RequestId::Number(8), parsed(0));
        assert!(
            resolve_pending(&runtime, RequestId::Number(8), None, "allow_once").await,
            "匹配 generation 必须应答"
        );
        assert!(!runtime
            .pending_permissions
            .lock()
            .unwrap()
            .contains_key(&RequestId::Number(8)));

        // 等 fake ACP 把请求写入 trace 后回读断言（serde_json 紧凑序列化："id":8）
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if std::fs::read_to_string(&trace_path)
                    .map(|trace| trace.contains("\"id\":8"))
                    .unwrap_or(false)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("匹配 generation 的应答必须到达客户端");

        // R34：Cancelled 应答（空 option_id）——匹配身份 + tool_call_id 则发送
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(RequestId::Number(9), parsed(0));
        assert!(
            resolve_pending(&runtime, RequestId::Number(9), Some("call-1"), "").await,
            "匹配的 cancel 必须应答"
        );
        // tool_call_id 不匹配（同 id 已被复用为其他工具调用）→ 拒绝应答且不发送
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(RequestId::Number(10), parsed(0));
        assert!(
            !resolve_pending(&runtime, RequestId::Number(10), Some("other-call"), "").await,
            "tool_call_id 不匹配必须拒绝"
        );
        assert!(runtime
            .pending_permissions
            .lock()
            .unwrap()
            .contains_key(&RequestId::Number(10)));
        // 等 cancel 应答写入 trace 后回读断言
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if std::fs::read_to_string(&trace_path)
                    .map(|trace| trace.contains("\"id\":9"))
                    .unwrap_or(false)
                {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("cancel 应答必须到达客户端");
        let trace = std::fs::read_to_string(&trace_path).unwrap_or_default();
        assert!(
            trace.contains("\"outcome\":\"cancelled\""),
            "cancel 应答必须是 Cancelled 形状: {trace}"
        );
        assert!(
            !trace.contains("\"id\":7"),
            "stale generation 应答不得写入新进程: {trace}"
        );
        assert!(
            !trace.contains("\"id\":10"),
            "tool_call_id 不匹配的应答不得发送: {trace}"
        );

        let _ = runtime.acp.lock().await.kill();
        let _ = std::fs::remove_file(&trace_path);
    }

    #[test]
    fn canonical_pending_key_exact_hit_and_number_to_string_fallback() {
        // ACP-01：前端把 requestId 以字符串回显——原 string-id 请求（String("7")）
        // 经候选 Number(7) 回退命中；Number 与 String 并存时精确命中优先。
        let mut pending: HashMap<RequestId, PendingPermission> = HashMap::new();
        pending.insert(RequestId::String("7".to_string()), parsed(0));
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::Number(7)),
            Some(RequestId::String("7".to_string())),
            "Number 未命中必须回退 String 形态"
        );
        pending.insert(RequestId::Number(7), parsed(0));
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::Number(7)),
            Some(RequestId::Number(7)),
            "并存时精确命中优先"
        );
        // 并存时 String 候选精确命中 String 条目（不跨形态回退）。
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::String("7".to_string())),
            Some(RequestId::String("7".to_string())),
            "并存时精确候选优先"
        );
        // ACP-01 CR-002：String 候选（approve_tool_call 以字符串调用 numeric 请求）
        // 未命中时回退 Number 形态——双向归一。此时 pending 仅剩 Number(7)。
        pending.remove(&RequestId::String("7".to_string()));
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::String("7".to_string())),
            Some(RequestId::Number(7)),
            "String 候选必须回退 Number 形态"
        );
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::String("007".to_string())),
            Some(RequestId::Number(7)),
            "前导零数字串归一为 Number"
        );
        assert_eq!(
            canonical_pending_key(&pending, &RequestId::String("perm-x".to_string())),
            None,
            "不存在返回 None"
        );
    }

    #[tokio::test]
    async fn string_id_pending_round_trip_echoes_original_variant() {
        // ACP-01 验收：string id（"perm-1"）挂起请求用原 variant 应答——
        // 响应 wire 的 id 必须是字符串（不能转成 number、不能当 0）。
        let trace_path = std::env::temp_dir().join(format!(
            "prism_perm_str_{}_{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = std::fs::remove_file(&trace_path);
        let agent =
            crate::test_utils::fake_acp_agent("fake-acp-perm-str", &trace_script(&trace_path));
        let acp = crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP 必须初始化");
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = acp;

        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(RequestId::String("perm-1".to_string()), parsed(0));
        assert!(
            resolve_pending(
                &runtime,
                RequestId::String("perm-1".to_string()),
                None,
                "allow_once"
            )
            .await,
            "string id 必须应答"
        );
        assert!(
            !runtime
                .pending_permissions
                .lock()
                .unwrap()
                .contains_key(&RequestId::String("perm-1".to_string())),
            "应答后必须清理"
        );

        // 等 fake ACP 把应答写入 trace 后回读断言：id 保持字符串形态。
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                if let Some(line) = std::fs::read_to_string(&trace_path)
                    .unwrap_or_default()
                    .lines()
                    .find(|line| line.contains("\"perm-1\""))
                {
                    let value: serde_json::Value = serde_json::from_str(line).unwrap();
                    assert_eq!(
                        value["id"],
                        serde_json::json!("perm-1"),
                        "响应必须回写 string id 原 variant"
                    );
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("string id 应答必须到达客户端");

        let _ = runtime.acp.lock().await.kill();
        let _ = std::fs::remove_file(&trace_path);
    }

    /// ACP-03（§5.6）：后端唯一计时/应答——超时请求结算后返回 outcome（前端
    /// permission.resolved 事件载荷）。disconnected() 默认 drop 写接收端，发送
    /// 必失败（恢复 pending）——须用存活通道 + 接收端保持作用域内，断言应答送达。
    #[tokio::test]
    async fn timeout_settles_and_reports_outcome_with_live_write_channel() {
        let (write_tx, mut write_rx) = tokio::sync::mpsc::channel(1);
        let mut acp = crate::acp::AcpClient::disconnected();
        acp.write_tx = write_tx;
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = acp;
        let agent_id = "timeout-agent";
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_runtime(agent_id, runtime.clone())
            .build();
        // requested_at 早于 300s——超时命中。
        let old = Timestamp::new(Timestamp::now().as_u64().saturating_sub(301_000));
        let mut pending = parsed(0);
        pending.requested_at = old;
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(RequestId::Number(7), pending);

        let outcomes = check_pending_permission_timeouts(&state).await;

        assert_eq!(outcomes.len(), 1, "超时请求必须结算并报告 outcome");
        let outcome = &outcomes[0];
        assert_eq!(outcome.agent_id, agent_id);
        assert_eq!(outcome.session_id, "s1");
        assert_eq!(outcome.request_id, RequestId::Number(7));
        assert_eq!(outcome.client_generation, 0);
        assert_eq!(outcome.option_id, "reject_once");
        assert!(
            runtime.pending_permissions.lock().unwrap().is_empty(),
            "结算后 pending 必须清空"
        );
        // 应答已送达（接收端存活——disconnected 默认 drop rx 会发送失败恢复 pending）
        let line = write_rx.try_recv().expect("超时应答必须送达写通道");
        assert!(
            line.contains("reject_once"),
            "应答必须回写 reject_once：{line}"
        );
    }

    /// ACP-03：deadline 由后端单一来源（PERMISSION_REQUEST_TIMEOUT_SECS）——
    /// 展示截止 = requestedAt + 300s；前端只读该值做倒计时。
    #[test]
    fn permission_deadline_is_requested_at_plus_timeout() {
        let requested_at = Timestamp::new(1_722_500_000_000);
        assert_eq!(
            permission_deadline_ms(requested_at),
            1_722_500_000_000 + 300 * 1000
        );
    }

    /// ACP-04（§5.6）：send_agent_error 发 JSON-RPC error 信封，id 回显原始
    /// variant（string/number），无 result/outcome；崩溃后不发送。
    #[tokio::test]
    async fn send_agent_error_emits_error_envelope_with_id_variant() {
        let (write_tx, mut write_rx) = tokio::sync::mpsc::channel(1);
        let crashed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ok = send_agent_error(
            write_tx,
            crashed.clone(),
            RequestId::String("perm-e".to_string()),
            -32602,
            "invalid params: permission request 解析失败",
        )
        .await;
        assert!(ok, "string id 错误应答必须发送");
        let line: serde_json::Value =
            serde_json::from_str(&write_rx.try_recv().expect("错误信封必须到达")).unwrap();
        assert_eq!(line["jsonrpc"], "2.0");
        assert_eq!(line["id"], "perm-e", "string id 必须回显原始 variant");
        assert_eq!(line["error"]["code"], -32602);
        assert!(line.get("result").is_none(), "错误应答不得携带 result");

        // number id 回显 + 崩溃后不发送。
        let (write_tx2, mut write_rx2) = tokio::sync::mpsc::channel(1);
        let ok2 = send_agent_error(
            write_tx2,
            crashed.clone(),
            RequestId::Number(9),
            -32602,
            "x",
        )
        .await;
        assert!(ok2, "number id 错误应答必须发送");
        let line2: serde_json::Value =
            serde_json::from_str(&write_rx2.try_recv().expect("错误信封必须到达")).unwrap();
        assert_eq!(line2["id"], 9, "number id 必须回显原始 variant");
        drop(write_rx2);

        crashed.store(true, std::sync::atomic::Ordering::Release);
        let (write_tx3, write_rx3) = tokio::sync::mpsc::channel(1);
        let ok3 = send_agent_error(
            write_tx3,
            crashed.clone(),
            RequestId::Number(1),
            -32602,
            "x",
        )
        .await;
        assert!(!ok3, "已崩溃不得发送");
        drop(write_rx3);
    }
}
