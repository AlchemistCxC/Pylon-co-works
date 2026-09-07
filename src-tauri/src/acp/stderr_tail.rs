//! Bounded, redacted stderr evidence for an ACP connection.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use regex::Regex;

const MAX_LINES: usize = 200;
const MAX_BYTES: usize = 32 * 1024;
const MAX_LINE_BYTES: usize = 512;
const MAX_SCAN_BYTES: usize = 16 * 1024;
const MAX_DROP_ERROR_BYTES: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailScope {
    ThisTurn,
    Recent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailSlice {
    pub lines: Vec<String>,
    pub scope: TailScope,
}

#[derive(Debug, Default)]
pub struct StderrTail {
    inner: Mutex<Inner>,
}

#[derive(Debug, Default)]
struct Inner {
    lines: VecDeque<(u64, String)>,
    next: u64,
    bytes: usize,
}

impl StderrTail {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&self, raw: &str) {
        let line = strip_ansi(raw);
        let line = line.trim_end();
        if line.is_empty() {
            return;
        }
        // Bound regex work, then redact, and only then retain the bounded line.
        // Redacting after retention could leave a credential fragment at the cut.
        let line = truncate_bytes(line, MAX_SCAN_BYTES);
        let line = sanitize_diagnostic(&line);
        let line = truncate_bytes(&line, MAX_LINE_BYTES);
        if line.is_empty() {
            return;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let seq = inner.next;
        inner.next = inner.next.saturating_add(1);
        inner.bytes += line.len();
        inner.lines.push_back((seq, line));
        while inner.lines.len() > MAX_LINES || (inner.bytes > MAX_BYTES && inner.lines.len() > 1) {
            if let Some((_, dropped)) = inner.lines.pop_front() {
                inner.bytes = inner.bytes.saturating_sub(dropped.len());
            }
        }
    }

    #[allow(dead_code)]
    pub fn mark(&self) -> u64 {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).next
    }

    pub fn tail_since(&self, mark: u64, max_lines: usize, max_bytes: usize) -> TailSlice {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let recent: Vec<&String> = inner
            .lines
            .iter()
            .filter(|(seq, _)| *seq >= mark)
            .map(|(_, line)| line)
            .collect();
        let (source, scope) = if recent.is_empty() {
            (
                inner.lines.iter().map(|(_, line)| line).collect::<Vec<_>>(),
                TailScope::Recent,
            )
        } else {
            (recent, TailScope::ThisTurn)
        };
        let mut out = Vec::new();
        let mut bytes = 0;
        for line in source.iter().rev() {
            if out.len() >= max_lines || bytes + line.len() > max_bytes {
                break;
            }
            bytes += line.len();
            out.push((*line).clone());
        }
        out.reverse();
        TailSlice { lines: out, scope }
    }
}

fn truncate_bytes(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        return value.to_owned();
    }
    let mut end = 0;
    for (index, ch) in value.char_indices() {
        if index + ch.len_utf8() > limit {
            break;
        }
        end = index + ch.len_utf8();
    }
    let mut out = value[..end].to_owned();
    out.push('…');
    out
}

fn strip_ansi(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            Some(']') => {
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            Some(_) | None => {}
        }
    }
    out
}

fn denylist() -> &'static Vec<(Regex, &'static str)> {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        [
            (r"(?i)\bsk-\S+", "sk-***"),
            (r"(?i)\bghp_\S+", "ghp_***"),
            (r"(?i)\bxoxb-\S+", "xoxb-***"),
            (r"(?i)\bauthorization\s*[:=]\s*.*", "Authorization: ***"),
            (r"(?i)\b(set-)?cookie\s*[:=]\s*.*", "${1}cookie: ***"),
            (r"(?i)\bbearer\s+[A-Za-z0-9._\-]{12,}", "Bearer ***"),
            (r"(?i)\b(api[_\-]?key|access[_\-]?token|auth[_\-]?token|refresh[_\-]?token|id[_\-]?token|client[_\-]?secret|secret|passwd|password|private[_\-]?key)\b\s*[:=]\s*\S+", "$1=***"),
            (r"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/\s:@]+:[^/\s@]+@", "${1}***:***@"),
            (r"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/\s:@]+:[^/\s@]{16,}", "${1}***:***"),
            (r"sk-[A-Za-z0-9_\-]{12,}", "sk-***"),
            (r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}", "${1}_***"),
            (r"\bxox[abprs]-[A-Za-z0-9\-]{10,}", "xox*-***"),
            (r"\bAKIA[0-9A-Z]{16}\b", "AKIA***"),
            (r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+", "<jwt ***>"),
            (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "-----BEGIN PRIVATE KEY (redacted)-----"),
        ].into_iter().filter_map(|(pattern, replacement)| {
            Regex::new(pattern).ok().map(|regex| (regex, replacement))
        }).collect()
    })
}

/// Redact credential-shaped text before it can reach UI or remote diagnostics.
pub fn sanitize_diagnostic(value: &str) -> String {
    denylist()
        .iter()
        .fold(value.to_owned(), |text, (regex, replacement)| {
            regex.replace_all(&text, *replacement).into_owned()
        })
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

const SAFE_EXPECT_PHRASES: &[&str] = &[
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "usize",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "isize",
    "f32",
    "f64",
    "bool",
    "char",
    "string",
    "str",
    "unit",
    "option",
    "seq",
    "map",
    "integer",
    "boolean",
    "null",
    "byte array",
    "floating point number",
    "a string",
    "an integer",
    "a sequence",
    "a map",
    "a boolean",
    "a borrowed string",
    "a byte array",
    "a character",
    "unit struct",
    "newtype struct",
];
const SAFE_SCHEMA_IDENTS: &[&str] = &[
    "sessionId",
    "sessionUpdate",
    "update",
    "content",
    "role",
    "toolCallId",
    "toolCall",
    "status",
    "kind",
    "title",
    "rawInput",
    "rawOutput",
    "entries",
    "used",
    "size",
    "stopReason",
    "meta",
    "agent_message_chunk",
    "agent_thought_chunk",
    "user_message_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "usage_update",
    "current_mode_update",
    "available_commands_update",
    "session_info_update",
    "config_option_update",
    "SessionNotification",
    "SessionUpdate",
    "ContentBlock",
    "ToolCall",
    "ToolCallUpdate",
];

fn safe_expectation(value: &str) -> bool {
    let value = value.trim().trim_end_matches(['.', ',']);
    if SAFE_EXPECT_PHRASES.contains(&value) {
        return true;
    }
    for prefix in ["struct ", "enum ", "unit variant ", "struct variant "] {
        if let Some(name) = value.strip_prefix(prefix) {
            return SAFE_SCHEMA_IDENTS.contains(&name.trim());
        }
    }
    let Some(list) = value.strip_prefix("one of ") else {
        return false;
    };
    let mut any = false;
    for item in list.split(',') {
        let Some(name) = item
            .trim()
            .strip_prefix('`')
            .and_then(|v| v.strip_suffix('`'))
        else {
            return false;
        };
        if !SAFE_SCHEMA_IDENTS.contains(&name) {
            return false;
        }
        any = true;
    }
    any
}

/// Reduce parser errors to a payload-free, bounded summary (default deny).
pub fn summarize_parser_error(error: &str) -> String {
    let first = collapse_whitespace(error.lines().next().unwrap_or("").trim());
    let position = Regex::new(r"\bat line \d+ column \d+")
        .ok()
        .and_then(|regex| regex.find(&first).map(|m| m.as_str().to_owned()));
    let body = if let Some(caps) = Regex::new(r"^missing field \\`(?P<field>[^\\`]*)\\`")
        .ok()
        .and_then(|r| r.captures(&first))
    {
        let field = caps.name("field").map(|m| m.as_str()).unwrap_or("");
        if SAFE_SCHEMA_IDENTS.contains(&field) {
            format!("missing field `{field}`")
        } else {
            "missing field (redacted)".to_owned()
        }
    } else if let Some((category, payload, captures)) = [
        (
            "invalid type",
            false,
            "^invalid type:.*?,\\s*expected\\s+(?P<exp>.+)$",
        ),
        (
            "invalid value",
            false,
            "^invalid value:.*?,\\s*expected\\s+(?P<exp>.+)$",
        ),
        (
            "invalid length",
            false,
            "^invalid length.*?,\\s*expected\\s+(?P<exp>.+)$",
        ),
        (
            "unknown variant",
            true,
            "^unknown variant\\s+`[^`]*`,\\s*expected\\s+(?P<exp>.+)$",
        ),
        (
            "unknown field",
            true,
            "^unknown field\\s+`[^`]*`,\\s*expected\\s+(?P<exp>.+)$",
        ),
    ]
    .iter()
    .find_map(|(category, payload, pattern)| {
        Regex::new(pattern)
            .ok()
            .and_then(|r| r.captures(&first).map(|c| (*category, *payload, c)))
    }) {
        let exp = captures.name("exp").map(|m| m.as_str()).unwrap_or("");
        let exp = Regex::new(r"\bat line \d+ column \d+")
            .ok()
            .map(|r| r.replace(exp, "").into_owned())
            .unwrap_or_else(|| exp.to_owned());
        let exp = exp.trim().trim_end_matches(',').trim();
        if safe_expectation(exp) {
            if payload {
                format!("{} (redacted), expected {}", category, exp)
            } else {
                format!("{}, expected {}", category, exp)
            }
        } else {
            format!("{} (redacted)", category)
        }
    } else if let Some(phrase) = [
        "EOF while parsing",
        "trailing characters",
        "expected value",
        "key must be a string",
        "control character",
        "invalid unicode code point",
        "number out of range",
        "recursion limit exceeded",
    ]
    .iter()
    .find(|p| first.starts_with(**p))
    {
        (*phrase).to_owned()
    } else {
        "unrecognized parse error (redacted)".to_owned()
    };
    let mut out = body;
    if let Some(position) = position {
        out.push(' ');
        out.push_str(&position);
    }
    truncate_bytes(&sanitize_diagnostic(&out), MAX_DROP_ERROR_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_recent_lines_and_marks_scope() {
        let tail = StderrTail::new();
        let mark = tail.mark();
        tail.push("ready");
        let slice = tail.tail_since(mark, 10, 100);
        assert_eq!(slice.scope, TailScope::ThisTurn);
        assert_eq!(slice.lines, vec!["ready"]);
    }

    #[test]
    fn falls_back_to_recent_and_redacts_credentials() {
        let tail = StderrTail::new();
        tail.push("failure token sk-live-secret");
        let slice = tail.tail_since(99, 10, 100);
        assert_eq!(slice.scope, TailScope::Recent);
        assert!(!slice.lines[0].contains("sk-live-secret"));
        assert!(slice.lines[0].contains("sk-***"));
    }

    #[test]
    fn redacts_headers_uris_and_private_keys() {
        for (input, leaked) in [
            ("Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"),
            ("connect https://user:hunter2@example.com/x", "hunter2"),
            ("-----BEGIN RSA PRIVATE KEY-----", "RSA PRIVATE KEY"),
        ] {
            let safe = sanitize_diagnostic(input);
            assert!(!safe.contains(leaked), "secret leaked in {safe:?}");
        }
    }

    #[test]
    fn redacts_before_retained_length_cut() {
        let tail = StderrTail::new();
        let prefix = "x".repeat(MAX_LINE_BYTES - 10);
        tail.push(&format!("{prefix}sk-live-abcdefghijklmnopqrstuvwxyz"));
        let line = &tail.tail_since(0, 1, 4096).lines[0];
        assert!(!line.contains("sk-live"));
        assert!(line.contains("sk-***"));
    }

    #[test]
    fn parser_summary_is_default_deny_and_keeps_safe_shape() {
        assert_eq!(
            summarize_parser_error(
                "invalid type: string \"secret\", expected u64 at line 1 column 4"
            ),
            "invalid type, expected u64 at line 1 column 4"
        );
        assert_eq!(
            summarize_parser_error("unknown field `secret`, expected `sessionUpdate`"),
            "unknown field (redacted)"
        );
        assert_eq!(
            summarize_parser_error("custom parser failed on sk-live-abcdefghijklmnop"),
            "unrecognized parse error (redacted)"
        );
    }

    #[test]
    fn parser_summary_drops_suffix_after_safe_syntax_prefix() {
        assert_eq!(
            summarize_parser_error(
                "EOF while parsing confidential prompt: sk-live-abcdefghijklmnop"
            ),
            "EOF while parsing"
        );
    }
}
