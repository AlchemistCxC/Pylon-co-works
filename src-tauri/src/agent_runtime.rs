/// 方案 9：本地 client 代际（= runtime.client_generation 的类型化包装）。
/// 显式区分"本地 client 代际"与"远端 session 延续性"（keep_sessions 混合了两者）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClientEpoch(pub(crate) u64);

/// 方案 9：远端 session 延续性。
/// - Preserved：新 client 确认旧 session 仍有效（有真实协议能力/回放证据）；
///   **首期不构造**（需真实协议能力与运行证据，方案 §② 后置）；
/// - Invalidated：switch 不同 agent / 手动 reconnect（旧 session 大概率失效）；
/// - Unknown：自动重连（首期保持旧行为——Unknown 仍按 keep_sessions=true 迁移，
///   仅内部标记待验证 + runtime log，不进入前端 wire）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionContinuity {
    #[allow(dead_code)] // 方案 9 首期预留：需真实协议证据才启用
    Preserved,
    Invalidated,
    Unknown,
}

/// 方案 9：client 激活结果——代际 + 远端延续性语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClientActivation {
    pub(crate) epoch: ClientEpoch,
    pub(crate) continuity: SessionContinuity,
}

/// 方案 9：按连接动作推导延续性（首期只观测，不改迁移行为）。
/// auto-reconnect → Unknown（自动重连保留旧映射，语义待验证）；
/// 其他（手动 switch/reconnect/平台懒启动）→ Invalidated。
pub(crate) fn client_activation_for_action(
    current_generation: u64,
    log_action: &str,
) -> ClientActivation {
    let continuity = match log_action {
        "auto-reconnect" => SessionContinuity::Unknown,
        _ => SessionContinuity::Invalidated,
    };
    ClientActivation {
        epoch: ClientEpoch(current_generation + 1),
        continuity,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentLifecycleStatus {
    Connecting,
    Connected,
    Reconnecting,
    Crashed,
    Disconnected,
    Error,
}

impl AgentLifecycleStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connecting => "connecting",
            Self::Connected => "connected",
            Self::Reconnecting => "reconnecting",
            Self::Crashed => "crashed",
            Self::Disconnected => "disconnected",
            Self::Error => "error",
        }
    }
}

/// 自动重连：最大尝试次数（2s+4s+8s+16s+30s ≈ 60s 后放弃；2^5=32s 被 30s 封顶）
/// G2-07：默认值来源（ReconnectPolicy::default 引用），dispatcher 消费经 policy。
pub const MAX_RECONNECT_ATTEMPTS: u32 = 5;

/// G2-07：重连策略（参数化；默认值 = 现值 5 次 / 2s 基 / 30s 封顶，行为零变化）。
/// G1 `acp.reconnect.*` 配置字段落地后按 agent 解析覆盖（现无字段，恒 Default）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReconnectPolicy {
    /// 最大尝试次数（现状 5）。
    pub max_attempts: u32,
    /// 指数退避基数毫秒（现状 2000）。
    pub backoff_base_ms: u64,
    /// 退避封顶毫秒（现状 30000）。
    pub backoff_cap_ms: u64,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self {
            max_attempts: MAX_RECONNECT_ATTEMPTS,
            backoff_base_ms: 2000,
            backoff_cap_ms: 30_000,
        }
    }
}

impl ReconnectPolicy {
    /// 指数退避：attempt 从 1 开始 → 2s/4s/8s/16s/30s（2^4=32s 封顶 30s；
    /// 算法 = 2^(attempt-1)·base 封顶 cap，与旧 reconnect_backoff_ms 逐值一致——
    /// 1→2000 / 2→4000 / 3→8000 / 4→16000 / 5→30000(封顶) / 6→30000）。
    pub fn backoff_ms(&self, attempt: u32) -> u64 {
        ((1u64 << attempt.saturating_sub(1)) * self.backoff_base_ms).min(self.backoff_cap_ms)
    }
}

/// G2-07：会话槽位策略（E9 拍板 per-agent：sessions 表本就在 runtime 内，上限按
/// runtime 生效，默认 100 = 现状全局常量值；G1 `acp.max_sessions` 落地后按 agent
/// 解析覆盖）。消费：session.rs replace_session_slot / create_session_slot。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionSlotPolicy {
    pub max_sessions: usize,
}

impl Default for SessionSlotPolicy {
    fn default() -> Self {
        Self {
            max_sessions: crate::session::MAX_SESSIONS,
        }
    }
}

use crate::time::Timestamp;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRuntimeState {
    pub status: AgentLifecycleStatus,
    pub last_error: Option<String>,
    /// R4：Timestamp（wire 序列化为字符串，契约不变）。
    pub last_connected_at: Option<Timestamp>,
    /// Fingerprint of the exact AgentDef used to create the currently activated client.
    /// `None` means no live definition has ever been activated for this runtime.
    pub activated_config_fingerprint: Option<String>,
}

pub fn session_mapping_matches(
    current_peri_id: &str,
    current_generation: u64,
    expected_peri_id: &str,
    expected_generation: u64,
) -> bool {
    current_peri_id == expected_peri_id && current_generation == expected_generation
}

///
/// Peri `session/update` carries only `sessionId`. The local generation is
/// therefore part of the routing key: stale mappings from an older client
/// must not make the current mapping ambiguous, and an old-only mapping must
/// be rejected.
pub fn source_for_peri_id_in_generation<'a, I>(
    mappings: I,
    peri_id: &str,
    current_generation: u64,
) -> Option<(String, u64)>
where
    I: IntoIterator<Item = (&'a String, &'a String, u64)>,
{
    let mut matches = mappings
        .into_iter()
        .filter(|(_, mapped_peri_id, generation)| {
            mapped_peri_id.as_str() == peri_id && *generation == current_generation
        })
        .map(|(source, _, generation)| (source.clone(), generation));
    let first = matches.next()?;
    if matches.next().is_some() {
        None
    } else {
        Some(first)
    }
}

pub fn status_after_connection_failure(previous: AgentLifecycleStatus) -> AgentLifecycleStatus {
    match previous {
        AgentLifecycleStatus::Connecting | AgentLifecycleStatus::Reconnecting => {
            AgentLifecycleStatus::Disconnected
        }
        status => status,
    }
}

impl Default for AgentRuntimeState {
    fn default() -> Self {
        Self {
            status: AgentLifecycleStatus::Disconnected,
            last_error: None,
            last_connected_at: None,
            activated_config_fingerprint: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connection_failure_returns_to_disconnected_without_mutating_connected_state() {
        assert_eq!(
            status_after_connection_failure(AgentLifecycleStatus::Connecting),
            AgentLifecycleStatus::Disconnected
        );
        assert_eq!(
            status_after_connection_failure(AgentLifecycleStatus::Reconnecting),
            AgentLifecycleStatus::Disconnected
        );
        assert_eq!(
            status_after_connection_failure(AgentLifecycleStatus::Connected),
            AgentLifecycleStatus::Connected
        );
    }

    #[test]
    fn lifecycle_status_strings_are_stable() {
        assert_eq!(AgentLifecycleStatus::Connecting.as_str(), "connecting");
        assert_eq!(AgentLifecycleStatus::Connected.as_str(), "connected");
        assert_eq!(AgentLifecycleStatus::Reconnecting.as_str(), "reconnecting");
        assert_eq!(AgentLifecycleStatus::Crashed.as_str(), "crashed");
        assert_eq!(AgentLifecycleStatus::Disconnected.as_str(), "disconnected");
        assert_eq!(AgentLifecycleStatus::Error.as_str(), "error");
    }

    #[test]
    fn client_activation_continuity_maps_actions() {
        // 方案 9：auto-reconnect → Unknown（保留旧映射待验证）；
        // 手动 switch/reconnect → Invalidated。
        let auto = client_activation_for_action(7, "auto-reconnect");
        assert_eq!(auto.epoch, ClientEpoch(8));
        assert_eq!(auto.continuity, SessionContinuity::Unknown);
        for action in ["switch", "reconnect", "lazy-start"] {
            let act = client_activation_for_action(3, action);
            assert_eq!(act.epoch, ClientEpoch(4));
            assert_eq!(
                act.continuity,
                SessionContinuity::Invalidated,
                "{action} 必须标记 Invalidated"
            );
        }
    }

    #[test]
    fn client_epoch_is_distinct_from_continuity() {
        // 方案 9 核心：本地代际（u64 类型）与远端延续性（枚举）显式区分，
        // 不再由 keep_sessions 布尔混同表达。
        let epoch = ClientEpoch(5);
        assert_eq!(epoch.0, 5);
        assert_ne!(SessionContinuity::Preserved, SessionContinuity::Unknown);
        assert_ne!(SessionContinuity::Invalidated, SessionContinuity::Unknown);
    }

    #[test]
    fn runtime_state_defaults_to_disconnected_without_error() {
        let state = AgentRuntimeState::default();
        assert_eq!(state.status, AgentLifecycleStatus::Disconnected);
        assert_eq!(state.last_error, None);
        assert_eq!(state.last_connected_at, None);
        assert_eq!(state.activated_config_fingerprint, None);
    }

    #[test]
    fn reconnect_backoff_is_exponential_and_capped() {
        let policy = ReconnectPolicy::default();
        assert_eq!(policy.max_attempts, 5, "默认策略 = 现状 5 次");
        assert_eq!(policy.backoff_ms(1), 2_000);
        assert_eq!(policy.backoff_ms(2), 4_000);
        assert_eq!(policy.backoff_ms(3), 8_000);
        assert_eq!(policy.backoff_ms(5), 30_000); // 2^5=32s 封顶 30s
        assert_eq!(policy.backoff_ms(6), 30_000); // 封顶
    }

    #[test]
    fn session_slot_policy_defaults_to_current_limit() {
        assert_eq!(
            SessionSlotPolicy::default().max_sessions,
            crate::session::MAX_SESSIONS,
            "默认会话上限 = 现状常量值（E9：per-agent，每 runtime 100）"
        );
    }

    #[test]
    fn stale_generation_cannot_remove_current_session() {
        assert!(!session_mapping_matches("peri-current", 3, "peri-old", 2));
        assert!(!session_mapping_matches(
            "peri-current",
            3,
            "peri-current",
            2
        ));
    }

    #[test]
    fn duplicate_peri_id_is_rejected_as_ambiguous_in_active_generation() {
        let source_a = String::from("source-a");
        let source_b = String::from("source-b");
        let peri_id = String::from("peri-shared");
        let mappings = vec![(&source_a, &peri_id, 3), (&source_b, &peri_id, 3)];
        assert_eq!(
            source_for_peri_id_in_generation(mappings, "peri-shared", 3),
            None
        );
    }

    #[test]
    fn stale_generation_mapping_does_not_shadow_active_mapping() {
        let old_source = String::from("source-old");
        let active_source = String::from("source-active");
        let peri_id = String::from("peri-replaced");
        let mappings = vec![(&old_source, &peri_id, 2), (&active_source, &peri_id, 3)];
        assert_eq!(
            source_for_peri_id_in_generation(mappings, "peri-replaced", 3),
            Some(("source-active".into(), 3))
        );
        assert_eq!(
            source_for_peri_id_in_generation(vec![(&old_source, &peri_id, 2)], "peri-replaced", 3),
            None
        );
    }

    #[test]
    fn unique_source_resolves_one_mapping_in_active_generation() {
        let source = String::from("source-a");
        let peri_id = String::from("peri-1");
        let mappings = vec![(&source, &peri_id, 7)];
        assert_eq!(
            source_for_peri_id_in_generation(mappings, "peri-1", 7),
            Some(("source-a".into(), 7))
        );
    }

    #[test]
    fn unrelated_peri_id_does_not_resolve() {
        let source = String::from("source-a");
        let peri_id = String::from("peri-a");
        let mappings = vec![(&source, &peri_id, 1)];
        assert_eq!(
            source_for_peri_id_in_generation(mappings, "peri-b", 1),
            None
        );
    }
}
