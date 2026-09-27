//! 权限请求路由缝（#317 批次二 ④ 自 mod.rs 主泵分支迁入）：B9 权限审批分支——
//! 带-id 请求委派 handle_permission_request（P1-3：provider 每次从活配置解析）；
//! 缺-id 畸形请求走可观测拒绝。分支在主泵中为纯 `continue` 语义。

use super::{
    handle_permission_request, reject_interaction_request, AcpLock, PermissionLock, SessionsLock,
};
use crate::hook_bridge::HookBridge;
use crate::runtime::AgentRuntimeManager;
use agent_client_protocol_schema::v1::ErrorCode as WireErrorCode;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

/// B9 权限审批：agent 主动 request_permission（带 id 请求，客户端必须应答）。
/// ACP-01：id 为原始 variant（number/string）——string-id agent 请求不再丢弃。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn route_permission_request<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    acp: &AcpLock,
    client_generation: &AtomicU64,
    approval_mode: &std::sync::Mutex<String>,
    pending_permissions: &PermissionLock,
    sessions: &SessionsLock,
    hook_bridge: &Arc<HookBridge>,
    runtimes: &AgentRuntimeManager,
    agents: &std::sync::Mutex<std::collections::HashMap<String, crate::agent_config::AgentDef>>,
    agent_id: &str,
    raw: crate::acp::RawMessage,
) {
    if let Some(request_id) = raw.id {
        // P1-3：provider 每次请求时从活 agents 配置解析（reload 生效）。
        let provider = agents
            .lock()
            .ok()
            .and_then(|agents| super::resolve_agent_provider(&agents, agent_id))
            .unwrap_or_else(|| "unknown".to_string());
        handle_permission_request(
            window,
            acp,
            client_generation,
            approval_mode,
            pending_permissions,
            sessions,
            hook_bridge,
            runtimes,
            &provider,
            agent_id,
            raw.method.as_deref(),
            request_id,
            raw.params.as_ref(),
        )
        .await;
    } else {
        // ACP-01：null/absent id 的 request_permission 是畸形协议请求——
        // 不静默当 0（不臆造 id 应答），记录并发出不可提交的拒绝事件。
        let provider = agents
            .lock()
            .ok()
            .and_then(|agents| super::resolve_agent_provider(&agents, agent_id))
            .unwrap_or_else(|| "unknown".to_string());
        reject_interaction_request(
            window,
            acp,
            &provider,
            agent_id,
            raw.method.as_deref(),
            None,
            raw.params.as_ref(),
            "missing_request_id",
            WireErrorCode::InvalidRequest,
            "invalid request: interaction request requires a JSON-RPC id",
        )
        .await;
    }
}
