//! #423 InteractionLedger —— 审批线三 store 的单一登记面。
//!
//! 现状（本模块引入前）：同一审批请求写 2-3 处——`pending_permissions`
//! （permission 域）+ `private_interactions`（私有桥域）+ `InteractionQueue`
//! （pylon-acp）——一致性靠手工同步，#98 P2-1 的「队列与 store 失配」补丁
//! 证明这是结构性风险。本模块把 admit / settle / restore / 超时 drain / 断开
//! 清理收口为单点方法：**写路径只允许经 Ledger**（store 增删与 queue 登记在
//! 同一方法内完成），读路径经受限访问器。deadline 归队列权威（admit 时注入
//! `deadline_ms`，超时判定经 `drain_expired` 的严格 `now > deadline` 边界）。
//!
//! 三份 admit 事件的现存 json 差异（#416 复核钉死，逐字段保留）：
//! 1. permission admit：`eventType:"permission.request"` + 顶层 `toolCallId` +
//!    payload 内 `deadlineMs`（dispatcher 正身形状）；
//! 2. 私有桥 admit：`eventType` 三变体（approval.request / elicitation.request /
//!    ask-user）+ payload = 原始 params（#423 显式迁移：问题桥把 minted
//!    `questions[i].id` 回写进事件 payload——wire 快照收敛后 CLI/GUI 应答
//!    values 的 key 唯一来源）；
//! 3. permission restore（发送失败回灌）：provider/agentId 置空串（#98 P2-1
//!    语义：store 不持有 provider，事件消费方不依赖该字段做归属）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::acp::interaction_queue::{
    AdmissionOutcome, InteractionEntryState, InteractionQueue, InteractionQueueEntry,
    InteractionTerminalReason,
};
use crate::acp::RequestId;
use crate::permission::{canonical_pending_key, permission_deadline_ms, PendingPermission};
use crate::private_interaction::{PendingPrivateInteraction, PrivateInteractionOwner};
use crate::protocol_adapter::private_ext::PrivateBridge;
#[cfg(test)]
use crate::time::Timestamp;

type PermissionStore = Arc<Mutex<HashMap<RequestId, PendingPermission>>>;

/// 审批线单一登记面：queue（排序与生命周期）+ 两 store（应答载荷）。
/// Clone 共享同一底层（挂 `AgentRuntime` 上随 runtime 克隆）。
#[derive(Clone, Default)]
pub(crate) struct InteractionLedger {
    queue: InteractionQueue,
    permissions: PermissionStore,
    private: PrivateInteractionOwner,
}

impl InteractionLedger {
    // ── 只读访问器（测试 / 快照 / 豁免检查用；写路径必须走下方单点方法）──

    pub(crate) fn queue(&self) -> &InteractionQueue {
        &self.queue
    }

    pub(crate) fn permissions(&self) -> &PermissionStore {
        &self.permissions
    }

    pub(crate) fn private(&self) -> &PrivateInteractionOwner {
        &self.private
    }

    /// 只读按 canonical 键查挂起权限请求（双向形态回退；应答身份复核 /
    /// 超时 sweep 取 options 用，不消费条目）。
    pub(crate) fn pending_permission(
        &self,
        candidate: &RequestId,
    ) -> Option<(RequestId, PendingPermission)> {
        let pending = self.permissions.lock().ok()?;
        let canonical = canonical_pending_key(&pending, candidate)?;
        let permission = pending.get(&canonical).cloned()?;
        Some((canonical, permission))
    }

    /// claim（原子移除）挂起权限请求：canonical 键 + 锁内复核谓词 + remove
    /// ——谓词在 permissions 锁内对现行条目求值，通过才移除（TOCTOU 单临界
    /// 区）。`resolve_pending` 锁内复核段的单点实现（调用方仍在 acp 锁内
    /// 调用，本方法只碰 permissions 锁，不新增锁序）。
    pub(crate) fn claim_permission(
        &self,
        candidate: &RequestId,
        check: impl Fn(&PendingPermission) -> bool,
    ) -> Option<(RequestId, PendingPermission)> {
        let mut pending = self.permissions.lock().ok()?;
        let canonical = canonical_pending_key(&pending, candidate)?;
        let permission = pending.get(&canonical)?;
        if !check(permission) {
            return None;
        }
        let claimed = pending.remove(&canonical)?;
        Some((canonical, claimed))
    }

    /// claim（原子移除）挂起私有交互——take() 抢先语义（用户应答与超时
    /// sweep 竞态的裁决保持：先 take 者收口）。
    pub(crate) fn take_private(&self, id: &RequestId) -> Option<PendingPrivateInteraction> {
        self.private.take(id).ok().flatten()
    }

    // ── admit（单点：store 写 + queue 登记 + 事件 json 构造）──

    /// 权限请求登记（admit json 差异 1）。返回 (入队结果, 事件 json)——
    /// 事件由调用方 emit（与 live 事件同一份）。
    pub(crate) fn admit_permission(
        &self,
        provider: &str,
        agent_id: &str,
        request_id: &RequestId,
        permission: &PendingPermission,
    ) -> Result<(AdmissionOutcome, serde_json::Value), String> {
        let deadline = permission_deadline_ms(permission.requested_at);
        let event = serde_json::json!({
            "provider": provider,
            "agentId": agent_id,
            "sessionId": permission.session_id,
            "eventType": "permission.request",
            "requestId": request_id.to_string(),
            "toolCallId": permission.tool_call_id,
            "clientGeneration": permission.client_generation,
            "payload": {
                "title": permission.title,
                "prompt": permission.prompt,
                "options": permission.options,
                "requestedAt": permission.requested_at,
                // ACP-03（§5.6）：deadline 由后端单一来源给出，前端只做倒计时展示。
                "deadlineMs": deadline,
            },
        });
        self.permissions
            .lock()
            .map_err(|error| error.to_string())?
            .insert(request_id.clone(), permission.clone());
        let outcome = self.queue.admit(InteractionQueueEntry {
            request_id: request_id.to_string(),
            method: crate::acp::METHOD_SESSION_REQUEST_PERMISSION.to_string(),
            kind: "approval".to_string(),
            session_id: permission.session_id.clone(),
            agent_id: agent_id.to_string(),
            client_generation: permission.client_generation,
            enqueued_at: permission.requested_at,
            // #356：deadline admit 时注入（与事件 payload 内 deadlineMs 同源同值）。
            deadline_ms: Some(deadline),
            event: event.clone(),
            state: InteractionEntryState::Waiting,
        })?;
        Ok((outcome, event))
    }

    /// 私有桥交互登记（admit json 差异 2 + specs id 回写）。返回
    /// (入队结果, 事件 json)——事件由调用方 emit。
    pub(crate) fn admit_private(
        &self,
        provider: &str,
        agent_id: &str,
        request_id: &RequestId,
        pending: &PendingPrivateInteraction,
        method: &str,
    ) -> Result<(AdmissionOutcome, serde_json::Value), String> {
        let event = private_interaction_event(provider, agent_id, request_id, pending);
        let kind = pending.queue_kind().to_string();
        let session_id = pending.session_id.clone();
        let client_generation = pending.client_generation;
        let enqueued_at = pending.enqueued_at;
        // #356：私有交互对等参与超时结算——deadline 与权限请求同源同值。
        let deadline_ms = Some(permission_deadline_ms(enqueued_at));
        self.private.insert(request_id.clone(), pending.clone())?;
        let outcome = self.queue.admit(InteractionQueueEntry {
            request_id: request_id.to_string(),
            method: method.to_string(),
            kind,
            session_id,
            agent_id: agent_id.to_string(),
            client_generation,
            enqueued_at,
            deadline_ms,
            event: event.clone(),
            state: InteractionEntryState::Waiting,
        })?;
        Ok((outcome, event))
    }

    // ── restore（发送失败回灌单点；#98 P2-1 队列随动）──

    /// 权限请求应答发送失败后恢复（admit json 差异 3：provider/agentId 置空
    /// 串——restore 路径不可得，事件消费方不依赖该字段做归属）。同 id 已有
    /// 更新条目时保留更新条目（不覆盖新请求）。
    pub(crate) fn restore_permission(&self, request_id: &RequestId, permission: PendingPermission) {
        let inserted = self
            .permissions
            .lock()
            .map(|mut pending| {
                pending
                    .insert(request_id.clone(), permission.clone())
                    .is_none()
            })
            .unwrap_or(false);
        if !inserted {
            return;
        }
        let deadline = permission_deadline_ms(permission.requested_at);
        let event = serde_json::json!({
            "provider": "",
            "agentId": "",
            "sessionId": permission.session_id,
            "eventType": "permission.request",
            "requestId": request_id.to_string(),
            "toolCallId": permission.tool_call_id,
            "clientGeneration": permission.client_generation,
            "payload": {
                "title": permission.title,
                "prompt": permission.prompt,
                "options": permission.options,
                "requestedAt": permission.requested_at,
                "deadlineMs": deadline,
            },
        });
        let _ = self.queue.admit(InteractionQueueEntry {
            request_id: request_id.to_string(),
            method: crate::acp::METHOD_SESSION_REQUEST_PERMISSION.to_string(),
            kind: "approval".to_string(),
            session_id: permission.session_id,
            agent_id: String::new(),
            client_generation: permission.client_generation,
            enqueued_at: permission.requested_at,
            deadline_ms: Some(deadline),
            event,
            state: InteractionEntryState::Waiting,
        });
    }

    /// 私有交互发送失败后恢复（store 回插 + queue 回灌——deadline 已过线的
    /// 条目下轮 watcher 重试；超时/应答失败路径共用）。
    pub(crate) fn restore_private(
        &self,
        request_id: &RequestId,
        pending: PendingPrivateInteraction,
    ) {
        let inserted = self
            .private
            .insert(request_id.clone(), pending.clone())
            .map(|_| true)
            .unwrap_or(false);
        if !inserted {
            return;
        }
        let event = private_interaction_event("", "", request_id, &pending);
        let _ = self.queue.admit(InteractionQueueEntry {
            request_id: request_id.to_string(),
            method: pending.method.clone(),
            kind: pending.queue_kind().to_string(),
            session_id: pending.session_id.clone(),
            agent_id: pending.agent_id.clone(),
            client_generation: pending.client_generation,
            enqueued_at: pending.enqueued_at,
            deadline_ms: Some(permission_deadline_ms(pending.enqueued_at)),
            event,
            state: InteractionEntryState::Waiting,
        });
    }

    // ── settle / drain（queue 终态单点）──

    /// 终结一条 waiter 并晋升下一个（应答/取消/超时/拒绝）。
    pub(crate) fn settle(
        &self,
        request_id: &str,
        reason: InteractionTerminalReason,
    ) -> Result<Option<InteractionQueueEntry>, String> {
        self.queue.settle(request_id, reason)
    }

    /// 按会话批量终结（session close/expiry 的 drain 覆盖全部 waiter——
    /// 非 approval 条目不经 resolve_pending，须在此终结防悬挂）。
    pub(crate) fn drain_where_session(
        &self,
        session_id: &str,
        reason: InteractionTerminalReason,
    ) -> Result<Vec<InteractionQueueEntry>, String> {
        self.queue
            .drain_where(|entry| entry.session_id == session_id, reason)
    }

    /// 超时 drain（deadline 归队列权威）：终结所有 `now_ms > deadline_ms`
    /// 的条目（严格大于边界，与宿主原 sweep `elapsed > 300_000ms` 判据逐 ms
    /// 等价）。watcher 轮询粒度（5s）由调用方保持。
    pub(crate) fn drain_expired(
        &self,
        now_ms: u64,
        reason: InteractionTerminalReason,
    ) -> Result<Vec<InteractionQueueEntry>, String> {
        self.queue.drain_expired(now_ms, reason)
    }

    /// 全量断开清理（dead runtime 与客户端替换共用单点）：pending_permissions
    /// 清空 + private_interactions 撤销 + queue Disconnected 全量 drain。
    /// 返回 (权限清空数, 私有清空数, 被 drain 的 queue 条目)——调用方据此
    /// 告警（场景文案自定）与广播终态事件。清理幂等（先到者清空，后到者空转）。
    pub(crate) fn drain_disconnected(&self) -> (usize, usize, Vec<InteractionQueueEntry>) {
        let dropped_permissions = self
            .permissions
            .lock()
            .map(|mut pending| {
                let dropped = pending.len();
                pending.clear();
                dropped
            })
            .unwrap_or(0);
        let stale_private = self.private.snapshot().len();
        self.private.cancel_all();
        let drained = self
            .queue
            .drain(InteractionTerminalReason::Disconnected)
            .unwrap_or_default();
        (dropped_permissions, stale_private, drained)
    }
}

/// 私有桥交互的事件 json（admit 差异 2：eventType 三变体 + payload 原文）。
/// #423 显式迁移：问题桥（GrokExtQuestions/PiSelectAsk）把 minted
/// `questions[i].id` 回写进事件 payload——wire 快照收敛后 CLI/GUI 应答
/// values 的 key（`question-N`，运行时原子计数铸造、不可从 params 重建）
/// 唯一来源。store 侧 `params` 保持原文（应答构造走 question_specs）。
fn private_interaction_event(
    provider: &str,
    agent_id: &str,
    request_id: &RequestId,
    pending: &PendingPrivateInteraction,
) -> serde_json::Value {
    let event_type = match pending.bridge {
        PrivateBridge::GrokExitPlan => "approval.request",
        PrivateBridge::Elicitation => "elicitation.request",
        PrivateBridge::GrokExtQuestions | PrivateBridge::PiSelectAsk => "ask-user",
    };
    let mut payload = pending.params.clone();
    if let Some(specs) = pending.question_specs.as_deref() {
        if let Some(questions) = payload.get_mut("questions").and_then(|q| q.as_array_mut()) {
            for (question, spec) in questions.iter_mut().zip(specs) {
                if let Some(question) = question.as_object_mut() {
                    question.insert("id".to_string(), serde_json::json!(spec.id));
                }
            }
        }
    }
    serde_json::json!({
        "provider": provider,
        "agentId": agent_id,
        "sessionId": pending.session_id,
        "eventType": event_type,
        "requestId": request_id.to_string(),
        "clientGeneration": pending.client_generation,
        "payload": payload,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn permission() -> PendingPermission {
        crate::permission::parse_permission_request_with_generation(
            Some(&serde_json::json!({
                "sessionId": "s1",
                "toolCall": {"toolCallId": "call-1", "title": "tool"},
                "options": [{"optionId": "allow_once"}, {"optionId": "reject_once"}]
            })),
            2,
        )
        .expect("合法请求必须解析")
    }

    fn private_pending(bridge: PrivateBridge, method: &str) -> PendingPrivateInteraction {
        PendingPrivateInteraction {
            provider: "peri".into(),
            agent_id: "a1".into(),
            session_id: "s1".into(),
            method: method.into(),
            bridge,
            params: serde_json::json!({"sessionId": "s1"}),
            question_specs: None,
            client_generation: 1,
            enqueued_at: Timestamp::now(),
        }
    }

    /// #423 登记面单点：admit_permission 一次完成 store 写 + queue 登记 +
    /// 事件构造（差异 1：eventType=permission.request + toolCallId + payload
    /// 内 deadlineMs 同源同值）。
    #[test]
    fn admit_permission_writes_store_queue_and_event_together() {
        let ledger = InteractionLedger::default();
        let request_id = RequestId::Number(7);
        let permission = permission();
        let (outcome, event) = ledger
            .admit_permission("peri", "a1", &request_id, &permission)
            .expect("admit 必须成功");
        assert_eq!(outcome, AdmissionOutcome::Promoted);
        assert!(ledger
            .permissions()
            .lock()
            .unwrap()
            .contains_key(&request_id));
        assert_eq!(ledger.queue().snapshot().unwrap().len(), 1);
        assert_eq!(event["eventType"], "permission.request");
        assert_eq!(event["toolCallId"], "call-1");
        let deadline = event["payload"]["deadlineMs"].as_u64().unwrap();
        assert_eq!(deadline, permission_deadline_ms(permission.requested_at));
        // queue 条目 deadline 与事件 payload 同源同值（#356）。
        assert_eq!(
            ledger.queue().snapshot().unwrap()[0].deadline_ms,
            Some(deadline)
        );
    }

    /// 差异 2：私有桥事件 eventType 三变体 + payload 原文；问题桥 specs id
    /// 回写进事件 payload（store params 保持原文）。
    #[test]
    fn admit_private_event_type_variants_and_spec_id_injection() {
        let ledger = InteractionLedger::default();
        let elicitation = private_pending(PrivateBridge::Elicitation, "elicitation/create");
        let (_, event) = ledger
            .admit_private(
                "peri",
                "a1",
                &RequestId::Number(1),
                &elicitation,
                "elicitation/create",
            )
            .unwrap();
        assert_eq!(event["eventType"], "elicitation.request");
        assert_eq!(event["payload"]["sessionId"], "s1");

        let exit_plan = private_pending(PrivateBridge::GrokExitPlan, "_x.ai/exit_plan_mode");
        let (_, event) = ledger
            .admit_private(
                "peri",
                "a1",
                &RequestId::Number(2),
                &exit_plan,
                "_x.ai/exit_plan_mode",
            )
            .unwrap();
        assert_eq!(event["eventType"], "approval.request");

        let mut question =
            private_pending(PrivateBridge::GrokExtQuestions, "_x.ai/ask_user_question");
        question.params = serde_json::json!({
            "sessionId": "s1",
            "questions": [{"question": "Pick", "header": "Choice", "options": [{"label": "A"}, {"label": "B"}]}]
        });
        question.question_specs =
            Some(crate::acp::question_policy::parse_questions(&question.params).unwrap());
        let (_, event) = ledger
            .admit_private(
                "peri",
                "a1",
                &RequestId::Number(3),
                &question,
                "_x.ai/ask_user_question",
            )
            .unwrap();
        assert_eq!(event["eventType"], "ask-user");
        // minted id 回写进事件 payload（应答 key 唯一来源），store 原文不动。
        assert_eq!(
            event["payload"]["questions"][0]["id"],
            question.question_specs.as_deref().unwrap()[0].id
        );
        assert!(question.params["questions"][0].get("id").is_none());
    }

    /// 差异 3：restore_permission 的 provider/agentId 置空串 + queue 回灌
    /// （#98 P2-1）；同 id 已有更新条目时保留更新条目。
    #[test]
    fn restore_permission_requeues_with_empty_identity() {
        let ledger = InteractionLedger::default();
        let request_id = RequestId::Number(7);
        let _ = ledger
            .admit_permission("peri", "a1", &request_id, &permission())
            .unwrap();
        let (canonical, claimed) = ledger
            .claim_permission(&request_id, |_| true)
            .expect("claim 必须命中");
        assert_eq!(canonical, request_id);
        ledger.restore_permission(&request_id, claimed);
        let snapshot = ledger.queue().snapshot().unwrap();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].event["provider"], "");
        assert_eq!(snapshot[0].event["agentId"], "");
        assert_eq!(snapshot[0].event["eventType"], "permission.request");
        assert_eq!(snapshot[0].event["toolCallId"], "call-1");
        // 同 id 已有新条目时 restore 不覆盖（保留新请求）。
        let fresh = permission();
        let _ = ledger
            .admit_permission("peri", "a1", &request_id, &fresh)
            .unwrap();
        ledger.restore_permission(&request_id, fresh);
        assert_eq!(ledger.queue().snapshot().unwrap().len(), 1);
    }

    /// restore_private：store 回插 + queue 回灌（deadline 已过线条目下轮
    /// drain_expired 重试）。
    #[test]
    fn restore_private_requeues_for_retry() {
        let ledger = InteractionLedger::default();
        let request_id = RequestId::Number(9);
        let mut pending = private_pending(PrivateBridge::Elicitation, "elicitation/create");
        // deadline 已过线：restore 后 drain_expired 立即可再命中（重试语义）。
        pending.enqueued_at = Timestamp::new(Timestamp::now().as_u64().saturating_sub(301_000));
        let _ = ledger
            .admit_private("peri", "a1", &request_id, &pending, "elicitation/create")
            .unwrap();
        // sweep 序：drain_expired 先行（deadline 权威判定，queue 移除），
        // 随后 take claim——与生产 sweep_interaction_timeouts 一致。
        let drained = ledger
            .drain_expired(
                Timestamp::now().as_u64(),
                InteractionTerminalReason::TimedOut,
            )
            .unwrap();
        assert_eq!(drained.len(), 1, "deadline 过线条目被 sweep 判定终结");
        let claimed = ledger.take_private(&request_id).expect("take 必须命中");
        ledger.restore_private(&request_id, claimed);
        assert!(ledger.private().get(&request_id).unwrap().is_some());
        let drained = ledger
            .drain_expired(
                Timestamp::now().as_u64(),
                InteractionTerminalReason::TimedOut,
            )
            .unwrap();
        assert_eq!(drained.len(), 1, "回灌条目下轮超时重试可再命中");
    }

    /// drain_disconnected：三 store 全清 + 返回计数与 drained 条目（幂等）。
    #[test]
    fn drain_disconnected_clears_all_three_stores() {
        let ledger = InteractionLedger::default();
        let _ = ledger
            .admit_permission("peri", "a1", &RequestId::Number(7), &permission())
            .unwrap();
        let _ = ledger
            .admit_private(
                "peri",
                "a1",
                &RequestId::Number(8),
                &private_pending(PrivateBridge::Elicitation, "elicitation/create"),
                "elicitation/create",
            )
            .unwrap();
        let (dropped, stale, drained) = ledger.drain_disconnected();
        assert_eq!((dropped, stale, drained.len()), (1, 1, 2));
        assert!(drained.iter().all(|entry| matches!(
            entry.state,
            InteractionEntryState::Terminal(InteractionTerminalReason::Disconnected)
        )));
        assert!(ledger.permissions().lock().unwrap().is_empty());
        assert!(ledger.private().snapshot().is_empty());
        assert!(ledger.queue().snapshot().unwrap().is_empty());
        // 幂等：二次调用空转。
        assert_eq!(ledger.drain_disconnected(), (0, 0, Vec::new()));
    }

    /// pending_permission / claim_permission 的 canonical 双向回退。
    #[test]
    fn permission_lookup_crosses_number_string_forms() {
        let ledger = InteractionLedger::default();
        let _ = ledger
            .admit_permission("peri", "a1", &RequestId::String("7".into()), &permission())
            .unwrap();
        let (canonical, _) = ledger
            .pending_permission(&RequestId::Number(7))
            .expect("Number 候选必须回退命中 String 条目");
        assert_eq!(canonical, RequestId::String("7".into()));
        let claimed = ledger.claim_permission(&RequestId::Number(7), |_| true);
        assert!(claimed.is_some());
        assert!(ledger
            .claim_permission(&RequestId::Number(7), |_| true)
            .is_none());
    }

    /// claim 的复核谓词在锁内对现行条目求值：不通过不移除（单临界区）。
    #[test]
    fn claim_permission_check_rejects_in_critical_section() {
        let ledger = InteractionLedger::default();
        let request_id = RequestId::Number(7);
        let _ = ledger
            .admit_permission("peri", "a1", &request_id, &permission())
            .unwrap();
        assert!(
            ledger
                .claim_permission(&request_id, |p| p.client_generation == 99)
                .is_none(),
            "复核不通过不得移除条目"
        );
        assert!(ledger.pending_permission(&request_id).is_some());
        assert!(ledger
            .claim_permission(&request_id, |p| p.client_generation == 2)
            .is_some());
    }
}
