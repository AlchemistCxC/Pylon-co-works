//! A1a：官方 SDK 连接引擎（D1=①）。
//!
//! 本模块只承载**协议栈接缝**：把 `agent-client-protocol 2.2.0` 的连接、字节桥与
//! wire 观测接到 Pylon 既有的 `AcpWireHub` 上。Pylon 的业务纪律（canonical 单一
//! 写者、owner/generation 校验、commit-before-publish）仍由 dispatcher/session 层
//! 负责，本模块不复制第二套状态。
//!
//! 接缝要点（对应施工书 §4/A1a 步骤 2–4）：
//!
//! 1. 进程归属不变：子进程仍由 `ManagedChild`（Windows Job Object）持有，SDK 只做协议；
//! 2. 字节桥：`tokio_util::compat::Compat` 把 tokio 流适配为 futures 流后交给 `ByteStreams`；
//! 3. wire capture：在 SDK 与字节流之间插 `Channel`，用 `Channel::bridge_with_inspection`
//!    逐帧观测后**原样转发**，因此 `id` 的 number/string/null 形态不会被改写
//!    （施工书写作 `Channel::bridge`，实名为 `bridge_with_inspection`，已记台账勘误）；
//! 4. 入站分发走**非类型化** `Dispatch<UntypedMessage, UntypedMessage>`：handler 内
//!    只做转发，不做同步阻塞（施工书 §3 第 9 条）。
//!
//! A1a 步骤 5–7 已接线：`AcpClient::connect_with_logs`（acp/client.rs）经
//! [`spawn_sdk_engine`] 把本模块接入生产路径——SDK 是唯一后端，legacy 传输
//! 已删除（原「接线前仅供测试」的模块级 `allow(dead_code)` 已随之摘除）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::{
    ByteStreams, Channel, Client, ConnectTo, Dispatch, Handled, Responder, UntypedMessage,
};
use tokio::sync::{broadcast, mpsc, oneshot, watch};
use tokio_util::compat::{Compat, TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

use super::client::{ClassifiedMessage, NotificationInbox};
use super::error::AcpError;
use super::wire_trace::{AcpWireCapture, AcpWireHub, WireDirection};
use super::RawMessage;
use std::future::Future;

/// 入站 broadcast 容量（Kernel/replay 扇出；A1c 从 transport.rs 迁入）。
pub const BROADCAST_CAP: usize = 256;
/// 单消费者 Kernel inbox 容量（慢 dispatcher 施加背压而非丢帧）。
pub const NOTIFICATION_CHAN_CAP: usize = 4096;
/// 取消等待超时（秒）——只包住 `wait_prompt_with_recovery` 判死截断后
/// cancel 请求的队列等待，**不保护物理 stdin 写**（SDK Channel 无界、物理写
/// 无超时；#348 A1 词表勘误：原注释「agent 忙碌不读 stdin 时防止无限挂起」
/// 夸大了保护范围）。
pub const DEFAULT_WRITE_TIMEOUT_SECS: u64 = 10;
/// #99：控制帧 inbox 容量（agent 请求/崩溃广播走优先级通道，不被通知洪泛饿死）。
pub const CONTROL_INBOX_CAP: usize = 64;
/// #99：入站 spill 缓冲容量（inbox 满时的有界溢出区；溢出 = 显式过载终态）。
/// inbox(4096) + spill(8192) 构成有界总内存，禁止用无限队列掩盖慢消费者。
pub const INBOUND_SPILL_CAP: usize = 8192;

/// #99：入站投遥测（每连接一份）。
///
/// `next_seq` 是本连接入站帧的单调 ingress ordinal 分配器；spill/drop 计数是
/// 背压的可观测面——任何 drop 都必须显式记录（过载 gap 或下游关闭计数），
/// 禁止静默丢帧。
#[derive(Debug, Default)]
pub struct InboundTelemetry {
    next_seq: AtomicU64,
    spilled_total: AtomicU64,
    dropped_total: AtomicU64,
    closed_dropped: AtomicU64,
    overloaded: AtomicBool,
}

/// 遥测快照（冷挂载/诊断只读投影；serde camelCase）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboundTelemetrySnapshot {
    pub last_ingress_seq: u64,
    pub spilled_total: u64,
    pub dropped_total: u64,
    pub closed_dropped: u64,
    pub overloaded: bool,
}

impl InboundTelemetry {
    pub fn new() -> Self {
        Self::default()
    }

    /// 分配下一个 ingress ordinal（1 起单调递增；调度回调单线程串行调用）。
    fn allocate_seq(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub fn snapshot(&self) -> InboundTelemetrySnapshot {
        InboundTelemetrySnapshot {
            last_ingress_seq: self.next_seq.load(Ordering::Relaxed),
            spilled_total: self.spilled_total.load(Ordering::Relaxed),
            dropped_total: self.dropped_total.load(Ordering::Relaxed),
            closed_dropped: self.closed_dropped.load(Ordering::Relaxed),
            overloaded: self.overloaded.load(Ordering::Acquire),
        }
    }
}

/// 入站帧的目标通道：控制帧（agent 请求/崩溃广播）优先于普通通知。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InboundLane {
    Control,
    Updates,
}

/// spill 缓冲（有界；两个 lane 各自保序）。
#[derive(Debug)]
struct SpillState {
    control: std::collections::VecDeque<ClassifiedMessage>,
    updates: std::collections::VecDeque<ClassifiedMessage>,
    capacity: usize,
}

/// #99：可靠入站投递中继。
///
/// 入站帧必须经本中继进入 Kernel inbox：`try_send` 失败不再是可忽略的日志，
/// 而是转入有界 spill 缓冲由泵任务续投；spill 也满 = 显式过载终态（连接按
/// 崩溃收敛 + `dropped_total` 记录 gap），三选一策略取「spill + 过载终止」，
/// 杜绝静默丢帧（issue #99 方案不变量 §1）。
#[derive(Clone)]
pub struct InboundRelay {
    updates_tx: mpsc::Sender<ClassifiedMessage>,
    control_tx: mpsc::Sender<ClassifiedMessage>,
    spill: Arc<Mutex<SpillState>>,
    wake: Arc<tokio::sync::Notify>,
    pub telemetry: Arc<InboundTelemetry>,
    shutdown: watch::Sender<bool>,
    crashed: Arc<AtomicBool>,
    crashed_watch: watch::Sender<bool>,
}

/// 单帧投递结果（可观测背压的机器可判定面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishOutcome {
    /// 已进入 inbox。
    Published,
    /// inbox 满已转入 spill（泵任务续投；消费端最终收到）。
    Spilled,
    /// spill 溢出：本帧被显式丢弃且已记录 gap，连接将以过载终态收敛。
    Overloaded,
    /// 下游通道已关闭（消费端消失）：帧无法投递，计入 `closed_dropped`
    /// 遥测。连接终止本身由既有 crash/shutdown 路径显式收敛（评审 E7）。
    DroppedClosed,
}

/// #348 A1：崩溃控制帧的唯一构造点——`reason` 走 [`CrashReason`] 稳定词表，
/// 禁止散落手拼 JSON（`terminate_overloaded` 与子侧传输收尾共用）。
fn crash_control_frame(reason: CrashReason) -> ClassifiedMessage {
    ClassifiedMessage::live(RawMessage {
        id: None,
        kind: super::AcpKind::Crashed,
        method: Some(super::NOTIF_AGENT_CRASHED.to_string()),
        result: None,
        params: Some(serde_json::json!({
            "reason": reason.as_str()
        })),
        error: None,
    })
}

/// #348 A1：子侧传输 future 的 Err 分类——[`CrashReason::WriterFailed`]
/// 的唯一产生点。与官方 SDK 2.2.0 实现核对：**干净关闭时传输 future 返回
/// `Ok`**（`try_join!` 两个传输 actor 正常收尾），根本不进入 Err 分支——
/// 防误报的第一道防线是「Ok 不发帧」。SDK 的 `incoming_transport_closed`
/// 标记只为**挂起请求**合成（SentRequest 侧收尾），不会作为传输 future 的
/// Err 出现，故 `None` 臂是防御性代码（生产输入不可达，保留以对冲 SDK 行为
/// 变化）；`Some` 臂覆盖非 EOF 的物理传输错误（stdin 写 EPIPE / stdout 读
/// IO 错误）。
fn transport_failure_reason(error: &agent_client_protocol::Error) -> Option<CrashReason> {
    if agent_client_protocol::is_incoming_transport_closed(error) {
        None
    } else {
        Some(CrashReason::WriterFailed)
    }
}

impl InboundRelay {
    fn lane_of(classified: &ClassifiedMessage) -> InboundLane {
        match classified.raw.kind {
            // 崩溃广播是控制帧（洪泛时不得被 session/update 饿死）。
            super::AcpKind::Crashed => InboundLane::Control,
            // #316：elicitation/complete 同为控制帧（轻量、低频、语义关键）。
            super::AcpKind::ElicitationComplete => InboundLane::Control,
            // 带 id 且带 method = agent 发来的 JSON-RPC 请求（permission/terminal/
            // fs/私有交互）——也是控制帧。Response 不经 inbox（SDK SentRequest 直达）。
            _ if classified.raw.id.is_some() && classified.raw.method.is_some() => {
                InboundLane::Control
            }
            _ => InboundLane::Updates,
        }
    }

    /// 投递一帧：先保证单调 ingress ordinal，再按 lane 入队。
    ///
    /// #99 不变量（结构性保证，调用方无法绕过）：每帧必有 ordinal；
    /// inbox 满转 spill；spill 溢出 = 显式过载终态，绝不静默丢帧。
    /// lane 内严格 FIFO：决策与入队在 spill 锁内原子完成——某 lane 存在
    /// 滞留帧时，该 lane 的新帧一律排到队尾（直发会越过滞留帧送达；
    /// 泵侧以「队首占位直到发送成功」配合，两侧无交错窗口）（评审 E1）。
    fn relay(&self, mut classified: ClassifiedMessage) -> PublishOutcome {
        if classified.ingress_seq == 0 {
            classified.ingress_seq = self.telemetry.allocate_seq();
        }
        let lane = Self::lane_of(&classified);
        let mut spill = self
            .spill
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let lane_has_backlog = match lane {
            InboundLane::Control => !spill.control.is_empty(),
            InboundLane::Updates => !spill.updates.is_empty(),
        };
        let (outcome, first_gap) = if lane_has_backlog {
            Self::spill_enqueue(&mut spill, &self.telemetry, classified, lane)
        } else {
            // 无滞留：锁内直发。`try_send` 非阻塞、不回调，持锁安全；
            // 持锁发送消除「泵已取帧未落通道 + 新帧直发越过」的窗口。
            let send_result = match lane {
                InboundLane::Control => self.control_tx.try_send(classified),
                InboundLane::Updates => self.updates_tx.try_send(classified),
            };
            match send_result {
                Ok(()) => (PublishOutcome::Published, false),
                Err(tokio::sync::mpsc::error::TrySendError::Full(classified)) => {
                    Self::spill_enqueue(&mut spill, &self.telemetry, classified, lane)
                }
                Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
                    self.telemetry.closed_dropped.fetch_add(1, Ordering::AcqRel);
                    (PublishOutcome::DroppedClosed, false)
                }
            }
        };
        drop(spill);
        if first_gap {
            self.terminate_overloaded();
        }
        if outcome == PublishOutcome::Spilled {
            self.wake.notify_one();
        }
        outcome
    }

    /// 锁内入队 spill（容量检查 + 计数）。返回 `(结果, 是否首个过载 gap)`；
    /// 首个 gap 由调用方在**释放锁后**触发过载终态（std Mutex 不可重入，
    /// terminate 内部会再次 relay 崩溃帧）。
    fn spill_enqueue(
        spill: &mut SpillState,
        telemetry: &InboundTelemetry,
        classified: ClassifiedMessage,
        lane: InboundLane,
    ) -> (PublishOutcome, bool) {
        if spill.control.len() + spill.updates.len() >= spill.capacity {
            // 显式 gap：丢弃必须计数；首个 gap 触发过载终态收敛连接，
            // 后续溢出帧只计数（终止流程已启动，不再重复触发）。
            telemetry.dropped_total.fetch_add(1, Ordering::AcqRel);
            let first_gap = !telemetry.overloaded.swap(true, Ordering::AcqRel);
            return (PublishOutcome::Overloaded, first_gap);
        }
        match lane {
            InboundLane::Control => spill.control.push_back(classified),
            InboundLane::Updates => spill.updates.push_back(classified),
        }
        telemetry.spilled_total.fetch_add(1, Ordering::AcqRel);
        (PublishOutcome::Spilled, false)
    }

    /// 过载终态：携带原因的控制帧 + 崩溃信号 + 主动关闭连接。
    ///
    /// 控制帧让 dispatcher 以稳定 code `overloaded` 收敛 turn/UI；crashed 标志
    /// 阻断新出站请求；shutdown 结束 SDK 泵任务、触发传输关闭（EOF 路径随后
    /// 自然收敛）。**reason 修正是 best-effort**：watch 分支可能先以缺省
    /// `stdout_closed` 触发 handle_crash，控制帧随后到达通常会把 reason 修正
    /// 为 `overloaded`（last-write-wins）；极端拥塞下（控制通道 + spill 均满）
    /// 崩溃帧也可能被计入 gap，此时 reason 保持缺省——连接终止由
    /// watch/shutdown 保证，与 reason 无关（评审 E7/E12）。
    fn terminate_overloaded(&self) {
        tracing::error!(
            dropped_total = self.telemetry.dropped_total.load(Ordering::Acquire),
            spilled_total = self.telemetry.spilled_total.load(Ordering::Acquire),
            "acp inbound relay overloaded; terminating connection with explicit gap"
        );
        let _ = self.relay(crash_control_frame(CrashReason::Overloaded));
        self.crashed.store(true, Ordering::Release);
        let _ = self.crashed_watch.send(true);
        let _ = self.shutdown.send(true);
    }

    /// 测试构造：返回 (relay, updates_rx, control_rx, shutdown_rx)。
    /// 生产路径的构造在 `spawn_sdk_engine`（含真实 crash/shutdown 句柄）。
    #[cfg(test)]
    pub fn for_test_with_receivers(
        updates_cap: usize,
        control_cap: usize,
        spill_cap: usize,
    ) -> (
        Self,
        mpsc::Receiver<ClassifiedMessage>,
        mpsc::Receiver<ClassifiedMessage>,
        watch::Receiver<bool>,
    ) {
        let (updates_tx, updates_rx) = mpsc::channel(updates_cap);
        let (control_tx, control_rx) = mpsc::channel(control_cap);
        let (shutdown, shutdown_rx) = watch::channel(false);
        let (crashed_watch, _crashed_rx) = watch::channel(false);
        (
            Self {
                updates_tx,
                control_tx,
                spill: Arc::new(Mutex::new(SpillState {
                    control: std::collections::VecDeque::new(),
                    updates: std::collections::VecDeque::new(),
                    capacity: spill_cap,
                })),
                wake: Arc::new(tokio::sync::Notify::new()),
                telemetry: Arc::new(InboundTelemetry::new()),
                shutdown,
                crashed: Arc::new(AtomicBool::new(false)),
                crashed_watch,
            },
            updates_rx,
            control_rx,
            shutdown_rx,
        )
    }
}

/// #99：spill 续投泵。
///
/// inbox 满时帧进 spill；泵任务在 inbox 有空位后按「控制优先、各自保序」续投。
/// 保序机制（评审 E1）：锁内 **peek 队首并 clone 试发**——帧在成功发送前保持
/// 队首占位，生产者（relay）因此始终看到非空滞留、把新帧排到队尾；
/// 「取出-失败-放回」的重试窗口不复存在。
/// 退出条件（评审 E5/P2-3）：下游通道关闭（滞留帧计入 `closed_dropped`）、
/// shutdown 触发（订阅 watch：空 spill 时现值检查 + changed；重试等待中亦
/// 响应现值——连接收敛后不再向其投递滞留帧）、或过载终态后 spill 排空。
pub fn spawn_inbound_pump(relay: InboundRelay) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut shutdown_rx = relay.shutdown.subscribe();
        let retry = std::time::Duration::from_millis(5);
        loop {
            let attempt = {
                let spill = relay
                    .spill
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let front = if let Some(message) = spill.control.front() {
                    Some((InboundLane::Control, message.clone()))
                } else {
                    spill
                        .updates
                        .front()
                        .map(|message| (InboundLane::Updates, message.clone()))
                };
                match front {
                    None => None,
                    Some((lane, message)) => {
                        // try_send 非阻塞、不回调，持 spill 锁调用安全；
                        // 与 relay 的锁内直发决策互斥，无交错窗口。
                        let result = match lane {
                            InboundLane::Control => relay.control_tx.try_send(message),
                            InboundLane::Updates => relay.updates_tx.try_send(message),
                        };
                        Some((lane, result))
                    }
                }
            };
            match attempt {
                None => {
                    if relay.telemetry.overloaded.load(Ordering::Acquire) {
                        break;
                    }
                    // shutdown 可能在泵首次运行前就已触发（subscribe 之后才
                    // 轮询）——现值检查兜底，changed() 只覆盖其后的变更。
                    if *shutdown_rx.borrow_and_update() {
                        break;
                    }
                    // 等 shutdown / 新 spill 入队；超时兜底重查过载与关闭。
                    tokio::select! {
                        _ = shutdown_rx.changed() => break,
                        _ = relay.wake.notified() => {}
                        _ = tokio::time::sleep(std::time::Duration::from_millis(200)) => {}
                    }
                }
                Some((lane, Ok(()))) => {
                    // 发送成功此刻才真正出队——队首在成功前始终占位，
                    // 生产者据此保持「滞留即排尾」的 FIFO 纪律。
                    let mut spill = relay
                        .spill
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    match lane {
                        InboundLane::Control => {
                            spill.control.pop_front();
                        }
                        InboundLane::Updates => {
                            spill.updates.pop_front();
                        }
                    }
                }
                Some((_, Err(tokio::sync::mpsc::error::TrySendError::Full(_)))) => {
                    // inbox 仍满：帧保持在队首占位，稍候重试（无取放窗口）。
                    // 重试等待同样响应 shutdown——过载终态置位 shutdown 后不再
                    // 把滞留帧继续投进正在收敛的连接（评审 P2-3）。
                    if *shutdown_rx.borrow_and_update() {
                        break;
                    }
                    tokio::time::sleep(retry).await;
                }
                Some((_, Err(tokio::sync::mpsc::error::TrySendError::Closed(_)))) => {
                    // 下游关闭：spill 滞留帧无法投递——显式计数后退出（模块
                    // 不变量：任何 drop 必须可观测，评审 P2-3）。
                    let mut spill = relay
                        .spill
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    let leftover = (spill.control.len() + spill.updates.len()) as u64;
                    spill.control.clear();
                    spill.updates.clear();
                    drop(spill);
                    if leftover > 0 {
                        relay
                            .telemetry
                            .closed_dropped
                            .fetch_add(leftover, Ordering::AcqRel);
                        tracing::warn!(
                            leftover,
                            "acp inbound pump: downstream closed with frames still in spill"
                        );
                    }
                    break;
                }
            }
        }
    })
}

/// SDK 后端（官方 `agent-client-protocol` 连接）的传输状态。
///
/// 出站经有界 `outbound` 队列交给 `cx.spawn` 泵；入站直接产出
/// [`ClassifiedMessage`]，与 legacy 共用同一条 Kernel inbox 语义。
pub struct SdkBackend {
    pub outbound: mpsc::Sender<SdkOutbound>,
    /// D12：Pylon 相关 id 的本地计数器（wire id 永不暴露）。
    pub next_id: Arc<AtomicU64>,
    pub inbound: NotificationInbox,
    /// #99：入站投递遥测（ingress 序列 cursor / spill / 过载 gap 计数）。
    pub telemetry: Arc<InboundTelemetry>,
    /// A1b：入站帧的 replay 观察扇出（legacy `rx` 的对应物）。
    pub replay_events: broadcast::Sender<ClassifiedMessage>,
    /// A1b：进行中的 replay 采集（Pylon id → sessionId），用于把匹配通知标记为 Replay。
    pub active_replay_requests: Arc<Mutex<HashMap<u64, String>>>,
    /// A1b：agent 发来的请求应答器（Pylon request id → Responder），供
    /// `ResponderHandle::Sdk` 在锁外应答。
    pub pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>>,
    pub shutdown: watch::Sender<bool>,
    pub join: Option<tokio::task::JoinHandle<Result<(), agent_client_protocol::Error>>>,
    // A1c：`None` = 断开态（`AcpClient::disconnected()`），无引擎任务可 abort。
}

/// D11：后端中立应答句柄（在锁外使用，避免持锁等待写通道）。
///
/// A1c：legacy 写通道实现已删除；应答统一经引擎登记的 `Responder` 完成。
pub struct ResponderHandle {
    pub pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>>,
}

impl ResponderHandle {
    /// 应答 agent 发来的 JSON-RPC 请求。
    pub async fn respond(self, request_id: super::RequestId, response: serde_json::Value) -> bool {
        let responder = self
            .pending_requests
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&request_id));
        match responder {
            Some(responder) => responder.respond(response).is_ok(),
            None => false,
        }
    }

    /// 以 JSON-RPC error 应答 agent 发来的请求。
    /// #316：错误码由官方 `ErrorCode` 枚举收口（魔数词表消除；wire 数值不变）。
    pub async fn respond_error(
        self,
        request_id: super::RequestId,
        code: agent_client_protocol_schema::v1::ErrorCode,
        message: &str,
    ) -> bool {
        let responder = self
            .pending_requests
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&request_id));
        match responder {
            Some(responder) => responder
                .respond_with_error(agent_client_protocol::Error::new(i32::from(code), message))
                .is_ok(),
            None => false,
        }
    }
}

/// 引擎连接配置（仅用于日志/诊断，不参与 canonical 身份）。
#[derive(Debug, Clone)]
pub struct SdkEngineConfig {
    /// 连接名（SDK 日志用）。
    pub name: String,
    pub wire: Arc<AcpWireHub>,
}

/// D12：`PreparedRpc` 的 SDK 专属状态（`id` 由 facade 持有）。
///
/// `id` 是 **Pylon 相关 id**（本地计数器）；wire id 永不暴露。
pub struct SdkPreparedRpc {
    pub outbound: mpsc::Sender<SdkOutbound>,
    pub method: String,
    pub params: serde_json::Value,
    pub rpc_timeout: std::time::Duration,
}

/// 发送请求行，成功时返回响应接收器。
pub async fn send_keep_rx_prepared(
    prepared: PreparedRpc,
) -> Result<oneshot::Receiver<RawMessage>, AcpError> {
    let pylon_id = prepared.id;
    let sdk = prepared.sdk;
    // A1b：把 SDK 的响应回调转回 `oneshot::Receiver<RawMessage>`，
    // 让 `wait_prompt_with_recovery` 的双超时/cancel/settle 机制原样复用。
    let (ready_tx, ready_rx) = oneshot::channel();
    sdk.outbound
        .send(SdkOutbound::RequestKeepRx {
            method: sdk.method,
            params: sdk.params,
            ready: ready_tx,
        })
        .await
        .map_err(|_| AcpError::ConnectionClosed)?;
    let response_rx = ready_rx.await.map_err(|_| AcpError::ConnectionClosed)??;
    let (out_tx, out_rx) = oneshot::channel();
    tokio::spawn(async move {
        let raw = match response_rx.await {
            Ok(Ok(value)) => RawMessage {
                id: Some(super::RequestId::Number(pylon_id)),
                method: None,
                kind: super::AcpKind::Response,
                result: Some(value),
                params: None,
                error: None,
            },
            Ok(Err(error)) => RawMessage {
                id: Some(super::RequestId::Number(pylon_id)),
                method: None,
                kind: super::AcpKind::Response,
                result: None,
                params: None,
                error: Some(serde_json::json!(error.to_string())),
            },
            Err(_) => return,
        };
        let _ = out_tx.send(raw);
    });
    Ok(out_rx)
}

/// 发送 + 等待匹配响应（SDK 走 outbound 泵）。
pub async fn complete_prepared(prepared: PreparedRpc) -> Result<serde_json::Value, AcpError> {
    let sdk = prepared.sdk;
    let (reply_tx, reply_rx) = oneshot::channel();
    sdk.outbound
        .send(SdkOutbound::Request {
            method: sdk.method,
            params: sdk.params,
            reply: reply_tx,
        })
        .await
        .map_err(|_| AcpError::ConnectionClosed)?;
    match tokio::time::timeout(sdk.rpc_timeout, reply_rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(AcpError::ConnectionClosed),
        Err(_) => Err(AcpError::RpcTimeout),
    }
}

/// 启动子进程（两后端共用）：preflight + `LaunchPlan` + `ManagedChild`。
///
/// A2：exe/args/cwd/env 全部来自 `plan_launch` 产出的 `LaunchPlan`，本函数不再
/// 内联拼装任何 provider 差异；唯一保留的 provider 侧步骤是托管运行时适配器
/// （需现查 PATH/Git Bash，无法离线进 plan），它在 plan 应用之后以显式适配器
/// 形式运行，不再是 spawn 代码内散落的 provider 分支。
///
/// 进程归属不变（Windows Job Object / taskkill / Drop 均在 `ManagedChild`）。
pub async fn spawn_agent_child(
    agent: &pylon_core::agent_config::AgentDef,
    base_dir: Option<&std::path::Path>,
) -> Result<super::ManagedChild, AcpError> {
    use std::process::{Command, Stdio};

    if (agent.exe.contains('/') || agent.exe.contains('\\'))
        && !std::path::Path::new(&agent.exe).is_file()
    {
        return Err(super::error::AgentConnectFailure::preflight(
            "agent_executable_missing",
            format!(
                "agent {} 的 exe 路径不存在：{}（请在 设置 → Agent 中修改 agents.yaml 配置）",
                agent.name, agent.exe
            ),
        )
        .into());
    }
    let hermes_runtime = pylon_core::hermes::runtime::prepare(agent)
        .await
        .map_err(|error| super::error::AgentConnectFailure::preflight(error.code, error.message))?;
    // 托管运行时要现查 PATH 与 Git Bash，无法离线进入 plan；它作为显式的运行时
    // 适配器在 plan 之后应用。plan 仍拥有 argv/cwd/per-agent env/HERMES_HOME。
    let plan = super::launch_plan::plan_for_agent(agent, base_dir, &Default::default(), Vec::new())
        .map_err(|error| {
            super::error::AgentConnectFailure::preflight(
                "agent_launch_plan_invalid",
                error.to_string(),
            )
        })?;
    for diagnostic in &plan.diagnostics {
        tracing::debug!(
            provider = %plan.provider,
            owner_key = %plan.owner_key,
            code = %diagnostic.code,
            "agent launch plan: {}",
            diagnostic.message
        );
    }
    let mut cmd = Command::new(&plan.executable);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // #348 A3：Windows 上隐藏 agent 控制台窗口（与 preflight 探针同纪律）。
    super::process::hide_console_window(&mut cmd);
    super::launch_plan::apply_launch_plan(&mut cmd, &plan);
    if let Some(selection) = hermes_runtime.as_ref() {
        pylon_core::hermes::runtime::apply_to_command(&mut cmd, agent, selection);
    }
    let child = cmd
        .spawn()
        .map_err(|error| super::error::AgentConnectFailure::spawn(&agent.exe, error))?;
    Ok(super::ManagedChild::new(child))
}

/// D12：SDK 后端的 `PreparedRpc` 构造（本地计数器分配 Pylon id，wire id 永不暴露）。
pub fn prepared_sdk_rpc(
    sdk: &SdkBackend,
    method: &str,
    params: serde_json::Value,
    rpc_timeout_secs: u64,
) -> Result<PreparedRpc, AcpError> {
    let id = sdk.next_id.fetch_add(1, Ordering::Relaxed);
    Ok(PreparedRpc {
        id,
        sdk: SdkPreparedRpc {
            outbound: sdk.outbound.clone(),
            method: method.to_string(),
            params,
            rpc_timeout: std::time::Duration::from_secs(rpc_timeout_secs),
        },
    })
}

/// 一条出站请求/通知（由 Pylon 既有 `prepare_rpc`/`prepare_prompt` 语义产生）。
///
/// SDK 的 dispatch loop 是单任务串行，因此出站一律经 `cx.spawn` 在独立任务中发送；
/// 本类型只承载「方法 + 参数 + 应答通道」，不复制 Pylon 的 pending 表。
pub enum SdkOutbound {
    /// 需要响应的 JSON-RPC 请求（非类型化）。
    Request {
        method: String,
        params: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<Result<serde_json::Value, AcpError>>,
    },
    /// A1b：发送后把响应接收器交回调用方（prompt 等待/取消语义复用 legacy 机制）。
    RequestKeepRx {
        method: String,
        params: serde_json::Value,
        ready: tokio::sync::oneshot::Sender<
            Result<tokio::sync::oneshot::Receiver<Result<serde_json::Value, AcpError>>, AcpError>,
        >,
    },
    /// 不需要响应的 JSON-RPC 通知。
    Notification {
        method: String,
        params: serde_json::Value,
        reply: tokio::sync::oneshot::Sender<Result<(), AcpError>>,
    },
}

/// SDK 错误 → Pylon `AcpError`。
///
/// 四个 Pylon 独有变体（`ReplayTimeout`/`ReplayLagged`/`ReplayStreamClosed`/
/// `ReplayLoadInProgress`）由 Pylon 侧合成，不由 SDK 映射而来（施工书 A1-C6）。
pub fn map_sdk_error(error: agent_client_protocol::Error) -> AcpError {
    if agent_client_protocol::is_incoming_transport_closed(&error) {
        return AcpError::ConnectionClosed;
    }
    // 与 legacy 一致：把 JSON-RPC error 对象序列化为文本，下游
    // `AgentConnectFailure::initialize` 才能提取 `code`/`message`（远端 code 不丢）。
    match serde_json::to_string(&error) {
        Ok(raw) => AcpError::Rpc(raw),
        Err(_) => AcpError::Rpc(error.to_string()),
    }
}

/// SDK wire request id → Pylon `RequestId`（null/absent → None）。
fn sdk_request_id_to_pylon(
    id: &agent_client_protocol::schema::v1::RequestId,
) -> Option<super::RequestId> {
    match id {
        agent_client_protocol::schema::v1::RequestId::Number(number) => {
            u64::try_from(*number).ok().map(super::RequestId::Number)
        }
        agent_client_protocol::schema::v1::RequestId::Str(text) => {
            Some(super::RequestId::String(text.clone()))
        }
        agent_client_protocol::schema::v1::RequestId::Null => None,
    }
}

/// A1b：标记 replay 分类并投递（broadcast 扇出 + 可靠中继）。
///
/// #99 变更：ingress ordinal 分配与投递全部收敛在 [`InboundRelay::relay`]——
/// inbox 满转入有界 spill 续投，spill 溢出以显式过载终态收敛连接。禁止
/// `try_send` 失败后仅打日志继续运行（旧行为会静默丢帧，已被本函数取代）。
fn publish_inbound(
    mut classified: ClassifiedMessage,
    replay_events: &broadcast::Sender<ClassifiedMessage>,
    active_replay_requests: &Arc<Mutex<HashMap<u64, String>>>,
    relay: &InboundRelay,
) -> PublishOutcome {
    // ordinal 在 clone/broadcast 之前分配：broadcast（replay 观察扇出）副本与
    // inbox 帧携带同一序号，live/replay/boundary 共用同一序列模型（评审 E10）。
    // relay 内的 assign-if-zero 只兜底直调路径（测试/过载崩溃帧）。
    if classified.ingress_seq == 0 {
        classified.ingress_seq = relay.telemetry.allocate_seq();
    }
    // A replay response is the deterministic boundary of the load operation.
    // Keep this classification on the transport message itself so observers
    // do not have to infer it from the response channel.
    // (#260-B4) 两次读取合并为一次持锁：boundary 与 replay 两判定共享同一份
    // 快照，判定顺序不变；锁中毒时两判定都跳过，与旧「各自 if let Ok」一致。
    if let Ok(active) = active_replay_requests.lock() {
        if let Some(super::RequestId::Number(id)) = classified.raw.id.as_ref() {
            if active.contains_key(id) {
                classified.classification =
                    super::ReplayClassification::Boundary { request_id: *id };
            }
        }
        if let Some(session_id) = classified
            .raw
            .params
            .as_ref()
            .and_then(|params| params.get("sessionId"))
            .and_then(serde_json::Value::as_str)
        {
            if classified.classification == super::ReplayClassification::Live {
                if let Some((request_id, _)) =
                    active.iter().find(|(_, id)| id.as_str() == session_id)
                {
                    classified.classification = super::ReplayClassification::Replay {
                        request_id: *request_id,
                    };
                }
            }
        }
    }
    // (#260-B4) 零订阅者跳过整帧深克隆：broadcast send 对无接收者本就是被吞的
    // no-op。不变量：replay.rs 的 subscribe 严格先于 session/load 发出，故
    // rc==0 时被跳过的帧必在 load 点之前，journal 重放会覆盖。
    if replay_events.receiver_count() > 0 {
        let _ = replay_events.send(classified.clone());
    }
    relay.relay(classified)
}

/// 构造 SDK 侧 transport 与观测桥之间的四端 `Channel` 拓扑。
///
/// 拓扑：`sdk_end <-> inspect_left  ==bridge==  inspect_right <-> child_end`。
/// `child_end` 由调用方接到子进程字节流（`ConnectTo`）。
/// 仅测试消费：生产拓扑（`spawn_sdk_engine`）的 child 侧不走独立 duplex 通道，
/// 由 `ConnectTo::into_channel_and_future` 直接给出。
#[cfg(test)]
pub fn bridge_channels() -> (Channel, Channel, Channel, Channel) {
    let (sdk_end, inspect_left) = Channel::duplex();
    let (inspect_right, child_end) = Channel::duplex();
    (sdk_end, inspect_left, inspect_right, child_end)
}

/// 运行观测桥：两个方向逐帧写入 `AcpWireHub`，原帧原样转发。
///
/// 使用 SDK 的 `bridge_with_inspection`，在 SDK 与子进程之间原样转发帧并
/// 记录 wire capture。该 API 对 batch 内每条消息调用 observer，因此保留
/// `RequestId` 的 number/string/null 形态。
pub async fn run_wire_bridge(
    inspect_left: Channel,
    inspect_right: Channel,
    hub: Arc<AcpWireHub>,
) -> Result<(), agent_client_protocol::Error> {
    let outbound = hub.clone();
    let inbound = hub;
    Channel::bridge_with_inspection(
        inspect_left,
        inspect_right,
        move |message| {
            observe_message(message, &outbound, WireDirection::PylonToAgent);
            Ok(())
        },
        move |message| {
            observe_message(message, &inbound, WireDirection::AgentToPylon);
            Ok(())
        },
    )
    .await
}

fn observe_message(
    message: &agent_client_protocol::RawJsonRpcMessage,
    hub: &AcpWireHub,
    direction: WireDirection,
) {
    if let Ok(value) = serde_json::to_value(message) {
        match direction {
            WireDirection::PylonToAgent => hub.capture_request(&value),
            WireDirection::AgentToPylon => hub.capture_agent_message(&value),
        }
    }
}

/// 观测一条传输帧内的全部有效消息（batch 逐条）。
/// 用 `tokio_util::compat::Compat` 把 tokio 读写半流适配成 SDK 需要的 futures 字节流。
pub fn byte_streams<R, W>(read: R, write: W) -> ByteStreams<Compat<W>, Compat<R>>
where
    R: tokio::io::AsyncRead + Send + 'static,
    W: tokio::io::AsyncWrite + Send + 'static,
{
    ByteStreams::new(write.compat_write(), read.compat())
}

/// 启动 SDK 客户端连接任务：非类型化 dispatch → 可靠入站中继（有界 inbox +
/// 有界 spill + 过载显式终态 + 控制帧优先通道），`on_close` 置关闭信号；
/// `shutdown` 触发时 `main_fn` 返回、连接收敛。
#[allow(
    clippy::too_many_arguments,
    reason = "装配函数：参数量随 A1b replay 扇出增加；A1c 收敛后端后合并为结构体"
)]
pub fn spawn_sdk_client(
    config: SdkEngineConfig,
    relay: InboundRelay,
    mut outbound_rx: tokio::sync::mpsc::Receiver<SdkOutbound>,
    transport: impl ConnectTo<Client> + 'static,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
    crashed: Arc<AtomicBool>,
    crashed_watch: watch::Sender<bool>,
    replay_events: broadcast::Sender<ClassifiedMessage>,
    active_replay_requests: Arc<Mutex<HashMap<u64, String>>>,
    pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>>,
) -> tokio::task::JoinHandle<Result<(), agent_client_protocol::Error>> {
    let crashed_eof = crashed.clone();
    let crashed_watch_eof = crashed_watch.clone();
    let wire = config.wire.clone();
    // #99：spill 续投泵（inbox 满时的续投者；过载后退出）。
    let _pump = spawn_inbound_pump(relay.clone());
    tokio::spawn(async move {
        let result = Client
            .builder()
            .name(config.name)
            .on_receive_dispatch(
                move |message: Dispatch<UntypedMessage, UntypedMessage>, _cx| {
                    let relay = relay.clone();
                    let replay_events = replay_events.clone();
                    let active_replay_requests = active_replay_requests.clone();
                    let pending_requests = pending_requests.clone();
                    let wire = wire.clone();
                    async move {
                        match message {
                            // 响应必须交回 SDK 的 SentRequest：若被 handler 认领而不路由，
                            // ResponseRouter 被丢弃，等响应的请求会以 oneshot canceled 失败。
                            Dispatch::Response(result, router) => {
                                router.route_with_result(result)?;
                            }
                            Dispatch::Request(request, responder) => {
                                // A1b：登记 Responder 供 `ResponderHandle::Sdk` 锁外应答。
                                let id = sdk_request_id_to_pylon(responder.id());
                                if let Some(id) = &id {
                                    if let Ok(mut pending) = pending_requests.lock() {
                                        pending.insert(id.clone(), responder);
                                    }
                                }
                                let mut classified = ClassifiedMessage::live(RawMessage {
                                    id,
                                    kind: super::AcpKind::from_method(Some(request.method())),
                                    method: Some(request.method().to_string()),
                                    result: None,
                                    params: Some(request.params().clone()),
                                    error: None,
                                });
                                classified.wire_ordinal = wire.take_inbound_ordinal();
                                publish_inbound(
                                    classified,
                                    &replay_events,
                                    &active_replay_requests,
                                    &relay,
                                );
                            }
                            Dispatch::Notification(notification) => {
                                let mut classified = ClassifiedMessage::live(RawMessage {
                                    id: None,
                                    kind: super::AcpKind::from_method(Some(notification.method())),
                                    method: Some(notification.method().to_string()),
                                    result: None,
                                    params: Some(notification.params().clone()),
                                    error: None,
                                });
                                classified.wire_ordinal = wire.take_inbound_ordinal();
                                publish_inbound(
                                    classified,
                                    &replay_events,
                                    &active_replay_requests,
                                    &relay,
                                );
                            }
                        }
                        Ok(Handled::Yes)
                    }
                },
                agent_client_protocol::on_receive_dispatch!(),
            )
            .on_close(move |_cx| {
                let crashed = crashed.clone();
                let crashed_watch = crashed_watch.clone();
                async move {
                    crashed.store(true, Ordering::Release);
                    let _ = crashed_watch.send(true);
                    Ok(())
                }
            })
            .connect_with(transport, async move |cx| {
                // 出站泵：每个请求在独立任务中发送，绝不阻塞 dispatch loop。
                loop {
                    tokio::select! {
                        _ = shutdown.changed() => break,
                        // 入站 EOF（子进程退出）等价 legacy reader 的崩溃信号：
                        // SDK 的 on_close 只在错误关闭时回调，干净 EOF 需在此显式置位。
                        _ = cx.incoming_closed() => {
                            crashed_eof.store(true, Ordering::Release);
                            let _ = crashed_watch_eof.send(true);
                            break;
                        }
                        outbound = outbound_rx.recv() => {
                            let Some(outbound) = outbound else { break };
                            let spawn_cx = cx.clone();
                            let task_cx = cx.clone();
                            let _ = spawn_cx.spawn(async move {
                                match outbound {
                                    SdkOutbound::Request { method, params, reply } => {
                                        let result = async {
                                            let message = UntypedMessage::new(&method, params)
                                                .map_err(map_sdk_error)?;
                                            task_cx.send_request(message).block_task().await
                                                .map_err(map_sdk_error)
                                        }
                                        .await;
                                        let _ = reply.send(result);
                                    }
                                    SdkOutbound::Notification { method, params, reply } => {
                                        let result = async {
                                            let message = UntypedMessage::new(&method, params)
                                                .map_err(map_sdk_error)?;
                                            task_cx.send_notification(message).map_err(map_sdk_error)
                                        }
                                        .await;
                                        let _ = reply.send(result);
                                    }
                                    SdkOutbound::RequestKeepRx { method, params, ready } => {
                                        let result = async {
                                            let message = UntypedMessage::new(&method, params)
                                                .map_err(map_sdk_error)?;
                                            let (resp_tx, resp_rx) = oneshot::channel();
                                            task_cx.send_request(message).on_receiving_result(
                                                move |response| {
                                                    let mapped = response.map_err(map_sdk_error);
                                                    async move {
                                                        let _ = resp_tx.send(mapped);
                                                        Ok(())
                                                    }
                                                },
                                            )
                                            .map_err(map_sdk_error)?;
                                            Ok(resp_rx)
                                        }
                                        .await;
                                        let _ = ready.send(result);
                                    }
                                }
                                Ok(())
                            });
                        }
                    }
                }
                Ok(())
            })
            .await;
        result
    })
}

/// 出站队列容量（有界；满时调用方拿到 `ConnectionClosed` 而不是无限堆积）。
const OUTBOUND_CHAN_CAP: usize = 256;

/// 用 SDK 连接已由 Pylon spawn 的子进程（D1=①）。
///
/// 进程归属不变：子进程仍由 `ManagedChild`（Windows Job Object）持有；本函数只接
/// 协议栈：std 管道 → `tokio::process::ChildStdin/Stdout::from_std`（非阻塞 + 注册
/// runtime）→ `compat` → `ByteStreams` → 观测桥 → SDK client。
/// client 代际由调用方在 `wire`（`AcpWireCapture` correlation）内携带，不再单独传参。
pub fn spawn_sdk_engine(
    agent: &pylon_core::agent_config::AgentDef,
    stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
    wire: Arc<AcpWireCapture>,
    crashed: Arc<AtomicBool>,
    crashed_watch: watch::Sender<bool>,
) -> Result<SdkBackend, AcpError> {
    let stdin = tokio::process::ChildStdin::from_std(stdin)
        .map_err(|error| AcpError::Child(format!("sdk engine stdin setup failed: {error}")))?;
    let stdout = tokio::process::ChildStdout::from_std(stdout)
        .map_err(|error| AcpError::Child(format!("sdk engine stdout setup failed: {error}")))?;

    let (sdk_end, sdk_bridge_side) = Channel::duplex();

    // 子进程字节流 → Channel（自持 relay，避免 SDK `Channel::connect_to` 的
    // `try_join!` 在单向 EOF 时不传播关闭）。
    let transport = byte_streams(stdout, stdin);
    let (child_channel, child_future) =
        <_ as ConnectTo<Client>>::into_channel_and_future(transport);

    // 观测桥：逐帧写入 wire hub，原帧原样转发；任一方向结束即返回。
    let bridge_wire = wire.clone();
    tokio::spawn(async move {
        let _ = run_wire_bridge(sdk_bridge_side, child_channel, bridge_wire).await;
    });

    let (updates_tx, updates_rx) = mpsc::channel(super::NOTIFICATION_CHAN_CAP);
    // #99：控制帧通道（agent 请求/崩溃广播走优先级 lane）+ 可靠中继。
    let (control_tx, control_rx) = mpsc::channel(CONTROL_INBOX_CAP);
    let (outbound_tx, outbound_rx) = mpsc::channel(OUTBOUND_CHAN_CAP);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let (replay_events, _) = broadcast::channel(super::BROADCAST_CAP);
    let active_replay_requests: Arc<Mutex<HashMap<u64, String>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let pending_requests: Arc<Mutex<HashMap<super::RequestId, Responder>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let telemetry = Arc::new(InboundTelemetry::new());
    let relay = InboundRelay {
        updates_tx,
        control_tx,
        spill: Arc::new(Mutex::new(SpillState {
            control: std::collections::VecDeque::new(),
            updates: std::collections::VecDeque::new(),
            capacity: INBOUND_SPILL_CAP,
        })),
        wake: Arc::new(tokio::sync::Notify::new()),
        telemetry: telemetry.clone(),
        shutdown: shutdown_tx.clone(),
        crashed: crashed.clone(),
        crashed_watch: crashed_watch.clone(),
    };

    // 子侧传输收尾（#348 A1：区分正常关闭与物理传输失败）。干净关闭 =
    // child_future 返回 `Ok`——不进 Err 分支、不发崩溃控制帧；crashed 信号
    // 照常置位：子进程退出（含 EOF）是权威崩溃信号，等价 legacy reader，
    // 不依赖 SDK 的 EOF 语义（`incoming_closed` 在洪泛/批量场景未必及时完成）。
    // Err 时非 SDK 关闭标记的由 [`transport_failure_reason`] 判为
    // `WriterFailed`，经既有 InboundRelay 控制帧通道发崩溃帧补全终因。已收敛
    // 的连接（过载等已发过崩溃帧）不再竞争修正 reason（watch 缺省
    // `stdout_closed` / 既有控制帧 last-write-wins 不被覆盖）。
    let child_crashed = crashed.clone();
    let child_crashed_watch = crashed_watch.clone();
    let child_end_relay = relay.clone();
    tokio::spawn(async move {
        let outcome = child_future.await;
        if let Err(error) = &outcome {
            if !child_crashed.load(Ordering::Acquire) {
                match transport_failure_reason(error) {
                    Some(reason) => {
                        tracing::warn!(
                            error = %error,
                            reason = reason.as_str(),
                            "acp child transport failed; broadcasting crash control frame"
                        );
                        let _ = child_end_relay.relay(crash_control_frame(reason));
                    }
                    None => {
                        tracing::debug!(error = %error, "acp child transport closed cleanly");
                    }
                }
            }
        }
        child_crashed.store(true, Ordering::Release);
        let _ = child_crashed_watch.send(true);
    });

    let join = spawn_sdk_client(
        SdkEngineConfig {
            name: agent.name.clone(),
            wire: wire.clone(),
        },
        relay,
        outbound_rx,
        sdk_end,
        shutdown_rx,
        crashed,
        crashed_watch,
        replay_events.clone(),
        active_replay_requests.clone(),
        pending_requests.clone(),
    );

    Ok(SdkBackend {
        outbound: outbound_tx,
        next_id: Arc::new(AtomicU64::new(1)),
        inbound: NotificationInbox::new(updates_rx, control_rx),
        telemetry,
        replay_events,
        active_replay_requests,
        pending_requests,
        shutdown: shutdown_tx,
        join: Some(join),
    })
}

#[cfg(test)]
mod tests {
    use super::test_support::fake_acp_agent_stub;
    use super::*;
    use agent_client_protocol::schema::v1::RequestId;
    use agent_client_protocol::{RawJsonRpcMessage, TransportFrame};
    use pylon_core::correlation::RuntimeCorrelation;
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    fn engine_config() -> SdkEngineConfig {
        SdkEngineConfig {
            name: "pylon-engine-test".to_string(),
            wire: AcpWireHub::new(
                RuntimeCorrelation {
                    agent_id: "test".into(),
                    provider: None,
                    source: "test".into(),
                    local_session_id: None,
                    remote_session_id: None,
                    peri_id: None,
                    client_generation: 1,
                    request_id: None,
                    tool_call_id: None,
                },
                8,
            ),
        }
    }

    /// #348 A1：分类器对 SDK 谓词的委托——`is_incoming_transport_closed`
    /// 标记不算传输失败，其余 Err 一律判 `WriterFailed`。
    /// 注意：手工构造标记错误喂分类器，锁定的是**委托关系**，不是生产输入
    /// （SDK 只为挂起请求合成该标记，不作为传输 future 的 Err 出现）；生产
    /// 路径的干净关闭走「Ok 不发帧」，由下方真实传输 future 用例覆盖。
    #[test]
    fn transport_failure_reason_delegates_to_the_sdk_closed_marker_predicate() {
        let closed_marker = agent_client_protocol::Error::internal_error()
            .data(serde_json::json!({"reason": "incoming_transport_closed"}));
        assert_eq!(transport_failure_reason(&closed_marker), None);

        let physical_error = agent_client_protocol::Error::internal_error();
        assert_eq!(
            transport_failure_reason(&physical_error),
            Some(CrashReason::WriterFailed)
        );
    }

    /// #348 A1（真实路径）：干净关闭 = 传输 future 返回 `Ok`（SDK `try_join!`
    /// 两个传输 actor 正常收尾）。生产收尾任务靠「Ok 不发帧」防误报——
    /// `transport_failure_reason` 只在 Err 时出场，本用例不构造不可达的
    /// 带标记 Err，而是断言真实传输 future 在干净 EOF 下的 Ok 收敛。
    #[tokio::test]
    async fn clean_child_transport_close_completes_ok_without_failure() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let transport = byte_streams(client_read, client_write);
        let (child_channel, child_future) =
            <_ as ConnectTo<Client>>::into_channel_and_future(transport);
        drop(child_channel); // 出站侧无帧：outgoing actor 输入排空即完成
        drop(agent_io); // 对端整体关闭 = 入站侧干净 EOF（整体 drop 才会传播
                        // EOF；split 半关闭不触及底层管道状态）
        let outcome = tokio::time::timeout(Duration::from_secs(5), child_future)
            .await
            .expect("干净关闭必须收敛，不得挂起");
        assert!(
            outcome.is_ok(),
            "干净关闭必须是 Ok（try_join 两 actor 正常收尾），实际 {outcome:?}"
        );
    }

    /// #348 A1：崩溃控制帧的唯一构造——reason 必须是稳定词表 wire code。
    #[test]
    fn crash_control_frame_carries_stable_reason_code() {
        let frame = crash_control_frame(CrashReason::WriterFailed);
        assert_eq!(frame.raw.kind, crate::AcpKind::Crashed);
        assert_eq!(
            frame.raw.params,
            Some(serde_json::json!({"reason": "writer_failed"}))
        );
    }

    /// A1a 步骤 2/4 证据：SDK 客户端连上字节流并**非类型化**收到 agent 通知。
    #[tokio::test]
    async fn sdk_engine_dispatches_untyped_notification() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (_, mut agent_write) = tokio::io::split(agent_io);

        let (relay, mut updates_rx, _control_rx, _shutdown_rx) =
            InboundRelay::for_test_with_receivers(8, 8, 64);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let _outbound_tx = outbound_tx;
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let crashed = Arc::new(AtomicBool::new(false));
        let (crashed_watch, mut crashed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            relay,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            crashed.clone(),
            crashed_watch,
            tokio::sync::broadcast::channel(8).0,
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        );

        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk"}}
        });
        agent_write
            .write_all(format!("{frame}\n").as_bytes())
            .await
            .expect("agent write");
        agent_write.flush().await.expect("agent flush");

        let inbound = tokio::time::timeout(Duration::from_secs(5), updates_rx.recv())
            .await
            .expect("inbound notification must arrive")
            .expect("inbound channel must stay open");
        assert_eq!(inbound.raw.method.as_deref(), Some("session/update"));
        assert_eq!(
            inbound.raw.params,
            Some(serde_json::json!({
                "sessionId": "s-1",
                "update": {"sessionUpdate": "agent_message_chunk"}
            }))
        );

        // A1a 步骤 4 证据：agent 端关闭 → SDK on_close 置位。
        drop(agent_write);
        tokio::time::timeout(Duration::from_secs(5), crashed_rx.changed())
            .await
            .expect("on_close must fire after transport EOF")
            .expect("crashed watch must stay open");
        assert!(*crashed_rx.borrow());
        assert!(crashed.load(Ordering::Acquire));

        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1a 步骤 5 证据：出站非类型化请求经 `cx.spawn` 发送并拿回响应。
    #[tokio::test]
    async fn sdk_engine_outbound_request_returns_response() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, mut agent_write) = tokio::io::split(agent_io);

        let (relay, _updates_rx, _control_rx, _relay_shutdown_rx) =
            InboundRelay::for_test_with_receivers(8, 8, 64);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (crashed_watch, _crashed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            relay,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            Arc::new(AtomicBool::new(false)),
            crashed_watch,
            tokio::sync::broadcast::channel(8).0,
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        );

        // agent 端：读一条请求，按原 id 回一条 result；保持写端存活直到测试拿到响应，
        // 避免 EOF 与响应处理竞态。
        let (hold_tx, hold_rx) = tokio::sync::oneshot::channel::<()>();
        let agent_task = tokio::spawn(async move {
            let mut reader = BufReader::new(agent_read);
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
                .await
                .expect("agent must receive outbound request")
                .expect("agent read must succeed");
            let request: serde_json::Value =
                serde_json::from_str(line.trim()).expect("request json");
            assert_eq!(request["method"], "session/new");
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {"sessionId": "outbound-session"}
            });
            agent_write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .expect("agent write");
            agent_write.flush().await.expect("agent flush");
            let _ = hold_rx.await;
        });

        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        outbound_tx
            .send(SdkOutbound::Request {
                method: "session/new".to_string(),
                params: serde_json::json!({"cwd": "."}),
                reply: reply_tx,
            })
            .await
            .expect("outbound queue");
        let response = tokio::time::timeout(Duration::from_secs(5), reply_rx)
            .await
            .expect("outbound reply must arrive")
            .expect("reply channel must stay open")
            .expect("outbound request must succeed");
        assert_eq!(response["sessionId"], "outbound-session");

        let _ = hold_tx.send(());
        agent_task.await.expect("agent task");
        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1a 步骤 6（**硬门**）+ #99 背压契约：入站队列满时**不丢帧**——溢出帧
    /// 进有界 spill 由泵任务续投（ingress 序列保序），同时 dispatch loop 保持
    /// 响应（出站请求在 inbox 满时仍被处理）。
    ///
    /// 预期行为变化（对比旧 `inbox_full_does_not_block_dispatch`）：旧契约断言
    /// 「容量 1 时后 2 帧被静默丢弃」；#99 禁止静默丢帧，本测试改为断言全部
    /// 3 帧按 ingress 序列完整送达。
    #[tokio::test]
    async fn inbox_full_spills_then_delivers_every_frame_in_order() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, mut agent_write) = tokio::io::split(agent_io);

        // 入站队列容量 1：连发 3 条通知必有 2 条先入 spill，再由泵续投。
        let (relay, mut updates_rx, _control_rx, _shutdown_rx) =
            InboundRelay::for_test_with_receivers(1, 8, 64);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (crashed_watch, _crashed_rx) = tokio::sync::watch::channel(false);
        let handle = spawn_sdk_client(
            engine_config(),
            relay,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            Arc::new(AtomicBool::new(false)),
            crashed_watch,
            tokio::sync::broadcast::channel(8).0,
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
            std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        );

        let (hold_tx, hold_rx) = tokio::sync::oneshot::channel::<()>();
        let agent_task = tokio::spawn(async move {
            for index in 0..3 {
                let frame = serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "session/update",
                    "params": {"sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk", "index": index}}
                });
                agent_write
                    .write_all(format!("{frame}\n").as_bytes())
                    .await
                    .expect("agent write");
            }
            agent_write.flush().await.expect("agent flush");
            // 入站队列已满仍必须能处理出站请求（否则 dispatch loop 被阻塞）。
            let mut reader = BufReader::new(agent_read);
            let mut line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
                .await
                .expect("dispatch loop must stay responsive while inbox is full")
                .expect("agent read must succeed");
            let request: serde_json::Value =
                serde_json::from_str(line.trim()).expect("request json");
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {"ok": true}
            });
            agent_write
                .write_all(format!("{response}\n").as_bytes())
                .await
                .expect("agent response write");
            agent_write.flush().await.expect("agent response flush");
            let _ = hold_rx.await;
        });

        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        outbound_tx
            .send(SdkOutbound::Request {
                method: "session/new".to_string(),
                params: serde_json::json!({"cwd": "."}),
                reply: reply_tx,
            })
            .await
            .expect("outbound queue");
        let response = tokio::time::timeout(Duration::from_secs(5), reply_rx)
            .await
            .expect("outbound reply must arrive while inbox is full")
            .expect("reply channel must stay open")
            .expect("outbound request must succeed");
        assert_eq!(response["ok"], true);

        // #99：三帧全部送达（无静默丢帧），ingress 序列严格递增。
        let mut seqs = Vec::new();
        for index in 0..3 {
            let frame = tokio::time::timeout(Duration::from_secs(5), updates_rx.recv())
                .await
                .expect("spilled frame must be delivered by the pump")
                .expect("updates channel must stay open");
            assert_eq!(
                frame.raw.params.as_ref().unwrap()["update"]["index"],
                serde_json::json!(index),
                "帧必须按序送达（无记录的丢弃 = 门禁失败）"
            );
            seqs.push(frame.ingress_seq);
        }
        assert_eq!(seqs, vec![1, 2, 3], "ingress ordinal 必须单调递增且无 gap");

        let _ = hold_tx.send(());
        agent_task.await.expect("agent task");
        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// #99：spill 溢出 = 显式过载终态。丢弃必须计数（gap 可观测）、崩溃广播
    /// 携带稳定 code `overloaded`、shutdown 触发连接收敛；禁止静默继续运行。
    #[tokio::test]
    async fn spill_overflow_terminates_connection_with_explicit_overload() {
        let (relay, updates_rx, mut control_rx, shutdown_rx) =
            InboundRelay::for_test_with_receivers(1, 8, 1);

        let update = |index: u64| {
            ClassifiedMessage::live(RawMessage {
                id: None,
                kind: super::super::AcpKind::SessionUpdate,
                method: Some(super::super::NOTIF_SESSION_UPDATE.to_string()),
                result: None,
                params: Some(serde_json::json!({"sessionId": "s-1", "update": {"index": index}})),
                error: None,
            })
        };

        // 消费端不读 updates_rx：inbox(1) + spill(1) 后第 3 帧必须触发过载。
        assert_eq!(relay.relay(update(0)), PublishOutcome::Published);
        assert_eq!(relay.relay(update(1)), PublishOutcome::Spilled);
        assert_eq!(relay.relay(update(2)), PublishOutcome::Overloaded);

        let telemetry = relay.telemetry.snapshot();
        assert_eq!(
            telemetry.dropped_total, 1,
            "溢出帧必须显式计数（gap marker）"
        );
        assert_eq!(telemetry.spilled_total, 1);
        assert!(telemetry.overloaded, "过载位必须置上");

        // 崩溃广播走控制通道，reason = 稳定 code "overloaded"。
        let crash = tokio::time::timeout(Duration::from_secs(2), control_rx.recv())
            .await
            .expect("crash frame must be queued")
            .expect("control channel must stay open");
        assert_eq!(crash.raw.kind, super::super::AcpKind::Crashed);
        assert_eq!(
            crash.raw.params.as_ref().unwrap()["reason"],
            serde_json::json!("overloaded")
        );
        // shutdown 已触发（连接收敛），且 updates_rx 未被消费过。
        assert!(
            *shutdown_rx.borrow(),
            "shutdown must be requested on overload"
        );
        drop(updates_rx);
    }

    /// #99：控制帧优先级——updates 通道满 + spill 非空时，agent 请求（带 id）
    /// 仍经控制通道立即被消费端读到；优先级不改写各帧 ingress 序列。
    #[tokio::test]
    async fn control_lane_delivers_requests_while_update_flood_is_queued() {
        let (relay, mut updates_rx, mut control_rx, _shutdown_rx) =
            InboundRelay::for_test_with_receivers(1, 8, 64);

        let update = |index: u64| {
            ClassifiedMessage::live(RawMessage {
                id: None,
                kind: super::super::AcpKind::SessionUpdate,
                method: Some(super::super::NOTIF_SESSION_UPDATE.to_string()),
                result: None,
                params: Some(serde_json::json!({"sessionId": "s-1", "update": {"index": index}})),
                error: None,
            })
        };
        assert_eq!(relay.relay(update(0)), PublishOutcome::Published);
        assert_eq!(relay.relay(update(1)), PublishOutcome::Spilled);

        // 洪泛未消费时，permission 请求必须立即可读（控制通道）。
        let request = ClassifiedMessage::live(RawMessage {
            id: Some(super::super::RequestId::String("perm-1".to_string())),
            kind: super::super::AcpKind::PermissionRequest,
            method: Some("session/request_permission".to_string()),
            result: None,
            params: Some(serde_json::json!({"sessionId": "s-1"})),
            error: None,
        });
        assert_eq!(relay.relay(request), PublishOutcome::Published);
        let control_frame = tokio::time::timeout(Duration::from_secs(2), control_rx.recv())
            .await
            .expect("control frame must bypass the update flood")
            .expect("control channel must stay open");
        assert_eq!(
            control_frame.raw.kind,
            super::super::AcpKind::PermissionRequest
        );
        assert_eq!(control_frame.ingress_seq, 3, "优先级不改写 ingress 序列");

        // 普通 lane 数据未动：第一帧仍在 inbox。
        let first = tokio::time::timeout(Duration::from_secs(2), updates_rx.recv())
            .await
            .expect("update frame")
            .expect("updates channel");
        assert_eq!(first.ingress_seq, 1);
    }

    /// A1a 步骤 3 证据：观测桥逐帧写入 `AcpWireHub`（两个方向、id 形态保持）。
    #[tokio::test]
    async fn wire_bridge_records_both_directions_with_id_kind() {
        let (mut sdk_end, inspect_left, inspect_right, child_end) = bridge_channels();
        let agent = fake_acp_agent_stub("fake-acp-bridge");
        let hub = AcpWireHub::for_agent(&agent, 1);
        let bridge = tokio::spawn(run_wire_bridge(inspect_left, inspect_right, hub.clone()));

        // agent → pylon：string id 请求帧（形态必须原样保留）
        let inbound = RawJsonRpcMessage::request(
            "session/request_permission".to_string(),
            serde_json::json!({"sessionId": "s-1"}),
            RequestId::Str("str-1".to_string()),
        )
        .expect("inbound request frame");
        child_end
            .tx
            .unbounded_send(TransportFrame::Single(inbound))
            .expect("child send");
        let forwarded = tokio::time::timeout(Duration::from_secs(5), sdk_end.rx.recv())
            .await
            .expect("bridge must forward frame")
            .expect("sdk side must stay open");
        assert!(matches!(forwarded, TransportFrame::Single(_)));

        // pylon → agent：number id 请求帧
        let outbound = RawJsonRpcMessage::request(
            "session/prompt".to_string(),
            serde_json::json!({"sessionId": "s-1"}),
            RequestId::Number(7),
        )
        .expect("outbound request frame");
        sdk_end
            .tx
            .unbounded_send(TransportFrame::Single(outbound))
            .expect("sdk send");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let records = loop {
            let records = hub.snapshot();
            if records.len() >= 2 {
                break records;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "wire hub must record both frames"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].direction, WireDirection::AgentToPylon);
        assert_eq!(
            records[0].id_kind,
            super::super::wire_trace::WireIdKind::String
        );
        assert_eq!(records[1].direction, WireDirection::PylonToAgent);
        assert_eq!(
            records[1].id_kind,
            super::super::wire_trace::WireIdKind::Number
        );

        bridge.abort();
        let _ = bridge.await;
    }

    /// A1b 步骤 7：agent 请求经 `ResponderHandle::Sdk` 在锁外应答（原值 id 回写）。
    #[tokio::test]
    async fn sdk_responder_answers_agent_request() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, mut agent_write) = tokio::io::split(agent_io);

        let (relay, _updates_rx, _control_rx, _relay_shutdown_rx) =
            InboundRelay::for_test_with_receivers(8, 8, 64);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let _outbound_tx = outbound_tx;
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (crashed_watch, _crashed_rx) = tokio::sync::watch::channel(false);
        let pending: Arc<Mutex<HashMap<super::super::RequestId, Responder>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let handle = spawn_sdk_client(
            engine_config(),
            relay,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            Arc::new(AtomicBool::new(false)),
            crashed_watch,
            tokio::sync::broadcast::channel(8).0,
            Arc::new(Mutex::new(HashMap::new())),
            pending.clone(),
        );

        // agent 发一条 string-id 的 permission 请求。
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "perm-1",
            "method": "session/request_permission",
            "params": {"sessionId": "s-1", "toolCallId": "tc-1", "options": []}
        });
        agent_write
            .write_all(format!("{request}\n").as_bytes())
            .await
            .expect("agent write");
        agent_write.flush().await.expect("agent flush");

        // 等引擎登记 Responder（Pylon id 为 String("perm-1")）。
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if pending
                .lock()
                .unwrap()
                .contains_key(&super::super::RequestId::String("perm-1".to_string()))
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "engine must register the agent responder"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        let responder = ResponderHandle {
            pending_requests: pending,
        };
        assert!(
            responder
                .respond(
                    super::super::RequestId::String("perm-1".to_string()),
                    serde_json::json!({"outcome": {"outcome": "selected", "optionId": "allow_once"}}),
                )
                .await,
            "sdk responder must answer"
        );

        // agent 读到同 id 的响应。
        let mut reader = BufReader::new(agent_read);
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
            .await
            .expect("agent must receive response")
            .expect("agent read must succeed");
        let response: serde_json::Value = serde_json::from_str(line.trim()).expect("response json");
        assert_eq!(response["id"], "perm-1");
        assert_eq!(response["result"]["outcome"]["optionId"], "allow_once");

        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1b 步骤 4 前置：进行中 replay 采集的 session 通知必须被标记为 Replay。
    #[tokio::test]
    async fn sdk_inbound_replay_notification_is_classified() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (_, mut agent_write) = tokio::io::split(agent_io);

        let (relay, _updates_rx, _control_rx, _relay_shutdown_rx) =
            InboundRelay::for_test_with_receivers(8, 8, 64);
        let (outbound_tx, outbound_rx) = tokio::sync::mpsc::channel(8);
        let _outbound_tx = outbound_tx;
        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let (crashed_watch, _crashed_rx) = tokio::sync::watch::channel(false);
        let (replay_tx, mut replay_rx) = tokio::sync::broadcast::channel(8);
        let active: Arc<Mutex<HashMap<u64, String>>> = Arc::new(Mutex::new(HashMap::new()));
        active.lock().unwrap().insert(42, "s-1".to_string());

        let handle = spawn_sdk_client(
            engine_config(),
            relay,
            outbound_rx,
            byte_streams(client_read, client_write),
            shutdown_rx,
            Arc::new(AtomicBool::new(false)),
            crashed_watch,
            replay_tx,
            active,
            Arc::new(Mutex::new(HashMap::new())),
        );

        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": "s-1", "update": {"sessionUpdate": "agent_message_chunk", "content": {"text": "x"}}}
        });
        agent_write
            .write_all(
                format!(
                    "{frame}
"
                )
                .as_bytes(),
            )
            .await
            .expect("agent write");
        agent_write.flush().await.expect("agent flush");

        let classified = tokio::time::timeout(Duration::from_secs(5), replay_rx.recv())
            .await
            .expect("broadcast must deliver")
            .expect("broadcast must stay open");
        assert!(matches!(
            classified.classification,
            super::super::ReplayClassification::Replay { request_id: 42 }
        ));

        let _ = shutdown_tx.send(true);
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// A1b 步骤 3 前置：SDK 的 `SentRequest` 被 drop 会自动发 `$/cancel_request`
    /// （与 Pylon「丢弃 pending 不发取消」不同——A1b 必须显式审计并锁定该差异）。
    #[tokio::test]
    async fn sent_request_drop_sends_cancel_request() {
        let (agent_io, client_io) = tokio::io::duplex(64 * 1024);
        let (client_read, client_write) = tokio::io::split(client_io);
        let (agent_read, _agent_write) = tokio::io::split(agent_io);

        let agent_task = tokio::spawn(async move {
            let mut reader = BufReader::new(agent_read);
            let mut request_line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut request_line))
                .await
                .expect("agent must receive request")
                .expect("agent read must succeed");
            let request: serde_json::Value =
                serde_json::from_str(request_line.trim()).expect("request json");
            assert_eq!(request["method"], "session/prompt");

            let mut cancel_line = String::new();
            tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut cancel_line))
                .await
                .expect("drop must send $/cancel_request")
                .expect("agent read must succeed");
            let cancel: serde_json::Value =
                serde_json::from_str(cancel_line.trim()).expect("cancel json");
            assert_eq!(cancel["method"], "$/cancel_request");
        });

        let transport = byte_streams(client_read, client_write);
        let handle = tokio::spawn(async move {
            Client
                .builder()
                .name("drop-cancel-probe")
                .connect_with(transport, async |cx| {
                    let request = UntypedMessage::new(
                        "session/prompt",
                        serde_json::json!({"sessionId": "s-1"}),
                    )?;
                    // 立即 drop：SDK 契约 = 自动发 $/cancel_request。
                    drop(cx.send_request(request));
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    Ok(())
                })
                .await
        });

        agent_task.await.expect("agent task");
        let _ = tokio::time::timeout(Duration::from_secs(5), handle).await;
    }

    /// #99（评审 E1 回归锁，判别性构造由二审 P2-1 给出）：lane 存在滞留帧时，
    /// 新帧必须排到 spill 队尾（返回 `Spilled`）而不是直发越过滞留帧。
    ///
    /// 判别力设计：**relay 阶段不 spawn 泵**（旧实现的乱序窗口恰在泵重试等待
    /// 期间；无泵则无调度干扰，结果确定）。updates 容量 2：A、B 直发占满，
    /// C 进 spill（滞留期开始）；消费 A 腾出一格后 relay D——
    /// - 新实现：检测到滞留（C 占位）→ D 返回 `Spilled`，最终交付 [A,B,C,D]；
    /// - 旧实现：无滞留检查 → D 直发返回 `Published`，交付 [A,B,D,C]。
    /// 断言同时钉住 outcome 与交付序，对旧实现必红。
    #[tokio::test]
    async fn relay_with_lane_backlog_keeps_new_frames_behind_spilled() {
        let (relay, mut updates_rx, _control_rx, _shutdown_rx) =
            InboundRelay::for_test_with_receivers(2, 8, 64);
        let update = |index: u64| {
            ClassifiedMessage::live(RawMessage {
                id: None,
                kind: super::super::AcpKind::SessionUpdate,
                method: Some(super::super::NOTIF_SESSION_UPDATE.to_string()),
                result: None,
                params: Some(serde_json::json!({
                    "sessionId": "s-1", "update": {"index": index}
                })),
                error: None,
            })
        };
        // relay 阶段（无泵、无 await：结果确定，不受调度影响）。
        assert_eq!(relay.relay(update(0)), PublishOutcome::Published);
        assert_eq!(relay.relay(update(1)), PublishOutcome::Published);
        assert_eq!(relay.relay(update(2)), PublishOutcome::Spilled);
        // 消费 A 腾出一格——滞留 C 仍在 spill 占位。
        let first = updates_rx.recv().await.expect("first frame");
        assert_eq!(first.ingress_seq, 1);
        // 判别点：滞留存在时 D 禁止直发。
        assert_eq!(
            relay.relay(update(3)),
            PublishOutcome::Spilled,
            "滞留存在时新帧必须排尾（直发 = E1 旧实现回归）"
        );
        // 现在起泵续投：交付序必须 [A,B,C,D]（旧实现为 [A,B,D,C]）。
        let pump = spawn_inbound_pump(relay.clone());
        let mut seqs = vec![first.ingress_seq];
        for _ in 0..3 {
            let frame = tokio::time::timeout(Duration::from_secs(5), updates_rx.recv())
                .await
                .expect("frame must be delivered")
                .expect("updates channel must stay open");
            seqs.push(frame.ingress_seq);
        }
        assert_eq!(seqs, vec![1, 2, 3, 4], "交付序必须等于 ingress 序");
        pump.abort();
    }

    /// #99（评审 E5 回归锁）：shutdown 触发后泵任务必须退出，不残留
    /// 定时唤醒的僵尸任务。
    #[tokio::test]
    async fn inbound_pump_exits_on_shutdown() {
        let (updates_tx, updates_rx) = mpsc::channel(8);
        let (control_tx, control_rx) = mpsc::channel(8);
        let (shutdown, _shutdown_rx) = watch::channel(false);
        let shutdown_tx = shutdown.clone();
        let (crashed_watch, _crashed_rx) = watch::channel(false);
        let relay = InboundRelay {
            updates_tx,
            control_tx,
            spill: Arc::new(Mutex::new(SpillState {
                control: std::collections::VecDeque::new(),
                updates: std::collections::VecDeque::new(),
                capacity: 64,
            })),
            wake: Arc::new(tokio::sync::Notify::new()),
            telemetry: Arc::new(InboundTelemetry::new()),
            shutdown,
            crashed: Arc::new(AtomicBool::new(false)),
            crashed_watch,
        };
        let pump = spawn_inbound_pump(relay);
        drop(updates_rx);
        drop(control_rx);
        let _ = shutdown_tx.send(true);
        tokio::time::timeout(Duration::from_secs(2), pump)
            .await
            .expect("pump must exit after shutdown")
            .expect("pump task must not panic");
    }
}

// ── JSON-RPC request id（原 acp/request_id.rs，A1c 收敛）──

use std::fmt;

/// JSON-RPC 请求 id 的原始形态（数字或字符串）。
///
/// `#[serde(untagged)]`：序列化时 `Number(n)` → JSON number、`String(s)` → JSON string，
/// 天然满足"响应用原始 variant 回写"。
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    Number(u64),
    String(String),
}

impl RequestId {
    /// 从 wire JSON value 原样解析（保留 variant）；null/absent/布尔/浮点 → None。
    ///
    /// 测试与 wire 回放断言消费（#228/#247：宿主 golden_trace_tests 跨 crate 使用，
    /// 故为常态 pub；生产 legacy stdout reader 已于 A1c 删除）。
    pub fn from_json_value(value: &serde_json::Value) -> Option<RequestId> {
        match value {
            serde_json::Value::Number(n) => n.as_u64().map(RequestId::Number),
            serde_json::Value::String(s) => Some(RequestId::String(s.clone())),
            _ => None,
        }
    }

    /// 从前端回显字符串还原候选 id（ACP-01）：数字形态 → `Number`（命中原 numeric
    /// 请求），否则 `String`。不把 string 强转 number、不把 null/空串当 0——
    /// 最终 variant 由 pending 命中决定（见 `permission::canonical_pending_key`）。
    pub fn from_echo_string(value: &str) -> RequestId {
        match value.parse::<u64>() {
            Ok(n) => RequestId::Number(n),
            Err(_) => RequestId::String(value.to_string()),
        }
    }
}

impl fmt::Display for RequestId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RequestId::Number(n) => write!(f, "{n}"),
            RequestId::String(s) => write!(f, "{s}"),
        }
    }
}

// ── JSON-RPC pending / PreparedRpc / prompt 等待（原 acp/jsonrpc.rs，A1c 收敛）──

/// 准备好的 JSON-RPC 请求（D12：后端专属状态封在 [`SdkPreparedRpc`]，
/// `line`/`write_tx`/`rx` 不出现在公开面）。
pub struct PreparedRpc {
    /// Pylon 相关 id（本地计数器）；wire id 永不暴露。
    pub id: u64,
    pub sdk: SdkPreparedRpc,
}

impl PreparedRpc {
    /// 发送请求行，返回响应接收器。
    pub async fn send_keep_rx(self) -> Result<oneshot::Receiver<RawMessage>, AcpError> {
        super::engine::send_keep_rx_prepared(self).await
    }

    /// 发送 + 等待匹配响应（超时值来自协议配置）。
    pub async fn complete(self) -> Result<serde_json::Value, AcpError> {
        super::engine::complete_prepared(self).await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptTimeoutKind {
    FirstToken,
    Idle,
    /// #352：用户已发出 cancel（一等判死输入）——跳过闲置/首 token 评估，直接
    /// 进入 cancel-settle 窗口；`bound` 记录 settle 窗口配置。
    UserCancel,
}

impl PromptTimeoutKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FirstToken => "first-token",
            Self::Idle => "idle",
            Self::UserCancel => "user-cancel",
        }
    }
}

#[derive(Debug)]
pub enum PromptWaitOutcome {
    Response(RawMessage),
    CancelledAfterTimeout {
        response: Option<RawMessage>,
        cancel_error: Option<String>,
        timeout_kind: PromptTimeoutKind,
        timeout_bound: std::time::Duration,
        elapsed: std::time::Duration,
        /// #99：cancel 后 settle 窗口的可判定解析——Agent 在窗口内回终态、
        /// 窗口超时、或响应通道消失（引擎任务已终止），三者不再合并为 None。
        settle: CancelSettleResolution,
    },
    ConnectionClosed,
}

/// #99：超时触发 cancel 后 settle 窗口的解析结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelSettleResolution {
    /// Agent 在 settle 窗口内回终态——使用该终态（issue #99 验收：窗口内回的
    /// 终态必须胜出）。
    Responded,
    /// settle 窗口超时且无终态。
    SettleTimeout,
    /// 响应 oneshot 被丢弃（引擎任务终止 = 连接级失败）。
    ResponderDropped,
}

/// Wait for a prompt response. On truncation, send session/cancel and keep the
/// response receiver alive until Peri confirms the cancelled turn has settled.
///
/// R-t5（2026-08-20）正确的截断语义——活动续命、无输出才截：
/// - `last_activity` 探针返回本回合会话最近一次活动（文本/思考/工具/usage）的单调时刻，
///   `None` 表示从未有活动。等待循环以"距上次活动"判闲置，而非"回合总时长"。
/// - 任一 ACP 活动即续命：只要持续产出，回合永不因总时长被截。
/// - 首次活动始终未出现（`activity` 不晚于 `start`）且超过 `first_token_timeout` → 判死（首 token 超时）。
/// - 已活动但距最近活动超过 `idle_timeout` 仍无终态 → 判死（闲置超时）。
/// - `prompt_timeout` 仅作为未单独配置 `idle_timeout` 时的单步闲置超时；
///   不设整轮绝对墙钟。一个回合可以包含任意多个分析、思考和工具步骤，
///   每个步骤都必须分别获得完整的超时窗口。
///
/// 任一判死后进入 cancel + settle。`force_kill` 在 cancel 后仍未 settle 时给
/// 调用方一次进程树强清机会（Windows 上观察到的 Hermes/MSYS 死锁）；回调由
/// 调用方显式传入，本层不感知 provider 进程策略——非 Hermes 调用方传 no-op
/// `|| async {}`（原 `wait_prompt_with_cancel` 薄包装无独有语义，已并入本参数删除）。
///
/// #352：`cancel_requested` 是**一等判死输入**——置位（用户已对当前会话发出
/// cancel）即跳过闲置/首 token 评估，直接进入 cancel + settle 路径。没有这一路
/// 输入时，agent 在 cancel 后继续产出会不断刷新 `last_activity`，闲置判死被
/// 无限续命，settle 窗口永远进不去，回合可能永不收敛。命中 flag 后活动刷新
/// 自然失效（完全绕开 liveness 评估）。
#[allow(clippy::too_many_arguments)]
pub async fn wait_prompt_with_recovery<F, Fut, K, KF>(
    rx: &mut oneshot::Receiver<RawMessage>,
    cancel_settle_timeout: std::time::Duration,
    idle_timeout: std::time::Duration,
    first_token_timeout: std::time::Duration,
    last_activity: impl Fn() -> Option<std::time::Instant>,
    cancel_requested: impl Fn() -> bool,
    cancel: F,
    force_kill: K,
) -> PromptWaitOutcome
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
    K: FnOnce() -> KF,
    KF: Future<Output = ()>,
{
    let start = std::time::Instant::now();
    // 轮询粒度：取待判定的最小非零超时的一小段，既及时又不忙转。
    let poll = smallest_nonzero([idle_timeout, first_token_timeout, std::time::Duration::ZERO]) / 8;
    loop {
        // 先评估是否该判死（在 sleep 前，避免刚发完就等一个轮询周期的空档）。
        // #352：用户 cancel 置位优先于闲置/首 token 评估——判死边界记为 settle
        // 窗口配置（判死本身无墙钟，flag 命中即触发）。
        let fire_reason = if cancel_requested() {
            Some(TruncationFire {
                kind: PromptTimeoutKind::UserCancel,
                bound: cancel_settle_timeout,
                elapsed: start.elapsed(),
            })
        } else {
            evaluate_truncation(start, idle_timeout, first_token_timeout, last_activity())
        };
        if let Some(fire_reason) = fire_reason {
            let cancel_error = match tokio::time::timeout(
                std::time::Duration::from_secs(DEFAULT_WRITE_TIMEOUT_SECS),
                cancel(),
            )
            .await
            {
                Ok(result) => result.err(),
                Err(_) => {
                    tracing::warn!("ACP: cancel timed out after {DEFAULT_WRITE_TIMEOUT_SECS}s");
                    Some("ACP write timeout".to_string())
                }
            };
            let (response, settle) =
                match tokio::time::timeout(cancel_settle_timeout, &mut *rx).await {
                    Ok(Ok(raw)) => (Some(raw), CancelSettleResolution::Responded),
                    Ok(Err(_)) => (None, CancelSettleResolution::ResponderDropped),
                    Err(_) => (None, CancelSettleResolution::SettleTimeout),
                };
            if response.is_none() {
                // A provider can acknowledge neither session/cancel nor the
                // pending prompt (the Hermes/MSYS deadlock observed on
                // Windows).  Give the provider-specific owner one chance to
                // terminate its process tree so the next ACP generation can
                // reconnect instead of leaving a wedged child behind.
                force_kill().await;
            }
            // fire_reason 用于日志（多少秒后因何截断）；对外文案仍是统一超时语义。
            tracing::warn!(
                "ACP: prompt truncated ({}) after {}ms (bound={}ms)",
                fire_reason.kind.as_str(),
                fire_reason.elapsed.as_millis(),
                fire_reason.bound.as_millis()
            );
            return PromptWaitOutcome::CancelledAfterTimeout {
                response,
                cancel_error,
                timeout_kind: fire_reason.kind,
                timeout_bound: fire_reason.bound,
                elapsed: fire_reason.elapsed,
                settle,
            };
        }
        tokio::select! {
            r = &mut *rx => {
                match r {
                    Ok(raw) => return PromptWaitOutcome::Response(raw),
                    Err(_) => return PromptWaitOutcome::ConnectionClosed,
                }
            }
            _ = tokio::time::sleep(poll) => {}
        }
    }
}

/// 截断判据的触发结果。
struct TruncationFire {
    /// 触发的语义类别（首 token / 闲置 / 用户 cancel，#352）。
    kind: PromptTimeoutKind,
    /// 本次判定使用的配置边界。
    bound: std::time::Duration,
    /// 从 prompt wait 开始到触发的实际单调耗时。
    elapsed: std::time::Duration,
}

/// 评估是否该判死；返回 Some = 应立即截断。
fn evaluate_truncation(
    start: std::time::Instant,
    idle_timeout: std::time::Duration,
    first_token_timeout: std::time::Duration,
    last_activity: Option<std::time::Instant>,
) -> Option<TruncationFire> {
    let now = std::time::Instant::now();
    let elapsed = now.duration_since(start);
    // 活动"在本回合发送之后"才算本回合已开始（dispatcher 对历史回合的活动不计入）。
    let active_after_start = last_activity.map(|t| t >= start).unwrap_or(false);
    let reason = if active_after_start {
        // 已开始：按闲置判定。
        if let Some(last) = last_activity {
            if now.duration_since(last) >= idle_timeout {
                Some((PromptTimeoutKind::Idle, idle_timeout))
            } else {
                None
            }
        } else {
            None
        }
    } else if elapsed >= first_token_timeout {
        // 从未开始：按首 token 判定。
        Some((PromptTimeoutKind::FirstToken, first_token_timeout))
    } else {
        None
    };
    if let Some((kind, bound)) = reason {
        return Some(TruncationFire {
            kind,
            bound,
            elapsed,
        });
    }
    None
}

/// 取一组非零 Duration 的最小值；全零则返回 1ms（避免除以零 / 忙转）。
fn smallest_nonzero(durations: [std::time::Duration; 3]) -> std::time::Duration {
    durations
        .iter()
        .copied()
        .filter(|d| !d.is_zero())
        .min()
        .unwrap_or(std::time::Duration::from_millis(1))
}

/// ISSUE-17 W1（LR2-WI06）：ACP crash 原因稳定枚举（wire snake_case 字符串）。
/// 禁止用错误文本正则区分 crash 类型（ISSUE-17 禁止事项）——writer 失败/EOF
/// 必须用稳定 code 区分，供 dispatcher 消费 reason 生成用户可读文案并保留诊断字段。
/// 词表纪律（#348 A1）：每个变体必须有可指出的产生点，不留无产生者的死变体。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CrashReason {
    /// 物理传输失败（stdin 写 EPIPE / stdout 读 IO 错误）。产生点 =
    /// `spawn_sdk_engine` 子侧传输收尾的 [`transport_failure_reason`] 分类。
    WriterFailed,
    /// stdout EOF（agent 进程退出/管道关闭）。
    StdoutClosed,
    /// pending 分片锁中毒（保守收敛，fail-closed）。
    ///
    /// 豁免保留（#348 返工裁定）：本仓**无产生点**——release 为
    /// `panic = "abort"`，锁中毒即进程终止，本变体描述的「保守收敛」在
    /// release 下不可达。未按词表纪律摘除，因前端错误码词表
    /// （`src/app/errorCodeExplanations.ts` 的 `pending_lock_poisoned` 词条）
    /// 已承载该 code 的文案，前端域属另一在途批次；反向映射
    /// `crash_reason_from_code` 对远端传入的该 code 仍按词表放行。
    /// 前端词条收编或删除后应一并摘除本变体。
    PendingLockPoisoned,
    /// #99：入站投递过载（inbox+spill 均满，显式 gap 终止连接）。
    Overloaded,
}

impl CrashReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            CrashReason::WriterFailed => "writer_failed",
            CrashReason::StdoutClosed => "stdout_closed",
            CrashReason::PendingLockPoisoned => "pending_lock_poisoned",
            CrashReason::Overloaded => "overloaded",
        }
    }
}

// #247：本文件测试的 fake agent 构造就地自持（原依赖宿主 test_utils——跨 crate 后
// 不可见）。定位逻辑与宿主 test_utils::fake_agent_bin 保持一致。
#[cfg(test)]
mod test_support {
    use pylon_core::agent_config::AgentDef;
    use std::collections::HashMap;

    pub fn fake_agent_bin() -> std::path::PathBuf {
        if let Ok(path) = std::env::var("PYLON_FAKE_AGENT_BIN") {
            if !path.trim().is_empty() {
                return std::path::PathBuf::from(path);
            }
        }
        let exe = std::env::current_exe().expect("current_exe must resolve");
        let bin_names: &[&str] = if cfg!(windows) {
            &["pylon-fake-agent.exe"]
        } else {
            &["pylon-fake-agent"]
        };
        for ancestor in exe.ancestors() {
            for name in bin_names {
                let candidate = ancestor.join(name);
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        panic!(
            "pylon-fake-agent bin not found（先构建：cargo build --bin pylon-fake-agent              --features test-agent；或设 PYLON_FAKE_AGENT_BIN 指向已有 bin）"
        )
    }

    pub fn fake_acp_agent_stub(name: &str) -> AgentDef {
        AgentDef {
            name: name.to_string(),
            provider: None,
            transport: "subprocess".to_string(),
            exe: fake_agent_bin().to_string_lossy().into_owned(),
            args: vec!["--scenario".to_string(), "alive".to_string()],
            cwd: None,
            env: HashMap::new(),
            default: false,
            set_model_api: false,
            model: None,
            hermes_profile: None,
            acp_args: Vec::new(),
            acp: None,
        }
    }
}
