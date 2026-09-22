// 计算纯函数 TS↔wasm 对照脚手架的**跑器与口径**（issue #220 的配套基建）。
//
// 设计（用户裁决的「多维度多场景」）：
// - 每个 wasm 出口登记为一个 PairSpec：`ts` 侧是迁移前/保留的 TS 原生实现，
//   `wasm` 侧是计算核出口；两侧吃**同一份输入**、产出按同一口径归一后逐字节比对。
// - 场景（CaseSpec）带维度标注：scale（xs/s/m/l 输入量级）、shape（结构变体）、
//   edge（边界/病态输入）、flow（cold/paged/idempotent 等状态流形态）。
//   parity 门禁默认只跑 xs/s/m（+全部 shape/edge）；`COMPUTE_PARITY_SCALE=full`
//   才含 l，CI 不为极量级付时间。
// - 同一套 Suite 的 **case 定义**被产品路径性能基准（`scripts/perf-bench.mts`，issue #233）
//   借用——它只取 pair 的 `wasm` 侧（生产出口）计时，不做双侧比值。
//
// #233 起本文件**只剩 parity 跑器**：原先放在这里的性能/内存跑器（`runBench` / `runMemory`
// / `formatBenchTable` / `formatMemoryTable` 等）已随「废除 wasm↔TS 对照 benchmark」一并删除——
// 那套口径输出的是两个实现的比值，而 TS 侧是 `baselines/`（不在生产路径），不是产品路径成本。

/** 输入量级维度。l 档只在 `COMPUTE_PARITY_SCALE=full` 下参与 parity。 */
export type Scale = 'xs' | 's' | 'm' | 'l'

export interface CaseMeta {
  readonly scale?: Scale
  /** 结构变体标签（如 single-part / multi-part / cjk / astral）。 */
  readonly shape?: string
  /** 边界或病态输入（空串、畸形、未闭合、NaN 时刻……）。 */
  readonly edge?: boolean
  /** 状态流形态（cold / paged / idempotent / prefix-scan / replay-script）。 */
  readonly flow?: string
}

export interface CaseSpec<In> {
  readonly id: string
  readonly meta: CaseMeta
  /** 每次运行取一份新输入（纯函数约定：不得就地改输入）。 */
  readonly build: () => In
}

export type PairFn<In, Out> = (input: In) => Out | Promise<Out>

export type Domain =
  | 'streaming-split'
  | 'streaming-budget'

export interface PairSpec<In, Out> {
  /** wasm 出口名（与 `#[wasm_bindgen(js_name)]` 一致）。 */
  readonly name: string
  readonly domain: Domain
  readonly ts: PairFn<In, Out>
  readonly wasm: PairFn<In, Out>
  /**
   * 归一化（键序、包装结构对齐等）后进 stableJson 比对；缺省恒等。
   * 键序本身不在迁移契约内（Rust serde Map 为字典序）。
   */
  readonly normalize?: (value: Out) => unknown
  /** 已过审的两侧差异 case id（如高亮 js/go 引擎级残差）：报告为 known-diff 不算红。 */
  readonly knownDivergences?: readonly string[]
  readonly cases: readonly CaseSpec<In>[]
}

export interface Suite {
  readonly domain: Domain
  readonly pairs: readonly PairSpec<unknown, unknown>[]
}

// ── 归一化比对口径 ───────────────────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 键序归一的 JSON 字符串（与 eventsComputeParity 的 stableJson 同一语义）。 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')
    return `{${entries}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * 边界归一：把 serde_wasm_bindgen 编成 JS `Map` 的 BTreeMap 深转回普通对象。
 *
 * 口径依据 `pylon-markdown/src/wasm_exit.rs` 头注：旧产物把 `properties` 编成
 * Map（`JSON.stringify` 得 `{}`），wasm 侧的在途修复是边界上就给普通对象；
 * 本归一与其同语义，产物更新后是空操作。只影响比对口径，不改两侧实现。
 */
export function normalizeBoundaryMaps<T>(value: T): T {
  if (value instanceof Map) {
    return normalizeBoundaryMaps(Object.fromEntries(value)) as T
  }
  if (Array.isArray(value)) return value.map(item => normalizeBoundaryMaps(item)) as T
  if (isRecord(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = normalizeBoundaryMaps(item)
    return out as T
  }
  return value
}

function truncate(text: string, limit = 320): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…(${text.length}B)`
}

// ── 维度过滤 ─────────────────────────────────────────────────────────────────

export function includeCase(meta: CaseMeta, scale: Scale): boolean {
  const caseScale = meta.scale ?? 'xs'
  const rank: Record<Scale, number> = { xs: 0, s: 1, m: 2, l: 3 }
  return rank[caseScale] <= rank[scale]
}

export function resolveScale(requested?: string): Scale {
  if (requested === 'full' || requested === 'l') return 'l'
  if (requested === 'xs' || requested === 's') return 's'
  return 'm'
}

// ── parity 跑器 ──────────────────────────────────────────────────────────────

export interface ParityRow {
  readonly domain: Domain
  readonly pair: string
  readonly caseId: string
  readonly meta: CaseMeta
  readonly outcome: 'ok' | 'known-diff' | 'mismatch'
  readonly detail?: string
}

function normalizeOut<Out>(pair: PairSpec<unknown, unknown>, value: Out): unknown {
  return pair.normalize ? pair.normalize(value) : value
}

export async function runParity(
  suites: readonly Suite[],
  options: { scale: Scale } = { scale: resolveScale(process.env.COMPUTE_PARITY_SCALE) },
): Promise<ParityRow[]> {
  const rows: ParityRow[] = []
  for (const suite of suites) {
    for (const pair of suite.pairs) {
      const known = new Set(pair.knownDivergences ?? [])
      for (const scenario of pair.cases) {
        if (!includeCase(scenario.meta, options.scale)) continue
        const input = scenario.build()
        const tsOut = normalizeOut(pair, await pair.ts(input))
        const wasmOut = normalizeOut(pair, await pair.wasm(input))
        const tsJson = stableJson(tsOut)
        const wasmJson = stableJson(wasmOut)
        if (tsJson === wasmJson) {
          rows.push({ domain: suite.domain, pair: pair.name, caseId: scenario.id, meta: scenario.meta, outcome: 'ok' })
          continue
        }
        if (known.has(scenario.id)) {
          rows.push({
            domain: suite.domain, pair: pair.name, caseId: scenario.id, meta: scenario.meta,
            outcome: 'known-diff',
            detail: `已过审差异：TS ${truncate(tsJson)} / wasm ${truncate(wasmJson)}`,
          })
          continue
        }
        rows.push({
          domain: suite.domain, pair: pair.name, caseId: scenario.id, meta: scenario.meta,
          outcome: 'mismatch',
          detail: `TS(${tsJson.length}B) ${truncate(tsJson)}\n    wasm(${wasmJson.length}B) ${truncate(wasmJson)}`,
        })
      }
    }
  }
  return rows
}

export function summarizeParity(rows: readonly ParityRow[]): string {
  const ok = rows.filter(row => row.outcome === 'ok').length
  const known = rows.filter(row => row.outcome === 'known-diff').length
  const bad = rows.filter(row => row.outcome === 'mismatch')
  const lines = [
    `parity 断言 ${rows.length} 项：ok ${ok} / known-diff ${known} / mismatch ${bad.length}`,
  ]
  for (const row of bad) {
    lines.push(`  ✗ [${row.domain}] ${row.pair} · ${row.caseId}（scale=${row.meta.scale ?? 'xs'}${row.meta.shape ? ` shape=${row.meta.shape}` : ''}${row.meta.edge ? ' edge' : ''}）`)
    if (row.detail) lines.push(`    ${row.detail}`)
  }
  for (const row of rows.filter(item => item.outcome === 'known-diff')) {
    lines.push(`  ~ [${row.domain}] ${row.pair} · ${row.caseId}：已过审差异`)
  }
  return lines.join('\n')
}
