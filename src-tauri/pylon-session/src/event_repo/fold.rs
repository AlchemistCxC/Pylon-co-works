//! delta 折叠 / rollup 压缩：相邻同类 delta run 折叠为 `*.delta.batch` 行
//! （读写两侧共用，ADR-0016）。

use super::row::CanonicalEventRow;

/// #205：读侧尾部折叠预算——与写侧 `canonicalEventBatch.CANONICAL_BATCH_LIMITS` 同口径
/// （48 KiB / 2000 chunk，落在 `retain_raw_payload` 的 64 KiB 截断线之内）。读侧不需要
/// 截断约束，沿用该预算只为产出「同一种 batch 行形状」，任何既有解析路径都认。
pub(super) const MAX_FOLDED_CHUNKS: usize = 2000;
pub(super) const MAX_FOLD_BYTES: usize = 48 * 1024;

/// 该行能否参与折叠：静态 delta 类型，且 `typed_payload.text` 是 string。
/// `.batch` 行不二次折叠。**text 门控与写侧同款**：无 string text 的 chunk 在逐行投影里
/// 该行承载了几个输入（写入侧配对用）：`*.delta.batch` 行按 `seqSpan` 宽度计，其余为 1。
///
/// 与 `mergeAdjacentDeltaChunks` 的跨度契约配套：span 内每一号都落在这唯一一行里，
/// 因此 dispatcher 把「一个输入一条结果」的配对改成「按跨度展开配对」。
pub fn row_input_span_width(row: &CanonicalEventRow) -> usize {
    if !row.event_type.ends_with(".batch") {
        return 1;
    }
    let span = row
        .typed_payload
        .as_ref()
        .and_then(|typed| typed.get("seqSpan"))
        .and_then(serde_json::Value::as_array);
    let Some(span) = span else { return 1 };
    let (Some(start), Some(end)) = (
        span.first().and_then(serde_json::Value::as_i64),
        span.get(1).and_then(serde_json::Value::as_i64),
    ) else {
        return 1;
    };
    if start < 1 || end < start || end != row.sequence {
        return 1;
    }
    usize::try_from(end - start + 1).unwrap_or(1)
}

/// 是 no-op（不新建消息），折进 batch 行会把 no-op 变成新建消息 ⇒ 破坏投影等价。
pub(super) fn foldable_delta_base(row: &CanonicalEventRow) -> Option<&'static str> {
    if row.event_type.ends_with(".batch") {
        return None;
    }
    let base = crate::turn_rollup::static_delta_type(&row.event_type)?;
    let has_text = row
        .typed_payload
        .as_ref()
        .and_then(|typed| typed.get("text"))
        .is_some_and(serde_json::Value::is_string);
    has_text.then_some(base)
}

/// identity 四键全等（与前端 `sameIdentity` 同口径：两边都缺失算相等，null 与缺失不等）。
pub(super) fn identity_keys_equal(
    left: &Option<serde_json::Value>,
    right: &Option<serde_json::Value>,
) -> bool {
    const KEYS: [&str; 4] = ["messageId", "turnId", "toolCallId", "requestId"];
    KEYS.iter().all(|key| {
        match (
            left.as_ref().and_then(|value| value.get(*key)),
            right.as_ref().and_then(|value| value.get(*key)),
        ) {
            (None, None) => true,
            (Some(left), Some(right)) => left == right,
            _ => false,
        }
    })
}

/// 折叠预算按**入库序列化文本**计：`raw_payload_json` 与 `raw_payload.to_string()` 逐字节
/// 相等（v15 不变量），也正是前端 `encodedByteLength(JSON.stringify(raw))` 的口径——
/// 免掉逐行再序列化一次。
pub(super) fn raw_payload_bytes(row: &CanonicalEventRow) -> usize {
    row.raw_payload_json.len()
}

/// run 收口：长度 < 2 原样放回（与写侧「单条 run 不合并」一致），≥ 2 产出 batch 行。
pub(super) fn flush_delta_run(
    out: &mut Vec<CanonicalEventRow>,
    chunks: Vec<CanonicalEventRow>,
    base: Option<&'static str>,
) {
    let Some(base) = base else { return };
    if chunks.len() < 2 {
        out.extend(chunks);
        return;
    }
    let first_sequence = chunks[0].sequence;
    // 不可达分支：上方 `chunks.len() < 2` 已早退，此处 run 至少两行、last 必存在。
    let Some(last) = chunks.last() else {
        out.extend(chunks);
        return;
    };
    let last_sequence = last.sequence;
    let last_event_id = last.event_id.clone();
    let folded_count = chunks.len();
    let mut row = chunks[0].clone();
    let mut text = String::new();
    let mut raw_items: Vec<serde_json::Value> = Vec::with_capacity(folded_count);
    for chunk in chunks {
        if let Some(part) = chunk
            .typed_payload
            .as_ref()
            .and_then(|typed| typed.get("text"))
            .and_then(serde_json::Value::as_str)
        {
            text.push_str(part);
        }
        raw_items.push(chunk.raw_payload);
    }
    row.event_type = format!("{base}.batch");
    // 跨度占用：行取段末的 sequence/eventId，段内编号不被任何行占用，读侧按
    // `owner#(seqSpan[0]+i)` 重建原始 id（`canonicalEventBatch` 的既有契约）。
    row.sequence = last_sequence;
    row.event_id = last_event_id;
    row.typed_payload = Some(serde_json::json!({
        "text": text,
        "foldedCount": folded_count,
        "seqSpan": [first_sequence, last_sequence],
    }));
    row.raw_payload = serde_json::Value::Array(raw_items);
    // 维持 v15 不变量：raw_payload_json == raw_payload.to_string()。
    row.raw_payload_json = row.raw_payload.to_string();
    row.rollup_seq_start = None;
    row.rollup_seq_end = None;
    out.push(row);
}

/// 相邻同类 delta 的行聚合（**读写两侧共用**；ADR-0016）：把 identity 全等、sequence 连续的
/// delta run 折成一条 `*.delta.batch` 行——span 占位，幸存行挪到跨度末位并带 `seqSpan`，
/// span 中间的裸行不再存在。形状与前端 `canonicalEventBatch.mergeAdjacentDeltaChunks` 同一契约，
/// `canonicalRowToWorkbench` 已有展开路径（逐 chunk 重建事件 id 与 coverage），故与逐行存储
/// **投影等价**。
///
/// - 读侧（#205）：compact 读过滤出「单元 + 未覆盖行」后调用，对存量 journal 立即生效；
/// - 写侧（ADR-0016 / #155 T3-1）：`ingest_kernel_events` 顺序折叠后落盘，行数随之下降。
///
/// 两侧共用同一实现与同一预算（48 KiB / 2000 chunk），不存在第二份规则。`evt_list` 分页读不折叠。
pub(super) fn fold_adjacent_delta_runs(rows: Vec<CanonicalEventRow>) -> Vec<CanonicalEventRow> {
    let mut out: Vec<CanonicalEventRow> = Vec::with_capacity(rows.len());
    let mut run: Vec<CanonicalEventRow> = Vec::new();
    let mut run_base: Option<&'static str> = None;
    let mut run_bytes: usize = 0;
    for row in rows {
        let base = foldable_delta_base(&row);
        let extend = match (base, run.last(), run_base) {
            (Some(base), Some(last), Some(current)) => {
                current == base
                    && row.sequence == last.sequence + 1
                    && identity_keys_equal(&last.identity, &row.identity)
                    && run.len() < MAX_FOLDED_CHUNKS
                    && run_bytes + raw_payload_bytes(&row) <= MAX_FOLD_BYTES
            }
            _ => false,
        };
        if extend {
            run_bytes += raw_payload_bytes(&row);
            run.push(row);
            continue;
        }
        flush_delta_run(&mut out, std::mem::take(&mut run), run_base.take());
        run_bytes = 0;
        match base {
            // 单条自身就超预算的 delta 不成批（与写侧一致：不截断，原样保留）。
            Some(base) if raw_payload_bytes(&row) <= MAX_FOLD_BYTES => {
                run_bytes = raw_payload_bytes(&row);
                run_base = Some(base);
                run.push(row);
            }
            _ => out.push(row),
        }
    }
    flush_delta_run(&mut out, run, run_base);
    out
}
