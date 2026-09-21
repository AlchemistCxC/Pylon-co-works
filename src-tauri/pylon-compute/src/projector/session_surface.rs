//! WP2 补全：sessionSurface 归一化（usage/budget/commands/options）。
//!
//! TS 基线（逐函数对齐，不是重新设计）：
//! - `src/domains/workbench/session/sessionSurface.ts` 的 `normalizeUsageSnapshot` /
//!   `normalizeBudgetSnapshot` / `normalizeSessionCommands` / `normalizeSessionConfigOptions`
//! - `src/infrastructure/acp/chatContracts.ts` 的 wire extract 家族
//!   （`extractWireString` / `extractConfigOptionId` / `extractConfigOptionValue` /
//!   `extractConfigOptionChoices` / `extractChoiceId` / `extractChoiceLabel`）
//!
//! 全部以 JSON `Value` 进出：usage / commands / options 的形态是「结构化首字段 +
//! raw 宽容保留」，字段集开放（provider 会加字段），用 Value 建模才不会在归一化层
//! 静默丢弃未知字段（K14）。
//!
//! 已知语义缺口（与 TS 基线的对照）：
//! - `Object.entries` 按插入序遍历；serde_json Map（无 preserve_order 特性）按字典序。
//!   仅当同一对象里有两个规范化后同名的键（如 `value` 与 `Value`）时取值可能不同，
//!   wire 契约里不出现该形态。

use serde_json::{json, Map, Value};

use super::content_part::{as_record, js_number_of, js_trim};
use super::workbench::js_number_value;

/// chatContracts `DEFAULT_VALUE_KEYS`：机器 id 键序（显示名 name/label 刻意殿后）。
const DEFAULT_VALUE_KEYS: [&str; 15] = [
    "valueId",
    "value_id",
    "modelId",
    "model_id",
    "modeId",
    "mode_id",
    "id",
    "key",
    "value",
    "currentValue",
    "current_value",
    "current",
    "selected",
    "selectedValue",
    "selected_value",
];

/// TS `normalizedWireKey`：camelCase → snake_case、`-`/空白折叠成 `_`、小写化。
/// JS 正则 `[a-z][A-Z]` 是 ASCII 判定，这里逐字符对齐。
fn normalized_wire_key(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    let mut cased = String::with_capacity(key.len() + 4);
    for (index, ch) in chars.iter().enumerate() {
        if index > 0 && ch.is_ascii_uppercase() && chars[index - 1].is_ascii_lowercase() {
            cased.push('_');
        }
        cased.push(*ch);
    }
    let mut out = String::with_capacity(cased.len());
    let mut in_run = false;
    for ch in cased.chars() {
        if ch == '-' || ch.is_whitespace() {
            // `[-\s]+` 折叠为单个 `_`。
            if !in_run {
                out.push('_');
                in_run = true;
            }
        } else {
            out.push(ch);
            in_run = false;
        }
    }
    out.to_lowercase()
}

/// chatContracts `readWireField`：按 camelCase/snake_case/kebab-case/大小写变体读字段。
fn read_wire_field<'a>(record: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    let wanted: std::collections::HashSet<String> =
        keys.iter().map(|key| normalized_wire_key(key)).collect();
    record
        .iter()
        .find(|(key, _)| wanted.contains(&normalized_wire_key(key)))
        .map(|(_, value)| value)
}

/// chatContracts `extractWireString`：机器可读字符串提取；稳定 id 恒优先于显示名。
pub fn extract_wire_string(value: &Value, preferred_keys: &[&str], depth: usize) -> Option<String> {
    if depth > 8 {
        return None;
    }
    if let Some(text) = value.as_str() {
        // TS：`const trimmed = value.trim(); return trimmed || undefined` —— 返回原串。
        let trimmed = js_trim(text);
        return if trimmed.is_empty() {
            None
        } else {
            Some(text.to_string())
        };
    }
    let record = as_record(value)?;
    let mut visited = std::collections::HashSet::new();
    for key in preferred_keys.iter().chain(DEFAULT_VALUE_KEYS.iter()) {
        let normalized = normalized_wire_key(key);
        if !visited.insert(normalized) {
            continue;
        }
        let nested = match read_wire_field(record, &[key]) {
            Some(nested) => nested,
            None => continue,
        };
        // TS 的 `nested === value` 是引用相等的自引用保护；JSON 树无环，值相等即
        // 不可能嵌回自身，等价。
        if nested == value {
            continue;
        }
        if let Some(result) = extract_wire_string(nested, preferred_keys, depth + 1) {
            return Some(result);
        }
    }
    None
}

/// chatContracts `extractConfigOptionId`（含 ACP v1.4 别名）。
pub fn extract_config_option_id(option: &Value) -> Option<String> {
    extract_wire_string(
        option,
        &[
            "configId",
            "config_id",
            "optionId",
            "option_id",
            "id",
            "key",
            "name",
        ],
        0,
    )
}

/// chatContracts `unwrapWireValue`：剥 value/valueId 等信封。
fn unwrap_wire_value(value: &Value, depth: usize) -> Value {
    if depth > 8 {
        return value.clone();
    }
    let record = match as_record(value) {
        Some(record) => record,
        None => return value.clone(),
    };
    for key in [
        "valueId", "value_id", "modelId", "model_id", "modeId", "mode_id", "id", "key", "value",
    ] {
        if let Some(nested) = read_wire_field(record, &[key]) {
            if nested != value {
                return unwrap_wire_value(nested, depth + 1);
            }
        }
    }
    value.clone()
}

/// chatContracts `extractConfigOptionValue`：选中值解包。`Some(Value::Null)` 与
/// `None`（未声明）严格区分——TS 侧分别是 `null` 与 `undefined`。
pub fn extract_config_option_value(option: &Value) -> Option<Value> {
    let record = as_record(option)?;
    for key in [
        "currentValue",
        "current_value",
        "selectedValue",
        "selected_value",
        "selected",
        "value",
        "current",
        "defaultValue",
        "default_value",
    ] {
        match read_wire_field(record, &[key]) {
            Some(raw) => return Some(unwrap_wire_value(raw, 0)),
            None => continue,
        }
    }
    None
}

/// chatContracts `extractConfigOptionChoices`：options/choices/schema/enum 变体全收。
/// `seen` 对应 TS 的引用去重集；以节点地址近似（读路径无 mutation，地址稳定）。
pub fn extract_config_option_choices(option: &Value) -> Vec<Value> {
    let record = match as_record(option) {
        Some(record) => record.clone(),
        None => return Vec::new(),
    };
    let mut found: Vec<Value> = Vec::new();
    let mut seen: Vec<usize> = Vec::new();
    fn collect(value: &Value, depth: usize, found: &mut Vec<Value>, seen: &mut Vec<usize>) {
        if depth > 5 {
            return;
        }
        let id = value as *const Value as usize;
        if seen.contains(&id) {
            return;
        }
        seen.push(id);
        if let Some(items) = value.as_array() {
            found.extend(items.iter().cloned());
            return;
        }
        let nested = match as_record(value) {
            Some(nested) => nested,
            None => return,
        };
        for key in [
            "options",
            "choices",
            "values",
            "available",
            "items",
            "enum",
            "schema",
        ] {
            if let Some(child) = read_wire_field(nested, &[key]) {
                collect(child, depth + 1, found, seen);
            }
        }
    }
    for key in [
        "options",
        "choices",
        "values",
        "available",
        "items",
        "schema",
    ] {
        if let Some(value) = read_wire_field(&record, &[key]) {
            collect(value, 0, &mut found, &mut seen);
        }
    }
    found
}

/// chatContracts `extractChoiceId`：model/mode choice 的机器 id 键序优先。
pub fn extract_choice_id(value: &Value, kind: Option<&str>) -> Option<String> {
    let preferred: &[&str] = match kind {
        Some("model") => &[
            "modelId", "model_id", "id", "valueId", "value_id", "key", "value", "name", "label",
        ],
        Some("mode") => &[
            "modeId", "mode_id", "id", "valueId", "value_id", "key", "value", "name", "label",
        ],
        _ => &DEFAULT_VALUE_KEYS,
    };
    extract_wire_string(value, preferred, 0)
}

/// chatContracts `extractChoiceLabel`：展示标签；机器 id 上 wire，标签只做显示。
pub fn extract_choice_label(value: &Value, fallback: Option<&str>) -> Option<String> {
    if let Some(record) = as_record(value) {
        for key in [
            "label",
            "title",
            "displayName",
            "display_name",
            "name",
            "description",
        ] {
            if let Some(field) = read_wire_field(record, &[key]) {
                if let Some(candidate) = extract_wire_string(field, &[], 0) {
                    return Some(candidate);
                }
            }
        }
    }
    fallback
        .map(str::to_string)
        .or_else(|| extract_choice_id(value, None))
}

// ── sessionSurface 归一化 ────────────────────────────────────────────────────

/// TS `stringField`：trim 非空即原样返回。
fn string_field(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|s| !js_trim(s).is_empty())
}

/// TS `finiteNonNegative`：number + finite + >= 0。返回克隆保 int/f64 形态。
fn finite_non_negative(value: Option<&Value>) -> Option<Value> {
    value
        .filter(|v| v.is_number() && js_number_of(v).is_finite() && js_number_of(v) >= 0.0)
        .cloned()
}

/// TS `withoutKeys`：剔除键集后的剩余对象。
fn without_keys(value: &Map<String, Value>, keys: &[&str]) -> Map<String, Value> {
    let omitted: std::collections::HashSet<&str> = keys.iter().copied().collect();
    value
        .iter()
        .filter(|(key, _)| !omitted.contains(key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect()
}

/// TS `optionalRaw`：空对象不保留（undefined 语义）。
fn optional_raw(raw: Map<String, Value>) -> Option<Value> {
    if raw.is_empty() {
        None
    } else {
        Some(Value::Object(raw))
    }
}

pub struct NormalizedUsage {
    pub value: Value,
    pub invalid_fields: Vec<String>,
}

const USAGE_NUMERIC_FIELDS: [&str; 11] = [
    "inputTokens",
    "outputTokens",
    "reasoningTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "contextUsed",
    "contextLimit",
    "contextPercent",
    "calls",
    "costUsd",
];

/// TS `normalizeUsageSnapshot`：合法数值字段升为一等字段，非法/未知叶子进 raw 留审计；
/// contextPercent 在计数器变化时重算（显式 provider 权威值优先）。
pub fn normalize_usage_snapshot(
    value: Option<&Value>,
    previous: Option<&Value>,
) -> NormalizedUsage {
    let record = match value
        .filter(|v| v.is_object())
        .map(|v| v.as_object().expect("checked is_object"))
    {
        Some(record) => record,
        None => {
            return NormalizedUsage {
                value: previous.cloned().unwrap_or_else(|| json!({})),
                invalid_fields: vec!["usage".to_string()],
            }
        }
    };
    let mut next: Map<String, Value> = previous.and_then(as_record).cloned().unwrap_or_default();
    let mut raw: Map<String, Value> = previous
        .and_then(|p| p.get("raw"))
        .and_then(as_record)
        .cloned()
        .unwrap_or_default();
    let mut invalid_fields: Vec<String> = Vec::new();
    for (key, field) in record {
        if USAGE_NUMERIC_FIELDS.contains(&key.as_str()) {
            let number = js_number_of(field);
            if field.is_number() && number.is_finite() && number >= 0.0 {
                next.insert(key.clone(), field.clone());
            } else {
                raw.insert(key.clone(), field.clone());
                invalid_fields.push(key.clone());
            }
            continue;
        }
        if key == "currency" {
            if let Some(text) = string_field(Some(field)) {
                next.insert("currency".to_string(), Value::String(text.to_string()));
            } else {
                raw.insert(key.clone(), field.clone());
                invalid_fields.push(key.clone());
            }
            continue;
        }
        raw.insert(key.clone(), field.clone());
    }
    let context_used = next
        .get("contextUsed")
        .filter(|v| v.is_number())
        .map(js_number_of);
    let context_limit = next
        .get("contextLimit")
        .filter(|v| v.is_number())
        .map(js_number_of);
    let context_counter_changed =
        record.contains_key("contextUsed") || record.contains_key("contextLimit");
    let explicit_percent = record
        .get("contextPercent")
        .is_some_and(|v| v.is_number() && js_number_of(v).is_finite() && js_number_of(v) >= 0.0);
    let derived_percent = match (context_used, context_limit) {
        (Some(used), Some(limit)) if limit > 0.0 => {
            // Math.min(100, used / limit * 100)。
            Some((used / limit * 100.0).min(100.0))
        }
        _ => None,
    };
    if let Some(percent) = derived_percent.filter(|_| {
        !explicit_percent && (context_counter_changed || !next.contains_key("contextPercent"))
    }) {
        next.insert("contextPercent".to_string(), js_number_value(percent));
    } else if context_counter_changed && !explicit_percent {
        next.remove("contextPercent");
    }
    match optional_raw(raw) {
        Some(raw) => {
            next.insert("raw".to_string(), raw);
        }
        None => {
            next.remove("raw");
        }
    }
    NormalizedUsage {
        value: Value::Object(next),
        invalid_fields,
    }
}

/// TS `normalizeBudgetSnapshot`：部分补丁合并 + 计数器派生（remaining/percent/
/// exhausted 由最新 observed usage 重导出）。
pub fn normalize_budget_snapshot(input: &Value, previous: Option<&Value>) -> Value {
    let used = finite_non_negative(input.get("used"))
        .or_else(|| previous.and_then(|p| finite_non_negative(p.get("used"))));
    let limit = finite_non_negative(input.get("limit"))
        .or_else(|| previous.and_then(|p| finite_non_negative(p.get("limit"))));
    let remaining = match finite_non_negative(input.get("remaining")) {
        Some(value) => Some(value),
        None => match (&used, &limit) {
            (Some(used), Some(limit)) => Some(js_number_value(
                (js_number_of(limit) - js_number_of(used)).max(0.0),
            )),
            _ => previous.and_then(|p| finite_non_negative(p.get("remaining"))),
        },
    };
    let percent = match finite_non_negative(input.get("percent")) {
        Some(value) => Some(value),
        None => match (&used, &limit) {
            (Some(used), Some(limit)) if js_number_of(limit) > 0.0 => Some(js_number_value(
                js_number_of(used) / js_number_of(limit) * 100.0,
            )),
            _ => previous
                .and_then(|p| p.get("percent"))
                .filter(|v| v.is_number())
                .cloned(),
        },
    };
    let text_field = |key: &str| -> Option<Value> {
        let current = string_field(input.get(key)).map(|s| Value::String(s.to_string()));
        match current {
            Some(value) => Some(value),
            None => previous
                .and_then(|p| string_field(p.get(key)))
                .map(|s| Value::String(s.to_string())),
        }
    };
    let exhausted = match input.get("exhausted") {
        Some(value) if value.is_boolean() => Some(value.clone()),
        _ => match (&used, &limit) {
            (Some(used), Some(limit)) => {
                Some(Value::Bool(js_number_of(used) >= js_number_of(limit)))
            }
            _ => previous
                .and_then(|p| p.get("exhausted"))
                .filter(|v| v.is_boolean())
                .cloned(),
        },
    };
    // budget 的 type 是**输入/输出键不同名**的一例：TS 是
    // `input.budgetType ?? previous?.type`——previous 回退读的是**输出键**。故不能复用
    // 下面那个同名成对的 `text_field`：用它会在部分更新时去读 `previous.budgetType`，
    // 把上一拍已经确立的 type 丢掉。
    let budget_type = string_field(input.get("budgetType"))
        .map(|value| Value::String(value.to_string()))
        .or_else(|| {
            previous
                .and_then(|p| string_field(p.get("type")))
                .map(|value| Value::String(value.to_string()))
        });
    let mut out = Map::new();
    if let Some(used) = used {
        out.insert("used".to_string(), used);
    }
    if let Some(limit) = limit {
        out.insert("limit".to_string(), limit);
    }
    if let Some(remaining) = remaining {
        out.insert("remaining".to_string(), remaining);
    }
    if let Some(value) = budget_type {
        out.insert("type".to_string(), value);
    }
    if let Some(value) = text_field("resetAt") {
        out.insert("resetAt".to_string(), value);
    }
    if let Some(value) = text_field("threshold") {
        out.insert("threshold".to_string(), value);
    }
    if let Some(percent) = percent {
        out.insert("percent".to_string(), percent);
    }
    if let Some(exhausted) = exhausted {
        out.insert("exhausted".to_string(), exhausted);
    }
    Value::Object(out)
}

/// TS `normalizeSessionCommands`：id/name 收窄 + raw 宽容保留。
pub fn normalize_session_commands(values: &[Value]) -> Vec<Value> {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let record = match as_record(value) {
                Some(record) => record.clone(),
                None => {
                    // 非 object 条目按契约保 raw 兜底，不抛错。
                    return json!({
                        "id": format!("unknown-command-{index}"),
                        "name": format!("unknown-command-{index}"),
                        "raw": { "value": value },
                    });
                }
            };
            let id = string_field(record.get("id"))
                .or_else(|| string_field(record.get("name")))
                .map(str::to_string)
                .unwrap_or_else(|| format!("unknown-command-{index}"));
            let name = string_field(record.get("name"))
                .map(str::to_string)
                .unwrap_or_else(|| id.clone());
            let mut command = Map::new();
            command.insert("id".to_string(), Value::String(id));
            command.insert("name".to_string(), Value::String(name));
            if let Some(description) = string_field(record.get("description")) {
                command.insert(
                    "description".to_string(),
                    Value::String(description.to_string()),
                );
            }
            if let Some(input_hint) = string_field(record.get("inputHint")) {
                command.insert(
                    "inputHint".to_string(),
                    Value::String(input_hint.to_string()),
                );
            }
            match record.get("availability") {
                Some(value @ Value::Bool(_)) => {
                    command.insert("availability".to_string(), value.clone());
                }
                Some(value @ Value::String(_)) => {
                    command.insert("availability".to_string(), value.clone());
                }
                _ => {}
            }
            if let Some(capability) = string_field(record.get("capability")) {
                command.insert(
                    "capability".to_string(),
                    Value::String(capability.to_string()),
                );
            }
            let raw = without_keys(
                &record,
                &[
                    "id",
                    "name",
                    "description",
                    "inputHint",
                    "availability",
                    "capability",
                ],
            );
            if let Some(retained) = optional_raw(raw) {
                command.insert("raw".to_string(), retained);
            }
            Value::Object(command)
        })
        .collect()
}

/// TS `isWritableConfigOption`：boolean 型须是 boolean 值；select/enum 型须是字符串
/// 值且 schema.options / schema.enum 非空。
fn is_writable_config_option(
    value_type: Option<&str>,
    value: Option<&Value>,
    schema: Option<&Value>,
) -> bool {
    let value_type = match value_type {
        Some(value_type) => value_type.to_lowercase(),
        None => return false,
    };
    if value_type == "boolean" || value_type == "bool" {
        return value.is_some_and(Value::is_boolean);
    }
    if (value_type != "select" && value_type != "enum") || !value.is_some_and(Value::is_string) {
        return false;
    }
    let record = match schema.and_then(as_record) {
        Some(record) => record,
        None => return false,
    };
    match record.get("options") {
        Some(options) => options.as_array().is_some_and(|items| !items.is_empty()),
        None => record
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty()),
    }
}

/// TS `normalizeSessionConfigOptions`：label/value/valueType 收窄 + choices 归一 +
/// 不可写项的值退守 raw（renderer 设置面板不得改写只读项）。
pub fn normalize_session_config_options(values: &[Value]) -> Vec<Value> {
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let record = match as_record(value) {
                Some(record) => record.clone(),
                None => {
                    return json!({
                        "id": format!("unknown-option-{index}"),
                        "label": format!("unknown-option-{index}"),
                        "raw": { "value": value },
                    });
                }
            };
            let id = extract_config_option_id(value)
                .unwrap_or_else(|| format!("unknown-option-{index}"));
            let label = string_field(record.get("label"))
                .or_else(|| string_field(record.get("name")))
                .or_else(|| string_field(record.get("title")))
                .map(str::to_string)
                .unwrap_or_else(|| id.clone());
            let value_type = string_field(record.get("valueType"))
                .or_else(|| string_field(record.get("value_type")))
                .or_else(|| string_field(record.get("type")))
                .map(str::to_string);
            // `'key' in value` 是键存在性，与值无关（null 也算宣告）。
            let has_value = [
                "value",
                "currentValue",
                "current_value",
                "current",
                "selected",
                "selectedValue",
                "selected_value",
            ]
            .iter()
            .any(|key| record.contains_key(*key));
            let option_value = if has_value {
                extract_config_option_value(value)
            } else {
                None
            };
            let raw_choices = extract_config_option_choices(value);
            let normalized_choices: Vec<Value> = raw_choices
                .iter()
                .filter_map(|choice| {
                    let choice_id = extract_choice_id(choice, None)?;
                    let label = extract_choice_label(choice, Some(&choice_id))
                        .unwrap_or_else(|| choice_id.clone());
                    Some(json!({ "id": choice_id, "label": label }))
                })
                .collect();
            let schema = match record.get("schema") {
                Some(source_schema) => Some(source_schema.clone()),
                None => {
                    if !normalized_choices.is_empty() {
                        Some(json!({ "options": normalized_choices }))
                    } else {
                        None
                    }
                }
            };
            let writable = is_writable_config_option(
                value_type.as_deref(),
                option_value.as_ref(),
                schema.as_ref(),
            );
            let mut raw: Map<String, Value> = match record.get("raw").and_then(as_record) {
                Some(base) => base.clone(),
                None => Map::new(),
            };
            if !writable && has_value {
                raw.insert(
                    "value".to_string(),
                    option_value.clone().unwrap_or(Value::Null),
                );
                if let Some(value_type) = &value_type {
                    raw.insert("valueType".to_string(), Value::String(value_type.clone()));
                }
            }
            for (key, value) in without_keys(
                &record,
                &[
                    "id",
                    "key",
                    "configId",
                    "config_id",
                    "optionId",
                    "option_id",
                    "name",
                    "label",
                    "title",
                    "value",
                    "currentValue",
                    "current_value",
                    "current",
                    "selected",
                    "selectedValue",
                    "selected_value",
                    "valueType",
                    "value_type",
                    "type",
                    "editable",
                    "readOnly",
                    "readonly",
                    "read_only",
                    "schema",
                    "version",
                    "capability",
                    "raw",
                    "options",
                    "choices",
                    "values",
                    "available",
                    "items",
                ],
            ) {
                raw.insert(key, value);
            }
            let retained = optional_raw(raw);
            let version = finite_non_negative(record.get("version"));
            let mut option = Map::new();
            option.insert("id".to_string(), Value::String(id));
            option.insert("label".to_string(), Value::String(label));
            if has_value {
                // TS：`value: optionValue` —— extract 返回 undefined 时键带 undefined
                // （toEqual 语义下等价缺席）；这里同样缺席。
                if let Some(option_value) = option_value {
                    option.insert("value".to_string(), option_value);
                }
            }
            if let Some(value_type) = &value_type {
                option.insert("valueType".to_string(), Value::String(value_type.clone()));
            }
            if let Some(editable) = record.get("editable").filter(|v| v.is_boolean()) {
                let writable_flag = writable;
                option.insert(
                    "editable".to_string(),
                    Value::Bool(editable.as_bool().expect("checked") && writable_flag),
                );
            }
            if let Some(schema) = schema {
                option.insert("schema".to_string(), schema);
            }
            if let Some(version) = version {
                option.insert("version".to_string(), version);
            }
            if let Some(capability) = string_field(record.get("capability")) {
                option.insert(
                    "capability".to_string(),
                    Value::String(capability.to_string()),
                );
            }
            if let Some(retained) = retained {
                option.insert("raw".to_string(), retained);
            }
            Value::Object(option)
        })
        .collect()
}
