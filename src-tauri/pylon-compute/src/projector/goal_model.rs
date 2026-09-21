//! WP2 补全：C08 Todo / Plan / Goal 统一语义模型。
//!
//! TS 基线（逐函数对齐）：`src/domains/workbench/plan/goalModel.ts` 的
//! `normalizePlanStatus` / `normalizePlanEntries` / `applyPlanEvent` /
//! `normalizeGoalSnapshot` / `applyGoalEvents`。
//!
//! 状态与条目以 JSON `Value` 建模：PlanEntryV2 / GoalSnapshot 的字段集开放
//! （未知 provider 字段必须进 metadata 可见，K14），Value 建模保证未知字段
//! 不在归一化层被静默丢弃。深等判据对应 TS 的 `entriesEqual` / `goalsEqual`
//! —— metadata / accounting 以 Value 深等近似 TS 的 `JSON.stringify` 等值
//! （两侧都是同一归一化器的产物，内容相等即判等成立；键序差异不参与）。
//!
//! 返回值约定：`apply_*` 返回 `Option<Value>`——`None` 对应 TS「返回同一引用」
//! （revision 不变、上游直通），`Some` 为新状态。

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::content_part::{as_record, js_trim};
use super::workbench::js_number_value;

/// TS `PLAN_ENTRY_STATUSES`（unknown 是收窄兜底态，不属 wire 词表）。
pub const PLAN_ENTRY_STATUSES: [&str; 5] = [
    "pending",
    "in_progress",
    "completed",
    "cancelled",
    "blocked",
];

/// TS `GOAL_STATUSES`（unknown 是收窄兜底态）。
pub const GOAL_STATUSES: [&str; 3] = ["active", "complete", "blocked"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedStatus {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_status: Option<String>,
}

/// provider 状态拼写 → 五状态别名表（声明序即 TS STATUS_ALIASES 的语义全集）。
fn status_alias(normalized: &str) -> Option<&'static str> {
    match normalized {
        "pending" | "todo" | "queued" => Some("pending"),
        "in_progress" | "inprogress" | "in-progress" | "running" => Some("in_progress"),
        "completed" | "complete" | "done" => Some("completed"),
        "cancelled" | "canceled" | "killed" | "abandoned" => Some("cancelled"),
        "blocked" => Some("blocked"),
        _ => None,
    }
}

fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|s| !js_trim(s).is_empty())
}

/// TS `normalizePlanStatus`：未知拼写保留原文进 rawStatus；已归一化的 unknown
/// 输入若自带 rawStatus 由 normalize_plan_entries 原样保留（不在此处理）。
pub fn normalize_plan_status(raw_status: Option<&Value>) -> NormalizedStatus {
    let Some(raw) = text(raw_status) else {
        return NormalizedStatus {
            status: "pending".to_string(),
            raw_status: None,
        };
    };
    let trimmed = js_trim(raw);
    if trimmed == "unknown" {
        return NormalizedStatus {
            status: "unknown".to_string(),
            raw_status: None,
        };
    }
    match status_alias(&trimmed.to_lowercase()) {
        Some(mapped) => {
            if mapped == trimmed {
                NormalizedStatus {
                    status: mapped.to_string(),
                    raw_status: None,
                }
            } else {
                // 变体拼写：canonical 进 status，原文进 rawStatus。
                NormalizedStatus {
                    status: mapped.to_string(),
                    raw_status: Some(raw.to_string()),
                }
            }
        }
        None => NormalizedStatus {
            status: "unknown".to_string(),
            raw_status: Some(trimmed.to_string()),
        },
    }
}

const PLAN_ENTRY_KNOWN_KEYS: [&str; 12] = [
    "id",
    "itemId",
    "content",
    "title",
    "text",
    "status",
    "rawStatus",
    "activeForm",
    "priority",
    "blockedReason",
    "blocked_reason",
    "metadata",
];

/// TS `normalizePlanEntries`：wire entries → PlanEntryV2[]。id 缺失按 content 派生
/// 稳定身份；非 object / 缺 content 条目按契约丢弃（与 P1-01 一致）。
pub fn normalize_plan_entries(raw: Option<&Value>) -> Vec<Value> {
    let Some(items) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut entries: Vec<Value> = Vec::new();
    for item in items {
        let Some(record) = as_record(item) else {
            continue;
        };
        let content = text(record.get("content"))
            .or_else(|| text(record.get("title")))
            .or_else(|| text(record.get("text")));
        let Some(content) = content else {
            continue;
        };
        let content = content.to_string();
        let id = text(record.get("id"))
            .or_else(|| text(record.get("itemId")))
            .map(str::to_string)
            .unwrap_or_else(|| content.clone());
        // 已归一化的 unknown 条目回读：status='unknown' + rawStatus 字符串 → 保留原文。
        let legacy_raw_status = match (record.get("rawStatus"), record.get("status")) {
            (Some(Value::String(raw)), Some(Value::String(status))) if status == "unknown" => {
                Some(raw.clone())
            }
            _ => None,
        };
        let status_info = normalize_plan_status(record.get("status"));
        let mut metadata: Map<String, Value> = match record.get("metadata").and_then(as_record) {
            Some(record) => record.clone(),
            None => Map::new(),
        };
        if let Some(metadata_raw) = record.get("metadata") {
            if !metadata_raw.is_object() {
                metadata.insert("metadata".to_string(), metadata_raw.clone());
            }
        }
        // JSON 对象里所有键都有值（undefined 不可表达），未知键全量进 metadata。
        for (key, value) in record {
            if !PLAN_ENTRY_KNOWN_KEYS.contains(&key.as_str()) {
                metadata.insert(key.clone(), value.clone());
            }
        }
        let mut entry = Map::new();
        entry.insert("id".to_string(), Value::String(id));
        entry.insert("content".to_string(), Value::String(content));
        entry.insert(
            "status".to_string(),
            Value::String(status_info.status.clone()),
        );
        let raw_status = status_info.raw_status.or(legacy_raw_status);
        if let Some(raw_status) = raw_status {
            entry.insert("rawStatus".to_string(), Value::String(raw_status));
        }
        if let Some(active_form) = text(record.get("activeForm")) {
            entry.insert(
                "activeForm".to_string(),
                Value::String(active_form.to_string()),
            );
        }
        match record.get("priority") {
            Some(value @ Value::Number(_)) => {
                entry.insert("priority".to_string(), value.clone());
            }
            // 空串不是有效 priority（TS：`item.priority !== ''`）。
            Some(value @ Value::String(s)) if !s.is_empty() => {
                entry.insert("priority".to_string(), value.clone());
            }
            _ => {}
        }
        if let Some(blocked) = text(record.get("blockedReason")) {
            entry.insert(
                "blockedReason".to_string(),
                Value::String(blocked.to_string()),
            );
        }
        // TS 的展开顺序：blocked_reason 覆盖先前的 blockedReason。
        if let Some(blocked) = text(record.get("blocked_reason")) {
            entry.insert(
                "blockedReason".to_string(),
                Value::String(blocked.to_string()),
            );
        }
        if !metadata.is_empty() {
            entry.insert("metadata".to_string(), Value::Object(metadata));
        }
        entries.push(Value::Object(entry));
    }
    entries
}

/// TS `entriesEqual`：身份 + 内容 + 状态 + 展示字段 + metadata 深等。
fn entries_equal(left: &Value, right: &Value) -> bool {
    let field = |key: &str| left.get(key) == right.get(key);
    field("id")
        && field("content")
        && field("status")
        && field("activeForm")
        && field("priority")
        && field("blockedReason")
        && field("rawStatus")
        && left.get("metadata").cloned().unwrap_or(Value::Null)
            == right.get("metadata").cloned().unwrap_or(Value::Null)
}

/// TS `createEmptyPlanState`。
pub fn empty_plan_state(session_id: &str) -> Value {
    json!({ "sessionId": session_id, "revision": 0, "entries": [] })
}

/// TS `createEmptyGoalState`。
pub fn empty_goal_state() -> Value {
    json!({})
}

/// TS `applyPlanEvent`：
/// - replaced = 全量快照替换（保持 provider 顺序）；深等返回同一引用（终态幂等）；
/// - entry-updated = 按 stable id patch；目标不存在时以 patch 为种子追加（parent-late 容忍）。
pub fn apply_plan_event(state: &Value, event: &Value) -> Option<Value> {
    let event_type = event.get("type").and_then(Value::as_str)?;
    let session_id = state.get("sessionId").cloned().unwrap_or(Value::Null);
    let revision = state.get("revision").and_then(Value::as_f64).unwrap_or(0.0);
    let entries_of = |state: &Value| -> Vec<Value> {
        state
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    if event_type == "plan.replaced" {
        let entries = normalize_plan_entries(event.get("entries"));
        let current = entries_of(state);
        let unchanged = current.len() == entries.len()
            && current
                .iter()
                .zip(entries.iter())
                .all(|(left, right)| entries_equal(left, right));
        if unchanged {
            return None;
        }
        return Some(json!({
            "sessionId": session_id,
            "revision": js_number_value(revision + 1.0),
            "entries": entries,
        }));
    }
    if event_type == "plan.entry-updated" {
        let entry = event.get("entry").filter(|entry| entry.is_object())?;
        let patch = normalize_plan_entries(Some(&Value::Array(vec![entry.clone()])))
            .into_iter()
            .next()?;
        // patch 无显式 id 时按 content 兜底定位（与 normalizePlanEntries 派生一致）。
        let has_explicit_id = entry.get("id").is_some_and(Value::is_string)
            || entry.get("itemId").is_some_and(Value::is_string);
        let entries = entries_of(state);
        let index = entries.iter().position(|existing| {
            existing.get("id") == patch.get("id")
                || (!has_explicit_id && existing.get("content") == patch.get("content"))
        });
        let index = match index {
            Some(index) => index,
            None => {
                let mut next = entries;
                next.push(patch);
                return Some(json!({
                    "sessionId": session_id,
                    "revision": js_number_value(revision + 1.0),
                    "entries": next,
                }));
            }
        };
        // `{ ...previous, ...patch, metadata: { ...previous.metadata, ...patch.metadata } }`。
        let mut merged: Map<String, Value> = entries[index].as_object().expect("entry").clone();
        for (key, value) in patch.as_object().expect("patch") {
            merged.insert(key.clone(), value.clone());
        }
        if let Some(patch_metadata) = patch.get("metadata") {
            let mut combined: Map<String, Value> = entries[index]
                .get("metadata")
                .and_then(as_record)
                .cloned()
                .unwrap_or_default();
            for (key, value) in patch_metadata.as_object().expect("metadata") {
                combined.insert(key.clone(), value.clone());
            }
            merged.insert("metadata".to_string(), Value::Object(combined));
        }
        let merged = Value::Object(merged);
        if entries_equal(&entries[index], &merged) {
            return None;
        }
        let mut next = entries;
        next[index] = merged;
        return Some(json!({
            "sessionId": session_id,
            "revision": js_number_value(revision + 1.0),
            "entries": next,
        }));
    }
    None
}

const GOAL_KNOWN_KEYS: [&str; 13] = [
    "goalId",
    "goal_id",
    "id",
    "objective",
    "status",
    "tokenBudget",
    "token_budget",
    "tokensUsed",
    "tokens_used",
    "blockedReason",
    "blocked_reason",
    "accounting",
    "metadata",
];

const ACCOUNTING_KNOWN_KEYS: [&str; 5] = [
    "tokensUsed",
    "tokens_used",
    "timeUsedSeconds",
    "time_used_seconds",
    "metadata",
];

/// TS `normalizeGoalSnapshot`：已知字段收窄，未知字段进 metadata；accounting 单独收窄。
pub fn normalize_goal_snapshot(raw: &Value) -> Option<Value> {
    let record = as_record(raw)?;
    let raw_status = record
        .get("status")
        .and_then(Value::as_str)
        .map(|s| js_trim(s).to_lowercase());
    let status: String = match raw_status.as_deref() {
        Some(raw_status) => {
            if GOAL_STATUSES.contains(&raw_status) {
                raw_status.to_string()
            } else {
                "unknown".to_string()
            }
        }
        None => "unknown".to_string(),
    };
    let mut metadata: Map<String, Value> = match record.get("metadata").and_then(as_record) {
        Some(record) => record.clone(),
        None => Map::new(),
    };
    if let Some(metadata_raw) = record.get("metadata") {
        if !metadata_raw.is_object() {
            metadata.insert("metadata".to_string(), metadata_raw.clone());
        }
    }
    for (key, value) in record {
        if !GOAL_KNOWN_KEYS.contains(&key.as_str()) {
            metadata.insert(key.clone(), value.clone());
        }
    }
    let accounting_raw = record.get("accounting");
    let mut accounting: Option<Map<String, Value>> = None;
    if let Some(accounting_raw) = accounting_raw.filter(|value| value.is_object()) {
        let accounting_record = accounting_raw.as_object().expect("checked");
        let mut accounting_metadata: Map<String, Value> =
            match accounting_record.get("metadata").and_then(as_record) {
                Some(record) => record.clone(),
                None => Map::new(),
            };
        if let Some(metadata_raw) = accounting_record.get("metadata") {
            if !metadata_raw.is_object() {
                accounting_metadata.insert("metadata".to_string(), metadata_raw.clone());
            }
        }
        for (key, value) in accounting_record {
            if !ACCOUNTING_KNOWN_KEYS.contains(&key.as_str()) {
                accounting_metadata.insert(key.clone(), value.clone());
            }
        }
        let mut collected = Map::new();
        let tokens_used = accounting_record
            .get("tokensUsed")
            .filter(|v| v.is_number())
            .or_else(|| {
                accounting_record
                    .get("tokens_used")
                    .filter(|v| v.is_number())
            });
        if let Some(value) = tokens_used {
            collected.insert("tokensUsed".to_string(), value.clone());
        }
        let time_used = accounting_record
            .get("timeUsedSeconds")
            .filter(|v| v.is_number())
            .or_else(|| {
                accounting_record
                    .get("time_used_seconds")
                    .filter(|v| v.is_number())
            });
        if let Some(value) = time_used {
            collected.insert("timeUsedSeconds".to_string(), value.clone());
        }
        if !accounting_metadata.is_empty() {
            collected.insert("metadata".to_string(), Value::Object(accounting_metadata));
        }
        if !collected.is_empty() {
            accounting = Some(collected);
        }
    } else if let Some(accounting_raw) = accounting_raw {
        // 非 object accounting 不静默丢弃。
        metadata.insert("accounting".to_string(), accounting_raw.clone());
    }
    let goal_id = text(record.get("goalId"))
        .or_else(|| text(record.get("goal_id")))
        .or_else(|| text(record.get("id")));
    let mut snapshot = Map::new();
    if let Some(goal_id) = goal_id {
        snapshot.insert("goalId".to_string(), Value::String(goal_id.to_string()));
    }
    if let Some(objective) = text(record.get("objective")) {
        snapshot.insert(
            "objective".to_string(),
            Value::String(objective.to_string()),
        );
    }
    snapshot.insert("status".to_string(), Value::String(status));
    if let Some(value) = record.get("tokenBudget").filter(|v| v.is_number()) {
        snapshot.insert("tokenBudget".to_string(), value.clone());
    } else if let Some(value) = record.get("token_budget").filter(|v| v.is_number()) {
        snapshot.insert("tokenBudget".to_string(), value.clone());
    }
    if let Some(value) = record.get("tokensUsed").filter(|v| v.is_number()) {
        snapshot.insert("tokensUsed".to_string(), value.clone());
    } else if let Some(value) = record.get("tokens_used").filter(|v| v.is_number()) {
        snapshot.insert("tokensUsed".to_string(), value.clone());
    }
    let blocked = text(record.get("blockedReason")).or_else(|| text(record.get("blocked_reason")));
    if let Some(blocked) = blocked {
        snapshot.insert(
            "blockedReason".to_string(),
            Value::String(blocked.to_string()),
        );
    }
    if let Some(accounting) = accounting {
        snapshot.insert("accounting".to_string(), Value::Object(accounting));
    }
    if !metadata.is_empty() {
        snapshot.insert("metadata".to_string(), Value::Object(metadata));
    }
    Some(Value::Object(snapshot))
}

/// TS `goalsEqual`：结构化字段 + accounting/metadata 深等。
fn goals_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            let field = |key: &str| left.get(key) == right.get(key);
            field("goalId")
                && field("objective")
                && field("status")
                && field("tokenBudget")
                && field("tokensUsed")
                && field("blockedReason")
                && left.get("accounting").cloned().unwrap_or(Value::Null)
                    == right.get("accounting").cloned().unwrap_or(Value::Null)
                && left.get("metadata").cloned().unwrap_or(Value::Null)
                    == right.get("metadata").cloned().unwrap_or(Value::Null)
        }
        _ => false,
    }
}

/// TS `applyGoalEvents`：updated = merge（partial 快照保活），cleared = 显式清除。
pub fn apply_goal_events(state: &Value, event: &Value) -> Option<Value> {
    let event_type = event.get("type").and_then(Value::as_str)?;
    if event_type == "goal.updated" {
        let incoming = normalize_goal_snapshot(event.get("goal")?)?;
        let previous = state.get("current").filter(|value| !value.is_null());
        if let (Some(previous_goal_id), Some(incoming_goal_id)) = (
            previous.and_then(|p| text(p.get("goalId"))),
            text(incoming.get("goalId")),
        ) {
            if previous_goal_id != incoming_goal_id {
                // 新 goal id = UPSERT 新目标（Peri set_goal 语义）。
                return Some(json!({ "current": incoming }));
            }
        }
        let mut merged: Map<String, Value> =
            previous.and_then(as_record).cloned().unwrap_or_default();
        for (key, value) in incoming.as_object().expect("incoming") {
            merged.insert(key.clone(), value.clone());
        }
        // accounting 逐层合并（metadata 深合并），incoming 缺失时保留 previous。
        if let Some(incoming_accounting) = incoming.get("accounting") {
            let mut combined: Map<String, Value> = previous
                .and_then(|p| p.get("accounting"))
                .and_then(as_record)
                .cloned()
                .unwrap_or_default();
            for (key, value) in incoming_accounting.as_object().expect("accounting") {
                combined.insert(key.clone(), value.clone());
            }
            if let Some(incoming_metadata) = incoming_accounting.get("metadata") {
                let mut metadata: Map<String, Value> = previous
                    .and_then(|p| p.get("accounting"))
                    .and_then(|a| a.get("metadata"))
                    .and_then(as_record)
                    .cloned()
                    .unwrap_or_default();
                for (key, value) in incoming_metadata.as_object().expect("metadata") {
                    metadata.insert(key.clone(), value.clone());
                }
                combined.insert("metadata".to_string(), Value::Object(metadata));
            }
            merged.insert("accounting".to_string(), Value::Object(combined));
        } else if let Some(previous_accounting) = previous.and_then(|p| p.get("accounting")) {
            merged.insert("accounting".to_string(), previous_accounting.clone());
        }
        // incoming 不带 metadata 时 previous.metadata 保活。
        if !incoming
            .as_object()
            .expect("incoming")
            .contains_key("metadata")
        {
            if let Some(previous_metadata) = previous.and_then(|p| p.get("metadata")) {
                merged.insert("metadata".to_string(), previous_metadata.clone());
            }
        }
        let merged = Value::Object(merged);
        if goals_equal(previous, Some(&merged)) {
            return None;
        }
        return Some(json!({ "current": merged }));
    }
    if event_type == "goal.cleared" {
        let current = state.get("current").filter(|value| !value.is_null())?;
        // TS `event.goalId && state.current.goalId`：JS truthy（非空串即可，不 trim）。
        // current 侧来自归一化快照，goalId 不会是纯空白串，两种判法等价。
        let event_goal_id = event
            .get("goalId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        let current_goal_id = current
            .get("goalId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty());
        // goalId 指向别的 goal 时不是清除指令。
        if let (Some(event_goal_id), Some(current_goal_id)) = (event_goal_id, current_goal_id) {
            if event_goal_id != current_goal_id {
                return None;
            }
        }
        // TS 返回 `{ current: undefined }`；JSON 语义下等价空对象。
        return Some(json!({}));
    }
    None
}
