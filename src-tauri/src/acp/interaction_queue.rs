//! #98：统一 Agent→Pylon 阻塞式 client request 交互队列。
//!
//! permission / elicitation / question 等所有阻塞 agent 的请求都登记在此：
//! 唯一 request id、FIFO 排序、单一 Active（与前端单张可见卡对应）、实时
//! queued depth，且 cancel / timeout / disconnect / generation 变化都会 drain
//! 并给每个 waiter 一个终态——后端不能因为 UI 只显示一张卡就只保留一个
//! pending slot（spec §6 Interaction queue）。
//!
//! 职责边界：本模块只管理**排序与生命周期**（谁 active、谁在等、怎么终结），
//! 不持有 wire responder（应答仍走 `AcpClient::responder()` 与既有 pending
//! store），不解析协议载荷。注册表按 request id 去重（同 id 重复到达以新
//! 记录替换，保留 FIFO 位置），drain 后整队清空。

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use crate::time::Timestamp;

/// 入队条目的生命周期状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InteractionEntryState {
    /// 队首、当前可见/应答中（与前端单张 active 卡对应）。
    Active,
    /// FIFO 等待中。
    Waiting,
    /// 已终结（终态原因见 [`InteractionTerminalReason`]）。
    Terminal(InteractionTerminalReason),
}

/// waiter 终态：drain 语义要求每个 waiter 都拿到确定终态，不悬空。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InteractionTerminalReason {
    /// 用户已应答。
    Answered,
    /// 用户/宿主取消。
    Cancelled,
    /// 超时（后端单一来源的 deadline 判定）。
    TimedOut,
    /// 客户端替换/断线 drain（旧进程请求随连接失效）。
    Disconnected,
    /// generation 前进导致旧连接 waiter 失效（保留：generation 变化 drain 的
    /// 专用终态；当前 replace 路径以 Disconnected 全量 drain）。
    #[allow(dead_code)]
    GenerationSuperseded,
    /// 协议层拒绝（解析失败、方法不支持等，附稳定原因码）。保留：被拒绝的
    /// 请求按设计不进队列（AC-04 §5.6：不伪造可交互 pending），该终态供
    /// 未来 admission 前置拒绝路径使用。
    #[allow(dead_code)]
    Rejected(String),
}

impl InteractionTerminalReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Answered => "answered",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timed_out",
            Self::Disconnected => "disconnected",
            Self::GenerationSuperseded => "generation_superseded",
            Self::Rejected(_) => "rejected",
        }
    }
}

/// 队列条目：身份 + 排序 + 冷挂载恢复所需载荷。
#[derive(Debug, Clone, PartialEq)]
pub struct InteractionQueueEntry {
    /// wire request id 的规范字符串形态（Number/String 双形态归一）。
    pub request_id: String,
    /// 触发交互的 ACP client request method。
    pub method: String,
    /// 交互类别（"approval" / "ask-user" / "elicitation" / ...）。
    pub kind: String,
    pub session_id: String,
    pub agent_id: String,
    /// 到达时的 client_generation（应答身份复核与 generation drain 用）。
    pub client_generation: u64,
    pub enqueued_at: Timestamp,
    /// 事件 payload（与 `pylon:interaction` 事件同一份结构，冷挂载恢复直接复用）。
    pub event: serde_json::Value,
    pub state: InteractionEntryState,
}

/// admit 结果：是否立即晋升 Active + 当前等待深度。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdmissionOutcome {
    /// 直接成为 Active（队列为空）。
    Promoted,
    /// 排入 FIFO 等待；携带入队后的 waiting 深度。
    Queued { waiting_depth: usize },
}

#[derive(Default)]
struct QueueInner {
    order: VecDeque<InteractionQueueEntry>,
}

/// per-runtime 交互队列（Clone 共享同一内部状态）。
#[derive(Clone, Default)]
pub struct InteractionQueue {
    inner: Arc<Mutex<QueueInner>>,
}

impl InteractionQueue {
    /// 入队一条交互请求。同 request_id 重复到达时以新记录原位替换（不重复
    /// 计数）；队列为空则直接晋升 Active，否则 FIFO 排队。
    pub fn admit(&self, mut entry: InteractionQueueEntry) -> Result<AdmissionOutcome, String> {
        let mut inner = self.inner.lock().map_err(|error| error.to_string())?;
        entry.state = InteractionEntryState::Waiting;
        let has_active = inner
            .order
            .front()
            .is_some_and(|front| front.state == InteractionEntryState::Active);
        // 同 id 原位替换：保持队列位置，避免 agent 重试把旧位置挤到队尾。
        if let Some(existing) = inner
            .order
            .iter()
            .position(|item| item.request_id == entry.request_id)
        {
            let was_active = inner.order[existing].state == InteractionEntryState::Active;
            entry.state = if was_active {
                InteractionEntryState::Active
            } else {
                InteractionEntryState::Waiting
            };
            inner.order[existing] = entry;
            return Ok(if was_active {
                AdmissionOutcome::Promoted
            } else {
                AdmissionOutcome::Queued {
                    waiting_depth: inner.order.len() - 1,
                }
            });
        }
        let outcome = if has_active || !inner.order.is_empty() {
            // 入队后的 waiting 深度（含本条）。
            let waiting_depth = inner
                .order
                .iter()
                .filter(|item| item.state == InteractionEntryState::Waiting)
                .count()
                + 1;
            inner.order.push_back(entry);
            AdmissionOutcome::Queued { waiting_depth }
        } else {
            entry.state = InteractionEntryState::Active;
            inner.order.push_back(entry);
            AdmissionOutcome::Promoted
        };
        Ok(outcome)
    }

    /// 终结一条 waiter（应答/取消/超时/拒绝）并晋升下一个 Waiting → Active。
    /// 返回被终结的条目（调用方据此发终态事件）。
    pub fn settle(
        &self,
        request_id: &str,
        reason: InteractionTerminalReason,
    ) -> Result<Option<InteractionQueueEntry>, String> {
        let mut inner = self.inner.lock().map_err(|error| error.to_string())?;
        let position = inner
            .order
            .iter()
            .position(|item| item.request_id == request_id);
        let Some(position) = position else {
            return Ok(None);
        };
        let mut entry = inner.order.remove(position).expect("position 存在");
        entry.state = InteractionEntryState::Terminal(reason);
        promote_next(&mut inner.order);
        Ok(Some(entry))
    }

    /// 按条件批量终结（timeout 扫描 / generation 变化），返回全部被终结条目。
    pub fn drain_where(
        &self,
        predicate: impl Fn(&InteractionQueueEntry) -> bool,
        reason: InteractionTerminalReason,
    ) -> Result<Vec<InteractionQueueEntry>, String> {
        let mut inner = self.inner.lock().map_err(|error| error.to_string())?;
        let mut drained = Vec::new();
        let mut kept = VecDeque::new();
        for entry in inner.order.drain(..) {
            if predicate(&entry) {
                let mut terminal = entry;
                terminal.state = InteractionEntryState::Terminal(reason.clone());
                drained.push(terminal);
            } else {
                kept.push_back(entry);
            }
        }
        promote_next(&mut kept);
        inner.order = kept;
        Ok(drained)
    }

    /// 全量 drain（disconnect / 客户端替换）：每个 waiter 都拿到终态。
    pub fn drain(
        &self,
        reason: InteractionTerminalReason,
    ) -> Result<Vec<InteractionQueueEntry>, String> {
        self.drain_where(|_| true, reason)
    }

    /// FIFO 快照（冷挂载/agent_status 投影用；Active 在前，保持队序）。
    pub fn snapshot(&self) -> Result<Vec<InteractionQueueEntry>, String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        Ok(inner.order.iter().cloned().collect())
    }

    /// 当前深度：(active request id, waiting 数)。
    pub fn depth(&self) -> Result<(Option<String>, usize), String> {
        let inner = self.inner.lock().map_err(|error| error.to_string())?;
        let active = inner
            .order
            .iter()
            .find(|item| item.state == InteractionEntryState::Active)
            .map(|item| item.request_id.clone());
        let waiting = inner
            .order
            .iter()
            .filter(|item| item.state == InteractionEntryState::Waiting)
            .count();
        Ok((active, waiting))
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().expect("test 锁").order.len()
    }
}

/// 晋升：若队首不是 Active 且队列非空，把第一个 Waiting 提为 Active
/// （单一可见语义：同一时刻至多一个 Active）。
fn promote_next(order: &mut VecDeque<InteractionQueueEntry>) {
    if order
        .front()
        .is_some_and(|front| front.state == InteractionEntryState::Active)
    {
        return;
    }
    if let Some(first_waiting) = order
        .iter_mut()
        .find(|item| item.state == InteractionEntryState::Waiting)
    {
        first_waiting.state = InteractionEntryState::Active;
    }
}

/// agent_status / 冷挂载投影：pending 交互摘要（含事件 payload 全文，前端
/// 仅凭 snapshot + generation 即可恢复 active 卡与 queued 深度，不依赖一次性
/// live event）。
pub fn pending_interactions_wire(entries: &[InteractionQueueEntry]) -> serde_json::Value {
    serde_json::Value::Array(
        entries
            .iter()
            .map(|entry| {
                serde_json::json!({
                    "requestId": entry.request_id,
                    "method": entry.method,
                    "kind": entry.kind,
                    "sessionId": entry.session_id,
                    "agentId": entry.agent_id,
                    "clientGeneration": entry.client_generation,
                    "requestedAt": entry.enqueued_at,
                    "state": match entry.state {
                        InteractionEntryState::Active => "active",
                        InteractionEntryState::Waiting => "waiting",
                        InteractionEntryState::Terminal(ref reason) => reason.as_str(),
                    },
                    "payload": entry.event,
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn entry(id: &str, kind: &str) -> InteractionQueueEntry {
        InteractionQueueEntry {
            request_id: id.to_string(),
            method: "session/request_permission".into(),
            kind: kind.into(),
            session_id: "s1".into(),
            agent_id: "a1".into(),
            client_generation: 3,
            enqueued_at: Timestamp::now(),
            event: json!({"title": id}),
            state: InteractionEntryState::Waiting,
        }
    }

    /// AC10：两个并发 permission 请求不互相覆盖——各自保留条目，首个 Active
    /// 第二个 Waiting；每个 request id 都有独立记录。
    #[test]
    fn concurrent_requests_keep_separate_entries_with_fifo_states() {
        let queue = InteractionQueue::default();
        assert_eq!(
            queue.admit(entry("1", "approval")).unwrap(),
            AdmissionOutcome::Promoted
        );
        assert_eq!(
            queue.admit(entry("2", "approval")).unwrap(),
            AdmissionOutcome::Queued { waiting_depth: 1 }
        );
        let snapshot = queue.snapshot().unwrap();
        assert_eq!(snapshot.len(), 2);
        assert_eq!(snapshot[0].request_id, "1");
        assert_eq!(snapshot[0].state, InteractionEntryState::Active);
        assert_eq!(snapshot[1].request_id, "2");
        assert_eq!(snapshot[1].state, InteractionEntryState::Waiting);
        assert_eq!(queue.depth().unwrap(), (Some("1".into()), 1));
    }

    /// FIFO promotion：settle 队首后下一个 Waiting 晋升 Active。
    #[test]
    fn settle_promotes_next_waiter_in_fifo_order() {
        let queue = InteractionQueue::default();
        let _ = queue.admit(entry("1", "approval"));
        let _ = queue.admit(entry("2", "approval"));
        let _ = queue.admit(entry("3", "elicitation"));
        let settled = queue
            .settle("1", InteractionTerminalReason::Answered)
            .unwrap()
            .expect("队首必被终结");
        assert_eq!(settled.request_id, "1");
        assert_eq!(
            settled.state,
            InteractionEntryState::Terminal(InteractionTerminalReason::Answered)
        );
        let snapshot = queue.snapshot().unwrap();
        assert_eq!(snapshot[0].request_id, "2");
        assert_eq!(snapshot[0].state, InteractionEntryState::Active);
        assert_eq!(snapshot[1].state, InteractionEntryState::Waiting);
        // 未知的 request id settle 返回 None（幂等）。
        assert!(queue
            .settle("missing", InteractionTerminalReason::Cancelled)
            .unwrap()
            .is_none());
    }

    /// timeout drain：只终结命中谓词的 waiter，其余保留且晋升补位。
    #[test]
    fn timeout_drain_only_expires_matching_entries() {
        let queue = InteractionQueue::default();
        let _ = queue.admit(entry("stale", "approval"));
        let _ = queue.admit(entry("fresh", "approval"));
        let expired = queue
            .drain_where(
                |item| item.request_id == "stale",
                InteractionTerminalReason::TimedOut,
            )
            .unwrap();
        assert_eq!(expired.len(), 1);
        assert_eq!(
            expired[0].state,
            InteractionEntryState::Terminal(InteractionTerminalReason::TimedOut)
        );
        let snapshot = queue.snapshot().unwrap();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].request_id, "fresh");
        assert_eq!(snapshot[0].state, InteractionEntryState::Active);
    }

    /// disconnect drain：全队终结且每个 waiter 拿到终态，队列清空。
    #[test]
    fn disconnect_drain_gives_every_waiter_a_terminal_state() {
        let queue = InteractionQueue::default();
        let _ = queue.admit(entry("a", "approval"));
        let _ = queue.admit(entry("b", "ask-user"));
        let _ = queue.admit(entry("c", "elicitation"));
        let drained = queue
            .drain(InteractionTerminalReason::Disconnected)
            .unwrap();
        assert_eq!(drained.len(), 3);
        assert!(drained.iter().all(|item| matches!(
            item.state,
            InteractionEntryState::Terminal(InteractionTerminalReason::Disconnected)
        )));
        assert_eq!(queue.len(), 0);
        assert_eq!(queue.depth().unwrap(), (None, 0));
    }

    /// 同 id 重复到达：原位替换不重复计数，Active 身份保持。
    #[test]
    fn duplicate_request_id_replaces_in_place() {
        let queue = InteractionQueue::default();
        let _ = queue.admit(entry("1", "approval"));
        let _ = queue.admit(entry("2", "approval"));
        let mut retry = entry("1", "approval");
        retry.event = json!({"title": "1-retry"});
        assert_eq!(queue.admit(retry).unwrap(), AdmissionOutcome::Promoted);
        let snapshot = queue.snapshot().unwrap();
        assert_eq!(snapshot.len(), 2);
        assert_eq!(snapshot[0].event, json!({"title": "1-retry"}));
        assert_eq!(snapshot[0].state, InteractionEntryState::Active);
    }

    /// generation 变化 drain：旧 generation waiter 全部 GenerationSuperseded。
    #[test]
    fn generation_bump_supersedes_stale_generation_waiters() {
        let queue = InteractionQueue::default();
        let _ = queue.admit(entry("old", "approval"));
        let mut fresh = entry("new", "approval");
        fresh.client_generation = 9;
        let _ = queue.admit(fresh);
        let drained = queue
            .drain_where(
                |item| item.client_generation < 9,
                InteractionTerminalReason::GenerationSuperseded,
            )
            .unwrap();
        assert_eq!(drained.len(), 1);
        assert_eq!(
            drained[0].state,
            InteractionEntryState::Terminal(InteractionTerminalReason::GenerationSuperseded)
        );
        assert_eq!(queue.snapshot().unwrap()[0].request_id, "new");
    }

    /// 冷挂载投影：snapshot 含身份、状态与事件 payload 全文。
    #[test]
    fn wire_projection_carries_enough_for_cold_mount() {
        let queue = InteractionQueue::default();
        let _ = queue.admit(entry("1", "approval"));
        let _ = queue.admit(entry("2", "elicitation"));
        let wire = pending_interactions_wire(&queue.snapshot().unwrap());
        let items = wire.as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].get("requestId"), Some(&json!("1")));
        assert_eq!(items[0].get("state"), Some(&json!("active")));
        assert_eq!(items[1].get("state"), Some(&json!("waiting")));
        assert_eq!(items[0].pointer("/payload/title"), Some(&json!("1")));
        assert!(items[0].get("clientGeneration").is_some());
    }
}
