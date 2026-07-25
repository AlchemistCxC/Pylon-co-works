//! Terminal Crab — ASCII pet companion.
//!
//! Lives in the Pylon chat view. Reacts to ACP events passively.
//! State is persisted via localStorage on the frontend side;
//! the backend only provides the event triggers and a status command.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct PetState {
    pub mood: &'static str,       // idle | curious | excited | sleepy | error | happy
    pub happiness: u8,            // 0-100
    pub first_chunk_at_ms: Option<u64>,  // timestamp for sleepy detection
    pub messages: u64,            // total messages sent (for milestones)
}

impl Default for PetState {
    fn default() -> Self {
        Self {
            mood: "idle",
            happiness: 50,
            first_chunk_at_ms: None,
            messages: 0,
        }
    }
}

/// Pet mood transitions triggered by ACP events.
/// Returns the new mood (may be same as old).
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

pub fn on_done(state: &mut PetState, response_len: usize) -> &'static str {
    state.first_chunk_at_ms = None;
    if response_len > 200 {
        state.mood = "excited";
        state.happiness = state.happiness.saturating_add(2).min(100);
    } else {
        state.mood = "happy";
    }
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

/// Check if the pet should switch to sleepy.
/// Called periodically by the frontend timer.
/// Returns true if the pet is now sleepy.
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

/// Daily happiness decay.
pub fn daily_decay(state: &mut PetState) {
    state.happiness = state.happiness.saturating_sub(5);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
