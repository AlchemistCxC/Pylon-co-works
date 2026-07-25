//! Terminal Crab — ASCII pet companion.
//!
//! Dual-axis growth: token volume → body size, tool successes → tentacle count.
//! Cute naming: 小豆豆 → 豆豆酱 → 豆豆师傅 → 老豆豆.
//! Random speech bubbles on event triggers.

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};

static SEED: AtomicU64 = AtomicU64::new(0);

/// Simple deterministic-ish random picker. Not crypto-secure.
fn pick(items: &'static [&'static str]) -> &'static str {
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
    pub memories: Vec<String>,           // up to 10 remembered moments
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
            msg: None,
            memories: Vec::new(),
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

// ── Speech bubble pools ──

const USER_SENT: &[&str] = &[
    "交给我！", "看着呢~", "加油！", "冲冲冲！", "好！", "来了来了！",
    "又有活干了", "让我瞧瞧", "(竖钳)", "(探头)", "⌁⌁⌁",
];

const FIRST_CHUNK: &[&str] = &[
    "哦？", "有意思", "让我康康", "嗯嗯", "在想了在想了",
    "(眼睛亮了)", "这个我知道！", "等我一下…", "翻文档中…",
];

const DONE_MSGS: &[&str] = &[
    "搞定啦！", "怎么样~", "厉害吧", "轻轻松松", "完工！",
    "(叉腰)", "下一题！", "还行吧？", "⌁✧⌁", "呼——",
];

const ERROR_MSGS: &[&str] = &[
    "哎呀", "疼疼疼", "翻车了…", "(炸毛)", "不是我干的！",
    "它又崩了", "呜呜", "要不要重启一下", "⌁✕⌁", "救命",
];

const POKE_MSGS: &[&str] = &[
    "嘿嘿", "别闹~", "痒！", "人家在工作呢", "(蹭)", "⌁♥⌁",
    "再来一下？", "干嘛呀", "(翻肚皮)", "啾",
];

const FEED_MSGS: &[&str] = &[
    "好吃！", "还有吗", "(嚼嚼)", "谢谢投喂~", "饱了饱了",
    "能量+1", "这什么好吃的", "(眼睛发光)", "⌁♡⌁", "嗝",
];

const SLEEPY_MSGS: &[&str] = &[
    "好慢啊…", "zzz", "快睡着了", "(打哈欠)", "还没好？",
    "我先眯一会…", "都快长蘑菇了", "⌁﹏⌁",
];

const NIGHT_MSGS: &[&str] = &[
    "都几点了…", "(打哈欠)", "还不睡？", "我帮你看着，你先睡吧",
    "凌晨代码最香了…才怪", "生产队的驴也该歇了", "⌁_⌁ zzZ",
    "你是不是又在修bug", "真的不困吗", "明天再看也一样啦",
];

const MEMORY_MSGS: &[&str] = &[
    "还记得吗——", "突然想起一件事：", "说起来，之前",
    "我好像记得…", "很久以前，", "翻开旧账本：",
];

/// Hour in UTC+8. Returns true if it's 2am-6am (night owl hours).
pub fn is_night() -> bool {
    let total_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let hour = ((total_secs / 3600 + 8) % 24) as u8;
    hour >= 2 && hour < 6
}

// ── Mood transitions ──

pub fn on_user_sent(state: &mut PetState) -> &'static str {
    state.messages += 1;
    state.first_chunk_at_ms = None;
    state.mood = "curious";
    state.msg = Some(if is_night() { pick(NIGHT_MSGS) } else { pick(USER_SENT) });
    state.mood
}

pub fn on_first_chunk(state: &mut PetState) -> &'static str {
    state.first_chunk_at_ms = Some(now_ms());
    state.mood = "curious";
    state.msg = Some(pick(FIRST_CHUNK));
    state.mood
}

pub fn on_done(state: &mut PetState) -> &'static str {
    state.first_chunk_at_ms = None;
    state.mood = "excited";
    state.happiness = state.happiness.saturating_add(2).min(100);
    state.msg = Some(pick(DONE_MSGS));
    state.mood
}

pub fn on_error(state: &mut PetState) -> &'static str {
    state.first_chunk_at_ms = None;
    state.mood = "error";
    state.happiness = state.happiness.saturating_sub(10);
    state.msg = Some(pick(ERROR_MSGS));
    state.mood
}

pub fn on_poke(state: &mut PetState) -> &'static str {
    state.mood = "happy";
    state.happiness = (state.happiness + 5).min(100);
    state.msg = Some(pick(POKE_MSGS));
    state.mood
}

pub fn on_feed(state: &mut PetState) -> &'static str {
    state.happiness = (state.happiness + 15).min(100);
    state.mood = "happy";
    state.msg = Some(pick(FEED_MSGS));
    state.mood
}

// ── Growth hooks (called from notification loop) ──

pub fn on_usage_update(state: &mut PetState, total: u64) {
    state.total_tokens = total;
}

pub fn on_tool_success(state: &mut PetState) {
    state.tools_succeeded += 1;
}

// ── Memories ──

/// Store a memory snippet. Keeps at most 10.
pub fn add_memory(state: &mut PetState, snippet: String) {
    if state.memories.len() >= 10 { state.memories.remove(0); }
    state.memories.push(snippet);
}

/// Recall a random memory. Returns (prefix, memory) or None if no memories.
pub fn recall_memory(state: &mut PetState) -> Option<(&'static str, String)> {
    if state.memories.is_empty() { return None; }
    let n = SEED.fetch_add(1, Ordering::Relaxed) as usize % state.memories.len();
    let mem = state.memories[n].clone();
    Some((pick(MEMORY_MSGS), mem))
}

pub fn check_sleepy(state: &mut PetState) -> bool {
    if state.mood == "error" || state.mood == "excited" || state.mood == "happy" {
        return false;
    }
    if let Some(start) = state.first_chunk_at_ms {
        if now_ms().saturating_sub(start) > 30_000 {
            state.mood = "sleepy";
            state.msg = Some(pick(SLEEPY_MSGS));
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
