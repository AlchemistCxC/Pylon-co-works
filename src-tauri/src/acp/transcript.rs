//! Pure transcript evidence reader migrated from codeg `acp_transcript.rs`.
//! Writer, persistence ownership, and provider bridges intentionally remain
//! outside this module.

use serde::{Deserialize, Serialize};

pub const TRANSCRIPT_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TranscriptHeader {
    pub v: u32,
    pub kind: String,
    pub agent: String,
    pub session_id: String,
    pub cwd: String,
    pub started_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continues_from: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Prompt,
    Update,
    TurnEnd,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TranscriptEntry {
    pub t: u64,
    pub k: EntryKind,
    pub p: serde_json::Value,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Transcript {
    pub header: Option<TranscriptHeader>,
    pub entries: Vec<TranscriptEntry>,
}

pub fn parse_transcript(content: &str) -> Transcript {
    let mut transcript = Transcript::default();
    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("kind").and_then(|v| v.as_str()) == Some("header") {
            if let Ok(header) = serde_json::from_value(value) {
                transcript.header = Some(header);
            }
            continue;
        }
        if let Ok(entry) = serde_json::from_value(value) {
            transcript.entries.push(entry);
        }
    }
    transcript
}

pub const MAX_CONTINUATION_DEPTH: usize = 512;

/// Merge already-read continuation transcripts, newest first. This is the
/// codeg chain algorithm with filesystem ownership deliberately left to the
/// caller.
pub fn merge_continuation_chain(mut chain: Vec<Transcript>) -> Transcript {
    let mut merged = Transcript::default();
    for transcript in chain.iter_mut().rev() {
        if merged.header.is_none() {
            merged.header = transcript.header.take();
        }
        merged.entries.append(&mut transcript.entries);
    }
    merged
}

pub fn continuation_ancestors(mut current: String, headers: &std::collections::HashMap<String, TranscriptHeader>) -> Vec<String> {
    let mut out = Vec::new();
    let mut visited = std::collections::HashSet::from([current.clone()]);
    while let Some(next) = headers.get(&current).and_then(|h| h.continues_from.clone()) {
        if out.len() >= MAX_CONTINUATION_DEPTH || !visited.insert(next.clone()) {
            break;
        }
        out.push(next.clone());
        current = next;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_header_entries_and_skips_corrupt_lines() {
        let input = r#"{"v":1,"kind":"header","agent":"a","session_id":"s","cwd":".","started_at_ms":1}
{"t":2,"k":"update","p":{"sessionUpdate":"agent_message_chunk"}}
not-json
{"t":3,"k":"turn_end","p":{"stopReason":"end_turn"}}"#;
        let parsed = parse_transcript(input);
        assert_eq!(parsed.header.as_ref().map(|h| h.session_id.as_str()), Some("s"));
        assert_eq!(parsed.entries.len(), 2);
    }
}
