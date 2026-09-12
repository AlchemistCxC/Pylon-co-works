//! Terminal registry seam adapted from codeg's `terminal_runtime.rs`.
//!
//! This module owns terminal instances and their observable lifecycle. Process
//! creation/response wiring is deliberately supplied by the caller; every
//! instance owns the existing `ManagedChild`, so no second process owner is
//! introduced.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use tokio::sync::{watch, Mutex, Notify};

use super::terminal_policy::{
    decode_available_utf8, default_platform_shell, enforce_output_limit,
    output_limit as resolve_output_limit, shell_wrapper_args, TerminalCompletion,
};
use super::ManagedChild;

const PROCESS_POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(10);

/// Codeg's error-only retry state. A healthy running process has no deadline;
/// after persistent wait errors we publish unknown completion once, but retain
/// the child and keep reaping at the slower idle cadence.
struct WaitRetry {
    deadline: Option<tokio::time::Instant>,
    backoff: std::time::Duration,
    published_unknown: bool,
}

impl Default for WaitRetry {
    fn default() -> Self {
        Self {
            deadline: None,
            backoff: PROCESS_POLL_INTERVAL,
            published_unknown: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TerminalSnapshot {
    pub output: String,
    pub output_base_offset: u64,
    pub truncated: bool,
    pub exit_status: Option<super::terminal_policy::TerminalExitStatus>,
}

struct TerminalInstance {
    session_id: String,
    output_limit: usize,
    child: Mutex<ManagedChild>,
    snapshot: Mutex<TerminalSnapshot>,
    completion: watch::Sender<TerminalCompletion>,
    reader_handles: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    kill: Notify,
}

impl TerminalInstance {
    async fn observe_process_status(
        &self,
        status: Result<Option<std::process::ExitStatus>, super::AcpError>,
        retry: &mut WaitRetry,
        now: tokio::time::Instant,
    ) -> Option<std::time::Duration> {
        use super::terminal_policy::{
            next_wait_retry_backoff, WAIT_ERROR_BUDGET, WAIT_ERROR_IDLE_RETRY,
        };
        match status {
            Ok(Some(status)) => {
                if !retry.published_unknown {
                    self.drain_readers().await;
                    self.mark_exited(super::terminal_policy::map_exit_status(status))
                        .await;
                }
                None
            }
            Ok(None) => {
                // try_wait differs from Codeg's blocking wait: None is a
                // successful observation, not another wait error.
                retry.deadline = None;
                retry.backoff = PROCESS_POLL_INTERVAL;
                Some(if retry.published_unknown {
                    WAIT_ERROR_IDLE_RETRY
                } else {
                    PROCESS_POLL_INTERVAL
                })
            }
            Err(error) => {
                let deadline = *retry.deadline.get_or_insert(now + WAIT_ERROR_BUDGET);
                if !retry.published_unknown && now >= deadline {
                    retry.published_unknown = true;
                    tracing::error!(%error, "terminal wait error budget exhausted; owner continues reaping");
                    self.append_output(
                        "\n[terminal exit status unavailable: could not reap the process]\n",
                    )
                    .await;
                    self.drain_readers().await;
                    self.mark_exited(super::terminal_policy::TerminalExitStatus::default())
                        .await;
                }
                if retry.published_unknown {
                    Some(WAIT_ERROR_IDLE_RETRY)
                } else {
                    retry.backoff = next_wait_retry_backoff(retry.backoff);
                    Some(retry.backoff)
                }
            }
        }
    }
    fn new(session_id: String, output_limit: usize, child: ManagedChild) -> Arc<Self> {
        let (completion, _) = watch::channel(TerminalCompletion::Running);
        Arc::new(Self {
            session_id,
            output_limit,
            child: Mutex::new(child),
            snapshot: Mutex::new(TerminalSnapshot::default()),
            completion,
            reader_handles: Mutex::new(Vec::new()),
            kill: Notify::new(),
        })
    }

    async fn append_output(&self, text: &str) {
        let mut snapshot = self.snapshot.lock().await;
        snapshot.output.push_str(text);
        let removed = enforce_output_limit(&mut snapshot.output, self.output_limit);
        if removed > 0 {
            snapshot.truncated = true;
            snapshot.output_base_offset =
                snapshot.output_base_offset.saturating_add(removed as u64);
        }
    }

    async fn mark_exited(&self, status: super::terminal_policy::TerminalExitStatus) {
        self.snapshot.lock().await.exit_status = Some(status.clone());
        let _ = self
            .completion
            .send_replace(TerminalCompletion::Exited(status));
    }

    async fn drain_readers(&self) {
        let handles = std::mem::take(&mut *self.reader_handles.lock().await);
        for handle in handles {
            let abort = handle.abort_handle();
            if tokio::time::timeout(super::terminal_policy::READER_DRAIN_GRACE, handle)
                .await
                .is_err()
            {
                abort.abort();
            }
        }
    }

    async fn wait_for_exit(&self) -> Result<super::terminal_policy::TerminalExitStatus, String> {
        let mut completion = self.completion.subscribe();
        loop {
            if let Some(status) = completion.borrow_and_update().exit_status().cloned() {
                return Ok(status);
            }
            completion
                .changed()
                .await
                .map_err(|_| "terminal owner ended without exit status".to_string())?;
        }
    }

    async fn kill(&self) -> Result<(), String> {
        if self.completion.borrow().exit_status().is_some() {
            return Ok(());
        }
        self.kill.notify_one();
        tokio::time::timeout(
            super::terminal_policy::KILL_REPORT_BUDGET,
            self.wait_for_exit(),
        )
        .await
        .map_err(|_| "terminal kill report timed out".to_string())??;
        Ok(())
    }
}

#[derive(Default)]
pub struct TerminalRegistry {
    next_id: Mutex<u64>,
    terminals: Mutex<HashMap<String, Arc<TerminalInstance>>>,
}

impl TerminalRegistry {
    pub async fn create_shell(
        &self,
        session_id: String,
        shell: Option<String>,
        line: &str,
        cwd: Option<&Path>,
        output_limit: Option<usize>,
    ) -> Result<String, String> {
        let shell = shell.unwrap_or_else(|| default_platform_shell(None));
        let mut command = std::process::Command::new(&shell);
        command
            .args(shell_wrapper_args(&shell, line))
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        let mut child = ManagedChild::new(command.spawn().map_err(|e| e.to_string())?);
        let stdout = child.take_stdout().map_err(|e| e.to_string())?;
        let stderr = child.take_stderr().map_err(|e| e.to_string())?;
        let limit = resolve_output_limit(output_limit);
        let id = self.insert(session_id, limit, child).await;
        let terminal = self
            .terminals
            .lock()
            .await
            .get(&id)
            .cloned()
            .expect("terminal inserted before readers start");
        let watcher = terminal.clone();
        tokio::spawn(async move {
            let mut poll_delay = PROCESS_POLL_INTERVAL;
            let mut retry = WaitRetry::default();
            loop {
                tokio::select! {
                    _ = watcher.kill.notified() => {
                        let child = {
                            let mut owned = watcher.child.lock().await;
                            std::mem::replace(&mut *owned, ManagedChild::empty())
                        };
                        let _ = tokio::task::spawn_blocking(move || {
                            let mut child = child;
                            let _ = child.terminate_gracefully();
                            std::thread::sleep(super::terminal_policy::KILL_ESCALATE_GRACE);
                            child.kill_and_wait()
                        }).await;
                        watcher.drain_readers().await;
                        watcher.mark_exited(super::terminal_policy::TerminalExitStatus::default()).await;
                        break;
                    }
                    _ = tokio::time::sleep(poll_delay) => {
                        let status = watcher.child.lock().await.try_wait();
                        match watcher.observe_process_status(status, &mut retry, tokio::time::Instant::now()).await {
                            Some(delay) => poll_delay = delay,
                            None => break,
                        }
                    }
                }
            }
        });
        let stdout_reader = spawn_reader(stdout, terminal.clone());
        let stderr_reader = spawn_reader(stderr, terminal.clone());
        terminal
            .reader_handles
            .lock()
            .await
            .extend([stdout_reader, stderr_reader]);
        Ok(id)
    }

    pub async fn insert(
        &self,
        session_id: String,
        output_limit: usize,
        child: ManagedChild,
    ) -> String {
        let mut next = self.next_id.lock().await;
        *next = next.saturating_add(1);
        let id = format!("terminal-{}", *next);
        self.terminals.lock().await.insert(
            id.clone(),
            TerminalInstance::new(session_id, output_limit, child),
        );
        id
    }

    async fn find(&self, id: &str, session_id: &str) -> Result<Arc<TerminalInstance>, String> {
        let terminal = self
            .terminals
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("terminal {id} not found"))?;
        if terminal.session_id != session_id {
            return Err(format!(
                "terminal {id} does not belong to session {session_id}"
            ));
        }
        Ok(terminal)
    }

    pub async fn snapshot(&self, id: &str, session_id: &str) -> Result<TerminalSnapshot, String> {
        Ok(self
            .find(id, session_id)
            .await?
            .snapshot
            .lock()
            .await
            .clone())
    }

    pub async fn wait_for_exit(
        &self,
        id: &str,
        session_id: &str,
    ) -> Result<super::terminal_policy::TerminalExitStatus, String> {
        self.find(id, session_id).await?.wait_for_exit().await
    }

    pub async fn kill(&self, id: &str, session_id: &str) -> Result<(), String> {
        self.find(id, session_id).await?.kill().await
    }

    pub async fn release(&self, id: &str, session_id: &str) -> Result<(), String> {
        let terminal = self.find(id, session_id).await?;
        self.terminals.lock().await.remove(id);
        terminal.kill().await
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    mut reader: R,
    terminal: Arc<TerminalInstance>,
) -> tokio::task::JoinHandle<()> {
    let handle = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        let mut pending = Vec::new();
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = decode_available_utf8(&mut pending);
                    handle.block_on(terminal.append_output(&text));
                }
                Err(_) => break,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::terminal_policy::TerminalExitStatus;

    #[tokio::test]
    async fn healthy_long_running_terminal_has_no_error_deadline() {
        let instance = TerminalInstance::new("session-a".into(), 1024, ManagedChild::empty());
        let mut retry = WaitRetry::default();
        let now = tokio::time::Instant::now();
        for elapsed in [0, 31, 300, 3600] {
            assert_eq!(
                instance
                    .observe_process_status(
                        Ok(None),
                        &mut retry,
                        now + std::time::Duration::from_secs(elapsed)
                    )
                    .await,
                Some(PROCESS_POLL_INTERVAL)
            );
            assert_eq!(*instance.completion.borrow(), TerminalCompletion::Running);
            assert!(retry.deadline.is_none());
        }
    }

    #[tokio::test]
    async fn persistent_wait_errors_back_off_then_publish_unknown_once_and_keep_reaping() {
        use super::super::terminal_policy::{
            WAIT_ERROR_BUDGET, WAIT_ERROR_IDLE_RETRY, WAIT_RETRY_MAX_BACKOFF,
        };
        let instance = TerminalInstance::new("session-a".into(), 1024, ManagedChild::empty());
        let mut retry = WaitRetry::default();
        let now = tokio::time::Instant::now();
        let failure = || Err(super::super::AcpError::Child("injected wait error".into()));
        let mut previous = PROCESS_POLL_INTERVAL;
        for _ in 0..20 {
            let delay = instance
                .observe_process_status(failure(), &mut retry, now)
                .await
                .unwrap();
            assert!(delay >= previous && delay <= WAIT_RETRY_MAX_BACKOFF);
            previous = delay;
            assert_eq!(*instance.completion.borrow(), TerminalCompletion::Running);
        }
        let deadline = now + WAIT_ERROR_BUDGET;
        assert_eq!(
            instance
                .observe_process_status(failure(), &mut retry, deadline)
                .await,
            Some(WAIT_ERROR_IDLE_RETRY)
        );
        assert_eq!(
            instance.wait_for_exit().await.unwrap(),
            TerminalExitStatus::default()
        );
        let output = instance.snapshot.lock().await.output.clone();
        assert!(output.contains("could not reap"));
        assert_eq!(
            instance
                .observe_process_status(failure(), &mut retry, deadline + WAIT_ERROR_IDLE_RETRY)
                .await,
            Some(WAIT_ERROR_IDLE_RETRY)
        );
        assert_eq!(instance.snapshot.lock().await.output, output);
    }

    #[tokio::test]
    async fn successful_poll_resets_transient_wait_error_budget() {
        let instance = TerminalInstance::new("session-a".into(), 1024, ManagedChild::empty());
        let mut retry = WaitRetry::default();
        let now = tokio::time::Instant::now();
        instance
            .observe_process_status(
                Err(super::super::AcpError::Child("transient".into())),
                &mut retry,
                now,
            )
            .await;
        instance
            .observe_process_status(Ok(None), &mut retry, now)
            .await;
        instance
            .observe_process_status(
                Err(super::super::AcpError::Child("later".into())),
                &mut retry,
                now + std::time::Duration::from_secs(60),
            )
            .await;
        assert_eq!(*instance.completion.borrow(), TerminalCompletion::Running);
        assert_eq!(retry.backoff, PROCESS_POLL_INTERVAL * 2);
    }

    #[tokio::test]
    async fn registry_confines_operations_to_session_owner() {
        let registry = TerminalRegistry::default();
        let id = registry
            .insert("session-a".into(), 4, ManagedChild::empty())
            .await;
        assert!(registry.snapshot(&id, "session-b").await.is_err());
        let instance = registry.find(&id, "session-a").await.unwrap();
        instance.append_output("abcde").await;
        let snapshot = registry.snapshot(&id, "session-a").await.unwrap();
        assert_eq!(snapshot.output, "bcde");
        assert_eq!(snapshot.output_base_offset, 1);
    }

    #[tokio::test]
    async fn completion_watch_retains_exit_for_late_waiter() {
        let instance = TerminalInstance::new("session-a".into(), 100, ManagedChild::empty());
        instance.mark_exited(TerminalExitStatus::default()).await;
        assert!(instance.wait_for_exit().await.is_ok());
    }

    #[tokio::test]
    async fn create_shell_drains_output_and_publishes_exit() {
        let registry = TerminalRegistry::default();
        let line = if cfg!(windows) {
            "echo terminal-registry"
        } else {
            "printf terminal-registry"
        };
        let id = registry
            .create_shell("session-a".into(), None, line, None, Some(1024))
            .await
            .unwrap();
        let status = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            registry.wait_for_exit(&id, "session-a"),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(status.exit_code.is_some() || status.signal.is_some());
        let snapshot = registry.snapshot(&id, "session-a").await.unwrap();
        assert!(snapshot.output.contains("terminal-registry"));
    }

    #[tokio::test]
    async fn kill_routes_through_owner_and_release_removes_terminal() {
        let registry = TerminalRegistry::default();
        let line = if cfg!(windows) {
            "ping -n 10 127.0.0.1 > nul"
        } else {
            "sleep 10"
        };
        let id = registry
            .create_shell("session-a".into(), None, line, None, Some(1024))
            .await
            .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            registry.kill(&id, "session-a"),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(registry.release(&id, "session-a").await.is_ok());
        assert!(registry.snapshot(&id, "session-a").await.is_err());
    }
}
