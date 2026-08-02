//! 成就系统（M9）：静态目录表 + 解锁判定 + PetState 成就方法。
//! R6c 自 lib.rs 拆分（纯搬移，零行为变化）。

use serde::Serialize;

use crate::{GrowthStage, PetState};

// ── M9 成就系统（设计书 §15 扩展位：成就徽章集合）──

/// 成就定义（静态表；id 稳定，落盘引用）。
/// 奖励分 xp / bond 两档；解锁幂等（unlocked 列表判重）。
pub struct AchievementDef {
    pub id: &'static str,
    pub name: &'static str,
    pub desc: &'static str,
    pub icon: &'static str,
    pub xp: u32,
    pub bond: u32,
}

/// 成就全量目录（23 枚；条件见 [`achievement_met`]）。
pub static ACHIEVEMENTS: &[AchievementDef] = &[
    AchievementDef {
        id: "first_step",
        name: "初次对话",
        desc: "和它说了第一句话",
        icon: "🗣️",
        xp: 2,
        bond: 0,
    },
    AchievementDef {
        id: "first_evolve",
        name: "初次进化",
        desc: "成长到初生体",
        icon: "✨",
        xp: 5,
        bond: 0,
    },
    AchievementDef {
        id: "week_companion",
        name: "七日之约",
        desc: "连续相伴 7 天",
        icon: "📅",
        xp: 10,
        bond: 0,
    },
    AchievementDef {
        id: "month_companion",
        name: "月之守望",
        desc: "连续相伴 30 天",
        icon: "🗓️",
        xp: 20,
        bond: 0,
    },
    AchievementDef {
        id: "ten_tasks",
        name: "十次同行",
        desc: "累计完成 10 次任务",
        icon: "🎯",
        xp: 5,
        bond: 0,
    },
    AchievementDef {
        id: "hundred_tasks",
        name: "百日同行",
        desc: "累计完成 100 次任务",
        icon: "🏆",
        xp: 20,
        bond: 0,
    },
    AchievementDef {
        id: "code_gourmet",
        name: "代码小吃货",
        desc: "陪你看 50 次代码",
        icon: "🍴",
        xp: 10,
        bond: 0,
    },
    AchievementDef {
        id: "code_feast",
        name: "代码饕客",
        desc: "陪你看 200 次代码",
        icon: "🍽️",
        xp: 20,
        bond: 0,
    },
    AchievementDef {
        id: "friend_maker",
        name: "捏朋友",
        desc: "第一次捏出幻影朋友",
        icon: "🫶",
        xp: 5,
        bond: 0,
    },
    AchievementDef {
        id: "friend_collector",
        name: "朋友收藏家",
        desc: "捏出 5 个幻影朋友",
        icon: "👯",
        xp: 10,
        bond: 0,
    },
    AchievementDef {
        id: "night_watcher",
        name: "深夜守望",
        desc: "在深夜陪伴过它",
        icon: "🌙",
        xp: 0,
        bond: 10,
    },
    AchievementDef {
        id: "night_owl",
        name: "夜猫子",
        desc: "10 次深夜陪伴",
        icon: "🦉",
        xp: 0,
        bond: 20,
    },
    AchievementDef {
        id: "gourmet",
        name: "老饕",
        desc: "喂食 50 次",
        icon: "🍚",
        xp: 0,
        bond: 5,
    },
    AchievementDef {
        id: "gourmand",
        name: "食神",
        desc: "喂食 200 次",
        icon: "🍛",
        xp: 0,
        bond: 15,
    },
    AchievementDef {
        id: "tool_master",
        name: "工具大师",
        desc: "50 次工具成功",
        icon: "🛠️",
        xp: 15,
        bond: 0,
    },
    AchievementDef {
        id: "tool_legend",
        name: "工具传说",
        desc: "500 次工具成功",
        icon: "⚒️",
        xp: 30,
        bond: 0,
    },
    AchievementDef {
        id: "token_grower",
        name: "能量新芽",
        desc: "积累 100 点能量转化",
        icon: "⚡",
        xp: 10,
        bond: 0,
    },
    AchievementDef {
        id: "token_giant",
        name: "能量巨树",
        desc: "积累 1000 点能量转化",
        icon: "🌟",
        xp: 30,
        bond: 0,
    },
    AchievementDef {
        id: "daze_dreamer",
        name: "发呆艺术家",
        desc: "发呆 10 次（它习惯了）",
        icon: "💭",
        xp: 5,
        bond: 0,
    },
    AchievementDef {
        id: "bond_friend",
        name: "羁绊伙伴",
        desc: "羁绊达到 300",
        icon: "🤝",
        xp: 10,
        bond: 0,
    },
    AchievementDef {
        id: "bond_soulmate",
        name: "羁绊共生",
        desc: "羁绊达到 2000",
        icon: "💞",
        xp: 25,
        bond: 0,
    },
    AchievementDef {
        id: "collector",
        name: "收藏家",
        desc: "收集 5 件装扮",
        icon: "🎒",
        xp: 15,
        bond: 0,
    },
    AchievementDef {
        id: "luminary",
        name: "长明体",
        desc: "成长为长明体（最高形态）",
        icon: "🔆",
        xp: 50,
        bond: 0,
    },
];

/// 成就条件判定（B 层计数/状态比较，幂等）。未列出的 id 永远不满足。
fn achievement_met(id: &str, pet: &PetState) -> bool {
    let stats = &pet.stats;
    match id {
        "first_step" => stats.messages >= 1,
        "first_evolve" => pet.stage() >= GrowthStage::Sprout,
        "week_companion" => stats.streak_days >= 7,
        "month_companion" => stats.streak_days >= 30,
        "ten_tasks" => stats.prompts_completed >= 10,
        "hundred_tasks" => stats.prompts_completed >= 100,
        "code_gourmet" => stats.code_sessions >= 50,
        "code_feast" => stats.code_sessions >= 200,
        "friend_maker" => stats.friends_made >= 1,
        "friend_collector" => stats.friends_made >= 5,
        "night_watcher" => stats.night_visits >= 1,
        "night_owl" => stats.night_visits >= 10,
        "gourmet" => stats.feed_count >= 50,
        "gourmand" => stats.feed_count >= 200,
        "tool_master" => stats.tools_succeeded >= 50,
        "tool_legend" => stats.tools_succeeded >= 500,
        "token_grower" => stats.token_xp >= 100,
        "token_giant" => stats.token_xp >= 1000,
        "daze_dreamer" => stats.dazes >= 10,
        "bond_friend" => pet.bond >= 300,
        "bond_soulmate" => pet.bond >= 2000,
        "collector" => stats.cosmetics_collected >= 5,
        "luminary" => pet.stage() == GrowthStage::Luminary,
        _ => false,
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
                id: def.id,
                name: def.name,
                desc: def.desc,
                icon: def.icon,
                unlocked: self.unlocked.iter().any(|id| id == def.id),
            })
            .collect()
    }

    /// M9：解锁检查——遍历未解锁成就，满足条件则解锁（奖励 + 记忆 + 徽章文案）。
    /// 幂等：unlocked 判重；每枚只解锁一次（B 层只增不减）。
    pub(crate) fn unlock_achievements(&mut self) {
        for def in ACHIEVEMENTS {
            if self.unlocked.iter().any(|id| id == def.id) {
                continue;
            }
            if achievement_met(def.id, self) {
                self.unlocked.push(def.id.to_string());
                if def.xp > 0 {
                    self.gain_xp(def.xp);
                }
                if def.bond > 0 {
                    self.gain_bond(def.bond);
                }
                self.remember(format!("解锁成就「{}」", def.name));
                self.msg = Some(format!("{} 它胸前亮起一枚徽章：{}", def.icon, def.name));
            }
        }
    }
}
