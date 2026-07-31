//! 平台静态绑定路由（BE-B10-001 施工位）。
//!
//! 占位骨架：完整实现由 BE-B10-001 任务交付（EntityBinding + yaml 解析 + lookup + 单测）。

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntityBinding {
    pub source: String,
    pub agent_id: String,
    pub profile_id: String,
    pub session_key: String,
}

pub struct EntityRouteTable {
    entries: Vec<EntityBinding>,
}

impl EntityRouteTable {
    pub fn empty() -> Self {
        Self { entries: Vec::new() }
    }

    pub fn lookup(&self, source: &str) -> Option<&EntityBinding> {
        self.entries.iter().find(|e| e.source == source)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_table_lookup_returns_none() {
        let table = EntityRouteTable::empty();
        assert!(table.lookup("qq:group:123").is_none());
    }
}
