//! ACP Client — spawn peri.exe as child process, JSON-RPC over stdin/stdout.
//!
//! Architecture: one dedicated reader thread dispatches messages by request_id
//! to per-session channels. No lock contention between concurrent sessions.
//! stderr is drained in a background thread to prevent pipe buffer deadlock.

use std::collections::HashMap;
use std::future::Future;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::{broadcast, mpsc, oneshot};

// ── Constants ──

/// JSON-RPC method names used by the ACP protocol.
pub const METHOD_INITIALIZE: &str = "initialize";
pub const METHOD_SESSION_NEW: &str = "session/new";
pub const METHOD_SESSION_PROMPT: &str = "session/prompt";
pub const METHOD_SESSION_CLOSE: &str = "session/close";
pub const METHOD_SESSION_LOAD: &str = "session/load";
pub const METHOD_SESSION_LIST: &str = "session/list";
pub const METHOD_SESSION_SET_MODE: &str = "session/set_mode";
pub const METHOD_SESSION_SET_CONFIG_OPTION: &str = "session/set_config_option";
pub const METHOD_SESSION_CANCEL: &str = "session/cancel";
pub const NOTIF_SESSION_UPDATE: &str = "session/update";

/// Broadcast channel capacity for ACP message fan-out.
pub const BROADCAST_CAP: usize = 256;
/// mpsc channel capacity for stdin writes — bounded to provide backpressure.
pub const WRITE_CHAN_CAP: usize = 256;
/// Default prompt timeout in seconds.
pub const PROMPT_TIMEOUT_SECS: u64 = 300;
/// Maximum time to wait for Peri's final prompt response after sending cancel.
pub const CANCEL_SETTLE_TIMEOUT_SECS: u64 = 30;

type Pending = HashMap<u64, oneshot::Sender<RawMessage>>;
const PENDING_SHARDS: usize = 16;

pub struct AcpClient {
    child: Child,
    /// mpsc channel for writing JSON-RPC lines to stdin. Single consumer = no lock contention.
    pub(crate) write_tx: mpsc::Sender<String>,
    next_id: AtomicU64,
    pending: Arc<[Mutex<Pending>; PENDING_SHARDS]>,
    /// Broadcast channel for all received messages (responses + notifications).
    pub rx: broadcast::Receiver<RawMessage>,
    /// Set when the child process exits unexpectedly.
    pub crashed: Arc<AtomicBool>,
}

#[derive(Debug, Clone)]
pub struct RawMessage {
    pub id: Option<u64>,
    pub method: Option<String>,
    pub result: Option<serde_json::Value>,
    pub params: Option<serde_json::Value>,
    pub error: Option<serde_json::Value>,
}

#[derive(Debug)]
pub enum PromptWaitOutcome {
    Response(RawMessage),
    CancelledAfterTimeout {
        response: Option<RawMessage>,
        cancel_error: Option<String>,
    },
    ConnectionClosed,
}

/// Wait for a prompt response. On timeout, send session/cancel and keep the
/// response receiver alive until Peri confirms the cancelled turn has settled.
pub async fn wait_prompt_with_cancel<F, Fut>(
    rx: &mut oneshot::Receiver<RawMessage>,
    prompt_timeout: std::time::Duration,
    cancel_settle_timeout: std::time::Duration,
    cancel: F,
) -> PromptWaitOutcome
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    match tokio::time::timeout(prompt_timeout, &mut *rx).await {
        Ok(Ok(raw)) => PromptWaitOutcome::Response(raw),
        Ok(Err(_)) => PromptWaitOutcome::ConnectionClosed,
        Err(_) => {
            let cancel_error = cancel().await.err();
            let response = match tokio::time::timeout(cancel_settle_timeout, &mut *rx).await {
                Ok(Ok(raw)) => Some(raw),
                Ok(Err(_)) | Err(_) => None,
            };
            PromptWaitOutcome::CancelledAfterTimeout {
                response,
                cancel_error,
            }
        }
    }
}

impl AcpClient {
    pub fn remove_pending(&self, id: u64) {
        if let Ok(mut pending) = self.pending_shard(id).lock() {
            pending.remove(&id);
        }
    }

    fn pending_shard(&self, id: u64) -> &Mutex<Pending> {
        &self.pending[id as usize % PENDING_SHARDS]
    }
    /// Send a JSON-RPC request and wait for the matching response.
    async fn call_async(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        // Register oneshot BEFORE writing to stdin
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending_shard(id).lock().map_err(|e| e.to_string())?;
            pending.insert(id, tx);
        }

        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let line = match serde_json::to_string(&req) {
            Ok(line) => line,
            Err(error) => {
                self.remove_pending(id);
                return Err(format!("serialize failed: {}", error));
            }
        };

        if self.write_tx.send(line).await.is_err() {
            self.remove_pending(id);
            return Err("ACP connection closed".to_string());
        }

        let msg = match tokio::time::timeout(std::time::Duration::from_secs(30), rx).await {
            Ok(Ok(msg)) => msg,
            Ok(Err(_)) => return Err("ACP connection closed".to_string()),
            Err(_) => {
                self.remove_pending(id);
                return Err("RPC timeout after 30s".to_string());
            }
        };

        if let Some(err) = msg.error {
            return Err(format!("RPC error: {}", err));
        }

        Ok(msg.result.unwrap_or(serde_json::Value::Null))
    }

    /// Create a new session. Returns full Peri response (sessionId, modes, configOptions).
    pub async fn new_session(&self, cwd: &str) -> Result<serde_json::Value, String> {
        self.call_async(METHOD_SESSION_NEW, serde_json::json!({
            "cwd": cwd,
            "mcpServers": []
        })).await
    }

    /// Extract sessionId from a session/new response.
    pub fn session_id_from(response: &serde_json::Value) -> Result<String, String> {
        response.get("sessionId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("invalid session/new response: {response}"))
    }

    /// Set a session config option (model, thinking_effort, context_1m, mode).
    /// Returns Peri's full configOptionUpdate from the response body.
    pub async fn set_config_option(&self, session_id: &str, key: &str, value: &str) -> Result<serde_json::Value, String> {
        self.call_async(METHOD_SESSION_SET_CONFIG_OPTION, serde_json::json!({
            "sessionId": session_id,
            "configId": key,
            "value": {"valueId": {"value": value}}
        })).await
    }


    /// Prepare a prompt request without writing to stdin.
    pub fn prepare_prompt(&self, session_id: &str, text: &str) -> Result<(u64, String, oneshot::Receiver<RawMessage>), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending_shard(id).lock().map_err(|e| e.to_string())?;
            pending.insert(id, tx);
        }

        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": METHOD_SESSION_PROMPT,
            "params": {
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": text}]
            },
        });

        let line = match serde_json::to_string(&req) {
            Ok(line) => line,
            Err(error) => {
                self.remove_pending(id);
                return Err(format!("serialize failed: {}", error));
            }
        };

        Ok((id, line, rx))
    }

    /// Kill the child process. Called before switching agents to prevent orphans.
    pub fn kill(&mut self) -> Result<(), String> {
        self.child.kill().map_err(|e| format!("kill failed: {}", e))?;
        self.child.wait().map_err(|e| format!("wait failed: {}", e))?;
        Ok(())
    }

    /// Check if the child process has exited unexpectedly.
    pub fn is_crashed(&self) -> bool {
        self.crashed.load(Ordering::Relaxed)
    }

    /// Set session mode.
    pub async fn set_mode(&self, session_id: &str, mode: &str) -> Result<serde_json::Value, String> {
        self.call_async(METHOD_SESSION_SET_MODE, serde_json::json!({
            "sessionId": session_id,
            "modeId": mode
        })).await
    }

    /// Close a session, releasing agent-side resources (ThreadStore, cancel tokens).
    pub async fn close_session(&self, session_id: &str) -> Result<(), String> {
        self.call_async(METHOD_SESSION_CLOSE, serde_json::json!({
            "sessionId": session_id
        })).await?;
        Ok(())
    }

    /// Send a fire-and-forget notification (no id, no response expected).
    pub async fn send_notification(&self, method: &str, params: serde_json::Value) -> Result<(), String> {
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&req).map_err(|e| format!("serialize failed: {}", e))?;
        self.write_tx.send(line).await.map_err(|_| "ACP connection closed".to_string())?;
        Ok(())
    }

    /// Cancel a running prompt. Fire-and-forget notification.
    pub async fn cancel_session(&self, session_id: &str) -> Result<(), String> {
        self.send_notification(METHOD_SESSION_CANCEL, serde_json::json!({
            "sessionId": session_id
        })).await
    }

    /// Connect from AgentDef (P0: replaces hardcoded spawn)
    pub async fn connect(agent: &crate::agent_config::AgentDef) -> Result<Self, String> {
        match agent.transport.as_str() {
            "subprocess" => {
                let mut cmd = Command::new(&agent.exe);
                cmd.args(&agent.args)
                   .stdin(Stdio::piped())
                   .stdout(Stdio::piped())
                   .stderr(Stdio::piped());
                if let Some(cwd) = &agent.cwd {
                    cmd.current_dir(cwd);
                }
                for (k, v) in &agent.env {
                    cmd.env(k, v);
                }
                let mut child = cmd.spawn()
                    .map_err(|e| format!("spawn {} failed: {}", &agent.exe, e))?;

                let stdin = child.stdin.take().ok_or("no stdin")?;
                let (write_tx, mut write_rx) = mpsc::channel::<String>(WRITE_CHAN_CAP);
                // Spawn single-consumer writer task — writes JSON-RPC lines to stdin, with newline
                std::thread::spawn(move || {
                    let mut writer = BufWriter::new(stdin);
                    while let Some(line) = write_rx.blocking_recv() {
                        if writeln!(writer, "{}", line).is_err() { break; }
                        if writer.flush().is_err() { break; }
                    }
                });
                let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);

                // Drain stderr
                let stderr = child.stderr.take().ok_or("no stderr")?;
                let agent_name_stderr = agent.name.clone();
                std::thread::spawn(move || {
                    for line in BufReader::new(stderr).lines() {
                        if let Ok(l) = line { if !l.is_empty() { log::error!("{} stderr: {}", agent_name_stderr, l); } }
                    }
                });

                let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
                    Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
                let (tx, rx) = broadcast::channel(BROADCAST_CAP);
                let crashed = Arc::new(AtomicBool::new(false));

                let pending_clone = pending.clone();
                let tx_clone = tx.clone();
                let crashed_reader = crashed.clone();
                std::thread::spawn(move || {
                    for line in stdout.lines() {
                        let line = match line { Ok(l) => l, Err(_) => break };
                        let line = line.trim().to_string();
                        if line.is_empty() { continue; }
                        let msg_val: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(e) => { log::error!("ACP parse: {} — {}", e, line.chars().take(100).collect::<String>()); continue; }
                        };
                        let raw = RawMessage {
                            id: msg_val.get("id").and_then(|v| v.as_u64()),
                            method: msg_val.get("method").and_then(|v| v.as_str()).map(|s| s.to_string()),
                            result: msg_val.get("result").cloned(),
                            params: msg_val.get("params").cloned(),
                            error: msg_val.get("error").cloned(),
                        };
                        if raw.method.is_none() && raw.id.is_some() {
                            if let Some(id) = raw.id {
                                let shard = &pending_clone[id as usize % PENDING_SHARDS];
                                let mut p = shard.lock().unwrap();
                                if let Some(tx) = p.remove(&id) { let _ = tx.send(raw.clone()); }
                            }
                        }
                        let _ = tx_clone.send(raw);
                    }
                    crashed_reader.store(true, Ordering::Relaxed);
                    pending_clone.iter().for_each(|shard| {
                        if let Ok(mut pending) = shard.lock() {
                            for (_, tx) in pending.drain() {
                                let _ = tx.send(RawMessage {
                                    id: None,
                                    method: None,
                                    result: None,
                                    params: None,
                                    error: Some(serde_json::json!("ACP connection closed")),
                                });
                            }
                        }
                    });
                    log::error!("ACP: child process stdout closed (agent crashed)");
                });

                let client = AcpClient {
                    child, write_tx, next_id: AtomicU64::new(1), pending, rx,
                    crashed,
                };
                // Initialize
                client.call_async(METHOD_INITIALIZE, serde_json::json!({
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "tokenStats": true,
                        "_meta": {
                            "peri.tokenStats": true,
                            "peri.skillNames": true,
                            "peri.replay": true
                        }
                    },
                    "clientInfo": {"name": "Pylon", "version": "0.1.0"}
                })).await?;
                Ok(client)
            }
            other => Err(format!("unsupported transport: {}", other)),
        }
    }

    /// Load a persisted session. Peri replays history before returning the response.
    pub async fn load_session(&self, session_id: &str, cwd: &str) -> Result<serde_json::Value, String> {
        self.call_async(METHOD_SESSION_LOAD, serde_json::json!({
            "sessionId": session_id,
            "cwd": cwd,
        })).await
    }

    /// P1: List persisted sessions from ThreadStore
    pub async fn list_persisted(&self, cwd: Option<&str>) -> Result<serde_json::Value, String> {
        let mut params = serde_json::json!({});
        if let Some(c) = cwd {
            params["cwd"] = serde_json::Value::String(c.to_string());
        }
        self.call_async(METHOD_SESSION_LIST, params).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    fn response() -> RawMessage {
        RawMessage {
            id: Some(1),
            method: None,
            result: Some(serde_json::json!({"stopReason": "cancelled"})),
            params: None,
            error: None,
        }
    }

    #[tokio::test]
    async fn timeout_sends_cancel_and_waits_for_final_response() {
        let (tx, mut rx) = oneshot::channel();
        let cancel_called = Arc::new(AtomicBool::new(false));
        let cancel_called_for_task = cancel_called.clone();

        let outcome = wait_prompt_with_cancel(
            &mut rx,
            std::time::Duration::from_millis(10),
            std::time::Duration::from_millis(200),
            move || async move {
                cancel_called_for_task.store(true, Ordering::SeqCst);
                tx.send(response()).map_err(|_| "receiver closed".to_string())
            },
        )
        .await;

        assert!(cancel_called.load(Ordering::SeqCst));
        match outcome {
            PromptWaitOutcome::CancelledAfterTimeout { response, cancel_error } => {
                assert!(cancel_error.is_none());
                assert_eq!(
                    response.and_then(|raw| raw.result)
                        .and_then(|value| value.get("stopReason").cloned()),
                    Some(serde_json::json!("cancelled"))
                );
            }
            other => panic!("unexpected outcome: {other:?}"),
        }
    }

    #[tokio::test]
    async fn response_before_timeout_does_not_send_cancel() {
        let (tx, mut rx) = oneshot::channel();
        tx.send(response()).expect("receiver must be open");
        let cancel_called = Arc::new(AtomicBool::new(false));
        let cancel_called_for_task = cancel_called.clone();

        let outcome = wait_prompt_with_cancel(
            &mut rx,
            std::time::Duration::from_secs(1),
            std::time::Duration::from_millis(10),
            move || async move {
                cancel_called_for_task.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await;

        assert!(!cancel_called.load(Ordering::SeqCst));
        assert!(matches!(outcome, PromptWaitOutcome::Response(_)));
    }
}
