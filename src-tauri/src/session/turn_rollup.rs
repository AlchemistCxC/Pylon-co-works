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
    event_type == "assistant.text.delta" || event_type == "assistant.thinking.delta"
}

fn static_delta_type(event_type: &str) -> Option<&'static str> {
    match event_type {
        "assistant.text.delta" => Some("assistant.text.delta"),
        "assistant.thinking.delta" => Some("assistant.thinking.delta"),
        _ => None,
    }
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
                *seq_end = row.sequence;
                run_text.push_str(&text);
                *run_markdown |= markdown;
                continue;
            }
        }
        segments.push(Segment::Run {
            event_type: static_delta_type(&row.event_type).expect("checked delta"),
            seq_start: row.sequence,
            seq_end: row.sequence,
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
