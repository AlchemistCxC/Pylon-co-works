//! 揭示预算引擎（对应 TS 基线 `src/renderers/solid-workbench/streamingDisplayScheduler.ts`
//! 的**计算**部分，#220 WP3）。
//!
//! 揭示契约（语义不变，只换实现）：
//! - **D1 预算逐行递减**：一次发布的**聚合**新增不超过预算——逐行决策一次，
//!   每行从剩余预算里按剩余行数摊分，任何一行都不再独占整拍预算；
//! - **D2 UTF-16 计量且不劈字素**：记账量纲 = UTF-16 单元（与欠账/预算同量纲），
//!   步进单位 = 字素（UAX#29 extended grapheme cluster）。astral 文本
//!   （1 字素 = 2+ 单元）不会超预算；切分点永不落在字素内部；
//! - **60fps 发布节奏**：帧源（requestAnimationFrame）与定时器留在 JS 编排侧，
//!   引擎只做预算数学（`updateIntervalMs` 等节奏常量由 JS 传入）；
//! - **400ms 追赶窗口**：积压超过平滑容量时开启/延长固定窗口，窗口内按
//!   `ceil(欠账 / 剩余拍数)` 提速，收敛即清零——一次突发必须在窗口内排干，
//!   但"揭示剩余全部"永远不会挤进一帧。
//!
//! # 编排/计算的分界（这是引擎的形状，不是省略）
//!
//! TS 基线里的结构性路径——replacement flush（换会话/换代/列表重写）、终态合并
//! （微任务）、判据 A 历史整发、判据 C 增长集合、帧对齐与心跳、诊断环形缓冲——
//! 是**编排**，按 ADR-0018 留在 JS；它们决定"这一拍该不该发生、发布什么结构"。
//! 引擎负责其中可计算的部分：给定节奏常量与时刻序列，预算怎么分、每行揭示到哪。
//! 镜像（canonical 文本）是**单写者**：只有 [`RevealEngine::reset`] /
//! [`RevealEngine::feed`] 能写，`tick` 只读——镜像漂移可断言
//! （`mirror_text` 必须逐字节等于权威目标文本，parity 测试即此断言）。
//!
//! # 分层与数值口径
//!
//! 内层是普通 Rust 状态机（`f64` 时刻进、结构化结果出，宿主可测）；wasm 薄壳只做
//! 值/错误转换。所有单位量（预算/欠账/单元数）用 `f64` 并保持与 TS **相同的运算
//! 顺序**：`1000/60 = 16.66…68`、`400/(1000/60)` 这类 IEEE 运算两侧逐位一致，
//! 任何"数学上等价"的重排（先取整再除等）都可能让 `ceil/round` 越过整数边界，
//! 属于契约破坏而不是优化。

use serde::{Deserialize, Serialize};
use unicode_segmentation::UnicodeSegmentation;
use wasm_bindgen::prelude::*;

// ── 纯内层（宿主可测，零 JS 依赖） ───────────────────────────────────────────

/// 渲染侧节奏默认值。必须与 TS `DEFAULT_STREAMING_DISPLAY_OPTIONS` 逐项一致；
/// 那边是契约源，这边是镜像（退役后以本文件为源）。
pub const DEFAULT_MAX_UPDATES_PER_SECOND: f64 = 60.0;
pub const DEFAULT_REVEAL_UNITS_PER_SECOND: f64 = 120.0;
pub const DEFAULT_MAX_REVEAL_UNITS_PER_TICK: f64 = 128.0;
pub const DEFAULT_MAX_REVEAL_LAG_MS: f64 = 400.0;

/// 节奏选项（TS `StreamingDisplaySchedulerOptions` 的数值子集）。
/// 缺省/非正值按 TS `positiveFinite` 落回默认值，见 [`RevealEngine::new`]。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EngineOptions {
    pub max_updates_per_second: f64,
    pub reveal_units_per_second: f64,
    pub max_reveal_units_per_tick: f64,
    pub max_reveal_lag_ms: f64,
}

impl Default for EngineOptions {
    fn default() -> Self {
        Self {
            max_updates_per_second: DEFAULT_MAX_UPDATES_PER_SECOND,
            reveal_units_per_second: DEFAULT_REVEAL_UNITS_PER_SECOND,
            max_reveal_units_per_tick: DEFAULT_MAX_REVEAL_UNITS_PER_TICK,
            max_reveal_lag_ms: DEFAULT_MAX_REVEAL_LAG_MS,
        }
    }
}

/// TS `positiveFinite`：`undefined`/非有限/非正 ⇒ 回落默认值。
fn positive_finite(value: f64, fallback: f64) -> f64 {
    if value.is_finite() && value > 0.0 {
        value
    } else {
        fallback
    }
}

/// [`advance_prefix`] 的返回：揭示到的前缀 + 本次消费的 UTF-16 单元数
/// （D2：与预算/欠账同量纲）。
#[derive(Debug, Clone, PartialEq)]
pub struct PrefixAdvance {
    pub value: String,
    pub consumed_units: f64,
}

/// 单行推进（TS `advancePrefix`）：把 `current` 沿 `target` 按字素步进最多
/// `budget` 个 UTF-16 单元。
///
/// D2 的命门：Rust 字符串是 UTF-8，契约按 UTF-16 计量——逐字素累计 UTF-16
/// 长度，下一字素放不下即停。astral 文本（1 字素 = 2+ 单元）因此也不会超预算，
/// 代价是最多少用一个字素的余量。非前缀目标整发回落（TS 同分支）。
pub fn advance_prefix(current: &str, target: &str, budget: f64) -> PrefixAdvance {
    if current == target {
        return PrefixAdvance {
            value: current.to_string(),
            consumed_units: 0.0,
        };
    }
    if !target.starts_with(current) {
        return PrefixAdvance {
            value: target.to_string(),
            consumed_units: 0.0,
        };
    }
    let remaining = &target[current.len()..];
    if remaining.is_empty() || budget <= 0.0 {
        return PrefixAdvance {
            value: current.to_string(),
            consumed_units: 0.0,
        };
    }

    let (taken_bytes, code_units) = advance_graphemes(remaining, budget);
    PrefixAdvance {
        value: format!("{current}{}", &remaining[..taken_bytes]),
        consumed_units: code_units,
    }
}

/// 沿 `remaining` 按字素步进最多 `budget` 个 UTF-16 单元，返回
/// `(taken_bytes, consumed_units)`。[`advance_prefix`] 与 [`RevealEngine::tick`]
/// 共用这一段——tick 只要尾巴字节区间，不再为构造整条前缀付出一次 `format!` 复制。
fn advance_graphemes(remaining: &str, budget: f64) -> (usize, f64) {
    let mut code_units = 0.0f64;
    let mut taken_bytes = 0usize;
    for grapheme in remaining.graphemes(true) {
        let units = grapheme.chars().map(char::len_utf16).sum::<usize>() as f64;
        let next = code_units + units;
        if next > budget {
            break;
        }
        code_units = next;
        taken_bytes += grapheme.len();
    }
    (taken_bytes, code_units)
}

/// 一行的镜像与揭示状态。`canonical` 是镜像（单写者：`reset`/`feed`）；
/// `revealed_bytes` 是已发布前缀的字节长度（恒落在 char 边界：只按整字素推进）。
///
/// UTF-16 计数**增量记账**（#220 边界收口）：`canonical_units` 在 `feed` 时只对
/// delta 计数、`revealed_units` 在 `tick` 时累加已算出的 `consumed_units`。这些都是
/// 整数值的 f64（< 2^53），每步加法精确 ⇒ 与「从头 `encode_utf16().count()`」逐位
/// 一致，欠账/预算读数因此不触碰「与 TS 同运算顺序」的契约，而 `pending_units`
/// 从 O(全文)/拍降到 O(行数)/拍。
struct RevealRow {
    key: String,
    canonical: String,
    canonical_units: f64,
    revealed_bytes: usize,
    revealed_units: f64,
}

/// 一次 `tick` 的结果（TS `tick()` → `interpolateSnapshot` + `publishSnapshot` 的
/// 计算投影；结构发布/清定时器等编排动作由 JS 按 `kind` 执行）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TickOutcome {
    /// `"budgeted"`：按预算发布各行的揭示前缀；`"converged"`：全部文本已收敛，
    /// JS 应整发目标快照并清追赶窗口（TS 的 `pending === false` 路径）。
    pub kind: &'static str,
    /// 本拍预算（UTF-16 单元）。
    pub budget: f64,
    /// 预算计算时的欠账（UTF-16 单元，揭示前口径）。
    pub backlog_units: f64,
    /// 本拍单行最大新增（TS `advancedMaxUnits`）。
    pub advanced_max_units: f64,
    /// 本拍所有行新增之和（TS `advancedTotalUnits`）。
    pub advanced_total_units: f64,
    /// 参与本拍决策的行（`pending` 行，保持镜像顺序；converged 时为空）。
    pub rows: Vec<RowReveal>,
    /// 追赶窗口（重新）开启的累计次数（TS `catchUpWindows`）。
    pub catch_up_windows: u64,
}

/// 一行的本拍决策（TS `RowDecision` + 行 key）。
///
/// wire 形状是**增量尾巴**（#220 边界收口）：`tail` 只携带本拍新揭示的部分，JS 侧
/// 追加到自己持有的已揭示前缀上——整条前缀每拍过界是 O(全文)/拍、O(N²)/流的
/// 编组+复制+GC 开销（与投影 live 路线 A 同款病灶）。`revealed_length` 是本拍
/// 结束后已揭示前缀的 UTF-16 长度：JS 侧逐列表裁决（`resolveTailValue`）靠它判断
/// 本列表是否恰在揭示位上、分叉列表该截到哪，不追加就能自愈。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowReveal {
    pub key: String,
    /// 本拍新增的尾巴（`revealed_length - tail 的 UTF-16 长度` = 拍前揭示位）。
    pub tail: String,
    /// 本拍结束后该行已揭示前缀的 UTF-16 长度。
    pub revealed_length: f64,
    /// 该行本拍消费的 UTF-16 单元数。
    pub consumed_units: f64,
}

/// 揭示预算引擎（TS `createStreamingDisplayScheduler` 的计算核心）。
///
/// 纯状态机：不读时钟（`now` 全部由 JS 传参）、不做 IO、不动 DOM、不排帧。
/// 文本镜像单写者：只有 [`reset`](Self::reset)/[`feed`](Self::feed) 改镜像，
/// [`tick`](Self::tick) 只读。
pub struct RevealEngine {
    rows: Vec<RevealRow>,
    // ── 派生节奏常量（new 时一次算好，运算顺序与 TS 构造器一致） ──
    update_interval_ms: f64,
    reveal_units_per_second: f64,
    max_reveal_units_per_tick: f64,
    max_reveal_lag_ms: f64,
    /// 一整个积压被允许用来追赶的拍数（`catchUpTicks`）。
    catch_up_ticks: f64,
    /// 平滑打字速度在滞后窗口内就能消化的积压（`smoothBacklogCapacity`）。
    smooth_backlog_capacity: f64,
    // ── 状态 ──
    last_tick_at: f64,
    /// 当前追赶窗口的死线；`-∞` = 未开启。
    catch_up_deadline: f64,
    catch_up_windows: u64,
    /// 只读诊断镜像：预算只在有欠账的拍更新（TS `diagnosticsBudget` 同款怪癖，
    /// 保留它是为了 parity，不是设计）。
    last_backlog_units: f64,
    last_budget: f64,
}

impl RevealEngine {
    /// 用节奏常量构造引擎。选项经 TS `positiveFinite` 同款归一化；
    /// `last_tick_at` 由首次 [`reset`](Self::reset) 用传入时刻校正
    /// （TS 创建时取 `now()`，随后首次整发发布把它重置为发布时刻）。
    pub fn new(options: EngineOptions) -> Self {
        let max_updates_per_second = positive_finite(
            options.max_updates_per_second,
            DEFAULT_MAX_UPDATES_PER_SECOND,
        );
        let reveal_units_per_second = positive_finite(
            options.reveal_units_per_second,
            DEFAULT_REVEAL_UNITS_PER_SECOND,
        );
        let max_reveal_lag_ms =
            positive_finite(options.max_reveal_lag_ms, DEFAULT_MAX_REVEAL_LAG_MS);
        let max_reveal_units_per_tick = positive_finite(
            options.max_reveal_units_per_tick,
            DEFAULT_MAX_REVEAL_UNITS_PER_TICK,
        )
        .floor()
        .max(1.0);
        let update_interval_ms = 1000.0 / max_updates_per_second;
        // 一拍不拆：运算顺序保持 `Math.ceil(maxRevealLagMs / updateIntervalMs)`。
        let catch_up_ticks = (max_reveal_lag_ms / update_interval_ms).ceil().max(1.0);
        let smooth_backlog_capacity = reveal_units_per_second * max_reveal_lag_ms / 1000.0;
        Self {
            rows: Vec::new(),
            update_interval_ms,
            reveal_units_per_second,
            max_reveal_units_per_tick,
            max_reveal_lag_ms,
            catch_up_ticks,
            smooth_backlog_capacity,
            last_tick_at: 0.0,
            catch_up_deadline: f64::NEG_INFINITY,
            catch_up_windows: 0,
            last_backlog_units: 0.0,
            last_budget: 0.0,
        }
    }

    /// 用完整 canonical 文本重建镜像（TS 的 identity reset / 换代 / 换会话路径）。
    /// 语义 = 整发：每行视为已显示，无欠账、追赶窗口清零，`last_tick_at` 校正为
    /// 发布时刻（TS `publishSnapshot` 同款）。
    pub fn reset(&mut self, rows: &[(&str, &str)], at: f64) {
        self.rows = rows
            .iter()
            .map(|(key, text)| {
                let canonical_units = text.encode_utf16().count() as f64;
                RevealRow {
                    key: (*key).to_string(),
                    canonical: (*text).to_string(),
                    canonical_units,
                    revealed_bytes: text.len(),
                    revealed_units: canonical_units,
                }
            })
            .collect();
        self.catch_up_deadline = f64::NEG_INFINITY;
        self.last_tick_at = at;
    }

    /// 追加一行增量 delta（镜像单写者的直播入口）。未知行按"新出现的行"建立
    /// （TS `collectStreamRowPlans` 里新行以空显示态参与插值），因此也遵守
    /// "只有 feed 写镜像"的约束。
    pub fn feed(&mut self, key: &str, delta: &str) -> Result<(), String> {
        if delta.is_empty() {
            return Ok(());
        }
        match self.rows.iter_mut().find(|row| row.key == key) {
            Some(row) => {
                row.canonical.push_str(delta);
                row.canonical_units += delta.encode_utf16().count() as f64;
            }
            None => self.rows.push(RevealRow {
                key: key.to_string(),
                canonical_units: delta.encode_utf16().count() as f64,
                canonical: delta.to_string(),
                revealed_bytes: 0,
                revealed_units: 0.0,
            }),
        }
        Ok(())
    }

    /// TS `noteBacklog`：一次 push 的欠账超过平滑容量时开启/延长追赶窗口。
    /// `now` 由 JS 传入（push 时刻）。引擎侧欠账口径 = 镜像 − 已揭示
    /// （TS = displayed 与新快照的差，镜像已含新快照的文本，两者一致）。
    pub fn note_backlog(&mut self, now: f64) {
        if self.pending_units() <= self.smooth_backlog_capacity {
            return;
        }
        let candidate = now + self.max_reveal_lag_ms;
        if candidate > self.catch_up_deadline {
            self.catch_up_deadline = candidate;
        }
    }

    /// 当前欠账（UTF-16 单元，D3 归并后的口径：一行只计一次——镜像天然按行去重）。
    /// 读的是增量记账的计数器（见 [`RevealRow`]），O(行数)，不再整串重编码。
    fn pending_units(&self) -> f64 {
        self.rows
            .iter()
            .filter(|row| row.revealed_units < row.canonical_units)
            .map(|row| row.canonical_units - row.revealed_units)
            .sum()
    }

    /// 一拍预算（TS `revealBudget`）：平滑打字速度为基线，追赶窗口内按剩余拍数
    /// 提速，任何情况不超过单拍硬上限。
    fn reveal_budget(&mut self, now: f64) -> f64 {
        let elapsed_since_tick = (now - self.last_tick_at).max(0.0);
        let baseline = (self.reveal_units_per_second
            * elapsed_since_tick.max(self.update_interval_ms)
            / 1000.0)
            .round()
            .max(1.0);
        if self.rows.is_empty() {
            return self.max_reveal_units_per_tick.min(baseline);
        }
        let backlog = self.pending_units();
        self.last_backlog_units = backlog;
        if backlog <= 0.0 {
            return self.max_reveal_units_per_tick.min(baseline);
        }
        // 未武装的窗口（平滑流）或已过期的窗口（被节流的后台定时器）在这里重启，
        // 倒计时不会退化成"这一帧揭示剩余全部"。
        // 写成 `partial_cmp != Greater` 而不是 `deadline <= now`：这必须与 JS 的
        // `!(deadline > now)` 逐字同义，而 NaN 下两者会翻转（NaN 参与比较时 `<=`
        // 为假、`!(>)` 为真）。契约把 NaN 视为"窗口未武装"，故保留否定形式。
        if self
            .catch_up_deadline
            .partial_cmp(&now)
            .is_none_or(|ordering| ordering != core::cmp::Ordering::Greater)
        {
            self.catch_up_deadline = now + self.max_reveal_lag_ms;
            self.catch_up_windows += 1;
        }
        let ticks_left = ((self.catch_up_deadline - now) / self.update_interval_ms)
            .ceil()
            .max(1.0);
        let catch_up = (backlog / self.catch_up_ticks.min(ticks_left)).ceil();
        let budget = self.max_reveal_units_per_tick.min(baseline.max(catch_up));
        self.last_budget = budget;
        budget
    }

    /// 走一拍（TS `tick()` 的计算部分）。`now` 由 JS 传参；引擎不读时钟。
    pub fn tick(&mut self, now: f64) -> TickOutcome {
        let budget = self.reveal_budget(now);
        self.last_tick_at = now;

        // 待揭示行（TS `pendingRowPlans`）：只认前缀增长，保持镜像顺序——
        // D1 的摊分顺序敏感，行序漂移会让逐行决策整个漂移。
        let pending: Vec<usize> = (0..self.rows.len())
            .filter(|&index| self.rows[index].revealed_bytes < self.rows[index].canonical.len())
            .collect();

        if pending.is_empty() {
            // 全部收敛：TS 清追赶窗口并整发目标（displayed !== target 时）。
            self.catch_up_deadline = f64::NEG_INFINITY;
            return TickOutcome {
                kind: "converged",
                budget,
                backlog_units: self.last_backlog_units,
                advanced_max_units: 0.0,
                advanced_total_units: 0.0,
                rows: Vec::new(),
                catch_up_windows: self.catch_up_windows,
            };
        }

        // D1：递减预算——budget ≥ 行数时每行至少分到 1；budget < 行数时末尾行
        // 本拍分到 0（不饿死：下一拍重算）。
        let rows_total = pending.len();
        let mut remaining = budget.max(0.0).floor();
        let mut rows_left = rows_total as f64;
        let mut advanced_max_units = 0.0f64;
        let mut advanced_total_units = 0.0f64;
        let mut still_pending = false;
        let mut reveals = Vec::with_capacity(rows_total);

        for index in pending {
            let per_row = if rows_left > 1.0 {
                (remaining / rows_left).floor().max(1.0)
            } else {
                remaining
            };
            let row = &mut self.rows[index];
            let start = row.revealed_bytes;
            let (taken_bytes, consumed) = advance_graphemes(&row.canonical[start..], per_row);
            let end = start + taken_bytes;
            // 尾巴只切新增区间：不再为 wire 构造整条前缀（O(全文)/拍 → O(尾)/拍）
            let tail = row.canonical[start..end].to_string();
            row.revealed_bytes = end;
            row.revealed_units += consumed;
            remaining = (remaining - consumed).max(0.0);
            rows_left -= 1.0;
            advanced_total_units += consumed;
            if consumed > advanced_max_units {
                advanced_max_units = consumed;
            }
            if end < row.canonical.len() {
                still_pending = true;
            }
            reveals.push(RowReveal {
                key: row.key.clone(),
                tail,
                revealed_length: row.revealed_units,
                consumed_units: consumed,
            });
        }

        if !still_pending {
            // 本拍全部揭示到位：TS 走 pending === false 路径——清窗口、整发原快照。
            self.catch_up_deadline = f64::NEG_INFINITY;
        }

        TickOutcome {
            kind: if still_pending {
                "budgeted"
            } else {
                "converged"
            },
            budget,
            backlog_units: self.last_backlog_units,
            advanced_max_units,
            advanced_total_units,
            rows: reveals,
            catch_up_windows: self.catch_up_windows,
        }
    }

    // ── 只读观测（漂移断言的入口；不改任何节奏状态） ──

    /// 镜像文本（canonical 权威的引擎侧副本）。parity 侧断言它与权威目标逐字节一致。
    pub fn mirror_text(&self, key: &str) -> Option<&str> {
        self.rows
            .iter()
            .find(|row| row.key == key)
            .map(|row| row.canonical.as_str())
    }

    /// 已揭示前缀。
    pub fn revealed_text(&self, key: &str) -> Option<&str> {
        self.rows
            .iter()
            .find(|row| row.key == key)
            .map(|row| &row.canonical[..row.revealed_bytes])
    }

    /// 已揭示前缀的 UTF-16 单元数（增量记账，O(1) 查表）。
    pub fn revealed_units(&self, key: &str) -> Option<f64> {
        self.rows
            .iter()
            .find(|row| row.key == key)
            .map(|row| row.revealed_units)
    }

    /// 追赶窗口（重新）开启次数（TS `catchUpWindows`）。
    pub fn catch_up_windows(&self) -> u64 {
        self.catch_up_windows
    }

    /// 最近一次有欠账的拍算出的欠账（TS `lastBacklogUnits` 的镜像）。
    pub fn last_backlog_units(&self) -> f64 {
        self.last_backlog_units
    }

    /// 最近一次有欠账的拍的一拍预算（TS `lastBudget` 的镜像）。
    pub fn last_budget(&self) -> f64 {
        self.last_budget
    }
}

// ── wasm 薄壳（只做值/错误转换） ─────────────────────────────────────────────

/// TS 选项对象的反序列化形态（全部可选；归一化在 [`RevealEngine::new`] 内做）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EngineOptionsInput {
    max_updates_per_second: Option<f64>,
    reveal_units_per_second: Option<f64>,
    max_reveal_units_per_tick: Option<f64>,
    max_reveal_lag_ms: Option<f64>,
}

impl From<EngineOptionsInput> for EngineOptions {
    fn from(input: EngineOptionsInput) -> Self {
        // 缺省字段用 NaN 走 positive_finite 的回落分支（与 TS 的 undefined 同路径）
        EngineOptions {
            max_updates_per_second: input.max_updates_per_second.unwrap_or(f64::NAN),
            reveal_units_per_second: input.reveal_units_per_second.unwrap_or(f64::NAN),
            max_reveal_units_per_tick: input.max_reveal_units_per_tick.unwrap_or(f64::NAN),
            max_reveal_lag_ms: input.max_reveal_lag_ms.unwrap_or(f64::NAN),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowInput {
    key: String,
    text: String,
}

/// [`RevealEngine`] 的 wasm 出口。JS 侧持有实例并按「reset → (feed → noteBacklog)* → tick*」
/// 驱动；`now` 一律由 JS 传参。
// JS 类名即 Rust 名（不在此处再挂 js_name：wasm-bindgen 的 impl 匹配用 Rust 名）。
#[wasm_bindgen]
pub struct StreamingRevealEngine {
    engine: RevealEngine,
}

#[wasm_bindgen]
impl StreamingRevealEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(options: JsValue) -> Result<StreamingRevealEngine, JsError> {
        let input: EngineOptionsInput = if options.is_null() || options.is_undefined() {
            EngineOptionsInput::default()
        } else {
            serde_wasm_bindgen::from_value(options)
                .map_err(|error| JsError::new(&format!("节奏选项反序列化失败: {error}")))?
        };
        Ok(Self {
            engine: RevealEngine::new(EngineOptions::from(input)),
        })
    }

    /// 用完整 canonical 行集重建镜像：`rows: [{ key, text }]`，`at` 为发布时刻。
    pub fn reset(&mut self, rows: JsValue, at: f64) -> Result<(), JsError> {
        let parsed: Vec<RowInput> = serde_wasm_bindgen::from_value(rows)
            .map_err(|error| JsError::new(&format!("镜像行反序列化失败: {error}")))?;
        let rows: Vec<(&str, &str)> = parsed
            .iter()
            .map(|row| (row.key.as_str(), row.text.as_str()))
            .collect();
        self.engine.reset(&rows, at);
        Ok(())
    }

    /// 追加增量（镜像单写者）。可失败逻辑在内层，壳只转错误。
    pub fn feed(&mut self, key: &str, delta: &str) -> Result<(), JsError> {
        self.engine
            .feed(key, delta)
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(js_name = noteBacklog)]
    pub fn note_backlog(&mut self, now: f64) {
        self.engine.note_backlog(now);
    }

    pub fn tick(&mut self, now: f64) -> Result<JsValue, JsError> {
        serde_wasm_bindgen::to_value(&self.engine.tick(now))
            .map_err(|error| JsError::new(&format!("tick 结果序列化失败: {error}")))
    }

    #[wasm_bindgen(js_name = mirrorText)]
    pub fn mirror_text(&self, key: &str) -> Option<String> {
        self.engine.mirror_text(key).map(str::to_string)
    }

    #[wasm_bindgen(js_name = revealedText)]
    pub fn revealed_text(&self, key: &str) -> Option<String> {
        self.engine.revealed_text(key).map(str::to_string)
    }

    #[wasm_bindgen(js_name = revealedUnits)]
    pub fn revealed_units(&self, key: &str) -> Option<f64> {
        self.engine.revealed_units(key)
    }

    #[wasm_bindgen(js_name = catchUpWindows)]
    pub fn catch_up_windows(&self) -> u32 {
        self.engine.catch_up_windows() as u32
    }
}

// ── 原生单测（D1 预算递减、D2 UTF-16 计量 + 字素不劈分、追赶窗口、镜像单写者） ──

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 TS 测试同口径的一拍：调度间隔 + 1ms 余量。
    const TICK: f64 = 1000.0 / 60.0 + 1.0;

    fn engine() -> RevealEngine {
        RevealEngine::new(EngineOptions::default())
    }

    /// 引擎建立初始镜像（TS：首次 push 整发空文本）。
    fn seed(engine: &mut RevealEngine, rows: &[(&str, &str)]) {
        engine.reset(rows, 0.0);
    }

    // ── D2：UTF-16 计量 + 字素不劈分 ─────────────────────────────────────────

    #[test]
    fn advance_prefix_bills_utf16_units_and_stops_before_overflow() {
        // ASCII：预算内取整
        assert_eq!(advance_prefix("", "abc", 2.0).value, "ab");
        assert_eq!(advance_prefix("", "abc", 2.0).consumed_units, 2.0);
        // 预算为 0 不推进；预算富余取全量
        assert_eq!(advance_prefix("", "abc", 0.0).value, "");
        assert_eq!(advance_prefix("", "abc", 10.0).value, "abc");
        // 非前缀目标：整发回落（TS 同分支）
        assert_eq!(advance_prefix("xy", "ab", 5.0).value, "ab");
        assert_eq!(advance_prefix("xy", "ab", 5.0).consumed_units, 0.0);
        // 已相等：零消费
        assert_eq!(advance_prefix("abc", "abc", 5.0).consumed_units, 0.0);
    }

    #[test]
    fn advance_prefix_never_splits_a_zwj_grapheme() {
        // 👩‍💻 = 1 字素 = 5 UTF-16 单元：预算 4 放不下（0 推进），预算 5 恰好整字素
        assert_eq!(advance_prefix("", "👩‍💻x", 4.0).consumed_units, 0.0);
        let step = advance_prefix("", "👩‍💻x", 5.0);
        assert_eq!(step.value, "👩‍💻");
        assert_eq!(step.consumed_units, 5.0);
        // 下一字素放不下即停，不劈 'x'
        let again = advance_prefix("👩‍💻", "👩‍💻x", 5.0);
        assert_eq!(again.value, "👩‍💻x");
        assert_eq!(again.consumed_units, 1.0);
    }

    #[test]
    fn advance_prefix_keeps_astral_family_intact_when_budget_is_smaller() {
        // 👨‍👩‍👧‍👦 = 1 字素 = 11 UTF-16 单元：预算 10 一格都揭示不了（与 TS 同款死锁）
        assert_eq!(advance_prefix("", "👨‍👩‍👧‍👦", 10.0).consumed_units, 0.0);
        assert_eq!(advance_prefix("", "👨‍👩‍👧‍👦", 11.0).consumed_units, 11.0);
    }

    #[test]
    fn advance_prefix_pairs_regional_indicators() {
        // 🇺🇸🇯🇵 = 2 字素（成对 RI）× 4 单元：预算 5 只放下一面旗
        let step = advance_prefix("", "🇺🇸🇯🇵", 5.0);
        assert_eq!(step.value, "🇺🇸");
        assert_eq!(step.consumed_units, 4.0);
    }

    #[test]
    fn advance_prefix_keeps_combining_marks_with_their_base() {
        // e + U+0301 = 1 字素 = 2 单元
        let step = advance_prefix("", "e\u{0301}ab", 2.0);
        assert_eq!(step.value, "e\u{0301}");
        assert_eq!(step.consumed_units, 2.0);
        let half = advance_prefix("", "e\u{0301}ab", 1.0);
        assert_eq!(half.consumed_units, 0.0);
    }

    // ── D1：预算逐行递减 ─────────────────────────────────────────────────────

    #[test]
    fn one_tick_aggregate_never_exceeds_the_budget_and_later_rows_do_not_starve() {
        let mut engine = engine();
        seed(&mut engine, &[("m1", ""), ("m2", ""), ("m3", "")]);
        for key in ["m1", "m2", "m3"] {
            engine.feed(key, &"x".repeat(30)).expect("feed");
        }
        engine.note_backlog(0.0);
        let outcome = engine.tick(TICK);

        assert_eq!(outcome.kind, "budgeted");
        // 手算（与 TS 一致）：baseline = round(120×17.67/1000) = 2；
        // note_backlog(0) 欠账 90 > 48 ⇒ 窗口武装于 400；
        // ticksLeft = ceil((400−17.67)/16.67) = 23，catchUpTicks = 24 ⇒ catchUp = ceil(90/23) = 4
        assert_eq!(outcome.budget, 4.0);
        let units: Vec<f64> = outcome.rows.iter().map(|row| row.consumed_units).collect();
        assert_eq!(
            units,
            vec![1.0, 1.0, 2.0],
            "D1 摊分：floor(4/3)=1 → 1 → 余量 2 给末行"
        );
        let total: f64 = units.iter().sum();
        assert_eq!(total, outcome.advanced_total_units);
        assert!(total <= 4.0, "聚合新增不得超过预算");
        assert_eq!(outcome.advanced_max_units, 2.0);
    }

    #[test]
    fn d2_caps_astral_reveal_at_the_hard_per_tick_bound_in_utf16_units() {
        let mut engine = engine();
        seed(&mut engine, &[("m1", "")]);
        let grapheme = "👩‍💻"; // 1 字素 = 5 UTF-16 单元
        engine.feed("m1", &grapheme.repeat(400)).expect("feed"); // 2000 单元欠账
        engine.note_backlog(0.0);
        let outcome = engine.tick(TICK);
        assert_eq!(outcome.kind, "budgeted");
        // 追赶量 ceil(2000/23) = 87 < 128 ⇒ 预算 87；87/5 = 17.4 ⇒ 17 个整字素 = 85 单元
        assert_eq!(outcome.budget, 87.0);
        assert_eq!(outcome.rows[0].consumed_units, 85.0);
        assert!(
            outcome.rows[0].consumed_units <= 128.0,
            "硬上限按 UTF-16 单元计"
        );
        assert_eq!(engine.revealed_units("m1"), Some(85.0));
        assert_eq!(
            engine.revealed_text("m1"),
            Some(grapheme.repeat(17).as_str())
        );
    }

    #[test]
    fn smooth_stream_stays_on_the_typing_pace() {
        let mut engine = engine();
        seed(&mut engine, &[("m1", "")]);
        // 欠账 20 ≤ 平滑容量 48：note_backlog 不武装窗口；首个有欠账的 tick 自武装
        // （TS revealBudget 同款：窗口计数发生在预算计算里，不在 noteBacklog 里）
        engine.feed("m1", &"x".repeat(20)).expect("feed");
        engine.note_backlog(0.0);
        let outcome = engine.tick(TICK);
        // budget = min(128, max(2, ceil(20/24))) = 2（打字节奏 120 单元/s ≈ 2 单元/拍）
        assert_eq!(outcome.budget, 2.0);
        assert_eq!(outcome.rows[0].consumed_units, 2.0);
        assert_eq!(
            engine.catch_up_windows(),
            1,
            "note_backlog 不计数；首个欠账拍自武装计 1"
        );
    }

    // ── wire tail：tail 拼接 == 整条揭示前缀；revealed_length == UTF-16 长度 ──

    #[test]
    fn tick_rows_carry_incremental_tails_that_concat_to_the_revealed_prefix() {
        let mut engine = engine();
        seed(&mut engine, &[("m1", "")]);
        engine.feed("m1", &"x".repeat(4000)).expect("feed");
        engine.note_backlog(0.0);
        let mut revealed = String::new();
        let mut ticks = 0;
        loop {
            let outcome = engine.tick((ticks + 1) as f64 * TICK);
            ticks += 1;
            for row in &outcome.rows {
                // 拍前揭示位（JS 侧追加基准）+ tail == 拍后揭示位（长度守恒）
                assert_eq!(
                    revealed.encode_utf16().count() as f64 + row.tail.encode_utf16().count() as f64,
                    row.revealed_length,
                    "ticks={ticks}"
                );
                revealed.push_str(&row.tail);
            }
            if outcome.kind == "converged" {
                break;
            }
            assert!(ticks < 200, "4000 单元必须收敛");
        }
        assert_eq!(revealed, "x".repeat(4000));
        assert_eq!(engine.revealed_units("m1"), Some(4000.0));
    }

    #[test]
    fn astral_tails_keep_revealed_length_in_utf16_units() {
        let mut engine = engine();
        seed(&mut engine, &[("m1", "")]);
        let grapheme = "👩‍💻"; // 1 字素 = 5 UTF-16 单元
        engine.feed("m1", &grapheme.repeat(400)).expect("feed");
        engine.note_backlog(0.0);
        let mut revealed_units = 0.0f64;
        let mut tail_units = 0.0f64;
        for ticks in 1..200 {
            let outcome = engine.tick(ticks as f64 * TICK);
            for row in &outcome.rows {
                assert_eq!(row.revealed_length, revealed_units + row.consumed_units);
                tail_units += row.tail.chars().map(char::len_utf16).sum::<usize>() as f64;
                revealed_units = row.revealed_length;
            }
            if outcome.kind == "converged" {
                break;
            }
        }
        // 全部 tail 拼出的 UTF-16 长度 == 揭示位；tail 切点都落在字素边界（整字素倍数）
        assert_eq!(revealed_units, 2000.0);
        assert_eq!(tail_units, 2000.0);
        assert_eq!(
            engine.revealed_text("m1"),
            Some(grapheme.repeat(400).as_str())
        );
    }

    #[test]
    fn tail_path_matches_the_full_prefix_reference_advance() {
        // tick 走的 advance_graphemes 与参考实现 advance_prefix 逐字节等价
        //（前缀目标场景；非前缀整发回落是 advance_prefix 自己的分支）
        let mut random = Lcg(0x220_CA11);
        for case in 0..300 {
            let mut target = String::new();
            let parts = 1 + random.below(10);
            for _ in 0..parts {
                target.push_str(UNITS[random.below(UNITS.len())]);
            }
            let mut current = String::new();
            for grapheme in target.graphemes(true) {
                let budget = (random.below(12)) as f64;
                let reference = advance_prefix(&current, &target, budget);
                let (taken_bytes, consumed) = advance_graphemes(&target[current.len()..], budget);
                assert_eq!(
                    &target[current.len()..][..taken_bytes],
                    &reference.value[current.len()..],
                    "case={case} tail 与整发前缀的增量不一致"
                );
                assert_eq!(consumed, reference.consumed_units, "case={case}");
                current.push_str(grapheme);
            }
        }
    }

    // ── 400ms 追赶窗口 ───────────────────────────────────────────────────────

    #[test]
    fn a_burst_drains_within_the_catch_up_window_without_painting_a_block() {
        let mut engine = engine();
        seed(&mut engine, &[("m1", "")]);
        engine.feed("m1", &"x".repeat(4000)).expect("feed");
        engine.note_backlog(0.0);

        let mut ticks = 0;
        let mut max_units = 0.0f64;
        loop {
            let outcome = engine.tick(0.0 + (ticks + 1) as f64 * TICK);
            ticks += 1;
            if outcome.kind == "converged" {
                break;
            }
            for row in &outcome.rows {
                max_units = max_units.max(row.consumed_units);
            }
            assert!(ticks < 60, "4000 单元必须在追赶窗口量级内收敛");
        }
        // 128 单元/拍 ⇒ 至少 32 拍；400ms 窗口 = 24 拍 ⇒ 至少重开一次窗口
        assert!(ticks >= 32, "单拍硬上限不允许更快收敛（实际 {ticks} 拍）");
        assert!(
            max_units <= 128.0,
            "任何一拍都不倒出整块（峰值 {max_units}）"
        );
        assert!(engine.catch_up_windows() >= 1, "过期窗口重开要计数");
        assert_eq!(engine.revealed_text("m1"), Some("x".repeat(4000).as_str()));
    }

    #[test]
    fn converged_tick_clears_the_window_and_reports_converged() {
        let mut engine = engine();
        seed(&mut engine, &[("m1", "")]);
        engine.feed("m1", "xx").expect("feed");
        let first = engine.tick(TICK);
        assert_eq!(first.kind, "converged");
        assert_eq!(engine.catch_up_windows(), 1, "首个欠账拍武装并计数一次");
        // 收敛后再 tick：无欠账路径，预算回到基线且窗口不再累加
        let idle = engine.tick(2.0 * TICK);
        assert_eq!(idle.kind, "converged");
        assert_eq!(idle.budget, 2.0);
        assert_eq!(engine.catch_up_windows(), 1);
    }

    // ── 镜像单写者 + 漂移可断言 ──────────────────────────────────────────────

    #[test]
    fn mirror_is_only_written_by_reset_and_feed() {
        let mut engine = engine();
        engine.reset(&[("m1", "hello")], 0.0);
        engine.feed("m1", " world").expect("feed");
        assert_eq!(engine.mirror_text("m1"), Some("hello world"));
        // tick 只读：镜像不变
        engine.note_backlog(0.0);
        engine.tick(TICK);
        assert_eq!(engine.mirror_text("m1"), Some("hello world"));
        // reset 整发：镜像整体替换、revealed 追平
        engine.reset(&[("m1", "fresh")], 1.0);
        assert_eq!(engine.mirror_text("m1"), Some("fresh"));
        assert_eq!(engine.revealed_text("m1"), Some("fresh"));
        // 未知行先 reset 建立——直播中从未见过的行由 feed 建立（新行空显示态参与插值）
        engine.feed("m2", "new").expect("feed");
        assert_eq!(engine.revealed_text("m2"), Some(""));
        assert_eq!(engine.mirror_text("m2"), Some("new"));
    }

    #[test]
    fn reset_replays_like_a_whole_publication() {
        let mut engine = engine();
        engine.reset(&[("m1", "")], 0.0);
        engine.feed("m1", &"x".repeat(100)).expect("feed");
        engine.note_backlog(0.0);
        engine.tick(TICK);
        assert!(engine.revealed_units("m1").expect("units") > 0.0);
        // 换代 reset：整发后 revealed == mirror，无欠账
        let long = "z".repeat(400);
        engine.reset(&[("m1", long.as_str())], 2.0 * TICK);
        assert_eq!(engine.revealed_units("m1"), Some(400.0));
        let outcome = engine.tick(3.0 * TICK);
        assert_eq!(outcome.kind, "converged");
    }

    // ── property-style 随机用例（确定性种子，失败可复现） ────────────────────

    struct Lcg(u64);

    impl Lcg {
        fn below(&mut self, bound: usize) -> usize {
            self.0 = self.0.wrapping_add(0x6d2b79f5);
            let mut t = self.0;
            t = t.wrapping_mul(t ^ (t >> 15) | 1);
            t ^= t.wrapping_add(t ^ (t >> 7) | 61);
            let value = ((t ^ (t >> 14)) >> 32) as f64 / u32::MAX as f64;
            ((value * bound as f64).floor() as usize).min(bound - 1)
        }
    }

    /// 字母表：字素长度 1~5+ 单元混合（组合标记 / ZWJ / RI 成对 / BMP / astral）。
    const UNITS: &[&str] = &[
        "x",
        "字",
        "e\u{0301}",
        "👩‍💻",
        "🇺",
        "🇸",
        "🎯",
        "\u{200D}",
        "a",
        "。",
    ];

    fn utf16_len(text: &str) -> f64 {
        text.encode_utf16().count() as f64
    }

    #[test]
    fn randomized_advance_prefix_respects_budget_and_grapheme_boundaries() {
        let mut random = Lcg(0x220_beef);
        for case in 0..500 {
            let mut target = String::new();
            let parts = 1 + random.below(12);
            for _ in 0..parts {
                target.push_str(UNITS[random.below(UNITS.len())]);
            }
            // 只取字素边界上的 current 前缀，保证「target 的前缀」这条分支
            let mut current = String::new();
            for grapheme in target.graphemes(true) {
                let budget = (random.below(14)) as f64;
                let advanced = advance_prefix(&current, &target, budget);
                assert!(
                    target.starts_with(&advanced.value),
                    "case={case} 结果必须是目标前缀"
                );
                assert!(
                    advanced.value.starts_with(current.as_str()),
                    "case={case} 不得回退"
                );
                let consumed = utf16_len(&advanced.value) - utf16_len(&current);
                assert!(
                    consumed <= budget.max(0.0),
                    "case={case} 消费 {consumed} > 预算 {budget}"
                );
                // 最大化：还有剩余且没吃满目标时，下一个字素必然放不下
                if advanced.value != target && budget > 0.0 {
                    let rest = &target[advanced.value.len()..];
                    let next_units = rest
                        .graphemes(true)
                        .next()
                        .map(utf16_len)
                        .expect("rest 非空必有字素");
                    assert!(
                        consumed + next_units > budget,
                        "case={case} 过早停步：consumed={consumed} next={next_units} budget={budget}"
                    );
                }
                current.push_str(grapheme);
            }
        }
    }

    #[test]
    fn randomized_engine_stream_keeps_aggregate_and_prefix_invariants() {
        let mut random = Lcg(0x220_fa11);
        for case in 0..120 {
            let mut engine = engine();
            let row_count = 1 + random.below(4);
            let keys: Vec<String> = (0..row_count).map(|index| format!("m{index}")).collect();
            let mut now = 0.0f64;
            engine.reset(
                &keys
                    .iter()
                    .map(|key| (key.as_str(), ""))
                    .collect::<Vec<_>>(),
                now,
            );
            let mut authoritative: Vec<String> = vec![String::new(); row_count];
            for step in 0..(3 + random.below(10)) {
                for (index, key) in keys.iter().enumerate() {
                    let delta_len = random.below(24);
                    if delta_len == 0 {
                        continue;
                    }
                    let delta: String = (0..delta_len)
                        .map(|_| UNITS[random.below(UNITS.len())])
                        .collect();
                    authoritative[index].push_str(&delta);
                    engine.feed(key, &delta).expect("feed");
                    // 漂移断言：镜像必须与权威拼接逐字节一致
                    assert_eq!(
                        engine.mirror_text(key),
                        Some(authoritative[index].as_str()),
                        "case={case} step={step} 镜像漂移"
                    );
                }
                engine.note_backlog(now);
                now += TICK;
                let outcome = engine.tick(now);
                if outcome.kind == "budgeted" {
                    let total: f64 = outcome.rows.iter().map(|row| row.consumed_units).sum();
                    // TS 语义：perRow = max(1, floor(remaining/rowsLeft)) 的 max(1,…)
                    // 允许行在 remaining=0 时仍取 1 ⇒ 聚合至多超出预算 rows−1 单元
                    // （「聚合 ≤ 预算」只在 budget ≥ 行数时成立，见语义缺口清单）。
                    assert!(
                        total <= outcome.budget + row_count as f64,
                        "case={case} step={step} 聚合 {total} > 预算 {} + 行数",
                        outcome.budget
                    );
                }
                for (index, key) in keys.iter().enumerate() {
                    let revealed = engine.revealed_text(key).expect("行存在");
                    assert!(
                        authoritative[index].starts_with(revealed),
                        "case={case} step={step} 揭示前缀越界"
                    );
                    // 字素边界：已揭示前缀必须恰好由整字素组成
                    let mut whole_graphemes = 0usize;
                    for grapheme in authoritative[index].graphemes(true) {
                        if whole_graphemes + grapheme.len() > revealed.len() {
                            break;
                        }
                        whole_graphemes += grapheme.len();
                    }
                    assert_eq!(
                        whole_graphemes,
                        revealed.len(),
                        "case={case} step={step} 揭示点劈开了字素"
                    );
                }
            }
        }
    }
}
