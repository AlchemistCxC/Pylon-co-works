//! ACP 传输层：stdin writer / stdout reader / stderr drain（R10/P3-2 拆分自 acp.rs；
//! 行为零变化）。writer 超时置位 crashed、stdout EOF 经 watch 信号 + drain pending、
//! stderr 持续 drain 防管道缓冲死锁。

use std::io::{BufRead, BufReader, BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, watch};

use super::jsonrpc::{drain_pending, Pending, PENDING_SHARDS};
use super::{AcpError, AcpKind, RawMessage, NOTIF_AGENT_CRASHED};

/// Broadcast channel capacity for ACP message fan-out.
pub const BROADCAST_CAP: usize = 256;
/// mpsc channel capacity for stdin writes — bounded to provide backpressure.
pub const WRITE_CHAN_CAP: usize = 256;
/// Write-channel send timeout. The writer thread blocks on writeln!/flush while the
/// agent is busy reading nothing, filling the mpsc; without a timeout `send().await`
/// hangs forever, breaking the RPC timeout contract above. Timeout is treated as
/// a connection failure (warn + Err). E2 已定：写超时是"连接活性"语义不参数化。
pub const DEFAULT_WRITE_TIMEOUT_SECS: u64 = 10;

/// 写通道发送统一入口：10s 超时防 writer 阻塞击穿超时契约——agent 忙碌不读 stdin
/// 时 writer 线程阻塞在 writeln!/flush，256 容量 mpsc 填满后 send 无限挂起。
/// 超时视为连接故障（warn 日志 + crashed 置位 + Err）：置位后上层快速失败
/// （后续命令立即 ConnectionClosed），dispatcher 收到崩溃通知自动重连。
pub(crate) async fn send_line(
    tx: mpsc::Sender<String>,
    line: String,
    crashed: &Arc<AtomicBool>,
) -> Result<(), AcpError> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(DEFAULT_WRITE_TIMEOUT_SECS),
        tx.send(line),
    )
    .await
    {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => Err(AcpError::ConnectionClosed),
        Err(_) => {
            tracing::warn!(
                "ACP write timeout after {DEFAULT_WRITE_TIMEOUT_SECS}s: connection presumed dead"
            );
            crashed.store(true, Ordering::Release);
            Err(AcpError::WriteTimeout)
        }
    }
}

/// G1-05：writer 任务启动（S3 拆分；R4 自 std 线程改 tokio 任务：
/// spawn_blocking + 写超时）。每行经独立的 blocking 段写入并以 write_timeout
/// 竞争超时——agent 不读 stdin 时管道填满，旧 std 线程的 flush 永久阻塞
/// （无超时路径），写通道填满后 send_line 的超时兜底前已有多条命令排队失败。
/// 单消费者 + 逐行等待保证写入顺序不变。超时语义与 send_line 一致：
/// 置位 crashed 让上层快速失败并触发自动重连。
pub(crate) fn spawn_writer_task(
    stdin: std::process::ChildStdin,
    mut write_rx: mpsc::Receiver<String>,
    crashed: &Arc<AtomicBool>,
    write_timeout: u64,
) -> tokio::task::JoinHandle<()> {
    let writer_crashed = crashed.clone();
    tokio::task::spawn(async move {
        let stdin_writer = Arc::new(Mutex::new(BufWriter::new(stdin)));
        while let Some(line) = write_rx.recv().await {
            let stdin_writer = stdin_writer.clone();
            let write = tokio::task::spawn_blocking(move || {
                let mut guard = match stdin_writer.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                writeln!(guard, "{line}")?;
                guard.flush()
            });
            match tokio::time::timeout(std::time::Duration::from_secs(write_timeout), write).await {
                // 写入成功 → 取下一条
                Ok(Ok(Ok(()))) => {}
                // EPIPE 等写失败 → reader 线程经 EOF 置位 crashed + watch
                Ok(Ok(Err(_))) | Ok(Err(_)) => break,
                // 写超时：agent 存活但不读 stdin，reader 不会收到 EOF——
                // writer 自行置位 crashed（与 send_line 超时语义一致），
                // 上层快速失败并触发自动重连。
                Err(_) => {
                    tracing::warn!(
                        "ACP writer timeout after {write_timeout}s: connection presumed dead"
                    );
                    writer_crashed.store(true, Ordering::Release);
                    break;
                }
            }
        }
    })
}

/// G1-05：stderr drain 线程启动（S3 拆分；防管道缓冲死锁）。
/// clippy 2026-08-02：读失败即停（map_while）——stderr 一旦读失败后续必失败。
pub(crate) fn spawn_stderr_reader(
    stderr: std::process::ChildStderr,
    agent_name: &str,
    runtime_logs: &Option<Arc<crate::runtime_log::RuntimeLogHub>>,
) {
    let agent_name_stderr = agent_name.to_string();
    let stderr_logs = runtime_logs.clone();
    std::thread::spawn(move || {
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !l.is_empty() {
                let safe = crate::runtime_log::sanitize_message(l.clone());
                tracing::error!("{} stderr: {}", agent_name_stderr, safe);
                if let Some(hub) = &stderr_logs {
                    hub.push(
                        crate::time::Timestamp::now(),
                        "error",
                        "agent-stderr",
                        None,
                        "Agent stderr output",
                        serde_json::Map::from_iter([(
                            "agent".to_string(),
                            serde_json::Value::String(agent_name_stderr.clone()),
                        )]),
                    );
                }
            }
        }
    });
}

/// G1-05：stdout reader 线程启动（S3 拆分；行为与原内联实现逐字一致）：
/// 逐行解析 JSON → broadcast 转发 + pending 分片 resolve；EOF → store crashed →
/// watch 信号（A7 可靠投递）→ drain pending → NOTIF_AGENT_CRASHED 广播。
pub(crate) fn spawn_stdout_reader(
    stdout: std::io::BufReader<std::process::ChildStdout>,
    pending: Arc<[Mutex<Pending>; PENDING_SHARDS]>,
    tx: broadcast::Sender<RawMessage>,
    crashed: &Arc<AtomicBool>,
    crashed_watch: &watch::Sender<bool>,
    runtime_logs: &Option<Arc<crate::runtime_log::RuntimeLogHub>>,
) {
    let pending_clone = pending.clone();
    let tx_clone = tx.clone();
    let crashed_reader = crashed.clone();
    let crashed_watch_reader = crashed_watch.clone();
    let stdout_logs = runtime_logs.clone();
    std::thread::spawn(move || {
        for line in stdout.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }
            let msg_val: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(e) => {
                    tracing::error!("ACP parse: {}", e);
                    if let Some(hub) = &stdout_logs {
                        hub.push(
                            crate::time::Timestamp::now(),
                            "error",
                            "acp",
                            None,
                            "ACP stdout JSON parse error",
                            serde_json::Map::from_iter([(
                                "error".to_string(),
                                serde_json::Value::String(e.to_string()),
                            )]),
                        );
                    }
                    continue;
                }
            };
            let method = msg_val
                .get("method")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let raw = RawMessage {
                id: msg_val.get("id").and_then(|v| v.as_u64()),
                kind: AcpKind::from_method(method.as_deref()),
                method,
                result: msg_val.get("result").cloned(),
                params: msg_val.get("params").cloned(),
                error: msg_val.get("error").cloned(),
            };
            let _ = tx_clone.send(raw.clone());
            if raw.method.is_none() {
                if let Some(id) = raw.id {
                    let shard = &pending_clone[id as usize % PENDING_SHARDS];
                    match shard.lock() {
                        Ok(mut p) => {
                            if let Some(tx) = p.remove(&id) {
                                let _ = tx.send(raw);
                            }
                        }
                        Err(_) => {
                            // poison 时无法 resolve pending，标记 crashed 让上层收敛，
                            // 避免读线程 panic 后 pending 悬挂到超时。
                            crashed_reader.store(true, Ordering::Relaxed);
                            tracing::error!("ACP: pending shard lock poisoned for id {id}");
                        }
                    }
                }
            }
        }
        crashed_reader.store(true, Ordering::Relaxed);
        // A7：EOF 崩溃信号经 watch 通道可靠投递——broadcast 在洪泛
        // Lagged 时会丢 NOTIF_AGENT_CRASHED，watch 保留最新值不丢，
        // 自动重连依赖此信号（dispatcher select! 双路监听）。
        let _ = crashed_watch_reader.send(true);
        let drained = drain_pending(&pending_clone);
        tracing::warn!(
            "ACP: drained {} pending requests after stdout closed",
            drained
        );
        let _ = tx_clone.send(RawMessage {
            id: None,
            method: Some(NOTIF_AGENT_CRASHED.to_string()),
            kind: AcpKind::Crashed,
            result: None,
            params: Some(serde_json::json!({"reason": "stdout_closed"})),
            error: None,
        });
        if let Some(hub) = &stdout_logs {
            hub.push(
                crate::time::Timestamp::now(),
                "error",
                "acp",
                None,
                "ACP child stdout closed; agent crashed",
                serde_json::Map::new(),
            );
        }
        tracing::error!("ACP: child process stdout closed (agent crashed)");
    });
}
