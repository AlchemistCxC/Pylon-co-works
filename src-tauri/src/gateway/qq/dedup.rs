//! QQ 重放去重（BE-B10-003）。
//!
//! 纯数据层：seen 滑动窗口（msg_id → 单调递增序号，超限清理最旧）+ last_msg_id
//! 映射（chat_id → 最新 msg_id）。不依赖 tauri/WS，无 IO。
//!
//! 背景：QQ WS 断线重连后 resume 会重放事件，必须去重，否则 agent 收到重复消息。
//! 参考 Hermes `_seen_messages` 滑动窗口（DEDUP_MAX_SIZE = 1000 为 Hermes 实证值）。

use std::collections::{HashMap, VecDeque};

/// seen 窗口上限（Hermes 实证值）。
///
/// B10.2 起由 QqAdapter::handle_incoming 经 `is_new` 消费（去重窗口）。
const DEDUP_MAX_SIZE: usize = 1000;

/// QQ 重放去重状态。
///
/// 纯数据层；B10.2 起由 QqAdapter::handle_incoming（ingest 前判重、记录 latest）
/// 与 deliver_text（回复锚点 latest_for）消费。
pub struct DedupState {
    /// msg_id → 单调递增序号（替代真实时间）。
    seen: HashMap<String, u64>,
    /// 插入顺序队列（队首最旧），用于 O(1) 驱逐。
    order: VecDeque<String>,
    /// 内部单调递增计数器，每记录一条新消息 +1。
    next_seq: u64,
    /// chat_id → 最新 msg_id（回复锚点 + msg_seq 计算）。
    last_msg_id: HashMap<String, String>,
}

/// 实现（B10.2 起由 QQ 适配器 handle_incoming / deliver_text 消费）。
impl DedupState {
    pub fn new() -> Self {
        Self {
            seen: HashMap::new(),
            order: VecDeque::new(),
            next_seq: 0,
            last_msg_id: HashMap::new(),
        }
    }

    /// 判定 msg_id 是否为新消息：首次见返回 true 并记录；重复返回 false。
    pub fn is_new(&mut self, msg_id: &str) -> bool {
        if self.seen.contains_key(msg_id) {
            return false;
        }
        if self.seen.len() >= DEDUP_MAX_SIZE {
            self.evict_oldest();
        }
        self.seen.insert(msg_id.to_string(), self.next_seq);
        self.order.push_back(msg_id.to_string());
        self.next_seq += 1;
        true
    }

    /// 回滚 seen 记录（C14）：ingest 发送失败后撤销去重标记——msg_id 不再占
    /// 去重窗口，resume 重放同一消息可重新 ingest（防故障期消息永久丢失）。
    /// 同步从 order 队列移除该条目，避免驱逐时 pop 到已不在 seen 的残留
    /// （残留条目驱逐无效，seen 短暂超上限）。
    /// 不影响 last_msg_id（回复锚点语义：锚点跟随最后一次收到的消息）。
    pub fn rollback(&mut self, msg_id: &str) {
        self.seen.remove(msg_id);
        self.order.retain(|m| m != msg_id);
    }

    /// seen 窗口容量（DEDUP_MAX_SIZE，Hermes 实证值）。仅测试引用。
    #[cfg(test)]
    pub fn window_capacity(&self) -> usize {
        DEDUP_MAX_SIZE
    }

    /// 清理 seen 窗口中最旧的条目（队首，插入顺序即序号顺序）。
    /// 若被驱逐的 msg_id 恰为某 chat 的 last_msg_id 锚点，同步清除
    /// （锚点失效后降级普通发送，而非悬空引用）。
    fn evict_oldest(&mut self) {
        if let Some(oldest) = self.order.pop_front() {
            self.seen.remove(&oldest);
            self.last_msg_id.retain(|_, v| v != &oldest);
        }
    }

    /// 查询 chat 的最新 msg_id（B10 收尾：deliver 回复锚点消费）。
    pub fn latest_for(&self, chat_id: &str) -> Option<&str> {
        self.last_msg_id.get(chat_id).map(String::as_str)
    }

    /// 更新 chat 的最新 msg_id。
    pub fn set_latest(&mut self, chat_id: &str, msg_id: &str) {
        self.last_msg_id
            .insert(chat_id.to_string(), msg_id.to_string());
    }
}

impl Default for DedupState {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_message_is_new() {
        let mut state = DedupState::new();
        assert!(state.is_new("msg-1"));
    }

    #[test]
    fn duplicate_msg_id_is_rejected() {
        let mut state = DedupState::new();
        assert!(state.is_new("msg-1"));
        assert!(!state.is_new("msg-1"));
        // 新消息不受影响
        assert!(state.is_new("msg-2"));
        assert!(!state.is_new("msg-2"));
    }

    #[test]
    fn window_evicts_oldest_when_over_limit() {
        let mut state = DedupState::new();
        // 填满窗口
        for i in 0..DEDUP_MAX_SIZE {
            let msg_id = format!("msg-{i}");
            assert!(state.is_new(&msg_id), "msg-{i} 应为新消息");
        }
        assert_eq!(state.seen.len(), DEDUP_MAX_SIZE);
        // 超限插入：最旧条目（msg-0）被清理，容量不超上限
        assert!(state.is_new("msg-overflow"));
        assert!(state.seen.len() <= DEDUP_MAX_SIZE);
        // 窗口内其余条目仍判重
        assert!(!state.is_new("msg-1"));
        assert!(!state.is_new("msg-999"));
        assert!(!state.is_new("msg-overflow"));
        // 最早条目已被清出窗口，重新可见（重入会再次挤掉当前最旧条目，容量仍受限）
        assert!(state.is_new("msg-0"), "最早条目 msg-0 应已被清理");
        assert!(state.seen.len() <= DEDUP_MAX_SIZE);
    }

    #[test]
    fn rollback_restores_reingest_after_seen() {
        let mut state = DedupState::new();
        assert!(state.is_new("msg-1"));
        assert!(!state.is_new("msg-1"));
        // C14：ingest 失败回滚 → 同一 msg_id 重新可入
        state.rollback("msg-1");
        assert!(state.is_new("msg-1"), "rollback 后同一 msg_id 必须可重入");
        // rollback 未记录过的 id 安全无副作用
        state.rollback("never-seen");
        // 回滚不影响 last_msg_id 锚点
        state.set_latest("chat-1", "msg-1");
        state.rollback("msg-1");
        assert_eq!(state.latest_for("chat-1"), Some("msg-1"));
    }

    #[test]
    fn rollback_removes_order_entry() {
        let mut state = DedupState::new();
        state.is_new("msg-1");
        state.is_new("msg-2");
        state.rollback("msg-1");
        assert_eq!(state.order.len(), 1, "rollback 后 order 不应残留该 msg_id");
        assert!(!state.order.iter().any(|m| m == "msg-1"));
    }

    #[test]
    fn rollback_keeps_window_bounded_after_reingest_cycles() {
        let mut state = DedupState::new();
        // C14：msg-0 失败回滚（若 order 残留，则成为队首脏条目）
        assert!(state.is_new("msg-0"));
        state.rollback("msg-0");
        for i in 1..=DEDUP_MAX_SIZE {
            assert!(state.is_new(&format!("msg-{i}")));
        }
        // 超限插入应驱逐真实最旧条目（msg-1），而非残留的 msg-0
        assert!(state.is_new("msg-overflow"));
        assert!(state.seen.len() <= DEDUP_MAX_SIZE);
        assert!(!state.is_new("msg-2"));
        assert!(!state.is_new("msg-overflow"));
        // msg-1 已被驱逐 → 可重入（若驱逐的是残留 msg-0，msg-1 仍占窗口即失败）
        assert!(state.is_new("msg-1"), "msg-1 应已被驱逐，可重入");
        assert!(state.seen.len() <= DEDUP_MAX_SIZE);
    }

    #[test]
    fn last_msg_id_update_and_query() {
        let mut state = DedupState::new();
        assert_eq!(state.latest_for("chat-1"), None);
        state.set_latest("chat-1", "msg-100");
        assert_eq!(state.latest_for("chat-1"), Some("msg-100"));
        // 更新覆盖旧值
        state.set_latest("chat-1", "msg-200");
        assert_eq!(state.latest_for("chat-1"), Some("msg-200"));
    }

    #[test]
    fn last_msg_id_isolated_per_chat() {
        let mut state = DedupState::new();
        state.set_latest("chat-a", "msg-a1");
        state.set_latest("chat-b", "msg-b1");
        assert_eq!(state.latest_for("chat-a"), Some("msg-a1"));
        assert_eq!(state.latest_for("chat-b"), Some("msg-b1"));
        // 更新 chat-a 不影响 chat-b
        state.set_latest("chat-a", "msg-a2");
        assert_eq!(state.latest_for("chat-a"), Some("msg-a2"));
        assert_eq!(state.latest_for("chat-b"), Some("msg-b1"));
        assert_eq!(state.latest_for("chat-c"), None);
    }

    #[test]
    fn evicting_last_msg_id_clears_anchor() {
        let mut state = DedupState::new();
        // chat-1 锚点指向 msg-0（最旧条目）
        state.set_latest("chat-1", "msg-0");
        for i in 0..DEDUP_MAX_SIZE {
            assert!(state.is_new(&format!("msg-{i}")));
        }
        // 超限插入触发驱逐：msg-0 被清出窗口，同时锚点失效
        assert!(state.is_new("msg-overflow"));
        assert_eq!(state.latest_for("chat-1"), None, "锚点应随驱逐清除");
        // 无关 chat 锚点不受影响
        state.set_latest("chat-2", "msg-500");
        assert_eq!(state.latest_for("chat-2"), Some("msg-500"));
    }
}
