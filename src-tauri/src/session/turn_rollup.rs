//! #81 L2/L3：turn 单元行（turn.unit）构建与裁剪校验。
//!
//! 单元行在 kernel ingest 写入 `turn.completed|failed` 的**同一事务**内追加
//! （只加不减；生产唯一写路径是 kernel——前端 sink 自写轨无生产 offer 调用方）。
//! payload = 保序 segment 数组：相邻同类 delta（assistant.text/thinking.delta）
//! 且 identity 全字段相等合成一段（text 精确拼接、occurredAt 取 run 首条、
//! markdown 取 run 内是否出现）；tool/user/状态/unknown 行整行保留为 event 段——
//! 嵌入形状是 **EVT-01 canonical 事件**（嵌套 owner/provenance，由
//! `canonical_event_wire` 产出），与前端 `CanonicalConversationEvent` 契约同构。
//! `contentSha256` 覆盖 segments 的规范化序列化字节，L3 裁剪迁移按
//! 「重折叠 sha256 == 单元 sha256」校验通过后才删行（裁决 1：允许彻底丢弃）。
//!
//! 未终结 turn 不折叠（只在终态事件写入时触发）。

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::event_repo::{
    canonical_event_wire, parse_canonical_event, CanonicalEventRow, EventError,
};

pub(crate) const TURN_UNIT_EVENT_TYPE: &str = "turn.unit";
pub(crate) const TURN_UNIT_AGGREGATE_KIND: &str = "turn-rollup";
pub(crate) const TURN_UNIT_FOLD_SCHEME: &str = "adjacent-delta-fold-v1";

/// 终态事件类型（触发单元行构建）。
pub(crate) fn is_turn_terminal(event_type: &str) -> bool {
    event_type == "turn.completed" || event_type == "turn.failed"
}

/// 单个折叠段（构建期中间表示）。
enum Segment {
    Run {
        event_type: &'static str,
        seq_start: i64,
        seq_end: i64,
        identity: Option<Value>,
        text: String,
        occurred_at: String,
        markdown: bool,
    },
    Event(Value),
}

fn is_foldable_delta(event_type: &str) -> bool {
    static_delta_type(event_type).is_some()
}

fn static_delta_type(event_type: &str) -> Option<&'static str> {
    match event_type {
        "assistant.text.delta" | "assistant.text.delta.batch" => Some("assistant.text.delta"),
        "assistant.thinking.delta" | "assistant.thinking.delta.batch" => {
            Some("assistant.thinking.delta")
        }
        _ => None,
    }
}

fn delta_sequence_span(row: &CanonicalEventRow) -> Option<(i64, i64)> {
    if !row.event_type.ends_with(".batch") {
        return Some((row.sequence, row.sequence));
    }
    let span = row
        .typed_payload
        .as_ref()
        .and_then(|typed| typed.get("seqSpan"))
        .and_then(Value::as_array)?;
    if span.len() != 2 {
        return None;
    }
    let start = span.first().and_then(Value::as_i64)?;
    let end = span.get(1).and_then(Value::as_i64)?;
    if start < 1 || end < start || end != row.sequence {
        return None;
    }
    Some((start, end))
}

/// 折叠 turn 范围行（升序、含 terminal 行）为保序 segments。
/// 规则与前端 `canonicalEventBatch`/`canonicalUnit` 同口径：类型同类 +
/// identity 全字段相等（serde_json Value 相等与键序无关）才并入 run。
fn fold_segments(rows: &[CanonicalEventRow]) -> Vec<Segment> {
    let mut segments: Vec<Segment> = Vec::new();
    for row in rows {
        if !is_foldable_delta(&row.event_type) {
            // 整行 segment：EVT-01 canonical 事件（嵌套 owner/provenance），与前端
            // `CanonicalConversationEvent` 契约同构；raw 恒存。不得改回
            // `serde_json::to_value(row)`——那是数据库扁平列形状，会绕过前端读边界
            // 的归一化（#81 回归：重启后整轮历史丢失）。
            segments.push(Segment::Event(canonical_event_wire(row)));
            continue;
        }
        let Some((seq_start, row_seq_end)) = delta_sequence_span(row) else {
            segments.push(Segment::Event(canonical_event_wire(row)));
            continue;
        };
        let text = row
            .typed_payload
            .as_ref()
            .and_then(|typed| typed.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let markdown = row.raw_payload_json.contains("\"type\":\"markdown\"");
        if let Some(Segment::Run {
            event_type,
            seq_end,
            identity,
            text: run_text,
            markdown: run_markdown,
            ..
        }) = segments.last_mut()
        {
            let same_run = *event_type
                == static_delta_type(&row.event_type).unwrap_or(row.event_type.as_str())
                && *identity == row.identity;
            if same_run {
                *seq_end = row_seq_end;
                run_text.push_str(&text);
                *run_markdown |= markdown;
                continue;
            }
        }
        segments.push(Segment::Run {
            event_type: static_delta_type(&row.event_type).expect("checked delta"),
            seq_start,
            seq_end: row_seq_end,
            identity: row.identity.clone(),
            text,
            occurred_at: row.occurred_at.clone(),
            markdown,
        });
    }
    segments
}

fn segment_to_json(segment: &Segment) -> Value {
    match segment {
        Segment::Run {
            event_type,
            seq_start,
            seq_end,
            identity,
            text,
            occurred_at,
            markdown,
        } => {
            let mut object = serde_json::Map::new();
            object.insert("kind".into(), json!("delta-run"));
            object.insert("eventType".into(), json!(event_type));
            object.insert("seqStart".into(), json!(seq_start));
            object.insert("seqEnd".into(), json!(seq_end));
            if let Some(value) = identity {
                object.insert("identity".into(), value.clone());
            }
            object.insert("text".into(), json!(text));
            object.insert("occurredAt".into(), json!(occurred_at));
            object.insert("markdown".into(), json!(markdown));
            Value::Object(object)
        }
        Segment::Event(value) => json!({ "kind": "event", "event": value }),
    }
}

/// segments 规范化序列化的 sha256 hex（构建与 L3 裁剪校验共用同一字节源）。
fn segments_sha256(segments: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(segments.to_string().as_bytes());
    format!("{:x}", hasher.finalize())
}

/// 折叠结果（turn 范围行 → segments + sha256）。
pub(crate) struct TurnFold {
    pub(crate) segments: Value,
    pub(crate) content_sha256: String,
}

/// L3 裁剪校验用：对仍存续的 turn 范围行重折叠，产出与构建期一致的
/// segments/sha256（行集含 terminal 行，与构建时同一输入域）。
pub(crate) fn fold_turn_rows(rows: &[CanonicalEventRow]) -> TurnFold {
    let segments_value = Value::Array(fold_segments(rows).iter().map(segment_to_json).collect());
    TurnFold {
        content_sha256: segments_sha256(&segments_value),
        segments: segments_value,
    }
}

/// 构建单元行（terminal 已写入、`unit_sequence = terminal.sequence + 1`，
/// 同事务内无并发插行）。rollup 列直接填充。
pub(crate) fn build_turn_unit_row(
    terminal: &CanonicalEventRow,
    rows: &[CanonicalEventRow],
    unit_sequence: i64,
) -> Result<CanonicalEventRow, EventError> {
    let fold = fold_turn_rows(rows);
    let seq_start = rows
        .first()
        .map(|row| row.sequence)
        .unwrap_or(terminal.sequence);
    let typed_payload = json!({
        "aggregateKind": TURN_UNIT_AGGREGATE_KIND,
        "seqStart": seq_start,
        "seqEnd": terminal.sequence,
        "foldedCount": rows.len(),
        "foldScheme": TURN_UNIT_FOLD_SCHEME,
        "contentSha256": fold.content_sha256,
        "terminal": {
            "eventType": terminal.event_type,
            "occurredAt": terminal.occurred_at,
        },
        "segments": fold.segments,
    });
    let owner_key = &terminal.owner_key;
    let mut provenance = json!({
        "origin": terminal.provenance_origin,
        "trust": terminal.provenance_trust,
    });
    if let Some(provider) = &terminal.provenance_provider {
        provenance["provider"] = json!(provider);
    }
    if let Some(import_id) = &terminal.provenance_import_id {
        provenance["importId"] = json!(import_id);
    }
    let mut owner = serde_json::Map::new();
    owner.insert("profileId".into(), json!(terminal.profile_id));
    owner.insert("agentId".into(), json!(terminal.agent_id));
    owner.insert("localSessionId".into(), json!(terminal.local_session_id));
    if let Some(remote) = &terminal.remote_session_id {
        owner.insert("remoteSessionId".into(), json!(remote));
    }
    let event_json = json!({
        "eventId": format!("{owner_key}#{unit_sequence}"),
        "owner": Value::Object(owner),
        "clientGeneration": terminal.client_generation,
        "sequence": unit_sequence,
        "occurredAt": terminal.occurred_at,
        "receivedAt": terminal.occurred_at,
        "eventType": TURN_UNIT_EVENT_TYPE,
        "payloadVersion": 1,
        "schemaVersion": 1,
        "typedPayload": typed_payload,
        "rawPayload": { "kind": "turn-unit" },
        "provenance": provenance,
    });
    let mut row = parse_canonical_event(&event_json)?;
    row.rollup_seq_start = Some(seq_start);
    row.rollup_seq_end = Some(terminal.sequence);
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::event_repo::parse_canonical_event;
    use serde_json::json;

    const OWNER_KEY: &str = r#"["p1","peri","local:s1"]"#;

    /// 经 `parse_canonical_event`（生产同一入口）构造行，避免逐字段打桩。
    fn row(
        sequence: i64,
        event_type: &str,
        typed_payload: Value,
        identity: Option<Value>,
        raw_payload: Value,
    ) -> CanonicalEventRow {
        let mut event = json!({
            "eventId": format!("{OWNER_KEY}#{sequence}"),
            "owner": { "profileId": "p1", "agentId": "peri", "localSessionId": "local:s1" },
            "clientGeneration": 1,
            "sequence": sequence,
            "occurredAt": "2026-09-18T00:00:00.000Z",
            "receivedAt": "2026-09-18T00:00:00.000Z",
            "eventType": event_type,
            "payloadVersion": 1,
            "schemaVersion": 1,
            "typedPayload": typed_payload,
            "rawPayload": raw_payload,
            "provenance": { "origin": "local-observed", "trust": "authoritative", "provider": "peri" },
        });
        if let Some(value) = identity {
            event["identity"] = value;
        }
        parse_canonical_event(&event).expect("row must parse")
    }

    fn delta(sequence: i64, kind: &str, text: &str, message_id: &str) -> CanonicalEventRow {
        let session_update = if kind == "assistant.thinking.delta" {
            "agent_thought_chunk"
        } else {
            "agent_message_chunk"
        };
        row(
            sequence,
            kind,
            json!({ "text": text }),
            Some(json!({ "messageId": message_id })),
            json!({
                "source": "local:s1",
                "update": { "sessionUpdate": session_update, "content": { "type": "text", "text": text } },
            }),
        )
    }

    fn user(sequence: i64, text: &str) -> CanonicalEventRow {
        row(
            sequence,
            "user.message",
            json!({ "text": text }),
            None,
            json!({ "source": "local:s1", "update": { "sessionUpdate": "user_message_chunk", "content": { "text": text } } }),
        )
    }

    fn terminal(sequence: i64) -> CanonicalEventRow {
        row(
            sequence,
            "turn.completed",
            json!({}),
            None,
            json!({ "source": "local:s1", "update": { "sessionUpdate": "done" } }),
        )
    }

    /// 聚合行：占用 [first,last]，`sequence` 取跨度末条，`text` 为拼接结果。
    fn batch(
        sequence: i64,
        kind: &str,
        seq_start: i64,
        seq_end: i64,
        text: &str,
        chunks: usize,
        message_id: &str,
    ) -> CanonicalEventRow {
        let batch_type = format!("{kind}.batch");
        let raw_chunks: Vec<Value> = (0..chunks)
            .map(|_| {
                json!({
                    "source": "local:s1",
                    "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text } },
                })
            })
            .collect();
        row(
            sequence,
            &batch_type,
            json!({ "text": text, "foldedCount": chunks, "seqSpan": [seq_start, seq_end] }),
            Some(json!({ "messageId": message_id })),
            Value::Array(raw_chunks),
        )
    }

    fn kinds(segments: &Value) -> Vec<String> {
        segments
            .as_array()
            .expect("segments array")
            .iter()
            .map(|segment| {
                segment
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn fold_merges_adjacent_same_type_same_identity_into_one_run() {
        let rows = vec![
            user(1, "问"),
            delta(2, "assistant.text.delta", "甲", "m1"),
            delta(3, "assistant.text.delta", "乙", "m1"),
            terminal(4),
        ];
        let fold = fold_turn_rows(&rows);
        assert_eq!(kinds(&fold.segments), vec!["event", "delta-run", "event"]);
        let run = &fold.segments[1];
        assert_eq!(run["eventType"], json!("assistant.text.delta"));
        assert_eq!(run["seqStart"], json!(2));
        assert_eq!(run["seqEnd"], json!(3));
        assert_eq!(
            run["text"],
            json!("甲乙"),
            "相邻同类同 identity 必须精确拼接"
        );
    }

    #[test]
    fn fold_splits_run_on_type_switch_and_identity_change() {
        let by_type = vec![
            delta(1, "assistant.text.delta", "甲", "m1"),
            delta(2, "assistant.thinking.delta", "思", "m1"),
            delta(3, "assistant.text.delta", "乙", "m1"),
        ];
        assert_eq!(
            kinds(&fold_turn_rows(&by_type).segments),
            vec!["delta-run", "delta-run", "delta-run"]
        );

        let by_identity = vec![
            delta(1, "assistant.text.delta", "甲", "m1"),
            delta(2, "assistant.text.delta", "乙", "m2"),
        ];
        assert_eq!(
            kinds(&fold_turn_rows(&by_identity).segments),
            vec!["delta-run", "delta-run"],
            "identity 变化必须切断 run"
        );
    }

    #[test]
    fn non_delta_rows_are_kept_as_event_segments_in_order() {
        let rows = vec![
            user(1, "问"),
            delta(2, "assistant.text.delta", "甲", "m1"),
            terminal(3),
        ];
        let fold = fold_turn_rows(&rows);
        assert_eq!(
            kinds(&fold.segments),
            vec!["event", "delta-run", "event"],
            "非 delta 行必须整行保留且保序"
        );
        assert_eq!(
            fold.segments[0]["event"]["eventType"],
            json!("user.message")
        );
        assert_eq!(
            fold.segments[2]["event"]["eventType"],
            json!("turn.completed")
        );
    }

    #[test]
    fn build_turn_unit_row_sets_sequence_span_rollup_and_terminal() {
        let rows = vec![
            user(1, "问"),
            delta(2, "assistant.text.delta", "甲", "m1"),
            terminal(3),
        ];
        let unit = build_turn_unit_row(rows.last().unwrap(), &rows, 4).expect("build unit");
        assert_eq!(unit.event_type, TURN_UNIT_EVENT_TYPE);
        assert_eq!(unit.sequence, 4, "单元行占用 terminal.sequence + 1");
        assert_eq!(unit.event_id, format!("{OWNER_KEY}#4"));
        assert_eq!(unit.rollup_seq_start, Some(1));
        assert_eq!(unit.rollup_seq_end, Some(3));
        let typed = unit.typed_payload.as_ref().expect("typed payload");
        assert_eq!(typed["seqStart"], json!(1));
        assert_eq!(typed["seqEnd"], json!(3));
        assert_eq!(typed["foldedCount"], json!(3));
        assert_eq!(typed["terminal"]["eventType"], json!("turn.completed"));
        assert_eq!(typed["foldScheme"], json!(TURN_UNIT_FOLD_SCHEME));
    }

    #[test]
    fn content_sha256_is_deterministic_and_covers_run_text() {
        let rows = vec![
            user(1, "问"),
            delta(2, "assistant.text.delta", "甲", "m1"),
            terminal(3),
        ];
        assert_eq!(
            fold_turn_rows(&rows).content_sha256,
            fold_turn_rows(&rows).content_sha256
        );

        let changed = vec![
            user(1, "问"),
            delta(2, "assistant.text.delta", "乙", "m1"),
            terminal(3),
        ];
        assert_ne!(
            fold_turn_rows(&rows).content_sha256,
            fold_turn_rows(&changed).content_sha256,
            "正文变化必须反映到 sha256"
        );
    }

    #[test]
    fn is_turn_terminal_matches_only_terminal_types() {
        assert!(is_turn_terminal("turn.completed"));
        assert!(is_turn_terminal("turn.failed"));
        assert!(!is_turn_terminal("turn.unit"));
        assert!(!is_turn_terminal("assistant.text.delta"));
        assert!(!is_turn_terminal("assistant.text.delta.batch"));
    }

    /// **等价性约束**：聚合行与它覆盖的原始 chunk 折叠结果必须逐字节相同。
    ///
    /// 这是 T1/T3 的关键等价性，也是"L3 裁剪后重折叠 sha 不变"的前提。当前
    /// `*.delta.batch` 通过 `static_delta_type` 映射回基础 delta 类型。聚合行的
    /// `typedPayload.text` 已是拼接结果、
    /// `identity`/`occurredAt` 沿用 run 首条，故折叠结果与折叠原始 chunk 必然相同。
    #[test]
    fn fold_of_aggregated_row_equals_fold_of_original_chunks() {
        let chunks = vec![
            user(1, "问"),
            delta(2, "assistant.text.delta", "甲", "m1"),
            delta(3, "assistant.text.delta", "乙", "m1"),
            terminal(4),
        ];
        let aggregated = vec![
            user(1, "问"),
            batch(3, "assistant.text.delta", 2, 3, "甲乙", 2, "m1"),
            terminal(4),
        ];
        let expected = fold_turn_rows(&chunks);
        let actual = fold_turn_rows(&aggregated);
        assert_eq!(
            actual.content_sha256, expected.content_sha256,
            "聚合形态与原 chunk 形态的折叠必须字节相同"
        );
        assert_eq!(actual.segments, expected.segments);
    }

    #[test]
    fn malformed_batch_span_is_preserved_as_an_event_segment() {
        let malformed = batch(3, "assistant.text.delta", 2, 4, "甲乙", 2, "m1");
        let fold = fold_turn_rows(&[malformed]);
        assert_eq!(kinds(&fold.segments), vec!["event"]);
        assert_eq!(
            fold.segments[0]["event"]["eventType"],
            json!("assistant.text.delta.batch")
        );
    }
}
