// ─────────────────────────────────────────────────────────────────────────────
// 【雕刻基线】迁移前的 TS 揭示预算引擎（issue #220 WP3 计算核 wasm 化）。
//
// 出处与组装方式（诚实声明，这不是逐字节整文件拷贝）：
// - 纯数学函数逐字取自迁移前的
//   `git show 76cbc819^:src/renderers/solid-workbench/streamingDisplayScheduler.ts`
//   ：`positiveFinite`（原 L677）、`advancePrefix` + 字素分段器（原 L1047-1089），
//   以及 `revealBudget`（原 L399-423）与 D1 递减摊分（原 `interpolateSnapshot`
//   的行决策循环，L929-972）的**运算语句原文**；
// - 状态机外壳按 Rust 权威移植 `src-tauri/pylon-compute/src/streaming/budget.rs`
//   的 `RevealEngine` 组装（该文件头注明它就是 TS 调度器「计算部分」的语义不变
//   移植）：行镜像（canonical/revealed 单写者）、追赶窗口、`lastBudget` 只在有
//   欠账的拍更新等怪癖全部保留；
// - 调度器中留在 JS 的**编排**（帧源/定时器/替换 flush/终态合并/判据 A/C）不属
//   于计算核，按 ADR-0018 不进本基线（wasm 出口同样不含它们）。
//
// 仅服务 `scripts/compute-parity/` 脚手架，不在任何生产路径。协议与 wasm 出口
// `StreamingRevealEngine` 逐方法同形，parity 红了先怀疑本文件的组装再怀疑移植。
// ─────────────────────────────────────────────────────────────────────────────

/** TS `PrefixAdvance`：揭示到的前缀 + 本次消费的 UTF-16 单元数。 */
export interface PrefixAdvance {
  value: string
  consumedUnits: number
}

interface GraphemeSegment {
  segment: string
}

interface GraphemeSegmenter {
  segment(input: string): Iterable<GraphemeSegment>
}

type IntlWithSegmenter = typeof Intl & {
  Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => GraphemeSegmenter
}

/** 原 L1075-1089（逐字）。 */
function createGraphemeSegmenter(): GraphemeSegmenter | undefined {
  if (typeof Intl === 'undefined') return undefined
  const Segmenter = (Intl as IntlWithSegmenter).Segmenter
  if (!Segmenter) return undefined
  try {
    return new Segmenter(undefined, { granularity: 'grapheme' })
  } catch {
    return undefined
  }
}

const graphemeSegmenter = createGraphemeSegmenter()

/** 原 L677-680（逐字）。 */
function positiveFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * 原 L1047-1073（逐字）：把 `current` 沿 `target` 按字素步进最多 `budget` 个
 * UTF-16 单元。D2 的命门：记账量纲 = UTF-16 单元，步进单位 = 字素（不切开字素）。
 */
export function advancePrefix(current: string, target: string, budget: number): PrefixAdvance {
  if (current === target) return { value: current, consumedUnits: 0 }
  if (!target.startsWith(current)) return { value: target, consumedUnits: 0 }
  const remaining = target.slice(current.length)
  if (!remaining || budget <= 0) return { value: current, consumedUnits: 0 }

  // 于是 astral 文本（1 字素 = 2+ 单元）也不会超预算，代价是最多少用一个字素的余量。
  let codeUnits = 0
  if (graphemeSegmenter) {
    for (const item of graphemeSegmenter.segment(remaining)) {
      const next = codeUnits + item.segment.length
      if (next > budget) break
      codeUnits = next
    }
  } else {
    // `for…of` iterates Unicode code points (not UTF-16 halves), which is a
    // safe fallback for older WebView implementations without Segmenter.
    for (const item of remaining) {
      const next = codeUnits + item.length
      if (next > budget) break
      codeUnits = next
    }
  }
  return { value: current + remaining.slice(0, codeUnits), consumedUnits: codeUnits }
}

// ── 引擎外壳（按 Rust `RevealEngine` 的状态与语义组装，运算语句同 TS 原文） ──

/** 节奏选项（缺省/非正值按 TS `positiveFinite` 落回默认）。 */
export interface OldRevealEngineOptions {
  maxUpdatesPerSecond?: number
  revealUnitsPerSecond?: number
  maxRevealUnitsPerTick?: number
  maxRevealLagMs?: number
}

/** 渲染侧节奏默认值（契约源镜像：Rust budget.rs 顶部常量同表）。 */
const DEFAULT_MAX_UPDATES_PER_SECOND = 60
const DEFAULT_REVEAL_UNITS_PER_SECOND = 120
const DEFAULT_MAX_REVEAL_UNITS_PER_TICK = 128
const DEFAULT_MAX_REVEAL_LAG_MS = 400

interface RevealRow {
  readonly key: string
  /** 镜像（canonical 权威的引擎侧副本；单写者：只有 reset/feed 写）。 */
  canonical: string
  /** 已揭示前缀（JS 字符串的 .length 即 UTF-16 单元数，与 Rust revealed_bytes 对位）。 */
  revealed: string
}

/** 一行的本拍决策（TS `RowDecision` + 行 key；Rust `RowReveal` 同形）。 */
export interface OldRowReveal {
  readonly key: string
  readonly value: string
  readonly consumedUnits: number
}

/** 一次 `tick` 的结果（Rust `TickOutcome` 同形）。 */
export interface OldTickOutcome {
  readonly kind: 'budgeted' | 'converged'
  readonly budget: number
  readonly backlogUnits: number
  readonly advancedMaxUnits: number
  readonly advancedTotalUnits: number
  readonly rows: readonly OldRowReveal[]
  readonly catchUpWindows: number
}

/**
 * 揭示预算引擎的 TS 基线。协议与 wasm `StreamingRevealEngine` 逐方法同形：
 * reset → (feed → noteBacklog)* → tick*；`now` 一律由调用方传参。
 */
export class OldStreamingRevealEngine {
  private rows: RevealRow[] = []
  private readonly updateIntervalMs: number
  private readonly revealUnitsPerSecond: number
  private readonly maxRevealUnitsPerTick: number
  private readonly maxRevealLagMs: number
  private readonly catchUpTicks: number
  private readonly smoothBacklogCapacity: number
  private lastTickAt = 0
  /** 当前追赶窗口死线；`-Infinity` = 未武装。NaN 按「未武装」处理（`!(deadline > now)`）。 */
  private catchUpDeadline = Number.NEGATIVE_INFINITY
  private catchUpWindowCount = 0
  /** 只读诊断镜像（TS `diagnosticsBacklogUnits`/`diagnosticsBudget` 同款怪癖，为 parity 保留）。 */
  private lastBacklogUnitsMirror = 0
  private lastBudgetMirror = 0

  constructor(options: OldRevealEngineOptions = {}) {
    // 构造期归一化与派生常量：运算顺序与 TS 构造器/Rust new 逐位一致。
    const maxUpdatesPerSecond = positiveFinite(options.maxUpdatesPerSecond, DEFAULT_MAX_UPDATES_PER_SECOND)
    const revealUnitsPerSecond = positiveFinite(options.revealUnitsPerSecond, DEFAULT_REVEAL_UNITS_PER_SECOND)
    const maxRevealLagMs = positiveFinite(options.maxRevealLagMs, DEFAULT_MAX_REVEAL_LAG_MS)
    const maxRevealUnitsPerTick = Math.max(1, Math.floor(positiveFinite(
      options.maxRevealUnitsPerTick,
      DEFAULT_MAX_REVEAL_UNITS_PER_TICK,
    )))
    this.revealUnitsPerSecond = revealUnitsPerSecond
    this.maxRevealUnitsPerTick = maxRevealUnitsPerTick
    this.maxRevealLagMs = maxRevealLagMs
    this.updateIntervalMs = 1000 / maxUpdatesPerSecond
    this.catchUpTicks = Math.max(1, Math.ceil(maxRevealLagMs / this.updateIntervalMs))
    this.smoothBacklogCapacity = revealUnitsPerSecond * maxRevealLagMs / 1000
  }

  /** 用完整 canonical 行集重建镜像（整发语义）：无欠账、窗口清零、`lastTickAt` 校正。 */
  reset(rows: ReadonlyArray<{ key: string, text: string }>, at: number): void {
    this.rows = rows.map(row => ({ key: row.key, canonical: row.text, revealed: row.text }))
    this.catchUpDeadline = Number.NEGATIVE_INFINITY
    this.lastTickAt = at
  }

  /** 追加增量（镜像单写者的直播入口）。空 delta 不建行；未知行按空显示态建立。 */
  feed(key: string, delta: string): void {
    if (!delta) return
    const row = this.rows.find(candidate => candidate.key === key)
    if (row) row.canonical += delta
    else this.rows.push({ key, canonical: delta, revealed: '' })
  }

  /** TS `noteBacklog`：一次 push 的欠账超过平滑容量时开启/延长追赶窗口。 */
  noteBacklog(now: number): void {
    if (this.pendingUnits() <= this.smoothBacklogCapacity) return
    const candidate = now + this.maxRevealLagMs
    if (candidate > this.catchUpDeadline) this.catchUpDeadline = candidate
  }

  /** 当前欠账（UTF-16 单元；镜像按行天然去重，D3 归并口径）。 */
  private pendingUnits(): number {
    let total = 0
    for (const row of this.rows) {
      if (row.revealed.length < row.canonical.length) total += row.canonical.length - row.revealed.length
    }
    return total
  }

  /** 一拍预算（运算语句 = TS `revealBudget` 原文，窗口计数怪癖同 Rust）。 */
  private revealBudget(now: number): number {
    const elapsedSinceTick = Math.max(0, now - this.lastTickAt)
    const baseline = Math.max(1, Math.round(
      this.revealUnitsPerSecond * Math.max(elapsedSinceTick, this.updateIntervalMs) / 1000,
    ))
    if (this.rows.length === 0) return Math.min(this.maxRevealUnitsPerTick, baseline)
    const backlog = this.pendingUnits()
    this.lastBacklogUnitsMirror = backlog
    if (backlog <= 0) return Math.min(this.maxRevealUnitsPerTick, baseline)
    // NaN 下 `<=` 为假、`!(>)` 为真——契约把 NaN 视为「窗口未武装」，保留否定形式。
    if (!(this.catchUpDeadline > now)) {
      this.catchUpDeadline = now + this.maxRevealLagMs
      this.catchUpWindowCount += 1
    }
    const ticksLeft = Math.max(1, Math.ceil((this.catchUpDeadline - now) / this.updateIntervalMs))
    const catchUp = Math.ceil(backlog / Math.min(this.catchUpTicks, ticksLeft))
    const budget = Math.min(this.maxRevealUnitsPerTick, Math.max(baseline, catchUp))
    this.lastBudgetMirror = budget
    return budget
  }

  /** 走一拍（TS `tick()` 的计算部分：预算 → D1 逐行递减摊分 → 字素安全推进）。 */
  tick(now: number): OldTickOutcome {
    const budget = this.revealBudget(now)
    this.lastTickAt = now

    // 待揭示行：只认前缀增长，保持镜像顺序（D1 摊分顺序敏感）。
    const pending = this.rows.filter(row => row.revealed.length < row.canonical.length)
    if (pending.length === 0) {
      this.catchUpDeadline = Number.NEGATIVE_INFINITY
      return {
        kind: 'converged',
        budget,
        backlogUnits: this.lastBacklogUnitsMirror,
        advancedMaxUnits: 0,
        advancedTotalUnits: 0,
        rows: [],
        catchUpWindows: this.catchUpWindowCount,
      }
    }

    // D1：递减预算——budget ≥ 行数时每行至少分到 1；不足时末尾行本拍分到 0
    // （但 `advancePrefix` 的 perRow 语义允许行在 remaining=0 时仍取 1，见 Rust 注）。
    let remaining = Math.max(0, Math.floor(budget))
    let rowsLeft = pending.length
    let advancedMaxUnits = 0
    let advancedTotalUnits = 0
    let stillPending = false
    const reveals: OldRowReveal[] = []
    for (const row of pending) {
      const perRow = rowsLeft > 1 ? Math.max(1, Math.floor(remaining / rowsLeft)) : remaining
      const advanced = advancePrefix(row.revealed, row.canonical, perRow)
      advancedTotalUnits += advanced.consumedUnits
      if (advanced.consumedUnits > advancedMaxUnits) advancedMaxUnits = advanced.consumedUnits
      remaining = Math.max(0, remaining - advanced.consumedUnits)
      rowsLeft -= 1
      if (advanced.value.length < row.canonical.length) stillPending = true
      row.revealed = advanced.value
      reveals.push({ key: row.key, value: advanced.value, consumedUnits: advanced.consumedUnits })
    }

    if (!stillPending) this.catchUpDeadline = Number.NEGATIVE_INFINITY

    return {
      kind: stillPending ? 'budgeted' : 'converged',
      budget,
      backlogUnits: this.lastBacklogUnitsMirror,
      advancedMaxUnits,
      advancedTotalUnits,
      rows: reveals,
      catchUpWindows: this.catchUpWindowCount,
    }
  }

  // ── 只读观测（不改任何节奏状态） ──

  mirrorText(key: string): string | undefined {
    return this.rows.find(row => row.key === key)?.canonical
  }

  revealedText(key: string): string | undefined {
    return this.rows.find(row => row.key === key)?.revealed
  }

  revealedUnits(key: string): number | undefined {
    return this.rows.find(row => row.key === key)?.revealed.length
  }

  catchUpWindows(): number {
    return this.catchUpWindowCount
  }

  lastBacklogUnits(): number {
    return this.lastBacklogUnitsMirror
  }

  lastBudget(): number {
    return this.lastBudgetMirror
  }
}
