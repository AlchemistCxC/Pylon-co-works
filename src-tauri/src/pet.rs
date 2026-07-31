//! Tauri 与独立宠物核心状态机之间的薄适配层。

pub use pylon_pet_core::{AiEvent, GrowthStage, PetState, ToolKind, ToolOutcome};
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
    /// M7：捏朋友进行中（前端进度展示）。
    pub crafting: bool,
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
        crafting: state.pending_action.is_some(),
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

/// M4：玩耍（消耗 energy，恢复 fun/降低孤独；60s bond 冷却）。
pub fn on_play(state: &mut PetState) {
    state.apply(AiEvent::Play, now_ms());
}

pub fn on_usage_update(state: &mut PetState, total: u64) {
    state.apply(AiEvent::TokenUsage { total }, now_ms());
}

/// M5：工具开始（带分类）——吃代码/捏朋友信号。
pub fn on_tool_started_kind(state: &mut PetState, kind: ToolKind) {
    state.apply(AiEvent::ToolStarted { kind }, now_ms());
}

/// M5：工具被取消（打断）。
pub fn on_tool_cancelled(state: &mut PetState) {
    state.apply(AiEvent::ToolCancelled, now_ms());
}

/// M5：工作模式切换。
pub fn on_mode_changed(state: &mut PetState, mode: &str) {
    state.apply(AiEvent::ModeChanged { mode: mode.to_string() }, now_ms());
}

/// M5：模型切换。
pub fn on_model_changed(state: &mut PetState, model: &str) {
    state.apply(AiEvent::ModelChanged { model: model.to_string() }, now_ms());
}

/// M5：agent 拒绝。
pub fn on_refused(state: &mut PetState) {
    state.apply(AiEvent::PromptRefused, now_ms());
}

/// M5：达到轮次上限。
pub fn on_maxed(state: &mut PetState) {
    state.apply(AiEvent::PromptMaxed, now_ms());
}

/// M5：prompt 超时（发呆）。
pub fn on_timeout(state: &mut PetState) {
    state.apply(AiEvent::PromptTimeout, now_ms());
}

/// M5：输出含代码块。
pub fn on_code_seen(state: &mut PetState) {
    state.apply(AiEvent::CodeSeen, now_ms());
}

/// M5：记录吃过的代码文件名（脱敏摘要）。
pub fn record_code_file(state: &mut PetState, file: &str) {
    state.record_code_file(file);
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

/// M6：主动说话（需求危机/延迟行为完成 → msg）。get_pet 轮询调用。
pub fn poll_voice(state: &mut PetState) -> bool {
    state.poll_voice(now_ms())
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

/// 原子写：唯一临时文件 + rename，中断也不会留下半截 JSON。
/// 审查修复：temp 名含 pid+时间戳——get_pet 轮询与 pet_action 可并发，固定 temp 名
/// 会互相截断写坏（损坏 JSON 被 rename 就位 → 下次启动静默丢档）。
pub fn save_to_file(state: &PetState, path: &std::path::Path) -> Result<(), String> {
    let json = serde_json::to_string(state).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let unique = {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        path.with_file_name(format!(
            ".{}.{}.{}.tmp",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("state"),
            std::process::id(),
            now,
        ))
    };
    std::fs::write(&unique, json).map_err(|e| e.to_string())?;
    std::fs::rename(&unique, path).map_err(|e| e.to_string())
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
