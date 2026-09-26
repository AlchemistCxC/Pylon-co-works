//! 前缘节流：把一段时间的重复告警折叠成一条，**且绝不静默丢弃**。
//!
//! 语义（对齐 Codeg `logging/throttle.rs`）：
//! - **前缘立即放行**：`last_emit` 还是 `None` 时无条件放行，不依赖时钟状态——
//!   第一条告警必须马上出现，否则用户根本不知道有这回事。
//! - 窗口内的后续命中只累加计数，不产出。
//! - 窗口外再放行，并把**窗口内被折叠的条数与抑制量**一起上抛（`Summary`）。
//!   抑制数总是搭下一条放行的车，所以没有任何一条被无声抹掉。
//! - 时钟倒退（`now < last_emit`）饱和为「窗口未过」→ 抑制，不 panic、不放行。
//!
//! 作用域是**每个调用点一份实例**，不是全局、也不是按 key。调用点自己持有。

use std::time::{Duration, Instant};

/// 窗口长度：10 秒。取值参考 Codeg `LAG_LOG_WINDOW`。
pub const LAG_LOG_WINDOW: Duration = Duration::from_secs(10);

/// 放行时携带的折叠摘要。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    /// 本窗口内（含本次）命中次数。
    pub occurrences: u64,
    /// 本窗口内被折叠掉的量（例如被跳过的条目数）累计。
    pub dropped: u64,
}

/// 前缘节流状态机：纯逻辑、`Instant` 由调用方注入以便单测。
#[derive(Debug, Clone)]
pub struct LeadingEdgeThrottle {
    window: Duration,
    last_emit: Option<Instant>,
    pending_occurrences: u64,
    pending_dropped: u64,
}

impl LeadingEdgeThrottle {
    pub const fn new(window: Duration) -> Self {
        Self {
            window,
            last_emit: None,
            pending_occurrences: 0,
            pending_dropped: 0,
        }
    }

    /// 记一次命中：放行则返回折叠摘要，抑制则返回 `None`。
    pub fn record(&mut self, dropped: u64) -> Option<Summary> {
        self.record_at(Instant::now(), dropped)
    }

    /// 注入时钟的版本（单测用）。
    pub fn record_at(&mut self, now: Instant, dropped: u64) -> Option<Summary> {
        self.pending_occurrences = self.pending_occurrences.saturating_add(1);
        self.pending_dropped = self.pending_dropped.saturating_add(dropped);
        let due = match self.last_emit {
            // 前缘：时钟状态无关，立即放行。
            None => true,
            Some(last) => now.saturating_duration_since(last) >= self.window,
        };
        if !due {
            return None;
        }
        let summary = Summary {
            occurrences: self.pending_occurrences,
            dropped: self.pending_dropped,
        };
        self.pending_occurrences = 0;
        self.pending_dropped = 0;
        self.last_emit = Some(now);
        Some(summary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_edge_passes_immediately_even_with_a_fresh_clock() {
        let mut throttle = LeadingEdgeThrottle::new(LAG_LOG_WINDOW);
        let base = Instant::now();
        assert_eq!(
            throttle.record_at(base, 5),
            Some(Summary {
                occurrences: 1,
                dropped: 5
            })
        );
    }

    #[test]
    fn inside_the_window_hits_fold_and_ride_the_next_emit() {
        let mut throttle = LeadingEdgeThrottle::new(Duration::from_secs(10));
        let base = Instant::now();
        // 前缘：立即放行，本窗口只含它自己
        assert_eq!(
            throttle.record_at(base, 3),
            Some(Summary {
                occurrences: 1,
                dropped: 3
            })
        );
        // 窗口内的三次命中：全部折叠（4 + 5 + 6 = 15）
        assert_eq!(throttle.record_at(base + Duration::from_secs(1), 4), None);
        assert_eq!(throttle.record_at(base + Duration::from_secs(2), 5), None);
        assert_eq!(throttle.record_at(base + Duration::from_secs(3), 6), None);
        // 窗口外放行：折叠的 3 次与 15 的抑制量随这条上抛，加上本次的 7 → 22
        assert_eq!(
            throttle.record_at(base + Duration::from_secs(10), 7),
            Some(Summary {
                occurrences: 4,
                dropped: 22
            })
        );
    }

    #[test]
    fn the_window_boundary_is_inclusive() {
        let mut throttle = LeadingEdgeThrottle::new(Duration::from_secs(10));
        let base = Instant::now();
        assert!(throttle.record_at(base, 0).is_some());
        assert!(throttle
            .record_at(base + Duration::from_secs(10), 0)
            .is_some());
    }

    #[test]
    fn a_backwards_clock_suppresses_instead_of_panicking() {
        let mut throttle = LeadingEdgeThrottle::new(Duration::from_secs(10));
        let base = Instant::now();
        assert!(throttle.record_at(base, 0).is_some());
        assert_eq!(throttle.record_at(base - Duration::from_secs(5), 1), None);
    }

    #[test]
    fn instances_are_independent() {
        let base = Instant::now();
        let mut first = LeadingEdgeThrottle::new(Duration::from_secs(10));
        let mut second = LeadingEdgeThrottle::new(Duration::from_secs(10));
        assert!(first.record_at(base, 0).is_some());
        // 另一个调用点的实例不受影响，它的前缘仍然立即放行
        assert!(second.record_at(base, 0).is_some());
    }
}
