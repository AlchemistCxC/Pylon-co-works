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
//!   18 组 (offset,len) 变长段（v2 末组是 provenance 富字段 JSON）。回放按页合批，
//!   一次 `append_batch` 一页。
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
//! - v2 帧在 v1 的 17 组变长段后追加第 18 组：**provenance 富字段 JSON**
//!   （provider/importId/sourceOrdinal/orderConfidence/collectionComplete/synthetic）。
//!   origin/trust 仍走 flags 低 4 位。activity/extension 节点把完整 provenance 写进
//!   document（C09/C10 可追溯性），v1 槽位装不下这些字段，故升版本。
//!
//! # 已知语义缺口（无法逐字复现，见交付清单）
//!
//! - `localeCompare`（乱序兜底排序的同 sequence tie-break）无 ICU 不可复现，
//!   Rust 侧按 UTF-8 字节序；journal 行本就按 sequence 升序，tie-break 仅在
//!   异常输入上可达。
//! - `Date.parse` 只实现 ISO 形态；无时区的 datetime 按 UTC（JS 按本地时区，
//!   测试环境 TZ=UTC 时一致）。
//! - document 内的开放对象（activity/plan/goal/lifecycle/usage/commands/options）
//!   以 serde_json Map（字典序）承载，TS 侧对象是插入序——仅影响键序不影响
//!   内容，parity 断言用结构等值（toEqual）。

use std::collections::HashSet;

use serde::Serialize;
use serde_json::{Map, Value};
use wasm_bindgen::prelude::*;

use super::content_part::{
    append_parts_with_merge, canonicalize_js_numbers, coalesce_adjacent_display_text_parts,
    coalesce_adjacent_reasoning_parts, create_unknown_content_part, js_number_of, js_string_of,
    js_trim, merge_display_text_pair, merge_reasoning_pair, parse_content_part,
};
use super::coverage;
use super::goal_model;
use super::lifecycle_model;
use super::session_surface;

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
    /// v2 帧第 18 槽：TS `WorkbenchEventProvenance` 的可选富字段
    /// （provider/importId/sourceOrdinal/orderConfidence/collectionComplete/synthetic）。
    pub provenance_extra: Option<Map<String, Value>>,
    pub coverage: Option<(f64, f64)>,
    pub event: Value,
}

impl SemanticEnvelope {
    /// 以另一份事件的 `Value` 重建信封，**只克隆 `event` 之外的字段**。
    ///
    /// 不要写成 `SemanticEnvelope { event, ..self.clone() }`：结构体更新语法会先把
    /// `event` 整棵树也克隆一份再被覆盖掉——逐事件折叠里那是一次纯浪费的深拷贝
    /// （20k delta 的同 harness 对照里，这类按事件树克隆是折叠比 TS 慢的主因之一）。
    fn with_event(&self, event: Value) -> SemanticEnvelope {
        SemanticEnvelope {
            event_type: self.event_type.clone(),
            sequence: self.sequence,
            event_id: self.event_id.clone(),
            session_id: self.session_id.clone(),
            recorded_at: self.recorded_at.clone(),
            occurred_at: self.occurred_at.clone(),
            identity: self.identity.clone(),
            source: self.source.clone(),
            provenance_origin: self.provenance_origin,
            provenance_trust: self.provenance_trust,
            provenance_extra: self.provenance_extra.clone(),
            coverage: self.coverage,
            event,
        }
    }

    /// `envelope.occurredAt ?? envelope.recordedAt`（消息 time 字段与时长基准）。
    fn occurred_or_recorded(&self) -> &str {
        self.occurred_at.as_deref().unwrap_or(&self.recorded_at)
    }

    /// TS `envelope.provenance` 的完整对象：origin/trust 走 flags，富字段走 v2 槽。
    pub fn provenance_value(&self) -> Value {
        let mut object = Map::new();
        object.insert(
            "origin".to_string(),
            Value::String(provenance_origin_name(self.provenance_origin).to_string()),
        );
        object.insert(
            "trust".to_string(),
            Value::String(provenance_trust_name(self.provenance_trust).to_string()),
        );
        if let Some(extra) = &self.provenance_extra {
            for (key, value) in extra {
                object.insert(key.clone(), value.clone());
            }
        }
        Value::Object(object)
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

/// provenance trust 位序名（bit 3：0 = authoritative，1 = unverified）。
pub fn provenance_trust_name(trust: u8) -> &'static str {
    if trust == 0 {
        "authoritative"
    } else {
        "unverified"
    }
}

/// TS `ACTIVITY_STATUSES`（workbenchEventSchema）：activity.progress 的 patch.status
/// 只认这份词表，词表外稳定降级为 unknown（不猜）。
pub const ACTIVITY_STATUSES: [&str; 12] = [
    "pending",
    "starting",
    "running",
    "paused",
    "completed",
    "failed",
    "interrupted",
    "cancel-requested",
    "cancelled",
    "timeout",
    "blocked",
    "unknown",
];

fn is_activity_status(value: &str) -> bool {
    ACTIVITY_STATUSES.contains(&value)
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
    /// 归一化命令目录（session.commands-updated 整体替换）。
    pub commands: Vec<Value>,
    /// 归一化配置项（session.config-updated；空列表不宣告 → 不清空既有候选面）。
    pub options: Vec<Value>,
    /// 归一化 usage 快照（含 budget）。
    pub usage: Option<Value>,
}

impl SessionSurfaceState {
    pub fn to_value(&self) -> Value {
        let mut object = Map::new();
        object.insert("status".to_string(), Value::String(self.status.clone()));
        if let Some(stop_reason) = &self.stop_reason {
            object.insert("stopReason".to_string(), Value::String(stop_reason.clone()));
        }
        if let Some(model) = &self.model {
            object.insert("model".to_string(), Value::String(model.clone()));
        }
        if let Some(mode) = &self.mode {
            object.insert("mode".to_string(), Value::String(mode.clone()));
        }
        object.insert("commands".to_string(), Value::Array(self.commands.clone()));
        object.insert("options".to_string(), Value::Array(self.options.clone()));
        if let Some(usage) = &self.usage {
            object.insert("usage".to_string(), usage.clone());
        }
        Value::Object(object)
    }
}

/// 投影文档（可丢弃）。`activities` / `interactions` / `diagnostics` /
/// `system_errors` / `extensions` / `assist` / `plan` / `goal` / `lifecycle` /
/// `session.usage|commands|options` 用 JSON 对象透传——TS 侧这些节点是结构化
/// 字面量且字段集开放（未知 provider 字段必须保活可见，K14），投影核只做字段
/// 读写，用 Value 建模才能逐字段保真。
#[derive(Debug, Clone)]
pub struct WorkbenchDocument {
    pub session_id: String,
    pub revision: f64,
    pub applied_event_ids: Vec<String>,
    /// `applied_event_ids` 的成员位（#205 的对位物）。TS 侧是 `Set`，移植成 `Vec` 后
    /// 幂等判据的 `contains` 退化成 Θ(N) 线性扫——它落在**每个**事件上，于是冷重放
    /// 又回到 Θ(N²)。只服务成员判据，不进 wire/patch（`to_value` 不读它）。
    pub applied_event_id_set: HashSet<String>,
    pub applied_ranges: coverage::CoverageRanges,
    pub timeline: Vec<TimelineEntry>,
    pub messages: Vec<WorkbenchMessage>,
    pub activities: Vec<Value>,
    pub interactions: Vec<Value>,
    pub extensions: Vec<Value>,
    pub session: SessionSurfaceState,
    pub assist: Value,
    pub diagnostics: Vec<Value>,
    pub plan: Value,
    pub goal: Value,
    pub lifecycle: Value,
    pub system_errors: Vec<Value>,
    /// timeline 派生读数的增量缓存（#205 的对位物）。不是投影语义的一部分，
    /// 也不进 wire/patch（`to_value` 不读它）。
    pub timeline_cache: TimelineCache,
}

/// TS `createWorkbenchDocument`。
pub fn create_workbench_document(session_id: &str) -> WorkbenchDocument {
    WorkbenchDocument {
        session_id: session_id.to_string(),
        revision: 0.0,
        applied_event_ids: Vec::new(),
        applied_event_id_set: HashSet::new(),
        applied_ranges: Vec::new(),
        timeline: Vec::new(),
        messages: Vec::new(),
        activities: Vec::new(),
        interactions: Vec::new(),
        extensions: Vec::new(),
        session: SessionSurfaceState {
            status: "idle".to_string(),
            stop_reason: None,
            model: None,
            mode: None,
            commands: Vec::new(),
            options: Vec::new(),
            usage: None,
        },
        assist: serde_json::json!({ "files": [] }),
        diagnostics: Vec::new(),
        plan: goal_model::empty_plan_state(session_id),
        goal: goal_model::empty_goal_state(),
        lifecycle: lifecycle_model::empty_lifecycle_state(),
        system_errors: Vec::new(),
        timeline_cache: TimelineCache::default(),
    }
}

/// f64 → JSON number：整值落在安全整数域时输出整数（与 JS number 显示一致）。
pub(super) fn js_number_value(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

impl WorkbenchDocument {
    /// 全量读数（parity / 冷刷新用；边界增量走 [`WorkbenchPatch`]）。
    pub fn to_document_value(&self) -> Value {
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
        object.insert(
            "extensions".to_string(),
            Value::Array(self.extensions.clone()),
        );
        object.insert("session".to_string(), self.session.to_value());
        object.insert("assist".to_string(), self.assist.clone());
        object.insert(
            "diagnostics".to_string(),
            Value::Array(self.diagnostics.clone()),
        );
        object.insert("plan".to_string(), self.plan.clone());
        object.insert("goal".to_string(), self.goal.clone());
        object.insert("lifecycle".to_string(), self.lifecycle.clone());
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
    // session 面是低频小对象：整面携带（status/stopReason/model/mode/commands/
    // options/usage），消费方整面覆盖即可，不做字段级 diff。
    WorkbenchPatch {
        revision: after.revision,
        applied_event_ids_appended: after.applied_event_ids[before.applied_event_ids.len()..]
            .to_vec(),
        applied_ranges: after.applied_ranges.clone(),
        timeline_upserts,
        message_upserts,
        session: after.session.to_value(),
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

pub(super) fn string_value(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|s| !js_trim(s).is_empty())
}

/// JS truthy（字符串形态）：非空即可，不 trim（`" "` 在 JS 里为真）。
pub(super) fn truthy_string(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| !s.is_empty())
}

fn is_record_value(value: &Value) -> bool {
    value.is_object()
}

/// timeline 派生读数的增量缓存（#205 的位）。
///
/// `terminal_sequence` 是「已扫过的 timeline 前缀里终态 session 条目的最大 sequence」。
/// 增量延展成立的两个前提都已在代码里核对过：条目一旦建立就**不可变**——`kind` 与
/// `data` 都不再被改写（`update_timeline` 只动
/// `status`/`title`/`summary`/`stream_boundary`，而 `is_terminal_session_entry` 读的是
/// `kind` 与 `data`）；折叠过程中 timeline **只增不减**（无 retain/remove/sort，
/// 乱序兜底走 `insert_by_sequence` 仍保持 sequence 升序）。因此只需看过新增的后缀。
/// `scanned > timeline.len()`（timeline 被重建或缩短）时缓存整份作废、重扫——
/// 这是唯一的失效路径，且是保守方向。
#[derive(Debug, Clone, Default)]
pub struct TimelineCache {
    scanned: usize,
    terminal_sequence: Option<f64>,
}

/// timeline 上「sequence ∈ (after, before) 且满足谓词」的存在性查询。
///
/// timeline 恒按 sequence 升序，故先二分定位 `sequence > after` 的起点，再**只在窗口内**
/// 判谓词——与逐条扫全表逐字等价，代价从 Θ(T) 降到 Θ(log T + 窗口)。这正是 #205 在 TS 侧
/// 用派生索引消灭的那处 Θ(N·T)：它落在最高频的 delta 上，把冷重放压成 Θ(N²)。
///
/// 比 TS 的索引强的一点：谓词在**查询时**求值，所以 `update_timeline` 事后把某个 tool 条目
/// 标成文本流边界，结果立刻正确——索引方案要靠重建来兜这种情况。
fn any_entry_in_sequence_window(
    document: &WorkbenchDocument,
    after: f64,
    before: f64,
    predicate: impl Fn(&TimelineEntry) -> bool,
) -> bool {
    let start = document
        .timeline
        .partition_point(|entry| entry.sequence <= after);
    document.timeline[start..]
        .iter()
        .take_while(|entry| entry.sequence < before)
        .any(predicate)
}

fn terminal_session_sequence(document: &mut WorkbenchDocument) -> f64 {
    let length = document.timeline.len();
    if document.timeline_cache.scanned > length {
        document.timeline_cache = TimelineCache::default();
    }
    let scanned = document.timeline_cache.scanned;
    let mut latest = document
        .timeline_cache
        .terminal_sequence
        .unwrap_or(f64::NEG_INFINITY);
    if scanned < length {
        for entry in &document.timeline[scanned..] {
            if is_terminal_session_entry(entry) {
                latest = latest.max(entry.sequence);
            }
        }
        document.timeline_cache.scanned = length;
        document.timeline_cache.terminal_sequence = Some(latest);
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
    !any_entry_in_sequence_window(
        document,
        previous_sequence,
        envelope_sequence,
        is_text_stream_boundary,
    )
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
    text_from_slice(parts.as_array().map(Vec::as_slice).unwrap_or(&[]))
}

/// 文本抽取的切片版：热路径手里已经有一份 `&[Value]`，不必再造一个
/// `Value::Array(clone())` 只为了读文本（那是逐事件一次整树克隆）。
fn text_from_slice(items: &[Value]) -> String {
    let mut out = String::new();
    {
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

/// `provider_identity_key` 的**结构体直读版**：按同一优先级取第一个存在的身份字段。
///
/// 不要为了取一个字段去建整棵 JSON Map（BTreeMap + 最多 6 次字符串克隆）——这是
/// message / reasoning 归约器里的**逐事件**调用，属于折叠耗时里按事件分配的一部分。
/// 优先级与 `provider_identity_key` 逐字一致（messageId → turnId → toolCallId →
/// taskId → interactionId，**不含 runId**，值版也没读它）；`Some("")` 同样短路返回空串，
/// 与值版 `get(key)` 命中即返回的语义一致。
fn provider_identity_key_of(identity: &Identity) -> String {
    for candidate in [
        &identity.message_id,
        &identity.turn_id,
        &identity.tool_call_id,
        &identity.task_id,
        &identity.interaction_id,
    ] {
        // 判据必须与值版逐字一致：值版走 `string_value`，而它按
        // `!js_trim(s).is_empty()` 过滤——**空串与「仅空白」都算缺席**
        // （`js_trim` 含 U+FEFF 等 JS 空白）。这条由 `provider_identity_tests`
        // 的 2^6 组合扫描（交替非空/空串/仅空白）钉死。
        if let Some(value) = candidate.as_ref().filter(|text| !js_trim(text).is_empty()) {
            return value.clone();
        }
    }
    String::new()
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

pub(super) fn normalize_normalized_error(raw: &Value, depth: usize) -> Option<Value> {
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
        // TS：redact(undefined) === undefined → 键不存在。
        if let Some(request) = event.get("request") {
            interaction.insert(
                "request".to_string(),
                redact_sensitive_interaction_payload(request),
            );
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
    let incoming_provider = provider_identity_key_of(&envelope.identity);
    let append = previous_index.is_some_and(|index| {
        let previous = &document.messages[index];
        previous.role == role
            && text_stream_continues(document, previous.sequence, envelope.sequence)
            && (role == "assistant"
                || (!incoming_provider.is_empty()
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
            // 只取标量与判据需要的字段：`content`/`parts` 是累计量，逐事件克隆它们
            // 就是 Θ(N²)（下面的合并改成就地下沉，不需要累积值）。
            let (previous_role, previous_running, previous_sequence) = {
                let previous = &document.messages[index];
                (previous.role == role, previous.running, previous.sequence)
            };
            if previous_role
                && !previous_running
                && text_stream_continues(document, previous_sequence, envelope.sequence)
                && envelope.sequence < previous_sequence.max(terminal_session_sequence(document))
            {
                let message = &mut document.messages[index];
                message.content.push_str(&content);
                append_parts_in_place(&mut message.parts, &parts, merge_display_text_pair);
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
                let explicit_provider_boundary = !incoming_provider.is_empty()
                    && !previous_provider.is_empty()
                    && incoming_provider != previous_provider;
                let same_or_missing_turn = incoming_turn.is_none_or(|incoming| {
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
        let identity_is_present = identity_is_present(&envelope.identity);
        // 只在需要回退时才取上一份身份：整份 `message.clone()` 含累计 content/parts，
        // 逐事件做即 Θ(N²)。
        let fallback_identity = if identity_is_present {
            None
        } else {
            Some(document.messages[index].identity.clone())
        };
        let message = &mut document.messages[index];
        message.content.push_str(&content);
        append_parts_in_place(&mut message.parts, &parts, merge_display_text_pair);
        message.identity = if identity_is_present {
            envelope.identity.to_value()
        } else {
            fallback_identity.expect("非空身份已排除")
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

/// 就地把 `incoming` 的部件下沉进 `target`（`target` 已是合并态）。
///
/// 取代「`concat_parts` 出累计数组 + `coalesce_*` 整份重建」：后者每事件 O(累计)
/// ——`#205` 的线性化在部件层缺的就是这一块（护栏用例 20k delta 实测 62s / 预算 2.5s）。
fn append_parts_in_place(
    target: &mut Value,
    incoming: &Value,
    merge_one: fn(&mut Value, &Value) -> bool,
) {
    let Some(items) = incoming.as_array() else {
        // 非数组按 TS 的 `concat` 语义忽略（防御性，信封校验保证数组）。
        return;
    };
    append_parts_slice_in_place(target, items, merge_one);
}

/// 切片版：热路径传 `&[Value]` 即可，省掉 `Value::Array(clone())` 那层整树克隆。
fn append_parts_slice_in_place(
    target: &mut Value,
    incoming: &[Value],
    merge_one: fn(&mut Value, &Value) -> bool,
) {
    if !target.is_array() {
        *target = Value::Array(Vec::new());
    }
    let slot = target.as_array_mut().expect("just ensured");
    append_parts_with_merge(slot, incoming, merge_one);
}

/// `Identity` 是否有任何字段存在——与 `identity.to_value().as_object().is_empty()` 等价。
///
/// 值版为了判空要先建一整棵 Map（BTreeMap + 每字段一次字符串克隆），而这是
/// message/reasoning 热路径上的逐事件调用。
fn identity_is_present(identity: &Identity) -> bool {
    identity.turn_id.is_some()
        || identity.message_id.is_some()
        || identity.tool_call_id.is_some()
        || identity.task_id.is_some()
        || identity.run_id.is_some()
        || identity.interaction_id.is_some()
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
    let incoming_identity = provider_identity_key_of(&envelope.identity);
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
    // 部件**借用**而不克隆：这段热路径此前对同一份 parts 做了 5 次整树克隆
    // （`parts` → `parts_items` → coalesce 重建 → `reasoning_parts.clone()` →
    // `Value::Array(...)` 包装），每次都是逐事件的树与字符串分配。
    // 文本抽取在「原始 parts」与「已合并 parts」上结果一致（合并只把相邻文本部件的
    // text 相接，不改变整体拼接），故 `content` 直接用原始切片算。
    // C01：redacted 时不保留原文（D06——raw 不进 projection），只留安全占位。
    let parts_value = event.get("parts");
    let parts_slice: &[Value] = parts_value
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let parts_owned = || {
        parts_value
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()))
    };
    let redacted = envelope.event_type == "reasoning.redacted";
    let content = if redacted {
        String::new()
    } else {
        text_from_slice(parts_slice)
    };
    if envelope.event_type == "reasoning.completed" && content.is_empty() {
        settle_reasoning_segment(document, envelope);
        return;
    }
    let previous_index = document.messages.len().checked_sub(1);
    let incoming_provider_identity = provider_identity_key_of(&envelope.identity);
    let previous_provider_identity = previous_index
        .map(|index| provider_identity_key(&document.messages[index].identity))
        .unwrap_or_default();
    let same_terminal_identity = !incoming_provider_identity.is_empty()
        && incoming_provider_identity == previous_provider_identity;
    let has_tool_boundary_between = previous_index.is_some_and(|index| {
        any_entry_in_sequence_window(
            document,
            document.messages[index].sequence,
            envelope.sequence,
            |entry| entry.kind == "tool",
        )
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
                    secured.parts = parts_owned();
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
            let (previous_is_reasoning, previous_running, previous_sequence) = {
                let previous = &document.messages[index];
                (
                    previous.role == "reasoning",
                    previous.running,
                    previous.sequence,
                )
            };
            if previous_is_reasoning
                && !previous_running
                && !has_tool_boundary_between
                && text_stream_continues(document, previous_sequence, envelope.sequence)
                && envelope.sequence < previous_sequence.max(terminal_session_sequence(document))
            {
                let message = &mut document.messages[index];
                message.content.push_str(&content);
                append_parts_slice_in_place(&mut message.parts, parts_slice, merge_reasoning_pair);
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
                let same_or_missing_turn = incoming_turn.is_none_or(|incoming| {
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
        let identity_is_present = identity_is_present(&envelope.identity);
        let fallback_identity = if identity_is_present {
            None
        } else {
            Some(document.messages[index].identity.clone())
        };
        let message = &mut document.messages[index];
        if redacted {
            // 剥敏段是**替换**而不是追加：整段换掉，语义不变。
            message.content = content;
            message.parts = parts_owned();
        } else {
            message.content.push_str(&content);
            append_parts_slice_in_place(&mut message.parts, parts_slice, merge_reasoning_pair);
        }
        message.identity = if identity_is_present {
            envelope.identity.to_value()
        } else {
            fallback_identity.expect("非空身份已排除")
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
                parts_owned()
            } else {
                Value::Array(
                    coalesce_adjacent_reasoning_parts(parts_slice)
                        .unwrap_or_else(|| parts_slice.to_vec()),
                )
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
    // TS：`event.commands ? {...}` —— 空数组在 JS 里为真（照常整体替换）。
    if let Some(commands) = event.get("commands").filter(|value| !value.is_null()) {
        if let Some(items) = commands.as_array() {
            document.session.commands = session_surface::normalize_session_commands(items);
        }
    }
    // 空列表什么都没宣告，不得清空 provider 已宣告的候选面（C14 契约：整体替换
    // 而非合并，因此由这里挡下空列表）。
    if let Some(options) = event
        .get("options")
        .and_then(Value::as_array)
        .filter(|items| !items.is_empty())
    {
        document.session.options = session_surface::normalize_session_config_options(options);
    }
    if let Some(usage) = event.get("usage") {
        // TS：`event.usage !== undefined` —— JSON 键存在即宣告。注意与 reduceUsage
        // 的差异：session 面只取 `.value`，invalid-field 诊断**不**从这里发
        // （TS reduceSession 丢弃 invalidFields，只在 usage.updated/budget.warning
        // 的归约器里发诊断）。
        let normalized =
            session_surface::normalize_usage_snapshot(Some(usage), document.session.usage.as_ref());
        document.session.usage = Some(normalized.value);
    }
    Ok(())
}

// ── usage / budget 折叠（C14） ───────────────────────────────────────────────

fn reduce_usage(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    if envelope.event_type == "budget.warning" {
        let previous_budget = document
            .session
            .usage
            .as_ref()
            .and_then(|usage| usage.get("budget").filter(|value| value.is_object()));
        let budget = session_surface::normalize_budget_snapshot(&envelope.event, previous_budget);
        // TS：`{ ...document.session.usage, budget }` —— usage 缺席时从空对象起。
        let mut usage: Map<String, Value> = document
            .session
            .usage
            .as_ref()
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        usage.insert("budget".to_string(), budget);
        document.session.usage = Some(Value::Object(usage));
        return;
    }
    let previous_usage = document.session.usage.clone();
    let normalized = session_surface::normalize_usage_snapshot(
        envelope.event.get("usage"),
        previous_usage.as_ref(),
    );
    document.session.usage = Some(normalized.value);
    for field in normalized.invalid_fields {
        add_diagnostic(
            document,
            envelope,
            "session.usage.invalid-field",
            &Value::String(format!("usage field {field} is invalid; retained in raw")),
            &Value::String("warning".to_string()),
            envelope.event.get("usage"),
        );
    }
}

// ── activity 折叠（C07/C09/C10，体量最大的收窄层） ───────────────────────────

/// TS `activityLifecycleStatus`：progress 是更新不是状态；patch.status 只认
/// schema 词表，词表外稳定降级 unknown（不猜）。
fn activity_lifecycle_status(event_type: &str, patch: &Value, previous: Option<&Value>) -> String {
    match event_type {
        "activity.started" => "running".to_string(),
        "activity.progress" => match string_value(patch.get("status")) {
            Some(patch_status) => {
                if is_activity_status(patch_status) {
                    patch_status.to_string()
                } else {
                    "unknown".to_string()
                }
            }
            None => previous
                .and_then(|node| node.get("status"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| "running".to_string()),
        },
        other => other.strip_prefix("activity.").unwrap_or(other).to_string(),
    }
}

/// TS `narrowActivityParts`：sourceParts 逐个过 content schema；失败证据转有界
/// unknown 部件 + warning 诊断（原始形态不进 projection 主路径）。
fn narrow_activity_parts(
    value: Option<&Value>,
    activity_id: &str,
    envelope: &SemanticEnvelope,
    activity_family: &str,
) -> (Option<Vec<Value>>, Vec<Value>) {
    let Some(value) = value else {
        return (None, Vec::new());
    };
    let source_parts: Vec<Value> = match value.as_array() {
        Some(items) => items.clone(),
        None => vec![value.clone()],
    };
    let mut parts: Vec<Value> = Vec::new();
    let mut diagnostics: Vec<Value> = Vec::new();
    for (part_index, part) in source_parts.iter().enumerate() {
        match parse_content_part(part) {
            Ok(parsed) => parts.push(parsed),
            Err(issues) => {
                let original_type = part
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("malformed");
                parts.push(create_unknown_content_part(original_type, part, None));
                diagnostics.push(serde_json::json!({
                    "code": format!("activity.{activity_family}.part-malformed"),
                    "message": format!(
                        "{activity_family} activity part {part_index} failed content schema validation"
                    ),
                    "eventId": envelope.event_id,
                    "sequence": js_number_value(envelope.sequence),
                    "level": "warning",
                    "data": {
                        "activityId": activity_id,
                        "partIndex": part_index,
                        "issues": issues,
                    },
                }));
            }
        }
    }
    // TS 的 coalesce 恒返回数组（未变化时原样返回）。
    let merged = coalesce_adjacent_display_text_parts(&parts).unwrap_or(parts);
    (Some(merged), diagnostics)
}

/// TS `c09RichFields`：子代理/委派/团队 rich 字段收窄——只认 normalized
/// activity/patch，缺失即 undefined（不猜）。
fn c09_rich_fields(
    activity: &Value,
    patch: &Value,
    result: Option<&Value>,
    previous: Option<&Value>,
) -> Vec<(&'static str, Value)> {
    let pick_string = |key: &str| -> Option<String> {
        string_value(activity.get(key))
            .or_else(|| string_value(patch.get(key)))
            .or_else(|| string_value(result.and_then(|record| record.get(key))))
            .or_else(|| {
                previous
                    .and_then(|node| node.get(key))
                    .and_then(Value::as_str)
            })
            .map(str::to_string)
    };
    let pick_number = |key: &str| -> Option<Value> {
        // 只认 activity/patch 的 finite number（不带 result、不带 previous）。
        let value = activity
            .get(key)
            .filter(|value| !value.is_null())
            .or_else(|| patch.get(key).filter(|value| !value.is_null()));
        value
            .filter(|value| value.is_number() && js_number_of(value).is_finite())
            .cloned()
    };
    let pick_value = |key: &str| -> Option<Value> {
        let picked = activity
            .get(key)
            .filter(|value| !value.is_null())
            .or_else(|| patch.get(key).filter(|value| !value.is_null()))
            .or_else(|| {
                result
                    .and_then(|record| record.get(key))
                    .filter(|value| !value.is_null())
            });
        match picked {
            // TS：`jsonSnapshot(picked) ?? previous[key]` —— picked 为 null 时
            // jsonSnapshot 产物是 nullish，退回 previous。
            Some(picked) => Some(picked.clone()),
            None => previous.and_then(|node| node.get(key)).cloned(),
        }
    };
    let fields: [(&'static str, Option<Value>); 17] = [
        (
            "sourceAgentId",
            pick_string("sourceAgentId").map(Value::String),
        ),
        ("description", pick_string("description").map(Value::String)),
        ("startedAt", pick_string("startedAt").map(Value::String)),
        ("completedAt", pick_string("completedAt").map(Value::String)),
        ("depth", pick_number("depth")),
        ("role", pick_string("role").map(Value::String)),
        ("model", pick_string("model").map(Value::String)),
        ("provider", pick_string("provider").map(Value::String)),
        ("goal", pick_string("goal").map(Value::String)),
        ("usage", pick_value("usage")),
        ("metrics", pick_value("metrics")),
        ("capabilities", pick_value("capabilities")),
        ("files", pick_value("files")),
        ("execution", pick_value("execution")),
        ("tools", pick_value("tools")),
        ("tasks", pick_value("tasks")),
        ("metadata", pick_value("metadata")),
    ];
    fields
        .into_iter()
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect()
}

/// C09 活动终态词表（与 mergeToolActivity 同构的幂等合并入口）。
const ACTIVITY_TERMINAL_STATUSES: [&str; 5] =
    ["completed", "failed", "interrupted", "cancelled", "timeout"];

/// TS `mergeActivityTerminal`：终态后迟到事件仅补缺字段，不回退状态；
/// progress 保持首个终态时刻的快照。
fn merge_activity_terminal(previous: Option<&Value>, next: &Value) -> Option<Value> {
    let previous = previous?;
    let previous_status = previous.get("status").and_then(Value::as_str).unwrap_or("");
    if !ACTIVITY_TERMINAL_STATUSES.contains(&previous_status) {
        return None;
    }
    let mut filled = previous.as_object().expect("activity 是对象").clone();
    for (key, value) in next.as_object().expect("activity 是对象") {
        // TS：`if (value === undefined) continue` —— JSON 无 undefined，逐键处理；
        // 只补 previous 缺失的键（status 恒在 → 恒不被改写）。
        if !filled.contains_key(key) {
            filled.insert(key.clone(), value.clone());
        }
    }
    // orphan 是 (id 集合, parentId) 的纯函数：与 refreshOrphans 同口径。
    let next_orphan = next.get("orphan").and_then(Value::as_bool).unwrap_or(false);
    let has_parent = previous
        .get("parentId")
        .is_some_and(|value| !value.is_null());
    filled.insert("orphan".to_string(), Value::Bool(next_orphan && has_parent));
    Some(Value::Object(filled))
}

fn reduce_activity(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    if TERMINAL_SESSION_STATUSES.contains(&document.session.status.to_lowercase().as_str()) {
        add_late_event_diagnostic(
            document,
            envelope,
            "late activity event ignored after terminal fence",
        );
        return;
    }
    let event = &envelope.event;
    // TS `||`：activityId 空串/缺席 → identity.taskId → eventId。
    let id = truthy_string(event.get("activityId"))
        .map(str::to_string)
        .or_else(|| {
            envelope
                .identity
                .task_id
                .clone()
                .filter(|id| !id.is_empty())
        })
        .unwrap_or_else(|| envelope.event_id.clone());
    let activity = event
        .get("activity")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let patch = event
        .get("patch")
        .filter(|value| value.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let result = event
        .get("result")
        .filter(|value| value.is_object())
        .cloned();
    let previous_index = document.activities.iter().position(|item| {
        item.get("id").and_then(Value::as_str) == Some(id.as_str())
            && item.get("kind").and_then(Value::as_str) == Some("activity")
    });
    let previous: Option<&Value> = previous_index.map(|index| &document.activities[index]);
    let status = activity_lifecycle_status(&envelope.event_type, &patch, previous);
    let activity_kind = string_value(activity.get("kind"))
        .or_else(|| string_value(patch.get("kind")))
        .or_else(|| {
            previous
                .and_then(|node| node.get("activityKind"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let family_derived = activity_kind.as_deref().and_then(|kind| {
        matches!(
            kind,
            "process"
                | "background-task"
                | "subagent"
                | "delegation"
                | "team"
                | "workflow"
                | "workflow-phase"
                | "workflow-agent"
        )
        .then(|| format!("activity.{kind}"))
    });
    let semantic_kind = string_value(activity.get("semanticKind"))
        .or_else(|| string_value(patch.get("semanticKind")))
        .or_else(|| {
            previous
                .and_then(|node| node.get("semanticKind"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
        .or(family_derived);
    // C09/C10：typed 家族的 output/parts 逐个过 content schema；其余家族原样保真。
    let source_parts = result
        .as_ref()
        .and_then(|record| record.get("output"))
        .filter(|value| !value.is_null())
        .or_else(|| {
            result
                .as_ref()
                .and_then(|record| record.get("parts"))
                .filter(|value| !value.is_null())
        })
        .or_else(|| patch.get("output").filter(|value| !value.is_null()))
        .or_else(|| patch.get("parts").filter(|value| !value.is_null()))
        .or_else(|| activity.get("output").filter(|value| !value.is_null()))
        .or_else(|| activity.get("parts").filter(|value| !value.is_null()));
    let is_c09_activity = matches!(
        activity_kind.as_deref(),
        Some("subagent") | Some("delegation") | Some("team")
    );
    let is_c10_activity = matches!(
        activity_kind.as_deref(),
        Some("background-task")
            | Some("workflow")
            | Some("workflow-phase")
            | Some("workflow-agent")
    );
    let typed_parts_family =
        activity_kind.as_deref() == Some("process") || is_c10_activity || is_c09_activity;
    let strict_parts = if typed_parts_family || semantic_kind.as_deref() == Some("activity.process")
    {
        let family = activity_kind.clone().unwrap_or_else(|| {
            semantic_kind
                .as_deref()
                .and_then(|kind| kind.strip_prefix("activity."))
                .unwrap_or("activity")
                .to_string()
        });
        Some(narrow_activity_parts(source_parts, &id, envelope, &family))
    } else {
        None
    };
    // TS：
    //   narrowedParts = strictParts ?? { parts: jsonSnapshot(sourceParts), diagnostics: [] }
    //   parts          = narrowedParts.parts ?? previous?.parts
    //   output         = (C09|C10) ? strictParts?.parts ?? previous?.output : previous?.output
    // narrow 的 parts 在 sourceParts 缺席时为 undefined（→ 退回 previous）；非 typed
    // 家族的 parts 是 jsonSnapshot 原值克隆（数组外形态也照搬）。
    let (narrowed_parts, narrow_diagnostics): (Option<Value>, Vec<Value>) = match &strict_parts {
        Some((parts, diagnostics)) => (
            parts.as_ref().map(|items| Value::Array(items.clone())),
            diagnostics.clone(),
        ),
        None => (source_parts.cloned(), Vec::new()),
    };
    let strict_parts_value: Option<Value> = strict_parts
        .as_ref()
        .and_then(|(parts, _)| parts.as_ref().map(|items| Value::Array(items.clone())));
    let parts = narrowed_parts.or_else(|| previous.and_then(|node| node.get("parts")).cloned());
    let output = if is_c09_activity || is_c10_activity {
        strict_parts_value.or_else(|| previous.and_then(|node| node.get("output")).cloned())
    } else {
        previous.and_then(|node| node.get("output")).cloned()
    };
    let error = if event.get("error").is_some() {
        event
            .get("error")
            .and_then(|value| normalize_normalized_error(value, 0))
    } else if result
        .as_ref()
        .and_then(|record| record.get("error"))
        .is_some()
    {
        result
            .as_ref()
            .and_then(|record| record.get("error"))
            .and_then(|value| normalize_normalized_error(value, 0))
    } else if patch.get("error").is_some() {
        patch
            .get("error")
            .and_then(|value| normalize_normalized_error(value, 0))
    } else {
        previous.and_then(|node| node.get("error")).cloned()
    };
    let killed = match patch.get("killed") {
        Some(value @ Value::Bool(_)) => Some(value.clone()),
        _ => previous.and_then(|node| node.get("killed")).cloned(),
    };
    let timeout = match patch.get("timeout") {
        Some(value @ Value::Bool(_)) => Some(value.clone()),
        _ => previous.and_then(|node| node.get("timeout")).cloned(),
    };
    let title = string_value(activity.get("title"))
        .or_else(|| string_value(activity.get("name")))
        .or_else(|| string_value(patch.get("title")))
        .or_else(|| {
            previous
                .and_then(|node| node.get("title"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let parent_id = string_value(activity.get("parentId"))
        .or_else(|| string_value(patch.get("parentId")))
        .or_else(|| {
            previous
                .and_then(|node| node.get("parentId"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let process_id = string_value(activity.get("processId"))
        .or_else(|| string_value(patch.get("processId")))
        .or_else(|| {
            previous
                .and_then(|node| node.get("processId"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let session_of_activity = string_value(activity.get("sessionId"))
        .or_else(|| string_value(patch.get("sessionId")))
        .or_else(|| {
            previous
                .and_then(|node| node.get("sessionId"))
                .and_then(Value::as_str)
        })
        .map(str::to_string);
    let progress = match patch.get("progress") {
        Some(value) => Some(value.clone()),
        None => previous
            .and_then(|node| node.get("progress"))
            .filter(|value| !value.is_null())
            .cloned(),
    };
    let node_result = if event.get("result").is_some() {
        event.get("result").cloned()
    } else if patch.get("result").is_some() {
        patch.get("result").cloned()
    } else {
        previous
            .and_then(|node| node.get("result"))
            .filter(|value| !value.is_null())
            .cloned()
    };
    let reason = string_value(event.get("reason"))
        .map(str::to_string)
        .or_else(|| {
            previous
                .and_then(|node| node.get("reason"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    let mut node = Map::new();
    node.insert("id".to_string(), Value::String(id.clone()));
    node.insert("kind".to_string(), Value::String("activity".to_string()));
    node.insert("status".to_string(), Value::String(status));
    node.insert("orphan".to_string(), Value::Bool(false));
    // 活动位置是创建时事实（progress 不移动卡片）。
    node.insert(
        "sequence".to_string(),
        js_number_value(
            previous
                .and_then(|node| node.get("sequence"))
                .and_then(Value::as_f64)
                .unwrap_or(envelope.sequence),
        ),
    );
    if let Some(semantic_kind) = semantic_kind {
        node.insert("semanticKind".to_string(), Value::String(semantic_kind));
    }
    if let Some(activity_kind) = activity_kind {
        node.insert("activityKind".to_string(), Value::String(activity_kind));
    }
    if let Some(title) = title {
        node.insert("title".to_string(), Value::String(title));
    }
    if let Some(parent_id) = parent_id {
        node.insert("parentId".to_string(), Value::String(parent_id));
    }
    if let Some(process_id) = process_id {
        node.insert("processId".to_string(), Value::String(process_id));
    }
    if let Some(session_id) = session_of_activity {
        node.insert("sessionId".to_string(), Value::String(session_id));
    }
    if let Some(progress) = progress {
        node.insert("progress".to_string(), progress);
    }
    if let Some(parts) = parts {
        node.insert("parts".to_string(), parts);
    }
    if let Some(output) = output {
        node.insert("output".to_string(), output);
    }
    if let Some(result) = node_result {
        node.insert("result".to_string(), result);
    }
    if let Some(error) = error {
        node.insert("error".to_string(), error);
    }
    if let Some(killed) = killed {
        node.insert("killed".to_string(), killed);
    }
    if let Some(timeout) = timeout {
        node.insert("timeout".to_string(), timeout);
    }
    if let Some(reason) = reason {
        node.insert("reason".to_string(), Value::String(reason));
    }
    for (key, value) in c09_rich_fields(&activity, &patch, result.as_ref(), previous) {
        node.insert(key.to_string(), value);
    }
    node.insert("provenance".to_string(), envelope.provenance_value());
    let node = Value::Object(node);
    let merged = merge_activity_terminal(previous, &node);
    let projected = merged.as_ref().unwrap_or(&node).clone();
    upsert_activity(document, projected);
    // narrow 诊断在节点落位后追加（TS：diagnostics 数组尾拼）。
    for diagnostic in narrow_diagnostics {
        document.diagnostics.push(diagnostic);
    }
}

// ── plan / goal / lifecycle / assist / extension 折叠 ────────────────────────

/// C08：plan 事件经 domain reducer 收敛进 document.plan；malformed entries 转可见诊断。
fn reduce_plan(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    let event = &envelope.event;
    let event_type = envelope.event_type.as_str();
    if event_type == "plan.replaced"
        && event.get("entries").is_some()
        && !event.get("entries").is_some_and(Value::is_array)
    {
        add_diagnostic(
            document,
            envelope,
            "plan.malformed",
            &Value::String("plan.replaced entries is not an array; plan unchanged".to_string()),
            &Value::String("warning".to_string()),
            event.get("entries"),
        );
        return;
    }
    if event_type == "plan.entry-updated"
        && event.get("entry").is_some_and(|entry| !entry.is_object())
    {
        add_diagnostic(
            document,
            envelope,
            "plan.malformed",
            &Value::String("plan.entry-updated entry is not an object; plan unchanged".to_string()),
            &Value::String("warning".to_string()),
            event.get("entry"),
        );
        return;
    }
    if let Some(next) = goal_model::apply_plan_event(&document.plan, event) {
        document.plan = next;
    }
}

/// C08：goal 事件经 domain reducer 收敛；malformed goal 转可见诊断。
fn reduce_goal(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    let event = &envelope.event;
    if envelope.event_type == "goal.updated"
        && event.get("goal").is_some()
        && event
            .get("goal")
            .and_then(goal_model::normalize_goal_snapshot)
            .is_none()
    {
        add_diagnostic(
            document,
            envelope,
            "goal.malformed",
            &Value::String("goal.updated payload is not an object; goal unchanged".to_string()),
            &Value::String("warning".to_string()),
            event.get("goal"),
        );
        return;
    }
    if let Some(next) = goal_model::apply_goal_events(&document.goal, event) {
        document.goal = next;
    }
}

/// C13：lifecycle 事件经 domain reducer 收敛；恢复成功不删除历史事实。
fn reduce_lifecycle(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    if let Some(next) = lifecycle_model::apply_lifecycle_event(
        &document.lifecycle,
        &envelope.event,
        &|raw: &Value| normalize_normalized_error(raw, 0),
    ) {
        document.lifecycle = next;
    }
}

/// C14：assist 事件投影进易逝 slice，不污染 transcript。
fn reduce_assist(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    let event = &envelope.event;
    let assist = &mut document.assist;
    match envelope.event_type.as_str() {
        "assist.prediction" => {
            let mut prediction = Map::new();
            if let Some(placeholder) = truthy_string(event.get("placeholder")) {
                prediction.insert(
                    "placeholder".to_string(),
                    Value::String(placeholder.to_string()),
                );
            }
            let actions: Vec<Value> = event
                .get("actions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            prediction.insert("actions".to_string(), Value::Array(actions));
            if let Some(record) = assist.as_object_mut() {
                record.insert("prediction".to_string(), Value::Object(prediction));
            }
        }
        "assist.file-suggestions" => {
            let files: Vec<Value> = event
                .get("files")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if let Some(record) = assist.as_object_mut() {
                record.insert("files".to_string(), Value::Array(files));
            }
        }
        _ => {
            // assist.queued-command：TS `event.command ? { queuedCommand } : {}`。
            if let Some(command) = truthy_string(event.get("command")) {
                if let Some(record) = assist.as_object_mut() {
                    record.insert(
                        "queuedCommand".to_string(),
                        Value::String(command.to_string()),
                    );
                }
            }
        }
    }
}

/// C15：namespaced extension 事件投影进持久 slice（payload/fallback 保真 +
/// source/provenance 全携带），按 sequence 插入。
fn reduce_extension(document: &mut WorkbenchDocument, envelope: &SemanticEnvelope) {
    let event = &envelope.event;
    let extension = serde_json::json!({
        "id": envelope.event_id,
        "kind": event.get("kind").cloned().unwrap_or(Value::String(String::new())),
        "payload": event.get("payload").cloned().unwrap_or(Value::Null),
        "fallback": event
            .get("fallback")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        "identity": envelope.identity.to_value(),
        "source": envelope.source.to_value(),
        "provenance": envelope.provenance_value(),
        "sequence": js_number_value(envelope.sequence),
        "time": envelope.occurred_or_recorded().to_string(),
    });
    let mut index = document.extensions.len();
    for (position, item) in document.extensions.iter().enumerate() {
        let sequence = item.get("sequence").and_then(Value::as_f64).unwrap_or(0.0);
        if sequence > envelope.sequence {
            index = position;
            break;
        }
    }
    document.extensions.insert(index, extension);
}

// ── 归约主干 ─────────────────────────────────────────────────────────────────

/// `reduceSemanticEvent` 的 dispatch。词表全集（45 项）均有归约器；
/// 越词表的事件在帧解码层已被 typeIndex 校验拒绝。
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
        "activity.started" | "activity.progress" | "activity.completed" | "activity.failed"
        | "activity.cancelled" => {
            reduce_activity(document, envelope);
            Ok(())
        }
        "interaction.requested" | "interaction.resolved" | "interaction.expired" => {
            reduce_interaction(document, envelope);
            Ok(())
        }
        "usage.updated" | "budget.warning" => {
            reduce_usage(document, envelope);
            Ok(())
        }
        "plan.replaced" | "plan.entry-updated" => {
            reduce_plan(document, envelope);
            Ok(())
        }
        "goal.updated" | "goal.cleared" => {
            reduce_goal(document, envelope);
            Ok(())
        }
        "lifecycle.retrying"
        | "lifecycle.compact-started"
        | "lifecycle.compact-completed"
        | "lifecycle.rewind-preview"
        | "lifecycle.rewind-completed"
        | "lifecycle.suspended"
        | "lifecycle.recovered" => {
            reduce_lifecycle(document, envelope);
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
        "assist.prediction" | "assist.file-suggestions" | "assist.queued-command" => {
            reduce_assist(document, envelope);
            Ok(())
        }
        "extension.event" => {
            reduce_extension(document, envelope);
            Ok(())
        }
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
        // 词表外类型进不到这里（帧解码按 typeIndex 拒绝）；防御性保留 fail-closed。
        other => Err(format!("semantic 事件 {other} 不在投影词表内，已拒绝投影")),
    }
}

/// `reduceWorkbenchEvent`：单事件折叠（幂等判据 + timeline + 语义归约 + orphan 刷新）。
pub fn reduce_workbench_event(
    document: &mut WorkbenchDocument,
    envelope: &SemanticEnvelope,
) -> Result<(), String> {
    // journal 信封按覆盖区间幂等；非 journal 信封保持 eventId 幂等。
    let span = envelope
        .coverage
        .and_then(|(start, end)| coverage::coverage_span_of(Some((start, end))));
    if let Some((start, end)) = span {
        if coverage::is_span_covered(&document.applied_ranges, start, end) {
            return Ok(());
        }
    } else if document.applied_event_id_set.contains(&envelope.event_id) {
        return Ok(());
    }
    // C12：secret-bearing interaction 在进入任何投影面前统一剥敏。
    let effective_event = if envelope.event_type.starts_with("interaction.") {
        redact_interaction_event(&envelope.event)
    } else {
        envelope.event.clone()
    };
    let effective = envelope.with_event(effective_event);
    let entry = timeline_entry(&effective);
    insert_by_sequence(&mut document.timeline, entry);
    document.revision = document.revision.max(envelope.sequence);
    if let Some((start, end)) = span {
        coverage::merge_coverage_in_place(&mut document.applied_ranges, start, end);
    } else {
        document.applied_event_ids.push(envelope.event_id.clone());
        document
            .applied_event_id_set
            .insert(envelope.event_id.clone());
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
    let mut sorted = envelopes;
    sorted.sort_by(|left, right| {
        left.sequence
            .partial_cmp(&right.sequence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.event_id.as_bytes().cmp(right.event_id.as_bytes()))
    });
    let before = document.clone();
    for envelope in &sorted {
        // 事务性：中途失败 → 回滚整页，document 不动。
        if let Err(error) = reduce_workbench_event(document, envelope) {
            *document = before;
            return Err(error);
        }
    }
    Ok(diff_patches(&before, document))
}

// ── 帧解码（纯内层；编码器在 TS 侧 parity 测试） ─────────────────────────────

pub const FRAME_MAGIC: [u8; 4] = *b"PYPB";
/// v2：在 v1 的 17 组变长段后追加第 18 组 provenance 富字段 JSON
/// （activity/extension 节点把完整 provenance 写进 document，v1 装不下）。
pub const FRAME_VERSION: u16 = 2;
/// 每事件变长段的 (offset,len) 对数。
pub const FRAME_PAIRS: usize = 18;

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
    let provenance_extra = reader.optional_json()?;
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
        recorded_at,
        occurred_at,
        identity,
        source,
        provenance_origin: (flags & 0b111) as u8,
        provenance_trust: ((flags >> 3) & 1) as u8,
        // 槽内只放 TS WorkbenchEventProvenance 的可选富字段（origin/trust 在 flags）。
        provenance_extra: provenance_extra.and_then(|value| match value {
            Value::Object(entries) => Some(entries),
            Value::Null => None,
            _ => None,
        }),
        coverage,
        event,
    })
}

// ── wasm 薄壳（只做值/错误转换；可失败逻辑全在纯内层） ────────────────────────

/// 工作台投影核实例：持有折叠状态，`append_batch` 按页合批消费二进制帧。
/// 诊断用时钟（毫秒）。
///
/// **wasm32-unknown-unknown 上 `std::time::Instant::now()` 没有实现，会 panic**
/// （本 crate 的 panic 策略是 abort，表现为 `RuntimeError: unreachable`）——这条
/// 平台约束意味着计算核里任何「读时钟」的代码都必须走 `js_sys` 或由 JS 传参
/// （后者是生产路径的做法，见 streaming 的 `tick(now)`）。此处只服务诊断读数。
#[cfg(target_arch = "wasm32")]
fn diag_now_ms() -> f64 {
    js_sys::Date::now()
}

#[cfg(not(target_arch = "wasm32"))]
fn diag_now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
}

#[wasm_bindgen]
pub struct PylonProjector {
    document: WorkbenchDocument,
    /// 上一次 `appendBatch` 的分段耗时（诊断读数，不参与投影语义；见 `foldPhases`）。
    phases: FoldPhases,
}

/// `appendBatch` 各阶段的上次耗时（毫秒，f64 便于直接过界读）。
///
/// 存在理由是**可测量的性能调查**：整体一个数分不清「Rust 折叠慢」还是「边界编组贵」，
/// 而这两者的修法完全不同。每次批量入口只取 4 个时钟，代价可忽略。
#[derive(Debug, Clone, Copy, Default)]
pub struct FoldPhases {
    pub decode_ms: f64,
    pub project_ms: f64,
    pub patch_json_ms: f64,
}

#[wasm_bindgen]
impl PylonProjector {
    #[wasm_bindgen(constructor)]
    pub fn new(session_id: &str) -> PylonProjector {
        PylonProjector {
            document: create_workbench_document(session_id),
            phases: FoldPhases::default(),
        }
    }

    /// 页级批量入口（回放/直播突刺共用；逐事件循环喂法被本 API 形态禁止）。
    /// 返回增量 patch（非全量 document）。
    #[wasm_bindgen(js_name = appendBatch)]
    pub fn append_batch(&mut self, frame: &[u8]) -> Result<String, JsError> {
        let started = diag_now_ms();
        let envelopes = decode_frame(frame).map_err(|error| JsError::new(&error))?;
        let after_decode = diag_now_ms();
        let patch =
            project_batch(&mut self.document, envelopes).map_err(|error| JsError::new(&error))?;
        let after_project = diag_now_ms();
        let text = to_boundary_json(&patch)?;
        let after_json = diag_now_ms();
        self.phases = FoldPhases {
            decode_ms: after_decode - started,
            project_ms: after_project - after_decode,
            patch_json_ms: after_json - after_project,
        };
        Ok(text)
    }

    /// 诊断读数：上一次批量入口的 decode / project / patch 序列化耗时（毫秒）。
    /// 供 `scripts/bench-ts-vs-wasm.mts` 把边界耗时拆开；生产路径不读它。
    #[wasm_bindgen(js_name = foldPhases)]
    pub fn fold_phases(&self) -> Result<String, JsError> {
        to_boundary_json(&serde_json::json!({
            "decodeMs": self.phases.decode_ms,
            "projectMs": self.phases.project_ms,
            "patchJsonMs": self.phases.patch_json_ms,
        }))
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
            provenance_extra: None,
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
        assert!(!recovery_document.messages[0].running);
        assert!(live_document.messages[0].running);
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
    fn usage_budget_and_session_fields_project_deterministically() {
        // 原 fail-closed 分支的替代契约：usage.updated / budget.warning /
        // session.commands-updated 现在全部真实折叠（对齐 usageBudgetProjection
        // 与 sessionSurfaceProjection 的既有断言）。
        let mut document = create_workbench_document(SESSION);
        let usage = envelope(
            1.0,
            json!({"type": "usage.updated", "usage": {"inputTokens": 12, "outputTokens": 8, "contextUsed": 25, "contextLimit": 100, "calls": -1, "futureCounter": 7}}),
        );
        reduce_workbench_event(&mut document, &usage).expect("fold");
        let session_usage = document.session.usage.as_ref().expect("usage");
        assert_eq!(session_usage.get("inputTokens"), Some(&json!(12)));
        assert_eq!(session_usage.get("contextPercent"), Some(&json!(25)));
        assert_eq!(
            session_usage.get("raw"),
            Some(&json!({ "calls": -1, "futureCounter": 7 }))
        );
        assert!(document
            .diagnostics
            .iter()
            .any(|item| item.get("code").and_then(Value::as_str)
                == Some("session.usage.invalid-field")));

        let budget = envelope(
            2.0,
            json!({"type": "budget.warning", "used": 900, "limit": 1000, "threshold": "warning", "percent": 90}),
        );
        reduce_workbench_event(&mut document, &budget).expect("fold");
        let budget_value = document
            .session
            .usage
            .as_ref()
            .unwrap()
            .get("budget")
            .cloned();
        assert_eq!(
            budget_value.as_ref().and_then(|b| b.get("used")),
            Some(&json!(900))
        );
        assert_eq!(
            budget_value.as_ref().and_then(|b| b.get("exhausted")),
            Some(&Value::Bool(false))
        );

        let commands = envelope(
            3.0,
            json!({"type": "session.commands-updated", "commands": [{"id": "compact", "name": "/compact", "future": "kept"}]}),
        );
        reduce_workbench_event(&mut document, &commands).expect("fold");
        assert_eq!(document.session.commands.len(), 1);
        assert_eq!(
            document.session.commands[0].get("name"),
            Some(&json!("/compact"))
        );
        // 整页拒绝改为真实投影：batch 与逐事件收敛一致。
        let mut batched = create_workbench_document(SESSION);
        project_batch(
            &mut batched,
            vec![
                envelope(1.0, json!({"type": "usage.updated", "usage": {"inputTokens": 1}})),
                envelope(2.0, json!({"type": "plan.replaced", "entries": [{"id": "a", "content": "第一步", "status": "completed"}]})),
            ],
        )
        .expect("batch");
        assert_eq!(batched.plan.get("revision"), Some(&json!(1)));
        assert_eq!(
            batched
                .plan
                .get("entries")
                .and_then(Value::as_array)
                .map(|entries| entries.len()),
            Some(1)
        );
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
        let flags_1 = FLAG_HAS_ROLE | (1 << FLAG_PARTS_MODE_SHIFT);
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
                empty,
            ],
            None,
        );
        // 事件 2：tool.started（typeIndex 6），富载荷走 JSON 通道 + extra；
        // parts 通道缺席（mode 0），turnId 落在 identity 槽位，provenance 槽缺席。
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
                empty,
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

    // ── 以下对齐 src/domains/workbench/__tests__ 的 C08/C09/C10/C13/C14/C15 契约 ──

    fn activity_node<'a>(document: &'a WorkbenchDocument, id: &str) -> &'a Value {
        document
            .activities
            .iter()
            .find(|node| node.get("id").and_then(Value::as_str) == Some(id))
            .expect("activity node")
    }

    #[test]
    fn plan_and_goal_slices_follow_the_c08_state_machine() {
        // workbenchProjectorPlan.test.ts：replaced + entry patch 序列。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "plan.replaced", "entries": [
                    {"id": "a", "content": "第一步", "status": "completed"},
                    {"id": "b", "content": "第二步", "status": "in_progress", "activeForm": "正在第二步"},
                ]}),
            ),
            envelope(
                2.0,
                json!({"type": "plan.entry-updated", "entry": {"id": "b", "content": "第二步", "status": "blocked", "blockedReason": "等待审批"}}),
            ),
            envelope(
                3.0,
                json!({"type": "plan.entry-updated", "entry": {"id": "b", "content": "第二步", "status": "in_progress"}}),
            ),
        ]);
        let entries: Vec<(String, String)> = document
            .plan
            .get("entries")
            .and_then(Value::as_array)
            .expect("entries")
            .iter()
            .map(|entry| {
                (
                    entry["id"].as_str().expect("id").to_string(),
                    entry["status"].as_str().expect("status").to_string(),
                )
            })
            .collect();
        assert_eq!(
            entries,
            vec![
                ("a".to_string(), "completed".to_string()),
                ("b".to_string(), "in_progress".to_string()),
            ]
        );
        let kinds: Vec<&str> = document.timeline.iter().map(|entry| entry.kind).collect();
        assert_eq!(kinds, vec!["plan", "plan", "plan"]);

        // goal.updated ×2 + cleared → current 消失；assist 归 plan 之外的 kind。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "goal.updated", "goal": {"goalId": "g-1", "objective": "完成渲染引擎", "status": "active", "tokenBudget": 5000, "tokensUsed": 120}}),
            ),
            envelope(
                2.0,
                json!({"type": "goal.updated", "goal": {"goalId": "g-1", "status": "blocked", "blockedReason": "预算耗尽"}}),
            ),
            envelope(3.0, json!({"type": "goal.cleared", "goalId": "g-1"})),
            envelope(4.0, json!({"type": "assist.prediction", "actions": []})),
        ]);
        assert!(document.goal.get("current").is_none());
        let kinds: Vec<&str> = document.timeline.iter().map(|entry| entry.kind).collect();
        assert_eq!(kinds, vec!["plan", "plan", "plan", "assist"]);

        // metadata/accounting 保活（未知字段不静默丢弃，K14）。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "plan.replaced", "entries": [{"id": "m", "content": "扩展任务", "status": "pending", "metadata": {"owner": "peri"}, "futureFlag": true}]}),
            ),
            envelope(
                2.0,
                json!({"type": "goal.updated", "goal": {"goalId": "g-m", "objective": "目标", "status": "active", "accounting": {"tokensUsed": 20, "timeUsedSeconds": 12, "providerCredits": 1.5}}}),
            ),
            envelope(
                3.0,
                json!({"type": "plan.entry-updated", "entry": {"id": "m", "content": "扩展任务", "status": "completed", "futureFlag": "reviewed"}}),
            ),
        ]);
        let entry = &document.plan["entries"][0];
        assert_eq!(
            entry["metadata"],
            json!({ "owner": "peri", "futureFlag": "reviewed" })
        );
        let accounting = &document.goal["current"]["accounting"];
        assert_eq!(accounting["tokensUsed"], json!(20));
        assert_eq!(accounting["timeUsedSeconds"], json!(12));
        // 未知 accounting 字段进 metadata（tokenBudget 等已知字段不在此列）。
        assert_eq!(accounting["metadata"]["providerCredits"], json!(1.5));

        // malformed plan/goal → 诊断兜底，不抛错。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "plan.replaced", "entries": "not-an-array"}),
            ),
            envelope(
                2.0,
                json!({"type": "goal.updated", "goal": "not-an-object"}),
            ),
        ]);
        assert_eq!(
            document
                .plan
                .get("entries")
                .and_then(Value::as_array)
                .map(Vec::is_empty),
            Some(true)
        );
        assert!(document.goal.get("current").is_none());
        assert!(document.diagnostics.len() >= 2);
        // 深等替换的幂等：同样内容重复 replaced 不推 revision。
        let mut document = create_workbench_document(SESSION);
        let replaced = envelope(
            1.0,
            json!({"type": "plan.replaced", "entries": [{"id": "x", "content": "任务 X", "status": "pending"}]}),
        );
        reduce_workbench_event(&mut document, &replaced).expect("fold");
        let revision_after_first = document.plan.get("revision").cloned().unwrap();
        reduce_workbench_event(&mut document, &envelope(
            2.0,
            json!({"type": "plan.replaced", "entries": [{"id": "x", "content": "任务 X", "status": "pending"}]}),
        ))
        .expect("fold");
        assert_eq!(document.plan.get("revision"), Some(&revision_after_first));
    }

    #[test]
    fn lifecycle_slice_projects_retry_chain_and_system_errors() {
        // workbenchProjectorLifecycle.test.ts：retry → recovered；history 只追加。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "lifecycle.retrying", "attempt": 1, "maxAttempts": 3, "delayMs": 1000, "error": {"technicalMessage": "boom", "recoverability": "retry"}}),
            ),
            envelope(
                2.0,
                json!({"type": "lifecycle.recovered", "source": "canonical"}),
            ),
        ]);
        assert!(document.lifecycle.get("retry").is_none());
        let kinds: Vec<&str> = document
            .lifecycle
            .get("history")
            .and_then(Value::as_array)
            .expect("history")
            .iter()
            .map(|item| item["kind"].as_str().expect("kind"))
            .collect();
        assert_eq!(kinds, vec!["retry", "recovered"]);
        let kinds: Vec<&str> = document.timeline.iter().map(|entry| entry.kind).collect();
        assert_eq!(kinds, vec!["lifecycle", "lifecycle"]);

        // error 级 notice 进 systemErrors（结构化 NormalizedError），info 不进。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "diagnostic.notice", "level": "info", "message": "提示信息"}),
            ),
            envelope(
                2.0,
                json!({"type": "diagnostic.notice", "level": "error", "message": "连接失败", "code": "agent_connection_timeout"}),
            ),
        ]);
        assert_eq!(document.system_errors.len(), 1);
        assert_eq!(
            document.system_errors[0].get("code"),
            Some(&Value::String("agent_connection_timeout".into()))
        );
        assert_eq!(
            document.system_errors[0].get("userSummary"),
            Some(&Value::String("连接失败".into()))
        );

        // 终态 status 单调：completed 后的 error 请求不回退。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "message.delta", "role": "assistant", "parts": [{"kind": "text", "text": "partial"}]}),
            ),
            envelope(
                2.0,
                json!({"type": "session.status-updated", "status": "completed"}),
            ),
            envelope(
                3.0,
                json!({"type": "session.status-updated", "status": "error"}),
            ),
        ]);
        assert_eq!(document.session.status, "completed");
        assert!(!document.messages[0].running);

        // 终态后迟到的 provider.error 不改写状态但留下诊断。
        let document = reduce_all(vec![
            envelope(1.0, json!({"type": "session.completed"})),
            envelope(
                2.0,
                json!({"type": "diagnostic.notice", "level": "error", "code": "provider.error", "message": "late provider failure"}),
            ),
        ]);
        assert_eq!(document.session.status, "completed");
        assert!(document
            .diagnostics
            .iter()
            .any(|item| item.get("code").and_then(Value::as_str) == Some("provider.error")));

        // retry error 的未知字段进 metadata（结构化 provider 错误可审计）。
        let document = reduce_all(vec![envelope(
            1.0,
            json!({"type": "lifecycle.retrying", "attempt": 1, "maxAttempts": 2, "delayMs": 500, "error": {
                "userSummary": "连接失败", "technicalMessage": "ECONNRESET", "code": "provider.error",
                "provider": "hermes", "recoverability": "retry", "retryAfterMs": 2000, "classification": "network",
            }}),
        )]);
        let retry = document.lifecycle.get("retry").expect("retry");
        let metadata = &retry["error"]["metadata"];
        assert_eq!(metadata["retryAfterMs"], json!(2000));
        assert_eq!(metadata["classification"], json!("network"));

        // live 顺序折叠与整页批量对 lifecycle 深等（重放 == 增量）。
        let events = vec![
            envelope(
                1.0,
                json!({"type": "lifecycle.compact-started", "strategy": "rolling", "tokensBefore": 1000}),
            ),
            envelope(
                2.0,
                json!({"type": "lifecycle.compact-completed", "tokensBefore": 1000, "tokensAfter": 300}),
            ),
            envelope(
                3.0,
                json!({"type": "lifecycle.suspended", "reason": "等待输入"}),
            ),
        ];
        let live = reduce_all(events.clone());
        let mut replay = create_workbench_document(SESSION);
        project_batch(&mut replay, events).expect("batch");
        assert_eq!(live.lifecycle, replay.lifecycle);
    }

    #[test]
    fn usage_context_percent_merges_and_recomputes_across_patches() {
        // sessionSurfaceProjection.test.ts：首事件派生 25%，部分补丁改计数器后重算 60%。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "usage.updated", "usage": {"contextUsed": 25, "contextLimit": 100}}),
            ),
            envelope(
                2.0,
                json!({"type": "usage.updated", "usage": {"contextUsed": 60}}),
            ),
        ]);
        let usage = document.session.usage.as_ref().expect("usage");
        assert_eq!(usage.get("contextUsed"), Some(&json!(60)));
        assert_eq!(usage.get("contextLimit"), Some(&json!(100)));
        assert_eq!(usage.get("contextPercent"), Some(&json!(60)));

        // 显式 percent 是 provider 权威值，不被本地重算覆盖。
        let document = reduce_all(vec![envelope(
            1.0,
            json!({"type": "usage.updated", "usage": {"contextUsed": 10, "contextLimit": 100, "contextPercent": 42}}),
        )]);
        let usage = document.session.usage.as_ref().expect("usage");
        assert_eq!(usage.get("contextPercent"), Some(&json!(42)));
    }

    #[test]
    fn session_commands_options_and_assist_follow_the_c14_surface() {
        // commands/config 归一化 + raw 宽容保留；option 不可写时值退守 raw。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "session.commands-updated", "commands": [
                    {"id": "compact", "name": "/compact", "description": "压缩上下文", "inputHint": "[focus]", "availability": true, "capability": "compact", "future": "kept"},
                ]}),
            ),
            envelope(
                2.0,
                json!({"type": "session.config-updated", "options": [
                    {"id": "temperature", "label": "Temperature", "value": {"providerScale": "adaptive"}, "valueType": "provider.custom", "editable": true, "schema": {"type": "object"}, "version": 3, "future": "kept"},
                ]}),
            ),
        ]);
        let command = &document.session.commands[0];
        assert_eq!(command.get("id"), Some(&json!("compact")));
        assert_eq!(command.get("name"), Some(&json!("/compact")));
        assert_eq!(command.get("description"), Some(&json!("压缩上下文")));
        assert_eq!(command.get("capability"), Some(&json!("compact")));
        assert_eq!(command.get("raw"), Some(&json!({ "future": "kept" })));
        let option = &document.session.options[0];
        assert_eq!(option.get("id"), Some(&json!("temperature")));
        assert_eq!(
            option.get("value"),
            Some(&json!({ "providerScale": "adaptive" }))
        );
        assert_eq!(option.get("valueType"), Some(&json!("provider.custom")));
        // valueType 非法（provider.custom 不在 boolean/select/enum 集）→ 不可写，
        // editable 被收窄为 false 且值+类型退守 raw。
        assert_eq!(option.get("editable"), Some(&Value::Bool(false)));
        assert_eq!(
            option.get("raw"),
            Some(&json!({
                "future": "kept",
                "value": { "providerScale": "adaptive" },
                "valueType": "provider.custom",
            }))
        );
        assert_eq!(option.get("version"), Some(&json!(3)));

        // 空列表不宣告 → 不清空既有候选面。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "session.config-updated", "options": [
                    {"id": "thinking_effort", "label": "Thinking Effort", "value": "max", "schema": {"options": [{"id": "low", "label": "low"}]}},
                ]}),
            ),
            envelope(
                2.0,
                json!({"type": "session.config-updated", "options": []}),
            ),
        ]);
        let ids: Vec<&str> = document
            .session
            .options
            .iter()
            .filter_map(|option| option.get("id").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, vec!["thinking_effort"]);

        // assist 三事件族投影进易逝 slice，不污染 transcript。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "assist.prediction", "placeholder": "继续修复", "actions": [{"id": "accept", "label": "接受"}]}),
            ),
            envelope(
                2.0,
                json!({"type": "assist.file-suggestions", "files": ["src/a.ts", "src/b.ts"]}),
            ),
            envelope(
                3.0,
                json!({"type": "assist.queued-command", "command": "/compact"}),
            ),
        ]);
        assert_eq!(
            document.assist,
            json!({
                "files": ["src/a.ts", "src/b.ts"],
                "prediction": { "placeholder": "继续修复", "actions": [{ "id": "accept", "label": "接受" }] },
                "queuedCommand": "/compact",
            })
        );
        assert!(document.messages.is_empty());
        let kinds: Vec<&str> = document.timeline.iter().map(|entry| entry.kind).collect();
        assert_eq!(kinds, vec!["assist", "assist", "assist"]);
    }

    #[test]
    fn activity_families_follow_the_c09_c10_contracts() {
        // started 后的 progress 保持 running（C09）。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "activity.started", "activityId": "sub-running", "activity": {"kind": "subagent", "title": "Inspect renderer seams"}}),
            ),
            envelope(
                2.0,
                json!({"type": "activity.progress", "activityId": "sub-running", "patch": {"progress": {"completed": 1, "total": 3}}}),
            ),
        ]);
        assert_eq!(
            activity_node(&document, "sub-running").get("status"),
            Some(&json!("running"))
        );

        // 归一化 status 白名单：词表外降级 unknown。
        let document = reduce_all(vec![envelope(
            1.0,
            json!({"type": "activity.progress", "activityId": "sub-invalid-status", "patch": {"kind": "subagent", "status": "teleporting"}}),
        )]);
        assert_eq!(
            activity_node(&document, "sub-invalid-status").get("status"),
            Some(&json!("unknown"))
        );

        // timeout/interrupted 终态不被迟到的 running progress 复活；缺字段可补。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "activity.progress", "activityId": "sub-timeout-terminal", "patch": {"kind": "subagent", "status": "timeout"}}),
            ),
            envelope(
                2.0,
                json!({"type": "activity.progress", "activityId": "sub-timeout-terminal", "patch": {"status": "running", "description": "late evidence may fill missing fields"}}),
            ),
        ]);
        let node = activity_node(&document, "sub-timeout-terminal");
        assert_eq!(node.get("status"), Some(&json!("timeout")));
        assert_eq!(
            node.get("description"),
            Some(&json!("late evidence may fill missing fields"))
        );

        // rich 字段跨事件累积；completed 的 result.completedAt 收窄。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "activity.started", "activityId": "sub-rich-lifecycle", "activity": {
                    "kind": "subagent", "sourceAgentId": "agent-parent", "description": "Inspect the renderer registry",
                    "startedAt": "2026-08-23T06:00:01.000Z",
                }}),
            ),
            envelope(
                2.0,
                json!({"type": "activity.progress", "activityId": "sub-rich-lifecycle", "patch": {
                    "metrics": {"toolCount": 4, "taskCount": 2, "durationMs": 900, "costUsd": 0.03},
                    "execution": {"mode": "remote", "background": true, "worktree": "review/c09", "team": "renderer"},
                    "tools": [{"id": "tool-4", "status": "completed"}],
                    "tasks": [{"id": "task-2", "status": "running"}],
                }}),
            ),
            envelope(
                3.0,
                json!({"type": "activity.completed", "activityId": "sub-rich-lifecycle", "result": {"completedAt": "2026-08-23T06:00:03.000Z"}}),
            ),
        ]);
        let node = activity_node(&document, "sub-rich-lifecycle");
        assert_eq!(node.get("sourceAgentId"), Some(&json!("agent-parent")));
        assert_eq!(
            node.get("description"),
            Some(&json!("Inspect the renderer registry"))
        );
        assert_eq!(
            node.get("startedAt"),
            Some(&json!("2026-08-23T06:00:01.000Z"))
        );
        assert_eq!(
            node.get("completedAt"),
            Some(&json!("2026-08-23T06:00:03.000Z"))
        );
        assert_eq!(
            node.get("metrics"),
            Some(&json!({"toolCount": 4, "taskCount": 2, "durationMs": 900, "costUsd": 0.03}))
        );
        assert_eq!(
            node.get("execution"),
            Some(
                &json!({"mode": "remote", "background": true, "worktree": "review/c09", "team": "renderer"})
            )
        );
        assert_eq!(
            node.get("tools"),
            Some(&json!([{ "id": "tool-4", "status": "completed" }]))
        );
        assert_eq!(
            node.get("tasks"),
            Some(&json!([{ "id": "task-2", "status": "running" }]))
        );

        // typed 家族 parts 逐个过 schema：畸形证据 → bounded unknown + warning 诊断。
        let mut completed = envelope(
            1.0,
            json!({"type": "activity.completed", "activityId": "sub-malformed-output",
            "activity": {"kind": "subagent", "title": "Unsafe worker output"},
            "result": {"parts": [
                {"kind": "terminal", "streams": [{"stream": "stdout", "text": "kept"}], "exitCode": 0},
                {"kind": "terminal", "streams": [{"stream": "stdin", "text": "malformed evidence"}]},
            ]}}),
        );
        completed.event_id = "wb-sub-malformed".to_string();
        let document = reduce_all(vec![completed.clone()]);
        let node = activity_node(&document, "sub-malformed-output");
        let parts = node.get("parts").and_then(Value::as_array).expect("parts");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].get("kind"), Some(&json!("terminal")));
        assert_eq!(parts[1].get("kind"), Some(&json!("unknown")));
        assert_eq!(parts[1].get("originalType"), Some(&json!("terminal")));
        assert_eq!(parts[1].get("truncated"), Some(&Value::Bool(false)));
        let diagnostic = document
            .diagnostics
            .iter()
            .find(|item| {
                item.get("code").and_then(Value::as_str) == Some("activity.subagent.part-malformed")
            })
            .expect("malformed diagnostic");
        assert_eq!(diagnostic.get("eventId"), Some(&json!("wb-sub-malformed")));
        assert_eq!(diagnostic.get("level"), Some(&json!("warning")));
        assert_eq!(
            diagnostic["data"]["activityId"],
            json!("sub-malformed-output")
        );
        assert_eq!(diagnostic["data"]["partIndex"], json!(1));

        // result.output 归一化为 typed 内容，output 与 parts 同源。
        let document = reduce_all(vec![envelope(
            1.0,
            json!({"type": "activity.completed", "activityId": "sub-output",
                    "activity": {"kind": "subagent", "title": "Review complete"},
                    "result": {"output": [{"kind": "text", "text": "No blocking issues found."}]}}),
        )]);
        let node = activity_node(&document, "sub-output");
        assert_eq!(
            node.get("output"),
            Some(&json!([{ "kind": "text", "text": "No blocking issues found." }]))
        );
        assert_eq!(node.get("output"), node.get("parts"));

        // 终态幂等：迟到 progress 只补缺不回退；rich 字段按 C09 全集累积。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "activity.started", "activityId": "sub-1", "activity": {
                    "kind": "subagent", "semanticKind": "activity.subagent", "title": "Explore repo",
                    "parentId": "tool-1", "depth": 2, "role": "explorer", "model": "ox-alpha-free", "provider": "opencode-go",
                    "goal": "find all call sites of reduceActivity", "capabilities": ["fs", "search"],
                }}),
            ),
            envelope(
                2.0,
                json!({"type": "activity.progress", "activityId": "sub-1", "patch": {
                    "progress": {"completed": 3, "total": 5},
                    "usage": {"inputTokens": 1200, "outputTokens": 340},
                    "files": ["src/a.ts", "src/b.ts"],
                }}),
            ),
            envelope(
                3.0,
                json!({"type": "activity.completed", "activityId": "sub-1", "result": {"summary": "found 12 call sites"}}),
            ),
            envelope(
                4.0,
                json!({"type": "activity.progress", "activityId": "sub-1", "patch": {"progress": {"completed": 9, "total": 5}}}),
            ),
        ]);
        let node = activity_node(&document, "sub-1");
        assert_eq!(node.get("status"), Some(&json!("completed")));
        assert_eq!(node.get("semanticKind"), Some(&json!("activity.subagent")));
        assert_eq!(node.get("activityKind"), Some(&json!("subagent")));
        assert_eq!(node.get("parentId"), Some(&json!("tool-1")));
        assert_eq!(node.get("depth"), Some(&json!(2)));
        assert_eq!(node.get("role"), Some(&json!("explorer")));
        assert_eq!(node.get("model"), Some(&json!("ox-alpha-free")));
        assert_eq!(node.get("provider"), Some(&json!("opencode-go")));
        assert_eq!(
            node.get("goal"),
            Some(&json!("find all call sites of reduceActivity"))
        );
        assert_eq!(node.get("capabilities"), Some(&json!(["fs", "search"])));
        assert_eq!(
            node.get("progress"),
            Some(&json!({ "completed": 3, "total": 5 }))
        );
        assert_eq!(
            node.get("usage"),
            Some(&json!({"inputTokens": 1200, "outputTokens": 340}))
        );
        assert_eq!(node.get("files"), Some(&json!(["src/a.ts", "src/b.ts"])));
        assert_eq!(
            node.get("result"),
            Some(&json!({ "summary": "found 12 call sites" }))
        );

        // 孤儿子代理可见、父节点后到解除 orphan。
        let document = reduce_all(vec![envelope(
            1.0,
            json!({"type": "activity.started", "activityId": "sub-orphan", "activity": {"kind": "delegation", "semanticKind": "activity.delegation", "title": "remote delegate", "parentId": "team-9"}}),
        )]);
        assert_eq!(
            activity_node(&document, "sub-orphan").get("orphan"),
            Some(&Value::Bool(true))
        );
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "activity.started", "activityId": "sub-orphan", "activity": {"kind": "delegation", "semanticKind": "activity.delegation", "title": "remote delegate", "parentId": "team-9"}}),
            ),
            envelope(
                2.0,
                json!({"type": "activity.started", "activityId": "team-9", "activity": {"kind": "team", "semanticKind": "activity.team", "title": "Ops team"}}),
            ),
        ]);
        assert_eq!(
            activity_node(&document, "sub-orphan").get("orphan"),
            Some(&Value::Bool(false))
        );

        // minimal delegation 不猜层级/身份字段（缺失即 undefined）。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "activity.started", "activityId": "del-min", "activity": {"kind": "delegation"}}),
            ),
            envelope(
                2.0,
                json!({"type": "activity.failed", "activityId": "del-min", "reason": "connection lost"}),
            ),
        ]);
        let node = activity_node(&document, "del-min");
        assert_eq!(
            node.get("semanticKind"),
            Some(&json!("activity.delegation"))
        );
        assert!(node.get("title").is_none());
        assert!(node.get("model").is_none());
        assert!(node.get("goal").is_none());
        assert!(node.get("parentId").is_none());
        assert!(node.get("depth").is_none());
        assert_eq!(node.get("status"), Some(&json!("failed")));
        assert_eq!(node.get("reason"), Some(&json!("connection lost")));

        // C07 process：身份/进度/输出/终态/provenance 全在活动节点，不进 messages。
        let mut first = envelope(
            1.0,
            json!({"type": "activity.started", "activityId": "activity-1", "activity": {
                "kind": "process", "semanticKind": "activity.process", "title": "npm test", "parentId": "tool-1",
                "processId": "proc-1", "sessionId": "shell-1",
            }}),
        );
        first.identity.task_id = Some("activity-1".to_string());
        let mut third = envelope(
            3.0,
            json!({"type": "activity.completed", "activityId": "activity-1", "result": {
                "parts": [{"kind": "terminal", "streams": [{"stream": "stdout", "text": "passed", "ordinal": 0}], "exitCode": 0}],
            }}),
        );
        third.provenance_origin = 4;
        third.provenance_trust = 1;
        third.provenance_extra = Some(
            serde_json::json!({
                "orderConfidence": "observed",
                "synthetic": { "reason": "terminal response observed" },
            })
            .as_object()
            .cloned()
            .unwrap(),
        );
        let document = reduce_all(vec![
            first,
            envelope(
                2.0,
                json!({"type": "activity.progress", "activityId": "activity-1", "patch": {
                    "progress": {"completed": 2, "total": 3},
                    "parts": [{"kind": "log", "source": "runner", "entries": [{"level": "info", "text": "running"}]}],
                }}),
            ),
            third,
        ]);
        assert!(document.messages.is_empty());
        assert_eq!(document.activities.len(), 1);
        let node = &document.activities[0];
        assert_eq!(node.get("activityKind"), Some(&json!("process")));
        assert_eq!(node.get("semanticKind"), Some(&json!("activity.process")));
        assert_eq!(node.get("title"), Some(&json!("npm test")));
        assert_eq!(node.get("parentId"), Some(&json!("tool-1")));
        assert_eq!(node.get("processId"), Some(&json!("proc-1")));
        assert_eq!(node.get("sessionId"), Some(&json!("shell-1")));
        assert_eq!(node.get("status"), Some(&json!("completed")));
        assert_eq!(
            node.get("progress"),
            Some(&json!({ "completed": 2, "total": 3 }))
        );
        assert_eq!(node["parts"][0]["kind"], json!("terminal"));
        assert_eq!(node["provenance"]["origin"], json!("plugin"));
        assert_eq!(
            node["provenance"]["synthetic"]["reason"],
            json!("terminal response observed")
        );
        assert_eq!(node["provenance"]["orderConfidence"], json!("observed"));

        // C10 workflow：phase 终态不回退、progress 快照保持；metadata 直通。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "activity.started", "activityId": "wf-1", "activity": {"kind": "workflow", "title": "release pipeline", "metadata": {"phases": ["phase-1", "phase-2"]}}}),
            ),
            envelope(
                2.0,
                json!({"type": "activity.started", "activityId": "phase-1", "activity": {"kind": "workflow-phase", "title": "build", "parentId": "wf-1"}}),
            ),
            envelope(
                3.0,
                json!({"type": "activity.progress", "activityId": "phase-1", "patch": {"progress": {"completed": 2, "total": 4}, "metadata": {"durationMs": 1200}}}),
            ),
            envelope(
                4.0,
                json!({"type": "activity.completed", "activityId": "phase-1", "result": {"summary": "built"}}),
            ),
            envelope(
                5.0,
                json!({"type": "activity.progress", "activityId": "phase-1", "patch": {"progress": {"completed": 0, "total": 4}}}),
            ),
            envelope(
                6.0,
                json!({"type": "activity.started", "activityId": "agent-1", "activity": {"kind": "workflow-agent", "title": "reviewer bot", "parentId": "wf-1", "role": "reviewer", "model": "ox-alpha-free"}}),
            ),
            envelope(
                9.0,
                json!({"type": "activity.failed", "activityId": "agent-1", "reason": "connection lost"}),
            ),
        ]);
        let wf = activity_node(&document, "wf-1");
        assert_eq!(wf.get("semanticKind"), Some(&json!("activity.workflow")));
        assert_eq!(
            wf.get("metadata"),
            Some(&json!({ "phases": ["phase-1", "phase-2"] }))
        );
        let phase = activity_node(&document, "phase-1");
        assert_eq!(phase.get("parentId"), Some(&json!("wf-1")));
        assert_eq!(
            phase.get("semanticKind"),
            Some(&json!("activity.workflow-phase"))
        );
        assert_eq!(phase.get("status"), Some(&json!("completed")));
        assert_eq!(
            phase.get("progress"),
            Some(&json!({ "completed": 2, "total": 4 }))
        );
        let agent = activity_node(&document, "agent-1");
        assert_eq!(
            agent.get("semanticKind"),
            Some(&json!("activity.workflow-agent"))
        );
        assert_eq!(agent.get("status"), Some(&json!("failed")));
        assert_eq!(agent.get("parentId"), Some(&json!("wf-1")));
        assert_eq!(agent.get("role"), Some(&json!("reviewer")));
        // 终态后的 killed/timeout 证据保留（C10 termination evidence）。
        let document = reduce_all(vec![
            envelope(
                1.0,
                json!({"type": "activity.started", "activityId": "bg-evidence", "activity": {"kind": "background-task", "title": "nightly index"}}),
            ),
            envelope(
                2.0,
                json!({"type": "activity.progress", "activityId": "bg-evidence", "patch": {
                    "usage": {"totalTokens": 420},
                    "metrics": {"toolCount": 3, "durationMs": 1500},
                    "result": {"summary": "partial output"},
                    "killed": true,
                    "timeout": true,
                }}),
            ),
        ]);
        let node = activity_node(&document, "bg-evidence");
        assert_eq!(
            node.get("result"),
            Some(&json!({ "summary": "partial output" }))
        );
        assert_eq!(node.get("usage"), Some(&json!({ "totalTokens": 420 })));
        assert_eq!(
            node.get("metrics"),
            Some(&json!({ "toolCount": 3, "durationMs": 1500 }))
        );
        assert_eq!(node.get("killed"), Some(&Value::Bool(true)));
        assert_eq!(node.get("timeout"), Some(&Value::Bool(true)));
        assert!(document.messages.is_empty());
    }

    #[test]
    fn extension_events_project_into_a_durable_slice() {
        // extensionProjection.test.ts：持久 slice 携带 source/provenance，timeline kind=extension。
        let mut event = envelope(
            4.0,
            json!({"type": "extension.event", "kind": "plugin.demo/result", "payload": {"status": "completed", "summary": "done"},
                "fallback": [{"kind": "unknown", "originalType": "plugin.demo/result", "summary": "unknown plugin event", "raw": {"status": "completed"}, "truncated": false}]}),
        );
        event.event_id = "wb-ext-1".to_string();
        let document = reduce_all(vec![event.clone()]);
        assert_eq!(document.extensions.len(), 1);
        let extension = &document.extensions[0];
        assert_eq!(extension.get("id"), Some(&json!("wb-ext-1")));
        assert_eq!(extension.get("kind"), Some(&json!("plugin.demo/result")));
        assert_eq!(extension.get("sequence"), Some(&json!(4)));
        assert_eq!(
            extension.get("payload"),
            Some(&json!({"status": "completed", "summary": "done"}))
        );
        assert_eq!(
            extension.get("source"),
            Some(&json!({"provider": "peri", "sourceId": event.source.source_id}))
        );
        assert_eq!(
            extension.get("provenance"),
            Some(&json!({"origin": "local-observed", "trust": "authoritative"}))
        );
        assert_eq!(document.timeline[0].kind, "extension");
        // 按 sequence 插入：晚 sequence 的事件不破坏扩展列表有序性。
        let document = reduce_all(vec![
            envelope(
                9.0,
                json!({"type": "extension.event", "kind": "a.b", "payload": 1, "fallback": []}),
            ),
            envelope(
                2.0,
                json!({"type": "extension.event", "kind": "c.d", "payload": 2, "fallback": []}),
            ),
        ]);
        let sequences: Vec<f64> = document
            .extensions
            .iter()
            .filter_map(|item| item.get("sequence").and_then(Value::as_f64))
            .collect();
        assert_eq!(sequences, vec![2.0, 9.0]);
    }
}

#[cfg(test)]
mod projection_index_tests {
    use super::*;
    use serde_json::json;

    /// 与 `tests::envelope_with` 同形的本地构造（那个 helper 是兄弟模块私有的）。
    fn envelope(sequence: f64, event: Value) -> SemanticEnvelope {
        SemanticEnvelope {
            event_type: event
                .get("type")
                .and_then(Value::as_str)
                .expect("type")
                .to_string(),
            sequence,
            event_id: format!(
                "wb-index-{sequence}-{}",
                event.get("type").and_then(Value::as_str).unwrap_or("")
            ),
            session_id: "session-index".to_string(),
            recorded_at: "2026-09-21T00:00:00.000Z".to_string(),
            occurred_at: None,
            identity: Identity {
                turn_id: None,
                message_id: Some("msg-1".to_string()),
                tool_call_id: None,
                task_id: None,
                run_id: None,
                interaction_id: None,
            },
            source: EventSource {
                provider: "peri".to_string(),
                source_id: format!("wire-1-{sequence}"),
                agent_id: None,
                parent_agent_id: None,
            },
            provenance_origin: 0,
            provenance_trust: 0,
            provenance_extra: None,
            coverage: None,
            event,
        }
    }

    /// 混合 timeline：文本 delta、tool 条目、终态 session 条目、reasoning 交错，
    /// 覆盖窗口查询要分辨的三类谓词。
    fn mixed_document(event_count: usize) -> WorkbenchDocument {
        let mut document = create_workbench_document("session-index");
        for sequence in 1..=event_count {
            let event = match sequence % 7 {
                0 => {
                    json!({ "type": "tool.started", "tool": { "toolCallId": format!("tool-{sequence}") } })
                }
                3 => json!({ "type": "session.completed", "status": "completed" }),
                5 => {
                    json!({ "type": "reasoning.delta", "parts": [{ "kind": "thinking", "text": "x" }] })
                }
                _ => {
                    json!({ "type": "message.delta", "role": "assistant", "parts": [{ "kind": "text", "text": "y" }] })
                }
            };
            reduce_workbench_event(&mut document, &envelope(sequence as f64, event))
                .expect("reduce");
        }
        document
    }

    fn text_boundary_scan(document: &WorkbenchDocument, after: f64, before: f64) -> bool {
        document.timeline.iter().any(|entry| {
            entry.sequence > after && entry.sequence < before && is_text_stream_boundary(entry)
        })
    }

    /// 诊断探针（默认 ignore）：把批量折叠按阶段计时，用来定位 Θ(N²) 落点。
    /// 跑法：`cargo test -p pylon-compute --lib batch_fold_phase_probe -- --ignored --nocapture`
    #[test]
    #[ignore = "诊断用，按需手动跑"]
    fn batch_fold_phase_probe() {
        use std::time::Instant;
        let total = 20_000usize;
        let mut journal = Vec::with_capacity(total);
        journal.push(envelope(1.0, json!({ "type": "message.started", "role": "user", "parts": [{ "kind": "text", "text": "长思考" }] })));
        for index in 0..total {
            journal.push(envelope(
                (index + 2) as f64,
                json!({ "type": "reasoning.delta", "parts": [{ "kind": "thinking", "text": format!("第{index}段") }] }),
            ));
        }
        let mut document = create_workbench_document("session-probe");
        let started = Instant::now();
        let patch = project_batch(&mut document, journal).expect("batch");
        let batch_ms = started.elapsed().as_secs_f64() * 1000.0;
        println!(
            "[probe] project_batch({total}) = {batch_ms:.1}ms, patch upserts = {}",
            patch.message_upserts.len()
        );

        // 对照：同样的事件逐条 reduce（单事件路径），看是否也慢。
        let mut per_event = create_workbench_document("session-probe");
        let started = Instant::now();
        for index in 0..total {
            let item = envelope(
                (index + 2) as f64,
                json!({ "type": "reasoning.delta", "parts": [{ "kind": "thinking", "text": format!("第{index}段") }] }),
            );
            reduce_workbench_event(&mut per_event, &item).expect("reduce");
        }
        println!(
            "[probe] per-event reduce = {:.1}ms",
            started.elapsed().as_secs_f64() * 1000.0
        );

        // 分段：只到「建条目 + 入 timeline」为止（不含归约器）。
        let started = Instant::now();
        let mut doc = create_workbench_document("session-probe2");
        for index in 0..total {
            let item = envelope(
                (index + 2) as f64,
                json!({ "type": "reasoning.delta", "parts": [{ "kind": "thinking", "text": format!("第{index}段") }] }),
            );
            let entry = timeline_entry(&item);
            insert_by_sequence(&mut doc.timeline, entry);
        }
        println!(
            "[probe] 仅建条目+入 timeline = {:.1}ms",
            started.elapsed().as_secs_f64() * 1000.0
        );

        // 分段：条目 + 信封复制（with_event）。
        let started = Instant::now();
        let mut doc2 = create_workbench_document("session-probe3");
        for index in 0..total {
            let item = envelope(
                (index + 2) as f64,
                json!({ "type": "reasoning.delta", "parts": [{ "kind": "thinking", "text": format!("第{index}段") }] }),
            );
            let effective = item.with_event(item.event.clone());
            let entry = timeline_entry(&effective);
            insert_by_sequence(&mut doc2.timeline, entry);
        }
        println!(
            "[probe] 含 with_event（信封复制）= {:.1}ms",
            started.elapsed().as_secs_f64() * 1000.0
        );

        // 分段：只做文本抽取（事件树读取）。
        let started = Instant::now();
        let mut units = 0usize;
        for index in 0..total {
            let item = envelope(
                (index + 2) as f64,
                json!({ "type": "reasoning.delta", "parts": [{ "kind": "thinking", "text": format!("第{index}段") }] }),
            );
            units += text_from_parts(item.event.get("parts").expect("parts")).len();
        }
        println!(
            "[probe] 仅文本抽取 = {:.1}ms（{} 字符）",
            started.elapsed().as_secs_f64() * 1000.0,
            units
        );

        // ── 受控消融：每段只比上一段多做**一个**调用，差值即该调用的成本 ──────────
        // native release。段 0 是 harness 基线（只建信封），差值才是被测函数。
        fn ablate<F: FnMut(&SemanticEnvelope, &mut WorkbenchDocument)>(
            label: &str,
            total: usize,
            make: &dyn Fn(usize) -> SemanticEnvelope,
            mut body: F,
        ) {
            let mut doc = create_workbench_document("session-abl");
            let started = Instant::now();
            for index in 0..total {
                let item = make(index);
                body(&item, &mut doc);
            }
            println!(
                "[ablate] {label} = {:.1}ms",
                started.elapsed().as_secs_f64() * 1000.0
            );
        }
        let make = |index: usize| {
            envelope(
                (index + 2) as f64,
                json!({ "type": "reasoning.delta", "parts": [{ "kind": "thinking", "text": format!("第{index}段") }] }),
            )
        };
        ablate("0 只建信封（harness 基线）", total, &make, |_, _| {});
        ablate("1 + timeline_entry + insert", total, &make, |item, doc| {
            let entry = timeline_entry(item);
            insert_by_sequence(&mut doc.timeline, entry);
        });
        ablate("2 + reduce_semantic_event", total, &make, |item, doc| {
            let entry = timeline_entry(item);
            insert_by_sequence(&mut doc.timeline, entry);
            let effective = item.with_event(item.event.clone());
            let _ = reduce_semantic_event(doc, &effective);
        });
        ablate(
            "3 + refresh_orphans（= 完整 reduce_workbench_event）",
            total,
            &make,
            |item, doc| {
                let entry = timeline_entry(item);
                insert_by_sequence(&mut doc.timeline, entry);
                let effective = item.with_event(item.event.clone());
                let _ = reduce_semantic_event(doc, &effective);
                refresh_orphans(doc);
            },
        );
        ablate(
            "4 只 with_event（信封复制）",
            total,
            &make,
            |item, _| {
                let _ = item.with_event(item.event.clone());
            },
        );
        ablate("5 只 reduce_reasoning", total, &make, |item, doc| {
            let effective = item.with_event(item.event.clone());
            reduce_reasoning(doc, &effective);
        });
    }

    /// 窗口查询必须与「逐条扫全表」判据逐字等价——这是那处 Θ(N·T) → Θ(log T + 窗口)
    /// 改写的正确性前提，也是本文件里唯一守得住它的东西。
    #[test]
    fn sequence_window_query_matches_full_scan() {
        let document = mixed_document(120);
        for after in [0.0, 1.0, 2.5, 17.0, 60.0, 119.0, 120.0, 200.0] {
            for before in [0.0, 1.0, 18.0, 18.5, 61.0, 120.0, 121.0, 500.0] {
                assert_eq!(
                    any_entry_in_sequence_window(&document, after, before, is_text_stream_boundary),
                    text_boundary_scan(&document, after, before),
                    "文本流边界窗口 {after}..{before}"
                );
                assert_eq!(
                    any_entry_in_sequence_window(&document, after, before, |entry| entry.kind
                        == "tool"),
                    document.timeline.iter().any(|entry| entry.sequence > after
                        && entry.sequence < before
                        && entry.kind == "tool"),
                    "tool 窗口 {after}..{before}"
                );
            }
        }
    }

    /// 增量缓存的终态 fence 必须等于整条扫描的结果——缓存的两条前提（条目
    /// kind/data 构建后不可变、timeline 只增不减）在归约过程中被反复使用。
    #[test]
    fn cached_terminal_fence_matches_full_scan() {
        let mut document = create_workbench_document("session-index-fence");
        for sequence in 1..=80 {
            let event = if sequence % 11 == 0 {
                json!({ "type": "session.completed", "status": "completed" })
            } else {
                json!({ "type": "message.delta", "role": "assistant", "parts": [{ "kind": "text", "text": "z" }] })
            };
            reduce_workbench_event(&mut document, &envelope(sequence as f64, event))
                .expect("reduce");
            let cached = terminal_session_sequence(&mut document);
            let full = document
                .timeline
                .iter()
                .filter(|entry| is_terminal_session_entry(entry))
                .map(|entry| entry.sequence)
                .fold(f64::NEG_INFINITY, f64::max);
            assert_eq!(cached, full, "终态 fence 在 sequence {sequence} 处不一致");
        }
        // timeline 被缩短（重建的一种）时缓存必须作废重扫，而不是继续返回旧的最大值。
        document.timeline.truncate(10);
        let rescanned = terminal_session_sequence(&mut document);
        let expected = document
            .timeline
            .iter()
            .filter(|entry| is_terminal_session_entry(entry))
            .map(|entry| entry.sequence)
            .fold(f64::NEG_INFINITY, f64::max);
        assert_eq!(rescanned, expected, "缩短 timeline 后缓存未作废");
    }
}

#[cfg(test)]
mod provider_identity_tests {
    use super::*;
    use serde_json::json;

    fn identity_from(value: Value) -> Identity {
        let get = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
        Identity {
            turn_id: get("turnId"),
            message_id: get("messageId"),
            tool_call_id: get("toolCallId"),
            task_id: get("taskId"),
            run_id: get("runId"),
            interaction_id: get("interactionId"),
        }
    }

    /// 直读版必须与「建 Value 再查」版逐字一致——它是那处逐事件 Map 构建的替代。
    #[test]
    fn struct_read_matches_value_lookup() {
        let cases = [
            json!({ "messageId": "m", "turnId": "t", "toolCallId": "c" }),
            json!({ "turnId": "t", "toolCallId": "c" }),
            json!({ "toolCallId": "c", "taskId": "k" }),
            json!({ "taskId": "k", "interactionId": "i" }),
            json!({ "interactionId": "i" }),
            // runId 两侧都不参与，故应落到空串
            json!({ "runId": "r" }),
            json!({}),
            // 空串与仅空白都算缺席：值版走 `string_value`（js_trim 后为空即过滤），
            // 故必须继续往后找 turnId，而不是短路返回。
            json!({ "messageId": "", "turnId": "t" }),
            json!({ "messageId": " \u{feff}", "turnId": "t" }),
            json!({ "messageId": " \t ", "toolCallId": "c" }),
        ];
        for case in cases {
            let identity = identity_from(case.clone());
            assert_eq!(
                provider_identity_key_of(&identity),
                provider_identity_key(&case),
                "身份 {case}"
            );
        }

        // 全覆盖：六字段的所有存在组合（2^6）都必须与值版一致。
        for mask in 0u32..64 {
            let mut object = Map::new();
            for (bit, key) in [
                "turnId",
                "messageId",
                "toolCallId",
                "taskId",
                "runId",
                "interactionId",
            ]
            .into_iter()
            .enumerate()
            {
                if mask & (1 << bit) != 0 {
                    // 交替放「非空 / 空串 / 仅空白(含 U+FEFF)」——值版按 js_trim 过滤，
                    // 三种都见过才算比对充分。
                    let text = match bit % 3 {
                        0 => format!("{key}-v"),
                        1 => String::new(),
                        _ => " \u{feff}\t".to_string(),
                    };
                    object.insert(key.to_string(), Value::String(text));
                }
            }
            let value = Value::Object(object);
            let identity = identity_from(value.clone());
            assert_eq!(
                provider_identity_key_of(&identity),
                provider_identity_key(&value),
                "组合 mask={mask}"
            );
        }
    }
}

#[cfg(test)]
mod text_slice_equivalence_tests {
    use super::*;
    use serde_json::json;

    fn next(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *seed >> 33
    }

    /// 热路径现在用**原始** parts 切片算文本（省掉每事件一次 `Value::Array(clone())`）。
    /// 这条等价性必须成立：合并只把相邻文本部件的 `text` 相接，不改变整体拼接结果。
    /// 用随机部件序列把边角（unknown+summary、缺 text、language 有无、全空）都扫到。
    #[test]
    fn text_slice_matches_coalesced() {
        for seed in 1..=60u64 {
            let mut state = seed;
            let mut parts: Vec<Value> = Vec::new();
            for index in 0..8 {
                let roll = next(&mut state) % 6;
                parts.push(match roll {
                    0 => json!({ "kind": "reasoning", "text": format!("r{index}") }),
                    1 => {
                        json!({ "kind": "thinking", "text": format!("t{index}"), "language": "zh" })
                    }
                    2 => json!({ "kind": "unknown", "summary": format!("s{index}") }),
                    3 => json!({ "kind": "reasoning" }),
                    4 => json!({ "kind": "unknown", "summary": 42 }),
                    _ => json!({ "kind": "text", "text": "" }),
                });
            }
            if next(&mut state) % 3 == 0 {
                parts.clear();
            }
            let raw = text_from_slice(&parts);
            let coalesced =
                coalesce_adjacent_reasoning_parts(&parts).unwrap_or_else(|| parts.clone());
            let merged = text_from_parts(&Value::Array(coalesced));
            assert_eq!(raw, merged, "seed={seed} parts={parts:?}");
        }
    }

    /// 切片版下沉与值版下沉必须等价（前者是热路径调用，后者保留给非切片入参）。
    #[test]
    fn slice_sink_matches_value_sink() {
        for seed in 1..=30u64 {
            let mut state = seed;
            let mut parts: Vec<Value> = Vec::new();
            for index in 0..6 {
                parts.push(match next(&mut state) % 4 {
                    0 => json!({ "kind": "reasoning", "text": format!("a{index}") }),
                    1 => json!({ "kind": "thinking", "text": format!("b{index}") }),
                    2 => json!({ "kind": "text", "text": "" }),
                    _ => json!({ "kind": "unknown", "summary": "s" }),
                });
            }
            let mut via_slice = Value::Array(Vec::new());
            append_parts_slice_in_place(&mut via_slice, &parts, merge_reasoning_pair);
            let mut via_value = Value::Array(Vec::new());
            append_parts_in_place(
                &mut via_value,
                &Value::Array(parts.clone()),
                merge_reasoning_pair,
            );
            assert_eq!(via_slice, via_value, "seed={seed}");
        }
    }
}
