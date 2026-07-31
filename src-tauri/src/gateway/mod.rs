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
use std::sync::{Arc, Mutex};

use route::EntityRouteTable;

/// 平台适配器接口。
///
/// 出站（agent → 平台）：GatewayCore 把 agent 事件按文本/非文本分类后调用
/// [`Self::deliver_text`]（已按 [`Self::max_message_len`] 分段）或
/// [`Self::deliver_event`]。入站（平台 → agent）：平台连接层解析事件后调用
/// GatewayCore::ingest（QQ 适配器经 handle_incoming 去重后进入）。
pub trait PlatformAdapter: Send + Sync {
    /// 平台标识（"qq"/"wechat"…），同时是 source 前缀（"qq:group:123"）。
    fn platform_key(&self) -> &str;
    /// 平台单条文本上限（字符数），deliver 分段的依据（QQ = 4000，Hermes 实证）。
    fn max_message_len(&self) -> usize;
    /// 向平台会话投递一段文本（已分段，未接线实现返回 Err 由调用方告警）。
    fn deliver_text(&self, source: &str, text: &str) -> Result<(), String>;
    /// 向平台会话投递非文本事件（peri:done / peri:error 等）。
    fn deliver_event(&self, source: &str, event: &str, payload: &serde_json::Value) -> Result<(), String>;
}

/// 入站消息解析结果：平台消息 → 路由绑定（B10.3 消费：会话生命周期 + ACP 发送）。
/// 字段待 B10.3 消费，当前由 ingest 构造（测试验证路由解析）。
#[allow(dead_code)]
#[derive(Debug)]
pub struct ResolvedIngest {
    pub source: String,
    pub content: String,
    /// 静态绑定命中；未配置实体时为 None（B10.3 回退默认绑定）。
    pub binding: Option<route::EntityBinding>,
}

/// 入站消息字符上限：超长截断再进 prompt（防超长消息打爆 agent 输入）。
pub const MAX_INGEST_CHARS: usize = 64 * 1024;

/// Gateway 核心：适配器注册表 + 静态路由表 + 入站解析 + 出站分发（B10.1）。
pub struct GatewayCore {
    adapters: Mutex<HashMap<String, Arc<dyn PlatformAdapter>>>,
    routes: EntityRouteTable,
}

impl GatewayCore {
    /// 从 agents.yaml 的 `gateway.routes` 段构建（缺段 → 空路由表）。
    pub fn new() -> Self {
        let routes = EntityRouteTable::from_yaml_str(include_str!("../../../agents.yaml"))
            .unwrap_or_else(|error| {
                log::warn!("gateway 路由配置解析失败，使用空路由表: {error}");
                EntityRouteTable::empty()
            });
        Self::with_routes(routes)
    }

    /// 用显式路由表构造（测试注入 / B10.3 热重载途径）。
    pub fn with_routes(routes: EntityRouteTable) -> Self {
        Self {
            adapters: Mutex::new(HashMap::new()),
            routes,
        }
    }

    /// 注册平台适配器；platform_key 重复 → Err。
    /// 待 B10.2 各平台适配器接线时调用（当前注册表为空，deliver_all 空转安全）。
    #[allow(dead_code)]
    pub fn register(&self, adapter: Arc<dyn PlatformAdapter>) -> Result<(), String> {
        let mut adapters = self.adapters.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if adapters.contains_key(adapter.platform_key()) {
            return Err(format!("duplicate platform adapter: {}", adapter.platform_key()));
        }
        adapters.insert(adapter.platform_key().to_string(), adapter);
        Ok(())
    }

    /// 已注册适配器的 platform_key 列表（gateway_status 命令/测试用）。
    #[allow(dead_code)]
    pub fn adapter_keys(&self) -> Vec<String> {
        self.adapters.lock().map(|a| a.keys().cloned().collect()).unwrap_or_default()
    }

    /// 入站解析：source 路由查询 + 超长截断。
    ///
    /// 平台相关去重（resume 重放）由各适配器层完成，本入口只见干净消息。
    /// 待 B10.3 会话生命周期接线后消费解析结果。
    #[allow(dead_code)]
    pub fn ingest(&self, source: &str, content: &str) -> Result<ResolvedIngest, String> {
        if source.trim().is_empty() {
            return Err("ingest requires a non-empty source".to_string());
        }
        let content: String = content.chars().take(MAX_INGEST_CHARS).collect();
        let binding = self.routes.lookup(source).cloned();
        Ok(ResolvedIngest {
            source: source.to_string(),
            content,
            binding,
        })
    }

    /// 出站分发：把 agent 事件投递给 source 前缀匹配的平台适配器。
    ///
    /// - peri:update 的 agent_message_chunk → 提取文本 → 按适配器上限分段 →
    ///   逐段 deliver_text（truncate 分段管线，平台无关，在核心层完成）
    /// - 其他事件 → deliver_event
    /// 投递失败（含未接线适配器）只告警，不阻断 WebView 事件。
    pub fn deliver_all(&self, source: &str, event: &str, payload: &serde_json::Value) {
        let adapters: Vec<Arc<dyn PlatformAdapter>> = self.adapters.lock()
            .map(|a| {
                a.values()
                    .filter(|adapter| source.starts_with(&format!("{}:", adapter.platform_key())))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        if adapters.is_empty() {
            return;
        }
        if let Some(text) = extract_deliver_text(event, payload) {
            for adapter in &adapters {
                for chunk in truncate::truncate_message(&text, adapter.max_message_len()) {
                    if let Err(error) = adapter.deliver_text(source, &chunk) {
                        log::warn!("gateway deliver_text({}) failed: {}", adapter.platform_key(), error);
                    }
                }
            }
        } else {
            for adapter in &adapters {
                if let Err(error) = adapter.deliver_event(source, event, payload) {
                    log::warn!("gateway deliver_event({}) failed: {}", adapter.platform_key(), error);
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
fn extract_deliver_text(event: &str, payload: &serde_json::Value) -> Option<String> {
    if event != "peri:update" {
        return None;
    }
    let update = payload.get("update")?;
    if update.get("sessionUpdate").and_then(|v| v.as_str()) != Some("agent_message_chunk") {
        return None;
    }
    update.get("content").and_then(|c| c.get("text")).and_then(|v| v.as_str()).map(str::to_string)
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
        fn platform_key(&self) -> &str { self.key }
        fn max_message_len(&self) -> usize { self.max_len }
        fn deliver_text(&self, _source: &str, _text: &str) -> Result<(), String> {
            self.delivered.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
        fn deliver_event(&self, _source: &str, event: &str, _payload: &serde_json::Value) -> Result<(), String> {
            self.events.lock().unwrap().push(event.to_string());
            Ok(())
        }
    }

    #[test]
    fn register_rejects_duplicate_platform_key() {
        let core = GatewayCore::new();
        core.register(FakeAdapter::new("qq", 4000)).expect("first register");
        let error = core.register(FakeAdapter::new("qq", 4000)).expect_err("duplicate must fail");
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
        let core = GatewayCore::with_routes(EntityRouteTable::from_yaml_str(yaml).unwrap());
        let resolved = core.ingest("qq:group:123", "你好").expect("ingest must resolve");
        assert_eq!(resolved.source, "qq:group:123");
        assert_eq!(resolved.content, "你好");
        let binding = resolved.binding.expect("static binding must hit");
        assert_eq!(binding.agent_id, "peri");
        assert_eq!(binding.profile_id, "trpg");
        assert_eq!(binding.session_key, "战役1");
        let unbound = core.ingest("qq:user:999", "hi").expect("unbound source must resolve to default");
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
        let core = GatewayCore::new();
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
        assert_eq!(qq.events.lock().unwrap().len(), 0, "文本事件不走 deliver_event");
    }

    #[test]
    fn deliver_all_routes_by_source_prefix_only() {
        let core = GatewayCore::new();
        let qq = FakeAdapter::new("qq", 20);
        let wechat = FakeAdapter::new("wechat", 20);
        core.register(qq.clone()).unwrap();
        core.register(wechat.clone()).unwrap();
        // 非文本事件：仅 qq source 到达 qq 适配器
        core.deliver_all("qq:group:1", "peri:done", &serde_json::json!({"source": "qq:group:1", "data": {}}));
        assert_eq!(*qq.events.lock().unwrap(), vec!["peri:done".to_string()]);
        assert!(wechat.events.lock().unwrap().is_empty(), "wechat 不得收到 qq 事件");
        // local source（GUI 会话）不投递给任何平台
        core.deliver_all("local", "peri:done", &serde_json::json!({"source": "local", "data": {}}));
        assert!(qq.events.lock().unwrap().len() == 1);
    }

    #[test]
    fn deliver_all_with_empty_registry_is_safe() {
        let core = GatewayCore::new();
        core.deliver_all("qq:group:1", "peri:update", &serde_json::json!({"update": {}}));
        assert!(core.adapter_keys().is_empty());
    }

    #[test]
    fn deliver_all_reports_wired_failures_without_panicking() {
        struct FailingAdapter;
        impl PlatformAdapter for FailingAdapter {
            fn platform_key(&self) -> &str { "failing" }
            fn max_message_len(&self) -> usize { 4000 }
            fn deliver_text(&self, _s: &str, _t: &str) -> Result<(), String> {
                Err("未接线".to_string())
            }
            fn deliver_event(&self, _s: &str, _e: &str, _p: &serde_json::Value) -> Result<(), String> {
                Err("未接线".to_string())
            }
        }
        let core = GatewayCore::new();
        core.register(Arc::new(FailingAdapter)).unwrap();
        core.deliver_all("failing:user:1", "peri:update", &serde_json::json!({
            "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "hi"}}
        }));
        core.deliver_all("failing:user:1", "peri:done", &serde_json::json!({"data": {}}));
    }
}
