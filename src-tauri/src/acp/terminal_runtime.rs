//! Terminal registry seam adapted from codeg's `terminal_runtime.rs`.
//!
//! This module owns terminal instances and their observable lifecycle. Process
//! creation/response wiring is deliberately supplied by the caller; every
//! instance owns the existing `ManagedChild`, so no second process owner is
//! introduced.

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{watch, Mutex};

use super::terminal_policy::{enforce_output_limit, TerminalCompletion};
use super::ManagedChild;

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
}

impl TerminalInstance {
    fn new(session_id: String, output_limit: usize, child: ManagedChild) -> Arc<Self> {
        let (completion, _) = watch::channel(TerminalCompletion::Running);
        Arc::new(Self {
            session_id,
            output_limit,
            child: Mutex::new(child),
            snapshot: Mutex::new(TerminalSnapshot::default()),
            completion,
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
        self.child
            .lock()
            .await
            .kill_and_wait()
            .map_err(|error| error.to_string())
    }
}

#[derive(Default)]
pub struct TerminalRegistry {
    next_id: Mutex<u64>,
    terminals: Mutex<HashMap<String, Arc<TerminalInstance>>>,
}

impl TerminalRegistry {
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

    pub async fn append_output(
        &self,
        id: &str,
        session_id: &str,
        text: &str,
    ) -> Result<(), String> {
        self.find(id, session_id).await?.append_output(text).await;
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::terminal_policy::TerminalExitStatus;

    #[tokio::test]
    async fn registry_confines_operations_to_session_owner() {
        let registry = TerminalRegistry::default();
        let id = registry
            .insert("session-a".into(), 4, ManagedChild::empty())
            .await;
        assert!(registry.snapshot(&id, "session-b").await.is_err());
        assert!(registry
            .append_output(&id, "session-a", "abcde")
            .await
            .is_ok());
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
}
