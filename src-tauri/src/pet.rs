//! Tauri 与独立宠物核心状态机之间的薄适配层。

pub use pylon_pet_core::{
    AchievementInfo, AiEvent, CosmeticDef, CosmeticInfo, DayPart, GrowthStage, PetState, ToolKind,
    ToolOutcome, ACHIEVEMENTS, COSMETICS,
};
use serde::Serialize;
use std::sync::OnceLock;
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
    /// M8：当前时段（dawn/day/dusk/night）——前端可显示时段状态/差异。
    pub day_part: DayPart,
    /// M9：成就全量目录 + 解锁标志（前端徽章墙/进度展示）。
    pub achievements: Vec<AchievementInfo>,
    /// M10：装扮全量目录 + 拥有标志（前端外观/装备界面）。
    pub cosmetics: Vec<CosmeticInfo>,
}

pub fn view(state: &PetState) -> PetView<'_> {
    let stage = state.stage();
    // O14：now_ms() 只取一次，age_days/day_part 共用（两次调用间时钟偏移原可致
    // 展示不一致，行为等价且更省一次系统调用）。
    let now = now_ms();
    PetView {
        state,
        stage,
        title: stage.title(),
        age_days: state.age_days(now),
        next_stage_xp: state.next_stage_xp(),
        growth_progress: state.growth_progress(),
        crafting: state.pending_action.is_some(),
        day_part: state.day_part(now),
        achievements: achievement_directory(state),
        cosmetics: cosmetic_directory(state),
    }
}

/// 成就目录骨架缓存（O15）：静态字段（id/name/desc/icon）仅构建一次；
/// unlocked 标志每次调用由当前 state 现算——行为等价，省去每次 view 全量重建。
static ACHIEVEMENT_SKELETON: OnceLock<
    Vec<(&'static str, &'static str, &'static str, &'static str)>,
> = OnceLock::new();

fn achievement_directory(state: &PetState) -> Vec<AchievementInfo> {
    ACHIEVEMENT_SKELETON
        .get_or_init(|| {
            ACHIEVEMENTS
                .iter()
                .map(|def| (def.id.as_str(), def.name, def.desc, def.icon))
                .collect()
        })
        .iter()
        .map(|(id, name, desc, icon)| AchievementInfo {
            id,
            name,
            desc,
            icon,
            unlocked: state.unlocked.iter().any(|u| u == id),
        })
        .collect()
}

/// 装扮目录骨架缓存（O15）：静态 def 引用仅构建一次；
/// owned 标志每次调用由当前 state 现算——行为等价。
static COSMETIC_SKELETON: OnceLock<Vec<&'static CosmeticDef>> = OnceLock::new();

fn cosmetic_directory(state: &PetState) -> Vec<CosmeticInfo> {
    COSMETIC_SKELETON
        .get_or_init(|| COSMETICS.iter().collect())
        .iter()
        .map(|def| CosmeticInfo {
            id: def.id,
            name: def.name,
            kind: def.kind,
            icon: def.icon,
            owned: state.owns_cosmetic(def),
        })
        .collect()
}

/// 统一事件入口：注入本地时区偏移（M8 时段感知）后 apply。
/// 时段判定粒度是小时，事件路径每次 set 的成本（一次 GetLocalTime）可忽略。
fn apply(state: &mut PetState, event: AiEvent) {
    state.set_local_offset_minutes(local_offset_minutes());
    state.apply(event, now_ms());
}

pub fn restore(state: &mut PetState, saved: PetState) {
    state.set_local_offset_minutes(local_offset_minutes());
    *state = PetState::restore(saved, now_ms());
}

pub fn on_user_sent(state: &mut PetState) {
    apply(state, AiEvent::UserSent);
}

pub fn on_first_chunk(state: &mut PetState) {
    apply(state, AiEvent::FirstChunk);
}

pub fn on_done(state: &mut PetState) {
    apply(state, AiEvent::PromptCompleted);
}

pub fn on_error(state: &mut PetState) {
    apply(state, AiEvent::PromptFailed);
}

pub fn on_poke(state: &mut PetState) {
    apply(state, AiEvent::Poke);
}

pub fn on_feed(state: &mut PetState) {
    apply(state, AiEvent::Feed);
}

/// M4：玩耍（消耗 energy，恢复 fun/降低孤独；60s bond 冷却）。
pub fn on_play(state: &mut PetState) {
    apply(state, AiEvent::Play);
}

pub fn on_usage_update(state: &mut PetState, total: u64) {
    apply(state, AiEvent::TokenUsage { total });
}

/// M5：工具开始（带分类）——吃代码/捏朋友信号。
pub fn on_tool_started_kind(state: &mut PetState, kind: ToolKind) {
    apply(state, AiEvent::ToolStarted { kind });
}

/// M5：工具被取消（打断）。
pub fn on_tool_cancelled(state: &mut PetState) {
    apply(state, AiEvent::ToolCancelled);
}

/// M5：工作模式切换。
pub fn on_mode_changed(state: &mut PetState, mode: &str) {
    apply(
        state,
        AiEvent::ModeChanged {
            mode: mode.to_string(),
        },
    );
}

/// M5：模型切换。
pub fn on_model_changed(state: &mut PetState, model: &str) {
    apply(
        state,
        AiEvent::ModelChanged {
            model: model.to_string(),
        },
    );
}

/// M5：agent 拒绝。
pub fn on_refused(state: &mut PetState) {
    apply(state, AiEvent::PromptRefused);
}

/// M5：达到轮次上限。
pub fn on_maxed(state: &mut PetState) {
    apply(state, AiEvent::PromptMaxed);
}

/// M5：prompt 超时（发呆）。
pub fn on_timeout(state: &mut PetState) {
    apply(state, AiEvent::PromptTimeout);
}

/// M5：输出含代码块。
pub fn on_code_seen(state: &mut PetState) {
    apply(state, AiEvent::CodeSeen);
}

/// M5：记录吃过的代码文件名（脱敏摘要）。
pub fn record_code_file(state: &mut PetState, file: &str) {
    state.record_code_file(file);
}

pub fn on_tool_success(state: &mut PetState) {
    apply(
        state,
        AiEvent::ToolCall {
            outcome: ToolOutcome::Succeeded,
        },
    );
}

pub fn on_tool_failure(state: &mut PetState) {
    apply(
        state,
        AiEvent::ToolCall {
            outcome: ToolOutcome::Failed,
        },
    );
}

pub fn on_agent_connected(state: &mut PetState) {
    apply(state, AiEvent::AgentConnected);
}

pub fn on_agent_crashed(state: &mut PetState) {
    apply(state, AiEvent::AgentCrashed);
}

pub fn recall_memory(state: &mut PetState) {
    state.msg = state
        .recall_memory()
        .or_else(|| Some("还没有形成长期记忆。".into()));
}

pub fn check_sleepy(state: &mut PetState) -> bool {
    state.check_sleepy(now_ms())
}

pub fn daily_visit(state: &mut PetState) {
    apply(state, AiEvent::Visit);
}

/// M6：主动说话（需求危机/延迟行为完成 → msg）。get_pet 轮询调用。
pub fn poll_voice(state: &mut PetState) -> bool {
    state.poll_voice(now_ms())
}

pub fn rename(state: &mut PetState, value: &str) {
    state.set_local_offset_minutes(local_offset_minutes());
    state.rename(value, now_ms());
}

/// M10：装备装扮（校验拥有/成长解锁；失败返回原因字符串）。
pub fn equip(state: &mut PetState, item_id: &str) -> Result<(), String> {
    state.set_local_offset_minutes(local_offset_minutes());
    state.equip(item_id).map(|_| ())
}

/// M10：卸下装扮。
pub fn unequip(state: &mut PetState) {
    state.set_local_offset_minutes(local_offset_minutes());
    state.unequip();
}

/// 本地时区偏移（分钟，东正西负）：Windows 用 GetLocalTime（零依赖 FFI，
/// SYSTEMTIME 布局由官方文档保证、线程安全）；其他平台回退 UTC（0）。
/// 时段判定精度为小时，偏移一天内不变（中国无夏令时），进程级缓存一次。
fn local_offset_minutes() -> i32 {
    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicI32, Ordering};
        static CACHED_OFFSET: AtomicI32 = AtomicI32::new(i32::MIN);
        let cached = CACHED_OFFSET.load(Ordering::Relaxed);
        if cached != i32::MIN {
            return cached;
        }
        let utc_hour = now_ms() / 3_600_000 % 24;
        let local = local_hour_windows();
        let diff_hours = (local as i64 - utc_hour as i64).rem_euclid(24) as i32;
        let offset = if diff_hours > 12 {
            diff_hours - 24
        } else {
            diff_hours
        };
        // 修复（2026-08-02 A2）：返回真分钟（东八区 +8 → +480）——旧实现返回
        // 小时差被 pet-core 按分钟消费（/60）后恒为 0，day_part 永远 UTC。
        let minutes = offset * 60;
        CACHED_OFFSET.store(minutes, Ordering::Relaxed);
        minutes
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// Windows 本地小时（GetLocalTime，0-23）。FFI 声明为 unsafe，调用在
/// 单线程上下文（事件/dispatcher 路径），无并发问题。
#[cfg(windows)]
fn local_hour_windows() -> u32 {
    #[repr(C)]
    struct SystemTime {
        w_year: u16,
        w_month: u16,
        w_day_of_week: u16,
        w_day: u16,
        w_hour: u16,
        w_minute: u16,
        w_second: u16,
        w_milliseconds: u16,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetLocalTime(lp_system_time: *mut SystemTime);
    }
    let mut t = SystemTime {
        w_year: 0,
        w_month: 0,
        w_day_of_week: 0,
        w_day: 0,
        w_hour: 0,
        w_minute: 0,
        w_second: 0,
        w_milliseconds: 0,
    };
    unsafe { GetLocalTime(&mut t) };
    t.w_hour as u32
}

fn now_ms() -> u64 {
    // R4：统一走 Timestamp（Unix 毫秒），不再重复 SystemTime 换算。
    crate::time::Timestamp::now().as_u64()
}

/// 序列化宠物状态（R6a：与磁盘写分离——调用方可在锁内只做内存序列化，
/// 慢速 fs 写移出 pet 锁经 [`Self::write_json_atomic`] 执行）。
pub fn serialize_state(state: &PetState) -> Result<String, String> {
    serde_json::to_string(state).map_err(|e| e.to_string())
}

/// 原子写：唯一临时文件 + rename，中断也不会留下半截 JSON。
/// 审查修复：temp 名含 pid+时间戳——get_pet 轮询与 pet_action 可并发，固定 temp 名
/// 会互相截断写坏（损坏 JSON 被 rename 就位 → 下次启动静默丢档）。
pub fn write_json_atomic(path: &std::path::Path, json: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let unique = {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        path.with_file_name(format!(
            ".{}.{}.{}.tmp",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("state"),
            std::process::id(),
            now,
        ))
    };
    let result = (|| {
        std::fs::write(&unique, json).map_err(|e| e.to_string())?;
        std::fs::rename(&unique, path).map_err(|e| e.to_string())
    })();
    // O16：失败清理遗留 temp（对齐 lifecycle.rs MCP 同款）——write/rename 失败
    // 不再留下半截 `.xxx.tmp` 垃圾文件。
    if let Err(ref error) = result {
        let _ = std::fs::remove_file(&unique);
        log::warn!("write state file failed: {error}");
    }
    result
}

/// 序列化 + 原子写（Exit 兜底等同步路径；高频路径请用 serialize_state + write_json_atomic 分离）。
pub fn save_to_file(state: &PetState, path: &std::path::Path) -> Result<(), String> {
    let json = serialize_state(state)?;
    write_json_atomic(path, &json)
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
