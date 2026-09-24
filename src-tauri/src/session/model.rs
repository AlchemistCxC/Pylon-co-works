//! 会话模型：SessionInfo / wire DTO / config option 纯函数。
//! 方案 11 机械拆分自 session/mod.rs；#97 起本文件承载模型选择器状态机
//! （模型面解析、三态收敛、切换路由与发送校验），见 .agents/decisions/0004。

use serde::Serialize;

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

/// #97/D97-2：一次 model 切换 RPC 响应的收敛结果（结构化，供调用方发诊断/回执）。
/// `Confirmed` = Agent 回显与 requested 一致；`Clamped` = Agent 实际值与 requested
/// 不同（拒绝/钳制，会话状态已回到实际值）；`Pending` = 无权威回显（乐观值保留，
/// 但标记未确认）；`Authoritative` = 有权威回显但本响应未携带 model 维度（例如仅
/// 刷新了其它 config option）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ModelSwitchSettlement {
    Confirmed {
        settled: String,
    },
    Clamped {
        requested: String,
        settled: String,
    },
    Pending {
        requested: String,
    },
    /// 权威响应已收敛；`confirmed_model` = 是否携带 model 维度的确认值。
    Authoritative {
        requested: Option<String>,
        confirmed_model: bool,
    },
    NotModel,
}

/// D97-4：raw selector envelope（configOptions 数组）保留上限。超过即拒绝替换
/// （已知 selector 状态保持不变 + 计数），防止异常响应撑爆会话状态。
pub(crate) const SELECTOR_ENVELOPE_MAX_BYTES: usize = 256 * 1024;

/// D97-1：响应中 models 状态的统一读取——优先嵌套 `models`，缺席时根级
/// `availableModels`/`available_models` 视作 models 状态本身（返回整个响应）。
/// session/new 初值计划与 SessionInfo 响应/异步刷新共用，保证全链路同一套
/// 模型面解析规则。
pub(crate) fn response_models_state(response: &serde_json::Value) -> Option<&serde_json::Value> {
    response.get("models").or_else(|| {
        response
            .get("availableModels")
            .or_else(|| response.get("available_models"))
            .map(|_| response)
    })
}

/// D97-4：异步 selector push 的幂等指纹（稳定 JSON 序列化的 FNV-1a）。
fn selector_echo_fingerprint(value: &serde_json::Value) -> u64 {
    // to_string 对 Value 是确定性的（BTreeMap 键序），可直接做指纹输入。
    let serialized = value.to_string();
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in serialized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// ADR-0017/#217：在途回合标记的身份键——(客户端 generation, 出站 request id)。
/// turn_id 与 turn_ledger 的 `TurnKey.turn_id` 同源（PreparedRpc.id），generation
/// 隔离后跨连接不混淆；清理按键匹配，旧代际迟到的终态动不了新代际的标记。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TurnInFlightMark {
    pub(crate) generation: u64,
    pub(crate) turn_id: u64,
}

#[derive(Clone)]
pub(crate) struct SessionInfo {
    /// ACP typed live state. This is an ingest-side projection only; canonical
    /// persistence and renderer publication remain owned by their existing
    /// transactions.
    pub(crate) acp_state: crate::acp::AcpSessionState,
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
    /// Legacy modes advertisement, kept separate from standard configOptions.
    pub(crate) mode_choices: Vec<String>,
    pub(crate) config_options: Vec<serde_json::Value>,
    pub(crate) model: String,
    /// P56/D1：模型切换通道宣告面（apply_session_response / apply_config_options
    /// 全量数组分支刷新）；set_config_option 的 model 键按此路由（显式 set_model_api
    /// 声明优先，见 control.rs）。
    pub(crate) model_surface: ModelSurface,
    /// P56/D1：宣告的 model machine id 集合（发送不变量：任何上 wire 的模型值必须
    /// ∈ 本集合；空集合 = 会话未宣告可校验列表，跳过校验放行现状行为）。
    pub(crate) model_choices: Vec<String>,
    /// #97/D97-2：requested-but-unconfirmed 模型值。仅当 set_config_option/set_model
    /// 响应不含任何权威回显（configOptions 列表 / models.current）时置位——上层与
    /// 后续收敛据此可辨识「未确认」状态；任何权威回显（RPC 响应或异步
    /// session_info_update）到达即清除。纯内部状态，不落 wire、不持久化。
    pub(crate) model_pending: Option<String>,
    /// D97-4：selector 回显幂等——最近一次异步 models push 的指纹（完整 models
    /// JSON 的稳定序列化）。相同指纹的重复 push 只提交一次状态，计数留诊断；
    /// 64-bit 指纹碰撞（概率可忽略）的语义是丢弃一条重复 push，接受。
    /// 单值 config_option_update 推送不走此槽——其分支按 value 相等判定天然幂等。
    selector_echo_fingerprint: Option<u64>,
    /// D97-4：诊断计数（重复 push 丢弃 / 超限 envelope 拒绝）。内部观测字段，
    /// 不落 wire、不持久化。
    pub(crate) selector_duplicate_pushes: u64,
    pub(crate) selector_envelope_dropped: u64,
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
    /// ADR-0017/#217：在途回合标记——「本进程已派发 prompt、尚未收到终态」的一等
    /// 事实（与 `last_activity` 同级：进程内事实，不落 wire、不序列化）。置位点与
    /// turn_ledger.begin 同点；终态路径无条件清理（见 prompt.rs report_settle /
    /// publish_prompt_failure）。键化为 (generation, turn_id)：客户端替换后迟到的
    /// 旧回合终态不得误清新回合的标记。prompt_gate 保证每实例至多一个在途 prompt，
    /// 故每会话至多一条。
    pub(crate) turn_in_flight: Option<TurnInFlightMark>,
    /// 会话级可恢复状态快照（wire key -> JSON）：usage/commands/mode 及未来状态量统一放这里。
    pub(crate) commands_snapshot: Option<serde_json::Value>,
    pub(crate) usage_snapshot: Option<serde_json::Value>,
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
            acp_state: crate::acp::AcpSessionState::default(),
            peri_id,
            profile_id: None,
            persona,
            cwd,
            has_first_prompt,
            title: String::new(),
            generation,
            replay_loading: false,
            mode: None,
            mode_choices: Vec::new(),
            config_options: Vec::new(),
            model: String::new(),
            model_surface: ModelSurface::None,
            model_choices: Vec::new(),
            model_pending: None,
            selector_echo_fingerprint: None,
            selector_duplicate_pushes: 0,
            selector_envelope_dropped: 0,
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
            turn_in_flight: None,
            commands_snapshot: None,
            usage_snapshot: None,
        }
    }

    /// ADR-0017/#217：标记在途回合（出站 prompt 已派发）。同键重复置位幂等。
    pub(crate) fn mark_turn_in_flight(&mut self, generation: u64, turn_id: u64) {
        self.turn_in_flight = Some(TurnInFlightMark {
            generation,
            turn_id,
        });
    }

    /// ADR-0017/#217：按键清理——只有 (generation, turn_id) 与标记一致才算本回合的
    /// 终态。陈旧回合（客户端替换后代际已换）的迟到清理返回 false 且不动标记。
    /// 返回是否发生了实际清理（诊断）。
    pub(crate) fn clear_turn_in_flight(&mut self, generation: u64, turn_id: u64) -> bool {
        let matches = self
            .turn_in_flight
            .is_some_and(|mark| mark.generation == generation && mark.turn_id == turn_id);
        if matches {
            self.turn_in_flight = None;
        }
        matches
    }

    /// ADR-0017/#217：无条件清理（不按键）——错误终态路径的防御纵深；
    /// 返回清理前是否存在标记（诊断）。
    pub(crate) fn force_clear_turn_in_flight(&mut self) -> bool {
        self.turn_in_flight.take().is_some()
    }

    /// ADR-0017/#217：本会话是否有一个在途回合（本进程已派发 prompt、尚未收到终态）。
    pub(crate) fn turn_in_flight(&self) -> bool {
        self.turn_in_flight.is_some()
    }

    pub(crate) fn apply_session_response(&mut self, response: &serde_json::Value) {
        // P56/D1.6：空回声保护——响应 configOptions 为空数组且本地非空时不覆盖本地
        // （全量数组分支；与 control.rs 写回分支同一契约）。
        // D97-2（评审修正）：快照携带权威 model 维度（configOptions model 选项或
        // models/modelId current）时清除 requested 未确认态——persist.rs 的原位
        // load 路径复用本函数，陈旧 pending 不得跨快照滞留。
        let mut authoritative_current = false;
        let mut effective_options: Vec<serde_json::Value> = self.config_options.clone();
        if let Some(options) = response
            .get("configOptions")
            .or_else(|| response.get("config_options"))
            .and_then(|value| value.as_array())
        {
            // D97-4：非空且未超限才替换（空回声保护与超限拒绝都保留本地宣告）。
            if !(options.is_empty() && !self.config_options.is_empty())
                && self.replace_config_options(options)
            {
                effective_options = self.config_options.clone();
                self.apply_config_options(&effective_options);
                // N2（第二轮评审）：value-based 判据——model 选项存在但无可提取
                // currentValue 时不构成 model 维度确认，pending 保留。
                authoritative_current = find_config_option(&effective_options, "model")
                    .and_then(config_option_current_machine_id)
                    .is_some();
            }
        }
        // Prefer standard configOptions over legacy models state.
        if !authoritative_current {
            // ACP 1.4 and Hermes expose the selected model in different places.
            // Prefer the standard `models.currentModelId` state when present, then
            // retain the config-option fallback handled above.  P56/D2：model 的
            // current 提取用 machine-id-only 变体（name/label 显示名不得当 id）。
            // #97/D97-1：根级 currentModelId/current_model_id 变体与嵌套 models 状态
            // 等价消费（同一解析规则覆盖 current 维度）。
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
                .or_else(|| {
                    response
                        .get("currentModelId")
                        .or_else(|| response.get("current_model_id"))
                })
                .and_then(value_as_machine_id)
            {
                self.model = model;
                authoritative_current = true;
            } else if let Some(model) = response
                .get("modelId")
                .or_else(|| response.get("model_id"))
                .or_else(|| response.get("model"))
                .and_then(value_as_machine_id)
            {
                self.model = model;
                authoritative_current = true;
            }
        }
        if authoritative_current {
            self.model_pending = None;
        }
        self.mode = find_config_option(&effective_options, "mode")
            .and_then(config_option_current_value)
            .or_else(|| {
                response
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
            })
            .or_else(|| {
                response
                    .get("modeId")
                    .or_else(|| response.get("mode_id"))
                    .or_else(|| response.get("mode"))
                    .and_then(value_as_string)
            });
        if let Some(modes) = response.get("modes") {
            if let Some(choices) = modes
                .get("availableModes")
                .or_else(|| modes.get("available_modes"))
                .and_then(serde_json::Value::as_array)
            {
                self.mode_choices = choices.iter().filter_map(value_as_machine_id).collect();
            }
        }
        // usage 不在此内联提取——函数尾 capture_session_state 经注册表
        // capture_usage 单点写入 usage_snapshot（提取链与原内联块逐字相同，
        // #261 去重：消除同一次响应路径上的同逻辑双写）。
        // P56/D1.2：按响应形状刷新模型面（configOptions 优先，models.availableModels
        // 兜底，都没有 → None 只读）。D97-1：models 状态解析走与初值计划
        // （plan_initial_model）同一 helper——根级 availableModels/available_models
        // 与嵌套变体等价进入模型面，session/new、session/load 与运行中切换共用
        // 同一套解析规则。
        let info = determine_model_surface(&effective_options, response_models_state(response));
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

    /// #97/D97-2：set_config_option / set_model 响应写回 + 收敛结果。响应含非空
    /// configOptions → 权威全量覆盖（含 model/mode current 提取）；configOptions 为
    /// 空数组且本地非空 → 空回声保护（hermes set_config_option 恒空回声，不得清空
    /// 本地宣告）；models.current 权威确认优先于语义键乐观写回。返回
    /// [`ModelSwitchSettlement`]：requested != settled 的钳制、无权威回显的
    /// pending（可辨识的未确认态）都结构化上抛，调用方据此发诊断。
    pub(crate) fn apply_config_option_response(
        &mut self,
        response: &serde_json::Value,
        key: &str,
        value: &serde_json::Value,
    ) -> ModelSwitchSettlement {
        let requested = if key == "model" {
            value.as_str().map(str::to_string)
        } else {
            None
        };
        let mut authoritative = false;
        // Some ACP agents (notably set_model implementations) return the
        // settled model in `models.currentModelId` while leaving
        // `configOptions` absent. Consume that acknowledgement before the
        // compatibility fallback below so the session converges on the
        // agent's value instead of retaining an optimistic client value.
        let acknowledged_model = response
            .get("models")
            .and_then(|models| {
                models
                    .get("currentModelId")
                    .or_else(|| models.get("current_model_id"))
            })
            .and_then(value_as_machine_id)
            .or_else(|| {
                response
                    .get("currentModelId")
                    .or_else(|| response.get("current_model_id"))
                    .and_then(value_as_machine_id)
            });
        if let Some(model) = acknowledged_model.as_ref() {
            self.model = model.clone();
        }
        if let Some(options) = response
            .get("configOptions")
            .and_then(|value| value.as_array())
        {
            if !(options.is_empty() && !self.config_options.is_empty())
                && self.replace_config_options(options)
            {
                self.apply_config_options(options);
                authoritative = true;
            }
        }
        if authoritative || acknowledged_model.is_some() {
            // D97-2：权威回显到达——requested 与 settled 不同即钳制（Agent 实际值
            // 胜出，回显 choices/catalog 已同步刷新）；一致即确认。pending 只在
            // 响应确实携带 model 维度时清除（权威列表但无 model 选项 ≠ model 确认）。
            let settled = acknowledged_model.clone().or_else(|| {
                find_config_option(&self.config_options, "model")
                    .and_then(config_option_current_machine_id)
            });
            if settled.is_some() {
                self.model_pending = None;
            }
            return match (requested.as_ref(), settled) {
                (Some(requested), Some(settled)) => {
                    if requested != &settled {
                        return ModelSwitchSettlement::Clamped {
                            requested: requested.clone(),
                            settled,
                        };
                    }
                    ModelSwitchSettlement::Confirmed { settled }
                }
                (requested, settled) => ModelSwitchSettlement::Authoritative {
                    requested: requested.cloned(),
                    confirmed_model: settled.is_some(),
                },
            };
        }
        if let Some(requested) = requested {
            // D97-2：无权威回显——乐观写回但保留可辨识的 pending（未确认）态；
            // 后续权威回显或 session_info_update 覆盖它。
            self.model = requested.clone();
            self.model_pending = Some(requested.clone());
            return ModelSwitchSettlement::Pending { requested };
        }
        if key == "mode" {
            if let Some(value) = value.as_str() {
                self.mode = Some(value.to_string());
            }
        }
        ModelSwitchSettlement::NotModel
    }

    /// #97/D97-3：异步 `session_info_update` 的 models 状态全量消费——current 提取
    /// （machine-id-only）+ 模型面/choices 刷新（configOptions 优先、嵌套/根级列表
    /// 兼容，与 apply_session_response 同一解析入口）+ pending 清除（仅当本 push
    /// 确实携带 model current 维度——无 model 维度的 push 不构成确认，D97-2）。
    /// 幂等：与上一次 push 完全相同的 fingerprint 重复到达时跳过提交并计数
    /// （D97-4），调用方无需自行去重。返回是否实际提交（false = 重复 push 被丢弃）。
    ///
    /// D97-7（评审修正）：本函数消费的是**增量 push**，语义与 apply_session_response
    /// 的快照整体替换不同——push 未携带模型宣告（无 choices，如只有 current 的
    /// 形状）是「未宣告」而非「撤销宣告」，既有面与 choices 原样保留，禁止降级
    /// （「空回声不得清空已知模型集合」的对偶契约；否则一次 current-only push 会
    /// 把 ModelsState 会话打回只读）。
    pub(crate) fn apply_models_state(&mut self, models: &serde_json::Value) -> bool {
        let fingerprint = selector_echo_fingerprint(models);
        if self.selector_echo_fingerprint == Some(fingerprint) {
            self.selector_duplicate_pushes += 1;
            tracing::debug!(
                code = "selector_push_duplicate_dropped",
                count = self.selector_duplicate_pushes,
                "duplicate models selector push dropped by fingerprint"
            );
            return false;
        }
        self.selector_echo_fingerprint = Some(fingerprint);
        let mut had_current = false;
        if let Some(model) = models
            .get("currentModelId")
            .or_else(|| models.get("current_model_id"))
            .or_else(|| models.get("currentModel"))
            .or_else(|| models.get("current_model"))
            .or_else(|| models.get("current"))
            .and_then(value_as_machine_id)
        {
            self.model = model;
            had_current = true;
        }
        let info = determine_model_surface(&self.config_options, Some(models));
        // configOptions 中的 model 选项仍是第一宣告面；models 状态只在它缺席且
        // 确实宣告了列表时提供通道与 choices（与 apply_session_response 的优先级
        // 一致；本次未宣告则保留现状，见 D97-7）。显式空列表（availableModels: []）
        // 与「未携带」同待——push 通道不表达撤销宣告，撤销走快照路径（N9 注记）。
        match info.surface {
            ModelSurface::ModelsState => {
                self.model_surface = ModelSurface::ModelsState;
                self.model_choices = info.choices;
            }
            // ConfigOption 面（含其 choices）由 configOptions 宣告治理，本 push 不动。
            ModelSurface::ConfigOption { .. } | ModelSurface::None => {}
        }
        if had_current {
            self.model_pending = None;
        }
        true
    }

    /// #97/D97-3（第二轮评审 N1）：异步 config_option_update **全量数组**推送的
    /// 统一消费——有界替换 + 已知 selector 刷新 + pending 清除。数组携带可提取
    /// model currentValue（权威回显的 model 维度）时清除 requested 未确认态，
    /// 判据与 apply_config_option_response 的 settled 一致（value-based）；
    /// 无 model 维度的数组不构成确认。返回是否接受（false = 超限拒绝）。
    pub(crate) fn apply_config_options_push(&mut self, options: &[serde_json::Value]) -> bool {
        if !self.replace_config_options(options) {
            return false;
        }
        self.apply_config_options(options);
        if find_config_option(options, "model")
            .and_then(config_option_current_machine_id)
            .is_some()
        {
            self.model_pending = None;
        }
        true
    }

    /// D97-4：raw selector envelope 的有界替换。configOptions 数组（含未知 option
    /// kind 的原样字段）超过 [`SELECTOR_ENVELOPE_MAX_BYTES`] 时拒绝替换并计数——
    /// 已知 selector 状态保持不变，不做截断（半份 envelope 比旧份更危险）。
    /// 返回是否接受。
    pub(crate) fn replace_config_options(&mut self, options: &[serde_json::Value]) -> bool {
        let serialized = serde_json::to_vec(options).unwrap_or_default();
        if serialized.len() > SELECTOR_ENVELOPE_MAX_BYTES {
            self.selector_envelope_dropped += 1;
            tracing::warn!(
                code = "selector_envelope_dropped",
                size = serialized.len(),
                limit = SELECTOR_ENVELOPE_MAX_BYTES,
                "oversized selector envelope refused; keeping known selector state"
            );
            return false;
        }
        self.config_options = options.to_vec();
        true
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

/// 归一化 token（P56/D1/D2 匹配判据共用）：trim、`-`/` `/`.` → `_`、小写。
fn normalized_token(value: &str) -> String {
    value
        .trim()
        .replace(['-', ' ', '.'], "_")
        .chars()
        .flat_map(char::to_lowercase)
        .collect()
}

/// 宽松键归一化（`-`/空格 → `_` + 小写；**不 trim、不处理 `.`**）：current/
/// identity 提取的历史语义，与 [`normalized_token`]（含 trim 与 `.`→`_`）是
/// **两组不同语义，不得合并**——wire 键含 `.` 时两组判定不同（#261 去重按
/// 语义分组收敛，等价性论证见 .agents/records/261-*）。
pub(crate) fn loose_normalized_key(value: &str) -> String {
    value
        .replace(['-', ' '], "_")
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
        "mode" | "modes" | "mode_id" | "modeid" => &[
            "mode",
            "modes",
            "mode_id",
            "modeid",
            "permission_mode",
            "permissions_mode",
        ],
        "reason" | "reasoning" | "thinking" | "thought" | "effort" => &[
            "reason",
            "reasoning",
            "reasoning_effort",
            "thinking",
            "thought",
            "thought_level",
            "effort",
        ],
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
        let Some((_, nested)) = object.iter().find(|(key, _)| normalized_key(key) == wanted) else {
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
            "valueId",
            "value_id",
            "modelId",
            "model_id",
            "modeId",
            "mode_id",
            "id",
            "key",
            "value",
            "currentValue",
            "current_value",
            "current",
            "selected",
            "selectedValue",
            "selected_value",
            "name",
            "label",
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
            "valueId",
            "value_id",
            "modelId",
            "model_id",
            "modeId",
            "mode_id",
            "id",
            "key",
            "value",
            "currentValue",
            "current_value",
            "current",
            "selected",
            "selectedValue",
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
        "currentValue",
        "current_value",
        "selectedValue",
        "selected_value",
        "selected",
        "value",
        "current",
        "defaultValue",
        "default_value",
    ]
    .iter()
    .find_map(|key| {
        object
            .iter()
            .find(|(candidate, _)| loose_normalized_key(candidate) == loose_normalized_key(key))
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
        candidate == wanted
            || aliases
                .iter()
                .any(|alias| candidate == normalized_token(alias))
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
            "configId",
            "config_id",
            "optionId",
            "option_id",
            "id",
            "key",
            "name",
            "label",
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
    candidate == wanted
        || aliases
            .iter()
            .any(|alias| candidate == normalized_token(alias))
}

/// P56/D1：选项身份（configId/config_id/optionId/option_id/id/key 的 machine-id-only
/// 提取；不含 name——宣告 configId 不得降级为显示名）。
pub(crate) fn config_option_identity(option: &serde_json::Value) -> Option<String> {
    let object = option.as_object()?;
    [
        "configId",
        "config_id",
        "optionId",
        "option_id",
        "id",
        "key",
    ]
    .iter()
    .filter_map(|field| object.get(*field))
    .find_map(value_as_machine_id)
    .filter(|id| !id.is_empty())
}

/// 递归收集选项 choices 候选值的共享骨架：machine-id 轨（[`config_option_choice_ids`]）
/// 与 create.rs 初始协商宽容轨（`option_choices`）共用。两轨候选键集合一致（wild 观测
/// 键名的同一份清单），迭代序取本清单顺序——宽容轨收集后 sort+dedup，键序对输出无
/// 影响，故共享骨架对两轨输出逐字节等价（#261 去重）。depth 截断与数组短路两轨一致；
/// 值提取经 `extract` 参数化（machine-id-only vs 宽容 string/{value}/{valueId}），
/// 去重策略由调用方自留（保序去重 vs 排序去重）。
pub(crate) fn collect_config_choice_values(
    option: &serde_json::Value,
    extract: fn(&serde_json::Value) -> Option<String>,
    out: &mut Vec<String>,
) {
    fn collect(
        value: &serde_json::Value,
        depth: usize,
        extract: fn(&serde_json::Value) -> Option<String>,
        out: &mut Vec<String>,
    ) {
        if depth > 4 {
            return;
        }
        if let Some(list) = value.as_array() {
            for item in list {
                if item
                    .get("group")
                    .and_then(serde_json::Value::as_str)
                    .is_some()
                {
                    if let Some(options) = item.get("options") {
                        collect(options, depth + 1, extract, out);
                    }
                } else if let Some(choice) = extract(item) {
                    out.push(choice);
                }
            }
            return;
        }
        let Some(object) = value.as_object() else {
            return;
        };
        for key in [
            "options",
            "choices",
            "values",
            "available",
            "items",
            "enum",
            "schema",
            "optionValues",
            "option_values",
        ] {
            if let Some(nested) = object.get(key) {
                collect(nested, depth + 1, extract, out);
            }
        }
    }
    collect(option, 0, extract, out);
}

/// P56/D1：select 选项宣告的 choice machine id 集合（保持宣告顺序、去重；
/// 无 machine id 的 choice 直接丢弃，不降级为显示名——与 TS modelChoices 同契约）。
/// #97/D97-6：control 层对依赖 option（reasoning 组）发送校验复用。
pub(crate) fn config_option_choice_ids(option: &serde_json::Value) -> Vec<String> {
    let mut choices = Vec::new();
    collect_config_choice_values(option, value_as_machine_id, &mut choices);
    // 保序去重（保留首个出现位）——与原 walk 内联 seen 检查的输出逐一相同。
    let mut seen: Vec<String> = Vec::new();
    choices.retain(|id| {
        if seen.contains(id) {
            false
        } else {
            seen.push(id.clone());
            true
        }
    });
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
/// #97/D97-5：显式 ConfigOption 声明 + model 键 + 会话已宣告 ConfigOption 面时，
/// 一律返回宣告的真实 config id（例如 `model-selection`），禁止把广告 id 降级成
/// 语义键 `model`；面未宣告 config id 时返回 None，由控制层按兼容规则（语义键 +
/// 诊断）发送。
pub(crate) fn resolve_model_switch_target(
    declared: Option<SetModelApi>,
    key: &str,
    surface: &ModelSurface,
) -> Result<(crate::agent_config::ModelSwitchTarget, Option<String>), PylonError> {
    if let Some(api) = declared {
        let target = api.route(key);
        // N3（第二轮评审）：提取判据与 control 层校验/诊断门同款别名匹配——别名键
        // + 宣告面时宣告 id 同样生效，杜绝「校验按 model、提取按精确键」的错位
        // （此前别名键会误发 model_config_id_missing 诊断）。注意：P56 的路由
        // 特判（api.route 与下方 `key != "model"` 早退）保持精确键现状不变量。
        if config_option_key_matches(key, "model") {
            if let (
                crate::agent_config::ModelSwitchTarget::ConfigOption,
                ModelSurface::ConfigOption { config_id },
            ) = (target, surface)
            {
                return Ok((
                    crate::agent_config::ModelSwitchTarget::ConfigOption,
                    Some(config_id.clone()),
                ));
            }
        }
        return Ok((target, None));
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

/// P56/D1.4/#97-D97-6：发送不变量——语义选择器（model / reasoning 等依赖 option）
/// 上 wire 的值必须 ∈ 当次会话宣告的 choices。choices 非空且目标不在列表 → 结构化
/// 错误（文案含稳定 code 前缀与宣告列表摘要）；choices 为空 = 会话未宣告可校验
/// 列表 → 放行（现状行为，兼容优先）。模型切换刷新宣告后，依赖 option 的失效值
/// 据此在发送前被拒，不遗留旧模型状态。
pub(crate) fn validate_advertised_choice(
    value: &str,
    choices: &[String],
    code: &str,
) -> Result<(), PylonError> {
    if choices.is_empty() || choices.iter().any(|choice| choice == value) {
        return Ok(());
    }
    Err(PylonError::Protocol(format!(
        "{code}: requested value {value:?} is not in the agent-advertised choices [{}]",
        choices.join(", ")
    )))
}

/// P56/D1.4：model 键发送校验（[`validate_advertised_choice`] 的稳定入口，
/// code=`model_not_advertised`）。
pub(crate) fn validate_model_advertised(value: &str, choices: &[String]) -> Result<(), PylonError> {
    validate_advertised_choice(value, choices, "model_not_advertised")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grouped_acp_choices_are_values_not_group_labels() {
        let option = serde_json::json!({"id":"model","options":[{"group":"recommended","name":"Recommended",
            "options":[{"value":"a","name":"A"},{"value":"b","name":"B"}]}]});
        assert_eq!(config_option_choice_ids(&option), vec!["a", "b"]);
    }

    #[test]
    fn legacy_selector_projection_preserves_catalogue_without_changing_rpc_surface() {
        let response = serde_json::json!({"models":{"currentModelId":"a","availableModels":[{"modelId":"a"},{"modelId":"b"}]},
            "modes":{"currentModeId":"default","availableModes":[{"id":"default"},{"id":"custom"}]}});
        let options = super::super::response_projection_options(&response);
        assert_eq!(options.len(), 2);
        assert_eq!(config_option_choice_ids(&options[0]), vec!["a", "b"]);
        assert_eq!(
            config_option_choice_ids(&options[1]),
            vec!["default", "custom"]
        );
        let mut live = session();
        live.apply_session_response(&response);
        assert_eq!(live.model_surface, ModelSurface::ModelsState);
        assert!(live.config_options.is_empty());
    }

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
            response
                .get("configOptions")
                .and_then(|v| v.as_array())
                .unwrap(),
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
        assert_eq!(
            found.get("id").and_then(value_as_string).as_deref(),
            Some("model-selection")
        );
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
        let (target, config_id) =
            resolve_model_switch_target(Some(SetModelApi::SetModel), "model", &ModelSurface::None)
                .unwrap();
        assert_eq!(target, crate::agent_config::ModelSwitchTarget::SetModel);
        assert_eq!(config_id, None);

        // 未声明 + key != "model"：既有路径不变。
        let (target, config_id) =
            resolve_model_switch_target(None, "mode", &ModelSurface::None).unwrap();
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

    #[test]
    fn set_model_response_acknowledgement_converges_without_config_options() {
        let mut session = SessionInfo::new(
            "peri-1".to_string(),
            "persona".to_string(),
            ".".to_string(),
            false,
            1,
        );
        session.model = "old-model".to_string();
        session.apply_config_option_response(
            &serde_json::json!({"models": {"currentModelId": "agent-normalized-model"}}),
            "model",
            &serde_json::json!("new-model"),
        );
        assert_eq!(session.model, "agent-normalized-model");
    }

    // ── #97/D97-1：根级模型列表与嵌套变体等价进入 SessionInfo ──

    #[test]
    fn root_level_model_catalogs_enter_session_info_equivalently() {
        // 验收 2：models.availableModels、根级 availableModels/available_models、
        // camel/snake 变体产生等价的 surface + choices。
        let shapes = [
            serde_json::json!({
                "models": {
                    "availableModels": [{"modelId": "a-one", "name": "One"}, {"modelId": "a-two"}],
                    "currentModelId": "a-two"
                }
            }),
            serde_json::json!({
                "models": {
                    "available_models": [{"model_id": "a-one", "name": "One"}, {"model_id": "a-two"}],
                    "current_model_id": "a-two"
                }
            }),
            serde_json::json!({
                "availableModels": [{"modelId": "a-one", "name": "One"}, {"modelId": "a-two"}],
                "currentModelId": "a-two"
            }),
            serde_json::json!({
                "available_models": [{"model_id": "a-one", "name": "One"}, {"model_id": "a-two"}],
                "current_model_id": "a-two"
            }),
            // 评审补强：根级列表与 current 的键风格交叉（camel 列表 + snake current）。
            serde_json::json!({
                "availableModels": [{"modelId": "a-one", "name": "One"}, {"modelId": "a-two"}],
                "current_model_id": "a-two"
            }),
        ];
        for shape in &shapes {
            let mut session = session();
            session.apply_session_response(shape);
            assert_eq!(session.model_surface, ModelSurface::ModelsState, "{shape}");
            assert_eq!(
                session.model_choices,
                vec!["a-one".to_string(), "a-two".to_string()],
                "{shape}"
            );
            assert_eq!(session.model, "a-two", "{shape}");
        }
        // 同一形状喂给初值计划（plan_initial_model 消费的同一解析入口）→ 等价 choices。
        for shape in &shapes {
            let info = determine_model_surface(&[], response_models_state(shape));
            assert_eq!(info.surface, ModelSurface::ModelsState);
            assert_eq!(info.choices, vec!["a-one".to_string(), "a-two".to_string()]);
        }
    }

    // ── #97/D97-2：requested/pending/confirmed 三态收敛矩阵 ──

    #[test]
    fn model_switch_settlement_matrix_distinguishes_confirmed_clamped_pending() {
        let model_option = |current: &str| {
            serde_json::json!([{
                "id": "model-selection",
                "category": "model",
                "options": [{"valueId": "m-a"}, {"valueId": "m-b"}],
                "currentValue": current
            }])
        };
        // requested == settled → Confirmed，pending 清除。
        let mut confirmed = session();
        confirmed.model_pending = Some("m-a".to_string());
        let settlement = confirmed.apply_config_option_response(
            &serde_json::json!({"configOptions": model_option("m-a")}),
            "model",
            &serde_json::json!("m-a"),
        );
        assert_eq!(
            settlement,
            ModelSwitchSettlement::Confirmed {
                settled: "m-a".to_string()
            }
        );
        assert_eq!(confirmed.model_pending, None);

        // requested 被钳制为 Agent 实际值 → Clamped，catalog/current 一致收敛到实际值。
        let mut clamped = session();
        clamped.apply_config_option_response(
            &serde_json::json!({"configOptions": model_option("m-a")}),
            "model",
            &serde_json::json!("m-a"),
        );
        let settlement = clamped.apply_config_option_response(
            &serde_json::json!({"configOptions": model_option("m-b")}),
            "model",
            &serde_json::json!("m-a"),
        );
        assert_eq!(
            settlement,
            ModelSwitchSettlement::Clamped {
                requested: "m-a".to_string(),
                settled: "m-b".to_string()
            }
        );
        assert_eq!(clamped.model, "m-b");
        assert_eq!(clamped.model_pending, None);
        // catalog（choices）随权威列表刷新，不得残留旧模型状态。
        assert_eq!(
            clamped.model_choices,
            vec!["m-a".to_string(), "m-b".to_string()]
        );

        // 空回声 → Pending（乐观值保留但可辨识为未确认），catalog 不被清空。
        let mut pending = session();
        pending.config_options = model_option("m-a").as_array().unwrap().clone();
        pending.model_surface = ModelSurface::ConfigOption {
            config_id: "model-selection".to_string(),
        };
        pending.model_choices = vec!["m-a".to_string(), "m-b".to_string()];
        let settlement = pending.apply_config_option_response(
            &serde_json::json!({"configOptions": []}),
            "model",
            &serde_json::json!("m-b"),
        );
        assert_eq!(
            settlement,
            ModelSwitchSettlement::Pending {
                requested: "m-b".to_string()
            }
        );
        assert_eq!(pending.model, "m-b");
        assert_eq!(pending.model_pending.as_deref(), Some("m-b"));
        assert_eq!(
            pending.model_choices,
            vec!["m-a".to_string(), "m-b".to_string()]
        );

        // 后续 session_info_update 的完整 models 状态覆盖 pending。
        let committed = pending.apply_models_state(&serde_json::json!({
            "currentModelId": "m-b",
            "availableModels": [{"modelId": "m-a"}, {"modelId": "m-b"}]
        }));
        assert!(committed);
        assert_eq!(pending.model_pending, None);

        // 非 model 键不受 pending 语义影响。
        let mut mode_key = session();
        let settlement = mode_key.apply_config_option_response(
            &serde_json::json!({}),
            "mode",
            &serde_json::json!("accept_edits"),
        );
        assert_eq!(settlement, ModelSwitchSettlement::NotModel);
        assert_eq!(mode_key.mode.as_deref(), Some("accept_edits"));
    }

    // ── #97/D97-3/D97-4：异步全量刷新与重复 push 幂等 ──

    #[test]
    fn apply_models_state_refreshes_full_catalog_and_dedups_repeated_pushes() {
        // 验收 4：session_info_update 的完整模型列表同步 choices + current。
        let mut session = session();
        session.model = "m-old".to_string();
        session.model_pending = Some("m-old".to_string());
        let committed = session.apply_models_state(&serde_json::json!({
            "currentModelId": "m-new",
            "availableModels": [{"modelId": "m-new", "name": "New"}, {"modelId": "m-legacy"}]
        }));
        assert!(committed);
        assert_eq!(session.model, "m-new");
        assert_eq!(session.model_surface, ModelSurface::ModelsState);
        assert_eq!(
            session.model_choices,
            vec!["m-new".to_string(), "m-legacy".to_string()]
        );
        assert_eq!(session.model_pending, None);

        // 完全相同的 push 重复到达 → 丢弃 + 计数，不再提交。
        let committed = session.apply_models_state(&serde_json::json!({
            "currentModelId": "m-new",
            "availableModels": [{"modelId": "m-new", "name": "New"}, {"modelId": "m-legacy"}]
        }));
        assert!(!committed);
        assert_eq!(session.selector_duplicate_pushes, 1);
        assert_eq!(session.model, "m-new");

        // 新列表到达 → 正常提交并刷新。
        let committed = session.apply_models_state(&serde_json::json!({
            "currentModelId": "m-new",
            "availableModels": [{"modelId": "m-new"}, {"modelId": "m-extra"}]
        }));
        assert!(committed);
        assert_eq!(
            session.model_choices,
            vec!["m-new".to_string(), "m-extra".to_string()]
        );
        assert_eq!(session.selector_duplicate_pushes, 1);

        // models 状态不携带 choices 且 ConfigOption 面在宣告 → 不清空其 choices。
        let mut config_backed = SessionInfo::new(
            "remote-1".to_string(),
            String::new(),
            "C:/workspace".to_string(),
            false,
            1,
        );
        config_backed.config_options = vec![serde_json::json!({
            "id": "model-selection",
            "category": "model",
            "options": [{"valueId": "m-a"}, {"valueId": "m-b"}],
            "currentValue": "m-a"
        })];
        config_backed.model_surface = ModelSurface::ConfigOption {
            config_id: "model-selection".to_string(),
        };
        config_backed.model_choices = vec!["m-a".to_string(), "m-b".to_string()];
        let committed =
            config_backed.apply_models_state(&serde_json::json!({"currentModelId": "m-b"}));
        assert!(committed);
        assert_eq!(config_backed.model, "m-b");
        assert_eq!(
            config_backed.model_surface,
            ModelSurface::ConfigOption {
                config_id: "model-selection".to_string()
            }
        );
        assert_eq!(
            config_backed.model_choices,
            vec!["m-a".to_string(), "m-b".to_string()]
        );
    }

    /// D97-7（评审修正回归）：current-only 的 models push 不得把 ModelsState 面降级
    /// 成 None（否则模型选择器在第一次增量推送后永久只读），choices 原样保留；
    /// 无 current 维度的 push 不得清除 pending。
    #[test]
    fn models_push_without_catalog_preserves_models_state_surface() {
        let mut session = session();
        session.apply_models_state(&serde_json::json!({
            "currentModelId": "m-1",
            "availableModels": [{"modelId": "m-1"}, {"modelId": "m-2"}]
        }));
        assert_eq!(session.model_surface, ModelSurface::ModelsState);
        session.model_pending = Some("m-2".to_string());

        // current-only push（合法 wire 形状）：current 更新，面与 choices 不动，
        // pending 因携带 current 维度被清除。
        let committed = session.apply_models_state(&serde_json::json!({"currentModelId": "m-2"}));
        assert!(committed);
        assert_eq!(session.model, "m-2");
        assert_eq!(session.model_surface, ModelSurface::ModelsState);
        assert_eq!(
            session.model_choices,
            vec!["m-1".to_string(), "m-2".to_string()]
        );
        assert_eq!(session.model_pending, None);
        // 降级后仍可切换（回归断言：resolve 不因面丢失而拒绝）。
        assert!(resolve_model_switch_target(None, "model", &session.model_surface).is_ok());

        // 仅列表、无 current 的 push：面/choices 刷新，但 pending 保留（未构成确认）。
        session.model_pending = Some("m-2".to_string());
        let committed = session.apply_models_state(&serde_json::json!({
            "availableModels": [{"modelId": "m-1"}, {"modelId": "m-3"}]
        }));
        assert!(committed);
        assert_eq!(session.model_surface, ModelSurface::ModelsState);
        assert_eq!(
            session.model_choices,
            vec!["m-1".to_string(), "m-3".to_string()]
        );
        assert_eq!(session.model_pending.as_deref(), Some("m-2"));
        // models: null 同样不得降级既有面。
        let committed = session.apply_models_state(&serde_json::Value::Null);
        assert!(committed);
        assert_eq!(session.model_surface, ModelSurface::ModelsState);
        assert_eq!(
            session.model_choices,
            vec!["m-1".to_string(), "m-3".to_string()]
        );
    }

    /// D97-2（评审修正回归）：apply_session_response（含 persist.rs 原位 load 路径）
    /// 携带权威 model 维度时清除 pending；无 model 维度则保留。
    #[test]
    fn session_response_clears_pending_on_authoritative_model_dimension() {
        // models.current 路径。
        {
            let mut session = session();
            session.model_pending = Some("stale".to_string());
            session.apply_session_response(&serde_json::json!({
                "models": {"currentModelId": "settled"}
            }));
            assert_eq!(session.model, "settled");
            assert_eq!(session.model_pending, None);
        }
        // 根级 currentModelId 变体路径。
        {
            let mut session = session();
            session.model_pending = Some("stale".to_string());
            session
                .apply_session_response(&serde_json::json!({"current_model_id": "root-settled"}));
            assert_eq!(session.model, "root-settled");
            assert_eq!(session.model_pending, None);
        }
        // configOptions model 选项路径。
        {
            let mut session = session();
            session.model_pending = Some("stale".to_string());
            session.apply_session_response(&serde_json::json!({
                "configOptions": [{
                    "id": "model-selection",
                    "category": "model",
                    "options": [{"valueId": "m-a"}],
                    "currentValue": "m-a"
                }]
            }));
            assert_eq!(session.model, "m-a");
            assert_eq!(session.model_pending, None);
        }
        // N2（第二轮评审）：model 选项存在但无可提取 currentValue → 不构成确认，
        // pending 保留。
        {
            let mut session = session();
            session.model_pending = Some("keep".to_string());
            session.apply_session_response(&serde_json::json!({
                "configOptions": [{
                    "id": "model-selection",
                    "category": "model",
                    "options": [{"valueId": "m-a"}]
                }]
            }));
            assert_eq!(session.model_pending.as_deref(), Some("keep"));
        }
        // 无 model 维度的响应：pending 保留（快照未构成确认）。
        let mut session = session();
        session.model_pending = Some("keep".to_string());
        session.apply_session_response(&serde_json::json!({"modes": {"currentModeId": "default"}}));
        assert_eq!(session.model_pending.as_deref(), Some("keep"));
    }

    /// D97-2：权威响应但不携带 model 维度 → Authoritative{confirmed_model:false}，
    /// pending 保留（权威列表无 model 选项 ≠ model 确认）。
    #[test]
    fn authoritative_response_without_model_dimension_reports_unconfirmed() {
        let mut session = session();
        session.model_pending = Some("m-a".to_string());
        let settlement = session.apply_config_option_response(
            &serde_json::json!({"configOptions": [{
                "id": "reasoning_effort",
                "category": "thought_level",
                "options": [{"valueId": "low"}, {"valueId": "high"}],
                "currentValue": "low"
            }]}),
            "model",
            &serde_json::json!("m-a"),
        );
        assert_eq!(
            settlement,
            ModelSwitchSettlement::Authoritative {
                requested: Some("m-a".to_string()),
                confirmed_model: false
            }
        );
        assert_eq!(session.model_pending.as_deref(), Some("m-a"));
    }

    /// 验收 9（评审补强）：configOptions 同时含已知 model 选项与未知 kind 时，
    /// 已知 selector 照常刷新，未知 kind 原样保留在 envelope 中且不被当可执行选项。
    #[test]
    fn unknown_option_kind_alongside_known_selector_preserves_surface() {
        let mut session = session();
        session.apply_session_response(&serde_json::json!({
            "configOptions": [
                {
                    "id": "model-selection",
                    "category": "model",
                    "options": [{"valueId": "m-a"}],
                    "currentValue": "m-a"
                },
                {"id": "future-kind", "payload": {"opaque": true}}
            ]
        }));
        assert_eq!(
            session.model_surface,
            ModelSurface::ConfigOption {
                config_id: "model-selection".to_string()
            }
        );
        assert_eq!(session.model, "m-a");
        assert_eq!(session.config_options.len(), 2, "未知 kind 原样保留");
        // 语义定位只认白名单别名，未知 kind 不会成为可执行 model 选项。
        assert_eq!(
            find_config_option(&session.config_options, "model").and_then(config_option_identity),
            Some("model-selection".to_string())
        );
    }

    // ── #97/D97-4：raw selector envelope 有界保留 ──

    #[test]
    fn oversized_selector_envelope_is_refused_without_corrupting_known_state() {
        let mut session = session();
        let known = serde_json::json!([{
            "id": "model-selection",
            "category": "model",
            "options": [{"valueId": "m-a"}],
            "currentValue": "m-a"
        }]);
        session.config_options = known.as_array().unwrap().clone();
        // 构造超过 256KiB 的未知 kind 巨型 option 数组。
        let blob = "x".repeat(SELECTOR_ENVELOPE_MAX_BYTES + 1);
        let oversized = serde_json::json!([{"id": "future-kind", "payload": blob}]);
        assert!(!session.replace_config_options(oversized.as_array().unwrap()));
        assert_eq!(session.selector_envelope_dropped, 1);
        // 已知 selector 状态原样保留（不截断、不部分替换）。
        assert_eq!(&session.config_options, known.as_array().unwrap());
        // 正常大小仍可替换。
        assert!(
            session.replace_config_options(serde_json::json!([{"id": "m"}]).as_array().unwrap())
        );
        assert_eq!(session.config_options.len(), 1);
    }

    // ── #97/D97-5：显式声明 + 宣告面的 config id 保留 ──

    #[test]
    fn explicit_config_option_declaration_keeps_advertised_config_id() {
        // 显式 ConfigOption 声明 + 会话宣告了非标准 config id → 原样返回，不降级 "model"。
        let (target, config_id) = resolve_model_switch_target(
            Some(SetModelApi::ConfigOption),
            "model",
            &ModelSurface::ConfigOption {
                config_id: "model-selection".to_string(),
            },
        )
        .unwrap();
        assert_eq!(target, crate::agent_config::ModelSwitchTarget::ConfigOption);
        assert_eq!(config_id.as_deref(), Some("model-selection"));

        // N3（第二轮评审）：model 语义别名键 + 宣告面 → 宣告 id 同样生效
        //（提取判据与 control 层校验/诊断门同款别名匹配）。
        let (target, config_id) = resolve_model_switch_target(
            Some(SetModelApi::ConfigOption),
            "models",
            &ModelSurface::ConfigOption {
                config_id: "model-selection".to_string(),
            },
        )
        .unwrap();
        assert_eq!(target, crate::agent_config::ModelSwitchTarget::ConfigOption);
        assert_eq!(config_id.as_deref(), Some("model-selection"));

        // 声明了 ConfigOption 但会话未宣告 config id → None（兼容规则：语义键 + 诊断）。
        let (target, config_id) = resolve_model_switch_target(
            Some(SetModelApi::ConfigOption),
            "model",
            &ModelSurface::None,
        )
        .unwrap();
        assert_eq!(target, crate::agent_config::ModelSwitchTarget::ConfigOption);
        assert_eq!(config_id, None);

        // 非 model 键（mode/reasoning）不受模型面影响：语义键即 config id。
        let (target, config_id) = resolve_model_switch_target(
            Some(SetModelApi::ConfigOption),
            "reasoning_effort",
            &ModelSurface::ConfigOption {
                config_id: "model-selection".to_string(),
            },
        )
        .unwrap();
        assert_eq!(target, crate::agent_config::ModelSwitchTarget::ConfigOption);
        assert_eq!(config_id, None);
    }

    #[test]
    fn validate_advertised_choice_carries_stable_code_for_dependent_options() {
        // D97-6：依赖 option（reasoning 组）发送校验复用同一不变量，code 稳定。
        let error = validate_advertised_choice(
            "ultra",
            &["low".to_string(), "high".to_string()],
            "reasoning_not_advertised",
        )
        .unwrap_err();
        let message = error.to_string();
        assert!(message.contains("reasoning_not_advertised"), "{message}");
        assert!(validate_advertised_choice(
            "high",
            &["high".to_string()],
            "reasoning_not_advertised"
        )
        .is_ok());
        // 未宣告列表 → 放行（现状兼容）。
        assert!(validate_advertised_choice("anything", &[], "reasoning_not_advertised").is_ok());
    }

    /// ADR-0017/#217：在途回合标记的置位与按键清理语义。
    #[test]
    fn turn_in_flight_mark_keyed_clear_semantics() {
        let mut session = SessionInfo::new(
            "peri-l1".to_string(),
            String::new(),
            ".".to_string(),
            true,
            0,
        );
        assert!(!session.turn_in_flight(), "新会话必须无在途回合");

        session.mark_turn_in_flight(1, 7);
        assert!(session.turn_in_flight());

        // 同键重复置位幂等（对齐 begin 的 AlreadyActive 语义）。
        session.mark_turn_in_flight(1, 7);
        assert!(session.turn_in_flight());

        // 键不匹配（陈旧回合迟到终态）：不清理。
        assert!(!session.clear_turn_in_flight(1, 8));
        assert!(
            session.turn_in_flight(),
            "陈旧 turn_id 不得清掉新回合的标记"
        );
        assert!(!session.clear_turn_in_flight(2, 7));
        assert!(session.turn_in_flight(), "旧代际不得清掉新代际的标记");

        // 键匹配：清理发生，且再次清理为 no-op。
        assert!(session.clear_turn_in_flight(1, 7));
        assert!(!session.turn_in_flight());
        assert!(!session.clear_turn_in_flight(1, 7));
    }

    /// ADR-0017/#217：force-clear 无条件清理 + 返回清理前状态（诊断）。
    #[test]
    fn turn_in_flight_force_clear_is_unconditional_and_reported() {
        let mut session = SessionInfo::new(
            "peri-l2".to_string(),
            String::new(),
            ".".to_string(),
            true,
            0,
        );
        assert!(
            !session.force_clear_turn_in_flight(),
            "无标记时 force-clear 报 false"
        );
        session.mark_turn_in_flight(9, 9);
        assert!(session.force_clear_turn_in_flight());
        assert!(!session.turn_in_flight());
        assert!(
            !session.force_clear_turn_in_flight(),
            "重复 force-clear 幂等"
        );
    }
}
