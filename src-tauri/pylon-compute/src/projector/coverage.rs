//! #81 L2 / ADR-0016 的 span 占用语义（TS 基线：`workbenchProjector.ts` 内的
//! `coverageSpanOf` / `isSpanCovered` / `mergeCoverage` / `mergeCoverageInPlace`）。
//!
//! 方向约定（ADR-0016）：`*.delta.batch` 的 seqSpan 是**占用**声明——跨度中间没有
//! 行写入，读侧按 `owner#(seqStart+i)` 重建原始 chunk；`turn.unit` 的 `rollup_*` 是
//! **覆盖**声明。投影侧只消费信封携带的 `[start, end]` 覆盖跨度，把它当占用做幂等：
//! 「把占用当 gap」有错误码，「把覆盖当占用」静默丢数据——后者才是本组函数死守的半边。
//!
//! 区间集恒为**升序、互不重叠**；整数跨度上相邻即连续（`[1,3]+[4,6] → [1,6]`，
//! 接触区间一律吸收）。合并规则与 TS 逐字一致，两个实现（重建版/就地版）在
//! 同一输入上必须给出同一结果——单测互相钉死。

/// 合并后的区间（升序、互不重叠、整数端点）。
pub type CoverageRanges = Vec<(i64, i64)>;

/// `coverageSpanOf`：信封携带的 journal 覆盖跨度；形状非法视为无 coverage。
/// TS 判据 `Number.isSafeInteger(span[i]) && span[0] >= 1 && span[0] <= span[1]`。
pub fn coverage_span_of(span: Option<(f64, f64)>) -> Option<(i64, i64)> {
    let (start, end) = span?;
    let is_safe = |v: f64| v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0;
    if !is_safe(start) || !is_safe(end) || start < 1.0 || start > end {
        return None;
    }
    Some((start as i64, end as i64))
}

/// `isSpanCovered`：区间 [start,end] 是否被升序不重叠覆盖集完整包含。
///
/// 约束：coverage 信封必须「完整覆盖已应用区间或从全新文档到达」；部分重叠时整段
/// 仍会投影（内容重复拼接）——正常路径不可达（TS 审核 P2-1），此处保持同一行为。
pub fn is_span_covered(ranges: &CoverageRanges, start: i64, end: i64) -> bool {
    for &(from, to) in ranges {
        if from > start {
            return false;
        }
        if end <= to {
            return true;
        }
    }
    false
}

/// `mergeCoverage`：并入一个区间并保持升序不重叠（吸收接触/重叠区间）。
pub fn merge_coverage(ranges: &CoverageRanges, start: i64, end: i64) -> CoverageRanges {
    let mut merged: CoverageRanges = Vec::with_capacity(ranges.len() + 1);
    let mut low = start;
    let mut high = end;
    let mut placed = false;
    for &(from, to) in ranges {
        if to < low - 1 {
            merged.push((from, to));
            continue;
        }
        if from > high + 1 {
            if !placed {
                merged.push((low, high));
                placed = true;
            }
            merged.push((from, to));
            continue;
        }
        low = low.min(from);
        high = high.max(to);
    }
    if !placed {
        merged.push((low, high));
    }
    merged
}

/// `mergeCoverageInPlace`：就地版——只改写被触及的窗口，合并规则与 [`merge_coverage`]
/// 逐字一致（`to < low-1` 前缀保留、`from <= high+1` 吸收）。
/// TS 的 `if (first === last && …) return` 无变化短路在 splice 前判等，语义等价于
/// 不变时保留原数组；Rust 侧同一窗口赋值即可。
pub fn merge_coverage_in_place(ranges: &mut CoverageRanges, start: i64, end: i64) {
    let mut first = 0usize;
    while first < ranges.len() && ranges[first].1 < start - 1 {
        first += 1;
    }
    let mut low = start;
    let mut high = end;
    let mut last = first;
    while last < ranges.len() && ranges[last].0 <= high + 1 {
        low = low.min(ranges[last].0);
        high = high.max(ranges[last].1);
        last += 1;
    }
    if first == last && ranges.get(first) == Some(&(low, high)) {
        return;
    }
    ranges.splice(first..last, std::iter::once((low, high)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn span_validation_rejects_malformed_shapes() {
        assert_eq!(coverage_span_of(None), None);
        assert_eq!(coverage_span_of(Some((0.0, 6.0))), None, "start < 1 非法");
        assert_eq!(coverage_span_of(Some((6.0, 3.0))), None, "start > end 非法");
        assert_eq!(coverage_span_of(Some((3.5, 6.0))), None, "非整数非法");
        assert_eq!(coverage_span_of(Some((1.0, 1.0))), Some((1, 1)));
        assert_eq!(coverage_span_of(Some((1.0, 6.0))), Some((1, 6)));
    }

    #[test]
    fn merge_keeps_ascending_disjoint_and_absorbs_adjacent() {
        // 与 appliedRanges.test.ts 的「区间升序合并且不重叠」同序：
        // [4,6] [1,3] [8,8] [7,9] → [[1,9]]
        let mut ranges: CoverageRanges = Vec::new();
        for (start, end) in [(4, 6), (1, 3), (8, 8), (7, 9)] {
            ranges = merge_coverage(&ranges, start, end);
        }
        assert_eq!(ranges, vec![(1, 9)]);
    }

    #[test]
    fn merge_absorbs_touching_but_keeps_gapped() {
        let ranges: CoverageRanges = vec![(1, 3), (10, 12)];
        // [5,9] 与 [10,12] 相邻 → 吸收；与 [1,3] 不相邻 → 保留。
        assert_eq!(merge_coverage(&ranges, 5, 9), vec![(1, 3), (5, 12)]);
        // [5,8] 与两侧都不相邻 → 独立插入。
        assert_eq!(
            merge_coverage(&ranges, 5, 8),
            vec![(1, 3), (5, 8), (10, 12)]
        );
    }

    #[test]
    fn in_place_variant_matches_functional_variant() {
        let base: CoverageRanges = vec![(1, 3), (10, 12), (20, 20)];
        for (start, end) in [(5, 9), (4, 4), (13, 19), (0, 0), (1, 30), (11, 11)] {
            let functional = merge_coverage(&base, start, end);
            let mut in_place = base.clone();
            merge_coverage_in_place(&mut in_place, start, end);
            assert_eq!(functional, in_place, "merge [{start},{end}]");
        }
    }

    #[test]
    fn span_coverage_requires_full_containment() {
        let ranges: CoverageRanges = vec![(1, 6), (10, 12)];
        assert!(is_span_covered(&ranges, 1, 6));
        assert!(is_span_covered(&ranges, 2, 5));
        assert!(is_span_covered(&ranges, 10, 12));
        assert!(!is_span_covered(&ranges, 1, 7));
        assert!(!is_span_covered(&ranges, 7, 9));
        assert!(!is_span_covered(&ranges, 11, 13));
        // 前缀越界（from > start）即不可覆盖：部分重叠按未覆盖处理（投影会重放）。
        assert!(!is_span_covered(&ranges, 0, 3));
    }
}
