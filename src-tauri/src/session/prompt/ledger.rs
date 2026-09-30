//! Prompt 域 · turn 账本（域 B）：#99 turn 终态结算、empty-turn 细分、cancel 判死探针。
//! W3 重构批次 S1 纯搬移自 session/prompt.rs（行为零变化）。

use super::*;

/// #99：turn 终态判定的 Unix 毫秒时间戳（账本/冷挂载快照用）。
pub(super) fn now_ms() -> u64 {
    crate::time::Timestamp::now().as_u64()
}

/// #99：把 ledger settle 结果落到诊断日志——`Published` 静默（正常收敛），
/// `Late`/`UnknownTurn` 告警（竞态被 CAS 拦截 / 未登记 turn）。
/// #420/ADR-0034：settle 即「本回合在途」事实的唯一收敛点（账本 active→terminal
/// 原子转移）——三条终态臂（Response / ConnectionClosed / CancelledAfterTimeout）
/// 都汇到这里；SessionInfo 不再有需要同步清理的镜像标记，旧代际迟到终态的
/// 让位语义由账本键控（TurnKey 含 generation）本身承担。
/// #442 Step3：返回 CAS 结果——`Published`（本调用赢得发布权）时由调用方广播
/// `pylon:turn-settled`（内核事实主轨）；Late/UnknownTurn 不广播（事实已由
/// 赢家发布/无从发布）。
pub(super) fn report_settle(
    runtime: &Arc<AgentRuntime>,
    turn_key: &crate::acp::TurnKey,
    cause: crate::acp::TurnTerminalCause,
    detail: Option<String>,
) -> crate::acp::SettleOutcome {
    let outcome = runtime
        .turn_ledger
        .settle(turn_key, cause, now_ms(), detail);
    match &outcome {
        crate::acp::SettleOutcome::Published => {}
        crate::acp::SettleOutcome::Late { existing } => tracing::warn!(
            turn_id = turn_key.turn_id,
            existing = existing.as_str(),
            "late terminal event rejected by turn ledger (CAS); diagnostic counter incremented"
        ),
        crate::acp::SettleOutcome::UnknownTurn => tracing::warn!(
            turn_id = turn_key.turn_id,
            "turn ledger settle hit an unregistered turn; lifecycle evidence lost"
        ),
    }
    outcome
}

/// #442 Step3：`pylon:turn-settled {source, turn}` 广播载荷（仅 CAS `Published`
/// 时产出——终态事实由 CAS 赢家**至多一次**发布；`Late`/`UnknownTurn` 返回 None）。
/// 独立成纯函数以便单测门控与载荷形状（window 发射是薄壳）。
pub(super) fn turn_settled_payload_if_published(
    runtime: &Arc<AgentRuntime>,
    source: &str,
    turn_key: &crate::acp::TurnKey,
    outcome: &crate::acp::SettleOutcome,
) -> Option<serde_json::Value> {
    if !matches!(outcome, crate::acp::SettleOutcome::Published) {
        return None;
    }
    let record = runtime.turn_ledger.snapshot(turn_key).or_else(|| {
        tracing::warn!(
            turn_id = turn_key.turn_id,
            "settled turn record missing at broadcast time; turn-settled suppressed"
        );
        None
    })?;
    let turn = serde_json::to_value(record).ok()?;
    Some(serde_json::json!({ "source": source, "turn": turn }))
}

/// #442 Step3：`pylon:turn-settled` 窗口发射薄壳——内核终态事实的收敛主轨。
/// 与 done/error 帧的双发（广播 + per-source Channel）不同，本事件**只**走窗口
/// 广播、与 Channel 注册生命周期无关（`stop_agent_runtime` 清注册后仍可投递，
/// 消灭「至多一次」投递模型的永久假在途）；done/error 帧自此退化为正文/usage
/// 载体，重复投递由 TurnClock 幂等吸收。window 缺省（平台 ingest）与 done/error
/// 同口径跳过。
pub(super) fn emit_turn_settled<R: tauri::Runtime>(
    window: Option<&tauri::Window<R>>,
    gateway: &GatewayCore,
    runtime: &Arc<AgentRuntime>,
    source: &str,
    turn_key: &crate::acp::TurnKey,
    outcome: &crate::acp::SettleOutcome,
) {
    let Some(payload) = turn_settled_payload_if_published(runtime, source, turn_key, outcome)
    else {
        return;
    };
    let Some(window) = window else {
        return;
    };
    emit_event_all(
        window,
        gateway,
        source,
        crate::event_names::TURN_SETTLED,
        payload,
    );
}

/// #99：empty-turn 细分——成功/MaxTurn 但无文本时推导细分原因
/// （tool-only / agent-empty），其余 cause 原样返回。
///
/// 判定源（评审 E3）：账本活动标志（dispatcher 在处理 chunk/工具调用的同一
/// 临界区写入）**或**会话 live 状态，两者取或。残余窗口：响应帧经
/// SentRequest 直达、可能先于仍在 inbox/spill 中的滞留 chunk 被结算——此时
/// 两路标志同为 false，空回合细分保守归类；terminal cause 本身不受影响
/// （终态仍是终态，UI 不会停在 prompting），journal 仍是内容权威。
pub(super) fn refine_empty_turn(
    runtime: &Arc<AgentRuntime>,
    turn_key: &crate::acp::TurnKey,
    cause: crate::acp::TurnTerminalCause,
) -> crate::acp::TurnTerminalCause {
    if !matches!(
        cause,
        crate::acp::TurnTerminalCause::Completed | crate::acp::TurnTerminalCause::MaxTurn
    ) {
        return cause;
    }
    let (ledger_text, ledger_tool, ledger_thinking) = runtime
        .turn_ledger
        .snapshot(turn_key)
        .map(|record| (record.saw_text, record.saw_tool, record.saw_thinking))
        .unwrap_or((false, false, false));
    let (saw_text, saw_tool) = match runtime.sessions.lock() {
        Ok(sessions) => match sessions.get(&turn_key.local_session_id) {
            Some(session) => (
                !session.last_response_text.trim().is_empty(),
                !session.acp_state.tools.is_empty(),
            ),
            None => (false, false),
        },
        Err(_) => (false, false),
    };
    let saw_text = ledger_text || saw_text;
    let saw_tool = ledger_tool || saw_tool;
    // #316：思考流只有账本侧证据（会话 live 态无对应投影），ledger_thinking
    // 单独透传——thinking-only 回合判有产出，不再误报 agent-empty。
    match crate::acp::empty_turn_cause(&cause, saw_text, saw_tool, ledger_thinking) {
        Some(empty) => crate::acp::TurnTerminalCause::EmptyTurn { cause: empty },
        None => cause,
    }
}

/// SDK outbound pump may surface a closed transport as a synthetic response
/// error string. It has the same recovery semantics as ConnectionClosed.
pub(super) fn is_closed_transport_response(raw: &acp::RawMessage) -> bool {
    raw.error.as_ref().and_then(serde_json::Value::as_str) == Some("ACP connection closed")
}

/// #99：从 prompt 响应帧结算 turn 终态（wire 权威，先于展示/持久化路径执行，
/// 保证 ensure_generation 等后续失败也不会让 turn 悬在账本外）。
/// #442 Step3：返回 CAS 结果供调用方广播 turn-settled。
pub(super) fn settle_turn_from_response(
    runtime: &Arc<AgentRuntime>,
    turn_key: &crate::acp::TurnKey,
    raw: &acp::RawMessage,
) -> crate::acp::SettleOutcome {
    let mut cause = if is_closed_transport_response(raw) {
        crate::acp::TurnTerminalCause::ConnectionLost
    } else if raw.error.is_some() {
        crate::acp::TurnTerminalCause::ProtocolError
    } else {
        let data = raw.result.clone().unwrap_or(serde_json::Value::Null);
        terminal_cause_from_prompt_result(&data)
    };
    cause = refine_empty_turn(runtime, turn_key, cause);
    let detail = raw.error.as_ref().map(|error| error.to_string());
    report_settle(runtime, turn_key, cause, detail)
}

/// #352：构造「用户 cancel 已发出」判死探针——只认 generation 一致的置位
/// （载体键化 generation，与账本 TurnKey 的代际隔离同纪律：客户端替换后
/// 旧代际的迟到置位不得把新代际等待循环拖进 cancel-settle 窗口）。锁形态按
/// dev-standards #331 例外二（into_inner）：标记是时间戳事实，中毒后仍自洽，
/// 就地恢复——判死输入不得因锁中毒静默消失。
pub(crate) fn cancel_requested_probe(
    runtime: Arc<AgentRuntime>,
    source: String,
    generation: u64,
) -> impl Fn() -> bool {
    move || {
        runtime
            .sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&source)
            .and_then(|session| session.cancel_requested)
            .is_some_and(|mark| mark.generation == generation)
    }
}
