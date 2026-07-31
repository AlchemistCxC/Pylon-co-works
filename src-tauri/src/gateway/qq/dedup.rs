//! QQ 重放去重（BE-B10-003 施工位）。
//!
//! 占位骨架：完整实现由 BE-B10-003 任务交付（seen 滑动窗口 + last_msg_id + 单测）。

pub struct DedupState {
    _marker: std::marker::PhantomData<()>,
}

impl DedupState {
    pub fn new() -> Self {
        Self { _marker: std::marker::PhantomData }
    }

    pub fn is_new(&mut self, _msg_id: &str) -> bool {
        true
    }

    pub fn latest_for(&self, _chat_id: &str) -> Option<&str> {
        None
    }

    pub fn set_latest(&mut self, _chat_id: &str, _msg_id: &str) {}
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
}
