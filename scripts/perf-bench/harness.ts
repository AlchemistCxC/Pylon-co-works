// 产品路径性能基准的**跑器与口径**（issue #233）。
//
// 与 `scripts/compute-parity/` 的关系：那边是 **parity 门禁**（双实现逐字节对照，判据是「等价」）；
// 这边是 **benchmark**（单实现绝对成本，判据是「多快」）。两者共用切分/揭示的 case 定义与语料，
// 但**不共用读数口径**——对照跑器（`compute-parity-{bench,memory}.mts`）已随本 issue 废除。
//
// 口径（为什么这样定）：
// - **一个 case = 一条已接线生产路径 + 一份输入**。没有第二实现，读数就是这条路径一次要花多少。
//   想量一个新开销点不必先造 TS 基线——这正是「开销点整合得进」的前提。
// - **绝对耗时取中位数**：冷启动（JIT / wasm 装载 / 引擎首载）由 1 轮预热排除；再报 `ms最小`
//   作为「无干扰地板」，两列一起看：中位与最小拉得开说明本轮采样被外部负载污染。
// - **派生单位成本**是跨机器可比的那一列：`中位耗时 / 工作量`（µs/字符、µs/拍、µs/事件）。
//   绝对 ms 随输入规模与机器变，单位成本不用。
// - **不做 TS↔wasm 比值**：被测物只有生产那一侧，比值需要第二实现，而第二实现（`baselines/`）
//   不在生产路径上。
// - **核线性内存 Δ**：wasm 计算核的线性内存只涨不跌，所以「跑本 case 的**单次**调用把高水位
//   抬高多少」是确定性读数（与 GC 无关）。注意它是**高水位增量**：靠后的 case 读到 0 是正常的
//   （它要的那块内存前面已经被别的 case 抬上去了），不是「不占内存」。
// - **不做宿主保留量**：要 `--expose-gc` 才精确、且是上限不是值，读错的代价大于信息量。

/** 输入量级维度。`l` 档只在 `PERF_SCALE=full` 下参与。 */
export type Scale = 'xs' | 's' | 'm' | 'l'

export type Domain =
  | 'streaming-split'
  | 'streaming-reveal'
  | 'markdown-parse'
  | 'markdown-highlight'
  | 'projector'
  | 'events'

export interface CaseMeta {
  readonly scale?: Scale
  /** 结构变体标签（如 doc / streaming-tail / mixed-flow）。 */
  readonly shape?: string
  /** 边界或病态输入（空串、畸形、未知语言、乱序……）。 */
  readonly edge?: boolean
  /** 状态流形态（cold / paged / growing / replay-script）。 */
  readonly flow?: string
}

export interface PerfCase {
  readonly id: string
  readonly meta: CaseMeta
  /**
   * 一次被计时的工作单元——**必须只调生产出口**（本文件不生成任何第二实现）。
   * 每次调用取新输入的原则由 case 自己保证：闭包里捕获的输入不得被 run 就地改写。
   */
  readonly run: () => void | Promise<void>
  /** 本次 run 的工作量（字符数 / 拍数 / 事件数 / 块数），用于单位成本列。 */
  readonly units?: number
  /** 工作量量纲名（`字符` / `拍` / `事件` / `块`）。给了 units 就必须给。 */
  readonly unitLabel?: string
  /** 为什么单列这个形状/这个 case（写进表下方的脚注）。 */
  readonly note?: string
}

export interface PerfPair {
  /** 生产出口名（与 `#[wasm_bindgen(js_name)]` 或 TS 导出名一致）。 */
  readonly name: string
  readonly domain: Domain
  /** 生产接线点 `file:line`——「它算已接线」的证据，不是结论。 */
  readonly wiredAt: string
  /** 本条路径测得是**哪一段**（消费方的缓存/生命周期编排不在这条读数里）。 */
  readonly note?: string
  readonly cases: readonly PerfCase[]
}

export interface PerfSuite {
  readonly domain: Domain
  readonly pairs: readonly PerfPair[]
}

// ── 维度过滤 ─────────────────────────────────────────────────────────────────

const SCALE_RANK: Record<Scale, number> = { xs: 0, s: 1, m: 2, l: 3 }

export function includeCase(meta: CaseMeta, scale: Scale): boolean {
  return SCALE_RANK[meta.scale ?? 'xs'] <= SCALE_RANK[scale]
}

/**
 * `PERF_SCALE` 解析。缺省 `m`；`full`/`l` 含 l 档极量级；`xs` 只跑最小档
 * ——xs 档耗时常在计时噪声量级，单位成本列仍可比，但绝对 ms 只作参考。
 */
export function resolveScale(requested?: string): Scale {
  if (requested === 'full' || requested === 'l') return 'l'
  if (requested === 'xs') return 'xs'
  if (requested === 's') return 's'
  return 'm'
}

// ── 内存探针（由入口注入；harness 不 import `node:*`）─────────────────────────

/** 各计算核的线性内存字节数（key = 产物名，如 `pylon-compute`）。 */
export interface PerfProbe {
  linearMemory(): Record<string, number>
}

// ── 跑器 ─────────────────────────────────────────────────────────────────────

export interface PerfRow {
  readonly domain: Domain
  readonly pair: string
  readonly wiredAt: string
  readonly caseId: string
  readonly meta: CaseMeta
  readonly medianMs: number
  readonly minMs: number
  readonly units?: number
  readonly unitLabel?: string
  /** 单次调用把计算核线性内存高水位抬高的字节数（确定性；无探针为 undefined）。 */
  readonly linearDeltaBytes?: number
  readonly note?: string
}

export interface PerfOptions {
  scale: Scale
  /** 采样轮数（取中位数；不含 1 轮预热与线性内存探针那次）。 */
  rounds?: number
  probe?: PerfProbe
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

function sumLinear(linear: Record<string, number>): number {
  let total = 0
  for (const value of Object.values(linear)) total += value
  return total
}

/**
 * 跑全部 case。
 *
 * 每个 case 的顺序有意如此：
 * 1. **第 1 次调用 = 线性内存探针**。线性内存是只涨不跌的高水位，重复调用不会让它再涨，
 *    所以「本 case 让核永久长高多少」只能由一次调用给出——放在预热之后量会读到 0。
 * 2. 第 1 次调用同时充当预热（JIT / wasm 装载 / 引擎首载都不进样本）。
 * 3. 再跑 `rounds` 轮计时，取中位数与最小。
 */
export async function runPerf(
  suites: readonly PerfSuite[],
  options: PerfOptions,
): Promise<PerfRow[]> {
  const rounds = options.rounds ?? 5
  const rows: PerfRow[] = []
  for (const suite of suites) {
    for (const pair of suite.pairs) {
      for (const scenario of pair.cases) {
        if (!includeCase(scenario.meta, options.scale)) continue
        const before = options.probe ? sumLinear(options.probe.linearMemory()) : undefined
        await scenario.run()
        const linearDeltaBytes = options.probe && before !== undefined
          ? sumLinear(options.probe.linearMemory()) - before
          : undefined
        const samples: number[] = []
        for (let round = 0; round < rounds; round += 1) {
          const started = performance.now()
          await scenario.run()
          samples.push(performance.now() - started)
        }
        rows.push({
          domain: pair.domain,
          pair: pair.name,
          wiredAt: pair.wiredAt,
          caseId: scenario.id,
          meta: scenario.meta,
          medianMs: median(samples),
          minMs: Math.min(...samples),
          ...(scenario.units !== undefined ? { units: scenario.units } : {}),
          ...(scenario.unitLabel !== undefined ? { unitLabel: scenario.unitLabel } : {}),
          ...(linearDeltaBytes !== undefined ? { linearDeltaBytes } : {}),
          ...(scenario.note !== undefined ? { note: scenario.note } : {}),
        })
      }
    }
  }
  return rows
}

// ── 显示 ─────────────────────────────────────────────────────────────────────

/** 耗时：≥100ms 取整；≥1ms 两位小数；其余三位（µs 级才看得出差别）。 */
function ms(value: number): string {
  if (value >= 100) return value.toFixed(0)
  if (value >= 1) return value.toFixed(2)
  return value.toFixed(3)
}

/** 单位成本：µs 起步，低于 0.01µs 退到 ns——避免整列都是 `0.00`。 */
function unitCost(medianMs: number, units: number): string {
  const micros = (medianMs * 1000) / units
  if (micros >= 1) return `${micros.toFixed(2)}µs`
  if (micros >= 0.01) return `${micros.toFixed(3)}µs`
  return `${(micros * 1000).toFixed(1)}ns`
}

/**
 * 单位成本的最小工作量门槛。
 *
 * 为什么需要：调用本身有固定开销（过界 + 一次 JS→wasm 编组，实测 5–30µs 量级），工作量
 * 低于门槛时这个固定量会主导读数——1 字符的输入会算出 `23.70µs/字符` 这种纯噪声。
 * 老对照跑器在 xs 档把这类噪声当比值印出来（`corpus-5 = 13.83` 之类），是本 issue 要废除的
 * 那个形状之一；这里显式收口：**工作量不足就只报耗时，不报单位成本**。
 * 门槛取 32：`单位成本` 至少由 32 个单位的和给出，固定开销被摊薄到不再主导。
 */
const MIN_UNITS_FOR_UNIT_COST = 32

function bytes(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)}M`
  if (abs === 0) return '0'
  return `${(value / 1024).toFixed(1)}K`
}

export function formatPerfTable(rows: readonly PerfRow[], opts: { rounds: number, hasProbe: boolean }): string {
  const head = ['domain', '路径', 'case', 'scale', 'ms中位', 'ms最小', '工作量', '单位成本', '核线性Δ']
  const body = rows.map((row) => {
    const cost = row.units !== undefined && row.units >= MIN_UNITS_FOR_UNIT_COST
      ? `${unitCost(row.medianMs, row.units)}/${row.unitLabel ?? '单位'}`
      : '—'
    return [
      row.domain,
      row.pair,
      row.caseId,
      row.meta.scale ?? 'xs',
      ms(row.medianMs),
      ms(row.minMs),
      row.units !== undefined ? String(row.units) : '—',
      cost,
      row.linearDeltaBytes !== undefined ? bytes(row.linearDeltaBytes) : '—',
    ]
  })
  const widths = head.map((column, index) => Math.max(column.length, ...body.map(cells => cells[index]!.length)))
  const line = (cells: readonly string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join('  ')
  const separator = widths.map(width => '─'.repeat(width)).join('──')
  const header = [
    `每 case 预热 1 轮 + ${opts.rounds} 轮取中位；单位成本 = 中位耗时 / 工作量（工作量 < ${MIN_UNITS_FOR_UNIT_COST} 时报 —：固定开销会主导读数）`,
    opts.hasProbe ? '核线性Δ = 单次调用抬高计算核高水位的字节数（确定性、与 GC 无关；0 表示未抬高已到过的高水位，不是「不占内存」）' : '（未注入内存探针，核线性Δ 不可用）',
    'ms最小 是无干扰地板：中位与最小拉得开说明本轮采样被外部负载污染',
  ].join('\n')
  return [header, line(head), separator, ...body.map(cells => line(cells))].join('\n')
}

/** 分域小结：case 数、Σ中位耗时、中位单位成本。 */
export function summarizePerf(rows: readonly PerfRow[]): string {
  const byDomain = new Map<string, PerfRow[]>()
  for (const row of rows) {
    const list = byDomain.get(row.domain) ?? []
    list.push(row)
    byDomain.set(row.domain, list)
  }
  const lines = ['分域小结（case 数 / Σ中位耗时 / 中位单位成本）']
  for (const [domain, list] of byDomain) {
    const total = list.reduce((sum, row) => sum + row.medianMs, 0)
    const ratios = list
      .filter(row => row.units !== undefined && row.units >= MIN_UNITS_FOR_UNIT_COST)
      .map(row => (row.medianMs * 1000) / row.units!)
      .sort((left, right) => left - right)
    const pick = ratios.length === 0 ? '—' : `${ratios[Math.floor(ratios.length / 2)]!.toFixed(3)}µs`
    lines.push(`  ${domain.padEnd(19)} ${String(list.length).padStart(3)} / ${ms(total).padStart(9)}ms / ${pick.padStart(9)}`)
  }
  return lines.join('\n')
}

/** 帧预算只对「工作量够大」的 case 有意义：拍数太少时单拍成本是噪声（同单位成本门槛的理由）。 */
const MIN_TICKS_FOR_FRAME_BUDGET = 20

/**
 * 帧预算参考。实时路径的单位成本只有摆到帧预算旁边才有意义：60fps 的预算是 16.67ms/拍，
 * 一个 per-tick 成本占它多少，直接决定这拍还剩多少余量给 DOM。
 *
 * 只列 `unitLabel === '拍'` 的域（当前是 streaming-reveal）——它的「工作量」是一次发布/一拍，
 * 不是一次调用。取拍数达门槛的 case 里 per-tick 成本**最高**的一条（burst 档预算更大，
 * 通常就是最坏形状）。
 */
export function frameBudgetNote(rows: readonly PerfRow[], frameMs = 1000 / 60): string {
  const candidates = rows.filter(
    row => row.unitLabel === '拍' && row.units !== undefined && row.units >= MIN_TICKS_FOR_FRAME_BUDGET,
  )
  if (candidates.length === 0) {
    return `帧预算参考：本档没有拍数 ≥ ${MIN_TICKS_FOR_FRAME_BUDGET} 的揭示 case（PERF_SCALE=s 及以上才有），跳过。`
  }
  const worst = candidates.reduce((top, row) => (row.medianMs / row.units! > top.medianMs / top.units! ? row : top), candidates[0]!)
  const micros = (worst.medianMs * 1000) / worst.units!
  const share = (worst.medianMs / frameMs) * 100
  return `帧预算参考：最贵的一条是 ${worst.domain} · ${worst.pair} · ${worst.caseId}`
    + `（${micros.toFixed(2)}µs/拍 × ${worst.units} 拍，该拍占 60fps 帧预算 ${frameMs.toFixed(2)}ms 的 ${share.toFixed(2)}%）`
    + '\n  —— 该读数只覆盖计算核那一段，DOM 消费（行测量、高亮挂载）不在其中。'
}

/** 脚注：case 自带的 `note`（为什么单列这个形状）。 */
export function notesOf(suites: readonly PerfSuite[]): string {
  const lines: string[] = []
  for (const suite of suites) {
    for (const pair of suite.pairs) {
      if (pair.note) lines.push(`  [${pair.name}] ${pair.note}`)
      for (const scenario of pair.cases) {
        if (scenario.note) lines.push(`  [${pair.name} · ${scenario.id}] ${scenario.note}`)
      }
    }
  }
  return lines.length === 0 ? '' : `脚注\n${lines.join('\n')}`
}
