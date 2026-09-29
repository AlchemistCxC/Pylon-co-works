//! #442 Step1：回合边界判据（前端 `canonicalTurnDuration.ts` 的 Rust 单源移植）。
//!
//! 权威链路：账本有记录 ⇒ 账本即答案（宿主侧合成，见 `TurnBoundary` 消费方）；
//! 账本为空（进程重启后的历史会话）⇒ journal tail 查询（[`TurnBoundaryRow`]）+
//! 本模块判据合成。判据逐条照抄前端（ADR-0029），黄金用例对照
//! `src/__tests__/replay/canonicalTurnDuration.test.ts`。
//!
//! 与前端的**一处**有意差异（记录在案）：`deriveCanonicalTurnDuration` 的
//! `turn.unit` 内嵌 segments 锚点恢复（#199）不移植——那是 compact **读路径**
//! 裁剪 `user.message` 行后的恢复手段；本模块直接查库，顶层锚点行恒可见。
//! 同序号畸形输入（anchor 与 terminal 同 sequence）在 span 扫描里按
//! 「terminal 先于 anchor」定序（与 `latest_turn_boundary_kind` 的同序号取
//! anchor 规则自洽：kind=open 时时间戳给出的是**当前回合**的起点）。

use chrono::DateTime;

/// journal tail 查询的行数上限（边界行 only）。判据只服务「最新回合」语义，
/// 窗口外的古老边界被截断是安全的；正常会话的边界行远小于此。
pub const BOUNDARY_TAIL_CAP: u32 = 512;

/// journal tail 查询的行投影：判据只需要这四个标量（不触任何载荷列）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnBoundaryRow {
    pub sequence: i64,
    pub event_type: String,
    pub occurred_at: Option<String>,
    pub received_at: Option<String>,
}

/// 观测到的最新回合边界形态（ADR-0029 语义，wire 字符串小写）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnBoundaryKind {
    /// 最新边界是终态行 ⇒ 当前回合已收敛。
    Terminal,
    /// 最新边界是 `user.message` 锚点 ⇒ 当前回合未收敛。
    Open,
    /// 无边界行 ⇒ 无证据（不猜）。
    Unknown,
}

const ANCHOR_EVENT_TYPE: &str = "user.message";
/// `turn.unit` 计入终态集合（#81 L2：compact 裁剪 terminal 单行时的同事务替代证据；
/// 本模块直查库，但判据保持与前端集合逐字一致）。
const TERMINAL_EVENT_TYPES: [&str; 3] = ["turn.completed", "turn.failed", "turn.unit"];

fn boundary_kind_of(event_type: &str) -> Option<&'static str> {
    if event_type == ANCHOR_EVENT_TYPE {
        Some("anchor")
    } else if TERMINAL_EVENT_TYPES.contains(&event_type) {
        Some("terminal")
    } else {
        None
    }
}

/// 前端 `latestTurnBoundary`（canonicalTurnDuration.ts:109-126）的逐条移植：
/// argmax(sequence) + 同序号取 anchor（宁可判 open 待终帧自愈，不误判 terminal
/// 不可逆封存）。对输入顺序不敏感（纯比较扫描）。
pub fn latest_turn_boundary_kind(rows: &[TurnBoundaryRow]) -> TurnBoundaryKind {
    let mut latest: Option<(i64, &str)> = None;
    for row in rows {
        let Some(kind) = boundary_kind_of(&row.event_type) else {
            continue;
        };
        let replace = match latest {
            None => true,
            Some((sequence, _)) => {
                row.sequence > sequence || (row.sequence == sequence && kind == "anchor")
            }
        };
        if replace {
            latest = Some((row.sequence, kind));
        }
    }
    match latest {
        None => TurnBoundaryKind::Unknown,
        Some((_, "terminal")) => TurnBoundaryKind::Terminal,
        Some((_, _)) => TurnBoundaryKind::Open,
    }
}

/// span 扫描结果：最后一段**已闭合**回合的 (started, ended)，以及仍在途回合的起点。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TurnSpanScan {
    pub last_closed: Option<(u64, u64)>,
    pub current_start: Option<u64>,
}

/// 前端 `deriveCanonicalTurnDuration`（canonicalTurnDuration.ts:31-70）主干的状态机
/// 移植（不含内嵌 segments 恢复，见模块头注）：
/// - 锚点行取**首个有效**时间戳（`occurred_at ?? received_at`）作回合起点，多 chunk
///   同回合不替换；
/// - 终态行闭合回合（终态时间戳无效或早于起点则整行跳过，不重置起点）；
/// - 闭合后同回合再多条终态不重复替换（第一条终态边界胜出）。
fn scan_turn_spans(rows: &[TurnBoundaryRow]) -> TurnSpanScan {
    let mut scan = TurnSpanScan::default();
    let mut started_at: Option<u64> = None;
    for row in rows {
        let timestamp = parse_timestamp_ms(row.occurred_at.as_deref())
            .or_else(|| parse_timestamp_ms(row.received_at.as_deref()));
        if row.event_type == ANCHOR_EVENT_TYPE {
            if timestamp.is_some() && started_at.is_none() {
                started_at = timestamp;
            }
            continue;
        }
        if !TERMINAL_EVENT_TYPES.contains(&row.event_type.as_str()) {
            continue;
        }
        if let (Some(start), Some(ended)) = (started_at, timestamp) {
            if ended < start {
                // 终态时间戳早于起点（畸形）：与前端一致整行跳过，不重置已持有的起点。
                continue;
            }
            scan.last_closed = Some((start, ended));
            // 随后的 user 行才开启下一回合；同回合的多余终态不得替换第一条边界。
            started_at = None;
            continue;
        }
        // 起点缺失或终态时间戳无效：与前端一致整行跳过（不重置已持有的起点）。
    }
    scan.current_start = started_at;
    scan
}

/// journal 侧合成入口：kind 走 [`latest_turn_boundary_kind`]（回合作用域判据），
/// 时间戳走 span 扫描——`open` 给当前回合起点，`terminal` 给闭合回合两端。
pub fn derive_turn_boundary(rows: &[TurnBoundaryRow]) -> Option<TurnBoundary> {
    if rows.is_empty() {
        return Some(TurnBoundary {
            kind: TurnBoundaryKind::Unknown,
            started_at_ms: None,
            ended_at_ms: None,
        });
    }
    let mut ordered: Vec<&TurnBoundaryRow> = rows.iter().collect();
    // 同序号畸形输入定序：terminal 先于 anchor 处理（anchor 视为更新，
    // 与「同序号取 anchor ⇒ open」的 kind 判据自洽）。
    ordered.sort_by(|left, right| {
        left.sequence
            .cmp(&right.sequence)
            .then_with(|| rank(left).cmp(&rank(right)))
    });
    let ordered: Vec<TurnBoundaryRow> = ordered.into_iter().cloned().collect();
    let kind = latest_turn_boundary_kind(&ordered);
    let scan = scan_turn_spans(&ordered);
    let (started_at_ms, ended_at_ms) = match kind {
        TurnBoundaryKind::Open => (scan.current_start, None),
        TurnBoundaryKind::Terminal => (
            scan.last_closed.map(|(start, _)| start),
            scan.last_closed.map(|(_, ended)| ended),
        ),
        TurnBoundaryKind::Unknown => (None, None),
    };
    Some(TurnBoundary {
        kind,
        started_at_ms,
        ended_at_ms,
    })
}

fn rank(row: &TurnBoundaryRow) -> u8 {
    if row.event_type == ANCHOR_EVENT_TYPE {
        1
    } else {
        0
    }
}

fn parse_timestamp_ms(value: Option<&str>) -> Option<u64> {
    let text = value?;
    let parsed = DateTime::parse_from_rfc3339(text).ok()?;
    let millis = parsed.timestamp_millis();
    u64::try_from(millis).ok()
}

/// load 响应顶层 `turnBoundary`（#442 Step1，camelCase wire）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnBoundary {
    pub kind: TurnBoundaryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at_ms: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(sequence: i64, event_type: &str, at: &str) -> TurnBoundaryRow {
        TurnBoundaryRow {
            sequence,
            event_type: event_type.to_string(),
            occurred_at: Some(at.to_string()),
            received_at: Some(at.to_string()),
        }
    }

    fn boundary_row(sequence: i64, event_type: &str) -> TurnBoundaryRow {
        TurnBoundaryRow {
            sequence,
            event_type: event_type.to_string(),
            occurred_at: None,
            received_at: None,
        }
    }

    const T10: &str = "2026-09-03T00:00:10.000Z";
    const T13_250: &str = "2026-09-03T00:00:13.250Z";
    const T10_500: &str = "2026-09-03T00:00:10.500Z";
    const T13_000: &str = "2026-09-03T00:00:13.000Z";
    const T1: &str = "2026-09-03T00:00:01.000Z";
    const T2: &str = "2026-09-03T00:00:02.000Z";
    const T60: &str = "2026-09-03T00:01:00.000Z";
    const T64_500: &str = "2026-09-03T00:01:04.500Z";

    // ---- 黄金用例：latestTurnBoundary（对照 TS canonicalTurnDuration.test.ts:72-128）----

    #[test]
    fn boundary_kind_follows_latest_boundary_only() {
        // 尾行是终态 ⇒ terminal。
        assert_eq!(
            latest_turn_boundary_kind(&[
                boundary_row(1, "user.message"),
                boundary_row(2, "turn.completed")
            ]),
            TurnBoundaryKind::Terminal
        );
        // 上一轮已终态，最新边界是本轮锚点 ⇒ open（旧判据的塌陷入口）。
        assert_eq!(
            latest_turn_boundary_kind(&[
                boundary_row(1, "user.message"),
                boundary_row(2, "turn.completed"),
                boundary_row(3, "user.message"),
            ]),
            TurnBoundaryKind::Open
        );
    }

    #[test]
    fn boundary_kind_unknown_without_boundary_rows() {
        assert_eq!(latest_turn_boundary_kind(&[]), TurnBoundaryKind::Unknown);
        assert_eq!(
            latest_turn_boundary_kind(&[boundary_row(1, "assistant.text.delta")]),
            TurnBoundaryKind::Unknown
        );
    }

    #[test]
    fn unit_and_failed_count_as_terminal_boundaries() {
        assert_eq!(
            latest_turn_boundary_kind(&[
                boundary_row(1, "user.message"),
                boundary_row(2, "turn.unit")
            ]),
            TurnBoundaryKind::Terminal
        );
        assert_eq!(
            latest_turn_boundary_kind(&[
                boundary_row(1, "user.message"),
                boundary_row(2, "turn.failed")
            ]),
            TurnBoundaryKind::Terminal
        );
    }

    #[test]
    fn multi_chunk_anchors_stay_open() {
        assert_eq!(
            latest_turn_boundary_kind(&[
                boundary_row(1, "user.message"),
                boundary_row(2, "user.message")
            ]),
            TurnBoundaryKind::Open
        );
    }

    #[test]
    fn same_sequence_tie_takes_anchor_open() {
        assert_eq!(
            latest_turn_boundary_kind(&[
                boundary_row(1, "user.message"),
                boundary_row(1, "turn.completed")
            ]),
            TurnBoundaryKind::Open
        );
    }

    #[test]
    fn out_of_order_input_resolves_by_sequence() {
        assert_eq!(
            latest_turn_boundary_kind(&[
                boundary_row(3, "user.message"),
                boundary_row(2, "turn.completed")
            ]),
            TurnBoundaryKind::Open
        );
        assert_eq!(
            latest_turn_boundary_kind(&[
                boundary_row(2, "user.message"),
                boundary_row(3, "turn.completed")
            ]),
            TurnBoundaryKind::Terminal
        );
    }

    // ---- 黄金用例：deriveCanonicalTurnDuration（对照 TS canonicalTurnDuration.test.ts:19-64）----

    #[test]
    fn span_derives_latest_completed_turn() {
        let scan = scan_turn_spans(&[
            row(1, "user.message", T10),
            row(2, "turn.completed", T13_250),
        ]);
        assert_eq!(scan.last_closed, Some((parse_ms(T10), parse_ms(T13_250))));
        assert_eq!(scan.current_start, None);
    }

    #[test]
    fn span_uses_latest_turn_and_ignores_earlier_one() {
        let scan = scan_turn_spans(&[
            row(1, "user.message", T1),
            row(2, "turn.completed", T2),
            row(3, "user.message", T60),
            row(4, "turn.failed", T64_500),
        ]);
        assert_eq!(scan.last_closed, Some((parse_ms(T60), parse_ms(T64_500))));
    }

    #[test]
    fn span_anchors_at_first_user_chunk() {
        let scan = scan_turn_spans(&[
            row(1, "user.message", T10),
            row(2, "user.message", T10_500),
            row(3, "turn.completed", T13_000),
        ]);
        assert_eq!(scan.last_closed, Some((parse_ms(T10), parse_ms(T13_000))));
    }

    #[test]
    fn span_skips_rows_with_invalid_timestamps() {
        fn row_no_ts(sequence: i64, event_type: &str) -> TurnBoundaryRow {
            TurnBoundaryRow {
                sequence,
                event_type: event_type.to_string(),
                occurred_at: None,
                received_at: None,
            }
        }
        // 锚点时间戳无效 ⇒ 回合无起点，终态行整行跳过（不造 0s）。
        let scan = scan_turn_spans(&[row_no_ts(1, "user.message"), row(2, "turn.completed", T2)]);
        assert_eq!(scan.last_closed, None);
        // 两端时间戳都无效同样不可测。
        let scan = scan_turn_spans(&[row_no_ts(1, "user.message"), row_no_ts(2, "turn.completed")]);
        assert_eq!(scan.last_closed, None);
    }

    // ---- 组合入口：kind 与时间戳的装配语义 ----

    #[test]
    fn compose_terminal_with_span() {
        let boundary = derive_turn_boundary(&[
            row(1, "user.message", T10),
            row(2, "turn.completed", T13_250),
        ])
        .expect("rows present");
        assert_eq!(
            boundary,
            TurnBoundary {
                kind: TurnBoundaryKind::Terminal,
                started_at_ms: Some(parse_ms(T10)),
                ended_at_ms: Some(parse_ms(T13_250)),
            }
        );
    }

    #[test]
    fn compose_open_with_current_turn_start() {
        let boundary = derive_turn_boundary(&[
            row(1, "user.message", T1),
            row(2, "turn.completed", T2),
            row(3, "user.message", T60),
        ])
        .expect("rows present");
        assert_eq!(
            boundary,
            TurnBoundary {
                kind: TurnBoundaryKind::Open,
                started_at_ms: Some(parse_ms(T60)),
                ended_at_ms: None,
            }
        );
    }

    #[test]
    fn compose_terminal_without_measurable_span_keeps_kind() {
        // unit 行时间戳无效：kind 仍 terminal（收敛证据与耗时可测性分离，前端语义同源）。
        let mut unit = row(2, "turn.unit", "");
        unit.occurred_at = None;
        unit.received_at = None;
        let boundary =
            derive_turn_boundary(&[row(1, "user.message", T10), unit]).expect("rows present");
        assert_eq!(boundary.kind, TurnBoundaryKind::Terminal);
        assert_eq!(boundary.started_at_ms, None);
        assert_eq!(boundary.ended_at_ms, None);
    }

    #[test]
    fn compose_unknown_on_empty_rows() {
        let boundary = derive_turn_boundary(&[]).expect("empty rows still yield explicit unknown");
        assert_eq!(boundary.kind, TurnBoundaryKind::Unknown);
        assert_eq!(boundary.started_at_ms, None);
        assert_eq!(boundary.ended_at_ms, None);
    }

    #[test]
    fn compose_same_sequence_tie_is_open_with_anchor_start() {
        let boundary =
            derive_turn_boundary(&[row(1, "turn.completed", T2), row(1, "user.message", T10)])
                .expect("rows present");
        assert_eq!(boundary.kind, TurnBoundaryKind::Open);
        assert_eq!(boundary.started_at_ms, Some(parse_ms(T10)));
        assert_eq!(boundary.ended_at_ms, None);
    }

    #[test]
    fn wire_shape_is_camel_case_with_optional_timestamps() {
        let full = TurnBoundary {
            kind: TurnBoundaryKind::Terminal,
            started_at_ms: Some(1),
            ended_at_ms: Some(2),
        };
        assert_eq!(
            serde_json::to_value(&full).unwrap(),
            serde_json::json!({"kind": "terminal", "startedAtMs": 1, "endedAtMs": 2})
        );
        let bare = TurnBoundary {
            kind: TurnBoundaryKind::Unknown,
            started_at_ms: None,
            ended_at_ms: None,
        };
        assert_eq!(
            serde_json::to_value(&bare).unwrap(),
            serde_json::json!({"kind": "unknown"})
        );
    }

    fn parse_ms(at: &str) -> u64 {
        parse_timestamp_ms(Some(at)).expect("test fixtures use valid rfc3339")
    }
}
