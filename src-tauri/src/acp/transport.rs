//! ACP 传输层：stdin writer / stdout reader / stderr drain（R10/P3-2 拆分自 acp.rs；
//! 行为零变化）。writer 超时置位 crashed、stdout EOF 经 watch 信号 + drain pending、
//! stderr 持续 drain 防管道缓冲死锁。

use std::collections::HashMap;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{broadcast, mpsc, watch};

use super::jsonrpc::{drain_pending, Pending, PENDING_SHARDS};
use super::request_id::RequestId;
use super::wire_trace::{AcpWireHub, WireDirection};
use super::{AcpError, AcpKind, RawMessage, NOTIF_AGENT_CRASHED};

/// Broadcast channel capacity for ACP message fan-out.
pub const BROADCAST_CAP: usize = 256;
/// Single-consumer Kernel notification inbox. Unlike broadcast, a slow dispatcher
/// applies backpressure instead of silently skipping pre-journal events.
// Large enough to absorb handshake/startup bursts before the runtime installs its
// dispatcher; sustained pressure still propagates back to the agent transport.
pub const NOTIFICATION_CHAN_CAP: usize = 4096;
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

/// ISSUE-17 W1（LR2-WI06）：ACP crash 原因稳定枚举（wire snake_case 字符串）。
/// 禁止用错误文本正则区分 crash 类型（ISSUE-17 禁止事项）——writer 失败/超时/EOF
/// 必须用稳定 code 区分，供 dispatcher 消费 reason 生成用户可读文案并保留诊断字段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashReason {
    /// stdin 写失败（EPIPE/JoinError 等）。
    WriterFailed,
    /// stdin 写超时（agent 存活但不读 stdin）。
    WriterTimeout,
    /// stdout EOF（agent 进程退出/管道关闭）。
    StdoutClosed,
    /// pending 分片锁中毒（保守收敛，fail-closed）。
    PendingLockPoisoned,
}

impl CrashReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            CrashReason::WriterFailed => "writer_failed",
            CrashReason::WriterTimeout => "writer_timeout",
            CrashReason::StdoutClosed => "stdout_closed",
            CrashReason::PendingLockPoisoned => "pending_lock_poisoned",
        }
    }
}

/// 方案 2A：ACP 故障统一结算入口（幂等）。
/// - `crashed=true`（状态快照）；
/// - `crashed_watch` 发 true（可靠最新值通知，dispatcher 依赖它触发自动重连）；
/// - pending drain 一次（返回 drained 数；重复调用 pending 已空返回 0，不 double-resolve）。
///
/// 与 reader EOF 并发时天然幂等：两个结算方先后 drain，第二次无 pending。
/// 不删 AtomicBool + watch 双通道（§4.2）：前者状态快照、后者可靠通知。
/// reason 用于 NOTIF_AGENT_CRASHED 的 payload 区分（writer_failed / stdout_closed），
/// 由调用方以 params 传入，本函数只负责结算核心。
pub(crate) fn fail_connection(
    crashed: &AtomicBool,
    crashed_watch: &watch::Sender<bool>,
    pending: &Arc<[Mutex<Pending>; PENDING_SHARDS]>,
) -> usize {
    crashed.store(true, Ordering::Release);
    let _ = crashed_watch.send(true);
    drain_pending(pending)
}

/// Fan out one inbound message. Notifications first enter the Kernel's bounded
/// single-consumer inbox; broadcast is retained only for replay/RPC observers.
fn fanout_inbound(
    notification_tx: &mpsc::Sender<RawMessage>,
    tx: &broadcast::Sender<RawMessage>,
    raw: RawMessage,
) {
    if raw.kind != AcpKind::Response {
        let _ = notification_tx.blocking_send(raw.clone());
    }
    let _ = tx.send(raw);
}

/// Tag notifications observed inside an active `session/load` request before they enter either
/// the Kernel inbox or the replay observer. ACP itself defines the matching response as the replay
/// boundary; provider-private `_meta.periReplay` is optional and cannot be the authority.
fn classify_active_replay_message(
    raw: &mut RawMessage,
    active_replay_requests: &Arc<Mutex<HashMap<u64, String>>>,
) {
    if raw.kind == AcpKind::Response {
        if let Some(RequestId::Number(request_id)) = raw.id {
            if let Ok(mut requests) = active_replay_requests.lock() {
                requests.remove(&request_id);
            }
        }
        return;
    }
    if raw.kind != AcpKind::SessionUpdate {
        return;
    }
    let Some(params) = raw
        .params
        .as_mut()
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    let Some(session_id) = params
        .get("sessionId")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
    else {
        return;
    };
    let is_active = active_replay_requests
        .lock()
        .map(|requests| requests.values().any(|active| active == &session_id))
        .unwrap_or(false);
    if !is_active {
        return;
    }
    let Some(update) = params
        .get_mut("update")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    let meta = update
        .entry("_meta")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !meta.is_object() {
        *meta = serde_json::Value::Object(serde_json::Map::new());
    }
    if let Some(meta) = meta.as_object_mut() {
        meta.insert("periReplay".to_string(), serde_json::Value::Bool(true));
    }
}

/// G1-05：writer 任务启动（S3 拆分；R4 自 std 线程改 tokio 任务：
/// spawn_blocking + 写超时）。每行经独立的 blocking 段写入并以 write_timeout
/// 竞争超时——agent 不读 stdin 时管道填满，旧 std 线程的 flush 永久阻塞
/// （无超时路径），写通道填满后 send_line 的超时兜底前已有多条命令排队失败。
/// 单消费者 + 逐行等待保证写入顺序不变。超时语义与 send_line 一致。
/// 方案 2A：写超时/EPIPE/JoinError 统一走 fail_connection（crashed + watch +
/// drain + NOTIF_AGENT_CRASHED），不再只置 crashed——writer 故障可被
/// dispatcher 感知，不等下次 EOF；与 reader EOF 并发结算幂等。
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_writer_task(
    stdin: std::process::ChildStdin,
    mut write_rx: mpsc::Receiver<String>,
    crashed: &Arc<AtomicBool>,
    crashed_watch: &watch::Sender<bool>,
    pending: &Arc<[Mutex<Pending>; PENDING_SHARDS]>,
    tx: &broadcast::Sender<RawMessage>,
    notification_tx: mpsc::Sender<RawMessage>,
    write_timeout: u64,
    wire_trace: Option<Arc<AcpWireHub>>,
) -> tokio::task::JoinHandle<()> {
    let writer_crashed = crashed.clone();
    let writer_watch = crashed_watch.clone();
    let writer_pending = pending.clone();
    let writer_tx = tx.clone();
    let writer_notification_tx = notification_tx;
    tokio::task::spawn(async move {
        let stdin_writer = Arc::new(Mutex::new(BufWriter::new(stdin)));
        while let Some(line) = write_rx.recv().await {
            // OBS-01：writer 边界记录 outbound wire（写入前；序列化行解析失败静默跳过）。
            if let Some(trace) = &wire_trace {
                trace.record_line(WireDirection::PylonToAgent, &line);
            }
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
                // EPIPE/JoinError 等写失败 → 统一结算（与 EOF 并发幂等）
                Ok(Ok(Err(_))) | Ok(Err(_)) => {
                    let drained = fail_connection(&writer_crashed, &writer_watch, &writer_pending);
                    tracing::warn!("ACP: writer failed, drained {drained} pending");
                    let raw = RawMessage {
                        id: None,
                        method: Some(NOTIF_AGENT_CRASHED.to_string()),
                        kind: AcpKind::Crashed,
                        result: None,
                        // ISSUE-17 W1：writer 失败与超时必须区分（稳定 code，禁用文本正则）
                        params: Some(
                            serde_json::json!({"reason": CrashReason::WriterFailed.as_str()}),
                        ),
                        error: None,
                    };
                    let _ = writer_notification_tx.send(raw.clone()).await;
                    let _ = writer_tx.send(raw);
                    break;
                }
                // 写超时：agent 存活但不读 stdin，reader 不会收到 EOF——
                // writer 自行统一结算（与 send_line 超时语义一致），
                // 上层快速失败并触发自动重连。
                Err(_) => {
                    tracing::warn!(
                        "ACP writer timeout after {write_timeout}s: connection presumed dead"
                    );
                    let drained = fail_connection(&writer_crashed, &writer_watch, &writer_pending);
                    tracing::warn!("ACP: writer timeout, drained {drained} pending");
                    let raw = RawMessage {
                        id: None,
                        method: Some(NOTIF_AGENT_CRASHED.to_string()),
                        kind: AcpKind::Crashed,
                        result: None,
                        // ISSUE-17 W1：超时必须发 writer_timeout（原误发 writer_failed）
                        params: Some(
                            serde_json::json!({"reason": CrashReason::WriterTimeout.as_str()}),
                        ),
                        error: None,
                    };
                    let _ = writer_notification_tx.send(raw.clone()).await;
                    let _ = writer_tx.send(raw);
                    break;
                }
            }
        }
    })
}

/// LOG-02：stderr 行等级解析（方案书 §5.14 建议等级 + 施工注意）。
///
/// 优先级：
/// 1. 结构化 JSON 的 `level` 字段（权威）——"结构化 JSON stderr 必须优先解析，
///    不能把 JSON 整行当普通 error message"。
/// 2. 非结构化行的不可辩驳致命信号（panic/fatal/uncaught exception/aborting/
///    segmentation fault/core dumped）→ error。
/// 3. 其余普通 stderr 输出 → info（不再默认 error）。
///
/// 施工注意落地：
/// - **不依赖字符串是否包含 "ERROR" 判定严重度**（§5.14）：agent 输出中的 "ERROR" 字样
///   常代表可恢复情况，真实失败也可能不含该字样。进程退出 / RPC error / command result
///   的严重度经结构化 JSON（含 wire error）与 ACP crash/exit 事件承载，本函数不做文本臆测。
/// - 致命信号否定式（non-fatal / nonfatal / not fatal）不得误升 error（LOG-02 CR-101）。
/// - 结构化 JSON 数字 level（pino 惯例 10/20/30/40/50/60）同样权威解析（LOG-02 CR-103）。
/// - 按物理行分类：跨行 pretty-printed JSON 首行无法解析为 Object → 默认 info，属行级
///   读取设计的固有限制（LOG-02 CR-104，行拼接留待评估）。
/// - 返回 hub level 字符串（"error"/"warn"/"info"/"debug"）。
pub(crate) fn classify_stderr_level(line: &str) -> &'static str {
    // 1. 结构化 JSON 优先：`level` 字段权威（字符串 + 数字）
    if let Ok(serde_json::Value::Object(map)) =
        serde_json::from_str::<serde_json::Value>(line.trim())
    {
        if let Some(lv) = map.get("level") {
            if let Some(s) = lv.as_str() {
                return match s.to_ascii_lowercase().as_str() {
                    "error" | "fatal" | "critical" | "panic" => "error",
                    "warn" | "warning" => "warn",
                    "debug" | "trace" => "debug",
                    _ => "info",
                };
            }
            if let Some(n) = lv.as_u64() {
                // CR-103：pino 数字 level（10/20→debug，30→info，40→warn，50/60→error）。
                return match n {
                    10 | 20 => "debug",
                    30 => "info",
                    40 => "warn",
                    50 | 60 => "error",
                    _ => "info",
                };
            }
        }
    }
    // 2. 非结构化行：致命信号否定式先排除（CR-101——"non-fatal" 可辩驳，不得因含
    //    "fatal" 子串误升 error），再匹配不可辩驳致命信号（不依赖 "ERROR" 字样）。
    let lower = line.to_ascii_lowercase();
    const NON_FATAL_MARKERS: [&str; 3] = ["non-fatal", "nonfatal", "not fatal"];
    if NON_FATAL_MARKERS.iter().any(|m| lower.contains(m)) {
        return "info";
    }
    const FATAL_MARKERS: [&str; 6] = [
        "panic",
        "fatal",
        "uncaught exception",
        "aborting",
        "segmentation fault",
        "core dumped",
    ];
    if FATAL_MARKERS.iter().any(|m| lower.contains(m)) {
        return "error";
    }
    // 3. 普通 stderr 输出 → info（不再默认 error）
    "info"
}

/// LOG-03：从结构化 JSON stderr 行提取机器可读错误码（顶层 `code` 字符串字段）。
/// 与 classify_stderr_level 同源——"结构化 JSON stderr 必须优先解析"（§5.14）。
/// 顶层 code 为 agent 自报码（agent 命名空间），与 Pylon wire_code（DEL-05）词汇分离，
/// 不做文本臆测；嵌套 `err.code`/`error.code` 的提取留待后续结构化站点。
pub(crate) fn extract_stderr_code(line: &str) -> Option<String> {
    if let Ok(serde_json::Value::Object(map)) =
        serde_json::from_str::<serde_json::Value>(line.trim())
    {
        if let Some(code) = map.get("code").and_then(|v| v.as_str()) {
            let code = code.trim();
            if !code.is_empty() {
                return Some(code.to_string());
            }
        }
    }
    None
}

/// G1-05：stderr drain 线程启动（S3 拆分；防管道缓冲死锁）。
/// clippy 2026-08-02：读失败即停（map_while）——stderr 一旦读失败后续必失败。
/// OBS-02：correlation 随日志条目进入 hub（统一身份，禁只记 source）。
pub(crate) fn spawn_stderr_reader(
    stderr: std::process::ChildStderr,
    agent_name: &str,
    runtime_logs: &Option<Arc<crate::runtime_log::RuntimeLogHub>>,
    correlation: Option<crate::correlation::RuntimeCorrelation>,
) {
    let agent_name_stderr = agent_name.to_string();
    let stderr_logs = runtime_logs.clone();
    std::thread::spawn(move || {
        for l in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !l.is_empty() {
                let safe = crate::runtime_log::sanitize_message(l.clone());
                // LOG-01：stderr 行回声只作 console/外部日志出口（fmt layer），
                // target 专属标记让 RuntimeLogLayer 跳过——hub 唯一归属下方显式 push，
                // 同一行只进 hub 一次（方案书 §5.14，原 A/B 双写）。
                // LOG-02 同步：echo 级别跟随 classify_stderr_level——agent（Hermes 等）
                // 的 INFO 日志走 stderr，不得顶着 ERROR 帽子；只有真实致命信号才 ERROR。
                // 原实现硬编码 tracing::error! 导致满屏 ERROR agent_stderr_echo（2026-08-19）。
                // 注意：tracing::event! / 各 level 宏的 target 与 level 都进 static callsite，
                // 必须是编译期常量（E0435）——target 用 const 路径、level 用 match 分支。
                match classify_stderr_level(&l) {
                    "error" => tracing::error!(
                        target: crate::runtime_log::AGENT_STDERR_ECHO_TARGET,
                        "{} stderr: {}",
                        agent_name_stderr,
                        safe
                    ),
                    "warn" => tracing::warn!(
                        target: crate::runtime_log::AGENT_STDERR_ECHO_TARGET,
                        "{} stderr: {}",
                        agent_name_stderr,
                        safe
                    ),
                    _ => tracing::info!(
                        target: crate::runtime_log::AGENT_STDERR_ECHO_TARGET,
                        "{} stderr: {}",
                        agent_name_stderr,
                        safe
                    ),
                }
                if let Some(hub) = &stderr_logs {
                    // LOG-02：等级按行解析（结构化 JSON level 优先；非结构化默认 info，
                    // 不依赖 "ERROR" 字样判定严重度）。方案书 §5.14 建议等级。
                    let level = classify_stderr_level(&l);
                    // LOG-03：增量字段——category=stderr（监控窗口可独立筛选原始 stderr，
                    // 与结构化后端日志分离，§5.14"原始 stderr 不应和结构化错误混在默认
                    // 错误列表"）；code=结构化 JSON 顶层 code（agent 自报码，与 DEL-05
                    // wire_code 词汇分离，不发明新码）；rawAvailable=true（真实行文本承载
                    // 于 message，区别于历史 B 型占位符"Agent stderr output"）。
                    hub.push_with_context(
                        crate::time::Timestamp::now(),
                        level,
                        "agent-stderr",
                        None,
                        safe,
                        serde_json::Map::from_iter([(
                            "agent".to_string(),
                            serde_json::Value::String(agent_name_stderr.clone()),
                        )]),
                        correlation.clone(),
                        crate::runtime_log::RuntimeLogContext {
                            code: extract_stderr_code(&l),
                            category: Some(crate::runtime_log::LOG_CATEGORY_STDERR.to_string()),
                            recoverable: None,
                            user_action_required: None,
                            raw_available: Some(true),
                        },
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
    notification_tx: mpsc::Sender<RawMessage>,
    crashed: &Arc<AtomicBool>,
    crashed_watch: &watch::Sender<bool>,
    runtime_logs: &Option<Arc<crate::runtime_log::RuntimeLogHub>>,
    wire_trace: Option<Arc<AcpWireHub>>,
    active_replay_requests: Arc<Mutex<HashMap<u64, String>>>,
) {
    let pending_clone = pending.clone();
    let tx_clone = tx.clone();
    let notification_tx_reader = notification_tx;
    let crashed_reader = crashed.clone();
    let crashed_watch_reader = crashed_watch.clone();
    let stdout_logs = runtime_logs.clone();
    let wire_trace_reader = wire_trace.clone();
    std::thread::spawn(move || {
        // I17 W2（LR2-WI07）：pending 分片锁中毒已用专属 reason 结算 → 跳过 EOF 结算，
        // 避免 StdoutClosed 覆盖 pending_lock_poisoned 诊断（reason 对账一致性）。
        let mut settled_with_reason = false;
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
            // OBS-01：reader 边界记录 inbound wire——必须在 u64 窄化**之前**记录
            // 原始 msg_val，否则 string/null/absent id 形态已经丢失。记录失败静默跳过。
            if let Some(trace) = &wire_trace_reader {
                trace.record(WireDirection::AgentToPylon, &msg_val);
            }
            let method = msg_val
                .get("method")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let mut raw = RawMessage {
                // ACP-01：保留原始 variant（number/string；null/absent → None 不静默当 0）。
                // OBS-01 的 wire trace 已在本行之前记录原始 msg_val——此处收窄不影响取证。
                id: msg_val.get("id").and_then(RequestId::from_json_value),
                kind: AcpKind::from_method(method.as_deref()),
                method,
                result: msg_val.get("result").cloned(),
                params: msg_val.get("params").cloned(),
                error: msg_val.get("error").cloned(),
            };
            classify_active_replay_message(&mut raw, &active_replay_requests);
            // This reader is a dedicated OS thread, so a full Kernel inbox applies
            // transport backpressure without blocking Tokio.
            fanout_inbound(&notification_tx_reader, &tx_clone, raw.clone());
            if raw.method.is_none() {
                // ACP-01：pending 注册表只承载 Pylon 自生成 numeric id——仅 Number
                // variant 结算；string-id 响应（inbound 请求 id）不命中 outbound pending。
                if let Some(RequestId::Number(id)) = raw.id {
                    let shard = &pending_clone[id as usize % PENDING_SHARDS];
                    match shard.lock() {
                        Ok(mut p) => {
                            if let Some(tx) = p.remove(&id) {
                                let _ = tx.send(raw);
                            }
                        }
                        Err(_) => {
                            // I17 W2（LR2-WI07）：锁中毒直接统一结算（crashed + watch +
                            // drain + PendingLockPoisoned 通知）——不只置 crashed，pending/
                            // reconnect 不依赖后续 EOF 才收敛（避免 pending 悬挂到超时）。
                            // 结算后跳出读取循环，EOF 结算被 settled 标志跳过。
                            let drained = fail_connection(
                                &crashed_reader,
                                &crashed_watch_reader,
                                &pending_clone,
                            );
                            tracing::error!(
                                "ACP: pending shard lock poisoned for id {id}, drained {drained}"
                            );
                            fanout_inbound(
                                &notification_tx_reader,
                                &tx_clone,
                                RawMessage {
                                    id: None,
                                    method: Some(NOTIF_AGENT_CRASHED.to_string()),
                                    kind: AcpKind::Crashed,
                                    result: None,
                                    params: Some(serde_json::json!({
                                        "reason": CrashReason::PendingLockPoisoned.as_str()
                                    })),
                                    error: None,
                                },
                            );
                            settled_with_reason = true;
                            break;
                        }
                    }
                }
            }
        }
        // 方案 2A：EOF 结算复用统一入口（crashed + watch + drain，幂等）——
        // 与 writer failure 并发结算时第二次 drain 返回 0，不 double-resolve。
        // I17 W2：锁中毒已用专属 reason 结算时跳过（避免 StdoutClosed 覆盖诊断）。
        if !settled_with_reason {
            let drained = fail_connection(&crashed_reader, &crashed_watch_reader, &pending_clone);
            tracing::warn!(
                "ACP: drained {} pending requests after stdout closed",
                drained
            );
            fanout_inbound(
                &notification_tx_reader,
                &tx_clone,
                RawMessage {
                    id: None,
                    method: Some(NOTIF_AGENT_CRASHED.to_string()),
                    kind: AcpKind::Crashed,
                    result: None,
                    // ISSUE-17 W1：EOF → stdout_closed（稳定 code）
                    params: Some(serde_json::json!({"reason": CrashReason::StdoutClosed.as_str()})),
                    error: None,
                },
            );
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
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_session_load_marks_unlabelled_updates_as_replay_before_fanout() {
        let active = Arc::new(Mutex::new(std::collections::HashMap::from([(
            7,
            "remote-session".to_string(),
        )])));
        let mut raw = RawMessage {
            id: None,
            method: Some(super::super::NOTIF_SESSION_UPDATE.to_string()),
            kind: AcpKind::SessionUpdate,
            result: None,
            params: Some(serde_json::json!({
                "sessionId": "remote-session",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": "replayed answer" }
                }
            })),
            error: None,
        };

        classify_active_replay_message(&mut raw, &active);

        assert_eq!(
            raw.params.as_ref().unwrap()["update"]["_meta"]["periReplay"],
            true,
            "session/load boundary, not provider-private metadata, must classify replay",
        );
    }

    #[test]
    fn inactive_session_update_is_not_reclassified_as_replay() {
        let active = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let mut raw = RawMessage {
            id: None,
            method: Some(super::super::NOTIF_SESSION_UPDATE.to_string()),
            kind: AcpKind::SessionUpdate,
            result: None,
            params: Some(serde_json::json!({
                "sessionId": "remote-session",
                "update": {
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "text": "live answer" }
                }
            })),
            error: None,
        };

        classify_active_replay_message(&mut raw, &active);

        assert!(raw.params.as_ref().unwrap()["update"]
            .get("_meta")
            .is_none());
    }

    #[test]
    fn matching_load_response_closes_replay_boundary_before_the_next_update() {
        let active = Arc::new(Mutex::new(std::collections::HashMap::from([(
            7,
            "remote-session".to_string(),
        )])));
        let mut response = RawMessage {
            id: Some(RequestId::Number(7)),
            method: None,
            kind: AcpKind::Response,
            result: Some(serde_json::json!({"sessionId": "remote-session"})),
            params: None,
            error: None,
        };
        classify_active_replay_message(&mut response, &active);

        let mut live = RawMessage {
            id: None,
            method: Some(super::super::NOTIF_SESSION_UPDATE.to_string()),
            kind: AcpKind::SessionUpdate,
            result: None,
            params: Some(serde_json::json!({
                "sessionId": "remote-session",
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "live"}}
            })),
            error: None,
        };
        classify_active_replay_message(&mut live, &active);

        assert!(active.lock().unwrap().is_empty());
        assert!(live.params.as_ref().unwrap()["update"]
            .get("_meta")
            .is_none());
    }

    #[test]
    fn unrelated_response_does_not_close_an_active_replay_boundary() {
        let active = Arc::new(Mutex::new(std::collections::HashMap::from([(
            7,
            "remote-session".to_string(),
        )])));
        let mut unrelated = RawMessage {
            id: Some(RequestId::Number(99)),
            method: None,
            kind: AcpKind::Response,
            result: Some(serde_json::json!({})),
            params: None,
            error: None,
        };

        classify_active_replay_message(&mut unrelated, &active);

        assert_eq!(
            active.lock().unwrap().get(&7).map(String::as_str),
            Some("remote-session")
        );
    }

    #[test]
    fn one_of_two_same_session_responses_does_not_close_the_other_replay_boundary() {
        let active = Arc::new(Mutex::new(std::collections::HashMap::from([
            (7, "remote-session".to_string()),
            (8, "remote-session".to_string()),
        ])));
        let mut first_response = RawMessage {
            id: Some(RequestId::Number(7)),
            method: None,
            kind: AcpKind::Response,
            result: Some(serde_json::json!({})),
            params: None,
            error: None,
        };
        classify_active_replay_message(&mut first_response, &active);

        let mut between_responses = RawMessage {
            id: None,
            method: Some(super::super::NOTIF_SESSION_UPDATE.to_string()),
            kind: AcpKind::SessionUpdate,
            result: None,
            params: Some(serde_json::json!({
                "sessionId": "remote-session",
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "still replay"}}
            })),
            error: None,
        };
        classify_active_replay_message(&mut between_responses, &active);

        assert_eq!(active.lock().unwrap().len(), 1);
        assert_eq!(
            between_responses.params.as_ref().unwrap()["update"]["_meta"]["periReplay"],
            true
        );
    }

    #[test]
    fn active_replay_for_one_session_does_not_reclassify_another_session() {
        let active = Arc::new(Mutex::new(std::collections::HashMap::from([(
            7,
            "session-a".to_string(),
        )])));
        let mut other_session = RawMessage {
            id: None,
            method: Some(super::super::NOTIF_SESSION_UPDATE.to_string()),
            kind: AcpKind::SessionUpdate,
            result: None,
            params: Some(serde_json::json!({
                "sessionId": "session-b",
                "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "live"}}
            })),
            error: None,
        };

        classify_active_replay_message(&mut other_session, &active);

        assert!(other_session.params.as_ref().unwrap()["update"]
            .get("_meta")
            .is_none());
        assert_eq!(active.lock().unwrap().len(), 1);
    }

    #[test]
    fn rpc_error_response_also_closes_the_matching_replay_boundary() {
        let active = Arc::new(Mutex::new(std::collections::HashMap::from([(
            7,
            "remote-session".to_string(),
        )])));
        let mut response = RawMessage {
            id: Some(RequestId::Number(7)),
            method: None,
            kind: AcpKind::Response,
            result: None,
            params: None,
            error: Some(serde_json::json!({"code": -32000, "message": "load failed"})),
        };

        classify_active_replay_message(&mut response, &active);

        assert!(active.lock().unwrap().is_empty());
    }

    #[test]
    fn crash_reason_wire_codes_are_stable() {
        // ISSUE-17 W1（LR2-WI06）：稳定 code 契约——writer 失败/超时/EOF 必须区分，
        // 禁止用文本正则猜测（old: 写超时误发 "writer_failed" → RED）。
        assert_eq!(CrashReason::WriterFailed.as_str(), "writer_failed");
        assert_eq!(CrashReason::WriterTimeout.as_str(), "writer_timeout");
        assert_eq!(CrashReason::StdoutClosed.as_str(), "stdout_closed");
        assert_eq!(
            CrashReason::PendingLockPoisoned.as_str(),
            "pending_lock_poisoned"
        );
        // 各 code 两两互异（区分度）
        let codes: Vec<&str> = [
            CrashReason::WriterFailed,
            CrashReason::WriterTimeout,
            CrashReason::StdoutClosed,
            CrashReason::PendingLockPoisoned,
        ]
        .iter()
        .map(|r| r.as_str())
        .collect();
        let mut unique = codes.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(codes.len(), unique.len(), "crash reason codes 必须互异");
    }

    #[test]
    fn crash_notification_wire_payload_uses_stable_code() {
        // NOTIF_AGENT_CRASHED 的 params.reason 必须用稳定 code（writer 超时=writer_timeout）
        let payload = |reason: CrashReason| serde_json::json!({ "reason": reason.as_str() });
        assert_eq!(
            payload(CrashReason::WriterTimeout),
            serde_json::json!({ "reason": "writer_timeout" })
        );
        assert_eq!(
            payload(CrashReason::WriterFailed),
            serde_json::json!({ "reason": "writer_failed" })
        );
        assert_eq!(
            payload(CrashReason::StdoutClosed),
            serde_json::json!({ "reason": "stdout_closed" })
        );
    }

    #[test]
    fn kernel_notification_inbox_preserves_messages_when_broadcast_lags() {
        const COUNT: u64 = 64;
        let (notification_tx, mut notification_rx) = mpsc::channel(4);
        let (broadcast_tx, mut broadcast_rx) = broadcast::channel(4);
        let producer = std::thread::spawn(move || {
            for index in 0..COUNT {
                fanout_inbound(
                    &notification_tx,
                    &broadcast_tx,
                    RawMessage {
                        id: None,
                        method: Some(super::super::NOTIF_SESSION_UPDATE.to_string()),
                        kind: AcpKind::SessionUpdate,
                        result: None,
                        params: Some(serde_json::json!({"index": index})),
                        error: None,
                    },
                );
            }
        });

        for expected in 0..COUNT {
            let raw = notification_rx
                .blocking_recv()
                .expect("notification inbox must remain open");
            assert_eq!(raw.params.as_ref().unwrap()["index"], expected);
        }
        producer.join().expect("producer thread");
        assert!(matches!(
            broadcast_rx.try_recv(),
            Err(broadcast::error::TryRecvError::Lagged(_))
        ));
    }

    #[test]
    fn rpc_responses_bypass_kernel_notification_inbox() {
        let (notification_tx, mut notification_rx) = mpsc::channel(1);
        let (broadcast_tx, mut broadcast_rx) = broadcast::channel(1);
        fanout_inbound(
            &notification_tx,
            &broadcast_tx,
            RawMessage {
                id: Some(RequestId::Number(7)),
                method: None,
                kind: AcpKind::Response,
                result: Some(serde_json::json!({"ok": true})),
                params: None,
                error: None,
            },
        );

        assert!(matches!(
            notification_rx.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
        assert_eq!(
            broadcast_rx.try_recv().unwrap().id,
            Some(RequestId::Number(7))
        );
    }

    #[test]
    fn classify_stderr_uses_structured_json_level_first() {
        // LOG-02：结构化 JSON 的 level 字段权威（§5.14"结构化 JSON stderr 必须优先解析"）
        assert_eq!(
            classify_stderr_level(r#"{"level":"error","msg":"db down"}"#),
            "error"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":"warn","msg":"retry"}"#),
            "warn"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":"info","msg":"ready"}"#),
            "info"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":"debug","msg":"detail"}"#),
            "debug"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":"trace","msg":"x"}"#),
            "debug"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":"fatal","msg":"x"}"#),
            "error"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":"warning","msg":"x"}"#),
            "warn"
        );
        // LOG-02 CR-105：critical/panic 与 fatal 同臂，补直接用例锁定。
        assert_eq!(
            classify_stderr_level(r#"{"level":"critical","msg":"x"}"#),
            "error"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":"panic","msg":"x"}"#),
            "error"
        );
    }

    #[test]
    fn classify_stderr_numeric_json_level_follows_pino_convention() {
        // LOG-02 CR-103：结构化 JSON 数字 level（pino 惯例）同样权威解析，
        // 不落入非结构化路径默认 info。
        assert_eq!(
            classify_stderr_level(r#"{"level":50,"msg":"db down"}"#),
            "error"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":60,"msg":"fatal"}"#),
            "error"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":40,"msg":"retry"}"#),
            "warn"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":30,"msg":"ready"}"#),
            "info"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":20,"msg":"detail"}"#),
            "debug"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":10,"msg":"trace"}"#),
            "debug"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":999,"msg":"unknown"}"#),
            "info",
            "未知数字 level 回落 info"
        );
    }

    #[test]
    fn classify_stderr_negated_fatal_phrases_stay_info() {
        // LOG-02 CR-101：致命信号否定式可辩驳，不得因含 "fatal" 子串误升 error。
        assert_eq!(classify_stderr_level("non-fatal error: continuing"), "info");
        assert_eq!(
            classify_stderr_level("the error is not fatal, retrying"),
            "info"
        );
        assert_eq!(classify_stderr_level("nonfatal warning detected"), "info");
        assert_eq!(
            classify_stderr_level("ERROR: non-fatal issue, recoverable"),
            "info"
        );
    }

    #[test]
    fn classify_stderr_level_is_case_insensitive() {
        assert_eq!(
            classify_stderr_level(r#"{"level":"ERROR","msg":"x"}"#),
            "error"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":"Info","msg":"x"}"#),
            "info"
        );
        assert_eq!(
            classify_stderr_level(r#"{"level":"WARN","msg":"x"}"#),
            "warn"
        );
    }

    #[test]
    fn classify_stderr_non_json_lines_default_info_not_error() {
        // LOG-02：普通 stderr 输出不再默认 error；且不依赖 "ERROR" 字样判定严重度
        //（§5.14 施工注意）——含 ERROR/WARNING 字样的普通行不得升 error。
        assert_eq!(classify_stderr_level("fake stderr diagnostic"), "info");
        assert_eq!(classify_stderr_level("loading model weights..."), "info");
        assert_eq!(
            classify_stderr_level("ERROR in module init: missing optional plugin"),
            "info"
        );
        assert_eq!(
            classify_stderr_level("WARNING: optional feature disabled"),
            "info"
        );
    }

    #[test]
    fn classify_stderr_escalates_only_unmistakable_fatal_markers() {
        assert_eq!(
            classify_stderr_level("thread panicked at src/main.rs:12"),
            "error"
        );
        assert_eq!(classify_stderr_level("fatal error: out of memory"), "error");
        assert_eq!(
            classify_stderr_level("uncaught exception: TypeError: x"),
            "error"
        );
        assert_eq!(
            classify_stderr_level("aborting due to previous errors"),
            "error"
        );
        // LOG-02 CR-102：glibc/libc 典型崩溃形态（完成时态 + core dump）补进白名单。
        assert_eq!(classify_stderr_level("Aborted (core dumped)"), "error");
        assert_eq!(
            classify_stderr_level("Segmentation fault (core dumped)"),
            "error"
        );
    }

    #[test]
    fn classify_stderr_json_without_level_falls_back_to_info() {
        // 结构化 JSON 但无 level 字段：不臆测等级（不把 JSON 整行当 error），回落默认 info。
        assert_eq!(
            classify_stderr_level(r#"{"event":"tool_result","name":"read_file"}"#),
            "info"
        );
        assert_eq!(
            classify_stderr_level(r#"{"event":"request","id":5}"#),
            "info"
        );
    }

    #[test]
    fn extract_stderr_code_reads_top_level_code_from_structured_json() {
        // LOG-03：结构化 JSON 顶层 `code`（agent 自报码）→ Some；大小写与空白原样保留。
        assert_eq!(
            extract_stderr_code(r#"{"level":"error","code":"agent_crashed","msg":"x"}"#),
            Some("agent_crashed".to_string())
        );
        assert_eq!(
            extract_stderr_code(r#"{"code":"OOM"}"#),
            Some("OOM".to_string()),
            "code 原样保留，不正规化大小写"
        );
    }

    #[test]
    fn extract_stderr_code_is_none_when_absent_or_invalid() {
        // 无顶层 code / 非字符串 / 空串 / 非 JSON 行 → None（不臆测、不发明码）。
        assert_eq!(
            extract_stderr_code(r#"{"level":"error","msg":"db down"}"#),
            None
        );
        assert_eq!(
            extract_stderr_code(r#"{"code":42}"#),
            None,
            "非字符串 code 不提取"
        );
        assert_eq!(
            extract_stderr_code(r#"{"code":""}"#),
            None,
            "空 code 不提取"
        );
        assert_eq!(
            extract_stderr_code(r#"{"err":{"code":"nested"}}"#),
            None,
            "嵌套 code 留待后续站点"
        );
        assert_eq!(extract_stderr_code("plain stderr line"), None);
        assert_eq!(extract_stderr_code(""), None);
    }
}
