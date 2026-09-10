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
use std::collections::HashMap;
use std::collections::VecDeque;
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
#[derive(Debug)]
pub struct AcpWireHub {
    correlation: RuntimeCorrelation,
    trace_id: String,
    next_seq: AtomicU64,
    enabled: AtomicBool,
    records: Mutex<AllocRingBuffer<Arc<WireRecord>>>,
    capacity: usize,
    canonical_correlations: Mutex<HashMap<u64, CanonicalCorrelation>>,
    inbound_ordinals: Mutex<VecDeque<u64>>,
    inbound_ordinal_overflowed: AtomicBool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalCorrelation {
    pub event_id: String,
    pub sequence: i64,
    pub revision: i64,
}

/// Stable semantic name for the transport capture seam.  The hub remains the
/// implementation so existing consumers keep compiling while new ACP code
/// depends on the protocol-neutral capture vocabulary.
pub type AcpWireCapture = AcpWireHub;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WireJsonlSnapshot {
    pub trace_id: String,
    pub format: &'static str,
    pub data: String,
    pub complete: bool,
    pub first_ordinal: Option<u64>,
    pub last_ordinal: Option<u64>,
    pub dropped_count: usize,
    pub reason: Option<&'static str>,
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
            canonical_correlations: Mutex::new(HashMap::new()),
            inbound_ordinals: Mutex::new(VecDeque::new()),
            inbound_ordinal_overflowed: AtomicBool::new(false),
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

    #[allow(dead_code)] // 测试开关接口：运行期 ring buffer 恒启用，开关仅供测试可见性控制
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Relaxed);
    }

    #[allow(dead_code)] // 同上（lifecycle 测试断言使用）
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    pub fn len(&self) -> usize {
        self.records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    /// Store the repository's actual commit identity for a wire ordinal.
    /// Values are supplied by EventService; no numeric inference occurs here.
    pub fn record_canonical_commit(&self, ordinal: u64, correlation: CanonicalCorrelation) {
        if let Ok(mut index) = self.canonical_correlations.lock() {
            if index.len() >= self.capacity && !index.contains_key(&ordinal) {
                if let Some(oldest) = index.keys().min().copied() {
                    index.remove(&oldest);
                }
            }
            index.insert(ordinal, correlation);
        }
    }

    pub fn correlate(&self, ordinal: u64) -> Option<CanonicalCorrelation> {
        self.canonical_correlations
            .lock()
            .ok()?
            .get(&ordinal)
            .cloned()
    }

    /// 记录一条原始 JSON 报文（必须是在 u64 窄化**之前**的原始 Value）。
    /// infallible：任何内部失败都静默跳过，绝不阻断业务。
    pub fn record(&self, direction: WireDirection, msg_val: &serde_json::Value) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        let record = build_record(&self.trace_id, &self.correlation, seq, direction, msg_val);
        let mut records = self
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if records.len() >= self.capacity {
            // 明确覆盖最旧（与 RuntimeLogHub 语义一致）。
            records.dequeue();
        }
        records.enqueue(Arc::new(record));
        if direction == WireDirection::AgentToPylon
            && msg_val
                .get("method")
                .and_then(|value| value.as_str())
                .is_some()
        {
            if let Ok(mut ordinals) = self.inbound_ordinals.lock() {
                if self.inbound_ordinal_overflowed.load(Ordering::Acquire) {
                    return;
                }
                if ordinals.len() >= self.capacity {
                    ordinals.clear();
                    self.inbound_ordinal_overflowed
                        .store(true, Ordering::Release);
                    return;
                }
                ordinals.push_back(seq);
            }
        }
    }

    pub fn take_inbound_ordinal(&self) -> Option<u64> {
        let mut ordinals = self.inbound_ordinals.lock().ok()?;
        if self.inbound_ordinal_overflowed.load(Ordering::Acquire) {
            return None;
        }
        ordinals.pop_front()
    }

    /// 记录一条已序列化的 outbound 行（writer 边界调用；解析失败静默跳过）。
    pub fn record_line(&self, direction: WireDirection, line: &str) {
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let Ok(msg_val) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        match direction {
            WireDirection::PylonToAgent => self.capture_request(&msg_val),
            WireDirection::AgentToPylon => self.capture_agent_message(&msg_val),
        }
    }

    /// 当前全部记录快照（旧→新，monotonicSeq 严格递增）。
    /// CR-001：seq 在 records 锁外分配，并发下 enqueue 落序可能偏离 seq 序——
    /// 快照返回前按 monotonicSeq 排齐，消费方可直接依赖 seq 全序。
    pub fn snapshot(&self) -> Vec<WireRecord> {
        let records = self
            .records
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        order_snapshot(records.iter().map(|record| (**record).clone()).collect())
    }

    /// Capture an outbound JSON-RPC request at the transport boundary.
    pub fn capture_request(&self, message: &serde_json::Value) {
        self.record(WireDirection::PylonToAgent, message);
    }

    /// Capture an inbound response or notification at the transport boundary.
    pub fn capture_agent_message(&self, message: &serde_json::Value) {
        self.record(WireDirection::AgentToPylon, message);
    }

    /// Compatibility-neutral snapshot name used by transcript/replay code.
    #[allow(dead_code)]
    pub fn records(&self) -> Vec<WireRecord> {
        self.snapshot()
    }

    /// Take one coherent snapshot and export it. Callers that also expose
    /// ordinal metadata must use this seam so body and metadata cannot drift
    /// across concurrent ring-buffer writes.
    pub fn snapshot_jsonl(&self, max_bytes: usize) -> WireJsonlSnapshot {
        let records = self.snapshot();
        let mut data = String::new();
        let mut kept = 0;
        for record in &records {
            let line = serde_json::to_string(record)
                .unwrap_or_else(|_| r#"{"error":"wire_record_serialization_failed"}"#.to_string());
            let extra = line.len().saturating_add(usize::from(kept > 0));
            if extra > max_bytes.saturating_sub(data.len()) {
                break;
            }
            if kept > 0 {
                data.push('\n');
            }
            data.push_str(&line);
            kept += 1;
        }
        let retained = &records[..kept];
        let complete = kept == records.len();
        WireJsonlSnapshot {
            trace_id: self.trace_id().to_owned(),
            format: "jsonl",
            data,
            complete,
            first_ordinal: retained.first().map(|record| record.monotonic_seq),
            last_ordinal: retained.last().map(|record| record.monotonic_seq),
            dropped_count: records.len() - kept,
            reason: (!complete).then_some("byte_budget"),
        }
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
    let params = msg_val.get("params").cloned().map(sanitize_wire);
    let result = msg_val.get("result").cloned().map(sanitize_wire);
    let error = msg_val.get("error").cloned().map(sanitize_wire);
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
    fn canonical_correlation_uses_explicit_repository_identity() {
        let hub = hub();
        assert_eq!(hub.correlate(7), None);
        let value = CanonicalCorrelation {
            event_id: "event-42".into(),
            sequence: 9,
            revision: 12,
        };
        hub.record_canonical_commit(7, value.clone());
        assert_eq!(hub.correlate(7), Some(value));
        assert_eq!(hub.correlate(8), None);
    }

    #[test]
    fn inbound_ordinal_does_not_consume_response_as_notification() {
        let hub = hub();
        hub.record(
            WireDirection::AgentToPylon,
            &json!({"jsonrpc":"2.0","id":1,"result":{}}),
        );
        hub.record(
            WireDirection::AgentToPylon,
            &json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s"}}),
        );
        assert_eq!(hub.take_inbound_ordinal(), Some(2));
    }

    #[test]
    fn inbound_ordinal_overflow_invalidates_correlation_instead_of_shifting() {
        let hub = hub();
        for i in 0..9 {
            hub.record(
                WireDirection::AgentToPylon,
                &json!({"jsonrpc":"2.0","method":"session/update","params":{"i":i}}),
            );
        }
        assert_eq!(hub.take_inbound_ordinal(), None);
        hub.record(
            WireDirection::AgentToPylon,
            &json!({"jsonrpc":"2.0","method":"session/update","params":{"i":10}}),
        );
        assert_eq!(hub.take_inbound_ordinal(), None);
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
    fn jsonl_export_is_bounded_and_preserves_sequence() {
        let hub = hub();
        for id in 0..12u64 {
            hub.record(
                WireDirection::PylonToAgent,
                &json!({"jsonrpc":"2.0","id":id,"method":"session/prompt","params":{}}),
            );
        }
        let exported = hub.snapshot_jsonl(usize::MAX);
        let lines: Vec<_> = exported.data.lines().collect();
        assert_eq!(lines.len(), 8);
        let first: WireRecord = serde_json::from_str(lines[0]).unwrap();
        let last: WireRecord = serde_json::from_str(lines[7]).unwrap();
        assert_eq!(first.monotonic_seq, 5);
        assert_eq!(last.monotonic_seq, 12);
    }

    #[test]
    fn jsonl_snapshot_metadata_and_body_share_one_capture() {
        let hub = hub();
        hub.record(
            WireDirection::PylonToAgent,
            &json!({"id":1,"method":"session/prompt"}),
        );
        let snapshot = hub.snapshot_jsonl(usize::MAX);
        hub.record(
            WireDirection::PylonToAgent,
            &json!({"id":2,"method":"session/prompt"}),
        );
        let exported: Vec<WireRecord> = snapshot
            .data
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(exported.len(), 1);
        assert_eq!(
            snapshot.first_ordinal,
            exported.first().map(|row| row.monotonic_seq)
        );
        assert_eq!(
            snapshot.last_ordinal,
            exported.last().map(|row| row.monotonic_seq)
        );
        assert!(snapshot.complete);
        assert_eq!(snapshot.dropped_count, 0);
        assert_eq!(hub.snapshot().len(), 2);
    }

    #[test]
    fn jsonl_byte_budget_retains_complete_lines_and_matching_ordinals() {
        let hub = hub();
        let empty = hub.snapshot_jsonl(0);
        assert!(empty.complete);
        assert_eq!(empty.first_ordinal, None);
        assert_eq!(empty.last_ordinal, None);
        hub.record(WireDirection::PylonToAgent, &json!({"id":1,"params":{"text":"中文"}}));
        hub.record(WireDirection::PylonToAgent, &json!({"id":2,"params":{"text":"更多"}}));
        let all = hub.snapshot_jsonl(usize::MAX);
        let first_line = all.data.lines().next().unwrap();
        let none = hub.snapshot_jsonl(first_line.len() - 1);
        assert!(none.data.is_empty());
        assert_eq!(none.first_ordinal, None);
        assert_eq!(none.last_ordinal, None);
        assert_eq!(none.dropped_count, 2);
        assert_eq!(none.reason, Some("byte_budget"));
        let one = hub.snapshot_jsonl(first_line.len());
        assert_eq!(one.data, first_line);
        assert_eq!(one.first_ordinal, Some(1));
        assert_eq!(one.last_ordinal, Some(1));
        assert_eq!(one.dropped_count, 1);
        assert!(!one.complete);
        let exact = hub.snapshot_jsonl(all.data.len());
        assert_eq!(exact.data, all.data);
        assert!(exact.complete);
        assert_eq!(exact.last_ordinal, Some(2));
        assert_eq!(exact.reason, None);
        let payload = serde_json::to_value(none).unwrap();
        assert!(payload["firstOrdinal"].is_null());
        assert!(payload["lastOrdinal"].is_null());
        assert_eq!(payload["format"], "jsonl");
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
