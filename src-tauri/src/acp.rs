//! ACP Client — spawn peri.exe as child process, JSON-RPC over stdin/stdout.
//!
//! Architecture: one dedicated reader thread dispatches messages by request_id
//! to per-session channels. No lock contention between concurrent sessions.
//! stderr is drained in a background thread to prevent pipe buffer deadlock.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::{broadcast, oneshot};

type Pending = HashMap<u64, oneshot::Sender<RawMessage>>;

pub struct AcpClient {
    child: Child,
    stdin: Arc<Mutex<BufWriter<std::process::ChildStdin>>>,
    next_id: AtomicU64,
    pending: Arc<Mutex<Pending>>,
    /// Broadcast channel for all received messages (responses + notifications).
    /// send_message subscribers filter by request_id or method.
    pub rx: broadcast::Receiver<RawMessage>,
    tx: broadcast::Sender<RawMessage>,
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
    /// Spawn `peri.exe acp`, perform initialize handshake, start reader + stderr threads.
    pub fn spawn(peri_exe: &str, cwd: &str, model: &str) -> Result<Self, String> {
        let mut child = Command::new(peri_exe)
            .args(["acp", "--cwd", cwd, "--model", model])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn peri.exe failed: {}", e))?;

        let stdin = Arc::new(Mutex::new(BufWriter::new(
            child.stdin.take().ok_or("no stdin")?
        )));

        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?);

        // Drain stderr in background to prevent pipe buffer deadlock
        let stderr = child.stderr.take().ok_or("no stderr")?;
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    if !l.is_empty() {
                        log::error!("peri stderr: {}", l);
                    }
                }
            }
        });

        let pending: Arc<Mutex<Pending>> = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = broadcast::channel(256);

        // Dedicated reader thread — sends all messages to broadcast + routes responses to pending oneshots
        let pending_clone = pending.clone();
        let tx_clone = tx.clone();
        std::thread::spawn(move || {
            for line in stdout.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                let line = line.trim().to_string();
                if line.is_empty() { continue; }

                let msg_val: serde_json::Value = match serde_json::from_str(&line) {
                    Ok(v) => v,
                    Err(e) => {
                        log::error!("ACP parse error: {} — line: {}", e, &line[..100.min(line.len())]);
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

                // Route response to pending oneshot if any
                let is_response = raw.method.is_none() && raw.id.is_some();
                if is_response {
                    if let Some(id) = raw.id {
                        let mut pending = pending_clone.lock().unwrap();
                        if let Some(tx) = pending.remove(&id) {
                            let _ = tx.send(raw.clone());
                        }
                    }
                }

                // Also broadcast to all subscribers
                let _ = tx_clone.send(raw);
            }
        });

        let mut client = AcpClient {
            child,
            stdin,
            next_id: AtomicU64::new(1),
            pending,
            rx,
            tx,
        };

        // ACP initialize
        let response = client.call_sync("initialize", serde_json::json!({
            "protocolVersion": 1,
            "capabilities": {},
            "clientInfo": {"name": "prism-desktop", "version": "0.1.0"}
        }))?;

        let server = response.get("serverInfo").and_then(|s| s.get("name"))
            .and_then(|n| n.as_str()).unwrap_or("unknown");
        log::info!("peri ACP initialized: {}", server);

        Ok(client)
    }

    /// Send a JSON-RPC request and wait for the matching response (synchronous — used for
    /// initialize, session/new, set_mode — not for streaming prompts).
    fn call_sync(&self, method: &str, params: serde_json::Value) -> Result<serde_json::Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });

        let line = serde_json::to_string(&req)
            .map_err(|e| format!("serialize failed: {}", e))?;

        {
            let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
            writeln!(stdin, "{}", line).map_err(|e| format!("write failed: {}", e))?;
            stdin.flush().map_err(|e| format!("flush failed: {}", e))?;
        }

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
            pending.insert(id, tx);
        }

        let msg = tokio::runtime::Handle::current()
            .block_on(rx)
            .map_err(|_| "ACP connection closed".to_string())?;

        if let Some(err) = msg.error {
            return Err(format!("RPC error: {}", err));
        }

        Ok(msg.result.unwrap_or(serde_json::Value::Null))
    }

    /// Create a new session. Returns the session ID.
    pub fn new_session(&self, cwd: &str) -> Result<String, String> {
        let result = self.call_sync("session/new", serde_json::json!({
            "cwd": cwd,
            "mcpServers": {}
        }))?;
        result.get("sessionId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| format!("invalid session/new response: {}", result))
    }

    /// Send a prompt. Returns a request_id that can be used to correlate streaming
    /// notifications. The caller should use `wait_for_prompt` or read from a shared channel.
    pub fn send_prompt(&self, session_id: &str, text: &str) -> Result<u64, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

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

        {
            let mut stdin = self.stdin.lock().map_err(|e| e.to_string())?;
            writeln!(stdin, "{}", line).map_err(|e| format!("write failed: {}", e))?;
            stdin.flush().map_err(|e| format!("flush failed: {}", e))?;
        }

        Ok(id)
    }

    /// Register a oneshot for a given request_id. The reader thread will deliver the final
    /// response to this channel. Notifications are NOT delivered here — those go through
    /// the shared notification path.
    pub fn register_response(&self, request_id: u64) -> Result<oneshot::Receiver<RawMessage>, String> {
        let (tx, rx) = oneshot::channel();
        let mut pending = self.pending.lock().map_err(|e| e.to_string())?;
        pending.insert(request_id, tx);
        Ok(rx)
    }

    /// Set session mode.
    pub fn set_mode(&self, session_id: &str, mode: &str) -> Result<serde_json::Value, String> {
        self.call_sync("session/set_mode", serde_json::json!({
            "sessionId": session_id,
            "mode": mode
        }))
    }
}
