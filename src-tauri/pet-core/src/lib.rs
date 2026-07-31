mod lines;

use serde::{Deserialize, Serialize};

const DAY_MS: u64 = 86_400_000;
const TOKEN_XP_STEP: u64 = 5_000;
/// 需求结算封顶（分钟）：离线超过 24h 只按 24h 衰减，防溢出/防惩罚过重。
const MAX_SETTLE_MINUTES: u64 = 24 * 60;
/// 感知窗口容量（环形）：情绪推导的最近事件输入。
const RECENT_EVENTS_CAP: usize = 8;

// ── v2 类型（设计书 §3/§5/§7）──

/// 个性参数（0-100；出生随机、restore 保留；serde 缺失时用中性值 50）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct PetTraits {
    pub activity: u8,
    pub clinginess: u8,
    pub greed: u8,
    pub curiosity: u8,
}

impl Default for PetTraits {
    fn default() -> Self {
        Self { activity: 50, clinginess: 50, greed: 50, curiosity: 50 }
    }
}

impl PetTraits {
    fn clamp(mut self) -> Self {
        self.activity = self.activity.min(100);
        self.clinginess = self.clinginess.min(100);
        self.greed = self.greed.min(100);
        self.curiosity = self.curiosity.min(100);
        self
    }

    /// 出生随机（M4）：每维 60±25，clamp 到 10-100（偏正面但有个性差异）。
    pub fn random() -> Self {
        use rand::RngExt;
        let mut rng = rand::rng();
        let roll = |rng: &mut rand::rngs::ThreadRng| -> u8 { (60_i32 + rng.random_range(-25..=25)).clamp(10, 100) as u8 };
        Self {
            activity: roll(&mut rng),
            clinginess: roll(&mut rng),
            greed: roll(&mut rng),
            curiosity: roll(&mut rng),
        }
    }
}

/// 层次状态机（设计书 §5）：Awake(Idle/Interacting/Distress) / Asleep。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PetMachineState {
    Awake(MachineSub),
    Asleep,
}

impl Default for PetMachineState {
    fn default() -> Self {
        Self::Awake(MachineSub::Idle)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MachineSub {
    Idle,
    Interacting,
    Distress,
}

/// 最近事件窗口（情绪推导输入；轻量枚举，落盘无碍）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RecentEvent {
    Poke,
    Feed,
    Play,
    Done,
    Failed,
    Timeout,
    Refused,
    Maxed,
    ToolOk,
    ToolFail,
    ToolCancel,
    Crashed,
    Connected,
    Code,
    Read,
    Exec,
    Net,
    Spawn,
    ModeCode,
    ModePlan,
    ModelNew,
}

/// 延迟行为（时间戳驱动完成，零后台任务）：捏朋友等。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PendingAction {
    CraftFriend { until_ms: u64 },
}

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
    /// M5：工具被取消（打断，区别于失败）。
    Cancelled,
}

/// 工具分类（M5 感知层，设计书 §8.2）：dispatcher 按 tool_call.title 分类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ToolKind {
    Code,
    Read,
    Execute,
    Network,
    AgentSpawn,
    Other,
}

impl ToolKind {
    /// 工具名 → 分类字典（子串匹配，与 Peri 常用工具名对齐）。
    pub fn classify(title: &str) -> Self {
        let lower = title.to_ascii_lowercase();
        let hit = |keywords: &[&str]| keywords.iter().any(|k| lower.contains(k));
        if hit(&["edit_file", "write_file", "apply_patch", "multi_edit", "file_edit", "code"]) {
            Self::Code
        } else if hit(&["spawn_agent", "delegate", "run_agent", "subagent", "dispatch_agent"]) {
            Self::AgentSpawn
        } else if hit(&["bash", "run", "execute", "terminal", "shell", "cmd"]) {
            Self::Execute
        } else if hit(&["web_search", "fetch", "curl", "http", "browser", "search"]) {
            Self::Network
        } else if hit(&["read", "grep", "glob", "list", "workspace", "view", "search_files"]) {
            Self::Read
        } else {
            Self::Other
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AiEvent {
    UserSent,
    FirstChunk,
    PromptCompleted,
    PromptFailed,
    TokenUsage { total: u64 },
    TokenDelta { amount: u64 },
    ToolCall { outcome: ToolOutcome },
    /// M5 感知：工具开始（带分类）——吃代码/捏朋友等行为信号。
    ToolStarted { kind: ToolKind },
    /// M5 感知：工具被取消（打断）。
    ToolCancelled,
    /// M5 感知：工作模式切换（plan/code 等）。
    ModeChanged { mode: String },
    /// M5 感知：模型切换。
    ModelChanged { model: String },
    /// M5 感知：agent 拒绝（refusal）。
    PromptRefused,
    /// M5 感知：达到轮次上限。
    PromptMaxed,
    /// M5 感知：prompt 超时（发呆）。
    PromptTimeout,
    /// M5 感知：输出含代码块。
    CodeSeen,
    Poke,
    Feed,
    /// v2：玩耍（消耗 energy，大额恢复 fun/loneliness）。
    Play,
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
    // ── M5 感知统计（设计书 §8.3）──
    pub code_sessions: u64,
    pub code_eaten: u64,
    pub code_watched: u64,
    pub friends_made: u64,
    pub dazes: u64,
    /// 吃过的文件名集合（脱敏摘要，上限 10 滚动）。
    pub code_files: Vec<String>,
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
    // ── v2：需求维度（设计书 §3，0-100）──
    pub hunger: u8,
    pub fun: u8,
    pub loneliness: u8,
    // ── v2：个性 / 状态机 / 感知 ──
    pub traits: PetTraits,
    pub machine: PetMachineState,
    pub last_tick_at_ms: u64,
    pub recent_events: Vec<RecentEvent>,
    pub last_agent_mode: Option<String>,
    pub last_agent_model: Option<String>,
    pub pending_action: Option<PendingAction>,
    // ── 原有 ──
    pub stats: PetStats,
    pub memories: Vec<String>,
    #[serde(skip)]
    pub msg: Option<String>,
    #[serde(skip)]
    last_interaction_at_ms: u64,
    // ── v2 防刷（M4；不落盘，重启后冷却清空）──
    #[serde(skip)]
    last_feed_at_ms: u64,
    #[serde(skip)]
    feed_spam_count: u8,
    #[serde(skip)]
    last_play_at_ms: u64,
    /// M6 文案轮换索引（不落盘）。
    #[serde(skip)]
    line_idx: u8,
}

impl Default for PetState {
    fn default() -> Self {
        // 反序列化缺失字段的兜底：确定性（traits 中性，绝不随机——否则每次加载存档 traits 都会变）
        let mut pet = Self::new_at(0);
        pet.traits = PetTraits::default();
        pet
    }
}

impl PetState {
    /// 出生（v2）：需求满格、个性中性随机微调、状态机 Awake.Idle。
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
            hunger: 80,
            fun: 70,
            loneliness: 0,
            traits: PetTraits::random(),
            machine: PetMachineState::default(),
            last_tick_at_ms: now_ms,
            recent_events: Vec::with_capacity(RECENT_EVENTS_CAP),
            last_agent_mode: None,
            last_agent_model: None,
            pending_action: None,
            stats: PetStats {
                active_days: 1,
                streak_days: 1,
                longest_streak: 1,
                ..PetStats::default()
            },
            memories: Vec::new(),
            msg: Some(lines::pick(lines::LineKey::Birth, &mut 0)),
            last_interaction_at_ms: 0,
            last_feed_at_ms: 0,
            feed_spam_count: 0,
            last_play_at_ms: 0,
            line_idx: 0,
        }
    }

    /// 迁移（v2）：旧存档缺新字段由 serde default 补齐；此处统一 clamp 与校验。
    pub fn restore(mut saved: Self, now_ms: u64) -> Self {
        saved.name = sanitize_name(&saved.name);
        saved.happiness = saved.happiness.min(100);
        saved.energy = saved.energy.min(100);
        saved.hunger = saved.hunger.min(100);
        saved.fun = saved.fun.min(100);
        saved.loneliness = saved.loneliness.min(100);
        saved.traits = saved.traits.clamp();
        saved.recent_events.truncate(RECENT_EVENTS_CAP);
        saved.stats.code_files.truncate(10);
        // 旧存档 last_tick_at_ms=0：以出生时间为基准（不触发惩罚性衰减）
        if saved.last_tick_at_ms == 0 {
            saved.last_tick_at_ms = saved.born_at_ms;
        }
        // pending_action 时间戳校验：已过期直接丢弃（防恢复后立即触发陈旧行为）
        if let Some(PendingAction::CraftFriend { until_ms }) = saved.pending_action {
            if until_ms <= now_ms {
                saved.pending_action = None;
            }
        }
        saved.memories.truncate(10);
        saved.first_chunk_at_ms = None;
        saved.last_interaction_at_ms = 0;
        saved.recompute_stats();
        saved.visit(now_ms);
        saved.msg = Some(format!("{} 又亮起来了。", saved.name));
        saved
    }

    /// v2：事件入口——先结算需求衰减（时间戳），再记录窗口事件、应用收益表、
    /// 执行 HSM 转移（设计书 §5 T1-T8）。
    pub fn apply(&mut self, event: AiEvent, now_ms: u64) {
        self.settle(now_ms);
        self.visit(now_ms);
        // T2：睡眠中任何事件（除 Sleepy 本身）→ 唤醒
        if self.machine == PetMachineState::Asleep && !matches!(event, AiEvent::Sleepy) {
            self.wake();
        }
        match event {
            AiEvent::Visit => {
                // 睡眠中被日常访问唤醒（wake 已在开头执行）
                if self.machine == PetMachineState::Asleep {
                    self.wake();
                }
            }
            AiEvent::UserSent => {
                self.stats.messages = self.stats.messages.saturating_add(1);
                self.first_chunk_at_ms = None;
                // mood 由 derive_mood 推导
                self.hunger = self.hunger.saturating_sub(1);
                self.energy = self.energy.saturating_sub(2);
                self.fun = (self.fun as u16 + 2).min(100) as u8;
                self.loneliness = self.loneliness.saturating_sub(15);
                self.happiness = (self.happiness as u16 + 1).min(100) as u8;
                self.gain_bond(1);
                self.msg = Some(lines::pick(lines::LineKey::UserSent, &mut self.line_idx));
            }
            AiEvent::FirstChunk => {
                // T5：对话开始 → Interacting
                self.machine = PetMachineState::Awake(MachineSub::Interacting);
                if self.first_chunk_at_ms.is_none() {
                    self.first_chunk_at_ms = Some(now_ms);
                    // mood 由 derive_mood 推导
                    self.msg = Some(lines::pick(lines::LineKey::FirstChunk, &mut self.line_idx));
                }
            }
            AiEvent::PromptCompleted => {
                // T6：对话结束 → Idle
                self.machine = PetMachineState::Awake(MachineSub::Idle);
                self.first_chunk_at_ms = None;
                self.stats.prompts_completed = self.stats.prompts_completed.saturating_add(1);
                self.gain_xp(3);
                self.gain_bond(2);
                self.happiness = (self.happiness as u16 + 2).min(100) as u8;
                self.energy = self.energy.saturating_sub(2);
                self.fun = (self.fun as u16 + 3).min(100) as u8;
                self.loneliness = self.loneliness.saturating_sub(10);
                // mood 由 derive_mood 推导
                if self.stats.prompts_completed == 1 {
                    self.remember("陪你完成了第一次任务".into());
                } else if self.stats.prompts_completed % 10 == 0 {
                    self.remember(format!("共同完成了 {} 次任务", self.stats.prompts_completed));
                }
                self.push_event(RecentEvent::Done);
                self.msg = Some(lines::pick(lines::LineKey::Done, &mut self.line_idx));
            }
            AiEvent::PromptFailed => {
                // T6：对话结束（失败）→ Idle
                self.machine = PetMachineState::Awake(MachineSub::Idle);
                self.first_chunk_at_ms = None;
                self.stats.prompts_failed = self.stats.prompts_failed.saturating_add(1);
                self.happiness = self.happiness.saturating_sub(3);
                self.fun = self.fun.saturating_sub(2);
                self.loneliness = (self.loneliness as u16 + 5).min(100) as u8;
                // mood 由 derive_mood 推导
                self.push_event(RecentEvent::Failed);
                self.msg = Some(lines::pick(lines::LineKey::Failed, &mut self.line_idx));
            }
            AiEvent::TokenUsage { total } => self.set_token_total(total),
            AiEvent::TokenDelta { amount } => self.add_token_delta(amount),
            AiEvent::ToolCall { outcome } => self.record_tool(outcome),
            // ── M5 感知（设计书 §8.3 行为映射）──
            AiEvent::ToolStarted { kind } => {
                match kind {
                    ToolKind::Code => {
                        self.stats.code_sessions = self.stats.code_sessions.saturating_add(1);
                        self.hunger = self.hunger.saturating_sub(2);
                        self.energy = self.energy.saturating_sub(3);
                        self.fun = (self.fun as u16 + 4).min(100) as u8;
                        self.loneliness = self.loneliness.saturating_sub(10);
                        self.happiness = (self.happiness as u16 + 1).min(100) as u8;
                        self.push_event(RecentEvent::Code);
                        self.msg = Some("它嗅到了代码的味道，凑了过去。".into());
                    }
                    ToolKind::AgentSpawn => {
                        self.push_event(RecentEvent::Spawn);
                        // M6：捏朋友——30s 延迟完成（时间戳驱动，零后台任务）
                        self.pending_action = Some(PendingAction::CraftFriend { until_ms: now_ms + 30_000 });
                        self.msg = Some(lines::pick(lines::LineKey::FriendStart, &mut self.line_idx));
                    }
                    ToolKind::Read => {
                        self.push_event(RecentEvent::Read);
                        self.msg = Some("它歪头看你在翻东西。".into());
                    }
                    ToolKind::Execute => {
                        self.push_event(RecentEvent::Exec);
                        self.msg = Some("它捂住耳朵，等轰鸣过去。".into());
                    }
                    ToolKind::Network => {
                        self.push_event(RecentEvent::Net);
                        self.msg = Some("它伸长脖子看向远方。".into());
                    }
                    ToolKind::Other => {}
                }
            }
            AiEvent::ToolCancelled => {
                self.fun = self.fun.saturating_sub(2);
                self.push_event(RecentEvent::ToolCancel);
                self.msg = Some("它愣住，像被 Ctrl+Z 了一样。".into());
            }
            AiEvent::ModeChanged { mode } => {
                if mode.to_ascii_lowercase().contains("code") {
                    self.push_event(RecentEvent::ModeCode);
                    self.msg = Some("它端正坐好：要写代码了！".into());
                } else {
                    self.push_event(RecentEvent::ModePlan);
                    self.msg = Some("它趴下来安静围观。".into());
                }
            }
            AiEvent::ModelChanged { model } => {
                self.push_event(RecentEvent::ModelNew);
                // 限频记忆：同模型不重复记
                if self.last_agent_model.as_deref() != Some(model.as_str()) {
                    self.remember(format!("它记住：那天换了个脑子（{model}）"));
                    self.last_agent_model = Some(model);
                }
                self.msg = Some("它绕着你嗅了一圈：'换了个脑子？'".into());
            }
            AiEvent::PromptRefused => {
                self.push_event(RecentEvent::Refused);
                self.msg = Some("它歪头，光里写满了问号。".into());
            }
            AiEvent::PromptMaxed => {
                self.push_event(RecentEvent::Maxed);
                self.msg = Some("它累瘫了，像跑完了所有循环。".into());
            }
            AiEvent::PromptTimeout => {
                self.stats.dazes = self.stats.dazes.saturating_add(1);
                self.fun = (self.fun as u16 + 5).min(100) as u8;
                self.push_event(RecentEvent::Timeout);
                self.msg = Some("它望着空气发呆。".into());
            }
            AiEvent::CodeSeen => {
                self.stats.code_watched = self.stats.code_watched.saturating_add(1);
            }
            AiEvent::Poke => {
                self.stats.interactions = self.stats.interactions.saturating_add(1);
                self.happiness = (self.happiness as u16 + 4).min(100) as u8;
                self.fun = (self.fun as u16 + 2).min(100) as u8;
                self.loneliness = self.loneliness.saturating_sub(15);
                self.reward_interaction(now_ms, 1);
                // mood 由 derive_mood 推导
                self.push_event(RecentEvent::Poke);
                self.msg = Some(lines::pick(lines::LineKey::Poke, &mut self.line_idx));
            }
            AiEvent::Feed => {
                self.stats.interactions = self.stats.interactions.saturating_add(1);
                // M4 防刷：30s 内重复喂食收益递减（100%→50%→25%→0），30s 后重置
                // （last_feed_at_ms==0 = 从未喂过，首次不视为 spam）
                if self.last_feed_at_ms > 0 && now_ms.saturating_sub(self.last_feed_at_ms) < 30_000 {
                    self.feed_spam_count = (self.feed_spam_count + 1).min(3);
                } else {
                    self.feed_spam_count = 0;
                }
                self.last_feed_at_ms = now_ms;
                let multiplier = [100_u16, 50, 25, 0][self.feed_spam_count as usize];
                // M4 个性：贪吃 → 饥饿恢复收益 ×(1+greed/200)（50%~150%）
                let greed_factor = (100 + self.traits.greed as u16 * 2) / 2;
                let hunger_gain = 20_u16 * multiplier / 100 * greed_factor / 100;
                self.hunger = (self.hunger as u16 + hunger_gain).min(100) as u8;
                self.energy = (self.energy as u16 + 20 * multiplier / 100).min(100) as u8;
                self.fun = (self.fun as u16 + 3 * multiplier / 100).min(100) as u8;
                self.loneliness = self.loneliness.saturating_sub((20 * multiplier / 100) as u8);
                self.happiness = (self.happiness as u16 + 7 * multiplier / 100).min(100) as u8;
                // bond 走 reward_interaction（30s 冷却，另计）
                self.reward_interaction(now_ms, 1);
                // mood 由 derive_mood 推导
                self.push_event(RecentEvent::Feed);
                self.msg = Some(lines::pick(lines::LineKey::Feed, &mut self.line_idx));
            }
            AiEvent::Play => {
                self.stats.interactions = self.stats.interactions.saturating_add(1);
                // M4 防刷：玩耍 60s 冷却（bond 收益；数值恢复不受限；首次不视为冷却中）
                let play_cooled = self.last_play_at_ms == 0
                    || now_ms.saturating_sub(self.last_play_at_ms) >= 60_000;
                self.last_play_at_ms = now_ms;
                self.hunger = self.hunger.saturating_sub(5);
                self.energy = self.energy.saturating_sub(10);
                // M4 个性：好奇 → 玩耍 fun 收益 ×(1+curiosity/200)（50%~150%）
                let curiosity_factor = (100 + self.traits.curiosity as u16 * 2) / 2;
                let fun_gain = 25_u16 * curiosity_factor / 100;
                self.fun = (self.fun as u16 + fun_gain).min(100) as u8;
                self.loneliness = self.loneliness.saturating_sub(30);
                self.happiness = (self.happiness as u16 + 4).min(100) as u8;
                if play_cooled {
                    self.gain_bond(3);
                }
                // mood 由 derive_mood 推导
                self.push_event(RecentEvent::Play);
                self.msg = Some(lines::pick(lines::LineKey::Play, &mut self.line_idx));
            }
            AiEvent::Sleepy => {
                self.machine = PetMachineState::Asleep;
                self.msg = Some(lines::pick(lines::LineKey::Sleep, &mut self.line_idx));
            }
            AiEvent::AgentConnected => {
                // T4：连接恢复 → Idle
                self.machine = PetMachineState::Awake(MachineSub::Idle);
                // mood 由 derive_mood 推导
                self.gain_bond(1);
                self.happiness = (self.happiness as u16 + 1).min(100) as u8;
                self.push_event(RecentEvent::Connected);
                self.msg = Some("连接亮起，它精神地站了起来。".into());
            }
            AiEvent::AgentCrashed => {
                // T3：崩溃 → Distress
                self.machine = PetMachineState::Awake(MachineSub::Distress);
                // mood 由 derive_mood 推导
                self.happiness = self.happiness.saturating_sub(2);
                self.push_event(RecentEvent::Crashed);
                self.msg = Some("连接断了，它吓得缩了一下。".into());
            }
        }
        // T1/T8 睡眠检查：energy 耗尽（≤15 且 30s 无互动，或直接归零）→ 入睡
        if self.machine != PetMachineState::Asleep {
            let idle_for = now_ms.saturating_sub(self.last_interaction_at_ms);
            if self.energy <= 15 && (idle_for >= 30_000 || self.energy == 0) {
                self.machine = PetMachineState::Asleep;
                self.msg = Some(lines::pick(lines::LineKey::Sleep, &mut self.line_idx));
            }
        }
        // M3：情绪统一推导（取代事件直接赋值）
        self.mood = self.derive_mood().to_string();
    }

    /// v2 需求衰减引擎（设计书 §4）：时间戳结算，零后台任务。
    /// dt 按分钟计，封顶 24h；睡眠豁免（energy 恢复，其余暂停）。
    fn settle(&mut self, now_ms: u64) {
        if self.last_tick_at_ms == 0 {
            self.last_tick_at_ms = now_ms;
            return;
        }
        let dt = (now_ms.saturating_sub(self.last_tick_at_ms) / 60_000).min(MAX_SETTLE_MINUTES);
        if dt == 0 {
            return;
        }
        let traits = self.traits;
        if self.machine == PetMachineState::Asleep {
            self.energy = (self.energy as u64 + dt * 2).min(100) as u8;
        } else {
            // 速率（每分钟）× dt；所有 delta 先 min(100) 再 cast 防 u8 截断
            // hunger -= dt×0.6×(1+greed/100)
            let hunger_delta = (dt * 6 * (100 + traits.greed as u64) / 1000).min(100);
            self.hunger = self.hunger.saturating_sub(hunger_delta as u8);
            // energy -= dt×0.5×(1-activity/200) = dt×(200-activity)/400
            let energy_delta = (dt * (200 - traits.activity as u64) / 400).min(100);
            self.energy = self.energy.saturating_sub(energy_delta as u8);
            // fun -= dt×0.35×(1+activity/200) = dt×35×(200+activity)/20000
            let fun_delta = (dt * 35 * (200 + traits.activity as u64) / 20_000).min(100);
            self.fun = self.fun.saturating_sub(fun_delta as u8);
            // loneliness += dt×0.25×(1+clinginess/100) = dt×25×(100+clinginess)/10000
            let lonely_delta = (dt * 25 * (100 + traits.clinginess as u64) / 10_000).min(100);
            self.loneliness = (self.loneliness as u64 + lonely_delta).min(100) as u8;
            // hunger=0 持续：羁绊惩罚（0.5/tick，封顶 10）
            if self.hunger == 0 {
                let penalty = (dt / 2).min(10);
                self.bond = self.bond.saturating_sub(penalty as u32);
            }
            // M4 个性：黏人被冷落（孤独≥80）持续 → bond 惩罚（0.5/tick，封顶 10）
            if self.loneliness >= 80 {
                let penalty = (dt / 2).min(10);
                self.bond = self.bond.saturating_sub(penalty as u32);
            }
        }
        self.last_tick_at_ms = now_ms;
    }

    /// v2 情绪推导（设计书 §6）：mood 不再由事件直接赋值，而是按优先级从
    /// 状态机 + 需求 + 感知窗口综合计算——杜绝"刚喂了食还在生气"的错位。
    /// 返回 &'static str（前端契约的 mood 字符串）。
    pub fn derive_mood(&self) -> &'static str {
        if self.machine == PetMachineState::Asleep {
            return "sleepy";
        }
        let recent = &self.recent_events;
        let recent3: Vec<&RecentEvent> = recent.iter().rev().take(3).collect();
        let recent3_has = |event: RecentEvent| recent3.iter().any(|e| **e == event);
        // 1. 崩溃/失败（近 3 条）
        if recent3_has(RecentEvent::Crashed) || recent3_has(RecentEvent::Failed) || recent3_has(RecentEvent::ToolFail) {
            return "error";
        }
        // 2. 需求危机
        if self.hunger < 20 {
            return "hungry";
        }
        if self.energy < 20 {
            return "tired";
        }
        if self.loneliness > 60 {
            return "lonely";
        }
        // 3. 短时事件情绪（近 3 条）
        if recent3_has(RecentEvent::Timeout) {
            return "dazed";
        }
        if recent3_has(RecentEvent::Refused) {
            return "confused";
        }
        if recent3_has(RecentEvent::ToolCancel) {
            return "startled";
        }
        if recent3_has(RecentEvent::Maxed) {
            return "tired";
        }
        // 4. 正向事件（窗口内）
        if recent.contains(&RecentEvent::Feed)
            || recent.contains(&RecentEvent::Play)
            || recent.contains(&RecentEvent::Done)
            || recent.contains(&RecentEvent::Poke)
        {
            return "happy";
        }
        if recent.contains(&RecentEvent::Connected) {
            return "excited";
        }
        // 5. 工作状态
        if recent.contains(&RecentEvent::ModeCode) {
            return "focused";
        }
        if recent.contains(&RecentEvent::ToolOk) || recent.contains(&RecentEvent::ToolFail) {
            return "focused";
        }
        if self.machine == PetMachineState::Awake(MachineSub::Interacting) {
            return "curious";
        }
        // 6. 感知：看代码/阅读/上网 → 好奇（设计书 §8.3）
        if recent.contains(&RecentEvent::Code)
            || recent.contains(&RecentEvent::Read)
            || recent.contains(&RecentEvent::Net)
            || recent.contains(&RecentEvent::Spawn)
        {
            return "curious";
        }
        "idle"
    }

    /// 感知窗口：环形 8，情绪推导输入（设计书 §6）。
    fn push_event(&mut self, event: RecentEvent) {
        self.recent_events.push(event);
        if self.recent_events.len() > RECENT_EVENTS_CAP {
            self.recent_events.remove(0);
        }
    }

    /// M5 感知：记录"吃过的代码"文件名（脱敏摘要：仅文件名，不含路径/参数）。
    /// 上限 10 滚动；dispatcher 从 rawInput 提取后调用——原文绝不下沉。
    pub fn record_code_file(&mut self, file: &str) {
        let name = file.rsplit(['/', '\\']).next().unwrap_or(file).trim().to_string();
        if name.is_empty() || self.stats.code_files.contains(&name) {
            return;
        }
        self.stats.code_files.push(name);
        if self.stats.code_files.len() > 10 {
            self.stats.code_files.remove(0);
        }
    }

    /// v2 唤醒（T2 转移动作）：状态置 Idle，energy +30，文案（mood 由推导决定）。
    fn wake(&mut self) {
        self.machine = PetMachineState::Awake(MachineSub::Idle);
        self.energy = (self.energy as u16 + 30).min(100) as u8;
        self.msg = Some(lines::pick(lines::LineKey::Wake, &mut self.line_idx));
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
        let prefix = lines::pick(lines::LineKey::Rename, &mut self.line_idx);
        self.msg = Some(format!("{prefix}{}。", self.name));
    }

    /// M6：结算延迟行为（时间戳驱动）。捏朋友到期 → 完成（记忆/bond/朋友统计）。
    /// 返回是否发生了完成（调用方可决定是否更新 view）。
    pub fn settle_pending(&mut self, now_ms: u64) -> bool {
        if let Some(PendingAction::CraftFriend { until_ms }) = self.pending_action {
            if now_ms >= until_ms {
                self.pending_action = None;
                self.stats.friends_made = self.stats.friends_made.saturating_add(1);
                self.gain_bond(2);
                self.gain_xp(2);
                self.fun = (self.fun as u16 + 10).min(100) as u8;
                self.loneliness = self.loneliness.saturating_sub(30);
                self.remember("它捏了个幻影朋友".into());
                self.msg = Some(lines::pick(lines::LineKey::FriendDone, &mut self.line_idx));
                return true;
            }
        }
        false
    }

    /// M6：主动说话（view/轮询入口，零后台任务）——
    /// 需求危机按优先级产出 msg（设计书 §9）。返回是否说了话。
    /// 紧急需求总是表达（可覆盖事件文案——饥饿优先，设计书 §1 无冷却）。
    pub fn poll_voice(&mut self, now_ms: u64) -> bool {
        self.settle(now_ms);
        if self.settle_pending(now_ms) {
            return true;
        }
        if self.machine == PetMachineState::Asleep {
            return false;
        }
        let key = if self.hunger < 25 {
            Some(lines::LineKey::Hungry)
        } else if self.loneliness > 70 {
            Some(lines::LineKey::Lonely)
        } else if self.energy < 20 {
            Some(lines::LineKey::Tired)
        } else if self.fun < 20 {
            Some(lines::LineKey::Bored)
        } else if self.mood == "dazed" {
            Some(lines::LineKey::Dazed)
        } else {
            None
        };
        if let Some(key) = key {
            self.msg = Some(lines::pick(key, &mut self.line_idx));
            true
        } else {
            false
        }
    }

    pub fn recall_memory(&self) -> Option<String> {
        self.memories.last().map(|memory| format!("同行记录：{memory}"))
    }

    pub fn check_sleepy(&mut self, now_ms: u64) -> bool {
        // v2：状态机判定（原 mood 字符串判断被推导取代）
        if self.machine == PetMachineState::Asleep {
            return true;
        }
        if matches!(self.machine, PetMachineState::Awake(MachineSub::Distress)) {
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
                self.fun = (self.fun as u16 + 2).min(100) as u8;
                self.happiness = (self.happiness as u16 + 1).min(100) as u8;
                self.push_event(RecentEvent::ToolOk);
            }
            ToolOutcome::Failed => {
                self.stats.tools_started = self.stats.tools_started.saturating_add(1);
                self.stats.tools_failed = self.stats.tools_failed.saturating_add(1);
                self.gain_xp(1);
                self.fun = self.fun.saturating_sub(2);
                self.happiness = self.happiness.saturating_sub(2);
                // mood 由 derive_mood 推导
                self.push_event(RecentEvent::ToolFail);
            }
            ToolOutcome::Cancelled => {
                self.stats.tools_started = self.stats.tools_started.saturating_add(1);
                self.fun = self.fun.saturating_sub(2);
                self.push_event(RecentEvent::ToolCancel);
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
