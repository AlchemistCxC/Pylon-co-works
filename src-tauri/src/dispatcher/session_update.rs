//! handle_session_update 的锁前解析与锁外收尾正身（#486 项3 拆出；行为不变）。
//!
//! 临界区（sessions 单一锁段）按拆分红线留在 [`super`]——锁序文档与锁内语句
//! 次序以 mod.rs 为权威档案位。本模块只承载两段无锁区：
//! - 锁前解析（payload Arc 化 → periId → binding 健康闸 → source 事件化解析 →
//!   代复核），所有丢弃路径统一映射 `None`（调用方 `return true` 保持主循环）；
//! - 锁外收尾（user echo → 持久化分派 → commit → 状态快照 → 感知应用 → 代复核
//!   → publish），`KeepPumping`/`EndGeneration` 精确映射原 true/false。

use super::*;

/// 锁前解析的产出：调用方据此进入临界区。
pub(super) struct ResolvedSessionUpdate {
    pub(super) payload: Arc<serde_json::Value>,
    pub(super) peri_id: String,
    pub(super) source: String,
}

/// 锁前解析（原 handle_session_update :144-233 逐字搬移）。
/// P2（#334）：payload 以 Arc 共享——routing::decide 在锁内需要完整 input，
/// 而 `update` 借用贯穿锁内 reducer 调用，深拷贝无法换成 move；改为引用计数
/// 共享后逐帧不再有 payload 级深拷贝（发布侧在 ingest 完成后取回唯一引用，
/// 消费顺序已核实：ingest 先于 publish）。
#[allow(clippy::too_many_arguments)]
pub(super) async fn resolve_session_update_target(
    sessions: &SessionsLock,
    binding_health: &std::sync::Mutex<
        std::collections::HashMap<String, crate::agent::runtime::SessionBindingHealth>,
    >,
    mapping_ready: &tokio::sync::Notify,
    client_generation: &AtomicU64,
    generation: u64,
    probe_sessions: &crate::runtime::ProbeSessionRegistry,
    payload: serde_json::Value,
) -> Option<ResolvedSessionUpdate> {
    let payload = Arc::new(payload);
    let peri_id = match payload.get("sessionId").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            tracing::warn!("ACP session/update missing sessionId");
            return None;
        }
    };
    let binding_blocked = match sessions.lock() {
        Ok(items) => items
            .iter()
            .find(|(_, session)| session.peri_id == peri_id)
            .is_some_and(|(source, _)| match binding_health.lock() {
                Ok(health) => matches!(
                    health.get(source),
                    Some(
                        crate::agent::runtime::SessionBindingHealth::Probing { .. }
                            | crate::agent::runtime::SessionBindingHealth::Detached { .. }
                    )
                ),
                Err(_) => true,
            }),
        Err(_) => true,
    };
    if binding_blocked {
        tracing::warn!(
            "ACP notification rejected while session binding is not attached: {}",
            peri_id
        );
        return None;
    }
    let source = {
        let mut mapped = None;
        let mut ambiguous = false;
        // R6：映射就绪事件化（吸收 O5）——20×5ms 轮询改为事件驱动：RPC 先于
        // 插映射，通知可先到，故仍在 100ms 窗口内等待；insert 成功后
        // mapping_ready.notify_waiters() 唤醒，deadline 兜底总等待 ≤100ms。
        // 唤醒可能来自其他会话的插映射（并发建会话），每次唤醒后复核，
        // 未命中且未超时则继续等——与原轮询语义等价（最坏仍 100ms 丢弃）。
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(100);
        loop {
            if let Ok(items) = sessions.lock() {
                let mappings = items
                    .iter()
                    .map(|(source, info)| (source, &info.peri_id, info.generation));
                mapped = source_for_peri_id_in_generation(mappings, &peri_id, generation);
                ambiguous = items
                    .values()
                    .filter(|info| info.peri_id == peri_id && info.generation == generation)
                    .count()
                    > 1;
            }
            if mapped.is_some() || ambiguous {
                break;
            }
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let _ = tokio::time::timeout(remaining, mapping_ready.notified()).await;
        }
        if ambiguous {
            tracing::warn!(
                "ACP notification rejected: periId {} maps to multiple local sources",
                peri_id
            );
            return None;
        }
        let Some(mapped) = mapped else {
            // #250：探测会话（#53 空态选择器探测）不落会话槽位，其建会话后的
            // 元数据通知按设计查无映射——按预期孤儿静默降级，不作异常告警。
            if probe_sessions.contains(&peri_id) {
                tracing::debug!("ACP notification for probe session {} dropped", peri_id);
                return None;
            }
            tracing::warn!("ACP notification for unknown session {}", peri_id);
            return None;
        };
        mapped.0
    };
    // source_for_peri_id_in_generation 已按代过滤（返回的映射
    // generation 必等于本 dispatcher 代），此处仅复核客户端未替换。
    if client_generation.load(Ordering::Acquire) != generation {
        tracing::warn!("ACP notification rejected for stale session {}", peri_id);
        return None;
    }
    Some(ResolvedSessionUpdate {
        payload,
        peri_id,
        source,
    })
}

/// 锁外收尾的出口：`KeepPumping` = 原 `return true`（主循环继续）；
/// `EndGeneration` = 原 `return false`（mutation 后本代已结束，主循环退出）。
pub(super) enum UpdateFinalizeOutcome {
    KeepPumping,
    EndGeneration,
}

/// 锁外收尾（原 handle_session_update :462-579 逐字搬移）。副作用次序不变：
/// user echo → user_chunk 闸 → batch/commit → set_session_state → 感知应用 →
/// 代际复核 → publish。
#[allow(clippy::too_many_arguments)]
pub(super) async fn finalize_session_update<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    gateway: &crate::gateway::GatewayCore,
    update_channels: &crate::runtime::UpdateChannelMap,
    reactions: &dyn KernelReactionSink,
    agent_id: &str,
    peri_id: &str,
    source: &str,
    event_service: Option<&Arc<crate::session::EventService>>,
    message_service: Option<&Arc<crate::session::MessageService>>,
    client_generation: &AtomicU64,
    generation: u64,
    pending_batch: Option<&mut Vec<PendingCanonicalPublish>>,
    routing_input: routing::RoutingInput,
    routing_decision: routing::RoutingDecision,
    pet_events: Vec<PetEvent>,
    session_state_to_persist: Option<(crate::session::DurableSessionOwner, serde_json::Value)>,
    is_user_chunk: bool,
    user_echo: Option<String>,
    payload: Arc<serde_json::Value>,
    wire: Option<Arc<crate::acp::AcpWireCapture>>,
) -> UpdateFinalizeOutcome {
    // 锁外副作用（原 :400-409 emit 本就在锁外；pet 感知 O7 锁外应用）
    if let Some(text) = user_echo {
        emit_event(
            window,
            crate::event_names::USER_ECHO,
            serde_json::json!({
                "source": source,
                "content": text,
                "replay": true,
            }),
        );
    }
    // Prompt user event 由 send_prompt_core 先行写入 journal；ACP user echo 不重复写。
    if is_user_chunk {
        return UpdateFinalizeOutcome::KeepPumping; // 原 :411 语义：user_message_chunk 不转发 emit_event_all
    }
    // D1/D7：Kernel routing 先完成 live canonical append，只有 committed result
    // 才允许继续进入 Channel/Gateway。平台 owner=None 与 replay 都明确跳过持久化。
    let input = routing_input;
    let decision = routing_decision;
    if decision.persist_canonical {
        if let Some(batch) = pending_batch {
            batch.push(PendingCanonicalPublish {
                input,
                decision,
                pet_events,
                session_state_to_persist,
                wire,
            });
            return UpdateFinalizeOutcome::KeepPumping;
        }
    }
    let committed_event = match routing::commit_live_event(&input, decision, event_service).await {
        routing::CommitOutcome::Skipped => None,
        routing::CommitOutcome::MissingService => {
            tracing::error!(
                code = "event_db_unavailable",
                agent_id,
                source,
                "canonical ingest unavailable after startup readiness barrier"
            );
            return UpdateFinalizeOutcome::KeepPumping;
        }
        routing::CommitOutcome::Committed { event, revision } => {
            if let (Some(ordinal), Some(wire)) = (input.wire_ordinal, wire.as_ref()) {
                wire.record_canonical_commit(
                    ordinal,
                    crate::acp::CanonicalCorrelation {
                        event_id: event.event_id.clone(),
                        sequence: event.sequence,
                        revision,
                    },
                );
            }
            Some(event)
        }
        routing::CommitOutcome::Rejected(error) => {
            log_canonical_ingest_error(&error, agent_id, source);
            return UpdateFinalizeOutcome::KeepPumping;
        }
    };
    if let (Some((owner, snapshot)), Some(message_service)) =
        (session_state_to_persist, message_service)
    {
        if let Err(error) = message_service
            .set_session_state(owner, Some(peri_id.to_string()), snapshot)
            .await
        {
            tracing::warn!(
                agent_id,
                source,
                error = %error,
                "ACP session state snapshot persistence failed"
            );
        }
    }
    // O7：感知事件锁外应用（原逐事件 `pet.lock()` 循环改经订阅缝，每事件一次
    // 锁获取 + 中毒吸收语义在 PetReactionSink 内逐位保留）。位置不变：commit →
    // set_session_state → 感知应用 → 代际复核 → publish。
    reactions.on_pet_events(pet_events);
    if client_generation.load(Ordering::Acquire) != generation {
        return UpdateFinalizeOutcome::EndGeneration; // 原 :437-439 语义：mutation 后本代已结束，主循环退出
    }
    if !decision.publish {
        return UpdateFinalizeOutcome::KeepPumping;
    }
    // P2（#334）：发布取回唯一引用。ingest 已完成（commit await 返回）且
    // `input` 不再被读取，drop 后 Arc 引用计数回到 1，`try_unwrap` 零拷贝
    // 取回原件注入 source/canonicalEvent；计数非 1 理论不可达，克隆兜底。
    drop(input);
    let mut payload = match Arc::try_unwrap(payload) {
        Ok(value) => value,
        Err(arc) => (*arc).clone(),
    };
    if let serde_json::Value::Object(ref mut map) = payload {
        map.insert(
            "source".to_string(),
            serde_json::Value::String(source.to_string()),
        );
        if let Some(committed_event) = committed_event {
            match serde_json::to_value(committed_event) {
                Ok(value) => {
                    map.insert("canonicalEvent".to_string(), value);
                }
                // #488 批⑤（审查修正措辞）：原先 unwrap_or(Null) 是**列值为 null**
                // 下发——前端 cursor 对 null 归一失败会整帧丢弃并报消费错误；本批
                // 改为**缺列**干净下发（前端按无 canonicalEvent 转发该帧）+ 后端
                // warn 诊断。这是 ⑤ 红线「字段集合逐字保持」的预期内例外（该失败
                // 分支当前不可达：CanonicalEventRow 全字段可序列化），已在 PR/issue
                // 显式声明。
                Err(error) => {
                    tracing::warn!(
                        source = %source,
                        %error,
                        "canonicalEvent 序列化失败，事件缺列下发"
                    );
                }
            }
        }
    }
    // C1：广播旧轨已拆除——SESSION_UPDATE 出站选路单点化于 publish_route.rs
    // （平台源广播红线/Channel 截胡防御注释随迁）；本调用点的 send 失败日志
    // 文案按现状保留（收口不做文案统一，见 publish_route 模块文档）。
    publish_route::publish_session_update(
        window,
        gateway,
        update_channels,
        source,
        payload,
        "channel update 帧发送失败",
    );
    UpdateFinalizeOutcome::KeepPumping
}
