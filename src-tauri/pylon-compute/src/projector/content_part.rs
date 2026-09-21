//! 内容部件语义契约（TS 基线：`src/domains/workbench/content/contentPartSchema.ts`）。
//!
//! 逐函数对齐，不是重新设计。部件值在 Rust 侧用 `serde_json::Value` 透传表示——
//! TS 侧 ContentPart 就是结构化 JSON 对象，投影核只读 `kind` / `text` / `language`
//! 等少数字段，其余 provider 字段原样保留；用 JSON 值建模才能逐字段保真。
//!
//! TS↔Rust 的关键映射约定（全部由本模块的单测或 parity 测试钉住）：
//!
//! - TS 的 `undefined` ↔ Rust 的「键不存在」（`Option::None`）；JSON `null` 仍是
//!   `Value::Null`。两者在 TS 校验里语义不同（`v === undefined` vs `v === null`），
//!   不得混用。
//! - JS number 在解析边界按 JS 语义规范化：整值且 |v| ≤ 2^53 的浮点转整数存储
//!   （JS 里 `3.0 === 3`，`JSON.stringify(3.0) === "3"`），否则字节数计量会与 TS 分叉。
//! - `String.prototype.trim` 的空白集比 Rust `str::trim` 宽（含 `\u{a0}` / `\u{feff}`
//!   等），统一走 [`js_trim`]。
//!
//! 已知语义缺口（无法逐字复现，见交付清单）：对象键序（serde_json 默认字典序 vs
//! JS 插入序，只影响截断预览的内容与 redactions 顺序，不影响长度判定与 summary）。

use serde_json::{Map, Number, Value};

pub const DEFAULT_MAX_RAW_BYTES: f64 = 8.0 * 1024.0;
/// artifact 预览部件数上限（TS `MAX_ARTIFACT_PREVIEW_PARTS`）。
pub const MAX_ARTIFACT_PREVIEW_PARTS: usize = 256;
const JS_MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

// ── 基础值判断（JS 语义） ────────────────────────────────────────────────────

/// JS `Number.isInteger`。
pub fn number_is_integer(value: &Number) -> bool {
    if value.is_i64() || value.is_u64() {
        return true;
    }
    value
        .as_f64()
        .is_some_and(|f| f.is_finite() && f.fract() == 0.0)
}

/// JS `Number.isSafeInteger`。
pub fn number_is_safe_integer(value: &Number) -> bool {
    match value.as_i64() {
        Some(i) => (i as f64).abs() <= JS_MAX_SAFE_INTEGER,
        None => match value.as_u64() {
            Some(u) => (u as f64) <= JS_MAX_SAFE_INTEGER,
            None => value.as_f64().is_some_and(|f| {
                f.is_finite() && f.fract() == 0.0 && f.abs() <= JS_MAX_SAFE_INTEGER
            }),
        },
    }
}

/// Number → f64。
pub fn number_as_f64(value: &Number) -> f64 {
    value.as_f64().unwrap_or(0.0)
}

/// JS `String(value)`（received 标注与 `String(line.kind)` 类判断用）。
pub fn js_string_of(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        Value::Number(n) => js_number_to_string(number_as_f64(n)),
        Value::String(s) => s.clone(),
        // JS 对普通对象是 "[object Object]"；数组会先 join，但校验分支只对
        // number/string 形态取值，这里保持保守一致。
        Value::Array(_) | Value::Object(_) => "[object Object]".to_string(),
    }
}

/// Value → f64（校验分支用；对象/数组按 JS 是 NaN）。
pub fn js_number_of(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        Value::Number(n) => number_as_f64(n),
        Value::String(s) => {
            let trimmed = js_trim(s);
            if trimmed.is_empty() {
                0.0
            } else {
                trimmed.parse::<f64>().unwrap_or(f64::NAN)
            }
        }
        Value::Array(_) | Value::Object(_) => f64::NAN,
    }
}

/// JS `Number.prototype.toString`：1e-6 ≤ |x| < 1e21 用十进制，其余用指数
/// （指数带显式正负号，如 `1e+21`）。shortest round-trip 由 Rust `{}` 保证。
pub fn js_number_to_string(value: f64) -> String {
    if value == 0.0 {
        return "0".to_string();
    }
    let magnitude = value.abs();
    if (1e-6..1e21).contains(&magnitude) {
        let text = format!("{value}");
        if let Some(dot) = text.find('.') {
            let trimmed = text[dot..].trim_end_matches('0').trim_end_matches('.');
            let mut result = String::with_capacity(text.len());
            result.push_str(&text[..dot]);
            result.push_str(trimmed);
            return result;
        }
        text
    } else {
        let formatted = format!("{value:e}");
        match formatted.split_once('e') {
            Some((mantissa, exponent)) => match exponent.strip_prefix('-') {
                Some(digits) => format!("{mantissa}e-{digits}"),
                None => format!("{mantissa}e+{exponent}"),
            },
            None => formatted,
        }
    }
}

/// JS `String.prototype.trim` 的空白集（WhiteSpace ∪ LineTerminator）。
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| {
        matches!(
            c,
            '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
                ..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
        )
    })
}

/// JS `string.length`（UTF-16 码元数）。
pub fn js_utf16_length(value: &str) -> usize {
    value
        .chars()
        .map(|c| usize::from(u32::from(c) > 0xFFFF) + 1)
        .sum()
}

/// TS `typeof value`。
pub fn js_typeof(value: &Value) -> &'static str {
    match value {
        Value::Null => "object", // typeof null === "object"
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) | Value::Object(_) => "object",
    }
}

/// TS `isRecord`（排除数组）。
pub fn is_record(value: &Value) -> bool {
    matches!(value, Value::Object(_))
}

pub fn as_record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// JSON 字符串的 UTF-8 字节数（TS `byteLength` 走 TextEncoder，同为 UTF-8）。
pub fn byte_length(value: &str) -> usize {
    value.len()
}

/// JSON 值按 JS `JSON.stringify` 语义序列化（用于字节数计量与截断预览）。
/// 键序缺口见模块注释；字符串转义规则与 JS 一致（\b \t \n \f \r \uXXXX 控制字符）。
pub fn js_json_stringify(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, &mut out);
    out
}

fn write_json(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => out.push_str(&js_number_to_string(number_as_f64(n))),
        Value::String(s) => write_json_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json(item, out);
            }
            out.push(']');
        }
        Value::Object(entries) => {
            out.push('{');
            for (index, (key, item)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_json_string(key, out);
                out.push(':');
                write_json(item, out);
            }
            out.push('}');
        }
    }
}

fn write_json_string(value: &str, out: &mut String) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (u32::from(c)) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// TS `encoded.slice(0, units)`：按 UTF-16 码元切串。切进代理对时 JS 会留下孤立
/// 代理项、TextEncoder 把它编成 U+FFFD（3 字节）——用替换符复现该字节数。
pub fn utf16_slice(value: &str, units: usize) -> String {
    let mut out = String::new();
    let mut used = 0usize;
    for c in value.chars() {
        if used >= units {
            break;
        }
        let width = usize::from(u32::from(c) > 0xFFFF) + 1;
        if used + width > units {
            out.push('\u{FFFD}');
            used += 1;
            continue;
        }
        out.push(c);
        used += width;
    }
    out
}

/// 把 JSON 数值按 JS number 语义规范化（整值浮点 → 整数）。帧解码后立刻执行，
/// 后续 stringify 的字节数才与 TS 一致。
pub fn canonicalize_js_numbers(value: &mut Value) {
    match value {
        Value::Number(n) => {
            if let Some(f) = n.as_f64() {
                if f.is_finite() && f.fract() == 0.0 && f.abs() <= JS_MAX_SAFE_INTEGER {
                    *n = Number::from(f as i64);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(canonicalize_js_numbers),
        Value::Object(entries) => entries.values_mut().for_each(canonicalize_js_numbers),
        _ => {}
    }
}

// ── SchemaIssue / SchemaResult ───────────────────────────────────────────────

/// TS `SchemaIssue`（path 元素为 string | number）。
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SchemaIssue {
    pub path: Vec<Value>,
    pub code: String,
    pub expected: String,
    pub received: String,
    pub summary: String,
}

pub type SchemaResult<T> = Result<T, Vec<SchemaIssue>>;

fn received(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Array(_) => "array".to_string(),
        other => js_typeof(other).to_string(),
    }
}

fn issue(path: Vec<Value>, code: &str, expected: &str, value: &Value) -> SchemaIssue {
    SchemaIssue {
        path,
        code: code.to_string(),
        expected: expected.to_string(),
        received: received(value),
        summary: format!("Expected {expected}"),
    }
}

/// TS `issue(path, code, expected, value[key])` 在键缺席（undefined）时的形态：
/// received = "undefined"。与「键存在但为 null」的 received = "null" 严格区分。
fn issue_undefined(path: Vec<Value>, code: &str, expected: &str) -> SchemaIssue {
    SchemaIssue {
        path,
        code: code.to_string(),
        expected: expected.to_string(),
        received: "undefined".to_string(),
        summary: format!("Expected {expected}"),
    }
}

fn path_of(parts: &[&str]) -> Vec<Value> {
    parts
        .iter()
        .map(|p| Value::String((*p).to_string()))
        .collect()
}

// ── 相邻聚合（流式 wire 片段 → 语义块） ──────────────────────────────────────

fn part_kind(part: &Value) -> Option<&str> {
    part.get("kind").and_then(Value::as_str)
}

fn part_text(part: &Value) -> Option<&str> {
    part.get("text").and_then(Value::as_str)
}

fn is_display_text_part(part: &Value) -> bool {
    matches!(part_kind(part), Some("text") | Some("markdown"))
}

fn is_reasoning_text_part(part: &Value) -> bool {
    matches!(
        part_kind(part),
        Some("text") | Some("markdown") | Some("reasoning") | Some("thinking")
    )
}

/// `coalesceAdjacentDisplayTextParts`：只合并相邻 display-text（text/markdown），
/// 保留 rich-content 边界；未变化时返回 None（TS 返回原数组，调用语义相同）。
pub fn coalesce_adjacent_display_text_parts(parts: &[Value]) -> Option<Vec<Value>> {
    if parts.len() < 2 {
        return None;
    }
    let mut merged: Vec<Value> = Vec::with_capacity(parts.len());
    let mut changed = false;
    for part in parts {
        let combined = merged
            .last()
            .is_some_and(|previous| is_display_text_part(previous) && is_display_text_part(part));
        if combined {
            let previous = merged.last_mut().expect("checked above");
            let previous_kind = part_kind(previous).unwrap_or("").to_string();
            let previous_text = part_text(previous).unwrap_or("").to_string();
            let current_text = part_text(part).unwrap_or("");
            let kind = if previous_kind == "markdown" || part_kind(part) == Some("markdown") {
                "markdown"
            } else {
                "text"
            };
            // TS 的 `{ ...previous, kind, text }`：其余字段原样保留（如 language）。
            let object = previous.as_object_mut().expect("display text part 是对象");
            object.insert("kind".to_string(), Value::String(kind.to_string()));
            object.insert(
                "text".to_string(),
                Value::String(format!("{previous_text}{current_text}")),
            );
            changed = true;
        } else {
            merged.push(part.clone());
        }
    }
    changed.then_some(merged)
}

/// `coalesceAdjacentReasoningParts`：额外接受 `reasoning` / `thinking` 文本族；
/// 合并时 language 只在两侧一致时保留。TS 是「重建对象」而不是 spread。
pub fn coalesce_adjacent_reasoning_parts(parts: &[Value]) -> Option<Vec<Value>> {
    if parts.len() < 2 {
        return None;
    }
    let mut merged: Vec<Value> = Vec::with_capacity(parts.len());
    let mut changed = false;
    for part in parts {
        let combined = merged.last().is_some_and(|previous| {
            is_reasoning_text_part(previous) && is_reasoning_text_part(part)
        });
        if combined {
            let previous = merged.last().expect("checked above").clone();
            let previous_kind = part_kind(&previous).unwrap_or("");
            let current_kind = part_kind(part).unwrap_or("");
            let kind = if previous_kind == "reasoning" || current_kind == "reasoning" {
                "reasoning"
            } else if previous_kind == "thinking" || current_kind == "thinking" {
                "thinking"
            } else if previous_kind == "markdown" || current_kind == "markdown" {
                "markdown"
            } else {
                "text"
            };
            let previous_language = previous.get("language");
            let current_language = part.get("language");
            let language = if previous_language == current_language {
                previous_language.cloned()
            } else {
                None
            };
            let text = format!(
                "{}{}",
                part_text(&previous).unwrap_or(""),
                part_text(part).unwrap_or("")
            );
            let mut object = Map::new();
            object.insert("kind".to_string(), Value::String(kind.to_string()));
            object.insert("text".to_string(), Value::String(text));
            if let Some(language) = language {
                object.insert("language".to_string(), language);
            }
            *merged.last_mut().expect("non-empty") = Value::Object(object);
            changed = true;
        } else {
            merged.push(part.clone());
        }
    }
    changed.then_some(merged)
}

// ── unknown 兜底 ─────────────────────────────────────────────────────────────

const SENSITIVE_KEY_MARKERS: [&str; 9] = [
    "token",
    "secret",
    "password",
    "authorization",
    "api-key",
    "api_key",
    "apikey",
    "credential",
    "cookie",
];

/// TS 正则 `/(?:token|secret|password|authorization|api[-_]?key|credential|cookie)/i`：
/// 无锚点子串匹配（小写化后包含测试；`api[-_]?key` 展开为 apikey/api-key/api_key）。
fn is_sensitive_key(key: &str) -> bool {
    let lowered = key.to_lowercase();
    SENSITIVE_KEY_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
}

fn normalize_type(value: &str) -> String {
    let trimmed = js_trim(value);
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

fn unknown_summary(kind: &str, bytes: usize) -> String {
    format!(
        "Unknown content type {} ({bytes} bytes)",
        normalize_type(kind)
    )
}

/// `sanitizeJson`：深度遍历，敏感键替换为 `[REDACTED]` 并留痕；非 JSON 形态
/// （TS 的 undefined/function/symbol）同样归 `[REDACTED]`。JSON 输入下与 TS 的
/// 唯一差异是遍历键序（见模块注释）。
pub fn sanitize_json(value: &Value, path: &[Value], redactions: &mut Vec<Value>) -> Value {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => value.clone(),
        Value::Number(n) => {
            if n.as_f64().is_some_and(f64::is_finite) {
                value.clone()
            } else {
                Value::Null
            }
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let mut child = path.to_vec();
                    child.push(Value::from(index));
                    sanitize_json(item, &child, redactions)
                })
                .collect(),
        ),
        Value::Object(entries) => {
            let mut output = Map::new();
            for (key, child) in entries {
                if is_sensitive_key(key) {
                    output.insert(key.clone(), Value::String("[REDACTED]".to_string()));
                    let mut marker_path = path.to_vec();
                    marker_path.push(Value::String(key.clone()));
                    redactions.push(serde_json::json!({
                        "path": marker_path,
                        "reason": "sensitive",
                    }));
                } else {
                    let mut child_path = path.to_vec();
                    child_path.push(Value::String(key.clone()));
                    output.insert(key.clone(), sanitize_json(child, &child_path, redactions));
                }
            }
            Value::Object(output)
        }
    }
}

/// `createUnknownContentPart`。`max_raw_bytes` 对应 `options.maxRawBytes`
/// （缺省 8 KiB、下限 128）。返回完整部件对象（JSON）。
pub fn create_unknown_content_part(
    original_type: &str,
    raw: &Value,
    max_raw_bytes: Option<f64>,
) -> Value {
    let max_raw_bytes = max_raw_bytes
        .unwrap_or(DEFAULT_MAX_RAW_BYTES)
        .max(128.0)
        .floor() as usize;
    let mut redactions: Vec<Value> = Vec::new();
    let sanitized = sanitize_json(raw, &[], &mut redactions);
    let encoded = js_json_stringify(&sanitized);
    let original_bytes = byte_length(&encoded);
    let has_redactions = !redactions.is_empty();

    let mut object = Map::new();
    object.insert("kind".to_string(), Value::String("unknown".to_string()));
    object.insert(
        "originalType".to_string(),
        Value::String(normalize_type(original_type)),
    );
    object.insert(
        "summary".to_string(),
        Value::String(unknown_summary(original_type, original_bytes)),
    );
    if original_bytes <= max_raw_bytes {
        object.insert("raw".to_string(), sanitized);
        object.insert("truncated".to_string(), Value::Bool(false));
        if has_redactions {
            object.insert("redactions".to_string(), Value::Array(redactions));
        }
        return Value::Object(object);
    }

    // 截断路径：预览是字符串，因此仍是合法 JSON（只是刻意不是完整载荷）。
    let preview = utf16_slice(&encoded, max_raw_bytes.saturating_sub(64).max(1));
    let retained_bytes = byte_length(&preview);
    let omitted_bytes = original_bytes.saturating_sub(retained_bytes);
    object.insert(
        "raw".to_string(),
        serde_json::json!({ "preview": preview, "truncated": true }),
    );
    object.insert("truncated".to_string(), Value::Bool(true));
    object.insert(
        "truncation".to_string(),
        serde_json::json!({
            "truncated": true,
            "originalBytes": original_bytes,
            "retainedBytes": retained_bytes,
            "omittedBytes": omitted_bytes,
            "reason": "size-limit",
        }),
    );
    if has_redactions {
        object.insert("redactions".to_string(), Value::Array(redactions));
    }
    Value::Object(object)
}

/// `contentPartFromDisplayHint`：journal typed_payload.displayHint → ContentPart。
pub fn content_part_from_display_hint(hint: &Value) -> Value {
    let record = match as_record(hint) {
        Some(record) => record,
        None => return create_unknown_content_part("content.unknown", hint, None),
    };
    let kind = match record.get("displayKind").and_then(Value::as_str) {
        Some(kind) if kind.contains('.') => kind,
        _ => return create_unknown_content_part("content.unknown", hint, None),
    };
    // TS 判据是「payload 不是对象（含 undefined/null/数组）」→ 用原始 hint 兜底。
    let payload = match record.get("payload").and_then(as_record) {
        Some(payload) => payload,
        None => return create_unknown_content_part(kind, hint, None),
    };
    // `{ kind, ...(payload) }`：payload 键在后，可覆盖 kind——刻意保真。
    let mut object = Map::new();
    object.insert("kind".to_string(), Value::String(normalize_type(kind)));
    for (key, value) in payload {
        object.insert(key.clone(), value.clone());
    }
    Value::Object(object)
}

// ── parseContentPart ─────────────────────────────────────────────────────────

fn is_text_kind(kind: &str) -> bool {
    ["text", "markdown", "code", "ansi", "reasoning", "thinking"].contains(&kind)
}

fn is_known_structured_kind(kind: &str) -> bool {
    [
        "redacted-reasoning",
        "document",
        "file-reference",
        "file-selection",
        "diff",
        "location",
        "terminal",
        "log",
        "progress",
        "list",
        "key-value",
        "json",
        "link",
        "search-result",
        "diagnostic-lsp",
        "tool-use",
        "tool-result",
        "artifact",
        "memory",
        "skill",
        "mcp-resource",
    ]
    .contains(&kind)
}

pub fn is_json_value(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => true,
        Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
        Value::Array(items) => items.iter().all(is_json_value),
        Value::Object(entries) => entries.values().all(is_json_value),
    }
}

fn validate_optional_string(record: &Map<String, Value>, key: &str, issues: &mut Vec<SchemaIssue>) {
    if let Some(value) = record.get(key) {
        if !value.is_string() {
            issues.push(issue(path_of(&[key]), "type.string", "string", value));
        }
    }
}

fn validate_optional_boolean(
    record: &Map<String, Value>,
    key: &str,
    issues: &mut Vec<SchemaIssue>,
) {
    if let Some(value) = record.get(key) {
        if !value.is_boolean() {
            issues.push(issue(path_of(&[key]), "type.boolean", "boolean", value));
        }
    }
}

fn reject_inline_blob(record: &Map<String, Value>, issues: &mut Vec<SchemaIssue>) {
    if let Some(value) = record.get("blob") {
        issues.push(issue(
            path_of(&["blob"]),
            "content.binary-inline",
            "omitted binary payload",
            value,
        ));
    }
}

fn non_empty_string(value: &Value) -> bool {
    value.as_str().is_some_and(|s| !js_trim(s).is_empty())
}

/// TS `isMissingOrNonEmptyString`：undefined（键不存在）视为通过。
fn is_missing_or_non_empty_string(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(value) => non_empty_string(value),
    }
}

fn is_optional_non_negative_integer(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(value) => value
            .as_number()
            .is_some_and(|n| number_is_integer(n) && number_as_f64(n) >= 0.0),
    }
}

fn is_optional_timestamp(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(Value::String(s)) => !js_trim(s).is_empty(),
        Some(_) => false,
    }
}

fn is_optional_timestamp_confidence(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(Value::String(s)) => {
            ["exact", "observed", "synthetic", "unknown"].contains(&s.as_str())
        }
        Some(_) => false,
    }
}

fn is_valid_truncation(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    if record.get("truncated") != Some(&Value::Bool(true)) {
        return false;
    }
    for key in ["originalBytes", "retainedBytes", "omittedBytes"] {
        if !record.get(key).is_some_and(|v| v.is_number()) {
            return false;
        }
    }
    matches!(
        record.get("reason").and_then(Value::as_str),
        Some("size-limit") | Some("non-serializable") | Some("sensitive")
    )
}

fn is_valid_terminal_truncation(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    let fields = [
        "capturedLines",
        "omittedLines",
        "capturedBytes",
        "omittedBytes",
    ];
    let any_present = fields.iter().any(|key| record.contains_key(*key));
    any_present
        && fields
            .iter()
            .all(|key| is_optional_non_negative_integer(record.get(*key)))
}

fn is_valid_text_position(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    let line_ok = record
        .get("line")
        .and_then(Value::as_number)
        .is_some_and(|n| number_is_integer(n) && number_as_f64(n) >= 0.0);
    if !line_ok {
        return false;
    }
    match record.get("character") {
        None => true,
        Some(value) => value
            .as_number()
            .is_some_and(|n| number_is_integer(n) && number_as_f64(n) >= 0.0),
    }
}

fn is_valid_text_range(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    let start = match record.get("start") {
        Some(start) if is_valid_text_position(start) => start,
        _ => return false,
    };
    let end = match record.get("end") {
        None => return true,
        Some(end) => end,
    };
    if !is_valid_text_position(end) {
        return false;
    }
    let line_of = |position: &Value| {
        position
            .get("line")
            .and_then(Value::as_number)
            .map(number_as_f64)
            .unwrap_or(0.0)
    };
    let character_of = |position: &Value| {
        position
            .get("character")
            .and_then(Value::as_number)
            .map(number_as_f64)
            .unwrap_or(0.0)
    };
    line_of(end) > line_of(start)
        || (line_of(end) == line_of(start) && character_of(end) >= character_of(start))
}

fn is_valid_diff_hunk(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    let keys = ["oldStart", "oldLines", "newStart", "newLines"];
    let any_present = keys.iter().any(|key| record.contains_key(*key));
    let all_valid = keys
        .iter()
        .all(|key| is_optional_non_negative_integer(record.get(*key)));
    any_present && all_valid
}

// ── 媒体校验（mediaContentValidation.ts 对齐） ───────────────────────────────

const MAX_INLINE_MEDIA_SOURCE_BYTES: usize = 8 * 1024 * 1024;

fn is_padded_base64(value: &str) -> bool {
    if value.is_empty() || !js_utf16_length(value).is_multiple_of(4) {
        return false;
    }
    let trimmed = value.trim_end_matches('=');
    let padding = value.len() - trimmed.len();
    padding <= 2
        && !trimmed.is_empty()
        && trimmed
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

fn starts_with_ignore_case(value: &str, prefix: &str) -> bool {
    value.len() >= prefix.len() && value[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// `^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$`（大小写不敏感）。返回 `(mime, base64)`。
fn parse_data_url(value: &str) -> Option<(&str, &str)> {
    let rest = starts_with_ignore_case(value, "data:").then(|| &value["data:".len()..])?;
    let separator = rest.find(';')?;
    let mime = &rest[..separator];
    if mime.is_empty() || mime.contains(',') {
        return None;
    }
    let rest = &rest[separator..];
    if !starts_with_ignore_case(rest, ";base64,") {
        return None;
    }
    let payload = &rest[";base64,".len()..];
    if !is_padded_base64(payload) {
        return None;
    }
    Some((mime, payload))
}

fn is_media_source_kind(value: &Value) -> bool {
    matches!(value, Value::String(s) if matches!(s.as_str(), "url" | "path" | "base64" | "blob"))
}

fn is_valid_media_mime(kind: &str, value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(Value::String(s)) => s.to_lowercase().starts_with(&format!("{kind}/")),
        Some(_) => false,
    }
}

fn is_valid_media_dimension(value: Option<&Value>) -> bool {
    value.is_none_or(|v| {
        v.as_number().is_some_and(|n| {
            let f = number_as_f64(n);
            f.is_finite() && f > 0.0
        })
    })
}

fn is_valid_media_duration(value: Option<&Value>) -> bool {
    value.is_none_or(|v| {
        v.as_number().is_some_and(|n| {
            let f = number_as_f64(n);
            f.is_finite() && f >= 0.0
        })
    })
}

fn has_forbidden_media_side_channel(record: &Map<String, Value>) -> bool {
    [
        "url",
        "localPath",
        "base64",
        "blob",
        "headers",
        "requestHeaders",
        "authorization",
        "token",
        "secret",
    ]
    .iter()
    .any(|key| record.contains_key(*key))
}

/// `isSafeLegacyMediaUrl`：无 sourceKind 的旧 ACP fixture，只接受安全 URL 形态。
fn is_safe_legacy_media_url(source: &str, content_kind: &str) -> bool {
    let lowered = source.to_lowercase();
    if lowered.starts_with("http://")
        || lowered.starts_with("https://")
        || lowered.starts_with("blob:")
    {
        return true;
    }
    parse_data_url(source).is_some_and(|(mime, payload)| {
        mime.to_lowercase().starts_with(&format!("{content_kind}/"))
            && payload.len() <= MAX_INLINE_MEDIA_SOURCE_BYTES
    })
}

/// `isValidMediaSource`。
fn is_valid_media_source(
    source: Option<&Value>,
    source_kind: Option<&Value>,
    mime_type: Option<&Value>,
    content_kind: &str,
) -> bool {
    let source = match source {
        Some(Value::String(s)) if !js_trim(s).is_empty() => js_trim(s),
        _ => return false,
    };
    match source_kind {
        // 旧 fixture 无 kind：URL 形态安全即可。
        None => is_safe_legacy_media_url(source, content_kind),
        Some(kind) if is_media_source_kind(kind) => match kind.as_str().expect("checked") {
            "url" => {
                let lowered = source.to_lowercase();
                lowered.starts_with("http://") || lowered.starts_with("https://")
            }
            "blob" => source.to_lowercase().starts_with("blob:"),
            "path" => {
                // `^[a-z]:[\\/]`（Windows 盘符）或不含 URI scheme。
                let bytes = source.as_bytes();
                let windows_drive = bytes.len() >= 3
                    && bytes[0].is_ascii_alphabetic()
                    && bytes[1] == b':'
                    && matches!(bytes[2], b'\\' | b'/');
                let uri_scheme = bytes.first().is_some_and(|b| b.is_ascii_alphabetic()) && {
                    let mut index = 1;
                    while index < bytes.len()
                        && (bytes[index].is_ascii_alphanumeric()
                            || matches!(bytes[index], b'+' | b'.' | b'-'))
                    {
                        index += 1;
                    }
                    index < bytes.len() && bytes[index] == b':'
                };
                windows_drive || !uri_scheme
            }
            "base64" => match parse_data_url(source) {
                Some((mime, payload)) => {
                    mime.to_lowercase().starts_with(&format!("{content_kind}/"))
                        && payload.len() <= MAX_INLINE_MEDIA_SOURCE_BYTES
                }
                None => match mime_type {
                    Some(Value::String(mime)) => {
                        mime.to_lowercase().starts_with(&format!("{content_kind}/"))
                            && source.len() <= MAX_INLINE_MEDIA_SOURCE_BYTES
                            && is_padded_base64(source)
                    }
                    _ => false,
                },
            },
            _ => false,
        },
        Some(_) => false,
    }
}

/// `isValidMediaContentInput`（expectedKind 恒有：parse 分支已固定 kind）。
fn is_valid_media_content_input(record: &Map<String, Value>, kind: &str) -> bool {
    is_valid_media_source(
        record.get("source"),
        record.get("sourceKind"),
        record.get("mimeType"),
        kind,
    ) && is_valid_media_mime(kind, record.get("mimeType"))
        && is_valid_media_dimension(record.get("width"))
        && is_valid_media_dimension(record.get("height"))
        && is_valid_media_duration(record.get("durationMs"))
        && ["alt", "caption", "poster", "transcript"]
            .iter()
            .all(|key| record.get(*key).is_none_or(Value::is_string))
        && !has_forbidden_media_side_channel(record)
}

/// `isNonEmptyContentLocation`。
fn is_non_empty_content_location(value: Option<&Value>) -> bool {
    value.is_some_and(non_empty_string)
}

fn is_valid_search_result_location(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    for key in ["path", "uri"] {
        if !is_missing_or_non_empty_string(record.get(key)) {
            return false;
        }
    }
    for key in ["line", "column", "endLine", "endColumn"] {
        if let Some(value) = record.get(key) {
            let ok = value
                .as_number()
                .is_some_and(|n| number_is_integer(n) && number_as_f64(n) >= 0.0);
            if !ok {
                return false;
            }
        }
    }
    ["path", "uri", "line", "column", "endLine", "endColumn"]
        .iter()
        .any(|key| record.contains_key(*key))
}

fn is_valid_search_result_entry(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    if !non_empty_string(record.get("source").unwrap_or(&Value::Null)) {
        return false;
    }
    if let Some(rank) = record.get("rank") {
        let ok = rank
            .as_number()
            .is_some_and(|n| number_is_integer(n) && number_as_f64(n) >= 1.0);
        if !ok {
            return false;
        }
    }
    if let Some(title) = record.get("title") {
        if !title.is_string() {
            return false;
        }
    }
    let snippet = record.get("snippet");
    if let Some(snippet) = snippet {
        if !snippet.is_string() {
            return false;
        }
    }
    if let Some(score) = record.get("score") {
        if !score
            .as_number()
            .is_some_and(|n| number_as_f64(n).is_finite())
        {
            return false;
        }
    }
    if let Some(token) = record.get("pagingToken") {
        if !token.as_str().is_some_and(|s| !js_trim(s).is_empty()) {
            return false;
        }
    }
    if let Some(location) = record.get("location") {
        if !is_valid_search_result_location(location) {
            return false;
        }
    }
    if let Some(highlights) = record.get("highlights") {
        let items = match highlights.as_array() {
            Some(items) => items,
            None => return false,
        };
        let snippet = match snippet.and_then(Value::as_str) {
            Some(snippet) => snippet,
            None => return false,
        };
        let snippet_length = js_utf16_length(snippet);
        for range in items {
            let range_record = match as_record(range) {
                Some(range_record) => range_record,
                None => return false,
            };
            let start = range_record.get("start").and_then(Value::as_number);
            let end = range_record.get("end").and_then(Value::as_number);
            let (Some(start), Some(end)) = (start, end) else {
                return false;
            };
            if !number_is_integer(start)
                || !number_is_integer(end)
                || number_as_f64(start) < 0.0
                || number_as_f64(end) <= number_as_f64(start)
                || number_as_f64(end) > snippet_length as f64
            {
                return false;
            }
        }
    }
    true
}

fn is_valid_search_result_content_input(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    let results = match record.get("results").and_then(Value::as_array) {
        Some(results) if !results.is_empty() => results,
        _ => return false,
    };
    if let Some(query) = record.get("query") {
        if !query.is_string() {
            return false;
        }
    }
    if let Some(total) = record.get("total") {
        let ok = total
            .as_number()
            .is_some_and(|n| number_is_integer(n) && number_as_f64(n) >= 0.0);
        if !ok {
            return false;
        }
    }
    if let Some(token) = record.get("pagingToken") {
        if !token.as_str().is_some_and(|s| !js_trim(s).is_empty()) {
            return false;
        }
    }
    results.iter().all(is_valid_search_result_entry)
}

fn is_valid_link_content_input(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    if !non_empty_string(record.get("url").unwrap_or(&Value::Null)) {
        return false;
    }
    if let Some(title) = record.get("title") {
        if !title.is_string() {
            return false;
        }
    }
    match record.get("status") {
        None => true,
        Some(status) => status.as_number().is_some_and(|n| {
            let f = number_as_f64(n);
            number_is_integer(n) && (100.0..=599.0).contains(&f)
        }),
    }
}

fn valid_safe_raw(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(record) => as_record(record).is_some_and(|record| record.values().all(is_json_value)),
    }
}

fn has_only_keys(record: &Map<String, Value>, allowed: &[&str]) -> bool {
    record.keys().all(|key| allowed.contains(&key.as_str()))
}

const MEMORY_CONTENT_KEYS: [&str; 11] = [
    "kind", "memoryId", "title", "source", "scope", "summary", "status", "version", "enabled",
    "used", "raw",
];
/// SKILL 键集 = MEMORY − memoryId + skillId + uri（TS 的 Set 运算结果）。
const SKILL_CONTENT_KEYS: [&str; 12] = [
    "kind", "skillId", "title", "source", "scope", "summary", "status", "version", "enabled",
    "used", "raw", "uri",
];
const MCP_RESOURCE_CONTENT_KEYS: [&str; 10] = [
    "kind",
    "server",
    "resourceUri",
    "tool",
    "title",
    "mimeType",
    "summary",
    "connectionState",
    "status",
    "raw",
];
const ARTIFACT_CONTENT_KEYS: [&str; 12] = [
    "kind",
    "artifactId",
    "title",
    "uri",
    "version",
    "mimeType",
    "summary",
    "status",
    "hasBlob",
    "parts",
    "actions",
    "raw",
];

/// `validC15Common`（memory/skill/artifact 公共字段约束）。
fn valid_c15_common(record: &Map<String, Value>) -> bool {
    for key in ["scope", "summary", "status"] {
        if let Some(value) = record.get(key) {
            if !non_empty_string(value) {
                return false;
            }
        }
    }
    for key in ["enabled", "used"] {
        if let Some(value) = record.get(key) {
            if !value.is_boolean() {
                return false;
            }
        }
    }
    if let Some(version) = record.get("version") {
        let ok = match version {
            Value::String(_) => non_empty_string(version),
            Value::Number(n) => {
                let f = number_as_f64(n);
                f.is_finite() && f >= 0.0
            }
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    !record.contains_key("blob") && valid_safe_raw(record.get("raw"))
}

fn is_valid_memory_content_input(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    record.get("kind").and_then(Value::as_str) == Some("memory")
        && non_empty_string(record.get("memoryId").unwrap_or(&Value::Null))
        && non_empty_string(record.get("title").unwrap_or(&Value::Null))
        && non_empty_string(record.get("source").unwrap_or(&Value::Null))
        && valid_c15_common(record)
        && has_only_keys(record, &MEMORY_CONTENT_KEYS)
}

fn is_valid_skill_content_input(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    record.get("kind").and_then(Value::as_str) == Some("skill")
        && non_empty_string(record.get("skillId").unwrap_or(&Value::Null))
        && non_empty_string(record.get("title").unwrap_or(&Value::Null))
        && non_empty_string(record.get("source").unwrap_or(&Value::Null))
        && valid_c15_common(record)
        && record.get("uri").is_none_or(non_empty_string)
        && has_only_keys(record, &SKILL_CONTENT_KEYS)
}

fn is_valid_mcp_resource_content_input(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    if record.get("kind").and_then(Value::as_str) != Some("mcp-resource")
        || !non_empty_string(record.get("server").unwrap_or(&Value::Null))
        || !non_empty_string(record.get("resourceUri").unwrap_or(&Value::Null))
    {
        return false;
    }
    for key in [
        "tool",
        "title",
        "mimeType",
        "summary",
        "connectionState",
        "status",
    ] {
        if let Some(value) = record.get(key) {
            if !non_empty_string(value) {
                return false;
            }
        }
    }
    valid_safe_raw(record.get("raw")) && has_only_keys(record, &MCP_RESOURCE_CONTENT_KEYS)
}

fn is_valid_artifact_content_input(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    if record.get("kind").and_then(Value::as_str) != Some("artifact")
        || !non_empty_string(record.get("artifactId").unwrap_or(&Value::Null))
        || !non_empty_string(record.get("title").unwrap_or(&Value::Null))
        || !non_empty_string(record.get("uri").unwrap_or(&Value::Null))
        || !valid_c15_common(record)
    {
        return false;
    }
    if let Some(mime) = record.get("mimeType") {
        if !non_empty_string(mime) {
            return false;
        }
    }
    if let Some(has_blob) = record.get("hasBlob") {
        if !has_blob.is_boolean() {
            return false;
        }
    }
    if let Some(actions) = record.get("actions") {
        match actions.as_array() {
            Some(items) if items.iter().all(non_empty_string) => {}
            _ => return false,
        }
    }
    if let Some(parts) = record.get("parts") {
        match parts.as_array() {
            Some(items) => {
                if items.len() > MAX_ARTIFACT_PREVIEW_PARTS {
                    return false;
                }
                if !items.iter().all(|part| parse_content_part(part).is_ok()) {
                    return false;
                }
            }
            None => return false,
        }
    }
    !record.contains_key("blob") && has_only_keys(record, &ARTIFACT_CONTENT_KEYS)
}

fn is_valid_diff_content_input(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    let has_path = ["path", "oldPath"].iter().any(|key| {
        record
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|s| !js_trim(s).is_empty())
    });
    if !has_path {
        return false;
    }
    if let Some(status) = record.get("status") {
        if !status.is_string() {
            return false;
        }
    }
    if let Some(range) = record.get("range") {
        if !is_valid_text_range(range) {
            return false;
        }
    }
    if let Some(lines) = record.get("lines") {
        let items = match lines.as_array() {
            Some(items) if !items.is_empty() => items,
            _ => return false,
        };
        for line in items {
            let line_record = match as_record(line) {
                Some(line_record) => line_record,
                None => return false,
            };
            let kind_matches = line_record
                .get("kind")
                .map(js_string_of)
                .is_some_and(|kind| ["context", "added", "removed"].contains(&kind.as_str()));
            let text_is_string = line_record.get("text").is_some_and(Value::is_string);
            if !kind_matches || !text_is_string {
                return false;
            }
        }
    }
    if let Some(hunks) = record.get("hunks") {
        let items = match hunks.as_array() {
            Some(items) if !items.is_empty() => items,
            _ => return false,
        };
        if !items.iter().all(is_valid_diff_hunk) {
            return false;
        }
    }
    for key in ["oldText", "newText", "unified"] {
        if let Some(value) = record.get(key) {
            if !value.is_string() {
                return false;
            }
        }
    }
    for key in ["additions", "deletions"] {
        if let Some(value) = record.get(key) {
            let ok = value
                .as_number()
                .is_some_and(|n| number_is_integer(n) && number_as_f64(n) >= 0.0);
            if !ok {
                return false;
            }
        }
    }
    for key in ["binary", "truncated"] {
        if let Some(value) = record.get(key) {
            if !value.is_boolean() {
                return false;
            }
        }
    }
    if let Some(truncation) = record.get("truncation") {
        if !is_valid_truncation(truncation) {
            return false;
        }
    }
    if let Some(raw_patch) = record.get("rawPatch") {
        if !is_json_value(raw_patch) {
            return false;
        }
    }
    if let Some(unknown_fields) = record.get("unknownFields") {
        match unknown_fields.as_array() {
            Some(items) if items.iter().all(Value::is_string) => {}
            _ => return false,
        }
    }
    record.get("binary") == Some(&Value::Bool(true))
        || record
            .get("lines")
            .and_then(Value::as_array)
            .is_some_and(|l| !l.is_empty())
        || record
            .get("hunks")
            .and_then(Value::as_array)
            .is_some_and(|h| !h.is_empty())
        || record
            .get("unified")
            .and_then(Value::as_str)
            .is_some_and(|u| !u.is_empty())
}

fn is_valid_lsp_diagnostic_content_input(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    let message_ok = record
        .get("message")
        .and_then(Value::as_str)
        .is_some_and(|s| !js_trim(s).is_empty());
    let path_ok = record
        .get("path")
        .and_then(Value::as_str)
        .is_some_and(|s| !js_trim(s).is_empty());
    if !message_ok || !path_ok {
        return false;
    }
    for key in ["severity", "code", "source"] {
        if let Some(value) = record.get(key) {
            if !value.is_string() {
                return false;
            }
        }
    }
    if let Some(range) = record.get("range") {
        if !is_valid_text_range(range) {
            return false;
        }
    }
    if let Some(related) = record.get("related") {
        let items = match related.as_array() {
            Some(items) => items,
            None => return false,
        };
        for item in items {
            let item_record = match as_record(item) {
                Some(item_record) => item_record,
                None => return false,
            };
            let message_ok = item_record
                .get("message")
                .and_then(Value::as_str)
                .is_some_and(|s| !js_trim(s).is_empty());
            let path_ok = item_record
                .get("path")
                .and_then(Value::as_str)
                .is_some_and(|s| !js_trim(s).is_empty());
            if !message_ok || !path_ok {
                return false;
            }
            if let Some(range) = item_record.get("range") {
                if !is_valid_text_range(range) {
                    return false;
                }
            }
        }
    }
    match record.get("unknownFields") {
        None => true,
        Some(Value::Array(items)) => items.iter().all(Value::is_string),
        Some(_) => false,
    }
}

fn is_valid_terminal_stream_entry(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    if !matches!(
        record.get("stream").and_then(Value::as_str),
        Some("stdout") | Some("stderr")
    ) {
        return false;
    }
    if !record.get("text").is_some_and(Value::is_string) {
        return false;
    }
    if !is_optional_non_negative_integer(record.get("ordinal")) {
        return false;
    }
    if let Some(late) = record.get("lateAfterTerminal") {
        if !late.is_boolean() {
            return false;
        }
    }
    if !is_optional_timestamp(record.get("timestamp")) {
        return false;
    }
    is_optional_timestamp_confidence(record.get("timestampConfidence"))
}

fn is_valid_terminal_content_input(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    let streams = match record.get("streams").and_then(Value::as_array) {
        Some(streams) => streams,
        None => return false,
    };
    if let Some(command) = record.get("command") {
        if !command.as_str().is_some_and(|s| !js_trim(s).is_empty()) {
            return false;
        }
    }
    if record.get("command").is_none() && streams.is_empty() && !record.contains_key("error") {
        return false;
    }
    for key in ["processId", "sessionId"] {
        if !is_missing_or_non_empty_string(record.get(key)) {
            return false;
        }
    }
    if let Some(status) = record.get("status") {
        if !["queued", "running", "completed", "failed", "cancelled"]
            .contains(&js_string_of(status).as_str())
        {
            return false;
        }
    }
    if let Some(terminated_by) = record.get("terminatedBy") {
        if !["timeout", "killed", "signal"].contains(&js_string_of(terminated_by).as_str()) {
            return false;
        }
    }
    if let Some(exit_code) = record.get("exitCode") {
        if !exit_code.as_number().is_some_and(number_is_integer) {
            return false;
        }
    }
    if let Some(duration) = record.get("durationMs") {
        // TS：Number.isFinite(input.durationMs) —— 非数字恒假。
        let ok = duration.as_number().is_some_and(|n| {
            let f = number_as_f64(n);
            f.is_finite() && f >= 0.0
        });
        if !ok {
            return false;
        }
    }
    if let Some(env) = record.get("env") {
        let ok = as_record(env).is_some_and(|env| env.values().all(Value::is_string));
        if !ok {
            return false;
        }
    }
    if let Some(truncation) = record.get("truncation") {
        if !is_valid_terminal_truncation(truncation) {
            return false;
        }
    }
    if let Some(error) = record.get("error") {
        let error_record = match as_record(error) {
            Some(error_record) => error_record,
            None => return false,
        };
        if !error_record
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|s| !js_trim(s).is_empty())
        {
            return false;
        }
        if let Some(code) = error_record.get("code") {
            if !code.is_string() {
                return false;
            }
        }
    }
    streams.iter().all(is_valid_terminal_stream_entry)
}

fn is_valid_log_content_input(value: &Value) -> bool {
    let record = match as_record(value) {
        Some(record) => record,
        None => return false,
    };
    let entries = match record.get("entries").and_then(Value::as_array) {
        Some(entries) if !entries.is_empty() => entries,
        _ => return false,
    };
    for key in ["source", "processId", "sessionId"] {
        if !is_missing_or_non_empty_string(record.get(key)) {
            return false;
        }
    }
    if let Some(truncation) = record.get("truncation") {
        if !is_valid_terminal_truncation(truncation) {
            return false;
        }
    }
    entries.iter().all(|entry| {
        let entry_record = match as_record(entry) {
            Some(entry_record) => entry_record,
            None => return false,
        };
        let level_ok = entry_record
            .get("level")
            .map(js_string_of)
            .is_some_and(|level| {
                [
                    "trace", "debug", "info", "warn", "error", "fatal", "unknown",
                ]
                .contains(&level.as_str())
            });
        if !level_ok {
            return false;
        }
        if let Some(original_level) = entry_record.get("originalLevel") {
            if !original_level
                .as_str()
                .is_some_and(|s| !js_trim(s).is_empty())
            {
                return false;
            }
        }
        if !entry_record.get("text").is_some_and(Value::is_string) {
            return false;
        }
        is_optional_non_negative_integer(entry_record.get("ordinal"))
            && is_optional_timestamp(entry_record.get("timestamp"))
            && is_optional_timestamp_confidence(entry_record.get("timestampConfidence"))
    })
}

fn parse_unknown(value: &Map<String, Value>) -> SchemaResult<Value> {
    let mut issues: Vec<SchemaIssue> = Vec::new();
    let original_type_ok = value
        .get("originalType")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty());
    if !original_type_ok {
        issues.push(issue_undefined(
            path_of(&["originalType"]),
            "type.string",
            "non-empty string",
        ));
    }
    if !value.get("summary").is_some_and(Value::is_string) {
        issues.push(issue_undefined(
            path_of(&["summary"]),
            "type.string",
            "string",
        ));
    }
    if !value.get("raw").is_some_and(is_json_value) {
        issues.push(issue_undefined(
            path_of(&["raw"]),
            "json.invalid",
            "JSON value",
        ));
    }
    if !value.get("truncated").is_some_and(Value::is_boolean) {
        issues.push(issue_undefined(
            path_of(&["truncated"]),
            "type.boolean",
            "boolean",
        ));
    }
    if let Some(truncation) = value.get("truncation") {
        if !is_valid_truncation(truncation) {
            issues.push(issue(
                path_of(&["truncation"]),
                "shape.truncation",
                "truncation metadata",
                truncation,
            ));
        }
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    let mut object = Map::new();
    object.insert("kind".to_string(), Value::String("unknown".to_string()));
    object.insert("originalType".to_string(), value["originalType"].clone());
    object.insert("summary".to_string(), value["summary"].clone());
    object.insert("raw".to_string(), value["raw"].clone());
    object.insert("truncated".to_string(), value["truncated"].clone());
    if let Some(truncation) = value.get("truncation") {
        object.insert("truncation".to_string(), truncation.clone());
    }
    if let Some(redactions) = value.get("redactions") {
        object.insert("redactions".to_string(), redactions.clone());
    }
    Ok(Value::Object(object))
}

/// `parseContentPart`：返回合法部件（JSON 透传或重建），失败时给出 issues。
pub fn parse_content_part(value: &Value) -> SchemaResult<Value> {
    let mut issues: Vec<SchemaIssue> = Vec::new();
    let record = match as_record(value) {
        Some(record) => record,
        None => return Err(vec![issue(Vec::new(), "type.object", "object", value)]),
    };
    let kind = match record.get("kind") {
        Some(Value::String(kind)) if !kind.is_empty() => kind.as_str(),
        Some(other) => {
            issues.push(issue(
                path_of(&["kind"]),
                "type.string",
                "non-empty string",
                other,
            ));
            return Err(issues);
        }
        None => {
            issues.push(issue_undefined(
                path_of(&["kind"]),
                "type.string",
                "non-empty string",
            ));
            return Err(issues);
        }
    };

    if kind == "unknown" {
        return parse_unknown(record);
    }
    if is_text_kind(kind) {
        if !record.get("text").is_some_and(Value::is_string) {
            issues.push(issue_undefined(path_of(&["text"]), "type.string", "string"));
        }
    } else if matches!(kind, "image" | "audio" | "video") {
        match record.get("source") {
            Some(source) if source.is_string() => {
                if !is_valid_media_content_input(record, kind) {
                    issues.push(issue(
                        path_of(&["source"]),
                        "content.media-source",
                        "valid canonical media source",
                        source,
                    ));
                }
            }
            None => {
                issues.push(issue_undefined(
                    path_of(&["source"]),
                    "type.string",
                    "non-empty canonical media source",
                ));
            }
            other => {
                issues.push(issue(
                    path_of(&["source"]),
                    "type.string",
                    "non-empty canonical media source",
                    other.unwrap_or(&Value::Null),
                ));
            }
        }
        if let Some(source_kind) = record.get("sourceKind") {
            if !is_media_source_kind(source_kind) {
                issues.push(issue(
                    path_of(&["sourceKind"]),
                    "content.media-source-kind",
                    "url, path, base64, or blob",
                    source_kind,
                ));
            }
        }
        validate_optional_string(record, "mimeType", &mut issues);
        validate_optional_string(record, "alt", &mut issues);
        validate_optional_string(record, "caption", &mut issues);
        validate_optional_string(record, "poster", &mut issues);
        validate_optional_string(record, "transcript", &mut issues);
        if !is_valid_media_mime(kind, record.get("mimeType")) {
            let mime_value = record.get("mimeType");
            let expected_mime = format!("{kind}/*");
            issues.push(match mime_value {
                Some(value) => issue(
                    path_of(&["mimeType"]),
                    "content.media-mime",
                    &expected_mime,
                    value,
                ),
                None => {
                    issue_undefined(path_of(&["mimeType"]), "content.media-mime", &expected_mime)
                }
            });
        }
        if !is_valid_media_dimension(record.get("width")) {
            issues.push(match record.get("width") {
                Some(value) => issue(
                    path_of(&["width"]),
                    "number.positive-finite",
                    "positive finite number",
                    value,
                ),
                None => issue_undefined(
                    path_of(&["width"]),
                    "number.positive-finite",
                    "positive finite number",
                ),
            });
        }
        if !is_valid_media_dimension(record.get("height")) {
            issues.push(match record.get("height") {
                Some(value) => issue(
                    path_of(&["height"]),
                    "number.positive-finite",
                    "positive finite number",
                    value,
                ),
                None => issue_undefined(
                    path_of(&["height"]),
                    "number.positive-finite",
                    "positive finite number",
                ),
            });
        }
        if !is_valid_media_duration(record.get("durationMs")) {
            issues.push(match record.get("durationMs") {
                Some(value) => issue(
                    path_of(&["durationMs"]),
                    "number.non-negative-finite",
                    "non-negative finite number",
                    value,
                ),
                None => issue_undefined(
                    path_of(&["durationMs"]),
                    "number.non-negative-finite",
                    "non-negative finite number",
                ),
            });
        }
        if has_forbidden_media_side_channel(record) {
            issues.push(issue(
                Vec::new(),
                "content.media-side-channel",
                "single canonical source without secret/raw side channels",
                value,
            ));
        }
    } else if kind == "resource" {
        if !is_non_empty_content_location(record.get("uri")) {
            issues.push(match record.get("uri") {
                Some(value) => issue(path_of(&["uri"]), "type.string", "non-empty string", value),
                None => issue_undefined(path_of(&["uri"]), "type.string", "non-empty string"),
            });
        }
        validate_optional_string(record, "title", &mut issues);
        validate_optional_string(record, "mimeType", &mut issues);
        validate_optional_string(record, "text", &mut issues);
        validate_optional_boolean(record, "hasBlob", &mut issues);
        reject_inline_blob(record, &mut issues);
    } else if kind == "document" {
        validate_optional_string(record, "title", &mut issues);
        validate_optional_string(record, "path", &mut issues);
        validate_optional_string(record, "uri", &mut issues);
        validate_optional_string(record, "mimeType", &mut issues);
        validate_optional_string(record, "text", &mut issues);
        validate_optional_boolean(record, "hasBlob", &mut issues);
        if !["path", "uri", "text"]
            .iter()
            .any(|key| is_non_empty_content_location(record.get(*key)))
        {
            issues.push(issue(
                Vec::new(),
                "content.document-source",
                "path, uri, or text",
                value,
            ));
        }
        reject_inline_blob(record, &mut issues);
    } else if kind == "search-result" {
        if !is_valid_search_result_content_input(value) {
            issues.push(issue(
                Vec::new(),
                "content.search-result",
                "normalized non-empty search results",
                value,
            ));
        }
    } else if kind == "link" {
        if !is_valid_link_content_input(value) {
            issues.push(match record.get("url") {
                Some(value) => issue(
                    path_of(&["url"]),
                    "content.link",
                    "normalized non-empty link",
                    value,
                ),
                None => issue_undefined(
                    path_of(&["url"]),
                    "content.link",
                    "normalized non-empty link",
                ),
            });
        }
    } else if kind == "diff" {
        if !is_valid_diff_content_input(value) {
            issues.push(issue(
                Vec::new(),
                "content.diff",
                "normalized structured diff",
                value,
            ));
        }
    } else if kind == "diagnostic-lsp" {
        if !is_valid_lsp_diagnostic_content_input(value) {
            issues.push(issue(
                Vec::new(),
                "content.diagnostic-lsp",
                "normalized LSP diagnostic",
                value,
            ));
        }
    } else if kind == "terminal" {
        if !is_valid_terminal_content_input(value) {
            issues.push(issue(
                Vec::new(),
                "content.terminal",
                "normalized terminal output",
                value,
            ));
        }
    } else if kind == "log" {
        if !is_valid_log_content_input(value) {
            issues.push(issue(
                Vec::new(),
                "content.log",
                "normalized structured log",
                value,
            ));
        }
    } else if kind == "memory" {
        if !is_valid_memory_content_input(value) {
            issues.push(issue(
                Vec::new(),
                "content.memory",
                "normalized memory metadata",
                value,
            ));
        }
    } else if kind == "skill" {
        if !is_valid_skill_content_input(value) {
            issues.push(issue(
                Vec::new(),
                "content.skill",
                "normalized skill metadata",
                value,
            ));
        }
    } else if kind == "mcp-resource" {
        if !is_valid_mcp_resource_content_input(value) {
            issues.push(issue(
                Vec::new(),
                "content.mcp-resource",
                "normalized MCP resource metadata",
                value,
            ));
        }
    } else if kind == "artifact" {
        if !is_valid_artifact_content_input(value) {
            issues.push(issue(
                Vec::new(),
                "content.artifact",
                "normalized artifact metadata and preview parts",
                value,
            ));
        }
    } else if kind == "tool-result" && record.contains_key("parts") {
        match record.get("parts").and_then(Value::as_array) {
            Some(parts) => {
                for (index, part) in parts.iter().enumerate() {
                    if let Err(nested) = parse_content_part(part) {
                        for item in nested {
                            let mut path =
                                vec![Value::String("parts".to_string()), Value::from(index)];
                            path.extend(item.path);
                            issues.push(SchemaIssue { path, ..item });
                        }
                    }
                }
            }
            None => {
                issues.push(issue_undefined(path_of(&["parts"]), "type.array", "array"));
            }
        }
    } else if kind.contains('.') || is_known_structured_kind(kind) {
        // 结构化/扩展 kind 刻意保留 provider 字段；信封只要求整体是 JSON 值。
        if !is_json_value(value) {
            issues.push(issue(Vec::new(), "json.invalid", "JSON value", value));
        }
    } else {
        // 未识别的 provider kind 归一为显式可见兜底（不静默丢弃）。
        return Ok(create_unknown_content_part(kind, value, None));
    }

    if issues.is_empty() {
        Ok(value.clone())
    } else {
        Err(issues)
    }
}

// ── 单测：对齐 `content/__tests__/contentPartSchema.test.ts` 与
//    `c15ContentNormalization.test.ts` 中直接落在 parseContentPart /
//    createUnknownContentPart / coalesce* 上的断言 ──
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(value: Value) -> SchemaResult<Value> {
        // 进入前先做 JS number 规范化（与帧解码路径一致）。
        let mut value = value;
        canonicalize_js_numbers(&mut value);
        parse_content_part(&value)
    }

    #[test]
    fn coalesces_only_adjacent_display_text() {
        let code = json!({"kind": "code", "text": "const answer = 42", "language": "ts"});
        let parts = vec![
            json!({"kind": "text", "text": "连续"}),
            json!({"kind": "markdown", "text": "正文"}),
            code.clone(),
            json!({"kind": "markdown", "text": "尾部"}),
            json!({"kind": "text", "text": "正文"}),
        ];
        let merged = coalesce_adjacent_display_text_parts(&parts).expect("changed");
        assert_eq!(
            merged,
            vec![
                json!({"kind": "markdown", "text": "连续正文"}),
                code,
                json!({"kind": "markdown", "text": "尾部正文"}),
            ]
        );
    }

    #[test]
    fn coalesces_reasoning_kinds_without_crossing_rich_boundaries() {
        let code = json!({"kind": "code", "text": "const answer = 42", "language": "ts"});
        let parts = vec![
            json!({"kind": "text", "text": "先"}),
            json!({"kind": "reasoning", "text": "思考"}),
            json!({"kind": "thinking", "text": "再"}),
            code.clone(),
            json!({"kind": "markdown", "text": "后"}),
            json!({"kind": "text", "text": "续"}),
        ];
        let merged = coalesce_adjacent_reasoning_parts(&parts).expect("changed");
        assert_eq!(
            merged,
            vec![
                json!({"kind": "reasoning", "text": "先思考再"}),
                code,
                json!({"kind": "markdown", "text": "后续"}),
            ]
        );
    }

    #[test]
    fn accepts_normalized_terminal_streams() {
        assert!(parse(json!({
            "kind": "terminal",
            "command": "npm test",
            "processId": "proc-1",
            "sessionId": "shell-1",
            "streams": [{"stream": "stdout", "text": "ok", "ordinal": 0}],
            "status": "completed",
            "exitCode": 0,
            "truncation": {"capturedLines": 1, "omittedLines": 2, "capturedBytes": 2, "omittedBytes": 4},
        }))
        .is_ok());

        assert!(parse(
            json!({"kind": "terminal", "streams": [{"stream": "stdin", "text": "secret"}]})
        )
        .is_err());
        assert!(parse(json!({"kind": "terminal", "streams": [{"stream": "stdout"}]})).is_err());
        assert!(parse(json!({"kind": "terminal", "streams": [{"stream": "stdout", "text": "x", "ordinal": -1}]})).is_err());
        assert!(parse(
            json!({"kind": "terminal", "streams": [], "terminatedBy": "provider-magic"})
        )
        .is_err());
    }

    #[test]
    fn accepts_normalized_log_entries() {
        assert!(parse(json!({
            "kind": "log", "source": "worker", "processId": "proc-1",
            "entries": [{"level": "warn", "text": "slow", "ordinal": 2, "timestampConfidence": "synthetic"}],
        }))
        .is_ok());
        assert!(parse(json!({"kind": "log", "entries": []})).is_err());
        assert!(
            parse(json!({"kind": "log", "entries": [{"level": "verbose", "text": "x"}]})).is_err()
        );
        assert!(parse(json!({"kind": "log", "entries": [{"level": "info", "text": 42}]})).is_err());
        assert!(parse(json!({"kind": "log", "entries": [{"level": "info", "text": "x", "timestampConfidence": "guessed"}]})).is_err());
    }

    #[test]
    fn accepts_basic_kinds() {
        for value in [
            json!({"kind": "text", "text": "hello"}),
            json!({"kind": "thinking", "text": "private reasoning"}),
            json!({"kind": "image", "source": "https://example.test/image.png", "mimeType": "image/png"}),
            json!({"kind": "resource", "uri": "mcp://resource/1", "title": "Resource"}),
            json!({"kind": "diff", "path": "src/app.ts", "unified": "@@ -1 +1 @@"}),
            json!({"kind": "location", "path": "src/app.ts", "line": 3, "column": 4}),
            json!({"kind": "tool-result", "status": "completed", "parts": []}),
        ] {
            assert!(parse(value).is_ok());
        }
    }

    #[test]
    fn keeps_unknown_block_visible_with_truncation() {
        let raw = json!({"providerType": "future.block", "payload": "x".repeat(20_000)});
        let unknown = create_unknown_content_part("future.block", &raw, Some(256.0));
        assert_eq!(unknown.get("kind"), Some(&Value::String("unknown".into())));
        assert_eq!(
            unknown.get("originalType"),
            Some(&Value::String("future.block".into()))
        );
        let summary = unknown
            .get("summary")
            .and_then(Value::as_str)
            .expect("summary");
        assert!(summary.contains("future.block"));
        let truncation = unknown.get("truncation").expect("truncation");
        assert_eq!(truncation.get("truncated"), Some(&Value::Bool(true)));
        assert!(
            truncation
                .get("omittedBytes")
                .and_then(Value::as_i64)
                .expect("omitted")
                > 0
        );
        let raw_out = js_json_stringify(unknown.get("raw").expect("raw"));
        assert!(raw_out.len() < 2_000);
        assert!(parse_content_part(&unknown).is_ok());
    }

    #[test]
    fn rejects_malformed_shapes_with_path_and_code() {
        let issues = parse(json!({"kind": "image", "source": 42})).expect_err("must fail");
        assert_eq!(issues[0].path, vec![Value::String("source".into())]);
        assert_eq!(issues[0].code, "type.string");
        assert_eq!(issues[0].received, "number");
    }

    #[test]
    fn accepts_safe_document_metadata_but_rejects_inline_blob() {
        assert!(parse(json!({
            "kind": "document", "title": "spec.pdf", "uri": "file:///spec.pdf",
            "mimeType": "application/pdf", "hasBlob": true,
        }))
        .is_ok());
        assert!(parse(json!({"kind": "document", "title": "empty", "text": ""})).is_err());
        assert!(parse(json!({"kind": "resource", "uri": "   "})).is_err());

        for value in [
            json!({"kind": "document", "title": "private.pdf", "blob": "JVBERi0xLjQK"}),
            json!({"kind": "resource", "uri": "file:///private.pdf", "blob": "JVBERi0xLjQK"}),
        ] {
            let issues = parse(value).expect_err("blob 必须拒");
            assert!(issues
                .iter()
                .any(|issue| issue.code == "content.binary-inline"
                    && issue.path == vec![Value::String("blob".into())]));
        }
    }

    #[test]
    fn validates_canonical_media_source_boundary() {
        assert!(parse(json!({
            "kind": "image", "source": "iVBORw0KGgo=", "sourceKind": "base64", "mimeType": "image/png",
            "width": 640, "height": 480, "caption": "架构图",
        }))
        .is_ok());
        assert!(parse(json!({
            "kind": "video", "source": "C:\\media\\demo.mp4", "sourceKind": "path", "mimeType": "video/mp4",
            "durationMs": 1_500,
        }))
        .is_ok());

        assert!(parse(json!({"kind": "image", "source": "   "})).is_err());
        assert!(parse(
            json!({"kind": "image", "source": "https://safe.test/a.png", "sourceKind": "guess"})
        )
        .is_err());
        assert!(
            parse(json!({"kind": "image", "source": "https://safe.test/a.png", "width": -1}))
                .is_err()
        );
        // JSON 里没有 NaN；非数字形态走同一拒绝分支。
        assert!(parse(
            json!({"kind": "image", "source": "https://safe.test/a.png", "height": "NaN"})
        )
        .is_err());
        assert!(parse(
            json!({"kind": "audio", "source": "https://safe.test/a.png", "mimeType": "image/png"})
        )
        .is_err());
        assert!(parse(json!({
            "kind": "image", "source": "https://safe.test/a.png", "headers": {"authorization": "Bearer secret"},
        }))
        .is_err());
        assert!(parse(json!({
            "kind": "image", "source": "https://safe.test/a.png", "base64": "duplicate-payload",
        }))
        .is_err());
    }

    #[test]
    fn round_trips_unknown_raw_without_invalidating_json() {
        let unknown = create_unknown_content_part(
            "provider.unknown",
            &json!({"nested": [1, true, null]}),
            None,
        );
        assert!(parse_content_part(&unknown).is_ok());
    }

    #[test]
    fn c15_boundary_rejects_cross_family_and_incomplete_payloads() {
        assert!(
            parse(json!({"kind": "memory", "title": "missing identity", "source": "hermes"}))
                .is_err()
        );
        assert!(parse(json!({"kind": "skill", "skillId": "s", "title": "Skill", "source": "peri", "enabled": "yes"})).is_err());
        assert!(
            parse(json!({"kind": "mcp-resource", "server": "mcp", "resourceUri": ""})).is_err()
        );
        assert!(parse(json!({"kind": "artifact", "artifactId": "a", "title": "A", "uri": "artifact://a", "parts": [{"kind": "text"}]})).is_err());
        assert!(parse(json!({"kind": "memory", "memoryId": "m", "title": "M", "source": "hermes", "artifactId": "cross-family"})).is_err());
        assert!(parse(json!({"kind": "memory", "memoryId": "m", "title": "M", "source": "hermes", "status": ""})).is_err());
        assert!(parse(json!({"kind": "mcp-resource", "server": "mcp", "resourceUri": "file:///a", "title": ""})).is_err());
        assert!(parse(json!({"kind": "artifact", "artifactId": "a", "title": "A", "uri": "artifact://a", "mimeType": ""})).is_err());
        assert!(parse(json!({"kind": "artifact", "artifactId": "a", "title": "A", "uri": "artifact://a", "actions": [""]})).is_err());
    }

    #[test]
    fn c15_accepts_typed_metadata_directly() {
        assert!(parse(json!({
            "kind": "memory", "memoryId": "mem-1", "source": "hermes", "scope": "session",
            "title": "User prefers dark mode", "summary": "stored preference",
            "status": "recalled", "version": 3,
        }))
        .is_ok());
        assert!(parse(json!({
            "kind": "mcp-resource", "server": "fs-mcp", "resourceUri": "file:///docs/spec.md",
            "mimeType": "text/markdown", "connectionState": "connected",
        }))
        .is_ok());
        assert!(parse(json!({
            "kind": "artifact", "artifactId": "art-1", "title": "report.pdf", "uri": "https://example.com/report.pdf",
            "version": 2, "hasBlob": true,
        }))
        .is_ok());
        // 257 个部件超 MAX_ARTIFACT_PREVIEW_PARTS。
        let parts: Vec<Value> = (0..257)
            .map(|index| json!({"kind": "text", "text": format!("line-{index}")}))
            .collect();
        assert!(parse(json!({
            "kind": "artifact", "artifactId": "large", "title": "Large", "uri": "artifact://large",
            "parts": parts,
        }))
        .is_err());
    }

    #[test]
    fn display_hint_derives_dotted_kind_and_falls_back() {
        let part = content_part_from_display_hint(&json!({
            "displayKind": "plugin.card", "payload": {"text": "x"},
        }));
        assert_eq!(part.get("kind"), Some(&Value::String("plugin.card".into())));
        assert_eq!(part.get("text"), Some(&Value::String("x".into())));

        let fallback = content_part_from_display_hint(&json!({
            "displayKind": "plugin.card", "payload": "bad",
        }));
        // payload 非对象 → 按原始 hint 整体走 unknown。
        assert_eq!(fallback.get("kind"), Some(&Value::String("unknown".into())));
    }

    #[test]
    fn sensitive_keys_are_redacted_from_unknown_raw() {
        let unknown = create_unknown_content_part(
            "mystery",
            &json!({"apiToken": "must-not-survive", "vendorFuture": 9}),
            None,
        );
        let raw = js_json_stringify(unknown.get("raw").expect("raw"));
        assert!(!raw.contains("must-not-survive"));
        assert!(unknown.get("redactions").is_some());
    }

    #[test]
    fn js_number_semantics_survive_parse() {
        // 整值浮点规范化后 stringify 字节数与 TS 一致（"3" 而不是 "3.0"）。
        let mut value = json!(3.0);
        canonicalize_js_numbers(&mut value);
        assert_eq!(js_json_stringify(&value), "3");
        let mut value = json!(-0.0);
        canonicalize_js_numbers(&mut value);
        assert_eq!(js_json_stringify(&value), "0");
        assert_eq!(js_number_to_string(1e21), "1e+21");
        assert_eq!(js_number_to_string(0.1), "0.1");
    }
}

// ── 增量下沉（#205 线性化在部件层的对位物） ───────────────────────────────────
//
// `coalesce_*` 是「整数组重建」语义：每事件 `concat` 出累计数组再整份合并，代价
// O(累计) ⇒ 冷重放 Θ(N²)，而且它逐对合并时用 `format!("{prev}{cur}")` 复制累计文本，
// 那是同一处的第二个 Θ(N²)。下面三个函数给出**等价但增量**的形态：
// 只处理新产生的相邻对，且文本就地 `push_str`。

/// 把 `incoming` 就地下沉进**已合并态**的 `existing`。
///
/// 与 `coalesce_*(concat(existing, incoming))` 等价：合并规则只看相邻两项，而
/// `existing` 已无相邻可并对，故新增的可并对只会出现在「旧末项 × 新首项」与
/// `incoming` 内部。于是每事件只付 O(新增)。
pub fn append_parts_with_merge(
    existing: &mut Vec<Value>,
    incoming: &[Value],
    merge_one: fn(&mut Value, &Value) -> bool,
) {
    for part in incoming {
        if let Some(previous) = existing.last_mut() {
            if merge_one(previous, part) {
                continue;
            }
        }
        existing.push(part.clone());
    }
}

/// `coalesce_adjacent_display_text_parts` 的**单对**规则：并入成功返回 true。
/// 这一族按 TS 的 `{ ...previous, kind, text }` 保形，故除 kind/text 外字段原样留着。
pub fn merge_display_text_pair(previous: &mut Value, part: &Value) -> bool {
    if !(is_display_text_part(previous) && is_display_text_part(part)) {
        return false;
    }
    let previous_kind = part_kind(previous).unwrap_or("").to_string();
    let kind = if previous_kind == "markdown" || part_kind(part) == Some("markdown") {
        "markdown"
    } else {
        "text"
    };
    let incoming = part_text(part).unwrap_or("").to_string();
    if let Some(object) = previous.as_object_mut() {
        match object.get_mut("text") {
            Some(Value::String(text)) => text.push_str(&incoming),
            _ => {
                object.insert("text".to_string(), Value::String(incoming));
            }
        }
        object.insert("kind".to_string(), Value::String(kind.to_string()));
    }
    true
}

/// `coalesce_adjacent_reasoning_parts` 的**单对**规则：并入成功返回 true。
/// 与 display 族不同，这一族是**重建对象**（未知字段被丢弃），且 language 只在两侧
/// 一致时保留——这里用 `retain` 收敛到同样的键集合（serde_json 的 Map 是字典序，
/// 键序与原实现一致）。
pub fn merge_reasoning_pair(previous: &mut Value, part: &Value) -> bool {
    if !(is_reasoning_text_part(previous) && is_reasoning_text_part(part)) {
        return false;
    }
    let previous_kind = part_kind(previous).unwrap_or("").to_string();
    let current_kind = part_kind(part).unwrap_or("").to_string();
    let kind = if previous_kind == "reasoning" || current_kind == "reasoning" {
        "reasoning"
    } else if previous_kind == "thinking" || current_kind == "thinking" {
        "thinking"
    } else if previous_kind == "markdown" || current_kind == "markdown" {
        "markdown"
    } else {
        "text"
    };
    let previous_language = previous.get("language").cloned();
    let language = if previous_language.as_ref() == part.get("language") {
        previous_language
    } else {
        None
    };
    let incoming = part_text(part).unwrap_or("").to_string();
    if let Some(object) = previous.as_object_mut() {
        match object.get_mut("text") {
            Some(Value::String(text)) => text.push_str(&incoming),
            _ => {
                object.insert("text".to_string(), Value::String(incoming));
            }
        }
        object.insert("kind".to_string(), Value::String(kind.to_string()));
        retain_reasoning_shape(object);
        match language {
            Some(language) => {
                object.insert("language".to_string(), language);
            }
            None => {
                object.remove("language");
            }
        }
    }
    true
}

/// 推理族的键集合收敛（重建对象语义）：只留 kind / text / language。
fn retain_reasoning_shape(object: &mut Map<String, Value>) {
    object.retain(|key, _| key == "kind" || key == "text" || key == "language");
}

#[cfg(test)]
mod incremental_sink_tests {
    use super::*;
    use serde_json::json;

    /// 确定性伪随机（线性同余）：用例要可按种子复现，不引 rand 依赖。
    fn next(seed: &mut u64) -> u64 {
        *seed = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *seed >> 33
    }

    /// 造一段「可能相邻同类」的部件序列：同族连排与异族交错都要出现，
    /// 否则测不到「只在交界处合并」这条等价性。
    fn random_parts(seed: &mut u64, length: usize) -> Vec<Value> {
        let kinds = ["text", "markdown", "thinking", "reasoning", "code", "ansi"];
        let mut out = Vec::with_capacity(length);
        for index in 0..length {
            let kind = kinds[(next(seed) % kinds.len() as u64) as usize];
            let mut object = Map::new();
            object.insert("kind".to_string(), Value::String(kind.to_string()));
            object.insert(
                "text".to_string(),
                Value::String(format!("{kind}-{index};")),
            );
            // language 只有部分部件带，用来测 reasoning 族的「两侧一致才保留」。
            if next(seed).is_multiple_of(3) {
                object.insert("language".to_string(), Value::String("rust".to_string()));
            }
            // 噪声字段：display 族保形、reasoning 族丢弃——两条规则的分野点。
            if next(seed).is_multiple_of(4) {
                object.insert("limit".to_string(), json!(index));
            }
            out.push(Value::Object(object));
        }
        out
    }

    /// 参考实现：**整数组重建**语义（`concat` 后整份 coalesce），即被下沉版取代的那条路。
    fn reference(existing: &[Value], incoming: &[Value], reasoning: bool) -> Vec<Value> {
        let mut folded: Vec<Value> = existing.to_vec();
        folded.extend(incoming.iter().cloned());
        let merged = if reasoning {
            coalesce_adjacent_reasoning_parts(&folded)
        } else {
            coalesce_adjacent_display_text_parts(&folded)
        };
        merged.unwrap_or(folded)
    }

    /// 增量下沉必须与「整份重建」逐值等价——这是把 Θ(N²) 换成 O(新增) 的正确性前提。
    /// 用例覆盖：任意切分点（把同一序列按不同长度分批下沉）、同族连排、异族交错、
    /// language/噪声字段的有无、以及空批。
    #[test]
    fn incremental_sink_matches_full_rebuild() {
        for seed in 1..=40u64 {
            let mut state = seed;
            let sequence = random_parts(&mut state, 24);
            for chunk in 1..=6usize {
                for reasoning in [false, true] {
                    let merge_one: fn(&mut Value, &Value) -> bool = if reasoning {
                        merge_reasoning_pair
                    } else {
                        merge_display_text_pair
                    };
                    let mut in_place: Vec<Value> = Vec::new();
                    let mut rebuilt: Vec<Value> = Vec::new();
                    for slice in sequence.chunks(chunk) {
                        append_parts_with_merge(&mut in_place, slice, merge_one);
                        rebuilt = reference(&rebuilt, slice, reasoning);
                    }
                    assert_eq!(
                        Value::Array(in_place.clone()),
                        Value::Array(rebuilt),
                        "seed={seed} chunk={chunk} reasoning={reasoning}"
                    );
                }
            }
        }
    }

    /// 累计文本必须**逐字节**等于逐段拼接——`push_str` 取代 `format!` 后最容易错的就是它。
    #[test]
    fn incremental_sink_accumulates_text_byte_exactly() {
        let mut accumulated: Vec<Value> = Vec::new();
        let mut expected = String::new();
        for index in 0..64 {
            let part = json!({ "kind": "text", "text": format!("段{index}-") });
            expected.push_str(&format!("段{index}-"));
            append_parts_with_merge(
                &mut accumulated,
                std::slice::from_ref(&part),
                merge_display_text_pair,
            );
        }
        assert_eq!(accumulated.len(), 1, "同族连排应合成一个部件");
        assert_eq!(part_text(&accumulated[0]).unwrap_or(""), expected);
    }

    /// 空批与非法入参不得改变已合并态（防御路径）。
    #[test]
    fn incremental_sink_is_noop_on_empty() {
        let mut accumulated = vec![json!({ "kind": "text", "text": "a" })];
        append_parts_with_merge(&mut accumulated, &[], merge_display_text_pair);
        assert_eq!(accumulated.len(), 1);
        let merged = coalesce_adjacent_display_text_parts(&accumulated);
        assert!(merged.is_none(), "已合并态不应再产生可合并对");
    }
}
