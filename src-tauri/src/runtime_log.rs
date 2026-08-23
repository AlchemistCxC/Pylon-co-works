//! 结构化运行时日志：固定容量、查询过滤、截断和敏感字段脱敏。

use ringbuffer::{AllocRingBuffer, RingBuffer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::correlation::RuntimeCorrelation;
use crate::time::Timestamp;

/// R18：生产 hub 注册处——run() 创建 hub 后写入，tracing Layer 按事件读取。
/// 测试不安装 subscriber，Layer 不运行，无需注册。
static HUB: OnceLock<Arc<RuntimeLogHub>> = OnceLock::new();

pub fn register_hub(hub: Arc<RuntimeLogHub>) {
    let _ = HUB.set(hub);
}

fn hub() -> Option<Arc<RuntimeLogHub>> {
    HUB.get().cloned()
}

pub const DEFAULT_CAPACITY: usize = 2000;
const MAX_MESSAGE_BYTES: usize = 8 * 1024;
#[cfg(test)]
const REDACTED: &str = "[REDACTED]";

/// LOG-01：agent stderr 行回声专用 tracing target——该 target 只作 console/外部日志
/// 出口（fmt layer），`RuntimeLogLayer` 跳过它，hub 唯一归属 = stderr reader 的显式
/// push（保留真实行文本 + agent + correlation，同一行只进 hub 一次，方案书 §5.14）。
pub(crate) const AGENT_STDERR_ECHO_TARGET: &str = "agent_stderr_echo";

/// LOG-03：日志功能域分类词汇（集中定义防拼写漂移）。
/// 本卡只填充可确定性判定的站点（stderr/frontend）；transport/session/permission/
/// command/lifecycle 等域由后续结构化日志站点按此词汇填充（方案书 §5.14 增量字段
/// `category`）。类别语义：`stderr`=agent 原始 stderr 行（可与结构化后端日志分离筛选），
/// `frontend`=前端日志（source 亦固定为 frontend）。
pub const LOG_CATEGORY_STDERR: &str = "stderr";
pub const LOG_CATEGORY_FRONTEND: &str = "frontend";

/// LOG-03：结构化日志上下文——RuntimeLogEntry 增量字段的推进入口（方案书 §5.14：
/// code/category/agentId/provider/source/sessionId/clientGeneration/requestId/toolCallId/
/// recoverable/userActionRequired/rawAvailable）。
/// identity 部分（agentId/provider/source/clientGeneration/requestId/toolCallId/sessionId）
/// 已由 [`crate::correlation::RuntimeCorrelation`] + 既有 `session` 字段承载（OBS-02），
/// 本 context 只承载判定性增量字段。全部 `Option` + `skip_serializing_if`：缺失不上 wire，
/// 旧 UI 不认识新字段时不影响既有解析（OBS-02 兼容性纪律，同 correlation.rs）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLogContext {
    /// 机器可读错误码（稳定契约，前端可分支）。值域：agent 结构化 stderr 自报码
    /// （agent 命名空间）或 Pylon wire_code（DEL-05 词汇），不得发明新码；
    /// agent_unavailable 等内部测试码不进该字段（DEL-05 CR-002）。
    pub code: Option<String>,
    /// 日志功能域分类（词汇见 [`LOG_CATEGORY_STDERR`] / [`LOG_CATEGORY_FRONTEND`]）。
    pub category: Option<String>,
    /// 该错误是否可重试/自愈（语义由填充方定义；stderr 文本行不可判定 → None）。
    pub recoverable: Option<bool>,
    /// 是否需用户操作介入（同上；本卡无填充站点）。
    pub user_action_required: Option<bool>,
    /// 该条是否承载真实原始文本（可能经脱敏；区别于历史 B 型占位符"Agent stderr output"）。
    pub raw_available: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLogEntry {
    pub id: u64,
    /// R4：Timestamp 序列化为字符串（wire 契约 `"1722500000000"` 不变）。
    pub timestamp: Timestamp,
    pub level: String,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    pub message: String,
    #[serde(default)]
    pub fields: Map<String, Value>,
    /// OBS-02：统一身份 correlation context。Option + skip：旧 UI 不认识时
    /// 字段缺失不影响既有解析（方案书 §5.2 兼容性要求）；LOG-03 消费。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation: Option<RuntimeCorrelation>,
    /// LOG-03 增量字段（方案书 §5.14 RuntimeLogEntry 增量字段，卡点 code/category）。
    /// 全部 Option + skip_serializing_if：缺失不上 wire，旧 UI 兼容。
    /// code 值域见 [`RuntimeLogContext::code`]（稳定词汇，不发明新码）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recoverable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_action_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_available: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeLogQuery {
    pub level: Option<String>,
    pub source: Option<String>,
    pub session: Option<String>,
    pub search: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug)]
pub struct RuntimeLogHub {
    next_id: AtomicU64,
    /// R20：ringbuffer 硬容量（满时 enqueue 自动覆盖最旧，无扩容路径）。
    /// G3 §2.2.3：条目 Arc 化——push 双全量 clone → 2 次 Arc clone（ring + broadcast
    /// 共享同一 Arc）；serde `Arc<T: Serialize>` 保证消费方（session.rs / logs_cmds.rs）
    /// 零改动。
    entries: Mutex<AllocRingBuffer<Arc<RuntimeLogEntry>>>,
    capacity: usize,
    events: tokio::sync::broadcast::Sender<Arc<RuntimeLogEntry>>,
    /// B2：live 推送闸门——RuntimeSheet 打开时置 true（前端 set_runtime_log_live
    /// 驱动），关闭时 false。ringbuffer 记录不受影响（pull 兜底不变）；
    /// dispatcher 在闸门关闭时跳过 serialize + emit，消除无消费者时的广播开销。
    live_enabled: AtomicBool,
}

impl RuntimeLogHub {
    pub fn new(capacity: usize) -> Arc<Self> {
        let (events, _) = tokio::sync::broadcast::channel(256);
        Arc::new(Self {
            next_id: AtomicU64::new(1),
            entries: Mutex::new(AllocRingBuffer::new(capacity.max(1))),
            capacity: capacity.max(1),
            events,
            live_enabled: AtomicBool::new(false),
        })
    }

    /// B2：开/关 live 推送。默认关——启动后 RuntimeSheet 首次挂载才打开。
    pub fn set_live(&self, enabled: bool) {
        self.live_enabled.store(enabled, Ordering::Release);
    }

    pub fn live_enabled(&self) -> bool {
        self.live_enabled.load(Ordering::Acquire)
    }

    pub fn default() -> Arc<Self> {
        Self::new(DEFAULT_CAPACITY)
    }

    pub fn push(
        &self,
        timestamp: Timestamp,
        level: impl Into<String>,
        source: impl Into<String>,
        session: Option<String>,
        message: impl Into<String>,
        fields: Map<String, Value>,
    ) -> RuntimeLogEntry {
        self.push_with_correlation(timestamp, level, source, session, message, fields, None)
    }

    /// OBS-02：带 correlation context 的 push（统一身份进运行时日志）。
    /// correlation=None 时与旧 push 完全一致（wire 不新增字段，旧 UI 兼容）。
    pub fn push_with_correlation(
        &self,
        timestamp: Timestamp,
        level: impl Into<String>,
        source: impl Into<String>,
        session: Option<String>,
        message: impl Into<String>,
        fields: Map<String, Value>,
        correlation: Option<RuntimeCorrelation>,
    ) -> RuntimeLogEntry {
        self.push_with_context(
            timestamp,
            level,
            source,
            session,
            message,
            fields,
            correlation,
            RuntimeLogContext::default(),
        )
    }

    /// LOG-03：带结构化上下文的 push（增量字段 code/category/recoverable/
    /// userActionRequired/rawAvailable 的唯一推进入口）。context 为缺省值时与
    /// `push_with_correlation` 完全一致（wire 不新增字段，旧 UI 兼容）。
    pub fn push_with_context(
        &self,
        timestamp: Timestamp,
        level: impl Into<String>,
        source: impl Into<String>,
        session: Option<String>,
        message: impl Into<String>,
        fields: Map<String, Value>,
        correlation: Option<RuntimeCorrelation>,
        context: RuntimeLogContext,
    ) -> RuntimeLogEntry {
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // O22：id 分配在锁内，保证 id 递增与入队序一致。
        let entry = Arc::new(RuntimeLogEntry {
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            timestamp,
            level: normalize_level(level.into()),
            source: truncate(source.into(), MAX_MESSAGE_BYTES),
            session: session.map(|value| truncate(value, MAX_MESSAGE_BYTES)),
            message: sanitize_message(message.into()),
            fields: sanitize_fields(fields),
            correlation,
            code: context.code,
            category: context.category,
            recoverable: context.recoverable,
            user_action_required: context.user_action_required,
            raw_available: context.raw_available,
        });
        // R20：ringbuffer enqueue 满时自动覆盖最旧。
        // G3：1 次 Arc clone（原 :101 全量 clone）。
        let _ = entries.enqueue(Arc::clone(&entry));
        drop(entries);
        // O24：broadcast send 移出 entries 锁临界区。
        // G3：1 次 Arc clone（原 :104 全量 clone）。
        let _ = self.events.send(Arc::clone(&entry));
        // 返回路径 1 次全量 clone（签名不变，调用方零改动）。
        (*entry).clone()
    }

    pub fn subscribe(&self) -> tokio::sync::broadcast::Receiver<Arc<RuntimeLogEntry>> {
        self.events.subscribe()
    }

    pub fn list(&self, query: &RuntimeLogQuery) -> Vec<RuntimeLogEntry> {
        let search = query.search.as_deref().map(str::to_lowercase);
        let limit = query.limit.unwrap_or(self.capacity).min(self.capacity);
        // O23：锁内仅 clone 快照，过滤在锁外进行（保持 rev + take(limit) 语义）。
        // G3：Arc 快照（廉价指针复制，原 :121 全量 clone），仅结果集 clone。
        let entries = {
            let guard = self
                .entries
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.iter().cloned().collect::<Vec<_>>()
        };
        entries
            .iter()
            .rev()
            .filter(|entry| {
                query
                    .level
                    .as_deref()
                    .is_none_or(|value| entry.level.eq_ignore_ascii_case(value))
            })
            .filter(|entry| {
                query
                    .source
                    .as_deref()
                    .is_none_or(|value| entry.source.eq_ignore_ascii_case(value))
            })
            .filter(|entry| {
                query
                    .session
                    .as_deref()
                    .is_none_or(|value| entry.session.as_deref() == Some(value))
            })
            .filter(|entry| {
                search.as_deref().is_none_or(|needle| {
                    // P3：needle 已小写一次（上方）。O25：search 只匹配字符串值，
                    // 不命中字段 key；字符串值免 JSON 再序列化，非字符串值才
                    // to_string（保持与原"序列化整 map"的匹配面一致）。
                    entry.message.to_lowercase().contains(needle)
                        || entry.fields.values().any(|value| match value {
                            Value::String(text) => text.to_lowercase().contains(needle),
                            other => other.to_string().to_lowercase().contains(needle),
                        })
                })
            })
            .take(limit)
            .map(|entry| entry.as_ref().clone())
            .collect()
    }

    pub fn clear(&self) {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

fn normalize_level(level: String) -> String {
    match level.to_ascii_lowercase().as_str() {
        "trace" | "debug" | "info" | "warn" | "error" => level.to_ascii_lowercase(),
        _ => "info".to_string(),
    }
}

/// R18：tracing Layer——把 tracing 宏产生的 event 转发到 RuntimeLogHub。
/// runtime-log 事件形状不变（level / source=target / message / fields / session），
/// 消息与字段在 push 层统一走 sanitize（hub.push 自带）。session 字段 tracing
/// 原生没有，约定由 event field 传递（record_str 命中 "session" 时抽取）。
#[derive(Clone, Default)]
pub struct RuntimeLogLayer {
    /// 显式 hub（测试/自定义场景）；None 时按事件惰性读取静态注册的 hub。
    hub: Option<Arc<RuntimeLogHub>>,
}

impl RuntimeLogLayer {
    pub fn new() -> Self {
        Self { hub: None }
    }

    /// 绑定显式 hub（不经过静态注册）——Layer 单元测试用，避免并行测试
    /// 竞争全局注册点。
    #[cfg(test)]
    pub fn with_hub(hub: Arc<RuntimeLogHub>) -> Self {
        Self { hub: Some(hub) }
    }
}

impl<S> tracing_subscriber::Layer<S> for RuntimeLogLayer
where
    S: tracing::Subscriber,
{
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        // 与 fmt layer 的 max_level=INFO 一致：debug/trace 不进 hub（不冲刷环形缓冲）。
        if event.metadata().level() > &tracing::Level::INFO {
            return;
        }
        // LOG-01：agent stderr 行回声（target=AGENT_STDERR_ECHO_TARGET）只作 console
        // 出口，不进 hub——hub 由 stderr reader 显式 push 唯一承载（否则同一行双写，
        // 方案书 §5.14"确定 hub 唯一归属"）。
        if event.metadata().target() == AGENT_STDERR_ECHO_TARGET {
            return;
        }
        let Some(hub) = self.hub.clone().or_else(hub) else {
            return;
        };
        let mut capture = EventCapture::default();
        event.record(&mut capture);
        hub.push(
            crate::time::Timestamp::now(),
            level_name(event.metadata().level()),
            event.metadata().target(),
            capture.session,
            capture.message,
            capture.fields,
        );
    }
}

fn level_name(level: &tracing::Level) -> &'static str {
    match *level {
        tracing::Level::TRACE => "trace",
        tracing::Level::DEBUG => "debug",
        tracing::Level::INFO => "info",
        tracing::Level::WARN => "warn",
        tracing::Level::ERROR => "error",
    }
}

#[derive(Default)]
struct EventCapture {
    message: String,
    session: Option<String>,
    fields: Map<String, Value>,
}

impl tracing::field::Visit for EventCapture {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        match field.name() {
            "message" => self.message.push_str(value),
            "session" if self.session.is_none() => self.session = Some(value.to_string()),
            name => {
                self.fields
                    .insert(name.to_string(), Value::String(value.to_string()));
            }
        }
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        match field.name() {
            "message" if self.message.is_empty() => self.message = format!("{value:?}"),
            name => {
                self.fields
                    .insert(name.to_string(), Value::String(format!("{value:?}")));
            }
        }
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), Value::from(value));
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.fields
            .insert(field.name().to_string(), Value::from(value));
    }

    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        self.fields
            .insert(field.name().to_string(), Value::from(value));
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.fields
            .insert(field.name().to_string(), Value::from(value));
    }

    fn record_error(
        &mut self,
        field: &tracing::field::Field,
        value: &(dyn std::error::Error + 'static),
    ) {
        self.fields
            .insert(field.name().to_string(), Value::String(value.to_string()));
    }
}

// ── R8（P2-3）：前端日志输入限制 ──

/// 前端日志 message 限长（比通用 8KB 更紧，前端日志仅调试用途）。
pub const FRONTEND_LOG_MAX_MESSAGE: usize = 1024;
/// 前端日志 fields 单个字符串值限长。
pub const FRONTEND_LOG_MAX_FIELD_STRING: usize = 512;
/// 前端日志每秒上限（超限丢弃并返回错误，防刷掉重要后端日志）。
pub const FRONTEND_LOG_RATE_LIMIT: u32 = 20;

/// R8：前端日志限流窗口（AppState 持有；每秒最多 [`FRONTEND_LOG_RATE_LIMIT`] 条）。
#[derive(Debug, Default)]
pub struct FrontendLogThrottle {
    pub window_start_ms: u64,
    pub count: u32,
}

/// R8：前端日志限流判定——放行则计数 +1 返回 true；超限返回 false（调用方丢弃）。
/// 窗口滚动逻辑内聚于此（可单测）；logs_cmds::push_frontend_log 使用。
pub fn frontend_log_allowed(throttle: &mut FrontendLogThrottle, now_ms: u64) -> bool {
    if now_ms.saturating_sub(throttle.window_start_ms) >= 1000 {
        throttle.window_start_ms = now_ms;
        throttle.count = 0;
    }
    if throttle.count >= FRONTEND_LOG_RATE_LIMIT {
        return false;
    }
    throttle.count += 1;
    true
}

/// R8：前端日志 message 限长截断。
pub fn truncate_frontend_message(message: &str) -> String {
    truncate(message.to_string(), FRONTEND_LOG_MAX_MESSAGE)
}

/// R8：fields 字符串值限长截断（数字/布尔本就远小于上限，保持类型不变）。
pub fn truncate_frontend_fields(fields: Map<String, Value>) -> Map<String, Value> {
    fields
        .into_iter()
        .map(|(key, value)| {
            let value = match value {
                Value::String(text) => Value::String(truncate(text, FRONTEND_LOG_MAX_FIELD_STRING)),
                other => other,
            };
            (key, value)
        })
        .collect()
}

fn truncate(value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes.saturating_sub(3);
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &value[..end])
}

/// R21：脱敏实现统一到 crate::sanitize（策略参数化：runtime_log 走 Redact）。
/// 此处仅保留 push/acp/permission 与测试所需的薄包装，hub 区（43-150）零改动。
pub(crate) fn sanitize_message(message: String) -> String {
    crate::sanitize::sanitize_message(message)
}

fn sanitize_fields(fields: Map<String, Value>) -> Map<String, Value> {
    crate::sanitize::sanitize_fields(fields)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tracing_subscriber::layer::Layer;

    // ── R8（P2-3）：前端日志限流与截断 ──

    #[test]
    fn frontend_log_allows_limit_per_second_then_denies() {
        let mut throttle = FrontendLogThrottle::default();
        let now = 1_000_000u64;
        for i in 0..FRONTEND_LOG_RATE_LIMIT {
            assert!(frontend_log_allowed(&mut throttle, now), "第 {i} 条应放行");
        }
        assert!(
            !frontend_log_allowed(&mut throttle, now),
            "同窗口超限必须拒绝"
        );
        // 下一窗口滚动后恢复
        assert!(frontend_log_allowed(&mut throttle, now + 1000));
    }

    #[test]
    fn frontend_log_truncates_message_and_field_strings() {
        let long = "x".repeat(FRONTEND_LOG_MAX_MESSAGE + 100);
        let truncated = truncate_frontend_message(&long);
        assert!(truncated.len() < long.len());
        assert!(truncated.ends_with("..."));

        let fields = truncate_frontend_fields(Map::from_iter([
            (
                "big".to_string(),
                Value::String("y".repeat(FRONTEND_LOG_MAX_FIELD_STRING + 100)),
            ),
            ("num".to_string(), Value::from(42)),
            ("flag".to_string(), Value::Bool(true)),
        ]));
        let big = fields.get("big").unwrap().as_str().unwrap();
        assert!(big.len() < FRONTEND_LOG_MAX_FIELD_STRING + 100);
        assert!(big.ends_with("..."));
        assert_eq!(fields.get("num").unwrap(), &Value::from(42), "数字类型不变");
        assert_eq!(
            fields.get("flag").unwrap(),
            &Value::Bool(true),
            "布尔类型不变"
        );
    }

    #[test]
    fn frontend_log_short_messages_pass_through_unchanged() {
        let message = "short message";
        assert_eq!(truncate_frontend_message(message), message);
    }

    fn fields(values: &[(&str, Value)]) -> Map<String, Value> {
        values
            .iter()
            .map(|(key, value)| ((*key).to_string(), value.clone()))
            .collect()
    }

    fn layer_subscriber(
        hub: Arc<RuntimeLogHub>,
    ) -> impl tracing::Subscriber + Send + Sync + 'static {
        RuntimeLogLayer::with_hub(hub).with_subscriber(
            tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .finish(),
        )
    }

    #[test]
    fn ring_buffer_keeps_latest_entries_and_monotonic_ids() {
        let hub = RuntimeLogHub::new(2);
        hub.push(Timestamp::new(1), "info", "a", None, "one", Map::new());
        hub.push(Timestamp::new(2), "info", "a", None, "two", Map::new());
        hub.push(Timestamp::new(3), "info", "a", None, "three", Map::new());
        let entries = hub.list(&RuntimeLogQuery::default());
        assert_eq!(
            entries.iter().map(|entry| entry.id).collect::<Vec<_>>(),
            vec![3, 2]
        );
        assert_eq!(entries[0].message, "three");
    }

    #[test]
    fn filters_by_level_source_session_and_search() {
        let hub = RuntimeLogHub::default();
        hub.push(
            Timestamp::new(1),
            "error",
            "acp",
            Some("a".into()),
            "Parse failed",
            Map::new(),
        );
        hub.push(
            Timestamp::new(2),
            "info",
            "ui",
            Some("b".into()),
            "Clicked",
            Map::new(),
        );
        let query = RuntimeLogQuery {
            level: Some("error".into()),
            source: Some("acp".into()),
            session: Some("a".into()),
            search: Some("parse".into()),
            limit: Some(10),
        };
        assert_eq!(hub.list(&query).len(), 1);
    }

    #[test]
    fn query_level_and_source_are_case_insensitive() {
        // O25：大写 LEVEL/SOURCE 查询命中小写存储。
        let hub = RuntimeLogHub::default();
        hub.push(
            Timestamp::new(1),
            "error",
            "acp",
            None,
            "Parse failed",
            Map::new(),
        );
        let query = RuntimeLogQuery {
            level: Some("ERROR".into()),
            source: Some("ACP".into()),
            session: None,
            search: None,
            limit: Some(10),
        };
        assert_eq!(hub.list(&query).len(), 1);
    }

    #[test]
    fn search_matches_values_but_not_field_keys() {
        // O25：search 命中字段值，不命中字段 key。
        let hub = RuntimeLogHub::default();
        hub.push(
            Timestamp::new(1),
            "info",
            "acp",
            None,
            "safe message",
            fields(&[("parseKey", json!("value-with-needle"))]),
        );
        let by_key = RuntimeLogQuery {
            level: None,
            source: None,
            session: None,
            search: Some("parseKey".into()),
            limit: Some(10),
        };
        assert!(hub.list(&by_key).is_empty(), "search 不得命中字段 key");
        let by_value = RuntimeLogQuery {
            level: None,
            source: None,
            session: None,
            search: Some("needle".into()),
            limit: Some(10),
        };
        assert_eq!(hub.list(&by_value).len(), 1, "search 必须命中字段值");
    }

    #[test]
    fn does_not_redact_suffix_shared_key_names() {
        // O26：tokensTotal 等共享后缀名不再整体 REDACTED；password 仍脱敏。
        let hub = RuntimeLogHub::default();
        let entry = hub.push(
            Timestamp::new(1),
            "info",
            "acp",
            None,
            "safe",
            fields(&[
                ("tokensTotal", json!(42)),
                ("password", json!("hunter2")),
                ("access_token", json!("abc")),
            ]),
        );
        assert_eq!(
            entry.fields["tokensTotal"],
            json!(42),
            "tokensTotal 不得整体脱敏"
        );
        assert_eq!(
            entry.fields["password"],
            json!(REDACTED),
            "password 必须脱敏"
        );
        assert_eq!(
            entry.fields["access_token"],
            json!(REDACTED),
            "access_token 必须脱敏"
        );
    }

    #[test]
    fn redacts_sensitive_fields_and_truncates_message() {
        let hub = RuntimeLogHub::default();
        let entry = hub.push(
            Timestamp::new(1),
            "warn",
            "acp",
            None,
            "x".repeat(9000),
            fields(&[
                ("apiKey", json!("secret-value")),
                (
                    "nested",
                    json!({"authorization": "Bearer abc", "result": "safe"}),
                ),
            ]),
        );
        assert!(entry.message.len() <= MAX_MESSAGE_BYTES);
        assert_eq!(entry.fields["apiKey"], json!(REDACTED));
        assert_eq!(entry.fields["nested"]["authorization"], json!(REDACTED));
        assert_eq!(entry.fields["nested"]["result"], json!("safe"));
    }

    #[test]
    fn keeps_safe_diagnostic_words_in_message() {
        let hub = RuntimeLogHub::default();
        let entry = hub.push(
            Timestamp::new(1),
            "info",
            "runtime",
            None,
            "Prompt started; contentLength=42",
            Map::new(),
        );
        assert_eq!(entry.message, "Prompt started; contentLength=42");
    }

    #[test]
    fn redacts_sensitive_message_payload_markers() {
        let hub = RuntimeLogHub::default();
        for message in ["token=abc", "authorization: Bearer abc", "persona: hidden"] {
            let entry = hub.push(
                Timestamp::new(1),
                "error",
                "runtime",
                None,
                message,
                Map::new(),
            );
            assert_eq!(entry.message, REDACTED);
        }
    }

    #[test]
    fn redacts_bearer_and_json_token_shapes() {
        // 审查修复回归：无前缀 Bearer / JSON token 形态也必须脱敏
        let hub = RuntimeLogHub::default();
        for message in [
            "Bearer sk-abc123",
            "x-api-key: 12345",
            r#"{"token":"sk-abc"}"#,
            r#"{"data":{"apiKey":"sk-abc"}}"#,
            "client_secret=abc",
            "access_token=abc",
        ] {
            let entry = hub.push(
                Timestamp::new(1),
                "error",
                "runtime",
                None,
                message,
                Map::new(),
            );
            assert_eq!(entry.message, REDACTED, "message {message:?} 必须脱敏");
        }
    }

    #[test]
    fn redacts_delimiter_variants_and_bare_secrets() {
        // A12 回归：分隔符变体（含全角、含空白）与裸 secret 前缀形态必须脱敏
        let hub = RuntimeLogHub::default();
        for message in [
            "token: abc",
            "token = abc",
            "token：abc",
            "token ＝ abc",
            "sk-abc123",
            "ghp_abcdef",
            r#"{"data":"sk-abc"}"#,
            "x-api-key: 12345",
        ] {
            let entry = hub.push(
                Timestamp::new(1),
                "error",
                "runtime",
                None,
                message,
                Map::new(),
            );
            assert_eq!(entry.message, REDACTED, "message {message:?} 必须脱敏");
        }
        let safe = hub.push(
            Timestamp::new(2),
            "info",
            "runtime",
            None,
            "tokensTotal=42; prompt started",
            Map::new(),
        );
        assert_eq!(safe.message, "tokensTotal=42; prompt started");
    }

    #[test]
    fn value_content_redacts_variants_and_bare_secrets() {
        // A12 回归：值内容脱敏与消息脱敏共用检测，`token：`/裸 eyj 前缀等均覆盖
        // R21：实现已统一到 crate::sanitize，测试直接调用公共模块。
        assert_eq!(
            crate::sanitize::sanitize_value_content("token：abc"),
            REDACTED
        );
        assert_eq!(
            crate::sanitize::sanitize_value_content("token = abc"),
            REDACTED
        );
        assert_eq!(
            crate::sanitize::sanitize_value_content(r#"{"data":"sk-abc"}"#),
            REDACTED
        );
        assert_eq!(
            crate::sanitize::sanitize_value_content("eyJhbGciOiJIUzI1NiJ9"),
            REDACTED
        );
        assert_eq!(
            crate::sanitize::sanitize_value_content("tokenCount=5"),
            "tokenCount=5"
        );
        assert_eq!(
            crate::sanitize::sanitize_value_content("contentLength=42"),
            "contentLength=42"
        );
    }

    #[test]
    fn redacts_sensitive_content_inside_field_values() {
        // 审查修复回归：非敏感 key 下的敏感值内容也必须脱敏
        let hub = RuntimeLogHub::default();
        let entry = hub.push(
            Timestamp::new(1),
            "warn",
            "acp",
            None,
            "safe message",
            fields(&[
                ("detail", json!("api_key=sk-123")),
                ("items", json!(["Bearer secret-token", "safe"])),
                ("ok", json!("fine")),
            ]),
        );
        assert_eq!(
            entry.fields["detail"],
            json!(REDACTED),
            "值内 api_key= 必须脱敏"
        );
        assert_eq!(
            entry.fields["items"][0],
            json!(REDACTED),
            "数组内 Bearer 必须脱敏"
        );
        assert_eq!(entry.fields["items"][1], json!("safe"));
        assert_eq!(entry.fields["ok"], json!("fine"));
    }

    #[test]
    fn clear_keeps_id_sequence() {
        let hub = RuntimeLogHub::default();
        let first = hub.push(Timestamp::new(1), "info", "test", None, "first", Map::new());
        hub.clear();
        let second = hub.push(
            Timestamp::new(2),
            "info",
            "test",
            None,
            "second",
            Map::new(),
        );
        assert!(second.id > first.id);
        assert_eq!(hub.list(&RuntimeLogQuery::default()).len(), 1);
    }

    #[tokio::test]
    async fn subscribers_receive_sanitized_entries_after_ring_write() {
        let hub = RuntimeLogHub::new(2);
        let mut events = hub.subscribe();
        let entry = hub.push(
            Timestamp::new(1),
            "error",
            "acp",
            None,
            "token=hidden",
            fields(&[("nested", json!({"apiKey": "secret"}))]),
        );
        let event = events.recv().await.expect("log event should be published");
        assert_eq!(event.as_ref(), &entry);
        assert_eq!(event.message, REDACTED);
        assert_eq!(event.fields["nested"]["apiKey"], json!(REDACTED));
        assert_eq!(hub.list(&RuntimeLogQuery::default()).first(), Some(&entry));
    }

    #[test]
    fn tracing_layer_forwards_events_to_registered_hub() {
        // R18：Layer 转发形状——level / source=target / message / fields；
        // sanitize 在 push 层生效（敏感 key 字段 → REDACTED）。
        let hub = RuntimeLogHub::new(16);
        tracing::subscriber::with_default(layer_subscriber(hub.clone()), || {
            let api_key = "abc123".to_string();
            // 0.1.44：inline `{name}` 只做消息插值不生成字段；显式 `name = %expr` 才记录字段。
            tracing::warn!(api_key = %api_key, "connect failed: {api_key} retry={}", 2);
        });
        let entries = hub.list(&RuntimeLogQuery::default());
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.level, "warn");
        assert!(
            entry.source.contains("runtime_log"),
            "source 应为 target: {}",
            entry.source
        );
        assert_eq!(entry.message, "connect failed: abc123 retry=2");
        assert_eq!(entry.fields["api_key"], json!(REDACTED));
    }

    #[test]
    fn tracing_layer_caps_level_and_reads_session_field() {
        // R18：INFO 以下不进 hub；session 由 event field 传递并抽取。
        let hub = RuntimeLogHub::new(16);
        tracing::subscriber::with_default(layer_subscriber(hub.clone()), || {
            let session = "s-1";
            tracing::debug!("dropped below INFO cap");
            tracing::info!(session, "session started");
        });
        let entries = hub.list(&RuntimeLogQuery::default());
        assert_eq!(entries.len(), 1);
        let entry = &entries[0];
        assert_eq!(entry.level, "info");
        assert_eq!(entry.session.as_deref(), Some("s-1"));
        assert_eq!(entry.message, "session started");
    }

    #[test]
    fn layer_skips_agent_stderr_echo_target_but_keeps_other_errors() {
        // LOG-01：agent stderr 行回声（target=AGENT_STDERR_ECHO_TARGET）只作 console
        // 出口、不进 hub（hub 唯一归属 = stderr reader 显式 push）；普通 error 事件仍进。
        let hub = RuntimeLogHub::new(16);
        tracing::subscriber::with_default(layer_subscriber(hub.clone()), || {
            tracing::error!(
                target: AGENT_STDERR_ECHO_TARGET,
                "fake-acp stderr: boom"
            );
            tracing::error!("real diagnostic: db full");
        });
        let entries = hub.list(&RuntimeLogQuery::default());
        assert_eq!(entries.len(), 1, "echo target 不得进 hub");
        let entry = &entries[0];
        assert_eq!(entry.level, "error");
        assert!(
            entry.message.contains("real diagnostic"),
            "普通 error 事件仍进 hub: {}",
            entry.message
        );
    }

    #[test]
    fn push_with_correlation_embeds_identity_and_absent_when_none() {
        // OBS-02：RuntimeLogHub 日志传输携带统一身份；correlation=None 时
        // wire 不新增字段（旧 UI 兼容），缺失字段不使日志命令失败。
        let hub = RuntimeLogHub::new(8);
        let corr = crate::correlation::RuntimeCorrelation {
            agent_id: "hermes-a".into(),
            provider: Some("openai".into()),
            source: "subprocess".into(),
            local_session_id: Some("local-1".into()),
            remote_session_id: Some("remote-1".into()),
            peri_id: Some("peri-1".into()),
            client_generation: 5,
            request_id: Some("perm-9".into()),
            tool_call_id: Some("tc-9".into()),
        };
        let with_corr = hub.push_with_correlation(
            Timestamp::new(1),
            "error",
            "agent-stderr",
            None,
            "boom",
            Map::new(),
            Some(corr.clone()),
        );
        assert_eq!(with_corr.correlation.as_ref(), Some(&corr));

        let plain = hub.push(Timestamp::new(2), "info", "acp", None, "ok", Map::new());
        assert_eq!(plain.correlation, None, "旧 push 不带 correlation");

        // wire 形状：带 correlation 时序列化出 correlation 对象；缺省时无该键。
        let with_json = serde_json::to_value(&with_corr).expect("serialize");
        assert_eq!(
            with_json["correlation"]["agentId"],
            json!("hermes-a"),
            "correlation 必须进 wire"
        );
        assert_eq!(with_json["correlation"]["clientGeneration"], json!(5));
        let plain_json = serde_json::to_value(&plain).expect("serialize");
        assert!(
            plain_json.get("correlation").is_none(),
            "correlation=None 时不得序列化该键（旧 UI 兼容）"
        );
        // 缺失 correlation 键的反序列化必须成功（旧字段缺失不失败）。
        let revived: RuntimeLogEntry = serde_json::from_value(plain_json).expect("deserialize");
        assert_eq!(revived.correlation, None);
    }

    #[test]
    fn push_with_context_embeds_incremental_fields() {
        // LOG-03：push_with_context 把 code/category/recoverable/userActionRequired/
        // rawAvailable 带进条目（方案书 §5.14 增量字段）。
        let hub = RuntimeLogHub::new(8);
        let entry = hub.push_with_context(
            Timestamp::new(1),
            "error",
            "agent-stderr",
            None,
            "boom",
            Map::new(),
            None,
            RuntimeLogContext {
                code: Some("agent_crashed".into()),
                category: Some(LOG_CATEGORY_STDERR.into()),
                recoverable: Some(false),
                user_action_required: Some(true),
                raw_available: Some(true),
            },
        );
        assert_eq!(entry.code.as_deref(), Some("agent_crashed"));
        assert_eq!(entry.category.as_deref(), Some(LOG_CATEGORY_STDERR));
        assert_eq!(entry.recoverable, Some(false));
        assert_eq!(entry.user_action_required, Some(true));
        assert_eq!(entry.raw_available, Some(true));
    }

    #[test]
    fn push_with_context_serializes_incremental_fields_camel_case_and_omits_none() {
        // LOG-03：增量字段 camelCase 上 wire；缺省字段因 skip_serializing_if 不得出现
        //（旧 UI 不认识的键缺失不影响解析，OBS-02 兼容性纪律）。
        let hub = RuntimeLogHub::new(8);
        let entry = hub.push_with_context(
            Timestamp::new(1),
            "error",
            "agent-stderr",
            None,
            "boom",
            Map::new(),
            None,
            RuntimeLogContext {
                code: Some("agent_crashed".into()),
                category: Some(LOG_CATEGORY_STDERR.into()),
                raw_available: Some(true),
                ..Default::default()
            },
        );
        let json = serde_json::to_value(&entry).expect("serialize");
        let map = json.as_object().expect("object");
        assert_eq!(map["code"], json!("agent_crashed"));
        assert_eq!(map["category"], json!("stderr"));
        assert_eq!(map["rawAvailable"], json!(true));
        assert!(!map.contains_key("recoverable"), "缺省字段不得上 wire");
        assert!(
            !map.contains_key("userActionRequired"),
            "缺省字段不得上 wire"
        );
        // 缺省 context（push_with_correlation 路径）→ 全部增量键缺席。
        let plain = hub.push_with_correlation(
            Timestamp::new(2),
            "info",
            "acp",
            None,
            "ok",
            Map::new(),
            None,
        );
        let plain_json = serde_json::to_value(&plain).expect("serialize");
        let plain_map = plain_json.as_object().expect("object");
        for key in [
            "code",
            "category",
            "recoverable",
            "userActionRequired",
            "rawAvailable",
        ] {
            assert!(
                !plain_map.contains_key(key),
                "缺省 context 不得序列化 {key}（旧 UI 兼容）"
            );
        }
        // 旧 wire（无增量键）反序列化成功且缺省为 None。
        let revived: RuntimeLogEntry = serde_json::from_value(plain_json).expect("deserialize");
        assert_eq!(revived.code, None);
        assert_eq!(revived.category, None);
        assert_eq!(revived.raw_available, None);
    }

    #[test]
    fn log_context_default_is_all_none() {
        // LOG-03：RuntimeLogContext::default() 全部 None——push_with_correlation 委托
        // 到 push_with_context 时不得夹带任何增量字段。
        let context = RuntimeLogContext::default();
        assert_eq!(context.code, None);
        assert_eq!(context.category, None);
        assert_eq!(context.recoverable, None);
        assert_eq!(context.user_action_required, None);
        assert_eq!(context.raw_available, None);
    }
}
