pub mod lines;

use std::collections::VecDeque;

use rand::RngExt;
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
        Self {
            activity: 50,
            clinginess: 50,
            greed: 50,
            curiosity: 50,
        }
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
        let mut rng = rand::rng();
        let roll = |rng: &mut rand::rngs::ThreadRng| -> u8 {
            (60_i32 + rng.random_range(-25..=25)).clamp(10, 100) as u8
        };
        Self {
            activity: roll(&mut rng),
            clinginess: roll(&mut rng),
            greed: roll(&mut rng),
            curiosity: roll(&mut rng),
        }
    }
}

/// 层次状态机（设计书 §5）：Awake(Idle/Interacting/Distress) / Asleep。
/// 序列化为字符串（前端契约："awake.idle" / "awake.interacting" / "awake.distress" / "asleep"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PetMachineState {
    Awake(MachineSub),
    Asleep,
}

impl PetMachineState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Awake(MachineSub::Idle) => "awake.idle",
            Self::Awake(MachineSub::Interacting) => "awake.interacting",
            Self::Awake(MachineSub::Distress) => "awake.distress",
            Self::Asleep => "asleep",
        }
    }
}

impl Default for PetMachineState {
    fn default() -> Self {
        Self::Awake(MachineSub::Idle)
    }
}

impl Serialize for PetMachineState {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PetMachineState {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::Error;
        let raw = String::deserialize(deserializer)?;
        match raw.as_str() {
            "awake.idle" => Ok(Self::Awake(MachineSub::Idle)),
            "awake.interacting" => Ok(Self::Awake(MachineSub::Interacting)),
            "awake.distress" => Ok(Self::Awake(MachineSub::Distress)),
            "asleep" => Ok(Self::Asleep),
            other => Err(D::Error::custom(format!("unknown machine state: {other}"))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MachineSub {
    Idle,
    Interacting,
    Distress,
}

/// 时段（M8 扩展位：时段感知）。由本地小时推导（UTC 小时 + local_offset_minutes）。
/// 序列化为字符串（前端契约："dawn" / "day" / "dusk" / "night"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DayPart {
    /// 5:00-8:00 拂晓
    Dawn,
    /// 8:00-18:00 白昼
    Day,
    /// 18:00-22:00 黄昏
    Dusk,
    /// 22:00-5:00 深夜
    Night,
}

impl DayPart {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dawn => "dawn",
            Self::Day => "day",
            Self::Dusk => "dusk",
            Self::Night => "night",
        }
    }
}

/// 由本地小时推导时段（纯函数，边界可测）：5-7 拂晓 / 8-17 白昼 / 18-21 黄昏 / 其余深夜。
pub fn day_part_of_hour(hour: u32) -> DayPart {
    match hour {
        5..=7 => DayPart::Dawn,
        8..=17 => DayPart::Day,
        18..=21 => DayPart::Dusk,
        _ => DayPart::Night,
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum GrowthStage {
    #[default]
    Seed,
    Sprout,
    Hopper,
    Guardian,
    Luminary,
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
    /// 预留变体：桥接层 pet.rs 当前不构造（只发 Succeeded/Failed/Cancelled），
    /// 保留以兼容公共 API；record_tool 不再处理该分支。
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
    /// 审查修复：去裸 "code"/"search" 子串（误伤 vscode/search_files），
    /// Network 用显式 web 形态。
    pub fn classify(title: &str) -> Self {
        let lower = title.to_ascii_lowercase();
        let hit = |keywords: &[&str]| keywords.iter().any(|k| lower.contains(k));
        if hit(&[
            "edit_file",
            "write_file",
            "apply_patch",
            "multi_edit",
            "file_edit",
            "code_edit",
        ]) {
            Self::Code
        } else if hit(&[
            "spawn_agent",
            "delegate",
            "run_agent",
            "subagent",
            "dispatch_agent",
        ]) {
            Self::AgentSpawn
        } else if hit(&[
            "bash",
            "run_command",
            "run_shell",
            "execute",
            "terminal",
            "shell",
        ]) {
            Self::Execute
        } else if hit(&[
            "web_search",
            "search_web",
            "fetch",
            "curl",
            "http",
            "browser",
        ]) {
            Self::Network
        } else if hit(&[
            "read",
            "grep",
            "glob",
            "list",
            "workspace",
            "view",
            "search_files",
            "search_in",
        ]) {
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
    TokenUsage {
        total: u64,
    },
    /// 预留事件：桥接层尚未接线（生产代码只发 TokenUsage），保留供测试/未来增量接口。
    TokenDelta {
        amount: u64,
    },
    ToolCall {
        outcome: ToolOutcome,
    },
    /// M5 感知：工具开始（带分类）——吃代码/捏朋友等行为信号。
    ToolStarted {
        kind: ToolKind,
    },
    /// M5 感知：工具被取消（打断）。
    ToolCancelled,
    /// M5 感知：工作模式切换（plan/code 等）。
    ModeChanged {
        mode: String,
    },
    /// M5 感知：模型切换。
    ModelChanged {
        model: String,
    },
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
    pub code_files: VecDeque<String>,
    // ── M9 成就计数（B 层只增不减）──
    /// 喂食总次数（Feed 事件）。
    pub feed_count: u64,
    /// 玩耍总次数（Play 事件）。
    pub play_count: u64,
    /// 深夜时段互动次数（Night 时段的真实互动，M8 午夜陪伴）。
    pub night_visits: u64,
    /// 已收集装扮数量（M10 掉落/解锁）。
    pub cosmetics_collected: u64,
}

// R6c：成就/装扮表与 PetState 扩展方法拆分至子模块（纯搬移）
pub mod achievements;
pub mod cosmetics;
pub use achievements::{AchievementDef, AchievementInfo, ACHIEVEMENTS};
pub use cosmetics::{CosmeticDef, CosmeticInfo, CosmeticKind, CosmeticUnlock, COSMETICS};

/// 审查修复（P2-4）：0-100 状态值反序列化钳制——手改/损坏存档含 >100 值时
/// 不再整份拒绝（否则 load 失败宠物重置），而是钳到 100。
fn clamp_u8<'de, D>(deserializer: D) -> Result<u8, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    Ok(value.min(100) as u8)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PetState {
    pub name: String,
    pub mood: String,
    #[serde(deserialize_with = "clamp_u8")]
    pub happiness: u8,
    #[serde(deserialize_with = "clamp_u8")]
    pub energy: u8,
    pub xp: u32,
    pub bond: u32,
    pub born_at_ms: u64,
    pub last_seen_day: u64,
    pub first_chunk_at_ms: Option<u64>,
    // ── v2：需求维度（设计书 §3，0-100）──
    #[serde(deserialize_with = "clamp_u8")]
    pub hunger: u8,
    #[serde(deserialize_with = "clamp_u8")]
    pub fun: u8,
    #[serde(deserialize_with = "clamp_u8")]
    pub loneliness: u8,
    // ── v2：个性 / 状态机 / 感知 ──
    pub traits: PetTraits,
    pub machine: PetMachineState,
    pub last_tick_at_ms: u64,
    /// R29：环形缓冲（VecDeque）——push_back/pop_front O(1)，serde 数组契约不变。
    pub recent_events: VecDeque<RecentEvent>,
    pub last_agent_mode: Option<String>,
    pub last_agent_model: Option<String>,
    pub pending_action: Option<PendingAction>,
    /// M9 成就：已解锁成就 id 列表（B 层只增不减，幂等）。
    #[serde(default)]
    pub unlocked: Vec<String>,
    /// M10 装扮：已掉落/获得的物品 id 列表（掉落池物品；成长解锁不入栏）。
    #[serde(default)]
    pub inventory: Vec<String>,
    /// M10 装扮：当前装备的物品 id（None = 未装备）。
    #[serde(default)]
    pub equipped: Option<String>,
    /// M10 装扮：最近一次掉落时间（Unix 毫秒，落盘——24h 冷却防刷，重启不清空）。
    #[serde(default)]
    pub last_drop_at_ms: u64,
    // ── 原有 ──
    pub stats: PetStats,
    /// R29：环形缓冲（VecDeque），serde 数组契约不变。
    pub memories: VecDeque<String>,
    #[serde(skip)]
    pub msg: Option<String>,
    #[serde(skip)]
    last_interaction_at_ms: u64,
    /// M7 审查修复：最近一次活动时间（不落盘）——check_sleepy 发呆判定基准；
    /// 任何 apply 事件（除 Visit/Sleepy）都会刷新。
    #[serde(skip)]
    last_activity_at_ms: u64,
    /// M8 时段感知：本地时区偏移（分钟，东正西负；不落盘——重启后由桥接层
    /// 按系统时区重新注入）。0 = UTC（测试/无桥接环境）。时段判定粒度是小时，
    /// 夏令时切换的半小时级误差可忽略（中国无夏令时）。
    #[serde(skip)]
    local_offset_minutes: i32,
    // ── v2 防刷（M4；不落盘，重启后冷却清空）──
    #[serde(skip)]
    last_feed_at_ms: u64,
    #[serde(skip)]
    feed_spam_count: u8,
    #[serde(skip)]
    last_play_at_ms: u64,
    /// M6 文案轮换索引（不落盘）：每场景独立计数器（R30）——交替场景各用
    /// 各的索引，不再锁步对齐周期性重复。
    #[serde(skip)]
    line_idx_by_scene: std::collections::HashMap<lines::LineKey, u8>,
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
            recent_events: VecDeque::with_capacity(RECENT_EVENTS_CAP),
            last_agent_mode: None,
            last_agent_model: None,
            pending_action: None,
            unlocked: Vec::new(),
            inventory: Vec::new(),
            equipped: None,
            last_drop_at_ms: 0,
            stats: PetStats {
                active_days: 1,
                streak_days: 1,
                longest_streak: 1,
                ..PetStats::default()
            },
            memories: VecDeque::new(),
            msg: Some(lines::pick(
                lines::LineKey::Birth,
                &mut std::collections::HashMap::new(),
                DayPart::Day,
            )),
            last_interaction_at_ms: 0,
            last_activity_at_ms: 0,
            local_offset_minutes: 0,
            last_feed_at_ms: 0,
            feed_spam_count: 0,
            last_play_at_ms: 0,
            line_idx_by_scene: std::collections::HashMap::new(),
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
        // A13：数值上限——手改/损坏存档注入的天文数字钳制到合法上限
        //（xp/bond 上限与 gain_xp/gain_bond 的封顶一致，stats 统一 10M 上限）
        saved.xp = saved.xp.min(999_999);
        saved.bond = saved.bond.min(9_999);
        saved.stats.messages = saved.stats.messages.min(10_000_000);
        saved.stats.prompts_completed = saved.stats.prompts_completed.min(10_000_000);
        saved.stats.prompts_failed = saved.stats.prompts_failed.min(10_000_000);
        saved.stats.tokens_total = saved.stats.tokens_total.min(10_000_000);
        saved.stats.token_xp = saved.stats.token_xp.min(10_000_000);
        saved.stats.tools_started = saved.stats.tools_started.min(10_000_000);
        saved.stats.tools_succeeded = saved.stats.tools_succeeded.min(10_000_000);
        saved.stats.tools_failed = saved.stats.tools_failed.min(10_000_000);
        saved.stats.interactions = saved.stats.interactions.min(10_000_000);
        saved.stats.active_days = saved.stats.active_days.min(10_000_000);
        saved.stats.streak_days = saved.stats.streak_days.min(10_000_000);
        saved.stats.longest_streak = saved.stats.longest_streak.min(10_000_000);
        saved.stats.code_sessions = saved.stats.code_sessions.min(10_000_000);
        saved.stats.code_eaten = saved.stats.code_eaten.min(10_000_000);
        saved.stats.code_watched = saved.stats.code_watched.min(10_000_000);
        saved.stats.friends_made = saved.stats.friends_made.min(10_000_000);
        saved.stats.dazes = saved.stats.dazes.min(10_000_000);
        saved.stats.feed_count = saved.stats.feed_count.min(10_000_000);
        saved.stats.play_count = saved.stats.play_count.min(10_000_000);
        saved.stats.night_visits = saved.stats.night_visits.min(10_000_000);
        saved.stats.cosmetics_collected = saved.stats.cosmetics_collected.min(10_000_000);
        // A13：id 白名单——未知成就/装扮 id 一律剔除（防注入假解锁）；
        // 必须在 unlock_achievements 补查**之前**执行，保证补查只基于合法 id。
        saved
            .unlocked
            .retain(|id| ACHIEVEMENTS.iter().any(|a| a.id.as_str() == id.as_str()));
        saved.unlocked.truncate(64);
        saved
            .inventory
            .retain(|id| COSMETICS.iter().any(|c| c.id == id));
        saved.inventory.truncate(128);
        // S7 审查修复：equipped 校验与 equip() 语义一致——合法 id **且拥有**
        //（掉落入栏 / bond / stage 成长条件）。手改/损坏存档注入"未拥有"装备
        //（如 equipped=code_crown + bond=50）→ 置 None；C10"掉落不顶装备"使
        // 非法状态无法被后续掉落纠正，restore 是唯一防线。
        if let Some(id) = saved.equipped.as_deref() {
            let owned = COSMETICS
                .iter()
                .find(|def| def.id == id)
                .is_some_and(|def| saved.owns_cosmetic(def));
            if !owned {
                saved.equipped = None;
            }
        }
        saved.stats.cosmetics_collected = saved.inventory.len() as u64;
        // 旧存档 last_tick_at_ms=0（v1 无此字段）：审查修复——以**现在**为基准，
        // 而不是 born_at（久远存档会触发 24h 惩罚性衰减，违背"不惩罚"意图）。
        if saved.last_tick_at_ms == 0 {
            saved.last_tick_at_ms = now_ms;
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
        saved.last_activity_at_ms = 0;
        saved.recompute_stats();
        saved.visit(now_ms);
        // M9：旧档恢复后补查成就（满足条件的立即解锁，不因"已达标未触发"错过）
        saved.unlock_achievements();
        saved.msg = Some(format!("{} 又亮起来了。", saved.name));
        saved
    }

    /// v2：事件入口——先结算需求衰减（时间戳），再记录窗口事件、应用收益表、
    /// 执行 HSM 转移（设计书 §5 T1-T8）。
    pub fn apply(&mut self, event: AiEvent, now_ms: u64) {
        // O54：时段一次计算，事件内复用（night_bond/record_night_visit 收 part 参数）
        let part = self.day_part(now_ms);
        self.settle(now_ms);
        self.visit(now_ms);
        // M7 审查修复：活动时间戳——除轮询心跳（Visit）与入睡动作（Sleepy）外的
        // 任何事件都视为"有活动"；check_sleepy 的发呆判定以此为准（修复长生成期间
        // first_chunk_at_ms 不刷新导致的睡-醒振荡，见 check_sleepy）。
        if !matches!(event, AiEvent::Visit | AiEvent::Sleepy) {
            self.last_activity_at_ms = now_ms;
        }
        // T2：睡眠中真实互动事件（Poke/Feed/Play/对话）→ 唤醒。
        // 审查修复：TokenUsage/TokenDelta/工具事件等"工作流噪声"不唤醒——
        // 否则流式 usage_update 会在长生成期间反复唤醒（睡-醒振荡 + energy 农场）。
        if self.machine == PetMachineState::Asleep
            && matches!(
                event,
                AiEvent::UserSent
                    | AiEvent::FirstChunk
                    | AiEvent::Poke
                    | AiEvent::Feed
                    | AiEvent::Play
            )
        {
            self.wake(now_ms);
        }
        match event {
            AiEvent::Visit => {
                // 审查修复：asleep 时访问仅记账（跨天结算在 visit()），不唤醒
                //（真实唤醒靠 Poke/Feed/Play 的 T2）。
            }
            AiEvent::UserSent => {
                self.stats.messages = self.stats.messages.saturating_add(1);
                self.first_chunk_at_ms = None;
                // 审查修复：用户发消息也是互动——刷新睡眠判定基准（防对话中 energy≤15 被 T1/T8 误入睡）
                self.last_interaction_at_ms = now_ms;
                // mood 由 derive_mood 推导
                self.hunger = self.hunger.saturating_sub(1);
                self.energy = self.energy.saturating_sub(2);
                self.fun = (self.fun as u16 + 2).min(100) as u8;
                self.loneliness = self.loneliness.saturating_sub(15);
                self.happiness = (self.happiness as u16 + 1).min(100) as u8;
                // M8：午夜陪伴——Night 时段发消息 bond ×1.5
                self.gain_bond(self.night_bond(part, 1));
                self.record_night_visit(part);
                self.msg = Some(lines::pick(
                    lines::LineKey::UserSent,
                    &mut self.line_idx_by_scene,
                    part,
                ));
            }
            AiEvent::FirstChunk => {
                // T5：对话开始 → Interacting
                self.machine = PetMachineState::Awake(MachineSub::Interacting);
                // 审查修复：对话开始也是互动（同上，防 T1/T8 误入睡）
                self.last_interaction_at_ms = now_ms;
                if self.first_chunk_at_ms.is_none() {
                    self.first_chunk_at_ms = Some(now_ms);
                    // mood 由 derive_mood 推导
                    self.msg = Some(lines::pick(
                        lines::LineKey::FirstChunk,
                        &mut self.line_idx_by_scene,
                        part,
                    ));
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
                } else if self.stats.prompts_completed.is_multiple_of(10) {
                    self.remember(format!(
                        "共同完成了 {} 次任务",
                        self.stats.prompts_completed
                    ));
                }
                self.push_event(RecentEvent::Done);
                self.msg = Some(lines::pick(
                    lines::LineKey::Done,
                    &mut self.line_idx_by_scene,
                    part,
                ));
                // M10：稀有发现掉落（1% + 24h 冷却；任务完成是掉落时机之一）
                self.maybe_drop_cosmetic(now_ms, rand::rng().random_range(0..1000u32));
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
                self.msg = Some(lines::pick(
                    lines::LineKey::Failed,
                    &mut self.line_idx_by_scene,
                    part,
                ));
            }
            AiEvent::TokenUsage { total } => self.set_token_total(total),
            // 预留事件：桥接层尚未接线，保留处理供测试/未来增量接口
            AiEvent::TokenDelta { amount } => self.add_token_delta(amount),
            AiEvent::ToolCall { outcome } => self.record_tool(outcome, now_ms),
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
                        // M6：捏朋友——30s 延迟完成（时间戳驱动，零后台任务）。
                        // 审查修复：已有 crafting 时不覆盖（连续 spawn 不会无限推迟完成）。
                        if self.pending_action.is_none() {
                            self.pending_action = Some(PendingAction::CraftFriend {
                                until_ms: now_ms + 30_000,
                            });
                        }
                        self.msg = Some(lines::pick(
                            lines::LineKey::FriendStart,
                            &mut self.line_idx_by_scene,
                            part,
                        ));
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
                // 审查修复：写入 last_agent_mode（此前只 push 事件，前端永远 null）；
                // 限频记忆：同模式不重复记（仿照 ModelChanged）。
                if self.last_agent_mode.as_deref() != Some(mode.as_str()) {
                    self.remember(format!("它记住：进入了{mode}模式"));
                    self.last_agent_mode = Some(mode);
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
                // C12：对话结束（拒绝）→ Idle——与 PromptCompleted/Failed 一致
                //（否则 Interacting 卡住，情绪恒推导 curious）
                self.machine = PetMachineState::Awake(MachineSub::Idle);
                self.first_chunk_at_ms = None;
                self.push_event(RecentEvent::Refused);
                self.msg = Some("它歪头，光里写满了问号。".into());
            }
            AiEvent::PromptMaxed => {
                // C12：对话结束（达轮次上限）→ Idle——同上
                self.machine = PetMachineState::Awake(MachineSub::Idle);
                self.first_chunk_at_ms = None;
                self.push_event(RecentEvent::Maxed);
                self.msg = Some("它累瘫了，像跑完了所有循环。".into());
            }
            AiEvent::PromptTimeout => {
                // 审查修复：T7 超时 → 状态回 Idle（否则 Interacting 卡住推导 curious）
                self.machine = PetMachineState::Awake(MachineSub::Idle);
                self.stats.dazes = self.stats.dazes.saturating_add(1);
                self.fun = (self.fun as u16 + 5).min(100) as u8;
                self.push_event(RecentEvent::Timeout);
                self.msg = Some(lines::pick(
                    lines::LineKey::Dazed,
                    &mut self.line_idx_by_scene,
                    part,
                ));
            }
            AiEvent::CodeSeen => {
                self.stats.code_watched = self.stats.code_watched.saturating_add(1);
            }
            AiEvent::Poke => {
                self.stats.interactions = self.stats.interactions.saturating_add(1);
                self.happiness = (self.happiness as u16 + 4).min(100) as u8;
                self.fun = (self.fun as u16 + 2).min(100) as u8;
                self.loneliness = self.loneliness.saturating_sub(15);
                // M8：午夜陪伴——Night 时段戳一戳 bond ×1.5
                self.reward_interaction(now_ms, self.night_bond(part, 1));
                self.record_night_visit(part);
                // C13：戳也是互动——刷新睡眠判定基准（防 energy≤15 时持续互动被 T1/T8 误入睡）
                self.last_interaction_at_ms = now_ms;
                // mood 由 derive_mood 推导
                self.push_event(RecentEvent::Poke);
                self.msg = Some(lines::pick(
                    lines::LineKey::Poke,
                    &mut self.line_idx_by_scene,
                    part,
                ));
            }
            AiEvent::Feed => {
                self.stats.interactions = self.stats.interactions.saturating_add(1);
                // M9：喂食计数（成就条件）
                self.stats.feed_count = self.stats.feed_count.saturating_add(1);
                // M4 防刷：30s 内重复喂食收益递减（100%→50%→25%→0），30s 后重置
                // （last_feed_at_ms==0 = 从未喂过，首次不视为 spam）
                if self.last_feed_at_ms > 0 && now_ms.saturating_sub(self.last_feed_at_ms) < 30_000
                {
                    self.feed_spam_count = (self.feed_spam_count + 1).min(3);
                } else {
                    self.feed_spam_count = 0;
                }
                self.last_feed_at_ms = now_ms;
                let multiplier = [100_u16, 50, 25, 0][self.feed_spam_count as usize];
                // 审查修复：hunger 收益固定 +20（贪吃改作用于 bond，见 reward 调用）
                let hunger_gain = 20_u16 * multiplier / 100;
                self.hunger = (self.hunger as u16 + hunger_gain).min(100) as u8;
                self.energy = (self.energy as u16 + 20 * multiplier / 100).min(100) as u8;
                self.fun = (self.fun as u16 + 3 * multiplier / 100).min(100) as u8;
                self.loneliness = self
                    .loneliness
                    .saturating_sub((20 * multiplier / 100) as u8);
                self.happiness = (self.happiness as u16 + 7 * multiplier / 100).min(100) as u8;
                // bond 走 reward_interaction（30s 冷却）；审查修复：贪吃 → bond 收益 ×(1+greed/100)；
                // M8：午夜陪伴——Night 时段喂食 bond 再 ×1.5
                // O53：贪吃 → bond ×(1+greed/100)。对齐注释意图的通用公式
                // ((100+greed)×amount)/100——当前基础 bond=1，整数除法下与旧式
                // （1 + greed/100）数值一致（greed 1-99 → 1，greed=100 → 2）；
                // 该公式在 amount>1 时才体现加成差异。
                let base_bond = 1_u32;
                let greed_bond = (100 + self.traits.greed as u32) * base_bond / 100;
                self.reward_interaction(now_ms, self.night_bond(part, greed_bond));
                self.record_night_visit(part);
                // C13：喂食也是互动——刷新睡眠判定基准（防 energy≤15 时持续互动被 T1/T8 误入睡）
                self.last_interaction_at_ms = now_ms;
                // mood 由 derive_mood 推导
                self.push_event(RecentEvent::Feed);
                self.msg = Some(lines::pick(
                    lines::LineKey::Feed,
                    &mut self.line_idx_by_scene,
                    part,
                ));
            }
            AiEvent::Play => {
                self.stats.interactions = self.stats.interactions.saturating_add(1);
                // M9：玩耍计数（成就条件）
                self.stats.play_count = self.stats.play_count.saturating_add(1);
                // M4 防刷：玩耍 60s 冷却（bond 收益；数值恢复不受限；首次不视为冷却中）
                let play_cooled = self.last_play_at_ms == 0
                    || now_ms.saturating_sub(self.last_play_at_ms) >= 60_000;
                self.last_play_at_ms = now_ms;
                // 审查修复：玩耍也是互动——刷新睡眠判定基准（防 30s 内误入睡）
                self.last_interaction_at_ms = now_ms;
                self.hunger = self.hunger.saturating_sub(5);
                self.energy = self.energy.saturating_sub(10);
                // M4 个性：好奇 → 玩耍 fun 收益 ×(1+curiosity/100)（100%~200%）
                let curiosity_factor = 100 + self.traits.curiosity as u16;
                let fun_gain = 25_u16 * curiosity_factor / 100;
                self.fun = (self.fun as u16 + fun_gain).min(100) as u8;
                self.loneliness = self.loneliness.saturating_sub(30);
                self.happiness = (self.happiness as u16 + 4).min(100) as u8;
                if play_cooled {
                    // M8：午夜陪伴——Night 时段玩耍 bond ×1.5
                    self.gain_bond(self.night_bond(part, 3));
                }
                self.record_night_visit(part);
                // mood 由 derive_mood 推导
                self.push_event(RecentEvent::Play);
                self.msg = Some(lines::pick(
                    lines::LineKey::Play,
                    &mut self.line_idx_by_scene,
                    part,
                ));
            }
            AiEvent::Sleepy => {
                self.machine = PetMachineState::Asleep;
                self.msg = Some(lines::pick(
                    lines::LineKey::Sleep,
                    &mut self.line_idx_by_scene,
                    part,
                ));
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
                self.msg = Some(lines::pick(
                    lines::LineKey::Sleep,
                    &mut self.line_idx_by_scene,
                    part,
                ));
            }
        }
        // M3：情绪统一推导（取代事件直接赋值）
        self.mood = self.derive_mood().to_string();
        // M9：事件后成就检查（幂等；新达成即解锁）
        self.unlock_achievements();
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
        // 审查修复：直接迭代最近 3 条，不再分配 Vec<&RecentEvent>
        let recent3_has = |event: RecentEvent| recent.iter().rev().take(3).any(|e| *e == event);
        // 1. 崩溃/失败（近 3 条）
        if recent3_has(RecentEvent::Crashed)
            || recent3_has(RecentEvent::Failed)
            || recent3_has(RecentEvent::ToolFail)
        {
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
        push_capped(&mut self.recent_events, event, RECENT_EVENTS_CAP);
    }

    /// M5 感知：记录"吃过的代码"文件名（脱敏摘要：仅文件名，不含路径/参数）。
    /// 上限 10 滚动；dispatcher 从 rawInput 提取后调用——原文绝不下沉。
    pub fn record_code_file(&mut self, file: &str) {
        let name = file
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(file)
            .trim()
            .to_string();
        if name.is_empty() || self.stats.code_files.contains(&name) {
            return;
        }
        push_capped(&mut self.stats.code_files, name, 10);
    }

    /// v2 唤醒（T2 转移动作）：状态置 Idle，energy +30，文案（mood 由推导决定）。
    fn wake(&mut self, now_ms: u64) {
        self.machine = PetMachineState::Awake(MachineSub::Idle);
        self.energy = (self.energy as u16 + 30).min(100) as u8;
        let part = self.day_part(now_ms);
        self.msg = Some(lines::pick(
            lines::LineKey::Wake,
            &mut self.line_idx_by_scene,
            part,
        ));
    }

    /// M8 时段感知：当前时段（本地小时推导）。offset 由桥接层注入（见
    /// [`Self::set_local_offset_minutes`]）；0 = UTC。
    /// 修复（2026-08-02 A2）：偏移单位为分钟，直接按分钟加毫秒——旧实现
    /// `offset / 60` 把"小时差当分钟注入"的偏移（写入端 8 → 480 之前）丢弃。
    pub fn day_part(&self, now_ms: u64) -> DayPart {
        let hour = ((now_ms as i64 + self.local_offset_minutes as i64 * 60_000) / 3_600_000)
            .rem_euclid(24) as u32;
        day_part_of_hour(hour)
    }

    /// M8 时段感知：注入本地时区偏移（分钟，东正西负）。桥接层在事件/轮询
    /// 入口调用；不落盘（serde skip），重启后重注入。
    pub fn set_local_offset_minutes(&mut self, minutes: i32) {
        self.local_offset_minutes = minutes.clamp(-24 * 60, 24 * 60);
    }

    /// M8 午夜陪伴（设计书 §13.5.5 预埋机制）：Night 时段互动 bond 收益 ×1.5
    /// （向上取整，至少 +1）。只用于真实互动（UserSent/Poke/Feed/Play）。
    /// O54：part 由调用方（apply 顶部）一次计算后传入。
    fn night_bond(&self, part: DayPart, amount: u32) -> u32 {
        if part == DayPart::Night {
            (amount * 3).div_ceil(2)
        } else {
            amount
        }
    }

    /// M9：深夜互动计数（night_visits 成就条件）——真实互动且 Night 时段。
    /// O54：part 由调用方（apply 顶部）一次计算后传入。
    fn record_night_visit(&mut self, part: DayPart) {
        if part == DayPart::Night {
            self.stats.night_visits = self.stats.night_visits.saturating_add(1);
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
        let Some(end) = self.next_stage_xp() else {
            return 100;
        };
        (((self.xp.saturating_sub(start)) as f32 / (end - start) as f32) * 100.0)
            .round()
            .clamp(0.0, 100.0) as u8
    }

    pub fn rename(&mut self, value: &str, now_ms: u64) {
        self.name = sanitize_name(value);
        let part = self.day_part(now_ms);
        let prefix = lines::pick(lines::LineKey::Rename, &mut self.line_idx_by_scene, part);
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
                let part = self.day_part(now_ms);
                self.msg = Some(lines::pick(
                    lines::LineKey::FriendDone,
                    &mut self.line_idx_by_scene,
                    part,
                ));
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
        // M8：深夜不打扰——Night 时段不说 BORED（深夜不制造陪伴压力）
        let night = self.day_part(now_ms) == DayPart::Night;
        let key = if self.hunger < 25 {
            Some(lines::LineKey::Hungry)
        } else if self.loneliness > 70 {
            Some(lines::LineKey::Lonely)
        } else if self.energy < 20 {
            Some(lines::LineKey::Tired)
        } else if !night && self.fun < 20 {
            Some(lines::LineKey::Bored)
        } else if self.mood == "dazed" {
            Some(lines::LineKey::Dazed)
        } else {
            None
        };
        if let Some(key) = key {
            let part = self.day_part(now_ms);
            self.msg = Some(lines::pick(key, &mut self.line_idx_by_scene, part));
            true
        } else {
            false
        }
    }

    pub fn recall_memory(&self) -> Option<String> {
        self.memories
            .back()
            .map(|memory| format!("同行记录：{memory}"))
    }

    pub fn check_sleepy(&mut self, now_ms: u64) -> bool {
        // v2：状态机判定（原 mood 字符串判断被推导取代）
        if self.machine == PetMachineState::Asleep {
            return true;
        }
        if matches!(self.machine, PetMachineState::Awake(MachineSub::Distress)) {
            return false;
        }
        // 审查修复：发呆判定基于"无任何活动"——last_activity_at_ms 由任何 apply 事件
        // （除 Visit/Sleepy）刷新；不再依赖 first_chunk_at_ms（长生成期间不刷新，
        // 曾导致 30s 后误入睡 → 流式 TokenUsage 唤醒 +30 → 再入睡的振荡与能量农场）。
        if now_ms.saturating_sub(self.last_activity_at_ms) > 30_000 {
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
        // O52：极端量级不再 u32 截断回绕——超限钳到 u32::MAX（增益封顶，行为等价）
        let gained = u32::try_from(new_steps.saturating_sub(old_steps)).unwrap_or(u32::MAX);
        self.stats.tokens_total = total;
        self.stats.token_xp = self.stats.token_xp.saturating_add(gained);
        self.gain_xp(gained);
    }

    fn add_token_delta(&mut self, amount: u64) {
        let total = self.stats.tokens_total.saturating_add(amount);
        self.set_token_total(total);
    }

    fn record_tool(&mut self, outcome: ToolOutcome, now_ms: u64) {
        match outcome {
            // 审查修复：ToolOutcome::Started 为死分支——桥接层 pet.rs 只发
            // Succeeded/Failed/Cancelled；变体保留仅为兼容公共 API，此臂不产生任何统计。
            ToolOutcome::Started => {}
            // 口径说明（现状语义）：Cancelled 只计入 tools_started（分母），
            // 不计成功也不计失败（取消 ≠ 失败）——tool_success_rate =
            // succeeded / started 因此是"取消算分母"的保守下限。
            ToolOutcome::Succeeded => {
                self.stats.tools_started = self.stats.tools_started.saturating_add(1);
                self.stats.tools_succeeded = self.stats.tools_succeeded.saturating_add(1);
                self.gain_xp(2);
                self.gain_bond(1);
                self.fun = (self.fun as u16 + 2).min(100) as u8;
                self.happiness = (self.happiness as u16 + 1).min(100) as u8;
                self.push_event(RecentEvent::ToolOk);
                // M10：稀有发现掉落（1% + 24h 冷却；工具成功是掉落时机之一）
                self.maybe_drop_cosmetic(now_ms, rand::rng().random_range(0..1000u32));
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
        self.stats.streak_days = if elapsed == 1 {
            self.stats.streak_days.saturating_add(1)
        } else {
            1
        };
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
        // 审查修复：last_interaction==0（从未互动）视为首次，不触发冷却
        if self.last_interaction_at_ms == 0
            || now_ms.saturating_sub(self.last_interaction_at_ms) >= 30_000
        {
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
        if self.memories.back() == Some(&memory) {
            return;
        }
        push_capped(&mut self.memories, memory, 10);
    }

    fn recompute_stats(&mut self) {
        let resolved = self
            .stats
            .tools_succeeded
            .saturating_add(self.stats.tools_failed);
        self.stats.tools_started = self.stats.tools_started.max(resolved);
        self.stats.tool_success_rate = self
            .stats
            .tools_succeeded
            .saturating_mul(100)
            .checked_div(self.stats.tools_started)
            .map(|rate| rate.min(100) as u8)
            .unwrap_or(0);
        self.stats.active_days = self.stats.active_days.max(1);
        self.stats.streak_days = self.stats.streak_days.max(1);
        self.stats.longest_streak = self.stats.longest_streak.max(self.stats.streak_days);
    }
}

fn sanitize_name(value: &str) -> String {
    let name: String = value.trim().chars().take(12).collect();
    if name.is_empty() {
        "微栖".into()
    } else {
        name
    }
}

/// 环形缓冲 helper：push_back 后若超过 cap 则 pop_front 淘汰最旧（O(1)），
/// 返回被淘汰的元素（调用方通常忽略）。
/// R29：Vec → VecDeque——原实现 push 后 remove(0) 是 O(n) 搬移；三处
/// recent_events/code_files/memories 统一走此 helper。serde 数组契约不变。
fn push_capped<T>(deque: &mut VecDeque<T>, item: T, cap: usize) -> Option<T> {
    deque.push_back(item);
    (deque.len() > cap).then(|| deque.pop_front().expect("len > cap ⇒ 非空"))
}

fn day_number(ms: u64) -> u64 {
    ms / DAY_MS
}
