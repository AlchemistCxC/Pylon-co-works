//! #99：prompt/turn 权威终态账本（terminal ledger）。
//!
//! 后端是 prompt/turn live state 的唯一权威来源：每个 turn 以
//! `(local_session_id, remote_session_id, generation, turn_id)` 为 key 登记，
//! 终态采用 compare-and-set——只有第一个终态拥有发布/持久化权，迟到的
//! response/update/cancel 只计入诊断计数（`late_terminal_events`），绝不产生
//! 第二个终帧。
//!
//! 与既有基础设施的边界（issue #99「方案与不变量 §2」）：
//! - ledger 决定**生命周期**（一个 prompt 至多一个 terminal transition）；
//! - canonical journal 决定 durable content（不复制第二套 durable 存储）；
//! - wire trace 决定诊断证据。
//!
//! generation 是硬隔离：key 携带 generation，旧代际的迟到 settle 永远不可能
//! 命中新代际的 turn；`drop_generation` 在客户端替换时批量收敛旧条目。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// 一个 turn 的稳定身份（四元组，缺一不可）。
///
/// `turn_id` 使用 Pylon 本地出站 request id（`PreparedRpc.id`），同一连接内
/// 唯一；generation 隔离后跨连接也不混淆。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TurnKey {
    pub local_session_id: String,
    pub remote_session_id: String,
    pub generation: u64,
    pub turn_id: u64,
}

/// 回合终态的稳定语义类别（issue #99：不能用一个"连接失败"吞掉原因）。
///
/// serde 序列化为 camelCase 供前端/冷挂载快照直接消费；`as_str` 提供稳定
/// snake_case wire code 供日志与诊断。
///
/// 词表按 issue #99 验收枚举**完备定义**（含 writer/EOF/过载等传输侧终因）；
/// 生产 prompt 路径当前直接构造其中一部分。尚未接线的变体逐项挂
/// `#[allow(dead_code)]`（预留，含摘除条件），不做模块/块级豁免。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnTerminalCause {
    /// 正常完成且有文本产出。
    Completed,
    /// 成功但无文本产出（UI 不得停在 prompting）。
    EmptyTurn { cause: EmptyTurnCause },
    /// agent 明确取消（stopReason=cancelled）。
    Cancelled,
    /// agent 拒绝（stopReason=refusal）。
    Refusal,
    /// agent 达到最大回合数（stopReason=max_turn_requests）。
    MaxTurn,
    /// 首 token 超时（判死后触发 cancel）。
    ///
    /// 预留（#99 词表，仅测试构造锁定 wire code）：判死类别现经 settle
    /// detail 编码（`triggered_by:first-token`），未落为独立终因；接线为
    /// 细粒度终因或词表收敛裁除时摘除。
    #[allow(dead_code)] // 预留：细粒度超时终因接线或词表收敛时摘除
    FirstTokenTimeout,
    /// 活动后闲置超时（判死后触发 cancel）。
    ///
    /// 预留（#99 词表，仅测试构造锁定 wire code）：判死类别现经 settle
    /// detail 编码（`triggered_by:idle`），未落为独立终因；接线为
    /// 细粒度终因或词表收敛裁除时摘除。
    #[allow(dead_code)] // 预留：细粒度超时终因接线或词表收敛时摘除
    IdleTimeout,
    /// cancel 已发出但 settle 窗口内未收到终态。
    CancelSettleTimeout,
    /// stdin 写超时（agent 存活但不读 stdin）。
    ///
    /// 预留（#99 词表，仅测试构造锁定 wire code）：writer 失败/超时现经
    /// `CrashReason` + ConnectionLost 收敛，未映射到账本终因；接线或词表
    /// 收敛裁除时摘除。
    #[allow(dead_code)] // 预留：writer 结算映射到账本终因时摘除
    WriterTimeout,
    /// stdin 写失败（EPIPE 等）。
    ///
    /// 预留（#99 词表，仅测试构造锁定 wire code）：writer 失败/超时现经
    /// `CrashReason` + ConnectionLost 收敛，未映射到账本终因；接线或词表
    /// 收敛裁除时摘除。
    #[allow(dead_code)] // 预留：writer 结算映射到账本终因时摘除
    WriterFailed,
    /// 连接关闭 / EOF / 引擎任务消失。
    ConnectionLost,
    /// 协议错误（畸形响应、未知 stopReason、RPC error）。
    ProtocolError,
    /// 入站过载：spill 溢出后以显式 gap 终止连接。
    ///
    /// 预留（#99 词表，仅测试构造锁定 wire code）：过载崩溃现以
    /// `CrashReason::Overloaded` 广播收敛，turn 结算尚未映射 Overloaded；
    /// 接线或词表收敛裁除时摘除。
    #[allow(dead_code)] // 预留：过载结算映射到账本终因时摘除
    Overloaded,
}

impl TurnTerminalCause {
    /// 稳定 snake_case wire code（诊断/日志用，禁止用错误文本正则反推）。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::EmptyTurn { .. } => "empty_turn",
            Self::Cancelled => "cancelled",
            Self::Refusal => "refusal",
            Self::MaxTurn => "max_turn",
            Self::FirstTokenTimeout => "first_token_timeout",
            Self::IdleTimeout => "idle_timeout",
            Self::CancelSettleTimeout => "cancel_settle_timeout",
            Self::WriterTimeout => "writer_timeout",
            Self::WriterFailed => "writer_failed",
            Self::ConnectionLost => "connection_lost",
            Self::ProtocolError => "protocol_error",
            Self::Overloaded => "overloaded",
        }
    }
}

/// 成功但无文本的回合的细分原因（issue #99：empty-turn cause 必须显式）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EmptyTurnCause {
    /// 有工具调用但无文本（tool-only 回合是合法成功）。
    ToolOnly,
    /// 回合被取消（取消本身解释了无文本）。
    Cancelled,
    /// agent 明确拒绝。
    Refusal,
    /// agent 什么都没产出。
    AgentEmpty,
    /// 无法判定（保守归类，不猜）。
    Unknown,
}

/// turn 生命周期阶段（issue #99 建议语义：Prompting → Streaming → Settling → 终态）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnPhase {
    /// 出站 session/prompt 已发送，等待首个活动。
    Prompting,
    /// 已收到本回合首个 live 活动（文本/思考/工具）。
    Streaming,
    /// 终态已判 waiting settle（cancel 已发出）。
    ///
    /// 预留（issue #99 语义完备性）：当前 cancel 已发出的中间态由超时路径
    /// 隐式跨越（settle 直接 Terminal）；超时路径显式进入 Settling 时摘除。
    #[allow(dead_code)] // 预留：超时路径显式建模 Settling 中间态时摘除
    Settling,
    /// 已收敛到唯一终态。
    Terminal,
}

/// 终态记录（CAS 胜者写入，不可变）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTerminal {
    pub cause: TurnTerminalCause,
    /// 终态判定时刻（毫秒时间戳，快照/冷挂载用）。
    pub settled_at_ms: u64,
    /// 诊断 detail（错误消息原文，可为空）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// 单个 turn 的账本条目。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRecord {
    pub key: TurnKeySnapshot,
    pub phase: TurnPhase,
    pub started_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<TurnTerminal>,
    /// 本 turn 观测到的最后一个入站 ingress sequence（诊断 cursor）。
    pub last_ingress_seq: u64,
    /// 本 turn 是否观测到 live 文本产出（empty-turn 判定输入）。
    pub saw_text: bool,
    /// 本 turn 是否观测到 live 工具调用（empty-turn 判定输入）。
    pub saw_tool: bool,
    /// 本 turn 是否观测到 live 思考流（#316：thinking-only 回合算有产出，
    /// 不再误判 agent-empty）。
    pub saw_thinking: bool,
}

/// [`TurnKey`] 的可序列化快照形态。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnKeySnapshot {
    pub local_session_id: String,
    pub remote_session_id: String,
    pub generation: u64,
    pub turn_id: u64,
}

impl TurnKey {
    pub fn snapshot(&self) -> TurnKeySnapshot {
        TurnKeySnapshot {
            local_session_id: self.local_session_id.clone(),
            remote_session_id: self.remote_session_id.clone(),
            generation: self.generation,
            turn_id: self.turn_id,
        }
    }
}

/// `begin` 的结果：同一 turn 重复 begin 是协议异常，但必须幂等可观测。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeginOutcome {
    Started,
    AlreadyActive,
}

/// `settle` 的 CAS 结果：只有 `Published` 拥有发布/持久化权。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SettleOutcome {
    /// 本调用是第一个终态：调用方获得发布权。
    Published,
    /// 迟到终态：已被拒绝发布，诊断计数 +1。
    Late { existing: TurnTerminalCause },
    /// 未知 turn（从未 begin，或已被清理）：无法归属，调用方只记日志。
    UnknownTurn,
}

/// turn 终态账本（per-agent runtime 一份）。
///
/// 内部为单 `Mutex` 下的双表：`active`（在途，逐帧热路径命中）与 `terminal`
/// （CAS 已收敛，终态保留裁剪只作用于本表）。所有操作锁内完成、锁外返回
/// clone，避免把账本锁跨越 await（与 runtime.rs 锁序纪律一致）；CAS 语义
/// 依赖「remove 出 active → 写终态 → 插入 terminal」在同一临界区内完成。
///
/// #334/P3：`note_session_activity` 每 chunk 只扫 `active` 表（每会话在途
/// 至多一个，`prompt_gate` 保证）并原地 `values_mut` 更新——不再全表扫、
/// 不再重建 `TurnKey`（原每 chunk 两次 `to_string()` + 全表 `filter().min()`）。
/// 内存上界（评审 E8）：settle 内建每会话终态保留裁剪，`drop_generation`
/// 随代际退出收敛；`late_terminal_events` 为诊断计数（读取面见其方法文档）。
#[derive(Debug, Default)]
pub struct TurnLedger {
    tables: Mutex<LedgerTables>,
    late_terminal_events: AtomicU64,
}

/// 账本双表（同一 `Mutex` 保护）。
#[derive(Debug, Default)]
struct LedgerTables {
    /// 在途 turn：begin 插入，settle 移出（同一锁内转移，非终态恒在此表）。
    active: HashMap<TurnKey, TurnRecord>,
    /// 已终态 turn：受 `TERMINAL_RETENTION_PER_SESSION` 裁剪约束。
    terminal: HashMap<TurnKey, TurnRecord>,
}

/// #99/#316：empty-turn 判定的活动标志（文本/工具/思考三 bit，可叠加）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ActivityFlags {
    /// 观测到 live 正文 chunk。
    pub saw_text: bool,
    /// 观测到 live 工具调用/更新。
    pub saw_tool: bool,
    /// 观测到 live 思考流（thinking-only 回合算有产出）。
    pub saw_thinking: bool,
}

impl TurnLedger {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 迟到终态计数（诊断：任何 >0 都意味着竞态路径被 CAS 拦截过）。
    ///
    /// 仅测试消费（#228）：生产诊断出口（冷挂载快照/日志）尚未读取该计数，
    /// 接入时摘除 `#[cfg(test)]`。
    #[cfg(test)]
    pub fn late_terminal_events(&self) -> u64 {
        self.late_terminal_events.load(Ordering::Relaxed)
    }

    /// 登记一个新 turn（Prompting 起点）。同一 key 重复 begin 幂等返回
    /// `AlreadyActive`（不重置已登记状态——原始 begin 的时间戳与阶段保持）。
    /// key 已在终态表（同 turn_id 重新 begin）同样按协议异常幂等拒绝。
    pub fn begin(&self, key: TurnKey, started_at_ms: u64) -> BeginOutcome {
        let mut tables = self.lock();
        if tables.active.contains_key(&key) || tables.terminal.contains_key(&key) {
            return BeginOutcome::AlreadyActive;
        }
        tables.active.insert(
            key.clone(),
            TurnRecord {
                key: key.snapshot(),
                phase: TurnPhase::Prompting,
                started_at_ms,
                terminal: None,
                last_ingress_seq: 0,
                saw_text: false,
                saw_tool: false,
                saw_thinking: false,
            },
        );
        BeginOutcome::Started
    }

    /// 推进阶段。Streaming/Settling 只能向前，不能从终态回退；未知 turn 静默
    /// 忽略（通知路径可能晚于终态清理到达）。
    ///
    /// 仅测试消费（#228）：生产 phase 推进走会话作用域的
    /// `note_session_activity`（dispatcher 不持有 turn_id）；持有 turn_id 的
    /// 生产调用方出现时摘除 `#[cfg(test)]`。
    #[cfg(test)]
    pub fn advance(&self, key: &TurnKey, phase: TurnPhase) {
        let mut tables = self.lock();
        if let Some(record) = tables.active.get_mut(key) {
            if record.terminal.is_some() {
                return;
            }
            let current_rank = phase_rank(record.phase);
            let next_rank = phase_rank(phase);
            if next_rank > current_rank {
                record.phase = phase;
            }
        }
    }

    /// 会话作用域的活动推进（dispatcher 用：不持有 turn_id，命中该会话在途的
    /// 唯一 turn）——刷新 ingress cursor / [`ActivityFlags`] 标志（#316 加思考
    /// 位），并把阶段推进到 Streaming。多活跃 turn（理论竞态）时取 turn_id
    /// 最小者，与 `settle_by_session` 的选择语义一致（评审 E9）。
    /// 返回是否命中在途 turn（false = 回合未登记或已终态，迟到活动只算诊断）。
    ///
    /// #334/P3：只扫 active 表单遍 `values_mut` 原地更新——终态记录已移出
    /// （不需 `terminal.is_none()` 过滤）、命中即改（不再重建 `TurnKey` 二次查表）。
    pub fn note_session_activity(
        &self,
        local_session_id: &str,
        remote_session_id: &str,
        generation: u64,
        ingress_seq: u64,
        flags: ActivityFlags,
    ) -> bool {
        let mut tables = self.lock();
        let target = tables
            .active
            .values_mut()
            .filter(|record| {
                record.key.local_session_id == local_session_id
                    && record.key.remote_session_id == remote_session_id
                    && record.key.generation == generation
            })
            .min_by_key(|record| record.key.turn_id);
        match target {
            Some(record) => {
                record.last_ingress_seq = record.last_ingress_seq.max(ingress_seq);
                record.saw_text |= flags.saw_text;
                record.saw_tool |= flags.saw_tool;
                record.saw_thinking |= flags.saw_thinking;
                if phase_rank(record.phase) < phase_rank(TurnPhase::Streaming) {
                    record.phase = TurnPhase::Streaming;
                }
                true
            }
            None => false,
        }
    }

    /// CAS 终态：只有第一个 cause 获得发布权；迟到者只推进诊断计数。
    ///
    /// 保留上界（评审 E8）：settle 成功后按会话三元组做终态保留裁剪——至多
    /// 保留 [`TERMINAL_RETENTION_PER_SESSION`] 条最新终态，更旧的即时释放
    /// （`latest_session_snapshot` 的「最近终态」语义只需要一条）。在途记录
    /// 不受裁剪影响。
    pub fn settle(
        &self,
        key: &TurnKey,
        cause: TurnTerminalCause,
        settled_at_ms: u64,
        detail: Option<String>,
    ) -> SettleOutcome {
        let mut tables = self.lock();
        // CAS 语义（#334/P3 拆表后保持）：remove 出 active → 写终态 → 插入
        // terminal 全在同一临界区内；不在 active 表则在 terminal 表查迟到终态。
        match tables.active.remove(key) {
            Some(mut record) => {
                record.terminal = Some(TurnTerminal {
                    cause,
                    settled_at_ms,
                    detail,
                });
                record.phase = TurnPhase::Terminal;
                tables.terminal.insert(key.clone(), record);
                Self::prune_terminal_retention(&mut tables.terminal, key);
                SettleOutcome::Published
            }
            None => match tables.terminal.get(key) {
                Some(record) => {
                    self.late_terminal_events.fetch_add(1, Ordering::Relaxed);
                    SettleOutcome::Late {
                        existing: record
                            .terminal
                            .as_ref()
                            .expect("terminal 表内记录必已收敛")
                            .cause
                            .clone(),
                    }
                }
                None => SettleOutcome::UnknownTurn,
            },
        }
    }

    /// 每会话三元组保留的最新终态记录数（冷挂载语义只需最近一条，留少量
    /// 余量供诊断对比）。
    const TERMINAL_RETENTION_PER_SESSION: usize = 8;

    /// 裁剪同会话三元组下超量的旧终态记录（settle 锁内调用，只作用于 terminal 表）。
    ///
    /// just-settled 永不参与裁剪候选（评审 P2-2）：墙钟回拨时它的
    /// `settled_at_ms` 可能小于存量终态，若参排会被误判为最旧而即时丢失
    /// （且 settle 已返回 Published、静默不可观测）。语义：保留最近
    /// `TERMINAL_RETENTION_PER_SESSION` 条**含 just-settled**——候选为存量
    /// 终态，超出容纳空间时从最旧开始裁剪，为其腾位。
    fn prune_terminal_retention(
        terminal: &mut HashMap<TurnKey, TurnRecord>,
        just_settled: &TurnKey,
    ) {
        let mut stale_candidates: Vec<(u64, u64)> = terminal
            .iter()
            .filter(|(key, _)| {
                key.turn_id != just_settled.turn_id
                    && key.local_session_id == just_settled.local_session_id
                    && key.remote_session_id == just_settled.remote_session_id
                    && key.generation == just_settled.generation
            })
            .map(|(key, record)| {
                (
                    record
                        .terminal
                        .as_ref()
                        .map(|terminal| terminal.settled_at_ms)
                        .unwrap_or(0),
                    key.turn_id,
                )
            })
            .collect();
        // candidates + just_settled 的总数须 ≤ 上界；超出即从最旧候选裁起。
        let excess =
            (stale_candidates.len() + 1).saturating_sub(Self::TERMINAL_RETENTION_PER_SESSION);
        if excess == 0 {
            return;
        }
        // 最旧优先（时间戳同毫秒时以 turn_id 定序，保证确定性）。
        stale_candidates.sort_unstable_by_key(|(at, id)| (*at, *id));
        let stale_ids: std::collections::HashSet<u64> = stale_candidates[..excess]
            .iter()
            .map(|(_, id)| *id)
            .collect();
        terminal.retain(|key, _| {
            !(key.local_session_id == just_settled.local_session_id
                && key.remote_session_id == just_settled.remote_session_id
                && key.generation == just_settled.generation
                && stale_ids.contains(&key.turn_id))
        });
    }

    /// 按会话三元组结算该 source 当前唯一在途 turn。
    ///
    /// prompt_gate 保证同一实例同一时刻至多一个 prompt，因此会话三元组至多
    /// 命中一个未终态 turn；若存在多个（理论竞态），取 turn_id 最小者结算，
    /// 其余留给显式 key 调用收敛。
    ///
    /// 仅测试消费（#228）：生产结算路径（session/prompt）持完整 `TurnKey`
    /// 直接走 `settle`；无 key 的生产结算方出现时摘除 `#[cfg(test)]`。
    #[cfg(test)]
    pub fn settle_by_session(
        &self,
        local_session_id: &str,
        remote_session_id: &str,
        generation: u64,
        cause: TurnTerminalCause,
        settled_at_ms: u64,
        detail: Option<String>,
    ) -> SettleOutcome {
        // 与原全表选择语义逐一对照：候选含在途与终态（终态命中走 Late），
        // 取 turn_id 最小者。
        let target = {
            let tables = self.lock();
            tables
                .active
                .keys()
                .chain(tables.terminal.keys())
                .filter(|key| {
                    key.local_session_id == local_session_id
                        && key.remote_session_id == remote_session_id
                        && key.generation == generation
                })
                .min_by_key(|key| key.turn_id)
                .cloned()
        };
        match target {
            Some(key) => self.settle(&key, cause, settled_at_ms, detail),
            None => SettleOutcome::UnknownTurn,
        }
    }

    /// 快照：指定 turn 的当前记录（冷挂载/诊断只读投影）。
    pub fn snapshot(&self, key: &TurnKey) -> Option<TurnRecord> {
        let tables = self.lock();
        tables
            .active
            .get(key)
            .cloned()
            .or_else(|| tables.terminal.get(key).cloned())
    }

    /// 快照：某会话「在途优先、否则最近终态」的单条 turn 记录（冷挂载数据面）。
    ///
    /// 冷挂载语义：有在途 turn 返回它（UI 恢复 prompting/streaming）；没有则
    /// 返回最近收敛的终态 turn（UI 恢复 terminalCause）；会话从未有 turn 返回
    /// None。不伪造状态——快照缺 turn 字段就是「本会话无已知 turn 事实」。
    pub fn latest_session_snapshot(
        &self,
        local_session_id: &str,
        remote_session_id: &str,
        generation: u64,
    ) -> Option<TurnRecord> {
        let tables = self.lock();
        let active = tables
            .active
            .values()
            .filter(|record| {
                record.key.local_session_id == local_session_id
                    && record.key.remote_session_id == remote_session_id
                    && record.key.generation == generation
            })
            .min_by_key(|record| record.key.turn_id);
        match active {
            Some(record) => Some(record.clone()),
            None => tables
                .terminal
                .values()
                .filter(|record| {
                    record.key.local_session_id == local_session_id
                        && record.key.remote_session_id == remote_session_id
                        && record.key.generation == generation
                })
                .max_by_key(|record| {
                    record
                        .terminal
                        .as_ref()
                        .map(|terminal| terminal.settled_at_ms)
                        .unwrap_or(0)
                })
                .cloned(),
        }
    }

    /// generation 硬隔离清理：客户端替换后旧代际条目整体收敛。
    /// 返回被清理的条目数（诊断）。
    /// (#260-B7) 单遍 retain 替代「收集 keys 再逐个 remove」的两遍遍历，同删除集。
    pub fn drop_generation(&self, generation: u64) -> usize {
        let mut tables = self.lock();
        let before = tables.active.len() + tables.terminal.len();
        tables.active.retain(|key, _| key.generation != generation);
        tables
            .terminal
            .retain(|key, _| key.generation != generation);
        let after = tables.active.len() + tables.terminal.len();
        before - after
    }

    #[cfg(test)]
    fn snapshot_records_for_test(&self, local: &str, remote: &str, generation: u64) -> Vec<u64> {
        let tables = self.lock();
        tables
            .active
            .values()
            .chain(tables.terminal.values())
            .filter(|record| {
                record.key.local_session_id == local
                    && record.key.remote_session_id == remote
                    && record.key.generation == generation
            })
            .map(|record| record.key.turn_id)
            .collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, LedgerTables> {
        self.tables
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn phase_rank(phase: TurnPhase) -> u8 {
    match phase {
        TurnPhase::Prompting => 0,
        TurnPhase::Streaming => 1,
        TurnPhase::Settling => 2,
        TurnPhase::Terminal => 3,
    }
}

/// 从 session/prompt 响应 result 推导终态 cause（纯函数，供 prompt 路径与测试共用）。
///
/// 与 `prompt_stop_outcome` 的判定表对齐（#316）：end_turn / max_tokens /
/// max_turn_requests 是协议级成功（max_tokens 达上限也是合法终态，UI 凭
/// done 载荷里的 stopReason 区分提示）；refusal / cancelled 是协议级提前
/// 终止；其余/缺失 = protocol error。
pub fn terminal_cause_from_prompt_result(result: &serde_json::Value) -> TurnTerminalCause {
    let stop_reason = result
        .get("stopReason")
        .and_then(|value| value.as_str())
        .map(str::trim);
    match stop_reason {
        Some("end_turn") => TurnTerminalCause::Completed,
        Some("max_tokens") => TurnTerminalCause::Completed,
        Some("max_turn_requests") => TurnTerminalCause::MaxTurn,
        Some("cancelled") => TurnTerminalCause::Cancelled,
        Some("refusal") => TurnTerminalCause::Refusal,
        _ => TurnTerminalCause::ProtocolError,
    }
}

/// empty-turn cause 推导（纯函数）。
///
/// 优先级：agent 明确取消/拒绝 → 它们本身就是"无文本"的权威解释；否则有工具
/// 无文本 = tool-only（合法成功）；有思考流无文本 = 同样算有产出（#316：
/// thinking-only 回合判 completed，不再误报 agent-empty）；完全无产出 =
/// agent-empty；把本函数用在不代表"成功收尾"的终态上属于调用方契约破坏，
/// 防御性归 unknown（不猜）。
pub fn empty_turn_cause(
    terminal: &TurnTerminalCause,
    saw_text: bool,
    saw_tool: bool,
    saw_thinking: bool,
) -> Option<EmptyTurnCause> {
    if saw_text || saw_thinking {
        return None;
    }
    match terminal {
        TurnTerminalCause::Cancelled => Some(EmptyTurnCause::Cancelled),
        TurnTerminalCause::Refusal => Some(EmptyTurnCause::Refusal),
        TurnTerminalCause::Completed | TurnTerminalCause::MaxTurn => Some(if saw_tool {
            EmptyTurnCause::ToolOnly
        } else {
            EmptyTurnCause::AgentEmpty
        }),
        _ => Some(EmptyTurnCause::Unknown),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(turn_id: u64) -> TurnKey {
        TurnKey {
            local_session_id: "local:s1".to_string(),
            remote_session_id: "peri-s1".to_string(),
            generation: 1,
            turn_id,
        }
    }

    fn ledger() -> Arc<TurnLedger> {
        TurnLedger::new()
    }

    #[test]
    fn begin_then_settle_publishes_exactly_once() {
        let ledger = ledger();
        let k = key(7);
        assert_eq!(ledger.begin(k.clone(), 100), BeginOutcome::Started);
        assert_eq!(
            ledger.settle(&k, TurnTerminalCause::Completed, 200, None),
            SettleOutcome::Published
        );
        // 重复终态：CAS 拒绝 + 诊断计数
        assert_eq!(
            ledger.settle(&k, TurnTerminalCause::ConnectionLost, 300, None),
            SettleOutcome::Late {
                existing: TurnTerminalCause::Completed
            }
        );
        assert_eq!(ledger.late_terminal_events(), 1);
        let record = ledger.snapshot(&k).expect("record kept for audit");
        assert_eq!(record.phase, TurnPhase::Terminal);
        assert_eq!(record.terminal.unwrap().settled_at_ms, 200);
    }

    #[test]
    fn duplicate_begin_is_idempotent_and_keeps_original_start() {
        let ledger = ledger();
        let k = key(1);
        assert_eq!(ledger.begin(k.clone(), 10), BeginOutcome::Started);
        assert_eq!(ledger.begin(k.clone(), 99), BeginOutcome::AlreadyActive);
        assert_eq!(ledger.snapshot(&k).unwrap().started_at_ms, 10);
    }

    #[test]
    fn cancel_and_response_race_produces_single_terminal() {
        let ledger = ledger();
        let k = key(2);
        ledger.begin(k.clone(), 0);
        // cancel 路径先到
        assert_eq!(
            ledger.settle_by_session(
                "local:s1",
                "peri-s1",
                1,
                TurnTerminalCause::IdleTimeout,
                50,
                None
            ),
            SettleOutcome::Published
        );
        // response 迟到（settle 窗口内的真实终态也只算 Late——第一个已发布）
        assert!(matches!(
            ledger.settle(&k, TurnTerminalCause::Completed, 60, None),
            SettleOutcome::Late { .. }
        ));
        // EOF 也迟到
        assert!(matches!(
            ledger.settle(&k, TurnTerminalCause::ConnectionLost, 70, None),
            SettleOutcome::Late { .. }
        ));
        assert_eq!(ledger.late_terminal_events(), 2);
    }

    #[test]
    fn generation_isolation_rejects_stale_settle() {
        let ledger = ledger();
        let mut old = key(3);
        old.generation = 1;
        ledger.begin(old.clone(), 0);
        // 客户端替换：generation 2 开新 turn
        let mut new = key(4);
        new.generation = 2;
        ledger.begin(new.clone(), 10);
        // 旧代际迟到 response 不能触碰新代际
        assert_eq!(
            ledger.settle(&old, TurnTerminalCause::Completed, 20, None),
            SettleOutcome::Published
        );
        let new_record = ledger.snapshot(&new).expect("new generation intact");
        assert!(new_record.terminal.is_none(), "旧代际终态不得泄漏到新代际");
        // 新代际独立收敛
        assert_eq!(
            ledger.settle(&new, TurnTerminalCause::FirstTokenTimeout, 30, None),
            SettleOutcome::Published
        );
    }

    #[test]
    fn drop_generation_clears_only_stale_entries() {
        let ledger = ledger();
        let mut g1 = key(5);
        g1.generation = 1;
        let mut g2 = key(6);
        g2.generation = 2;
        ledger.begin(g1.clone(), 0);
        ledger.begin(g2.clone(), 0);
        assert_eq!(ledger.drop_generation(1), 1);
        assert!(ledger.snapshot(&g1).is_none());
        assert!(ledger.snapshot(&g2).is_some());
        // 旧代际条目清理后，迟到 settle 归 UnknownTurn（不可归属）
        assert_eq!(
            ledger.settle(&g1, TurnTerminalCause::ConnectionLost, 5, None),
            SettleOutcome::UnknownTurn
        );
    }

    #[test]
    fn phase_advances_forward_only_and_never_past_terminal() {
        let ledger = ledger();
        let k = key(8);
        ledger.begin(k.clone(), 0);
        ledger.advance(&k, TurnPhase::Streaming);
        assert_eq!(ledger.snapshot(&k).unwrap().phase, TurnPhase::Streaming);
        // 回退尝试被拒绝
        ledger.advance(&k, TurnPhase::Prompting);
        assert_eq!(ledger.snapshot(&k).unwrap().phase, TurnPhase::Streaming);
        ledger.advance(&k, TurnPhase::Settling);
        ledger.settle(&k, TurnTerminalCause::Cancelled, 10, None);
        // 终态后不得回退阶段
        ledger.advance(&k, TurnPhase::Prompting);
        assert_eq!(ledger.snapshot(&k).unwrap().phase, TurnPhase::Terminal);
    }

    #[test]
    fn activity_updates_cursor_and_text_flag() {
        let ledger = ledger();
        let k = key(9);
        ledger.begin(k.clone(), 0);
        ledger.note_session_activity(
            "local:s1",
            "peri-s1",
            1,
            5,
            ActivityFlags {
                saw_text: true,
                ..Default::default()
            },
        );
        ledger.note_session_activity(
            "local:s1",
            "peri-s1",
            1,
            3,
            ActivityFlags {
                saw_tool: true,
                ..Default::default()
            },
        ); // 乱序 cursor 不回退
        let record = ledger.snapshot(&k).unwrap();
        assert_eq!(record.last_ingress_seq, 5);
        assert!(record.saw_text);
        assert!(record.saw_tool);
    }

    #[test]
    fn terminal_retention_is_bounded_per_session() {
        let ledger = ledger();
        // 同会话三元组连发 12 个 turn 并全部 settle：终态保留裁剪到上界。
        for turn_id in 1..=12u64 {
            let k = key(turn_id);
            ledger.begin(k.clone(), turn_id);
            assert_eq!(
                ledger.settle(&k, TurnTerminalCause::Completed, 100 + turn_id, None),
                SettleOutcome::Published
            );
        }
        let retained = ledger
            .latest_session_snapshot("local:s1", "peri-s1", 1)
            .expect("最近终态必须保留");
        assert_eq!(retained.key.turn_id, 12, "保留的必须是最新终态");
        let mut terminal_turns: Vec<u64> =
            ledger.snapshot_records_for_test("local:s1", "peri-s1", 1);
        terminal_turns.sort_unstable();
        assert_eq!(
            terminal_turns.len(),
            TurnLedger::TERMINAL_RETENTION_PER_SESSION,
            "终态记录数必须收敛到保留上界"
        );
        // 在途 turn 不受裁剪影响
        let active = key(13);
        ledger.begin(active.clone(), 13);
        assert!(ledger.snapshot(&active).is_some());
    }

    #[test]
    fn prune_survives_clock_backwards_just_settled() {
        let ledger = ledger();
        for turn_id in 1..=8u64 {
            let k = key(turn_id);
            ledger.begin(k.clone(), turn_id);
            assert_eq!(
                ledger.settle(&k, TurnTerminalCause::Completed, 100 + turn_id, None),
                SettleOutcome::Published
            );
        }
        // 墙钟回拨（NTP 步进）：第 9 个 turn 的 settled_at_ms 小于全部存量。
        let k9 = key(9);
        ledger.begin(k9.clone(), 9);
        assert_eq!(
            ledger.settle(&k9, TurnTerminalCause::Completed, 50, None),
            SettleOutcome::Published
        );
        // P2-2：just-settled 已返回 Published，不得被裁剪静默丢失。
        assert!(
            ledger.snapshot(&k9).is_some(),
            "刚 settle 的记录不得被时钟回拨误裁"
        );
        let mut ids = ledger.snapshot_records_for_test("local:s1", "peri-s1", 1);
        ids.sort_unstable();
        assert_eq!(ids.len(), TurnLedger::TERMINAL_RETENTION_PER_SESSION);
        assert!(ids.contains(&9), "最新终态必须存活");
        assert_eq!(ids[0], 2, "被裁的应是时间戳最旧的 turn 1");
    }

    #[test]
    fn terminal_cause_mapping_covers_protocol_stop_reasons() {
        for (stop, expected) in [
            ("end_turn", TurnTerminalCause::Completed),
            ("max_turn_requests", TurnTerminalCause::MaxTurn),
            ("cancelled", TurnTerminalCause::Cancelled),
            ("refusal", TurnTerminalCause::Refusal),
        ] {
            let result = serde_json::json!({"stopReason": stop});
            assert_eq!(
                terminal_cause_from_prompt_result(&result),
                expected,
                "stopReason {stop} 映射错误"
            );
        }
        // 缺失 / 未知 stopReason = 协议错误
        assert_eq!(
            terminal_cause_from_prompt_result(&serde_json::json!({})),
            TurnTerminalCause::ProtocolError
        );
        assert_eq!(
            terminal_cause_from_prompt_result(&serde_json::json!({"stopReason": "warp_drive"})),
            TurnTerminalCause::ProtocolError
        );
    }

    #[test]
    fn empty_turn_cause_prioritizes_tool_only_and_agent_states() {
        // 有文本 → 不是空回合
        assert_eq!(
            empty_turn_cause(&TurnTerminalCause::Completed, true, false, false),
            None
        );
        // 有工具无文本 → tool-only
        assert_eq!(
            empty_turn_cause(&TurnTerminalCause::Completed, false, true, false),
            Some(EmptyTurnCause::ToolOnly)
        );
        // 取消/拒绝本身解释了空文本
        assert_eq!(
            empty_turn_cause(&TurnTerminalCause::Cancelled, false, false, false),
            Some(EmptyTurnCause::Cancelled)
        );
        assert_eq!(
            empty_turn_cause(&TurnTerminalCause::Refusal, false, false, false),
            Some(EmptyTurnCause::Refusal)
        );
        // 完全无产出 → agent-empty
        assert_eq!(
            empty_turn_cause(&TurnTerminalCause::Completed, false, false, false),
            Some(EmptyTurnCause::AgentEmpty)
        );
        // #316：只有思考流也算有产出 → 不是空回合
        assert_eq!(
            empty_turn_cause(&TurnTerminalCause::Completed, false, false, true),
            None
        );
    }

    #[test]
    fn note_session_activity_ors_thinking_flag() {
        let ledger = ledger();
        ledger.begin(key(7), 0);
        assert!(ledger.note_session_activity(
            "local:s1",
            "peri-s1",
            1,
            1,
            ActivityFlags {
                saw_thinking: true,
                ..Default::default()
            }
        ));
        let record = ledger.snapshot(&key(7)).expect("turn must be tracked");
        assert!(!record.saw_text && !record.saw_tool && record.saw_thinking);
    }

    #[test]
    fn settle_by_session_targets_oldest_active_turn() {
        let ledger = ledger();
        let mut a = key(20);
        a.remote_session_id = "peri-x".to_string();
        let mut b = key(21);
        b.remote_session_id = "peri-x".to_string();
        ledger.begin(a.clone(), 0);
        ledger.begin(b.clone(), 1);
        // 三元组结算命中 turn_id 最小的在途 turn
        assert_eq!(
            ledger.settle_by_session(
                "local:s1",
                "peri-x",
                1,
                TurnTerminalCause::Overloaded,
                9,
                None
            ),
            SettleOutcome::Published
        );
        assert!(ledger.snapshot(&a).unwrap().terminal.is_some());
        assert!(ledger.snapshot(&b).unwrap().terminal.is_none());
    }

    #[test]
    fn unknown_turn_settle_is_observable_not_fatal() {
        let ledger = ledger();
        assert_eq!(
            ledger.settle(&key(404), TurnTerminalCause::Completed, 0, None),
            SettleOutcome::UnknownTurn
        );
        assert_eq!(ledger.late_terminal_events(), 0);
    }
}
