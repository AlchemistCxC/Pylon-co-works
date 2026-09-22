/**
 * #243 切片 1：行高表 + 偏移索引。
 *
 * 尺寸真值按**行 key**（messageId）存储——行卸载/重挂/重排都不丢测量（D7 改口径①：
 * 「尺寸缓存不随卸载丢弃 ⇒ 回滚布局不跳」），偏移数组从**最早脏索引**增量重建
 * （spec 240 附录 B1 的改判：1 万行的后缀重建是微秒级，不上 Fenwick 树）。
 *
 * 变更批处理由调用方负责（PlainMessageList 用 createFrameTask 按帧合并后再通知引擎）；
 * 本模块只保证：任何读操作前偏移都与尺寸一致（读时惰性重建）。
 */

export interface RowHeightEntry {
  readonly size: number
  readonly source: 'estimated' | 'measured'
}

export interface RowHeightTable {
  /** 行集合换代：与旧 keys 求最长公共前缀定位脏起点；缺失尺寸用 estimateFor 播种。 */
  setKeys(keys: readonly string[], estimateFor: (key: string) => number): void
  /** 播种估算：已有条目（无论来源）一律不覆写。 */
  seedEstimate(key: string, size: number): void
  /**
   * 行内容已变化的口径更新：未测行换新估算；已测但**不在挂载窗**（无法被 ResizeObserver
   * 即时纠正）的行降级回估算；已测且在窗内的行保留实测（观察器稍后回填真实值）。
   */
  refreshAfterContentChange(key: string, size: number, currentlyMounted: boolean): void
  /**
   * 实测回填。与现值差在 ε 内的写回被忽略（亚像素抖动会制造无意义的脏重建）；
   * 返回实际生效的差值（新 − 旧；0 表示被忽略或无变化）。
   */
  measure(key: string, size: number): number
  /** 作废单行实测（降级回估算，尺寸取 estimateFor 重算）。 */
  invalidate(key: string, estimateFor: (key: string) => number): void
  /**
   * 作废全部实测（theme/font/container 失效路径），尺寸统一由 estimateFor 重算。
   * 遍历**全部已知条目**（含已退役行）：当前行集用 estimateFor 重估；退役行无内容
   * 可估，原值降级为估算（调用方的 estimateFor 以 sizeOf 回落）——过期实测不再被
   * 重挂命中（审查 P1-4）。
   */
  invalidateAll(estimateFor: (key: string) => number): void
  entry(key: string): RowHeightEntry | undefined
  isMeasured(key: string): boolean
  /** 第 index 行的顶边偏移（相对列表原点）；index ∈ [0, count] 合法，越界返回 undefined。 */
  offsetAt(index: number): number | undefined
  /** 给定偏移所在行（顶边 ≤ offset 的最后一行；空表或负偏移返回 undefined）。 */
  indexForOffset(offset: number): number | undefined
  sizeAt(index: number): number | undefined
  sizeOf(key: string): number | undefined
  indexOf(key: string): number | undefined
  readonly count: number
  /** 全部行高之和（读时保证与尺寸一致）。 */
  totalSize(): number
  /** 是否存在待重建的脏偏移（测试与调试用）。 */
  readonly dirty: boolean
  reset(): void
}

/** 亚像素写回阈值：与 #212 S4 的 ANCHOR_EPSILON_PX 同量级，防止 RO 抖动制造脏帧。 */
const MEASURE_WRITE_EPSILON_PX = 0.5

export function createRowHeightTable(): RowHeightTable {
  let keys: readonly string[] = []
  const sizes = new Map<string, RowHeightEntry>()
  const indexByKey = new Map<string, number>()
  let offsets: number[] = [0]
  let dirtyFrom = Number.POSITIVE_INFINITY

  const rebuildIfDirty = () => {
    if (dirtyFrom > keys.length) return
    const from = Math.max(0, dirtyFrom)
    for (let index = from; index < keys.length; index += 1) {
      offsets[index + 1] = offsets[index]! + (sizes.get(keys[index]!)?.size ?? 0)
    }
    offsets.length = keys.length + 1
    dirtyFrom = keys.length + 1
  }

  const markDirtyFrom = (index: number) => {
    dirtyFrom = Math.min(dirtyFrom, Math.max(0, index))
  }

  const writeSize = (key: string, entry: RowHeightEntry) => {
    sizes.set(key, entry)
    const index = indexByKey.get(key)
    if (index !== undefined) markDirtyFrom(index)
  }

  return {
    setKeys(nextKeys, estimateFor) {
      let divergence = Math.min(keys.length, nextKeys.length)
      for (let index = 0; index < divergence; index += 1) {
        if (keys[index] !== nextKeys[index]) { divergence = index; break }
      }
      keys = nextKeys
      indexByKey.clear()
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index]!
        indexByKey.set(key, index)
        // 已退役行的尺寸条目**保留**在 sizes 里（不随行集收缩丢弃）——回滚重挂时
        // 直接命中实测，这就是 D7 改口径①的机制载体。条目上限 = 会话中出现过的
        // 唯一行数，与 DOM 常驻无关。
        if (!sizes.has(key)) sizes.set(key, { size: estimateFor(key), source: 'estimated' })
      }
      offsets.length = keys.length + 1
      offsets[0] = 0
      markDirtyFrom(divergence)
      rebuildIfDirty()
    },
    seedEstimate(key, size) {
      if (sizes.has(key)) return
      writeSize(key, { size, source: 'estimated' })
    },
    refreshAfterContentChange(key, size, currentlyMounted) {
      const existing = sizes.get(key)
      if (!existing) { writeSize(key, { size, source: 'estimated' }); return }
      if (existing.source === 'measured' && currentlyMounted) return
      if (existing.size === size && existing.source === 'estimated') return
      writeSize(key, { size, source: 'estimated' })
    },
    measure(key, size) {
      const existing = sizes.get(key)
      if (existing === undefined || indexByKey.get(key) === undefined) return 0
      const previous = existing.size
      if (Math.abs(size - previous) < MEASURE_WRITE_EPSILON_PX) {
        // 差量虽在 ε 内，来源仍要升格为实测（估算被真实 DOM 佐证过）
        if (existing.source !== 'measured') sizes.set(key, { size: previous, source: 'measured' })
        return 0
      }
      writeSize(key, { size, source: 'measured' })
      return size - previous
    },
    invalidate(key, estimateFor) {
      const existing = sizes.get(key)
      if (!existing || existing.source !== 'measured') return
      writeSize(key, { size: estimateFor(key), source: 'estimated' })
    },
    invalidateAll(estimateFor) {
      let earliest = Number.POSITIVE_INFINITY
      for (const [key, entry] of sizes) {
        if (entry.source !== 'measured') continue
        sizes.set(key, { size: estimateFor(key), source: 'estimated' })
        const index = indexByKey.get(key)
        if (index !== undefined) earliest = Math.min(earliest, index)
      }
      if (earliest < Number.POSITIVE_INFINITY) markDirtyFrom(earliest)
    },
    entry: key => sizes.get(key),
    isMeasured: key => sizes.get(key)?.source === 'measured',
    offsetAt(index) {
      rebuildIfDirty()
      if (index < 0 || index > keys.length) return undefined
      return offsets[index]
    },
    indexForOffset(offset) {
      rebuildIfDirty()
      if (keys.length === 0 || offset < 0) return undefined
      // 二分：顶边 ≤ offset 的最后一行（spec 240 B3 的 `<=` 边界语义同源）；
      // offset 超过末行底边时钳到最后一行（scrollTo 落点要的是行，不是哨兵）
      let low = 0
      let high = keys.length - 1
      let best = 0
      while (low <= high) {
        const middle = (low + high) >> 1
        if (offsets[middle + 1]! <= offset) { best = middle + 1; low = middle + 1 }
        else high = middle - 1
      }
      return Math.min(best, keys.length - 1)
    },
    sizeAt(index) {
      const key = keys[index]
      return key === undefined ? undefined : sizes.get(key)?.size
    },
    sizeOf: key => sizes.get(key)?.size,
    indexOf: key => indexByKey.get(key),
    get count() { return keys.length },
    totalSize() {
      rebuildIfDirty()
      return offsets[keys.length] ?? 0
    },
    get dirty() { return dirtyFrom <= keys.length },
    reset() {
      keys = []
      sizes.clear()
      indexByKey.clear()
      offsets = [0]
      dirtyFrom = Number.POSITIVE_INFINITY
    },
  }
}
