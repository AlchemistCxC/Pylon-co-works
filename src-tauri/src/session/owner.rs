//! OWNER-01：AgentSessionOwner contract（方案书 §5.8 / LONG-RUN-PLAN M2 首卡）。
//!
//! OwnerKey = profileId + agentId + localSessionId（localSessionId 即会话 source）。
//! BindingKey = OwnerKey + remoteSessionId(peri_id) + clientGeneration。
//!
//! A 版契约（codebase 现状勘察实证）：
//!   - source 只在单个 Agent runtime 内唯一（runtime.rs `AgentContextKey` doc）；
//!     sessions 映射键 = source，agent 维度 = 所属 runtime 的注册键（agent_id）。
//!   - `profile_id` 为**声明维**：codebase 无权威 profile 注册表——`AgentDef.hermes_profile`
//!     是 per-agent Hermes 环境注入（与所有权命名空间无关）、前端 `Profile.id` 是 UI
//!     persona 配置、gateway `binding.profile_id` 仅序列化展示。故 A 版只携带不校验，
//!     校验语义待 profile 注册表建立（后续工单决策）。当前保留在 key 中是为了
//!     OwnerKey/BindingKey 完整性（规范明文维度）。
//!   - 反向查找（source → owner runtime）的 ACP-05 `find_runtime_for_source` 已在
//!     OWNER-02 移除——双 Agent 同名 source 时无法确定归属；本模块提供**正向**
//!     （owner → runtime）解析原语——显式 agentId 路由，杜绝"双 Agent 同名 source
//!     串线"（§8.1 验收）。
//!
//! 错误语义（§5.8）：
//!   - owner runtime 不存在（agent 未配置/未启动/未知）→ `AgentRuntimeUnavailable`
//!     （**禁止** fallback 到另一个 active runtime）；
//!   - runtime 存在但无该 source 会话 → `SessionNotFound`。
//!
//! 本卡只交付契约与解析原语（+ 测试）；命令层逐卡迁移（OWNER-02 起）才切换路由，
//! 在此之前整个契约 API 是"预备契约"——dead_code 属预期，模块级 allow 统一豁免。

#![allow(dead_code)]

use std::sync::Arc;

use crate::error::PylonError;
use crate::runtime::{AgentContextKey, AgentRuntime, AgentRuntimeManager};

/// SQLite durable identity. Unlike [`SessionOwner`], all three dimensions are
/// required because persisted state must never be recovered by remote ACP id or
/// by a source that is only unique inside one runtime.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DurableSessionOwner {
    pub(crate) profile_id: String,
    pub(crate) agent_id: String,
    pub(crate) local_session_id: String,
}

impl DurableSessionOwner {
    pub(crate) fn new(
        profile_id: impl Into<String>,
        agent_id: impl Into<String>,
        local_session_id: impl Into<String>,
    ) -> Self {
        Self {
            profile_id: profile_id.into(),
            agent_id: agent_id.into(),
            local_session_id: local_session_id.into(),
        }
    }

    pub(crate) fn validate(&self) -> Result<(), PylonError> {
        for (field, value) in [
            ("profileId", self.profile_id.as_str()),
            ("agentId", self.agent_id.as_str()),
            ("localSessionId", self.local_session_id.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(PylonError::from(format!(
                    "durable session owner {field} must be non-empty"
                )));
            }
        }
        Ok(())
    }

    pub(crate) fn key(&self) -> Result<String, PylonError> {
        self.validate()?;
        serde_json::to_string(&[
            self.profile_id.as_str(),
            self.agent_id.as_str(),
            self.local_session_id.as_str(),
        ])
        .map_err(PylonError::from)
    }
}

/// A 版 OwnerKey：agentId + source（localSessionId）必填；profileId 可选声明维
/// （语义见模块 doc）。`as_context_key()` 与既有 `AgentContextKey`（runtime.rs）互转。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub(crate) struct SessionOwner {
    pub(crate) agent_id: String,
    pub(crate) source: String,
    pub(crate) profile_id: Option<String>,
}

impl SessionOwner {
    pub(crate) fn new(agent_id: impl Into<String>, source: impl Into<String>) -> Self {
        Self {
            agent_id: agent_id.into(),
            source: source.into(),
            profile_id: None,
        }
    }

    /// 携带声明维 profile_id（A 版不校验，仅保留在 OwnerKey 中）。
    pub(crate) fn with_profile(mut self, profile_id: Option<String>) -> Self {
        self.profile_id = profile_id;
        self
    }

    /// 降级为既有 AgentContextKey（owner → context 单向，禁止反方向补 agentId）。
    pub(crate) fn as_context_key(&self) -> AgentContextKey {
        AgentContextKey::new(self.agent_id.clone(), self.source.clone())
    }
}

impl std::fmt::Display for SessionOwner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 日志形态：不拼 `a:b:c`（source 可含冒号），括号化字段避免歧义。
        match &self.profile_id {
            Some(profile) => write!(
                f,
                "owner[profile={profile}, agent={}, source={}]",
                self.agent_id, self.source
            ),
            None => write!(f, "owner[agent={}, source={}]", self.agent_id, self.source),
        }
    }
}

/// OWNER-02：按 agentId 解析 owner runtime——只要求 agent runtime 存在，**不要求会话已存在**。
///
/// send_message / new_session / load_persisted_session / export_session 等"创建或恢复
/// 会话"路径使用（路由时刻会话可能尚不存在）；`agent_runtime_unavailable` 语义与
/// [`resolve_owner_runtime`] 一致（不存在 owner runtime 即失败，禁止 fallback active）。
pub(crate) fn resolve_agent_runtime(
    runtimes: &AgentRuntimeManager,
    agent_id: &str,
) -> Result<Arc<AgentRuntime>, PylonError> {
    runtimes
        .get(agent_id)
        .ok_or_else(|| PylonError::AgentRuntimeUnavailable {
            agent_id: agent_id.to_string(),
        })
}

/// 正向 owner 解析（§5.8）：显式 agentId 路由到 owner runtime。
///
/// 解析顺序（任一失败即返回，绝不做 active runtime fallback）：
/// 1. runtime 不存在 → `AgentRuntimeUnavailable`；
/// 2. runtime 内无该 source 会话 → `SessionNotFound`。
///
/// 锁序：只短持 `sessions` 锁（guard 在 `contains_key` 后即释放），无嵌套锁。
pub(crate) fn resolve_owner_runtime(
    runtimes: &AgentRuntimeManager,
    owner: &SessionOwner,
) -> Result<Arc<AgentRuntime>, PylonError> {
    let runtime = resolve_agent_runtime(runtimes, &owner.agent_id)?;
    let has_session = runtime
        .sessions
        .lock()
        .map_err(|e| PylonError::Protocol(e.to_string()))?
        .contains_key(&owner.source);
    if !has_session {
        return Err(PylonError::SessionNotFound(owner.source.clone()));
    }
    Ok(runtime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::AgentRuntime;
    use crate::session::SessionInfo;
    use crate::test_utils::TestStateBuilder;

    fn session_source(runtime: &AgentRuntime, source: &str, peri_id: &str) {
        runtime.sessions.lock().unwrap().insert(
            source.to_string(),
            SessionInfo::new(peri_id.to_string(), "persona".into(), ".".into(), true, 0),
        );
    }

    #[test]
    fn durable_owner_key_matches_canonical_journal_encoding() {
        let owner = DurableSessionOwner::new("p1", "peri", "local:一");
        assert_eq!(owner.key().expect("key"), r#"["p1","peri","local:一"]"#);
        assert!(DurableSessionOwner::new("", "peri", "local").key().is_err());
    }

    /// §8.1 验收：双 Agent 同名 source 不串线——显式 agentId 路由到各自 owner runtime。
    #[tokio::test]
    async fn same_source_in_two_runtimes_routes_to_owner() {
        let peri = AgentRuntime::new_disconnected();
        let hermes = AgentRuntime::new_disconnected();
        let state = TestStateBuilder::bare()
            .with_runtime("peri", peri.clone())
            .with_runtime("hermes", hermes.clone())
            .with_active_agent("peri")
            .build();
        // 同名 source：两个 runtime 各持有（互不串扰的极端情形）。
        session_source(&peri, "shared-source", "peri-sess-1");
        session_source(&hermes, "shared-source", "hermes-sess-1");

        let owner_peri = SessionOwner::new("peri", "shared-source");
        let owner_hermes = SessionOwner::new("hermes", "shared-source");
        let resolved_peri = resolve_owner_runtime(&state.runtimes, &owner_peri).unwrap();
        let resolved_hermes = resolve_owner_runtime(&state.runtimes, &owner_hermes).unwrap();
        assert!(
            Arc::ptr_eq(&resolved_peri, &peri),
            "peri owner 必须解析到 peri runtime"
        );
        assert!(
            Arc::ptr_eq(&resolved_hermes, &hermes),
            "hermes owner 必须解析到 hermes runtime"
        );
        assert!(
            !Arc::ptr_eq(&resolved_peri, &resolved_hermes),
            "两个 owner 必须互不串线"
        );
    }

    /// §5.8：owner runtime 不存在 → agent_runtime_unavailable（禁止 fallback active）。
    #[tokio::test]
    async fn unknown_agent_returns_agent_runtime_unavailable() {
        let state = TestStateBuilder::bare()
            .with_runtime("peri", AgentRuntime::new_disconnected())
            .with_active_agent("peri")
            .build();
        session_source(
            &state.runtimes.get("peri").unwrap(),
            "shared-source",
            "peri-sess-1",
        );
        let err = resolve_owner_runtime(
            &state.runtimes,
            &SessionOwner::new("ghost-agent", "shared-source"),
        )
        .err()
        .expect("未知 agent 必须解析失败");
        assert_eq!(err.code(), "agent_runtime_unavailable");
        // 即使 active runtime 存在同名 source，也必须报 unavailable 而非静默路由。
        assert!(err.to_string().contains("ghost-agent"));
    }

    /// runtime 存在但无该 source 会话 → session_not_found。
    #[tokio::test]
    async fn missing_session_returns_session_not_found() {
        let state = TestStateBuilder::bare()
            .with_runtime("peri", AgentRuntime::new_disconnected())
            .with_active_agent("peri")
            .build();
        let err = resolve_owner_runtime(
            &state.runtimes,
            &SessionOwner::new("peri", "no-such-source"),
        )
        .err()
        .expect("缺失会话必须解析失败");
        assert_eq!(err.code(), "session_not_found");
    }

    /// OWNER-02：resolve_agent_runtime 不要求会话存在（send_message/new_session 等
    /// 创建路径）；未知 agent 仍返回 agent_runtime_unavailable（禁止 fallback）。
    #[tokio::test]
    async fn resolve_agent_runtime_skips_session_existence_check() {
        let peri = AgentRuntime::new_disconnected();
        let state = TestStateBuilder::bare()
            .with_runtime("peri", peri.clone())
            .with_runtime("hermes", AgentRuntime::new_disconnected())
            .with_active_agent("peri")
            .build();
        // 无任何会话（send_message 自动创建前状态）：owner 解析仍成功，且路由到 peri runtime。
        let resolved = resolve_agent_runtime(&state.runtimes, "peri").unwrap();
        assert!(Arc::ptr_eq(&resolved, &peri));
        // 未知 agent → agent_runtime_unavailable（绝不 fallback 到存在同名 source 的 active）。
        let err = resolve_agent_runtime(&state.runtimes, "ghost-agent")
            .err()
            .expect("未知 agent 必须解析失败");
        assert_eq!(err.code(), "agent_runtime_unavailable");
        assert!(err.to_string().contains("ghost-agent"));
    }

    /// as_context_key 与既有 AgentContextKey 一致（owner → context 单向）。
    #[test]
    fn owner_to_context_key_roundtrip() {
        let owner = SessionOwner::new("peri", "src").with_profile(Some("p-a".to_string()));
        let key = owner.as_context_key();
        assert_eq!(key.agent_id, "peri");
        assert_eq!(key.source, "src");
    }
}
