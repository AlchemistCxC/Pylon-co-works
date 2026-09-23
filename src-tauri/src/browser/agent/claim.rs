//! 浏览器 claim 状态机：同一时刻至多一个 Agent 会话持有浏览器。
//!
//! 规则（spec §5）：写操作需要 claim；用户手动交互立即抢占（`claim_lost`）；
//! 会话结束显式释放；持有方空闲超过 [`CLAIM_IDLE_TIMEOUT`] 自动释放。
//! readonly 观察类工具不要求 claim，但高亮等可视反馈只跟随 claim 持有者。

use std::time::Duration;

/// 持有方无任何操作多久后自动释放。
pub(crate) const CLAIM_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClaimState {
    Free,
    Held {
        session_key: String,
        last_activity_ms: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClaimAcquireError {
    /// 已被其他会话持有（携带持有者）。
    HeldBy { session_key: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ClaimUseError {
    /// 需要 claim 但当前未被任何会话持有。
    ClaimRequired,
    /// 被其他会话持有。
    HeldBy { session_key: String },
    /// 原持有者已被用户抢占（仅对被抢占会话的第一次写操作返回）。
    Lost,
}

#[derive(Debug)]
pub(crate) struct ClaimManager {
    state: ClaimState,
    idle_timeout: Duration,
    /// 用户抢占的受害者：其下一次写操作收到 `Lost`（而非静默重新持有），
    /// 之后回归正常语义。spec 验收 7。
    pending_lost: Option<String>,
}

impl Default for ClaimManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaimManager {
    pub(crate) fn new() -> Self {
        Self {
            state: ClaimState::Free,
            idle_timeout: CLAIM_IDLE_TIMEOUT,
            pending_lost: None,
        }
    }

    /// 构造时注入空闲超时（测试用）。
    #[allow(dead_code)]
    pub(crate) fn with_idle_timeout(idle_timeout: Duration) -> Self {
        Self {
            state: ClaimState::Free,
            idle_timeout,
            pending_lost: None,
        }
    }

    pub(crate) fn holder(&self) -> Option<&str> {
        match &self.state {
            ClaimState::Free => None,
            ClaimState::Held { session_key, .. } => Some(session_key),
        }
    }

    pub(crate) fn held_by(&self, session_key: &str) -> bool {
        match &self.state {
            ClaimState::Held {
                session_key: holder,
                ..
            } => holder == session_key,
            ClaimState::Free => false,
        }
    }

    /// 空闲释放检查：超过空闲窗口的持有视为已释放。返回释放的持有者。
    fn expire_idle(&mut self, now_ms: u64) -> Option<String> {
        if let ClaimState::Held {
            session_key,
            last_activity_ms,
        } = &self.state
        {
            let idle_ms = now_ms.saturating_sub(*last_activity_ms);
            if idle_ms >= u64::try_from(self.idle_timeout.as_millis()).unwrap_or(u64::MAX) {
                let expired = session_key.clone();
                self.state = ClaimState::Free;
                return Some(expired);
            }
        }
        None
    }

    /// 会话请求持有。若已过期持有会被先释放。
    pub(crate) fn acquire(
        &mut self,
        session_key: &str,
        now_ms: u64,
    ) -> Result<(), ClaimAcquireError> {
        self.expire_idle(now_ms);
        match &self.state {
            ClaimState::Free => {
                self.state = ClaimState::Held {
                    session_key: session_key.to_string(),
                    last_activity_ms: now_ms,
                };
                Ok(())
            }
            ClaimState::Held {
                session_key: holder,
                ..
            } => {
                if holder == session_key {
                    self.state = ClaimState::Held {
                        session_key: session_key.to_string(),
                        last_activity_ms: now_ms,
                    };
                    Ok(())
                } else {
                    Err(ClaimAcquireError::HeldBy {
                        session_key: holder.clone(),
                    })
                }
            }
        }
    }

    /// 写操作前检查：持有者刷新活动时间；空闲/被抢占/未持有分别报错。
    pub(crate) fn ensure_usable(
        &mut self,
        session_key: &str,
        now_ms: u64,
    ) -> Result<(), ClaimUseError> {
        self.expire_idle(now_ms);
        if self.state == ClaimState::Free {
            if let Some(victim) = self.pending_lost.take() {
                if victim == session_key {
                    return Err(ClaimUseError::Lost);
                }
                self.pending_lost = Some(victim);
            }
        }
        match &self.state {
            ClaimState::Free => Err(ClaimUseError::ClaimRequired),
            ClaimState::Held {
                session_key: holder,
                ..
            } => {
                if holder == session_key {
                    self.state = ClaimState::Held {
                        session_key: session_key.to_string(),
                        last_activity_ms: now_ms,
                    };
                    Ok(())
                } else {
                    Err(ClaimUseError::HeldBy {
                        session_key: holder.clone(),
                    })
                }
            }
        }
    }

    /// 用户手动交互：无条件抢占，返回被挤掉的持有者（用于 UI/审计提示）。
    pub(crate) fn preempt_by_user(&mut self) -> Option<String> {
        let previous = self.holder().map(str::to_string);
        self.pending_lost = previous.clone();
        self.state = ClaimState::Free;
        previous
    }

    /// 会话显式释放（会话关闭时）。返回是否确有释放。
    /// （预留：session close 钩子接线前由 5 分钟空闲释放兜底。）
    #[allow(dead_code)]
    pub(crate) fn release(&mut self, session_key: &str) -> bool {
        if self.pending_lost.as_deref() == Some(session_key) {
            self.pending_lost = None;
        }
        if self.held_by(session_key) {
            self.state = ClaimState::Free;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn acquire_reacquire_and_release_by_same_session() {
        let mut claim = ClaimManager::new();
        assert!(claim.holder().is_none());
        claim.acquire("s1", 1_000).unwrap();
        assert!(claim.held_by("s1"));
        // 同会话重复 acquire 等价于续期。
        claim.acquire("s1", 2_000).unwrap();
        assert!(claim.held_by("s1"));
        assert!(claim.release("s1"));
        assert!(!claim.release("s1"));
        assert_eq!(claim.holder(), None);
    }

    #[test]
    fn acquire_by_other_session_is_rejected_with_holder() {
        let mut claim = ClaimManager::new();
        claim.acquire("s1", 0).unwrap();
        let error = claim.acquire("s2", 1_000).unwrap_err();
        assert_eq!(
            error,
            ClaimAcquireError::HeldBy {
                session_key: "s1".to_string()
            }
        );
    }

    #[test]
    fn write_requires_claim_and_reports_holder() {
        let mut claim = ClaimManager::new();
        assert_eq!(
            claim.ensure_usable("s1", 0).unwrap_err(),
            ClaimUseError::ClaimRequired
        );
        claim.acquire("s2", 0).unwrap();
        assert_eq!(
            claim.ensure_usable("s1", 1_000).unwrap_err(),
            ClaimUseError::HeldBy {
                session_key: "s2".to_string()
            }
        );
        claim.ensure_usable("s2", 1_000).unwrap();
    }

    #[test]
    fn idle_holding_expires_after_timeout() {
        let mut claim = ClaimManager::with_idle_timeout(Duration::from_secs(300));
        claim.acquire("s1", 0).unwrap();
        // 未超时：其他会话仍看到"被持有"（不刷新持有者的活动时间）。
        assert_eq!(
            claim.ensure_usable("s2", 299_999).unwrap_err(),
            ClaimUseError::HeldBy {
                session_key: "s1".to_string()
            }
        );
        // 超时：空闲释放，原持有者写操作要求重新 acquire。
        assert_eq!(
            claim.ensure_usable("s1", 300_000).unwrap_err(),
            ClaimUseError::ClaimRequired
        );
        claim.acquire("s2", 300_001).unwrap();
        assert!(claim.held_by("s2"));
    }

    #[test]
    fn user_preemption_forces_release_and_reports_previous_holder() {
        let mut claim = ClaimManager::new();
        claim.acquire("s1", 0).unwrap();
        let previous = claim.preempt_by_user();
        assert_eq!(previous.as_deref(), Some("s1"));
        assert_eq!(claim.holder(), None);
        // 用户抢占后，原持有者的下一次写操作收到 Lost（而非静默重持）。
        assert_eq!(
            claim.ensure_usable("s1", 1_000).unwrap_err(),
            ClaimUseError::Lost
        );
        // Lost 只报一次：之后回归 Free 语义（写操作可重新自动持有）。
        assert_eq!(
            claim.ensure_usable("s1", 2_000).unwrap_err(),
            ClaimUseError::ClaimRequired
        );
        // 空闲态抢占返回 None 且无副作用。
        assert_eq!(claim.preempt_by_user(), None);
    }

    #[test]
    fn release_by_other_session_is_noop() {
        let mut claim = ClaimManager::new();
        claim.acquire("s1", 0).unwrap();
        assert!(!claim.release("s2"));
        assert!(claim.held_by("s1"));
    }
}
