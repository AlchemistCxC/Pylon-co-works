//! 装扮系统（M10）：静态目录表 + 掉落/装备 + PetState 装扮方法。
//! R6c 自 lib.rs 拆分（纯搬移，零行为变化）。

use serde::{Deserialize, Serialize};

use crate::{GrowthStage, PetState};

// ── M10 装扮/物品栏（设计书 §15 扩展位：装扮 + 掉落/兑换）──

/// 装扮种类（前端外观分类；序列化为字符串）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CosmeticKind {
    Hat,
    Cape,
    Glow,
    Companion,
}

/// 装扮获取方式：掉落（1% + 24h 冷却，B 层随机）或成长解锁（确定性条件）。
#[derive(Debug, Clone, Copy)]
pub enum CosmeticUnlock {
    /// 稀有发现掉落池（随机，未拥有才可能掉）。
    Drop,
    /// 羁绊等级解锁（确定性，equip 时校验；不入 inventory）。
    Bond(u32),
    /// 成长阶段解锁（确定性，equip 时校验；不入 inventory）。
    Stage(GrowthStage),
}

/// 装扮定义（静态表；id 稳定，落盘引用）。
pub struct CosmeticDef {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: CosmeticKind,
    pub icon: &'static str,
    pub unlock: CosmeticUnlock,
}

/// 装扮全量目录（掉落 8 + 成长解锁 3）。
pub static COSMETICS: &[CosmeticDef] = &[
    CosmeticDef { id: "beret", name: "夜光贝雷帽", kind: CosmeticKind::Hat, icon: "🎩", unlock: CosmeticUnlock::Drop },
    CosmeticDef { id: "pixel_hat", name: "像素渔夫帽", kind: CosmeticKind::Hat, icon: "👒", unlock: CosmeticUnlock::Drop },
    CosmeticDef { id: "pixel_cape", name: "像素披风", kind: CosmeticKind::Cape, icon: "🧣", unlock: CosmeticUnlock::Drop },
    CosmeticDef { id: "star_scarf", name: "星光围巾", kind: CosmeticKind::Cape, icon: "✨", unlock: CosmeticUnlock::Drop },
    CosmeticDef { id: "glow_band", name: "光点手环", kind: CosmeticKind::Glow, icon: "💫", unlock: CosmeticUnlock::Drop },
    CosmeticDef { id: "code_pin", name: "代码胸针", kind: CosmeticKind::Glow, icon: "🧷", unlock: CosmeticUnlock::Drop },
    CosmeticDef { id: "phantom_cat", name: "幻影猫", kind: CosmeticKind::Companion, icon: "🐱", unlock: CosmeticUnlock::Drop },
    CosmeticDef { id: "mini_orb", name: "迷你光球", kind: CosmeticKind::Companion, icon: "💡", unlock: CosmeticUnlock::Drop },
    CosmeticDef { id: "code_crown", name: "代码之冕", kind: CosmeticKind::Hat, icon: "👑", unlock: CosmeticUnlock::Bond(300) },
    CosmeticDef { id: "bond_glow", name: "羁绊之光", kind: CosmeticKind::Glow, icon: "🔆", unlock: CosmeticUnlock::Bond(2000) },
    CosmeticDef { id: "luminary_wings", name: "长明之翼", kind: CosmeticKind::Cape, icon: "🪽", unlock: CosmeticUnlock::Stage(GrowthStage::Luminary) },
];

/// 装扮展示信息（全量目录 + 拥有标志；PetView 透出给前端）。
#[derive(Debug, Clone, Serialize)]
pub struct CosmeticInfo {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: CosmeticKind,
    pub icon: &'static str,
    pub owned: bool,
}

/// 装扮掉落冷却（24h，防刷）。
const DROP_COOLDOWN_MS: u64 = 24 * 60 * 60 * 1000;
/// 装扮掉落概率（1/100）。
const DROP_PROBABILITY_PERMILLE: u32 = 10;

impl PetState {
    /// M10：装扮全量目录 + 拥有标志。拥有 = 掉落入栏 或 成长条件满足
    /// （成长解锁确定性，可随时装备，不需要提前获得）。
    pub fn cosmetic_info(&self) -> Vec<CosmeticInfo> {
        COSMETICS
            .iter()
            .map(|def| CosmeticInfo {
                id: def.id,
                name: def.name,
                kind: def.kind,
                icon: def.icon,
                owned: self.owns_cosmetic(def),
            })
            .collect()
    }

    /// M10：是否拥有某装扮（掉落入栏 或 成长解锁条件满足）。
    pub fn owns_cosmetic(&self, def: &CosmeticDef) -> bool {
        match def.unlock {
            CosmeticUnlock::Drop => self.inventory.iter().any(|id| id == def.id),
            CosmeticUnlock::Bond(threshold) => self.bond >= threshold,
            CosmeticUnlock::Stage(stage) => self.stage() >= stage,
        }
    }

    /// M10：装备校验——必须是合法物品且"拥有"（掉落入栏或成长解锁）。
    /// 成功返回 Ok(物品名)，失败返回原因。装备后 msg 提示。
    pub fn equip(&mut self, item_id: &str) -> Result<&'static str, String> {
        let def = COSMETICS
            .iter()
            .find(|def| def.id == item_id)
            .ok_or_else(|| format!("未知装扮: {item_id}"))?;
        if !self.owns_cosmetic(def) {
            return Err(format!("尚未拥有该装扮: {}", def.name));
        }
        self.equipped = Some(def.id.to_string());
        self.msg = Some(format!("{} 它把{}装备起来，光更亮了。", def.icon, def.name));
        Ok(def.name)
    }

    /// M10：卸下装备（无装备时静默返回）。
    pub fn unequip(&mut self) {
        if self.equipped.is_none() {
            return;
        }
        let name = self
            .equipped
            .as_deref()
            .and_then(|id| COSMETICS.iter().find(|def| def.id == id))
            .map(|def| def.name)
            .unwrap_or("装扮");
        self.equipped = None;
        self.msg = Some(format!("它把{name}收进光里。"));
    }

    /// M10：稀有发现掉落（设计书 §13.5.5 预埋机制）——
    /// `roll` 为千分位随机数（0-999）：`roll < DROP_PROBABILITY_PERMILLE`（1%）触发；
    /// 24h 冷却（last_drop_at_ms）；只掉落掉落池中未拥有的物品；全收集后掉率为 0。
    /// 返回是否掉落（并自动装备 + 记忆 + 计数）。
    pub fn maybe_drop_cosmetic(&mut self, now_ms: u64, roll: u32) -> bool {
        if roll >= DROP_PROBABILITY_PERMILLE {
            return false;
        }
        if self.last_drop_at_ms > 0 && now_ms.saturating_sub(self.last_drop_at_ms) < DROP_COOLDOWN_MS {
            return false;
        }
        let droppable: Vec<&CosmeticDef> = COSMETICS
            .iter()
            .filter(|def| matches!(def.unlock, CosmeticUnlock::Drop) && !self.inventory.iter().any(|id| id == def.id))
            .collect();
        if droppable.is_empty() {
            return false; // 掉落池已全收集（先判空，random_range(0..0) 会 panic）
        }
        use rand::RngExt;
        let Some(&picked) = droppable.get(rand::rng().random_range(0..droppable.len())) else {
            return false; // 掉落池已全收集
        };
        self.inventory.push(picked.id.to_string());
        self.equipped = Some(picked.id.to_string());
        self.last_drop_at_ms = now_ms;
        self.stats.cosmetics_collected = self.stats.cosmetics_collected.saturating_add(1);
        self.remember(format!("它捡到了{}", picked.name));
        self.msg = Some(format!("{} 它捡到{}，立刻戴上了。", picked.icon, picked.name));
        true
    }

}
