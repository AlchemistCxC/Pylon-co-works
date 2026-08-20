//! 会话模型：SessionInfo / wire DTO / config option 纯函数。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

use serde::Serialize;
use std::collections::HashMap;

use super::{capture_session_state, DurableSessionOwner};
use crate::error::PylonError;
use crate::time::Timestamp;

#[derive(Clone)]
pub(crate) struct SessionInfo {
    pub(crate) peri_id: String,
    /// D3/Kernel ingest：本地 durable owner 的 profile 维。平台自动会话没有 UI
    /// Profile，保持 None；禁止用 active/default profile 猜测。
    pub(crate) profile_id: Option<String>,
    pub(crate) persona: String,
    pub(crate) cwd: String,
    pub(crate) has_first_prompt: bool,
    pub(crate) title: String,
    pub(crate) generation: u64,
    /// session/load 正在由 command 收集完整 replay snapshot；期间 dispatcher 只更新
    /// 后端会话状态，不向前端广播 replay 增量，避免全局事件流与 command response 双写。
    pub(crate) replay_loading: bool,
    pub(crate) mode: Option<String>,
    pub(crate) config_options: Vec<serde_json::Value>,
    pub(crate) model: String,
    pub(crate) tokens_in: u64,
    pub(crate) tokens_out: u64,
    pub(crate) tokens_total: u64,
    pub(crate) context_size: u64,
    /// 最后活动时间（B10.3b 会话超时/重置判定；R4：Timestamp，仅内部使用不落 wire）。
    pub(crate) updated_at: Option<Timestamp>,
    /// CWD-03：Workspace 实体绑定（方案 C）。Some = Session 绑定 Workspace，
    /// root 解析以 Workspace.root_path 为单一来源（workspace_root_for_context 优先分支）；
    /// None = legacy 未绑定，root 解析回退 session.cwd（兼容分支）。
    pub(crate) workspace_id: Option<String>,
    /// B11：回合计数（每次用户消息 +1；注入与完成持久化共用同一 round）。
    pub(crate) inject_round: u64,
    /// B11.2：当前正在收集的回合号——回合推进时标记为最新 inject_round，
    /// dispatcher 据此绑定流式收集（SessionInfo 无 serde derive，不落 wire/落盘）。
    pub(crate) last_response_round: u64,
    /// B11.2：当前回合 agent 回复文本（dispatcher 流式收集，完成持久化用）。
    pub(crate) last_response_text: String,
    /// 会话级可恢复状态快照（wire key -> JSON）：usage/commands 及未来状态量统一放这里。
    pub(crate) snapshots: HashMap<String, serde_json::Value>,
}

/// 方案 7：load_sessions wire DTO（替代手写 json!；wire 字段/形状逐字不变）。
/// 只暴露会话快照字段；generation/inject_round/last_response_*/updated_at 不落 wire。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionListRow {
    pub(crate) source: String,
    pub(crate) peri_id: String,
    pub(crate) persona: String,
    pub(crate) cwd: String,
    pub(crate) title: String,
    pub(crate) mode: Option<String>,
    pub(crate) config_options: Vec<serde_json::Value>,
    pub(crate) model: String,
    pub(crate) tokens_in: u64,
    pub(crate) tokens_out: u64,
    pub(crate) tokens_total: u64,
    pub(crate) context_size: u64,
}

/// 方案 7：inspector session 行 wire DTO（替代手写 json!；形状逐字不变）。
/// 含 agentId（跨 runtime 区分来源）；不含 persona/config_options/generation。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InspectorSessionRow {
    pub(crate) agent_id: String,
    pub(crate) source: String,
    pub(crate) peri_id: String,
    pub(crate) title: String,
    pub(crate) model: String,
    pub(crate) mode: Option<String>,
    pub(crate) tokens_in: u64,
    pub(crate) tokens_out: u64,
    pub(crate) tokens_total: u64,
    pub(crate) context_size: u64,
    pub(crate) cwd: String,
}

impl SessionInfo {
    pub(crate) fn new(
        peri_id: String,
        persona: String,
        cwd: String,
        has_first_prompt: bool,
        generation: u64,
    ) -> Self {
        Self {
            peri_id,
            profile_id: None,
            persona,
            cwd,
            has_first_prompt,
            title: String::new(),
            generation,
            replay_loading: false,
            mode: None,
            config_options: Vec::new(),
            model: String::new(),
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            context_size: 0,
            updated_at: Some(Timestamp::now()),
            workspace_id: None,
            inject_round: 0,
            last_response_round: 0,
            last_response_text: String::new(),
            snapshots: HashMap::new(),
        }
    }

    pub(crate) fn apply_session_response(&mut self, response: &serde_json::Value) {
        if let Some(options) = response
            .get("configOptions")
            .and_then(|value| value.as_array())
        {
            self.config_options = options.clone();
            self.apply_config_options(options);
        }
        self.mode = response
            .get("modes")
            .and_then(|modes| {
                modes
                    .get("currentModeId")
                    .or_else(|| modes.get("currentMode"))
                    .or_else(|| modes.get("current"))
            })
            .and_then(value_as_string)
            .or_else(|| {
                find_config_option(&self.config_options, "mode")
                    .and_then(config_option_current_value)
            });
        if let Some(usage) = response
            .get("usage")
            .or_else(|| {
                response
                    .get("sessionInfo")
                    .and_then(|info| info.get("usage"))
            })
            .cloned()
        {
            self.snapshots.insert("usage".to_string(), usage);
        }
        capture_session_state(self, response);
    }

    pub(crate) fn apply_config_options(&mut self, options: &[serde_json::Value]) {
        if let Some(model) =
            find_config_option(options, "model").and_then(config_option_current_value)
        {
            self.model = model;
        }
        if let Some(mode) =
            find_config_option(options, "mode").and_then(config_option_current_value)
        {
            self.mode = Some(mode);
        }
    }

    /// 将 GUI Profile 绑定到 runtime session。第一次绑定与相同 owner 的重复请求
    /// 都是幂等操作；已经绑定后禁止换 Profile，避免同一 source 的事件写入另一条
    /// canonical journal。平台自动会话传 None，保持没有 UI owner 的事实。
    pub(crate) fn attach_profile_id(
        &mut self,
        requested_profile_id: Option<&str>,
        source: &str,
    ) -> Result<(), PylonError> {
        let Some(requested_profile_id) = requested_profile_id else {
            return Ok(());
        };
        if self
            .profile_id
            .as_deref()
            .is_some_and(|current| current != requested_profile_id)
        {
            return Err(PylonError::Protocol(format!(
                "session owner profile mismatch for source {source}"
            )));
        }
        self.profile_id = Some(requested_profile_id.to_string());
        Ok(())
    }

    /// 只有已绑定 GUI Profile 的 runtime session 才能证明完整 durable owner。
    /// 返回 None 表示平台自动会话，调用方不得以 active/default profile 补齐。
    pub(crate) fn durable_owner(
        &self,
        agent_id: &str,
        source: &str,
    ) -> Result<Option<DurableSessionOwner>, PylonError> {
        let Some(profile_id) = self.profile_id.as_deref() else {
            return Ok(None);
        };
        let owner = DurableSessionOwner::new(profile_id, agent_id, source);
        owner.validate()?;
        Ok(Some(owner))
    }

    /// B11.2：流式收集当前回合回复文本（完成持久化 POST /persist 用）。
    /// 回合绑定：仅当 ① 收集标记回合 == 当前回合（标记未过期），且 ② chunk
    /// 的接收回合 == 当前回合（事件接收后回合未推进）才追加——Round N 迟到
    /// chunk 在 Round N+1 推进（clear）之后才被 dispatcher 追加 → 丢弃，防
    /// 跨回合污染 persist 落库。
    /// 上限 64KB 截断防超长回复撑爆内存；截断必须落在字符边界
    /// （String::truncate 在非边界处 panic，会 poison sessions 锁）。
    pub(crate) fn collect_response_chunk(&mut self, text: &str, received_round: u64) {
        if self.last_response_round != self.inject_round {
            return;
        }
        if received_round != self.inject_round {
            return;
        }
        self.last_response_text.push_str(text);
        if self.last_response_text.len() > 64 * 1024 {
            let mut end = 64 * 1024;
            while end > 0 && !self.last_response_text.is_char_boundary(end) {
                end -= 1;
            }
            self.last_response_text.truncate(end);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> SessionInfo {
        SessionInfo::new(
            "remote-1".to_string(),
            String::new(),
            "C:/workspace".to_string(),
            false,
            1,
        )
    }

    #[test]
    fn profile_binding_is_idempotent_but_cannot_change_owner() {
        let mut session = session();
        session.attach_profile_id(None, "local-1").unwrap();
        assert_eq!(session.profile_id, None);

        session
            .attach_profile_id(Some("profile-1"), "local-1")
            .unwrap();
        session
            .attach_profile_id(Some("profile-1"), "local-1")
            .unwrap();
        let error = session
            .attach_profile_id(Some("profile-2"), "local-1")
            .unwrap_err();

        assert!(error.to_string().contains("owner profile mismatch"));
        assert_eq!(session.profile_id.as_deref(), Some("profile-1"));
    }

    #[test]
    fn durable_owner_requires_a_proven_profile_binding() {
        let mut session = session();
        assert!(session
            .durable_owner("agent-1", "local-1")
            .unwrap()
            .is_none());

        session
            .attach_profile_id(Some("profile-1"), "local-1")
            .unwrap();
        let owner = session
            .durable_owner("agent-1", "local-1")
            .unwrap()
            .unwrap();

        assert_eq!(owner.profile_id, "profile-1");
        assert_eq!(owner.agent_id, "agent-1");
        assert_eq!(owner.local_session_id, "local-1");
    }
}

pub(crate) fn value_as_string(value: &serde_json::Value) -> Option<String> {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .or_else(|| {
            value
                .get("value")
                .and_then(|nested| nested.as_str())
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            value
                .get("valueId")
                .and_then(|nested| nested.get("value"))
                .and_then(|nested| nested.as_str())
                .map(ToOwned::to_owned)
        })
}

pub(crate) fn find_config_option<'a>(
    options: &'a [serde_json::Value],
    key: &str,
) -> Option<&'a serde_json::Value> {
    options.iter().find(|option| {
        option
            .get("id")
            .or_else(|| option.get("key"))
            .or_else(|| option.get("name"))
            .and_then(|value| value.as_str())
            == Some(key)
    })
}

pub(crate) fn config_option_current_value(option: &serde_json::Value) -> Option<String> {
    option
        .get("currentValue")
        .and_then(value_as_string)
        .or_else(|| option.get("value").and_then(value_as_string))
        .or_else(|| option.get("current").and_then(value_as_string))
        .or_else(|| option.get("selected").and_then(value_as_string))
}
