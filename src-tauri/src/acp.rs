//! ACP Client — spawn peri.exe as child process, JSON-RPC over stdin/stdout.
//!
//! Architecture: one dedicated reader thread dispatches messages by request_id
//! to per-session channels. No lock contention between concurrent sessions.
//! stderr is drained in a background thread to prevent pipe buffer deadlock.

use base64::Engine;
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
pub const NOTIF_AGENT_CRASHED: &str = "pylon:agent-crashed";

/// Broadcast channel capacity for ACP message fan-out.
pub const BROADCAST_CAP: usize = 256;
/// mpsc channel capacity for stdin writes — bounded to provide backpressure.
pub const WRITE_CHAN_CAP: usize = 256;
/// Default prompt timeout in seconds.
pub const PROMPT_TIMEOUT_SECS: u64 = 300;
/// Maximum time to wait for Peri's final prompt response after sending cancel.
pub const CANCEL_SETTLE_TIMEOUT_SECS: u64 = 30;
/// Maximum size for a single attachment.
pub const MAX_ATTACHMENT_BYTES: u64 = 10 * 1024 * 1024;
/// Maximum number of attachments in one prompt.
pub const MAX_ATTACHMENTS: usize = 8;

type Pending = HashMap<u64, oneshot::Sender<RawMessage>>;
const PENDING_SHARDS: usize = 16;

fn connection_closed_message() -> RawMessage {
    RawMessage {
        id: None,
        method: None,
        result: None,
        params: None,
        error: Some(serde_json::json!("ACP connection closed")),
    }
}

fn drain_pending(pending: &Arc<[Mutex<Pending>; PENDING_SHARDS]>) -> usize {
    let mut drained = 0;
    for shard in pending.iter() {
        if let Ok(mut requests) = shard.lock() {
            drained += requests.len();
            for (_, tx) in requests.drain() {
                let _ = tx.send(connection_closed_message());
            }
        }
    }
    drained
}

struct ManagedChild {
    child: Option<Child>,
}

impl ManagedChild {
    fn empty() -> Self {
        Self { child: None }
    }

    fn new(child: Child) -> Self {
        Self { child: Some(child) }
    }

    fn take_stdin(&mut self) -> Result<std::process::ChildStdin, String> {
        self.child
            .as_mut()
            .and_then(|child| child.stdin.take())
            .ok_or_else(|| "no stdin".to_string())
    }

    fn take_stdout(&mut self) -> Result<std::process::ChildStdout, String> {
        self.child
            .as_mut()
            .and_then(|child| child.stdout.take())
            .ok_or_else(|| "no stdout".to_string())
    }

    fn take_stderr(&mut self) -> Result<std::process::ChildStderr, String> {
        self.child
            .as_mut()
            .and_then(|child| child.stderr.take())
            .ok_or_else(|| "no stderr".to_string())
    }

    fn kill_and_wait(&mut self) -> Result<(), String> {
        let Some(mut child) = self.child.take() else {
            return Ok(());
        };
        match child.try_wait() {
            Ok(Some(_)) => Ok(()),
            Ok(None) => {
                child.kill().map_err(|error| format!("kill failed: {error}"))?;
                child.wait().map_err(|error| format!("wait failed: {error}"))?;
                Ok(())
            }
            Err(error) => {
                // try_wait 失败时仍必须继续清理，不能把已取出的 Child
                // 直接丢弃，否则 initialize/switch/Drop 错误路径可能遗留子进程。
                let kill_result = child.kill();
                let wait_result = child.wait();
                match (kill_result, wait_result) {
                    (Ok(()), Ok(_)) => Err(format!("try_wait failed: {error}; child killed and waited")),
                    (kill_error, wait_error) => Err(format!(
                        "try_wait failed: {error}; kill: {}; wait: {}",
                        kill_error.map(|_| "ok".to_string()).unwrap_or_else(|err| err.to_string()),
                        wait_error.map(|_| "ok".to_string()).unwrap_or_else(|err| err.to_string()),
                    )),
                }
            }
        }
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        if let Err(error) = self.kill_and_wait() {
            log::warn!("cleanup ACP child: {}", error);
        }
    }
}

pub struct AcpClient {
    child: ManagedChild,
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
    pub fn disconnected() -> Self {
        let (write_tx, write_rx) = mpsc::channel(1);
        drop(write_rx);
        let (_tx, rx) = broadcast::channel(BROADCAST_CAP);
        Self {
            child: ManagedChild::empty(),
            write_tx,
            next_id: AtomicU64::new(1),
            pending: Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new()))),
            rx,
            crashed: Arc::new(AtomicBool::new(false)),
        }
    }

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
        if self.is_crashed() {
            return Err("ACP connection closed".to_string());
        }
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
            Ok(Err(_)) => {
                self.remove_pending(id);
                return Err("ACP connection closed".to_string());
            }
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
    pub async fn new_session(&self, cwd: &str, mcp_servers: Vec<serde_json::Value>) -> Result<serde_json::Value, String> {
        self.call_async(METHOD_SESSION_NEW, serde_json::json!({
            "cwd": cwd,
            "mcpServers": mcp_servers
        })).await
    }

    /// Extract and validate sessionId from a session/new response.
    pub fn session_id_from(response: &serde_json::Value) -> Result<String, String> {
        let session_id = response.get("sessionId")
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("invalid session/new response: {response}"))?
            .trim();
        if session_id.is_empty() || session_id.eq_ignore_ascii_case("error") {
            return Err(format!("session/new failed: invalid sessionId {session_id:?}"));
        }
        Ok(session_id.to_string())
    }

    /// Validate a session/prompt response and return its stop reason.
    pub fn prompt_stop_reason(response: &serde_json::Value) -> Result<&str, String> {
        let stop_reason = response.get("stopReason")
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("invalid session/prompt response: {response}"))?;
        match stop_reason {
            "end_turn" | "max_turn_requests" => Ok(stop_reason),
            "cancelled" => Err("prompt cancelled".to_string()),
            "refusal" => Err("prompt refused by agent".to_string()),
            other => Err(format!("unsupported prompt stopReason: {other}")),
        }
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


    pub fn prompt_blocks(text: String, attachments: &[String]) -> Result<Vec<serde_json::Value>, String> {
        if attachments.len() > MAX_ATTACHMENTS {
            return Err(format!("too many attachments: maximum is {MAX_ATTACHMENTS}"));
        }
        let mut blocks = vec![serde_json::json!({"type": "text", "text": text})];
        for raw_path in attachments {
            let path = std::path::Path::new(raw_path);
            let metadata = std::fs::metadata(path)
                .map_err(|error| format!("attachment metadata failed for {}: {error}", path.display()))?;
            if !metadata.is_file() {
                return Err(format!("attachment is not a file: {}", path.display()));
            }
            if metadata.len() > MAX_ATTACHMENT_BYTES {
                return Err(format!(
                    "attachment too large: {} is {} bytes, maximum is {} bytes",
                    path.display(), metadata.len(), MAX_ATTACHMENT_BYTES
                ));
            }
            let bytes = std::fs::read(path)
                .map_err(|error| format!("attachment read failed for {}: {error}", path.display()))?;
            let mime = infer::get(&bytes).map(|kind| kind.mime_type());
            match mime {
                Some(mime) if matches!(mime, "image/png" | "image/jpeg" | "image/gif" | "image/webp") => {
                    blocks.push(serde_json::json!({
                        "type": "image",
                        "mimeType": mime,
                        "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                    }));
                }
                Some(mime) if mime.starts_with("text/") => {
                    let content = String::from_utf8(bytes)
                        .map_err(|error| format!("attachment is not valid UTF-8 text {}: {error}", path.display()))?;
                    blocks.push(serde_json::json!({"type": "text", "text": content}));
                }
                None => {
                    let content = String::from_utf8(bytes)
                        .map_err(|_| format!("unsupported attachment type: {}", path.display()))?;
                    blocks.push(serde_json::json!({"type": "text", "text": content}));
                }
                Some(mime) => return Err(format!("unsupported attachment MIME {mime}: {}", path.display())),
            }
        }
        Ok(blocks)
    }

    /// Prepare a prompt request without writing to stdin.
    pub fn prepare_prompt(&self, session_id: &str, prompt: Vec<serde_json::Value>) -> Result<(u64, String, oneshot::Receiver<RawMessage>), String> {
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
                "prompt": prompt
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
        self.child.kill_and_wait()
    }

    /// Check if the child process has exited unexpectedly.
    pub fn is_crashed(&self) -> bool {
        self.crashed.load(Ordering::Relaxed)
    }

    #[cfg(test)]
    fn child_id(&self) -> Option<u32> {
        self.child.child.as_ref().map(Child::id)
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

    /// Connect from AgentDef with optional structured runtime log sink.
    pub async fn connect_with_logs(
        agent: &crate::agent_config::AgentDef,
        runtime_logs: Option<Arc<crate::runtime_log::RuntimeLogHub>>,
    ) -> Result<Self, String> {
        let resolved_agent;
        let agent = if let Some(config_path) = crate::agent_config::config_path() {
            let base_dir = config_path.parent().unwrap_or_else(|| std::path::Path::new("."));
            resolved_agent = agent.resolve_paths(base_dir);
            &resolved_agent
        } else {
            agent
        };
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
                let child = cmd.spawn()
                    .map_err(|e| format!("spawn {} failed: {}", &agent.exe, e))?;
                let mut child = ManagedChild::new(child);

                let stdin = child.take_stdin()?;
                let (write_tx, mut write_rx) = mpsc::channel::<String>(WRITE_CHAN_CAP);
                // Spawn single-consumer writer task — writes JSON-RPC lines to stdin, with newline
                std::thread::spawn(move || {
                    let mut writer = BufWriter::new(stdin);
                    while let Some(line) = write_rx.blocking_recv() {
                        if writeln!(writer, "{}", line).is_err() { break; }
                        if writer.flush().is_err() { break; }
                    }
                });
                let stdout = BufReader::new(child.take_stdout()?);

                // Drain stderr
                let stderr = child.take_stderr()?;
                let agent_name_stderr = agent.name.clone();
                let stderr_logs = runtime_logs.clone();
                std::thread::spawn(move || {
                    for line in BufReader::new(stderr).lines() {
                        if let Ok(l) = line {
                            if !l.is_empty() {
                                log::error!("{} stderr: {}", agent_name_stderr, l);
                                if let Some(hub) = &stderr_logs {
                                    hub.push(crate::runtime_log::timestamp(), "error", "agent-stderr", None, "Agent stderr output", serde_json::Map::from_iter([
                                        ("agent".to_string(), serde_json::Value::String(agent_name_stderr.clone())),
                                    ]));
                                }
                            }
                        }
                    }
                });

                let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
                    Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
                let (tx, rx) = broadcast::channel(BROADCAST_CAP);
                let crashed = Arc::new(AtomicBool::new(false));

                let pending_clone = pending.clone();
                let tx_clone = tx.clone();
                let crashed_reader = crashed.clone();
                let stdout_logs = runtime_logs.clone();
                std::thread::spawn(move || {
                    for line in stdout.lines() {
                        let line = match line { Ok(l) => l, Err(_) => break };
                        let line = line.trim().to_string();
                        if line.is_empty() { continue; }
                        let msg_val: serde_json::Value = match serde_json::from_str(&line) {
                            Ok(v) => v,
                            Err(e) => {
                                log::error!("ACP parse: {}", e);
                                if let Some(hub) = &stdout_logs {
                                    hub.push(crate::runtime_log::timestamp(), "error", "acp", None, "ACP stdout JSON parse error", serde_json::Map::from_iter([
                                        ("error".to_string(), serde_json::Value::String(e.to_string())),
                                    ]));
                                }
                                continue;
                            }
                        };
                        let raw = RawMessage {
                            id: msg_val.get("id").and_then(|v| v.as_u64()),
                            method: msg_val.get("method").and_then(|v| v.as_str()).map(|s| s.to_string()),
                            result: msg_val.get("result").cloned(),
                            params: msg_val.get("params").cloned(),
                            error: msg_val.get("error").cloned(),
                        };
                        let _ = tx_clone.send(raw.clone());
                        if raw.method.is_none() && raw.id.is_some() {
                            if let Some(id) = raw.id {
                                let shard = &pending_clone[id as usize % PENDING_SHARDS];
                                let mut p = shard.lock().unwrap();
                                if let Some(tx) = p.remove(&id) { let _ = tx.send(raw); }
                            }
                        }
                    }
                    crashed_reader.store(true, Ordering::Relaxed);
                    let drained = drain_pending(&pending_clone);
                    log::warn!("ACP: drained {} pending requests after stdout closed", drained);
                    let _ = tx_clone.send(RawMessage {
                        id: None,
                        method: Some(NOTIF_AGENT_CRASHED.to_string()),
                        result: None,
                        params: Some(serde_json::json!({"reason": "stdout_closed"})),
                        error: None,
                    });
                    if let Some(hub) = &stdout_logs {
                        hub.push(crate::runtime_log::timestamp(), "error", "acp", None, "ACP child stdout closed; agent crashed", serde_json::Map::new());
                    }
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

    fn load_session_params(session_id: &str, cwd: &str, mcp_servers: Vec<serde_json::Value>) -> serde_json::Value {
        serde_json::json!({
            "sessionId": session_id,
            "cwd": cwd,
            "mcpServers": mcp_servers
        })
    }

    /// Load a persisted session and collect every replay notification before the response.
    /// The reader publishes notifications before resolving the response pending entry, so
    /// observing the matching response on this receiver is the deterministic replay boundary.
    pub async fn load_session_with_replay(
        &self,
        session_id: &str,
        cwd: &str,
        mcp_servers: Vec<serde_json::Value>,
    ) -> Result<(serde_json::Value, Vec<serde_json::Value>), String> {
        let mut events = self.rx.resubscribe();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, _rx) = oneshot::channel();
        {
            let mut pending = self.pending_shard(id).lock().map_err(|e| e.to_string())?;
            pending.insert(id, tx);
        }
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": METHOD_SESSION_LOAD,
            "params": Self::load_session_params(session_id, cwd, mcp_servers),
        });
        let line = serde_json::to_string(&request).map_err(|error| {
            self.remove_pending(id);
            format!("serialize failed: {error}")
        })?;
        if self.write_tx.send(line).await.is_err() {
            self.remove_pending(id);
            return Err("ACP connection closed".to_string());
        }

        let mut replay = Vec::new();
        loop {
            let raw = match tokio::time::timeout(std::time::Duration::from_secs(30), events.recv()).await {
                Ok(Ok(raw)) => raw,
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(count))) => {
                    self.remove_pending(id);
                    return Err(format!("session/load replay lagged by {count} messages"));
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => {
                    self.remove_pending(id);
                    return Err("ACP notification stream closed during session/load".to_string());
                }
                Err(_) => {
                    self.remove_pending(id);
                    return Err("session/load replay timed out after 30s".to_string());
                }
            };
            if raw.method.as_deref() == Some(NOTIF_SESSION_UPDATE)
                && raw.params.as_ref().and_then(|params| params.get("sessionId")).and_then(|value| value.as_str()) == Some(session_id)
            {
                if let Some(params) = raw.params {
                    replay.push(params);
                }
                continue;
            }
            if raw.id != Some(id) {
                continue;
            }
            if let Some(error) = raw.error {
                self.remove_pending(id);
                return Err(format!("RPC error: {error}"));
            }
            self.remove_pending(id);
            return Ok((raw.result.unwrap_or(serde_json::Value::Null), replay));
        }
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

    #[test]
    fn disconnected_client_is_not_marked_as_crashed() {
        assert!(!AcpClient::disconnected().is_crashed());
    }

    #[test]
    fn session_load_params_include_required_mcp_servers() {
        assert_eq!(
            AcpClient::load_session_params("session-1", "G:/workspace", Vec::new()),
            serde_json::json!({
                "sessionId": "session-1",
                "cwd": "G:/workspace",
                "mcpServers": []
            })
        );
    }

    #[test]
    fn rejects_empty_and_error_session_ids() {
        for session_id in ["", "   ", "error", "ERROR"] {
            let response = serde_json::json!({"sessionId": session_id});
            assert!(AcpClient::session_id_from(&response).is_err());
        }
    }

    #[test]
    fn accepts_valid_session_id_after_trimming_whitespace() {
        let response = serde_json::json!({"sessionId": "  session-42  "});
        assert_eq!(AcpClient::session_id_from(&response).unwrap(), "session-42");
    }

    #[test]
    fn validates_prompt_stop_reasons() {
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "end_turn"})),
            Ok("end_turn")
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "max_turn_requests"})),
            Ok("max_turn_requests")
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "cancelled"}))
                .expect_err("cancelled must not complete normally"),
            "prompt cancelled"
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "refusal"}))
                .expect_err("refusal must not complete normally"),
            "prompt refused by agent"
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({"stopReason": "paused"}))
                .expect_err("unknown stop reason must be rejected"),
            "unsupported prompt stopReason: paused"
        );
        assert_eq!(
            AcpClient::prompt_stop_reason(&serde_json::json!({}))
                .expect_err("missing stop reason must be rejected"),
            "invalid session/prompt response: {}"
        );
    }

    #[test]
    fn prompt_without_attachments_contains_one_text_block() {
        let blocks = AcpClient::prompt_blocks("hello".to_string(), &[]).unwrap();
        assert_eq!(blocks, vec![serde_json::json!({"type": "text", "text": "hello"})]);
    }

    #[test]
    fn prompt_rejects_more_than_maximum_attachments() {
        let attachments = vec!["missing.txt".to_string(); MAX_ATTACHMENTS + 1];
        let error = AcpClient::prompt_blocks("hello".to_string(), &attachments)
            .expect_err("attachment count limit must be enforced before file access");
        assert_eq!(error, format!("too many attachments: maximum is {MAX_ATTACHMENTS}"));
    }

    #[test]
    fn prompt_rejects_missing_attachment_with_explicit_error() {
        let error = AcpClient::prompt_blocks(
            "hello".to_string(),
            &["definitely-missing-pylon-attachment.txt".to_string()],
        )
        .expect_err("missing attachment must fail");
        assert!(error.starts_with("attachment metadata failed for definitely-missing-pylon-attachment.txt:"));
    }

    #[test]
    fn prompt_rejects_directory_attachment() {
        let directory = std::env::temp_dir().join(format!("pylon-attachment-dir-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let error = AcpClient::prompt_blocks("hello".to_string(), &[directory.to_string_lossy().into_owned()])
            .expect_err("directory attachment must fail");
        std::fs::remove_dir_all(&directory).unwrap();
        assert_eq!(error, format!("attachment is not a file: {}", directory.display()));
    }

    #[test]
    fn prompt_rejects_unknown_binary_attachment() {
        let path = std::env::temp_dir().join(format!("pylon-attachment-binary-{}.bin", std::process::id()));
        std::fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
        let error = AcpClient::prompt_blocks("hello".to_string(), &[path.to_string_lossy().into_owned()])
            .expect_err("unknown binary attachment must fail");
        std::fs::remove_file(&path).unwrap();
        assert_eq!(error, format!("unsupported attachment type: {}", path.display()));
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

    #[test]
    fn drain_pending_notifies_every_waiter_and_clears_registry() {
        let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
            Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
        let mut receivers = Vec::new();
        for id in [1_u64, 16, 31] {
            let (tx, rx) = oneshot::channel();
            pending[id as usize % PENDING_SHARDS].lock().unwrap().insert(id, tx);
            receivers.push(rx);
        }

        assert_eq!(drain_pending(&pending), 3);
        assert!(pending.iter().all(|shard| shard.lock().unwrap().is_empty()));
        for receiver in receivers {
            let message = receiver.blocking_recv().expect("EOF should wake pending request");
            assert_eq!(message.error, Some(serde_json::json!("ACP connection closed")));
        }
    }

    #[test]
    fn drain_pending_is_idempotent_after_first_close() {
        let pending: Arc<[Mutex<Pending>; PENDING_SHARDS]> =
            Arc::new(std::array::from_fn(|_| Mutex::new(HashMap::new())));
        assert_eq!(drain_pending(&pending), 0);
        assert_eq!(drain_pending(&pending), 0);
    }

    #[tokio::test]
    async fn fake_acp_subprocess_completes_initialize_new_and_prompt_wire() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'session/new':
        response['result']={'sessionId':'fake-session-1'}
    elif method == 'session/prompt':
        response['result']={'stopReason':'end_turn'}
    print(json.dumps(response), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
        };
        let mut client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP must initialize");
        let child_id = client.child_id().expect("fake ACP child must exist");
        let new_response = client.new_session(".", Vec::new()).await.expect("session/new must succeed");
        assert_eq!(AcpClient::session_id_from(&new_response).unwrap(), "fake-session-1");

        let (request_id, prompt_line, mut response_rx) = client
            .prepare_prompt("fake-session-1", vec![serde_json::json!({"type":"text","text":"hello"})])
            .expect("prompt must serialize");
        assert!(prompt_line.contains("session/prompt"));
        client.write_tx.send(prompt_line).await.expect("fake child stdin must remain open");
        let response = tokio::time::timeout(std::time::Duration::from_secs(2), &mut response_rx)
            .await
            .expect("fake ACP prompt response must arrive")
            .expect("fake ACP prompt pending must settle");
        assert_eq!(response.id, Some(request_id));
        assert_eq!(AcpClient::prompt_stop_reason(&response.result.unwrap()).unwrap(), "end_turn");

        client.kill().expect("explicit child cleanup must succeed");
        assert!(!process_exists(child_id), "fake ACP child must exit after kill_and_wait");
    }

    #[tokio::test]
    async fn fake_acp_eof_drains_pending_requests() {
        let script = r#"import sys
sys.exit(0)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-eof".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
        };
        let client = AcpClient::connect_with_logs(&agent, None).await;
        assert!(client.is_err(), "initialize must fail when fake ACP closes without a response");
    }

    #[tokio::test]
    async fn fake_acp_session_load_collects_replay_before_response() {
        let script = r#"import json,sys
for line in sys.stdin:
    request=json.loads(line)
    method=request.get('method')
    response={'jsonrpc':'2.0','id':request.get('id'),'result':{}}
    if method == 'initialize':
        response['result']={}
    elif method == 'session/load':
        session_id=request['params']['sessionId']
        for text in ['history-1','history-2']:
            print(json.dumps({'jsonrpc':'2.0','method':'session/update','params':{'sessionId':session_id,'update':{'sessionUpdate':'agent_message_chunk','content':{'text':text}}}}), flush=True)
        response['result']={'loaded':True}
    else:
        response['result']={}
    print(json.dumps(response), flush=True)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-replay".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
        };
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("fake ACP replay agent must initialize");
        let (response, replay) = client
            .load_session_with_replay("fake-session-replay", ".", Vec::new())
            .await
            .expect("session/load must return after replay response");
        assert_eq!(response, serde_json::json!({"loaded": true}));
        assert_eq!(replay.len(), 2);
        assert_eq!(replay[0]["update"]["content"]["text"], "history-1");
        assert_eq!(replay[1]["update"]["content"]["text"], "history-2");
    }

    #[tokio::test]
    async fn fake_acp_eof_wakes_pending_request_after_initialize() {
        let script = r#"import json,sys
line=sys.stdin.readline()
request=json.loads(line)
print(json.dumps({'jsonrpc':'2.0','id':request.get('id'),'result':{}}), flush=True)
sys.exit(0)
"#;
        let agent = crate::agent_config::AgentDef {
            name: "fake-acp-eof-after-init".to_string(),
            transport: "subprocess".to_string(),
            exe: "python".to_string(),
            args: vec!["-u".to_string(), "-c".to_string(), script.to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
        };
        let client = AcpClient::connect_with_logs(&agent, None)
            .await
            .expect("initialize response must arrive before EOF");
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                if client.is_crashed() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("fake child EOF must be observed");
        let error = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            client.new_session(".", Vec::new()),
        )
        .await
        .expect("pending request must settle after EOF")
        .expect_err("EOF must reject a new request");
        assert!(error.contains("ACP connection closed"));
    }

    fn process_exists(pid: u32) -> bool {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}
