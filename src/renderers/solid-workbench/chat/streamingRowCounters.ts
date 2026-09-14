/**
 * S0 只读计数：流式行集合的规模与「输入回退」次数（纯观测，不参与任何渲染决策）。
 *
 * 为什么需要它：行集合必须始终是当前文本的函数。`rowsPerTextLength > 1` 说明行集合里
 * 出现了文本里并不存在的边界——历史上「每几个字换行」的碎裂（issue #55）就是它的后果；
 * `resets` 说明发布链出现过非后继输入（插值前缀、双列表分叉、终态重发、resume 之一）。
 * 两者都是本 issue 的现场判据，且不依赖任何 DOM 读取。
 *
 * 计数是模块级累计量：读数是「本次运行内所有流式行」的聚合，不持有任何引用，因此不会
 * 影响行组件的回收；`rows`/`textParagraphs` 表示最近一次发布（多行并发时为最后发布者）。
 */
export interface StreamingRowCountersSnapshot {
  /** 记账过的发布次数 */
  readonly publications: number
  /**
   * 行集合被整体重建的次数：输入不是上一次文本后继（回退/换挡/重放）的次数。
   * 对应旧实现里 `reset()` 的那条路径，但现在不再有特殊分支——只是把「推导输入退过」这件事记下来。
   */
  readonly resets: number
  /** 最近一次发布的行数与文本段落数 */
  readonly rows: number
  readonly textParagraphs: number
  /** 最近一次的 rows / textParagraphs（段落数为 0 时为 0） */
  readonly rowsPerTextLength: number
  /** 历史最大 rows / textParagraphs；**> 1 即行集合出现文本之外的边界** */
  readonly maxRowsPerTextLength: number
}

let publications = 0
let resets = 0
let lastRows = 0
let lastParagraphs = 0
let lastRowsPerTextLength = 0
let maxRowsPerTextLength = 0

/** 记一次行集合推导结果（每次发布调用一次；调用本身不改变任何渲染决策）。 */
export function noteStreamingRowSet(input: {
  readonly rows: number
  readonly paragraphs: number
  readonly reset: boolean
}): void {
  publications += 1
  if (input.reset) resets += 1
  lastRows = normalize(input.rows)
  lastParagraphs = normalize(input.paragraphs)
  lastRowsPerTextLength = ratio(lastRows, lastParagraphs)
  if (lastRowsPerTextLength > maxRowsPerTextLength) maxRowsPerTextLength = lastRowsPerTextLength
}

export function streamingRowCounters(): StreamingRowCountersSnapshot {
  return {
    publications,
    resets,
    rows: lastRows,
    textParagraphs: lastParagraphs,
    rowsPerTextLength: lastRowsPerTextLength,
    maxRowsPerTextLength,
  }
}

/** 测试用：清空累计计数。 */
export function resetStreamingRowCounters(): void {
  publications = 0
  resets = 0
  lastRows = 0
  lastParagraphs = 0
  lastRowsPerTextLength = 0
  maxRowsPerTextLength = 0
}

function normalize(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

function ratio(rows: number, paragraphs: number): number {
  return paragraphs > 0 ? rows / paragraphs : 0
}
