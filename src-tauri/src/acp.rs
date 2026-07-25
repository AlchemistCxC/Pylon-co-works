//! ACP Client — spawn peri.exe as child process, JSON-RPC over stdin/stdout.
//!
//! Architecture: one dedicated reader thread dispatches messages by request_id
//! to per-session channels. No lock contention between concurrent sessions.
//! stderr is drained in a background thread to prevent pipe buffer deadlock.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tokio::sync::{broadcast, mpsc, oneshot};

type Pending = HashMap<u64, oneshot::Sender<RawMessage>>;

pub struct AcpClient {
    child: Child,
    /// mpsc channel for writing JSON-RPC lines to stdin. Single consumer = no lock contention.
    write_tx: mpsc::UnboundedSender<String>,
    next_id: AtomicU64,
    pending: Arc<Mutex<Pending>>,
    /// Broadcast channel for all received messages (responses + notifications).
    pub rx: broadcast::Receiver<RawMessage>,
    tx: broadcast::Sender<RawMessage>,
    /// Set when the child process exits unexpectedly.
    pub crashed: Arc<AtomicBool>,
    /// Agent config for reconnect.
    agent_name: String,
    agent_cwd: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RawMessage {
    pub id: Option<u64>,
    pub method: Option<String>,
    pub result: Option<serde_json::Value>,
    pub params: Option<serde_json::Value>,
    pub error: Option<serde_json::Value>,
}

impl AcpClient {
    /// Send a JSON-RPC request and wait for the matching response.
    async fn call_async(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        // Register oneshot BEFORE writing to stdin
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
            pending.insert(id, tx);
        }

        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let line = serde_json::to_string(&req)
            .map_err(|e| format!("serialize failed: {}", e))?;

        self.write_tx.send(line).map_err(|_| "ACP connection closed".to_string())?;

        let msg = rx.await.map_err(|_| "ACP connection closed".to_string())?;

        if let Some(err) = msg.error {
            return Err(format!("RPC error: {}", err));
        }

        Ok(msg.result.unwrap_or(serde_json::Value::Null))
    }

    /// Create a new session. Returns the session ID.
    pub async fn new_session(&self, cwd: &str) -> Result<String, String> {
        let result = self.call_async("session/new", serde_json::json!({
            "cwd": cwd,
            "mcpServers": []
        })).await?;
        result.get("sessionId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("invalid session/new response: {}", result))
    }

    /// Atomic: allocate ID, register oneshot, then send prompt. No timing hole.
    pub fn send_prompt_atomic(&self, session_id: &str, text: &str) -> Result<(u64, oneshot::Receiver<RawMessage>), String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        // Register oneshot BEFORE writing to stdin
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
            pending.insert(id, tx);
        }

        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": {
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": text}]
            },
        });

        let line = serde_json::to_string(&req)
            .map_err(|e| format!("serialize failed: {}", e))?;

        self.write_tx.send(line).map_err(|_| "ACP connection closed".to_string())?;

        Ok((id, rx))
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
        self.call_async("session/set_mode", serde_json::json!({
            "sessionId": session_id,
            "mode": mode
        })).await
    }

    /// Close a session, releasing agent-side resources (ThreadStore, cancel tokens).
    pub async fn close_session(&self, session_id: &str) -> Result<(), String> {
        self.call_async("session/close", serde_json::json!({
            "sessionId": session_id
        })).await?;
        Ok(())
    }

    /// Send a fire-and-forget notification (no id, no response expected).
    pub fn send_notification(&self, method: &str, params: serde_json::Value) -> Result<(), String> {
        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let line = serde_json::to_string(&req).map_err(|e| format!("serialize failed: {}", e))?;
        self.write_tx.send(line).map_err(|_| "ACP connection closed".to_string())?;
        Ok(())
    }

    /// Cancel a running prompt. Fire-and-forget notification.
    pub fn cancel_session(&self, session_id: &str) -> Result<(), String> {
        self.send_notification("session/cancel", serde_json::json!({
            "sessionId": session_id
        }))
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
                let (write_tx, mut write_rx) = mpsc::unbounded_channel::<String>();
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

                let pending: Arc<Mutex<Pending>> = Arc::new(Mutex::new(HashMap::new()));
                let (tx, rx) = broadcast::channel(256);
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
                            Err(e) => { log::error!("ACP parse: {} — {}", e, &line[..100.min(line.len())]); continue; }
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
                                let mut p = pending_clone.lock().unwrap();
                                if let Some(tx) = p.remove(&id) { let _ = tx.send(raw.clone()); }
                            }
                        }
                        let _ = tx_clone.send(raw);
                    }
                    // stdout closed → child process exited
                    crashed_reader.store(true, Ordering::Relaxed);
                    log::error!("ACP: child process stdout closed (agent crashed)");
                });

                let client = AcpClient {
                    child, write_tx, next_id: AtomicU64::new(1), pending, rx, tx,
                    crashed,
                    agent_name: agent.name.clone(),
                    agent_cwd: agent.cwd.clone(),
                };
                // Initialize
                client.call_async("initialize", serde_json::json!({
                    "protocolVersion": 1, "capabilities": {"tokenStats": true},
                    "clientInfo": {"name": "prism-desktop", "version": "0.1.0"}
                })).await?;
                Ok(client)
            }
            other => Err(format!("unsupported transport: {}", other)),
        }
    }

    /// P1: Load a persisted session — Peri replays history via session/update
    pub async fn load_session(&self, session_id: &str, cwd: &str) -> Result<(), String> {
        self.call_async("session/load", serde_json::json!({
            "sessionId": session_id,
            "cwd": cwd,
        })).await?;
        Ok(())
    }

    /// P1: List persisted sessions from ThreadStore
    pub async fn list_persisted(&self, cwd: Option<&str>) -> Result<serde_json::Value, String> {
        let mut params = serde_json::json!({});
        if let Some(c) = cwd {
            params["cwd"] = serde_json::Value::String(c.to_string());
        }
        self.call_async("session/list", params).await
    }
}
