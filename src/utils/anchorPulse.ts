/**
 * anchorPulse — 设置项锚点定位后的高亮脉冲（O-2）。
 *
 * #228 批次D 收敛 components/Settings.tsx 与 sheets/SettingsSheetSidebar.tsx 的
 * 复制粘贴脉冲（同类名、同时长）。prefers-reduced-motion 时 CSS 端自动禁用动画；
 * 类名与 1200ms 时长为两处既有约定，不得在此改动（改样式走设置样式域）。
 */
export function pulseSettingsAnchor(target: Element | null | undefined): void {
  if (!target) return
  target.classList.add('settings-anchor-pulse')
  setTimeout(() => target.classList.remove('settings-anchor-pulse'), 1200)
}
