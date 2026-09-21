//! WP2 补全：C13 生命周期状态机。
//!
//! TS 基线（逐函数对齐）：`src/domains/workbench/lifecycle/lifecycleModel.ts` 的
//! `applyLifecycleEvent`。retry/compact/rewind/suspended 是当前态，history 只追加
//! 不删除（恢复成功不删除历史事实）。
//!
//! 状态以 JSON `Value` 建模：LifecycleState 的字段全部可选且各 phase 携带开放
//! 字段（error 是 NormalizedError，files/messages 是 JsonRecord 数组），Value 建
//! 模与 TS 的字面量构造逐键等价。返回 `None` 对应 TS「返回同一引用」（上游直通）。
//!
//! `normalize_normalized_error` 复用 `workbench` 的既有移植（C13 错误一等契约），
//! 以函数参数注入避免模块环。

use serde_json::{json, Map, Value};

use super::content_part::{js_number_of, js_trim};
use super::workbench::js_number_value;

/// TS `createEmptyLifecycleState`。
pub fn empty_lifecycle_state() -> Value {
    json!({ "history": [] })
}

/// TS `text`：trim 非空即原样返回。
fn text(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|s| !js_trim(s).is_empty())
}

/// TS `num`：number + finite。
fn num(value: Option<&Value>) -> Option<Value> {
    value
        .filter(|v| v.is_number() && js_number_of(v).is_finite())
        .cloned()
}

/// TS `isRecordLike`：JsonRecord 判定（数组与 null 不算）。
fn is_record_like(value: &Value) -> bool {
    value.is_object()
}

/// TS `applyLifecycleEvent`：终态收敛当前态、全部事实进 history（只追加不删除）。
pub fn apply_lifecycle_event(
    state: &Value,
    event: &Value,
    normalize_error: &dyn Fn(&Value) -> Option<Value>,
) -> Option<Value> {
    let event_type = event.get("type").and_then(Value::as_str)?;
    let mut next: Map<String, Value> = state.as_object()?.clone();
    let mut history = state
        .get("history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    match event_type {
        "lifecycle.retrying" => {
            let mut retry = Map::new();
            // attempt 缺失按 0（TS：`num(event.attempt) ?? 0`）。
            retry.insert(
                "attempt".to_string(),
                num(event.get("attempt")).unwrap_or_else(|| js_number_value(0.0)),
            );
            if let Some(max_attempts) = num(event.get("maxAttempts")) {
                retry.insert("maxAttempts".to_string(), max_attempts);
            }
            if let Some(delay_ms) = num(event.get("delayMs")) {
                retry.insert("delayMs".to_string(), delay_ms);
            }
            // error 为 null 时 normalize 返回 None：TS 键带 undefined（结构上缺席）。
            if let Some(error_raw) = event.get("error") {
                if let Some(error) = normalize_error(error_raw) {
                    retry.insert("error".to_string(), error);
                }
            }
            let retry = Value::Object(retry);
            let mut item = Map::new();
            item.insert("kind".to_string(), Value::String("retry".to_string()));
            for (key, value) in retry.as_object().expect("retry") {
                item.insert(key.clone(), value.clone());
            }
            history.push(Value::Object(item));
            next.insert("retry".to_string(), retry);
        }
        "lifecycle.compact-started" | "lifecycle.compact-completed" => {
            let completed = event_type == "lifecycle.compact-completed";
            let previous_compact = state.get("compact");
            let mut compact = Map::new();
            compact.insert(
                "phase".to_string(),
                Value::String(if completed { "completed" } else { "started" }.to_string()),
            );
            // completed 未携带时保留 started 的 strategy/trigger/tokensBefore。
            let carried = |key: &str| -> Option<Value> {
                text(event.get(key))
                    .map(|s| Value::String(s.to_string()))
                    .or_else(|| {
                        previous_compact
                            .and_then(|c| c.get(key))
                            .and_then(|value| text(Some(value)))
                            .map(|s| Value::String(s.to_string()))
                    })
            };
            if let Some(strategy) = carried("strategy") {
                compact.insert("strategy".to_string(), strategy);
            }
            if let Some(trigger) = carried("trigger") {
                compact.insert("trigger".to_string(), trigger);
            }
            match num(event.get("tokensBefore")) {
                Some(value) => {
                    compact.insert("tokensBefore".to_string(), value);
                }
                None => {
                    if let Some(value) = previous_compact.and_then(|c| c.get("tokensBefore")) {
                        compact.insert("tokensBefore".to_string(), value.clone());
                    }
                }
            }
            if let Some(value) = num(event.get("tokensAfter")) {
                compact.insert("tokensAfter".to_string(), value);
            }
            if let Some(summary) = text(event.get("summary")) {
                compact.insert("summary".to_string(), Value::String(summary.to_string()));
            }
            let compact = Value::Object(compact);
            let mut item = Map::new();
            item.insert("kind".to_string(), Value::String("compact".to_string()));
            for (key, value) in compact.as_object().expect("compact") {
                item.insert(key.clone(), value.clone());
            }
            history.push(Value::Object(item));
            next.insert("compact".to_string(), compact);
        }
        "lifecycle.rewind-preview" | "lifecycle.rewind-completed" => {
            let previous_rewind = state.get("rewind");
            let mut rewind = Map::new();
            rewind.insert(
                "phase".to_string(),
                Value::String(
                    if event_type == "lifecycle.rewind-completed" {
                        "completed"
                    } else {
                        "preview"
                    }
                    .to_string(),
                ),
            );
            let carried_records = |key: &str| -> Option<Value> {
                match event.get(key) {
                    Some(value) if value.is_array() => Some(Value::Array(
                        value
                            .as_array()
                            .expect("checked array")
                            .iter()
                            .filter(|item| is_record_like(item))
                            .cloned()
                            .collect(),
                    )),
                    _ => previous_rewind
                        .and_then(|r| r.get(key))
                        .filter(|value| !value.is_null())
                        .cloned(),
                }
            };
            if let Some(files) = carried_records("files") {
                rewind.insert("files".to_string(), files);
            }
            if let Some(messages) = carried_records("messages") {
                rewind.insert("messages".to_string(), messages);
            }
            if let Some(summary) = text(event.get("summary")) {
                rewind.insert("summary".to_string(), Value::String(summary.to_string()));
            }
            let rewind = Value::Object(rewind);
            let mut item = Map::new();
            item.insert("kind".to_string(), Value::String("rewind".to_string()));
            for (key, value) in rewind.as_object().expect("rewind") {
                item.insert(key.clone(), value.clone());
            }
            history.push(Value::Object(item));
            next.insert("rewind".to_string(), rewind);
        }
        "lifecycle.suspended" => {
            let mut suspended = Map::new();
            if let Some(reason) = text(event.get("reason")) {
                suspended.insert("reason".to_string(), Value::String(reason.to_string()));
            }
            let suspended = Value::Object(suspended);
            let mut item = Map::new();
            item.insert("kind".to_string(), Value::String("suspended".to_string()));
            if let Some(reason) = suspended.get("reason") {
                item.insert("reason".to_string(), reason.clone());
            }
            history.push(Value::Object(item));
            next.insert("suspended".to_string(), suspended);
        }
        "lifecycle.recovered" => {
            let source = if event.get("source").and_then(Value::as_str) == Some("agent-import") {
                "agent-import"
            } else {
                "canonical"
            };
            let mut last_recovery = Map::new();
            last_recovery.insert("source".to_string(), Value::String(source.to_string()));
            if let Some(imported_events) = num(event.get("importedEvents")) {
                last_recovery.insert("importedEvents".to_string(), imported_events);
            }
            let last_recovery = Value::Object(last_recovery);
            // recovered 终态：收敛 retry/suspend 当前态；history 不删除。
            let mut item = Map::new();
            item.insert("kind".to_string(), Value::String("recovered".to_string()));
            item.insert("source".to_string(), Value::String(source.to_string()));
            if let Some(imported_events) = last_recovery.get("importedEvents") {
                item.insert("importedEvents".to_string(), imported_events.clone());
            }
            history.push(Value::Object(item));
            next.remove("retry");
            next.remove("suspended");
            next.insert("lastRecovery".to_string(), last_recovery);
        }
        _ => return None,
    }
    next.insert("history".to_string(), Value::Array(history));
    Some(Value::Object(next))
}
