export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens)) return '0'
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return millions >= 10 ? `${Math.round(millions)}M` : `${millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000
    return thousands >= 10 ? `${Math.round(thousands)}K` : `${thousands.toFixed(1)}K`
  }
  return String(tokens)
}

export function formatCacheReadTokens(tokens: number): string {
  return `${formatTokenCount(tokens)} cached`
}

/**
 * 用量控件（S11）的 token 计数格式 —— 与 formatTokenCount 的区别：
 * 单位小写 `k` / `m`、数字与单位之间一个空格、小数恒一位（含 0 与不足 1000 的值）。
 * 例：`123.5 k`、`200.0 k`、`1.2 m`。
 */
export function formatUsageTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return '0.0 k'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)} m`
  return `${(tokens / 1_000).toFixed(1)} k`
}

/** 用量控件（S11）的百分比格式 —— 入参为 0–1 的比值，输出一位小数，例 `45.6%`。 */
export function formatUsagePercent(ratio: number): string {
  const percent = Number.isFinite(ratio) ? ratio * 100 : 0
  return `${percent.toFixed(1)}%`
}
