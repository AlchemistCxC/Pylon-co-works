//! Tauri 与独立宠物核心状态机之间的薄适配层。

pub use pylon_pet_core::{AiEvent, GrowthStage, PetState, ToolOutcome};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
pub struct PetView<'a> {
    #[serde(flatten)]
    pub state: &'a PetState,
    pub stage: GrowthStage,
    pub title: &'static str,
    pub age_days: u64,
    pub next_stage_xp: Option<u32>,
    pub growth_progress: u8,
}

pub fn view(state: &PetState) -> PetView<'_> {
    let stage = state.stage();
    PetView {
        state,
        stage,
        title: stage.title(),
        age_days: state.age_days(now_ms()),
        next_stage_xp: state.next_stage_xp(),
        growth_progress: state.growth_progress(),
    }
}

pub fn restore(state: &mut PetState, saved: PetState) {
    *state = PetState::restore(saved, now_ms());
}

pub fn on_user_sent(state: &mut PetState) {
    state.apply(AiEvent::UserSent, now_ms());
}

pub fn on_first_chunk(state: &mut PetState) {
    state.apply(AiEvent::FirstChunk, now_ms());
}

pub fn on_done(state: &mut PetState) {
    state.apply(AiEvent::PromptCompleted, now_ms());
}

pub fn on_error(state: &mut PetState) {
    state.apply(AiEvent::PromptFailed, now_ms());
}

pub fn on_poke(state: &mut PetState) {
    state.apply(AiEvent::Poke, now_ms());
}

pub fn on_feed(state: &mut PetState) {
    state.apply(AiEvent::Feed, now_ms());
}

pub fn on_usage_update(state: &mut PetState, total: u64) {
    state.apply(AiEvent::TokenUsage { total }, now_ms());
}

pub fn on_tool_started(state: &mut PetState) {
    state.apply(AiEvent::ToolCall { outcome: ToolOutcome::Started }, now_ms());
}

pub fn on_tool_success(state: &mut PetState) {
    state.apply(AiEvent::ToolCall { outcome: ToolOutcome::Succeeded }, now_ms());
}

pub fn on_tool_failure(state: &mut PetState) {
    state.apply(AiEvent::ToolCall { outcome: ToolOutcome::Failed }, now_ms());
}

pub fn on_agent_connected(state: &mut PetState) {
    state.apply(AiEvent::AgentConnected, now_ms());
}

pub fn on_agent_crashed(state: &mut PetState) {
    state.apply(AiEvent::AgentCrashed, now_ms());
}

pub fn recall_memory(state: &mut PetState) {
    state.msg = state.recall_memory().or_else(|| Some("还没有形成长期记忆。".into()));
}

pub fn check_sleepy(state: &mut PetState) -> bool {
    state.check_sleepy(now_ms())
}

pub fn daily_visit(state: &mut PetState) {
    state.apply(AiEvent::Visit, now_ms());
}

pub fn rename(state: &mut PetState, value: &str) {
    state.rename(value);
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
