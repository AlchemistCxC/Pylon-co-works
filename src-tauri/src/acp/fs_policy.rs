//! Upstream filesystem runtime limits and path-policy constants.
//! Execution remains owned by the existing Pylon permission/runtime boundary.

use std::time::Duration;

pub const MAX_CONCURRENT_OPS: usize = 8;
pub const IO_TIMEOUT: Duration = Duration::from_secs(30);
pub const MAX_FILE_SIZE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_READ_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_WRITE_BYTES: usize = 2 * 1024 * 1024;
pub const SLOW_OPERATION_MS: u128 = 200;

pub fn read_size_allowed(size: u64) -> bool { size <= MAX_FILE_SIZE_BYTES }
pub fn write_size_allowed(size: usize) -> bool { size <= MAX_WRITE_BYTES }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upstream_limits_are_stable() {
        assert_eq!(MAX_CONCURRENT_OPS, 8);
        assert_eq!(IO_TIMEOUT, Duration::from_secs(30));
        assert!(read_size_allowed(MAX_FILE_SIZE_BYTES));
        assert!(!read_size_allowed(MAX_FILE_SIZE_BYTES + 1));
        assert!(write_size_allowed(MAX_WRITE_BYTES));
        assert!(!write_size_allowed(MAX_WRITE_BYTES + 1));
        assert_eq!(MAX_READ_RESPONSE_BYTES, 2 * 1024 * 1024);
    }
}
