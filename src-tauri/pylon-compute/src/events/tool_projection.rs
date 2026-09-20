//! EVT-04：Message/Tool projection（TS `toolProjection.ts` 的逐函数对齐）。
//!
//! §5.11 验收：同一个 ACP event 通过 live、replay、restart 三条路径，最终
//! ToolProjection 的以下字段深等：toolCallId / toolName(title) / kind / rawInput /
//! rawOutput / status / contentBlocks / owner / clientGeneration。
//!
//! 工具字段一律自 canonical `typedPayload.tool` 提取（`toolFieldsFromCanonical`
//! 单一路径；caller 不得再读 wire 别名）。非工具事件返回 None——与 TS 一致，
//! 不抛错。

use serde::Serialize;
use wasm_bindgen::prelude::*;

use super::{tool_fields_from_payload, CompactEvent, EventOwner, ToolFields};
use pylon_canonical_types::CanonicalEventType;

/// §5.11 验收投影字段（9 项，字段不丢）。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolProjection {
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// wire title（§5.11 "toolName/title" 同义）。
    #[serde(rename = "toolName", skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(rename = "rawInput", skip_serializing_if = "Option::is_none")]
    pub raw_input: Option<serde_json::Value>,
    #[serde(rename = "rawOutput", skip_serializing_if = "Option::is_none")]
    pub raw_output: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(rename = "contentBlocks", skip_serializing_if = "Option::is_none")]
    pub content_blocks: Option<serde_json::Value>,
    pub owner: serde_json::Value,
    #[serde(rename = "clientGeneration")]
    pub client_generation: i64,
}

fn is_tool_event(event_type: CanonicalEventType) -> bool {
    matches!(
        event_type,
        CanonicalEventType::ToolCallStarted
            | CanonicalEventType::ToolCallUpdated
            | CanonicalEventType::ToolCallCompleted
            | CanonicalEventType::ToolCallFailed
    )
}

fn tool_fields_or_empty(tool: Option<&ToolFields>) -> ToolFields {
    tool.cloned().unwrap_or_default()
}

fn projection_from(
    tool_call_id: Option<String>,
    fields: ToolFields,
    owner: &EventOwner,
    client_generation: i64,
) -> ToolProjection {
    ToolProjection {
        tool_call_id,
        tool_name: fields.title,
        kind: fields.kind,
        raw_input: fields.raw_input,
        raw_output: fields.raw_output,
        status: fields.status,
        content_blocks: fields.content_blocks,
        owner: owner.to_value(),
        client_generation,
    }
}

/// canonical 工具事件 → 全字段 ToolProjection；非工具事件返回 None。
pub fn project_tool_from_canonical_inner(event: &CompactEvent) -> Option<ToolProjection> {
    if !is_tool_event(event.event_type) {
        return None;
    }
    let tool_call_id = event
        .identity
        .as_ref()
        .and_then(|identity| identity.tool_call_id.clone());
    let fields = tool_fields_or_empty(event.tool.as_ref());
    Some(projection_from(
        tool_call_id,
        fields,
        &event.owner,
        event.client_generation,
    ))
}

/// Message 级投影所需的最小 tool 字段集（controller 落为 tool Message 后投影）。
#[derive(Debug, Default)]
pub struct ProjectableToolMessage {
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub tool_kind: Option<String>,
    pub raw_input: Option<serde_json::Value>,
    pub raw_output: Option<serde_json::Value>,
    pub tool_status: Option<String>,
    pub content_blocks: Option<serde_json::Value>,
}

/// Message 级投影（三路径验收：同一 ACP event 经 live/replay/restart 落为 tool
/// Message 后，以同一 owner/generation 投影深等）。owner 由权威 session 解析
/// （profileId+agentId+localSessionId 与 canonical 事件 owner 同一来源）。
pub fn project_tool_from_message_inner(
    message: &ProjectableToolMessage,
    owner: &EventOwner,
    client_generation: i64,
) -> Option<ToolProjection> {
    // 与 TS 一致：三身份字段全 undefined 才返回 undefined（空串算 defined）。
    if message.tool_call_id.is_none() && message.tool_name.is_none() && message.tool_kind.is_none()
    {
        return None;
    }
    Some(ToolProjection {
        tool_call_id: message.tool_call_id.clone(),
        tool_name: message.tool_name.clone(),
        kind: message.tool_kind.clone(),
        raw_input: message.raw_input.clone(),
        raw_output: message.raw_output.clone(),
        status: message.tool_status.clone(),
        content_blocks: message.content_blocks.clone(),
        owner: owner.to_value(),
        client_generation,
    })
}

// ── wasm 薄壳 ────────────────────────────────────────────────────────────────

/// 整页工具投影入口（批量形态）：返回与事件等长的数组，非工具事件位为 `null`。
#[wasm_bindgen(js_name = projectToolProjectionsFromBatch)]
pub fn project_tool_projections_from_batch(frame: &[u8]) -> Result<JsValue, JsError> {
    fn inner(frame: &[u8]) -> Result<JsValue, String> {
        let events = super::decode_batch(frame)?;
        let mut out = Vec::with_capacity(events.len());
        for event in &events {
            out.push(project_tool_from_canonical_inner(event));
        }
        crate::events::to_js(&out)
    }
    inner(frame).map_err(|error| JsError::new(&error))
}

/// TS `toolFieldsFromCanonical` 的直通出口（typedPayload JsValue 进出）。
#[wasm_bindgen(js_name = toolFieldsFromCanonical)]
pub fn tool_fields_from_canonical(typed_payload: JsValue) -> Result<JsValue, JsError> {
    fn inner(typed_payload: JsValue) -> Result<JsValue, String> {
        let typed: serde_json::Value = serde_wasm_bindgen::from_value(typed_payload)
            .map_err(|error| format!("typedPayload 反序列化失败: {error}"))?;
        // TS 对非对象 typedPayload 取 undefined tool ⇒ 全 undefined 字段；这里
        // None/非对象同样产出空字段集。
        let fields = typed
            .as_object()
            .and_then(|_| tool_fields_from_payload(&typed))
            .unwrap_or_default();
        let out = serde_json::json!({
            "title": fields.title,
            "kind": fields.kind,
            "rawInput": fields.raw_input,
            "rawOutput": fields.raw_output,
            "status": fields.status,
            "contentBlocks": fields.content_blocks,
        });
        // TS 语义：undefined 字段与缺失字段在 toEqual 下等价；这里把 null 统一为
        // 缺失（skip 序列化做不到 per-key，交给 JS 侧比较口径）。
        let out = strip_nulls(&out);
        crate::events::to_js(&out)
    }
    inner(typed_payload).map_err(|error| JsError::new(&error))
}

fn strip_nulls(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let out = map
                .iter()
                .filter(|(_, value)| !value.is_null())
                .map(|(key, value)| (key.clone(), strip_nulls(value)))
                .collect::<serde_json::Map<String, serde_json::Value>>();
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(strip_nulls).collect())
        }
        other => other.clone(),
    }
}

/// TS `projectToolFromMessage` 的直通出口。
// 参数即 §5.11 九字段验收面本身（wasm 边界无 struct 传参），不是可合并的散参。
#[allow(clippy::too_many_arguments)]
#[wasm_bindgen(js_name = projectToolFromMessage)]
pub fn project_tool_from_message(
    tool_call_id: Option<String>,
    tool_name: Option<String>,
    tool_kind: Option<String>,
    raw_input: JsValue,
    raw_output: JsValue,
    tool_status: Option<String>,
    content_blocks: JsValue,
    owner: JsValue,
    client_generation: f64,
) -> Result<JsValue, JsError> {
    fn inner(
        tool_call_id: Option<String>,
        tool_name: Option<String>,
        tool_kind: Option<String>,
        raw_input: JsValue,
        raw_output: JsValue,
        tool_status: Option<String>,
        content_blocks: JsValue,
        owner: JsValue,
        client_generation: f64,
    ) -> Result<JsValue, String> {
        if !client_generation.is_finite() || client_generation.fract() != 0.0 {
            return Err(format!(
                "clientGeneration 必须是整数值（收到 {client_generation}）"
            ));
        }
        let to_value = |value: JsValue, name: &str| -> Result<Option<serde_json::Value>, String> {
            if value.is_undefined() {
                return Ok(None);
            }
            serde_wasm_bindgen::from_value(value)
                .map(Some)
                .map_err(|error| format!("{name} 反序列化失败: {error}"))
        };
        let message = ProjectableToolMessage {
            tool_call_id,
            tool_name,
            tool_kind,
            raw_input: to_value(raw_input, "rawInput")?,
            raw_output: to_value(raw_output, "rawOutput")?,
            tool_status,
            content_blocks: to_value(content_blocks, "contentBlocks")?,
        };
        let owner: serde_json::Value = serde_wasm_bindgen::from_value(owner)
            .map_err(|error| format!("owner 反序列化失败: {error}"))?;
        let owner = owner
            .as_object()
            .ok_or_else(|| "owner 必须是对象".to_string())?;
        let owner = EventOwner {
            profile_id: owner
                .get("profileId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .into(),
            agent_id: owner
                .get("agentId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .into(),
            local_session_id: owner
                .get("localSessionId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .into(),
            remote_session_id: owner
                .get("remoteSessionId")
                .and_then(serde_json::Value::as_str)
                .map(into_string),
            workspace_id: owner
                .get("workspaceId")
                .and_then(serde_json::Value::as_str)
                .map(into_string),
        };
        let projection =
            project_tool_from_message_inner(&message, &owner, client_generation as i64);
        crate::events::to_js(&projection)
    }
    inner(
        tool_call_id,
        tool_name,
        tool_kind,
        raw_input,
        raw_output,
        tool_status,
        content_blocks,
        owner,
        client_generation,
    )
    .map_err(|error| JsError::new(&error))
}

fn into_string(value: &str) -> String {
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::test_support::{event, owner, OWNER_KEY};
    use pylon_canonical_types::CanonicalEventType;
    use serde_json::json;

    #[test]
    fn started_projection_keeps_all_nine_fields() {
        // 对齐 toolProjection.test.ts「tool.call.started 投影全字段保留」。
        let mut event = event(CanonicalEventType::ToolCallStarted, 1);
        event.client_generation = 7;
        event.identity = Some(crate::events::EventIdentity {
            tool_call_id: Some("tc-1".into()),
            ..Default::default()
        });
        event.tool = Some(ToolFields {
            title: Some("Read".into()),
            kind: Some("read_file".into()),
            raw_input: Some(json!({ "path": "a.txt", "mode": "r" })),
            content_blocks: Some(json!([{ "type": "text", "text": "preview" }])),
            ..Default::default()
        });
        let projection = project_tool_from_canonical_inner(&event).expect("projection");
        assert_eq!(projection.tool_call_id.as_deref(), Some("tc-1"));
        assert_eq!(projection.tool_name.as_deref(), Some("Read"));
        assert_eq!(projection.kind.as_deref(), Some("read_file"));
        assert_eq!(
            projection.raw_input,
            Some(json!({ "path": "a.txt", "mode": "r" }))
        );
        assert_eq!(projection.raw_output, None);
        assert_eq!(projection.status, None);
        assert_eq!(
            projection.content_blocks,
            Some(json!([{ "type": "text", "text": "preview" }]))
        );
        assert_eq!(projection.owner["localSessionId"], "local:s1");
        assert_eq!(projection.client_generation, 7);
    }

    #[test]
    fn completed_projection_keeps_raw_output_and_status() {
        // content 层的 tool_use_id 别名也能被单一路径识别（§5.11）。
        let mut event = event(CanonicalEventType::ToolCallCompleted, 2);
        event.client_generation = 9;
        event.identity = Some(crate::events::EventIdentity {
            tool_call_id: Some("tc-2".into()),
            ..Default::default()
        });
        event.tool = Some(ToolFields {
            raw_output: Some(json!({ "ok": true, "lines": 3 })),
            status: Some("completed".into()),
            ..Default::default()
        });
        let projection = project_tool_from_canonical_inner(&event).expect("projection");
        assert_eq!(projection.tool_call_id.as_deref(), Some("tc-2"));
        assert_eq!(
            projection.raw_output,
            Some(json!({ "ok": true, "lines": 3 }))
        );
        assert_eq!(projection.status.as_deref(), Some("completed"));
        assert_eq!(projection.client_generation, 9);
    }

    #[test]
    fn non_tool_events_project_to_none() {
        let user = event(CanonicalEventType::UserMessage, 3);
        assert!(project_tool_from_canonical_inner(&user).is_none());
        let unknown = event(CanonicalEventType::Unknown, 4);
        assert!(project_tool_from_canonical_inner(&unknown).is_none());
    }

    #[test]
    fn empty_string_title_and_kind_count_as_missing() {
        // normalizer 纪律（TS canonicalNormalizer.toolPayload）：空字符串 title/kind
        // 不落 typedPayload.tool ⇒ 提取路径自然拿到 undefined。
        let raw = json!({
            "update": { "sessionUpdate": "tool_call", "toolCallId": "tc-3", "title": "", "kind": "" }
        });
        let owner = json!({ "profileId": "p1", "agentId": "peri", "localSessionId": "local:s1" });
        let normalized = crate::events::normalize_raw_event_inner(
            &raw,
            &owner,
            3,
            6,
            "2026-08-14T00:00:00.000Z",
        )
        .expect("normalize");
        let fields = tool_fields_from_payload(&normalized.event["typedPayload"]).expect("fields");
        assert_eq!(fields.title, None);
        assert_eq!(fields.kind, None);
        // 对照：非空字符串原样保留（typeof string 直通，含空格不 trim 后比较的
        // 语义由 normalizer 负责，提取层只认类型）。
        let typed = json!({ "tool": { "title": "Write", "kind": "write_file" } });
        let fields = tool_fields_from_payload(&typed).expect("fields");
        assert_eq!(fields.title.as_deref(), Some("Write"));
        assert_eq!(fields.kind.as_deref(), Some("write_file"));
    }

    #[test]
    fn message_level_projection_full_fields() {
        let message = ProjectableToolMessage {
            tool_call_id: Some("tc-m".into()),
            tool_name: Some("Read".into()),
            tool_kind: Some("read_file".into()),
            raw_input: Some(json!({ "path": "a.txt" })),
            raw_output: Some(json!({ "ok": true })),
            tool_status: Some("completed".into()),
            content_blocks: Some(json!([{ "type": "text", "text": "x" }])),
        };
        let projection =
            project_tool_from_message_inner(&message, &owner(), 5).expect("projection");
        assert_eq!(projection.tool_call_id.as_deref(), Some("tc-m"));
        assert_eq!(projection.tool_name.as_deref(), Some("Read"));
        assert_eq!(projection.kind.as_deref(), Some("read_file"));
        assert_eq!(projection.raw_output, Some(json!({ "ok": true })));
        assert_eq!(projection.status.as_deref(), Some("completed"));
        assert_eq!(projection.client_generation, 5);
        assert_eq!(projection.owner["profileId"], "p1");
        assert_eq!(OWNER_KEY, r#"["p1","peri","local:s1"]"#);
    }

    #[test]
    fn message_without_tool_identity_is_none() {
        let message = ProjectableToolMessage::default();
        assert!(project_tool_from_message_inner(&message, &owner(), 5).is_none());
    }
}
