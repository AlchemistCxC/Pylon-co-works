//! 工作台投影核（TS 基线：`src/domains/workbench/workbenchProjector.ts` 折叠主干）。
//!
//! 输入是已归一化、带 sequence 的 semantic envelope，输出可丢弃的
//! WorkbenchDocument（增量 patch）。deep pure：不读时钟、store、registry、IO；
//! live / restart / recovery 喂同一组 envelopes 得到同一份 document。
//!
//! # 边界（spec「编组格式」的本层落法）
//!
//! - 批量入口 [`PylonProjector::append_batch`]（wasm）/ [`decode_frame`]（纯内层）
//!   消费**紧凑列式帧**：`magic "PYPB" | version u16 | eventCount u32 | 字串池` +
//!   每事件 24B 定长头（sequence f64 | 保留 u64 | typeIndex u32 | flags u32）+
//!   17 组 (offset,len) 变长段。回放按页合批，一次 `append_batch` 一页。
//! - 热路径（message/reasoning delta）走「单文本部件」通道：定长头 + 池内偏移，
//!   **零 serde_json**；冷事件（tool / diagnostic / session 等低频富载荷）允许把
//!   事件字段整块 JSON 进池，Rust 侧一次性解析——serde_json 往返不进热路径。
//! - 事件类型过界是 u32 词表索引（[`WORKBENCH_EVENT_TYPES`]）；词表前 43 项顺序
//!   即 TS `WORKBENCH_SEMANTIC_EVENT_TYPES`，末尾追加 `event.unknown` /
//!   `extension.event`，两侧由 parity 测试钉死。
//! - 输出走增量 patch（[`WorkbenchPatch`]），不是全量 document；全量读数
//!   （`document()`）仅供 parity / 冷刷新。
//! - spec 头部原定 `sequence i64 | occurredAtMs i64`；本层改 `f64`：sequence 在
//!   TS 侧是 number，f64 直传避免 BigInt 化；时间戳由 Rust 侧从 ISO 串解析
//!   （[`parse_iso_to_ms`]），不要求 JS 预算 ms。
//!
//! # 已知语义缺口（无法逐字复现，见交付清单）
//!
//! - `localeCompare`（乱序兜底排序的同 sequence tie-break）无 ICU 不可复现，
//!   Rust 侧按 UTF-8 字节序；journal 行本就按 sequence 升序，tie-break 仅在
//!   异常输入上可达。
//! - `Date.parse` 只实现 ISO 形态；无时区的 datetime 按 UTC（JS 按本地时区，
//!   测试环境 TZ=UTC 时一致）。
//!
//! # 未移植（fail-closed）
//!
//! `activity.*` / `usage.*` / `budget.warning` / `plan.*` / `goal.*` /
//! `lifecycle.*` / `assist.*` / `extension.event`，以及 session 事件的
//! `commands` / `options` / `usage` 字段——对应归约器依赖 goalModel /
//! lifecycleModel / sessionSurface，尚未迁移。折叠核遇到即报错，绝不静默分叉。

use serde::Serialize;
use serde_json::{Map, Value};
use wasm_bindgen::prelude::*;

use super::content_part::{
    canonicalize_js_numbers, coalesce_adjacent_display_text_parts,
    coalesce_adjacent_reasoning_parts, create_unknown_content_part, js_string_of, js_trim,
    parse_content_part,
};
use super::coverage;

// ── 语义事件词表 ─────────────────────────────────────────────────────────────

/// TS `WORKBENCH_SEMANTIC_EVENT_TYPES`（前 43 项）+ schema 层的
/// `event.unknown` / `extension.event`。声明顺序即帧内 typeIndex。
pub const WORKBENCH_EVENT_TYPES: [&str; 45] = [
    "message.started",
    "message.delta",
    "message.completed",
    "reasoning.delta",
    "reasoning.completed",
    "reasoning.redacted",
    "tool.started",
    "tool.progress",
    "tool.completed",
    "tool.failed",
    "plan.replaced",
    "plan.entry-updated",
    "goal.updated",
    "goal.cleared",
    "activity.started",
    "activity.progress",
    "activity.completed",
    "activity.failed",
    "activity.cancelled",
    "interaction.requested",
    "interaction.resolved",
    "interaction.expired",
    "usage.updated",
    "budget.warning",
    "session.started",
    "session.commands-updated",
    "session.config-updated",
    "session.model-updated",
    "session.mode-updated",
    "session.status-updated",
    "session.completed",
    "lifecycle.retrying",
    "lifecycle.compact-started",
    "lifecycle.compact-completed",
    "lifecycle.rewind-preview",
    "lifecycle.rewind-completed",
    "lifecycle.suspended",
    "lifecycle.recovered",
    "assist.prediction",
    "assist.file-suggestions",
    "assist.queued-command",
    "diagnostic.updated",
    "diagnostic.notice",
    "event.unknown",
    "extension.event",
];

/// TS `MessageRole`（帧内 role 位序）。
pub const MESSAGE_ROLES: [&str; 7] = [
    "user",
    "assistant",
    "system",
    "tool",
    "reasoning",
    "developer",
    "unknown",
];

/// 单文本部件通道的 kind 位序。
pub const TEXT_PART_KINDS: [&str; 6] =
    ["text", "markdown", "code", "ansi", "reasoning", "thinking"];

/// provenance origin 位序。
pub const PROVENANCE_ORIGINS: [&str; 5] = [
    "local-observed",
    "optimistic-local",
    "recovery-import",
    "migration",
    "plugin",
];

const TERMINAL_SESSION_STATUSES: [&str; 4] = ["completed", "error", "failed", "cancelled"];
const SESSION_LIFECYCLE_STATUSES: [&str; 13] = [
    "idle",
    "loading",
    "ready",
    "degraded",
    "running",
    "generating",
    "thinking",
    "responding",
    "working",
    "completed",
    "error",
    "failed",
    "cancelled",
];
const TERMINAL_TOOL_STATUSES: [&str; 3] = ["completed", "failed", "cancelled"];

// flags 位定义（帧内 u32）。
const FLAG_HAS_COVERAGE: u32 = 1 << 5;
const FLAG_HAS_ROLE: u32 = 1 << 6;
const FLAG_ROLE_SHIFT: u32 = 7;
const FLAG_PARTS_MODE_SHIFT: u32 = 10;
const FLAG_PART_KIND_SHIFT: u32 = 12;
/// 帧头保留字段原 spec 的 `occurredAtMs` 位；本实现时间戳由 ISO 串解析。
const FLAG_UNUSED_MASK: u32 = !((1 << 15) - 1) | (1 << 4) | (1 << 15);

// ── 信封（帧解码产物） ───────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct Identity {
    pub turn_id: Option<String>,
    pub message_id: Option<String>,
    pub tool_call_id: Option<String>,
    pub task_id: Option<String>,
    pub run_id: Option<String>,
    pub interaction_id: Option<String>,
}

impl Identity {
    fn to_value(&self) -> Value {
        let mut object = Map::new();
        for (key, value) in [
            ("turnId", &self.turn_id),
            ("messageId", &self.message_id),
            ("toolCallId", &self.tool_call_id),
            ("taskId", &self.task_id),
            ("runId", &self.run_id),
            ("interactionId", &self.interaction_id),
        ] {
            if let Some(value) = value {
                object.insert(key.to_string(), Value::String(value.clone()));
            }
        }
        Value::Object(object)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EventSource {
    pub provider: String,
    pub source_id: String,
    pub agent_id: Option<String>,
    pub parent_agent_id: Option<String>,
}

impl EventSource {
    fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("provider".to_string(), Value::String(self.provider.clone()));
        object.insert(
            "sourceId".to_string(),
            Value::String(self.source_id.clone()),
        );
        if let Some(agent_id) = &self.agent_id {
            object.insert("agentId".to_string(), Value::String(agent_id.clone()));
        }
        if let Some(parent) = &self.parent_agent_id {
            object.insert("parentAgentId".to_string(), Value::String(parent.clone()));
        }
        Value::Object(object)
    }
}

/// 已解码的 semantic envelope（event 已重建为 JSON 对象）。
#[derive(Debug, Clone)]
pub struct SemanticEnvelope {
    pub event_type: String,
    pub sequence: f64,
    pub event_id: String,
    pub session_id: String,
    pub recorded_at: String,
    pub occurred_at: Option<String>,
    pub identity: Identity,
    pub source: EventSource,
    pub provenance_origin: u8,
    pub provenance_trust: u8,
    pub coverage: Option<(f64, f64)>,
    pub event: Value,
}

impl SemanticEnvelope {
    /// `envelope.occurredAt ?? envelope.recordedAt`（消息 time 字段与时长基准）。
    fn occurred_or_recorded(&self) -> &str {
        self.occurred_at.as_deref().unwrap_or(&self.recorded_at)
    }
}

/// provenance origin 位序名（诊断消息与测试可读性用）。
#[allow(dead_code)]
pub fn provenance_origin_name(origin: u8) -> &'static str {
    PROVENANCE_ORIGINS
        .get(origin as usize)
        .copied()
        .unwrap_or("local-observed")
}

// ── 文档模型 ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub struct TimelineEntry {
    pub id: String,
    pub sequence: f64,
    pub event_id: String,
    pub kind: &'static str,
    pub status: Option<Value>,
    pub title: Option<Value>,
    pub summary: Option<Value>,
    pub stream_boundary: Option<bool>,
    pub data: Value,
}

impl TimelineEntry {
    fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".to_string(), Value::String(self.id.clone()));
        object.insert("sequence".to_string(), js_number_value(self.sequence));
        object.insert("eventId".to_string(), Value::String(self.event_id.clone()));
        object.insert("kind".to_string(), Value::String(self.kind.to_string()));
        if let Some(status) = &self.status {
            object.insert("status".to_string(), status.clone());
        }
        if let Some(title) = &self.title {
            object.insert("title".to_string(), title.clone());
        }
        if let Some(summary) = &self.summary {
            object.insert("summary".to_string(), summary.clone());
        }
        if let Some(boundary) = self.stream_boundary {
            object.insert("streamBoundary".to_string(), Value::Bool(boundary));
        }
        object.insert("data".to_string(), self.data.clone());
        Value::Object(object)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkbenchMessage {
    pub id: String,
    pub segment_id: String,
    pub role: String,
    pub content: String,
    pub parts: Value,
    pub identity: Value,
    pub source: Value,
    pub sequence: f64,
    pub running: bool,
    pub time: String,
    pub optimistic: Option<bool>,
    pub thought_duration_ms: Option<f64>,
    pub redacted: Option<bool>,
    pub redacted_reason: Option<String>,
    pub thought_started_at_ms: Option<f64>,
}

impl WorkbenchMessage {
    fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".to_string(), Value::String(self.id.clone()));
        object.insert(
            "segmentId".to_string(),
            Value::String(self.segment_id.clone()),
        );
        object.insert("role".to_string(), Value::String(self.role.clone()));
        object.insert("content".to_string(), Value::String(self.content.clone()));
        object.insert("parts".to_string(), self.parts.clone());
        object.insert("identity".to_string(), self.identity.clone());
        object.insert("source".to_string(), self.source.clone());
        if self.optimistic == Some(true) {
            object.insert("optimistic".to_string(), Value::Bool(true));
        }
        object.insert("sequence".to_string(), js_number_value(self.sequence));
        object.insert("running".to_string(), Value::Bool(self.running));
        object.insert("time".to_string(), Value::String(self.time.clone()));
        if let Some(duration) = self.thought_duration_ms {
            object.insert("thoughtDurationMs".to_string(), js_number_value(duration));
        }
        if self.redacted == Some(true) {
            object.insert("redacted".to_string(), Value::Bool(true));
        }
        if let Some(reason) = &self.redacted_reason {
            object.insert("redactedReason".to_string(), Value::String(reason.clone()));
        }
        if let Some(started) = self.thought_started_at_ms {
            object.insert("thoughtStartedAtMs".to_string(), js_number_value(started));
        }
        Value::Object(object)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionSurfaceState {
    pub status: String,
    pub stop_reason: Option<String>,
    pub model: Option<String>,
    pub mode: Option<String>,
}

/// 投影文档（可丢弃）。`activities` / `interactions` / `diagnostics` /
/// `system_errors` 用 JSON 对象透传——TS 侧这些节点是结构化字面量，投影核只做
/// 字段读写，用 Value 建模才能逐字段保真。
#[derive(Debug, Clone)]
pub struct WorkbenchDocument {
    pub session_id: String,
    pub revision: f64,
    pub applied_event_ids: Vec<String>,
    pub applied_ranges: coverage::CoverageRanges,
    pub timeline: Vec<TimelineEntry>,
    pub messages: Vec<WorkbenchMessage>,
    pub activities: Vec<Value>,
    pub interactions: Vec<Value>,
    pub session: SessionSurfaceState,
    pub diagnostics: Vec<Value>,
    pub system_errors: Vec<Value>,
}

/// TS `createWorkbenchDocument`。
pub fn create_workbench_document(session_id: &str) -> WorkbenchDocument {
    WorkbenchDocument {
        session_id: session_id.to_string(),
        revision: 0.0,
        applied_event_ids: Vec::new(),
        applied_ranges: Vec::new(),
        timeline: Vec::new(),
        messages: Vec::new(),
        activities: Vec::new(),
        interactions: Vec::new(),
        session: SessionSurfaceState {
            status: "idle".to_string(),
            stop_reason: None,
            model: None,
            mode: None,
        },
        diagnostics: Vec::new(),
        system_errors: Vec::new(),
    }
}

/// f64 → JSON number：整值落在安全整数域时输出整数（与 JS number 显示一致）。
fn js_number_value(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

impl WorkbenchDocument {
    /// 全量读数（parity / 冷刷新用；边界增量走 [`WorkbenchPatch`]）。
    pub fn to_document_value(&self) -> Value {
        let mut session = Map::new();
        session.insert(
            "status".to_string(),
            Value::String(self.session.status.clone()),
        );
        if let Some(stop_reason) = &self.session.stop_reason {
            session.insert("stopReason".to_string(), Value::String(stop_reason.clone()));
        }
        if let Some(model) = &self.session.model {
            session.insert("model".to_string(), Value::String(model.clone()));
        }
        if let Some(mode) = &self.session.mode {
            session.insert("mode".to_string(), Value::String(mode.clone()));
        }
        session.insert("commands".to_string(), Value::Array(Vec::new()));
        session.insert("options".to_string(), Value::Array(Vec::new()));

        let mut object = Map::new();
        object.insert(
            "sessionId".to_string(),
            Value::String(self.session_id.clone()),
        );
        object.insert("revision".to_string(), js_number_value(self.revision));
        object.insert(
            "appliedEventIds".to_string(),
            Value::Array(
                self.applied_event_ids
                    .iter()
                    .map(|id| Value::String(id.clone()))
                    .collect(),
            ),
        );
        object.insert(
            "appliedRanges".to_string(),
            Value::Array(
                self.applied_ranges
                    .iter()
                    .map(|(start, end)| Value::Array(vec![Value::from(*start), Value::from(*end)]))
                    .collect(),
            ),
        );
        object.insert(
            "timeline".to_string(),
            Value::Array(self.timeline.iter().map(TimelineEntry::to_value).collect()),
        );
        object.insert(
            "messages".to_string(),
            Value::Array(
                self.messages
                    .iter()
                    .map(WorkbenchMessage::to_value)
                    .collect(),
            ),
        );
        object.insert(
            "activities".to_string(),
            Value::Array(self.activities.clone()),
        );
        object.insert(
            "interactions".to_string(),
            Value::Array(self.interactions.clone()),
        );
        object.insert("extensions".to_string(), Value::Array(Vec::new()));
        object.insert("session".to_string(), Value::Object(session));
        // EMPTY_ASSIST_SNAPSHOT / 空 plan / goal / lifecycle（未喂对应事件时的
        // TS 恒定空态；喂到未移植事件会 fail-closed，不会走到带内容的形态）。
        object.insert("assist".to_string(), serde_json::json!({ "files": [] }));
        object.insert(
            "diagnostics".to_string(),
            Value::Array(self.diagnostics.clone()),
        );
        object.insert(
            "plan".to_string(),
            serde_json::json!({
                "sessionId": self.session_id,
                "revision": 0,
                "entries": [],
            }),
        );
        object.insert("goal".to_string(), serde_json::json!({}));
        object.insert(
            "lifecycle".to_string(),
            serde_json::json!({ "history": [] }),
        );
        object.insert(
            "systemErrors".to_string(),
            Value::Array(self.system_errors.clone()),
        );
        Value::Object(object)
    }
}

// ── 增量 patch DTO（边界输出；粒度待 mock 实测定，spec 未决问题 4） ──────────

#[derive(Debug, Clone, Serialize)]
pub struct MessagePatch {
    pub index: usize,
    pub message: Value,
}

/// 增量 patch：只携带变化的行。timeline 按 eventId upsert；messages 按下标
/// upsert（含追加）；appliedRanges 量小全量携带；session 面携带当前值。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchPatch {
    pub revision: f64,
    pub applied_event_ids_appended: Vec<String>,
    pub applied_ranges: coverage::CoverageRanges,
    pub timeline_upserts: Vec<Value>,
    pub message_upserts: Vec<MessagePatch>,
    pub session: Value,
}

fn diff_patches(before: &WorkbenchDocument, after: &WorkbenchDocument) -> WorkbenchPatch {
    let message_upserts = after
        .messages
        .iter()
        .enumerate()
        .filter(|(index, message)| before.messages.get(*index) != Some(*message))
        .map(|(index, message)| MessagePatch {
            index,
            message: message.to_value(),
        })
        .collect();
    let before_timeline: std::collections::HashMap<&str, &TimelineEntry> = before
        .timeline
        .iter()
        .map(|entry| (entry.event_id.as_str(), entry))
        .collect();
    let timeline_upserts = after
        .timeline
        .iter()
        .filter(|entry| {
            before_timeline
                .get(entry.event_id.as_str())
                .is_none_or(|before_entry| **before_entry != **entry)
        })
        .map(TimelineEntry::to_value)
        .collect();
    let mut session = Map::new();
    session.insert(
        "status".to_string(),
        Value::String(after.session.status.clone()),
    );
    if let Some(stop_reason) = &after.session.stop_reason {
        session.insert("stopReason".to_string(), Value::String(stop_reason.clone()));
    }
    if let Some(model) = &after.session.model {
        session.insert("model".to_string(), Value::String(model.clone()));
    }
    if let Some(mode) = &after.session.mode {
        session.insert("mode".to_string(), Value::String(mode.clone()));
    }
    WorkbenchPatch {
        revision: after.revision,
        applied_event_ids_appended: after.applied_event_ids[before.applied_event_ids.len()..]
            .to_vec(),
        applied_ranges: after.applied_ranges.clone(),
        timeline_upserts,
        message_upserts,
        session: Value::Object(session),
    }
}

// ── 时间解析（Date.parse 的 ISO 子集） ───────────────────────────────────────

/// `Date.parse` 的 ISO 8601 子集：`YYYY-MM-DD`（UTC）、
/// `YYYY-MM-DDTHH:MM[:SS[.sss…]][Z|±HH:MM|±HHMM]`。无时区的 datetime 按 UTC
/// （JS 按本地时区——测试环境 TZ=UTC 时一致，缺口已登记）。非法输入返回 None
/// （等价 JS 的 NaN 语义）。
pub fn parse_iso_to_ms(value: &str) -> Option<f64> {
    let bytes = value.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        value.get(range).and_then(|slice| slice.parse::<i64>().ok())
    };
    let year = digits(0..4)?;
    if bytes[4] != b'-' {
        return None;
    }
    let month = digits(5..7)?;
    if bytes[7] != b'-' {
        return None;
    }
    let day = digits(8..10)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if bytes.len() == 10 {
        return Some(utc_ms(year, month, day, 0, 0, 0.0, 0));
    }
    let separator = bytes[10];
    if separator != b'T' && separator != b' ' {
        return None;
    }
    if bytes.len() < 13 {
        return None;
    }
    let hour = digits(11..13)?;
    let mut index = 13usize;
    let minute = if bytes.get(index) == Some(&b':') {
        index += 1;
        let minute = digits(index..index + 2)?;
        index += 2;
        minute
    } else {
        0
    };
    let second = if bytes.get(index) == Some(&b':') {
        index += 1;
        let second = digits(index..index + 2)?;
        index += 2;
        second
    } else {
        0
    };
    let mut millisecond = 0f64;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        // JS 只取前 3 位毫秒。
        let fraction = &value[start..index.min(start + 3)];
        let padded = format!("{fraction:0<3}");
        millisecond = padded.parse::<f64>().ok()?;
    }
    let offset_minutes = match bytes.get(index) {
        None => 0i64,
        Some(b'Z') | Some(b'z') => {
            index += 1;
            0
        }
        Some(sign @ (b'+' | b'-')) => {
            index += 1;
            let sign = if *sign == b'-' { -1 } else { 1 };
            let hours = digits(index..index + 2)?;
            index += 2;
            if bytes.get(index) == Some(&b':') {
                index += 1;
            }
            let minutes = if index < bytes.len() {
                digits(index..index + 2)?
            } else {
                0
            };
            sign * (hours * 60 + minutes)
        }
        Some(_) => return None,
    };
    if index > bytes.len() {
        return None;
    }
    Some(utc_ms(
        year,
        month,
        day,
        hour,
        minute,
        second as f64 + millisecond / 1000.0,
        offset_minutes,
    ))
}

fn utc_ms(
    year: i64,
    month: i64,
    day: i64,
    hour: i64,
    minute: i64,
    second: f64,
    offset_minutes: i64,
) -> f64 {
    // 天数算法（Howard Hinnant 的 civil_from_days；月份按 3 月起算移位，
    // 1/2 月归入前一年的 11/12 月位）。
    let year_adjusted = if month <= 2 { year - 1 } else { year };
    let era = if year_adjusted >= 0 {
        year_adjusted
    } else {
        year_adjusted - 399
    } / 400;
    let year_of_era = year_adjusted - era * 400;
    let month_shift = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_shift + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468;
    days as f64 * 86_400_000.0 + (hour * 3_600_000 + minute * 60_000) as f64 + second * 1000.0
        - (offset_minutes * 60_000) as f64
}

// ── 归约器公共小件 ───────────────────────────────────────────────────────────

fn string_value(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|s| !js_trim(s).is_empty())
}

/// JS truthy（字符串形态）：非空即可，不 trim（`" "` 在 JS 里为真）。
fn truthy_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn is_record_value(value: &Value) -> bool {
    value.is_object()
}

fn terminal_session_sequence(document: &WorkbenchDocument) -> f64 {
    let mut latest = f64::NEG_INFINITY;
    for entry in &document.timeline {
        if is_terminal_session_entry(entry) {
            latest = latest.max(entry.sequence);
        }
    }
    latest
}

fn is_terminal_session_entry(entry: &TimelineEntry) -> bool {
    if entry.kind != "session" {
        return false;
    }
    let data = match entry.data.as_object() {
        Some(data) => data,
        None => return false,
    };
    data.get("type").and_then(Value::as_str) == Some("session.completed")
        || data
            .get("status")
            .and_then(Value::as_str)
            .is_some_and(|status| {
                TERMINAL_SESSION_STATUSES.contains(&status.to_lowercase().as_str())
            })
}

/// `textStreamContinues`：previous 与本事件之间是否存在文本流边界条目。
/// TS 批量路径用二分索引做同一判定的加速（#205），扫描版语义等价。
fn text_stream_continues(
    document: &WorkbenchDocument,
    previous_sequence: f64,
    envelope_sequence: f64,
) -> bool {
    !document.timeline.iter().any(|entry| {
        entry.sequence > previous_sequence
            && entry.sequence < envelope_sequence
            && is_text_stream_boundary(entry)
    })
}

fn is_text_stream_boundary(entry: &TimelineEntry) -> bool {
    entry.kind == "message"
        || entry.kind == "reasoning"
        || (entry.kind == "tool" && entry.stream_boundary == Some(true))
        || entry.kind == "session"
        || entry.kind == "interaction"
}

fn insert_by_sequence(timeline: &mut Vec<TimelineEntry>, entry: TimelineEntry) {
    match timeline.last() {
        Some(last) if last.sequence <= entry.sequence => timeline.push(entry),
        _ => {
            let mut low = 0usize;
            let mut high = timeline.len();
            while low < high {
                let middle = (low + high) / 2;
                if timeline[middle].sequence <= entry.sequence {
                    low = middle + 1;
                } else {
                    high = middle;
                }
            }
            timeline.insert(low, entry);
        }
    }
}

fn timeline_entry(envelope: &SemanticEnvelope) -> TimelineEntry {
    let event_type = envelope.event_type.as_str();
    let kind = if event_type.starts_with("message.") {
        "message"
    } else if event_type.starts_with("reasoning.") {
        "reasoning"
    } else if event_type.starts_with("tool.") {
        "tool"
    } else if event_type.starts_with("activity.") {
        "activity"
    } else if event_type.starts_with("interaction.") {
        "interaction"
    } else if event_type.starts_with("session.") {
        "session"
    } else if event_type.starts_with("usage.") || event_type == "budget.warning" {
        "usage"
    } else if event_type.starts_with("diagnostic.") || event_type == "event.unknown" {
        if event_type == "event.unknown" {
            "unknown"
        } else {
            "diagnostic"
        }
    } else if event_type == "extension.event" {
        "extension"
    } else if event_type.starts_with("plan.") || event_type.starts_with("goal.") {
        "plan"
    } else if event_type.starts_with("lifecycle.") {
        "lifecycle"
    } else {
        "assist"
    };
    TimelineEntry {
        id: envelope.event_id.clone(),
        sequence: envelope.sequence,
        event_id: envelope.event_id.clone(),
        kind,
        status: None,
        title: None,
        summary: None,
        stream_boundary: None,
        data: envelope.event.clone(),
    }
}

fn update_timeline(
    document: &mut WorkbenchDocument,
    event_id: &str,
    status: Option<Value>,
    title: Option<Value>,
    summary: Option<Value>,
    stream_boundary: Option<Option<bool>>,
) {
    for entry in &mut document.timeline {
        if entry.event_id == event_id {
            if status.is_some() {
                entry.status = status.clone();
            }
            if title.is_some() {
                entry.title = title.clone();
            }
            if summary.is_some() {
                entry.summary = summary.clone();
            }
            if let Some(boundary) = stream_boundary {
                entry.stream_boundary = boundary;
            }
        }
    }
}

fn text_from_parts(parts: &Value) -> String {
    let mut out = String::new();
    if let Some(items) = parts.as_array() {
        for part in items {
            if let Some(text) = part.get("text").and_then(Value::as_str) {
                out.push_str(text);
            } else if part.get("kind").and_then(Value::as_str) == Some("unknown") {
                // Array.join 把 undefined/null 元素转成空串，其余 String() 化。
                match part.get("summary") {
                    Some(Value::String(summary)) => out.push_str(summary),
                    Some(Value::Null) | None => {}
                    Some(other) => out.push_str(&js_string_of(other)),
                }
            }
        }
    }
    out
}

fn provider_identity_key(identity: &Value) -> String {
    for key in [
        "messageId",
        "turnId",
        "toolCallId",
        "taskId",
        "interactionId",
    ] {
        if let Some(value) = identity.get(key) {
            if let Some(text) = string_value(Some(value)) {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn settle_superseded_running_messages(
    document: &mut WorkbenchDocument,
    continuing_role: Option<&str>,
) {
    let has_superseded = document
        .messages
        .iter()
        .any(|message| message.running && Some(message.role.as_str()) != continuing_role);
    if !has_superseded {
        return;
    }
    for message in &mut document.messages {
        if message.running && Some(message.role.as_str()) != continuing_role {
            message.running = false;
        }
    }
}

fn message_identity_for(envelope: &SemanticEnvelope) -> (String, String) {
    let segment_id = envelope.event_id.clone();
    (format!("{}:{segment_id}", envelope.session_id), segment_id)
}

fn add_late_event_diagnostic(
    document: &mut WorkbenchDocument,
    envelope: &SemanticEnvelope,
    message: &str,
) {
    if document
        .diagnostics
        .iter()
        .any(|item| item.get("code").and_then(Value::as_str) == Some("late-event-after-terminal"))
    {
        return;
    }
    add_diagnostic(
        document,
        envelope,
        "late-event-after-terminal",
        &Value::String(message.to_string()),
        &Value::String("warning".to_string()),
        None,
    );
}

fn add_out_of_order_diagnostic(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    if document
        .diagnostics
        .iter()
        .any(|item| item.get("code").and_then(Value::as_str) == Some("out-of-order-text-dropped"))
    {
        return;
    }
    add_diagnostic(
        document,
        envelope,
        "out-of-order-text-dropped",
        &Value::String(
            "journal-earlier text delta arrived after later text; dropped until the next canonical refresh re-orders"
                .to_string(),
        ),
        &Value::String("warning".to_string()),
        Some(&serde_json::json!({ "sequence": js_number_value(envelope.sequence) })),
    );
}

fn add_diagnostic(
    document: &mut WorkbenchDocument,
    envelope: &SemanticEnvelope,
    code: &str,
    message: &Value,
    level: &Value,
    data: Option<&Value>,
) {
    let failed_turn = matches!(code, "turn.failed" | "provider.error");
    let already_terminal =
        TERMINAL_SESSION_STATUSES.contains(&document.session.status.to_lowercase().as_str());
    let transition_to_error = failed_turn && !already_terminal;
    if transition_to_error {
        for message_item in &mut document.messages {
            if message_item.running {
                message_item.running = false;
            }
        }
        document.session.status = "error".to_string();
    }
    let mut diagnostic = Map::new();
    diagnostic.insert("code".to_string(), Value::String(code.to_string()));
    diagnostic.insert("message".to_string(), message.clone());
    diagnostic.insert(
        "eventId".to_string(),
        Value::String(envelope.event_id.clone()),
    );
    diagnostic.insert("sequence".to_string(), js_number_value(envelope.sequence));
    diagnostic.insert("level".to_string(), level.clone());
    if let Some(data) = data {
        diagnostic.insert("data".to_string(), data.clone());
    }
    document.diagnostics.push(Value::Object(diagnostic));
    update_timeline(
        document,
        &envelope.event_id,
        Some(level.clone()),
        None,
        Some(message.clone()),
        None,
    );
}

fn refresh_orphans(document: &mut WorkbenchDocument) {
    let ids: std::collections::HashSet<String> = document
        .activities
        .iter()
        .filter_map(|activity| activity.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    for activity in &mut document.activities {
        let parent_id = match activity.get("parentId").and_then(Value::as_str) {
            Some(parent_id) => parent_id,
            None => continue,
        };
        let orphan = !ids.contains(parent_id);
        if activity.get("orphan") != Some(&Value::Bool(orphan)) {
            if let Some(object) = activity.as_object_mut() {
                object.insert("orphan".to_string(), Value::Bool(orphan));
            }
        }
    }
}

// ── 归一化错误（lifecycleModel.normalizeNormalizedError 对齐） ────────────────

const MAX_CAUSE_DEPTH: usize = 4;

fn normalized_error_text(value: Option<&Value>) -> Option<&str> {
    string_value(value)
}

pub fn normalize_normalized_error(raw: &Value, depth: usize) -> Option<Value> {
    if raw.is_null() {
        return None;
    }
    if let Some(message_raw) = raw.as_str() {
        let message = {
            let trimmed = js_trim(message_raw);
            if trimmed.is_empty() {
                "未知错误".to_string()
            } else {
                trimmed.to_string()
            }
        };
        return Some(serde_json::json!({
            "userSummary": message,
            "technicalMessage": message,
            "recoverability": "none",
        }));
    }
    if !is_record_value(raw) {
        return Some(serde_json::json!({
            "userSummary": "未知错误",
            "technicalMessage": super::content_part::js_string_of(raw),
            "recoverability": "none",
        }));
    }
    let record = raw.as_object().expect("checked");
    const KNOWN_KEYS: [&str; 24] = [
        "userSummary",
        "user_summary",
        "userMessage",
        "technicalMessage",
        "technical_message",
        "detail",
        "message",
        "error",
        "code",
        "provider",
        "sessionId",
        "session_id",
        "eventId",
        "event_id",
        "renderKind",
        "rendererId",
        "rendererSuiteId",
        "rendererSlotId",
        "pluginId",
        "runtimeInstanceId",
        "phase",
        "recoverability",
        "retryable",
        "cause",
    ];
    let mut metadata: Map<String, Value> = match record.get("metadata") {
        Some(metadata) if is_record_value(metadata) => {
            metadata.as_object().expect("checked").clone()
        }
        _ => Map::new(),
    };
    if let Some(metadata_raw) = record.get("metadata") {
        if !is_record_value(metadata_raw) {
            metadata.insert("metadata".to_string(), metadata_raw.clone());
        }
    }
    // TS：`value !== undefined` —— JSON 对象里所有键都存在（undefined 不可表达），
    // null 不是 undefined，照抄进 metadata。
    for (key, value) in record {
        if !KNOWN_KEYS.contains(&key.as_str()) {
            metadata.insert(key.clone(), value.clone());
        }
    }
    let technical = normalized_error_text(record.get("technicalMessage"))
        .or_else(|| normalized_error_text(record.get("technical_message")))
        .or_else(|| normalized_error_text(record.get("detail")))
        .or_else(|| normalized_error_text(record.get("message")))
        .or_else(|| normalized_error_text(record.get("error")))
        .map(|s| s.to_string());
    let summary = normalized_error_text(record.get("userSummary"))
        .or_else(|| normalized_error_text(record.get("user_summary")))
        .or_else(|| normalized_error_text(record.get("userMessage")))
        .map(|s| s.to_string())
        .or(technical.clone())
        .unwrap_or_else(|| "未知错误".to_string());
    let mut cause: Option<Value> = None;
    if let Some(cause_raw) = record.get("cause") {
        if depth < MAX_CAUSE_DEPTH {
            cause = normalize_normalized_error(cause_raw, depth + 1);
        } else {
            metadata.insert("causeTruncated".to_string(), Value::Bool(true));
        }
    }
    let recoverability =
        normalize_recoverability(record.get("recoverability"), record.get("retryable"));
    let phase = normalize_error_phase(record.get("phase"));
    if let Some(phase_raw) = record.get("phase") {
        if phase.is_none() {
            metadata.insert("phase".to_string(), phase_raw.clone());
        }
    }
    let mut object = Map::new();
    for (key, source_key) in [
        ("code", "code"),
        ("provider", "provider"),
        ("sessionId", "sessionId"),
        ("eventId", "eventId"),
        ("renderKind", "renderKind"),
        ("rendererId", "rendererId"),
        ("rendererSuiteId", "rendererSuiteId"),
        ("rendererSlotId", "rendererSlotId"),
        ("pluginId", "pluginId"),
        ("runtimeInstanceId", "runtimeInstanceId"),
    ] {
        // TS 的 `text(raw.sessionId ?? raw.session_id)`：?? 只跳过 null/undefined。
        let value = match key {
            "sessionId" => pick_nullish(record, &["sessionId", "session_id"]),
            "eventId" => pick_nullish(record, &["eventId", "event_id"]),
            other => record.get(other),
        };
        if let Some(text) = normalized_error_text(value) {
            object.insert(key.to_string(), Value::String(text.to_string()));
        }
        let _ = source_key;
    }
    if let Some(phase) = phase {
        object.insert("phase".to_string(), Value::String(phase.to_string()));
    }
    object.insert("userSummary".to_string(), Value::String(summary));
    if let Some(technical) = technical {
        object.insert("technicalMessage".to_string(), Value::String(technical));
    }
    object.insert(
        "recoverability".to_string(),
        Value::String(recoverability.to_string()),
    );
    if let Some(cause) = cause {
        object.insert("cause".to_string(), cause);
    }
    if !metadata.is_empty() {
        object.insert("metadata".to_string(), Value::Object(metadata));
    }
    Some(Value::Object(object))
}

/// JS `??`：只把 undefined/null 让位给备选。
fn pick_nullish<'a>(record: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    for key in keys {
        match record.get(*key) {
            Some(Value::Null) | None => continue,
            Some(value) => return Some(value),
        }
    }
    None
}

fn normalize_recoverability(value: Option<&Value>, retryable: Option<&Value>) -> &'static str {
    const CANDIDATES: [&str; 5] = ["retry", "fallback", "reload-plugin", "reimport", "none"];
    let normalized = value
        .and_then(|v| string_value(Some(v)))
        .map(|s| s.trim().to_lowercase());
    match normalized {
        Some(text) => CANDIDATES
            .into_iter()
            .find(|candidate| *candidate == text)
            .unwrap_or(if retryable == Some(&Value::Bool(true)) {
                "retry"
            } else {
                "none"
            }),
        None => {
            if retryable == Some(&Value::Bool(true)) {
                "retry"
            } else {
                "none"
            }
        }
    }
}

fn normalize_error_phase(value: Option<&Value>) -> Option<&'static str> {
    const CANDIDATES: [&str; 8] = [
        "resolve",
        "prepare",
        "mount",
        "update",
        "switch",
        "action",
        "destroy",
        "settings-migrate",
    ];
    let normalized = value
        .and_then(|v| string_value(Some(v)))
        .map(|s| s.trim().to_lowercase());
    let normalized = normalized?;
    CANDIDATES
        .into_iter()
        .find(|candidate| *candidate == normalized)
}

// ── interaction 脱敏与投影（interactionProjection.ts 对齐） ──────────────────

const SENSITIVE_REQUEST_KEYS: [&str; 11] = [
    "password",
    "secret",
    "value",
    "token",
    "accesstoken",
    "refreshtoken",
    "clientsecret",
    "apikey",
    "authorization",
    "credential",
    "cookie",
];

fn redact_sensitive_interaction_payload(payload: &Value) -> Value {
    if let Some(items) = payload.as_array() {
        return Value::Array(
            items
                .iter()
                .map(redact_sensitive_interaction_payload)
                .collect(),
        );
    }
    let record = match payload.as_object() {
        Some(record) => record,
        None => return payload.clone(),
    };
    let mut out = Map::new();
    for (key, value) in record {
        let normalized_key: String = key
            .chars()
            .filter(|c| *c != '_' && *c != '-')
            .flat_map(|c| c.to_lowercase())
            .collect();
        let is_sensitive = SENSITIVE_REQUEST_KEYS.contains(&normalized_key.as_str())
            || normalized_key.ends_with("token")
            || normalized_key.ends_with("apikey")
            || normalized_key.ends_with("secret");
        if is_sensitive {
            // omission metadata 替代原值（DIC-C12-01）。
            if !value.is_null() {
                out.insert(format!("{key}Redacted"), Value::Bool(true));
            }
            continue;
        }
        if key == "url" {
            if let Some(url) = value.as_str() {
                // `^https:\/\/|^http:\/\/localhost` 白名单之外整体剥除。
                if !(url.starts_with("https://") || url.starts_with("http://localhost")) {
                    out.insert("urlRedacted".to_string(), Value::Bool(true));
                    continue;
                }
            }
        }
        out.insert(key.clone(), redact_sensitive_interaction_payload(value));
    }
    Value::Object(out)
}

fn redact_interaction_event(event: &Value) -> Value {
    let mut out = event.as_object().expect("event 是对象").clone();
    if let Some(request) = event.get("request") {
        out.insert(
            "request".to_string(),
            redact_sensitive_interaction_payload(request),
        );
    }
    if let Some(response) = event.get("response") {
        out.insert(
            "response".to_string(),
            redact_sensitive_interaction_payload(response),
        );
    }
    Value::Object(out)
}

fn reduce_interaction(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    let event = &envelope.event;
    // TS：`event.interactionId || envelope.identity.interactionId || envelope.eventId`
    let id = event
        .get("interactionId")
        .and_then(|value| string_value(Some(value)))
        .map(str::to_string)
        .or_else(|| envelope.identity.interaction_id.clone())
        .unwrap_or_else(|| envelope.event_id.clone());
    let previous_index = document
        .interactions
        .iter()
        .position(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()));
    if let Some(index) = previous_index {
        let previous_status = document.interactions[index]
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("requested")
            .to_string();
        if previous_status != "requested" {
            if previous_status == "resolved" {
                return;
            }
            let previous = &document.interactions[index];
            let mut filled = previous.as_object().expect("interaction 是对象").clone();
            if !filled.contains_key("response") {
                if let Some(response) = event.get("response") {
                    filled.insert("response".to_string(), response.clone());
                }
            }
            if !filled.contains_key("reason") {
                if let Some(reason) = event.get("reason") {
                    filled.insert("reason".to_string(), reason.clone());
                }
            }
            document.interactions[index] = Value::Object(filled);
            return;
        }
    }
    let status = match envelope.event_type.as_str() {
        "interaction.requested" => "requested",
        "interaction.expired" => "expired",
        _ => "resolved",
    };
    let mut interaction = Map::new();
    interaction.insert("id".to_string(), Value::String(id.clone()));
    interaction.insert("status".to_string(), Value::String(status.to_string()));
    // request 由 requested 事件建立；resolved/expired 只带 response/reason。
    if envelope.event_type == "interaction.requested" {
        match event.get("request") {
            Some(request) => {
                interaction.insert(
                    "request".to_string(),
                    redact_sensitive_interaction_payload(request),
                );
            }
            // TS：redact(undefined) === undefined → 键不存在。
            None => {}
        }
    } else if let Some(index) = previous_index {
        if let Some(request) = document.interactions[index].get("request") {
            interaction.insert("request".to_string(), request.clone());
        }
    }
    if let Some(response) = event.get("response") {
        interaction.insert(
            "response".to_string(),
            redact_sensitive_interaction_payload(response),
        );
    } else if let Some(index) = previous_index {
        if let Some(response) = document.interactions[index].get("response") {
            interaction.insert("response".to_string(), response.clone());
        }
    }
    let reason = event.get("reason").cloned().or_else(|| {
        previous_index.and_then(|index| document.interactions[index].get("reason").cloned())
    });
    if let Some(reason) = reason {
        interaction.insert("reason".to_string(), reason);
    }
    interaction.insert("sequence".to_string(), js_number_value(envelope.sequence));
    document
        .interactions
        .retain(|item| item.get("id").and_then(Value::as_str) != Some(id.as_str()));
    document.interactions.push(Value::Object(interaction));
}

// ── message / reasoning 折叠 ─────────────────────────────────────────────────

fn reduce_message(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    let event = &envelope.event;
    let role_source = event.get("role").and_then(Value::as_str).unwrap_or("");
    let role = if role_source == "reasoning" {
        "assistant"
    } else if role_source == "user" {
        "user"
    } else {
        "assistant"
    };
    if TERMINAL_SESSION_STATUSES.contains(&document.session.status.to_lowercase().as_str()) {
        // 终态栅栏之后到达的 journal-earlier 事件是乱序到达而非 journal-late；
        // sequence 有序重放仍会折叠它，live 路径不得剔除。
        let fence = terminal_session_sequence(document);
        let journal_earlier_than_fence = envelope.sequence < fence;
        let last = document.messages.last();
        let user_turn_in_progress =
            last.is_some_and(|message| message.role == "user" && role == "user" && message.running);
        if role == "user"
            && (envelope.event_type == "message.started"
                || envelope.event_type == "message.delta"
                || (envelope.event_type == "message.completed" && user_turn_in_progress))
        {
            document.session.status = "running".to_string();
            document.session.stop_reason = None;
        } else if (role != "user" || envelope.event_type == "message.completed")
            && !journal_earlier_than_fence
        {
            add_late_event_diagnostic(
                document,
                envelope,
                "late assistant event ignored after terminal fence",
            );
            return;
        }
    }
    settle_superseded_running_messages(document, Some(role));
    let parts = event
        .get("parts")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let content = text_from_parts(&parts);
    let previous_index = document.messages.len().checked_sub(1);
    let terminal = envelope.event_type == "message.completed";
    // #200：recovery-import 是 session/load 的历史导入——历史没有「在途」语义。
    let imported_history = envelope.provenance_origin == 2;
    if terminal && content.is_empty() {
        settle_text_segment(document, envelope, role);
        return;
    }
    // ACP provider 可省略 message 身份；相邻同角色 chunk 仍属同一条流。assistant
    // 边界来自 canonical timeline 的语义事件，不来自 side-channel 或逐 chunk 身份。
    let incoming_provider = provider_identity_key(&envelope.identity.to_value());
    let append = previous_index.is_some_and(|index| {
        let previous = &document.messages[index];
        previous.role == role
            && text_stream_continues(document, previous.sequence, envelope.sequence)
            && (role == "assistant"
                || (incoming_provider != ""
                    && incoming_provider == provider_identity_key(&previous.identity))
                || (incoming_provider.is_empty() && previous.running))
    });
    let incoming_optimistic = envelope.provenance_origin == 1;
    let duplicate_index = if role == "user" {
        find_correlated_user_echo(document, envelope, &content, incoming_optimistic)
    } else {
        None
    };
    if let Some(duplicate_index) = duplicate_index {
        // Kernel 提交行无论先到后到都优先；在乐观位替换还能修复 assistant 抢跑。
        if incoming_optimistic {
            return;
        }
        let (id, segment_id) = message_identity_for(envelope);
        let replacement = WorkbenchMessage {
            id,
            segment_id,
            role: "user".to_string(),
            content,
            parts,
            identity: envelope.identity.to_value(),
            source: envelope.source.to_value(),
            sequence: envelope.sequence,
            running: !terminal && !imported_history,
            time: envelope.occurred_or_recorded().to_string(),
            optimistic: None,
            thought_duration_ms: None,
            redacted: None,
            redacted_reason: None,
            thought_started_at_ms: None,
        };
        document.messages[duplicate_index] = replacement;
        return;
    }
    // 乱序收敛：journal-earlier 的 delta 属于已封口段（sequence 先于终态），
    // 折入而不是丢弃，live 文档与 sequence 有序重放对齐；终态本身不复活。
    if !terminal {
        if let Some(index) = previous_index {
            let (
                previous_role,
                previous_running,
                previous_sequence,
                previous_content,
                previous_parts,
            ) = {
                let previous = &document.messages[index];
                (
                    previous.role == role,
                    previous.running,
                    previous.sequence,
                    previous.content.clone(),
                    previous.parts.clone(),
                )
            };
            if previous_role
                && !previous_running
                && text_stream_continues(document, previous_sequence, envelope.sequence)
                && envelope.sequence < previous_sequence.max(terminal_session_sequence(document))
            {
                let folded_parts = concat_parts(&previous_parts, &parts);
                let merged_parts =
                    coalesce_adjacent_display_text_parts(&folded_parts).unwrap_or(folded_parts);
                let message = &mut document.messages[index];
                message.content = format!("{previous_content}{content}");
                message.parts = Value::Array(merged_parts);
                return;
            }
        }
    }
    // 终态段是吸收栅栏：迟到 delta 只有在 provider 给出显式不同 turn 身份时才
    // 能开新段；否则属于已封口 turn，忽略。
    if !terminal {
        if let Some(index) = previous_index {
            let previous = &document.messages[index];
            if previous.role == role
                && !previous.running
                && text_stream_continues(document, previous.sequence, envelope.sequence)
            {
                let previous_turn = previous.identity.get("turnId").and_then(Value::as_str);
                let incoming_turn = envelope.identity.turn_id.as_deref();
                let previous_provider = provider_identity_key(&previous.identity);
                let explicit_provider_boundary = incoming_provider != ""
                    && previous_provider != ""
                    && incoming_provider != previous_provider;
                let same_or_missing_turn = incoming_turn.map_or(true, |incoming| {
                    previous_turn.is_none_or(|previous| incoming == previous)
                });
                if same_or_missing_turn && !explicit_provider_boundary {
                    return;
                }
            }
        }
    }
    // K03 guard：journal-earlier delta 追加在更晚文本之后会破坏段序——报缺失诊断。
    if append {
        if let Some(index) = previous_index {
            if envelope.sequence < document.messages[index].sequence {
                add_out_of_order_diagnostic(document, envelope);
                return;
            }
        }
    }
    if append {
        let index = document.messages.len() - 1;
        let previous = document.messages[index].clone();
        let folded_parts = concat_parts(&previous.parts, &parts);
        let merged_parts =
            coalesce_adjacent_display_text_parts(&folded_parts).unwrap_or(folded_parts);
        let identity_is_present = !envelope
            .identity
            .to_value()
            .as_object()
            .expect("identity")
            .is_empty();
        let message = &mut document.messages[index];
        message.content = format!("{}{}", previous.content, content);
        message.parts = Value::Array(merged_parts);
        message.identity = if identity_is_present {
            envelope.identity.to_value()
        } else {
            previous.identity
        };
        message.sequence = envelope.sequence;
        message.running = !terminal && !imported_history;
    } else {
        let (id, segment_id) = message_identity_for(envelope);
        let merged_parts = match parts.as_array() {
            Some(items) => coalesce_adjacent_display_text_parts(items)
                .map(Value::Array)
                .unwrap_or(parts),
            // 非 array 形态按 TS 的 `?? []` 之外行为不可达（信封校验保证数组）；
            // 防御性按原值透传，不 panic。
            None => parts,
        };
        document.messages.push(WorkbenchMessage {
            id,
            segment_id,
            role: role.to_string(),
            content,
            parts: merged_parts,
            identity: envelope.identity.to_value(),
            source: envelope.source.to_value(),
            sequence: envelope.sequence,
            running: !terminal && !imported_history,
            time: envelope.occurred_or_recorded().to_string(),
            optimistic: incoming_optimistic.then_some(true),
            thought_duration_ms: None,
            redacted: None,
            redacted_reason: None,
            thought_started_at_ms: None,
        });
    }
}

fn concat_parts(left: &Value, right: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(items) = left.as_array() {
        out.extend(items.iter().cloned());
    }
    if let Some(items) = right.as_array() {
        out.extend(items.iter().cloned());
    }
    out
}

fn find_correlated_user_echo(
    document: &WorkbenchDocument,
    envelope: &SemanticEnvelope,
    content: &str,
    incoming_optimistic: bool,
) -> Option<usize> {
    let request_identity = envelope.identity.interaction_id.as_deref();
    if let Some(request_identity) = request_identity {
        if !request_identity.is_empty() {
            let correlated = find_last_message_index(document, |message| {
                message.role == "user"
                    && message.optimistic.unwrap_or(false) != incoming_optimistic
                    && message
                        .identity
                        .get("interactionId")
                        .and_then(Value::as_str)
                        == Some(request_identity)
            });
            if correlated.is_some() {
                return correlated;
            }
            // 带显式 client 身份的本地乐观行是独立命令，除非身份相关联。
            if incoming_optimistic {
                return None;
            }
        }
    }
    let adjacent_index = document.messages.len().checked_sub(1)?;
    let adjacent = &document.messages[adjacent_index];
    (adjacent.role == "user"
        && adjacent.content == content
        && adjacent.optimistic.unwrap_or(false) != incoming_optimistic)
        .then_some(adjacent_index)
}

fn find_last_message_index(
    document: &WorkbenchDocument,
    predicate: impl Fn(&WorkbenchMessage) -> bool,
) -> Option<usize> {
    (0..document.messages.len())
        .rev()
        .find(|index| predicate(&document.messages[*index]))
}

fn settle_text_segment(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope, role: &str) {
    let mut index = find_terminal_target_index(document, envelope, role);
    // 乱序（journal-earlier）终态可能命中已被 session 栅栏沉淀的段；回退到最后
    // 一条同角色行，使重排与重放收敛。
    if index.is_none() && envelope.sequence < terminal_session_sequence(document) {
        index = find_last_message_index(document, |message| message.role == role);
    }
    let index = match index {
        Some(index) => index,
        None => return,
    };
    if !document.messages[index].running {
        return;
    }
    let message = &mut document.messages[index];
    message.running = false;
    message.sequence = envelope.sequence;
}

fn find_terminal_target_index(
    document: &WorkbenchDocument,
    envelope: &SemanticEnvelope,
    role: &str,
) -> Option<usize> {
    let incoming_identity = provider_identity_key(&envelope.identity.to_value());
    if !incoming_identity.is_empty() {
        let exact = find_last_message_index(document, |message| {
            message.role == role && provider_identity_key(&message.identity) == incoming_identity
        });
        if exact.is_some() {
            return exact;
        }
    }
    find_last_message_index(document, |message| message.role == role && message.running)
}

fn reduce_reasoning(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    let event = &envelope.event;
    if TERMINAL_SESSION_STATUSES.contains(&document.session.status.to_lowercase().as_str()) {
        // journal-earlier 是乱序到达而非 journal-late（见 reduceMessage）。
        if envelope.sequence >= terminal_session_sequence(document) {
            add_late_event_diagnostic(
                document,
                envelope,
                "late reasoning event ignored after terminal fence",
            );
            return;
        }
    }
    settle_superseded_running_messages(document, Some("reasoning"));
    let parts = event
        .get("parts")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let parts_items: Vec<Value> = parts.as_array().cloned().unwrap_or_default();
    // C01：redacted 时不保留原文（D06——raw 不进 projection），只留安全占位。
    let redacted = envelope.event_type == "reasoning.redacted";
    let reasoning_parts: Vec<Value> = if redacted {
        parts_items.clone()
    } else {
        coalesce_adjacent_reasoning_parts(&parts_items).unwrap_or_else(|| parts_items.clone())
    };
    let content = if redacted {
        String::new()
    } else {
        text_from_parts(&Value::Array(reasoning_parts.clone()))
    };
    if envelope.event_type == "reasoning.completed" && content.is_empty() {
        settle_reasoning_segment(document, envelope);
        return;
    }
    let previous_index = document.messages.len().checked_sub(1);
    let incoming_provider_identity = provider_identity_key(&envelope.identity.to_value());
    let previous_provider_identity = previous_index
        .map(|index| provider_identity_key(&document.messages[index].identity))
        .unwrap_or_default();
    let same_terminal_identity = !incoming_provider_identity.is_empty()
        && incoming_provider_identity == previous_provider_identity;
    let has_tool_boundary_between = previous_index.is_some_and(|index| {
        document.timeline.iter().any(|entry| {
            entry.sequence > document.messages[index].sequence
                && entry.sequence < envelope.sequence
                && entry.kind == "tool"
        })
    });
    let append = previous_index.is_some_and(|index| {
        let previous = &document.messages[index];
        previous.role == "reasoning"
            && text_stream_continues(document, previous.sequence, envelope.sequence)
            && !has_tool_boundary_between
            && (previous.running
                || (envelope.event_type != "reasoning.delta" && same_terminal_identity))
    });
    // C01：terminal 是吸收态——迟到 delta/重复 completion 不得复活或改写首次终态。
    // redaction 是唯一可继续收紧的迁移。
    if append {
        if let Some(index) = previous_index {
            if !document.messages[index].running {
                if redacted && document.messages[index].redacted != Some(true) {
                    let mut secured = document.messages[index].clone();
                    secured.content = String::new();
                    secured.parts = parts.clone();
                    secured.sequence = envelope.sequence;
                    secured.redacted = Some(true);
                    if let Some(reason) = event.get("reason").and_then(Value::as_str) {
                        secured.redacted_reason = Some(reason.to_string());
                    }
                    document.messages[index] = secured;
                }
                return;
            }
        }
    }
    // 乱序收敛：journal-earlier delta 折入已封口 reasoning 段。
    if envelope.event_type == "reasoning.delta" {
        if let Some(index) = previous_index {
            let (
                previous_is_reasoning,
                previous_running,
                previous_sequence,
                previous_content,
                previous_parts,
            ) = {
                let previous = &document.messages[index];
                (
                    previous.role == "reasoning",
                    previous.running,
                    previous.sequence,
                    previous.content.clone(),
                    previous.parts.clone(),
                )
            };
            if previous_is_reasoning
                && !previous_running
                && !has_tool_boundary_between
                && text_stream_continues(document, previous_sequence, envelope.sequence)
                && envelope.sequence < previous_sequence.max(terminal_session_sequence(document))
            {
                let folded_parts =
                    concat_parts(&previous_parts, &Value::Array(reasoning_parts.clone()));
                let merged_parts = coalesce_adjacent_reasoning_parts(&folded_parts)
                    .map(Value::Array)
                    .unwrap_or(Value::Array(folded_parts));
                let message = &mut document.messages[index];
                message.content = format!("{previous_content}{content}");
                message.parts = merged_parts;
                return;
            }
        }
        // 终态后迟到 delta：只有显式不同 turn/provider 身份才开新段。
        if let Some(index) = previous_index {
            let previous = &document.messages[index];
            if previous.role == "reasoning" && !previous.running && !has_tool_boundary_between {
                let previous_turn = previous.identity.get("turnId").and_then(Value::as_str);
                let incoming_turn = envelope.identity.turn_id.as_deref();
                let previous_provider = provider_identity_key(&previous.identity);
                let explicit_provider_boundary = !incoming_provider_identity.is_empty()
                    && !previous_provider.is_empty()
                    && incoming_provider_identity != previous_provider;
                let same_or_missing_turn = incoming_turn.map_or(true, |incoming| {
                    previous_turn.is_none_or(|previous| incoming == previous)
                });
                if same_or_missing_turn && !explicit_provider_boundary {
                    return;
                }
            }
        }
    }
    // K03 guard：journal-earlier delta 追加在更晚 reasoning 文本之后 → 缺失诊断。
    if append {
        if let Some(index) = previous_index {
            if document.messages[index].running
                && envelope.sequence < document.messages[index].sequence
            {
                add_out_of_order_diagnostic(document, envelope);
                return;
            }
        }
    }
    // C01：时长 = 终态 occurredAt − 首个 delta occurredAt；append 段沿用首段时间基准。
    let terminal_at = parse_iso_to_ms(envelope.occurred_or_recorded());
    let started_at = match previous_index {
        Some(index) if append && document.messages[index].thought_started_at_ms.is_some() => {
            document.messages[index].thought_started_at_ms
        }
        _ => parse_iso_to_ms(envelope.occurred_or_recorded()),
    };
    let duration_ms = if envelope.event_type == "reasoning.delta" {
        if append {
            previous_index.and_then(|index| document.messages[index].thought_duration_ms)
        } else {
            None
        }
    } else {
        match (terminal_at, started_at) {
            (Some(end), Some(start)) if end.is_finite() && start.is_finite() => {
                Some((end - start).max(0.0))
            }
            _ => None,
        }
    };
    let running_next = envelope.event_type == "reasoning.delta" && envelope.provenance_origin != 2;
    if append {
        let index = document.messages.len() - 1;
        let previous = document.messages[index].clone();
        let folded_parts = concat_parts(&previous.parts, &Value::Array(reasoning_parts.clone()));
        let merged_parts = if redacted {
            parts.clone()
        } else {
            coalesce_adjacent_reasoning_parts(&folded_parts)
                .map(Value::Array)
                .unwrap_or(Value::Array(folded_parts))
        };
        let message = &mut document.messages[index];
        message.content = if redacted {
            content
        } else {
            format!("{}{}", previous.content, content)
        };
        message.parts = merged_parts;
        message.identity = if !envelope
            .identity
            .to_value()
            .as_object()
            .expect("identity")
            .is_empty()
        {
            envelope.identity.to_value()
        } else {
            previous.identity
        };
        message.sequence = envelope.sequence;
        message.running = running_next;
        if let Some(duration) = duration_ms {
            message.thought_duration_ms = Some(duration);
        }
        if redacted {
            message.redacted = Some(true);
        }
        if let Some(reason) = event.get("reason").and_then(Value::as_str) {
            message.redacted_reason = Some(reason.to_string());
        }
    } else {
        let (id, segment_id) = message_identity_for(envelope);
        let mut message = WorkbenchMessage {
            id,
            segment_id,
            role: "reasoning".to_string(),
            content,
            parts: if redacted {
                parts.clone()
            } else {
                Value::Array(reasoning_parts.clone())
            },
            identity: envelope.identity.to_value(),
            source: envelope.source.to_value(),
            sequence: envelope.sequence,
            running: running_next,
            time: envelope.occurred_or_recorded().to_string(),
            optimistic: None,
            thought_duration_ms: None,
            redacted: None,
            redacted_reason: None,
            thought_started_at_ms: None,
        };
        if let Some(duration) = duration_ms {
            message.thought_duration_ms = Some(duration);
        } else if let Some(started) = started_at.filter(|value| value.is_finite()) {
            message.thought_started_at_ms = Some(started);
        } else {
            // TS：`{ thoughtStartedAtMs: undefined }` —— 键存在但值为 undefined，
            // 结构上等价于缺省。
        }
        if redacted {
            message.redacted = Some(true);
        }
        if let Some(reason) = event.get("reason").and_then(Value::as_str) {
            message.redacted_reason = Some(reason.to_string());
        }
        document.messages.push(message);
    }
}

fn settle_reasoning_segment(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    let mut index = find_terminal_target_index(document, envelope, "reasoning");
    let journal_earlier_terminal = envelope.sequence < terminal_session_sequence(document);
    if index.is_none() && journal_earlier_terminal {
        index = find_last_message_index(document, |message| message.role == "reasoning");
    }
    let index = match index {
        Some(index) => index,
        None => return,
    };
    let target = document.messages[index].clone();
    let terminal_at = parse_iso_to_ms(envelope.occurred_or_recorded());
    let started_at = target
        .thought_started_at_ms
        .or_else(|| parse_iso_to_ms(&target.time));
    let duration_ms = match (terminal_at, started_at) {
        (Some(end), Some(start)) if end.is_finite() && start.is_finite() => {
            Some((end - start).max(0.0))
        }
        _ => None,
    };
    // journal-earlier 终态是重放序里的首个权威终态：重算被乱序 session 栅栏
    // 沉淀过的状态。
    if !target.running
        && !journal_earlier_terminal
        && (target.thought_duration_ms.is_some() || duration_ms.is_none())
    {
        return;
    }
    let message = &mut document.messages[index];
    message.running = false;
    message.sequence = envelope.sequence;
    if let Some(duration) = duration_ms {
        message.thought_duration_ms = Some(duration);
    }
}

// ── tool 折叠 ────────────────────────────────────────────────────────────────

fn reduce_tool(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    if TERMINAL_SESSION_STATUSES.contains(&document.session.status.to_lowercase().as_str()) {
        add_late_event_diagnostic(
            document,
            envelope,
            "late tool event ignored after terminal fence",
        );
        return;
    }
    let event = &envelope.event;
    let tool = event
        .get("tool")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let tool_record = tool.as_object().cloned().unwrap_or_default();
    let id = tool_record
        .get("toolCallId")
        .and_then(|value| string_value(Some(value)))
        .map(str::to_string)
        .or_else(|| envelope.identity.tool_call_id.clone())
        .unwrap_or_else(|| envelope.event_id.clone());
    let payload_status = string_value(tool_record.get("status"))
        .unwrap_or("progress")
        .to_string();
    let status = match envelope.event_type.as_str() {
        "tool.started" => "running".to_string(),
        "tool.failed" => "failed".to_string(),
        "tool.completed" => "completed".to_string(),
        "tool.cancelled" => "cancelled".to_string(),
        _ => {
            if payload_status.is_empty() {
                "progress".to_string()
            } else {
                payload_status.clone()
            }
        }
    };
    let normalized_tool_error = tool_record
        .get("error")
        .map(|error| normalize_normalized_error(error, 0))
        .unwrap_or(None)
        .filter(|value| !value.is_null());
    let previous_index = document.activities.iter().position(|node| {
        node.get("id").and_then(Value::as_str) == Some(id.as_str())
            && node.get("kind").and_then(Value::as_str) == Some("tool")
    });
    if previous_index.is_none() {
        settle_superseded_running_messages(document, None);
        update_timeline(
            document,
            &envelope.event_id,
            None,
            None,
            None,
            Some(Some(true)),
        );
    }
    let previous = previous_index.map(|index| &document.activities[index]);
    let str_or_prev = |current: Option<&Value>, previous_key: &str| -> Option<Value> {
        if let Some(text) = current.and_then(|value| string_value(Some(value))) {
            return Some(Value::String(text.to_string()));
        }
        previous
            .and_then(|node| node.get(previous_key))
            .and_then(|value| string_value(Some(value)))
            .map(|text| Value::String(text.to_string()))
    };
    let mut node = Map::new();
    // node.title 是工具身份（machine name）；本地化 title 只进 displayName。
    let title = str_or_prev(tool_record.get("name"), "title");
    node.insert("id".to_string(), Value::String(id.clone()));
    node.insert("kind".to_string(), Value::String("tool".to_string()));
    if let Some(title) = &title {
        node.insert("title".to_string(), title.clone());
    }
    node.insert("status".to_string(), Value::String(status.clone()));
    if let Some(semantic_kind) = str_or_prev(tool_record.get("semanticKind"), "semanticKind") {
        node.insert("semanticKind".to_string(), semantic_kind);
    }
    if let Some(parent) = str_or_prev(tool_record.get("parentToolUseId"), "parentToolCallId") {
        node.insert("parentToolCallId".to_string(), parent);
    }
    if let Some(parent) = str_or_prev(tool_record.get("parentActivityId"), "parentId") {
        node.insert("parentId".to_string(), parent);
    }
    if let Some(canonical_name) = str_or_prev(tool_record.get("canonicalName"), "canonicalName") {
        node.insert("canonicalName".to_string(), canonical_name);
    }
    if let Some(tool_kind_wire) = str_or_prev(tool_record.get("kind"), "toolKindWire") {
        node.insert("toolKindWire".to_string(), tool_kind_wire);
    }
    if let Some(display_name) = str_or_prev(tool_record.get("title"), "displayName") {
        node.insert("displayName".to_string(), display_name);
    }
    if let Some(input) = tool_record.get("input") {
        node.insert("input".to_string(), input.clone());
    }
    if let Some(locations) = tool_record.get("locations") {
        if locations.is_array() {
            node.insert("locations".to_string(), locations.clone());
        }
    }
    if let Some(progress) = tool_record.get("progress") {
        node.insert("progress".to_string(), progress.clone());
    }
    if let Some(action) = tool_record
        .get("action")
        .and_then(|value| string_value(Some(value)))
    {
        node.insert("action".to_string(), Value::String(action.to_string()));
    }
    if let Some(capabilities) = tool_record.get("capabilities") {
        if capabilities.is_array() {
            node.insert("capabilities".to_string(), capabilities.clone());
        }
    }
    if let Some(duration) = tool_record.get("durationMs") {
        // TS：Number.isFinite(Number(tool.durationMs))。
        let value = super::content_part::js_number_of(duration);
        if value.is_finite() {
            node.insert("durationMs".to_string(), js_number_value(value));
        }
    }
    if let Some(error) = normalized_tool_error {
        node.insert("error".to_string(), error);
    }
    if let Some(parts) = tool_record.get("parts") {
        if parts.is_array() {
            node.insert("parts".to_string(), parts.clone());
        }
    }
    if let Some(raw_output) = tool_record.get("rawOutput") {
        node.insert("rawOutput".to_string(), raw_output.clone());
    }
    let provider_name = str_or_prev(tool_record.get("providerName"), "providerName")
        .or_else(|| {
            tool_record
                .get("name")
                .and_then(|value| string_value(Some(value)))
                .map(|text| Value::String(text.to_string()))
        })
        .or_else(|| {
            previous
                .and_then(|node| node.get("providerName"))
                .and_then(|value| string_value(Some(value)))
                .map(|text| Value::String(text.to_string()))
        });
    if let Some(provider_name) = provider_name {
        node.insert("providerName".to_string(), provider_name);
    }
    if let Some(raw_input) = tool_record.get("rawInput") {
        node.insert("rawInput".to_string(), raw_input.clone());
    } else if let Some(previous_node) = previous {
        if let Some(raw_input) = previous_node.get("rawInput") {
            node.insert("rawInput".to_string(), raw_input.clone());
        }
    }
    node.insert("orphan".to_string(), Value::Bool(false));
    // C04 终态幂等 + 活动位置是创建时事实（progress 不移动卡片）。
    node.insert("data".to_string(), event.clone());
    node.insert(
        "sequence".to_string(),
        js_number_value(
            previous
                .and_then(|node| node.get("sequence"))
                .and_then(Value::as_f64)
                .unwrap_or(envelope.sequence),
        ),
    );
    let node = Value::Object(node);
    let merged = merge_tool_activity(previous, &node);
    let projected = merged.as_ref().unwrap_or(&node).clone();
    upsert_activity(document, projected);
    // TS：`{ status: merged?.status ?? status, title: merged?.title ?? node.title }`。
    let merged_ref = merged.as_ref().unwrap_or(&node);
    let merged_status = merged_ref
        .get("status")
        .and_then(Value::as_str)
        .map(str::to_string);
    let merged_title = merged_ref.get("title").cloned();
    update_timeline(
        document,
        &envelope.event_id,
        Some(Value::String(merged_status.unwrap_or(status))),
        merged_title,
        None,
        None,
    );
}

/// C04 终态幂等合并：previous 已是终态时，迟到事件只补缺字段不回退状态。
fn merge_tool_activity(previous: Option<&Value>, next: &Value) -> Option<Value> {
    let previous = previous?;
    let previous_status = previous.get("status").and_then(Value::as_str).unwrap_or("");
    if !TERMINAL_TOOL_STATUSES.contains(&previous_status) {
        return Some(next.clone());
    }
    let mut filled = previous.as_object().expect("activity 是对象").clone();
    const FILL_KEYS: [&str; 18] = [
        "semanticKind",
        "title",
        "parentId",
        "canonicalName",
        "input",
        "locations",
        "progress",
        "action",
        "capabilities",
        "parentToolCallId",
        "durationMs",
        "error",
        "parts",
        "rawOutput",
        "providerName",
        "rawInput",
        "toolKindWire",
        "displayName",
    ];
    for key in FILL_KEYS {
        if let Some(value) = next.get(key) {
            if !filled.contains_key(key) {
                filled.insert(key.to_string(), value.clone());
            }
        }
    }
    Some(Value::Object(filled))
}

fn upsert_activity(document: &mut WorkbenchDocument, next: Value) {
    let next_id = next.get("id").and_then(Value::as_str).map(str::to_string);
    let index = next_id.and_then(|id| {
        document
            .activities
            .iter()
            .position(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
    });
    match index {
        None => document.activities.push(next),
        Some(index) => {
            let item = &document.activities[index];
            // TS：`{ ...item, ...next, parentId: next.parentId ?? item.parentId }`。
            let mut merged = item.as_object().expect("activity 是对象").clone();
            for (key, value) in next.as_object().expect("activity 是对象") {
                merged.insert(key.clone(), value.clone());
            }
            let parent_id = next
                .get("parentId")
                .cloned()
                .or_else(|| item.get("parentId").cloned());
            match parent_id {
                Some(parent_id) => merged.insert("parentId".to_string(), parent_id),
                None => merged.remove("parentId"),
            };
            document.activities[index] = Value::Object(merged);
        }
    }
}

// ── diagnostic / session 折叠 ────────────────────────────────────────────────

fn reduce_diagnostic(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    let event = &envelope.event;
    let level = event
        .get("level")
        .cloned()
        .unwrap_or_else(|| Value::String("info".to_string()));
    let message = event
        .get("message")
        .cloned()
        .unwrap_or_else(|| Value::String("diagnostic event".to_string()));
    let code = event
        .get("code")
        .and_then(Value::as_str)
        .unwrap_or("diagnostic.notice")
        .to_string();
    let mut with_error = document.clone();
    if level.as_str() == Some("error") && code != "turn.failed" && code != "provider.error" {
        let normalized = normalize_normalized_error(
            &serde_json::json!({
                "userSummary": message.as_str().unwrap_or_default(),
                "technicalMessage": message.as_str().unwrap_or_default(),
                "code": code,
                "sessionId": envelope.session_id,
                "eventId": envelope.event_id,
                "recoverability": "retry",
            }),
            0,
        );
        if let Some(normalized) = normalized.filter(|value| !value.is_null()) {
            with_error.system_errors.push(normalized);
        }
    }
    add_diagnostic(
        &mut with_error,
        envelope,
        &code,
        &message,
        &level,
        Some(event),
    );
    *document = with_error;
}

fn reduce_session(
    document: &mut WorkbenchDocument,
    envelope: &SemanticEnvelope,
) -> Result<(), String> {
    let event = &envelope.event;
    // commands/options/usage 的 fail-closed 已在 validate_envelope 里先于变更完成。
    let completed_at = parse_iso_to_ms(envelope.occurred_or_recorded());
    let previous_status = document.session.status.clone();
    let requested_status = if envelope.event_type == "session.completed" {
        Some("completed".to_string())
    } else {
        event
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let requested_lower = requested_status.as_deref().map(str::to_lowercase);
    let previous_lower = previous_status.to_lowercase();
    let terminal_regression = TERMINAL_SESSION_STATUSES.contains(&previous_lower.as_str())
        && requested_lower
            .as_deref()
            .is_some_and(|requested| requested != previous_lower);
    let next_status = requested_status
        .as_deref()
        .filter(|status| !status.is_empty())
        .filter(|_| {
            requested_lower
                .as_deref()
                .is_some_and(|lower| SESSION_LIFECYCLE_STATUSES.contains(&lower))
        })
        .filter(|_| !terminal_regression)
        .map(str::to_string)
        .unwrap_or(previous_status);
    let settles_messages = TERMINAL_SESSION_STATUSES.contains(&next_status.to_lowercase().as_str());
    if settles_messages {
        for message in &mut document.messages {
            if !message.running {
                continue;
            }
            message.running = false;
            if message.role == "reasoning" {
                if let Some(started) = message.thought_started_at_ms {
                    if let Some(completed) = completed_at.filter(|value| value.is_finite()) {
                        message.thought_duration_ms = Some((completed - started).max(0.0));
                    }
                }
            }
        }
    }
    document.session.status = next_status;
    if let Some(stop_reason) = truthy_string(event.get("stopReason")) {
        document.session.stop_reason = Some(stop_reason.to_string());
    }
    if let Some(model) = truthy_string(event.get("model")) {
        document.session.model = Some(model.to_string());
    }
    if let Some(mode) = truthy_string(event.get("mode")) {
        document.session.mode = Some(mode.to_string());
    }
    Ok(())
}

// ── 归约主干 ─────────────────────────────────────────────────────────────────

/// `reduceSemanticEvent` 的 dispatch。未移植类型 fail-closed。
fn reduce_semantic_event(
    document: &mut WorkbenchDocument,
    envelope: &SemanticEnvelope,
) -> Result<(), String> {
    match envelope.event_type.as_str() {
        "message.started" | "message.delta" | "message.completed" => {
            reduce_message(document, envelope);
            Ok(())
        }
        "reasoning.delta" | "reasoning.completed" | "reasoning.redacted" => {
            reduce_reasoning(document, envelope);
            Ok(())
        }
        "tool.started" | "tool.progress" | "tool.completed" | "tool.failed" => {
            reduce_tool(document, envelope);
            Ok(())
        }
        "interaction.requested" | "interaction.resolved" | "interaction.expired" => {
            reduce_interaction(document, envelope);
            Ok(())
        }
        "diagnostic.updated" | "diagnostic.notice" => {
            reduce_diagnostic(document, envelope);
            Ok(())
        }
        "session.started"
        | "session.commands-updated"
        | "session.config-updated"
        | "session.model-updated"
        | "session.mode-updated"
        | "session.status-updated"
        | "session.completed" => reduce_session(document, envelope),
        "event.unknown" => {
            let summary = envelope
                .event
                .get("summary")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new()));
            add_diagnostic(
                document,
                envelope,
                "event.unknown",
                &summary,
                &Value::String("warning".to_string()),
                Some(&envelope.event),
            );
            Ok(())
        }
        other => Err(format!(
            "semantic 事件 {other} 的归约器未迁移到计算核（activity/usage/plan/goal/lifecycle/assist/extension），已 fail-closed"
        )),
    }
}

/// 迁移期 fail-closed 预检：未移植的归约器 / session 事件的未迁移字段，必须在
/// **任何 document 变更之前**拒绝（单事件与整页共用，保证事务性）。
fn validate_envelope(envelope: &SemanticEnvelope) -> Result<(), String> {
    let ported = matches!(
        envelope.event_type.as_str(),
        "message.started"
            | "message.delta"
            | "message.completed"
            | "reasoning.delta"
            | "reasoning.completed"
            | "reasoning.redacted"
            | "tool.started"
            | "tool.progress"
            | "tool.completed"
            | "tool.failed"
            | "interaction.requested"
            | "interaction.resolved"
            | "interaction.expired"
            | "diagnostic.updated"
            | "diagnostic.notice"
            | "event.unknown"
            | "session.started"
            | "session.model-updated"
            | "session.mode-updated"
            | "session.status-updated"
            | "session.completed"
    );
    if !ported {
        return Err(format!(
            "semantic 事件 {} 的归约器未迁移到计算核（activity/usage/plan/goal/lifecycle/assist/extension），已 fail-closed",
            envelope.event_type
        ));
    }
    if envelope.event_type.starts_with("session.") {
        // sessionSurface（commands/options/usage 归一化）未迁移：fail-closed。
        for key in ["commands", "options", "usage"] {
            if envelope
                .event
                .get(key)
                .is_some_and(|value| !value.is_null())
            {
                return Err(format!(
                    "session 事件携带未迁移的 {key} 字段（sessionSurface 归一化未移植），已拒绝投影"
                ));
            }
        }
    }
    Ok(())
}

/// `reduceWorkbenchEvent`：单事件折叠（幂等判据 + timeline + 语义归约 + orphan 刷新）。
pub fn reduce_workbench_event(
    document: &mut WorkbenchDocument,
    envelope: &SemanticEnvelope,
) -> Result<(), String> {
    // fail-closed 预检先于任何变更（幂等命中时不做预检：重放旧批次里含未移植
    // 事件时，已覆盖/已应用的跨度保持幂等语义）。
    validate_envelope(envelope)?;
    // journal 信封按覆盖区间幂等；非 journal 信封保持 eventId 幂等。
    let span = envelope
        .coverage
        .and_then(|(start, end)| coverage::coverage_span_of(Some((start, end))));
    if let Some((start, end)) = span {
        if coverage::is_span_covered(&document.applied_ranges, start, end) {
            return Ok(());
        }
    } else if document.applied_event_ids.contains(&envelope.event_id) {
        return Ok(());
    }
    // C12：secret-bearing interaction 在进入任何投影面前统一剥敏。
    let effective_event = if envelope.event_type.starts_with("interaction.") {
        redact_interaction_event(&envelope.event)
    } else {
        envelope.event.clone()
    };
    let effective = SemanticEnvelope {
        event: effective_event,
        ..envelope.clone()
    };
    let entry = timeline_entry(&effective);
    insert_by_sequence(&mut document.timeline, entry);
    document.revision = document.revision.max(envelope.sequence);
    if let Some((start, end)) = span {
        document.applied_ranges = coverage::merge_coverage(&document.applied_ranges, start, end);
    } else {
        document.applied_event_ids.push(envelope.event_id.clone());
    }
    reduce_semantic_event(document, &effective)?;
    refresh_orphans(document);
    Ok(())
}

/// `projectWorkbench`：批量折叠（回放按页合批的落点）。
///
/// 排序判据与 TS 一致：sequence 升序，同 sequence 按 eventId（TS 用
/// localeCompare——本实现按 UTF-8 字节序，缺口已登记；journal 行本就有序）。
/// 去重走 `reduce_workbench_event` 的同一判据（#205 的 Set 预去重是 JS GC
/// 优化；Rust 侧 eventId 去重仅服务非 journal 信封，批量回放主路径是区间判据）。
pub fn project_batch(
    document: &mut WorkbenchDocument,
    envelopes: Vec<SemanticEnvelope>,
) -> Result<WorkbenchPatch, String> {
    // 事务性：任一事件预检失败 → 整页拒绝，document 不动。
    for envelope in &envelopes {
        validate_envelope(envelope)?;
    }
    let mut sorted = envelopes;
    sorted.sort_by(|left, right| {
        left.sequence
            .partial_cmp(&right.sequence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.event_id.as_bytes().cmp(right.event_id.as_bytes()))
    });
    let before = document.clone();
    for envelope in &sorted {
        // 事务性：中途失败（如 session 事件的未迁移字段）→ 回滚整页，document 不动。
        if let Err(error) = reduce_workbench_event(document, envelope) {
            *document = before;
            return Err(error);
        }
    }
    Ok(diff_patches(&before, document))
}

// ── 帧解码（纯内层；编码器在 TS 侧 parity 测试） ─────────────────────────────

pub const FRAME_MAGIC: [u8; 4] = *b"PYPB";
pub const FRAME_VERSION: u16 = 1;
/// 每事件变长段的 (offset,len) 对数。
pub const FRAME_PAIRS: usize = 17;

#[derive(Debug)]
struct FrameReader<'a> {
    bytes: &'a [u8],
    pool: &'a [u8],
    position: usize,
}

impl<'a> FrameReader<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8], String> {
        let end = self.position + length;
        if end > self.bytes.len() {
            return Err("帧截断：变长段越界".to_string());
        }
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }

    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_le_bytes(
            self.take(2)?.try_into().expect("2 bytes"),
        ))
    }

    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_le_bytes(
            self.take(4)?.try_into().expect("4 bytes"),
        ))
    }

    fn f64(&mut self) -> Result<f64, String> {
        Ok(f64::from_le_bytes(
            self.take(8)?.try_into().expect("8 bytes"),
        ))
    }

    fn pair(&mut self) -> Result<&'a [u8], String> {
        let offset = self.u32()? as usize;
        let length = self.u32()? as usize;
        if offset + length > self.pool.len() {
            return Err("帧截断：字串池越界".to_string());
        }
        Ok(&self.pool[offset..offset + length])
    }

    fn string(&mut self) -> Result<String, String> {
        let bytes = self.pair()?;
        String::from_utf8(bytes.to_vec()).map_err(|error| format!("字串池不是 UTF-8: {error}"))
    }

    fn optional_string(&mut self) -> Result<Option<String>, String> {
        let bytes = self.pair()?;
        if bytes.is_empty() {
            return Ok(None);
        }
        String::from_utf8(bytes.to_vec())
            .map(Some)
            .map_err(|error| format!("字串池不是 UTF-8: {error}"))
    }

    fn optional_json(&mut self) -> Result<Option<Value>, String> {
        let bytes = self.pair()?;
        if bytes.is_empty() {
            return Ok(None);
        }
        serde_json::from_slice(bytes)
            .map(Some)
            .map_err(|error| format!("池内 JSON 解析失败: {error}"))
    }
}

/// 解码一页批量帧。热路径事件（message/reasoning delta）不经过 serde_json；
/// 池内 JSON 仅服务冷事件富载荷。
pub fn decode_frame(bytes: &[u8]) -> Result<Vec<SemanticEnvelope>, String> {
    if bytes.len() < 14 || bytes[..4] != FRAME_MAGIC {
        return Err("帧魔数不符（期望 PYPB）".to_string());
    }
    let mut reader = FrameReader {
        bytes,
        pool: &[],
        position: 4,
    };
    let version = reader.u16()?;
    if version != FRAME_VERSION {
        return Err(format!("帧版本不支持：{version}（期望 {}）", FRAME_VERSION));
    }
    let event_count = reader.u32()? as usize;
    let pool_length = reader.u32()? as usize;
    let pool_start = reader.position;
    if pool_start + pool_length > bytes.len() {
        return Err("帧截断：字串池越界".to_string());
    }
    reader.pool = &bytes[pool_start..pool_start + pool_length];
    reader.position = pool_start + pool_length;

    let mut envelopes = Vec::with_capacity(event_count);
    for index in 0..event_count {
        let envelope = decode_event(&mut reader)
            .map_err(|error| format!("第 {index} 个事件解码失败: {error}"))?;
        envelopes.push(envelope);
    }
    Ok(envelopes)
}

fn decode_event(reader: &mut FrameReader) -> Result<SemanticEnvelope, String> {
    let sequence = reader.f64()?;
    let _reserved = reader.f64()?;
    let type_index = reader.u32()? as usize;
    let flags = reader.u32()?;
    if flags & FLAG_UNUSED_MASK != 0 {
        return Err(format!("flags 保留位非零：{flags:#x}"));
    }
    let event_type = WORKBENCH_EVENT_TYPES
        .get(type_index)
        .copied()
        .ok_or_else(|| format!("typeIndex 越界：{type_index}"))?
        .to_string();

    let event_id = reader.string()?;
    let session_id = reader.string()?;
    let recorded_at = reader.string()?;
    let occurred_at = reader.optional_string()?;
    let identity = Identity {
        turn_id: reader.optional_string()?,
        message_id: reader.optional_string()?,
        tool_call_id: reader.optional_string()?,
        task_id: reader.optional_string()?,
        run_id: reader.optional_string()?,
        interaction_id: reader.optional_string()?,
    };
    let source = EventSource {
        provider: reader.string()?,
        source_id: reader.string()?,
        agent_id: reader.optional_string()?,
        parent_agent_id: reader.optional_string()?,
    };
    let reason = reader.optional_string()?;
    let parts_mode = (flags >> FLAG_PARTS_MODE_SHIFT) & 0b11;
    let part_kind_index = ((flags >> FLAG_PART_KIND_SHIFT) & 0b111) as usize;
    let parts_text = reader.optional_string()?;
    let extra = reader.optional_json()?;
    let coverage = if flags & FLAG_HAS_COVERAGE != 0 {
        let start = reader.f64()?;
        let end = reader.f64()?;
        Some((start, end))
    } else {
        None
    };

    // 重建 semantic event 对象（与 TS envelope.event 逐字段等价）。
    let mut event = Map::new();
    event.insert("type".to_string(), Value::String(event_type.clone()));
    if flags & FLAG_HAS_ROLE != 0 {
        let role_index = ((flags >> FLAG_ROLE_SHIFT) & 0b111) as usize;
        let role = MESSAGE_ROLES
            .get(role_index)
            .ok_or_else(|| format!("role 位越界：{role_index}"))?;
        event.insert("role".to_string(), Value::String(role.to_string()));
    }
    match parts_mode {
        0 => {}
        1 => {
            let text = parts_text.unwrap_or_default();
            let kind = TEXT_PART_KINDS
                .get(part_kind_index)
                .ok_or_else(|| format!("partKind 位越界：{part_kind_index}"))?;
            event.insert(
                "parts".to_string(),
                Value::Array(vec![serde_json::json!({ "kind": kind, "text": text })]),
            );
        }
        2 => {
            let parsed = match parts_text {
                Some(text) => serde_json::from_str::<Value>(&text)
                    .map_err(|error| format!("parts JSON 解析失败: {error}"))?,
                None => return Err("parts JSON 通道为空".to_string()),
            };
            if !parsed.is_array() {
                return Err("parts JSON 通道必须是数组".to_string());
            }
            event.insert("parts".to_string(), parsed);
        }
        other => return Err(format!("partsMode 非法：{other}")),
    }
    if let Some(reason) = reason {
        event.insert("reason".to_string(), Value::String(reason));
    }
    if let Some(extra) = extra {
        let extra = match extra {
            Value::Object(entries) => entries,
            _ => return Err("extra 载荷必须是对象".to_string()),
        };
        for (key, value) in extra {
            event.insert(key, value);
        }
    }
    // 池内 JSON 的数字按 JS 语义规范化（整值浮点 → 整数）。
    let mut event = Value::Object(event);
    canonicalize_js_numbers(&mut event);

    Ok(SemanticEnvelope {
        event_type,
        sequence,
        event_id,
        session_id,
        recorded_at: recorded_at,
        occurred_at,
        identity,
        source,
        provenance_origin: (flags & 0b111) as u8,
        provenance_trust: ((flags >> 3) & 1) as u8,
        coverage,
        event,
    })
}

// ── wasm 薄壳（只做值/错误转换；可失败逻辑全在纯内层） ────────────────────────

/// 工作台投影核实例：持有折叠状态，`append_batch` 按页合批消费二进制帧。
#[wasm_bindgen]
pub struct PylonProjector {
    document: WorkbenchDocument,
}

#[wasm_bindgen]
impl PylonProjector {
    #[wasm_bindgen(constructor)]
    pub fn new(session_id: &str) -> PylonProjector {
        PylonProjector {
            document: create_workbench_document(session_id),
        }
    }

    /// 页级批量入口（回放/直播突刺共用；逐事件循环喂法被本 API 形态禁止）。
    /// 返回增量 patch（非全量 document）。
    #[wasm_bindgen(js_name = appendBatch)]
    pub fn append_batch(&mut self, frame: &[u8]) -> Result<String, JsError> {
        let envelopes = decode_frame(frame).map_err(|error| JsError::new(&error))?;
        let patch =
            project_batch(&mut self.document, envelopes).map_err(|error| JsError::new(&error))?;
        to_boundary_json(&patch)
    }

    /// 全量读数（parity / 冷刷新；热路径消费 patch）。
    #[wasm_bindgen(js_name = document)]
    pub fn document(&self) -> Result<String, JsError> {
        to_boundary_json(&self.document.to_document_value())
    }
}

// ── parity 探针（冷路径；供 TS parity 测试逐函数对齐，不进生产热路径） ────────

/// 边界输出助手：一次 serde_json 写 → JS 侧 `JSON.parse`。
///
/// 刻意**不走** serde_wasm_bindgen：它把 `null` 编组为 `undefined`，会破坏
/// JsonValue 载荷（raw / tool input / request/response）的精确保真。输出方向的
/// 一次字符串写不是输入侧被禁的「事件 JSON 往返」——输入帧零 JSON 的纪律不变，
/// 且输出 patch 是增量行、document() 是冷读数。
fn to_boundary_json<T: serde::Serialize>(value: &T) -> Result<String, JsError> {
    serde_json::to_string(value).map_err(|error| JsError::new(&format!("边界序列化失败: {error}")))
}

fn parse_json_input(input: &str) -> Result<Value, JsError> {
    let mut value: Value = serde_json::from_str(input)
        .map_err(|error| JsError::new(&format!("输入不是合法 JSON: {error}")))?;
    canonicalize_js_numbers(&mut value);
    Ok(value)
}

fn schema_result_to_value(result: super::content_part::SchemaResult<Value>) -> Value {
    match result {
        Ok(value) => serde_json::json!({ "ok": true, "value": value }),
        Err(issues) => serde_json::json!({ "ok": false, "issues": issues }),
    }
}

/// `parseContentPart` 的过界探针。
#[wasm_bindgen(js_name = projectorParseContentPart)]
pub fn projector_parse_content_part(input: &str) -> Result<String, JsError> {
    let value = parse_json_input(input)?;
    to_boundary_json(&schema_result_to_value(parse_content_part(&value)))
}

/// `createUnknownContentPart` 的过界探针。
#[wasm_bindgen(js_name = projectorCreateUnknownContentPart)]
pub fn projector_create_unknown_content_part(
    original_type: &str,
    raw: &str,
    max_raw_bytes: Option<f64>,
) -> Result<String, JsError> {
    let value = parse_json_input(raw)?;
    to_boundary_json(&create_unknown_content_part(
        original_type,
        &value,
        max_raw_bytes,
    ))
}

/// 相邻聚合探针：返回 `{ changed, parts }`。
#[wasm_bindgen(js_name = projectorCoalesceDisplayTextParts)]
pub fn projector_coalesce_display_text_parts(input: &str) -> Result<String, JsError> {
    let value = parse_json_input(input)?;
    let parts = value
        .as_array()
        .ok_or_else(|| JsError::new("输入必须是 parts 数组"))?
        .clone();
    let merged = coalesce_adjacent_display_text_parts(&parts);
    let payload = serde_json::json!({
        "changed": merged.is_some(),
        "parts": merged.unwrap_or(parts),
    });
    to_boundary_json(&payload)
}

/// 相邻聚合探针（reasoning 文本族）：返回 `{ changed, parts }`。
#[wasm_bindgen(js_name = projectorCoalesceReasoningParts)]
pub fn projector_coalesce_reasoning_parts(input: &str) -> Result<String, JsError> {
    let value = parse_json_input(input)?;
    let parts = value
        .as_array()
        .ok_or_else(|| JsError::new("输入必须是 parts 数组"))?
        .clone();
    let merged = coalesce_adjacent_reasoning_parts(&parts);
    let payload = serde_json::json!({
        "changed": merged.is_some(),
        "parts": merged.unwrap_or(parts),
    });
    to_boundary_json(&payload)
}

/// span 占用探针：`mergeCoverage(ranges, start, end)`。
#[wasm_bindgen(js_name = projectorMergeCoverage)]
pub fn projector_merge_coverage(ranges: &str, start: f64, end: f64) -> Result<String, JsError> {
    let value = parse_json_input(ranges)?;
    let parsed: coverage::CoverageRanges = serde_json::from_value(value)
        .map_err(|error| JsError::new(&format!("ranges 必须是 [start,end][]: {error}")))?;
    to_boundary_json(&coverage::merge_coverage(&parsed, start as i64, end as i64))
}

/// 语义事件词表（typeIndex 的唯一事实源，与 TS 侧 parity 钉死）。
#[wasm_bindgen(js_name = projectorEventTypes)]
pub fn projector_event_types() -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(&WORKBENCH_EVENT_TYPES.to_vec())
        .map_err(|error| JsError::new(&format!("词表序列化失败: {error}")))
}

// ── 原生单测：对齐 `src/domains/workbench/__tests__/workbenchProjector*.test.ts`
//    中落在已移植归约器上的断言 ──
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SESSION: &str = "session-1";
    const RECORDED_AT: &str = "2026-08-21T00:00:00.000Z";

    fn envelope(sequence: f64, event: Value) -> SemanticEnvelope {
        envelope_with(sequence, event, json!({}), 0)
    }

    fn envelope_with(sequence: f64, event: Value, identity: Value, origin: u8) -> SemanticEnvelope {
        envelope_full(
            sequence,
            event,
            identity,
            origin,
            None,
            format!("wire-1-{sequence}"),
        )
    }

    fn envelope_full(
        sequence: f64,
        event: Value,
        identity: Value,
        origin: u8,
        coverage: Option<(f64, f64)>,
        source_id: String,
    ) -> SemanticEnvelope {
        let identity_object = identity.as_object().cloned().unwrap_or_default();
        SemanticEnvelope {
            event_type: event
                .get("type")
                .and_then(Value::as_str)
                .expect("type")
                .to_string(),
            sequence,
            event_id: format!(
                "wb-test-{sequence}-{}",
                event.get("type").and_then(Value::as_str).unwrap_or("")
            ),
            session_id: SESSION.to_string(),
            recorded_at: RECORDED_AT.to_string(),
            occurred_at: None,
            identity: Identity {
                turn_id: identity_object
                    .get("turnId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                message_id: identity_object
                    .get("messageId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                tool_call_id: identity_object
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                task_id: identity_object
                    .get("taskId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                run_id: identity_object
                    .get("runId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                interaction_id: identity_object
                    .get("interactionId")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
            source: EventSource {
                provider: "peri".to_string(),
                source_id,
                agent_id: None,
                parent_agent_id: None,
            },
            provenance_origin: origin,
            provenance_trust: if origin == 0 { 0 } else { 1 },
            coverage,
            event,
        }
    }

    fn reduce_all(events: Vec<SemanticEnvelope>) -> WorkbenchDocument {
        let mut document = create_workbench_document(SESSION);
        for envelope in &events {
            reduce_workbench_event(&mut document, envelope).expect("fold");
        }
        document
    }

    fn message_contents(document: &WorkbenchDocument) -> Vec<(String, String)> {
        document
            .messages
            .iter()
            .map(|message| (message.role.clone(), message.content.clone()))
            .collect()
    }

    #[test]
    fn projects_messages_timeline_and_unknown_diagnostics() {
        let first = envelope(
            1.0,
            json!({"type": "message.delta", "role": "user", "parts": [{"kind": "text", "text": "question"}]}),
        );
        let second = envelope_with(
            2.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "answer"}]}),
            json!({"messageId": "m-1"}),
            0,
        );
        let unknown = envelope(
            3.0,
            json!({"type": "event.unknown", "originalType": "future_event", "summary": "future", "raw": {"value": 1}, "truncated": false}),
        );
        let document = reduce_all(vec![first, second, unknown]);
        assert_eq!(
            message_contents(&document),
            vec![
                ("user".to_string(), "question".to_string()),
                ("assistant".to_string(), "answer".to_string())
            ]
        );
        let kinds: Vec<&str> = document.timeline.iter().map(|entry| entry.kind).collect();
        assert_eq!(kinds, vec!["message", "message", "unknown"]);
        assert!(document
            .diagnostics
            .iter()
            .any(|item| item.get("code").and_then(Value::as_str) == Some("event.unknown")));
    }

    #[test]
    fn is_idempotent_for_duplicate_event_ids_and_keeps_tool_orphan() {
        let mut document = create_workbench_document(SESSION);
        let tool_update = envelope_with(
            2.0,
            json!({"type": "tool.progress", "tool": {"toolCallId": "tool-1", "name": "read", "semanticKind": "tool.read", "parentActivityId": "parent-1", "status": "completed"}}),
            json!({"toolCallId": "tool-1"}),
            0,
        );
        reduce_workbench_event(&mut document, &tool_update).expect("fold");
        let applied_before = document.applied_event_ids.clone();
        reduce_workbench_event(&mut document, &tool_update).expect("fold");
        assert_eq!(document.applied_event_ids, applied_before);
        let tool = document
            .activities
            .iter()
            .find(|node| node.get("id").and_then(Value::as_str) == Some("tool-1"))
            .expect("tool node");
        assert_eq!(
            tool.get("parentId"),
            Some(&Value::String("parent-1".into()))
        );
        assert_eq!(
            tool.get("semanticKind"),
            Some(&Value::String("tool.read".into()))
        );
        assert_eq!(tool.get("orphan"), Some(&Value::Bool(true)));
    }

    #[test]
    fn batch_replay_equals_single_event_fold() {
        let events: Vec<SemanticEnvelope> = (0..60)
            .map(|index| {
                envelope_with(
                    (index + 1) as f64,
                    json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": format!("chunk-{index} ")}]}),
                    json!({"messageId": "m-1"}),
                    0,
                )
            })
            .collect();
        // 批内重复事件只折叠一次。
        let mut batch = events.clone();
        batch.push(events[10].clone());
        batch.push(events[40].clone());

        let batched = reduce_all(batch);
        let folded = reduce_all(events);
        assert_eq!(batched.applied_event_ids, folded.applied_event_ids);
        assert_eq!(batched.applied_event_ids.len(), 60);
        assert_eq!(batched.messages, folded.messages);
        assert_eq!(batched.timeline, folded.timeline);
    }

    #[test]
    fn resolves_interactions_and_turn_failure_deterministically() {
        let requested = envelope_with(
            1.0,
            json!({"type": "interaction.requested", "interactionId": "ask-1", "request": {"question": "continue?"}}),
            json!({"interactionId": "ask-1"}),
            0,
        );
        let failure = envelope(
            4.0,
            json!({"type": "diagnostic.notice", "level": "error", "message": "failed", "code": "turn.failed"}),
        );
        let resolved = envelope_with(
            5.0,
            json!({"type": "interaction.resolved", "interactionId": "ask-1", "response": {"answer": "yes"}}),
            json!({"interactionId": "ask-1"}),
            0,
        );
        let document = reduce_all(vec![requested, failure, resolved]);
        assert_eq!(document.interactions.len(), 1);
        let interaction = &document.interactions[0];
        assert_eq!(interaction.get("id"), Some(&Value::String("ask-1".into())));
        assert_eq!(
            interaction.get("status"),
            Some(&Value::String("resolved".into()))
        );
        // turn.failed → session error 终态 + running 消息沉淀。
        assert_eq!(document.session.status, "error");
        assert!(document
            .diagnostics
            .iter()
            .any(
                |item| item.get("code").and_then(Value::as_str) == Some("turn.failed")
                    && item.get("level").and_then(Value::as_str) == Some("error")
            ));
        // request 脱敏标记保留（question 非敏感键，原样保留）。
        assert!(document.interactions[0].get("request").is_some());
    }

    #[test]
    fn interaction_secret_fields_are_redacted() {
        let requested = envelope_with(
            1.0,
            json!({"type": "interaction.requested", "interactionId": "ask-2", "request": {"password": "hunter2", "note": "ok"}}),
            json!({"interactionId": "ask-2"}),
            0,
        );
        let document = reduce_all(vec![requested]);
        let request = &document.interactions[0]["request"];
        assert_eq!(request.get("passwordRedacted"), Some(&Value::Bool(true)));
        assert!(request.get("password").is_none());
        assert_eq!(request.get("note"), Some(&Value::String("ok".into())));
        // timeline 里的 event 同样剥敏（共享同一结果）。
        let entry = document
            .timeline
            .iter()
            .find(|entry| entry.kind == "interaction")
            .expect("interaction entry");
        assert!(entry.data["request"].get("password").is_none());
    }

    #[test]
    fn recovery_import_starts_settled_but_content_is_identical() {
        let live = envelope(
            1.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "same"}]}),
        );
        let recovery = envelope_with(
            1.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "same"}]}),
            json!({}),
            2,
        );
        let live_document = reduce_all(vec![live]);
        let recovery_document = reduce_all(vec![recovery]);
        assert_eq!(recovery_document.messages[0].running, false);
        assert_eq!(live_document.messages[0].running, true);
        assert_eq!(
            recovery_document.messages[0].content,
            live_document.messages[0].content
        );
    }

    #[test]
    fn sorts_journal_sequence_deterministically() {
        let first = envelope(
            1.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "a"}]}),
        );
        let second = envelope(
            2.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "b"}]}),
        );
        let forward = reduce_all(vec![first.clone(), second.clone()]);
        let mut document = create_workbench_document(SESSION);
        project_batch(&mut document, vec![second, first]).expect("batch");
        assert_eq!(message_contents(&document), message_contents(&forward));
    }

    #[test]
    fn aggregates_identity_less_chunks_of_same_role() {
        let first = envelope(
            1.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "first"}]}),
        );
        let second = envelope(
            2.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "second"}]}),
        );
        let document = reduce_all(vec![first, second]);
        assert_eq!(
            message_contents(&document),
            vec![("assistant".to_string(), "firstsecond".to_string())]
        );

        // identity-less user chunks 同理。
        let first = envelope(
            1.0,
            json!({"type": "message.delta", "role": "user", "parts": [{"kind": "text", "text": "first"}]}),
        );
        let second = envelope(
            2.0,
            json!({"type": "message.delta", "role": "user", "parts": [{"kind": "text", "text": "second"}]}),
        );
        let document = reduce_all(vec![first, second]);
        assert_eq!(
            message_contents(&document),
            vec![("user".to_string(), "firstsecond".to_string())]
        );
    }

    #[test]
    fn aggregates_one_stream_across_rotating_identity() {
        let events = [
            ("这", "chunk-1"),
            ("是", "chunk-2"),
            (" complete", "chunk-3"),
            (" answer", "chunk-4"),
        ]
        .into_iter()
        .enumerate()
        .map(|(index, (text, message_id))| {
            envelope_with(
                (index + 1) as f64,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": text}]}),
                json!({"messageId": message_id}),
                0,
            )
        })
        .collect();
        let document = reduce_all(events);
        assert_eq!(
            message_contents(&document),
            vec![("assistant".to_string(), "这是 complete answer".to_string())]
        );
        assert_eq!(
            document.messages[0].parts,
            Value::Array(vec![
                json!({"kind": "text", "text": "这是 complete answer"})
            ])
        );
    }

    #[test]
    fn keeps_streams_separated_across_tool_boundary() {
        let document = reduce_all(vec![
            envelope_with(
                1.0,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "before tool"}]}),
                json!({"messageId": "turn-message"}),
                0,
            ),
            envelope_with(
                2.0,
                json!({"type": "tool.started", "tool": {"toolCallId": "tool-1", "name": "read"}}),
                json!({"toolCallId": "tool-1"}),
                0,
            ),
            envelope_with(
                3.0,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "after tool"}]}),
                json!({"messageId": "turn-message"}),
                0,
            ),
        ]);
        assert_eq!(
            message_contents(&document),
            vec![
                ("assistant".to_string(), "before tool".to_string()),
                ("assistant".to_string(), "after tool".to_string()),
            ]
        );
        let ids: std::collections::HashSet<&str> = document
            .messages
            .iter()
            .map(|message| message.id.as_str())
            .collect();
        assert_eq!(ids.len(), document.messages.len());
        let segments: std::collections::HashSet<&str> = document
            .messages
            .iter()
            .map(|message| message.segment_id.as_str())
            .collect();
        assert_eq!(segments.len(), document.messages.len());
    }

    #[test]
    fn keeps_identity_less_chunks_separated_across_tool_boundary() {
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "reasoning.delta", "parts": [{"kind": "text", "text": "before tool"}]}),
            ),
            envelope_with(
                2.0,
                json!({"type": "tool.started", "tool": {"toolCallId": "tool-1", "name": "read"}}),
                json!({"toolCallId": "tool-1"}),
                0,
            ),
            envelope(
                3.0,
                json!({"type": "reasoning.delta", "parts": [{"kind": "text", "text": "after tool"}]}),
            ),
        ]);
        assert_eq!(
            document
                .messages
                .iter()
                .filter(|message| message.role == "reasoning")
                .map(|message| message.content.as_str())
                .collect::<Vec<_>>(),
            vec!["before tool", "after tool"]
        );
    }

    #[test]
    fn keeps_streams_open_across_non_boundary_side_channel_events() {
        // diagnostic.* 是 timeline-only 侧信道（usage/plan/activity/extension 未移植，
        // 边界语义等价：非边界事件不打断流）。
        let mut events = vec![
            envelope_with(
                1.0,
                json!({"type": "reasoning.delta", "parts": [{"kind": "text", "text": "think-"}]}),
                json!({"messageId": "reasoning-a"}),
                0,
            ),
            envelope(
                2.0,
                json!({"type": "diagnostic.notice", "level": "info", "message": "notice"}),
            ),
            envelope(
                3.0,
                json!({"type": "diagnostic.notice", "level": "info", "message": "another notice"}),
            ),
            envelope_with(
                4.0,
                json!({"type": "reasoning.delta", "parts": [{"kind": "text", "text": "together"}]}),
                json!({"messageId": "reasoning-b"}),
                0,
            ),
            envelope_with(
                5.0,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "answer-"}]}),
                json!({"messageId": "assistant-a"}),
                0,
            ),
            envelope(
                6.0,
                json!({"type": "diagnostic.notice", "level": "info", "message": "side"}),
            ),
            envelope_with(
                7.0,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "together"}]}),
                json!({"messageId": "assistant-b"}),
                0,
            ),
        ];
        for (index, event) in events.iter_mut().enumerate() {
            event.event_id = format!("wb-side-{index}");
        }
        let document = reduce_all(events);
        assert_eq!(
            message_contents(&document),
            vec![
                ("reasoning".to_string(), "think-together".to_string()),
                ("assistant".to_string(), "answer-together".to_string()),
            ]
        );
    }

    #[test]
    fn empty_late_terminal_settles_without_creating_a_row() {
        let document = reduce_all(vec![
            envelope_with(
                1.0,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "I will inspect"}]}),
                json!({"messageId": "message-1"}),
                0,
            ),
            envelope_with(
                2.0,
                json!({"type": "tool.started", "tool": {"toolCallId": "tool-1", "name": "read"}}),
                json!({"toolCallId": "tool-1"}),
                0,
            ),
            envelope_with(
                3.0,
                json!({"type": "message.completed", "role": "assistant", "parts": []}),
                json!({"messageId": "message-1"}),
                0,
            ),
        ]);
        assert_eq!(document.messages.len(), 1);
        assert_eq!(document.messages[0].content, "I will inspect");
        assert!(!document.messages[0].running);
    }

    #[test]
    fn does_not_split_when_older_tool_terminal_arrives_late() {
        let document = reduce_all(vec![
            envelope_with(
                1.0,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "before tool"}]}),
                json!({"messageId": "shared"}),
                0,
            ),
            envelope_with(
                2.0,
                json!({"type": "tool.started", "tool": {"toolCallId": "tool-1", "name": "read"}}),
                json!({"toolCallId": "tool-1"}),
                0,
            ),
            envelope_with(
                3.0,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "after "}]}),
                json!({"messageId": "shared"}),
                0,
            ),
            envelope_with(
                4.0,
                json!({"type": "tool.completed", "tool": {"toolCallId": "tool-1", "status": "completed"}}),
                json!({"toolCallId": "tool-1"}),
                0,
            ),
            envelope_with(
                5.0,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "completion"}]}),
                json!({"messageId": "shared"}),
                0,
            ),
        ]);
        let rows: Vec<(String, bool)> = document
            .messages
            .iter()
            .map(|message| (message.content.clone(), message.running))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("before tool".to_string(), false),
                ("after completion".to_string(), true)
            ]
        );
    }

    #[test]
    fn settles_every_running_message_when_session_completes() {
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "reasoning.delta", "parts": [{"kind": "text", "text": "thinking"}]}),
            ),
            envelope(
                2.0,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "answer"}]}),
            ),
            envelope(
                3.0,
                json!({"type": "session.completed", "stopReason": "end_turn"}),
            ),
        ]);
        let running: Vec<bool> = document
            .messages
            .iter()
            .map(|message| message.running)
            .collect();
        assert_eq!(running, vec![false, false]);
        assert_eq!(document.session.status, "completed");
        assert_eq!(document.session.stop_reason.as_deref(), Some("end_turn"));
    }

    #[test]
    fn settles_superseded_text_segments_on_semantic_boundary_start() {
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "reasoning.delta", "parts": [{"kind": "text", "text": "thinking"}]}),
            ),
            envelope(
                2.0,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "answer before tool"}]}),
            ),
            envelope_with(
                3.0,
                json!({"type": "tool.started", "tool": {"toolCallId": "tool-1", "name": "read"}}),
                json!({"toolCallId": "tool-1"}),
                0,
            ),
        ]);
        let rows: Vec<(String, bool)> = document
            .messages
            .iter()
            .map(|message| (message.role.clone(), message.running))
            .collect();
        assert_eq!(
            rows,
            vec![
                ("reasoning".to_string(), false),
                ("assistant".to_string(), false)
            ]
        );
    }

    #[test]
    fn folds_adjacent_optimistic_and_authoritative_copies() {
        let optimistic = envelope_with(
            1.0,
            json!({"type": "message.delta", "role": "user", "parts": [{"kind": "text", "text": "one prompt"}]}),
            json!({"interactionId": "client-1"}),
            1,
        );
        let authoritative = envelope_with(
            2.0,
            json!({"type": "message.delta", "role": "user", "parts": [{"kind": "text", "text": "one prompt"}]}),
            json!({}),
            0,
        );
        let document = reduce_all(vec![optimistic, authoritative]);
        assert_eq!(document.messages.len(), 1);
        assert_eq!(document.messages[0].content, "one prompt");
        assert_eq!(document.messages[0].identity, Value::Object(Map::new()));
        assert!(document.messages[0].id.starts_with(&format!("{SESSION}:")));
    }

    #[test]
    fn folds_late_optimistic_append_by_request_identity() {
        let authoritative = envelope_with(
            1.0,
            json!({"type": "message.delta", "role": "user", "parts": [{"kind": "text", "text": "prompt"}]}),
            json!({"interactionId": "client-late"}),
            0,
        );
        let assistant = envelope(
            2.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "answer"}]}),
        );
        let optimistic = envelope_with(
            3.0,
            json!({"type": "message.delta", "role": "user", "parts": [{"kind": "text", "text": "prompt"}]}),
            json!({"interactionId": "client-late"}),
            1,
        );
        let document = reduce_all(vec![authoritative, assistant, optimistic]);
        assert_eq!(
            message_contents(&document),
            vec![
                ("user".to_string(), "prompt".to_string()),
                ("assistant".to_string(), "answer".to_string()),
            ]
        );
    }

    #[test]
    fn does_not_suppress_new_optimistic_prompt_over_identical_history() {
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "message.delta", "role": "user", "parts": [{"kind": "text", "text": "continue"}]}),
            ),
            envelope(
                2.0,
                json!({"type": "message.completed", "role": "assistant", "parts": [{"kind": "text", "text": "old answer"}]}),
            ),
            envelope_with(
                3.0,
                json!({"type": "message.delta", "role": "user", "parts": [{"kind": "text", "text": "continue"}]}),
                json!({"interactionId": "new-request"}),
                1,
            ),
        ]);
        assert_eq!(
            message_contents(&document),
            vec![
                ("user".to_string(), "continue".to_string()),
                ("assistant".to_string(), "old answer".to_string()),
                ("user".to_string(), "continue".to_string()),
            ]
        );
        assert_eq!(
            document.messages.last().map(|message| message.optimistic),
            Some(Some(true))
        );
    }

    #[test]
    fn reasoning_segments_carry_thought_duration() {
        let document = create_workbench_document(SESSION);
        // reasoning.delta (t0) → reasoning.completed (t1)：duration = t1 - t0。
        let mut delta = envelope_with(
            1.0,
            json!({"type": "reasoning.delta", "parts": [{"kind": "text", "text": "think"}]}),
            json!({}),
            0,
        );
        delta.recorded_at = "2026-08-21T00:00:01.000Z".to_string();
        delta.occurred_at = Some("2026-08-21T00:00:01.000Z".to_string());
        let mut completed = envelope_with(
            2.0,
            json!({"type": "reasoning.completed", "parts": []}),
            json!({}),
            0,
        );
        completed.occurred_at = Some("2026-08-21T00:00:03.500Z".to_string());
        let mut document = document;
        reduce_workbench_event(&mut document, &delta).expect("fold");
        reduce_workbench_event(&mut document, &completed).expect("fold");
        assert_eq!(document.messages[0].thought_duration_ms, Some(2500.0));
        assert!(!document.messages[0].running);
    }

    #[test]
    fn reasoning_redaction_secures_content() {
        let document = reduce_all(vec![
            envelope_with(
                1.0,
                json!({"type": "reasoning.delta", "parts": [{"kind": "text", "text": "secret thought"}]}),
                json!({"messageId": "r-1"}),
                0,
            ),
            envelope_with(
                2.0,
                json!({"type": "reasoning.completed", "parts": [{"kind": "text", "text": "secret thought"}]}),
                json!({"messageId": "r-1"}),
                0,
            ),
            envelope_with(
                3.0,
                json!({"type": "reasoning.redacted", "parts": [{"kind": "text", "text": "secret thought"}], "reason": "provider redaction"}),
                json!({"messageId": "r-1"}),
                0,
            ),
        ]);
        assert_eq!(document.messages.len(), 1);
        assert_eq!(document.messages[0].content, "");
        assert_eq!(document.messages[0].redacted, Some(true));
        assert_eq!(
            document.messages[0].redacted_reason.as_deref(),
            Some("provider redaction")
        );
    }

    #[test]
    fn applied_ranges_cover_and_merge_like_the_ts_contract() {
        // coverage 信封按区间幂等：同一跨度投影两次不重复。
        let envelope_once = envelope_full(
            6.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "abc"}]}),
            json!({"messageId": "msg-1"}),
            0,
            Some((1.0, 6.0)),
            "s-6".to_string(),
        );
        let mut document = create_workbench_document(SESSION);
        reduce_workbench_event(&mut document, &envelope_once).expect("fold");
        let applied = document.applied_ranges.clone();
        let messages_before = document.messages.len();
        reduce_workbench_event(&mut document, &envelope_once).expect("fold");
        assert_eq!(document.applied_ranges, applied);
        assert_eq!(document.messages.len(), messages_before);
        assert_eq!(document.messages[0].content, "abc");

        // live 逐 chunk 覆盖后单元 segment 到达：coverage 互斥，不重复拼接。
        let mut document = create_workbench_document(SESSION);
        for sequence in 1..=6i64 {
            let envelope = envelope_full(
                sequence as f64,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": sequence.to_string()}]}),
                json!({"messageId": "msg-1"}),
                0,
                Some((sequence as f64, sequence as f64)),
                format!("s-{sequence}"),
            );
            reduce_workbench_event(&mut document, &envelope).expect("fold");
        }
        assert_eq!(document.messages[0].content, "123456");
        let unit = envelope_full(
            6.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "123456"}]}),
            json!({"messageId": "msg-1"}),
            0,
            Some((1.0, 6.0)),
            "unit".to_string(),
        );
        let content_before = document.messages[0].content.clone();
        reduce_workbench_event(&mut document, &unit).expect("fold");
        assert_eq!(document.messages[0].content, content_before);
        assert_eq!(document.applied_ranges, vec![(1, 6)]);
    }

    #[test]
    fn non_journal_envelopes_stay_event_id_idempotent() {
        let mut document = create_workbench_document(SESSION);
        let optimistic = envelope_with(
            7.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "opt"}]}),
            json!({"messageId": "msg-1"}),
            1,
        );
        reduce_workbench_event(&mut document, &optimistic).expect("fold");
        assert!(document.applied_event_ids.contains(&optimistic.event_id));
        assert!(document.applied_ranges.is_empty());
        let applied = document.applied_event_ids.clone();
        reduce_workbench_event(&mut document, &optimistic).expect("fold");
        assert_eq!(document.applied_event_ids, applied);
    }

    #[test]
    fn fail_closed_for_unported_event_types() {
        let mut document = create_workbench_document(SESSION);
        let usage = envelope(
            1.0,
            json!({"type": "usage.updated", "usage": {"inputTokens": 3}}),
        );
        assert!(reduce_workbench_event(&mut document, &usage).is_err());
        // 整页拒绝：document 不动。
        let plan = envelope(2.0, json!({"type": "plan.replaced", "entries": []}));
        assert!(project_batch(&mut document, vec![plan]).is_err());
        assert!(document.applied_event_ids.is_empty());
    }

    #[test]
    fn session_commands_field_is_fail_closed() {
        let mut document = create_workbench_document(SESSION);
        let commands = envelope(
            1.0,
            json!({"type": "session.commands-updated", "commands": [{"name": "/compact"}]}),
        );
        assert!(reduce_workbench_event(&mut document, &commands).is_err());
    }

    #[test]
    fn iso_parser_matches_js_for_utc_forms() {
        assert_eq!(
            parse_iso_to_ms("2026-08-21T00:00:00.000Z"),
            Some(1_787_270_400_000.0)
        );
        assert_eq!(parse_iso_to_ms("1970-01-01T00:00:00.000Z"), Some(0.0));
        assert_eq!(
            parse_iso_to_ms("2026-08-21"),
            parse_iso_to_ms("2026-08-21T00:00:00.000Z")
        );
        assert_eq!(
            parse_iso_to_ms("2026-08-21T00:00:03.500Z"),
            Some(1_787_270_403_500.0)
        );
        // 时区偏移：08:00-8h 等价 UTC 当日 16:00 前一日折算。
        assert_eq!(
            parse_iso_to_ms("2026-08-21T08:00:00+08:00"),
            parse_iso_to_ms("2026-08-21T00:00:00.000Z")
        );
        // 无时区按 UTC（缺口：JS 按本地时区）。
        assert_eq!(
            parse_iso_to_ms("2026-08-21T00:00:00"),
            parse_iso_to_ms("2026-08-21T00:00:00Z")
        );
        assert_eq!(parse_iso_to_ms("not-a-date"), None);
    }

    #[test]
    fn frame_round_trip_preserves_envelopes() {
        // Rust 侧没有生产编码器（编码器在 TS parity 测试侧）；这里用最小手工帧
        // 验证解码不变量。构造一个双事件帧：一个热路径文本 delta + 一个冷 JSON 载荷。
        let mut pool: Vec<u8> = Vec::new();
        let put = |pool: &mut Vec<u8>, text: &str| -> (u32, u32) {
            let offset = pool.len() as u32;
            pool.extend_from_slice(text.as_bytes());
            (offset, text.len() as u32)
        };
        let event_id = put(&mut pool, "wb-frame-1");
        let tool_event_id = put(&mut pool, "wb-frame-2");
        let session_id = put(&mut pool, "session-1");
        let recorded_at = put(&mut pool, "2026-08-21T00:00:00.000Z");
        let turn_id = put(&mut pool, "turn-9");
        let provider = put(&mut pool, "peri");
        let source_id = put(&mut pool, "wire-1");
        // 单文本通道放的是 delta 正文本身（零 JSON）；JSON 只进冷事件 extra 通道。
        let delta_text = put(&mut pool, "hello");
        let extra = r#"{"tool":{"toolCallId":"tool-9","name":"read"}}"#;
        let (extra_offset, extra_len) = put(&mut pool, extra);

        let mut frame: Vec<u8> = Vec::new();
        frame.extend_from_slice(&FRAME_MAGIC);
        frame.extend_from_slice(&FRAME_VERSION.to_le_bytes());
        frame.extend_from_slice(&2u32.to_le_bytes());
        frame.extend_from_slice(&(pool.len() as u32).to_le_bytes());
        frame.extend_from_slice(&pool);
        let write_event = |frame: &mut Vec<u8>,
                           sequence: f64,
                           type_index: u32,
                           flags: u32,
                           pairs: [(u32, u32); FRAME_PAIRS],
                           coverage: Option<(f64, f64)>| {
            frame.extend_from_slice(&sequence.to_le_bytes());
            frame.extend_from_slice(&0f64.to_le_bytes());
            frame.extend_from_slice(&type_index.to_le_bytes());
            frame.extend_from_slice(&flags.to_le_bytes());
            for (offset, length) in pairs {
                frame.extend_from_slice(&offset.to_le_bytes());
                frame.extend_from_slice(&length.to_le_bytes());
            }
            if let Some((start, end)) = coverage {
                frame.extend_from_slice(&start.to_le_bytes());
                frame.extend_from_slice(&end.to_le_bytes());
            }
        };
        let empty = (0u32, 0u32);
        // 事件 1：message.delta，role=user（位 7..9 = 0），单文本部件 kind=text。
        let flags_1 = 0
            | FLAG_HAS_ROLE
            | (0 << FLAG_ROLE_SHIFT)
            | (1 << FLAG_PARTS_MODE_SHIFT)
            | (0 << FLAG_PART_KIND_SHIFT);
        write_event(
            &mut frame,
            1.0,
            1,
            flags_1,
            [
                event_id,
                session_id,
                recorded_at,
                empty,
                empty,
                empty,
                empty,
                empty,
                empty,
                empty,
                provider,
                source_id,
                empty,
                empty,
                empty,
                delta_text,
                empty,
            ],
            None,
        );
        // 事件 2：tool.started（typeIndex 6），富载荷走 JSON 通道 + extra；
        // parts 通道缺席（mode 0），turnId 落在 identity 槽位。
        let flags_2 = 0u32;
        write_event(
            &mut frame,
            2.0,
            6,
            flags_2,
            [
                tool_event_id,
                session_id,
                recorded_at,
                empty,
                turn_id,
                empty,
                empty,
                empty,
                empty,
                empty,
                provider,
                source_id,
                empty,
                empty,
                empty,
                empty,
                (extra_offset, extra_len),
            ],
            None,
        );
        let envelopes = decode_frame(&frame).expect("decode");
        assert_eq!(envelopes.len(), 2);
        assert_eq!(envelopes[0].event_type, "message.delta");
        assert_eq!(
            envelopes[0].event["parts"],
            Value::Array(vec![json!({"kind": "text", "text": "hello"})])
        );
        assert_eq!(envelopes[1].event_type, "tool.started");
        assert_eq!(
            envelopes[1].event["tool"]["toolCallId"],
            Value::String("tool-9".into())
        );
        assert_eq!(envelopes[1].identity.turn_id.as_deref(), Some("turn-9"));

        // 折叠走通：文本 delta 进消息，tool.started 建活动节点并打流边界。
        let mut document = create_workbench_document(SESSION);
        project_batch(&mut document, envelopes).expect("fold");
        assert_eq!(document.messages.len(), 1);
        assert_eq!(document.messages[0].content, "hello");
        assert_eq!(document.activities.len(), 1);
        let entry = document
            .timeline
            .iter()
            .find(|entry| entry.kind == "tool")
            .expect("tool entry");
        assert_eq!(entry.stream_boundary, Some(true));
    }

    #[test]
    fn patch_diff_reports_only_changed_rows() {
        let mut document = create_workbench_document(SESSION);
        let first = envelope_with(
            1.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "a"}]}),
            json!({"messageId": "m-1"}),
            0,
        );
        let patch = project_batch(&mut document, vec![first]).expect("patch");
        assert_eq!(patch.message_upserts.len(), 1);
        assert_eq!(patch.message_upserts[0].index, 0);
        assert_eq!(patch.applied_event_ids_appended.len(), 1);

        let second = envelope_with(
            2.0,
            json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "b"}]}),
            json!({"messageId": "m-1"}),
            0,
        );
        let patch = project_batch(&mut document, vec![second]).expect("patch");
        // 追加的 delta 折进同一条消息：单条 upsert（index 0）。
        assert_eq!(patch.message_upserts.len(), 1);
        assert_eq!(patch.message_upserts[0].index, 0);
        assert_eq!(patch.applied_event_ids_appended.len(), 1);
    }

    #[test]
    fn document_value_matches_ts_shape() {
        let document = reduce_all(vec![
            envelope_with(
                1.0,
                json!({"type": "message.delta", "role": "user", "parts": [{"kind": "text", "text": "q"}]}),
                json!({"turnId": "t-1"}),
                0,
            ),
            envelope(
                2.0,
                json!({"type": "session.status-updated", "status": "ready"}),
            ),
        ]);
        let value = document.to_document_value();
        let object = value.as_object().expect("object");
        for key in [
            "sessionId",
            "revision",
            "appliedEventIds",
            "appliedRanges",
            "timeline",
            "messages",
            "activities",
            "interactions",
            "extensions",
            "session",
            "assist",
            "diagnostics",
            "plan",
            "goal",
            "lifecycle",
            "systemErrors",
        ] {
            assert!(object.contains_key(key), "缺少 {key}");
        }
        assert_eq!(object["session"]["status"], Value::String("ready".into()));
        assert_eq!(object["session"]["commands"], Value::Array(vec![]));
        assert_eq!(object["assist"], serde_json::json!({ "files": [] }));
        assert_eq!(object["plan"]["sessionId"], Value::String(SESSION.into()));
        assert_eq!(object["lifecycle"], serde_json::json!({ "history": [] }));
        let message = &object["messages"][0];
        assert_eq!(
            message["id"],
            Value::String(format!("{SESSION}:{}", document.messages[0].segment_id))
        );
        assert_eq!(message["identity"]["turnId"], Value::String("t-1".into()));
        assert_eq!(message["source"]["provider"], Value::String("peri".into()));
    }
}
