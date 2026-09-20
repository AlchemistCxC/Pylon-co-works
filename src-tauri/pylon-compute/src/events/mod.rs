//! WP2（events 层）：canonical 事件的归一化、单元展开与消息投影纯规则。
//!
//! 与 TS 基线（`src/domains/events/**`、`src/infrastructure/events/canonicalEventBatch.ts`）
//! 逐函数对齐，不重新设计。本模块持有 events 层的**公共契约**：
//!
//! 1. [`CompactEvent`] —— 规则层消费的事件视图。字段集不是 schema 的全量镜像，
//!    而是恰为「这些规则读什么、产出什么」所需：forensic 字段（provenance /
//!    rawMetadata / schemaVersion）不过界，由宿主在物化最终行时回挂。
//! 2. [`decode_batch`] —— spec「编组格式」定稿的紧凑列式缓冲（`PYPB` v1）解码。
//!    事件类型过界只传词表 u32 索引（词表顺序即
//!    `canonicalEventTypes.generated.ts` / `CanonicalEventType::ALL` 的声明顺序），
//!    字符串只留内容本体，ownerKey 复用预计算串；serde_json 往返不进热路径。
//!    **批量入口一律吃整帧**（`append(batch)` 形态）——逐事件穿越正是本迁移要消灭的成本。
//! 3. wire 归一化（TS `canonicalNormalizer.ts`）——live 路径天然逐事件，走 JsValue
//!    结构化转换而非 JSON 文本；`canonicalEventTypeFor` 与 owner key / eventId 推导
//!    已是 WP1 单源（`pylon-canonical-types`），此处直接复用，不长第二份。
//!
//! 分层硬约束（WP1 记录）：**可失败逻辑全在内层**（`Result<T, String>`），
//! `#[wasm_bindgen]` 壳只做值/错误转换——`JsError::new` 在非 wasm 目标会 panic。
//!
//! 计算核纪律：不读时钟/store/registry、不做 IO。TS `normalizeRawEvent` 里
//! 「receivedAt 缺省取当前时间」的一步因此收归宿主：本层要求 `received_at` 必填。

use pylon_canonical_types::CanonicalEventType;
use serde::Serialize;
use wasm_bindgen::prelude::*;

pub mod batch_rules;
pub mod chunk_merge;
pub mod message_projection;
pub mod tool_projection;
pub mod turn_duration;
pub mod turn_unit;

// ── 事件视图（规则层的输入形状） ─────────────────────────────────────────────

/// owner 三元组 + 可选绑定维（与 TS `CanonicalEventOwner` 对应；remote/workspace 不进
/// ownerKey，但 batch 行/展开事件要原样继承它们）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct EventOwner {
    #[serde(rename = "profileId")]
    pub profile_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "localSessionId")]
    pub local_session_id: String,
    #[serde(rename = "remoteSessionId", skip_serializing_if = "Option::is_none")]
    pub remote_session_id: Option<String>,
    #[serde(rename = "workspaceId", skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

impl EventOwner {
    /// 嵌套 owner 的 JSON 形状（键序与 TS 对象字面量一致）。
    pub fn to_value(&self) -> serde_json::Value {
        let mut object = serde_json::Map::new();
        object.insert(
            "profileId".into(),
            serde_json::Value::String(self.profile_id.clone()),
        );
        object.insert(
            "agentId".into(),
            serde_json::Value::String(self.agent_id.clone()),
        );
        object.insert(
            "localSessionId".into(),
            serde_json::Value::String(self.local_session_id.clone()),
        );
        if let Some(remote) = &self.remote_session_id {
            object.insert(
                "remoteSessionId".into(),
                serde_json::Value::String(remote.clone()),
            );
        }
        if let Some(workspace) = &self.workspace_id {
            object.insert(
                "workspaceId".into(),
                serde_json::Value::String(workspace.clone()),
            );
        }
        serde_json::Value::Object(object)
    }
}

/// 跨概念 identity：四字段互相独立、原样保留（§5.10 施工注意 2）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct EventIdentity {
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

impl EventIdentity {
    /// TS `resolveEventIdentity` 的插入序（toolCallId, messageId, turnId, requestId）；
    /// eventProjectionKey 的键序一致性依赖它。
    pub fn to_value(&self) -> serde_json::Value {
        let mut object = serde_json::Map::new();
        if let Some(tool_call_id) = &self.tool_call_id {
            object.insert(
                "toolCallId".into(),
                serde_json::Value::String(tool_call_id.clone()),
            );
        }
        if let Some(message_id) = &self.message_id {
            object.insert(
                "messageId".into(),
                serde_json::Value::String(message_id.clone()),
            );
        }
        if let Some(turn_id) = &self.turn_id {
            object.insert("turnId".into(), serde_json::Value::String(turn_id.clone()));
        }
        if let Some(request_id) = &self.request_id {
            object.insert(
                "requestId".into(),
                serde_json::Value::String(request_id.clone()),
            );
        }
        serde_json::Value::Object(object)
    }
}

/// 工具负载字段（TS `toolFieldsFromCanonical` 口径）：title/kind/status 仅在 wire 上
/// 是非空 string 时才存在；raw input/output/contentBlocks 是任意 JSON 原样保留。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ToolFields {
    pub title: Option<String>,
    pub kind: Option<String>,
    pub status: Option<String>,
    pub raw_input: Option<serde_json::Value>,
    pub raw_output: Option<serde_json::Value>,
    /// rawOutput 的**预序列化 JSON 文本**。消息投影的 `stringifyToolOutput` 需要
    /// JSON.stringify(v, null, 2) 的逐字节输出——从文本重排（见 [`pretty_json_text`]）
    /// 而不是从 Value 再序列化，键序与数字字面量才与 JS 一致。
    pub raw_output_json: Option<String>,
    pub content_blocks: Option<serde_json::Value>,
}

/// 规则层消费的事件视图。`typed_payload` 仅在宿主显式携带时存在（当前契约：只有
/// `turn.unit` / `*.batch` 行携带完整 typedPayload JSON；热路径 delta 只走 `text`
/// 列，Rust 侧零 JSON 解析）。
#[derive(Debug, Clone)]
pub struct CompactEvent {
    pub event_type: CanonicalEventType,
    pub type_index: u32,
    pub sequence: i64,
    /// 宿主预计算的有效时间戳：`Date.parse(occurredAt) ?? Date.parse(receivedAt)`，
    /// 双双无效为 `None`（turn duration 的「宁可不可测也不猜」语义）。
    pub occurred_at_ms: Option<i64>,
    pub owner_key: String,
    pub owner: EventOwner,
    pub client_generation: i64,
    pub payload_version: i64,
    pub identity: Option<EventIdentity>,
    /// `typedPayload.text`，仅当它是 string（空文本 chunk 为 `None`——与 TS
    /// `textOf`/`deltaTextOf` 的 no-op 语义一致）。
    pub text: Option<String>,
    /// 宿主预格式化的显示时间（TS `options.timeFormatter` 的产物列；计算核不读
    /// locale/时钟）。缺省回退 `received_at` 原文。
    pub time_label: Option<String>,
    /// 宿主注入的工具输入摘要（`options.toolInputSummary` 产物列；空串视同未注入，
    /// 由本层回退 `fallbackToolInput`）。注入策略（renderer registry）是宿主状态，
    /// 计算核不读 registry。
    pub tool_input_summary: Option<String>,
    pub tool: Option<ToolFields>,
    /// rawPayload 的预序列化 JSON 文本（宿主 `JSON.stringify(rawPayload ?? null)`）。
    /// 本层只做字节计长（batch 预算）与聚合拼接（batch 行 rawPayload），从不解析。
    pub raw_json: Option<String>,
    pub typed_payload: Option<serde_json::Value>,
    pub occurred_at: String,
    pub received_at: String,
    /// rawPayload `update._meta.pylonCanonicalRecovery === true`（迁移回收行标记，
    /// 宿主预扫——避免本层为找标记解析每个 rawPayload）。
    pub raw_meta_recovery: bool,
    /// rawPayload `update._meta.pylonOptimisticUser === true`（乐观 user 行标记）。
    pub raw_meta_optimistic: bool,
}

impl CompactEvent {
    /// identity 的三字段投影（TS `identityOf` 口径：messageId/turnId/toolCallId，
    /// requestId 不进 Message 的 externalIdentity）。
    pub fn chat_identity(&self) -> Option<ChatIdentity> {
        let identity = self.identity.as_ref()?;
        let mapped = ChatIdentity {
            message_id: identity.message_id.clone(),
            turn_id: identity.turn_id.clone(),
            tool_call_id: identity.tool_call_id.clone(),
        };
        // 与 TS identityOf 一致：三字段全空 ⇒ undefined。
        let is_empty = mapped.message_id.is_none()
            && mapped.turn_id.is_none()
            && mapped.tool_call_id.is_none();
        if is_empty {
            None
        } else {
            Some(mapped)
        }
    }
}

/// Message.externalIdentity 的口径（TS `OptionalChatEventIdentity` 的三字段映射）。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ChatIdentity {
    #[serde(rename = "messageId", skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(rename = "turnId", skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(rename = "toolCallId", skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatIdentity {
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("ChatIdentity 序列化")
    }
}

/// 从嵌套 canonical 事件 JSON（含 unit 内嵌 segment）物化视图。读侧路径：
/// 单元行展开的整行 segment 是 Value 而非帧列，规则层要继续消费就得回到本形状。
pub fn compact_event_from_value(value: &serde_json::Value) -> CompactEvent {
    let event_type = value
        .get("eventType")
        .and_then(serde_json::Value::as_str)
        .and_then(CanonicalEventType::from_wire)
        .unwrap_or(CanonicalEventType::Unknown);
    let type_index = CanonicalEventType::ALL
        .iter()
        .position(|candidate| *candidate == event_type)
        .unwrap_or(0) as u32;
    let identity = value.get("identity").and_then(|identity| {
        let object = identity.as_object()?;
        Some(EventIdentity {
            message_id: object
                .get("messageId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            turn_id: object
                .get("turnId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            tool_call_id: object
                .get("toolCallId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            request_id: object
                .get("requestId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
        })
    });
    let owner_value = value.get("owner");
    let owner = EventOwner {
        profile_id: owner_value
            .and_then(|owner| owner.get("profileId"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        agent_id: owner_value
            .and_then(|owner| owner.get("agentId"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        local_session_id: owner_value
            .and_then(|owner| owner.get("localSessionId"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string(),
        remote_session_id: owner_value
            .and_then(|owner| owner.get("remoteSessionId"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        workspace_id: owner_value
            .and_then(|owner| owner.get("workspaceId"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    };
    let occurred_at = value
        .get("occurredAt")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let received_at = value
        .get("receivedAt")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string();
    let occurred_at_ms = parse_timestamp(&occurred_at).or_else(|| parse_timestamp(&received_at));
    let owner_key = pylon_canonical_types::canonical_owner_key(
        &owner.profile_id,
        &owner.agent_id,
        &owner.local_session_id,
    )
    .unwrap_or_default();
    let typed_payload = value
        .get("typedPayload")
        .filter(|payload| !payload.is_null())
        .cloned();
    let text = typed_payload
        .as_ref()
        .and_then(|payload| payload.get("text"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let tool = typed_payload.as_ref().and_then(tool_fields_from_payload);
    let raw_json = value
        .get("rawPayload")
        .map(|raw| serde_json::to_string(raw).unwrap_or_else(|_| "null".into()));
    let (raw_meta_recovery, raw_meta_optimistic) = raw_meta_flags(value.get("rawPayload"));
    CompactEvent {
        event_type,
        type_index,
        sequence: value
            .get("sequence")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        occurred_at_ms,
        owner_key,
        owner,
        client_generation: value
            .get("clientGeneration")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(0),
        payload_version: value
            .get("payloadVersion")
            .and_then(serde_json::Value::as_i64)
            .unwrap_or(1),
        identity,
        text,
        time_label: None,
        tool_input_summary: None,
        tool,
        raw_json,
        typed_payload,
        occurred_at,
        received_at,
        raw_meta_recovery,
        raw_meta_optimistic,
    }
}

/// TS `toolFieldsFromCanonical`：自 `typedPayload.tool` 单一路径提取（normalizer
/// 产出的字段 live/replay 必须识别同一组）。
pub fn tool_fields_from_payload(typed_payload: &serde_json::Value) -> Option<ToolFields> {
    let tool = typed_payload.get("tool")?;
    let string_field = |name: &str| {
        tool.get(name)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    Some(ToolFields {
        title: string_field("title"),
        kind: string_field("kind"),
        status: string_field("status"),
        raw_input: tool.get("rawInput").cloned(),
        raw_output: tool.get("rawOutput").cloned(),
        raw_output_json: tool
            .get("rawOutput")
            .map(|raw| serde_json::to_string(raw).unwrap_or_else(|_| "null".into())),
        content_blocks: tool.get("contentBlocks").cloned(),
    })
}

/// rawPayload `update._meta` 上的两个宿主预扫标记（乐观 user / 迁移回收）。
fn raw_meta_flags(raw_payload: Option<&serde_json::Value>) -> (bool, bool) {
    let Some(raw) = raw_payload.filter(|raw| raw.is_object()) else {
        return (false, false);
    };
    // TS canonicalRecoveryMetadata / isOptimisticUserEvent 的取径：
    // root.update ?? root.params?.update。
    let update = raw
        .get("update")
        .filter(|value| value.is_object())
        .or_else(|| {
            raw.get("params")
                .filter(|params| params.is_object())
                .and_then(|params| params.get("update"))
                .filter(|value| value.is_object())
        });
    let Some(meta) = update
        .and_then(|update| update.get("_meta"))
        .filter(|meta| meta.is_object())
    else {
        return (false, false);
    };
    let recovery = meta.get("pylonCanonicalRecovery") == Some(&serde_json::Value::Bool(true));
    let optimistic = meta.get("pylonOptimisticUser") == Some(&serde_json::Value::Bool(true));
    (recovery, optimistic)
}

// ── 时间戳解析 ───────────────────────────────────────────────────────────────

/// `Date.parse` 的 ISO 子集实现（计算核不引 chrono，也无需：canonical 时间戳一律
/// `toISOString()` 产物）。支持 `YYYY-MM-DD`（UTC 零点，与 JS date-only 语义一致）、
/// `YYYY-MM-DDTHH:MM[:SS[.fff…]]` + `Z` 或 `±HH:MM` 偏移。**无偏移的 date-time 按
/// UTC 处理**——JS 会按宿主本地时区解释，这是已知语义缺口（见 parity 记录），
/// canonical 语料（toISOString 产物）恒带 Z，不触发该分支。
pub fn parse_timestamp(value: &str) -> Option<i64> {
    if value.is_empty() {
        return None;
    }
    let bytes = value.as_bytes();
    if bytes.len() < 10 {
        return None;
    }
    let year: i64 = value.get(0..4)?.parse().ok()?;
    if bytes[4] != b'-' {
        return None;
    }
    let month: i64 = value.get(5..7)?.parse().ok()?;
    if bytes[7] != b'-' {
        return None;
    }
    let day: i64 = value.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut hour: i64 = 0;
    let mut minute: i64 = 0;
    let mut second: i64 = 0;
    let mut millisecond: i64 = 0;
    let mut offset_minutes: i64 = 0;
    if bytes.len() == 10 {
        // date-only：JS 按 UTC 零点。
    } else {
        let separator = bytes[10];
        if separator != b'T' && separator != b' ' && separator != b't' {
            return None;
        }
        if bytes.len() < 16 {
            return None;
        }
        hour = value.get(11..13)?.parse().ok()?;
        if bytes[13] != b':' {
            return None;
        }
        minute = value.get(14..16)?.parse().ok()?;
        let mut cursor = 16usize;
        if bytes.len() > cursor && bytes[cursor] == b':' {
            second = value.get(17..19)?.parse().ok()?;
            cursor = 19;
            // 小数秒：任意精度，截断到毫秒（Date 同样按 ms 存储）。
            if bytes.len() > cursor && bytes[cursor] == b'.' {
                cursor += 1;
                let start = cursor;
                while bytes.len() > cursor && bytes[cursor].is_ascii_digit() {
                    cursor += 1;
                }
                let digits = &value[start..cursor];
                if digits.is_empty() {
                    return None;
                }
                let mut fraction: i64 = 0;
                for (index, digit) in digits.bytes().take(3).enumerate() {
                    fraction += (digit - b'0') as i64 * [100, 10, 1][index];
                }
                millisecond = fraction;
            }
        }
        if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) || !(0..=60).contains(&second) {
            return None;
        }
        // 时区：Z / ±HH:MM / ±HHMM / 缺省（缺省按 UTC，缺口见函数注释）。
        if bytes.len() > cursor {
            match bytes[cursor] {
                b'Z' | b'z' => {}
                b'+' | b'-' => {
                    let sign: i64 = if bytes[cursor] == b'-' { -1 } else { 1 };
                    let rest = &value[cursor + 1..];
                    let (offset_hour, offset_minute) =
                        if rest.len() >= 5 && rest.as_bytes()[2] == b':' {
                            (
                                rest.get(0..2)?.parse::<i64>().ok()?,
                                rest.get(3..5)?.parse::<i64>().ok()?,
                            )
                        } else if rest.len() >= 4 {
                            (
                                rest.get(0..2)?.parse::<i64>().ok()?,
                                rest.get(2..4)?.parse::<i64>().ok()?,
                            )
                        } else {
                            return None;
                        };
                    offset_minutes = sign * (offset_hour * 60 + offset_minute);
                }
                _ => return None,
            }
        }
    }
    // days-from-civil（Howard Hinnant 算法）：公历日期 → Unix 天数。
    let year_shifted = if month <= 2 { year - 1 } else { year };
    let era = if year_shifted >= 0 {
        year_shifted
    } else {
        year_shifted - 399
    } / 400;
    let year_of_era = year_shifted - era * 400;
    let month_shifted = if month > 2 { month - 3 } else { month + 9 };
    let day_of_era = (153 * month_shifted + 2) / 5 + day - 1;
    let day_number = era * 146_097 + year_of_era * 365 + year_of_era / 4 - year_of_era / 100
        + day_of_era
        - 719_468;
    let seconds = day_number * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1_000 + millisecond)
}

// ── PYPB v1 帧解码（spec「编组格式」定稿的紧凑列式缓冲） ─────────────────────

/// 字串池槽位（每事件 23 个 `(offset u32, len u32)`；len = u32::MAX 表示缺失）。
mod slots {
    pub const OWNER_KEY: usize = 0;
    pub const PROFILE_ID: usize = 1;
    pub const AGENT_ID: usize = 2;
    pub const LOCAL_SESSION_ID: usize = 3;
    pub const REMOTE_SESSION_ID: usize = 4;
    pub const WORKSPACE_ID: usize = 5;
    pub const MESSAGE_ID: usize = 6;
    pub const TURN_ID: usize = 7;
    pub const TOOL_CALL_ID: usize = 8;
    pub const REQUEST_ID: usize = 9;
    pub const TEXT: usize = 10;
    pub const TIME_LABEL: usize = 11;
    pub const TOOL_TITLE: usize = 12;
    pub const TOOL_KIND: usize = 13;
    pub const TOOL_STATUS: usize = 14;
    pub const TOOL_RAW_INPUT_JSON: usize = 15;
    pub const TOOL_RAW_OUTPUT_JSON: usize = 16;
    pub const TOOL_CONTENT_BLOCKS_JSON: usize = 17;
    pub const RAW_JSON: usize = 18;
    pub const TYPED_PAYLOAD_JSON: usize = 19;
    pub const OCCURRED_AT: usize = 20;
    pub const RECEIVED_AT: usize = 21;
    pub const TOOL_INPUT_SUMMARY: usize = 22;
    pub const COUNT: usize = 23;
}

mod flag_bits {
    pub const HAS_IDENTITY: u32 = 1 << 0;
    pub const HAS_TEXT: u32 = 1 << 1;
    pub const HAS_TOOL: u32 = 1 << 2;
    pub const HAS_RAW_JSON: u32 = 1 << 3;
    pub const HAS_TYPED_PAYLOAD_JSON: u32 = 1 << 4;
    pub const TIMESTAMP_VALID: u32 = 1 << 5;
    pub const RAW_META_RECOVERY: u32 = 1 << 6;
    pub const RAW_META_OPTIMISTIC: u32 = 1 << 7;
}

/// 每事件定长段：24B 头（spec 钉死：sequence i64 | occurredAtMs i64 | typeIndex u32 |
/// flags u32）+ 16B 标量（clientGeneration / payloadVersion）+ 23×8B 池引用。
const EVENT_STRIDE: usize = 24 + 16 + slots::COUNT * 8;
const HEADER_SIZE: usize = 14;
const ABSENT_LEN: u32 = u32::MAX;

/// 解码整页事件帧。**批量入口只认这一种形态**：热边界禁 JSON 串行，事件类型是
/// 词表索引、字符串只留内容本体；越界/坏形状一律 `Err`（fail-closed，不静默截断）。
pub fn decode_batch(frame: &[u8]) -> Result<Vec<CompactEvent>, String> {
    if frame.len() < HEADER_SIZE {
        return Err(format!("PYPB 帧过短: {} 字节", frame.len()));
    }
    if &frame[0..4] != b"PYPB" {
        return Err("PYPB magic 不匹配".into());
    }
    let version = read_u16(&frame[4..6]);
    if version != 1 {
        return Err(format!("PYPB 版本不支持: {version}"));
    }
    let event_count = read_u32(&frame[6..10]) as usize;
    let pool_len = read_u32(&frame[10..14]) as usize;
    let pool_start = HEADER_SIZE;
    let events_start = pool_start
        .checked_add(pool_len)
        .ok_or_else(|| "PYPB 帧长度溢出".to_string())?;
    if frame.len() < events_start {
        return Err(format!(
            "PYPB 字串池越界: 需要 {events_start} 字节，实际 {}",
            frame.len()
        ));
    }
    let pool = std::str::from_utf8(&frame[pool_start..events_start])
        .map_err(|error| format!("PYPB 字串池非 UTF-8: {error}"))?;
    let total = EVENT_STRIDE
        .checked_mul(event_count)
        .ok_or_else(|| "PYPB 事件区长度溢出".to_string())?;
    if frame.len() < events_start + total {
        return Err(format!(
            "PYPB 事件区越界: 需要 {} 字节，实际 {}",
            events_start + total,
            frame.len()
        ));
    }
    let mut events = Vec::with_capacity(event_count);
    for index in 0..event_count {
        let base = events_start + index * EVENT_STRIDE;
        let event = decode_event(frame, base, pool)?;
        events.push(event);
    }
    Ok(events)
}

fn decode_event(frame: &[u8], base: usize, pool: &str) -> Result<CompactEvent, String> {
    let sequence = read_i64(&frame[base..base + 8]);
    let occurred_at_ms = read_i64(&frame[base + 8..base + 16]);
    let type_index = read_u32(&frame[base + 16..base + 20]);
    let flags = read_u32(&frame[base + 20..base + 24]);
    let client_generation = read_i64(&frame[base + 24..base + 32]);
    let payload_version = read_i64(&frame[base + 32..base + 40]);
    let refs_base = base + 40;
    let field = |slot: usize| -> Result<Option<String>, String> {
        let at = refs_base + slot * 8;
        let offset = read_u32(&frame[at..at + 4]) as usize;
        let len = read_u32(&frame[at + 4..at + 8]);
        if len == ABSENT_LEN {
            return Ok(None);
        }
        let end = offset
            .checked_add(len as usize)
            .ok_or_else(|| format!("事件槽位 {slot} 长度溢出"))?;
        let bytes = pool
            .get(offset..end)
            .ok_or_else(|| format!("事件槽位 {slot} 越界: [{offset},{end})"))?;
        Ok(Some(bytes.to_string()))
    };

    let event_type = CanonicalEventType::ALL
        .get(type_index as usize)
        .copied()
        .ok_or_else(|| {
            format!(
                "typeIndex {type_index} 不在词表内（词表长 {}）",
                CanonicalEventType::ALL.len()
            )
        })?;

    let owner = EventOwner {
        profile_id: field(slots::PROFILE_ID)?.unwrap_or_default(),
        agent_id: field(slots::AGENT_ID)?.unwrap_or_default(),
        local_session_id: field(slots::LOCAL_SESSION_ID)?.unwrap_or_default(),
        remote_session_id: field(slots::REMOTE_SESSION_ID)?,
        workspace_id: field(slots::WORKSPACE_ID)?,
    };
    let identity = if flags & flag_bits::HAS_IDENTITY != 0 {
        Some(EventIdentity {
            message_id: field(slots::MESSAGE_ID)?,
            turn_id: field(slots::TURN_ID)?,
            tool_call_id: field(slots::TOOL_CALL_ID)?,
            request_id: field(slots::REQUEST_ID)?,
        })
    } else {
        None
    };
    let text = if flags & flag_bits::HAS_TEXT != 0 {
        field(slots::TEXT)?
    } else {
        None
    };
    let tool = if flags & flag_bits::HAS_TOOL != 0 {
        let raw_input_json = field(slots::TOOL_RAW_INPUT_JSON)?;
        let raw_output_json = field(slots::TOOL_RAW_OUTPUT_JSON)?;
        let content_blocks_json = field(slots::TOOL_CONTENT_BLOCKS_JSON)?;
        let parse =
            |json: &Option<String>, name: &str| -> Result<Option<serde_json::Value>, String> {
                json.as_deref()
                    .map(|json| {
                        serde_json::from_str(json)
                            .map_err(|error| format!("{name} JSON 解析失败: {error}"))
                    })
                    .transpose()
            };
        Some(ToolFields {
            title: field(slots::TOOL_TITLE)?,
            kind: field(slots::TOOL_KIND)?,
            status: field(slots::TOOL_STATUS)?,
            raw_input: parse(&raw_input_json, "rawInput")?,
            raw_output: parse(&raw_output_json, "rawOutput")?,
            raw_output_json,
            content_blocks: parse(&content_blocks_json, "contentBlocks")?,
        })
    } else {
        None
    };
    // typedPayload JSON 只在宿主声明时解析（当前契约：turn.unit / *.batch 行）；
    // delta 热路径恒无此列，Rust 侧零 JSON 解析。
    let typed_payload = if flags & flag_bits::HAS_TYPED_PAYLOAD_JSON != 0 {
        field(slots::TYPED_PAYLOAD_JSON)?
            .map(|json| {
                serde_json::from_str(&json)
                    .map_err(|error| format!("typedPayload JSON 解析失败: {error}"))
            })
            .transpose()?
    } else {
        None
    };
    Ok(CompactEvent {
        event_type,
        type_index,
        sequence,
        occurred_at_ms: if flags & flag_bits::TIMESTAMP_VALID != 0 {
            Some(occurred_at_ms)
        } else {
            None
        },
        owner_key: field(slots::OWNER_KEY)?.unwrap_or_default(),
        owner,
        client_generation,
        payload_version,
        identity,
        text,
        time_label: field(slots::TIME_LABEL)?,
        tool_input_summary: field(slots::TOOL_INPUT_SUMMARY)?,
        tool,
        raw_json: if flags & flag_bits::HAS_RAW_JSON != 0 {
            field(slots::RAW_JSON)?
        } else {
            None
        },
        typed_payload,
        occurred_at: field(slots::OCCURRED_AT)?.unwrap_or_default(),
        received_at: field(slots::RECEIVED_AT)?.unwrap_or_default(),
        raw_meta_recovery: flags & flag_bits::RAW_META_RECOVERY != 0,
        raw_meta_optimistic: flags & flag_bits::RAW_META_OPTIMISTIC != 0,
    })
}

fn read_u16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes([bytes[0], bytes[1]])
}

fn read_u32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes.try_into().expect("u32 切片长度"))
}

fn read_i64(bytes: &[u8]) -> i64 {
    i64::from_le_bytes(bytes.try_into().expect("i64 切片长度"))
}

// ── wire 归一化（TS canonicalNormalizer.ts 的逐函数对齐） ────────────────────

/// canonical normalize 结果（TS `CanonicalNormalizeResult`）：事件恒存在
/// （malformed/unknown 亦产出，raw 不丢），附分类元信息供调用方做 wire 专属处理。
#[derive(Debug, Clone, Serialize)]
pub struct NormalizedEvent {
    pub event: serde_json::Value,
    #[serde(rename = "sessionUpdate", skip_serializing_if = "Option::is_none")]
    pub session_update: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<serde_json::Value>,
    pub malformed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

fn is_object(value: Option<&serde_json::Value>) -> Option<&serde_json::Value> {
    value.filter(|value| value.is_object())
}

/// 非空字符串（TS `nonEmptyString`）：trim 后非空，返回 **trim 后**的值。
fn non_empty_string(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|trimmed| !trimmed.is_empty())
        .map(str::to_string)
}

/// 从任意 wire envelope 提取 update 对象（宽容度与 TS `extractUpdate` 一致：
/// `$.params.update` / `$.update` / 裸 sessionUpdate）。
fn extract_update(raw: &serde_json::Value) -> Option<&serde_json::Value> {
    if !raw.is_object() {
        return None;
    }
    let params = is_object(raw.get("params"));
    if let Some(update) = params.and_then(|params| is_object(params.get("update"))) {
        return Some(update);
    }
    if let Some(update) = is_object(raw.get("update")) {
        return Some(update);
    }
    if raw
        .get("sessionUpdate")
        .and_then(serde_json::Value::as_str)
        .is_some()
    {
        return Some(raw);
    }
    if let Some(params) = params {
        if params
            .get("sessionUpdate")
            .and_then(serde_json::Value::as_str)
            .is_some()
        {
            return Some(params);
        }
    }
    None
}

fn first_string(record: Option<&serde_json::Value>, keys: &[&str]) -> Option<String> {
    let record = record?;
    for key in keys {
        if let Some(value) = non_empty_string(record.get(key)) {
            return Some(value);
        }
    }
    None
}

/// 单一权威身份解析（TS `resolveEventIdentity`）：toolCallId 根优先（root → content
/// → meta），其余 content 优先（content → root → meta）；别名含 snake_case 与
/// toolUseId。结果对象的键序与 TS 逐字节一致（eventProjectionKey 依赖它）。
pub fn resolve_event_identity(update: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let update = update?;
    if !update.is_object() {
        return None;
    }
    let content = is_object(update.get("content"));
    let meta = is_object(update.get("_meta"));
    let mut result = serde_json::Map::new();
    let mut pick = |field: &str, records: [Option<&serde_json::Value>; 3], keys: &[&str]| {
        for record in records.into_iter().flatten() {
            if let Some(value) = first_string(Some(record), keys) {
                result.insert(field.to_string(), serde_json::Value::String(value));
                return;
            }
        }
    };
    pick(
        "toolCallId",
        [Some(update), content, meta],
        &["toolCallId", "tool_call_id", "toolUseId", "tool_use_id"],
    );
    pick(
        "messageId",
        [content, Some(update), meta],
        &["messageId", "message_id"],
    );
    pick(
        "turnId",
        [content, Some(update), meta],
        &["turnId", "turn_id"],
    );
    pick(
        "requestId",
        [content, Some(update), meta],
        &["requestId", "request_id"],
    );
    if result.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(result))
    }
}

/// 工具 identity 唯一解析路径（§5.11 禁止项 1：live/replay 共用，不得各自读字段）。
pub fn resolve_tool_call_id(update: Option<&serde_json::Value>) -> Option<String> {
    resolve_event_identity(update)?
        .get("toolCallId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

/// 工具事件负载（TS `toolPayload`）：title/kind/rawInput/rawOutput/status/contentBlocks
/// 全保留，键序与 TS 对象字面量一致；非工具事件返回 None。
fn tool_payload(update: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let update = update?;
    let session_update = update
        .get("sessionUpdate")
        .and_then(serde_json::Value::as_str)?;
    if session_update != "tool_call" && session_update != "tool_call_update" {
        return None;
    }
    let mut tool = serde_json::Map::new();
    if let Some(title) = non_empty_string(update.get("title")) {
        tool.insert("title".into(), serde_json::Value::String(title));
    }
    if let Some(kind) = non_empty_string(update.get("kind")) {
        tool.insert("kind".into(), serde_json::Value::String(kind));
    }
    if let Some(raw_input) = update.get("rawInput") {
        tool.insert("rawInput".into(), raw_input.clone());
    }
    if let Some(raw_output) = update.get("rawOutput") {
        tool.insert("rawOutput".into(), raw_output.clone());
    }
    if let Some(status) = non_empty_string(update.get("status")) {
        tool.insert("status".into(), serde_json::Value::String(status));
    }
    if let Some(content) = update.get("content") {
        tool.insert("contentBlocks".into(), content.clone());
    }
    Some(serde_json::Value::Object(tool))
}

/// 文本类事件负载（TS `textOf`）：`content.text ?? update.text`，注意 `??` 的
/// nullish 语义——null 与缺失都会落到 update.text，非 nullish 的非字符串则直接失败。
fn text_of(update: Option<&serde_json::Value>) -> Option<String> {
    let update = update?;
    let content = is_object(update.get("content"));
    let candidate = match content.and_then(|content| content.get("text")) {
        None | Some(serde_json::Value::Null) => update.get("text"),
        other => other,
    };
    candidate
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// 统一 canonical normalize 入口（TS `normalizeRawEvent`；live / replay / SQLite
/// recovery 三路径共用）。恒产出 canonical 事件：malformed/unknown 亦产出
/// `eventType: 'unknown'`，rawPayload 恒为原始 wire（§5.10 原则 5）。
///
/// 与 TS 的唯一差异：`received_at` 必填——TS 在缺省时读 `new Date()`，计算核不读时钟。
pub fn normalize_raw_event_inner(
    raw: &serde_json::Value,
    owner: &serde_json::Value,
    client_generation: i64,
    sequence: i64,
    received_at: &str,
) -> Result<NormalizedEvent, String> {
    let update = extract_update(raw);
    let malformed = update.is_none();
    let session_update = update
        .and_then(|update| update.get("sessionUpdate"))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let status = update
        .and_then(|update| update.get("status"))
        .and_then(serde_json::Value::as_str);
    let event_type =
        pylon_canonical_types::canonical_event_type_for(session_update.as_deref(), status);
    let identity = resolve_event_identity(update);
    let tool = tool_payload(update);
    let text = text_of(update);

    let mut typed_payload = serde_json::Map::new();
    if let Some(text) = &text {
        typed_payload.insert("text".into(), serde_json::Value::String(text.clone()));
    }
    if let Some(tool) = &tool {
        typed_payload.insert("tool".into(), tool.clone());
    }
    if session_update.as_deref() == Some("error") {
        let error = non_empty_string(update.and_then(|update| update.get("error")))
            .or_else(|| non_empty_string(update.and_then(|update| update.get("message"))));
        if let Some(error) = error {
            typed_payload.insert("error".into(), serde_json::Value::String(error));
        }
    }
    if session_update.as_deref() == Some("cancelled") {
        // cancelled 由 canonical 失败族表达，stopReason 留在 typed payload，
        // replay 无需解析 provider 文本即可区分。
        typed_payload.insert(
            "stopReason".into(),
            serde_json::Value::String("cancelled".into()),
        );
    }
    if session_update.as_deref() == Some("done") {
        // D5：完成元数据是 additive 的，保持 payloadVersion 稳定。
        for field in ["stopReason", "usage", "model"] {
            if let Some(value) = update.and_then(|update| update.get(field)) {
                typed_payload.insert(field.to_string(), value.clone());
            }
        }
    }

    let profile_id = owner
        .get("profileId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "owner 必填 profileId".to_string())?;
    let agent_id = owner
        .get("agentId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "owner 必填 agentId".to_string())?;
    let local_session_id = owner
        .get("localSessionId")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "owner 必填 localSessionId".to_string())?;
    let owner_key =
        pylon_canonical_types::canonical_owner_key(profile_id, agent_id, local_session_id)
            .map_err(|error| format!("owner key 序列化失败: {error}"))?;

    let mut event = serde_json::Map::new();
    event.insert(
        "eventId".into(),
        serde_json::Value::String(pylon_canonical_types::canonical_event_id(
            &owner_key, sequence,
        )),
    );
    event.insert("owner".into(), owner.clone());
    event.insert(
        "clientGeneration".into(),
        serde_json::Value::from(client_generation),
    );
    event.insert("sequence".into(), serde_json::Value::from(sequence));
    event.insert(
        "occurredAt".into(),
        serde_json::Value::String(received_at.to_string()),
    );
    event.insert(
        "receivedAt".into(),
        serde_json::Value::String(received_at.to_string()),
    );
    event.insert(
        "eventType".into(),
        serde_json::Value::String(event_type.as_str().to_string()),
    );
    event.insert("payloadVersion".into(), serde_json::Value::from(1));
    if let Some(identity) = &identity {
        event.insert("identity".into(), identity.clone());
    }
    if !typed_payload.is_empty() {
        event.insert(
            "typedPayload".into(),
            serde_json::Value::Object(typed_payload),
        );
    }
    event.insert("rawPayload".into(), raw.clone());
    Ok(NormalizedEvent {
        event: serde_json::Value::Object(event),
        session_update,
        update: update.cloned(),
        malformed,
        warning: malformed.then(|| "未找到可解析的 update envelope（raw 已保留）".to_string()),
    })
}

// ── wasm 薄壳（只做值/错误转换；可失败逻辑全在内层） ─────────────────────────

/// wasm 出口统一序列化：serde map → **plain object**（serde-wasm-bindgen 缺省会产
/// JS `Map`，JSON.stringify 归零、宿主深等断言全毁；canonical 事件在 JS 侧的契约
/// 形状是普通对象）。
pub(crate) fn to_js<T: serde::Serialize + ?Sized>(value: &T) -> Result<JsValue, String> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|error| format!("结果序列化失败: {error}"))
}

#[wasm_bindgen(js_name = normalizeRawEvent)]
pub fn normalize_raw_event(
    raw: JsValue,
    owner: JsValue,
    client_generation: f64,
    sequence: f64,
    received_at: Option<String>,
) -> Result<JsValue, JsError> {
    fn inner(
        raw: JsValue,
        owner: JsValue,
        client_generation: f64,
        sequence: f64,
        received_at: Option<String>,
    ) -> Result<JsValue, String> {
        if !client_generation.is_finite() || client_generation.fract() != 0.0 {
            return Err(format!(
                "clientGeneration 必须是整数值（收到 {client_generation}）"
            ));
        }
        if !sequence.is_finite() || sequence.fract() != 0.0 {
            return Err(format!("sequence 必须是整数值（收到 {sequence}）"));
        }
        let received_at = received_at.ok_or_else(|| {
            "receivedAt 必填：计算核不读时钟，缺省取当前时间的一步由宿主完成".to_string()
        })?;
        let raw: serde_json::Value = serde_wasm_bindgen::from_value(raw)
            .map_err(|error| format!("raw 反序列化失败: {error}"))?;
        let owner: serde_json::Value = serde_wasm_bindgen::from_value(owner)
            .map_err(|error| format!("owner 反序列化失败: {error}"))?;
        let normalized = normalize_raw_event_inner(
            &raw,
            &owner,
            client_generation as i64,
            sequence as i64,
            &received_at,
        )?;
        to_js(&normalized)
    }
    inner(raw, owner, client_generation, sequence, received_at)
        .map_err(|error| JsError::new(&error))
}

// ── JSON 文本重排（消息投影的 stringifyToolOutput 用） ───────────────────────

/// 把**minified JSON 文本**重排为 `JSON.stringify(v, null, 2)` 的逐字节形态。
/// 从文本重排而不是从 `serde_json::Value` 再序列化，理由有二：serde_json 的
/// `Map` 默认按键排序（丢 JS 的插入序），数字字面量会被 Rust 浮点格式改写；
/// 文本直通让键序与数字都保持宿主 `JSON.stringify` 的原样。
pub fn pretty_json_text(input: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut cursor = 0usize;
    write_json_value(input, &mut cursor, 0, &mut out)?;
    skip_json_ws(input, &mut cursor);
    if cursor != input.len() {
        return Err(format!("JSON 文本存在尾随内容（位置 {cursor}）"));
    }
    Ok(out)
}

fn skip_json_ws(input: &str, cursor: &mut usize) {
    let bytes = input.as_bytes();
    while *cursor < bytes.len() && matches!(bytes[*cursor], b' ' | b'\t' | b'\n' | b'\r') {
        *cursor += 1;
    }
}

fn write_json_value(
    input: &str,
    cursor: &mut usize,
    depth: usize,
    out: &mut String,
) -> Result<(), String> {
    skip_json_ws(input, cursor);
    let bytes = input.as_bytes();
    if *cursor >= bytes.len() {
        return Err("JSON 文本提前结束".into());
    }
    match bytes[*cursor] {
        b'{' => {
            *cursor += 1;
            skip_json_ws(input, cursor);
            if bytes.get(*cursor) == Some(&b'}') {
                *cursor += 1;
                out.push_str("{}");
                return Ok(());
            }
            out.push_str("{\n");
            loop {
                skip_json_ws(input, cursor);
                if bytes.get(*cursor) != Some(&b'"') {
                    return Err(format!("对象键必须是字符串（位置 {cursor}）"));
                }
                push_indent(depth + 1, out);
                copy_json_string(input, cursor, out)?;
                skip_json_ws(input, cursor);
                if bytes.get(*cursor) != Some(&b':') {
                    return Err(format!("缺少冒号（位置 {cursor}）"));
                }
                *cursor += 1;
                out.push_str(": ");
                write_json_value(input, cursor, depth + 1, out)?;
                skip_json_ws(input, cursor);
                match bytes.get(*cursor) {
                    Some(b',') => {
                        *cursor += 1;
                        out.push_str(",\n");
                    }
                    Some(b'}') => {
                        *cursor += 1;
                        out.push('\n');
                        break;
                    }
                    _ => return Err(format!("对象缺少闭合（位置 {cursor}）")),
                }
            }
            push_indent(depth, out);
            out.push('}');
            Ok(())
        }
        b'[' => {
            *cursor += 1;
            skip_json_ws(input, cursor);
            if bytes.get(*cursor) == Some(&b']') {
                *cursor += 1;
                out.push_str("[]");
                return Ok(());
            }
            out.push_str("[\n");
            loop {
                push_indent(depth + 1, out);
                write_json_value(input, cursor, depth + 1, out)?;
                skip_json_ws(input, cursor);
                match bytes.get(*cursor) {
                    Some(b',') => {
                        *cursor += 1;
                        out.push_str(",\n");
                    }
                    Some(b']') => {
                        *cursor += 1;
                        out.push('\n');
                        break;
                    }
                    _ => return Err(format!("数组缺少闭合（位置 {cursor}）")),
                }
            }
            push_indent(depth, out);
            out.push(']');
            Ok(())
        }
        b'"' => copy_json_string(input, cursor, out),
        _ => {
            // 字面量（number / true / false / null）逐字节直通。
            let start = *cursor;
            while *cursor < bytes.len()
                && !matches!(
                    bytes[*cursor],
                    b',' | b'}' | b']' | b' ' | b'\t' | b'\n' | b'\r'
                )
            {
                *cursor += 1;
            }
            if start == *cursor {
                return Err(format!("非法 JSON 字面量（位置 {start}）"));
            }
            out.push_str(&input[start..*cursor]);
            Ok(())
        }
    }
}

fn copy_json_string(input: &str, cursor: &mut usize, out: &mut String) -> Result<(), String> {
    let bytes = input.as_bytes();
    let start = *cursor;
    *cursor += 1; // 开引号
    while *cursor < bytes.len() {
        match bytes[*cursor] {
            b'\\' => *cursor += 2, // 转义：跳过下一个字符
            b'"' => {
                *cursor += 1;
                out.push_str(&input[start..*cursor]);
                return Ok(());
            }
            _ => *cursor += 1,
        }
    }
    Err(format!("字符串缺少闭合引号（起始于 {start}）"))
}

fn push_indent(depth: usize, out: &mut String) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

/// UTF-16 码元口径的 `slice(0, limit)`（TS `String.prototype.slice` 对齐；D2 的
/// UTF-16 计量纪律同样适用于这条展示截断——按 char 切会把 astral 字符切错位）。
pub fn slice_utf16(text: &str, limit: usize) -> &str {
    let mut units = 0usize;
    for (index, ch) in text.char_indices() {
        if units >= limit {
            return &text[..index];
        }
        units += ch.len_utf16();
    }
    text
}

// ── 原生测试支撑（仅 cfg(test) 参与；帧编码器是 parity/单测的对向装置） ────────

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;

    pub const OWNER_KEY: &str = r#"["p1","peri","local:s1"]"#;

    pub fn owner() -> EventOwner {
        EventOwner {
            profile_id: "p1".into(),
            agent_id: "peri".into(),
            local_session_id: "local:s1".into(),
            remote_session_id: None,
            workspace_id: None,
        }
    }

    /// 基准事件：字段缺省与 TS 测试语料对齐（occurredAt = 2026-09-14T00:00:00.000Z）。
    pub fn event(event_type: CanonicalEventType, sequence: i64) -> CompactEvent {
        CompactEvent {
            event_type,
            type_index: CanonicalEventType::ALL
                .iter()
                .position(|candidate| *candidate == event_type)
                .expect("词表内类型") as u32,
            sequence,
            occurred_at_ms: parse_timestamp("2026-09-14T00:00:00.000Z"),
            owner_key: OWNER_KEY.into(),
            owner: owner(),
            client_generation: 1,
            payload_version: 1,
            identity: None,
            text: None,
            time_label: Some("00:00:00".into()),
            tool_input_summary: None,
            tool: None,
            raw_json: Some("null".into()),
            typed_payload: None,
            occurred_at: "2026-09-14T00:00:00.000Z".into(),
            received_at: "2026-09-14T00:00:00.000Z".into(),
            raw_meta_recovery: false,
            raw_meta_optimistic: false,
        }
    }

    /// 毫秒时间戳 → ISO（测试语料构造用；只覆盖 Z 时区）。
    pub fn iso_of(ms: i64) -> String {
        let seconds = ms.div_euclid(1000);
        let millis = ms.rem_euclid(1000);
        let days = seconds.div_euclid(86_400);
        let day_seconds = seconds.rem_euclid(86_400);
        // civil-from-days（Howard Hinnant 算法的逆）。
        let z = days + 719_468;
        let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
        let day_of_era = z - era * 146_097;
        let year_of_era =
            (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let mut year = year_of_era + era * 400;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let mp = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * mp + 2) / 5 + 1;
        let month = if mp < 10 { mp + 3 } else { mp - 9 };
        if month <= 2 {
            year += 1;
        }
        format!(
            "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
            year,
            month,
            day,
            day_seconds / 3600,
            day_seconds % 3600 / 60,
            day_seconds % 60,
            millis
        )
    }

    /// 帧编码器：与 TS parity 测试的 JS 编码器逐字节同构（native 单测的对向装置）。
    pub fn encode_frame(events: &[CompactEvent]) -> Vec<u8> {
        let mut pool: Vec<u8> = Vec::new();
        let mut offsets: Vec<[u32; 2]> = Vec::with_capacity(events.len() * slots::COUNT);
        let put = |value: &Option<String>, pool: &mut Vec<u8>| -> [u32; 2] {
            match value {
                None => [0, ABSENT_LEN],
                Some(text) => {
                    let offset = pool.len() as u32;
                    pool.extend_from_slice(text.as_bytes());
                    [offset, text.len() as u32]
                }
            }
        };
        for event in events {
            offsets.push(put(&Some(event.owner_key.clone()), &mut pool));
            offsets.push(put(&Some(event.owner.profile_id.clone()), &mut pool));
            offsets.push(put(&Some(event.owner.agent_id.clone()), &mut pool));
            offsets.push(put(&Some(event.owner.local_session_id.clone()), &mut pool));
            offsets.push(put(&event.owner.remote_session_id, &mut pool));
            offsets.push(put(&event.owner.workspace_id, &mut pool));
            let identity = event.identity.clone().unwrap_or_default();
            let has_identity = event.identity.is_some();
            let slot_if = |value: &Option<String>, enabled: bool| {
                if enabled {
                    value.clone()
                } else {
                    None
                }
            };
            offsets.push(put(&slot_if(&identity.message_id, has_identity), &mut pool));
            offsets.push(put(&slot_if(&identity.turn_id, has_identity), &mut pool));
            offsets.push(put(
                &slot_if(&identity.tool_call_id, has_identity),
                &mut pool,
            ));
            offsets.push(put(&slot_if(&identity.request_id, has_identity), &mut pool));
            offsets.push(put(&event.text, &mut pool));
            offsets.push(put(&event.time_label, &mut pool));
            let (tool, has_tool) = match &event.tool {
                Some(tool) => (tool, true),
                None => (&ToolFields::default(), false),
            };
            let tool_slot = |value: &Option<String>| slot_if(value, has_tool);
            offsets.push(put(&tool_slot(&tool.title), &mut pool));
            offsets.push(put(&tool_slot(&tool.kind), &mut pool));
            offsets.push(put(&tool_slot(&tool.status), &mut pool));
            offsets.push(put(
                &slot_if(
                    &tool
                        .raw_input
                        .as_ref()
                        .map(|value| serde_json::to_string(value).expect("rawInput")),
                    has_tool,
                ),
                &mut pool,
            ));
            offsets.push(put(&tool_slot(&tool.raw_output_json), &mut pool));
            offsets.push(put(
                &slot_if(
                    &tool
                        .content_blocks
                        .as_ref()
                        .map(|value| serde_json::to_string(value).expect("contentBlocks")),
                    has_tool,
                ),
                &mut pool,
            ));
            offsets.push(put(&event.raw_json, &mut pool));
            offsets.push(put(
                &event
                    .typed_payload
                    .as_ref()
                    .map(|value| serde_json::to_string(value).expect("typedPayload")),
                &mut pool,
            ));
            offsets.push(put(&Some(event.occurred_at.clone()), &mut pool));
            offsets.push(put(&Some(event.received_at.clone()), &mut pool));
            offsets.push(put(&event.tool_input_summary, &mut pool));
        }

        let mut frame: Vec<u8> = Vec::new();
        frame.extend_from_slice(b"PYPB");
        frame.extend_from_slice(&1u16.to_le_bytes());
        frame.extend_from_slice(&(events.len() as u32).to_le_bytes());
        frame.extend_from_slice(&(pool.len() as u32).to_le_bytes());
        frame.extend_from_slice(&pool);
        for (index, event) in events.iter().enumerate() {
            let refs = &offsets[index * slots::COUNT..(index + 1) * slots::COUNT];
            frame.extend_from_slice(&event.sequence.to_le_bytes());
            frame.extend_from_slice(&event.occurred_at_ms.unwrap_or(0).to_le_bytes());
            frame.extend_from_slice(&event.type_index.to_le_bytes());
            let mut flags = 0u32;
            if event.identity.is_some() {
                flags |= flag_bits::HAS_IDENTITY;
            }
            if event.text.is_some() {
                flags |= flag_bits::HAS_TEXT;
            }
            if event.tool.is_some() {
                flags |= flag_bits::HAS_TOOL;
            }
            if event.raw_json.is_some() {
                flags |= flag_bits::HAS_RAW_JSON;
            }
            if event.typed_payload.is_some() {
                flags |= flag_bits::HAS_TYPED_PAYLOAD_JSON;
            }
            if event.occurred_at_ms.is_some() {
                flags |= flag_bits::TIMESTAMP_VALID;
            }
            if event.raw_meta_recovery {
                flags |= flag_bits::RAW_META_RECOVERY;
            }
            if event.raw_meta_optimistic {
                flags |= flag_bits::RAW_META_OPTIMISTIC;
            }
            frame.extend_from_slice(&flags.to_le_bytes());
            frame.extend_from_slice(&event.client_generation.to_le_bytes());
            frame.extend_from_slice(&event.payload_version.to_le_bytes());
            for pair in refs {
                frame.extend_from_slice(&pair[0].to_le_bytes());
                frame.extend_from_slice(&pair[1].to_le_bytes());
            }
        }
        frame
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::test_support::{encode_frame, event, OWNER_KEY};
    use serde_json::json;

    fn owner_value() -> serde_json::Value {
        json!({ "profileId": "p1", "agentId": "peri", "localSessionId": "local:s1" })
    }

    #[test]
    fn normalize_produces_canonical_event_with_all_fields() {
        // 对齐 toolProjection.test.ts 的构造路径：tool_call 全字段保留。
        let raw = json!({
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "tc-1",
                "title": "Read",
                "kind": "read_file",
                "rawInput": { "path": "a.txt", "mode": "r" },
                "content": [{ "type": "text", "text": "preview" }],
            }
        });
        let normalized =
            normalize_raw_event_inner(&raw, &owner_value(), 7, 1, "2026-08-14T00:00:00.000Z")
                .expect("normalize");
        let event = normalized.event;
        assert_eq!(event["eventType"], "tool.call.started");
        assert_eq!(event["identity"]["toolCallId"], "tc-1");
        assert_eq!(event["typedPayload"]["tool"]["title"], "Read");
        assert_eq!(event["typedPayload"]["tool"]["rawInput"]["path"], "a.txt");
        assert_eq!(
            event["typedPayload"]["tool"]["contentBlocks"][0]["type"],
            "text"
        );
        assert_eq!(event["eventId"], r#"["p1","peri","local:s1"]#1"#);
        assert_eq!(event["occurredAt"], "2026-08-14T00:00:00.000Z");
        assert_eq!(event["receivedAt"], "2026-08-14T00:00:00.000Z");
        assert_eq!(event["payloadVersion"], 1);
        assert!(!normalized.malformed);
        assert_eq!(normalized.session_update.as_deref(), Some("tool_call"));
    }

    #[test]
    fn normalize_identity_aliases_follow_single_path() {
        // toolCallId 根优先；messageId content 优先；snake_case / toolUseId 别名。
        let root_wins = json!({
            "update": {
                "sessionUpdate": "tool_call",
                "toolCallId": "root-id",
                "content": { "type": "text", "text": "x", "tool_call_id": "content-id" },
            }
        });
        let normalized =
            normalize_raw_event_inner(&root_wins, &owner_value(), 1, 1, "2026-08-14T00:00:00.000Z")
                .expect("ok");
        assert_eq!(normalized.event["identity"]["toolCallId"], "root-id");

        let content_wins = json!({
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "messageId": "root-msg",
                "content": { "type": "text", "text": "x", "messageId": "content-msg" },
            }
        });
        let normalized = normalize_raw_event_inner(
            &content_wins,
            &owner_value(),
            1,
            2,
            "2026-08-14T00:00:00.000Z",
        )
        .expect("ok");
        assert_eq!(normalized.event["identity"]["messageId"], "content-msg");

        let tool_use_id = json!({
            "update": { "sessionUpdate": "tool_call", "_meta": { "toolUseId": "meta-id" } }
        });
        let normalized = normalize_raw_event_inner(
            &tool_use_id,
            &owner_value(),
            1,
            3,
            "2026-08-14T00:00:00.000Z",
        )
        .expect("ok");
        assert_eq!(normalized.event["identity"]["toolCallId"], "meta-id");
        // resolveToolCallId：工具 identity 唯一解析路径与归一结果一致。
        assert_eq!(
            resolve_tool_call_id(Some(normalized.update.as_ref().expect("update"))),
            Some("meta-id".to_string())
        );
    }

    #[test]
    fn normalize_error_cancelled_done_payloads() {
        let error = json!({ "update": { "sessionUpdate": "error", "message": "炸了" } });
        let normalized =
            normalize_raw_event_inner(&error, &owner_value(), 1, 1, "2026-08-14T00:00:00.000Z")
                .expect("ok");
        assert_eq!(normalized.event["eventType"], "turn.failed");
        assert_eq!(normalized.event["typedPayload"]["error"], "炸了");

        let cancelled = json!({ "update": { "sessionUpdate": "cancelled" } });
        let normalized =
            normalize_raw_event_inner(&cancelled, &owner_value(), 1, 2, "2026-08-14T00:00:00.000Z")
                .expect("ok");
        assert_eq!(normalized.event["eventType"], "turn.failed");
        assert_eq!(normalized.event["typedPayload"]["stopReason"], "cancelled");

        let done = json!({
            "update": { "sessionUpdate": "done", "stopReason": "end_turn", "usage": { "outputTokens": 3 } }
        });
        let normalized =
            normalize_raw_event_inner(&done, &owner_value(), 1, 3, "2026-08-14T00:00:00.000Z")
                .expect("ok");
        assert_eq!(normalized.event["eventType"], "turn.completed");
        assert_eq!(normalized.event["typedPayload"]["stopReason"], "end_turn");
        assert_eq!(normalized.event["typedPayload"]["usage"]["outputTokens"], 3);
        assert!(normalized.event["typedPayload"].get("model").is_none());
    }

    #[test]
    fn normalize_malformed_keeps_raw_and_warns() {
        let malformed = json!({ "nope": true });
        let normalized =
            normalize_raw_event_inner(&malformed, &owner_value(), 1, 1, "2026-08-14T00:00:00.000Z")
                .expect("ok");
        assert!(normalized.malformed);
        assert_eq!(normalized.event["eventType"], "unknown");
        assert_eq!(normalized.event["rawPayload"], malformed);
        assert_eq!(
            normalized.warning.as_deref(),
            Some("未找到可解析的 update envelope（raw 已保留）")
        );
    }

    #[test]
    fn normalize_empty_text_chunk_has_no_typed_payload() {
        // 空文本 chunk：textOf === undefined ⇒ 无 typedPayload（逐行投影 no-op）。
        let raw = json!({
            "update": { "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "" } }
        });
        let normalized =
            normalize_raw_event_inner(&raw, &owner_value(), 1, 1, "2026-08-14T00:00:00.000Z")
                .expect("ok");
        assert_eq!(normalized.event["eventType"], "assistant.text.delta");
        assert!(normalized.event.get("typedPayload").is_none());
    }

    #[test]
    fn parse_timestamp_supports_iso_subset() {
        assert_eq!(parse_timestamp("1970-01-01T00:00:00.000Z"), Some(0));
        // 偏移时区：UTC 时间要扣掉偏移。
        assert_eq!(parse_timestamp("1970-01-01T08:00:00+08:00"), Some(0));
        // date-only 按 UTC 零点（与 JS Date.parse 一致）。
        assert_eq!(parse_timestamp("1970-01-02"), Some(86_400_000));
        assert_eq!(parse_timestamp(""), None);
        assert_eq!(parse_timestamp("not-a-date"), None);
        assert_eq!(parse_timestamp("2026-13-01"), None);
        // 无偏移 date-time：按 UTC（已知缺口：JS 会按宿主本地时区解释）。
        assert_eq!(parse_timestamp("1970-01-01T00:00:00"), Some(0));
    }

    #[test]
    fn pretty_json_text_matches_json_stringify_indent_2() {
        // 键序与数字字面量都按输入文本直通——这正是从文本重排而不是从 Value
        // 再序列化的理由。
        let minified =
            r#"{"b":1,"a":{"x":1.0,"y":[1,2,{"z":null}]},"empty":{},"earr":[],"s":"a\nb"}"#;
        let pretty = pretty_json_text(minified).expect("pretty");
        let expected = "{\n  \"b\": 1,\n  \"a\": {\n    \"x\": 1.0,\n    \"y\": [\n      1,\n      2,\n      {\n        \"z\": null\n      }\n    ]\n  },\n  \"empty\": {},\n  \"earr\": [],\n  \"s\": \"a\\nb\"\n}";
        assert_eq!(pretty, expected);
        assert!(pretty_json_text("{bad}").is_err());
        assert_eq!(pretty_json_text("[]").expect("空数组"), "[]");
    }

    #[test]
    fn slice_utf16_counts_utf16_units() {
        // astral 字符占 2 个 UTF-16 码元：切点不得落在代理对内部。
        assert_eq!(slice_utf16("abcdef", 3), "abc");
        assert_eq!(slice_utf16("a😀b", 2), "a😀");
        assert_eq!(slice_utf16("a😀b", 1), "a");
        assert_eq!(slice_utf16("你好", 80), "你好");
    }

    #[test]
    fn decode_batch_round_trips_and_fails_closed() {
        let events = vec![event(CanonicalEventType::AssistantTextDelta, 1), {
            let mut event = event(CanonicalEventType::ToolCallStarted, 2);
            event.identity = Some(EventIdentity {
                tool_call_id: Some("tc-1".into()),
                ..Default::default()
            });
            event.tool = Some(ToolFields {
                title: Some("Read".into()),
                raw_input: Some(json!({ "path": "a.txt" })),
                raw_output_json: Some("\"内容\"".into()),
                ..Default::default()
            });
            event
        }];
        let frame = encode_frame(&events);
        let decoded = decode_batch(&frame).expect("decode");
        assert_eq!(decoded.len(), 2);
        assert_eq!(
            decoded[0].event_type,
            CanonicalEventType::AssistantTextDelta
        );
        assert_eq!(
            decoded[1]
                .identity
                .as_ref()
                .and_then(|identity| identity.tool_call_id.as_deref()),
            Some("tc-1")
        );
        assert_eq!(
            decoded[1]
                .tool
                .as_ref()
                .and_then(|tool| tool.raw_input.as_ref())
                .map(|raw| raw["path"].as_str()),
            Some(Some("a.txt"))
        );
        assert_eq!(
            decoded[1]
                .tool
                .as_ref()
                .and_then(|tool| tool.raw_output_json.as_deref()),
            Some("\"内容\"")
        );
        assert_eq!(decoded[0].owner_key, OWNER_KEY);
        assert_eq!(
            decoded[0].occurred_at_ms,
            parse_timestamp("2026-09-14T00:00:00.000Z")
        );

        // fail-closed：坏 magic / 截断帧 / 越界 typeIndex / 版本不符。
        let mut broken = frame.clone();
        broken[0] = b'X';
        assert!(decode_batch(&broken).is_err());
        let mut truncated = frame.clone();
        truncated.pop();
        assert!(decode_batch(&truncated).is_err());
        let events_start = HEADER_SIZE + read_u32(&frame[10..14]) as usize;
        let mut bad_type = frame.clone();
        for offset in 0..4 {
            bad_type[events_start + 16 + offset] = 0xFF;
        }
        assert!(decode_batch(&bad_type).is_err());
        let mut bad_version = frame;
        bad_version[4] = 9;
        assert!(decode_batch(&bad_version).is_err());
    }
}
