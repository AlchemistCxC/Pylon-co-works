//! B9 权限审批：挂起请求解析/应答/超时（R1 拆分自 lib.rs；行为零变化）。
//! ACP-01：挂起键从 `u64` 升级为 [`RequestId`]（number/string 原始形态），
//! 响应 id 用原始 variant 回写。
//! ACP-02：options 从 `Vec<String>` 升级为 [`PermissionOption`]（typed wire），
//! kind/name 宽容保留、optionId 原值不正规化（§5.5）。

use std::collections::HashMap;
use std::sync::atomic::Ordering;

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
    let prompt: String = runtime_log::sanitize_message(&raw_input)
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

/// 严格 reject 选择：只匹配 reject_once / reject 前缀语义，**绝无 first() 回退**。
/// 供钩子驱动的拒绝路径（tool.beforeCall cancel / permission.request Deny）使用：
/// 请求不含 reject 语义选项时返回 None，调用方不得伪造应答、应交回常规流程
/// （对比 [`pick_option`] 的 first() 回退——那是超时/自动批准场景的既定约定，
/// 不适用于「钩子显式拒绝」：对一个 deny gate 回答 allow 语义项是 fail-open 缺陷）。
pub(crate) fn pick_reject_option(options: &[PermissionOption]) -> Option<&str> {
    let semantic = |option: &PermissionOption, needle: &str, prefix: bool| {
        std::iter::once(option.option_id.as_str())
            .chain(option.kind.iter().map(String::as_str))
            .any(|value| {
                let value = value.to_ascii_lowercase().replace('_', "");
                let needle = needle.replace('_', "");
                if prefix {
                    value.starts_with(&needle)
                } else {
                    value == needle
                }
            })
    };
    options
        .iter()
        .find(|option| semantic(option, "reject_once", false))
        .or_else(|| {
            options
                .iter()
                .find(|option| semantic(option, "reject", true))
        })
        .map(|option| option.option_id.as_str())
}

/// 严格 allow 选择（钩子驱动的批准路径）：只匹配 allow 前缀语义
/// （allow_once / allow_always），无 first() 回退——理由同 [`pick_reject_option`]。
pub(crate) fn pick_allow_option(options: &[PermissionOption]) -> Option<&str> {
    let semantic = |option: &PermissionOption, needle: &str, prefix: bool| {
        std::iter::once(option.option_id.as_str())
            .chain(option.kind.iter().map(String::as_str))
            .any(|value| {
                let value = value.to_ascii_lowercase().replace('_', "");
                let needle = needle.replace('_', "");
                if prefix {
                    value.starts_with(&needle)
                } else {
                    value == needle
                }
            })
    };
    options
        .iter()
        .find(|option| semantic(option, "allow", true))
        .map(|option| option.option_id.as_str())
}

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
    let (responder, claimed, canonical_id) = {
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
        (acp.responder(), pending.remove(&canonical_id), canonical_id)
    };
    // 锁外发送（G3 §2.2.2 收敛）：构造应答 → send_agent_response（信封 + 序列化 +
    // 10s 超时 + crashed 预检/置位）。失败恢复 pending（保留可重试）；原 :190-194
    // 的 crashed 预检分支自然落入 helper 返回 false → restore，行为一致。
    let outcome = if option_id.is_empty() {
        permission_response_cancelled()
    } else {
        permission_response(option_id)
    };
    if !responder.respond(canonical_id.clone(), outcome).await {
        restore_pending(runtime, canonical_id, claimed);
        return false;
    }
    // #98：统一交互队列终态——成功送达即 settle（Answered/Cancelled）并晋升
    // 下一个 waiter（FIFO single-visible）。发送失败路径不入队终态（保留可重试）。
    let _ = runtime.interactions.settle(
        &canonical_id.to_string(),
        if option_id.is_empty() {
            crate::acp::interaction_queue::InteractionTerminalReason::Cancelled
        } else {
            crate::acp::interaction_queue::InteractionTerminalReason::Answered
        },
    );
    // The pending entry carries the only reliable session binding.  Update the
    // reducer only after the wire response commits, so a failed send remains
    // retryable and cannot prematurely drain state.
    if let Some(permission) = claimed.as_ref() {
        if let Ok(mut sessions) = runtime.sessions.lock() {
            if let Some(session) = sessions.get_mut(&permission.session_id) {
                let _ = session
                    .acp_state
                    .resolve_permission(&canonical_id.to_string());
            }
        }
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
        let inserted = runtime
            .pending_permissions
            .lock()
            .map(|mut pending| {
                pending
                    .insert(request_id.clone(), permission.clone())
                    .is_none()
            })
            .unwrap_or(false);
        // #98（P2-1 评审修复）：发送失败恢复 pending 时同步回灌交互队列——
        // 否则超时路径的 settle(TimedOut) 先行移除后，重试中的请求会从
        // pendingInteractions 冷挂载快照消失（队列与 pending store 失配）。
        // 回灌事件载荷与 dispatcher admit 同构重建。
        if inserted {
            // provider 在 restore 路径不可得（pending store 不持有）——置空串；
            // 事件消费方（冷挂载 normalize→receive）不依赖该字段做归属。
            let event = serde_json::json!({
                "provider": "",
                "agentId": "",
                "sessionId": permission.session_id,
                "eventType": "permission.request",
                "requestId": request_id.to_string(),
                "toolCallId": permission.tool_call_id,
                "clientGeneration": permission.client_generation,
                "payload": {
                    "title": permission.title,
                    "prompt": permission.prompt,
                    "options": permission.options,
                    "requestedAt": permission.requested_at,
                    "deadlineMs": permission_deadline_ms(permission.requested_at),
                },
            });
            let _ =
                runtime
                    .interactions
                    .admit(crate::acp::interaction_queue::InteractionQueueEntry {
                        request_id: request_id.to_string(),
                        method: crate::acp::METHOD_SESSION_REQUEST_PERMISSION.to_string(),
                        kind: "approval".to_string(),
                        session_id: permission.session_id,
                        agent_id: String::new(),
                        client_generation: permission.client_generation,
                        enqueued_at: permission.requested_at,
                        event,
                        state: crate::acp::interaction_queue::InteractionEntryState::Waiting,
                    });
        }
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
    // #98（P1-3 评审修复）：session close/expiry 的 drain 必须覆盖全部 waiter——
    // elicitation/ask-user 等非 approval 条目不经 resolve_pending，若不在此
    // 终结会滞留队列并被冷挂载快照复活成死交互（spec §6：cancel 必须 drain
    // 并给每个 waiter 一个终态）。
    let _ = runtime.interactions.drain_where(
        |entry| entry.session_id == session_id,
        crate::acp::interaction_queue::InteractionTerminalReason::Cancelled,
    );
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
/// P0-3（R2-WI03）：协议适配器 dispatch。#98：私有桥/elicitation 先按
/// request id 路由（方法驱动，不要求 provider 名称匹配）；兜底路径按
/// method 查适配器（provider 键控表仅剩诊断用途）——未注册 provider 的
/// 合法 ACP 交互不再被拒。
#[tauri::command]
pub(crate) async fn respond_interaction(
    state: tauri::State<'_, AppState>,
    identity: InteractionIdentityInput,
    kind: String,
    answer: InteractionAnswerInput,
) -> Result<(), PylonError> {
    let runtime = state.runtimes.get(&identity.agent_id).ok_or_else(|| {
        PylonError::Protocol(format!("agent runtime not found: {}", identity.agent_id))
    })?;
    let request_id = crate::acp::RequestId::from_echo_string(&identity.request_id);
    if let Some(pending) = runtime
        .private_interactions
        .get(&request_id)
        .map_err(PylonError::Protocol)?
    {
        if pending.session_id != identity.session_id
            || pending.provider != identity.provider
            || pending.agent_id != identity.agent_id
            || pending.method.is_empty()
            || pending.client_generation != identity.client_generation
        {
            return Err(PylonError::Protocol("stale interaction identity".into()));
        }
        let response = match pending.bridge {
            crate::acp::adapter::private_ext::PrivateBridge::GrokExtQuestions
            | crate::acp::adapter::private_ext::PrivateBridge::PiSelectAsk => {
                let questions = pending.question_specs.ok_or_else(|| {
                    PylonError::Protocol("private question request lost validated specs".into())
                })?;
                let values = answer.values.clone().unwrap_or_default();
                let answers = questions
                    .iter()
                    .filter_map(|spec| {
                        values.get(&spec.id).map(|value| {
                            let labels = match value {
                                serde_json::Value::String(label) => vec![label.clone()],
                                serde_json::Value::Array(items) => items
                                    .iter()
                                    .filter_map(|item| item.as_str().map(str::to_owned))
                                    .collect(),
                                _ => Vec::new(),
                            };
                            crate::acp::question_policy::QuestionAnswerItem {
                                question_id: spec.id.clone(),
                                labels,
                            }
                        })
                    })
                    .collect();
                let answer = crate::acp::question_policy::QuestionAnswer {
                    answers,
                    declined: answer.option_id.as_deref() == Some("declined"),
                };
                crate::acp::adapter::private_ext::build_question_response(
                    pending.bridge,
                    &questions,
                    &answer,
                )
                .map_err(PylonError::Protocol)?
            }
            crate::acp::adapter::private_ext::PrivateBridge::GrokExitPlan => {
                let _ = crate::acp::adapter::private_ext::parse_exit_plan(
                    pending.bridge,
                    &pending.params,
                )
                .map_err(PylonError::Protocol)?;
                crate::acp::plan_policy::approval_response(
                    answer.option_id.as_deref().unwrap_or("keep_planning"),
                    answer.text.as_deref().unwrap_or(""),
                )
            }
            crate::acp::adapter::private_ext::PrivateBridge::Elicitation => {
                // #98：elicitation 应答 = ESM 风格 action 三值。decline/cancel
                // 由前端 optionId 表达；accept 携带 values/text 原样 content。
                // P2-3（评审修复）：optionId 白名单 fail-closed——未知值显式
                // 报错而非静默 accept（不伪造成功）。缺省 optionId + values/text
                // = 自由作答（accept）。
                let action = match answer.option_id.as_deref() {
                    None | Some("accept") => "accept",
                    Some("declined") => "decline",
                    Some("cancel") => "cancel",
                    Some(other) => {
                        return Err(PylonError::Protocol(format!(
                            "elicitation action unsupported: {other}"
                        )))
                    }
                };
                let content = match (&answer.values, &answer.text) {
                    (Some(values), _) if values.is_object() => Some(values.clone()),
                    (None, Some(text)) if !text.is_empty() => {
                        Some(serde_json::json!({ "text": text }))
                    }
                    _ => None,
                };
                crate::acp::adapter::private_ext::build_elicitation_response(
                    action,
                    content.as_ref(),
                )
                .map_err(PylonError::Protocol)?
            }
        };
        let responder = { runtime.acp.lock().await.responder() };
        if !responder.respond(request_id.clone(), response).await {
            return Err(PylonError::Protocol(
                "private interaction response failed".into(),
            ));
        }
        let _ = runtime.private_interactions.take(&request_id);
        // #98：队列终态——私有桥/elicitation 应答同样 settle 并晋升下一个 waiter。
        let _ = runtime.interactions.settle(
            &request_id.to_string(),
            crate::acp::interaction_queue::InteractionTerminalReason::Answered,
        );
        return Ok(());
    }
    // 兜底：permission 应答路径（方法驱动——不再要求 provider 注册）。
    let adapter = crate::protocol_adapter::get_protocol_adapter_for_method(
        crate::acp::METHOD_SESSION_REQUEST_PERMISSION,
    )
    .ok_or_else(|| {
        PylonError::Protocol(
            "interaction response unsupported: no adapter for session/request_permission"
                .to_string(),
        )
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
/// 条目携带 `kind`（respond 必传词项）：pending_permissions 只存
/// request_permission 条目（协议适配层归一为 "approval"），故恒为该值——
/// CLI 侧透传，不自行硬编码（#36：`permission` 是漂移词项，会被门禁拒绝）。
/// #230：同时投影私有交互（elicitation / ask-user / exit-plan）——identity
/// 取 private_interactions store（respond 复核真源），options 为应答动作
/// 虚拟投影（fail-closed 白名单见 respond_interaction）。#356：私有交互与
/// pending_permissions 对等参与超时结算，deadlineMs 为真实 deadline。
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
        let pending = runtime
            .pending_permissions
            .lock()
            .map_err(|e| PylonError::Protocol(format!("pending permissions lock poisoned: {e}")))?;
        for (request_id, permission) in pending.iter() {
            items.push(serde_json::json!({
                "provider": provider,
                "agentId": agent_id,
                "kind": "approval",
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
        for (request_id, pending_private) in runtime.private_interactions.snapshot() {
            items.push(private_interaction_item(
                &provider,
                &agent_id,
                request_id,
                &pending_private,
            ));
        }
    }
    Ok(serde_json::json!({ "items": items }))
}

/// #230：CLI 投影展示文本上限——prompt 摘要截断，防超长 plan/question 撑爆列表。
const PRIVATE_PROMPT_MAX_CHARS: usize = 400;

fn truncate_prompt(text: &str) -> String {
    if text.chars().count() <= PRIVATE_PROMPT_MAX_CHARS {
        return text.to_string();
    }
    let mut truncated: String = text.chars().take(PRIVATE_PROMPT_MAX_CHARS).collect();
    truncated.push('…');
    truncated
}

/// #230：单条私有交互的 CLI 投影（identity + kind + 应答动作虚拟 options）。
fn private_interaction_item(
    provider: &str,
    agent_id: &str,
    request_id: crate::acp::RequestId,
    pending: &crate::private_interaction::PendingPrivateInteraction,
) -> serde_json::Value {
    use crate::acp::adapter::private_ext::PrivateBridge;
    let (title, prompt, tool_call_id, options) = match pending.bridge {
        PrivateBridge::Elicitation => (
            "Elicitation".to_string(),
            pending
                .params
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string(),
            String::new(),
            vec!["accept", "declined", "cancel"],
        ),
        PrivateBridge::GrokExitPlan => {
            let (plan, tool_call) =
                crate::acp::adapter::private_ext::parse_exit_plan(pending.bridge, &pending.params)
                    .unwrap_or_default();
            (
                "Exit plan".to_string(),
                plan,
                tool_call,
                vec!["approved", "abandoned", "keep_planning"],
            )
        }
        PrivateBridge::GrokExtQuestions | PrivateBridge::PiSelectAsk => {
            // 问题以 id + 题面摘要进 prompt；应答走 values（questionId → label）
            // 或 declined，options 不适用（留空 + prompt 说明）。
            let summary = pending
                .question_specs
                .as_deref()
                .unwrap_or_default()
                .iter()
                .map(|spec| format!("{}:{}", spec.id, spec.question))
                .collect::<Vec<_>>()
                .join("；");
            (
                "Ask user".to_string(),
                if summary.is_empty() {
                    pending.method.clone()
                } else {
                    summary
                },
                String::new(),
                Vec::new(),
            )
        }
    };
    serde_json::json!({
        "provider": if pending.provider.is_empty() { provider } else { &pending.provider },
        "agentId": agent_id,
        "kind": pending.queue_kind(),
        "requestId": request_id.to_string(),
        "sessionId": pending.session_id,
        "toolCallId": tool_call_id,
        "clientGeneration": pending.client_generation,
        "title": title,
        "prompt": truncate_prompt(&prompt),
        "options": options.iter().map(|option_id| serde_json::json!({
            "optionId": option_id,
        })).collect::<Vec<_>>(),
        "requestedAt": pending.enqueued_at.to_string(),
        // #356：私有交互对等参与超时结算——deadline 与权限请求同源同值。
        "deadlineMs": permission_deadline_ms(pending.enqueued_at),
    })
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
        // O37：已死 runtime 的挂起请求永久无法应答（O9 锁外发送依赖写通道，
        // 崩溃/主动停后 send 必失败、restore 后下轮 watcher 重试仍失败）——直接清空。
        // #163：判定用 is_dead（崩溃 ∨ 主动停）——被切走的 agent 同样送不达。
        let dead = runtime
            .acp
            .try_lock()
            .map(|acp| acp.is_dead())
            .unwrap_or(false);
        if dead {
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
            // #98：崩溃 = 连接已死——队列全量 drain，每个 waiter 拿到 Disconnected
            // 终态（不悬挂）。
            let _ = runtime
                .interactions
                .drain(crate::acp::interaction_queue::InteractionTerminalReason::Disconnected);
            // #316：私有交互（elicitation/ask-user）同批收敛——崩溃后 store 残留
            // 条目会在 interaction_list 里悬挂到下次 generation 替换。
            let stale_private = runtime.private_interactions.snapshot().len();
            if stale_private > 0 {
                tracing::warn!("runtime 已崩溃，清空 {stale_private} 条挂起私有交互");
            }
            runtime.private_interactions.cancel_all();
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
                    // #98：队列先以 TimedOut 终结（超时事实先于默认拒绝应答成立；
                    // resolve_pending 内部的 settle 对已终结条目幂等让位）。
                    let _ = runtime.interactions.settle(
                        &request_id.to_string(),
                        crate::acp::interaction_queue::InteractionTerminalReason::TimedOut,
                    );
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

/// #356：私有交互超时结算的 outcome（watcher 据此广播
/// `interaction.resolved{reason:"timed_out"}`）。session_id 对 request-scoped
/// elicitation 为空串（前端 settle 按 agentId+requestId+clientGeneration 关卡，
/// 与 session 无关）。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PrivateInteractionTimeoutOutcome {
    pub agent_id: String,
    pub session_id: String,
    pub request_id: RequestId,
    pub client_generation: u64,
    pub kind: String,
}

/// #356：私有交互超时的默认回包（产品裁决落在这一处）。
/// 语义基准：**超时 = 用户未应答**，回包必须取各桥的**非承诺值**——
/// - elicitation → `cancel`（用户未作答；`decline` 会断言用户明确拒绝，不成立）；
/// - grok/pi 问题桥 → 既有 declined 映射（`skip_interview` / `cancelled:true`）；
/// - exit_plan → `keep_planning`（超时绝不批准，也不代替用户放弃计划）。
///
/// 与 `pending_permissions` 的超时默认拒绝（pick_option prefer_reject）同一
/// 「不悬挂、不批准」取向。
fn private_interaction_timeout_response(
    pending: &crate::private_interaction::PendingPrivateInteraction,
) -> Result<serde_json::Value, PylonError> {
    use crate::acp::adapter::private_ext::PrivateBridge;
    match pending.bridge {
        PrivateBridge::Elicitation => {
            crate::acp::adapter::private_ext::build_elicitation_response("cancel", None)
        }
        PrivateBridge::GrokExtQuestions | PrivateBridge::PiSelectAsk => {
            let questions = pending.question_specs.clone().ok_or_else(|| {
                PylonError::Protocol("private question request lost validated specs".into())
            })?;
            crate::acp::adapter::private_ext::build_question_response(
                pending.bridge,
                &questions,
                &crate::acp::question_policy::QuestionAnswer {
                    answers: Vec::new(),
                    declined: true,
                },
            )
        }
        PrivateBridge::GrokExitPlan => Ok(crate::acp::plan_policy::approval_response(
            "keep_planning",
            "",
        )),
    }
    .map_err(PylonError::Protocol)
}

/// #356：挂起私有交互的超时检查——与 `check_pending_permission_timeouts`
/// 对等的 deadline drain + 向 agent 回包（超时前 agent 会挂等一个永不来的
/// 响应，可能阻塞其 auth/config 流程）。同一 watcher 每轮先跑权限 sweep，
/// 死亡 runtime 的 store 残留已由其死亡分支 `cancel_all` 清理，此处跳过
/// dead runtime 即可。claim 顺序与并发用户应答竞态的裁决：**take() 原子
/// 抢先**——用户应答先到则本 sweep 拿 None 跳过；本 sweep 先 take 则用户
/// 侧拿到 not found 由前端 settle（与 route_elicitation_complete 的 P2-2
/// 语义一致）。发送失败回插 pending，下轮 watcher 重试。
pub(crate) async fn check_pending_private_interaction_timeouts(
    state: &AppState,
) -> Vec<PrivateInteractionTimeoutOutcome> {
    let now = Timestamp::now();
    let mut outcomes = Vec::new();
    for (agent_id, runtime) in state.runtimes.all_with_ids() {
        let dead = runtime
            .acp
            .try_lock()
            .map(|acp| acp.is_dead())
            .unwrap_or(false);
        if dead {
            continue;
        }
        let expired: Vec<(
            RequestId,
            crate::private_interaction::PendingPrivateInteraction,
        )> = runtime
            .private_interactions
            .snapshot()
            .into_iter()
            .filter(|(_, pending)| {
                now.elapsed_since(pending.enqueued_at) > PERMISSION_REQUEST_TIMEOUT_SECS * 1000
            })
            .collect();
        // 只需要 request_id：超时判据已在 collect 的 filter 里用掉快照值，真正的
        // claim 是下面的 `take()`（它拿到的 `claimed` 才是权威值）。
        for (request_id, _) in expired {
            // take() 即原子 claim：None = 用户应答已抢先收口，跳过。
            let Some(claimed) = runtime
                .private_interactions
                .take(&request_id)
                .ok()
                .flatten()
            else {
                continue;
            };
            let kind = claimed.queue_kind().to_string();
            let response = match private_interaction_timeout_response(&claimed) {
                Ok(response) => response,
                Err(error) => {
                    tracing::error!("私有交互 {request_id} 超时应答构造失败：{error}；回插重试");
                    let _ = runtime
                        .private_interactions
                        .insert(request_id.clone(), claimed);
                    continue;
                }
            };
            let responder = { runtime.acp.lock().await.responder() };
            if !responder.respond(request_id.clone(), response).await {
                tracing::warn!("私有交互 {request_id} 超时回包发送失败；回插 pending 下轮重试");
                let _ = runtime.private_interactions.insert(request_id, claimed);
                continue;
            }
            // #98：队列 TimedOut 终结——超时事实与回包一并成立，waiter 不悬挂。
            let _ = runtime.interactions.settle(
                &request_id.to_string(),
                crate::acp::interaction_queue::InteractionTerminalReason::TimedOut,
            );
            tracing::warn!(
                "私有交互 {request_id}（{kind}）超时，已按默认动作回包（session={}）",
                claimed.session_id
            );
            outcomes.push(PrivateInteractionTimeoutOutcome {
                agent_id: agent_id.clone(),
                session_id: claimed.session_id,
                request_id,
                client_generation: claimed.client_generation,
                kind,
            });
        }
    }
    outcomes
}

#[cfg(test)]
mod tests {
    use crate::private_interaction::PendingPrivateInteraction;

    fn private_elicitation_pending() -> PendingPrivateInteraction {
        PendingPrivateInteraction {
            provider: "peri".into(),
            agent_id: "a1".into(),
            session_id: "peri-s1".into(),
            method: "elicitation/create".into(),
            bridge: crate::acp::adapter::private_ext::PrivateBridge::Elicitation,
            params: serde_json::json!({"sessionId": "peri-s1", "elicitationId": "el-1"}),
            question_specs: None,
            client_generation: 1,
            enqueued_at: crate::time::Timestamp::now(),
        }
    }

    /// #316：runtime 死亡分支必须连 private_interactions 一起清——否则崩溃后
    /// 残留条目会在 interaction_list 里悬挂到下次 generation 替换。
    #[tokio::test]
    async fn dead_runtime_clears_private_interactions() {
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_runtime("a1", crate::runtime::AgentRuntime::new_disconnected())
            .build();
        let runtime = state.runtimes.get("a1").expect("runtime 已注入");
        let request_id = crate::acp::RequestId::Number(41);
        runtime
            .private_interactions
            .insert(request_id.clone(), private_elicitation_pending())
            .expect("insert 必须成功");
        let _ = runtime
            .interactions
            .admit(crate::acp::interaction_queue::InteractionQueueEntry {
                request_id: "41".into(),
                method: "elicitation/create".into(),
                kind: "elicitation".into(),
                session_id: "peri-s1".into(),
                agent_id: "a1".into(),
                client_generation: 1,
                enqueued_at: crate::time::Timestamp::now(),
                event: serde_json::json!({}),
                state: crate::acp::interaction_queue::InteractionEntryState::Active,
            });

        // 置死：主动 stop 标记（disconnected client 的 kill 只置位、无真实子进程）。
        let _ = runtime.acp.lock().await.kill();
        assert!(runtime.acp.lock().await.is_dead());

        let outcomes = check_pending_permission_timeouts(&state).await;
        let _ = outcomes;
        assert!(
            runtime.private_interactions.snapshot().is_empty(),
            "死亡分支必须清空私有交互残留"
        );
        assert!(
            runtime
                .interactions
                .snapshot()
                .ok()
                .map(|entries| entries.is_empty())
                .unwrap_or(true),
            "统一交互队列必须全量 drain"
        );
    }

    use super::*;
    use crate::runtime::AgentRuntime;

    /// #36：interaction_list 投影 `kind` 恒为 "approval"——CLI respond 透传该
    /// 字段（不再硬编码 'permission'）；该字段被移除时此测试必红（防契约回退）。
    #[test]
    fn interaction_list_projects_kind_for_cli_respond_passthrough() {
        use tauri::Manager;
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_runtime("a1", AgentRuntime::new_disconnected())
            .build();
        state
            .runtimes
            .get("a1")
            .expect("runtime 已注入")
            .pending_permissions
            .lock()
            .expect("pending 锁必须可用")
            .insert(crate::acp::RequestId::Number(7), parsed(2));
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app must build");
        app.manage(state);
        let items = tokio::runtime::Runtime::new()
            .expect("tokio runtime")
            .block_on(interaction_list(app.state::<crate::AppState>()))
            .expect("interaction_list 必须成功");
        let item = &items["items"][0];
        assert_eq!(item["kind"], "approval");
        assert_eq!(item["requestId"], "7");
        assert_eq!(item["clientGeneration"], 2);
    }

    /// #230：私有交互（elicitation / exit-plan）投影进 interaction_list——
    /// kind 沿队列 canonical 值、identity 取 store 真源、options 为应答动作
    /// 虚拟白名单。#356：deadlineMs 为真实 deadline（对等权限请求）。
    #[test]
    fn interaction_list_projects_private_interactions_for_cli() {
        use crate::acp::adapter::private_ext::PrivateBridge;
        use crate::private_interaction::{PendingPrivateInteraction, PrivateInteractionOwner};
        let base = PendingPrivateInteraction {
            provider: String::new(),
            agent_id: "a1".into(),
            session_id: "s1".into(),
            method: "elicitation/create".into(),
            bridge: PrivateBridge::Elicitation,
            params: serde_json::json!({"sessionId": "s1", "message": "issue230 验收"}),
            question_specs: None,
            client_generation: 4,
            enqueued_at: Timestamp::now(),
        };
        let elicitation = base.clone();
        let exit_plan = PendingPrivateInteraction {
            provider: "peri".into(),
            method: "_x.ai/exit_plan_mode".into(),
            bridge: PrivateBridge::GrokExitPlan,
            params: serde_json::json!({"sessionId": "s1", "planContent": "step 1", "toolCallId": "tc-9"}),
            client_generation: 5,
            ..base
        };
        let owner = PrivateInteractionOwner::default();
        owner
            .insert(crate::acp::RequestId::Number(11), elicitation)
            .unwrap();
        owner
            .insert(crate::acp::RequestId::String("e2".into()), exit_plan)
            .unwrap();
        for (request_id, pending) in owner.snapshot() {
            let item = private_interaction_item("peri-fallback", "a1", request_id, &pending);
            let option_ids = || {
                item["options"]
                    .as_array()
                    .expect("options 数组")
                    .iter()
                    .map(|o| o["optionId"].as_str().expect("optionId"))
                    .collect::<Vec<_>>()
            };
            match pending.bridge {
                PrivateBridge::Elicitation => {
                    assert_eq!(item["kind"], "elicitation");
                    assert_eq!(item["title"], "Elicitation");
                    assert_eq!(item["prompt"], "issue230 验收");
                    // store provider 缺省时回退配置反查值。
                    assert_eq!(item["provider"], "peri-fallback");
                    assert_eq!(option_ids(), vec!["accept", "declined", "cancel"]);
                    // #356：deadline = enqueued_at + 300s（对等权限请求）。
                    assert_eq!(
                        item["deadlineMs"],
                        serde_json::json!(permission_deadline_ms(pending.enqueued_at))
                    );
                    assert_eq!(item["clientGeneration"], 4);
                }
                PrivateBridge::GrokExitPlan => {
                    assert_eq!(item["kind"], "approval");
                    assert_eq!(item["toolCallId"], "tc-9");
                    assert_eq!(item["provider"], "peri");
                    assert_eq!(item["prompt"], "step 1");
                    assert_eq!(option_ids(), vec!["approved", "abandoned", "keep_planning"]);
                    assert_eq!(item["clientGeneration"], 5);
                }
                _ => panic!("本测试只覆盖 elicitation 与 exit-plan"),
            }
        }
    }

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
    fn pick_reject_option_never_falls_back_to_first() {
        // 严格 reject：无 reject 语义项返回 None，绝不回退首个选项（评审 P1）。
        assert_eq!(
            pick_reject_option(&opts(&["allow_once", "ask_again"])),
            None
        );
        assert_eq!(
            pick_reject_option(&opts(&["allow_once", "reject_once"])),
            Some("reject_once")
        );
        // 前缀语义（reject_forever）与 kind 归一（rejectOnce）均命中。
        assert_eq!(
            pick_reject_option(&opts(&["allow_once", "reject_forever"])),
            Some("reject_forever")
        );
        assert_eq!(
            pick_reject_option(&opts_kind(&[("demand", Some("RejectOnce"))])),
            Some("demand")
        );
    }

    #[test]
    fn pick_allow_option_matches_allow_prefix_without_fallback() {
        assert_eq!(
            pick_allow_option(&opts(&["reject_once", "ask_again"])),
            None
        );
        assert_eq!(
            pick_allow_option(&opts(&["reject_once", "allow_always"])),
            Some("allow_always")
        );
        assert_eq!(
            pick_allow_option(&opts_kind(&[("ok", Some("AllowOnce"))])),
            Some("ok")
        );
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
        // A1c: SDK responder 只为真实 agent request 登记；代际拒绝保持 pending。
        let runtime = AgentRuntime::new_disconnected();
        runtime
            .pending_permissions
            .lock()
            .unwrap()
            .insert(RequestId::Number(7), parsed(1));
        assert!(!resolve_pending(&runtime, RequestId::Number(7), None, "allow_once").await);
        assert!(runtime
            .pending_permissions
            .lock()
            .unwrap()
            .contains_key(&RequestId::Number(7)));
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

    // String-id wire echo is covered by acp::engine::sdk_responder_answers_agent_request.
    /// ACP-03（§5.6）：后端唯一计时/应答——超时请求结算后返回 outcome（前端
    /// permission.resolved 事件载荷）。A1c：legacy 写通道已删除，改由真实 SDK
    /// 连接登记 Responder（fake agent 发 id=7 的 permission 请求）——应答送达才结算。
    #[tokio::test]
    async fn timeout_settles_and_reports_outcome_with_live_responder() {
        let agent = crate::test_utils::fake_acp_agent(
            "fake-acp-perm-timeout",
            &[
                "--scenario",
                "permission-proactive",
                "--permission-id",
                "7",
                "--post-init-respond",
                "--permission-params",
                r#"{"sessionId":"s1","toolCallId":"tc-1","options":[{"optionId":"allow_once"},{"optionId":"reject_once"}]}"#,
            ],
        );
        let acp = crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        // 等引擎登记 id=7 的 Responder（Pylon id = Number(7)）。
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if acp
                .backend
                .pending_requests
                .lock()
                .unwrap()
                .contains_key(&RequestId::Number(7))
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "engine must register the permission responder"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
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
        let _ = runtime.acp.lock().await.kill();
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

    /// #356：私有交互超时默认回包 = 各桥的非承诺值（超时 = 用户未应答）。
    /// 产品裁决集中在本函数——改语义只动一处。
    #[test]
    fn private_timeout_response_picks_the_non_committal_value_per_bridge() {
        use crate::acp::adapter::private_ext::PrivateBridge;
        let mut elicitation = private_elicitation_pending();
        assert_eq!(
            private_interaction_timeout_response(&elicitation).unwrap(),
            serde_json::json!({"action": "cancel"}),
            "elicitation 超时 = cancel（未作答），不得伪造 decline"
        );

        elicitation.bridge = PrivateBridge::GrokExitPlan;
        assert_eq!(
            private_interaction_timeout_response(&elicitation).unwrap(),
            serde_json::json!({"outcome": "keep_planning", "feedback": ""}),
            "exit_plan 超时 = keep_planning（不批准也不代弃）"
        );

        let mut grok = elicitation.clone();
        grok.bridge = PrivateBridge::GrokExtQuestions;
        grok.question_specs = Some(
            crate::acp::question_policy::parse_questions(&serde_json::json!({"questions": [{
                "question": "Pick", "header": "Choice",
                "options": [{"label": "A"}, {"label": "B"}]
            }]}))
            .unwrap(),
        );
        assert_eq!(
            private_interaction_timeout_response(&grok).unwrap(),
            serde_json::json!({"outcome": "skip_interview"}),
            "grok 问题桥超时 = 既有 declined 映射"
        );

        let mut pi = grok.clone();
        pi.bridge = PrivateBridge::PiSelectAsk;
        assert_eq!(
            private_interaction_timeout_response(&pi).unwrap(),
            serde_json::json!({"cancelled": true}),
            "pi 问题桥超时 = cancelled:true"
        );

        // 问题桥丢 specs 的防御分支：报错而非伪造应答。
        pi.question_specs = None;
        assert!(private_interaction_timeout_response(&pi).is_err());
    }

    /// #356：到期私有交互经真实 SDK responder 回包（fake agent 发 id=71 的
    /// 请求，引擎登记 Responder）——store 清空、队列 TimedOut、outcome 收集。
    #[tokio::test]
    async fn private_interaction_timeout_sends_cancel_and_settles_with_live_responder() {
        let agent = crate::test_utils::fake_acp_agent(
            "fake-acp-private-timeout",
            &[
                "--scenario",
                "permission-proactive",
                "--permission-id",
                "71",
                "--post-init-respond",
                "--permission-params",
                r#"{"sessionId":"s1","toolCallId":"tc-1","options":[{"optionId":"allow_once"}]}"#,
            ],
        );
        let acp = crate::acp::AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            if acp
                .backend
                .pending_requests
                .lock()
                .unwrap()
                .contains_key(&RequestId::Number(71))
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "engine must register the private interaction responder"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let runtime = AgentRuntime::new_disconnected();
        *runtime.acp.lock().await = acp;
        let agent_id = "private-timeout-agent";
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_runtime(agent_id, runtime.clone())
            .build();
        // enqueued_at 早于 300s——超时命中。
        let mut pending = private_elicitation_pending();
        pending.enqueued_at = Timestamp::new(Timestamp::now().as_u64().saturating_sub(301_000));
        runtime
            .private_interactions
            .insert(RequestId::Number(71), pending.clone())
            .unwrap();
        let _ = runtime
            .interactions
            .admit(crate::acp::interaction_queue::InteractionQueueEntry {
                request_id: "71".into(),
                method: "elicitation/create".into(),
                kind: "elicitation".into(),
                session_id: pending.session_id.clone(),
                agent_id: agent_id.into(),
                client_generation: 1,
                enqueued_at: pending.enqueued_at,
                event: serde_json::json!({}),
                state: crate::acp::interaction_queue::InteractionEntryState::Active,
            });

        let outcomes = check_pending_private_interaction_timeouts(&state).await;

        assert_eq!(outcomes.len(), 1, "到期私有交互必须结算并报告 outcome");
        let outcome = &outcomes[0];
        assert_eq!(outcome.agent_id, agent_id);
        assert_eq!(outcome.session_id, "peri-s1");
        assert_eq!(outcome.request_id, RequestId::Number(71));
        assert_eq!(outcome.kind, "elicitation");
        assert!(
            runtime.private_interactions.snapshot().is_empty(),
            "回包送达后 store 必须清空"
        );
        let entries = runtime.interactions.snapshot().expect("queue snapshot");
        assert!(
            entries.is_empty(),
            "队列条目必须被 settle 收敛（settle = 移除 + 终态返回），不残留悬挂 waiter"
        );
        let _ = runtime.acp.lock().await.kill();
    }

    /// #356：未到期不动；到期但发送失败（disconnected client）→ 条目回插
    /// 供下轮重试，队列不终结、不产出 outcome。
    #[tokio::test]
    async fn private_interaction_timeout_retains_entry_when_send_fails() {
        let runtime = AgentRuntime::new_disconnected();
        let agent_id = "private-timeout-retry-agent";
        let state = crate::test_utils::TestStateBuilder::bare()
            .with_runtime(agent_id, runtime.clone())
            .build();
        let fresh = private_elicitation_pending();
        let mut expired = private_elicitation_pending();
        expired.enqueued_at = Timestamp::new(Timestamp::now().as_u64().saturating_sub(301_000));
        runtime
            .private_interactions
            .insert(RequestId::Number(81), expired)
            .unwrap();
        runtime
            .private_interactions
            .insert(RequestId::Number(82), fresh)
            .unwrap();

        let outcomes = check_pending_private_interaction_timeouts(&state).await;

        assert!(outcomes.is_empty(), "发送失败不得产出 outcome");
        let snapshot = runtime.private_interactions.snapshot();
        assert_eq!(
            snapshot.len(),
            2,
            "未到期保留；发送失败回插重试——两条都不丢"
        );
        assert!(snapshot.iter().any(|(id, _)| *id == RequestId::Number(81)));
        assert!(snapshot.iter().any(|(id, _)| *id == RequestId::Number(82)));
    }
}
