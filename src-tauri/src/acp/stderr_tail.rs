//! Bounded, redacted stderr evidence for an ACP connection.

use std::collections::VecDeque;
use std::sync::Mutex;

const MAX_LINES: usize = 200;
const MAX_BYTES: usize = 32 * 1024;
const MAX_LINE_BYTES: usize = 512;

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
    pub fn new() -> Self { Self::default() }

    pub fn push(&self, raw: &str) {
        let line = redact(&strip_ansi(raw));
        let line = truncate_utf8(line.trim_end(), MAX_LINE_BYTES);
        if line.is_empty() { return; }
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

    pub fn mark(&self) -> u64 {
        self.inner.lock().unwrap_or_else(|e| e.into_inner()).next
    }

    pub fn tail_since(&self, mark: u64, max_lines: usize, max_bytes: usize) -> TailSlice {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let recent: Vec<&String> = inner.lines.iter().filter(|(seq, _)| *seq >= mark).map(|(_, line)| line).collect();
        let (source, scope) = if recent.is_empty() {
            (inner.lines.iter().map(|(_, line)| line).collect::<Vec<_>>(), TailScope::Recent)
        } else { (recent, TailScope::ThisTurn) };
        let mut out = Vec::new();
        let mut bytes = 0;
        for line in source.iter().rev() {
            if out.len() >= max_lines || bytes + line.len() > max_bytes { break; }
            bytes += line.len();
            out.push((*line).clone());
        }
        out.reverse();
        TailSlice { lines: out, scope }
    }
}

fn truncate_utf8(value: &str, limit: usize) -> String {
    if value.len() <= limit { return value.to_owned(); }
    let mut end = limit;
    while end > 0 && !value.is_char_boundary(end) { end -= 1; }
    value[..end].to_owned()
}

fn strip_ansi(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' { out.push(ch); continue; }
        match chars.next() {
            Some('[') => { for c in chars.by_ref() { if ('@'..='~').contains(&c) { break; } } }
            Some(']') => { while let Some(c) = chars.next() { if c == '\u{7}' { break; } if c == '\u{1b}' && chars.peek() == Some(&'\\') { chars.next(); break; } } }
            Some(_) | None => {}
        }
    }
    out
}

fn redact(value: &str) -> String {
    let mut out = value.to_owned();
    for marker in ["sk-", "ghp_", "xoxb-"] {
        let mut from = 0;
        while let Some(relative) = out[from..].find(marker) {
            let start = from + relative;
            let end = out[start..].find(char::is_whitespace).map(|n| start + n).unwrap_or(out.len());
            out.replace_range(start..end, &format!("{marker}***"));
            from = start + marker.len() + 3;
            if from >= out.len() { break; }
        }
    }
    out
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
}
