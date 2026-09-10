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

pub fn continuation_ancestors(
    mut current: String,
    headers: &std::collections::HashMap<String, TranscriptHeader>,
) -> Vec<String> {
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

/// Codeg's pure compaction rule for already parsed entries. Consecutive plain
/// assistant/thought text updates with equal `_meta` are folded; boundaries and
/// non-text updates pass through unchanged. Returns the next compactable state.
pub fn compact_batch(
    entries: &[TranscriptEntry],
    mut compactable: bool,
) -> (Vec<TranscriptEntry>, bool) {
    let mut out = Vec::with_capacity(entries.len());
    for entry in entries {
        let mergeable =
            compactable && entry.k == EntryKind::Update && mergeable_text_kind(&entry.p).is_some();
        if !mergeable {
            if entry.k == EntryKind::Prompt {
                compactable = true;
            }
            if entry.k == EntryKind::TurnEnd {
                compactable = false;
            }
            out.push(entry.clone());
            continue;
        }
        if let Some(previous) = out.last_mut().filter(|previous| {
            previous.k == EntryKind::Update
                && mergeable_text_kind(&previous.p) == mergeable_text_kind(&entry.p)
                && previous.p.get("_meta") == entry.p.get("_meta")
        }) {
            let text = entry
                .p
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or_default();
            if let Some(existing) = previous
                .p
                .get_mut("content")
                .and_then(|c| c.get_mut("text"))
                .and_then(|t| t.as_str().map(str::to_owned))
            {
                if let Some(target) = previous
                    .p
                    .get_mut("content")
                    .and_then(|c| c.get_mut("text"))
                {
                    *target = serde_json::Value::String(format!("{existing}{text}"));
                }
            }
            previous.t = entry.t;
        } else {
            out.push(entry.clone());
        }
    }
    (out, compactable)
}

fn mergeable_text_kind(payload: &serde_json::Value) -> Option<&'static str> {
    let kind = match payload.get("sessionUpdate").and_then(|v| v.as_str()) {
        Some("agent_message_chunk") => "agent_message_chunk",
        Some("agent_thought_chunk") => "agent_thought_chunk",
        _ => return None,
    };
    let content = payload.get("content")?;
    (content.get("type").and_then(|v| v.as_str()) == Some("text")
        && content
            .get("text")
            .is_some_and(serde_json::Value::is_string))
    .then_some(kind)
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
        assert_eq!(
            parsed
                .entries
                .iter()
                .map(|entry| entry.t)
                .collect::<Vec<_>>(),
            vec![1, 3]
        );
    }

    #[test]
    fn parses_header_entries_and_skips_corrupt_lines() {
        let input = r#"{"v":1,"kind":"header","agent":"a","session_id":"s","cwd":".","started_at_ms":1}
{"t":2,"k":"update","p":{"sessionUpdate":"agent_message_chunk"}}
not-json
{"t":3,"k":"turn_end","p":{"stopReason":"end_turn"}}"#;
        let parsed = parse_transcript(input);
        assert_eq!(
            parsed.header.as_ref().map(|h| h.session_id.as_str()),
            Some("s")
        );
        assert_eq!(parsed.entries.len(), 2);
    }

    #[test]
    fn merges_newest_first_chain_oldest_header_and_entry_order() {
        let old = Transcript {
            header: Some(TranscriptHeader {
                v: 1,
                kind: "header".into(),
                agent: "a".into(),
                session_id: "old".into(),
                cwd: ".".into(),
                started_at_ms: 1,
                continues_from: None,
            }),
            entries: vec![TranscriptEntry {
                t: 1,
                k: EntryKind::Prompt,
                p: serde_json::json!(1),
            }],
        };
        let new = Transcript {
            header: Some(TranscriptHeader {
                v: 1,
                kind: "header".into(),
                agent: "a".into(),
                session_id: "new".into(),
                cwd: ".".into(),
                started_at_ms: 2,
                continues_from: Some("old".into()),
            }),
            entries: vec![TranscriptEntry {
                t: 2,
                k: EntryKind::TurnEnd,
                p: serde_json::json!(2),
            }],
        };
        let merged = merge_continuation_chain(vec![new, old]);
        assert_eq!(merged.header.unwrap().session_id, "old");
        assert_eq!(
            merged.entries.iter().map(|e| e.t).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn compacts_only_adjacent_text_updates_and_preserves_last_timestamp() {
        let entries = vec![
            TranscriptEntry {
                t: 1,
                k: EntryKind::Prompt,
                p: serde_json::json!({}),
            },
            TranscriptEntry {
                t: 2,
                k: EntryKind::Update,
                p: serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"a"}}),
            },
            TranscriptEntry {
                t: 3,
                k: EntryKind::Update,
                p: serde_json::json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"b"}}),
            },
            TranscriptEntry {
                t: 4,
                k: EntryKind::TurnEnd,
                p: serde_json::json!({}),
            },
        ];
        let (compacted, state) = compact_batch(&entries, false);
        assert!(!state);
        assert_eq!(compacted.len(), 3);
        assert_eq!(compacted[1].t, 3);
        assert_eq!(compacted[1].p["content"]["text"], "ab");
    }
}
