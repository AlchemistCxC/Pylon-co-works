//! 会话模型：SessionInfo / wire DTO / config option 纯函数。
//! 方案 11 机械拆分自 session/mod.rs（纯搬移，行为零变化）。

use serde::Serialize;
use std::collections::HashMap;

use super::{capture_session_state, DurableSessionOwner};
use crate::agent_config::SetModelApi;
use crate::error::PylonError;
use crate::time::Timestamp;

/// P56/D1：会话模型切换宣告面——由 session/new、session/load 响应形状自适应判定
/// （Pylon 是通用 ACP GUI：不绑定 hermes，按响应形状选通道）。
/// - `ConfigOption`：ACP 1.4 标准通道（configOptions 中 category=="model" 的选项，
///   config_id 用宣告值回写 session/set_config_option）。
/// - `ModelsState`：hermes 等扩展通道（`models.availableModels` 非空，原样回发
///   modelId 走 unstable session/set_model；`provider:model` 编码不解析、只回发）。
/// - `None`：未宣告任何模型面——会话模型只读，禁止发切换 RPC。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ModelSurface {
    ConfigOption { config_id: String },
    ModelsState,
    None,
}

/// P56/D1：一次响应形状判定的完整结果（面 + 宣告的 machine id 集合，两通道通用）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModelSurfaceInfo {
    pub(crate) surface: ModelSurface,
    pub(crate) choices: Vec<String>,
}

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
    /// P56/D1：模型切换通道宣告面（apply_session_response / apply_config_options
    /// 全量数组分支刷新）；set_config_option 的 model 键按此路由（显式 set_model_api
    /// 声明优先，见 control.rs）。
    pub(crate) model_surface: ModelSurface,
    /// P56/D1：宣告的 model machine id 集合（发送不变量：任何上 wire 的模型值必须
    /// ∈ 本集合；空集合 = 会话未宣告可校验列表，跳过校验放行现状行为）。
    pub(crate) model_choices: Vec<String>,
    pub(crate) tokens_in: u64,
    pub(crate) tokens_out: u64,
    pub(crate) tokens_total: u64,
    pub(crate) context_size: u64,
    /// 最后活动时间（B10.3b 会话超时/重置判定；R4：Timestamp，仅内部使用不落 wire）。
    pub(crate) updated_at: Option<Timestamp>,
    /// R-t5 liveness：本会话最近一次收到 ACP 活动信号（文本/思考/工具/usage 任一）
    /// 的单调时刻。dispatcher 每次处理 session/update 刷新；prompt 等待据此做
    /// "闲置超时"判定（活动即续命）。不落 wire / 不序列化。
    pub(crate) last_activity: Option<std::time::Instant>,
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
    /// 会话级可恢复状态快照（wire key -> JSON）：usage/commands/mode 及未来状态量统一放这里。
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
            model_surface: ModelSurface::None,
            model_choices: Vec::new(),
            tokens_in: 0,
            tokens_out: 0,
            tokens_total: 0,
            context_size: 0,
            updated_at: Some(Timestamp::now()),
            last_activity: None,
            workspace_id: None,
            inject_round: 0,
            last_response_round: 0,
            last_response_text: String::new(),
            snapshots: HashMap::new(),
        }
    }

    pub(crate) fn apply_session_response(&mut self, response: &serde_json::Value) {
        // P56/D1.6：空回声保护——响应 configOptions 为空数组且本地非空时不覆盖本地
        // （全量数组分支；与 control.rs 写回分支同一契约）。
        let mut effective_options: Vec<serde_json::Value> = self.config_options.clone();
        if let Some(options) = response
            .get("configOptions")
            .or_else(|| response.get("config_options"))
            .and_then(|value| value.as_array())
        {
            if !(options.is_empty() && !self.config_options.is_empty()) {
                self.config_options = options.clone();
            }
            effective_options = self.config_options.clone();
            self.apply_config_options(&effective_options);
        }
        // ACP 1.4 and Hermes expose the selected model in different places.
        // Prefer the standard `models.currentModelId` state when present, then
        // retain the config-option fallback handled above.  P56/D2：model 的
        // current 提取用 machine-id-only 变体（name/label 显示名不得当 id）。
        if let Some(model) = response
            .get("models")
            .and_then(|models| {
                models
                    .get("currentModelId")
                    .or_else(|| models.get("current_model_id"))
                    .or_else(|| models.get("currentModel"))
                    .or_else(|| models.get("current_model"))
                    .or_else(|| models.get("current"))
            })
            .and_then(value_as_machine_id)
        {
            self.model = model;
        } else if let Some(model) = response
            .get("modelId")
            .or_else(|| response.get("model_id"))
            .or_else(|| response.get("model"))
            .and_then(value_as_machine_id)
        {
            self.model = model;
        }
        self.mode = response
            .get("modes")
            .and_then(|modes| {
                modes
                    .get("currentModeId")
                    .or_else(|| modes.get("current_mode_id"))
                    .or_else(|| modes.get("currentMode"))
                    .or_else(|| modes.get("current_mode"))
                    .or_else(|| modes.get("current"))
            })
            .and_then(value_as_string)
            .or_else(|| {
                find_config_option(&effective_options, "mode")
                    .and_then(config_option_current_value)
            })
            .or_else(|| {
                response
                    .get("modeId")
                    .or_else(|| response.get("mode_id"))
                    .or_else(|| response.get("mode"))
                    .and_then(value_as_string)
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
        // P56/D1.2：按响应形状刷新模型面（configOptions 优先，models.availableModels
        // 兜底，都没有 → None 只读）。
        let info = determine_model_surface(&effective_options, response.get("models"));
        self.model_surface = info.surface;
        self.model_choices = info.choices;
        capture_session_state(self, response);
    }

    pub(crate) fn apply_config_options(&mut self, options: &[serde_json::Value]) {
        if let Some(model) =
            find_config_option(options, "model").and_then(config_option_current_machine_id)
        {
            self.model = model;
        }
        if let Some(mode) =
            find_config_option(options, "mode").and_then(config_option_current_value)
        {
            self.mode = Some(mode);
        }
        // P56/D1.2：全量数组分支刷新模型面。仅当本数组实际宣告了可寻址的 model
        // 选项才切到 ConfigOption 面；未宣告时不据此降级既有 ModelsState（models
        // 状态与 configOptions 是两个独立宣告面），只把失效的 ConfigOption 面降级
        // 为 None。
        if let Some(option) = find_config_option(options, "model") {
            if let Some(config_id) = config_option_identity(option) {
                self.model_surface = ModelSurface::ConfigOption { config_id };
                self.model_choices = config_option_choice_ids(option);
                return;
            }
        }
        if matches!(self.model_surface, ModelSurface::ConfigOption { .. }) {
            self.model_surface = ModelSurface::None;
            self.model_choices = Vec::new();
        }
    }

    /// P56/D1.6：set_config_option 响应写回。响应含非空 configOptions → 权威全量
    /// 覆盖（含 model/mode current 提取）；configOptions 为空数组且本地非空 →
    /// 空回声保护（hermes set_config_option 恒空回声，不得清空本地宣告）；其余 →
    /// 语义键乐观写回（切换响应未给权威状态时保留乐观语义）。
    pub(crate) fn apply_config_option_response(
        &mut self,
        response: &serde_json::Value,
        key: &str,
        value: &serde_json::Value,
    ) {
        let mut authoritative = false;
        if let Some(options) = response.get("configOptions").and_then(|value| value.as_array()) {
            if !(options.is_empty() && !self.config_options.is_empty()) {
                self.config_options = options.clone();
                self.apply_config_options(options);
                authoritative = true;
            }
        }
        if authoritative {
            return;
        }
        match key {
            "model" => {
                if let Some(value) = value.as_str() {
                    self.model = value.to_string();
                }
            }
            "mode" => {
                if let Some(value) = value.as_str() {
                    self.mode = Some(value.to_string());
                }
            }
            _ => {}
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

    // ── P56/D1：模型面判定（三态 × camelCase/snake_case）──

    #[test]
    fn model_surface_detects_config_option_channel_with_category_first() {
        // 标准 ACP 形态：category=="model" 的选项胜出；description 含 "model" 的
        // 干扰选项不得胜出（验收 3）。
        let response = serde_json::json!({
            "configOptions": [
                {
                    "id": "reasoning-effort",
                    "description": "Reasoning effort for the model",
                    "category": "thought_level",
                    "options": [{"valueId": "low", "name": "Low"}],
                    "currentValue": "low"
                },
                {
                    "id": "model-selection",
                    "category": "model",
                    "options": [{"valueId": "m-1", "name": "Model One"}],
                    "currentValue": "m-1"
                }
            ]
        });
        let info = determine_model_surface(
            response.get("configOptions").and_then(|v| v.as_array()).unwrap(),
            None,
        );
        assert_eq!(
            info.surface,
            ModelSurface::ConfigOption {
                config_id: "model-selection".to_string()
            }
        );
        assert_eq!(info.choices, vec!["m-1".to_string()]);
    }

    #[test]
    fn model_surface_falls_back_to_token_equality_without_category() {
        // review 修复（架构师）：fixture id 必须落在语义别名表（model/models/model_id/
        // modelid/model_selection）内——"model_selector" 不在表中，精确相等判据下不命中。
        let options = vec![serde_json::json!({
            "id": "model_selection",
            "options": [{"valueId": "a"}, {"valueId": "b"}],
            "currentValue": "a"
        })];
        let info = determine_model_surface(&options, None);
        assert_eq!(
            info.surface,
            ModelSurface::ConfigOption {
                config_id: "model_selection".to_string()
            }
        );
        assert_eq!(info.choices, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn model_surface_detects_hermes_models_state_in_camel_and_snake() {
        // hermes 形态（验收 1）：无 configOptions，models.availableModels 为
        // `provider:model` 编码 id——只收集 machine id，不解析编码。
        let camel = serde_json::json!({
            "models": {
                "availableModels": [
                    {"modelId": "nous:hermes-4", "name": "Nous · hermes-4"},
                    {"name": "display-only is dropped"}
                ],
                "currentModelId": "nous:hermes-4"
            }
        });
        let info = determine_model_surface(&[], camel.get("models"));
        assert_eq!(info.surface, ModelSurface::ModelsState);
        assert_eq!(info.choices, vec!["nous:hermes-4".to_string()]);

        let snake = serde_json::json!({
            "models": {
                "available_models": [
                    {"model_id": "nous:hermes-4", "name": "Nous · hermes-4"}
                ],
                "current_model_id": "nous:hermes-4"
            }
        });
        let info = determine_model_surface(&[], snake.get("models"));
        assert_eq!(info.surface, ModelSurface::ModelsState);
        assert_eq!(info.choices, vec!["nous:hermes-4".to_string()]);
    }

    #[test]
    fn model_surface_is_none_without_any_advertisement() {
        let info = determine_model_surface(&[], None);
        assert_eq!(info.surface, ModelSurface::None);
        assert!(info.choices.is_empty());
        let empty_models = serde_json::json!({"availableModels": []});
        let info = determine_model_surface(&[], Some(&empty_models));
        assert_eq!(info.surface, ModelSurface::None);
    }

    #[test]
    fn apply_session_response_tracks_surface_and_choices() {
        // 验收 1 后端侧：hermes fixture 的宣告 choices 进入 model_choices。
        let mut hermes = session();
        hermes.apply_session_response(&serde_json::json!({
            "sessionId": "s1",
            "models": {
                "availableModels": [{"modelId": "nous:hermes-4", "name": "Nous · hermes-4"}],
                "currentModelId": "nous:hermes-4"
            }
        }));
        assert_eq!(hermes.model, "nous:hermes-4");
        assert_eq!(hermes.model_surface, ModelSurface::ModelsState);
        assert_eq!(hermes.model_choices, vec!["nous:hermes-4".to_string()]);

        // 显示名-only 的 current 不得进入 typed 字段（machine-id-only）。
        let mut fresh = session();
        fresh.model = "previous".to_string();
        fresh.apply_session_response(&serde_json::json!({
            "models": {"currentModelId": {"name": "Display Only"}}
        }));
        assert_eq!(fresh.model, "previous");
    }

    // ── P56/D2：find_config_option 收紧 ──

    #[test]
    fn find_config_option_ignores_description_and_substring_matches() {
        let options = vec![
            serde_json::json!({
                "id": "reasoning-effort",
                "description": "Reasoning effort for the model",
                "options": [{"valueId": "low"}]
            }),
            serde_json::json!({
                "id": "model_context_window",
                "description": "Context window of the model"
            }),
        ];
        assert_eq!(find_config_option(&options, "model"), None);
    }

    #[test]
    fn find_config_option_prefers_category_over_name_tokens() {
        let options = vec![
            serde_json::json!({"id": "model", "name": "Legacy token match"}),
            serde_json::json!({"id": "model-selection", "category": "model"}),
        ];
        let found = find_config_option(&options, "model").unwrap();
        assert_eq!(found.get("id").and_then(value_as_string).as_deref(), Some("model-selection"));
    }

    // ── P56/D1.6：空回声保护 ──

    #[test]
    fn config_option_response_keeps_local_catalog_on_empty_echo() {
        // 验收 6：hermes set_config_option 恒空回声——本地 config_options 不得被清空，
        // 且 model 走乐观写回（响应未给权威状态）。
        let mut session = session();
        session.config_options = vec![serde_json::json!({"id": "model", "currentValue": "old"})];
        session.apply_config_option_response(
            &serde_json::json!({"configOptions": []}),
            "model",
            &serde_json::Value::String("next".to_string()),
        );
        assert_eq!(session.config_options.len(), 1);
        assert_eq!(session.model, "next");
    }

    #[test]
    fn config_option_response_overwrites_with_authoritative_options() {
        let mut session = session();
        session.model = "old".to_string();
        session.apply_config_option_response(
            &serde_json::json!({
                "configOptions": [{
                    "id": "model-selection",
                    "category": "model",
                    "options": [{"valueId": "m-1", "name": "Model One"}],
                    "currentValue": "m-1"
                }]
            }),
            "model",
            &serde_json::Value::String("ignored-optimistic".to_string()),
        );
        // 权威回声优先：model 取自响应 current，而非乐观值。
        assert_eq!(session.model, "m-1");
        assert_eq!(
            session.model_surface,
            ModelSurface::ConfigOption {
                config_id: "model-selection".to_string()
            }
        );
    }

    // ── P56/D1.3/D1.4：路由与发送校验 ──

    #[test]
    fn resolve_model_switch_target_prefers_explicit_declaration() {
        // 验收 8：显式 set_model_api 声明按声明路由（现状行为）。
        let (target, config_id) = resolve_model_switch_target(
            Some(SetModelApi::SetModel),
            "model",
            &ModelSurface::None,
        )
        .unwrap();
        assert_eq!(target, crate::agent_config::ModelSwitchTarget::SetModel);
        assert_eq!(config_id, None);

        // 未声明 + key != "model"：既有路径不变。
        let (target, config_id) = resolve_model_switch_target(
            None,
            "mode",
            &ModelSurface::None,
        )
        .unwrap();
        assert_eq!(target, crate::agent_config::ModelSwitchTarget::ConfigOption);
        assert_eq!(config_id, None);
    }

    #[test]
    fn resolve_model_switch_target_routes_by_surface_when_undeclared() {
        let (target, config_id) = resolve_model_switch_target(
            None,
            "model",
            &ModelSurface::ConfigOption {
                config_id: "model-selection".to_string(),
            },
        )
        .unwrap();
        assert_eq!(target, crate::agent_config::ModelSwitchTarget::ConfigOption);
        assert_eq!(config_id.as_deref(), Some("model-selection"));

        let (target, config_id) =
            resolve_model_switch_target(None, "model", &ModelSurface::ModelsState).unwrap();
        assert_eq!(target, crate::agent_config::ModelSwitchTarget::SetModel);
        assert_eq!(config_id, None);
    }

    #[test]
    fn resolve_model_switch_target_rejects_when_no_surface_advertised() {
        // 验收 5：surface==None → model switching unavailable。
        let error = resolve_model_switch_target(None, "model", &ModelSurface::None).unwrap_err();
        assert!(error.to_string().contains("model switching unavailable"));
    }

    #[test]
    fn validate_model_advertised_rejects_out_of_list_values_with_summary() {
        // 验收 4：非列表值被拒，错误含 model_not_advertised 与宣告列表摘要。
        let error = validate_model_advertised(
            "bare-model-x",
            &["nous:hermes-4".to_string(), "nous:hermes-3".to_string()],
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("model_not_advertised"), "{message}");
        assert!(message.contains("nous:hermes-4"), "{message}");
        assert!(message.contains("nous:hermes-3"), "{message}");

        // 未宣告列表（空 choices）→ 无法校验，放行（现状兼容）。
        assert!(validate_model_advertised("anything", &[]).is_ok());
        assert!(validate_model_advertised("nous:hermes-4", &["nous:hermes-4".to_string()]).is_ok());
    }
}

/// 归一化 token（P56/D1/D2 匹配判据共用）：trim、`-`/` `/`.` → `_`、小写。
fn normalized_token(value: &str) -> String {
    value
        .trim()
        .replace(['-', ' ', '.'], "_")
        .chars()
        .flat_map(char::to_lowercase)
        .collect()
}

/// 语义键别名表（find_config_option 与 config_option_key_matches 共用）。
fn semantic_aliases(wanted: &str) -> &'static [&'static str] {
    match wanted {
        "model" | "models" | "model_id" | "modelid" => {
            &["model", "models", "model_id", "modelid", "model_selection"]
        }
        "mode" | "modes" | "mode_id" | "modeid" => {
            &["mode", "modes", "mode_id", "modeid", "permission_mode", "permissions_mode"]
        }
        "reason" | "reasoning" | "thinking" | "thought" | "effort" => {
            &["reason", "reasoning", "reasoning_effort", "thinking", "thought", "thought_level", "effort"]
        }
        _ => &[],
    }
}

/// wire 键名归一（value_as_string 系键序匹配用）。
fn normalized_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len() + 4);
    for (index, ch) in key.chars().enumerate() {
        if ch.is_uppercase() && index > 0 {
            out.push('_');
        }
        if ch == '-' || ch == ' ' {
            out.push('_');
        } else {
            out.extend(ch.to_lowercase());
        }
    }
    out
}

fn walk_value_as_string(value: &serde_json::Value, depth: usize, keys: &[&str]) -> Option<String> {
    if depth > 8 {
        return None;
    }
    if let Some(text) = value.as_str() {
        let text = text.trim();
        return (!text.is_empty()).then(|| text.to_string());
    }
    let object = value.as_object()?;
    for wanted in keys {
        let wanted = normalized_key(wanted);
        let Some((_, nested)) = object
            .iter()
            .find(|(key, _)| normalized_key(key) == wanted)
        else {
            continue;
        };
        if let Some(result) = walk_value_as_string(nested, depth + 1, keys) {
            return Some(result);
        }
    }
    None
}

/// 宽容字符串提取（mode 等既有路径复用，行为不变）。
pub(crate) fn value_as_string(value: &serde_json::Value) -> Option<String> {
    // Stable machine ids always precede display labels/current wrappers.
    walk_value_as_string(
        value,
        0,
        &[
            "valueId", "value_id", "modelId", "model_id", "modeId", "mode_id", "id", "key",
            "value", "currentValue", "current_value", "current", "selected", "selectedValue",
            "selected_value", "name", "label",
        ],
    )
}

/// P56/D2：machine-id-only 提取——与 [`value_as_string`] 同型 walk，但键序**不含**
/// `name`/`label` 显示名兜底。模型值绝不允许把显示名当 id 发上 wire（R3：
/// 显示名与机器 id 混用是「切到预期外 model」的直接来源之一）。
pub(crate) fn value_as_machine_id(value: &serde_json::Value) -> Option<String> {
    walk_value_as_string(
        value,
        0,
        &[
            "valueId", "value_id", "modelId", "model_id", "modeId", "mode_id", "id", "key",
            "value", "currentValue", "current_value", "current", "selected", "selectedValue",
            "selected_value",
        ],
    )
}

pub(crate) fn config_option_current_value(option: &serde_json::Value) -> Option<String> {
    config_option_current_value_with(option, value_as_string)
}

/// P56/D2：model 的 current 提取变体——顶层 current 键序不变，值提取改用
/// machine-id-only（无 machine id → None，不降级为显示名）。
pub(crate) fn config_option_current_machine_id(option: &serde_json::Value) -> Option<String> {
    config_option_current_value_with(option, value_as_machine_id)
}

fn config_option_current_value_with(
    option: &serde_json::Value,
    extract: fn(&serde_json::Value) -> Option<String>,
) -> Option<String> {
    let object = option.as_object()?;
    [
        "currentValue", "current_value", "selectedValue", "selected_value", "selected", "value",
        "current", "defaultValue", "default_value",
    ]
    .iter()
    .find_map(|key| {
        object
            .iter()
            .find(|(candidate, _)| {
                candidate
                    .replace(['-', ' '], "_")
                    .chars()
                    .flat_map(char::to_lowercase)
                    .collect::<String>()
                    == key
                    .replace(['-', ' '], "_")
                    .chars()
                    .flat_map(char::to_lowercase)
                    .collect::<String>()
            })
            .and_then(|(_, value)| extract(value))
    })
}

/// P56/D2.1：语义选项定位收紧——① `category` 归一化精确相等为第一判据；② 无
/// category 命中时 id/name/label/title 的归一化 token 与别名**精确相等**降级。
/// `description` 不参与匹配、`contains` 子串匹配已删除（R1：description 含
/// "model" 的 reasoning/context 选项不得再误配为 model 选择器）。
pub(crate) fn find_config_option<'a>(
    options: &'a [serde_json::Value],
    key: &str,
) -> Option<&'a serde_json::Value> {
    let wanted = normalized_token(key);
    let aliases = semantic_aliases(&wanted);
    let is_alias = |candidate: &str| {
        let candidate = normalized_token(candidate);
        candidate == wanted || aliases.iter().any(|alias| candidate == normalized_token(alias))
    };
    // ① category 精确优先（协议语义判别字段；保持数组顺序取第一个命中）。
    if let Some(option) = options.iter().find(|option| {
        option
            .as_object()
            .and_then(|object| object.get("category"))
            .and_then(value_as_string)
            .is_some_and(|category| is_alias(&category))
    }) {
        return Some(option);
    }
    // ② token 精确相等降级：仅 id/name/label/title（description 禁止参与）。
    options.iter().find(|option| {
        let Some(object) = option.as_object() else {
            return false;
        };
        [
            "configId", "config_id", "optionId", "option_id", "id", "key", "name", "label",
            "title",
        ]
        .iter()
        .filter_map(|field| object.get(*field).and_then(value_as_string))
        .any(|candidate| is_alias(&candidate))
    })
}

/// P56/D2.2：单值 config_option_update 的语义键匹配——归一化后与别名表**精确相等**
/// （与 find_config_option 同判据；configId/config_id 键由调用方补读）。
pub(crate) fn config_option_key_matches(option_key: &str, semantic: &str) -> bool {
    let wanted = normalized_token(semantic);
    let aliases = semantic_aliases(&wanted);
    let candidate = normalized_token(option_key);
    candidate == wanted || aliases.iter().any(|alias| candidate == normalized_token(alias))
}

/// P56/D1：选项身份（configId/config_id/optionId/option_id/id/key 的 machine-id-only
/// 提取；不含 name——宣告 configId 不得降级为显示名）。
fn config_option_identity(option: &serde_json::Value) -> Option<String> {
    let object = option.as_object()?;
    ["configId", "config_id", "optionId", "option_id", "id", "key"]
        .iter()
        .filter_map(|field| object.get(*field))
        .find_map(value_as_machine_id)
        .filter(|id| !id.is_empty())
}

/// P56/D1：select 选项宣告的 choice machine id 集合（保持宣告顺序、去重；
/// 无 machine id 的 choice 直接丢弃，不降级为显示名——与 TS modelChoices 同契约）。
fn config_option_choice_ids(option: &serde_json::Value) -> Vec<String> {
    fn collect(value: &serde_json::Value, depth: usize, seen: &mut Vec<String>) {
        if depth > 4 {
            return;
        }
        if let Some(list) = value.as_array() {
            for item in list {
                if let Some(id) = value_as_machine_id(item) {
                    if !seen.contains(&id) {
                        seen.push(id);
                    }
                }
            }
            return;
        }
        let Some(object) = value.as_object() else {
            return;
        };
        for key in [
            "options", "choices", "values", "available", "items", "enum", "schema",
            "optionValues", "option_values",
        ] {
            if let Some(nested) = object.get(key) {
                collect(nested, depth + 1, seen);
            }
        }
    }
    let mut choices = Vec::new();
    collect(option, 0, &mut choices);
    choices
}

/// P56/D1.2：按响应形状判定模型切换宣告面（纯函数，便于测试）。
/// ① configOptions 中 model 选项（category=="model" 精确第一判据，token 精确相等
///    降级——见 [`find_config_option`]）→ `ConfigOption { config_id }`，choices 取
///    其 select options 的 machine id；选项缺身份键（不可寻址）则继续降级；
/// ② 否则 `models.availableModels` 非空 → `ModelsState`，choices 取各 choice 的
///    modelId（machine-id-only，无 id 的 choice 丢弃）；
/// ③ 都没有 → `None`（会话模型只读）。
pub(crate) fn determine_model_surface(
    config_options: &[serde_json::Value],
    models: Option<&serde_json::Value>,
) -> ModelSurfaceInfo {
    if let Some(option) = find_config_option(config_options, "model") {
        if let Some(config_id) = config_option_identity(option) {
            return ModelSurfaceInfo {
                surface: ModelSurface::ConfigOption { config_id },
                choices: config_option_choice_ids(option),
            };
        }
    }
    if let Some(models) = models {
        let mut choices: Vec<String> = Vec::new();
        for key in ["availableModels", "available_models"] {
            if let Some(list) = models.get(key).and_then(|value| value.as_array()) {
                for item in list {
                    if let Some(id) = value_as_machine_id(item) {
                        if !choices.contains(&id) {
                            choices.push(id);
                        }
                    }
                }
                break;
            }
        }
        if !choices.is_empty() {
            return ModelSurfaceInfo {
                surface: ModelSurface::ModelsState,
                choices,
            };
        }
    }
    ModelSurfaceInfo {
        surface: ModelSurface::None,
        choices: Vec::new(),
    }
}

/// P56/D1.3：set_config_option 的 model 键路由——显式 `set_model_api` 声明优先
/// （现状行为，兼容优先；含 legacy 布尔迁移与 catalog 默认，判定用 load.rs parse()
/// 的「显式 vs catalog 默认」合并结果：`agent.acp.set_model_api` 为 Some 即声明态）；
/// 未声明且 key=="model" 时按响应判定的 [`ModelSurface`] 路由；None → 结构化错误。
/// 返回 (路由目标, 宣告的 configId)——ConfigOption 通道统一使用宣告 configId
/// （D1.5，消除初值 advertised / 运行时硬编码 "model" 的不一致）。
pub(crate) fn resolve_model_switch_target(
    declared: Option<SetModelApi>,
    key: &str,
    surface: &ModelSurface,
) -> Result<(crate::agent_config::ModelSwitchTarget, Option<String>), PylonError> {
    if let Some(api) = declared {
        return Ok((api.route(key), None));
    }
    if key != "model" {
        // key != "model" 的既有路径（mode/reasoning 等）行为不变。
        return Ok((crate::agent_config::ModelSwitchTarget::ConfigOption, None));
    }
    let target = match surface {
        ModelSurface::ConfigOption { config_id } => {
            return Ok((
                crate::agent_config::ModelSwitchTarget::ConfigOption,
                Some(config_id.clone()),
            ));
        }
        ModelSurface::ModelsState => crate::agent_config::ModelSwitchTarget::SetModel,
        ModelSurface::None => {
            return Err(PylonError::Protocol(
                "model switching unavailable: agent advertises no model surface".to_string(),
            ));
        }
    };
    Ok((target, None))
}

/// P56/D1.4：发送不变量——任何上 wire 的模型值必须 ∈ 当次会话宣告的 choices。
/// choices 非空且目标不在列表 → 结构化错误（文案含 `model_not_advertised` 与宣告
/// 列表摘要）；choices 为空 = 会话未宣告可校验列表 → 放行（现状行为，兼容优先）。
pub(crate) fn validate_model_advertised(value: &str, choices: &[String]) -> Result<(), PylonError> {
    if choices.is_empty() || choices.iter().any(|choice| choice == value) {
        return Ok(());
    }
    Err(PylonError::Protocol(format!(
        "model_not_advertised: requested model {value:?} is not in the agent-advertised choices [{}]",
        choices.join(", ")
    )))
}
