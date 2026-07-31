//! 平台静态绑定路由（BE-B10-001 + B10.3 扩展 + B11 注入配置）。
//!
//! 静态 EntityBinding 路由表：source（如 `qq:group:123`）→
//! { agent_id, profile_id, session_key, allow_from, reset, idle_minutes }。
//! 未匹配的 source 由调用方回退默认绑定。
//! 二期预留动态覆盖/指令切换接口（本文件只做静态配置解析与查询）。
//!
//! B11 注入钩子配置（gateway.inject 段）：send_prompt_core 发送前置调用
//! Prism /inject 拿 context 拼进 prompt；persist 控制完成后的回合持久化
//! （"skip" 不持久化 / "prism" 调 Prism /persist）。
//!
//! 纯数据层：不依赖 tauri/AppState，不读 env。配置结构：
//!
//! ```yaml
//! gateway:
//!   qq:
//!     group_allow_from: [group_openid_1]   # 可选：群级白名单（缺省=不限）
//!   inject:
//!     enabled: true                        # 可选：注入开关（默认 true，Prism 不可用自动降级）
//!     scenario: trpg                       # 可选：缺省让 Prism 用 active.scenario
//!     sources: [vein]                      # 可选：缺省让 Prism 用 active.sources
//!     persist: skip                        # 可选：skip | prism（默认 skip）
//!   routes:
//!     - source: qq:group:123
//!       agent: peri
//!       profile: trpg
//!       session: 战役1
//!       allow_from: [member_openid_1]      # 可选：群成员/私聊用户白名单
//!       reset: idle                        # 可选：idle | daily | off（默认 idle）
//!       idle_minutes: 1440                 # 可选：idle 模式阈值（默认 1440）
//! ```

use std::collections::HashSet;

use serde::Deserialize;

/// 平台绑定实体：source（平台路由 key）→ agent/profile/session 三元组 + 白名单 + 重置策略。
///
/// yaml 键名为 `agent`/`profile`/`session`（与 Prism/前端 Session 语义对齐），
/// Rust 侧统一为 `agent_id`/`profile_id`/`session_key` 命名。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EntityBinding {
    pub source: String,
    #[serde(rename = "agent")]
    pub agent_id: String,
    #[serde(rename = "profile")]
    pub profile_id: String,
    #[serde(rename = "session")]
    pub session_key: String,
    /// 成员白名单（群消息按 member_openid，私聊按 user_openid）；缺省 = 不限。
    #[serde(default)]
    pub allow_from: Option<Vec<String>>,
    /// 会话重置策略：idle | daily | off；缺省 idle。
    #[serde(default)]
    pub reset: Option<String>,
    /// idle 模式无活动阈值（分钟）；缺省 1440（1 天）。
    #[serde(default)]
    pub idle_minutes: Option<u64>,
}

/// QQ 平台网关配置（B10.3：群级白名单）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct QqGatewayConfig {
    /// 群级白名单：列出的 group_openid 才允许 ingest；None = 不限。
    pub group_allow_from: Option<Vec<String>>,
}

/// B11 注入钩子配置（gateway.inject 段）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectConfig {
    /// 注入开关。默认 true：Prism 不可用/请求失败时自动降级为不注入（不阻塞消息）。
    pub enabled: bool,
    /// 注入场景（Prism scenario 名）；None = 让 Prism 用 active.scenario。
    pub scenario: Option<String>,
    /// 注入知识源列表；空 = 让 Prism 用 active.sources。
    pub sources: Vec<String>,
    /// 完成持久化模式："skip"（默认，不持久化）| "prism"（POST /persist）。
    pub persist: String,
}

impl Default for InjectConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            scenario: None,
            sources: Vec::new(),
            persist: "skip".to_string(),
        }
    }
}

/// 完整 gateway 配置：路由表 + 平台配置 + 注入配置。
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub routes: EntityRouteTable,
    pub qq: QqGatewayConfig,
    pub inject: InjectConfig,
}

impl GatewayConfig {
    /// 从 yaml 解析（缺 gateway 段 → 空路由表 + 默认平台配置）。
    pub fn from_yaml_str(input: &str) -> Result<Self, String> {
        parse_config(input)
    }

    /// 空配置（无路由、无白名单、默认注入配置）。
    pub fn empty() -> Self {
        Self {
            routes: EntityRouteTable::empty(),
            qq: QqGatewayConfig::default(),
            inject: InjectConfig::default(),
        }
    }
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
    /// 缺 `qq` 段视为默认（无群级白名单）。
    #[serde(default)]
    qq: Option<QqSection>,
    /// 缺 `inject` 段视为默认（enabled=true, persist=skip）。
    #[serde(default)]
    inject: Option<InjectSection>,
}

/// `gateway.qq` 段结构。
#[derive(Debug, Deserialize)]
struct QqSection {
    /// 缺省 = 不限。
    #[serde(default)]
    group_allow_from: Option<Vec<String>>,
}

/// `gateway.inject` 段结构（B11）。
#[derive(Debug, Deserialize)]
struct InjectSection {
    /// 缺省 = true（Prism 不可用自动降级）。
    #[serde(default = "default_inject_enabled")]
    enabled: bool,
    #[serde(default)]
    scenario: Option<String>,
    #[serde(default)]
    sources: Vec<String>,
    /// 缺省 = "skip"。
    #[serde(default = "default_persist_mode")]
    persist: String,
}

fn default_inject_enabled() -> bool {
    true
}

fn default_persist_mode() -> String {
    "skip".to_string()
}

/// 解析完整 gateway 配置（路由表 + 平台配置 + 注入配置）。
pub fn parse_config(input: &str) -> Result<GatewayConfig, String> {
    let config: GatewayConfigFile = serde_yaml::from_str(input)
        .map_err(|e| format!("gateway 配置解析失败: {e}"))?;
    let section = config.gateway.unwrap_or(GatewaySection {
        routes: Vec::new(),
        qq: None,
        inject: None,
    });
    let routes = section.routes;
    let mut entries = Vec::with_capacity(routes.len());
    let mut seen = HashSet::with_capacity(routes.len());
    for route in routes {
        if !seen.insert(route.source.clone()) {
            return Err(format!("重复的 source 路由: {}", route.source));
        }
        entries.push(route);
    }
    let qq = section
        .qq
        .map(|q| QqGatewayConfig {
            group_allow_from: q.group_allow_from,
        })
        .unwrap_or_default();
    let inject = match section.inject {
        Some(section) => {
            if !matches!(section.persist.as_str(), "skip" | "prism") {
                return Err(format!("gateway.inject.persist 未知模式: {}", section.persist));
            }
            if let Some(ref scenario) = section.scenario {
                if scenario.trim().is_empty() {
                    return Err("gateway.inject.scenario 不能为空".to_string());
                }
            }
            InjectConfig {
                enabled: section.enabled,
                scenario: section.scenario,
                sources: section.sources,
                persist: section.persist,
            }
        }
        None => InjectConfig::default(),
    };
    Ok(GatewayConfig {
        routes: EntityRouteTable { entries },
        qq,
        inject,
    })
}

/// 静态绑定路由表。
#[derive(Debug, Clone)]
pub struct EntityRouteTable {
    entries: Vec<EntityBinding>,
}

impl EntityRouteTable {
    /// 构造空路由表（无任何绑定）。
    pub fn empty() -> Self {
        Self { entries: Vec::new() }
    }

    /// 按 source 精确查询绑定；未命中返回 None（由调用方回退默认绑定）。
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
        let table = parse_config(yaml).expect("合法配置应解析成功").routes;
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
        let err = parse_config(yaml).expect_err("重复 source 应报错");
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
        let table = parse_config(yaml).expect("合法配置应解析成功").routes;
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
        let table = parse_config(yaml).expect("未知字段应被忽略").routes;
        assert!(table.lookup("qq:group:123").is_some());
    }

    #[test]
    fn missing_gateway_section_yields_empty_table() {
        let table = parse_config("some_other: 1")
            .expect("无 gateway 段应得到空表")
            .routes;
        assert!(table.lookup("qq:group:123").is_none());
    }

    #[test]
    fn malformed_yaml_rejected() {
        let err = parse_config("gateway: [unclosed").expect_err("非法 yaml 应报错");
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
            parse_config(yaml).is_err(),
            "缺 agent 字段应解析失败"
        );
    }

    #[test]
    fn parses_allowlist_reset_and_qq_group_allowlist() {
        let yaml = r#"
gateway:
  qq:
    group_allow_from: [group-a, group-b]
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
      allow_from: [member-1, member-2]
      reset: daily
      idle_minutes: 60
    - source: qq:user:456
      agent: hermes
      profile: default
      session: dm
"#;
        let config = parse_config(yaml).expect("完整配置应解析成功");
        assert_eq!(config.qq.group_allow_from.as_deref(), Some(&["group-a".to_string(), "group-b".to_string()][..]));
        let group = config.routes.lookup("qq:group:123").expect("群路由应命中");
        assert_eq!(group.agent_id, "peri");
        assert_eq!(group.allow_from.as_deref(), Some(&["member-1".to_string(), "member-2".to_string()][..]));
        assert_eq!(group.reset.as_deref(), Some("daily"));
        assert_eq!(group.idle_minutes, Some(60));
        let c2c = config.routes.lookup("qq:user:456").expect("私聊路由应命中");
        assert!(c2c.allow_from.is_none(), "未配置白名单应为 None");
        assert!(c2c.reset.is_none());
    }

    #[test]
    fn inject_config_defaults_to_enabled_and_skip_persist() {
        let config = parse_config("some_other: 1").expect("无 gateway 段应得到默认注入配置");
        assert!(config.inject.enabled);
        assert_eq!(config.inject.persist, "skip");
        assert!(config.inject.scenario.is_none());
        assert!(config.inject.sources.is_empty());
    }

    #[test]
    fn inject_config_parses_full_section() {
        let yaml = r#"
gateway:
  inject:
    enabled: false
    scenario: trpg
    sources: [vein, shared]
    persist: prism
"#;
        let config = parse_config(yaml).expect("注入配置应解析成功");
        assert!(!config.inject.enabled);
        assert_eq!(config.inject.scenario.as_deref(), Some("trpg"));
        assert_eq!(config.inject.sources.as_slice(), &["vein".to_string(), "shared".to_string()][..]);
        assert_eq!(config.inject.persist, "prism");
    }

    #[test]
    fn inject_config_partial_section_keeps_defaults() {
        let yaml = r#"
gateway:
  inject:
    scenario: trpg
"#;
        let config = parse_config(yaml).expect("部分注入配置应解析成功");
        assert!(config.inject.enabled, "缺 enabled 应默认 true");
        assert_eq!(config.inject.persist, "skip", "缺 persist 应默认 skip");
        assert_eq!(config.inject.scenario.as_deref(), Some("trpg"));
    }

    #[test]
    fn inject_config_rejects_unknown_persist_mode() {
        let yaml = r#"
gateway:
  inject:
    persist: chronicle
"#;
        let error = parse_config(yaml).expect_err("未知 persist 模式应报错");
        assert!(error.contains("persist"), "错误信息应指明 persist，实际: {error}");
    }

    #[test]
    fn inject_config_rejects_empty_scenario() {
        let yaml = r#"
gateway:
  inject:
    scenario: ""
"#;
        assert!(parse_config(yaml).is_err(), "空 scenario 应报错");
    }
}
