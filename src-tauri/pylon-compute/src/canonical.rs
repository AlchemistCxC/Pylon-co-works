//! canonical 事件契约的 JS 出口（WP1）。
//!
//! 本模块**不实现**任何 canonical 逻辑，只是把 `pylon-canonical-types` 的单源
//! 事实暴露给 JS。存在的理由是那条刻意的迁移路线：词表与「wire 判别符 → canonical
//! 类型」映射此前在 TS（`domains/events/{eventSchema,canonicalNormalizer}.ts`）与
//! Rust（`session/event_repo.rs`）各写一份；单源化之后 TS 侧不再手抄，而是消费本
//! 模块的出口（`src/wasm/` 的生成物）。
//!
//! # 分层：纯内层 + wasm 薄壳
//!
//! 每个出口都拆成两层——**内层是普通 Rust 函数**（`&str` 进、`String` 出、
//! 错误用 `String`），**外层是 `#[wasm_bindgen]` 薄壳**把结果与错误转成 JS 值。
//! 这不是风格洁癖：`JsError::new` 在非 wasm 目标上会走 wasm-bindgen 的导入桩并
//! **panic**（`cannot call wasm-bindgen imported functions on non-wasm targets`），
//! 于是任何在宿主上跑的失败路径测试都会炸。计算核的契约测试（D1/D2 计量、切分
//! 不变量、property test）必须能在宿主上跑，所以**可失败逻辑一律不进 wasm 壳**。
//!
//! # 边界约定
//!
//! - `sequence` 走 `f64` 而不是 `i64`——wasm-bindgen 把 `i64` 映射成 BigInt，
//!   会强迫所有调用点改写算术。canonical sequence 由契约规定为正整数
//!   （`validateCanonicalEvent` 同样要求 `Number.isInteger`），因此这里按
//!   「有限、整数值、非负」校验后转 `i64`，越界即报错而不是静默截断。
//! - 错误消息里带上违规的输入，便于在 vitest 侧断言。

use pylon_canonical_types::CanonicalEventType;
use wasm_bindgen::prelude::*;

// ── 纯内层（宿主可测，零 JS 依赖） ───────────────────────────────────────────

/// canonical 事件类型词表（声明顺序即 wire 顺序）。
pub fn event_types() -> &'static [&'static str] {
    pylon_canonical_types::CANONICAL_EVENT_TYPES
}

/// wire `sessionUpdate` 判别符 → canonical 事件类型。
///
/// 未识别 / 缺失判别符返回 `"unknown"`（§5.10 原则 5：不静默丢弃，raw 由调用方保留）。
pub fn event_type_for(session_update: Option<&str>, status: Option<&str>) -> &'static str {
    pylon_canonical_types::canonical_event_type_for(session_update, status).as_str()
}

/// 值是否在 canonical 词表内（用于把未知字符串与词表区分开，不抛错）。
pub fn is_event_type(value: &str) -> bool {
    CanonicalEventType::from_wire(value).is_some()
}

/// owner key = `["profileId","agentId","localSessionId"]` 的 JSON 序列化。
///
/// **禁止冒号拼接**：`source`/`localSessionId` 都可能含冒号，拼接会让两个不同 owner
/// 撞同一个 key。与 TS `toCanonicalOwnerKey`、Rust `DurableSessionOwner::key()` 逐字节一致。
pub fn owner_key(
    profile_id: &str,
    agent_id: &str,
    local_session_id: &str,
) -> Result<String, String> {
    pylon_canonical_types::canonical_owner_key(profile_id, agent_id, local_session_id)
        .map_err(|error| format!("owner key 序列化失败: {error}"))
}

/// 事件唯一标识：`ownerKey#sequence`（与内容无关，禁 content 哈希）。
pub fn event_id(owner_key: &str, sequence: f64) -> Result<String, String> {
    Ok(pylon_canonical_types::canonical_event_id(
        owner_key,
        to_sequence(sequence)?,
    ))
}

/// sequence 纯原语：`None` → 1（首事件），否则 +1。
pub fn next_sequence(previous: Option<f64>) -> Result<f64, String> {
    let previous = previous.map(to_sequence).transpose()?;
    Ok(pylon_canonical_types::next_event_sequence(previous) as f64)
}

/// canonical sequence 的边界校验：有限、整数值、非负、在 `i64` 值域内。
fn to_sequence(value: f64) -> Result<i64, String> {
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(format!("sequence 必须是整数值（收到 {value}）"));
    }
    if value < 0.0 {
        return Err(format!("sequence 不能为负（收到 {value}）"));
    }
    if value > i64::MAX as f64 {
        return Err(format!("sequence 超出 i64 值域（收到 {value}）"));
    }
    Ok(value as i64)
}

// ── wasm 薄壳（只做值/错误转换） ─────────────────────────────────────────────

#[wasm_bindgen(js_name = canonicalEventTypes)]
pub fn canonical_event_types() -> Result<JsValue, JsError> {
    serde_wasm_bindgen::to_value(event_types())
        .map_err(|error| JsError::new(&format!("词表序列化失败: {error}")))
}

#[wasm_bindgen(js_name = canonicalEventTypeFor)]
pub fn canonical_event_type_for(session_update: Option<String>, status: Option<String>) -> String {
    event_type_for(session_update.as_deref(), status.as_deref()).to_string()
}

#[wasm_bindgen(js_name = isCanonicalEventType)]
pub fn is_canonical_event_type(value: &str) -> bool {
    is_event_type(value)
}

#[wasm_bindgen(js_name = canonicalOwnerKey)]
pub fn canonical_owner_key(
    profile_id: &str,
    agent_id: &str,
    local_session_id: &str,
) -> Result<String, JsError> {
    owner_key(profile_id, agent_id, local_session_id).map_err(|error| JsError::new(&error))
}

#[wasm_bindgen(js_name = canonicalEventId)]
pub fn canonical_event_id(owner_key: &str, sequence: f64) -> Result<String, JsError> {
    event_id(owner_key, sequence).map_err(|error| JsError::new(&error))
}

#[wasm_bindgen(js_name = nextEventSequence)]
pub fn next_event_sequence(previous: Option<f64>) -> Result<f64, JsError> {
    next_sequence(previous).map_err(|error| JsError::new(&error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminant_mapping_is_the_shared_one() {
        // 本出口必须是 pylon-canonical-types 的直通，不能在这里长出第二份 switch。
        for update in [
            Some("user_message_chunk"),
            Some("agent_message_chunk"),
            Some("tool_call_update"),
            Some("nope"),
            None,
        ] {
            assert_eq!(
                event_type_for(update, Some("completed")),
                pylon_canonical_types::canonical_event_type_for(update, Some("completed")).as_str()
            );
        }
    }

    #[test]
    fn vocabulary_membership_matches_the_crate() {
        for wire in pylon_canonical_types::CANONICAL_EVENT_TYPES {
            assert!(is_event_type(wire), "{wire} 应在词表内");
        }
        assert!(!is_event_type("turn.started"));
    }

    #[test]
    fn owner_key_matches_the_crate() {
        assert_eq!(
            owner_key("p", "a", "l").expect("key"),
            pylon_canonical_types::canonical_owner_key("p", "a", "l").expect("key")
        );
    }

    #[test]
    fn sequence_validation_is_fail_closed() {
        assert_eq!(to_sequence(3.0).expect("int"), 3);
        assert!(to_sequence(3.5).is_err(), "小数必须报错，不能截断");
        assert!(to_sequence(f64::NAN).is_err());
        assert!(to_sequence(f64::INFINITY).is_err());
        assert!(to_sequence(-1.0).is_err());
        assert_eq!(next_sequence(None).expect("first"), 1.0);
        assert_eq!(next_sequence(Some(41.0)).expect("next"), 42.0);
        assert!(next_sequence(Some(0.5)).is_err());
    }

    #[test]
    fn event_id_is_owner_key_hash_sequence() {
        let key = owner_key("p", "a", "l").expect("key");
        assert_eq!(event_id(&key, 3.0).expect("id"), format!("{key}#3"));
        assert!(event_id(&key, 1.5).is_err());
    }
}
