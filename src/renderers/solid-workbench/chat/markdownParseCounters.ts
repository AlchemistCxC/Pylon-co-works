/**
 * #148 只读计数：流式 markdown 解析的调用数与耗时（纯观测，不参与任何渲染决策）。
 *
 * 为什么需要它：尾块的解析请求「最新即胜」——被取代的请求结果会被 Solid 丢弃
 * （`createResource` 的 `loadEnd` 只在 `pr === p` 时提交），因此它们不该跑解析器。
 * `skipped` 记下被判据挡下的请求数，`parsed` 记下真正进过解析器的次数：
 * 突发（一 tick 内多次发布）下 `skipped` 应当占绝大多数，帧节奏下应当为 0。
 *
 * `parseMs` / `maxParseMs` / `maxTextLength` 回答的是另一个问题——**长单块值不值得进一步优化**：
 * 尾块每帧重解析整块，成本随块长线性增长（issue #148 的调查结论），但现场出现频率未知。
 * 这三个数按需从 `__PYLON_KERNEL_DEV__.diagnostics.read('streamingDisplay')` 的 `parseCost` 取。
 *
 * 计数是模块级累计量：读数是「本次运行内所有解析」的聚合，不持有任何引用。
 */
export interface MarkdownParseCountersSnapshot {
  /** 命中 LRU 的请求数（稳定块复用，未进解析器） */
  readonly cacheHits: number
  /** 真正跑过解析器的请求数 */
  readonly parsed: number
  /**
   * #150 命中增量 graft 的请求数（纯文本追加直接拼接上一模型，未进解析器）。
   * 与 `parsed` 合看即「结构字符重解析」与「纯文本拼接」的比例；graft 不进 `parseMs`。
   */
  readonly grafted: number
  /** 因请求已被取代（结果必被丢弃）而跳过解析的请求数 */
  readonly skipped: number
  /** 解析器内累计耗时（毫秒，取整；只算 `parse` + `run`，不含模块加载） */
  readonly parseMs: number
  /** 单次解析最大耗时（毫秒，保留一位小数） */
  readonly maxParseMs: number
  /** 解析过的最大文本长度（字符数）——长单块判据 */
  readonly maxTextLength: number
}

let cacheHits = 0
let parsed = 0
let grafted = 0
let skipped = 0
let parseMs = 0
let maxParseMs = 0
let maxTextLength = 0

/** 记一次缓存命中（调用本身不改变任何渲染决策）。 */
export function noteMarkdownParseCacheHit(): void {
  cacheHits += 1
}

/** 记一次增量 graft 命中（纯文本追加拼接，未进解析器）。 */
export function noteMarkdownParseGrafted(): void {
  grafted += 1
}

/** 记一次被取代而跳过的解析请求。 */
export function noteMarkdownParseSkipped(): void {
  skipped += 1
}

/** 记一次真正跑完的解析：耗时与文本长度。 */
export function noteMarkdownParseDone(input: { readonly durationMs: number; readonly textLength: number }): void {
  parsed += 1
  const duration = normalizeDuration(input.durationMs)
  parseMs += duration
  if (duration > maxParseMs) maxParseMs = round1(duration)
  const length = normalizeLength(input.textLength)
  if (length > maxTextLength) maxTextLength = length
}

export function markdownParseCounters(): MarkdownParseCountersSnapshot {
  return { cacheHits, parsed, grafted, skipped, parseMs: Math.round(parseMs), maxParseMs, maxTextLength }
}

/** 测试用：清空累计计数。 */
export function resetMarkdownParseCounters(): void {
  cacheHits = 0
  parsed = 0
  grafted = 0
  skipped = 0
  parseMs = 0
  maxParseMs = 0
  maxTextLength = 0
}

function normalizeDuration(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function normalizeLength(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}
