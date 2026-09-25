//! Canonical 批次 flush 缝（#317 批次二 ④ 自 mod.rs 迁入）：窗口归属决策、
//! durable append + publish 的批处理出口，及循环内 4 个 flush 调用点共用的
//! 窗口 flush 包装。沿用 routing.rs 的「决策归模块、副作用适配归调用点」惯例。

use std::sync::atomic::Ordering;
use std::sync::Arc;

use super::{log_canonical_ingest_error, PetEvent, SessionsLock};
use crate::pet::PetState;

/// A live canonical update whose in-memory effects are already applied but
/// whose durable append and external publication are held until the current
/// dispatcher window is flushed. Keeping the routing input intact lets the
/// flush path preserve wire ordinal correlation and the original raw payload.
pub(crate) struct PendingCanonicalPublish {
    pub(crate) input: super::routing::RoutingInput,
    pub(crate) decision: super::routing::RoutingDecision,
    pub(crate) pet_events: Vec<PetEvent>,
    pub(crate) session_state_to_persist:
        Option<(crate::session::DurableSessionOwner, serde_json::Value)>,
    pub(crate) wire: Option<Arc<crate::acp::AcpWireCapture>>,
}

pub(crate) const MAX_PENDING_CANONICAL_EVENTS: usize = 32;
pub(crate) const PENDING_CANONICAL_FLUSH_INTERVAL: std::time::Duration =
    std::time::Duration::from_millis(8);

/// 批次窗口决策（原主循环内联段）：容量上限 / kind / replay / user_message_chunk
/// 边界 / session+owner 同质。满足任一 flush 条件即返回 true。
pub(crate) fn should_flush_batch(
    pending_batch: &[PendingCanonicalPublish],
    raw: &crate::acp::RawMessage,
    classification: &crate::acp::ReplayClassification,
    sessions: &SessionsLock,
    generation: u64,
    agent_id: &str,
) -> bool {
    // Keep a window owner-homogeneous. Control/request frames, replay
    // frames, terminal boundaries, and owner/session switches flush
    // before the next side effect is handled.
    let mut flush_batch = pending_batch.len() >= MAX_PENDING_CANONICAL_EVENTS
        || raw.kind != crate::acp::AcpKind::SessionUpdate
        || !matches!(classification, crate::acp::ReplayClassification::Live);
    if !flush_batch && raw.kind == crate::acp::AcpKind::SessionUpdate {
        flush_batch = raw
            .params
            .as_ref()
            .and_then(|params| params.get("update"))
            .and_then(|update| update.get("sessionUpdate"))
            .and_then(serde_json::Value::as_str)
            == Some("user_message_chunk");
    }
    if !flush_batch {
        let session_id = raw
            .params
            .as_ref()
            .and_then(|params| params.get("sessionId"))
            .and_then(serde_json::Value::as_str);
        // `first()` 与 `is_empty()` 互为镜像：None 即空批次，跳过同主
        // 比对即可（原 expect("non-empty pending batch has first item")）。
        if let Some(pending) = pending_batch.first() {
            flush_batch = session_id != Some(pending.input.remote_session_id.as_str());
            if !flush_batch {
                // 身份比较用 DurableSessionOwner 值（derive PartialEq，#331/P4）：
                // 原实现两侧各走一次 owner.key()（serde_json::to_string）——窗口内
                // 每帧两次序列化只为比一个三元组。#334 收尾：原 `durable_owner()`
                // 每帧构造三个 String + validate 只为值比较，改字段级借用比较
                // （expected 恒经 validate，三字段非空 ⇒ 字段全等即校验等价）。
                let current_owner_matches = session_id.and_then(|session_id| {
                    sessions.lock().ok().and_then(|items| {
                        items.iter().find_map(|(source, session)| {
                            if session.peri_id == session_id && session.generation == generation {
                                pending.input.owner.as_ref().map(|owner| {
                                    session.durable_owner_matches(agent_id, source, owner)
                                })
                            } else {
                                None
                            }
                        })
                    })
                });
                // None（查无会话/owner 缺失）一律按跨 owner 判 flush，与原
                // `current_owner != pending.input.owner` 的不等语义一致。
                // 等价性前提：批次条目仅在 decision.persist_canonical=true 时
                // 入队（routing.rs），该判定要求 owner.is_some()——即
                // expected=Some 恒成立。若未来放宽入队条件（允许 owner=None
                // 条目入批），此处「查无会话 → flush」与原「None == None → 不
                // flush」将出现可观察差异，须一并复审。
                flush_batch = !current_owner_matches.unwrap_or(false);
            }
        }
    }
    flush_batch
}

// 显式参数风格（window/gateway/update_channels/source/payload/committed_event
// 六参），与 flush 循环内逐参对应，结构体重构收益低。
fn publish_committed_update<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    gateway: &crate::gateway::GatewayCore,
    update_channels: &crate::runtime::UpdateChannelMap,
    source: &str,
    mut payload: serde_json::Value,
    committed_event: crate::session::CanonicalEventRow,
) {
    if let serde_json::Value::Object(ref mut map) = payload {
        map.insert(
            "source".to_string(),
            serde_json::Value::String(source.to_string()),
        );
        map.insert(
            "canonicalEvent".to_string(),
            serde_json::to_value(committed_event).unwrap_or(serde_json::Value::Null),
        );
    }
    let channel = if gateway.is_platform_source(source) {
        None
    } else {
        update_channels
            .lock()
            .ok()
            .and_then(|map| map.get(source).cloned())
    };
    if let Some(channel) = channel {
        let frame = serde_json::json!({
            "event": crate::event_names::SESSION_UPDATE,
            "payload": payload,
        });
        if let Err(error) = channel.send(frame) {
            tracing::warn!("channel update frame send failed source={source}: {error}");
        }
        return;
    }
    crate::emit_event_all(
        window,
        gateway,
        source,
        crate::event_names::SESSION_UPDATE,
        payload,
    );
}

/// #335/U1b：flush 的环境上下文收敛——dispatcher 主循环四个 flush 调用点共用的
/// 8 项服务/句柄引用（原逐参手抄 ×4，任何增删要同步 4 处；字段清单唯一处为
/// `NotificationPump::flush_context`，#336 起每次 flush 现场构造，取值时机与原
/// 「调用点逐参求值」逐点一致）。字段与原形参一一对应，锁语义/调用时序不变。
pub(crate) struct CanonicalFlushContext<'a, R: tauri::Runtime> {
    pub(crate) window: &'a tauri::Window<R>,
    pub(crate) gateway: &'a crate::gateway::GatewayCore,
    pub(crate) update_channels: &'a crate::runtime::UpdateChannelMap,
    pub(crate) pet: &'a std::sync::Mutex<PetState>,
    pub(crate) client_generation: &'a std::sync::atomic::AtomicU64,
    pub(crate) agent_id: &'a str,
    pub(crate) event_service: Option<&'a Arc<crate::session::EventService>>,
    pub(crate) message_service: Option<&'a Arc<crate::session::MessageService>>,
}

pub(crate) async fn flush_pending_canonical<R: tauri::Runtime>(
    context: &CanonicalFlushContext<'_, R>,
    pending: Vec<PendingCanonicalPublish>,
) -> bool {
    let CanonicalFlushContext {
        window,
        gateway,
        update_channels,
        pet,
        client_generation,
        agent_id,
        event_service,
        message_service,
    } = *context;
    if pending.is_empty() {
        return true;
    }
    let first = &pending[0];
    // 不变量：本函数只消费 persist_canonical=true 的批次，而 routing::decide 的
    // 该判定要求 owner.is_some()（routing.rs）。此保证未经类型系统携带、理论可
    // 违约 ⇒ 走可观测错误路径而非 panic（原 expect("persisted batch has owner")）。
    let Some(owner) = first.input.owner.clone() else {
        tracing::error!(
            code = "event_batch_owner_missing",
            agent_id,
            source = %first.input.source,
            "persisted batch entry reached flush without a durable owner"
        );
        return true;
    };
    let owner_key = owner.key().ok();
    let generation = first.input.generation;
    if pending.iter().any(|item| {
        item.input.owner.as_ref().and_then(|owner| owner.key().ok()) != owner_key
            || item.input.remote_session_id != first.input.remote_session_id
            || item.input.generation != generation
    }) {
        tracing::error!(
            code = "event_batch_owner_mismatch",
            agent_id,
            source = %first.input.source,
            "dispatcher batch crossed owner, remote session, or generation"
        );
        return true;
    }
    let remote_session_id = Some(first.input.remote_session_id.clone());
    // P2（#334）：Arc 引用计数共享进 ingest（原整份 payload 批次深拷贝拆除）；
    // 发布侧稍后对每项 `Arc::try_unwrap` 取回唯一引用。
    let raw_payloads = pending
        .iter()
        .map(|item| Arc::clone(&item.input.payload))
        .collect::<Vec<_>>();
    let Some(event_service) = event_service else {
        tracing::error!(
            code = "event_db_unavailable",
            agent_id,
            source = %first.input.source,
            "canonical ingest unavailable after startup readiness barrier"
        );
        return true;
    };
    let append = match event_service
        .ingest_events(owner, remote_session_id, generation, raw_payloads)
        .await
    {
        Ok(result) => result,
        Err(error) => {
            log_canonical_ingest_error(&error, agent_id, &first.input.source);
            return true;
        }
    };
    // ADR-0016：内核写侧把相邻同类 delta 折成一条 `*.delta.batch` 行（span 占位），结果行数
    // 可以少于本窗口输入数。配对按**跨度宽度**展开——span 内每个 wire 帧都记在承载它的那一行上
    // （这正是 durable 事实：这些帧就存在这一行里）。
    let mut canonical_events = append
        .events
        .into_iter()
        .filter(|event| event.event_type != "turn.unit")
        .flat_map(|event| {
            let width = crate::session::row_input_span_width(&event);
            std::iter::repeat_n(event, width)
        });
    for item in pending {
        let Some(event) = canonical_events.next() else {
            tracing::error!(
                code = "event_batch_result_mismatch",
                agent_id,
                source = %item.input.source,
                "canonical batch returned fewer input rows than requested"
            );
            return true;
        };
        if let (Some(ordinal), Some(wire)) = (item.input.wire_ordinal, item.wire.as_ref()) {
            wire.record_canonical_commit(
                ordinal,
                crate::acp::CanonicalCorrelation {
                    event_id: event.event_id.clone(),
                    sequence: event.sequence,
                    revision: append.revision,
                },
            );
        }
        if let (Some((owner, snapshot)), Some(message_service)) =
            (item.session_state_to_persist, message_service)
        {
            if let Err(error) = message_service
                .set_session_state(owner, Some(item.input.remote_session_id.clone()), snapshot)
                .await
            {
                tracing::warn!(
                    agent_id,
                    source = %item.input.source,
                    error = %error,
                    "ACP session state snapshot persistence failed"
                );
            }
        }
        for pet_event in item.pet_events {
            let _ = pet.lock().map(|mut state| pet_event.apply(&mut state));
        }
        if client_generation.load(Ordering::Acquire) != item.input.generation {
            return false;
        }
        if item.decision.publish {
            // P2（#334）：ingest 已完成（共享 Arc 已随 ingest 调用结束释放），
            // 计数回到 1，`try_unwrap` 零拷贝取回原件；计数非 1 理论不可达，
            // 克隆兜底保正确。
            let payload = match Arc::try_unwrap(item.input.payload) {
                Ok(value) => value,
                Err(arc) => (*arc).clone(),
            };
            publish_committed_update(
                window,
                gateway,
                update_channels,
                &item.input.source,
                payload,
                event,
            );
        }
    }
    true
}

// 审查修正（#317 批次二 review）：曾有的 flush_canonical_window 纯透传包装
// 已删除——调用点直接使用正身 flush_pending_canonical（dev-standards：
// 无独立职责的单行代理不算模块化）。
