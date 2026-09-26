//! 凭据脱敏策略单点：canonical journal 是 durable authority，任何 payload 在
//! 入库前必须经过本模块的清洗（credential 键识别 + 递归脱敏 + raw 截断保留）。
//! C12/DIC-C12-01：projector/renderer 的后置遮挡不能补救落盘泄漏——脱敏只在这里做，
//! 写入路径（kernel normalize 与 EVT-01 append parse）一律经由本模块，不得另起第二份规则。

pub(super) const MAX_CANONICAL_RAW_BYTES: usize = 64 * 1024;

fn is_journal_credential_key(key: &str, interaction_payload: bool) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect::<String>();
    if normalized.ends_with("redacted") {
        return false;
    }
    matches!(
        normalized.as_str(),
        "password" | "authorization" | "cookie" | "credential" | "credentials" | "tokenvalue"
    ) || normalized.ends_with("token")
        || normalized.ends_with("apikey")
        || normalized.ends_with("secret")
        || (interaction_payload && normalized == "value")
}

/// C12/DIC-C12-01：canonical journal 是 durable authority，credential 必须在 append
/// 之前递归替换为 omission metadata；projector/renderer 的后置遮挡不能补救落盘泄漏。
pub(super) fn redact_journal_credentials(
    value: serde_json::Value,
    interaction_payload: bool,
) -> serde_json::Value {
    match value {
        serde_json::Value::Object(object) => {
            let nested_interaction = interaction_payload
                || object
                    .get("kind")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|kind| matches!(kind, "oauth" | "secret" | "sudo"));
            let nested_interaction = nested_interaction
                || object
                    .get("request")
                    .and_then(serde_json::Value::as_object)
                    .and_then(|request| request.get("kind"))
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|kind| matches!(kind, "oauth" | "secret" | "sudo"));
            let mut safe = serde_json::Map::new();
            for (key, child) in object {
                if is_journal_credential_key(&key, nested_interaction) {
                    if !child.is_null() && child != serde_json::Value::String(String::new()) {
                        safe.insert(format!("{key}Redacted"), serde_json::Value::Bool(true));
                    }
                    continue;
                }
                let sanitized = redact_journal_credentials(child, nested_interaction);
                safe.insert(key, sanitized);
            }
            serde_json::Value::Object(safe)
        }
        serde_json::Value::Array(values) => serde_json::Value::Array(
            values
                .into_iter()
                .map(|child| redact_journal_credentials(child, interaction_payload))
                .collect(),
        ),
        serde_json::Value::String(text) => {
            serde_json::Value::String(pylon_foundations::sanitize::sanitize_value_content(&text))
        }
        other => other,
    }
}

/// 返回 (截断后的 raw_payload, 入库 JSON 文本, 截断标记, 字节统计…)。
/// 入库文本 = `raw_payload.to_string()`（serde_json 序列化确定 → 逐字节相等），
/// 调用方直接绑定 INSERT，免二次全量序列化；retained_bytes 统计复用同一文本。
pub(super) fn retain_raw_payload(
    raw: serde_json::Value,
) -> (serde_json::Value, String, bool, i64, i64, i64) {
    let encoded = raw.to_string();
    let original = encoded.len() as i64;
    if encoded.len() <= MAX_CANONICAL_RAW_BYTES {
        return (raw, encoded, false, original, original, 0);
    }
    let preview_len = MAX_CANONICAL_RAW_BYTES.saturating_sub(96);
    let preview = encoded.chars().take(preview_len).collect::<String>();
    let retained = serde_json::json!({
        "_pylonTruncated": true,
        "preview": preview,
        "originalBytes": original,
    });
    let retained_encoded = retained.to_string();
    let retained_bytes = retained_encoded.len() as i64;
    (
        retained,
        retained_encoded,
        true,
        original,
        retained_bytes,
        original.saturating_sub(retained_bytes),
    )
}

/// 收口后挂回 typed 载荷的保留键。与 raw 的 `_pylonTruncated` 同惯例：下划线前缀、
/// 不属于 canonical 载荷语义，读侧凭它判断「这一行的 typed 被收缩过」。
pub(super) const TYPED_TRUNCATION_KEY: &str = "_pylonTypedTruncated";

/// 标记里 `reason` 的固定取值（与 raw 的 `raw_truncation_reason` 同一取证惯例）。
const TYPED_TRUNCATION_REASON: &str = "read-path-typed-cap";

/// 参与按比例收缩的字符串叶子下限（字节）。低于此长度的字符串是标题/状态/ID 一类
/// 标量面，收口时不碰它们——只有在收缩「负载字符串」仍不足以落回预算内时，才连它们
/// 一起按比例收缩。
const TYPED_PAYLOAD_STRING_FLOOR: usize = 1024;

/// 标记自身的预算预留：按各数字段最大位数（10 位十进制）序列化一次取长度，另加 1
/// 字节给它与前一个键之间的逗号。预留取上界 ⇒「先收口、再挂标记」不会越线。
fn typed_truncation_marker_reserve() -> usize {
    let skeleton = serde_json::json!({
        TYPED_TRUNCATION_KEY: {
            "payloadOriginalBytes": 9_999_999_999i64,
            "trimmedStringLeaves": 9_999_999_999i64,
            "reason": TYPED_TRUNCATION_REASON,
        }
    });
    skeleton.to_string().len() + 1
}

/// 字符串叶子的原始字节总量；`floor` = 0 时统计全部字符串。
fn string_leaf_bytes(value: &serde_json::Value, floor: usize) -> usize {
    match value {
        serde_json::Value::String(text) if text.len() >= floor => text.len(),
        serde_json::Value::String(_) => 0,
        serde_json::Value::Array(items) => items
            .iter()
            .map(|item| string_leaf_bytes(item, floor))
            .sum(),
        serde_json::Value::Object(map) => map
            .values()
            .map(|child| string_leaf_bytes(child, floor))
            .sum(),
        _ => 0,
    }
}

/// 不超过 `index` 的最大字符边界（UTF-8 安全：多字节字符绝不从中间切开）。
fn floor_char_boundary(text: &str, index: usize) -> usize {
    if index >= text.len() {
        return text.len();
    }
    let mut boundary = index;
    while boundary > 0 && !text.is_char_boundary(boundary) {
        boundary -= 1;
    }
    boundary
}

/// 按同一个比例收缩字符串叶子：`keep_i = len_i * allowed / target`（整数除法向下取整，
/// 故 `Σkeep ≤ allowed` 恒成立，与遍历顺序无关）。键与非字符串标量逐字节不动。
struct TypedScale {
    allowed: usize,
    target: usize,
    floor: usize,
}

fn scale_string_leaves(value: &mut serde_json::Value, scale: &TypedScale, trimmed: &mut usize) {
    match value {
        serde_json::Value::String(text) => {
            if text.len() < scale.floor {
                return;
            }
            let keep = text.len().saturating_mul(scale.allowed) / scale.target;
            if keep >= text.len() {
                return;
            }
            let boundary = floor_char_boundary(text, keep);
            text.truncate(boundary);
            *trimmed += 1;
        }
        serde_json::Value::Array(items) => {
            for item in items {
                scale_string_leaves(item, scale, trimmed);
            }
        }
        serde_json::Value::Object(map) => {
            for child in map.values_mut() {
                scale_string_leaves(child, scale, trimmed);
            }
        }
        _ => {}
    }
}

/// #376：读出口 typed 载荷收口——**只收缩字符串叶子**，键与非字符串标量逐字节不动；
/// 预算内原样返回（逐字节不变）。与 `retain_raw_payload` 共用 `MAX_CANONICAL_RAW_BYTES`
/// 这同一条线，且同在写入侧脱敏模块内，读侧规则不另起第二份。
///
/// 为什么不复用 `retain_raw_payload` 的「整份替换 + preview」：typed 是标量面的唯一
/// 来源（hook / touched-file / turn 时长 / legacy 消息文案都从它的字段取值），整份替换
/// 会把这些读点一并打成空值。收口只牺牲超长正文的尾部、结构不变 ⇒ 现有读点全部继续成立。
///
/// 收敛性：被移除的 raw 字节数 ≥ 被移除的序列化字节数（每个被移走的字符在 JSON 字面量
/// 里至少占 1 字节），故以 `excess`（序列化口径）为收缩目标必然落回预算内。
pub(super) fn retain_typed_payload(typed: serde_json::Value) -> serde_json::Value {
    let encoded = typed.to_string();
    if encoded.len() <= MAX_CANONICAL_RAW_BYTES {
        return typed;
    }
    let original = encoded.len() as i64;
    if !typed.is_object() {
        // 形状异常（canonical normalize 恒产出对象）：退回与 raw 同款的整体截断，
        // 让「超预算必落在 64 KiB 内」这条硬要求不因形状漏掉。
        return retain_raw_payload(typed).0;
    }
    let budget = MAX_CANONICAL_RAW_BYTES.saturating_sub(typed_truncation_marker_reserve());
    let excess = encoded.len().saturating_sub(budget);
    let all_strings = string_leaf_bytes(&typed, 0);
    let payload_strings = string_leaf_bytes(&typed, TYPED_PAYLOAD_STRING_FLOOR);
    let (allowed, target, floor) = if payload_strings >= excess {
        (
            payload_strings - excess,
            payload_strings,
            TYPED_PAYLOAD_STRING_FLOOR,
        )
    } else {
        (all_strings.saturating_sub(excess), all_strings, 0)
    };
    if target == 0 {
        // 没有字符串可收缩却仍超预算（键本身就有 64 KiB）——无可收口面，退回整体截断。
        return retain_raw_payload(typed).0;
    }
    let serde_json::Value::Object(mut object) = typed else {
        unreachable!("is_object 已判定")
    };
    let scale = TypedScale {
        allowed,
        target,
        floor,
    };
    let mut trimmed = 0usize;
    for child in object.values_mut() {
        scale_string_leaves(child, &scale, &mut trimmed);
    }
    object.insert(
        TYPED_TRUNCATION_KEY.to_string(),
        serde_json::json!({
            "payloadOriginalBytes": original,
            "trimmedStringLeaves": trimmed,
            "reason": TYPED_TRUNCATION_REASON,
        }),
    );
    serde_json::Value::Object(object)
}
