//! Terminal Crab — ASCII pet companion.
//!
//! Dual-axis growth: token volume → body size, tool successes → tentacle count.
//! Cute naming: 小豆豆 → 豆豆酱 → 豆豆师傅 → 老豆豆.
//! Random speech bubbles on event triggers.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

static SEED: AtomicU64 = AtomicU64::new(0);

/// Simple deterministic-ish random picker. Not crypto-secure.
fn pick(items: &[&str]) -> &'static str {
    let n = SEED.fetch_add(1, Ordering::Relaxed);
    items[n as usize % items.len()]
}

#[derive(Debug, Clone, Serialize)]
pub struct PetState {
    pub mood: &'static str,              // idle|curious|excited|sleepy|error|happy
    pub happiness: u8,                   // 0-100
    pub first_chunk_at_ms: Option<u64>,  // timestamp for sleepy detection
    pub messages: u64,                   // total messages sent
    pub total_tokens: u64,               // cumulative token usage (from usageUpdate)
    pub tools_succeeded: u64,            // completed tool calls (from toolCallUpdate)
    pub name: String,                    // user-set base name
    #[serde(skip)]
    pub msg: Option<&'static str>,       // current speech bubble (consumed on read)
}

impl Default for PetState {
    fn default() -> Self {
        Self {
            mood: "idle",
            happiness: 50,
            first_chunk_at_ms: None,
            messages: 0,
            total_tokens: 0,
            tools_succeeded: 0,
            name: "豆豆".into(),
        }
    }
}

/// Growth tier (0-3). Tokens OR tools crossing threshold → level up.
pub fn growth_stage(tokens: u64, tools: u64) -> u8 {
    let token_tier = match tokens {
        t if t > 5_000_000 => 3,
        t if t > 500_000 => 2,
        t if t > 50_000 => 1,
        _ => 0,
    };
    let tool_tier = match tools {
        t if t > 300 => 3,
        t if t > 100 => 2,
        t if t > 20 => 1,
        _ => 0,
    };
    token_tier.max(tool_tier)
}

/// Cute display name based on growth stage.
pub fn display_name(base: &str, stage: u8) -> String {
    match stage {
        0 => format!("小{base}"),
        1 => format!("{base}酱"),
        2 => format!("{base}师傅"),
        _ => format!("老{base}"),
    }
}

/// Generate full display name from state.
pub fn full_name(state: &PetState) -> String {
    let stage = growth_stage(state.total_tokens, state.tools_succeeded);
    display_name(&state.name, stage)
}

// ── Mood transitions ──

pub fn on_user_sent(state: &mut PetState) -> &'static str {
    state.messages += 1;
    state.first_chunk_at_ms = None;
    state.mood = "curious";
    state.mood
}

pub fn on_first_chunk(state: &mut PetState) -> &'static str {
    state.first_chunk_at_ms = Some(now_ms());
    state.mood = "curious";
    state.mood
}

pub fn on_done(state: &mut PetState) -> &'static str {
    state.first_chunk_at_ms = None;
    state.mood = "excited";
    state.happiness = state.happiness.saturating_add(2).min(100);
    state.mood
}

pub fn on_error(state: &mut PetState) -> &'static str {
    state.first_chunk_at_ms = None;
    state.mood = "error";
    state.happiness = state.happiness.saturating_sub(10);
    state.mood
}

pub fn on_poke(state: &mut PetState) -> &'static str {
    state.mood = "happy";
    state.happiness = (state.happiness + 5).min(100);
    state.mood
}

pub fn on_feed(state: &mut PetState) -> &'static str {
    state.happiness = (state.happiness + 15).min(100);
    state.mood = "happy";
    state.mood
}

// ── Growth hooks (called from notification loop) ──

pub fn on_usage_update(state: &mut PetState, total: u64) {
    state.total_tokens = total;
}

pub fn on_tool_success(state: &mut PetState) {
    state.tools_succeeded += 1;
}

pub fn check_sleepy(state: &mut PetState) -> bool {
    if state.mood == "error" || state.mood == "excited" || state.mood == "happy" {
        return false;
    }
    if let Some(start) = state.first_chunk_at_ms {
        if now_ms().saturating_sub(start) > 30_000 {
            state.mood = "sleepy";
            return true;
        }
    }
    false
}

pub fn daily_decay(state: &mut PetState) {
    state.happiness = state.happiness.saturating_sub(5);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
