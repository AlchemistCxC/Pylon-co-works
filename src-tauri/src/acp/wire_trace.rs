//! OBS-01：ACP wire 只读记录器（read-only wire recorder）。
//! OBS-02：记录完整 correlation context（agentId/provider/source/localSessionId/
//! remoteSessionId/periId/clientGeneration/requestId/toolCallId，方案书 §5.2）。
//!
//! 在 transport 边界（writer→stdin / stdout reader）记录一条完整协议时间线，
//! 且**不修改任何 ACP 业务行为**。核心约束：
//!
//! - 必须在反序列化成 `u64` **之前**记录，否则 string/null id 已经丢失——
//!   记录入口接收原始 JSON `Value`，自行区分 `idKind: number|string|null|absent`。
//! - 记录失败/被禁用绝不影响正常 ACP 流：`record()` 为 infallible、best-effort，
//!   启用状态为 fast-path no-op；ring buffer 固定容量，满时覆盖最旧。
//! - 不依赖前端 UI 是否打开；记录发生在 transport/dispatcher 边界。
//! - 脱敏采用 `SanitizePolicy::Redact`（只 REDACT 敏感 key 与 secret 形态，
//!   不改写 id、method、params 结构字段；纪律 0.2-5）。

use ringbuffer::{AllocRingBuffer, RingBuffer};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::correlation::RuntimeCorrelation;
use crate::time::Timestamp;

/// 单条记录器默认容量（满时覆盖最旧，防止无界增长）。
pub const DEFAULT_WIRE_TRACE_CAPACITY: usize = 4096;

/// 连接级 trace id 分配器（跨连接唯一，用于区分多次连接）。
static NEXT_TRACE_ID: OnceLock<AtomicU64> = OnceLock::new();

fn next_trace_id() -> u64 {
    NEXT_TRACE_ID
        .get_or_init(|| AtomicU64::new(1))
        .fetch_add(1, Ordering::Relaxed)
}

/// wire 方向（以 Pylon 客户端为观察者）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireDirection {
    PylonToAgent,
    AgentToPylon,
}

/// 请求 id 的原始形态（OBS-01 核心：不在反序列化 u64 后记录）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WireIdKind {
    Number,
    String,
    Null,
    Absent,
}

// 身份上下文统一为 [`crate::correlation::RuntimeCorrelation`]（OBS-02）：
// 连接级字段（agentId/provider/source/clientGeneration）在 hub 构造时固定，
// 会话级字段（remoteSessionId/periId/requestId/toolCallId）逐条报文提取，
// localSessionId 由上层会话映射供给（transport 边界不可知）。

/// 单条脱敏 wire 记录（保留原始字段形态，只 REDACT secret）。
/// OBS-02：携带完整 correlation context——连接级字段来自 hub 构造时的
/// [`RuntimeCorrelation`]，会话级字段逐条 best-effort 提取。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WireRecord {
    pub trace_id: String,
    /// 单调递增序号（同一 trace 内按发送/接收顺序分配）。
    /// CR-003：方案书 §5.1 字段名对齐（monotonicSeq）。
    pub monotonic_seq: u64,
    pub timestamp: Timestamp,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    /// source 不是 owner——与 agentId + clientGeneration 合看。
    pub source: String,
    /// Pylon 侧本地会话键（transport 边界不可知，由上层映射供给）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_session_id: Option<String>,
    /// Agent 侧远端会话 id（best-effort 从 params/result 提取的 sessionId）。
    /// 与 local_session_id 分字段（remote ≠ local，方案书 §5.2）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_session_id: Option<String>,
    /// session/update 事件中 Agent 上报的会话 id（Peri 侧视角）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peri_id: Option<String>,
    /// 连接所属 client 代际（runtime replacement 时递增）。
    pub client_generation: u64,
    /// session/request_permission 的请求 id（wire 的 `id`，字符串形态）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub direction: WireDirection,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    pub id_kind: WireIdKind,
    /// 原始 JSON id 值（number|string|null），absent 时为 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_value: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
    /// best-effort 从 params/result 提取的 toolCallId。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// `sent`（pylon->agent）/ `received`（agent->pylon）。
    pub status: String,
}

/// 单 agent 的 wire trace 环形缓冲（容量上限，满时覆盖最旧）。
/// OBS-02：持有完整连接级 correlation context（agentId/provider/source/
/// clientGeneration 构造时固定）。
pub struct AcpWireHub {
    correlation: RuntimeCorrelation,
    trace_id: String,
    next_seq: AtomicU64,
    enabled: AtomicBool,
    records: Mutex<AllocRingBuffer<Arc<WireRecord>>>,
    capacity: usize,
}

impl AcpWireHub {
    pub fn new(correlation: RuntimeCorrelation, capacity: usize) -> Arc<Self> {
        Arc::new(Self {
            trace_id: format!("{}-{}", correlation.agent_id, next_trace_id()),
            correlation,
            next_seq: AtomicU64::new(1),
            enabled: AtomicBool::new(true),
            records: Mutex::new(AllocRingBuffer::new(capacity.max(1))),
            capacity: capacity.max(1),
        })
    }

    /// 从 AgentDef 构造（默认容量；client_generation 为连接所属代际）。
    /// 连接方在 `connect_with_logs`/`connect_with_generation` 使用。
    pub fn for_agent(agent: &crate::agent_config::AgentDef, client_generation: u64) -> Arc<Self> {
        Self::new(
            RuntimeCorrelation::from_agent(agent, client_generation),
            DEFAULT_WIRE_TRACE_CAPACITY,
        )
    }

    pub fn trace_id(&self) -> &str {
        &self.trace_id
    }

    /// OBS-02：连接级 correlation context（stderr/runtime log 共享同一身份）。
    pub fn correlation(&self) -> &RuntimeCorrelation {
        &self.correlation
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn len(&self) -> usize {
        self.records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    /// 记录一条原始 JSON 报文（必须是在 u64 窄化**之前**的原始 Value）。
    /// infallible：任何内部失败都静默跳过，绝不阻断业务。
    pub fn record(&self, direction: WireDirection, msg_val: &serde_json::Value) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let record = build_record(
            &self.trace_id,
            &self.correlation,
            self.next_seq.fetch_add(1, Ordering::Relaxed),
            direction,
            msg_val,
        );
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if records.len() >= self.capacity {
            // 明确覆盖最旧（与 RuntimeLogHub 语义一致）。
            records.dequeue();
        }
        records.enqueue(Arc::new(record));
    }

    /// 记录一条已序列化的 outbound 行（writer 边界调用；解析失败静默跳过）。
    pub fn record_line(&self, direction: WireDirection, line: &str) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let Ok(msg_val) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        self.record(direction, &msg_val);
    }

    /// 当前全部记录快照（旧→新，monotonicSeq 严格递增）。
    /// CR-001：seq 在 records 锁外分配，并发下 enqueue 落序可能偏离 seq 序——
    /// 快照返回前按 monotonicSeq 排齐，消费方可直接依赖 seq 全序。
    pub fn snapshot(&self) -> Vec<WireRecord> {
        let records = self
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        order_snapshot(
            records
                .iter()
                .cloned()
                .map(|record| (*record).clone())
                .collect(),
        )
    }
}

/// 按 monotonicSeq 排序（CR-001：seq 分配与 enqueue 非原子的落序修正）。
fn order_snapshot(mut records: Vec<WireRecord>) -> Vec<WireRecord> {
    records.sort_unstable_by_key(|record| record.monotonic_seq);
    records
}

fn build_record(
    trace_id: &str,
    correlation: &RuntimeCorrelation,
    seq: u64,
    direction: WireDirection,
    msg_val: &serde_json::Value,
) -> WireRecord {
    let method = msg_val
        .get("method")
        .and_then(|value| value.as_str())
        .map(|s| s.to_string());
    let (id_kind, id_value) = classify_id(msg_val.get("id"));
    let params = msg_val
        .get("params")
        .cloned()
        .map(|value| sanitize_wire(value));
    let result = msg_val
        .get("result")
        .cloned()
        .map(|value| sanitize_wire(value));
    let error = msg_val
        .get("error")
        .cloned()
        .map(|value| sanitize_wire(value));
    // 远端会话 id：best-effort 从 params/result 提取的 sessionId（原 session_id）。
    let remote_session_id = extract_first_string(msg_val, &["sessionId", "session_id"]);
    // periId：session/update 事件中 Agent 上报的会话 id（与 remoteSessionId 同为
    // Agent 侧 id，语义是"更新事件视角"，分列便于对账；方案书 §5.2）。
    let peri_id = if method.as_deref() == Some(super::NOTIF_SESSION_UPDATE) {
        remote_session_id.clone()
    } else {
        None
    };
    // requestId：session/request_permission 的请求 id（wire 的 `id`，字符串形态；
    // number id 字符串化，供上层 correlation 统一为 string）。
    let request_id = if method.as_deref() == Some(super::METHOD_SESSION_REQUEST_PERMISSION) {
        match id_value.as_ref() {
            Some(serde_json::Value::String(value)) => Some(value.clone()),
            Some(other) if other.is_number() => Some(other.to_string()),
            _ => None,
        }
    } else {
        None
    };
    let tool_call_id = extract_first_string(msg_val, &["toolCallId", "tool_call_id"]);
    WireRecord {
        trace_id: trace_id.to_string(),
        monotonic_seq: seq,
        timestamp: Timestamp::now(),
        agent_id: correlation.agent_id.clone(),
        provider: correlation.provider.clone(),
        source: correlation.source.clone(),
        local_session_id: correlation.local_session_id.clone(),
        remote_session_id,
        peri_id,
        client_generation: correlation.client_generation,
        request_id,
        direction,
        method,
        id_kind,
        id_value,
        params,
        result,
        error,
        tool_call_id,
        status: match direction {
            WireDirection::PylonToAgent => "sent".to_string(),
            WireDirection::AgentToPylon => "received".to_string(),
        },
    }
}

/// 在 u64 窄化之前分类 id：number|string|null|absent（畸形形态保留原始值，分类 Absent）。
fn classify_id(id: Option<&serde_json::Value>) -> (WireIdKind, Option<serde_json::Value>) {
    match id {
        None => (WireIdKind::Absent, None),
        Some(value) if value.is_number() => (WireIdKind::Number, Some(value.clone())),
        Some(value) if value.is_string() => (WireIdKind::String, Some(value.clone())),
        Some(value) if value.is_null() => (WireIdKind::Null, Some(value.clone())),
        Some(other) => (WireIdKind::Absent, Some(other.clone())),
    }
}

/// 脱敏：Redact 策略（只 REDACT secret，不改写结构字段）。
fn sanitize_wire(value: serde_json::Value) -> serde_json::Value {
    crate::sanitize::sanitize_value(crate::sanitize::SanitizePolicy::Redact, "params", value)
        .unwrap_or_else(|| serde_json::Value::String(crate::sanitize::REDACTED.to_string()))
}

/// 在整条报文（params/result 子树）中按候选 key 顺序递归查找第一个字符串值。
/// 递归限深（ACP wire 结构浅，16 层足够且防止畸形嵌套打爆栈）。
fn extract_first_string(msg_val: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(found) = find_string(msg_val, key, 0) {
            return Some(found);
        }
    }
    None
}

fn find_string(value: &serde_json::Value, key: &str, depth: usize) -> Option<String> {
    if depth > 16 {
        return None;
    }
    match value {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                if k == key {
                    if let Some(s) = v.as_str() {
                        return Some(s.to_string());
                    }
                }
            }
            for (_, v) in map {
                if let Some(found) = find_string(v, key, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        serde_json::Value::Array(items) => {
            for item in items {
                if let Some(found) = find_string(item, key, depth + 1) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hub() -> Arc<AcpWireHub> {
        AcpWireHub::new(
            RuntimeCorrelation {
                agent_id: "test-agent".into(),
                provider: Some("fake".into()),
                source: "subprocess".into(),
                local_session_id: None,
                remote_session_id: None,
                peri_id: None,
                client_generation: 3,
                request_id: None,
                tool_call_id: None,
            },
            8,
        )
    }

    fn identity_fields(record: &WireRecord) -> Vec<&str> {
        vec![
            record.agent_id.as_str(),
            record.provider.as_deref().unwrap_or(""),
            record.source.as_str(),
        ]
    }

    #[test]
    fn preserves_number_string_null_absent_id_kinds() {
        let hub = hub();
        hub.record(
            WireDirection::AgentToPylon,
            &json!({"jsonrpc":"2.0","id":7,"result":{}}),
        );
        hub.record(
            WireDirection::AgentToPylon,
            &json!({"jsonrpc":"2.0","id":"req-abc","result":{}}),
        );
        hub.record(
            WireDirection::AgentToPylon,
            &json!({"jsonrpc":"2.0","id":null,"result":null}),
        );
        hub.record(
            WireDirection::AgentToPylon,
            &json!({"jsonrpc":"2.0","method":"session/update","params":{}}),
        );
        let snap = hub.snapshot();
        assert_eq!(snap.len(), 4);
        assert_eq!(snap[0].id_kind, WireIdKind::Number);
        assert_eq!(snap[0].id_value, Some(json!(7)));
        assert_eq!(snap[1].id_kind, WireIdKind::String);
        assert_eq!(snap[1].id_value, Some(json!("req-abc")));
        assert_eq!(snap[2].id_kind, WireIdKind::Null);
        assert_eq!(snap[2].id_value, Some(serde_json::Value::Null));
        assert_eq!(snap[3].id_kind, WireIdKind::Absent);
        assert_eq!(snap[3].id_value, None);
    }

    #[test]
    fn records_monotonic_seq_and_identity() {
        let hub = hub();
        hub.record(
            WireDirection::PylonToAgent,
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
        );
        hub.record(
            WireDirection::AgentToPylon,
            &json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}),
        );
        hub.record(
            WireDirection::PylonToAgent,
            &json!({"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{"sessionId":"s-1"}}),
        );
        let snap = hub.snapshot();
        let seqs: Vec<u64> = snap.iter().map(|r| r.monotonic_seq).collect();
        assert_eq!(seqs, vec![1, 2, 3], "seq 必须单调递增");
        assert_eq!(snap[0].direction, WireDirection::PylonToAgent);
        assert_eq!(snap[0].status, "sent");
        assert_eq!(snap[1].direction, WireDirection::AgentToPylon);
        assert_eq!(snap[1].status, "received");
        for record in &snap {
            assert_eq!(
                identity_fields(record),
                vec!["test-agent", "fake", "subprocess"],
                "identity 必须逐条保留"
            );
            assert_eq!(record.client_generation, 3, "clientGeneration 必须逐条保留");
        }
        assert_eq!(snap[2].remote_session_id.as_deref(), Some("s-1"));
    }

    #[test]
    fn disabled_trace_records_nothing() {
        let hub = hub();
        hub.set_enabled(false);
        hub.record(
            WireDirection::AgentToPylon,
            &json!({"jsonrpc":"2.0","id":"x","result":{}}),
        );
        assert_eq!(hub.snapshot().len(), 0, "关闭时不得记录");
        hub.set_enabled(true);
        hub.record(
            WireDirection::AgentToPylon,
            &json!({"jsonrpc":"2.0","id":"x","result":{}}),
        );
        assert_eq!(hub.snapshot().len(), 1, "重新启用后继续记录");
    }

    #[test]
    fn ring_buffer_drops_oldest_when_full() {
        let hub = hub();
        for i in 0..10u64 {
            hub.record(
                WireDirection::AgentToPylon,
                &json!({"jsonrpc":"2.0","id":i,"result":{}}),
            );
        }
        let snap = hub.snapshot();
        assert_eq!(snap.len(), 8, "容量 8，满后覆盖最旧");
        assert_eq!(snap[0].id_value, Some(json!(2)), "最旧的 0、1 被覆盖");
        assert_eq!(snap[7].id_value, Some(json!(9)));
    }

    #[test]
    fn sanitizes_secrets_but_preserves_structure_fields() {
        let hub = hub();
        hub.record(
            WireDirection::PylonToAgent,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "session/prompt",
                "params": {
                    "sessionId": "s-1",
                    "blocks": [{"type": "text", "text": "hello", "toolCallId": "tc-9"}],
                    "apiKey": "sk-12345",
                    "prompt": "secret prompt"
                }
            }),
        );
        let snap = hub.snapshot();
        let params = snap[0].params.as_ref().unwrap();
        assert_eq!(
            params["sessionId"],
            json!("s-1"),
            "sessionId 不可脱敏（结构字段）"
        );
        assert_eq!(params["apiKey"], json!("[REDACTED]"), "apiKey 必须 REDACT");
        assert_eq!(params["prompt"], json!("[REDACTED]"), "prompt 正文可脱敏");
        assert_eq!(
            params["blocks"][0]["toolCallId"],
            json!("tc-9"),
            "toolCallId 保留"
        );
        assert_eq!(snap[0].id_kind, WireIdKind::Number, "id 不得被脱敏影响");
        assert_eq!(snap[0].method.as_deref(), Some("session/prompt"));
        assert_eq!(snap[0].remote_session_id.as_deref(), Some("s-1"));
        assert_eq!(snap[0].tool_call_id.as_deref(), Some("tc-9"));
    }

    #[test]
    fn record_line_parses_and_records_outbound_json() {
        let hub = hub();
        let line = r#"{"jsonrpc":"2.0","id":5,"method":"session/new","params":{"cwd":"."}}"#;
        hub.record_line(WireDirection::PylonToAgent, line);
        let snap = hub.snapshot();
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].id_kind, WireIdKind::Number);
        assert_eq!(snap[0].id_value, Some(json!(5)));
        assert_eq!(snap[0].method.as_deref(), Some("session/new"));
        assert_eq!(snap[0].direction, WireDirection::PylonToAgent);
        // 非法行静默跳过
        hub.record_line(WireDirection::PylonToAgent, "not-json{");
        assert_eq!(hub.snapshot().len(), 1);
    }

    #[test]
    fn extract_session_and_tool_call_from_result() {
        let hub = hub();
        hub.record(
            WireDirection::AgentToPylon,
            &json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {"sessionId": "s-2", "toolCallId": "tc-3"}
            }),
        );
        let snap = hub.snapshot();
        assert_eq!(snap[0].remote_session_id.as_deref(), Some("s-2"));
        assert_eq!(snap[0].tool_call_id.as_deref(), Some("tc-3"));
    }

    #[test]
    fn stamps_correlation_fields_and_extracts_peri_and_request_ids() {
        let hub = hub();
        // session/update 通知：params.sessionId → periId + remoteSessionId
        hub.record(
            WireDirection::AgentToPylon,
            &json!({
                "jsonrpc": "2.0",
                "method": "session/update",
                "params": {"sessionId": "peri-7", "type": "usage"}
            }),
        );
        // string-id request_permission：wire id → requestId（P1 场景）
        hub.record(
            WireDirection::AgentToPylon,
            &json!({
                "jsonrpc": "2.0",
                "id": "perm-42",
                "method": "session/request_permission",
                "params": {"sessionId": "peri-7", "toolCallId": "tc-7"}
            }),
        );
        // number-id request_permission：requestId 字符串化
        hub.record(
            WireDirection::AgentToPylon,
            &json!({
                "jsonrpc": "2.0",
                "id": 7,
                "method": "session/request_permission",
                "params": {"sessionId": "peri-7", "toolCallId": "tc-8"}
            }),
        );
        // 普通请求：requestId/periId 缺省，remoteSessionId 仍提取
        hub.record(
            WireDirection::PylonToAgent,
            &json!({"jsonrpc": "2.0", "id": 1, "method": "session/prompt", "params": {"sessionId": "peri-7"}}),
        );
        let snap = hub.snapshot();
        assert_eq!(snap[0].peri_id.as_deref(), Some("peri-7"));
        assert_eq!(snap[0].remote_session_id.as_deref(), Some("peri-7"));
        assert_eq!(snap[0].request_id, None, "update 通知不是 permission 请求");
        assert_eq!(snap[1].peri_id, None, "request_permission 不是 update 通知");
        assert_eq!(snap[1].request_id.as_deref(), Some("perm-42"));
        assert_eq!(snap[1].remote_session_id.as_deref(), Some("peri-7"));
        assert_eq!(
            snap[2].request_id.as_deref(),
            Some("7"),
            "number id 字符串化为 requestId"
        );
        assert_eq!(snap[3].request_id, None);
        assert_eq!(snap[3].peri_id, None);
        for record in &snap {
            assert_eq!(
                record.client_generation, 3,
                "clientGeneration 来自构造时的 correlation"
            );
            assert_eq!(record.agent_id, "test-agent");
            assert_eq!(record.source, "subprocess");
            assert_eq!(
                record.local_session_id, None,
                "transport 边界 local 键不可知"
            );
        }
    }

    #[test]
    fn passes_through_local_session_id_from_correlation() {
        let hub = AcpWireHub::new(
            RuntimeCorrelation {
                agent_id: "test-agent".into(),
                provider: None,
                source: "subprocess".into(),
                local_session_id: Some("local-1".into()),
                remote_session_id: None,
                peri_id: None,
                client_generation: 1,
                request_id: None,
                tool_call_id: None,
            },
            8,
        );
        hub.record(
            WireDirection::PylonToAgent,
            &json!({"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": {}}),
        );
        let snap = hub.snapshot();
        assert_eq!(snap[0].local_session_id.as_deref(), Some("local-1"));
        assert_eq!(snap[0].client_generation, 1);
    }

    #[test]
    fn snapshot_sorts_by_monotonic_seq_when_enqueue_order_diverges() {
        // CR-001：seq 在锁外分配，并发下 enqueue 落序可能偏离 seq 序——
        // order_snapshot 必须把快照排齐（确定性验证排序路径）。
        let hub = hub();
        for i in 0..5u64 {
            hub.record(
                WireDirection::AgentToPylon,
                &json!({"jsonrpc": "2.0", "id": i, "result": {}}),
            );
        }
        let snap = hub.snapshot();
        let mut shuffled = snap.clone();
        shuffled.reverse(); // 模拟乱序落序
        let sorted = order_snapshot(shuffled);
        let seqs: Vec<u64> = sorted.iter().map(|record| record.monotonic_seq).collect();
        assert_eq!(seqs, vec![1, 2, 3, 4, 5], "快照必须按 monotonicSeq 排齐");
    }
}
