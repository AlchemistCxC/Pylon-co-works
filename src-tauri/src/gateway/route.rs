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

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::gateway::instance::InstanceStatus;

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
    /// 引用 adapter instance id（I12-A-BE-01 契约冻结；D-01：route 以稳定
    /// instanceId 绑定实例）。缺省 None = 未绑定实例（旧配置兼容）。
    /// yaml 键 `instance`，wire 键 `instanceId`（手写 Serialize 输出）。
    #[serde(default, rename = "instance")]
    pub instance_id: Option<String>,
    /// 成员白名单（群消息按 member_openid，私聊按 user_openid）；缺省 = 不限。
    #[serde(default)]
    pub allow_from: Option<Vec<String>>,
    /// 会话重置策略：idle | daily | off；缺省 idle。
    #[serde(default)]
    pub reset: Option<String>,
    /// idle 模式无活动阈值（分钟）；缺省 1440（1 天）。
    #[serde(default)]
    pub idle_minutes: Option<u64>,
    /// 段内未知字段（配置拼错可见，parse_config 告警；不参与序列化——
    /// 手写 Serialize impl 不输出本字段）。
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

// B4：手写 Serialize——gateway_status wire 契约（camelCase 键）。不依赖
// rename_all（其宽松字段匹配会破坏 flatten 拼错键收集，实测 S4 测试失败）；
// 字段增删时本 impl 编译期强制同步（引用已删字段即编译错误）。
impl Serialize for EntityBinding {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = serializer.serialize_struct("EntityBinding", 8)?;
        st.serialize_field("source", &self.source)?;
        st.serialize_field("agentId", &self.agent_id)?;
        st.serialize_field("profileId", &self.profile_id)?;
        st.serialize_field("sessionKey", &self.session_key)?;
        st.serialize_field("instanceId", &self.instance_id)?;
        st.serialize_field("allowFrom", &self.allow_from)?;
        st.serialize_field("reset", &self.reset)?;
        st.serialize_field("idleMinutes", &self.idle_minutes)?;
        st.end()
    }
}

/// 未绑定消息策略（I12 W9，LR2-WI04）：无 binding 的消息如何处理。
/// `active-agent`（缺省，保持现状）：回退 active agent；`reject`：拒绝，不可进入 agent。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnboundPolicy {
    ActiveAgent,
    Reject,
}

impl UnboundPolicy {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            UnboundPolicy::ActiveAgent => "active-agent",
            UnboundPolicy::Reject => "reject",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "active-agent" => Some(UnboundPolicy::ActiveAgent),
            "reject" => Some(UnboundPolicy::Reject),
            _ => None,
        }
    }
}

/// QQ 平台网关配置（B10.3：群级白名单 + §3-7：max_message_len 参数外置）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct QqGatewayConfig {
    /// 群级白名单：列出的 group_openid 才允许 ingest；None = 不限。
    #[serde(default)]
    pub group_allow_from: Option<Vec<String>>,
    /// 单条文本上限（字符，deliver 分段依据）；None = 默认 QQ_MAX_MESSAGE_LEN(4000)。
    /// 取值校验（E16）：必须 ≥ 1（0/负值会让 truncate 预算退化硬切）。
    #[serde(default)]
    pub max_message_len: Option<usize>,
    /// 段内未知字段（配置拼错可见，parse_config 告警）。
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

/// B11 注入钩子配置（gateway.inject 段）。
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct InjectConfig {
    /// 注入开关。默认 true：Prism 不可用/请求失败时自动降级为不注入（不阻塞消息）。
    #[serde(default = "default_inject_enabled")]
    pub enabled: bool,
    /// 注入场景（Prism scenario 名）；None = 让 Prism 用 active.scenario。
    #[serde(default)]
    pub scenario: Option<String>,
    /// 注入知识源列表；空 = 让 Prism 用 active.sources。
    #[serde(default)]
    pub sources: Vec<String>,
    /// 完成持久化模式："skip"（默认，不持久化）| "prism"（POST /persist）。
    #[serde(default = "default_persist_mode")]
    pub persist: String,
    /// 段内未知字段（配置拼错可见，parse_config 告警；§3-6 补全）。
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

impl Default for InjectConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            scenario: None,
            sources: Vec::new(),
            persist: "skip".to_string(),
            extra: HashMap::new(),
        }
    }
}

/// 完整 gateway 配置：路由表 + 平台配置 + 注入配置 + 未绑定消息策略。
#[derive(Debug, Clone)]
pub struct GatewayConfig {
    pub routes: EntityRouteTable,
    pub qq: QqGatewayConfig,
    pub inject: InjectConfig,
    /// 未绑定消息策略（I12 W9）：缺省 active-agent（保持现状）；reject 拒绝未绑定消息。
    pub unbound_policy: UnboundPolicy,
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
            unbound_policy: UnboundPolicy::ActiveAgent,
        }
    }
}

/// gateway 配置文件的顶层结构（未知字段收集后告警）。
#[derive(Debug, Deserialize)]
struct GatewayConfigFile {
    /// 缺 `gateway` 段视为空表（容忍配置文件尚未包含本段）。
    gateway: Option<GatewaySection>,
    /// 未知顶层字段（配置拼错可见）。
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

/// `gateway` 段结构。
#[derive(Debug, Default, Deserialize)]
struct GatewaySection {
    /// 缺 `routes` 键视为空列表。
    #[serde(default)]
    routes: Vec<EntityBinding>,
    /// 缺 `qq` 段视为默认（无群级白名单）。
    #[serde(default)]
    qq: Option<QqGatewayConfig>,
    /// 缺 `inject` 段视为默认（enabled=true, persist=skip）。
    #[serde(default)]
    inject: Option<InjectConfig>,
    /// 缺省 `unbound_policy` 视为 active-agent（保持现状；reject 需显式配置）。
    #[serde(default)]
    unbound_policy: Option<String>,
    /// 段内未知字段（gateway.* 顶层拼错可见，parse_config 告警；§3-6 补全——
    /// 此前 gateway.* 未知键静默丢弃，与顶层文件告警行为不一致）。
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

fn default_inject_enabled() -> bool {
    true
}

fn default_persist_mode() -> String {
    "skip".to_string()
}

/// 解析完整 gateway 配置（路由表 + 平台配置 + 注入配置）。
pub fn parse_config(input: &str) -> Result<GatewayConfig, String> {
    let config: GatewayConfigFile =
        serde_yml::from_str(input).map_err(|e| format!("gateway 配置解析失败: {e}"))?;
    // agents.yaml 顶层合法字段：agents（agent 域）、tool_dictionary（工具字典）、
    // gateway（本域）。其余字段才视为拼错告警。
    let known_top_level = ["agents", "tool_dictionary"];
    let unknown: Vec<&String> = config
        .extra
        .keys()
        .filter(|key| !known_top_level.contains(&key.as_str()))
        .collect();
    if !unknown.is_empty() {
        let mut keys = unknown;
        keys.sort();
        tracing::warn!("gateway 配置含未知顶层字段（可能拼错）: {keys:?}");
    }
    let section = config.gateway.unwrap_or_default();
    // §3-6：gateway 段级未知键告警（对齐顶层文件/route/qq 段的收集告警语义）。
    if !section.extra.is_empty() {
        let mut keys: Vec<&String> = section.extra.keys().collect();
        keys.sort();
        tracing::warn!("gateway 段含未知字段（可能拼错）: {keys:?}");
    }
    let routes = section.routes;
    let mut entries = Vec::with_capacity(routes.len());
    let mut seen = HashSet::with_capacity(routes.len());
    for mut route in routes {
        let source = route.source.trim().to_string();
        if source.is_empty() {
            return Err("route source 不能为空".to_string());
        }
        if !route.extra.is_empty() {
            let mut keys: Vec<&String> = route.extra.keys().collect();
            keys.sort();
            tracing::warn!(
                "route {source} 含未知字段（可能拼错，白名单等安全控件可能静默失效）: {keys:?}"
            );
        }
        if !seen.insert(source.clone()) {
            return Err(format!("重复的 source 路由: {source}"));
        }
        if let Some(ref reset) = route.reset {
            if !matches!(reset.as_str(), "idle" | "daily" | "off") {
                return Err(format!(
                    "route {source} 的 reset 非法: {reset}（可选 idle/daily/off）"
                ));
            }
        }
        route.source = source;
        route.allow_from = route.allow_from.filter(|v| !v.is_empty());
        entries.push(route);
    }
    let qq = match section.qq {
        Some(mut q) => {
            if !q.extra.is_empty() {
                let mut keys: Vec<&String> = q.extra.keys().collect();
                keys.sort();
                tracing::warn!("gateway.qq 段含未知字段（可能拼错）: {keys:?}");
            }
            // E16：max_message_len 取值校验——0/负值（usize 只可能为 0）会让
            // truncate 预算退化为硬切（max_length/2），明确拒绝并指明配置键。
            if let Some(len) = q.max_message_len {
                if len < 1 {
                    return Err(format!(
                        "gateway.qq.max_message_len 非法: {len}（必须 ≥ 1，建议 ≥ 100）"
                    ));
                }
            }
            q.group_allow_from = q.group_allow_from.filter(|v| !v.is_empty());
            q
        }
        None => QqGatewayConfig::default(),
    };
    let inject = match section.inject {
        Some(mut inject) => {
            // §3-6：gateway.inject 段未知键告警（此前静默丢弃，与 qq 段行为不一致）。
            if !inject.extra.is_empty() {
                let mut keys: Vec<&String> = inject.extra.keys().collect();
                keys.sort();
                tracing::warn!("gateway.inject 段含未知字段（可能拼错）: {keys:?}");
            }
            if !matches!(inject.persist.as_str(), "skip" | "prism") {
                return Err(format!(
                    "gateway.inject.persist 未知模式: {}",
                    inject.persist
                ));
            }
            if let Some(ref scenario) = inject.scenario {
                if scenario.trim().is_empty() {
                    return Err("gateway.inject.scenario 不能为空".to_string());
                }
            }
            inject.scenario = inject.scenario.map(|s| s.trim().to_string());
            inject.sources = inject
                .sources
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            inject
        }
        None => InjectConfig::default(),
    };
    let index = entries
        .iter()
        .enumerate()
        .map(|(i, e)| (e.source.clone(), i))
        .collect();
    // I12 W9：unbound_policy 校验——非法值必须显式报错（安全控件拼错不得静默回退，
    // 否则管理员以为 reject 生效实则仍回退 active agent）。
    let unbound_policy = match section.unbound_policy.as_deref() {
        None => UnboundPolicy::ActiveAgent,
        Some(value) => UnboundPolicy::parse(value).ok_or_else(|| {
            format!("gateway.unbound_policy 非法: {value}（可选 active-agent/reject）")
        })?,
    };
    Ok(GatewayConfig {
        routes: EntityRouteTable { entries, index },
        qq,
        inject,
        unbound_policy,
    })
}

/// 静态绑定路由表。
#[derive(Debug, Clone)]
pub struct EntityRouteTable {
    entries: Vec<EntityBinding>,
    /// source → entries 下标索引（lookup O(1)）。
    index: HashMap<String, usize>,
}

impl EntityRouteTable {
    /// 构造空路由表（无任何绑定）。
    pub fn empty() -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::new(),
        }
    }

    /// 按 source 精确查询绑定；未命中返回 None（由调用方回退默认绑定）。
    pub fn lookup(&self, source: &str) -> Option<&EntityBinding> {
        self.index.get(source).and_then(|&i| self.entries.get(i))
    }

    /// 遍历全部绑定（gateway_status 展示 / 热重载快照用）。
    pub fn iter(&self) -> impl Iterator<Item = &EntityBinding> {
        self.entries.iter()
    }
}

/// Route 解析状态（I12-A-BE-01 契约冻结；D-04：实例删除后 route 保留并
/// disabled，不级联删除）。上游按本状态决定 ingest/deliver 是否放行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // 解析状态由诊断/前端展示消费
pub enum RouteResolveStatus {
    /// 实例存在且已连接 → 可 ingest/deliver。
    Active,
    /// binding 未引用实例（instance_id = None，旧配置）——按 legacy 行为处理。
    Unbound,
    /// 引用的实例不存在（已删除/未创建）→ disabled，明确显示"适配器实例不存在"。
    InstanceMissing,
    /// 实例存在但未连接（stopped/starting/error）→ 不可 ingest/deliver。
    InstanceNotConnected,
}

/// 冻结 route→instance 解析：给定 binding 与"按 instance id 查实例状态"的闭包，
/// 返回 route 可用性。纯函数（无锁、无状态）——BE-02 生命周期接入真实实例
/// 注册表后沿用本契约。
///
/// 语义（D-04）：引用的实例不存在 → InstanceMissing（route 保留 + disabled）；
/// 实例存在但未连接 → InstanceNotConnected；未引用实例 → Unbound（legacy 兼容）。
#[allow(dead_code)] // 诊断辅助（前端状态展示）
pub fn resolve_route_status(
    binding: &EntityBinding,
    instance_status: impl FnOnce(&str) -> Option<InstanceStatus>,
) -> RouteResolveStatus {
    let Some(instance_id) = binding.instance_id.as_deref() else {
        return RouteResolveStatus::Unbound;
    };
    match instance_status(instance_id) {
        Some(InstanceStatus::Connected) => RouteResolveStatus::Active,
        Some(_) => RouteResolveStatus::InstanceNotConnected,
        None => RouteResolveStatus::InstanceMissing,
    }
}

/// I12-W4/W9：ingest 路由目标拒绝原因（禁 fallback——来源实例不可用时不静默回退 active agent）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IngestReject {
    /// route 引用的实例不存在（已删除/未创建）。
    InstanceMissing,
    /// 实例存在但未连接（stopped/starting/error）。
    InstanceNotConnected,
    /// 未绑定消息且 unbound_policy=reject（I12 W9）：显式拒绝，不进入 agent。
    UnboundRejected,
}

/// I12-W4/W9：ingest 路由目标解析（禁 fallback 的**决策**纯函数，ingest handler 使用）：
/// - 无 binding → 依 unbound_policy：active-agent 回退 active agent（legacy 行为）；
///   reject → Err（显式拒绝，不进入 agent）；
/// - binding 引用实例（instance_id = Some）→ 仅 Connected 放行；Missing/NotConnected
///   → Err（显式拒绝，**不** fallback 到 active agent，避免错位回复）；
/// - binding 未引用实例（Unbound，旧配置）→ 保持旧行为（取 binding.agent_id，空则由
///   调用方空检处理）。
///
/// instance_status 为调用方已取得的实例状态快照（status_of().await 后传入）——
/// 本函数无锁无 IO，便于单元级直接覆盖正反用例。
pub fn resolve_ingest_agent(
    binding: Option<&EntityBinding>,
    instance_status: Option<InstanceStatus>,
    active_agent: &str,
    unbound_policy: UnboundPolicy,
) -> Result<String, IngestReject> {
    let Some(binding) = binding else {
        if unbound_policy == UnboundPolicy::Reject {
            return Err(IngestReject::UnboundRejected);
        }
        return Ok(active_agent.to_string());
    };
    if binding.instance_id.is_some() {
        match instance_status {
            Some(InstanceStatus::Connected) => Ok(binding.agent_id.clone()),
            Some(_) => Err(IngestReject::InstanceNotConnected),
            None => Err(IngestReject::InstanceMissing),
        }
    } else {
        Ok(binding.agent_id.clone())
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
        assert!(
            err.contains("qq:group:123"),
            "错误信息应包含重复的 source，实际: {err}"
        );
    }

    #[test]
    fn whitespace_variant_source_deduplicated_after_trim() {
        let yaml = r#"
gateway:
  routes:
    - source: " qq:group:1 "
      agent: peri
      profile: trpg
      session: 战役1
    - source: "qq:group:1"
      agent: hermes
      profile: default
      session: 其他
"#;
        let err = parse_config(yaml).expect_err("trim 后重复的 source 应报错");
        assert!(
            err.contains("qq:group:1"),
            "错误信息应包含重复的 source，实际: {err}"
        );
    }

    #[test]
    fn source_stored_trimmed() {
        let yaml = r#"
gateway:
  routes:
    - source: "  qq:group:1  "
      agent: peri
      profile: trpg
      session: 战役1
"#;
        let table = parse_config(yaml).expect("含空白 source 应解析成功").routes;
        let hit = table.lookup("qq:group:1").expect("trim 后应命中");
        assert_eq!(hit.source, "qq:group:1");
    }

    #[test]
    fn empty_source_rejected() {
        let yaml = r#"
gateway:
  routes:
    - source: "   "
      agent: peri
      profile: trpg
      session: 战役1
"#;
        assert!(parse_config(yaml).is_err(), "空白 source 应报错");
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
    fn allow_from_typo_collected_instead_of_silently_dropped() {
        let yaml = r#"
gateway:
  qq:
    groupAllowFrom: [group-a]
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
      allowFrom: [member-1]
"#;
        let config = parse_config(yaml).expect("拼错的字段名应解析成功（未知字段被收集告警）");
        let binding = config.routes.lookup("qq:group:123").expect("路由应命中");
        assert!(
            binding.allow_from.is_none(),
            "allowFrom 拼错不应生效，白名单应保持 None（缺省不限）"
        );
        assert_eq!(
            binding.extra.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["allowFrom"]
        );
        assert_eq!(
            config
                .qq
                .extra
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["groupAllowFrom"]
        );
    }

    #[test]
    fn gateway_section_and_inject_unknown_keys_are_collected() {
        // §3-6：gateway.* 段级未知键与 gateway.inject.* 未知键从"静默丢弃"改为
        // 收集进 extra（parse_config 告警依据）——拼错不再无声失效（白名单类
        // 安全控件静默失效的隐患同源）。
        let yaml = r#"
gateway:
  unknown_section_key: 1
  inject:
    enabled: true
    typoInjectKey: [a]
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#;
        let config = parse_config(yaml).expect("未知键应解析成功（收集告警不拒绝）");
        assert_eq!(
            config
                .inject
                .extra
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["typoInjectKey"],
            "gateway.inject 未知键必须收集进 extra"
        );
        let file: GatewayConfigFile = serde_yml::from_str(yaml).expect("deserialize");
        let section = file.gateway.expect("gateway 段存在");
        assert_eq!(
            section.extra.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["unknown_section_key"],
            "gateway 段级未知键必须收集进 extra"
        );
        // 已知键不得误入 extra
        assert!(!config.inject.extra.contains_key("enabled"));
        assert!(!section.extra.contains_key("routes"));
        assert!(!section.extra.contains_key("inject"));
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
        assert!(parse_config(yaml).is_err(), "缺 agent 字段应解析失败");
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
        assert_eq!(
            config.qq.group_allow_from.as_deref(),
            Some(&["group-a".to_string(), "group-b".to_string()][..])
        );
        let group = config.routes.lookup("qq:group:123").expect("群路由应命中");
        assert_eq!(group.agent_id, "peri");
        assert_eq!(
            group.allow_from.as_deref(),
            Some(&["member-1".to_string(), "member-2".to_string()][..])
        );
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
        assert_eq!(
            config.inject.sources.as_slice(),
            &["vein".to_string(), "shared".to_string()][..]
        );
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
        assert!(
            error.contains("persist"),
            "错误信息应指明 persist，实际: {error}"
        );
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

    #[test]
    fn qq_max_message_len_defaults_to_none_and_parses_configured() {
        // §3-7：gateway.qq.max_message_len 参数外置——缺省 None（适配器回退 4000），
        // 配置后原样保留。
        let missing = parse_config("some_other: 1").expect("无 gateway 段应解析成功");
        assert_eq!(
            missing.qq.max_message_len, None,
            "缺省 max_message_len 必须为 None（适配器回退 QQ_MAX_MESSAGE_LEN）"
        );
        let yaml = r#"
gateway:
  qq:
    group_allow_from: [group-a]
    max_message_len: 2000
"#;
        let config = parse_config(yaml).expect("合法 max_message_len 应解析成功");
        assert_eq!(config.qq.max_message_len, Some(2000));
        assert_eq!(
            config.qq.group_allow_from.as_deref(),
            Some(&["group-a".to_string()][..])
        );
    }

    #[test]
    fn qq_max_message_len_rejects_zero() {
        // E16：max_message_len=0 → truncate 预算退化硬切（max_length/2），必须拒绝
        // 并指明 gateway.qq.max_message_len（与 route reset 校验同款错误文案风格）。
        let yaml = r#"
gateway:
  qq:
    max_message_len: 0
"#;
        let error = parse_config(yaml).expect_err("max_message_len=0 必须拒绝");
        assert!(
            error.contains("gateway.qq.max_message_len"),
            "错误信息必须指明配置键，实际: {error}"
        );
    }

    #[test]
    fn invalid_reset_value_rejected() {
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
      reset: never
"#;
        let err = parse_config(yaml).expect_err("非法 reset 应报错");
        assert!(err.contains("reset"), "错误信息应指明 reset，实际: {err}");
        assert!(err.contains("never"), "错误信息应包含非法值，实际: {err}");
    }

    #[test]
    fn all_reset_values_accepted() {
        for value in ["idle", "daily", "off"] {
            let yaml = format!(
                r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
      reset: {value}
"#
            );
            let config = parse_config(&yaml).expect("合法 reset 应解析成功");
            let binding = config.routes.lookup("qq:group:123").expect("路由应命中");
            assert_eq!(binding.reset.as_deref(), Some(value));
        }
    }

    #[test]
    fn binding_serializes_with_camel_case_wire_contract() {
        // B4：gateway_status wire 契约钉死（手写 Serialize impl 的字段/键集合）。
        // I12-A-BE-01：契约含 instanceId 引用（D-01 route 以 instanceId 绑定实例）。
        let binding = EntityBinding {
            source: "qq:group:1".into(),
            agent_id: "peri".into(),
            profile_id: "trpg".into(),
            session_key: "战役1".into(),
            instance_id: None,
            allow_from: Some(vec!["member-1".into()]),
            reset: Some("daily".into()),
            idle_minutes: Some(60),
            extra: HashMap::from([("typoKey".into(), serde_json::json!(1))]),
        };
        let value = serde_json::to_value(&binding).expect("serialize");
        assert_eq!(
            value,
            serde_json::json!({
                "source": "qq:group:1",
                "agentId": "peri",
                "profileId": "trpg",
                "sessionKey": "战役1",
                "instanceId": null,
                "allowFrom": ["member-1"],
                "reset": "daily",
                "idleMinutes": 60,
            }),
            "gateway_status wire 形状（extra 不得输出）: {value}"
        );
    }

    #[test]
    fn binding_with_instance_reference_serializes_instance_id() {
        // I12-A-BE-01：route 引用 adapter instance id → wire 键 instanceId
        let binding = EntityBinding {
            source: "qq:group:1".into(),
            agent_id: "peri".into(),
            profile_id: "trpg".into(),
            session_key: "战役1".into(),
            instance_id: Some("qq-bot-1".into()),
            allow_from: None,
            reset: None,
            idle_minutes: None,
            extra: HashMap::new(),
        };
        let value = serde_json::to_value(&binding).expect("serialize");
        assert_eq!(
            value["instanceId"], "qq-bot-1",
            "route 必须序列化 instanceId 引用: {value}"
        );
    }

    #[test]
    fn camel_case_write_back_keys_rejected_not_silently_dropped() {
        // ISSUE-12 W6（LR2-WI01）严格契约：前端写回必须使用 yaml 键
        // agent/profile/session/instance/allow_from/reset/idle_minutes。
        // wire camelCase 键（agentId/profileId/sessionKey/instanceId）会被 flatten
        // 收集进 extra 并因缺必填 agent/profile/session 报错——不得静默落盘损坏配置。
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agentId: peri
      profileId: trpg
      sessionKey: 战役1
      instanceId: qq-bot-1
"#;
        let err = parse_config(yaml).expect_err("camelCase 写回键必须被拒绝");
        assert!(
            err.contains("agent"),
            "错误必须指明缺必填字段 agent（profile/session 同理），实际: {err}"
        );
    }

    #[test]
    fn yaml_key_round_trip_preserves_instance_and_full_fields() {
        // LR2-WI01：yaml 键写回 → parse_config 再读回，instance 与全部可选字段
        // 完整保留（这是前端 gatewayRouteToConfigEntry 适配器对齐的落盘契约）。
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
      instance: qq-bot-1
      allow_from: [member-1, member-2]
      reset: daily
      idle_minutes: 60
"#;
        let config = parse_config(yaml).expect("yaml 键写回应解析成功");
        let binding = config.routes.lookup("qq:group:123").expect("路由应命中");
        assert_eq!(binding.agent_id, "peri");
        assert_eq!(binding.profile_id, "trpg");
        assert_eq!(binding.session_key, "战役1");
        assert_eq!(binding.instance_id.as_deref(), Some("qq-bot-1"));
        assert_eq!(
            binding.allow_from.as_deref(),
            Some(&["member-1".to_string(), "member-2".to_string()][..])
        );
        assert_eq!(binding.reset.as_deref(), Some("daily"));
        assert_eq!(binding.idle_minutes, Some(60));
        assert!(
            binding.extra.is_empty(),
            "yaml 键写回不得产生未知字段: {:?}",
            binding.extra.keys()
        );
    }

    #[test]
    fn route_instance_reference_parses_from_yaml_and_defaults_none() {
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      instance: qq-bot-1
      agent: peri
      profile: trpg
      session: 战役1
    - source: qq:user:456
      agent: hermes
      profile: default
      session: dm
"#;
        let config = parse_config(yaml).expect("含 instance 引用的配置应解析成功");
        let bound = config.routes.lookup("qq:group:123").expect("路由应命中");
        assert_eq!(
            bound.instance_id.as_deref(),
            Some("qq-bot-1"),
            "yaml instance → instance_id"
        );
        let legacy = config.routes.lookup("qq:user:456").expect("路由应命中");
        assert_eq!(
            legacy.instance_id, None,
            "缺 instance 的旧配置必须兼容（None）"
        );
    }

    #[test]
    fn route_resolution_separates_active_missing_and_not_connected() {
        use crate::gateway::instance::InstanceStatus;
        let binding = |instance_id: Option<&str>| EntityBinding {
            source: "qq:group:1".into(),
            agent_id: "peri".into(),
            profile_id: "trpg".into(),
            session_key: "战役1".into(),
            instance_id: instance_id.map(str::to_string),
            allow_from: None,
            reset: None,
            idle_minutes: None,
            extra: HashMap::new(),
        };
        let registry = |id: &str| match id {
            "qq-bot-online" => Some(InstanceStatus::Connected),
            "qq-bot-stopped" => Some(InstanceStatus::Stopped),
            "qq-bot-starting" => Some(InstanceStatus::Starting),
            "qq-bot-error" => Some(InstanceStatus::Error),
            _ => None,
        };
        assert_eq!(
            resolve_route_status(&binding(Some("qq-bot-online")), registry),
            RouteResolveStatus::Active,
            "实例已连接 → Active"
        );
        assert_eq!(
            resolve_route_status(&binding(Some("qq-bot-deleted")), registry),
            RouteResolveStatus::InstanceMissing,
            "D-04：实例不存在 → disabled（route 保留，不级联删除）"
        );
        for id in ["qq-bot-stopped", "qq-bot-starting", "qq-bot-error"] {
            assert_eq!(
                resolve_route_status(&binding(Some(id)), registry),
                RouteResolveStatus::InstanceNotConnected,
                "{id} 未连接必须返回 InstanceNotConnected"
            );
        }
        assert_eq!(
            resolve_route_status(&binding(None), registry),
            RouteResolveStatus::Unbound,
            "未引用实例 → Unbound（legacy 兼容）"
        );
    }

    // ── I12-W4：ingest 目标解析（禁 fallback 决策）正反用例 ──

    fn binding_with_agent(instance: Option<&str>, agent: &str) -> EntityBinding {
        EntityBinding {
            source: "qq:group:1".into(),
            agent_id: agent.into(),
            profile_id: String::new(),
            session_key: String::new(),
            instance_id: instance.map(ToOwned::to_owned),
            allow_from: None,
            reset: None,
            idle_minutes: None,
            extra: HashMap::new(),
        }
    }

    #[test]
    fn ingest_agent_connected_instance_route_is_allowed() {
        let binding = binding_with_agent(Some("bot-a"), "peri");
        let target = resolve_ingest_agent(
            Some(&binding),
            Some(InstanceStatus::Connected),
            "active",
            UnboundPolicy::ActiveAgent,
        );
        assert_eq!(
            target,
            Ok("peri".to_string()),
            "实例已连接 → 路由到绑定 agent"
        );
    }

    #[test]
    fn ingest_agent_stopped_or_error_instance_route_rejected_no_fallback() {
        for status in [
            InstanceStatus::Stopped,
            InstanceStatus::Starting,
            InstanceStatus::Error,
        ] {
            let binding = binding_with_agent(Some("bot-a"), "peri");
            let target = resolve_ingest_agent(
                Some(&binding),
                Some(status),
                "active",
                UnboundPolicy::ActiveAgent,
            );
            assert_eq!(
                target,
                Err(IngestReject::InstanceNotConnected),
                "{status:?} → 显式拒绝且不 fallback 到 active agent"
            );
        }
    }

    #[test]
    fn ingest_agent_missing_instance_route_rejected_no_fallback() {
        let binding = binding_with_agent(Some("bot-ghost"), "peri");
        let target =
            resolve_ingest_agent(Some(&binding), None, "active", UnboundPolicy::ActiveAgent);
        assert_eq!(
            target,
            Err(IngestReject::InstanceMissing),
            "实例不存在 → 显式拒绝，不静默 fallback"
        );
    }

    #[test]
    fn ingest_agent_unbound_route_keeps_legacy_behavior() {
        // 未引用实例（legacy 配置）→ 取 binding.agent_id（旧行为；空由调用方空检）
        let binding = binding_with_agent(None, "peri");
        assert_eq!(
            resolve_ingest_agent(Some(&binding), None, "active", UnboundPolicy::ActiveAgent),
            Ok("peri".to_string())
        );
        let empty_agent = binding_with_agent(None, "");
        assert_eq!(
            resolve_ingest_agent(
                Some(&empty_agent),
                None,
                "active",
                UnboundPolicy::ActiveAgent
            ),
            Ok(String::new()),
            "Unbound 空 agent_id 保持旧语义（调用方空检）"
        );
    }

    #[test]
    fn ingest_agent_no_binding_falls_back_to_active_agent() {
        assert_eq!(
            resolve_ingest_agent(None, None, "active-agent", UnboundPolicy::ActiveAgent),
            Ok("active-agent".to_string())
        );
    }

    // ── I12 W9：unbound_policy（strict routing）正反用例 ──

    #[test]
    fn ingest_agent_reject_policy_blocks_unbound_message() {
        // reject 模式：无 binding 消息显式拒绝，不进入 agent（禁止 fallback）
        assert_eq!(
            resolve_ingest_agent(None, None, "active-agent", UnboundPolicy::Reject),
            Err(IngestReject::UnboundRejected),
            "reject 策略下未绑定消息必须拒绝"
        );
    }

    #[test]
    fn ingest_agent_reject_policy_does_not_affect_bound_routes() {
        // reject 只约束「无 binding」；bound route 行为不变
        let binding = binding_with_agent(Some("bot-a"), "peri");
        assert_eq!(
            resolve_ingest_agent(
                Some(&binding),
                Some(InstanceStatus::Connected),
                "active",
                UnboundPolicy::Reject
            ),
            Ok("peri".to_string())
        );
        let unbound_legacy = binding_with_agent(None, "peri");
        assert_eq!(
            resolve_ingest_agent(Some(&unbound_legacy), None, "active", UnboundPolicy::Reject),
            Ok("peri".to_string()),
            "legacy unbound route 仍按旧行为（取 binding.agent_id）"
        );
    }

    #[test]
    fn unbound_policy_parses_and_defaults() {
        let default = parse_config("some_other: 1").expect("无 gateway 段");
        assert_eq!(
            default.unbound_policy,
            UnboundPolicy::ActiveAgent,
            "缺省 active-agent（保持现状）"
        );
        let active = parse_config("gateway:\n  unbound_policy: active-agent\n").expect("parse");
        assert_eq!(active.unbound_policy, UnboundPolicy::ActiveAgent);
        let reject = parse_config("gateway:\n  unbound_policy: reject\n").expect("parse");
        assert_eq!(reject.unbound_policy, UnboundPolicy::Reject);
    }

    #[test]
    fn unbound_policy_rejects_invalid_value() {
        let err = parse_config("gateway:\n  unbound_policy: silent-fallback\n")
            .expect_err("非法策略必须报错");
        assert!(
            err.contains("unbound_policy"),
            "错误必须指明配置键，实际: {err}"
        );
    }

    #[test]
    fn empty_allow_from_is_unrestricted() {
        let yaml = r#"
gateway:
  qq:
    group_allow_from: []
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
      allow_from: []
"#;
        let config = parse_config(yaml).expect("空 allowlist 应解析成功");
        assert!(
            config.qq.group_allow_from.is_none(),
            "空 group_allow_from 应为 None（缺省不限）"
        );
        let binding = config.routes.lookup("qq:group:123").expect("路由应命中");
        assert!(
            binding.allow_from.is_none(),
            "空 allow_from 应为 None（缺省不限）"
        );
    }

    #[test]
    fn inject_trims_scenario_and_sources() {
        let yaml = r#"
gateway:
  inject:
    scenario: "  trpg  "
    sources: ["  vein ", "shared", "   ", ""]
"#;
        let config = parse_config(yaml).expect("含空白配置应解析成功");
        assert_eq!(config.inject.scenario.as_deref(), Some("trpg"));
        assert_eq!(
            config.inject.sources.as_slice(),
            &["vein".to_string(), "shared".to_string()][..]
        );
    }
}
