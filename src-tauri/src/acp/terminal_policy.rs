//! Upstream terminal runtime limits. Execution and process ownership remain in
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

/// Codeg terminal runtime keeps the newest bytes and never splits UTF-8.
pub fn enforce_output_limit(output: &mut String, limit: usize) -> usize {
    if output.len() <= limit {
        return 0;
    }
    let mut start = output.len().saturating_sub(limit);
    while start < output.len() && !output.is_char_boundary(start) {
        start += 1;
    }
    output.drain(..start);
    start
}

/// Decode complete UTF-8 while retaining an incomplete trailing sequence for
/// the next pipe read; invalid complete bytes use lossy replacement.
pub fn decode_available_utf8(pending: &mut Vec<u8>) -> String {
    let mut output = String::new();
    let mut consumed = 0usize;
    let mut remaining = pending.as_slice();
    while !remaining.is_empty() {
        match std::str::from_utf8(remaining) {
            Ok(text) => {
                output.push_str(text);
                consumed += remaining.len();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    output.push_str(std::str::from_utf8(&remaining[..valid]).unwrap());
                    consumed += valid;
                    remaining = &remaining[valid..];
                }
                match error.error_len() {
                    Some(length) => {
                        output.push_str(&String::from_utf8_lossy(&remaining[..length]));
                        consumed += length;
                        remaining = &remaining[length..];
                    }
                    None => break,
                }
            }
        }
    }
    pending.drain(..consumed);
    output
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFamily {
    PowerShell,
    Cmd,
    Posix,
}

pub fn classify_shell_family(shell: &str) -> ShellFamily {
    let name = std::path::Path::new(shell)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();
    if name == "powershell" || name == "powershell.exe" || name == "pwsh" || name == "pwsh.exe" {
        ShellFamily::PowerShell
    } else if name == "cmd" || name == "cmd.exe" {
        ShellFamily::Cmd
    } else {
        ShellFamily::Posix
    }
}

/// Arguments for codeg's shell wrapper. The command line remains one argv
/// element; callers must pass it to their existing process boundary.
pub fn shell_wrapper_args(shell: &str, line: &str) -> Vec<String> {
    match classify_shell_family(shell) {
        ShellFamily::PowerShell => vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-Command".into(),
            line.into(),
        ],
        ShellFamily::Cmd => vec!["/D".into(), "/S".into(), "/C".into(), line.into()],
        ShellFamily::Posix => vec!["-c".into(), line.into()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn upstream_terminal_limits_and_default_are_stable() {
        assert_eq!(output_limit(None), 1_000_000);
        assert_eq!(output_limit(Some(123)), 123);
        assert_eq!(READER_DRAIN_GRACE, Duration::from_millis(200));
        assert_eq!(KILL_ESCALATE_GRACE, Duration::from_secs(2));
        assert_eq!(KILL_REPORT_BUDGET, Duration::from_secs(5));
        assert_eq!(WAIT_ERROR_BUDGET, Duration::from_secs(30));
    }

    #[test]
    fn output_keeps_newest_utf8_and_decoder_keeps_partial_bytes() {
        let mut output = "old-😀-new".to_owned();
        let dropped = enforce_output_limit(&mut output, 8);
        assert!(dropped > 0 && output == "😀-new");
        let mut pending = vec![0xf0, 0x9f];
        assert_eq!(decode_available_utf8(&mut pending), "");
        pending.extend([0x98, 0x80, b'!']);
        assert_eq!(decode_available_utf8(&mut pending), "😀!");
    }

    #[test]
    fn shell_wrapper_preserves_one_argument_command_shape() {
        assert_eq!(
            classify_shell_family("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
            ShellFamily::PowerShell
        );
        assert_eq!(
            shell_wrapper_args("cmd.exe", "echo hi"),
            vec!["/D", "/S", "/C", "echo hi"]
        );
        assert_eq!(
            shell_wrapper_args("/bin/sh", "printf hi"),
            vec!["-c", "printf hi"]
        );
    }
}
