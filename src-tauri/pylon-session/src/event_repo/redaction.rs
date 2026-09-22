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
