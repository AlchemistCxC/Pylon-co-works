//! 平台静态绑定路由（BE-B10-001）。
//!
//! 首版静态 EntityBinding 路由表：source（如 `qq:group:123`）→
//! { agent_id, profile_id, session_key }。未匹配的 source 由调用方回退默认绑定。
//! 二期预留动态覆盖/指令切换接口（本文件只做静态配置解析与查询）。
//!
//! 纯数据层：不依赖 tauri/AppState，不读 env。配置结构：
//!
//! ```yaml
//! gateway:
//!   routes:
//!     - source: qq:group:123
//!       agent: peri
//!       profile: trpg
//!       session: 战役1
//! ```

use std::collections::HashSet;

use serde::Deserialize;

/// 平台绑定实体：source（平台路由 key）→ agent/profile/session 三元组。
///
/// yaml 键名为 `agent`/`profile`/`session`（与 Prism/前端 Session 语义对齐），
/// Rust 侧统一为 `agent_id`/`profile_id`/`session_key` 命名。
// 占位期无消费者（BE-B10-004/005/006 才接入命令层），此处仅抑制 dead_code 中间态噪音；
// 消费者接入后本 allow 可移除。
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EntityBinding {
    pub source: String,
    #[serde(rename = "agent")]
    pub agent_id: String,
    #[serde(rename = "profile")]
    pub profile_id: String,
    #[serde(rename = "session")]
    pub session_key: String,
}

/// gateway 配置文件的顶层结构（未知字段默认忽略）。
#[derive(Debug, Deserialize)]
struct GatewayConfigFile {
    /// 缺 `gateway` 段视为空表（容忍配置文件尚未包含本段）。
    gateway: Option<GatewaySection>,
}

/// `gateway` 段结构。
#[derive(Debug, Deserialize)]
struct GatewaySection {
    /// 缺 `routes` 键视为空列表。
    #[serde(default)]
    routes: Vec<EntityBinding>,
}

/// 静态绑定路由表。
#[allow(dead_code)]
#[derive(Debug)]
pub struct EntityRouteTable {
    entries: Vec<EntityBinding>,
}

impl EntityRouteTable {
    /// 解析 gateway 配置 yaml，构建路由表。
    ///
    /// - source 重复 → Err（同一 platform_key 只允许一条绑定）
    /// - 未知字段忽略（serde 默认行为）
    /// - 缺 `gateway` 段 / `routes` 为空 → 空表
    #[allow(dead_code)]
    pub fn from_yaml_str(input: &str) -> Result<Self, String> {
        let config: GatewayConfigFile = serde_yaml::from_str(input)
            .map_err(|e| format!("gateway 配置解析失败: {e}"))?;
        let routes = config.gateway.map(|g| g.routes).unwrap_or_default();
        let mut entries = Vec::with_capacity(routes.len());
        let mut seen = HashSet::with_capacity(routes.len());
        for route in routes {
            if !seen.insert(route.source.clone()) {
                return Err(format!("重复的 source 路由: {}", route.source));
            }
            entries.push(route);
        }
        Ok(Self { entries })
    }

    /// 构造空路由表（无任何绑定）。
    #[allow(dead_code)]
    pub fn empty() -> Self {
        Self { entries: Vec::new() }
    }

    /// 按 source 精确查询绑定；未命中返回 None（由调用方回退默认绑定）。
    #[allow(dead_code)]
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

    #[test]
    fn parses_valid_yaml_and_lookup_hits() {
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
    - source: qq:user:456
      agent: hermes
      profile: default
      session: dm
"#;
        let table = EntityRouteTable::from_yaml_str(yaml).expect("合法配置应解析成功");
        let hit = table.lookup("qq:group:123").expect("应命中 qq:group:123");
        assert_eq!(hit.source, "qq:group:123");
        assert_eq!(hit.agent_id, "peri");
        assert_eq!(hit.profile_id, "trpg");
        assert_eq!(hit.session_key, "战役1");
        let hit2 = table.lookup("qq:user:456").expect("应命中 qq:user:456");
        assert_eq!(hit2.agent_id, "hermes");
        assert_eq!(hit2.profile_id, "default");
        assert_eq!(hit2.session_key, "dm");
    }

    #[test]
    fn duplicate_source_rejected() {
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
    - source: qq:group:123
      agent: hermes
      profile: default
      session: 其他
"#;
        let err = EntityRouteTable::from_yaml_str(yaml).expect_err("重复 source 应报错");
        assert!(err.contains("qq:group:123"), "错误信息应包含重复的 source，实际: {err}");
    }

    #[test]
    fn lookup_miss_returns_none() {
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#;
        let table = EntityRouteTable::from_yaml_str(yaml).expect("合法配置应解析成功");
        assert!(table.lookup("qq:user:999").is_none());
        assert!(table.lookup("wechat:group:1").is_none());
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
      extra_field: 未知字段
      enabled: true
  other_section:
    anything: 1
top_level_unknown: value
"#;
        let table = EntityRouteTable::from_yaml_str(yaml).expect("未知字段应被忽略");
        assert!(table.lookup("qq:group:123").is_some());
    }

    #[test]
    fn missing_gateway_section_yields_empty_table() {
        let table = EntityRouteTable::from_yaml_str("some_other: 1")
            .expect("无 gateway 段应得到空表");
        assert!(table.lookup("qq:group:123").is_none());
    }

    #[test]
    fn malformed_yaml_rejected() {
        let err = EntityRouteTable::from_yaml_str("gateway: [unclosed").expect_err("非法 yaml 应报错");
        assert!(!err.is_empty());
    }

    #[test]
    fn missing_required_field_rejected() {
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      profile: trpg
      session: 战役1
"#;
        assert!(
            EntityRouteTable::from_yaml_str(yaml).is_err(),
            "缺 agent 字段应解析失败"
        );
    }
}
