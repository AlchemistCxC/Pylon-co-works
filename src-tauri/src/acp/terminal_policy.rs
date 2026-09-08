//! Codeg terminal runtime limits. Execution and process ownership remain in
//! Pylon's existing terminal boundary.

use std::time::Duration;

pub const DEFAULT_OUTPUT_BYTE_LIMIT: u64 = 1_000_000;
pub const READER_DRAIN_GRACE: Duration = Duration::from_millis(200);
pub const KILL_ESCALATE_GRACE: Duration = Duration::from_secs(2);
pub const KILL_REPORT_BUDGET: Duration = Duration::from_secs(5);
pub const WAIT_RETRY_MAX_BACKOFF: Duration = Duration::from_secs(1);
pub const WAIT_ERROR_BUDGET: Duration = Duration::from_secs(30);
pub const WAIT_ERROR_IDLE_RETRY: Duration = Duration::from_secs(5);

pub fn output_limit(requested: Option<usize>) -> usize {
    requested.unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT as usize)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn codeg_terminal_limits_and_default_are_stable() {
        assert_eq!(output_limit(None), 1_000_000);
        assert_eq!(output_limit(Some(123)), 123);
        assert_eq!(READER_DRAIN_GRACE, Duration::from_millis(200));
        assert_eq!(KILL_ESCALATE_GRACE, Duration::from_secs(2));
        assert_eq!(KILL_REPORT_BUDGET, Duration::from_secs(5));
        assert_eq!(WAIT_ERROR_BUDGET, Duration::from_secs(30));
    }
}
