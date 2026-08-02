//! Gateway：平台适配器层（B10）。
//!
//! 消息拓扑：平台(qq/微信/飞书/ins) → gateway → ACP → 本地 agent。
//! 信息脉络：agent ←ACP→ Pylon(gateway) → 平台。
//!
//! B10.1 骨架：PlatformAdapter trait + GatewayCore（适配器注册表、
//! 入站 ingest 路由解析、出站 deliver 分段分发）。B10.2 起逐个接入平台适配器。

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
/// GatewayCore::ingest（QQ 适配器经 handle_incoming 去重+白名单后进入）。
pub trait PlatformAdapter: Send + Sync {
    /// 平台标识（"qq"/"wechat"…），同时是 source 前缀（"qq:group:123"）。
    fn platform_key(&self) -> &str;
    /// 平台单条文本上限（字符数），deliver 分段的依据（QQ = 4000，Hermes 实证）。
    fn max_message_len(&self) -> usize;
    /// 向平台会话投递一段文本（已分段，未接线实现返回 Err 由调用方告警）。
    fn deliver_text(&self, source: &str, text: &str) -> Result<(), String>;
    /// 向平台会话投递非文本事件（peri:done / peri:error 等）。
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
    /// 回滚去重窗口用）。`ingest()` 构造为 None；适配器层 handle_incoming 组装时填充。
    pub msg_id: Option<String>,
}

/// 入站消息字符上限：超长截断再进 prompt（防超长消息打爆 agent 输入）。
pub const MAX_INGEST_CHARS: usize = 64 * 1024;

/// ingest 发送处理器：解析结果 → ACP 发送（B10.3 由 lib.rs 注册，
/// 按 binding.agent_id 路由到对应 runtime，未绑定回退 active agent）。
pub type IngestHandler = Arc<dyn Fn(&ResolvedIngest) + Send + Sync>;

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
    /// 修复（P3）：写锁失败（中毒）不再误报"已热重载"，改走错误日志分支。
    pub fn reload(&self, config: GatewayConfig) {
        match self.config.write() {
            Ok(mut slot) => {
                *slot = config;
                tracing::info!("gateway 配置已热重载");
            }
            Err(_) => tracing::error!("gateway 配置热重载失败（配置锁中毒），保持原配置"),
        }
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

    /// 入站解析：source 路由查询 + 超长截断。纯解析，不触发发送。
    ///
    /// 平台相关去重（resume 重放）与白名单由各适配器层完成，本入口只见干净消息；
    /// 白名单通过后由调用方 [`Self::dispatch_ingest`] 触发 ACP 发送。
    pub fn ingest(&self, source: &str, content: &str) -> Result<ResolvedIngest, String> {
        if source.trim().is_empty() {
            return Err("ingest requires a non-empty source".to_string());
        }
        let content: String = content.chars().take(MAX_INGEST_CHARS).collect();
        let binding = self
            .config
            .read()
            .ok()
            .and_then(|c| c.routes.lookup(source).cloned());
        Ok(ResolvedIngest {
            source: source.to_string(),
            content,
            binding,
            // C14：纯解析层不知道平台 msg_id，由适配器层 handle_incoming 组装时填充
            msg_id: None,
        })
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
    /// - peri:update 的 agent_message_chunk → 提取文本 → 按适配器上限分段 →
    ///   逐段 deliver_text（truncate 分段管线，平台无关，在核心层完成）
    /// - 其他事件 → deliver_event
    ///   投递失败（含未接线适配器）只告警，不阻断 WebView 事件。
    pub fn deliver_all(&self, source: &str, event: &str, payload: &serde_json::Value) {
        // 修复（P3）：前缀匹配提为平台 key 比较（source "qq:group:1" → "qq"），
        // 不再每适配器每元素 format! 一次（原实现与 starts_with("key:") 等价）。
        let key = source.split(':').next().unwrap_or("");
        let adapters: Vec<Arc<dyn PlatformAdapter>> = self
            .adapters
            .lock()
            .map(|a| {
                a.values()
                    .filter(|adapter| adapter.platform_key() == key)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if adapters.is_empty() {
            return;
        }
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
            for adapter in &adapters {
                for chunk in truncate::truncate_message(&text, adapter.max_message_len()) {
                    if let Err(error) = adapter.deliver_text(source, &chunk) {
                        tracing::warn!(
                            "gateway deliver_text({}) failed: {}",
                            adapter.platform_key(),
                            error
                        );
                    }
                }
            }
        } else {
            for adapter in &adapters {
                if let Err(error) = adapter.deliver_event(source, event, payload) {
                    tracing::warn!(
                        "gateway deliver_event({}) failed: {}",
                        adapter.platform_key(),
                        error
                    );
                }
            }
        }
    }
}

impl Default for GatewayCore {
    fn default() -> Self {
        Self::new()
    }
}

/// 从 agent 事件中提取可投递的平台文本：仅 peri:update 的 agent_message_chunk。
/// R4：sessionUpdate 变体经枚举解析（wire 字符串契约不变）。
fn extract_deliver_text(event: &str, payload: &serde_json::Value) -> Option<String> {
    if event != "peri:update" {
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

/// 平台入站白名单检查（B10.3，Hermes group_allow_from / allow_from 模式）：
///
/// - 群消息（qq:group:*）：群级白名单（qq 配置）→ 成员白名单（binding.allow_from）
/// - 私聊（qq:user:*）：用户白名单（binding.allow_from）
/// - 未配置白名单 = 放行；群级白名单只约束群消息
pub fn ingest_allowed(
    qq_config: &QqGatewayConfig,
    binding: Option<&route::EntityBinding>,
    source: &str,
    member_openid: Option<&str>,
    user_openid: Option<&str>,
) -> bool {
    if let Some(group_id) = source.strip_prefix("qq:group:") {
        if let Some(allow) = &qq_config.group_allow_from {
            if !allow.iter().any(|g| g == group_id) {
                return false;
            }
        }
    }
    let Some(binding) = binding else {
        return true;
    };
    let Some(allow) = &binding.allow_from else {
        return true;
    };
    let principal = if source.starts_with("qq:group:") {
        member_openid.unwrap_or("")
    } else {
        user_openid.unwrap_or("")
    };
    allow.iter().any(|entry| entry == principal)
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
        let yaml = r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#;
        let core = GatewayCore::from_config(crate::gateway::route::parse_config(yaml).unwrap());
        let resolved = core
            .ingest("qq:group:123", "你好")
            .expect("ingest must resolve");
        assert_eq!(resolved.source, "qq:group:123");
        assert_eq!(resolved.content, "你好");
        let binding = resolved.binding.expect("static binding must hit");
        assert_eq!(binding.agent_id, "peri");
        assert_eq!(binding.profile_id, "trpg");
        assert_eq!(binding.session_key, "战役1");
        let unbound = core
            .ingest("qq:user:999", "hi")
            .expect("unbound source must resolve to default");
        assert!(unbound.binding.is_none());
    }

    #[test]
    fn ingest_rejects_empty_source_and_truncates_overlong_content() {
        let core = GatewayCore::new();
        assert!(core.ingest("", "x").is_err());
        let long = "a".repeat(MAX_INGEST_CHARS + 1000);
        let resolved = core.ingest("qq:group:1", &long).unwrap();
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
        core.deliver_all("qq:group:1", "peri:update", &payload);
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
            "peri:done",
            &serde_json::json!({"source": "qq:group:1", "data": {}}),
        );
        assert_eq!(*qq.events.lock().unwrap(), vec!["peri:done".to_string()]);
        assert!(
            wechat.events.lock().unwrap().is_empty(),
            "wechat 不得收到 qq 事件"
        );
        // local source（GUI 会话）不投递给任何平台
        core.deliver_all(
            "local",
            "peri:done",
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
            "peri:update",
            &serde_json::json!({
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "hi"}}
            }),
        );
        core.deliver_all(
            "qq:group:999",
            "peri:done",
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
            "peri:done",
            &serde_json::json!({"data": {}}),
        );
        assert_eq!(
            *bound_qq.events.lock().unwrap(),
            vec!["peri:done".to_string()],
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
            "peri:update",
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
            "peri:update",
            &serde_json::json!({"update": {}}),
        );
        assert!(core.adapter_keys().is_empty());
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
            "peri:update",
            &serde_json::json!({
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "hi"}}
            }),
        );
        core.deliver_all(
            "failing:user:1",
            "peri:done",
            &serde_json::json!({"data": {}}),
        );
    }

    fn config_with(yaml: &str) -> GatewayCore {
        GatewayCore::from_config(route::parse_config(yaml).expect("合法配置"))
    }

    #[test]
    fn ingest_allowed_enforces_group_and_member_allowlists() {
        let config = config_with(
            r#"
gateway:
  qq:
    group_allow_from: [group-a]
  routes:
    - source: qq:group:group-a
      agent: peri
      profile: trpg
      session: 战役1
      allow_from: [member-1]
    - source: qq:user:user-1
      agent: hermes
      profile: default
      session: dm
      allow_from: [user-1]
"#,
        );
        let qq = config.qq_config();
        let group_binding = config.binding("qq:group:group-a");
        // 群级白名单：未列出群拒绝
        assert!(!ingest_allowed(
            &qq,
            group_binding.as_ref(),
            "qq:group:group-x",
            Some("member-1"),
            None
        ));
        // 成员白名单：匹配放行、不匹配拒绝
        assert!(ingest_allowed(
            &qq,
            group_binding.as_ref(),
            "qq:group:group-a",
            Some("member-1"),
            None
        ));
        assert!(!ingest_allowed(
            &qq,
            group_binding.as_ref(),
            "qq:group:group-a",
            Some("stranger"),
            None
        ));
        // 私聊白名单：按 user_openid
        let c2c_binding = config.binding("qq:user:user-1");
        assert!(ingest_allowed(
            &qq,
            c2c_binding.as_ref(),
            "qq:user:user-1",
            None,
            Some("user-1")
        ));
        assert!(!ingest_allowed(
            &qq,
            c2c_binding.as_ref(),
            "qq:user:user-1",
            None,
            Some("user-2")
        ));
        // 群级白名单配置了 group-a：any 群被拒绝
        assert!(!ingest_allowed(
            &qq,
            None,
            "qq:group:any",
            Some("whoever"),
            None
        ));
        // 无群级白名单 + 无绑定 → 放行
        let open = config_with(
            r#"
gateway:
  routes:
    - source: qq:group:123
      agent: peri
      profile: trpg
      session: 战役1
"#,
        );
        assert!(ingest_allowed(
            &open.qq_config(),
            None,
            "qq:group:any",
            Some("whoever"),
            None
        ));
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
        let resolved = core.ingest("qq:group:1", "hello").expect("ingest");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            0,
            "ingest 纯解析不得触发 handler"
        );
        core.dispatch_ingest(&resolved);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "dispatch 必须触发 handler");
        core.dispatch_ingest(&resolved);
        assert_eq!(calls.load(Ordering::SeqCst), 2, "handler 可重复调用");
    }
}
