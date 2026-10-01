//! 权限请求的挂起登记面（#486 项3 自 handle_permission_request 拆出；行为不变）。
//!
//! #423：登记面单点——store 写 + queue admit（deadline 注入）+ 事件 json 构造一次
//! 完成（#98：队列是 cancel/timeout/disconnect drain 终态与冷挂载快照的数据源；
//! kind = "approval"，事件载荷与 pylon:interaction 同构）。

use crate::emit_event;
use crate::permission::PendingPermission;
use crate::runtime::AgentRuntimeManager;

/// pending 权限登记（default/edit 模式路径）。语句次序与拆分前逐字一致。
pub(super) fn admit_pending_permission<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    runtimes: &AgentRuntimeManager,
    provider: &str,
    agent_id: &str,
    request_id: &crate::acp::RequestId,
    effective_permission: &PendingPermission,
) {
    if let Some(runtime) = runtimes.get(agent_id) {
        match runtime
            .ledger
            .admit_permission(provider, agent_id, request_id, effective_permission)
        {
            Ok((admission, interaction_event)) => {
                let (_, waiting) = runtime.ledger.queue().depth().unwrap_or((None, 0));
                tracing::trace!(
                    agent_id = %agent_id,
                    request_id = %request_id,
                    promoted = matches!(admission, crate::acp::interaction_queue::AdmissionOutcome::Promoted),
                    waiting,
                    "interaction queue admitted permission request"
                );
                emit_event(window, crate::event_names::INTERACTION, interaction_event);
            }
            Err(error) => tracing::warn!("interaction queue admit failed: {error}"),
        }
    } else {
        // runtime 缺席（结构性不可达：泵存活期 runtime 必在 manager）——
        // 整体不登记（store 与 queue 恒一致，杜绝单边写入）。
        tracing::warn!(
            agent_id = %agent_id,
            request_id = %request_id,
            "permission admit skipped: runtime not found"
        );
    }
}
