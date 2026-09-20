//! B-03：legacy Message projection 的纯语义规则 + 单一 append-only journal 的有效投影
//! 流解析（TS `messageProjectionRules.ts` + `messageProjection.ts` 纯部分的逐函数对齐）。
//!
//! 这里只描述 canonical event → Message[] 的状态变换，不拥有 load/generation、cancel、
//! usage 或任何 renderer/store/sink 依赖。TS 经 options 注入 `toolInputSummary` /
//! `timeFormatter`（宿主策略：renderer registry / locale）——计算核不读 registry 与
//! locale，这两个注入点在帧契约里是**宿主预计算列**（toolInputSummary / timeLabel），
//! 规则本身（`注入 || fallback`、时间原样落位）留在本层。

use serde::Serialize;
use serde_json::{json, Map, Value};
use wasm_bindgen::prelude::*;

use super::{
    chunk_merge::{resolve_chunk_append_inner, ChunkAppendResolution},
    compact_event_from_value, decode_batch, pretty_json_text, slice_utf16, ChatIdentity,
    CompactEvent,
};
use pylon_canonical_types::CanonicalEventType;

// ── 纯规则（projectCanonicalMessages） ───────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct MessageProjectionState {
    /// Message 对象（JSON 形态；字段与 TS `Message` 一致，undefined 字段不落位）。
    pub messages: Vec<Value>,
    /// user/assistant/reasoning 消息 id 使用的逻辑序号；工具卡不消耗序号。
    pub sequence: i64,
}

fn message_object(message: &Value) -> &Map<String, Value> {
    message.as_object().expect("Message 必为对象")
}

fn message_field_string(message: &Value, key: &str) -> Option<String> {
    message_object(message)
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn message_field_bool(message: &Value, key: &str) -> bool {
    message_object(message)
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn message_external_identity(message: &Value) -> Option<ChatIdentity> {
    let object = message_object(message)
        .get("externalIdentity")?
        .as_object()?;
    let string_field = |name: &str| object.get(name).and_then(Value::as_str).map(str::to_string);
    Some(ChatIdentity {
        message_id: string_field("messageId"),
        turn_id: string_field("turnId"),
        tool_call_id: string_field("toolCallId"),
    })
}

fn display_time(event: &CompactEvent) -> String {
    // TS formatTime = options.timeFormatter ?? timeOf；timeFormatter 产物即
    // timeLabel 列（宿主预格式化）。缺列时退 receivedAt 原文（不读 locale）。
    event
        .time_label
        .clone()
        .unwrap_or_else(|| event.received_at.clone())
}

/// 终态事件统一清除 running；running tool 没有 status 时补 completed（TS `settleMessages`；
/// 注意 `toolStatus || 'completed'` 的 falsy 语义：空串同样视为缺失）。
pub fn settle_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|message| {
            let is_running_tool = message_field_string(message, "role").as_deref() == Some("tool")
                && message_field_bool(message, "running");
            if is_running_tool {
                let mut object = message_object(message).clone();
                object.insert("running".into(), Value::Bool(false));
                let tool_status =
                    message_field_string(message, "toolStatus").filter(|s| !s.is_empty());
                object.insert(
                    "toolStatus".into(),
                    Value::String(tool_status.unwrap_or_else(|| "completed".into())),
                );
                return Value::Object(object);
            }
            if message_field_bool(message, "running") {
                let mut object = message_object(message).clone();
                object.insert("running".into(), Value::Bool(false));
                return Value::Object(object);
            }
            message.clone()
        })
        .collect()
}

/// TS `stringifyToolOutput`：字符串直通；否则 JSON.stringify(v, null, 2)；undefined
/// 才落空串。JSON 文本从宿主预序列化文本重排（键序/数字字面量与 JS 逐字节一致，
/// 见 `pretty_json_text` 的注释）。
pub fn stringify_tool_output(tool: Option<&super::ToolFields>) -> String {
    let Some(tool) = tool else {
        return String::new();
    };
    match (&tool.raw_output, &tool.raw_output_json) {
        (Some(Value::String(text)), _) => text.clone(),
        (Some(_), Some(json)) => pretty_json_text(json).unwrap_or_default(),
        (Some(_), None) => String::new(),
        (None, _) => String::new(),
    }
}

/// TS `fallbackToolInput`：`typeof rawInput === 'string' ? rawInput.slice(0, 80) : ''`。
/// slice 按 UTF-16 码元（见 `slice_utf16`）。
pub fn fallback_tool_input(raw_input: Option<&Value>) -> String {
    match raw_input {
        Some(Value::String(text)) => slice_utf16(text, 80).to_string(),
        _ => String::new(),
    }
}

/// 注入摘要列（宿主 toolInputSummary 产物）为空时回退 fallback——对齐 TS
/// `options.toolInputSummary?.(...) || fallbackToolInput(rawInput)` 的 `||` 语义。
fn tool_input_summary_of(event: &CompactEvent) -> String {
    let injected = event
        .tool_input_summary
        .as_deref()
        .filter(|summary| !summary.is_empty());
    match injected {
        Some(summary) => summary.to_string(),
        None => fallback_tool_input(event.tool.as_ref().and_then(|tool| tool.raw_input.as_ref())),
    }
}

fn tool_call_id_of(event: &CompactEvent) -> Option<String> {
    event
        .identity
        .as_ref()
        .and_then(|identity| identity.tool_call_id.clone())
}

fn append_message(
    mut state: MessageProjectionState,
    message: Value,
    sequence: i64,
) -> MessageProjectionState {
    state.messages.push(message);
    state.sequence = sequence;
    state
}

fn last_message(state: &MessageProjectionState) -> Option<&Value> {
    state.messages.last()
}

fn map_last_message(
    messages: &[Value],
    update: impl FnOnce(&mut Map<String, Value>),
) -> Vec<Value> {
    let mut messages = messages.to_vec();
    if let Some(last) = messages.last_mut() {
        let mut object = message_object(last).clone();
        update(&mut object);
        *last = Value::Object(object);
    }
    messages
}

fn find_by_tool_id(messages: &[Value], tool_call_id: &str) -> Option<usize> {
    let id = format!("tool-{tool_call_id}");
    messages
        .iter()
        .position(|message| message_object(message).get("id").and_then(Value::as_str) == Some(&id))
}

fn output_lines_of(output: &str) -> i64 {
    // TS：outputStr ? outputStr.split(/\n/).filter(line => line.trim()).length : 0。
    if output.is_empty() {
        return 0;
    }
    output
        .split('\n')
        .filter(|line| !line.trim().is_empty())
        .count() as i64
}

fn event_identity_value(identity: &ChatIdentity) -> Value {
    identity.to_value()
}

/// 对单个 canonical event 应用 Message 语义；unknown/interaction 等事件保持 no-op
/// （TS `reduceCanonicalMessageEvent`）。
pub fn reduce_canonical_message_event(
    state: MessageProjectionState,
    event: &CompactEvent,
) -> MessageProjectionState {
    match event.event_type {
        CanonicalEventType::UserMessage => {
            let Some(text) = &event.text else {
                return state;
            };
            let messages = settle_messages(&state.messages);
            let sequence = state.sequence + 1;
            let mut message = Map::new();
            message.insert("id".into(), Value::String(format!("user-{sequence}")));
            message.insert("role".into(), Value::String("user".into()));
            message.insert(
                "sender".into(),
                Value::String(event.owner.local_session_id.clone()),
            );
            message.insert("content".into(), Value::String(text.clone()));
            message.insert("time".into(), Value::String(display_time(event)));
            message.insert(
                "agentId".into(),
                Value::String(event.owner.agent_id.clone()),
            );
            message.insert("running".into(), Value::Bool(false));
            if let Some(identity) = event.chat_identity() {
                message.insert("externalIdentity".into(), event_identity_value(&identity));
            }
            append_message(
                MessageProjectionState {
                    messages,
                    sequence: state.sequence,
                },
                Value::Object(message),
                sequence,
            )
        }

        CanonicalEventType::AssistantTextDelta
        | CanonicalEventType::AssistantThinkingDelta
        | CanonicalEventType::AssistantTextDeltaBatch
        | CanonicalEventType::AssistantThinkingDeltaBatch => {
            // #81 L1：sink 聚合行。run 内 chunk 同 role 同 identity ⇒ 折叠决策与逐
            // chunk 一致，text 为精确拼接；time 沿用 run 首条（行时间戳）。
            let Some(text) = &event.text else {
                return state;
            };
            let role = if matches!(
                event.event_type,
                CanonicalEventType::AssistantTextDelta
                    | CanonicalEventType::AssistantTextDeltaBatch
            ) {
                "assistant"
            } else {
                "reasoning"
            };
            let identity = event.chat_identity();
            let last = last_message(&state);
            let ChunkAppendResolution {
                should_append,
                identity: merged_identity,
            } = resolve_chunk_append_inner(
                last.and_then(|message| message_field_string(message, "role"))
                    .as_deref(),
                role,
                last.and_then(message_external_identity).as_ref(),
                identity.as_ref(),
            );
            if should_append {
                let messages = map_last_message(&state.messages, |object| {
                    let content = object
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    object.insert("content".into(), Value::String(content + text));
                    if let Some(identity) = &merged_identity {
                        object.insert("externalIdentity".into(), event_identity_value(identity));
                    }
                });
                return MessageProjectionState {
                    messages,
                    sequence: state.sequence,
                };
            }
            let sequence = state.sequence + 1;
            let mut message = Map::new();
            message.insert(
                "id".into(),
                Value::String(format!(
                    "{}-{sequence}",
                    if role == "assistant" {
                        "msg"
                    } else {
                        "thought"
                    }
                )),
            );
            message.insert("role".into(), Value::String(role.into()));
            message.insert("sender".into(), Value::String("peri".into()));
            message.insert("content".into(), Value::String(text.clone()));
            message.insert("time".into(), Value::String(display_time(event)));
            message.insert("running".into(), Value::Bool(false));
            message.insert(
                "agentId".into(),
                Value::String(event.owner.agent_id.clone()),
            );
            if let Some(identity) = &identity {
                message.insert("externalIdentity".into(), event_identity_value(identity));
            }
            append_message(
                MessageProjectionState {
                    messages: state.messages,
                    sequence: state.sequence,
                },
                Value::Object(message),
                sequence,
            )
        }

        CanonicalEventType::ToolCallStarted => {
            let Some(tool_call_id) = tool_call_id_of(event) else {
                return state;
            };
            let title = event
                .tool
                .as_ref()
                .and_then(|tool| tool.title.clone())
                .filter(|title| !title.is_empty())
                .unwrap_or_else(|| "?".into());
            let input_str = tool_input_summary_of(event);
            match find_by_tool_id(&state.messages, &tool_call_id) {
                Some(existing) => {
                    let mut messages = state.messages.clone();
                    let message = &mut messages[existing];
                    let mut object = message_object(message).clone();
                    object.insert("toolName".into(), Value::String(title.clone()));
                    object.insert("sender".into(), Value::String(format!("tool:{title}")));
                    let kind = event.tool.as_ref().and_then(|tool| tool.kind.clone());
                    match kind {
                        Some(kind) => {
                            object.insert("toolKind".into(), Value::String(kind));
                        }
                        // TS `tool.kind ?? message.toolKind`：新值缺省保留旧值。
                        None => {
                            let _ = object.get("toolKind");
                        }
                    }
                    object.insert("toolInput".into(), Value::String(input_str));
                    // TS：contentBlocks/rawInput 直接赋新值——undefined 即移除。
                    set_or_remove(
                        &mut object,
                        "contentBlocks",
                        event
                            .tool
                            .as_ref()
                            .and_then(|tool| tool.content_blocks.clone()),
                    );
                    set_or_remove(
                        &mut object,
                        "rawInput",
                        event.tool.as_ref().and_then(|tool| tool.raw_input.clone()),
                    );
                    object.insert("clientGeneration".into(), event.client_generation.into());
                    *message = Value::Object(object);
                    MessageProjectionState {
                        messages,
                        sequence: state.sequence,
                    }
                }
                None => {
                    let mut message = Map::new();
                    message.insert("id".into(), Value::String(format!("tool-{tool_call_id}")));
                    message.insert("role".into(), Value::String("tool".into()));
                    message.insert("sender".into(), Value::String(format!("tool:{title}")));
                    message.insert("content".into(), Value::String(String::new()));
                    message.insert("time".into(), Value::String(display_time(event)));
                    message.insert(
                        "agentId".into(),
                        Value::String(event.owner.agent_id.clone()),
                    );
                    message.insert("toolName".into(), Value::String(title));
                    message.insert("toolInput".into(), Value::String(input_str));
                    set_or_remove(
                        &mut message,
                        "toolKind",
                        event
                            .tool
                            .as_ref()
                            .and_then(|tool| tool.kind.clone())
                            .map(Value::String),
                    );
                    set_or_remove(
                        &mut message,
                        "contentBlocks",
                        event
                            .tool
                            .as_ref()
                            .and_then(|tool| tool.content_blocks.clone()),
                    );
                    set_or_remove(
                        &mut message,
                        "rawInput",
                        event.tool.as_ref().and_then(|tool| tool.raw_input.clone()),
                    );
                    message.insert("clientGeneration".into(), event.client_generation.into());
                    message.insert("running".into(), Value::Bool(true));
                    message.insert(
                        "externalIdentity".into(),
                        json!({ "toolCallId": tool_call_id }),
                    );
                    let current_sequence = state.sequence;
                    append_message(state, Value::Object(message), current_sequence)
                }
            }
        }

        CanonicalEventType::ToolCallUpdated
        | CanonicalEventType::ToolCallCompleted
        | CanonicalEventType::ToolCallFailed => {
            let Some(tool_call_id) = tool_call_id_of(event) else {
                return state;
            };
            let output_str = stringify_tool_output(event.tool.as_ref());
            let lines = output_lines_of(&output_str);
            match find_by_tool_id(&state.messages, &tool_call_id) {
                Some(existing) => {
                    let mut messages = state.messages.clone();
                    let message = &mut messages[existing];
                    let mut object = message_object(message).clone();
                    object.insert("toolOutput".into(), Value::String(output_str));
                    object.insert("toolOutputLines".into(), lines.into());
                    set_or_remove(
                        &mut object,
                        "toolStatus",
                        event
                            .tool
                            .as_ref()
                            .and_then(|tool| tool.status.clone())
                            .map(Value::String),
                    );
                    let kind = event.tool.as_ref().and_then(|tool| tool.kind.clone());
                    if let Some(kind) = kind {
                        object.insert("toolKind".into(), Value::String(kind));
                    }
                    let content_blocks = event
                        .tool
                        .as_ref()
                        .and_then(|tool| tool.content_blocks.clone())
                        .or_else(|| object.get("contentBlocks").cloned());
                    set_or_remove(&mut object, "contentBlocks", content_blocks);
                    let raw_output = event
                        .tool
                        .as_ref()
                        .and_then(|tool| tool.raw_output.clone())
                        .or_else(|| object.get("rawOutput").cloned());
                    set_or_remove(&mut object, "rawOutput", raw_output);
                    object.insert("clientGeneration".into(), event.client_generation.into());
                    object.insert("running".into(), Value::Bool(false));
                    *message = Value::Object(object);
                    MessageProjectionState {
                        messages,
                        sequence: state.sequence,
                    }
                }
                None => {
                    let mut message = Map::new();
                    message.insert("id".into(), Value::String(format!("tool-{tool_call_id}")));
                    message.insert("role".into(), Value::String("tool".into()));
                    message.insert("sender".into(), Value::String("tool:?".into()));
                    message.insert("content".into(), Value::String(String::new()));
                    message.insert("time".into(), Value::String(display_time(event)));
                    message.insert(
                        "agentId".into(),
                        Value::String(event.owner.agent_id.clone()),
                    );
                    message.insert("toolName".into(), Value::String("?".into()));
                    message.insert("toolOutput".into(), Value::String(output_str));
                    message.insert("toolOutputLines".into(), lines.into());
                    set_or_remove(
                        &mut message,
                        "toolKind",
                        event
                            .tool
                            .as_ref()
                            .and_then(|tool| tool.kind.clone())
                            .map(Value::String),
                    );
                    set_or_remove(
                        &mut message,
                        "contentBlocks",
                        event
                            .tool
                            .as_ref()
                            .and_then(|tool| tool.content_blocks.clone()),
                    );
                    set_or_remove(
                        &mut message,
                        "toolStatus",
                        event
                            .tool
                            .as_ref()
                            .and_then(|tool| tool.status.clone())
                            .map(Value::String),
                    );
                    set_or_remove(
                        &mut message,
                        "rawOutput",
                        event.tool.as_ref().and_then(|tool| tool.raw_output.clone()),
                    );
                    message.insert("clientGeneration".into(), event.client_generation.into());
                    message.insert("running".into(), Value::Bool(false));
                    message.insert(
                        "externalIdentity".into(),
                        json!({ "toolCallId": tool_call_id }),
                    );
                    let current_sequence = state.sequence;
                    append_message(state, Value::Object(message), current_sequence)
                }
            }
        }

        CanonicalEventType::TurnCompleted | CanonicalEventType::TurnFailed => {
            MessageProjectionState {
                messages: settle_messages(&state.messages),
                sequence: state.sequence,
            }
        }

        _ => state,
    }
}

fn set_or_remove(object: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(value) => {
            object.insert(key.into(), value);
        }
        // TS 把 undefined 赋进键——读侧与「键不存在」同判（toEqual 亦同）。
        None => {
            object.remove(key);
        }
    }
}

/// 从已排序/筛选的 canonical stream 生成 legacy Message[]（TS `projectCanonicalMessages`）。
pub fn project_canonical_messages_inner(events: &[CompactEvent]) -> Vec<Value> {
    let mut state = MessageProjectionState::default();
    for event in events {
        state = reduce_canonical_message_event(state, event);
    }
    state.messages
}

// ── 有效投影流（messageProjection.ts 的纯部分） ──────────────────────────────

/// 有效流事件：帧引用（零拷贝路径）或单元展开的重建事件。
#[derive(Debug, Clone)]
pub struct EffectiveEvent {
    pub event: CompactEvent,
    /// 帧内下标；单元展开的重建事件为 None。
    pub frame_index: Option<usize>,
}

/// TS `eventProjectionKey`：JSON.stringify([eventType, identity ?? null,
/// text ?? null, tool?.rawInput ?? null])。serde_json 的对象键序恒为字典序（BTreeMap），
/// 两侧构造走同一条路径，键串在匹配运行内自洽。
pub fn event_projection_key(event: &CompactEvent) -> String {
    let identity = event
        .identity
        .as_ref()
        .map(|identity| serde_json::to_string(&identity.to_value()).expect("identity json"))
        .unwrap_or_else(|| "null".into());
    let text = event
        .text
        .as_ref()
        .map(|text| serde_json::to_string(text).expect("text json"))
        .unwrap_or_else(|| "null".into());
    let raw_input = event
        .tool
        .as_ref()
        .and_then(|tool| tool.raw_input.as_ref())
        .map(|raw| serde_json::to_string(raw).expect("rawInput json"))
        .unwrap_or_else(|| "null".into());
    format!(
        "[{},{},{},{}]",
        serde_json::to_string(event.event_type.as_str()).expect("wire json"),
        identity,
        text,
        raw_input
    )
}

/// 从归一化事件 Value 计算 key（recovery anchor 侧）。
fn event_projection_key_from_value(event: &Value) -> String {
    let empty = Value::Object(Map::new());
    let object = event
        .as_object()
        .unwrap_or_else(|| empty.as_object().expect("空对象"));
    let event_type = object
        .get("eventType")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let identity = object
        .get("identity")
        .filter(|identity| !identity.is_null())
        .map(|identity| serde_json::to_string(identity).expect("identity json"))
        .unwrap_or_else(|| "null".into());
    let typed = object.get("typedPayload");
    let text = typed
        .and_then(|typed| typed.get("text"))
        .and_then(Value::as_str)
        .map(|text| serde_json::to_string(text).expect("text json"))
        .unwrap_or_else(|| "null".into());
    let raw_input = typed
        .and_then(|typed| typed.get("tool"))
        .and_then(|tool| tool.get("rawInput"))
        .map(|raw| serde_json::to_string(raw).expect("rawInput json"))
        .unwrap_or_else(|| "null".into());
    format!(
        "[{},{},{},{}]",
        serde_json::to_string(event_type).expect("wire json"),
        identity,
        text,
        raw_input
    )
}

/// 保留 optimistic 行的原位置，隐藏随后到达的 kernel user echo（TS
/// `reconcileOptimisticUserEvents`）。
fn reconcile_optimistic_user_events(events: Vec<EffectiveEvent>) -> Vec<EffectiveEvent> {
    let mut optimistic_counts: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();
    for event in &events {
        if !(event.event.raw_meta_optimistic
            && event.event.event_type == CanonicalEventType::UserMessage)
        {
            continue;
        }
        if let Some(key) = &event.event.text {
            *optimistic_counts.entry(key.clone()).or_insert(0) += 1;
        }
    }
    events
        .into_iter()
        .filter(|event| {
            if event.event.raw_meta_optimistic
                && event.event.event_type == CanonicalEventType::UserMessage
            {
                return true;
            }
            if event.event.event_type != CanonicalEventType::UserMessage {
                return true;
            }
            let Some(key) = &event.event.text else {
                return true;
            };
            let count = optimistic_counts.get(key).copied().unwrap_or(0);
            if count <= 0 {
                return true;
            }
            optimistic_counts.insert(key.clone(), count - 1);
            false
        })
        .collect()
}

/// recovery 行的 `_meta`（TS canonicalRecoveryMetadata 的取径：root.update ??
/// root.params?.update → _meta）。
fn recovery_meta(event: &CompactEvent) -> Option<Value> {
    let raw = event.raw_json.as_deref()?;
    let raw: Value = serde_json::from_str(raw).ok()?;
    let update = raw
        .get("update")
        .filter(|value| value.is_object())
        .or_else(|| {
            raw.get("params")
                .and_then(|params| params.get("update"))
                .filter(|value| value.is_object())
        })?;
    let meta = update.get("_meta")?.as_object()?;
    if meta.get("pylonCanonicalRecovery") != Some(&Value::Bool(true)) {
        return None;
    }
    Some(update.get("_meta").cloned().expect("meta"))
}

/// recovery 锚点：`meta.pylonReplayAnchor` 经同一 normalize 归一（TS
/// canonicalRecoveryAnchor）。
fn recovery_anchor(event: &CompactEvent) -> Option<Value> {
    let meta = recovery_meta(event)?;
    let anchor = meta.get("pylonReplayAnchor")?;
    if !anchor.is_object() {
        return None;
    }
    normalize_raw_event_for_anchor(anchor, event)
}

fn normalize_raw_event_for_anchor(anchor: &Value, event: &CompactEvent) -> Option<Value> {
    super::normalize_raw_event_inner(
        anchor,
        &event.owner.to_value(),
        event.client_generation,
        event.sequence,
        &event.received_at,
    )
    .ok()
    .map(|normalized| normalized.event)
}

/// Resolve the single append-only journal into one effective projection stream.
///
/// Bug2：不再把 `history.snapshot` 纳入投影（canonical_events 的权威数据是逐 chunk
/// 行）。#81 L2：单元行先展开为 segment 级 canonical 事件。迁移标记的缺失 replay 行
/// 从 canonical 末尾按锚点归位；正常路径优先使用逐条 durable live rows。
pub fn effective_canonical_projection_events(events: &[CompactEvent]) -> Vec<EffectiveEvent> {
    // 排序（稳定，只按 sequence）。
    let mut order: Vec<usize> = (0..events.len()).collect();
    order.sort_by_key(|&index| events[index].sequence);

    // #81 L2：单元行展开为 segment 级事件；被单元覆盖的行丢弃。
    let unit_ranges: Vec<(i64, i64)> = order
        .iter()
        .filter_map(|&index| {
            super::turn_unit::parse_turn_unit_payload(&events[index])
                .map(|payload| (payload.seq_start, payload.seq_end))
        })
        .collect();
    let covered = |sequence: i64| {
        unit_ranges
            .iter()
            .any(|(start, end)| sequence >= *start && sequence <= *end)
    };

    let mut expanded: Vec<EffectiveEvent> = Vec::new();
    for &index in &order {
        let event = &events[index];
        match super::turn_unit::parse_turn_unit_payload(event) {
            Some(payload) => {
                for segment in payload.segments {
                    let value = match segment {
                        super::turn_unit::TurnUnitSegment::EventRow { event } => event,
                        super::turn_unit::TurnUnitSegment::DeltaRun {
                            event_type,
                            seq_end,
                            identity,
                            text,
                            occurred_at,
                            ..
                        } => super::turn_unit::build_delta_run_event(
                            event,
                            event_type,
                            seq_end,
                            identity,
                            text,
                            occurred_at,
                        ),
                    };
                    expanded.push(EffectiveEvent {
                        event: compact_event_from_value(&value),
                        frame_index: None,
                    });
                }
            }
            None => {
                if !unit_ranges.is_empty() && covered(event.sequence) {
                    continue;
                }
                expanded.push(EffectiveEvent {
                    event: event.clone(),
                    frame_index: Some(index),
                });
            }
        }
    }

    // history.snapshot 只作为 forensic 证据保留，永不成为第二投影源。
    expanded.retain(|item| item.event.event_type != CanonicalEventType::HistorySnapshot);
    let live = reconcile_optimistic_user_events(expanded);

    let recovered_indices: Vec<usize> = live
        .iter()
        .enumerate()
        .filter(|(_, item)| item.event.raw_meta_recovery)
        .map(|(index, _)| index)
        .collect();
    if recovered_indices.is_empty() {
        return live;
    }

    // Recovered rows are durable canonical events; sequence 是迁移 append 位置，
    // 按锚点放回到显式 live anchor 之前。
    let ordinal_of = |event: &CompactEvent| -> i64 {
        // TS：typeof ordinal === 'number' ? ordinal : Number.MAX_SAFE_INTEGER。
        recovery_meta(event)
            .and_then(|meta| meta.get("pylonReplayOrdinal").and_then(Value::as_i64))
            .unwrap_or(i64::MAX)
    };
    let mut recovered: Vec<EffectiveEvent> = recovered_indices
        .iter()
        .map(|&index| live[index].clone())
        .collect();
    recovered.sort_by_key(|item| ordinal_of(&item.event));

    let removed: std::collections::HashSet<usize> = recovered_indices.iter().copied().collect();
    let mut merged: Vec<EffectiveEvent> = live
        .into_iter()
        .enumerate()
        .filter(|(index, _)| !removed.contains(index))
        .map(|(_, item)| item)
        .collect();
    let mut insertion_floor = 0usize;
    for recovered_item in &recovered {
        let anchor_key = recovery_anchor(&recovered_item.event)
            .map(|anchor| event_projection_key_from_value(&anchor));
        let anchor_index = match anchor_key {
            Some(key) => merged
                .iter()
                .position(|item| event_projection_key(&item.event) == key),
            None => None,
        };
        let position = match anchor_index {
            Some(index) if index >= insertion_floor => index,
            _ => insertion_floor,
        };
        let position = position.min(merged.len());
        merged.insert(position, recovered_item.clone());
        insertion_floor = position + 1;
    }
    // 迁移合并后按新位置重排 sequence（1..n）。
    for (index, item) in merged.iter_mut().enumerate() {
        item.event.sequence = index as i64 + 1;
    }
    merged
}

/// 组合出口（TS `projectMessagesFromCanonicalBuiltin` 的注入列形态）：有效流 → Message[]。
pub fn project_messages_from_canonical_inner(events: &[CompactEvent]) -> Vec<Value> {
    let effective = effective_canonical_projection_events(events);
    let events: Vec<CompactEvent> = effective.into_iter().map(|item| item.event).collect();
    project_canonical_messages_inner(&events)
}

// ── wasm 薄壳 ────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct EffectiveItemDto {
    origin: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    index: Option<usize>,
    sequence: i64,
}

/// 有效投影流（批量形态）：输出逐项给出帧下标（unit 展开项无下标，由 combined 出口
/// 消费）与重排后的 sequence。
#[wasm_bindgen(js_name = effectiveCanonicalProjectionEvents)]
pub fn effective_canonical_projection_events_shell(frame: &[u8]) -> Result<JsValue, JsError> {
    fn inner(frame: &[u8]) -> Result<JsValue, String> {
        let events = decode_batch(frame)?;
        let effective = effective_canonical_projection_events(&events);
        let items: Vec<EffectiveItemDto> = effective
            .iter()
            .map(|item| EffectiveItemDto {
                origin: if item.frame_index.is_some() {
                    "frame"
                } else {
                    "unit"
                },
                index: item.frame_index,
                sequence: item.event.sequence,
            })
            .collect();
        crate::events::to_js(&items)
    }
    inner(frame).map_err(|error| JsError::new(&error))
}

/// 纯规则出口：对给定（已排序/筛选）事件流投影 Message[]（TS `projectCanonicalMessages`
/// 的注入列形态——toolInputSummary/timeFormatter 以帧列传入）。
#[wasm_bindgen(js_name = projectCanonicalMessages)]
pub fn project_canonical_messages(frame: &[u8]) -> Result<JsValue, JsError> {
    fn inner(frame: &[u8]) -> Result<JsValue, String> {
        let events = decode_batch(frame)?;
        let messages = project_canonical_messages_inner(&events);
        crate::events::to_js(&messages)
    }
    inner(frame).map_err(|error| JsError::new(&error))
}

/// 组合出口：有效流解析 + 消息投影（TS `effectiveCanonicalProjectionEvents` +
/// `projectCanonicalMessages` 的组合，单次过界）。
#[wasm_bindgen(js_name = projectMessagesFromCanonical)]
pub fn project_messages_from_canonical(frame: &[u8]) -> Result<JsValue, JsError> {
    fn inner(frame: &[u8]) -> Result<JsValue, String> {
        let events = decode_batch(frame)?;
        let messages = project_messages_from_canonical_inner(&events);
        crate::events::to_js(&messages)
    }
    inner(frame).map_err(|error| JsError::new(&error))
}

#[cfg(test)]
pub(crate) mod test_support {
    //! 测试辅助：BatchRow 回装 CompactEvent（聚合行的消息投影等价性验证用）。

    use super::*;
    use crate::events::batch_rules::BatchRow;

    pub fn batch_row_as_event(row: &BatchRow) -> CompactEvent {
        let mut event = crate::events::test_support::event(row.event_type, row.sequence);
        event.owner_key = row.owner_key.clone();
        event.owner = row.owner.clone();
        event.identity = row.identity.clone();
        event.text = Some(row.text.clone());
        event.occurred_at = row.occurred_at.clone();
        event.received_at = row.received_at.clone();
        event.client_generation = row.client_generation;
        event.payload_version = row.payload_version;
        event.raw_json = Some(serde_json::to_string(&row.raw_payload).expect("raw json"));
        event.typed_payload = Some(json!({
            "text": row.text,
            "foldedCount": row.folded_count,
            "seqSpan": [row.seq_span[0], row.seq_span[1]],
        }));
        // display time 沿用行时间戳（batch 行继承 run 首条 receivedAt）。
        event.time_label = Some(row.received_at.clone());
        event
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::batch_row_as_event;
    use super::*;
    use crate::events::batch_rules::{merge_adjacent_delta_chunks, BatchItem, BatchLimits};
    use crate::events::parse_timestamp;
    use crate::events::test_support::{event, iso_of, OWNER_KEY};
    use pylon_canonical_types::CanonicalEventType;

    fn base_ms() -> i64 {
        parse_timestamp("2026-09-14T00:00:00.000Z").expect("base")
    }

    fn row_from_wire(wire: &Value, sequence: i64) -> CompactEvent {
        let mut event = compact_event_from_value(
            &crate::events::normalize_raw_event_inner(
                wire,
                &crate::events::test_support::owner().to_value(),
                1,
                sequence,
                &iso_of(base_ms() + sequence),
            )
            .expect("normalize")
            .event,
        );
        event.time_label = Some(iso_of(base_ms() + sequence));
        event
    }

    fn raw_text(text: &str, message_id: &str) -> Value {
        json!({
            "source": "local:s1",
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": text }, "messageId": message_id },
        })
    }

    fn raw_thinking(text: &str, message_id: &str) -> Value {
        json!({
            "source": "local:s1",
            "update": { "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": text }, "messageId": message_id },
        })
    }

    fn raw_user(text: &str) -> Value {
        json!({ "source": "local:s1", "update": { "sessionUpdate": "user_message_chunk", "content": { "text": text } } })
    }

    fn raw_tool_start(tool_call_id: &str) -> Value {
        json!({
            "source": "local:s1",
            "update": { "sessionUpdate": "tool_call", "toolCallId": tool_call_id, "title": "Read", "kind": "read" },
        })
    }

    fn raw_done() -> Value {
        json!({ "source": "local:s1", "update": { "sessionUpdate": "done" } })
    }

    fn chunk_rows(wires: &[Value]) -> Vec<CompactEvent> {
        wires
            .iter()
            .enumerate()
            .map(|(index, wire)| row_from_wire(wire, index as i64 + 1))
            .collect()
    }

    fn merged_rows(events: &[CompactEvent]) -> Vec<CompactEvent> {
        merge_adjacent_delta_chunks(events, BatchLimits::default())
            .expect("merge")
            .into_iter()
            .map(|item| match item {
                BatchItem::Event { index } => events[index].clone(),
                BatchItem::BatchRow { row } => batch_row_as_event(&row),
            })
            .collect()
    }

    fn contents(messages: &[Value]) -> Vec<&str> {
        messages
            .iter()
            .map(|message| message["content"].as_str().expect("content"))
            .collect()
    }

    #[test]
    fn user_then_text_run_projects_two_messages() {
        let rows = chunk_rows(&[
            raw_user("问题"),
            raw_text("你", "msg-1"),
            raw_text("好", "msg-1"),
            raw_done(),
        ]);
        let messages = project_canonical_messages_inner(&rows);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["role"], "user");
        assert_eq!(messages[0]["sender"], "local:s1");
        assert_eq!(messages[0]["content"], "问题");
        assert_eq!(messages[1]["role"], "assistant");
        assert_eq!(messages[1]["sender"], "peri");
        assert_eq!(messages[1]["content"], "你好");
        assert_eq!(messages[1]["id"], "msg-2");
        assert_eq!(messages[1]["externalIdentity"]["messageId"], "msg-1");
    }

    #[test]
    fn thinking_and_text_alternate() {
        let rows = chunk_rows(&[
            raw_user("问题"),
            raw_thinking("思", "msg-1"),
            raw_thinking("考中…", "msg-1"),
            raw_text("答", "msg-1"),
            raw_text("案", "msg-1"),
            raw_done(),
        ]);
        let messages = project_canonical_messages_inner(&rows);
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[1]["role"], "reasoning");
        assert_eq!(messages[1]["id"], "thought-2");
        assert_eq!(messages[1]["content"], "思考中…");
        assert_eq!(messages[2]["role"], "assistant");
        assert_eq!(messages[2]["content"], "答案");
    }

    #[test]
    fn tool_card_lifecycle_and_settle() {
        let mut start = row_from_wire(&raw_tool_start("tool-1"), 2);
        start.tool.as_mut().unwrap().raw_input = Some(json!({ "path": "a.txt" }));
        let mut complete = row_from_wire(
            &json!({ "source": "local:s1", "update": { "sessionUpdate": "tool_call_update", "toolCallId": "tool-1", "status": "completed", "rawOutput": { "ok": true, "lines": 3 } } }),
            3,
        );
        complete.tool = Some(crate::events::ToolFields {
            status: Some("completed".into()),
            raw_output: Some(json!({ "ok": true, "lines": 3 })),
            raw_output_json: Some(r#"{"ok":true,"lines":3}"#.into()),
            ..Default::default()
        });
        let rows = vec![
            row_from_wire(&raw_user("查一下"), 1),
            start,
            complete,
            row_from_wire(&raw_done(), 4),
        ];
        let messages = project_canonical_messages_inner(&rows);
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[1]["role"], "tool");
        assert_eq!(messages[1]["id"], "tool-tool-1");
        assert_eq!(messages[1]["toolName"], "Read");
        assert_eq!(messages[1]["sender"], "tool:Read");
        assert_eq!(messages[1]["toolKind"], "read");
        // rawInput 非字符串 → fallback 摘要为空串。
        assert_eq!(messages[1]["toolInput"], "");
        assert_eq!(messages[1]["running"], false);
        assert_eq!(messages[1]["toolStatus"], "completed");
        // stringifyToolOutput 的 pretty 形态（键序直通）。
        assert_eq!(
            messages[1]["toolOutput"],
            "{\n  \"ok\": true,\n  \"lines\": 3\n}"
        );
        // pretty JSON 共 4 个非空行（花括号各占一行——TS split(/\n/) 同口径）。
        assert_eq!(messages[1]["toolOutputLines"], 4);
    }

    #[test]
    fn tool_update_without_start_creates_card() {
        let update = row_from_wire(
            &json!({ "source": "local:s1", "update": { "sessionUpdate": "tool_call_update", "toolCallId": "tc-x", "status": "failed", "rawOutput": "行1\n\n  \n行2" } }),
            1,
        );
        let mut update = update;
        update.tool = Some(crate::events::ToolFields {
            status: Some("failed".into()),
            raw_output: Some(Value::String("行1\n\n  \n行2".into())),
            raw_output_json: Some(r#""行1\n\n  \n行2""#.into()),
            ..Default::default()
        });
        let messages = project_canonical_messages_inner(&[update]);
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["sender"], "tool:?");
        assert_eq!(messages[0]["toolName"], "?");
        assert_eq!(messages[0]["toolStatus"], "failed");
        // 空行/纯空白行不计入行数。
        assert_eq!(messages[0]["toolOutputLines"], 2);
        assert_eq!(messages[0]["running"], false);
    }

    #[test]
    fn string_raw_input_falls_back_to_utf16_slice() {
        let mut start = row_from_wire(
            &json!({ "source": "local:s1", "update": { "sessionUpdate": "tool_call", "toolCallId": "t", "title": "Bash" } }),
            1,
        );
        start.tool = Some(crate::events::ToolFields {
            title: Some("Bash".into()),
            raw_input: Some(Value::String("x".repeat(100))),
            ..Default::default()
        });
        let messages = project_canonical_messages_inner(&[start]);
        assert_eq!(messages[0]["toolInput"], "x".repeat(80));
    }

    #[test]
    fn tool_call_id_missing_events_are_skipped() {
        // 无 toolCallId 的工具事件跳过（与 replay 一致）。
        let start = row_from_wire(
            &json!({ "source": "local:s1", "update": { "sessionUpdate": "tool_call", "title": "Read" } }),
            1,
        );
        assert!(project_canonical_messages_inner(&[start]).is_empty());
    }

    #[test]
    fn terminal_then_streaming_starts_new_message_without_merge() {
        // 终态后再续流：settle 语义不受聚合影响（done 切断 run）。
        let rows = chunk_rows(&[
            raw_user("一"),
            raw_text("a", "msg-1"),
            raw_done(),
            raw_text("b", "msg-1"),
            raw_done(),
        ]);
        let messages = project_canonical_messages_inner(&rows);
        assert_eq!(messages.len(), 2);
        // settle 只清 running，不断开消息：b 与同角色的 a 聚合（TS 同语义）。
        assert_eq!(contents(&messages), vec!["一", "ab"]);
    }

    #[test]
    fn batch_equivalence_golden() {
        // #81 L1 golden：逐 chunk 存储与 sink 窗口聚合的 Message[] 逐字节相等。
        let corpora: Vec<(Vec<Value>, bool)> = vec![
            (
                vec![
                    raw_user("问题"),
                    raw_text("你", "msg-1"),
                    raw_text("好", "msg-1"),
                    raw_text("，", "msg-1"),
                    raw_text("世", "msg-1"),
                    raw_text("界", "msg-1"),
                    raw_done(),
                ],
                true,
            ),
            (
                vec![
                    raw_user("问题"),
                    raw_thinking("思考", "msg-1"),
                    raw_thinking("中…", "msg-1"),
                    raw_text("答", "msg-1"),
                    raw_text("案", "msg-1"),
                    raw_done(),
                ],
                true,
            ),
            (
                vec![
                    raw_user("查一下"),
                    raw_text("先看看", "msg-1"),
                    raw_tool_start("tool-1"),
                    raw_text("结论是", "msg-1"),
                    raw_text("…", "msg-1"),
                    raw_done(),
                ],
                true,
            ),
            (
                vec![
                    raw_user("问题"),
                    raw_text("A", "msg-1"),
                    raw_text("B", "msg-1"),
                    raw_text("C", "msg-2"),
                    raw_text("D", "msg-2"),
                    raw_done(),
                ],
                true,
            ),
            (
                // 空文本 chunk 混入 run：不合并，但投影仍等价。
                vec![
                    raw_user("问题"),
                    raw_text("x", "msg-1"),
                    json!({ "source": "local:s1", "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "" } } }),
                    raw_text("y", "msg-1"),
                    raw_done(),
                ],
                false,
            ),
            (
                // 终态后再续流：done 切断 run，不发生合并。
                vec![
                    raw_user("一"),
                    raw_text("a", "msg-1"),
                    raw_done(),
                    raw_text("b", "msg-1"),
                    raw_done(),
                ],
                false,
            ),
        ];
        for (wires, expect_merge) in corpora {
            let rows = chunk_rows(&wires);
            let merged = merged_rows(&rows);
            if expect_merge {
                assert!(
                    merged
                        .iter()
                        .any(|row| row.event_type.as_str().ends_with(".batch")),
                    "聚合必须真的发生"
                );
            }
            let left =
                serde_json::to_string(&project_canonical_messages_inner(&rows)).expect("left");
            let right =
                serde_json::to_string(&project_canonical_messages_inner(&merged)).expect("right");
            assert_eq!(right, left, "wires={wires:?}");
        }
    }

    #[test]
    fn identity_metadata_takes_last_occurrence() {
        // messageId 变化：identity 元数据取末次出现，文本折叠一致。
        let rows = chunk_rows(&[raw_text("A", "msg-1"), raw_text("B", "msg-2")]);
        let messages = project_canonical_messages_inner(&rows);
        assert_eq!(contents(&messages), vec!["AB"]);
        assert_eq!(messages[0]["externalIdentity"]["messageId"], "msg-2");
    }

    #[test]
    fn optimistic_user_echo_is_hidden() {
        // 乐观 user 行保留原位置，随后到达的 kernel echo 被隐藏。
        let mut optimistic = row_from_wire(
            &json!({
                "source": "local:s1",
                "update": { "sessionUpdate": "user_message_chunk", "content": { "text": "你好" }, "_meta": { "pylonOptimisticUser": true } },
            }),
            1,
        );
        optimistic.raw_meta_optimistic = true;
        let echo = row_from_wire(&raw_user("你好"), 2);
        let effective = effective_canonical_projection_events(&[optimistic, echo]);
        assert_eq!(effective.len(), 1);
        assert_eq!(effective[0].event.sequence, 1);
        // 相同文本但非 optimistic 的两行互不吞并。
        let plain = vec![
            row_from_wire(&raw_user("你好"), 1),
            row_from_wire(&raw_user("你好"), 2),
        ];
        assert_eq!(effective_canonical_projection_events(&plain).len(), 2);
    }

    #[test]
    fn history_snapshot_is_never_a_projection_source() {
        let snapshot = row_from_wire(
            &json!({ "source": "local:s1", "update": { "sessionUpdate": "user_message_chunk", "content": { "text": "快照" } } }),
            1,
        );
        let mut snapshot = snapshot;
        snapshot.event_type = CanonicalEventType::HistorySnapshot;
        let user = row_from_wire(&raw_user("正文"), 2);
        let effective = effective_canonical_projection_events(&[snapshot, user]);
        assert_eq!(effective.len(), 1);
        assert_eq!(
            effective[0].event.event_type,
            CanonicalEventType::UserMessage
        );
    }

    #[test]
    fn recovered_rows_are_repositioned_by_anchor_and_resequenced() {
        // 迁移标记行按 pylonReplayOrdinal 排序，并插回到锚点之前；重排 sequence 1..n。
        let live_a = row_from_wire(&raw_text("live-1", "msg-1"), 1);
        let live_b = row_from_wire(&raw_text("live-2", "msg-1"), 2);
        let recovered_early = recovered_row(
            3,
            "recovered-early",
            "msg-1",
            0,
            &raw_text("live-1", "msg-1"),
        );
        let recovered_late = recovered_row(
            4,
            "recovered-late",
            "msg-1",
            1,
            &raw_text("live-2", "msg-1"),
        );
        let effective = effective_canonical_projection_events(&[
            live_a,
            live_b,
            recovered_late.clone(),
            recovered_early.clone(),
        ]);
        // 序：early（ordinal 0，锚 live-1 前）→ live-1 → late（锚 live-2 前）→ live-2
        let texts: Vec<Option<&String>> = effective
            .iter()
            .map(|item| item.event.text.as_ref())
            .collect();
        assert_eq!(
            texts,
            vec![
                Some(&"recovered-early".to_string()),
                Some(&"live-1".to_string()),
                Some(&"recovered-late".to_string()),
                Some(&"live-2".to_string())
            ]
        );
        let sequences: Vec<i64> = effective.iter().map(|item| item.event.sequence).collect();
        assert_eq!(sequences, vec![1, 2, 3, 4], "重排 sequence 1..n");
    }

    /// 构造带 `_meta.pylonCanonicalRecovery` 的迁移回收行。
    fn recovered_row(
        sequence: i64,
        text: &str,
        message_id: &str,
        ordinal: i64,
        anchor_wire: &Value,
    ) -> CompactEvent {
        let mut row = row_from_wire(
            &json!({
                "source": "local:s1",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": text },
                    "messageId": message_id,
                    "_meta": { "pylonCanonicalRecovery": true, "pylonReplayOrdinal": ordinal, "pylonReplayAnchor": anchor_wire["update"] },
                },
            }),
            sequence,
        );
        row.raw_meta_recovery = true;
        row
    }

    #[test]
    fn projection_key_matches_value_path() {
        // CompactEvent 路径与归一化 Value 路径对同一事件产出同一键（锚点匹配的前提）。
        let row = chunk_rows(&[raw_text("A", "msg-1")])[0].clone();
        let value = crate::events::turn_unit::test_support::compact_to_value(&row);
        assert_eq!(
            event_projection_key(&row),
            event_projection_key_from_value(&value)
        );
        assert_eq!(OWNER_KEY, r#"["p1","peri","local:s1"]"#);
    }

    #[test]
    fn event_is_skipped() {
        // event.unknown / interaction 等事件保持 no-op。
        let unknown = event(CanonicalEventType::Unknown, 1);
        let state = project_canonical_messages_inner(&[unknown]);
        assert!(state.is_empty());
    }
}
