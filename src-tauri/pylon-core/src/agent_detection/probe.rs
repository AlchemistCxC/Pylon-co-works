//! 版本探测子进程机器：输出上限 / Windows JobObject / 有界读取 / 探测诊断构造。
use super::types::{AgentDetectionDiagnostic, Startability};
use pylon_foundations::child_command::HideConsoleWindow;
use std::path::Path;
use tokio::io::{AsyncRead, AsyncReadExt};

pub(crate) const PROBE_OUTPUT_LIMIT: usize = 4 * 1024;

// Migrated from codeg `probe_cli_version_token`/`extract_version_token`.
// Keep parsing conservative: only version-looking tokens, never URLs or paths.
pub(crate) fn extract_version_token(text: &str) -> Option<String> {
    fn candidate(piece: &str) -> Option<String> {
        let piece = piece.trim_matches(|c: char| matches!(c, '(' | ')' | ',' | ';' | ':'));
        let value = piece
            .strip_prefix('v')
            .or_else(|| piece.strip_prefix('V'))
            .unwrap_or(piece);
        (value.chars().next().is_some_and(|c| c.is_ascii_digit())
            && value.contains('.')
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')))
        .then(|| value.to_string())
    }
    for line in text.lines() {
        for token in line.split_whitespace() {
            if token.contains("://") {
                continue;
            }
            if let Some(value) = token.split(['/', '@']).find_map(candidate) {
                return Some(value);
            }
        }
    }
    None
}

#[derive(Clone)]
pub(crate) struct VersionProbeOutcome {
    pub(crate) version: Option<String>,
    pub(crate) startability: Startability,
    pub(crate) diagnostic: Option<AgentDetectionDiagnostic>,
}

#[cfg(windows)]
use pylon_foundations::job_object::KillOnCloseJob;

pub(crate) struct ManagedProbeChild {
    child: tokio::process::Child,
    pid: Option<u32>,
    reaped: bool,
    #[cfg(windows)]
    job: Option<KillOnCloseJob>,
}

impl ManagedProbeChild {
    pub(crate) fn new(child: tokio::process::Child) -> Self {
        let pid = child.id();
        #[cfg(windows)]
        let job = Self::attach_job(&child);
        Self {
            child,
            pid,
            reaped: false,
            #[cfg(windows)]
            job,
        }
    }

    // 装配正身在 `pylon_foundations::job_object`（#486 项5 单源）；本函数只保留
    // 探测侧的原契约：静默回退 None（无日志、无诊断），失败由 taskkill 兜底路径接住。
    #[cfg(windows)]
    fn attach_job(child: &tokio::process::Child) -> Option<KillOnCloseJob> {
        // 原实现先建 job 再取 raw handle；`raw_handle()` 为 None 仅发生在子进程
        // 尚未 spawn / 已被收割时（探测路径恒已 spawn），顺序调整无行为差异。
        let process = child.raw_handle()?;
        // SAFETY：句柄取自刚 spawn 的探测子进程，有效且本进程持有完全权限。
        unsafe { KillOnCloseJob::attach_process(process) }.ok()
    }

    pub(crate) fn take_stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.child.stdout.take()
    }

    pub(crate) fn take_stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.child.stderr.take()
    }

    pub(crate) async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let result = self.child.wait().await;
        if result.is_ok() {
            self.reaped = true;
        }
        result
    }

    pub(crate) async fn kill_and_wait(&mut self) {
        if self.reaped {
            return;
        }
        #[cfg(windows)]
        if self.job.take().is_some() {
            let _ = self.child.wait().await;
            self.reaped = true;
            return;
        }
        #[cfg(windows)]
        if let Some(pid) = self.pid {
            let mut command = tokio::process::Command::new("taskkill");
            command
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .hide_console_window();
            let _ = command.output().await;
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid {
            unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        }
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
        self.reaped = true;
    }
}

impl Drop for ManagedProbeChild {
    fn drop(&mut self) {
        // 已收割则无清理；unix 下向进程组发 SIGKILL。Windows 无内联清理路径
        //（job 句柄关闭 + kill_on_drop 兜底），故把 cfg 放在整条语句上、不用
        // 早退 return——Windows 编译下 return 之后无语句，会命中
        // clippy::needless_return（且该 lint 在 CI 的 unix 目标不触发，#331）。
        #[cfg(unix)]
        if !self.reaped {
            if let Some(pid) = self.pid {
                unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
            }
        }
    }
}

pub(crate) async fn read_bounded<R: AsyncRead + Unpin>(mut reader: R) -> std::io::Result<Vec<u8>> {
    let mut retained = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            return Ok(retained);
        }
        let remaining = PROBE_OUTPUT_LIMIT.saturating_sub(retained.len());
        retained.extend_from_slice(&chunk[..count.min(remaining)]);
    }
}

/// 探测阶段的诊断（带被测可执行文件；`candidateId` 由聚合循环补齐——候选 id 依赖
/// 稳定的 (detector, path, args) 指纹，在候选成型处才算得出）。
pub(crate) fn probe_diagnostic(
    detector_id: &str,
    executable: Option<&Path>,
    code: &str,
    message: String,
    retryable: bool,
) -> AgentDetectionDiagnostic {
    AgentDetectionDiagnostic {
        code: code.into(),
        stage: "version_probe".into(),
        detector_id: Some(detector_id.into()),
        candidate_id: None,
        executable: executable.map(|path| path.to_string_lossy().into_owned()),
        message,
        retryable,
    }
}

/// 选择/扫描阶段的诊断：没有候选上下文，两个归因字段恒为 None。
pub(crate) fn scan_diagnostic(
    stage: &str,
    detector_id: Option<String>,
    code: &str,
    message: String,
    retryable: bool,
) -> AgentDetectionDiagnostic {
    AgentDetectionDiagnostic {
        code: code.into(),
        stage: stage.into(),
        detector_id,
        candidate_id: None,
        executable: None,
        message,
        retryable,
    }
}
