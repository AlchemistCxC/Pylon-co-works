//! turn.unit 单元行（#81 L2）的 payload 契约与展开（TS `canonicalUnit.ts` +
//! `canonicalEventRow.ts` 的逐函数对齐）。
//!
//! 单元行由 Rust kernel 在写入 turn.completed|failed 的同一事务内追加（生产唯一
//! 写路径；只加不减）。payload = 保序 segment 数组：相邻同类 delta（identity 全字
//! 段相等）合成一段（text 精确拼接，occurredAt 取 run 首条）；tool/user/状态/unknown
//! 事件按 sequence 穿插保留为整行 segment。
//!
//! **段内事件形状**：单元载荷里的整行 segment 是**后端 canonical_events 行的形状**
//! （`canonical_event_wire`：嵌套 owner/provenance 的 EVT-01 事件；历史数据可能是
//! 扁平列形状）。两种形状都在本模块的解析边界经 [`normalize_canonical_event_row`]
//! 归一——绕过这一步会把扁平行当不可读（#81 回归：重启后整轮历史丢失，且消息投影
//! 缺 owner 抛错）。
//!
//! 读侧优先消费单元：compact 读返回「单元 + 未覆盖行」，被单元覆盖的行不再读取。
//! 展开按 segment 重建 canonical 事件（eventId = owner#seqEnd），投影结果与逐行投影
//! 逐字节等价。

use serde::Serialize;
use wasm_bindgen::prelude::*;

use super::{decode_batch, CompactEvent};
use pylon_canonical_types::CanonicalEventType;

pub const TURN_UNIT_AGGREGATE_KIND: &str = "turn-rollup";
pub const TURN_UNIT_FOLD_SCHEME: &str = "adjacent-delta-fold-v1";

#[derive(Debug, Clone, PartialEq)]
pub struct TurnUnitTerminalInfo {
    pub event_type: CanonicalEventType,
    pub occurred_at: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TurnUnitSegment {
    DeltaRun {
        event_type: CanonicalEventType,
        seq_start: i64,
        seq_end: i64,
        /// 段内 identity 原样保留（wire 形状未知，存 JSON 值）。
        identity: Option<serde_json::Value>,
        /// run 内全部 chunk 文本的精确拼接。
        text: String,
        /// run 首条的 occurredAt（消息创建 time 与思考起点都取首条）。
        occurred_at: String,
        /// run 内是否出现 markdown 内容（决定展开 part kind）。
        markdown: bool,
    },
    /// 整行 segment：tool/user/状态/unknown 的原样保留事件（raw 不丢）。解析边界已
    /// 归一为嵌套 owner 的 EVT-01 canonical 事件；扁平落盘行不会泄漏到消费方。
    EventRow { event: serde_json::Value },
}

#[derive(Debug, Clone, PartialEq)]
pub struct TurnUnitPayload {
    pub seq_start: i64,
    pub seq_end: i64,
    pub folded_count: i64,
    pub aggregate_kind: String,
    pub fold_scheme: String,
    pub content_sha256: String,
    pub terminal: TurnUnitTerminalInfo,
    pub segments: Vec<TurnUnitSegment>,
}

/// canonical_events 后端回读扁平行 → 嵌套 owner 的 canonical 事件；已是嵌套形状
/// （测试/mock/未来 wire）原样保留。缺 owner 三元组的行会被归一为 unknown 事件
/// （不抛错，调用方仍可取证）。TS `normalizeCanonicalEventRow` 的逐字段对齐。
pub fn normalize_canonical_event_row(value: &serde_json::Value) -> serde_json::Value {
    let empty = serde_json::Value::Object(serde_json::Map::new());
    let row = value
        .as_object()
        .unwrap_or_else(|| empty.as_object().expect("空对象"));

    // provenance / rawMetadata 的扁平列 → 嵌套对象（两种形状共用）。
    let provenance = || -> Option<serde_json::Value> {
        // TS：row.provenanceOrigin && row.provenanceTrust（双列齐备才建）。
        let origin = row
            .get("provenanceOrigin")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())?;
        let trust = row
            .get("provenanceTrust")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())?;
        let mut object = serde_json::Map::new();
        object.insert(
            "origin".into(),
            serde_json::Value::String(origin.to_string()),
        );
        object.insert("trust".into(), serde_json::Value::String(trust.to_string()));
        if let Some(provider) = row
            .get("provenanceProvider")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
        {
            object.insert(
                "provider".into(),
                serde_json::Value::String(provider.to_string()),
            );
        }
        if let Some(import_id) = row
            .get("provenanceImportId")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
        {
            object.insert(
                "importId".into(),
                serde_json::Value::String(import_id.to_string()),
            );
        }
        Some(serde_json::Value::Object(object))
    };
    let raw_metadata = || -> Option<serde_json::Value> {
        // TS：row.rawTruncated !== undefined（只看这一列存在与否）。
        let truncated = row.get("rawTruncated")?;
        let mut object = serde_json::Map::new();
        object.insert("truncated".into(), truncated.clone());
        object.insert(
            "originalBytes".into(),
            row.get("rawOriginalBytes")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0)
                .into(),
        );
        object.insert(
            "retainedBytes".into(),
            row.get("rawRetainedBytes")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0)
                .into(),
        );
        object.insert(
            "omittedBytes".into(),
            row.get("rawOmittedBytes")
                .and_then(serde_json::Value::as_i64)
                .unwrap_or(0)
                .into(),
        );
        if let Some(reason) = row
            .get("rawTruncationReason")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
        {
            object.insert(
                "reason".into(),
                serde_json::Value::String(reason.to_string()),
            );
        }
        Some(serde_json::Value::Object(object))
    };

    if row
        .get("owner")
        .map(|owner| !owner.is_null())
        .unwrap_or(false)
    {
        // 嵌套形状：原样保留全部字段，仅补齐 schemaVersion/provenance/rawMetadata。
        let mut out = row.clone();
        if let Some(provenance) = provenance() {
            out.insert("provenance".into(), provenance);
        }
        if let Some(raw_metadata) = raw_metadata() {
            out.insert("rawMetadata".into(), raw_metadata);
        }
        return serde_json::Value::Object(out);
    }

    // 扁平列形状：owner 三元组是平铺列（`?? ''` 兜底；remoteSessionId 缺失不落位）。
    let owner = serde_json::json!({
        "profileId": row.get("profileId").and_then(serde_json::Value::as_str).unwrap_or_default(),
        "agentId": row.get("agentId").and_then(serde_json::Value::as_str).unwrap_or_default(),
        "localSessionId": row.get("localSessionId").and_then(serde_json::Value::as_str).unwrap_or_default(),
        // TS：...(row.remoteSessionId ? { remoteSessionId } : {})——空串/null 不落位。
    });
    let mut owner = owner;
    if let Some(remote) = row
        .get("remoteSessionId")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
    {
        owner["remoteSessionId"] = serde_json::Value::String(remote.to_string());
    }
    let mut out = serde_json::Map::new();
    out.insert(
        "eventId".into(),
        row.get("eventId")
            .and_then(serde_json::Value::as_str)
            .map(|s| serde_json::Value::String(s.to_string()))
            .unwrap_or(serde_json::Value::String(String::new())),
    );
    out.insert("owner".into(), owner);
    if let Some(schema_version) = row.get("schemaVersion") {
        out.insert("schemaVersion".into(), schema_version.clone());
    }
    if let Some(provenance) = provenance() {
        out.insert("provenance".into(), provenance);
    }
    if let Some(raw_metadata) = raw_metadata() {
        out.insert("rawMetadata".into(), raw_metadata);
    }
    out.insert(
        "clientGeneration".into(),
        row.get("clientGeneration")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0)
            .into(),
    );
    out.insert(
        "sequence".into(),
        row.get("sequence")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0)
            .into(),
    );
    out.insert(
        "occurredAt".into(),
        serde_json::Value::String(
            row.get("occurredAt")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    );
    out.insert(
        "receivedAt".into(),
        serde_json::Value::String(
            row.get("receivedAt")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ),
    );
    out.insert(
        "eventType".into(),
        serde_json::Value::String(
            row.get("eventType")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
        ),
    );
    out.insert(
        "payloadVersion".into(),
        row.get("payloadVersion")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(1)
            .into(),
    );
    let not_null =
        |value: Option<&serde_json::Value>| matches!(value, Some(value) if !value.is_null());
    if not_null(row.get("identity")) {
        out.insert("identity".into(), row["identity"].clone());
    }
    if not_null(row.get("typedPayload")) {
        out.insert("typedPayload".into(), row["typedPayload"].clone());
    }
    out.insert(
        "rawPayload".into(),
        row.get("rawPayload")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    if let Some(created_at) = row.get("createdAt") {
        out.insert("createdAt".into(), created_at.clone());
    }
    serde_json::Value::Object(out)
}

fn is_safe_i64(value: &serde_json::Value) -> Option<i64> {
    // Number.isSafeInteger 的 JSON 对应物：serde_json 的 i64 恰为 ±2^63，整数精度
    // 超出 2^53 的 JSON 数字会被解析成 f64 → as_i64 为 None ⇒ 与 TS 同判。
    value.as_i64()
}

/// 解析并校验单元行 payload；形状不互洽返回 None（调用方走单行兜底，不丢证据）。
pub fn parse_turn_unit_payload(event: &CompactEvent) -> Option<TurnUnitPayload> {
    if event.event_type != CanonicalEventType::TurnUnit {
        return None;
    }
    let empty = serde_json::Value::Object(serde_json::Map::new());
    let typed = event.typed_payload.as_ref().unwrap_or(&empty);
    let seq_start = is_safe_i64(typed.get("seqStart")?)?;
    let seq_end = is_safe_i64(typed.get("seqEnd")?)?;
    let folded_count = is_safe_i64(typed.get("foldedCount")?)?;
    let segments = typed
        .get("segments")
        .and_then(serde_json::Value::as_array)?;
    if seq_start < 1 || seq_start > seq_end {
        return None;
    }
    if folded_count < 1 {
        return None;
    }
    if segments.is_empty() {
        return None;
    }
    let aggregate_kind = typed
        .get("aggregateKind")
        .and_then(serde_json::Value::as_str)?
        .to_string();
    let fold_scheme = typed
        .get("foldScheme")
        .and_then(serde_json::Value::as_str)?
        .to_string();
    let content_sha256 = typed
        .get("contentSha256")
        .and_then(serde_json::Value::as_str)?
        .to_string();
    let terminal = typed.get("terminal")?;
    let terminal_event_type = match terminal
        .get("eventType")
        .and_then(serde_json::Value::as_str)
    {
        Some("turn.completed") => CanonicalEventType::TurnCompleted,
        Some("turn.failed") => CanonicalEventType::TurnFailed,
        _ => return None,
    };
    let terminal_occurred_at = terminal
        .get("occurredAt")
        .and_then(serde_json::Value::as_str)?
        .to_string();

    let mut parsed_segments = Vec::with_capacity(segments.len());
    for segment in segments {
        let segment = segment.as_object()?;
        match segment.get("kind").and_then(serde_json::Value::as_str) {
            Some("delta-run") => {
                let event_type = match segment.get("eventType").and_then(serde_json::Value::as_str)
                {
                    Some("assistant.text.delta") => CanonicalEventType::AssistantTextDelta,
                    Some("assistant.thinking.delta") => CanonicalEventType::AssistantThinkingDelta,
                    _ => return None,
                };
                let seq_start_seg = is_safe_i64(segment.get("seqStart")?)?;
                let seq_end_seg = is_safe_i64(segment.get("seqEnd")?)?;
                if seq_start_seg < seq_start || seq_end_seg > seq_end {
                    return None;
                }
                parsed_segments.push(TurnUnitSegment::DeltaRun {
                    event_type,
                    seq_start: seq_start_seg,
                    seq_end: seq_end_seg,
                    identity: segment
                        .get("identity")
                        .filter(|identity| identity.is_object())
                        .cloned(),
                    text: segment
                        .get("text")
                        .and_then(serde_json::Value::as_str)?
                        .to_string(),
                    occurred_at: segment
                        .get("occurredAt")
                        .and_then(serde_json::Value::as_str)?
                        .to_string(),
                    markdown: match segment.get("markdown") {
                        Some(serde_json::Value::Bool(value)) => *value,
                        _ => return None,
                    },
                });
            }
            Some("event") => {
                let inner = segment.get("event")?;
                // 先在**载荷原文**上校验 sequence 存在（normalize 会把缺失的 sequence
                // 兜底为 0，先归一后校验会放行形状损坏的段），再归一为嵌套事件。
                if !inner
                    .get("sequence")
                    .map(serde_json::Value::is_number)
                    .unwrap_or(false)
                {
                    return None;
                }
                parsed_segments.push(TurnUnitSegment::EventRow {
                    event: normalize_canonical_event_row(inner),
                });
            }
            _ => return None,
        }
    }
    Some(TurnUnitPayload {
        seq_start,
        seq_end,
        folded_count,
        aggregate_kind,
        fold_scheme,
        content_sha256,
        terminal: TurnUnitTerminalInfo {
            event_type: terminal_event_type,
            occurred_at: terminal_occurred_at,
        },
        segments: parsed_segments,
    })
}

/// 展开输出项：`Event` 引用原输入行（宿主零拷贝映射），`Segment` 是重建的 canonical
/// 事件（Value 形态，语义字段与逐行存储对齐）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ExpandedItem {
    Event { index: usize },
    Segment { event: serde_json::Value },
}

/// 消息侧展开（TS `expandTurnUnitRows`）：unit 行 → segment 重建的 canonical 事件
/// （eventId 由 owner+sequence 推导，与逐行存储的行级 id 对齐）；**被任一单元覆盖的
/// 普通行一并丢弃**——因此「单元 + 被覆盖行」混入任何读取路径都不会重复投影。
/// 非 unit 且未被覆盖的行原样保留。
pub fn expand_turn_unit_rows(events: &[CompactEvent]) -> Vec<ExpandedItem> {
    let unit_ranges: Vec<(i64, i64)> = events
        .iter()
        .filter_map(|event| {
            parse_turn_unit_payload(event).map(|payload| (payload.seq_start, payload.seq_end))
        })
        .collect();
    let covered = |sequence: i64| {
        unit_ranges
            .iter()
            .any(|(start, end)| sequence >= *start && sequence <= *end)
    };

    let mut items = Vec::new();
    for (index, event) in events.iter().enumerate() {
        match parse_turn_unit_payload(event) {
            None => {
                if !unit_ranges.is_empty() && covered(event.sequence) {
                    continue;
                }
                items.push(ExpandedItem::Event { index });
            }
            Some(payload) => {
                for segment in payload.segments {
                    items.push(match segment {
                        TurnUnitSegment::EventRow { event } => ExpandedItem::Segment { event },
                        TurnUnitSegment::DeltaRun {
                            event_type,
                            seq_end,
                            identity,
                            text,
                            occurred_at,
                            ..
                        } => ExpandedItem::Segment {
                            event: build_delta_run_event(
                                event,
                                event_type,
                                seq_end,
                                identity,
                                text,
                                occurred_at,
                            ),
                        },
                    });
                }
            }
        }
    }
    items
}

/// delta-run 段 → canonical 事件（TS `createCanonicalEvent` 的字段与键序）：
/// eventId = ownerKey#seqEnd，receivedAt 取 occurredAt，typedPayload = { text }，
/// rawPayload 标记 segment 来源（取证字段：所属单元行）。有效投影流
/// （message_projection）复用同一构造，保证两条读路径逐字节一致。
pub(crate) fn build_delta_run_event(
    unit: &CompactEvent,
    event_type: CanonicalEventType,
    seq_end: i64,
    identity: Option<serde_json::Value>,
    text: String,
    occurred_at: String,
) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    out.insert(
        "eventId".into(),
        serde_json::Value::String(pylon_canonical_types::canonical_event_id(
            &unit.owner_key,
            seq_end,
        )),
    );
    out.insert("owner".into(), unit.owner.to_value());
    out.insert("clientGeneration".into(), unit.client_generation.into());
    out.insert("sequence".into(), seq_end.into());
    out.insert(
        "occurredAt".into(),
        serde_json::Value::String(occurred_at.clone()),
    );
    out.insert("receivedAt".into(), serde_json::Value::String(occurred_at));
    out.insert(
        "eventType".into(),
        serde_json::Value::String(event_type.as_str().to_string()),
    );
    out.insert("payloadVersion".into(), unit.payload_version.into());
    if let Some(identity) = identity {
        out.insert("identity".into(), identity);
    }
    out.insert("typedPayload".into(), serde_json::json!({ "text": text }));
    out.insert(
        "rawPayload".into(),
        serde_json::json!({
            "kind": "turn-unit-segment",
            "unitEventId": pylon_canonical_types::canonical_event_id(&unit.owner_key, unit.sequence),
        }),
    );
    serde_json::Value::Object(out)
}

// ── wasm 薄壳 ────────────────────────────────────────────────────────────────

/// 整页单元展开（批量形态）：帧 → 输出项数组（引用或重建事件）。
#[wasm_bindgen(js_name = expandTurnUnitRows)]
pub fn expand_turn_unit_rows_shell(frame: &[u8]) -> Result<JsValue, JsError> {
    fn inner(frame: &[u8]) -> Result<JsValue, String> {
        let events = decode_batch(frame)?;
        let items = expand_turn_unit_rows(&events);
        crate::events::to_js(&items)
    }
    inner(frame).map_err(|error| JsError::new(&error))
}

#[cfg(test)]
pub(crate) mod test_support {
    //! 单元行构造（与 TS canonicalUnit.test.ts 的 unitRowFromTurn 同构）。

    use super::*;

    /// 生产形状的单元行：跨度含用户消息与终态行（seqStart = turn 首行），单元自身占
    /// terminal.sequence + 1。shape 决定整行 segment 是嵌套 canonical 还是遗留扁平列。
    pub fn unit_row_from_turn(
        rows: &[CompactEvent],
        shape: &'static str,
        unit_sequence: i64,
    ) -> CompactEvent {
        let terminal = rows.last().expect("rows");
        let owner = &terminal.owner;
        let mut segments: Vec<serde_json::Value> = Vec::new();
        for row in rows {
            let is_delta = matches!(
                row.event_type,
                CanonicalEventType::AssistantTextDelta | CanonicalEventType::AssistantThinkingDelta
            );
            if !is_delta {
                segments.push(match shape {
                    "canonical" => {
                        let mut event = serde_json::to_value(compact_to_value(row)).expect("segment");
                        event["provenance"] = serde_json::json!({ "origin": "local-observed", "trust": "authoritative" });
                        serde_json::json!({ "kind": "event", "event": event })
                    }
                    _ => {
                        // Rust `serde_json::to_value(CanonicalEventRow)` 遗留扁平列形状。
                        serde_json::json!({
                            "kind": "event",
                            "event": {
                                "eventId": pylon_canonical_types::canonical_event_id(&row.owner_key, row.sequence),
                                "ownerKey": row.owner_key,
                                "profileId": owner.profile_id,
                                "agentId": owner.agent_id,
                                "localSessionId": owner.local_session_id,
                                "remoteSessionId": null,
                                "clientGeneration": row.client_generation,
                                "sequence": row.sequence,
                                "occurredAt": row.occurred_at,
                                "receivedAt": row.received_at,
                                "eventType": row.event_type.as_str(),
                                "payloadVersion": row.payload_version,
                                "identity": row.identity.as_ref().map(super::super::EventIdentity::to_value).unwrap_or(serde_json::Value::Null),
                                "typedPayload": row.typed_payload.clone().unwrap_or(serde_json::Value::Null),
                                "rawPayload": serde_json::from_str::<serde_json::Value>(row.raw_json.as_deref().unwrap_or("null")).unwrap_or(serde_json::Value::Null),
                                "createdAt": 0,
                                "schemaVersion": 1,
                                "provenanceOrigin": "local-observed",
                                "provenanceTrust": "authoritative",
                                "provenanceProvider": null,
                                "provenanceImportId": null,
                                "rawTruncated": false,
                                "rawOriginalBytes": 0,
                                "rawRetainedBytes": 0,
                                "rawOmittedBytes": 0,
                                "rawTruncationReason": null,
                            }
                        })
                    }
                });
                continue;
            }
            let text = row.text.clone().unwrap_or_default();
            // TS sameRun：JSON.stringify(identity ?? null) 全字相等。
            let identity_json = row
                .identity
                .as_ref()
                .map(super::super::EventIdentity::to_value)
                .unwrap_or(serde_json::Value::Null);
            let same_run = matches!(segments.last(), Some(segment)
                if segment["kind"] == "delta-run"
                    && segment["eventType"] == row.event_type.as_str()
                    && segment.get("identity").cloned().unwrap_or(serde_json::Value::Null) == identity_json);
            if same_run {
                let last = segments.last_mut().expect("last");
                last["seqEnd"] = row.sequence.into();
                let mut text_accumulated = last["text"].as_str().unwrap_or_default().to_string();
                text_accumulated.push_str(&text);
                last["text"] = serde_json::Value::String(text_accumulated);
                continue;
            }
            segments.push(serde_json::json!({
                "kind": "delta-run",
                "eventType": row.event_type.as_str(),
                "seqStart": row.sequence,
                "seqEnd": row.sequence,
                "identity": identity_json,
                "text": text,
                "occurredAt": row.occurred_at,
                "markdown": false,
            }));
        }
        let folded_count = rows.len() as i64;
        let mut unit =
            crate::events::test_support::event(CanonicalEventType::TurnUnit, unit_sequence);
        unit.owner = owner.clone();
        unit.owner_key = terminal.owner_key.clone();
        unit.occurred_at = terminal.occurred_at.clone();
        unit.received_at = terminal.received_at.clone();
        unit.typed_payload = Some(serde_json::json!({
            "aggregateKind": "turn-rollup",
            "seqStart": rows.first().expect("rows").sequence,
            "seqEnd": terminal.sequence,
            "foldedCount": folded_count,
            "foldScheme": "adjacent-delta-fold-v1",
            "contentSha256": "deadbeef",
            "terminal": { "eventType": terminal.event_type.as_str(), "occurredAt": terminal.occurred_at },
            "segments": segments,
        }));
        unit.raw_json = Some(r#"{"kind":"turn-unit"}"#.into());
        unit
    }

    /// CompactEvent → 嵌套 canonical 事件 Value（canonical 段形状构造用）。
    pub fn compact_to_value(event: &CompactEvent) -> serde_json::Value {
        let mut out = serde_json::Map::new();
        out.insert(
            "eventId".into(),
            serde_json::Value::String(pylon_canonical_types::canonical_event_id(
                &event.owner_key,
                event.sequence,
            )),
        );
        out.insert("owner".into(), event.owner.to_value());
        out.insert("clientGeneration".into(), event.client_generation.into());
        out.insert("sequence".into(), event.sequence.into());
        out.insert(
            "occurredAt".into(),
            serde_json::Value::String(event.occurred_at.clone()),
        );
        out.insert(
            "receivedAt".into(),
            serde_json::Value::String(event.received_at.clone()),
        );
        out.insert(
            "eventType".into(),
            serde_json::Value::String(event.event_type.as_str().to_string()),
        );
        out.insert("payloadVersion".into(), event.payload_version.into());
        if let Some(identity) = &event.identity {
            out.insert("identity".into(), identity.to_value());
        }
        if let Some(typed) = &event.typed_payload {
            out.insert("typedPayload".into(), typed.clone());
        }
        out.insert(
            "rawPayload".into(),
            serde_json::from_str::<serde_json::Value>(event.raw_json.as_deref().unwrap_or("null"))
                .unwrap_or(serde_json::Value::Null),
        );
        serde_json::Value::Object(out)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::events::parse_timestamp;
    use crate::events::test_support::{event, iso_of, OWNER_KEY};
    use serde_json::json;

    fn text_delta(sequence: i64, text: &str) -> CompactEvent {
        let mut delta =
            crate::events::batch_rules::test_support::text_delta(sequence, text, "msg-1");
        delta.occurred_at =
            iso_of(parse_timestamp("2026-09-14T00:00:00.000Z").unwrap() + sequence * 1000);
        delta.received_at = delta.occurred_at.clone();
        delta.occurred_at_ms = parse_timestamp(&delta.occurred_at);
        delta
    }

    fn user_row(sequence: i64, text: &str) -> CompactEvent {
        let mut user = crate::events::batch_rules::test_support::user_message(sequence, text);
        user.occurred_at =
            iso_of(parse_timestamp("2026-09-14T00:00:00.000Z").unwrap() + sequence * 1000);
        user.received_at = user.occurred_at.clone();
        user.occurred_at_ms = parse_timestamp(&user.occurred_at);
        user
    }

    fn done_row(sequence: i64) -> CompactEvent {
        let mut done = crate::events::batch_rules::test_support::done(sequence);
        done.occurred_at =
            iso_of(parse_timestamp("2026-09-14T00:00:00.000Z").unwrap() + sequence * 1000);
        done.received_at = done.occurred_at.clone();
        done.occurred_at_ms = parse_timestamp(&done.occurred_at);
        done
    }

    /// 语义投影（对齐 TS canonicalUnit.test.ts 的 semantics：投影负载字段必须一致，
    /// 额外取证字段允许保留）。
    fn semantics_of(event: &serde_json::Value) -> serde_json::Value {
        json!({
            "eventId": event.get("eventId"),
            "owner": event.get("owner"),
            "sequence": event.get("sequence"),
            "occurredAt": event.get("occurredAt"),
            "receivedAt": event.get("receivedAt"),
            "eventType": event.get("eventType"),
            "payloadVersion": event.get("payloadVersion"),
            "identity": event.get("identity").unwrap_or(&serde_json::Value::Null),
            "typedPayload": event.get("typedPayload").unwrap_or(&serde_json::Value::Null),
            "rawPayload": event.get("rawPayload").unwrap_or(&serde_json::Value::Null),
        })
    }

    fn expanded_semantics(events: &[CompactEvent]) -> Vec<serde_json::Value> {
        expand_turn_unit_rows(events)
            .into_iter()
            .map(|item| match item {
                ExpandedItem::Event { index } => semantics_of(&compact_to_value(&events[index])),
                ExpandedItem::Segment { event } => semantics_of(&event),
            })
            .collect()
    }

    #[test]
    fn nested_owner_and_legacy_flat_segments_both_normalize() {
        // 嵌套 owner 与遗留扁平段载荷都归一为 canonical 事件（#81 回归锁定）。
        let rows = vec![user_row(1, "问题"), text_delta(2, "答"), done_row(3)];
        for shape in ["canonical", "legacy-flat"] {
            let unit = unit_row_from_turn(&rows, shape, 4);
            let payload = parse_turn_unit_payload(&unit).expect("payload");
            let event_segments: Vec<&serde_json::Value> = payload
                .segments
                .iter()
                .filter_map(|segment| match segment {
                    TurnUnitSegment::EventRow { event } => Some(event),
                    _ => None,
                })
                .collect();
            assert_eq!(event_segments.len(), 2, "shape={shape}");
            for segment in event_segments {
                assert_eq!(
                    segment["owner"]["localSessionId"], "local:s1",
                    "shape={shape}"
                );
                assert!(segment.get("eventType").is_some(), "shape={shape}");
            }
        }
    }

    #[test]
    fn both_shapes_expand_to_equal_semantics() {
        // 两种段载荷展开出的 canonical 语义字段相等（额外取证字段允许保留）。
        let rows = vec![
            user_row(1, "问题"),
            text_delta(2, "答"),
            text_delta(3, "案"),
            done_row(4),
        ];
        let from_canonical = expanded_semantics(&[unit_row_from_turn(&rows, "canonical", 5)]);
        let from_legacy = expanded_semantics(&[unit_row_from_turn(&rows, "legacy-flat", 5)]);
        assert_eq!(from_legacy, from_canonical);
        // 展开结果不得泄漏缺 owner 的事件（消息投影据此取 owner.localSessionId）。
        for semantic in from_canonical.iter().chain(from_legacy.iter()) {
            assert_eq!(semantic["owner"]["localSessionId"], "local:s1");
        }
        // delta-run 段重建的 eventId 与逐行存储的行级 id 对齐。
        assert_eq!(from_canonical.len(), 3);
    }

    #[test]
    fn mixed_read_drops_covered_rows() {
        // 「单元 + 被覆盖行」混入读取路径：被覆盖行丢弃、单元展开，不重复投影。
        let rows = vec![
            user_row(1, "问题"),
            text_delta(2, "答"),
            text_delta(3, "案"),
            done_row(4),
        ];
        let unit = unit_row_from_turn(&rows, "canonical", 5);
        let mixed = expand_turn_unit_rows(&[
            rows[0].clone(),
            rows[1].clone(),
            rows[2].clone(),
            rows[3].clone(),
            unit.clone(),
        ]);
        // 覆盖范围 [1..4] ⇒ 全部普通行被单元覆盖，只余展开的 segment。
        assert_eq!(mixed.len(), 3);
        let plain = expand_turn_unit_rows(&rows);
        assert_eq!(plain.len(), 4);
        // 被单元覆盖的行单独混入（部分覆盖）。
        let partial = expand_turn_unit_rows(&[rows[0].clone(), unit.clone()]);
        assert_eq!(partial.len(), 3, "user 行被覆盖丢弃，单元展开 3 个 segment");
        // 未覆盖的行原样保留。
        let outside = crate::events::batch_rules::test_support::user_message(9, "未覆盖");
        let kept = expand_turn_unit_rows(&[outside, unit]);
        assert_eq!(kept.len(), 4, "未覆盖行 + 3 segment");
    }

    #[test]
    fn segment_without_sequence_is_unparseable() {
        // 缺 sequence 的段事件判为不可解析（调用方走单行兜底，不静默放行）。
        let rows = vec![user_row(1, "问题"), text_delta(2, "答"), done_row(3)];
        let mut unit = unit_row_from_turn(&rows, "canonical", 4);
        let typed = unit.typed_payload.as_mut().expect("typed");
        typed["segments"][1] =
            json!({ "kind": "event", "event": { "eventType": "turn.completed" } });
        assert!(parse_turn_unit_payload(&unit).is_none());
        // 不可解析 ⇒ 整行按原样保留（不展开、不丢 raw 证据）。
        let expanded = expand_turn_unit_rows(&[unit]);
        assert_eq!(expanded.len(), 1);
        assert!(matches!(expanded[0], ExpandedItem::Event { index: 0 }));
    }

    #[test]
    fn malformed_unit_payloads_return_none() {
        // 形状校验逐条对齐 TS：seqStart 域、foldedCount、segments 非空、terminal、
        // delta-run 字段域。
        let mut unit = event(CanonicalEventType::TurnUnit, 1);
        let valid_segments = json!([
            { "kind": "delta-run", "eventType": "assistant.text.delta", "seqStart": 1, "seqEnd": 2, "text": "ab", "occurredAt": "2026-09-14T00:00:00.000Z", "markdown": false },
        ]);
        let base = json!({
            "aggregateKind": "turn-rollup",
            "seqStart": 1,
            "seqEnd": 2,
            "foldedCount": 2,
            "foldScheme": "adjacent-delta-fold-v1",
            "contentSha256": "deadbeef",
            "terminal": { "eventType": "turn.completed", "occurredAt": "2026-09-14T00:00:00.000Z" },
            "segments": valid_segments,
        });
        unit.typed_payload = Some(base.clone());
        assert!(parse_turn_unit_payload(&unit).is_some());

        for (name, patch) in [
            ("seqStart < 1", json!({ "seqStart": 0 })),
            ("seqStart > seqEnd", json!({ "seqStart": 3 })),
            ("foldedCount < 1", json!({ "foldedCount": 0 })),
            ("segments 空", json!({ "segments": [] })),
            ("foldScheme 非 string", json!({ "foldScheme": 3 })),
            (
                "terminal 类型非法",
                json!({ "terminal": { "eventType": "turn.started", "occurredAt": "x" } }),
            ),
        ] {
            let mut payload = base.clone();
            for (key, value) in patch.as_object().expect("patch") {
                payload[key.clone()] = value.clone();
            }
            unit.typed_payload = Some(payload);
            assert!(parse_turn_unit_payload(&unit).is_none(), "{name}");
        }

        // delta-run 段的 eventType / 跨度域 / markdown 布尔。
        unit.typed_payload = Some(base.clone());
        unit.typed_payload.as_mut().unwrap()["segments"][0]["eventType"] =
            json!("assistant.text.delta.batch");
        assert!(parse_turn_unit_payload(&unit).is_none());
        unit.typed_payload = Some(base.clone());
        unit.typed_payload.as_mut().unwrap()["segments"][0]["seqStart"] = json!(0);
        assert!(parse_turn_unit_payload(&unit).is_none());
        unit.typed_payload = Some(base.clone());
        unit.typed_payload.as_mut().unwrap()["segments"][0]["markdown"] = json!("yes");
        assert!(parse_turn_unit_payload(&unit).is_none());
    }

    #[test]
    fn delta_run_event_reconstruction_carries_unit_provenance() {
        // 单元行跨度含 delta-run 与终态整行（terminal 必须是 completed/failed）。
        let rows = vec![text_delta(2, "答"), text_delta(3, "案"), done_row(4)];
        let unit = unit_row_from_turn(&rows, "canonical", 5);
        let expanded = expand_turn_unit_rows(&[unit]);
        assert_eq!(expanded.len(), 2);
        let ExpandedItem::Segment { event } = &expanded[0] else {
            panic!("期望重建 segment");
        };
        assert_eq!(event["eventType"], "assistant.text.delta");
        assert_eq!(event["sequence"], 3, "delta-run 重建取 seqEnd");
        assert_eq!(event["eventId"], format!("{OWNER_KEY}#3"));
        assert_eq!(event["typedPayload"]["text"], "答案");
        assert_eq!(event["receivedAt"], event["occurredAt"]);
        assert_eq!(event["rawPayload"]["kind"], "turn-unit-segment");
        assert_eq!(event["rawPayload"]["unitEventId"], format!("{OWNER_KEY}#5"));
        assert_eq!(event["identity"]["messageId"], "msg-1");
        // 第二段：终态整行原样归一保留。
        let ExpandedItem::Segment { event } = &expanded[1] else {
            panic!("期望整行 segment");
        };
        assert_eq!(event["eventType"], "turn.completed");
        assert_eq!(event["sequence"], 4);
    }
}
