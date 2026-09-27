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

pub const TURN_UNIT_EVENT_TYPE: &str = "turn.unit";
pub const TURN_UNIT_AGGREGATE_KIND: &str = "turn-rollup";
/// #380-b：当前折叠方案。v2 = v1 的相邻 delta 折叠 **+** 「累积式工具拍压缩」。
pub const TURN_UNIT_FOLD_SCHEME: &str = "adjacent-delta-fold-v2";
/// v1：只有相邻 delta 折叠（v2 之前的所有单元行都用它算 sha256）。
pub const TURN_UNIT_FOLD_SCHEME_V1: &str = "adjacent-delta-fold-v1";

/// #380-b 压缩对象：工具中间拍。
pub const TOOL_CALL_UPDATED_EVENT_TYPE: &str = "tool.call.updated";

/// 终态事件类型（触发单元行构建）。
pub fn is_turn_terminal(event_type: &str) -> bool {
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
    /// #380-b：同一 `toolCallId` 的**累积式**连续拍压成一段——保留末拍的整行 canonical 事件
    /// （`event`）+ 覆盖跨度 + 拍数。中间拍在交付面上被末拍取代（这正是投影语义）。
    ToolRun {
        seq_start: i64,
        seq_end: i64,
        identity: Option<Value>,
        folded_count: usize,
        occurred_at: String,
        event: Value,
    },
    Event(Value),
}

fn is_foldable_delta(event_type: &str) -> bool {
    static_delta_type(event_type).is_some()
}

/// delta → 基础静态类型映射；`*.batch` 行映射回其基础 delta（#205：读侧尾部折叠
/// 与单元折叠共用同一口径，`event_repo::fold_adjacent_delta_runs` 复用本函数）。
pub fn static_delta_type(event_type: &str) -> Option<&'static str> {
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
///
/// `allow_tool_runs`（#380-b，方案 v2 起）额外允许把**累积式**的连续工具拍压成一段：
/// 判据是「后一拍正文以前一拍正文为前缀」——满足时末拍完全取代中间拍（投影语义本就如此），
/// 压缩**不丢任何可见内容**；不满足（增量式回传）时一拍都不折，行原样保留为 event 段。
fn fold_segments(rows: &[CanonicalEventRow], allow_tool_runs: bool) -> Vec<Segment> {
    let mut segments: Vec<Segment> = Vec::new();
    let mut index = 0usize;
    while index < rows.len() {
        let row = &rows[index];
        if allow_tool_runs && row.event_type == TOOL_CALL_UPDATED_EVENT_TYPE {
            if let Some((end, last_event)) = tool_run_at(rows, index) {
                segments.push(Segment::ToolRun {
                    seq_start: row.sequence,
                    seq_end: rows[end].sequence,
                    identity: row.identity.clone(),
                    folded_count: end - index + 1,
                    occurred_at: rows[end].occurred_at.clone(),
                    event: last_event,
                });
                index = end + 1;
                continue;
            }
        }
        if !is_foldable_delta(&row.event_type) {
            // 整行 segment：EVT-01 canonical 事件（嵌套 owner/provenance），与前端
            // `CanonicalConversationEvent` 契约同构；raw 恒存。不得改回
            // `serde_json::to_value(row)`——那是数据库扁平列形状，会绕过前端读边界
            // 的归一化（#81 回归：重启后整轮历史丢失）。
            segments.push(Segment::Event(canonical_event_wire(row)));
            index += 1;
            continue;
        }
        let Some((seq_start, row_seq_end)) = delta_sequence_span(row) else {
            segments.push(Segment::Event(canonical_event_wire(row)));
            index += 1;
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
                index += 1;
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
        index += 1;
    }
    segments
}

/// #380-b：从 `start` 起尝试吞掉一段**累积式**工具拍。
///
/// 返回 `(末拍下标, 末拍的 EVT-01 行)`；不满足压缩条件（单拍 / identity 或 sequence 不连续 /
/// 出现非 `tool.call.updated` / 正文不是前缀扩展 / 正文读不出来）返回 `None`，调用方按原样
/// 保留整行 segment。压缩的安全性来自两条判据，缺一不可：
///
/// 1. **正文前缀扩展**：末拍正文包含中间拍的全部正文 ⇒ 丢弃中间拍不改变可见正文；
/// 2. **键集不回缩**：每一拍的 raw `update` 键集都必须是**末拍键集的子集**。
///    理由不是正文而是**投影的 previous 回退**：`workbenchProjector` 的工具节点对
///    `title`/`kind`/`semanticKind`/`parentToolUseId`/`canonicalName`/`rawInput`/`name` 等
///    身份与展示字段走 `previous?.X` 惰性回退——逐拍投影下「首拍给了 title、后拍省略」仍能显示，
///    折成末拍一行后 previous 链消失、这些字段就没了。要求键集不回缩即可保证「末拍自己带全」，
///    于是两条路径的节点字段逐个相同。（评审反例：beat1 带 title/kind、beat2 只带 status+content
///    ⇒ 键集回缩 ⇒ 本判据拒绝折叠。）
///
/// 放置序由读侧负责：`tool-run` 展开出的信封序取 `seqStart`（创建时刻事实），与逐拍路径的
/// 「活动节点在首拍处创建」一致（见 `expandCanonicalUnitRow`）。
fn tool_run_at(rows: &[CanonicalEventRow], start: usize) -> Option<(usize, Value)> {
    let first = rows.get(start)?;
    if first.event_type != TOOL_CALL_UPDATED_EVENT_TYPE {
        return None;
    }
    let mut text = tool_beat_text(first)?;
    let mut keys = raw_update_keys(first)?;
    let mut end = start;
    while let Some(next) = rows.get(end + 1) {
        if next.event_type != TOOL_CALL_UPDATED_EVENT_TYPE
            || next.sequence != rows[end].sequence + 1
            || next.identity != first.identity
        {
            break;
        }
        let Some(next_text) = tool_beat_text(next) else {
            break;
        };
        if !next_text.starts_with(&text) {
            break;
        }
        let Some(next_keys) = raw_update_keys(next) else {
            break;
        };
        // 键集只能长大：末拍必须涵盖此前每一拍出现过的键（否则该键在折叠后消失）。
        if !next_keys.is_superset(&keys) {
            break;
        }
        text = next_text;
        keys = next_keys;
        end += 1;
    }
    if end == start {
        // 单拍压缩没有收益（反而多一层间接），保持整行 segment。
        return None;
    }
    Some((end, canonical_event_wire(&rows[end])))
}

/// raw `update` 对象的键集（读不出来返回 `None` ⇒ 不折）。
fn raw_update_keys(row: &CanonicalEventRow) -> Option<std::collections::BTreeSet<String>> {
    let raw: Value = serde_json::from_str(&row.raw_payload_json).ok()?;
    let update = raw.get("update")?.as_object()?;
    Some(update.keys().cloned().collect())
}

/// 工具拍正文：**先读 raw 的 `update.content[*].text`**（与工作台投影读的就是这份 wire 一致），
/// 退化到 typed 的 `tool.contentBlocks[*].content.text`。两份都读不出来返回 `None` ⇒ 不折。
fn tool_beat_text(row: &CanonicalEventRow) -> Option<String> {
    if let Ok(raw) = serde_json::from_str::<Value>(&row.raw_payload_json) {
        if let Some(text) = content_parts_text(raw.pointer("/update/content")) {
            return Some(text);
        }
    }
    let typed = row.typed_payload.as_ref()?;
    content_parts_text(typed.pointer("/tool/contentBlocks"))
}

/// `[{text}]`（wire content）与 `[{content:{text}}]`（contentBlocks）两种形状的正文拼接。
fn content_parts_text(value: Option<&Value>) -> Option<String> {
    let parts = value?.as_array()?;
    let mut text = String::new();
    let mut found = false;
    for part in parts {
        let candidate = part
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| part.pointer("/content/text").and_then(Value::as_str));
        if let Some(candidate) = candidate {
            text.push_str(candidate);
            found = true;
        }
    }
    found.then_some(text)
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
        Segment::ToolRun {
            seq_start,
            seq_end,
            identity,
            folded_count,
            occurred_at,
            event,
        } => {
            let mut object = serde_json::Map::new();
            object.insert("kind".into(), json!("tool-run"));
            object.insert("eventType".into(), json!(TOOL_CALL_UPDATED_EVENT_TYPE));
            object.insert("seqStart".into(), json!(seq_start));
            object.insert("seqEnd".into(), json!(seq_end));
            object.insert("foldedCount".into(), json!(folded_count));
            object.insert("occurredAt".into(), json!(occurred_at));
            if let Some(value) = identity {
                object.insert("identity".into(), value.clone());
            }
            // 末拍的整行 canonical 事件（EVT-01，与 `event` 段同形状）：读侧原样展开成
            // 一个信封，投影与「逐拍行」等价（累积式判据保证了这点）。
            object.insert("event".into(), event.clone());
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
pub struct TurnFold {
    pub segments: Value,
    pub content_sha256: String,
}

/// L3 裁剪校验用：对仍存续的 turn 范围行重折叠，产出与构建期一致的
/// segments/sha256（行集含 terminal 行，与构建时同一输入域）。
///
/// **按当前方案**重折——只适用于当前方案构建的单元；其它方案请用
/// [`fold_turn_rows_with_scheme`] 并传入单元自己记的 `foldScheme`。
pub fn fold_turn_rows(rows: &[CanonicalEventRow]) -> TurnFold {
    fold_turn_rows_with_scheme(rows, Some(TURN_UNIT_FOLD_SCHEME))
}

/// #380-b：按**单元自己记录的方案**重折叠，供 L3 裁剪校验。
///
/// 方案一变，同一批行重折出的 segments 就不同——裁剪若不认方案，旧单元（v1）会永远
/// 报 `ShaMismatch` 而**一条也删不掉**（安全但让迁移停摆）。这里显式认两个方案：
/// `v1` = 只折相邻 delta；`v2`（=`None`，视为当前）额外折累积式工具拍。
/// **未知方案**返回空 sha（必然与单元的 sha 不等）⇒ 裁剪保留行并跳过，绝不误删。
pub fn fold_turn_rows_with_scheme(rows: &[CanonicalEventRow], scheme: Option<&str>) -> TurnFold {
    let allow_tool_runs = match scheme {
        Some(TURN_UNIT_FOLD_SCHEME_V1) => false,
        Some(TURN_UNIT_FOLD_SCHEME) | None => true,
        Some(_) => {
            return TurnFold {
                segments: Value::Null,
                content_sha256: String::new(),
            }
        }
    };
    let segments_value = Value::Array(
        fold_segments(rows, allow_tool_runs)
            .iter()
            .map(segment_to_json)
            .collect(),
    );
    TurnFold {
        content_sha256: segments_sha256(&segments_value),
        segments: segments_value,
    }
}

/// 构建单元行（terminal 已写入、`unit_sequence = terminal.sequence + 1`，
/// 同事务内无并发插行）。rollup 列直接填充。
pub fn build_turn_unit_row(
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
    use crate::event_repo::parse_canonical_event;
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

    /// #380-b：同一 toolCallId 的连续工具拍（`tool.call.updated`）。
    /// `content` 逐拍累积（wire 形状与真实 provider 的 content 数组一致）。
    fn tool_beat(sequence: i64, tool_call_id: &str, text: &str) -> CanonicalEventRow {
        row(
            sequence,
            TOOL_CALL_UPDATED_EVENT_TYPE,
            json!({ "tool": { "toolCallId": tool_call_id, "status": "in_progress",
                "contentBlocks": [{ "type": "content", "content": { "type": "text", "text": text } }] } }),
            Some(json!({ "toolCallId": tool_call_id })),
            json!({ "source": "local:s1", "update": { "sessionUpdate": "tool_call_update",
                "toolCallId": tool_call_id, "content": [{ "type": "text", "text": text }] } }),
        )
    }

    #[test]
    fn cumulative_tool_beats_fold_into_one_tool_run_segment() {
        let beats = vec![
            tool_beat(1, "call-1", "aaa"),
            tool_beat(2, "call-1", "aaaaaa"),
            tool_beat(3, "call-1", "aaaaaabbb"),
        ];
        let fold = fold_turn_rows(&beats);
        assert_eq!(kinds(&fold.segments), vec!["tool-run"]);
        let segment = &fold.segments[0];
        assert_eq!(segment["foldedCount"], json!(3));
        assert_eq!(segment["seqStart"], json!(1));
        assert_eq!(segment["seqEnd"], json!(3));
        // 保留的是**末拍**整行事件（投影上等价于逐拍），正文是最终累积值
        assert_eq!(segment["event"]["sequence"], json!(3));
        assert_eq!(
            segment["event"]["rawPayload"]["update"]["content"][0]["text"],
            json!("aaaaaabbb")
        );
    }

    #[test]
    fn non_cumulative_tool_beats_are_not_folded() {
        // 增量式回传（后一拍不含前一拍正文）⇒ 压缩会丢内容，一拍都不折。
        let beats = vec![
            tool_beat(1, "call-1", "aaa"),
            tool_beat(2, "call-1", "bbb"),
            tool_beat(3, "call-1", "ccc"),
        ];
        let fold = fold_turn_rows(&beats);
        assert_eq!(kinds(&fold.segments), vec!["event", "event", "event"]);
    }

    #[test]
    fn tool_run_breaks_on_identity_gap_or_single_beat() {
        let single = fold_turn_rows(&[tool_beat(1, "call-1", "aaa")]);
        assert_eq!(kinds(&single.segments), vec!["event"], "单拍压缩没有收益");

        let other_call = vec![
            tool_beat(1, "call-1", "aaa"),
            tool_beat(2, "call-1", "aaaaaa"),
            tool_beat(3, "call-2", "aaaaaa"),
        ];
        assert_eq!(
            kinds(&fold_turn_rows(&other_call).segments),
            vec!["tool-run", "event"],
            "换 toolCallId 必须断开 run"
        );

        let gap = vec![
            tool_beat(1, "call-1", "aaa"),
            tool_beat(5, "call-1", "aaaaaa"),
        ];
        assert_eq!(
            kinds(&fold_turn_rows(&gap).segments),
            vec!["event", "event"],
            "sequence 不连续必须断开 run"
        );
    }

    #[test]
    fn v1_scheme_keeps_tool_beats_unfolded_and_hashes_differ() {
        let beats = vec![
            tool_beat(1, "call-1", "aaa"),
            tool_beat(2, "call-1", "aaaaaa"),
        ];
        let v1 = fold_turn_rows_with_scheme(&beats, Some(TURN_UNIT_FOLD_SCHEME_V1));
        assert_eq!(kinds(&v1.segments), vec!["event", "event"]);
        let v2 = fold_turn_rows_with_scheme(&beats, Some(TURN_UNIT_FOLD_SCHEME));
        assert_eq!(kinds(&v2.segments), vec!["tool-run"]);
        assert_ne!(
            v1.content_sha256, v2.content_sha256,
            "同一批行在两个方案下的 sha256 必须不同（否则 L3 裁剪会认错方案）"
        );
        // 未知方案：不可校验（空 sha ⇒ 必然 mismatch ⇒ 裁剪保留行，不误删）
        let unknown = fold_turn_rows_with_scheme(&beats, Some("adjacent-delta-fold-v9"));
        assert!(unknown.content_sha256.is_empty());
    }

    #[test]
    fn v1_rows_refold_identically_under_their_own_scheme() {
        // L3 裁剪的契约：v1 单元的行用 v1 重折必须字节相同（否则旧单元一条也删不掉）。
        let rows = vec![
            delta(1, "assistant.text.delta", "甲", "m1"),
            delta(2, "assistant.text.delta", "乙", "m1"),
            tool_beat(3, "call-1", "aaa"),
            tool_beat(4, "call-1", "aaaaaa"),
        ];
        let first = fold_turn_rows_with_scheme(&rows, Some(TURN_UNIT_FOLD_SCHEME_V1));
        let again = fold_turn_rows_with_scheme(&rows, Some(TURN_UNIT_FOLD_SCHEME_V1));
        assert_eq!(first.content_sha256, again.content_sha256);
        assert_eq!(first.segments, again.segments);
        assert_eq!(kinds(&first.segments), vec!["delta-run", "event", "event"]);
    }

    /// #380-b（评审反例）：首拍带身份/展示字段、后拍省略 ⇒ 键集回缩 ⇒ **不折**。
    /// 投影器的 `previous?.title/kind/…` 回退在逐拍路径里能让这些字段存活，折成一行就会丢。
    fn tool_beat_with_extra(
        sequence: i64,
        tool_call_id: &str,
        text: &str,
        extra: Value,
    ) -> CanonicalEventRow {
        let mut update = serde_json::json!({ "sessionUpdate": "tool_call_update", "toolCallId": tool_call_id,
            "status": "in_progress", "content": [{ "type": "text", "text": text }] });
        if let Some(object) = update.as_object_mut() {
            if let Some(extra) = extra.as_object() {
                for (key, value) in extra {
                    object.insert(key.clone(), value.clone());
                }
            }
        }
        row(
            sequence,
            TOOL_CALL_UPDATED_EVENT_TYPE,
            json!({ "tool": { "toolCallId": tool_call_id, "status": "in_progress",
                "contentBlocks": [{ "type": "content", "content": { "type": "text", "text": text } }] } }),
            Some(json!({ "toolCallId": tool_call_id })),
            json!({ "source": "local:s1", "update": update }),
        )
    }

    #[test]
    fn tool_run_refuses_when_a_beat_drops_a_key_an_earlier_beat_carried() {
        let beats = vec![
            tool_beat_with_extra(
                1,
                "call-1",
                "aaa",
                json!({ "title": "Bash", "kind": "execute" }),
            ),
            tool_beat_with_extra(2, "call-1", "aaaaaa", json!({})),
        ];
        let fold = fold_turn_rows(&beats);
        assert_eq!(
            kinds(&fold.segments),
            vec!["event", "event"],
            "键集回缩会让 title/kind 只存在于首拍 ⇒ 折叠会丢展示字段"
        );
    }

    #[test]
    fn tool_run_accepts_when_later_beats_keep_or_add_keys() {
        let beats = vec![
            tool_beat_with_extra(1, "call-1", "aaa", json!({ "title": "Bash" })),
            tool_beat_with_extra(2, "call-1", "aaaaaa", json!({ "title": "Bash" })),
            // 后拍多带一个键（键集长大）也可以：末拍涵盖前面的键集
            tool_beat_with_extra(
                3,
                "call-1",
                "aaaaaabbb",
                json!({ "title": "Bash", "kind": "execute" }),
            ),
        ];
        let fold = fold_turn_rows(&beats);
        assert_eq!(kinds(&fold.segments), vec!["tool-run"]);
        assert_eq!(fold.segments[0]["foldedCount"], json!(3));
    }
}
