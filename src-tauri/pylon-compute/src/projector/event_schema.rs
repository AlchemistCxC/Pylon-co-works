//! WP2 补全：workbench 语义事件 envelope 的构造 / 迁移 / 解析，以及
//! canonical → semantic 投影注册表。
//!
//! TS 基线（逐函数对齐）：`src/domains/workbench/events/workbenchEventSchema.ts` 的
//! `CANONICAL_SEMANTIC_PROJECTION_REGISTRY` / `migrateCanonicalEvent` /
//! `createWorkbenchEnvelope` / `deriveWorkbenchEventId`（fnv1a + stableStringify）/
//! `parseWorkbenchEnvelope` / `migrateWorkbenchEnvelope`。
//!
//! 这是 journal 读缝（migration seam）的纯逻辑：canonical 行（eventType +
//! typedPayload + rawPayload）在此投影成 renderer 消费的 semantic event。注册表是
//! 「canonical 事件名 → 语义形态」的唯一选择点；未知类型走 raw 保留的
//! `event.unknown` 兜底，不静默丢弃（§5.10 原则 5）。
//!
//! 已知语义缺口：`Date.parse` 的 ISO 子集（见 [`super::workbench::parse_iso_to_ms`]，
//! 无时区按 UTC）；`Object.keys().sort()` 按 UTF-8 字节序近似 JS 的 UTF-16 序——
//! 词表键为 ASCII，不可达。

use serde_json::{json, Map, Value};

use super::content_part::{
    as_record, byte_length, create_unknown_content_part, is_json_value, js_json_stringify,
    js_number_to_string, js_trim, js_utf16_length, number_as_f64, parse_content_part, SchemaIssue,
    SchemaResult,
};
use super::workbench::{js_number_value, parse_iso_to_ms};

const CURRENT_SCHEMA_VERSION: f64 = 1.0;
const DEFAULT_RAW_MAX_BYTES: f64 = 64.0 * 1024.0;

/// TS `receivedType`。
fn received_type(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Array(_) => "array".to_string(),
        other => super::content_part::js_typeof(other).to_string(),
    }
}

fn issue(path: Vec<Value>, code: &str, expected: &str, value: Option<&Value>) -> SchemaIssue {
    SchemaIssue {
        path,
        code: code.to_string(),
        expected: expected.to_string(),
        received: value
            .map(received_type)
            .unwrap_or_else(|| "undefined".to_string()),
        summary: format!("Expected {expected}"),
    }
}

fn path_str(parts: &[&str]) -> Vec<Value> {
    parts
        .iter()
        .map(|part| Value::String((*part).to_string()))
        .collect()
}

fn failure(issues: Vec<SchemaIssue>) -> SchemaResult<Value> {
    Err(issues)
}

// ── canonical → semantic 投影注册表 ──────────────────────────────────────────

fn unknown_canonical_projection(event_type: &str, raw: &Value) -> Value {
    json!({
        "type": "event.unknown",
        "originalType": event_type,
        "summary": format!("Migrated {event_type}"),
        "raw": raw,
        "truncated": false,
    })
}

fn unknown_without_id(event_type: &str, raw: &Value) -> Value {
    json!({
        "type": "event.unknown",
        "originalType": event_type,
        "summary": format!("Migrated {event_type} without interaction id"),
        "raw": raw,
        "truncated": false,
    })
}

fn tool_projection(event_type: &str, typed: &Value, text: Option<&str>) -> Value {
    let mut event = Map::new();
    event.insert("type".to_string(), Value::String(event_type.to_string()));
    if let Some(tool) = typed.get("tool") {
        event.insert("tool".to_string(), tool.clone());
    }
    if let Some(progress) = typed.get("progress") {
        event.insert("progress".to_string(), progress.clone());
    }
    if let Some(result) = typed.get("result") {
        event.insert("result".to_string(), result.clone());
    }
    if let Some(text) = text {
        event.insert(
            "parts".to_string(),
            json!([{ "kind": "text", "text": text }]),
        );
    }
    Value::Object(event)
}

fn lifecycle_projection(event_type: &str, typed: &Value) -> Value {
    let mut event = Map::new();
    event.insert("type".to_string(), Value::String(event_type.to_string()));
    if let Some(attempt) = typed.get("attempt").filter(|v| v.is_number()) {
        event.insert("attempt".to_string(), attempt.clone());
    }
    if let Some(reason) = typed.get("reason").and_then(Value::as_str) {
        event.insert("reason".to_string(), Value::String(reason.to_string()));
    }
    if let Some(summary) = typed.get("summary").and_then(Value::as_str) {
        event.insert("summary".to_string(), Value::String(summary.to_string()));
    }
    Value::Object(event)
}

fn diagnostic_projection(event_type: &str, typed: &Value) -> Value {
    let mut event = Map::new();
    event.insert("type".to_string(), Value::String(event_type.to_string()));
    if let Some(diagnostics) = typed.get("diagnostics").filter(|v| v.is_array()) {
        event.insert("diagnostics".to_string(), diagnostics.clone());
    }
    if let Some(level @ ("info" | "warning" | "error")) = typed.get("level").and_then(Value::as_str)
    {
        event.insert("level".to_string(), Value::String(level.to_string()));
    }
    if let Some(message) = typed.get("message").and_then(Value::as_str) {
        event.insert("message".to_string(), Value::String(message.to_string()));
    }
    if let Some(code) = typed.get("code").and_then(Value::as_str) {
        event.insert("code".to_string(), Value::String(code.to_string()));
    }
    Value::Object(event)
}

/// TS `CANONICAL_SEMANTIC_PROJECTION_REGISTRY` + `migrateCanonicalEvent` 的合成：
/// canonical 事件名 → semantic event；词表外的名字走 raw 保留兜底。函数式 match
/// 即注册表本体（键集由 `CanonicalEventType` 词表与迁移别名组成，parity 测试钉死）。
pub fn migrate_canonical_event(
    event_type: &str,
    typed: &Value,
    text: Option<&str>,
    raw: &Value,
) -> Value {
    let string_field = |key: &str| typed.get(key).and_then(Value::as_str);
    let event = match event_type {
        "user.message" => json!({
            "type": "message.delta",
            "role": "user",
            "parts": match text {
                Some(text) => json!([{ "kind": "text", "text": text }]),
                None => json!([]),
            },
        }),
        "assistant.text.delta" | "assistant.text.delta.batch" => json!({
            "type": "message.delta",
            "role": "assistant",
            "parts": match text {
                Some(text) => json!([{ "kind": "text", "text": text }]),
                None => json!([]),
            },
        }),
        "assistant.reasoning.delta"
        | "assistant.thinking.delta"
        | "assistant.thinking.delta.batch" => {
            let mut event = Map::new();
            event.insert(
                "type".to_string(),
                Value::String("reasoning.delta".to_string()),
            );
            // 注意：text 缺席时 parts 键整体缺席（与 message.delta 的 `parts: []` 不同）。
            if let Some(text) = text {
                event.insert(
                    "parts".to_string(),
                    json!([{ "kind": "text", "text": text }]),
                );
            }
            Value::Object(event)
        }
        "tool.started"
        | "tool.progress"
        | "tool.completed"
        | "tool.failed"
        | "tool.call.started"
        | "tool.call.updated"
        | "tool.call.completed"
        | "tool.call.failed" => {
            let semantic_type = match event_type {
                "tool.call.started" => "tool.started",
                "tool.call.updated" => "tool.progress",
                "tool.call.completed" => "tool.completed",
                "tool.call.failed" => "tool.failed",
                other => other,
            };
            tool_projection(semantic_type, typed, text)
        }
        "plan.replaced" => {
            let mut event = Map::new();
            event.insert(
                "type".to_string(),
                Value::String("plan.replaced".to_string()),
            );
            if let Some(entries) = typed.get("entries").filter(|v| v.is_array()) {
                event.insert("entries".to_string(), entries.clone());
            }
            Value::Object(event)
        }
        "plan.entry-updated" => {
            let mut event = Map::new();
            event.insert(
                "type".to_string(),
                Value::String("plan.entry-updated".to_string()),
            );
            if let Some(entry) = typed.get("entry") {
                event.insert("entry".to_string(), entry.clone());
            }
            Value::Object(event)
        }
        "usage.updated" => {
            let mut event = Map::new();
            event.insert(
                "type".to_string(),
                Value::String("usage.updated".to_string()),
            );
            if let Some(usage) = typed.get("usage") {
                event.insert("usage".to_string(), usage.clone());
            }
            Value::Object(event)
        }
        "goal.updated" => {
            let mut event = Map::new();
            event.insert(
                "type".to_string(),
                Value::String("goal.updated".to_string()),
            );
            if let Some(goal) = typed.get("goal") {
                event.insert("goal".to_string(), goal.clone());
            }
            if let Some(goal_id) = string_field("goalId") {
                event.insert("goalId".to_string(), Value::String(goal_id.to_string()));
            }
            Value::Object(event)
        }
        "goal.cleared" => {
            let mut event = Map::new();
            event.insert(
                "type".to_string(),
                Value::String("goal.cleared".to_string()),
            );
            if let Some(goal_id) = string_field("goalId") {
                event.insert("goalId".to_string(), Value::String(goal_id.to_string()));
            }
            Value::Object(event)
        }
        "activity.started" | "activity.progress" | "activity.completed" | "activity.failed"
        | "activity.cancelled" => {
            let mut event = Map::new();
            event.insert("type".to_string(), Value::String(event_type.to_string()));
            for key in ["activity", "result", "error"] {
                if let Some(value) = typed.get(key) {
                    event.insert(key.to_string(), value.clone());
                }
            }
            Value::Object(event)
        }
        "interaction.requested" | "interaction.resolved" | "interaction.expired" => {
            match string_field("interactionId") {
                Some(interaction_id) if !interaction_id.is_empty() => {
                    json!({ "type": event_type, "interactionId": interaction_id })
                }
                _ => unknown_without_id(event_type, raw),
            }
        }
        "interaction.answered" => match string_field("interactionId") {
            Some(interaction_id) if !interaction_id.is_empty() => {
                let mut event = Map::new();
                event.insert(
                    "type".to_string(),
                    Value::String("interaction.resolved".to_string()),
                );
                event.insert(
                    "interactionId".to_string(),
                    Value::String(interaction_id.to_string()),
                );
                if let Some(response) = typed.get("response") {
                    event.insert("response".to_string(), response.clone());
                }
                Value::Object(event)
            }
            _ => unknown_without_id("interaction.answered", raw),
        },
        "turn.completed" | "session.completed" => {
            let mut event = Map::new();
            event.insert(
                "type".to_string(),
                Value::String("session.completed".to_string()),
            );
            if let Some(stop_reason) = string_field("stopReason") {
                event.insert(
                    "stopReason".to_string(),
                    Value::String(stop_reason.to_string()),
                );
            }
            if let Some(usage) = typed.get("usage") {
                event.insert("usage".to_string(), usage.clone());
            }
            if let Some(model) = string_field("model") {
                event.insert("model".to_string(), Value::String(model.to_string()));
            }
            Value::Object(event)
        }
        "turn.failed" => {
            let mut event = Map::new();
            event.insert(
                "type".to_string(),
                Value::String("diagnostic.notice".to_string()),
            );
            event.insert("level".to_string(), Value::String("error".to_string()));
            match string_field("error") {
                Some(error) => {
                    event.insert("message".to_string(), Value::String(error.to_string()));
                }
                None => {
                    event.insert(
                        "message".to_string(),
                        Value::String("provider reported a cancelled or failed turn".to_string()),
                    );
                }
            }
            match string_field("code") {
                Some(code) => {
                    event.insert("code".to_string(), Value::String(code.to_string()));
                }
                None => {
                    event.insert("code".to_string(), Value::String("turn.failed".to_string()));
                }
            }
            event.insert("data".to_string(), raw.clone());
            Value::Object(event)
        }
        "session.model-updated" | "session.mode-updated" | "session.status-updated" => {
            let field = event_type
                .strip_prefix("session.")
                .unwrap_or("")
                .replace("-updated", "");
            let mut event = Map::new();
            event.insert("type".to_string(), Value::String(event_type.to_string()));
            if let Some(value) = string_field(&field) {
                event.insert(field, Value::String(value.to_string()));
            }
            Value::Object(event)
        }
        "session.config-updated" => {
            let mut event = Map::new();
            event.insert(
                "type".to_string(),
                Value::String("session.config-updated".to_string()),
            );
            if let Some(options) = typed.get("options").filter(|v| v.is_array()) {
                event.insert("options".to_string(), options.clone());
            }
            Value::Object(event)
        }
        "session.commands-updated" => {
            let mut event = Map::new();
            event.insert(
                "type".to_string(),
                Value::String("session.commands-updated".to_string()),
            );
            if let Some(commands) = typed.get("commands").filter(|v| v.is_array()) {
                event.insert("commands".to_string(), commands.clone());
            }
            Value::Object(event)
        }
        "lifecycle.retrying"
        | "lifecycle.compact-started"
        | "lifecycle.compact-completed"
        | "lifecycle.suspended"
        | "lifecycle.recovered" => lifecycle_projection(event_type, typed),
        "diagnostic.updated" | "diagnostic.notice" => diagnostic_projection(event_type, typed),
        _ => unknown_canonical_projection(event_type, raw),
    };
    event
}

// ── eventId 派生（fnv1a + stableStringify） ──────────────────────────────────

/// TS `stableStringify`：对象键排序后稳定序列化。键序按 UTF-8 字节序近似 JS 的
/// UTF-16 序（ASCII 键不可达分歧）。
fn stable_stringify(value: &Value) -> String {
    match value {
        Value::Array(items) => {
            let body: Vec<String> = items.iter().map(stable_stringify).collect();
            format!("[{}]", body.join(","))
        }
        Value::Object(record) => {
            let mut keys: Vec<&String> = record.keys().collect();
            keys.sort();
            let body: Vec<String> = keys
                .iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        js_json_stringify(&Value::String((*key).clone())),
                        stable_stringify(&record[*key])
                    )
                })
                .collect();
            format!("{{{}}}", body.join(","))
        }
        other => js_json_stringify(other),
    }
}

/// TS `fnv1a`：按 UTF-16 码元迭代（charCodeAt 语义），Math.imul → wrapping mul。
fn fnv1a(value: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in value.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{hash:08x}")
}

/// TS `deriveWorkbenchEventId`：sequence 是 journal 显式序（防同 provider id 碰撞），
/// 不取数组位、不取墙钟。
pub fn derive_workbench_event_id(
    session_id: &str,
    sequence: f64,
    provider: &str,
    source_id: &str,
    identity: &Value,
    event: &Value,
) -> String {
    let empty = Map::new();
    let identity_record = identity.as_object().unwrap_or(&empty);
    let stable_identity = if !identity_record.is_empty() {
        identity.clone()
    } else {
        json!({ "sourceId": source_id })
    };
    let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");
    // sequence 以 JSON number 进稳定序列化（TS：JSON.stringify(3) → "3"，
    // 不是 "\"3\""）。
    let payload = json!([
        session_id,
        provider,
        source_id,
        event_type,
        stable_identity,
        Value::Number(
            serde_json::Number::from_f64(sequence).unwrap_or(serde_json::Number::from(0))
        ),
    ]);
    format!("wb-{}", fnv1a(&stable_stringify(&payload)))
}

// ── envelope 构造 ────────────────────────────────────────────────────────────

/// TS `createWorkbenchEnvelope`（JSON 进出）。raw 经 `createUnknownContentPart`
/// 做截断/脱敏记账；eventId 缺省由内容稳定派生。
pub fn create_workbench_envelope(input: &Value) -> Value {
    let record = input.as_object().expect("envelope input 是对象");
    let string_field = |key: &str| record.get(key).and_then(Value::as_str).unwrap_or("");
    let session_id = string_field("sessionId");
    let recorded_at = string_field("recordedAt");
    let identity = record
        .get("identity")
        .and_then(as_record)
        .map(|record| Value::Object(record.clone()))
        .unwrap_or_else(|| json!({}));
    let source = record.get("source").cloned().unwrap_or_else(|| json!({}));
    let provenance = record
        .get("provenance")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let event = record.get("event").cloned().unwrap_or_else(|| json!({}));

    let raw_info = record.get("raw").map(|raw| {
        let max_raw_bytes = record
            .get("rawMaxBytes")
            .and_then(Value::as_f64)
            .unwrap_or(DEFAULT_RAW_MAX_BYTES);
        create_unknown_content_part("__envelope_raw__", raw, Some(max_raw_bytes))
    });
    let raw = raw_info.as_ref().and_then(|info| info.get("raw").cloned());
    let raw_metadata: Option<Value> = raw_info.as_ref().map(|info| {
        if let Some(truncation) = info.get("truncation") {
            let mut merged = truncation.as_object().expect("truncation").clone();
            if let Some(redactions) = info.get("redactions") {
                merged.insert("redactions".to_string(), redactions.clone());
            }
            Value::Object(merged)
        } else if info
            .get("redactions")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
        {
            // TS：originalBytes/retainedBytes 取 JSON.stringify(...).length（UTF-16）。
            let encoded = js_json_stringify(info.get("raw").unwrap_or(&Value::Null));
            let length = js_utf16_length(&encoded);
            json!({
                "truncated": false,
                "originalBytes": length,
                "retainedBytes": length,
                "omittedBytes": 0,
                "reason": "sensitive",
                "redactions": info.get("redactions"),
            })
        } else {
            Value::Null
        }
    });
    let raw_metadata = raw_metadata.filter(|value| !value.is_null());

    let mut base = Map::new();
    base.insert(
        "schemaVersion".to_string(),
        js_number_value(CURRENT_SCHEMA_VERSION),
    );
    base.insert(
        "sessionId".to_string(),
        Value::String(session_id.to_string()),
    );
    base.insert(
        "sequence".to_string(),
        record
            .get("sequence")
            .and_then(Value::as_f64)
            .map(js_number_value)
            .unwrap_or(Value::Null),
    );
    base.insert(
        "recordedAt".to_string(),
        Value::String(recorded_at.to_string()),
    );
    // TS：`...(input.occurredAt ? { occurredAt } : {})` —— truthy 串才带键。
    if let Some(occurred_at) = record.get("occurredAt").and_then(Value::as_str) {
        if !occurred_at.is_empty() {
            base.insert(
                "occurredAt".to_string(),
                Value::String(occurred_at.to_string()),
            );
        }
    }
    base.insert("source".to_string(), source);
    base.insert("identity".to_string(), identity);
    base.insert("provenance".to_string(), provenance);
    base.insert("event".to_string(), event);
    if let Some(coverage) = record.get("coverage").filter(|value| value.is_array()) {
        base.insert("coverage".to_string(), coverage.clone());
    }
    if let Some(raw) = raw {
        base.insert("raw".to_string(), raw);
    }
    if let Some(raw_metadata) = raw_metadata {
        base.insert("rawMetadata".to_string(), raw_metadata);
    }
    match record
        .get("eventId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
    {
        Some(event_id) => {
            base.insert("eventId".to_string(), Value::String(event_id.to_string()));
        }
        None => {
            let source_record = base
                .get("source")
                .and_then(as_record)
                .cloned()
                .unwrap_or_default();
            let provider = source_record
                .get("provider")
                .and_then(Value::as_str)
                .unwrap_or("");
            let source_id = source_record
                .get("sourceId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let event_id = derive_workbench_event_id(
                session_id,
                base.get("sequence").and_then(Value::as_f64).unwrap_or(0.0),
                provider,
                source_id,
                base.get("identity").unwrap_or(&Value::Null),
                base.get("event").unwrap_or(&Value::Null),
            );
            base.insert("eventId".to_string(), Value::String(event_id));
        }
    }
    Value::Object(base)
}

// ── envelope 解析 ────────────────────────────────────────────────────────────

fn require_string(record: &Map<String, Value>, key: &str, issues: &mut Vec<SchemaIssue>) {
    let value = record.get(key);
    let ok = value.and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if !ok {
        issues.push(issue(
            path_str(&[key]),
            "type.string",
            "non-empty string",
            value,
        ));
    }
}

fn is_safe_integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0)
}

fn require_positive_integer(record: &Map<String, Value>, key: &str, issues: &mut Vec<SchemaIssue>) {
    let value = record.get(key);
    let ok = value
        .and_then(Value::as_f64)
        .is_some_and(|number| number.fract() == 0.0 && number >= 1.0);
    if !ok {
        issues.push(issue(
            path_str(&[key]),
            "number.positive-integer",
            "positive integer",
            value,
        ));
    }
}

fn require_iso_date(record: &Map<String, Value>, key: &str, issues: &mut Vec<SchemaIssue>) {
    let value = record.get(key);
    let ok = value
        .and_then(Value::as_str)
        .is_some_and(|text| parse_iso_to_ms(text).is_some());
    if !ok {
        issues.push(issue(
            path_str(&[key]),
            "date.iso",
            "ISO date string",
            value,
        ));
    }
}

fn validate_source(value: Option<&Value>, issues: &mut Vec<SchemaIssue>) {
    let Some(record) = value.and_then(as_record) else {
        issues.push(issue(path_str(&["source"]), "type.object", "object", value));
        return;
    };
    require_string(record, "provider", issues);
    require_string(record, "sourceId", issues);
    for key in ["agentId", "parentAgentId"] {
        if let Some(value) = record.get(key) {
            if !value.is_string() {
                issues.push(issue(
                    path_str(&["source", key]),
                    "type.string",
                    "string",
                    Some(value),
                ));
            }
        }
    }
}

fn validate_identity(value: Option<&Value>, issues: &mut Vec<SchemaIssue>) {
    let Some(record) = value.and_then(as_record) else {
        issues.push(issue(
            path_str(&["identity"]),
            "type.object",
            "object",
            value,
        ));
        return;
    };
    for key in [
        "turnId",
        "messageId",
        "toolCallId",
        "taskId",
        "runId",
        "interactionId",
    ] {
        if let Some(value) = record.get(key) {
            if !value.is_string() {
                issues.push(issue(
                    path_str(&["identity", key]),
                    "type.string",
                    "string",
                    Some(value),
                ));
            }
        }
    }
}

fn validate_provenance(value: Option<&Value>, issues: &mut Vec<SchemaIssue>) {
    const ORIGINS: [&str; 5] = [
        "local-observed",
        "optimistic-local",
        "recovery-import",
        "migration",
        "plugin",
    ];
    const TRUSTS: [&str; 2] = ["authoritative", "unverified"];
    let Some(record) = value.and_then(as_record) else {
        issues.push(issue(
            path_str(&["provenance"]),
            "type.object",
            "object",
            value,
        ));
        return;
    };
    let origin = record.get("origin").and_then(Value::as_str);
    let trust = record.get("trust").and_then(Value::as_str);
    if !origin.is_some_and(|origin| ORIGINS.contains(&origin)) {
        let expected = ORIGINS.join("|");
        issues.push(issue(
            path_str(&["provenance", "origin"]),
            "enum.origin",
            &expected,
            record.get("origin"),
        ));
    }
    if !trust.is_some_and(|trust| TRUSTS.contains(&trust)) {
        let expected = TRUSTS.join("|");
        issues.push(issue(
            path_str(&["provenance", "trust"]),
            "enum.trust",
            &expected,
            record.get("trust"),
        ));
    }
    if origin == Some("local-observed") && trust != Some("authoritative") {
        issues.push(issue(
            path_str(&["provenance", "trust"]),
            "provenance.trust",
            "authoritative for local-observed",
            record.get("trust"),
        ));
    }
    if origin != Some("local-observed") && trust == Some("authoritative") {
        issues.push(issue(
            path_str(&["provenance", "trust"]),
            "provenance.trust",
            "unverified for non-local origin",
            record.get("trust"),
        ));
    }
    if origin == Some("recovery-import") {
        let provider_ok = record
            .get("provider")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty());
        if !provider_ok {
            issues.push(issue(
                path_str(&["provenance", "provider"]),
                "required.provider",
                "non-empty string",
                record.get("provider"),
            ));
        }
        let import_ok = record
            .get("importId")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.is_empty());
        if !import_ok {
            issues.push(issue(
                path_str(&["provenance", "importId"]),
                "required.importId",
                "non-empty string",
                record.get("importId"),
            ));
        }
    }
    if let Some(source_ordinal) = record.get("sourceOrdinal") {
        let ok = source_ordinal
            .as_f64()
            .is_some_and(|number| number.fract() == 0.0 && number >= 0.0);
        if !ok {
            issues.push(issue(
                path_str(&["provenance", "sourceOrdinal"]),
                "number.integer",
                "non-negative integer",
                Some(source_ordinal),
            ));
        }
    }
    if let Some(provider) = record.get("provider") {
        if !provider.is_string() {
            issues.push(issue(
                path_str(&["provenance", "provider"]),
                "type.string",
                "string",
                Some(provider),
            ));
        }
    }
    if let Some(import_id) = record.get("importId") {
        if !import_id.is_string() {
            issues.push(issue(
                path_str(&["provenance", "importId"]),
                "type.string",
                "string",
                Some(import_id),
            ));
        }
    }
    if let Some(order_confidence) = record.get("orderConfidence") {
        if !matches!(
            order_confidence.as_str(),
            Some("exact") | Some("observed") | Some("grouped") | Some("unknown")
        ) {
            issues.push(issue(
                path_str(&["provenance", "orderConfidence"]),
                "enum.order-confidence",
                "exact|observed|grouped|unknown",
                Some(order_confidence),
            ));
        }
    }
    if let Some(collection_complete) = record.get("collectionComplete") {
        if !collection_complete.is_boolean() {
            issues.push(issue(
                path_str(&["provenance", "collectionComplete"]),
                "type.boolean",
                "boolean",
                Some(collection_complete),
            ));
        }
    }
    if let Some(synthetic) = record.get("synthetic") {
        let reason_ok = synthetic
            .get("reason")
            .and_then(Value::as_str)
            .is_some_and(|reason| !js_trim(reason).is_empty());
        if !synthetic.is_object() || !reason_ok {
            issues.push(issue(
                path_str(&["provenance", "synthetic"]),
                "synthetic.reason",
                "non-empty reason",
                Some(synthetic),
            ));
        } else if record.get("orderConfidence").and_then(Value::as_str) != Some("observed") {
            issues.push(issue(
                path_str(&["provenance", "orderConfidence"]),
                "synthetic.order-confidence",
                "observed for synthetic events",
                record.get("orderConfidence"),
            ));
        }
    }
}

fn is_valid_raw_metadata(value: &Value) -> bool {
    let Some(record) = as_record(value) else {
        return false;
    };
    let truncated_ok = matches!(
        record.get("truncated"),
        Some(Value::Bool(true)) | Some(Value::Bool(false))
    );
    let bytes_ok = ["originalBytes", "retainedBytes", "omittedBytes"]
        .iter()
        .all(|key| {
            record
                .get(*key)
                .and_then(Value::as_f64)
                .is_some_and(|number| number >= 0.0)
        });
    let reason_ok = matches!(
        record.get("reason").and_then(Value::as_str),
        Some("size-limit") | Some("non-serializable") | Some("sensitive")
    );
    truncated_ok && bytes_ok && reason_ok
}

fn json_bytes(value: &Value) -> usize {
    byte_length(&js_json_stringify(value))
}

fn validate_parts(value: Option<&Value>, path: &[Value], issues: &mut Vec<SchemaIssue>) {
    let Some(items) = value.and_then(Value::as_array) else {
        issues.push(issue(path.to_vec(), "type.array", "array", value));
        return;
    };
    for (index, part) in items.iter().enumerate() {
        if let Err(part_issues) = parse_content_part(part) {
            for mut item in part_issues {
                let mut prefixed = path.to_vec();
                prefixed.push(Value::from(index as i64));
                prefixed.append(&mut item.path);
                item.path = prefixed;
                issues.push(item);
            }
        }
    }
}

fn is_known_event_type(event_type: &str) -> bool {
    // WORKBENCH_EVENT_TYPES 前 43 项即 TS WORKBENCH_SEMANTIC_EVENT_TYPES。
    super::workbench::WORKBENCH_EVENT_TYPES
        .iter()
        .take(43)
        .any(|known| *known == event_type)
}

/// TS `parseSemanticEvent`。
fn parse_semantic_event(value: &Value) -> SchemaResult<Value> {
    let Some(record) = as_record(value) else {
        return failure(vec![issue(
            Vec::new(),
            "event.type",
            "event object with type",
            Some(value),
        )]);
    };
    let Some(event_type) = record.get("type").and_then(Value::as_str) else {
        return failure(vec![issue(
            Vec::new(),
            "event.type",
            "event object with type",
            Some(value),
        )]);
    };
    let mut issues: Vec<SchemaIssue> = Vec::new();
    if event_type == "event.unknown" {
        if record.get("originalType").and_then(Value::as_str).is_none() {
            issues.push(issue(
                path_str(&["originalType"]),
                "type.string",
                "string",
                record.get("originalType"),
            ));
        }
        if record.get("summary").and_then(Value::as_str).is_none() {
            issues.push(issue(
                path_str(&["summary"]),
                "type.string",
                "string",
                record.get("summary"),
            ));
        }
        if let Some(raw) = record.get("raw") {
            if !is_json_value(raw) {
                issues.push(issue(
                    path_str(&["raw"]),
                    "json value",
                    "JSON value",
                    Some(raw),
                ));
            }
        } else {
            issues.push(issue(path_str(&["raw"]), "json value", "JSON value", None));
        }
        if !matches!(record.get("truncated"), Some(Value::Bool(_))) {
            issues.push(issue(
                path_str(&["truncated"]),
                "type.boolean",
                "boolean",
                record.get("truncated"),
            ));
        }
        if let (Some(raw), Some(truncated)) = (record.get("raw"), record.get("truncated")) {
            if json_bytes(raw) > DEFAULT_RAW_MAX_BYTES as usize && truncated != &Value::Bool(true) {
                issues.push(issue(
                    path_str(&["truncated"]),
                    "raw.truncation-required",
                    "true for oversized unknown raw",
                    Some(truncated),
                ));
            }
        }
    } else if event_type == "extension.event" {
        let namespaced = record
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|kind| {
                let segments: Vec<&str> = kind.split('.').collect();
                segments.len() > 1 && segments.iter().all(|segment| !js_trim(segment).is_empty())
            });
        if !namespaced {
            issues.push(issue(
                path_str(&["kind"]),
                "type.namespaced",
                "namespaced string",
                record.get("kind"),
            ));
        }
        match record.get("payload") {
            Some(payload) if is_json_value(payload) => {}
            other => issues.push(issue(
                path_str(&["payload"]),
                "json.invalid",
                "JSON value",
                other,
            )),
        }
        validate_parts(
            record.get("fallback"),
            &path_str(&["fallback"]),
            &mut issues,
        );
    } else if matches!(
        event_type,
        "message.started" | "message.delta" | "message.completed"
    ) {
        if record.get("role").and_then(Value::as_str).is_none() {
            issues.push(issue(
                path_str(&["role"]),
                "type.string",
                "string",
                record.get("role"),
            ));
        }
        if let Some(parts) = record.get("parts") {
            validate_parts(Some(parts), &path_str(&["parts"]), &mut issues);
        }
    } else if event_type == "reasoning.delta" {
        // reasoning.delta 的 parts 校验是无条件的（缺席即 type.array 问题）。
        validate_parts(record.get("parts"), &path_str(&["parts"]), &mut issues);
    } else if is_known_event_type(event_type) {
        // TS：`'parts' in value && value.parts !== undefined` —— JSON 里键存在即
        // 有值（null 也要过 validateParts 报 type.array）。
        if let Some(parts) = record.get("parts") {
            validate_parts(Some(parts), &path_str(&["parts"]), &mut issues);
        }
    } else {
        issues.push(issue(
            path_str(&["type"]),
            "event.unknown-type",
            "known semantic event or event.unknown",
            record.get("type"),
        ));
    }
    if !issues.is_empty() {
        return failure(issues);
    }
    Ok(value.clone())
}

/// TS `parseWorkbenchEnvelope`。
pub fn parse_workbench_envelope(value: &Value) -> SchemaResult<Value> {
    let Some(record) = as_record(value) else {
        return failure(vec![issue(
            Vec::new(),
            "type.object",
            "object",
            Some(value),
        )]);
    };
    let mut issues: Vec<SchemaIssue> = Vec::new();
    let schema_version = record.get("schemaVersion");
    match schema_version.and_then(Value::as_f64) {
        Some(version) if version == CURRENT_SCHEMA_VERSION => {}
        _ => issues.push(issue(
            path_str(&["schemaVersion"]),
            "schema.version",
            "1",
            schema_version,
        )),
    }
    require_string(record, "eventId", &mut issues);
    require_string(record, "sessionId", &mut issues);
    require_positive_integer(record, "sequence", &mut issues);
    require_iso_date(record, "recordedAt", &mut issues);
    if record.contains_key("occurredAt") {
        require_iso_date(record, "occurredAt", &mut issues);
    }
    validate_source(record.get("source"), &mut issues);
    validate_identity(record.get("identity"), &mut issues);
    validate_provenance(record.get("provenance"), &mut issues);
    if let Some(event) = record.get("event") {
        if let Err(event_issues) = parse_semantic_event(event) {
            for mut item in event_issues {
                let mut prefixed = vec![Value::String("event".to_string())];
                prefixed.append(&mut item.path);
                item.path = prefixed;
                issues.push(item);
            }
        }
    } else {
        issues.push(issue(
            path_str(&["event"]),
            "event.type",
            "event object with type",
            None,
        ));
    }
    if let Some(raw) = record.get("raw") {
        if !is_json_value(raw) {
            issues.push(issue(
                path_str(&["raw"]),
                "json.invalid",
                "JSON value",
                Some(raw),
            ));
        }
        let truncated_metadata = record
            .get("rawMetadata")
            .and_then(as_record)
            .and_then(|metadata| metadata.get("truncated"))
            == Some(&Value::Bool(true));
        if is_json_value(raw)
            && json_bytes(raw) > DEFAULT_RAW_MAX_BYTES as usize
            && !truncated_metadata
        {
            issues.push(issue(
                path_str(&["rawMetadata"]),
                "raw.truncation-required",
                "truncation metadata for oversized raw",
                record.get("rawMetadata"),
            ));
        }
    }
    if let Some(raw_metadata) = record.get("rawMetadata") {
        if !raw_metadata.is_null() && !is_valid_raw_metadata(raw_metadata) {
            issues.push(issue(
                path_str(&["rawMetadata"]),
                "shape.truncation",
                "raw metadata",
                Some(raw_metadata),
            ));
        }
    }
    if let Some(coverage) = record.get("coverage") {
        let items = coverage.as_array();
        let valid = items.is_some_and(|items| {
            items.len() == 2
                && items.iter().all(is_safe_integer)
                && number_as_f64(items[0].as_number().expect("safe integer")) >= 1.0
                && number_as_f64(items[0].as_number().expect("safe integer"))
                    <= number_as_f64(items[1].as_number().expect("safe integer"))
        });
        if !valid {
            issues.push(issue(
                path_str(&["coverage"]),
                "shape.coverage",
                "[start, end] safe integers",
                Some(coverage),
            ));
        }
    }
    if !issues.is_empty() {
        return failure(issues);
    }
    Ok(value.clone())
}

/// TS `migrateWorkbenchEnvelope`：version 1 直通；version 0（隐式）semantic 形态补
/// 版本号后解析；canonical 行（owner/sequence/rawPayload/typedPayload）走投影注册
/// 表桥接并标记 migration provenance。
pub fn migrate_workbench_envelope(value: &Value) -> SchemaResult<Value> {
    let Some(record) = as_record(value) else {
        return failure(vec![issue(
            Vec::new(),
            "type.object",
            "object",
            Some(value),
        )]);
    };
    match record.get("schemaVersion") {
        Some(version) if version.as_f64() == Some(CURRENT_SCHEMA_VERSION) => {
            return parse_workbench_envelope(value);
        }
        Some(version) if version.as_f64() != Some(0.0) => {
            return failure(vec![issue(
                path_str(&["schemaVersion"]),
                "schema.unsupported",
                "0 or 1",
                Some(version),
            )]);
        }
        _ => {}
    }
    // Version zero 已用 semantic 形态但没有显式版本号。
    let has_semantic_shape = ["event", "sessionId", "source", "provenance"]
        .iter()
        .all(|key| record.contains_key(*key));
    if has_semantic_shape {
        let mut migrated = record.clone();
        migrated.insert(
            "schemaVersion".to_string(),
            js_number_value(CURRENT_SCHEMA_VERSION),
        );
        return parse_workbench_envelope(&Value::Object(migrated));
    }
    // canonical 行的最小读缝桥：保留 raw 供取证，结果标记 migration。
    let owner = record.get("owner").and_then(as_record);
    let session_id = owner
        .and_then(|owner| owner.get("localSessionId"))
        .and_then(Value::as_str)
        .or_else(|| record.get("sessionId").and_then(Value::as_str));
    let sequence = record.get("sequence").and_then(Value::as_f64);
    let raw_payload = record.get("rawPayload");
    let (Some(session_id), Some(sequence), Some(raw_payload)) = (session_id, sequence, raw_payload)
    else {
        return failure(vec![issue(
            Vec::new(),
            "migration.legacy-shape",
            "version zero semantic or canonical event",
            Some(value),
        )]);
    };
    if !is_json_value(raw_payload) {
        return failure(vec![issue(
            Vec::new(),
            "migration.legacy-shape",
            "version zero semantic or canonical event",
            Some(value),
        )]);
    }
    let event_type = record
        .get("eventType")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let typed = record
        .get("typedPayload")
        .and_then(as_record)
        .map(|typed| Value::Object(typed.clone()))
        .unwrap_or_else(|| json!({}));
    let text = typed.get("text").and_then(Value::as_str);
    let event = migrate_canonical_event(event_type, &typed, text, raw_payload);
    let identity = record
        .get("identity")
        .and_then(as_record)
        .map(|identity| Value::Object(identity.clone()))
        .unwrap_or_else(|| json!({}));
    let explicit_event_id = record
        .get("eventId")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(|id| Value::String(id.to_string()));
    let mut input = Map::new();
    input.insert(
        "sessionId".to_string(),
        Value::String(session_id.to_string()),
    );
    input.insert("sequence".to_string(), js_number_value(sequence));
    input.insert(
        "recordedAt".to_string(),
        Value::String(
            record
                .get("receivedAt")
                .and_then(Value::as_str)
                .unwrap_or("1970-01-01T00:00:00.000Z")
                .to_string(),
        ),
    );
    input.insert(
        "source".to_string(),
        json!({
            "provider": "migration",
            "sourceId": record
                .get("eventId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("{session_id}:{}",
                    js_number_to_string(sequence))),
        }),
    );
    input.insert("identity".to_string(), identity);
    input.insert(
        "provenance".to_string(),
        json!({ "origin": "migration", "trust": "unverified", "provider": "migration" }),
    );
    input.insert("event".to_string(), event);
    input.insert("raw".to_string(), raw_payload.clone());
    if let Some(event_id) = explicit_event_id {
        input.insert("eventId".to_string(), event_id);
    }
    // 先过 createWorkbenchEnvelope（schemaVersion/eventId/raw 记账），再解析。
    parse_workbench_envelope(&create_workbench_envelope(&Value::Object(input)))
}

// ── 原生单测：对齐 `src/domains/workbench/events/__tests__/workbenchEventSchema.test.ts`
//    的投影向量/迁移/id 派生契约 ──
#[cfg(test)]
mod tests {
    use super::*;
    use pylon_canonical_types::CanonicalEventType;

    /// TS「renderer-facing projection vector for every canonical event type」：
    /// 每个词表 canonical 类型都能取到投影，且 fixture 投影出钉死的语义类型。
    #[test]
    fn every_canonical_event_type_has_a_projection_vector() {
        let fixture = |event_type: &str| -> Value {
            match event_type {
                "user.message" => json!({ "text": "question" }),
                "assistant.text.delta" | "assistant.text.delta.batch" => {
                    json!({ "text": "answer" })
                }
                "assistant.thinking.delta" | "assistant.thinking.delta.batch" => {
                    json!({ "text": "thinking" })
                }
                "tool.call.started" => json!({ "tool": { "name": "Read" } }),
                "tool.call.updated" => {
                    json!({ "tool": { "name": "Read" }, "progress": { "percent": 50 } })
                }
                "tool.call.completed" => {
                    json!({ "tool": { "name": "Read" }, "result": { "ok": true } })
                }
                "tool.call.failed" => {
                    json!({ "tool": { "name": "Read" }, "result": { "ok": false } })
                }
                "interaction.requested" => json!({ "interactionId": "ask-1" }),
                "interaction.answered" => {
                    json!({ "interactionId": "ask-1", "response": { "optionId": "allow" } })
                }
                "turn.completed" => {
                    json!({ "stopReason": "end_turn", "usage": { "outputTokens": 2 }, "model": "model-1" })
                }
                "turn.failed" => json!({ "error": "failed", "code": "turn.failed" }),
                "usage.updated" => json!({ "usage": { "inputTokens": 3 } }),
                "plan.replaced" => json!({ "entries": [{ "id": "step-1", "content": "Inspect" }] }),
                "session.mode-updated" => json!({ "mode": "auto" }),
                "session.model-updated" => json!({ "model": "model-1" }),
                "session.config-updated" => {
                    json!({ "options": [{ "id": "reasoning", "value": "high" }] })
                }
                "session.commands-updated" => json!({ "commands": [{ "name": "/compact" }] }),
                "history.snapshot" => json!({ "checkpoint": "replay-1" }),
                "turn.unit" => json!({ "aggregateKind": "turn-rollup" }),
                "unknown" => json!({ "future": true }),
                other => json!({ "fixture": other }),
            }
        };
        let expected = |event_type: &str| -> &'static str {
            match event_type {
                "user.message" | "assistant.text.delta" | "assistant.text.delta.batch" => {
                    "message.delta"
                }
                "assistant.thinking.delta" | "assistant.thinking.delta.batch" => "reasoning.delta",
                "tool.call.started" => "tool.started",
                "tool.call.updated" => "tool.progress",
                "tool.call.completed" => "tool.completed",
                "tool.call.failed" => "tool.failed",
                "interaction.requested" => "interaction.requested",
                "interaction.answered" => "interaction.resolved",
                "turn.completed" => "session.completed",
                "turn.failed" => "diagnostic.notice",
                "usage.updated" => "usage.updated",
                "plan.replaced" => "plan.replaced",
                "history.snapshot" | "turn.unit" | "unknown" => "event.unknown",
                _ => "",
            }
        };
        for event_type in CanonicalEventType::ALL {
            let wire = event_type.as_str();
            let projected = migrate_canonical_event(
                wire,
                &fixture(wire),
                Some("question"),
                &json!({ "eventType": wire, "fixture": true }),
            );
            let expected_type = expected(wire);
            if expected_type.is_empty() {
                assert_eq!(
                    projected.get("type").and_then(Value::as_str),
                    Some(wire),
                    "{wire} 应直通"
                );
            } else {
                assert_eq!(
                    projected.get("type").and_then(Value::as_str),
                    Some(expected_type),
                    "{wire} 语义类型漂移"
                );
            }
        }
    }

    #[test]
    fn migrates_typed_aliases_into_semantic_types() {
        // TS it.each：tool.call.* / assistant.reasoning.delta / turn.completed 等
        // 别名迁移（含不在 canonical 词表内的读缝别名）。
        let cases: [(&str, &str); 12] = [
            ("tool.started", "tool.started"),
            ("tool.call.started", "tool.started"),
            ("tool.call.updated", "tool.progress"),
            ("tool.call.completed", "tool.completed"),
            ("tool.call.failed", "tool.failed"),
            ("assistant.reasoning.delta", "reasoning.delta"),
            ("assistant.thinking.delta", "reasoning.delta"),
            ("plan.replaced", "plan.replaced"),
            ("usage.updated", "usage.updated"),
            ("turn.completed", "session.completed"),
            ("turn.failed", "diagnostic.notice"),
            ("session.completed", "session.completed"),
        ];
        for (event_type, expected) in cases {
            let event = migrate_canonical_event(
                event_type,
                &json!({ "text": "x", "entries": [], "usage": { "input": 1 }, "stopReason": "end" }),
                Some("x"),
                &json!({ "typed": true }),
            );
            assert_eq!(
                event.get("type").and_then(Value::as_str),
                Some(expected),
                "{event_type}"
            );
        }
    }

    #[test]
    fn preserves_additive_completion_fields_and_cancellation_reason() {
        let event = migrate_canonical_event(
            "turn.completed",
            &json!({ "stopReason": "end_turn", "usage": { "inputTokens": 2 }, "model": "hermes-1" }),
            None,
            &json!({}),
        );
        assert_eq!(
            event,
            json!({"type": "session.completed", "stopReason": "end_turn", "usage": {"inputTokens": 2}, "model": "hermes-1"})
        );

        let event = migrate_canonical_event(
            "turn.failed",
            &json!({ "stopReason": "cancelled" }),
            None,
            &json!({}),
        );
        assert_eq!(event.get("type"), Some(&json!("diagnostic.notice")));
        assert_eq!(event.get("code"), Some(&json!("turn.failed")));
        assert_eq!(event.get("level"), Some(&json!("error")));
    }

    #[test]
    fn does_not_synthesize_interaction_identity_and_maps_answered() {
        // 缺 interactionId 的 requested 迁移为 event.unknown（不造身份）。
        let event = migrate_canonical_event(
            "interaction.requested",
            &json!({}),
            None,
            &json!({ "request": true }),
        );
        assert_eq!(event.get("type"), Some(&json!("event.unknown")));
        assert_eq!(
            event.get("summary"),
            Some(&json!(
                "Migrated interaction.requested without interaction id"
            ))
        );
        assert_eq!(event.get("raw"), Some(&json!({ "request": true })));

        // answered → resolved + response。
        let event = migrate_canonical_event(
            "interaction.answered",
            &json!({ "interactionId": "ask-1", "response": { "optionId": "allow" } }),
            None,
            &json!({}),
        );
        assert_eq!(
            event,
            json!({"type": "interaction.resolved", "interactionId": "ask-1", "response": {"optionId": "allow"}})
        );
    }

    #[test]
    fn migrates_lifecycle_and_diagnostic_without_unknown_fallback() {
        for event_type in ["lifecycle.recovered", "diagnostic.notice"] {
            let event = migrate_canonical_event(
                event_type,
                &json!({ "reason": "retry", "level": "info", "message": "ok" }),
                None,
                &json!({}),
            );
            assert_eq!(
                event.get("type").and_then(Value::as_str),
                Some(event_type),
                "{event_type}"
            );
        }
    }

    #[test]
    fn migrates_config_and_command_payloads_onto_session_surfaces() {
        let migrated = migrate_workbench_envelope(&json!({
            "owner": { "localSessionId": "session-1" }, "sequence": 9,
            "eventType": "session.config-updated", "rawPayload": {},
            "typedPayload": { "options": [{ "id": "model", "value": "model-1" }] },
        }))
        .expect("config migrates");
        assert_eq!(
            migrated.get("event"),
            Some(
                &json!({ "type": "session.config-updated", "options": [{ "id": "model", "value": "model-1" }] })
            )
        );
        let migrated = migrate_workbench_envelope(&json!({
            "owner": { "localSessionId": "session-1" }, "sequence": 10,
            "eventType": "session.commands-updated", "rawPayload": {},
            "typedPayload": { "commands": [{ "name": "/compact" }] },
        }))
        .expect("commands migrate");
        assert_eq!(
            migrated.get("event"),
            Some(
                &json!({ "type": "session.commands-updated", "commands": [{ "name": "/compact" }] })
            )
        );
    }

    #[test]
    fn migrates_version_zero_envelope_at_the_read_seam() {
        // version zero semantic 形态（缺显式版本号）→ 补 1 后解析。
        let legacy = json!({
            "schemaVersion": 0,
            "eventId": "wb-legacy-1",
            "sessionId": "session-1",
            "sequence": 1,
            "recordedAt": "2026-08-21T00:00:00.000Z",
            "source": { "provider": "peri", "sourceId": "wire-1" },
            "identity": { "messageId": "message-1" },
            "provenance": { "origin": "local-observed", "trust": "authoritative" },
            "event": { "type": "message.delta", "role": "assistant", "parts": [{ "kind": "text", "text": "hello" }] },
        });
        let migrated = migrate_workbench_envelope(&legacy).expect("migrates");
        assert_eq!(migrated.get("schemaVersion"), Some(&json!(1)));
        // canonical 行形态 → migration provenance 桥接。
        let canonical = json!({
            "owner": { "localSessionId": "session-1" }, "sequence": 2,
            "eventType": "tool.call.completed", "rawPayload": { "typed": true },
            "typedPayload": { "tool": { "toolCallId": "t-1" } },
        });
        let migrated = migrate_workbench_envelope(&canonical).expect("bridges");
        assert_eq!(migrated["provenance"]["origin"], json!("migration"));
        assert_eq!(migrated["event"]["type"], json!("tool.completed"));
        // 行内显式 eventId 保留。
        let mut canonical = canonical.clone();
        canonical["eventId"] = json!("owner#2");
        let migrated = migrate_workbench_envelope(&canonical).expect("bridges");
        assert_eq!(migrated.get("eventId"), Some(&json!("owner#2")));
    }

    #[test]
    fn derives_stable_event_ids_matching_the_ts_fnv1a() {
        // 期望值来自 TS `deriveWorkbenchEventId` 的实跑输出（parity 钉死）。
        let derive = |session_id: &str,
                      sequence: f64,
                      provider: &str,
                      source_id: &str,
                      identity: Value,
                      event: Value|
         -> String {
            derive_workbench_event_id(session_id, sequence, provider, source_id, &identity, &event)
        };
        let first = derive(
            "session-1",
            3.0,
            "peri",
            "wire-1",
            json!({ "messageId": "message-1" }),
            json!({ "type": "message.delta", "role": "assistant", "parts": [] }),
        );
        let second = derive(
            "session-1",
            3.0,
            "peri",
            "wire-1",
            json!({ "messageId": "message-1" }),
            json!({ "type": "message.delta", "role": "assistant", "parts": [] }),
        );
        // 同输入同 id（不取数组位、不取墙钟）。
        assert_eq!(first, second);
        assert!(!first.contains("undefined") && !first.contains("NaN"));
        // 空 identity 退回 { sourceId } 稳定身份。
        let identity_less = derive(
            "session-1",
            3.0,
            "peri",
            "wire-1",
            json!({}),
            json!({ "type": "message.delta", "role": "assistant", "parts": [] }),
        );
        assert_eq!(first, "wb-993fb837");
        assert_eq!(identity_less, "wb-6a16ab6f");
        // 非 ASCII（UTF-16 码元语义）与字符串转义路径。
        let astral = derive(
            "会话-父",
            12.0,
            "hermes",
            "wire-42",
            json!({ "turnId": "turn-α" }),
            json!({ "type": "goal.updated" }),
        );
        assert_eq!(astral, "wb-9411753b");
    }

    #[test]
    fn rejects_invalid_provenance_trust_combinations() {
        let base = |provenance: Value| {
            json!({
                "schemaVersion": 1,
                "eventId": "wb-x",
                "sessionId": "session-1",
                "sequence": 1,
                "recordedAt": "2026-08-21T00:00:00.000Z",
                "source": { "provider": "peri", "sourceId": "wire-1" },
                "identity": { "messageId": "message-1" },
                "provenance": provenance,
                "event": { "type": "message.delta", "role": "assistant", "parts": [] },
            })
        };
        let result = parse_workbench_envelope(&base(
            json!({ "origin": "local-observed", "trust": "unverified" }),
        ));
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .iter()
            .any(|item| item.code == "provenance.trust"));
        let result = parse_workbench_envelope(&base(
            json!({ "origin": "recovery-import", "trust": "authoritative" }),
        ));
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .iter()
            .any(|item| item.code == "provenance.trust"));
    }

    #[test]
    fn adds_truncation_metadata_when_raw_exceeds_the_journal_cap() {
        let created = create_workbench_envelope(&json!({
            "sessionId": "session-1",
            "sequence": 2,
            "recordedAt": "2026-08-21T00:00:00.000Z",
            "source": { "provider": "peri", "sourceId": "wire-1" },
            "provenance": { "origin": "local-observed", "trust": "authoritative" },
            "identity": { "messageId": "message-1" },
            "event": { "type": "message.delta", "role": "assistant", "parts": [{ "kind": "text", "text": "hello" }] },
            "raw": { "payload": "x".repeat(70_000) },
            "rawMaxBytes": 512,
        }));
        assert_eq!(created["rawMetadata"]["truncated"], json!(true));
        assert!(
            created["rawMetadata"]["omittedBytes"]
                .as_f64()
                .expect("bytes")
                > 0.0,
            "omittedBytes 应为正"
        );
        assert!(parse_workbench_envelope(&created).is_ok());
    }

    #[test]
    fn parses_known_and_unknown_events_round_trip() {
        let base = |event: Value| {
            json!({
                "schemaVersion": 1,
                "eventId": "wb-x",
                "sessionId": "session-1",
                "sequence": 1,
                "recordedAt": "2026-08-21T00:00:00.000Z",
                "source": { "provider": "peri", "sourceId": "wire-1" },
                "identity": { "messageId": "message-1" },
                "provenance": { "origin": "local-observed", "trust": "authoritative" },
                "event": event,
            })
        };
        let known = base(
            json!({ "type": "message.delta", "role": "assistant", "parts": [{ "kind": "text", "text": "hello" }] }),
        );
        let parsed = parse_workbench_envelope(&known).expect("known");
        assert_eq!(parsed, known);
        let unknown = base(json!({
            "type": "event.unknown",
            "originalType": "provider.future_event",
            "summary": "future event",
            "raw": { "value": 1 },
            "truncated": false,
        }));
        let parsed = parse_workbench_envelope(&unknown).expect("unknown");
        assert_eq!(parsed, unknown);
        // reasoning.delta 的 parts 无条件校验：缺席即 type.array。
        let missing_parts = base(json!({ "type": "reasoning.delta" }));
        let issues = parse_workbench_envelope(&missing_parts).unwrap_err();
        assert!(issues.iter().any(|item| item.code == "type.array"
            && item.path == vec![Value::String("event".into()), Value::String("parts".into())]));
    }
}
