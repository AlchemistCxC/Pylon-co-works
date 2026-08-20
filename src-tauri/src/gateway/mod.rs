//! Gateway：平台适配器层（B10）。
//!
//! 消息拓扑：平台(qq/微信/飞书/ins) → gateway → ACP → 本地 agent。
//! 信息脉络：agent ←ACP→ Pylon(gateway) → 平台。
//!
//! B10.1 骨架：PlatformAdapter trait + GatewayCore（适配器注册表、
//! 入站 ingest 路由解析、出站 deliver 分段分发）。B10.2 起逐个接入平台适配器。
//!
//! # 入站契约（E15 封闭，§3-4）
//!
//! 入站消息解析的唯一生产入口是适配器层的单快照路径（QQ 适配器
//! [`QqAdapter::handle_incoming`]）：在 **一次** [`GatewayCore::with_routes_and_qq`]
//! 读锁快照内完成白名单判定与 binding 提取，白名单拒绝/空文本不占去重窗口，
//! `msg_id` 由适配器填充，经 [`GatewayCore::dispatch_ingest`] 触发发送。
//! 公共解析入口 [`build_resolved`] 只做纯组装（无锁、无状态），供测试/其他
//! 适配器构造解析结果，**不得**用它在白名单之后二次读锁解析 binding——
//! reload 热重载窗口下"旧绑定放行 → 新绑定投递"的混搭即二次读锁 bug
//! （历史教训：`ingest()` 因此被删除，S5）。

pub mod catalog;
pub mod credentials;
pub mod instance;
pub mod instance_store;
pub mod qq;
pub mod route;
pub mod truncate;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};

use route::{GatewayConfig, QqGatewayConfig};

/// 平台适配器接口。
///
/// 出站（agent → 平台）：GatewayCore 把 agent 事件按文本/非文本分类后调用
/// [`Self::deliver_text`]（已按 [`Self::max_message_len`] 分段）或
/// [`Self::deliver_event`]。入站（平台 → agent）：平台连接层解析事件后调用
/// 适配器的入站入口（QQ 适配器经 handle_incoming 单快照去重+白名单后进入，
/// 见模块头入站契约——唯一入口，不得引入二次读锁路径）。
pub trait PlatformAdapter: Send + Sync {
    /// 平台标识（"qq"/"wechat"…），同时是 source 前缀（"qq:group:123"）。
    fn platform_key(&self) -> &str;
    /// 平台单条文本上限（字符数），deliver 分段的依据（QQ = 4000，Hermes 实证）。
    fn max_message_len(&self) -> usize;
    /// 向平台会话投递一段文本（已分段，未接线实现返回 Err 由调用方告警）。
    fn deliver_text(&self, source: &str, text: &str) -> Result<(), String>;
    /// 向平台会话投递非文本事件（pylon:done / pylon:error 等）。
    fn deliver_event(
        &self,
        source: &str,
        event: &str,
        payload: &serde_json::Value,
    ) -> Result<(), String>;
    /// 入站去重回滚（C14）：ingest 发送失败后撤销平台侧 seen 标记，resume 重放
    /// 可重新 ingest（防故障期消息永久丢失）。默认空实现——无需去重的平台不关心。
    fn rollback_seen(&self, _msg_id: &str) {}
}

/// 入站消息解析结果：平台消息 → 路由绑定（B10.3 消费：会话生命周期 + ACP 发送）。
#[derive(Debug, Clone)]
pub struct ResolvedIngest {
    pub source: String,
    pub content: String,
    /// 静态绑定命中；未配置实体时为 None（回退默认绑定 = active agent）。
    pub binding: Option<route::EntityBinding>,
    /// 平台消息去重 id（C14：ingest 发送失败经 [`PlatformAdapter::rollback_seen`]
    /// 回滚去重窗口用）。`build_resolved` 构造为 None；适配器层 handle_incoming 组装时填充。
    pub msg_id: Option<String>,
}

/// 入站消息字符上限：超长截断再进 prompt（防超长消息打爆 agent 输入）。
pub const MAX_INGEST_CHARS: usize = 64 * 1024;

/// 入站文本超长截断（S5 修复：build_resolved 与 handle_incoming 共用同一上限与实现，
/// 避免适配器单快照路径与纯组装入口的截断行为漂移）。
pub(crate) fn truncate_ingest_content(content: &str) -> String {
    content.chars().take(MAX_INGEST_CHARS).collect()
}

/// 入站解析结果纯组装（§3-4，替代已删除的 `GatewayCore::ingest`）：非空 source
/// 校验 + 超长截断 + 组装。纯函数——无锁、无状态、不查询配置、不触发发送。
///
/// binding 由调用方在**单快照**内取得后传入（白名单判定与 binding 提取必须出自
/// 同一配置快照，见模块头入站契约/E15）；本函数绝不自行二次读锁。
pub(crate) fn build_resolved(
    source: &str,
    content: &str,
    binding: Option<route::EntityBinding>,
) -> Result<ResolvedIngest, String> {
    if source.trim().is_empty() {
        return Err("ingest requires a non-empty source".to_string());
    }
    let content = truncate_ingest_content(content);
    Ok(ResolvedIngest {
        source: source.to_string(),
        content,
        binding,
        // C14：纯组装层不知道平台 msg_id，由适配器层 handle_incoming 组装时填充
        msg_id: None,
    })
}

/// ingest 发送处理器：解析结果 → ACP 发送（B10.3 由 lib.rs 注册，
/// 按 binding.agent_id 路由到对应 runtime，未绑定回退 active agent）。
pub type IngestHandler = Arc<dyn Fn(&ResolvedIngest) + Send + Sync>;

/// Gateway 领域错误（R7/P2-1 补全）。code() 稳定供前端分支。
/// InvalidConfig/AdapterUnavailable/DeliveryFailed 为后续迁移预留（生命周期/
/// 投递路径逐步改 Result<_, GatewayError>），当前仅 ConfigLockPoisoned 被构造。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[allow(dead_code)]
pub enum GatewayError {
    /// reload 写锁中毒（reload 未生效，保持原配置）。
    #[error("gateway 配置锁中毒（reload 未生效，保持原配置）")]
    ConfigLockPoisoned,
    /// 配置解析/校验失败。
    #[error("gateway 配置非法: {0}")]
    InvalidConfig(String),
    /// 适配器不可用（未注册/已下线）。
    #[error("gateway 适配器不可用: {0}")]
    AdapterUnavailable(String),
    /// 出站投递失败。
    #[error("gateway 投递失败: {0}")]
    DeliveryFailed(String),
    /// 引用的 adapter instance 不存在（I12-A-BE-01；D-04：route 保留 + disabled）。
    #[error("gateway adapter instance 不存在: {0}")]
    InstanceNotFound(String),
    /// 引用的 adapter instance 未连接（stopped/starting/error）。
    #[error("gateway adapter instance 未连接: {0}")]
    InstanceNotConnected(String),
}

impl GatewayError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ConfigLockPoisoned => "gateway_config_lock_poisoned",
            Self::InvalidConfig(_) => "gateway_invalid_config",
            Self::AdapterUnavailable(_) => "gateway_adapter_unavailable",
            Self::DeliveryFailed(_) => "gateway_delivery_failed",
            Self::InstanceNotFound(_) => "gateway_instance_not_found",
            Self::InstanceNotConnected(_) => "gateway_instance_not_connected",
        }
    }
}

/// Gateway 核心：适配器注册表 + 静态路由表 + 平台配置 + 入站解析 + 出站分发。
/// 配置段（routes/qq/inject）收进 RwLock——`reload()` 支持热重载（B10.5 预留，
/// reload_gateway 命令接线）。
pub struct GatewayCore {
    adapters: Mutex<HashMap<String, Arc<dyn PlatformAdapter>>>,
    config: RwLock<GatewayConfig>,
    ingest_handler: Mutex<Option<IngestHandler>>,
}

impl GatewayCore {
    /// 从 agents.yaml 的 `gateway` 段构建（缺段 → 空路由表 + 默认平台配置）。
    pub fn new() -> Self {
        let config = GatewayConfig::from_yaml_str(include_str!("../../../agents.yaml"))
            .unwrap_or_else(|error| {
                tracing::warn!("gateway 配置解析失败，使用空配置: {error}");
                GatewayConfig::empty()
            });
        Self::from_config(config)
    }

    /// 用显式配置构造（测试注入 / B10.3 热重载途径）。
    pub fn from_config(config: GatewayConfig) -> Self {
        Self {
            adapters: Mutex::new(HashMap::new()),
            config: RwLock::new(config),
            ingest_handler: Mutex::new(None),
        }
    }

    /// 热重载配置（reload_gateway 命令）：替换路由表/平台配置/注入配置。
    /// 已注册适配器不受影响（凭据/连接级配置仍启动生效）。
    /// R4（P1-2）：写锁失败（中毒）返回 Err——上层 command 必须向调用方如实
    /// 报告"reload 未生效"，不得继续返回成功。调用点仅 gateway_cmds.rs 与测试。
    pub fn reload(&self, config: GatewayConfig) -> Result<(), GatewayError> {
        let mut slot = self
            .config
            .write()
            .map_err(|_| GatewayError::ConfigLockPoisoned)?;
        *slot = config;
        tracing::info!("gateway 配置已热重载");
        Ok(())
    }

    /// 注册 ingest 发送处理器（run() 接线 ACP 发送；可重复注册覆盖）。
    pub fn set_ingest_handler(&self, handler: IngestHandler) {
        if let Ok(mut slot) = self.ingest_handler.lock() {
            *slot = Some(handler);
        }
    }

    /// QQ 群级白名单配置（QqAdapter 白名单检查用）。
    /// 热路径（handle_incoming 每消息）请用 [`Self::with_routes_and_qq`] 锁内读取，避免 clone。
    pub fn qq_config(&self) -> QqGatewayConfig {
        self.config.read().map(|c| c.qq.clone()).unwrap_or_default()
    }

    /// 未绑定消息策略（I12 W9）：ingest handler 在 resolve_ingest_agent 决策时使用。
    pub fn unbound_policy(&self) -> route::UnboundPolicy {
        self.config
            .read()
            .map(|c| c.unbound_policy)
            .unwrap_or(route::UnboundPolicy::ActiveAgent)
    }

    /// 单锁快照：一次读锁内取 QQ 配置 + source 路由绑定（O67 修复）。
    /// 白名单判定与绑定解析必须出自同一份配置快照——分两次读锁在 reload 热重载
    /// 窗口下可能混搭"新 qq 配置 + 旧路由表"（或反之），原子快照保证判定基于
    /// 同一版本配置。读锁中毒 → None（fail-closed，回退会放行所有群，必须拒绝）。
    pub(crate) fn with_routes_and_qq<R>(
        &self,
        source: &str,
        f: impl FnOnce(&QqGatewayConfig, Option<&route::EntityBinding>) -> R,
    ) -> Option<R> {
        self.config
            .read()
            .ok()
            .map(|guard| f(&guard.qq, guard.routes.lookup(source)))
    }

    /// B11 注入开关（Prism 可用性由调用方降级处理）。
    pub fn inject_enabled(&self) -> bool {
        self.config
            .read()
            .map(|c| c.inject.enabled)
            .unwrap_or(false)
    }

    /// B11 注入场景（None = 让 Prism 用 active.scenario）。
    pub fn inject_scenario(&self) -> Option<String> {
        self.config
            .read()
            .ok()
            .and_then(|c| c.inject.scenario.clone())
    }

    /// B11 注入知识源（空 = 让 Prism 用 active.sources）。
    /// 签名保持返回 Vec（lib.rs 调用方契约，禁止改签名）；clone 成本仅发生在
    /// inject/persist 回合，不在 handle_incoming 每消息热路径上。
    pub fn inject_sources(&self) -> Vec<String> {
        self.config
            .read()
            .map(|c| c.inject.sources.clone())
            .unwrap_or_default()
    }

    /// B11 完成持久化模式："skip" | "prism"。
    pub fn inject_persist(&self) -> String {
        self.config
            .read()
            .map(|c| c.inject.persist.clone())
            .unwrap_or_else(|_| "skip".to_string())
    }

    /// 按 source 查询绑定（会话生命周期 watcher 取 reset 策略用）。
    pub fn binding(&self, source: &str) -> Option<route::EntityBinding> {
        self.config
            .read()
            .ok()
            .and_then(|c| c.routes.lookup(source).cloned())
    }

    /// 全部路由绑定（gateway_status 命令展示用）。
    pub fn routes(&self) -> Vec<route::EntityBinding> {
        self.config
            .read()
            .map(|c| c.routes.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 按 platform_key 取已注册适配器（系统消息投递 / gateway_status 用）。
    pub fn adapter(&self, key: &str) -> Option<Arc<dyn PlatformAdapter>> {
        self.adapters.lock().ok().and_then(|a| a.get(key).cloned())
    }

    /// source 归属的平台 key（首段）。空 source/无冒号时返回空串。
    /// 全部"按 source 取适配器/判定平台源"的消费点统一走本辅助（§3-1 收敛 5 处
    /// `split(':')` 前缀匹配）。
    fn platform_key_of(source: &str) -> &str {
        source.split(':').next().unwrap_or("")
    }

    /// 按 source 前缀取已注册适配器（"qq:group:1" → "qq"）。
    /// 与 deliver_all 前缀语义完全一致——所有"按 source 取适配器"的消费点统一走这里。
    /// 未注册该 key 的适配器（含 GUI source）返回 None。
    pub fn adapter_for_source(&self, source: &str) -> Option<Arc<dyn PlatformAdapter>> {
        let key = Self::platform_key_of(source);
        if key.is_empty() {
            return None;
        }
        self.adapter(key)
    }

    /// 平台源判定：注册的适配器前缀命中 或 静态绑定命中。
    /// 语义与 check_session_expiry 现有闭包（session.rs:618-623）逐字一致——
    /// "有注册适配器 OR 有 binding"（与 deliver_all 出站白名单的前置条件等价，E14 封闭）。
    /// 注意：QQ 适配器未注册（无 PYLON_QQ_APP_ID 凭据启动）时，qq:* 源仅 binding
    /// 命中才返回 true；两者皆无 → false。若未来引入运行时注册（B10.5），需同步收严。
    /// 消费：session.rs（C1/C3/C4 GUI 冒名校验与平台判定）+ lib.rs（C5 回滚）。
    pub fn is_platform_source(&self, source: &str) -> bool {
        let prefix_hit = {
            let key = Self::platform_key_of(source);
            !key.is_empty()
                && self
                    .adapters
                    .lock()
                    .map(|a| a.contains_key(key))
                    .unwrap_or(false)
        };
        prefix_hit || self.binding(source).is_some()
    }

    /// 注册平台适配器；platform_key 重复 → Err。
    /// 由 lib.rs run()/命令接线注册（QQ 适配器启动注册，deliver_all 分发到平台）。
    pub fn register(&self, adapter: Arc<dyn PlatformAdapter>) -> Result<(), String> {
        let mut adapters = self
            .adapters
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if adapters.contains_key(adapter.platform_key()) {
            return Err(format!(
                "duplicate platform adapter: {}",
                adapter.platform_key()
            ));
        }
        adapters.insert(adapter.platform_key().to_string(), adapter);
        Ok(())
    }

    /// 已注册适配器的 platform_key 列表（会话生命周期 watcher 平台判定 / 测试用）。
    pub fn adapter_keys(&self) -> Vec<String> {
        self.adapters
            .lock()
            .map(|a| a.keys().cloned().collect())
            .unwrap_or_default()
    }

    /// 触发 ingest 发送（B10.3：按 binding 路由到 runtime，未绑定回退 active agent）。
    /// 由适配器在白名单/去重通过后调用。
    pub fn dispatch_ingest(&self, resolved: &ResolvedIngest) {
        if let Ok(handler) = self.ingest_handler.lock() {
            if let Some(handler) = handler.as_ref() {
                handler(resolved);
            }
        }
    }

    /// 出站分发：把 agent 事件投递给 source 前缀匹配的平台适配器。
    ///
    /// - pylon:update 的 agent_message_chunk → 提取文本 → 按适配器上限分段 →
    ///   逐段 deliver_text（truncate 分段管线，平台无关，在核心层完成）
    /// - 其他事件 → deliver_event
    ///   投递失败（含未接线适配器）只告警，不阻断 WebView 事件。
    pub fn deliver_all(&self, source: &str, event: &str, payload: &serde_json::Value) {
        // §3-1：适配器查找统一走 adapter_for_source（平台 key 前缀 + 单 Arc 克隆，
        // 替代 filter + collect Vec——GUI source 每次事件不再付一次空 Vec 分配）。
        // 锁序保持"先适配器后绑定"（§1.6-1，B1 修复产物）：GUI source（key 无注册
        // 适配器）在此提前返回，不触发"拒绝未绑定"告警。
        let Some(adapter) = self.adapter_for_source(source) else {
            return;
        };
        // B1：出站白名单（安全收紧）——source 必须是 binding 命中的平台源。
        // GUI 会话冒名 qq:*（无 binding）不得被投递到平台；配置锁中毒 fail-closed。
        let bound = self
            .config
            .read()
            .ok()
            .map(|c| c.routes.lookup(source).is_some())
            .unwrap_or(false);
        if !bound {
            tracing::warn!("gateway deliver_all 拒绝未绑定 source 的出站投递: {source}");
            return;
        }
        if let Some(text) = extract_deliver_text(event, payload) {
            // 修复（O39）：空文本 chunk 不投递——空消息不入队发送
            // （也避免空文本被当作事件走 deliver_event 分支）。
            if text.is_empty() {
                return;
            }
            for chunk in truncate::truncate_message(&text, adapter.max_message_len()) {
                if let Err(error) = adapter.deliver_text(source, &chunk) {
                    tracing::warn!(
                        "gateway deliver_text({}) failed: {}",
                        adapter.platform_key(),
                        error
                    );
                }
            }
        } else if let Err(error) = adapter.deliver_event(source, event, payload) {
            tracing::warn!(
                "gateway deliver_event({}) failed: {}",
                adapter.platform_key(),
                error
            );
        }
    }
}

impl Default for GatewayCore {
    fn default() -> Self {
        Self::new()
    }
}

/// 从 agent 事件中提取可投递的平台文本：仅 pylon:update 的 agent_message_chunk。
/// R4：sessionUpdate 变体经枚举解析（wire 字符串契约不变）。
fn extract_deliver_text(event: &str, payload: &serde_json::Value) -> Option<String> {
    if event != crate::event_names::SESSION_UPDATE {
        return None;
    }
    let update = payload.get("update")?;
    if update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .and_then(crate::acp::SessionUpdateVariant::from_str)
        != Some(crate::acp::SessionUpdateVariant::AgentMessageChunk)
    {
        return None;
    }
    update
        .get("content")
        .and_then(|c| c.get("text"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct FakeAdapter {
        key: &'static str,
        max_len: usize,
        delivered: AtomicUsize,
        events: Mutex<Vec<String>>,
    }

    impl FakeAdapter {
        fn new(key: &'static str, max_len: usize) -> Arc<Self> {
            Arc::new(Self {
                key,
                max_len,
                delivered: AtomicUsize::new(0),
                events: Mutex::new(Vec::new()),
            })
        }
    }

    impl PlatformAdapter for FakeAdapter {
        fn platform_key(&self) -> &str {
            self.key
        }
        fn max_message_len(&self) -> usize {
            self.max_len
        }
        fn deliver_text(&self, _source: &str, _text: &str) -> Result<(), String> {
            self.delivered.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn deliver_event(
            &self,
            _source: &str,
            event: &str,
            _payload: &serde_json::Value,
        ) -> Result<(), String> {
            self.events.lock().unwrap().push(event.to_string());
            Ok(())
        }
    }

    #[test]
    fn instance_contract_error_codes_are_stable() {
        // I12-A-BE-01：route 引用不存在/未连接实例 → 结构化错误（稳定 code，不泄露 secret）
        assert_eq!(
            GatewayError::InstanceNotFound("qq-bot-1".into()).code(),
            "gateway_instance_not_found"
        );
        assert_eq!(
            GatewayError::InstanceNotConnected("qq-bot-1".into()).code(),
            "gateway_instance_not_connected"
        );
        // message 是结构化上下文；错误对象 wire 形状 {code,message} 由 PylonError 承载
        let message = GatewayError::InstanceNotFound("qq-bot-1".into()).to_string();
        assert!(
            message.contains("qq-bot-1") && !message.contains("secret"),
            "错误信息不得携带 secret"
        );
    }

    #[test]
    fn register_rejects_duplicate_platform_key() {
        let core = GatewayCore::new();
        core.register(FakeAdapter::new("qq", 4000))
            .expect("first register");
        let error = core
            .register(FakeAdapter::new("qq", 4000))
            .expect_err("duplicate must fail");
        assert!(error.contains("qq"));
        assert_eq!(core.adapter_keys(), vec!["qq"]);
    }

    #[test]
    fn register_accepts_multiple_platforms() {
        let core = GatewayCore::new();
        core.register(FakeAdapter::new("qq", 4000)).unwrap();
        core.register(FakeAdapter::new("wechat", 2000)).unwrap();
        let mut keys = core.adapter_keys();
        keys.sort();
        assert_eq!(keys, vec!["qq", "wechat"]);
    }

    #[test]
    fn ingest_resolves_static_binding_from_gateway_config() {
        // §3-4：ingest() 已删除——binding 由调用方单快照取得，经 build_resolved 纯组装
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#;
        let core = GatewayCore::from_config(crate::gateway::route::parse_config(yaml).unwrap());
        let binding = core.binding("qq:group:123");
        let resolved =
            build_resolved("qq:group:123", "你好", binding).expect("build_resolved must assemble");
        assert_eq!(resolved.source, "qq:group:123");
        assert_eq!(resolved.content, "你好");
        let binding = resolved.binding.expect("static binding must hit");
        assert_eq!(binding.agent_id, "peri");
        assert_eq!(binding.profile_id, "trpg");
        assert_eq!(binding.session_key, "战役1");
        let unbound = build_resolved("qq:user:999", "hi", None)
            .expect("unbound source must assemble to default");
        assert!(unbound.binding.is_none());
    }

    #[test]
    fn ingest_rejects_empty_source_and_truncates_overlong_content() {
        // §3-4：build_resolved 纯函数直测（原 ingest() 测试改写）
        assert!(build_resolved("", "x", None).is_err());
        assert!(
            build_resolved("   ", "x", None).is_err(),
            "空白 source 同样拒绝"
        );
        let long = "a".repeat(MAX_INGEST_CHARS + 1000);
        let resolved = build_resolved("qq:group:1", &long, None).unwrap();
        assert_eq!(resolved.content.chars().count(), MAX_INGEST_CHARS);
    }

    #[test]
    fn deliver_all_splits_agent_text_by_adapter_limit() {
        // B1：出站白名单——投递 source 必须是 binding 命中的平台源
        let core = config_with(
            r#"
gateway:
  routes:
    - source: qq:group:1
      agent: peri
      profile: trpg
      session: 战役1
"#,
        );
        let qq = FakeAdapter::new("qq", 20);
        core.register(qq.clone()).unwrap();
        let payload = serde_json::json!({
            "source": "qq:group:1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"text": "word word word word word word word"}
            }
        });
        core.deliver_all("qq:group:1", crate::event_names::SESSION_UPDATE, &payload);
        assert!(qq.delivered.load(Ordering::SeqCst) > 1, "长文本必须分段");
        assert_eq!(
            qq.events.lock().unwrap().len(),
            0,
            "文本事件不走 deliver_event"
        );
    }

    #[test]
    fn deliver_all_routes_by_source_prefix_only() {
        // B1：出站白名单——投递 source 必须是 binding 命中的平台源
        let core = config_with(
            r#"
gateway:
  routes:
    - source: qq:group:1
      agent: peri
      profile: trpg
      session: 战役1
"#,
        );
        let qq = FakeAdapter::new("qq", 20);
        let wechat = FakeAdapter::new("wechat", 20);
        core.register(qq.clone()).unwrap();
        core.register(wechat.clone()).unwrap();
        // 非文本事件：仅 qq source 到达 qq 适配器
        core.deliver_all(
            "qq:group:1",
            crate::event_names::SESSION_DONE,
            &serde_json::json!({"source": "qq:group:1", "data": {}}),
        );
        assert_eq!(
            *qq.events.lock().unwrap(),
            vec![crate::event_names::SESSION_DONE.to_string()]
        );
        assert!(
            wechat.events.lock().unwrap().is_empty(),
            "wechat 不得收到 qq 事件"
        );
        // local source（GUI 会话）不投递给任何平台
        core.deliver_all(
            "local",
            crate::event_names::SESSION_DONE,
            &serde_json::json!({"source": "local", "data": {}}),
        );
        assert!(qq.events.lock().unwrap().len() == 1);
    }

    #[test]
    fn deliver_all_rejects_unbound_source_outbound() {
        // B1：出站白名单——无 binding 的 qq:*（GUI 冒名平台源）不得出站；
        // 绑定命中的平台源照常投递（正对照）。
        let core = GatewayCore::new();
        let qq = FakeAdapter::new("qq", 4000);
        core.register(qq.clone()).unwrap();
        core.deliver_all(
            "qq:group:999",
            crate::event_names::SESSION_UPDATE,
            &serde_json::json!({
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "hi"}}
            }),
        );
        core.deliver_all(
            "qq:group:999",
            crate::event_names::SESSION_DONE,
            &serde_json::json!({"data": {}}),
        );
        assert_eq!(
            qq.delivered.load(Ordering::SeqCst),
            0,
            "未绑定 source 不得投递文本"
        );
        assert!(
            qq.events.lock().unwrap().is_empty(),
            "未绑定 source 不得投递事件"
        );
        // 绑定命中（qq:group:123）仍投递
        let bound = config_with(
            r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#,
        );
        let bound_qq = FakeAdapter::new("qq", 4000);
        bound.register(bound_qq.clone()).unwrap();
        bound.deliver_all(
            "qq:group:123",
            crate::event_names::SESSION_DONE,
            &serde_json::json!({"data": {}}),
        );
        assert_eq!(
            *bound_qq.events.lock().unwrap(),
            vec![crate::event_names::SESSION_DONE.to_string()],
            "绑定命中的平台源必须照常投递"
        );
    }

    #[test]
    fn deliver_all_skips_empty_text_chunk() {
        // O39：空文本 chunk 不投递——空消息不入队发送，也不落入 deliver_event 分支
        let core = config_with(
            r#"
gateway:
  routes:
    - source: qq:group:1
      agent: peri
      profile: trpg
      session: 战役1
"#,
        );
        let qq = FakeAdapter::new("qq", 4000);
        core.register(qq.clone()).unwrap();
        core.deliver_all(
            "qq:group:1",
            crate::event_names::SESSION_UPDATE,
            &serde_json::json!({
                "source": "qq:group:1",
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": ""}}
            }),
        );
        assert_eq!(qq.delivered.load(Ordering::SeqCst), 0, "空文本不得投递");
        assert!(
            qq.events.lock().unwrap().is_empty(),
            "空文本不得落入 deliver_event"
        );
    }

    #[test]
    fn deliver_all_with_empty_registry_is_safe() {
        let core = GatewayCore::new();
        core.deliver_all(
            "qq:group:1",
            crate::event_names::SESSION_UPDATE,
            &serde_json::json!({"update": {}}),
        );
        assert!(core.adapter_keys().is_empty());
    }

    #[test]
    fn adapter_for_source_resolves_registered_adapter_by_prefix() {
        let core = GatewayCore::new();
        let qq = FakeAdapter::new("qq", 4000);
        core.register(qq.clone()).unwrap();
        assert!(
            core.adapter_for_source("qq:group:123").is_some(),
            "注册适配器前缀命中必须返回适配器"
        );
        assert!(
            core.adapter_for_source("qq").is_some(),
            "裸平台 key 也应命中"
        );
        assert!(
            core.adapter_for_source("local").is_none(),
            "GUI source（无注册适配器）必须为 None"
        );
        assert!(
            core.adapter_for_source("wechat:group:1").is_none(),
            "未注册平台 key 必须为 None"
        );
        assert!(
            core.adapter_for_source("").is_none(),
            "空 source 必须为 None"
        );
        assert!(core.adapter_for_source(":").is_none(), "空 key 必须为 None");
    }

    #[test]
    fn is_platform_source_hits_adapter_prefix_or_binding() {
        // E14 语义：is_platform_source = "有注册适配器 OR 有 binding"
        // （与 deliver_all 出站白名单等价；QQ 适配器未注册时 qq:* 冒名源判定 false）
        let core = GatewayCore::new();
        // 无注册适配器 + 无 binding → qq:* 判定 false（E14 钉住）
        assert!(
            !core.is_platform_source("qq:group:999"),
            "无注册适配器 + 无 binding 的 qq:* 源必须判定 false（E14）"
        );
        assert!(
            !core.is_platform_source("local"),
            "GUI source 必须判定 false"
        );
        assert!(!core.is_platform_source(""), "空 source 必须判定 false");
        // 有 binding（无适配器）→ true
        let bound = config_with(
            r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#,
        );
        assert!(
            bound.is_platform_source("qq:group:123"),
            "binding 命中必须判定为平台源"
        );
        assert!(
            !bound.is_platform_source("qq:user:999"),
            "无 binding 的 qq:* 源在无适配器时必须判定 false"
        );
        // 有注册适配器（无 binding）→ true（前缀命中；deliver_all 层面仍被绑定白名单拒绝）
        bound.register(FakeAdapter::new("qq", 4000)).unwrap();
        assert!(
            bound.is_platform_source("qq:user:999"),
            "注册适配器前缀命中必须判定为平台源"
        );
        assert!(
            !bound.is_platform_source("local"),
            "GUI source（无注册适配器）必须判定 false"
        );
    }

    #[test]
    fn deliver_all_reports_wired_failures_without_panicking() {
        struct FailingAdapter;
        impl PlatformAdapter for FailingAdapter {
            fn platform_key(&self) -> &str {
                "failing"
            }
            fn max_message_len(&self) -> usize {
                4000
            }
            fn deliver_text(&self, _s: &str, _t: &str) -> Result<(), String> {
                Err("未接线".to_string())
            }
            fn deliver_event(
                &self,
                _s: &str,
                _e: &str,
                _p: &serde_json::Value,
            ) -> Result<(), String> {
                Err("未接线".to_string())
            }
        }
        let core = config_with(
            r#"
gateway:
  routes:
    - source: failing:user:1
      agent: peri
      profile: trpg
      session: 战役1
"#,
        );
        core.register(Arc::new(FailingAdapter)).unwrap();
        core.deliver_all(
            "failing:user:1",
            crate::event_names::SESSION_UPDATE,
            &serde_json::json!({
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "hi"}}
            }),
        );
        core.deliver_all(
            "failing:user:1",
            crate::event_names::SESSION_DONE,
            &serde_json::json!({"data": {}}),
        );
    }

    fn config_with(yaml: &str) -> GatewayCore {
        GatewayCore::from_config(route::parse_config(yaml).expect("合法配置"))
    }

    #[test]
    fn dispatch_ingest_invokes_registered_handler() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let core = GatewayCore::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let calls_clone = calls.clone();
        core.set_ingest_handler(Arc::new(move |_resolved: &ResolvedIngest| {
            calls_clone.fetch_add(1, Ordering::SeqCst);
        }));
        // §3-4：输入经 build_resolved 纯组装（原 ingest() 直调改写）
        let resolved = build_resolved("qq:group:1", "hello", None).expect("build_resolved");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "build_resolved 纯组装不得触发 handler"
        );
        core.dispatch_ingest(&resolved);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "dispatch 必须触发 handler");
        core.dispatch_ingest(&resolved);
        assert_eq!(calls.load(Ordering::SeqCst), 2, "handler 可重复调用");
    }

    // ── R6（P1-4）：reload 成功/失败语义 ──

    #[test]
    fn reload_updates_config_on_success() {
        let core = GatewayCore::new();
        let config = route::parse_config(
            r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#,
        )
        .expect("合法配置");
        core.reload(config).expect("reload 必须成功");
        let binding = core.binding("qq:group:123").expect("binding 必须生效");
        assert_eq!(binding.agent_id, "peri");
        assert_eq!(binding.session_key, "战役1");
    }

    #[test]
    fn reload_reports_poisoned_config_lock_and_keeps_running() {
        let core = Arc::new(GatewayCore::new());
        let core_for_poison = core.clone();
        // 毒化 config 写锁：持锁线程 panic（RwLock 中毒后所有后续写均失败）。
        let handle = std::thread::spawn(move || {
            let _guard = core_for_poison.config.write().unwrap();
            panic!("intentional lock poison for reload test");
        });
        let _ = handle.join();
        let result = core.reload(GatewayConfig::empty());
        assert!(
            matches!(result, Err(GatewayError::ConfigLockPoisoned)),
            "锁中毒必须返回 Err，不得误报成功"
        );
        // 中毒后服务仍可运行（fail-closed 读路径），不 panic。
        assert!(core.adapter_keys().is_empty());
        assert!(!core.is_platform_source("qq:group:999"));
    }
}
