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
    let mut out = Transcript::default();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // A header is distinguished by its `kind` field, not its position.
        if out.header.is_none() {
            if let Some(header) = parse_header_line(line) {
                out.header = Some(header);
                continue;
            }
        }
        if let Ok(entry) = serde_json::from_str::<TranscriptEntry>(line) {
            out.entries.push(entry);
        }
    }
    out
}

fn parse_header_line(line: &str) -> Option<TranscriptHeader> {
    let header = serde_json::from_str::<TranscriptHeader>(line).ok()?;
    (header.kind == "header" && header.v == TRANSCRIPT_SCHEMA_VERSION).then_some(header)
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
    fn parser_keeps_first_supported_header_without_losing_entries() {
        let content = [
            serde_json::json!({"v":99,"kind":"header","agent":"a","session_id":"future","cwd":".","started_at_ms":0}),
            serde_json::json!({"t":1,"k":"prompt","p":[]}),
            serde_json::json!({"v":1,"kind":"header","agent":"a","session_id":"first","cwd":".","started_at_ms":1}),
            serde_json::json!({"v":1,"kind":"header","agent":"a","session_id":"second","cwd":".","started_at_ms":2}),
            serde_json::json!({"t":3,"k":"turn_end","p":{"stopReason":"end_turn"}}),
        ].iter().map(ToString::to_string).collect::<Vec<_>>().join("\n");
        let parsed = parse_transcript(&content);
        assert_eq!(parsed.header.unwrap().session_id, "first");
        assert_eq!(parsed.entries.iter().map(|entry| entry.t).collect::<Vec<_>>(), vec![1, 3]);
    }

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

    #[test]
    fn merges_newest_first_chain_oldest_header_and_entry_order() {
        let old = Transcript {
            header: Some(TranscriptHeader {
                v: 1, kind: "header".into(), agent: "a".into(), session_id: "old".into(),
                cwd: ".".into(), started_at_ms: 1, continues_from: None,
            }),
            entries: vec![TranscriptEntry { t: 1, k: EntryKind::Prompt, p: serde_json::json!(1) }],
        };
        let new = Transcript {
            header: Some(TranscriptHeader {
                v: 1, kind: "header".into(), agent: "a".into(), session_id: "new".into(),
                cwd: ".".into(), started_at_ms: 2, continues_from: Some("old".into()),
            }),
            entries: vec![TranscriptEntry { t: 2, k: EntryKind::TurnEnd, p: serde_json::json!(2) }],
        };
        let merged = merge_continuation_chain(vec![new, old]);
        assert_eq!(merged.header.unwrap().session_id, "old");
        assert_eq!(merged.entries.iter().map(|e| e.t).collect::<Vec<_>>(), vec![1, 2]);
    }
}
