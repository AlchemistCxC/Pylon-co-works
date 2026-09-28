//! Agent 摘要 payload 与三态激活视图推导（自 mod.rs 拆分；纯函数/std 锁同步快照，无锁语义）。
use crate::agent::runtime::AgentLifecycleStatus;
use crate::agent_config::AgentDef;
use crate::AppState;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AgentConfigActivationState {
    Stored,
    PendingRestart,
    Activated,
}

pub(crate) fn config_activation_state(
    agent: &AgentDef,
    active: bool,
    status: Option<AgentLifecycleStatus>,
    activated_fingerprint: Option<&str>,
) -> AgentConfigActivationState {
    let live = active
        && matches!(
            status,
            Some(
                AgentLifecycleStatus::Connected
                    | AgentLifecycleStatus::Connecting
                    | AgentLifecycleStatus::Reconnecting
            )
        );
    if !live {
        return AgentConfigActivationState::Stored;
    }
    match activated_fingerprint {
        Some(fingerprint) if fingerprint == agent.runtime_fingerprint() => {
            AgentConfigActivationState::Activated
        }
        Some(_) => AgentConfigActivationState::PendingRestart,
        None => AgentConfigActivationState::Stored,
    }
}

/// L7 共享判定纯函数（W4 R.6 步5，#416 W2 wave2 步骤 9；**判定逻辑 only**）：
/// ①「crashed 压过 Connected」——crashed 时有效状态强制 Crashed，否则原状态
/// 透传（None 原样保留）；②「available 只看有效 Connected」——第二返回值 =
/// 有效状态恰为 Connected。消费方 = [`agent_summary_payload_with_activation`]
/// 与 lib.rs `agent_status_payload`；两侧 json! 构造与字段序各自保留、不合并，
/// wire 输出由 lifecycle 一致性矩阵测试与逐字段断言钉住。
pub(crate) fn effective_status_and_connected(
    crashed: bool,
    status: Option<AgentLifecycleStatus>,
) -> (Option<AgentLifecycleStatus>, bool) {
    let effective_status = if crashed {
        Some(AgentLifecycleStatus::Crashed)
    } else {
        status
    };
    let effective_connected = effective_status == Some(AgentLifecycleStatus::Connected);
    (effective_status, effective_connected)
}

pub(crate) fn agent_summary_payload(
    id: &str,
    agent: &AgentDef,
    active_id: Option<&str>,
    active_status: Option<AgentLifecycleStatus>,
    crashed: bool,
) -> serde_json::Value {
    agent_summary_payload_with_activation(id, agent, active_id, active_status, crashed, None)
}

pub(crate) fn agent_summary_payload_with_activation(
    id: &str,
    agent: &AgentDef,
    active_id: Option<&str>,
    active_status: Option<AgentLifecycleStatus>,
    crashed: bool,
    activated_fingerprint: Option<&str>,
) -> serde_json::Value {
    // 方案 3（漂移修复）：统一状态推导与 agent_status_payload 一致——
    // process_crashed 时有效状态为 crashed，available 只看有效状态是否 Connected。
    // 修复前 crashed=true, available=true 的矛盾（前端状态灯误判可用）。
    // #416 W2 wave2 步骤 9：判定收敛为共享纯函数 effective_status_and_connected
    // （与 lib.rs agent_status_payload 同源）。
    let (effective_status, effective_connected) =
        effective_status_and_connected(crashed, active_status);
    let available = active_id.is_some_and(|aid| id == aid) && effective_connected;
    let active = active_id.is_some_and(|aid| id == aid);
    let activation =
        config_activation_state(agent, active, effective_status, activated_fingerprint);
    serde_json::json!({
        // list_agents 的 id 是 registry key，name 仅用于展示。
        "id": id,
        "name": agent.name,
        "provider": agent.provider,
        "transport": agent.transport,
        // 施工文档 §4.2：结构化表单需要 exe/default，list_agents 直接输出，
        // 不新增 get_agent_config 命令（避免 secret 出前端）。
        "exe": agent.exe.clone(),
        "args": agent.args.clone(),
        "effectiveArgs": agent.command_args(),
        "default": agent.default,
        "crashed": crashed,
        "available": available,
        "active": active,
        "cwd": agent.cwd.clone(),
        "configActivationState": activation,
    })
}

pub(crate) fn stored_agent_activation(
    state: &AppState,
    agent_id: &str,
) -> Option<AgentConfigActivationState> {
    let agent = state.agents.lock().ok()?.get(agent_id)?.clone();
    let active = state.active_agent.lock().ok()?.as_str() == agent_id;
    let runtime = state.runtimes.get(agent_id);
    let runtime_state = runtime
        .as_ref()
        .and_then(|runtime| runtime.agent_runtime.lock().ok().map(|state| state.clone()));
    Some(config_activation_state(
        &agent,
        active,
        runtime_state.as_ref().map(|state| state.status),
        runtime_state
            .as_ref()
            .and_then(|state| state.activated_config_fingerprint.as_deref()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #416 W2 wave2 步骤 9：wire 输出逐字段不变断言——list_agents 摘要的
    /// 完整 json! 形状（字段集合、字段序敏感的 serde_json::Map 保持插入序）
    /// 在 crashed/Connected 判定收敛到共享纯函数后逐字节不变。
    #[test]
    fn agent_summary_wire_output_is_field_for_field_stable() {
        let agent = crate::test_utils::fake_acp_agent_stub("peri");
        let fingerprint = agent.runtime_fingerprint();
        let payload = agent_summary_payload_with_activation(
            "peri",
            &agent,
            Some("peri"),
            Some(AgentLifecycleStatus::Connected),
            false,
            Some(&fingerprint),
        );
        let object = payload.as_object().expect("摘要必须是 json 对象");
        let keys: Vec<&String> = object.keys().collect();
        assert_eq!(
            keys,
            [
                "id",
                "name",
                "provider",
                "transport",
                "exe",
                "args",
                "effectiveArgs",
                "default",
                "crashed",
                "available",
                "active",
                "cwd",
                "configActivationState"
            ]
            .iter()
            .collect::<Vec<_>>(),
            "list_agents 摘要字段序不得漂移"
        );
        assert_eq!(object["id"], "peri");
        assert_eq!(object["crashed"], false);
        assert_eq!(object["available"], true);
        assert_eq!(object["active"], true);
        assert_eq!(object["configActivationState"], "activated");

        // 矩阵对角：crashed 压过 Connected——available 翻假、activation 离开
        // activated（有效状态强制 Crashed 不满足 live 门）。
        let crashed_payload = agent_summary_payload_with_activation(
            "peri",
            &agent,
            Some("peri"),
            Some(AgentLifecycleStatus::Connected),
            true,
            Some(&fingerprint),
        );
        let object = crashed_payload.as_object().expect("摘要必须是 json 对象");
        assert_eq!(object["crashed"], true);
        assert_eq!(object["available"], false);
        assert_eq!(object["active"], true);
        assert_eq!(object["configActivationState"], "stored");
    }

    /// 共享判定与 lib.rs agent_status_payload 语义参照表逐格等值
    /// （(lifecycle, crashed) → (有效状态, effective_connected)）。
    #[test]
    fn effective_status_and_connected_matches_status_payload_matrix() {
        let cases: &[(AgentLifecycleStatus, bool, AgentLifecycleStatus, bool)] = &[
            (
                AgentLifecycleStatus::Connected,
                false,
                AgentLifecycleStatus::Connected,
                true,
            ),
            (
                AgentLifecycleStatus::Connected,
                true,
                AgentLifecycleStatus::Crashed,
                false,
            ),
            (
                AgentLifecycleStatus::Reconnecting,
                false,
                AgentLifecycleStatus::Reconnecting,
                false,
            ),
            (
                AgentLifecycleStatus::Disconnected,
                false,
                AgentLifecycleStatus::Disconnected,
                false,
            ),
            (
                AgentLifecycleStatus::Crashed,
                true,
                AgentLifecycleStatus::Crashed,
                false,
            ),
        ];
        for (lifecycle, crashed, expected_status, expected_connected) in cases {
            let (status, connected) = effective_status_and_connected(*crashed, Some(*lifecycle));
            assert_eq!(
                status,
                Some(*expected_status),
                "lifecycle={lifecycle:?} crashed={crashed} 有效状态不符"
            );
            assert_eq!(connected, *expected_connected);
        }
        // None 透传（summary 侧 active_status=None 语义）。
        assert_eq!(effective_status_and_connected(false, None), (None, false));
        assert_eq!(
            effective_status_and_connected(true, None),
            (Some(AgentLifecycleStatus::Crashed), false)
        );
    }
}
