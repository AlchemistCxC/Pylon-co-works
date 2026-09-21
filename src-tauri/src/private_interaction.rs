//! Runtime-owned pending private ACP interactions.
//! The owner deliberately stores only validated, bounded payloads; transport
//! response remains at the ACP client boundary.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::acp::RequestId;

#[derive(Debug, Clone)]
pub(crate) struct PendingPrivateInteraction {
    pub provider: String,
    pub agent_id: String,
    pub session_id: String,
    pub method: String,
    pub bridge: crate::acp::adapter::private_ext::PrivateBridge,
    pub params: serde_json::Value,
    pub question_specs: Option<Vec<crate::acp::question_policy::QuestionSpec>>,
    pub client_generation: u64,
    /// 到达时刻（#230：interaction_list 投影 requestedAt 用；私有交互不参与
    /// 超时结算，仅作展示时间戳）。
    pub enqueued_at: crate::time::Timestamp,
}

impl PendingPrivateInteraction {
    /// 队列 canonical kind（委托 PrivateBridge::queue_kind 单一映射）。
    pub(crate) fn queue_kind(&self) -> &'static str {
        self.bridge.queue_kind()
    }
}

#[derive(Clone, Default)]
pub(crate) struct PrivateInteractionOwner {
    pending: Arc<Mutex<HashMap<RequestId, PendingPrivateInteraction>>>,
}

impl PrivateInteractionOwner {
    pub(crate) fn insert(
        &self,
        id: RequestId,
        item: PendingPrivateInteraction,
    ) -> Result<(), String> {
        self.pending
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id, item);
        Ok(())
    }
    pub(crate) fn take(&self, id: &RequestId) -> Result<Option<PendingPrivateInteraction>, String> {
        Ok(self.pending.lock().map_err(|e| e.to_string())?.remove(id))
    }
    pub(crate) fn get(&self, id: &RequestId) -> Result<Option<PendingPrivateInteraction>, String> {
        Ok(self
            .pending
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned())
    }
    pub(crate) fn cancel_all(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }
    /// #230：interaction_list 投影快照（request_id → 条目）。
    pub(crate) fn snapshot(&self) -> Vec<(RequestId, PendingPrivateInteraction)> {
        self.pending
            .lock()
            .map(|pending| {
                pending
                    .iter()
                    .map(|(id, item)| (id.clone(), item.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owner_is_single_claim() {
        let owner = PrivateInteractionOwner::default();
        let item = PendingPrivateInteraction {
            provider: "peri".into(),
            agent_id: "a".into(),
            session_id: "s".into(),
            method: "pi/select_ask".into(),
            bridge: crate::acp::adapter::private_ext::PrivateBridge::PiSelectAsk,
            params: serde_json::json!({}),
            question_specs: None,
            client_generation: 3,
            enqueued_at: crate::time::Timestamp::now(),
        };
        owner.insert(RequestId::Number(1), item).unwrap();
        assert_eq!(owner.len(), 1);
        // #230：snapshot 投影不消费条目。
        assert_eq!(owner.snapshot().len(), 1);
        assert_eq!(owner.snapshot()[0].1.queue_kind(), "ask-user");
        assert!(owner.take(&RequestId::Number(1)).unwrap().is_some());
        assert!(owner.take(&RequestId::Number(1)).unwrap().is_none());
    }
}
