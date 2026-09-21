// ─────────────────────────────────────────────────────────────────────────────
// 【雕刻基线】迁移前的 TS journal 覆盖区间合并（issue #220 投影核 coverage 段）。
//
// 出处：`git show 76cbc819^:src/domains/workbench/workbenchProjector.ts` 的
// `isSpanCovered` / `mergeCoverage` / `mergeCoverageInPlace` 逐字拷贝（现文件为
// `scripts/compute-parity/baselines/oldWorkbenchProjector.ts` L289-340，同源）。
// wasm 对向出口：`projectorMergeCoverage`（Rust `projector/coverage.rs`）。
//
// 仅服务 `scripts/compute-parity/` 脚手架，不在任何生产路径。
// ─────────────────────────────────────────────────────────────────────────────

export function isSpanCovered(ranges: readonly (readonly [number, number])[], start: number, end: number): boolean {
  for (const [from, to] of ranges) {
    if (from > start) return false
    if (end <= to) return true
  }
  return false
}

/** 并入一个区间并保持升序不重叠（吸收接触/重叠区间）。 */
export function mergeCoverage(ranges: readonly (readonly [number, number])[], start: number, end: number): readonly (readonly [number, number])[] {
  const merged: [number, number][] = []
  let low = start
  let high = end
  let placed = false
  for (const [from, to] of ranges) {
    if (to < low - 1) {
      merged.push([from, to])
      continue
    }
    if (from > high + 1) {
      // 整数跨度上相邻即连续（[1,3]+[4,6] → [1,6]），接触区间一律吸收
      if (!placed) {
        merged.push([low, high])
        placed = true
      }
      merged.push([from, to])
      continue
    }
    low = Math.min(low, from)
    high = Math.max(high, to)
  }
  if (!placed) merged.push([low, high])
  return merged
}

/** `mergeCoverage` 的就地版（#205 批量回放路径；合并规则逐字一致）。 */
export function mergeCoverageInPlace(ranges: [number, number][], start: number, end: number): void {
  let first = 0
  while (first < ranges.length && ranges[first]![1] < start - 1) first++
  let low = start
  let high = end
  let last = first
  while (last < ranges.length && ranges[last]![0] <= high + 1) {
    low = Math.min(low, ranges[last]![0])
    high = Math.max(high, ranges[last]![1])
    last++
  }
  if (first === last && ranges[first]?.[0] === low && ranges[first]?.[1] === high) return
  ranges.splice(first, last - first, [low, high])
}
