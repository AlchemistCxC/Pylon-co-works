use serde::{Deserialize, Serialize};

const DAY_MS: u64 = 86_400_000;
const TOKEN_XP_STEP: u64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GrowthStage {
    Seed,
    Sprout,
    Hopper,
    Guardian,
    Luminary,
}

impl Default for GrowthStage {
    fn default() -> Self {
        Self::Seed
    }
}

impl GrowthStage {
    pub fn title(self) -> &'static str {
        match self {
            Self::Seed => "微光种",
            Self::Sprout => "初生体",
            Self::Hopper => "漫游体",
            Self::Guardian => "陪伴体",
            Self::Luminary => "长明体",
        }
    }

    pub fn minimum_xp(self) -> u32 {
        match self {
            Self::Seed => 0,
            Self::Sprout => 25,
            Self::Hopper => 90,
            Self::Guardian => 220,
            Self::Luminary => 500,
        }
    }

    pub fn next(self) -> Option<Self> {
        match self {
            Self::Seed => Some(Self::Sprout),
            Self::Sprout => Some(Self::Hopper),
            Self::Hopper => Some(Self::Guardian),
            Self::Guardian => Some(Self::Luminary),
            Self::Luminary => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolOutcome {
    Started,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiEvent {
    UserSent,
    FirstChunk,
    PromptCompleted,
    PromptFailed,
    TokenUsage { total: u64 },
    TokenDelta { amount: u64 },
    ToolCall { outcome: ToolOutcome },
    Poke,
    Feed,
    Sleepy,
    Visit,
    /// Agent 进程连接成功（switch/重连/自动重连）
    AgentConnected,
    /// Agent 进程崩溃/断开
    AgentCrashed,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PetStats {
    pub messages: u64,
    pub prompts_completed: u64,
    pub prompts_failed: u64,
    pub tokens_total: u64,
    pub token_xp: u32,
    pub tools_started: u64,
    pub tools_succeeded: u64,
    pub tools_failed: u64,
    pub tool_success_rate: u8,
    pub interactions: u64,
    pub active_days: u32,
    pub streak_days: u32,
    pub longest_streak: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PetState {
    pub name: String,
    pub mood: String,
    pub happiness: u8,
    pub energy: u8,
    pub xp: u32,
    pub bond: u32,
    pub born_at_ms: u64,
    pub last_seen_day: u64,
    pub first_chunk_at_ms: Option<u64>,
    pub stats: PetStats,
    pub memories: Vec<String>,
    #[serde(skip)]
    pub msg: Option<String>,
    #[serde(skip)]
    last_interaction_at_ms: u64,
}

impl Default for PetState {
    fn default() -> Self {
        Self::new_at(0)
    }
}

impl PetState {
    pub fn new_at(now_ms: u64) -> Self {
        Self {
            name: "微栖".into(),
            mood: "idle".into(),
            happiness: 65,
            energy: 80,
            xp: 0,
            bond: 0,
            born_at_ms: now_ms,
            last_seen_day: day_number(now_ms),
            first_chunk_at_ms: None,
            stats: PetStats {
                active_days: 1,
                streak_days: 1,
                longest_streak: 1,
                ..PetStats::default()
            },
            memories: Vec::new(),
            msg: Some("一粒微光落在了这里。".into()),
            last_interaction_at_ms: 0,
        }
    }

    pub fn restore(mut saved: Self, now_ms: u64) -> Self {
        saved.name = sanitize_name(&saved.name);
        saved.happiness = saved.happiness.min(100);
        saved.energy = saved.energy.min(100);
        saved.memories.truncate(10);
        saved.first_chunk_at_ms = None;
        saved.last_interaction_at_ms = 0;
        saved.recompute_stats();
        saved.visit(now_ms);
        saved.msg = Some(format!("{} 又亮起来了。", saved.name));
        saved
    }

    pub fn apply(&mut self, event: AiEvent, now_ms: u64) {
        self.visit(now_ms);
        match event {
            AiEvent::Visit => {
                // 睡眠中被日常访问唤醒
                if self.mood == "sleepy" {
                    self.mood = "idle".into();
                    self.msg = Some("它被你的脚步声唤醒。".into());
                }
            }
            AiEvent::UserSent => {
                self.stats.messages = self.stats.messages.saturating_add(1);
                self.first_chunk_at_ms = None;
                self.mood = "curious".into();
                self.energy = self.energy.saturating_sub(1);
                self.msg = Some("它追着新的想法望了过去。".into());
            }
            AiEvent::FirstChunk => {
                if self.first_chunk_at_ms.is_none() {
                    self.first_chunk_at_ms = Some(now_ms);
                    self.mood = "curious".into();
                    self.msg = Some("微光开始流动。".into());
                }
            }
            AiEvent::PromptCompleted => {
                self.first_chunk_at_ms = None;
                self.stats.prompts_completed = self.stats.prompts_completed.saturating_add(1);
                self.gain_xp(3);
                self.gain_bond(2);
                self.happiness = self.happiness.saturating_add(2).min(100);
                self.energy = self.energy.saturating_sub(2);
                self.mood = "excited".into();
                if self.stats.prompts_completed == 1 {
                    self.remember("陪你完成了第一次任务".into());
                } else if self.stats.prompts_completed % 10 == 0 {
                    self.remember(format!("共同完成了 {} 次任务", self.stats.prompts_completed));
                }
                self.msg = Some("它把这次完成收进了身体。".into());
            }
            AiEvent::PromptFailed => {
                self.first_chunk_at_ms = None;
                self.stats.prompts_failed = self.stats.prompts_failed.saturating_add(1);
                self.happiness = self.happiness.saturating_sub(3);
                self.mood = "error".into();
                self.msg = Some("光暗了一下，但没有熄灭。".into());
            }
            AiEvent::TokenUsage { total } => self.set_token_total(total),
            AiEvent::TokenDelta { amount } => self.add_token_delta(amount),
            AiEvent::ToolCall { outcome } => self.record_tool(outcome),
            AiEvent::Poke => {
                self.stats.interactions = self.stats.interactions.saturating_add(1);
                self.happiness = self.happiness.saturating_add(4).min(100);
                self.reward_interaction(now_ms, 1);
                self.mood = "happy".into();
                self.msg = Some("它贴近了你的指尖。".into());
            }
            AiEvent::Feed => {
                self.stats.interactions = self.stats.interactions.saturating_add(1);
                self.energy = self.energy.saturating_add(20).min(100);
                self.happiness = self.happiness.saturating_add(7).min(100);
                self.reward_interaction(now_ms, 1);
                self.mood = "happy".into();
                self.msg = Some("能量沿着像素一格格亮起。".into());
            }
            AiEvent::Sleepy => {
                self.mood = "sleepy".into();
                self.msg = Some("它蜷成一小团等待。".into());
            }
            AiEvent::AgentConnected => {
                self.mood = "excited".into();
                self.gain_bond(1);
                self.msg = Some("连接亮起，它精神地站了起来。".into());
            }
            AiEvent::AgentCrashed => {
                self.mood = "error".into();
                self.happiness = self.happiness.saturating_sub(2);
                self.msg = Some("连接断了，它吓得缩了一下。".into());
            }
        }
    }

    pub fn stage(&self) -> GrowthStage {
        match self.xp {
            0..=24 => GrowthStage::Seed,
            25..=89 => GrowthStage::Sprout,
            90..=219 => GrowthStage::Hopper,
            220..=499 => GrowthStage::Guardian,
            _ => GrowthStage::Luminary,
        }
    }

    pub fn age_days(&self, now_ms: u64) -> u64 {
        day_number(now_ms).saturating_sub(day_number(self.born_at_ms)) + 1
    }

    pub fn next_stage_xp(&self) -> Option<u32> {
        self.stage().next().map(GrowthStage::minimum_xp)
    }

    pub fn growth_progress(&self) -> u8 {
        let stage = self.stage();
        let start = stage.minimum_xp();
        let Some(end) = self.next_stage_xp() else { return 100 };
        (((self.xp.saturating_sub(start)) as f32 / (end - start) as f32) * 100.0)
            .round()
            .clamp(0.0, 100.0) as u8
    }

    pub fn rename(&mut self, value: &str) {
        self.name = sanitize_name(value);
        self.msg = Some(format!("它记住了名字：{}。", self.name));
    }

    pub fn recall_memory(&self) -> Option<String> {
        self.memories.last().map(|memory| format!("同行记录：{memory}"))
    }

    pub fn check_sleepy(&mut self, now_ms: u64) -> bool {
        if matches!(self.mood.as_str(), "error" | "excited" | "happy") {
            return false;
        }
        if self.first_chunk_at_ms.is_some_and(|start| now_ms.saturating_sub(start) > 30_000) {
            self.apply(AiEvent::Sleepy, now_ms);
            return true;
        }
        false
    }

    fn set_token_total(&mut self, total: u64) {
        if total <= self.stats.tokens_total {
            return;
        }
        let old_steps = self.stats.tokens_total / TOKEN_XP_STEP;
        let new_steps = total / TOKEN_XP_STEP;
        let gained = new_steps.saturating_sub(old_steps) as u32;
        self.stats.tokens_total = total;
        self.stats.token_xp = self.stats.token_xp.saturating_add(gained);
        self.gain_xp(gained);
    }

    fn add_token_delta(&mut self, amount: u64) {
        let total = self.stats.tokens_total.saturating_add(amount);
        self.set_token_total(total);
    }

    fn record_tool(&mut self, outcome: ToolOutcome) {
        match outcome {
            ToolOutcome::Started => {
                self.stats.tools_started = self.stats.tools_started.saturating_add(1);
            }
            ToolOutcome::Succeeded => {
                self.stats.tools_started = self.stats.tools_started.saturating_add(1);
                self.stats.tools_succeeded = self.stats.tools_succeeded.saturating_add(1);
                self.gain_xp(2);
                self.gain_bond(1);
                self.mood = "focused".into();
            }
            ToolOutcome::Failed => {
                self.stats.tools_started = self.stats.tools_started.saturating_add(1);
                self.stats.tools_failed = self.stats.tools_failed.saturating_add(1);
                self.gain_xp(1);
                self.mood = "error".into();
            }
        }
        self.recompute_stats();
    }

    fn visit(&mut self, now_ms: u64) {
        let today = day_number(now_ms);
        if today <= self.last_seen_day {
            return;
        }
        let elapsed = today - self.last_seen_day;
        self.stats.active_days = self.stats.active_days.saturating_add(1);
        self.stats.streak_days = if elapsed == 1 { self.stats.streak_days.saturating_add(1) } else { 1 };
        self.stats.longest_streak = self.stats.longest_streak.max(self.stats.streak_days);
        if self.stats.streak_days == 7 {
            self.remember("和你连续相伴了 7 天".into());
        }
        self.energy = self.energy.saturating_add(20).min(100);
        let loneliness = (elapsed.min(5) * 2) as u8;
        self.happiness = self.happiness.saturating_sub(loneliness);
        self.last_seen_day = today;
    }

    fn reward_interaction(&mut self, now_ms: u64, amount: u32) {
        if now_ms.saturating_sub(self.last_interaction_at_ms) >= 30_000 {
            self.gain_bond(amount);
            self.last_interaction_at_ms = now_ms;
        }
    }

    fn gain_xp(&mut self, amount: u32) {
        let previous = self.stage();
        self.xp = self.xp.saturating_add(amount).min(999_999);
        let evolved = self.stage();
        if evolved != previous && evolved > previous {
            self.remember(format!("蜕变为{}", evolved.title()));
        }
    }

    fn gain_bond(&mut self, amount: u32) {
        self.bond = self.bond.saturating_add(amount).min(9_999);
    }

    fn remember(&mut self, memory: String) {
        if self.memories.last() == Some(&memory) {
            return;
        }
        self.memories.push(memory);
        if self.memories.len() > 10 {
            self.memories.remove(0);
        }
    }

    fn recompute_stats(&mut self) {
        let resolved = self.stats.tools_succeeded.saturating_add(self.stats.tools_failed);
        self.stats.tools_started = self.stats.tools_started.max(resolved);
        self.stats.tool_success_rate = if self.stats.tools_started == 0 {
            0
        } else {
            ((self.stats.tools_succeeded.saturating_mul(100) / self.stats.tools_started).min(100)) as u8
        };
        self.stats.active_days = self.stats.active_days.max(1);
        self.stats.streak_days = self.stats.streak_days.max(1);
        self.stats.longest_streak = self.stats.longest_streak.max(self.stats.streak_days);
    }
}

fn sanitize_name(value: &str) -> String {
    let name: String = value.trim().chars().take(12).collect();
    if name.is_empty() { "微栖".into() } else { name }
}

fn day_number(ms: u64) -> u64 {
    ms / DAY_MS
}
