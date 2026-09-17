/**
 * #116 子项 4：口径与 OverviewSheetView 的 relativeTime 对齐——同一批会话数据在
 * Overview 显示「2 天前」、在侧栏显示「2d ago」，是同一应用内两种说法。
 */
export function formatTime(ts: number | undefined): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
