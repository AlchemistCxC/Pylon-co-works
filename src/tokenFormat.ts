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
