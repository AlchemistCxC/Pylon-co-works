//! turn 时长与终态判定（TS `canonicalTurnDuration.ts` 的逐函数对齐）。
//!
//! 从持久化事件时间戳推导最近一个完成的回合。刻意不用 Date.now：消费方在重启后的
//! Workbench 历史重建期，进程本地 generation 时钟已不存在。无效/缺失边界返回 None，
//! 调用方显示 "duration unavailable" 而不是凭空造 0 秒。
//!
//! #199：compact 读（`evt_load_compact`）只返回 unit 行 + 未覆盖行，回合的
//! `user.message` 锚点只作为内嵌 event segment 存在于 typedPayload.segments——
//! 顶层缺锚点时从这里恢复起点；形状异常视同无锚点（不得凭空造 0s）。

use serde::Serialize;
use wasm_bindgen::prelude::*;

use super::{decode_batch, parse_timestamp, CompactEvent};
use pylon_canonical_types::CanonicalEventType;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CanonicalTurnDuration {
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: i64,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "completedAt")]
    pub completed_at: i64,
    /// TS 基线的固定来源标记（source: 'canonical-events'）。
    pub source: &'static str,
}

fn is_user_message(event: &CompactEvent) -> bool {
    event.event_type == CanonicalEventType::UserMessage
}

fn is_terminal(event: &CompactEvent) -> bool {
    matches!(
        event.event_type,
        CanonicalEventType::TurnCompleted
            | CanonicalEventType::TurnFailed
            | CanonicalEventType::TurnUnit
    )
}

/// unit 行内嵌 segments 里的 user.message 锚点（首个有效 occurredAt）。形状与
/// `turn.unit` 的 segment 契约一致（`{kind:'event', event}`）；任何形状异常都返回
/// None——推导宁可「不可测」也不猜。
fn embedded_user_anchor_at(typed_payload: Option<&serde_json::Value>) -> Option<i64> {
    let segments = typed_payload?.get("segments")?.as_array()?;
    for segment in segments {
        let Some(holder) = segment.as_object() else {
            continue;
        };
        if holder.get("kind").and_then(serde_json::Value::as_str) != Some("event") {
            continue;
        }
        let Some(inner) = holder.get("event").and_then(serde_json::Value::as_object) else {
            continue;
        };
        if inner.get("eventType").and_then(serde_json::Value::as_str) != Some("user.message") {
            continue;
        }
        let anchor = inner
            .get("occurredAt")
            .and_then(serde_json::Value::as_str)
            .and_then(parse_timestamp);
        if anchor.is_some() {
            return anchor;
        }
    }
    None
}

/// 从持久化事件时间戳推导最近完成的回合（TS `deriveCanonicalTurnDuration`）。
///
/// 粒度无关性契约：只认 user.message / turn.completed / turn.failed / turn.unit，
/// 其余（含一切 delta/聚合行）一律跳过——这是「聚合行在回合时长上安全」「L3 裁掉
/// delta 行后仍能显示耗时」的依据，不是实现细节。
pub fn derive_canonical_turn_duration_inner(
    events: &[CompactEvent],
) -> Option<CanonicalTurnDuration> {
    // 稳定排序（与 TS sort 同为 stable），只按 sequence。
    let mut ordered: Vec<&CompactEvent> = events.iter().collect();
    ordered.sort_by_key(|event| event.sequence);
    let mut started_at: Option<i64> = None;
    let mut latest: Option<CanonicalTurnDuration> = None;

    for event in ordered {
        let timestamp = event.occurred_at_ms;
        if is_user_message(event) {
            // 畸形 user 行不得抹掉同回合的有效边界；后续合法 user 行仍可开启新回合。
            // 多条 canonical user chunk 同属一回合，首个有效 user 时间戳保留到终态闭合。
            if timestamp.is_some() && started_at.is_none() {
                started_at = timestamp;
            }
            continue;
        }
        if !is_terminal(event) {
            continue;
        }
        // #199：顶层没有 user 锚点行时（compact 读的常态），从 unit 内嵌 segments
        // 恢复起点——只认内嵌 event 段的 user.message，取首个有效时间戳。
        if started_at.is_none() {
            started_at = embedded_user_anchor_at(event.typed_payload.as_ref());
        }
        match (started_at, timestamp) {
            (Some(start), Some(completed)) if completed >= start => {
                latest = Some(CanonicalTurnDuration {
                    elapsed_ms: completed - start,
                    started_at: start,
                    completed_at: completed,
                    source: "canonical-events",
                });
                // 后续 user 行开启下一回合；没有新 user 行的多余终态是重复，不得
                // 替换首个终态边界。
                started_at = None;
            }
            _ => continue,
        }
    }

    latest
}

/// canonical 投影是否含终态回合边界。与时长推导刻意分离：重启后的会话可能有合法
/// 的完成回合但时间戳畸形/缺失——调用方仍可渲染 "duration unavailable" 终态脚注。
pub fn has_canonical_turn_terminal_inner(events: &[CompactEvent]) -> bool {
    events.iter().any(is_terminal)
}

// ── wasm 薄壳 ────────────────────────────────────────────────────────────────

#[wasm_bindgen(js_name = deriveCanonicalTurnDuration)]
pub fn derive_canonical_turn_duration(frame: &[u8]) -> Result<JsValue, JsError> {
    fn inner(frame: &[u8]) -> Result<JsValue, String> {
        let events = decode_batch(frame)?;
        let duration = derive_canonical_turn_duration_inner(&events);
        crate::events::to_js(&duration)
    }
    inner(frame).map_err(|error| JsError::new(&error))
}

#[wasm_bindgen(js_name = hasCanonicalTurnTerminal)]
pub fn has_canonical_turn_terminal(frame: &[u8]) -> Result<bool, JsError> {
    fn inner(frame: &[u8]) -> Result<bool, String> {
        let events = decode_batch(frame)?;
        Ok(has_canonical_turn_terminal_inner(&events))
    }
    inner(frame).map_err(|error| JsError::new(&error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::test_support::{event, iso_of, OWNER_KEY};
    use serde_json::json;

    const START: &str = "2026-09-03T00:00:10.000Z";
    const END: &str = "2026-09-03T00:00:22.500Z";

    fn boundary(sequence: i64, event_type: CanonicalEventType, at: &str) -> CompactEvent {
        let mut event = event(event_type, sequence);
        event.occurred_at = at.into();
        event.received_at = at.into();
        // TS parseTimestamp(occurredAt) ?? parseTimestamp(receivedAt)：无效时退 receivedAt。
        event.occurred_at_ms =
            parse_timestamp(&event.occurred_at).or_else(|| parse_timestamp(&event.received_at));
        event
    }

    #[test]
    fn derives_latest_completed_turn_from_timestamps() {
        let duration = derive_canonical_turn_duration_inner(&[
            boundary(
                1,
                CanonicalEventType::UserMessage,
                "2026-09-03T00:00:10.000Z",
            ),
            boundary(
                2,
                CanonicalEventType::TurnCompleted,
                "2026-09-03T00:00:13.250Z",
            ),
        ])
        .expect("duration");
        assert_eq!(
            duration,
            CanonicalTurnDuration {
                elapsed_ms: 3250,
                started_at: parse_timestamp("2026-09-03T00:00:10.000Z").unwrap(),
                completed_at: parse_timestamp("2026-09-03T00:00:13.250Z").unwrap(),
                source: "canonical-events",
            }
        );
    }

    #[test]
    fn uses_terminal_failure_boundary_and_ignores_earlier_turn() {
        let duration = derive_canonical_turn_duration_inner(&[
            boundary(
                1,
                CanonicalEventType::UserMessage,
                "2026-09-03T00:00:01.000Z",
            ),
            boundary(
                2,
                CanonicalEventType::TurnCompleted,
                "2026-09-03T00:00:02.000Z",
            ),
            boundary(
                3,
                CanonicalEventType::UserMessage,
                "2026-09-03T00:01:00.000Z",
            ),
            boundary(
                4,
                CanonicalEventType::TurnFailed,
                "2026-09-03T00:01:04.500Z",
            ),
        ])
        .expect("duration");
        assert_eq!(duration.elapsed_ms, 4500);
        assert_eq!(duration.source, "canonical-events");
    }

    #[test]
    fn anchors_turn_at_first_user_chunk_not_last() {
        let duration = derive_canonical_turn_duration_inner(&[
            boundary(
                1,
                CanonicalEventType::UserMessage,
                "2026-09-03T00:00:10.000Z",
            ),
            boundary(
                2,
                CanonicalEventType::UserMessage,
                "2026-09-03T00:00:10.500Z",
            ),
            boundary(
                3,
                CanonicalEventType::TurnCompleted,
                "2026-09-03T00:00:13.000Z",
            ),
        ])
        .expect("duration");
        assert_eq!(duration.elapsed_ms, 3000);
    }

    #[test]
    fn malformed_user_row_does_not_erase_boundary() {
        // 空时间戳的 user 行不得抹掉已确立的起点（多 user chunk 同回合同锚）。
        let duration = derive_canonical_turn_duration_inner(&[
            boundary(
                1,
                CanonicalEventType::UserMessage,
                "2026-09-03T00:00:10.000Z",
            ),
            boundary(2, CanonicalEventType::UserMessage, ""),
            boundary(
                3,
                CanonicalEventType::TurnCompleted,
                "2026-09-03T00:00:13.000Z",
            ),
        ])
        .expect("duration");
        assert_eq!(duration.elapsed_ms, 3000);
    }

    #[test]
    fn returns_none_when_boundary_timestamp_missing() {
        assert!(derive_canonical_turn_duration_inner(&[
            boundary(1, CanonicalEventType::UserMessage, ""),
            boundary(
                2,
                CanonicalEventType::TurnCompleted,
                "2026-09-03T00:00:02.000Z"
            ),
        ])
        .is_none());
    }

    #[test]
    fn separates_terminal_presence_from_measurable_duration() {
        assert!(has_canonical_turn_terminal_inner(&[boundary(
            1,
            CanonicalEventType::TurnCompleted,
            "2026-09-03T00:00:00.000Z"
        )]));
        // 双边界都缺时间戳：有终态但时长不可测。
        assert!(derive_canonical_turn_duration_inner(&[
            boundary(1, CanonicalEventType::UserMessage, ""),
            boundary(2, CanonicalEventType::TurnCompleted, ""),
        ])
        .is_none());
    }

    #[test]
    fn granularity_independence_batch_rows_are_neither_boundary_nor_terminal() {
        // ② 粒度无关性：聚合行不被误认终态或边界——只有聚合行时不得凭空得出回合已结束。
        let rows = [
            boundary(1, CanonicalEventType::UserMessage, START),
            boundary(4, CanonicalEventType::AssistantTextDeltaBatch, START),
        ];
        assert!(derive_canonical_turn_duration_inner(&rows).is_none());
        assert!(!has_canonical_turn_terminal_inner(&rows));
        assert!(!has_canonical_turn_terminal_inner(&[boundary(
            4,
            CanonicalEventType::AssistantThinkingDeltaBatch,
            START
        )]));
    }

    #[test]
    fn later_user_row_reanchors_next_turn() {
        let duration = derive_canonical_turn_duration_inner(&[
            boundary(1, CanonicalEventType::UserMessage, START),
            boundary(2, CanonicalEventType::UserMessage, END),
            boundary(6, CanonicalEventType::AssistantTextDeltaBatch, START),
            boundary(7, CanonicalEventType::TurnCompleted, END),
        ])
        .expect("duration");
        assert_eq!(duration.started_at, parse_timestamp(START).unwrap());
        assert_eq!(duration.elapsed_ms, 12_500);
    }

    #[test]
    fn compact_read_recovers_user_anchor_from_unit_segments() {
        // #199：仅 unit 行（user 锚点内嵌于 segments）与其它形态产出同一回合时长。
        let start_ms = parse_timestamp(START).unwrap();
        let end_ms = parse_timestamp(END).unwrap();
        let mut unit = event(CanonicalEventType::TurnUnit, 8);
        unit.occurred_at = END.into();
        unit.received_at = END.into();
        unit.occurred_at_ms = Some(end_ms);
        unit.typed_payload = Some(json!({
            "segments": [
                { "kind": "event", "event": { "sequence": 1, "eventType": "user.message", "occurredAt": START } },
                { "kind": "delta-run", "eventType": "assistant.text.delta", "seqStart": 2, "seqEnd": 6, "text": "答案", "occurredAt": START },
            ],
        }));
        let duration = derive_canonical_turn_duration_inner(&[unit]).expect("duration");
        assert_eq!(duration.elapsed_ms, 12_500);
        assert_eq!(duration.started_at, start_ms);

        // unit 未内嵌 user 段（或形状异常）时仍不得凭空造时长。
        let mut no_user_inside = event(CanonicalEventType::TurnUnit, 8);
        no_user_inside.occurred_at_ms = Some(end_ms);
        no_user_inside.occurred_at = END.into();
        no_user_inside.received_at = END.into();
        no_user_inside.typed_payload = Some(json!({
            "segments": [
                { "kind": "delta-run", "eventType": "assistant.text.delta", "seqStart": 2, "seqEnd": 7, "text": "答案", "occurredAt": START },
            ],
        }));
        assert!(derive_canonical_turn_duration_inner(&[no_user_inside.clone()]).is_none());
        assert!(has_canonical_turn_terminal_inner(&[no_user_inside]));

        // 形状异常（typedPayload 非对象/segments 非数组）视同无锚点。
        let mut corrupt = event(CanonicalEventType::TurnUnit, 8);
        corrupt.occurred_at_ms = Some(end_ms);
        corrupt.occurred_at = iso_of(end_ms);
        corrupt.received_at = iso_of(end_ms);
        corrupt.typed_payload = Some(json!("corrupt"));
        assert!(derive_canonical_turn_duration_inner(&[corrupt]).is_none());
        assert_eq!(OWNER_KEY, r#"["p1","peri","local:s1"]"#);
    }
}
