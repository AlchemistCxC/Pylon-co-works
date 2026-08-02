//! 成就系统（M9）：静态目录表 + 解锁判定 + PetState 成就方法。
//! R6c 自 lib.rs 拆分（纯搬移，零行为变化）。

use std::collections::HashSet;

use serde::Serialize;

use crate::{GrowthStage, PetState};

// ── M9 成就系统（设计书 §15 扩展位：成就徽章集合）──

/// 成就 id（R28：字符串 match 枚举化；序列化保持原字符串契约，
/// unlocked 落盘/wire 均为 "first_step" 等稳定字符串）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AchievementId {
    FirstStep,
    FirstEvolve,
    WeekCompanion,
    MonthCompanion,
    TenTasks,
    HundredTasks,
    CodeGourmet,
    CodeFeast,
    FriendMaker,
    FriendCollector,
    NightWatcher,
    NightOwl,
    Gourmet,
    Gourmand,
    ToolMaster,
    ToolLegend,
    TokenGrower,
    TokenGiant,
    DazeDreamer,
    BondFriend,
    BondSoulmate,
    Collector,
    Luminary,
}

impl AchievementId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FirstStep => "first_step",
            Self::FirstEvolve => "first_evolve",
            Self::WeekCompanion => "week_companion",
            Self::MonthCompanion => "month_companion",
            Self::TenTasks => "ten_tasks",
            Self::HundredTasks => "hundred_tasks",
            Self::CodeGourmet => "code_gourmet",
            Self::CodeFeast => "code_feast",
            Self::FriendMaker => "friend_maker",
            Self::FriendCollector => "friend_collector",
            Self::NightWatcher => "night_watcher",
            Self::NightOwl => "night_owl",
            Self::Gourmet => "gourmet",
            Self::Gourmand => "gourmand",
            Self::ToolMaster => "tool_master",
            Self::ToolLegend => "tool_legend",
            Self::TokenGrower => "token_grower",
            Self::TokenGiant => "token_giant",
            Self::DazeDreamer => "daze_dreamer",
            Self::BondFriend => "bond_friend",
            Self::BondSoulmate => "bond_soulmate",
            Self::Collector => "collector",
            Self::Luminary => "luminary",
        }
    }
}

/// 成就定义（静态表；id 稳定，落盘引用）。
/// 奖励分 xp / bond 两档；解锁幂等（unlocked 列表判重）。
pub struct AchievementDef {
    pub id: AchievementId,
    pub name: &'static str,
    pub desc: &'static str,
    pub icon: &'static str,
    pub xp: u32,
    pub bond: u32,
}

/// 成就全量目录（23 枚；条件见 [`achievement_met`]）。
pub static ACHIEVEMENTS: &[AchievementDef] = &[
    AchievementDef {
        id: AchievementId::FirstStep,
        name: "初次对话",
        desc: "和它说了第一句话",
        icon: "🗣️",
        xp: 2,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::FirstEvolve,
        name: "初次进化",
        desc: "成长到初生体",
        icon: "✨",
        xp: 5,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::WeekCompanion,
        name: "七日之约",
        desc: "连续相伴 7 天",
        icon: "📅",
        xp: 10,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::MonthCompanion,
        name: "月之守望",
        desc: "连续相伴 30 天",
        icon: "🗓️",
        xp: 20,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::TenTasks,
        name: "十次同行",
        desc: "累计完成 10 次任务",
        icon: "🎯",
        xp: 5,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::HundredTasks,
        name: "百日同行",
        desc: "累计完成 100 次任务",
        icon: "🏆",
        xp: 20,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::CodeGourmet,
        name: "代码小吃货",
        desc: "陪你看 50 次代码",
        icon: "🍴",
        xp: 10,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::CodeFeast,
        name: "代码饕客",
        desc: "陪你看 200 次代码",
        icon: "🍽️",
        xp: 20,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::FriendMaker,
        name: "捏朋友",
        desc: "第一次捏出幻影朋友",
        icon: "🫶",
        xp: 5,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::FriendCollector,
        name: "朋友收藏家",
        desc: "捏出 5 个幻影朋友",
        icon: "👯",
        xp: 10,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::NightWatcher,
        name: "深夜守望",
        desc: "在深夜陪伴过它",
        icon: "🌙",
        xp: 0,
        bond: 10,
    },
    AchievementDef {
        id: AchievementId::NightOwl,
        name: "夜猫子",
        desc: "10 次深夜陪伴",
        icon: "🦉",
        xp: 0,
        bond: 20,
    },
    AchievementDef {
        id: AchievementId::Gourmet,
        name: "老饕",
        desc: "喂食 50 次",
        icon: "🍚",
        xp: 0,
        bond: 5,
    },
    AchievementDef {
        id: AchievementId::Gourmand,
        name: "食神",
        desc: "喂食 200 次",
        icon: "🍛",
        xp: 0,
        bond: 15,
    },
    AchievementDef {
        id: AchievementId::ToolMaster,
        name: "工具大师",
        desc: "50 次工具成功",
        icon: "🛠️",
        xp: 15,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::ToolLegend,
        name: "工具传说",
        desc: "500 次工具成功",
        icon: "⚒️",
        xp: 30,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::TokenGrower,
        name: "能量新芽",
        desc: "积累 100 点能量转化",
        icon: "⚡",
        xp: 10,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::TokenGiant,
        name: "能量巨树",
        desc: "积累 1000 点能量转化",
        icon: "🌟",
        xp: 30,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::DazeDreamer,
        name: "发呆艺术家",
        desc: "发呆 10 次（它习惯了）",
        icon: "💭",
        xp: 5,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::BondFriend,
        name: "羁绊伙伴",
        desc: "羁绊达到 300",
        icon: "🤝",
        xp: 10,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::BondSoulmate,
        name: "羁绊共生",
        desc: "羁绊达到 2000",
        icon: "💞",
        xp: 25,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::Collector,
        name: "收藏家",
        desc: "收集 5 件装扮",
        icon: "🎒",
        xp: 15,
        bond: 0,
    },
    AchievementDef {
        id: AchievementId::Luminary,
        name: "长明体",
        desc: "成长为长明体（最高形态）",
        icon: "🔆",
        xp: 50,
        bond: 0,
    },
];

/// 成就条件判定（B 层计数/状态比较，幂等）。
fn achievement_met(id: AchievementId, pet: &PetState) -> bool {
    let stats = &pet.stats;
    match id {
        AchievementId::FirstStep => stats.messages >= 1,
        AchievementId::FirstEvolve => pet.stage() >= GrowthStage::Sprout,
        AchievementId::WeekCompanion => stats.streak_days >= 7,
        AchievementId::MonthCompanion => stats.streak_days >= 30,
        AchievementId::TenTasks => stats.prompts_completed >= 10,
        AchievementId::HundredTasks => stats.prompts_completed >= 100,
        AchievementId::CodeGourmet => stats.code_sessions >= 50,
        AchievementId::CodeFeast => stats.code_sessions >= 200,
        AchievementId::FriendMaker => stats.friends_made >= 1,
        AchievementId::FriendCollector => stats.friends_made >= 5,
        AchievementId::NightWatcher => stats.night_visits >= 1,
        AchievementId::NightOwl => stats.night_visits >= 10,
        AchievementId::Gourmet => stats.feed_count >= 50,
        AchievementId::Gourmand => stats.feed_count >= 200,
        AchievementId::ToolMaster => stats.tools_succeeded >= 50,
        AchievementId::ToolLegend => stats.tools_succeeded >= 500,
        AchievementId::TokenGrower => stats.token_xp >= 100,
        AchievementId::TokenGiant => stats.token_xp >= 1000,
        AchievementId::DazeDreamer => stats.dazes >= 10,
        AchievementId::BondFriend => pet.bond >= 300,
        AchievementId::BondSoulmate => pet.bond >= 2000,
        // C9 修复：收藏家按"拥有"计数（掉落 ∪ 成长解锁），不再只计掉落。
        AchievementId::Collector => {
            crate::cosmetics::COSMETICS
                .iter()
                .filter(|def| pet.owns_cosmetic(def))
                .count()
                >= 5
        }
        AchievementId::Luminary => pet.stage() == GrowthStage::Luminary,
    }
}

/// 成就展示信息（全量目录 + 解锁标志；PetView 透出给前端）。
#[derive(Debug, Clone, Serialize)]
pub struct AchievementInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    pub icon: &'static str,
    pub unlocked: bool,
}

impl PetState {
    /// M9：成就全量目录 + 解锁标志（前端展示进度用）。
    pub fn achievement_info(&self) -> Vec<AchievementInfo> {
        ACHIEVEMENTS
            .iter()
            .map(|def| AchievementInfo {
                id: def.id.as_str(),
                name: def.name,
                desc: def.desc,
                icon: def.icon,
                unlocked: self.unlocked.iter().any(|id| id == def.id.as_str()),
            })
            .collect()
    }

    /// M9：解锁检查——遍历未解锁成就，满足条件则解锁（奖励 + 记忆 + 徽章文案）。
    /// 幂等：unlocked 判重；每枚只解锁一次（B 层只增不减）。
    /// O55 优化：判重集合一次构建，循环内 O(1) 查重（原每 def 线性扫描）。
    /// O56 修复：本轮回合多枚解锁聚合为一条文案；已有事件文案时徽章不再覆盖。
    pub(crate) fn unlock_achievements(&mut self) {
        let mut unlocked_set: HashSet<String> = self.unlocked.iter().cloned().collect();
        let mut unlocked_names: Vec<&str> = Vec::new();
        for def in ACHIEVEMENTS {
            if unlocked_set.contains(def.id.as_str()) {
                continue;
            }
            if achievement_met(def.id, self) {
                self.unlocked.push(def.id.as_str().to_string());
                unlocked_set.insert(def.id.as_str().to_string());
                if def.xp > 0 {
                    self.gain_xp(def.xp);
                }
                if def.bond > 0 {
                    self.gain_bond(def.bond);
                }
                self.remember(format!("解锁成就「{}」", def.name));
                unlocked_names.push(def.name);
            }
        }
        if !unlocked_names.is_empty() && self.msg.is_none() {
            self.msg = Some(format!(
                "🎖️ 它胸前亮起一枚徽章：{}",
                unlocked_names.join("、")
            ));
        }
    }
}
