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

/// 原子写：临时文件 + rename，中断也不会留下半截 JSON。
pub fn save_to_file(state: &PetState, path: &std::path::Path) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

/// 容错读：文件缺失/损坏一律返回 None（启动时静默降级为新宠物）。
pub fn load_from_file(path: &std::path::Path) -> Option<PetState> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_load_round_trips_state() {
        let dir = std::env::temp_dir().join(format!("pylon-pet-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pylon-pet.json");
        let mut pet = PetState::new_at(1_000);
        pet.apply(AiEvent::PromptCompleted, 2_000);
        save_to_file(&pet, &path).expect("save must succeed");
        let loaded = load_from_file(&path).expect("load must succeed");
        assert_eq!(loaded.name, "微栖");
        assert_eq!(loaded.xp, pet.xp);
        assert_eq!(loaded.stats.prompts_completed, 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn load_missing_or_corrupt_returns_none() {
        let dir = std::env::temp_dir().join(format!("pylon-pet-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let missing = dir.join("missing.json");
        assert!(load_from_file(&missing).is_none());
        let corrupt = dir.join("corrupt.json");
        std::fs::write(&corrupt, "{not json").unwrap();
        assert!(load_from_file(&corrupt).is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
