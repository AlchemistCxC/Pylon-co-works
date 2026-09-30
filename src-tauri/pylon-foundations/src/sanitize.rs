//! 公共脱敏模块：敏感 key 表 + 值内容检测（regex）+ 递归 sanitize（策略参数化）。
//! R21：合并 export.rs（C1）与 runtime_log.rs（A12/R19）的脱敏实现，语义统一。

use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

pub const REDACTED: &str = "[REDACTED]";
const MAX_MESSAGE_BYTES: usize = 8 * 1024;

/// runtime_log 语义 key 表：敏感 key 的值整体 REDACTED 替换。
/// O26：token/apikey/api_key 改为精确或后缀匹配（tokensTotal 等共享后缀名不再误伤）；
/// `content` 移出精确表（值内容由 sanitize_value_content 兜底）。
pub fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "password",
        "secret",
        "authorization",
        "headers",
        "header",
        "prompt",
        "persona",
        "rawinput",
        "rawoutput",
        "attachment",
        "env",
    ]
    .iter()
    .any(|part| key == *part)
        || key.ends_with("token")
        || key.ends_with("apikey")
        || key.ends_with("api_key")
}

/// export 语义 key 表：敏感 key 子树整体剔除（不含 content——markdown 正文结构键）。
/// 优化-11：token/apikey/api_key 改为后缀匹配，与 runtime_log 表（O26）对齐——
/// tokensTotal/inputTokenCount/tokenStats/tokenCount 等统计键不再误伤；
/// `tokenvalue` 精确名保留（按命名即 token 值容器，且为既有基线测试契约）；
/// `secret` 保持 contains 语义（无统计键碰撞，且覆盖 client_secret/clientSecret 形态）；
/// 值内容仍由 sanitize_value_content 兜底（password/token 等值形态整体 REDACTED）。
pub fn is_export_sensitive_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "rawinput"
            | "rawoutput"
            | "prompt"
            | "persona"
            | "headers"
            | "env"
            | "authorization"
            | "password"
            | "cookie"
            | "credential"
            | "tokenvalue"
    ) || lower.ends_with("token")
        || lower.ends_with("apikey")
        || lower.ends_with("api_key")
        || lower.contains("secret")
}

static SENSITIVE_KEY_PATTERN: OnceLock<Regex> = OnceLock::new();
static BARE_SECRET_PATTERN: OnceLock<Regex> = OnceLock::new();

/// R19：敏感 key + 分隔符（半角/全角冒号等号、引号，允许中间空白）或 `bearer ` 前缀检测。
pub fn contains_sensitive_pattern(lower: &str) -> bool {
    SENSITIVE_KEY_PATTERN
        .get_or_init(|| {
            Regex::new(
                r#"(?:password|secret|token|api_key|apikey|authorization|client_secret|access_token|x-api-key|prompt|persona)\s*[:=："＝"]|bearer\s+"#,
            )
            .expect("SENSITIVE_KEY_PATTERN must compile")
        })
        .is_match(lower)
}

/// R19：裸 secret 前缀形态（sk-/ghp_/xoxb-/akia/eyj 等）检测。
/// S1：词边界锚定——`disk-usage`/`task-123`/`heyjohn` 等含子串的正常词不再误伤；
/// 调用方已 lower 化（sanitize_value_content/sanitize_message），故保持原大小写语义。
pub fn contains_bare_secret(lower: &str) -> bool {
    BARE_SECRET_PATTERN
        .get_or_init(|| {
            Regex::new(r"(^|[^a-z0-9])(sk-|ghp_|xoxb-|akia|eyj)")
                .expect("BARE_SECRET_PATTERN must compile")
        })
        .is_match(lower)
}

/// 值内容脱敏：值中若出现 secret 形态（分隔符变体/裸 secret 前缀），整体替换。
pub fn sanitize_value_content(value: &str) -> String {
    let lower = value.to_ascii_lowercase();
    if contains_sensitive_pattern(&lower) || contains_bare_secret(&lower) {
        REDACTED.to_string()
    } else {
        value.to_string()
    }
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

/// 递归 sanitize 策略。
#[derive(Clone, Copy)]
pub enum SanitizePolicy {
    /// export：敏感 key 子树剔除，字符串值内容检测（不截断）。
    Strip,
    /// runtime_log：敏感 key 值 REDACTED 替换，字符串值内容检测 + 截断。
    Redact,
}

impl SanitizePolicy {
    fn strips_sensitive_key(self) -> bool {
        matches!(self, SanitizePolicy::Strip)
    }

    fn truncates_strings(self) -> bool {
        matches!(self, SanitizePolicy::Redact)
    }

    /// key 表按策略选择：Strip 用 export 表（content 是正文结构键，不可剔除），
    /// Redact 用 runtime_log 表。
    fn key_is_sensitive(self, key: &str) -> bool {
        match self {
            SanitizePolicy::Strip => is_export_sensitive_key(key),
            SanitizePolicy::Redact => is_sensitive_key(key),
        }
    }
}

/// 递归 sanitize：敏感 key 按策略剔除/REDACTED，非敏感子树递归，字符串值内容检测。
pub fn sanitize_value(policy: SanitizePolicy, key: &str, value: Value) -> Option<Value> {
    if policy.key_is_sensitive(key) {
        return if policy.strips_sensitive_key() {
            None
        } else {
            Some(Value::String(REDACTED.to_string()))
        };
    }
    match value {
        Value::Object(object) => Some(Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key.clone(), sanitize_value(policy, &key, value)))
                .filter_map(|(key, value)| value.map(|value| (key, value)))
                .collect(),
        )),
        Value::Array(values) => Some(Value::Array(
            values
                .into_iter()
                .filter_map(|value| sanitize_value(policy, "value", value))
                .collect(),
        )),
        Value::String(value) => {
            let value = sanitize_value_content(&value);
            let value = if policy.truncates_strings() {
                truncate(value, MAX_MESSAGE_BYTES)
            } else {
                value
            };
            Some(Value::String(value))
        }
        other => Some(other),
    }
}

/// 消息 sanitize（runtime_log 语义：整体 REDACTED 或截断）。
pub fn sanitize_message(message: &str) -> String {
    let lower = message.to_ascii_lowercase();
    if contains_sensitive_pattern(&lower) || contains_bare_secret(&lower) {
        REDACTED.to_string()
    } else {
        truncate(message.to_owned(), MAX_MESSAGE_BYTES)
    }
}

/// 字段 map sanitize（runtime_log 语义）。
pub fn sanitize_fields(fields: Map<String, Value>) -> Map<String, Value> {
    fields
        .into_iter()
        .map(|(key, value)| {
            (
                key.clone(),
                sanitize_value(SanitizePolicy::Redact, &key, value),
            )
        })
        .filter_map(|(key, value)| value.map(|value| (key, value)))
        .collect()
}

/// 导出消息 sanitize（export 语义）：敏感 key 剔除 + 值内容检测。
pub fn sanitize_export_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .filter_map(|value| sanitize_value(SanitizePolicy::Strip, "message", value.clone()))
        .collect()
}

/// #444 批次③：绝对路径形态（盘符 / UNC / 根相对）→ 收窄为 `…/目录名`，避免全路径
/// 外泄；非绝对路径原样保留。逐行为镜像前端 threeSourceExport.ts `redactAbsolutePath`
/// （两侧以同一组期望值单测互钉；NUL 字节 → REDACTED 与前端一致）。
pub fn redact_absolute_path(path: &str) -> String {
    if path.contains('\0') {
        return REDACTED.to_string();
    }
    let bytes = path.as_bytes();
    let drive_absolute = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\');
    if !drive_absolute && !path.starts_with('/') && !path.starts_with('\\') {
        return path.to_string();
    }
    let trimmed = path.trim_end_matches(['/', '\\']);
    let last = trimmed
        .split(['/', '\\'])
        .rev()
        .find(|segment| !segment.is_empty());
    match last {
        Some(segment) => format!("…/{segment}"),
        None => REDACTED.to_string(),
    }
}

/// #444 批次③：export 管线第二阶段——对 sanitize 后的消息树做绝对路径收窄。
/// 对齐前端取证管线「sanitizeExportValue → 路径收窄」两段式；仅改字符串值，
/// 结构保形（对象/数组递归，其余字面量恒等）。
pub fn redact_export_absolute_paths(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|value| redact_value_paths(value.clone()))
        .collect()
}

fn redact_value_paths(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_absolute_path(&text)),
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| (key, redact_value_paths(value)))
                .collect(),
        ),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_value_paths).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn strip_policy_drops_sensitive_keys_and_redacts_string_content() {
        let value = json!({
            "password": "hunter2",
            "detail": "api_key=sk-123",
            "nested": {"safe": "kept"},
            "ok": "fine"
        });
        let sanitized = sanitize_value(SanitizePolicy::Strip, "root", value).unwrap();
        assert!(sanitized.get("password").is_none(), "敏感 key 必须剔除");
        assert_eq!(sanitized["detail"], json!(REDACTED));
        assert_eq!(sanitized["ok"], json!("fine"));
        assert_eq!(sanitized["nested"]["safe"], json!("kept"));
    }

    #[test]
    fn redact_policy_replaces_sensitive_keys_and_truncates_strings() {
        let value = json!({
            "apiKey": "sk-secret",
            "detail": "x".repeat(9000),
            "kept": {"a": "b"}
        });
        let sanitized = sanitize_value(SanitizePolicy::Redact, "root", value).unwrap();
        assert_eq!(sanitized["apiKey"], json!(REDACTED));
        assert_eq!(
            sanitized["detail"],
            json!(format!("{}...", "x".repeat(8189))),
            "非敏感字符串值必须截断"
        );
        assert_eq!(sanitized["kept"]["a"], json!("b"));
    }

    #[test]
    fn export_messages_strip_sensitive_keys_and_redact_value_content() {
        let messages = vec![json!({
            "sessionId": "s",
            "update": {"password": "x", "detail": "Bearer sk-abc", "safe": "kept"}
        })];
        let safe = sanitize_export_messages(&messages);
        let text = serde_json::to_string(&safe).unwrap();
        assert!(!text.contains("password"));
        assert!(text.contains("[REDACTED]"));
        assert!(text.contains("kept"));
    }

    #[test]
    fn redact_policy_never_drops_entries() {
        let value = json!([{"password": "x"}, "Bearer abc", {"a": 1}]);
        let sanitized = sanitize_value(SanitizePolicy::Redact, "root", value).unwrap();
        assert_eq!(sanitized[0]["password"], json!(REDACTED));
        assert_eq!(sanitized[1], json!(REDACTED));
        assert_eq!(sanitized[2]["a"], json!(1));
    }

    #[test]
    fn strip_policy_keeps_usage_stats_and_strips_token_family() {
        // 优化-11：统计键保留（与 Redact 表 O26 语义对齐）
        let value = json!({
            "tokensTotal": 123,
            "inputTokenCount": 45,
            "tokenStats": {"input": 1, "output": 2},
            "tokenCount": 7,
            "usage": {"tokensTotal": 999, "safe": "kept"},
            "password": "hunter2",
            "apiKeyToken": "sk-xyz",
            "api_key": "sk-abc",
            "client_secret": "very-secret"
        });
        let sanitized = sanitize_value(SanitizePolicy::Strip, "root", value).unwrap();
        assert_eq!(sanitized["tokensTotal"], json!(123));
        assert_eq!(sanitized["inputTokenCount"], json!(45));
        assert_eq!(sanitized["tokenStats"]["input"], json!(1));
        assert_eq!(sanitized["tokenCount"], json!(7));
        assert_eq!(sanitized["usage"]["tokensTotal"], json!(999));
        assert_eq!(sanitized["usage"]["safe"], json!("kept"));
        // token/secret 族仍剔除
        assert!(sanitized.get("password").is_none());
        assert!(sanitized.get("apiKeyToken").is_none());
        assert!(sanitized.get("api_key").is_none());
        assert!(sanitized.get("client_secret").is_none());
    }

    #[test]
    fn bare_secret_pattern_respects_word_boundaries() {
        for word in ["disk-usage", "task-123", "risk-2024", "heyjohn", "zakiah"] {
            assert_eq!(sanitize_value_content(word), word, "{word} 不得被误伤");
            assert!(
                !contains_bare_secret(&word.to_ascii_lowercase()),
                "{word} 不得命中"
            );
        }
        for secret in ["sk-abc123", "Bearer sk-abc123", "ghp_xxx", "eyJhbGci"] {
            assert_eq!(
                sanitize_value_content(secret),
                REDACTED,
                "{secret} 必须命中"
            );
        }
    }

    #[test]
    fn redact_absolute_path_mirrors_frontend_expectations() {
        // 期望值与 src/domains/export/__tests__/threeSourceExport.test.ts 同源互钉（#444 批次③）
        assert_eq!(
            redact_absolute_path("G:/Project/ws/prism-desktop"),
            "…/prism-desktop"
        );
        assert_eq!(
            redact_absolute_path("C:\\Users\\me\\prism-desktop"),
            "…/prism-desktop"
        );
        assert_eq!(
            redact_absolute_path("//server/share/prism-desktop"),
            "…/prism-desktop"
        );
        assert_eq!(redact_absolute_path("/root/proj"), "…/proj");
        assert_eq!(redact_absolute_path("relative/dir"), "relative/dir");
    }

    #[test]
    fn redact_absolute_path_separator_edges() {
        // 审查补充（#444）：裸根变体与分隔符连写
        assert_eq!(
            redact_absolute_path("C:\\"),
            "…/C:",
            "盘符反斜杠裸根与 C:/ 同判"
        );
        assert_eq!(redact_absolute_path("//"), REDACTED, "UNC 裸根无末段");
        assert_eq!(
            redact_absolute_path("a//b"),
            "a//b",
            "相对路径内的分隔符连写不触发（非绝对）"
        );
        assert_eq!(
            redact_absolute_path("/root//mixed\\dirs\\\\"),
            "…/dirs",
            "绝对路径混合/连续分隔符归一后取末段"
        );
    }

    #[test]
    fn redact_absolute_path_edges() {
        assert_eq!(
            redact_absolute_path("with\0nul"),
            REDACTED,
            "NUL 字节必须 REDACTED"
        );
        assert_eq!(redact_absolute_path("/"), REDACTED, "裸根无末段 → REDACTED");
        assert_eq!(redact_absolute_path("\\"), REDACTED);
        assert_eq!(
            redact_absolute_path("C:/"),
            "…/C:",
            "盘符根保留盘符为末段（与 TS 一致）"
        );
        assert_eq!(redact_absolute_path("C:\\foo\\"), "…/foo", "尾分隔符剥离");
        assert_eq!(
            redact_absolute_path("C:"),
            "C:",
            "无分隔符的盘符前缀不算绝对路径"
        );
        assert_eq!(redact_absolute_path(""), "");
        assert_eq!(
            redact_absolute_path("你好/世界"),
            "你好/世界",
            "多字节相对路径不误伤"
        );
        assert_eq!(
            redact_absolute_path("/single"),
            "…/single",
            "单段根路径同样收窄"
        );
    }

    #[test]
    fn redact_export_absolute_paths_walks_strings_and_keeps_shape() {
        let messages = vec![serde_json::json!({
            "sessionId": "peri-1",
            "update": {
                "sessionUpdate": "tool_call",
                "title": "read_file",
                "locations": [{ "path": "G:\\Project\\ws\\src\\main.rs", "line": 3 }],
                "detail": "see relative/dir and plain text",
                "count": 2,
                "flag": null
            }
        })];
        let narrowed = redact_export_absolute_paths(&messages);
        assert_eq!(
            narrowed[0]["update"]["locations"][0]["path"],
            json!("…/main.rs"),
            "绝对路径收窄为末段目录名"
        );
        assert_eq!(
            narrowed[0]["update"]["detail"],
            json!("see relative/dir and plain text"),
            "相对路径/普通文本原样保留"
        );
        assert_eq!(
            narrowed[0]["update"]["count"],
            json!(2),
            "非字符串字面量恒等"
        );
        assert_eq!(narrowed[0]["sessionId"], json!("peri-1"), "对象结构保形");
    }

    #[test]
    fn redact_export_absolute_paths_composes_after_strip() {
        // export_session 管线顺序（sanitize → 路径收窄）的接线表征：敏感 key 剔除
        // 先行，路径收窄只作用于幸存字段。
        let messages = vec![serde_json::json!({
            "sessionId": "peri-1",
            "update": {
                "sessionUpdate": "tool_call",
                "rawInput": "{\"path\":\"G:/secrets/key.txt\"}",
                "locations": [{ "path": "G:/secrets/visible.txt" }]
            }
        })];
        let safe = redact_export_absolute_paths(&sanitize_export_messages(&messages));
        let text = serde_json::to_string(&safe).unwrap();
        assert!(!text.contains("rawInput"), "敏感 key 剔除先行");
        assert!(!text.contains("secrets"), "幸存字段中的绝对路径必须收窄");
        assert!(text.contains("…/visible.txt"));
    }
}
