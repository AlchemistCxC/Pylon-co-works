//! #422：连接测试凭证登记（B1 保存门禁后端化的凭证侧）。
//!
//! `test_agent_candidate` 握手成功时把「已验证的 launch 指纹」记入本表；
//! `update_agents_config`（scope=agent / agent_fields）保存 launch 指纹有变更的
//! 候选前查表，无凭证即 `config_verification_required` 拒绝。
//!
//! 凭证形态（spec `.agents/spec/422-backend-save-gate.md`）：进程内
//! `agent_id → 有界指纹集合`，不落盘、无 TTL——失效条件是**指纹变更**（未变更
//! 沿用），与前端 `agentDraftMachine` 的 `verifiedFingerprint === fingerprint`
//! 语义同构。进程重启清空 = 重新测试（fail-closed；重启后未保存草稿本就丢失）。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;

/// 每 agent 保留的已验证指纹上限（超出淘汰最旧；去重时刷新位置）。
/// 上限只防无界增长：正常编辑流一次只有一两个待保存指纹在飞。
const PER_AGENT_VOUCHER_LIMIT: usize = 8;

#[derive(Default)]
pub(crate) struct VerificationVouchers {
    per_agent: Mutex<HashMap<String, VecDeque<String>>>,
}

impl VerificationVouchers {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// 记录一次成功握手验证过的指纹（重复记录 = 移到队尾，刷新 LRU 位置）。
    pub(crate) fn record(&self, agent_id: &str, fingerprint: &str) {
        let mut per_agent = self.per_agent.lock().unwrap_or_else(|e| e.into_inner());
        let entries = per_agent.entry(agent_id.to_string()).or_default();
        entries.retain(|entry| entry != fingerprint);
        entries.push_back(fingerprint.to_string());
        while entries.len() > PER_AGENT_VOUCHER_LIMIT {
            entries.pop_front();
        }
    }

    /// 该 agent 的此指纹是否验证过（凭证可重复使用：保存 CAS 冲突重试不需重测）。
    pub(crate) fn contains(&self, agent_id: &str, fingerprint: &str) -> bool {
        let per_agent = self.per_agent.lock().unwrap_or_else(|e| e.into_inner());
        per_agent
            .get(agent_id)
            .is_some_and(|entries| entries.iter().any(|entry| entry == fingerprint))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_is_idempotent_and_refreshes_recency() {
        let vouchers = VerificationVouchers::new();
        vouchers.record("a", "fp1");
        vouchers.record("a", "fp1");
        let entries = vouchers.per_agent.lock().unwrap().get("a").unwrap().clone();
        assert_eq!(entries.len(), 1, "重复记录同一指纹不占新槽位");
    }

    #[test]
    fn capacity_evicts_oldest_fingerprints() {
        let vouchers = VerificationVouchers::new();
        for index in 0..(PER_AGENT_VOUCHER_LIMIT + 2) {
            vouchers.record("a", &format!("fp{index}"));
        }
        assert!(!vouchers.contains("a", "fp0"), "最旧指纹被淘汰");
        assert!(!vouchers.contains("a", "fp1"), "次旧指纹被淘汰");
        assert!(vouchers.contains("a", "fp2"), "上限内保留");
        assert!(vouchers.contains("a", &format!("fp{}", PER_AGENT_VOUCHER_LIMIT + 1)));
    }

    #[test]
    fn vouchers_are_scoped_per_agent() {
        let vouchers = VerificationVouchers::new();
        vouchers.record("a", "fp1");
        assert!(!vouchers.contains("b", "fp1"), "凭证不跨 agent 复用");
        assert!(vouchers.contains("a", "fp1"));
    }
}
