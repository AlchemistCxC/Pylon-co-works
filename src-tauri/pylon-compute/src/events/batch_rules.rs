//! canonicalEventBatch — #81 L1 写入窗口聚合的纯合并规则（TS `canonicalEventBatch.ts`
//! 的逐函数对齐）。
//!
//! 在 canonicalEventSink 分配 sequence/eventId 之后、落盘之前，把 pending 中
//! **相邻同类 delta** 合并为一行 batch 行（跨度占用 sequence：行取跨度内最后一条的
//! sequence/eventId，跨度中间编号不被任何行占用，留给读侧按 `owner#(seqSpan[0]+i)`
//! 重建原始 id）。sink 的 id 分配与 conflict rebase 都经同一函数合并，规则不分叉。
//!
//! 合并条件（保守，等价性按构造成立）：
//! - 事件类型 ∈ {assistant.text.delta, assistant.thinking.delta} 且相邻同类；
//! - identity 全字段相等（比 messageProjectionRules 的三元组口径更严：合并更少、
//!   永不产生行为不同的事件）；
//! - 未超上限：rawPayload 序列化字节 ≤ maxRawBytes 且 foldedCount ≤ maxFoldedCount，
//!   超限切断成多行（不截断 ⇒ 不产生 raw_truncated 语义）。
//!
//! 非 delta 事件、未知事件、identity 不连续处、单条 run：原样保留（unknown 不丢弃）。
//! 字节计长读**宿主预序列化的 rawJson 文本字节长**——Rust 侧不做 serde_json 序列化，
//! 这正是「serde_json 往返不进热路径」的落点。
//!
//! 批量入口吃整页帧（`append(batch)` 形态）：输出用**索引引用**表示原样保留的事件
//! （宿主零拷贝映射回原对象），只有合并出的 batch 行才物化新对象。

use serde::Serialize;
use wasm_bindgen::prelude::*;

use super::{decode_batch, CompactEvent, EventIdentity, EventOwner};
use pylon_canonical_types::CanonicalEventType;

/// 单行 rawPayload 序列化字节上限的缺省值。48 KiB 而非裁决字面的 256 KiB：Rust
/// `retain_raw_payload`（MAX_CANONICAL_RAW_BYTES = 64 KiB）会对超限 rawPayload 做
/// 截断替换，与「不截断、rawPayload 可逐字节还原」的裁决意图冲突。
pub const DEFAULT_MAX_RAW_BYTES: i64 = 48 * 1024;
/// 单行折叠 chunk 数上限（缺省）。
pub const DEFAULT_MAX_FOLDED_COUNT: i64 = 2000;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BatchLimits {
    pub max_raw_bytes: i64,
    pub max_folded_count: i64,
}

impl Default for BatchLimits {
    fn default() -> Self {
        BatchLimits {
            max_raw_bytes: DEFAULT_MAX_RAW_BYTES,
            max_folded_count: DEFAULT_MAX_FOLDED_COUNT,
        }
    }
}

pub fn is_canonical_batch_delta_type(event_type: CanonicalEventType) -> bool {
    matches!(
        event_type,
        CanonicalEventType::AssistantTextDeltaBatch
            | CanonicalEventType::AssistantThinkingDeltaBatch
    )
}

/// delta → batch 类型映射；非 delta 返回 None。
pub fn batch_event_type_of(event_type: CanonicalEventType) -> Option<CanonicalEventType> {
    match event_type {
        CanonicalEventType::AssistantTextDelta => Some(CanonicalEventType::AssistantTextDeltaBatch),
        CanonicalEventType::AssistantThinkingDelta => {
            Some(CanonicalEventType::AssistantThinkingDeltaBatch)
        }
        _ => None,
    }
}

/// 合并输出项：`Event` 是原样保留（宿主按 index 零拷贝映射回原事件），
/// `BatchRow` 是合并出的聚合行（semantic 字段齐备；forensic 字段由宿主从
/// 跨度首条回挂）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BatchItem {
    Event { index: usize },
    // Box：passthrough 引用项只有 8 字节，聚合行远大于它——装箱压平变体尺寸差。
    BatchRow { row: Box<BatchRow> },
}

/// batch 行的语义字段（TS `buildBatchRow`）：沿用跨度内首条的身份/时间戳/provenance
/// 维度，sequence/eventId 取末条（跨度占用）。
#[derive(Debug, Clone, Serialize)]
pub struct BatchRow {
    #[serde(rename = "ownerKey")]
    pub owner_key: String,
    pub owner: EventOwner,
    #[serde(rename = "clientGeneration")]
    pub client_generation: i64,
    #[serde(rename = "payloadVersion")]
    pub payload_version: i64,
    #[serde(rename = "occurredAt")]
    pub occurred_at: String,
    #[serde(rename = "receivedAt")]
    pub received_at: String,
    #[serde(rename = "eventType")]
    pub event_type: CanonicalEventType,
    pub sequence: i64,
    #[serde(rename = "eventId")]
    pub event_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<EventIdentity>,
    /// run 内全部 chunk 文本的精确拼接。
    pub text: String,
    #[serde(rename = "foldedCount")]
    pub folded_count: i64,
    #[serde(rename = "seqSpan")]
    pub seq_span: [i64; 2],
    /// 原始 chunk 数组（rawJson 文本按序拼接后解析；顺序不变，raw 不丢）。
    #[serde(rename = "rawPayload")]
    pub raw_payload: serde_json::Value,
}

/// run 的进行时状态：连续下标区间 [first, cursor) + 聚合元数据。
struct RunState {
    first: usize,
    /// 已聚合的 rawJson 字节预算（TS run.bytes）。
    bytes: i64,
    batch_type: CanonicalEventType,
    count: i64,
    /// run 内 text 的精确拼接（增量追加，避免 flush 时重扫）。
    text: String,
}

fn identity_keys_equal(left: Option<&EventIdentity>, right: Option<&EventIdentity>) -> bool {
    // TS sameIdentity：四字段逐一 `===`（None 与 None 相等）。
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

/// rawPayload 序列化字节数：读宿主预序列化文本的字节长。宿主契约是恒携带
/// `JSON.stringify(rawPayload ?? null)`，因此缺省分支按 "null" 的 4 字节计——与
/// TS `encodedByteLength(undefined ?? null)` 一致。
fn raw_payload_bytes(event: &CompactEvent) -> usize {
    match &event.raw_json {
        Some(json) => json.len(),
        None => 4,
    }
}

/// TS `mergeAdjacentDeltaChunks`：合并 pending 中相邻同类 delta chunk 为 batch 行；
/// 其余事件原样保留。输入须为同一 owner 的逐 chunk canonical 事件（升序 = 到达序）；
/// 单条 run 不合并（保持与逐 chunk 存储逐字节一致）。
pub fn merge_adjacent_delta_chunks(
    events: &[CompactEvent],
    limits: BatchLimits,
) -> Result<Vec<BatchItem>, String> {
    let mut items: Vec<BatchItem> = Vec::new();
    let mut run: Option<RunState> = None;

    for (index, event) in events.iter().enumerate() {
        let batch_type = batch_event_type_of(event.event_type);
        // deltaTextOf：typedPayload 无 string text（如空文本 chunk）为 None。这类
        // chunk 在逐行投影中是 no-op，若并入 batch 行会让 text 变成 string，投影从
        // no-op 变成新建消息 ⇒ 破坏 Message[] 等价（审核 P1-2）。一律不参与合并。
        let fold_text = if batch_type.is_some() {
            event.text.clone()
        } else {
            None
        };

        let should_extend = match (&run, batch_type) {
            (Some(state), Some(batch_type)) => {
                state.batch_type == batch_type
                    && fold_text.is_some()
                    && identity_keys_equal(
                        events[state.first].identity.as_ref(),
                        event.identity.as_ref(),
                    )
                    && state.count < limits.max_folded_count
                    && state.bytes + raw_payload_bytes(event) as i64 <= limits.max_raw_bytes
            }
            _ => false,
        };

        if let Some(state) = run.as_mut() {
            if should_extend {
                state.bytes += raw_payload_bytes(event) as i64;
                state.count += 1;
                if let Some(text) = &fold_text {
                    state.text.push_str(text);
                }
                continue;
            }
        }

        // 切断：先冲刷当前 run。
        if let Some(state) = run.take() {
            flush_run(events, state, &mut items)?;
        }

        if let (Some(batch_type), Some(text)) = (batch_type, fold_text) {
            let bytes = raw_payload_bytes(event) as i64;
            if bytes > limits.max_raw_bytes {
                // 单条已超上限的 delta 无法成批，保持原样（不截断）。
                items.push(BatchItem::Event { index });
            } else {
                run = Some(RunState {
                    first: index,
                    bytes,
                    batch_type,
                    count: 1,
                    text: text.clone(),
                });
            }
        } else {
            // 非 delta、无 string text 的 delta：原样保留（no-op 语义/unknown 不丢）。
            items.push(BatchItem::Event { index });
        }
    }
    if let Some(state) = run.take() {
        flush_run(events, state, &mut items)?;
    }
    Ok(items)
}

fn flush_run(
    events: &[CompactEvent],
    state: RunState,
    items: &mut Vec<BatchItem>,
) -> Result<(), String> {
    if state.count == 1 {
        items.push(BatchItem::Event { index: state.first });
        return Ok(());
    }
    let first = &events[state.first];
    let last_index = state.first + state.count as usize - 1;
    let last = &events[last_index];
    // batch 行：沿用跨度内首条的身份/时间戳/provenance 维度，sequence/eventId 取
    // 末条（跨度占用）。rawMetadata 只描述单条 chunk 的截断状态，不适用于聚合行
    // （聚合行不截断）——forensic 字段由宿主回挂，这里只产出语义字段。
    let raw_parts: Vec<&str> = events[state.first..=last_index]
        .iter()
        .map(|event| match &event.raw_json {
            Some(json) => json.as_str(),
            None => "null",
        })
        .collect();
    let raw_text = format!("[{}]", raw_parts.join(","));
    let raw_payload: serde_json::Value = serde_json::from_str(&raw_text)
        .map_err(|error| format!("batch 行 rawPayload 拼接失败: {error}"))?;
    items.push(BatchItem::BatchRow {
        row: Box::new(BatchRow {
            owner_key: first.owner_key.clone(),
            owner: first.owner.clone(),
            client_generation: first.client_generation,
            payload_version: first.payload_version,
            occurred_at: first.occurred_at.clone(),
            received_at: first.received_at.clone(),
            event_type: state.batch_type,
            sequence: last.sequence,
            event_id: pylon_canonical_types::canonical_event_id(&first.owner_key, last.sequence),
            identity: first.identity.clone(),
            text: state.text,
            folded_count: state.count,
            seq_span: [first.sequence, last.sequence],
            raw_payload,
        }),
    });
    Ok(())
}

// ── 读侧访问器（TS canonicalBatchSpanOf / canonicalBatchChunksOf 的对齐） ────

fn span_boundary(value: Option<i64>) -> bool {
    match value {
        Some(value) => value >= 1,
        None => false,
    }
}

/// batch 行的 seqSpan（typedPayload.seqSpan，形状非法返回 None）。
pub fn canonical_batch_span_of(event: &CompactEvent) -> Option<[i64; 2]> {
    if !is_canonical_batch_delta_type(event.event_type) {
        return None;
    }
    let span = event.typed_payload.as_ref()?.get("seqSpan")?;
    let span = span.as_array()?;
    if span.len() != 2 {
        return None;
    }
    let first = span[0].as_i64();
    let last = span[1].as_i64();
    if !span_boundary(first) || !span_boundary(last) || last? < first? {
        return None;
    }
    Some([first?, last?])
}

/// batch 行携带的原始 chunk 数（TS `canonicalBatchChunksOf` 的一致性校验：
/// 数组长度、foldedCount、seqSpan 三者互洽；损坏行返回 None，由读侧走单行归一兜底，
/// raw 不丢）。TS 返回数组本体；读侧数组归宿主所有，这里返回计数——校验逻辑一致。
pub fn canonical_batch_chunk_count_of(event: &CompactEvent) -> Option<usize> {
    let span = canonical_batch_span_of(event)?;
    let chunks = event
        .raw_json
        .as_deref()
        .and_then(|json| serde_json::from_str::<serde_json::Value>(json).ok())?;
    let chunks = chunks.as_array()?;
    let folded_count = event.typed_payload.as_ref()?.get("foldedCount")?.as_i64()?;
    if folded_count != chunks.len() as i64 {
        return None;
    }
    if span[1] - span[0] + 1 != chunks.len() as i64 {
        return None;
    }
    Some(chunks.len())
}

// ── wasm 薄壳 ────────────────────────────────────────────────────────────────

fn limits_from(max_raw_bytes: f64, max_folded_count: f64) -> Result<BatchLimits, String> {
    let to_i64 = |value: f64, name: &str| -> Result<i64, String> {
        if !value.is_finite() || value.fract() != 0.0 || value < 0.0 {
            return Err(format!("{name} 必须是非负整数值（收到 {value}）"));
        }
        Ok(value as i64)
    };
    Ok(BatchLimits {
        max_raw_bytes: to_i64(max_raw_bytes, "maxRawBytes")?,
        max_folded_count: to_i64(max_folded_count, "maxFoldedCount")?,
    })
}

/// 批量入口（`append(batch)` 形态）：整页事件帧 → 合并输出项数组。
#[wasm_bindgen(js_name = mergeAdjacentDeltaChunks)]
pub fn merge_adjacent_delta_chunks_shell(
    frame: &[u8],
    max_raw_bytes: f64,
    max_folded_count: f64,
) -> Result<JsValue, JsError> {
    fn inner(frame: &[u8], max_raw_bytes: f64, max_folded_count: f64) -> Result<JsValue, String> {
        let limits = limits_from(max_raw_bytes, max_folded_count)?;
        let events = decode_batch(frame)?;
        let items = merge_adjacent_delta_chunks(&events, limits)?;
        crate::events::to_js(&items)
    }
    inner(frame, max_raw_bytes, max_folded_count).map_err(|error| JsError::new(&error))
}

/// batch 行读侧访问器出口（seqSpan 形状校验，逐事件一位）。
#[wasm_bindgen(js_name = canonicalBatchSpanOf)]
pub fn canonical_batch_span_of_shell(frame: &[u8]) -> Result<JsValue, JsError> {
    fn inner(frame: &[u8]) -> Result<JsValue, String> {
        let events = decode_batch(frame)?;
        let spans: Vec<Option<[i64; 2]>> = events.iter().map(canonical_batch_span_of).collect();
        crate::events::to_js(&spans)
    }
    inner(frame).map_err(|error| JsError::new(&error))
}

#[cfg(test)]
pub(crate) mod test_support {
    //! 测试语料构造：与 TS 测试（canonicalEventSink.batch.test.ts）相同的 wire 场景。

    use super::*;
    use crate::events::ToolFields;

    pub fn text_delta(sequence: i64, text: &str, message_id: &str) -> CompactEvent {
        let mut event =
            crate::events::test_support::event(CanonicalEventType::AssistantTextDelta, sequence);
        event.text = Some(text.into());
        event.identity = Some(EventIdentity {
            message_id: Some(message_id.into()),
            ..Default::default()
        });
        event.raw_json = Some(format!(
            r#"{{"source":"local:s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":{}}},"messageId":"{}"}}}}"#,
            serde_json::to_string(text).expect("text json"),
            message_id
        ));
        event
    }

    pub fn thinking_delta(sequence: i64, text: &str, message_id: &str) -> CompactEvent {
        let mut event = crate::events::test_support::event(
            CanonicalEventType::AssistantThinkingDelta,
            sequence,
        );
        event.text = Some(text.into());
        event.identity = Some(EventIdentity {
            message_id: Some(message_id.into()),
            ..Default::default()
        });
        event.raw_json = Some(format!(
            r#"{{"source":"local:s1","update":{{"sessionUpdate":"agent_thought_chunk","content":{{"type":"text","text":{}}},"messageId":"{}"}}}}"#,
            serde_json::to_string(text).expect("text json"),
            message_id
        ));
        event
    }

    pub fn empty_text_delta(sequence: i64) -> CompactEvent {
        let mut event =
            crate::events::test_support::event(CanonicalEventType::AssistantTextDelta, sequence);
        event.text = None;
        event.raw_json =
            Some(r#"{"source":"local:s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":""}}}"#.into());
        event
    }

    pub fn user_message(sequence: i64, text: &str) -> CompactEvent {
        let mut event =
            crate::events::test_support::event(CanonicalEventType::UserMessage, sequence);
        event.text = Some(text.into());
        event.raw_json = Some(format!(
            r#"{{"source":"local:s1","update":{{"sessionUpdate":"user_message_chunk","content":{{"text":{}}}}}}}"#,
            serde_json::to_string(text).expect("text json")
        ));
        event
    }

    pub fn tool_start(sequence: i64, tool_call_id: &str) -> CompactEvent {
        let mut event =
            crate::events::test_support::event(CanonicalEventType::ToolCallStarted, sequence);
        event.identity = Some(EventIdentity {
            tool_call_id: Some(tool_call_id.into()),
            ..Default::default()
        });
        event.tool = Some(ToolFields {
            title: Some("Read".into()),
            kind: Some("read".into()),
            ..Default::default()
        });
        event.raw_json = Some(format!(
            r#"{{"source":"local:s1","update":{{"sessionUpdate":"tool_call","toolCallId":"{}","title":"Read","kind":"read"}}}}"#,
            tool_call_id
        ));
        event
    }

    pub fn done(sequence: i64) -> CompactEvent {
        let mut event =
            crate::events::test_support::event(CanonicalEventType::TurnCompleted, sequence);
        event.raw_json = Some(r#"{"source":"local:s1","update":{"sessionUpdate":"done"}}"#.into());
        event
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use crate::events::{
        decode_batch,
        test_support::{encode_frame, OWNER_KEY},
    };
    use pylon_canonical_types::CanonicalEventType;
    use serde_json::json;

    fn merge(events: Vec<CompactEvent>) -> Vec<BatchItem> {
        merge_adjacent_delta_chunks(&events, BatchLimits::default()).expect("merge")
    }

    fn merged_row(item: &BatchItem) -> &BatchRow {
        match item {
            BatchItem::BatchRow { row } => row,
            other => panic!("期望 batch 行，得到 {other:?}"),
        }
    }

    fn passthrough_index(item: &BatchItem) -> usize {
        match item {
            BatchItem::Event { index } => *index,
            other => panic!("期望原样保留，得到 {other:?}"),
        }
    }

    #[test]
    fn adjacent_same_kind_deltas_merge_into_batch_row() {
        // 对齐 canonicalEventSink.batch.test.ts：「相邻同类 delta 合并为一行 batch」。
        let events = vec![
            text_delta(1, "你", "msg-1"),
            text_delta(2, "好", "msg-1"),
            text_delta(3, "，世界", "msg-1"),
            user_message(4, "hi"),
        ];
        let items = merge(events.clone());
        assert_eq!(items.len(), 2);
        let batch = merged_row(&items[0]);
        assert_eq!(
            batch.event_type,
            CanonicalEventType::AssistantTextDeltaBatch
        );
        assert_eq!(batch.sequence, 3);
        assert_eq!(batch.event_id, format!("{OWNER_KEY}#3"));
        assert_eq!(batch.text, "你好，世界");
        assert_eq!(batch.folded_count, 3);
        assert_eq!(batch.seq_span, [1, 3]);
        assert_eq!(
            batch
                .identity
                .as_ref()
                .and_then(|identity| identity.message_id.as_deref()),
            Some("msg-1")
        );
        // rawPayload = 原始 chunk 数组，顺序不变。
        let raw = batch.raw_payload.as_array().expect("raw 数组");
        assert_eq!(raw.len(), 3);
        assert_eq!(raw[2]["update"]["content"]["text"], "，世界");
        // 首条的时间戳/身份沿用。
        assert_eq!(batch.occurred_at, events[0].occurred_at);
        assert_eq!(batch.client_generation, events[0].client_generation);
        // user 行原样保留（引用下标 3）。
        assert_eq!(passthrough_index(&items[1]), 3);
    }

    #[test]
    fn identity_change_cuts_run() {
        // identity 变化即 run 边界：不合并，逐条落盘（单条 run 保持原事件）。
        let events = vec![
            text_delta(1, "A", "msg-1"),
            text_delta(2, "B", "msg-2"),
            user_message(3, "done"),
        ];
        let items = merge(events);
        assert_eq!(items.len(), 3);
        assert!(matches!(items[0], BatchItem::Event { index: 0 }));
        assert!(matches!(items[1], BatchItem::Event { index: 1 }));
        assert!(matches!(items[2], BatchItem::Event { index: 2 }));
    }

    #[test]
    fn type_switch_cuts_run_single_run_stays_original() {
        // 类型切换（text↔thinking）切断 run；单条 run 保持原事件不合成。
        let events = vec![
            text_delta(1, "a", "msg-1"),
            text_delta(2, "b", "msg-1"),
            thinking_delta(3, "think-1", "msg-1"),
            text_delta(4, "c", "msg-1"),
            user_message(5, "x"),
        ];
        let items = merge(events);
        assert_eq!(items.len(), 4);
        let batch = merged_row(&items[0]);
        assert_eq!(batch.text, "ab");
        assert_eq!(batch.folded_count, 2);
        assert_eq!(batch.seq_span, [1, 2]);
        assert!(matches!(items[1], BatchItem::Event { index: 2 }));
        assert!(matches!(items[2], BatchItem::Event { index: 3 }));
        assert!(matches!(items[3], BatchItem::Event { index: 4 }));
    }

    #[test]
    fn non_delta_event_cuts_run() {
        // 非 delta 事件穿插切断：工具卡两侧的 delta 不合并。
        let events = vec![
            text_delta(1, "before", "msg-1"),
            tool_start(2, "tool-1"),
            text_delta(3, "after", "msg-1"),
            user_message(4, "x"),
        ];
        let items = merge(events);
        assert_eq!(items.len(), 4);
        for index in 0..4 {
            assert!(matches!(items[index], BatchItem::Event { index: got } if got == index));
        }
    }

    #[test]
    fn empty_text_run_never_merges() {
        // 全空文本 chunk 的 run 不合并（逐行投影为 no-op，合并会新建空消息破坏等价）。
        let events = vec![
            empty_text_delta(1),
            empty_text_delta(2),
            user_message(3, "x"),
        ];
        let items = merge(events);
        assert_eq!(items.len(), 3);
        for index in 0..3 {
            assert!(matches!(items[index], BatchItem::Event { index: got } if got == index));
        }
    }

    #[test]
    fn folded_count_limit_cuts_into_multiple_rows() {
        // 对齐「foldedCount 上限（纯函数注入 limits）：达到上限切断成多行」。
        let events: Vec<CompactEvent> = (0..7)
            .map(|index| text_delta(index + 1, &format!("#{index}"), "msg-1"))
            .collect();
        let items = merge_adjacent_delta_chunks(
            &events,
            BatchLimits {
                max_raw_bytes: i64::MAX,
                max_folded_count: 3,
            },
        )
        .expect("merge");
        assert_eq!(items.len(), 3);
        let first = merged_row(&items[0]);
        assert_eq!(
            (first.text.as_str(), first.folded_count, first.seq_span),
            ("#0#1#2", 3, [1, 3])
        );
        let second = merged_row(&items[1]);
        assert_eq!(
            (second.text.as_str(), second.folded_count, second.seq_span),
            ("#3#4#5", 3, [4, 6])
        );
        assert!(matches!(items[2], BatchItem::Event { index: 6 }));
    }

    #[test]
    fn oversized_single_delta_stays_original() {
        // 单条 rawPayload 超字节上限的 delta 不成批、原样落盘（不截断）。
        let big_text = "大".repeat(40_000);
        let events = vec![
            text_delta(1, &big_text, "msg-1"),
            text_delta(2, "小", "msg-1"),
            user_message(3, "end"),
        ];
        let items = merge(events);
        // 40k CJK ≈ 120KB JSON（超过 48KiB 预算）→ 单条保持原事件；
        // 后续小 delta 自成 run 但单条不合并。
        assert_eq!(items.len(), 3);
        for index in 0..3 {
            assert!(matches!(items[index], BatchItem::Event { index: got } if got == index));
        }
    }

    /// 把 BatchRow 回装成 CompactEvent 视图（读侧访问器的输入形状）。
    fn row_as_event(row: &BatchRow) -> CompactEvent {
        let mut event = crate::events::test_support::event(row.event_type, row.sequence);
        event.owner_key = row.owner_key.clone();
        event.identity = row.identity.clone();
        event.text = Some(row.text.clone());
        event.raw_json = Some(serde_json::to_string(&row.raw_payload).expect("raw json"));
        event.typed_payload = Some(json!({
            "text": row.text,
            "foldedCount": row.folded_count,
            "seqSpan": [row.seq_span[0], row.seq_span[1]],
        }));
        event
    }

    #[test]
    fn byte_limit_cuts_before_count_limit_with_seamless_spans() {
        // 字节上限先于条数上限生效：2002 条小 chunk 切成多行且跨度无缝铺满
        // （切断 ≠ 截断）。
        let events: Vec<CompactEvent> = (0..2002)
            .map(|index| text_delta(index + 1, "x", "msg-1"))
            .collect();
        let items = merge(events);
        let batches: Vec<&BatchRow> = items
            .iter()
            .filter_map(|item| match item {
                BatchItem::BatchRow { row } => Some(row.as_ref()),
                _ => None,
            })
            .collect();
        assert!(batches.len() >= 2, "必须真的发生切断");
        let mut expected_next = 1i64;
        for batch in &batches {
            assert_eq!(
                batch.event_type,
                CanonicalEventType::AssistantTextDeltaBatch
            );
            let as_event = row_as_event(batch);
            let span = canonical_batch_span_of(&as_event).expect("span");
            assert_eq!(span[0], expected_next);
            assert_eq!(
                canonical_batch_chunk_count_of(&as_event).expect("chunks"),
                (span[1] - span[0] + 1) as usize
            );
            expected_next = span[1] + 1;
        }
        assert_eq!(expected_next, 2003);
    }

    #[test]
    fn malformed_batch_row_fails_chunk_count_check() {
        // foldedCount / seqSpan / 数组长度不互洽 → None（读侧走单行归一兜底）。
        let mut event =
            crate::events::test_support::event(CanonicalEventType::AssistantTextDeltaBatch, 3);
        event.typed_payload = Some(json!({ "text": "ab", "foldedCount": 3, "seqSpan": [1, 2] }));
        event.raw_json = Some(r#"[{"a":1},{"b":2}]"#.to_string());
        // span 只看 seqSpan 自身形状（与 TS canonicalBatchSpanOf 一致）；
        // 互洽性由 chunks 校验把关。
        assert_eq!(canonical_batch_span_of(&event), Some([1, 2]));
        assert_eq!(
            canonical_batch_chunk_count_of(&event),
            None,
            "foldedCount 与数组长度不互洽"
        );
        event.typed_payload = Some(json!({ "text": "ab", "foldedCount": 2, "seqSpan": [1, 2] }));
        assert_eq!(canonical_batch_chunk_count_of(&event), Some(2));
        event.typed_payload = Some(json!({ "text": "ab", "foldedCount": 5, "seqSpan": [1, 2] }));
        assert_eq!(canonical_batch_chunk_count_of(&event), None);
        // 非 batch 类型一律 None。
        let plain = crate::events::test_support::event(CanonicalEventType::AssistantTextDelta, 1);
        assert_eq!(canonical_batch_span_of(&plain), None);
    }

    #[test]
    fn frame_round_trip_preserves_merge_result() {
        // 帧入口（append(batch) 形态）与内存入口产出一致。
        let events = vec![
            text_delta(1, "a", "msg-1"),
            text_delta(2, "b", "msg-1"),
            user_message(3, "x"),
        ];
        let frame = encode_frame(&events);
        let decoded = decode_batch(&frame).expect("decode");
        let direct = merge_adjacent_delta_chunks(&events, BatchLimits::default()).expect("direct");
        let via_frame =
            merge_adjacent_delta_chunks(&decoded, BatchLimits::default()).expect("frame");
        assert_eq!(direct.len(), via_frame.len());
        let first = merged_row(&direct[0]);
        let frame_first = merged_row(&via_frame[0]);
        assert_eq!(frame_first.text, first.text);
        assert_eq!(frame_first.seq_span, first.seq_span);
        assert_eq!(frame_first.event_id, first.event_id);
        assert_eq!(frame_first.raw_payload, first.raw_payload);
    }
}
