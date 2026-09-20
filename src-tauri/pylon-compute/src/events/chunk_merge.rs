//! chunk_merge — 三路径投影深等的 chunk 聚合判据（TS `chunkMerge.ts` 的逐函数对齐）。
//!
//! live flush / replay reducer / canonical projection 共用同一套规则：
//! - last 与 incoming 同角色（assistant / reasoning）→ 聚合；
//! - 聚合后的 identity = incoming ?? last（与 live streamingIdentity 一致）；
//! - 跨角色（assistant ↔ reasoning ↔ tool ↔ user）→ 新建消息。
//!
//! 消息边界由 user/tool/turn 事件决定，不由 identity 决定——identity 只是元数据。
//! 纯函数：零 React / 零 store。

use serde::Serialize;
use wasm_bindgen::prelude::*;

use super::ChatIdentity;

/// 相邻 chunk 是否应并入上一条消息，以及合并后应采用的 identity（三路径共用）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChunkAppendResolution {
    #[serde(rename = "shouldAppend")]
    pub should_append: bool,
    /// 合并后消息的 externalIdentity；双方都无 identity 时为 None。
    #[serde(rename = "identity", skip_serializing_if = "Option::is_none")]
    pub identity: Option<ChatIdentity>,
}

pub fn resolve_chunk_append_inner(
    last_role: Option<&str>,
    incoming_role: &str,
    last_identity: Option<&ChatIdentity>,
    incoming_identity: Option<&ChatIdentity>,
) -> ChunkAppendResolution {
    if last_role != Some(incoming_role) {
        return ChunkAppendResolution {
            should_append: false,
            identity: None,
        };
    }
    // identity 取「最后出现的」：incoming ?? last。
    let identity = incoming_identity.or(last_identity).cloned();
    ChunkAppendResolution {
        should_append: true,
        identity,
    }
}

// ── wasm 薄壳 ────────────────────────────────────────────────────────────────

fn chat_identity_from_js(value: JsValue) -> Result<Option<ChatIdentity>, String> {
    if value.is_null() || value.is_undefined() {
        return Ok(None);
    }
    let object: serde_json::Value = serde_wasm_bindgen::from_value(value)
        .map_err(|error| format!("identity 反序列化失败: {error}"))?;
    let object = object
        .as_object()
        .ok_or_else(|| "identity 必须是对象".to_string())?;
    let string_field = |name: &str| {
        object
            .get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    Ok(Some(ChatIdentity {
        message_id: string_field("messageId"),
        turn_id: string_field("turnId"),
        tool_call_id: string_field("toolCallId"),
    }))
}

/// TS `resolveChunkAppend` 的直通出口（三条调用路径的规则同源，parity 钉死）。
#[wasm_bindgen(js_name = resolveChunkAppend)]
pub fn resolve_chunk_append(
    last_role: Option<String>,
    incoming_role: String,
    last_identity: JsValue,
    incoming_identity: JsValue,
) -> Result<JsValue, JsError> {
    fn inner(
        last_role: Option<String>,
        incoming_role: String,
        last_identity: JsValue,
        incoming_identity: JsValue,
    ) -> Result<JsValue, String> {
        let last_identity = chat_identity_from_js(last_identity)?;
        let incoming_identity = chat_identity_from_js(incoming_identity)?;
        let resolution = resolve_chunk_append_inner(
            last_role.as_deref(),
            &incoming_role,
            last_identity.as_ref(),
            incoming_identity.as_ref(),
        );
        crate::events::to_js(&resolution)
    }
    inner(last_role, incoming_role, last_identity, incoming_identity)
        .map_err(|error| JsError::new(&error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(message_id: &str) -> Option<ChatIdentity> {
        Some(ChatIdentity {
            message_id: Some(message_id.into()),
            turn_id: None,
            tool_call_id: None,
        })
    }

    #[test]
    fn same_role_appends_and_takes_incoming_identity() {
        let resolution = resolve_chunk_append_inner(
            Some("assistant"),
            "assistant",
            identity("m-1").as_ref(),
            identity("m-2").as_ref(),
        );
        assert!(resolution.should_append);
        assert_eq!(resolution.identity, identity("m-2"));
    }

    #[test]
    fn cross_role_starts_new_message() {
        let resolution = resolve_chunk_append_inner(
            Some("assistant"),
            "reasoning",
            identity("m-1").as_ref(),
            None,
        );
        assert!(!resolution.should_append);
        assert_eq!(resolution.identity, None);
    }

    #[test]
    fn no_last_role_never_appends() {
        let resolution =
            resolve_chunk_append_inner(None, "assistant", None, identity("m-1").as_ref());
        assert!(!resolution.should_append);
    }

    #[test]
    fn identity_falls_back_to_last_when_incoming_missing() {
        let resolution = resolve_chunk_append_inner(
            Some("reasoning"),
            "reasoning",
            identity("m-1").as_ref(),
            None,
        );
        assert!(resolution.should_append);
        assert_eq!(resolution.identity, identity("m-1"));
    }
}
