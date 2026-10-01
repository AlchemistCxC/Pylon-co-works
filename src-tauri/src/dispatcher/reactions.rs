//! 产品反应订阅缝（#416 W2 步骤③，§4.1 A 方案 R2 修正形态）：kernel 泵在既有
//! 转移点调用 [`KernelReactionSink`]，pet 是宿主装配的唯一实现
//! （[`PetReactionSink`]）。`PetEvent` 保持「解析/应用分离」：本模块（kernel
//! 层）只派生事件，应用正身由 sink 实现侧 match——kernel 决策面不再点名
//! pet 消费者（`RoutingDecision.apply_pet` 已删，门控走
//! `wants_live_reactions(class)`）。
//!
//! 三个表征基准逐条保持：
//! - **收集序 = 应用序**：感知事件在 sessions 锁内按序收集
//!   （[`derive_session_reactions`] 与 FirstChunk/CodeSeen），锁外经 sink 按
//!   同一顺序逐条应用（原 mod.rs O7 注释钉住）。
//! - **commit 后 publish 前**：sink 调用点 = 原 pet 应用点（持久化成功之后、
//!   代际复核与发布之前；draft commit 失败停泵判定仍在 sink 调用之后）。
//! - **锁外应用**：sink 一律在 sessions 锁外调用（`wants_live_reactions`
//!   除外——它是纯查询，在锁内取门控）。

use std::sync::Arc;

use crate::pet::PetState;
use crate::session::{config_option_key_matches, extract_tool_file_name, value_as_string};

use super::routing::RoutingClass;

/// C11/O7：一条 session/update 事件需要施加到宠物的感知事件。
/// 按收集顺序产出，调用方在 sessions 锁外逐条应用——收集顺序 = 应用顺序。
/// G3 §2.2.1：agent_message_chunk 的 FirstChunk/CodeSeen 与 apply_update_event 产出
/// 统一走收集路径（原 :366/:374 语句级独立锁 → 同锁收集、锁外按序应用，E12 接受）。
/// C11：回放（is_replay）事件仅同步 session 状态，不产生宠物感知
/// （回放不刷 xp/bond/掉落）。
#[derive(Debug)]
pub(crate) enum PetEvent {
    /// 原 agent_message_chunk 分支 on_first_chunk（每 !replay chunk 一次）。
    FirstChunk,
    /// 原 on_code_seen（text.contains("```")）。
    CodeSeen,
    UsageUpdate(u64),
    ToolStarted(crate::pet::ToolKind),
    CodeFile(String),
    ToolSucceeded,
    ToolFailed,
    ToolCancelled,
    ModelChanged(String),
    ModeChanged(String),
}

/// 事件应用到 pet 状态（原 `PetEvent::apply` 的 match 正身，随枚举迁出 kernel
/// 决策面——§4.1：`apply` 改由 pet 侧 sink 实现时 match）。生产路径一律经
/// [`KernelReactionSink`]；pub(crate) 仅供 characterization 测试直接驱动状态。
pub(crate) fn apply_pet_event(state: &mut PetState, event: PetEvent) {
    match event {
        PetEvent::FirstChunk => crate::pet::on_first_chunk(state),
        PetEvent::CodeSeen => crate::pet::on_code_seen(state),
        PetEvent::UsageUpdate(total) => crate::pet::on_usage_update(state, total),
        PetEvent::ToolStarted(kind) => crate::pet::on_tool_started_kind(state, kind),
        PetEvent::CodeFile(file) => crate::pet::record_code_file(state, &file),
        PetEvent::ToolSucceeded => crate::pet::on_tool_success(state),
        PetEvent::ToolFailed => crate::pet::on_tool_failure(state),
        PetEvent::ToolCancelled => crate::pet::on_tool_cancelled(state),
        PetEvent::ModelChanged(model) => crate::pet::on_model_changed(state, &model),
        PetEvent::ModeChanged(mode) => crate::pet::on_mode_changed(state, &mode),
    }
}

/// prompt 收尾·失败侧终态因由（M5 感知）：refusal 区分于普通失败；
/// max_tokens 转正为合法终态但感知独立（on_maxed）。三位点都在 pylon:error /
/// done 广播之前。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TurnFailureCause {
    Refused,
    Erred,
    Maxed,
}

/// Kernel 侧产品反应订阅缝（§4.1/R2 修正形态）。调用纪律（实现者必须遵守）：
/// ① **禁阻塞、禁 IO**：调用点在 dispatcher 泵热路径与 prompt 收尾——现状为
///    std Mutex + 纯内存（μs 级）；IO 型消费者必须在实现内部转 channel/task。
/// ② **无 panic 纪律**：sink panic 会穿透调用点杀死泵任务（`let _ = lock()`
///    只吸收既往中毒，不吸收本次 panic）——与现状语义本就等价，新增消费者
///    实现不得引入新 panic 面。
/// ③ **锁中毒吸收**：`let _ = lock()` 语义须在实现内复刻（中毒不终止泵）。
pub(crate) trait KernelReactionSink: Send + Sync {
    /// 锁外、commit 后 publish 前调用。events 按收集顺序整批交付，实现必须
    /// 按序逐条应用（收集顺序 = 应用顺序），每事件一次锁获取 + 中毒吸收。
    fn on_pet_events(&self, events: Vec<PetEvent>);
    /// prompt 收尾·失败侧位点（refused/error/maxed 判定处，在 done 广播
    /// **之前**）。两位点拆分是 R2 修正：单一 `on_turn_terminal` 无法同时占住
    /// done 广播两侧（refused/error/maxed 在前、on_done 在后）。
    /// 调用点：session/prompt/settle.rs（#416 W2 wave2 分位点接线）。
    fn on_turn_failed(&self, cause: TurnFailureCause);
    /// prompt 收尾·done 位点（done 广播 + channel 终帧**之后**、persist 之前）。
    /// 调用点：session/prompt/settle.rs `finalize_response`（同上接线）。
    fn on_turn_done(&self);
    /// 崩溃感知（crash_reconnect 原 `pet::on_agent_crashed` 直呼点）。独立方法
    /// 而非 PetEvent 变体——崩溃不是一条 session/update 派生事件（R2 修正）。
    fn on_agent_crashed(&self);
    /// prompt 发起路径·错误位点（session ensure 失败处，turn 尚未 begin——
    /// 与收尾位点的 [`Self::on_turn_failed`] 语义不同，故独立命名）。
    /// 调用点：session/prompt/wait.rs ensure_session_mapping 失败臂
    /// （#425 件6 补缝，原 `pet::on_error` 直呼点）。
    fn on_prompt_error(&self);
    /// prompt 发起·用户消息已送出位点（after-build hook 之后、user payload
    /// 构造之前）。调用点：session/prompt/wait.rs（#425 件6 补缝，原
    /// `pet::on_user_sent` 直呼点）。
    fn on_user_sent(&self);
    /// prompt 等待·超时判死位点（first-token/idle/user-cancel 判定处）。
    /// 调用点：session/prompt/settle.rs（#425 件6 补缝，原 `pet::on_timeout`
    /// 直呼点；M5 感知：超时 → 发呆，区别于普通失败）。
    fn on_timeout(&self);
    /// 是否收集该类帧的实时感知事件。取代 `RoutingDecision.apply_pet`（决策面
    /// 回归纯协议语义）。门控必须钉在 class==Live：Replay 与 Boundary 一律
    /// 不产感知（C11 回放门 + 终态边界帧；R2 修正——只丢 Replay 会改变终态
    /// 边界帧的宠物行为）。在 sessions 锁内调用，实现必须为纯查询（禁锁/禁IO）。
    fn wants_live_reactions(&self, class: RoutingClass) -> bool;
}

/// pet 宿主装配实现：包 pet 状态锁。应用粒度与原四应用点逐一一致——每事件
/// 一次锁获取、`let _ = lock()` 吸收既往中毒；pet 函数族保持无 panic 纪律。
pub(crate) struct PetReactionSink {
    pet: Arc<std::sync::Mutex<PetState>>,
}

impl PetReactionSink {
    pub(crate) fn new(pet: Arc<std::sync::Mutex<PetState>>) -> Self {
        Self { pet }
    }
}

impl KernelReactionSink for PetReactionSink {
    fn on_pet_events(&self, events: Vec<PetEvent>) {
        for event in events {
            let _ = self
                .pet
                .lock()
                .map(|mut state| apply_pet_event(&mut state, event));
        }
    }

    fn on_turn_failed(&self, cause: TurnFailureCause) {
        let _ = self.pet.lock().map(|mut state| match cause {
            TurnFailureCause::Refused => crate::pet::on_refused(&mut state),
            TurnFailureCause::Erred => crate::pet::on_error(&mut state),
            TurnFailureCause::Maxed => crate::pet::on_maxed(&mut state),
        });
    }

    fn on_turn_done(&self) {
        let _ = self
            .pet
            .lock()
            .map(|mut state| crate::pet::on_done(&mut state));
    }

    fn on_agent_crashed(&self) {
        let _ = self
            .pet
            .lock()
            .map(|mut state| crate::pet::on_agent_crashed(&mut state));
    }

    fn on_prompt_error(&self) {
        let _ = self
            .pet
            .lock()
            .map(|mut state| crate::pet::on_error(&mut state));
    }

    fn on_user_sent(&self) {
        let _ = self
            .pet
            .lock()
            .map(|mut state| crate::pet::on_user_sent(&mut state));
    }

    fn on_timeout(&self) {
        let _ = self
            .pet
            .lock()
            .map(|mut state| crate::pet::on_timeout(&mut state));
    }

    fn wants_live_reactions(&self, class: RoutingClass) -> bool {
        matches!(class, RoutingClass::Live)
    }
}

/// Kernel 派生：对一条 session/update 事件施加 session 状态变更，并按收集顺序
/// 返回实时感知事件（§4.1：原 `apply_update_event_with_pet_policy` 改名收窄——
/// 产出不再点名 pet，应用交由 [`KernelReactionSink`]）。调用方持有 sessions 锁
/// 时调用、锁外逐条应用。
/// `live_reactions` 门控取 `sink.wants_live_reactions(decision.class)`：
/// C11 下回放（Replay）与终态边界（Boundary）帧均不产出任何感知事件。
pub(crate) fn derive_session_reactions(
    session: &mut crate::session::SessionInfo,
    update: &serde_json::Value,
    variant: Option<crate::acp::SessionUpdateVariant>,
    live_reactions: bool,
) -> Vec<PetEvent> {
    // Keep the ACP reducer alongside the legacy SessionInfo fields during the
    // migration. It emits no UI events; canonical commit/publication remains
    // governed by the existing routing transaction below.
    // P2（#334）：零拷贝直喂——原实现按 `{"update": update}` 重包一份整树深拷贝
    // 喂 `apply`，逐帧成本随 payload 体量放大（frame_path_bench 读数一）。
    let deltas = session.acp_state.apply_session_update(update);
    // Typed reducer output is consumed here at the kernel boundary. Existing
    // canonical/session updates below remain the publication authority; this
    // adapter only mirrors reducer-owned scalar domains into the live session.
    for delta in deltas {
        match delta {
            crate::acp::AcpStateDelta::Usage {
                used,
                size,
                input,
                output,
            } => {
                session.tokens_total = used;
                session.context_size = size.unwrap_or(0);
                if let Some(input) = input {
                    session.tokens_in = input;
                }
                if let Some(output) = output {
                    session.tokens_out = output;
                }
            }
            // Mode/model remain handled by the existing event transaction below;
            // consuming them here would suppress its change detection.
            crate::acp::AcpStateDelta::Mode { .. }
            | crate::acp::AcpStateDelta::Model { .. }
            | crate::acp::AcpStateDelta::PermissionQueueDepth { .. }
            | crate::acp::AcpStateDelta::PermissionRequested { .. }
            | crate::acp::AcpStateDelta::Text { .. }
            | crate::acp::AcpStateDelta::Reasoning { .. }
            | crate::acp::AcpStateDelta::UserText { .. }
            | crate::acp::AcpStateDelta::ToolStarted { .. }
            | crate::acp::AcpStateDelta::ToolUpdated { .. }
            | crate::acp::AcpStateDelta::Plan { .. }
            | crate::acp::AcpStateDelta::Unknown { .. } => {}
        }
    }
    let mut pet_events: Vec<PetEvent> = Vec::new();
    match variant {
        Some(crate::acp::SessionUpdateVariant::UsageUpdate) => {
            if let Some(meta) = update.get("_meta") {
                if let Some(model) = meta.get("model").and_then(|v| v.as_str()) {
                    session.model = model.to_string();
                    // #97/D97-3（评审修正）：usage _meta.model 是权威 current 通道，
                    // 与单值 config_option_update 分支同契约——清除客户端 requested
                    // 未确认态，三态收敛不留漏口。
                    session.model_pending = None;
                }
            }
            if live_reactions {
                pet_events.push(PetEvent::UsageUpdate(session.tokens_total));
            }
        }
        Some(crate::acp::SessionUpdateVariant::ToolCall) => {
            if live_reactions {
                // M5 感知：title → 工具分类（吃代码/捏朋友）；rawInput 提取文件名（脱敏摘要）
                let title = update.get("title").and_then(|v| v.as_str()).unwrap_or("");
                let kind = crate::pet::ToolKind::classify(title);
                pet_events.push(PetEvent::ToolStarted(kind));
                // rawInput 仅提取文件名白名单形态（"path":"..."），原文绝不下沉
                if let Some(raw) = update.get("rawInput").and_then(|v| v.as_str()) {
                    if let Some(file) = extract_tool_file_name(raw) {
                        pet_events.push(PetEvent::CodeFile(file));
                    }
                }
            }
        }
        Some(crate::acp::SessionUpdateVariant::ToolCallUpdate) => {
            if live_reactions {
                match update.get("status").and_then(|v| v.as_str()) {
                    Some("completed") => pet_events.push(PetEvent::ToolSucceeded),
                    Some("failed") => pet_events.push(PetEvent::ToolFailed),
                    Some("cancelled") => pet_events.push(PetEvent::ToolCancelled),
                    _ => {}
                }
            }
        }
        Some(crate::acp::SessionUpdateVariant::SessionInfoUpdate) => {
            if let Some(title) = update.get("title").and_then(|v| v.as_str()) {
                session.title = title.to_string();
            }
            // P56/D2.3 + #97/D97-3：payload 带 models 状态（camelCase/snake_case）时
            // 全量消费——current 提取 + 模型面/choices 完整刷新（不再只更新当前值），
            // 并清除客户端 requested 未确认态（Agent 推送的完整状态是权威）。
            // apply_models_state 内置 fingerprint 幂等（#97/D97-4）：完全相同的
            // models push 重复到达只提交一次，丢弃计数留在 session 诊断字段。
            if let Some(models) = update.get("models") {
                session.apply_models_state(models);
            }
        }
        Some(crate::acp::SessionUpdateVariant::ConfigOptionUpdate) => {
            if let Some(options) = update.get("configOptions").and_then(|v| v.as_array()) {
                // #97/D97-4：有界替换——超限 envelope 拒绝入库（已知 selector 状态
                // 保持不变 + 计数），未知 option kind 随原样数组保留。
                // N1（第二轮评审）：数组携带可提取 model currentValue（权威回显的
                // model 维度）时清除 requested 未确认态，pending 生命周期无漏口。
                session.apply_config_options_push(options);
            } else {
                // P56/D2.2：option_key 读取补官方 configId/config_id 键；与 "model"/
                // "mode" 比较前按 find_config_option 同款归一化规则精确匹配（不做
                // 子串包含猜测）。
                let option_key = update
                    .get("configId")
                    .or_else(|| update.get("config_id"))
                    .or_else(|| update.get("id"))
                    .or_else(|| update.get("key"))
                    .and_then(|v| v.as_str());
                let is_model_key =
                    option_key.is_some_and(|key| config_option_key_matches(key, "model"));
                let is_mode_key =
                    option_key.is_some_and(|key| config_option_key_matches(key, "mode"));
                // N4（第二轮评审）：model 值走 machine-id-only 提取（显示名不当 id，
                // 与 models-state 通道同一不变量）；mode 等其余语义保持宽容提取。
                let current = update
                    .get("currentValue")
                    .or_else(|| update.get("value"))
                    .and_then(|value| {
                        if is_model_key {
                            crate::session::value_as_machine_id(value)
                        } else {
                            value_as_string(value)
                        }
                    });
                if is_model_key {
                    if let Some(model) = current {
                        // M5 感知：模型切换。C11：回放不推送——回放时 session 为新对象，
                        // model 为空必误判 changed（对齐 usage/tool 全部门控）。
                        // #97/D97-3：Agent 推送的 current 是权威值——清除客户端
                        // requested 未确认态。
                        let changed = session.model != model;
                        session.model = model.clone();
                        session.model_pending = None;
                        if changed && live_reactions {
                            pet_events.push(PetEvent::ModelChanged(model));
                        }
                    }
                } else if is_mode_key {
                    if let Some(mode) = current {
                        let changed = session.mode.as_deref() != Some(mode.as_str());
                        session.mode = Some(mode.clone());
                        if changed && live_reactions {
                            // M5 感知：工作模式切换（C11：回放不推送）
                            pet_events.push(PetEvent::ModeChanged(mode));
                        }
                    }
                }
            }
        }
        Some(crate::acp::SessionUpdateVariant::AvailableCommandsUpdate) => {
            if let Some(commands) = update
                .get("availableCommands")
                .or_else(|| update.get("commands"))
            {
                session.commands_snapshot = Some(commands.clone());
            }
        }
        Some(crate::acp::SessionUpdateVariant::CurrentModeUpdate) => {
            let mode = update
                .get("currentModeId")
                .or_else(|| update.get("modeId"))
                .or_else(|| update.get("mode"))
                .and_then(value_as_string);
            if let Some(mode) = mode {
                let changed = session.mode.as_deref() != Some(mode.as_str());
                // Keep the asynchronously advertised mode in the durable snapshot as
                // well as the typed field; session/load restores snapshots before the
                // response is rebuilt, so this survives agents that only emit updates
                // after session/new or session/load.
                session.mode = Some(mode.clone());
                if changed && live_reactions {
                    pet_events.push(PetEvent::ModeChanged(mode));
                }
            }
        }
        _ => {}
    }
    pet_events
}

/// O7：对一条 session/update 事件施加 session 状态变更，并返回需施加到宠物的
/// 感知事件（按收集顺序）。调用方持有 sessions 锁时调用、锁外逐条应用。
/// C11：回放（is_replay）事件仅同步 session 状态（tokens/title/model/mode），
/// 不产出任何宠物感知事件。
/// 生产路径的 live/replay 感知策略已收口为 `sink.wants_live_reactions(
/// decision.class)`（#416 W2，原布尔包装 apply_update_event_routed 已拆）；
/// 本包装仅剩 C11 宠物策略 characterization 测试消费，故 cfg(test)。
#[cfg(test)]
pub(crate) fn apply_update_event(
    session: &mut crate::session::SessionInfo,
    update: &serde_json::Value,
    variant: Option<crate::acp::SessionUpdateVariant>,
    is_replay: bool,
) -> Vec<PetEvent> {
    derive_session_reactions(session, update, variant, !is_replay)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R2 修正守卫：感知门控必须钉在 class==Live——Replay 与 Boundary 帧一律
    /// 不产感知（只丢 Replay 会改变终态边界帧的宠物行为）。
    #[test]
    fn reaction_gate_drops_replay_and_boundary_frames() {
        let sink = PetReactionSink::new(Arc::new(std::sync::Mutex::new(PetState::default())));
        assert!(sink.wants_live_reactions(RoutingClass::Live));
        assert!(!sink.wants_live_reactions(RoutingClass::Replay));
        assert!(!sink.wants_live_reactions(RoutingClass::Boundary));
    }

    /// #425 件6：prompt 域三处补缝位点的「sink ≡ 直呼」等价锁——同一初始
    /// 状态分别经 [`PetReactionSink`] 与既有 pet 函数族推进，终态 Debug 快照
    /// 必须全等（补缝是纯接缝扩展，行为不变；PetState 无 PartialEq，比较
    /// Debug 字符串）。
    ///
    /// #504：apply 内部取真实墙钟写 `last_tick_at_ms` / `last_activity_at_ms`
    ///（`UserSent` 另写私有的 `last_interaction_at_ms`），sink 路与直呼路两次
    /// 驱动相隔微秒，毫秒跳变落在其间即拆散全等（非行为差异）——比较前对
    /// 两侧归零（`zero_wall_clock_for_test`），表征只锁行为面。
    ///
    /// 防扩展踩坑：`line_idx_by_scene`（HashMap）Debug 迭代序按实例随机——
    /// 当前每驱动恰好一次 `lines::pick`（单键无序歧义）故安全；扩展为多事件
    /// 驱动前须先归一化该字段，否则 Debug 全等将引入非毫秒类新竞态。
    #[test]
    fn prompt_path_sink_methods_match_direct_pet_calls() {
        let drive = |sink_method: fn(&PetReactionSink), pet_fn: fn(&mut PetState)| {
            let shared = Arc::new(std::sync::Mutex::new(PetState::default()));
            sink_method(&PetReactionSink::new(shared.clone()));
            let mut direct = PetState::default();
            pet_fn(&mut direct);
            let mut via_sink = shared.lock().expect("pet lock").clone();
            via_sink.zero_wall_clock_for_test();
            direct.zero_wall_clock_for_test();
            assert_eq!(
                format!("{via_sink:?}"),
                format!("{direct:?}"),
                "sink 位点必须与直呼 pet 函数行为全等"
            );
        };
        drive(|sink| sink.on_prompt_error(), crate::pet::on_error);
        drive(|sink| sink.on_user_sent(), crate::pet::on_user_sent);
        drive(|sink| sink.on_timeout(), crate::pet::on_timeout);
    }
}
