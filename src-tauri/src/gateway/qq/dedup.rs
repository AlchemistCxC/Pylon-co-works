//! QQ 重放去重（BE-B10-003）。
//!
//! 纯数据层：seen 滑动窗口（msg_id → 单调递增序号，超限清理最旧）+ last_msg_id
//! 映射（chat_id → 最新 msg_id）。不依赖 tauri/WS，无 IO。
//!
//! 背景：QQ WS 断线重连后 resume 会重放事件，必须去重，否则 agent 收到重复消息。
//! 参考 Hermes `_seen_messages` 滑动窗口（DEDUP_MAX_SIZE = 1000 为 Hermes 实证值）。

use std::collections::HashMap;

/// seen 窗口上限（Hermes 实证值）。
///
/// 待 B10.2 QQ 适配器消费，当前仅单测引用，故允许 dead_code。
const DEDUP_MAX_SIZE: usize = 1000;

/// QQ 重放去重状态。
///
/// 纯数据层，供 B10.2 适配器在 ingest 前判重、回复时取 last_msg_id；
/// 当前尚未被适配器消费（仅单测），故允许 dead_code。
pub struct DedupState {
    /// msg_id → 单调递增序号（替代真实时间，用于清理最旧条目）。
    seen: HashMap<String, u64>,
    /// 内部单调递增计数器，每记录一条新消息 +1。
    next_seq: u64,
    /// chat_id → 最新 msg_id（回复锚点 + msg_seq 计算）。
    last_msg_id: HashMap<String, String>,
}

/// 实现（各方法待 B10.2 适配器消费，当前仅单测引用，故允许 dead_code）。
impl DedupState {
    pub fn new() -> Self {
        Self {
            seen: HashMap::new(),
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
        self.next_seq += 1;
        true
    }

    /// seen 窗口容量（DEDUP_MAX_SIZE，Hermes 实证值）。仅测试引用。
    #[cfg(test)]
    pub fn window_capacity(&self) -> usize {
        DEDUP_MAX_SIZE
    }

    /// 清理 seen 窗口中序号最小的条目（最旧）。
    fn evict_oldest(&mut self) {
        if let Some(oldest) = self
            .seen
            .iter()
            .min_by_key(|(_, seq)| **seq)
            .map(|(msg_id, _)| msg_id.clone())
        {
            self.seen.remove(&oldest);
        }
    }

    /// 查询 chat 的最新 msg_id（B10 收尾：deliver 回复锚点消费）。
    pub fn latest_for(&self, chat_id: &str) -> Option<&str> {
        self.last_msg_id.get(chat_id).map(String::as_str)
    }

    /// 更新 chat 的最新 msg_id。
    pub fn set_latest(&mut self, chat_id: &str, msg_id: &str) {
        self.last_msg_id.insert(chat_id.to_string(), msg_id.to_string());
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
}
