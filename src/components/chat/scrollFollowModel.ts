/**
 * scrollFollowModel — 滚动跟随判别纯函数（scrollFollowState 的后继模块，P57 S1）。
 *
 * R-C1 修复的核心契约：程序化滚动写入与用户滚动可判别。旧 `scrollFollowState.ts`
 * 的纯位置判别把 auto-follow 写入自身的 scroll 反馈事件误判为用户输入，风暴中
 * 直接关掉跟随（主症状）；该模块的"写迹判别"以组件记录的最近一次程序化写入
 * 端点为迹，命中阈值的 scroll 事件是程序化反馈，不推翻跟随相位。
 *
 * 与 followLockUntil 锁窗正交共存：锁窗压制程序化动画期间的反馈（R-C5），
 * 写迹判别压制无动画 instant 写入的反馈；输入模态（wheel/touch/键盘）是唯一
 * 的用户取消通道。
 */

export type ScrollEventKind = 'programmatic-feedback' | 'user'

/** 最近一次程序化滚动写入：写入的目标 top 与写入时刻（performance.now ms）。 */
export interface ScrollWriteTrace {
  readonly top: number
  readonly at: number
}

/** 写迹命中阈值（px）。Windows 125%/150% 缩放亚像素抖动与触控板小步滚需要远小于 48px 相位阈值的判定带宽。 */
export const SCROLL_TRACE_THRESHOLD_PX = 2

/** DPR 兜底：高分屏缩放下亚像素抖动放大，阈值放宽到 max(2, 0.5×devicePixelRatio)。 */
export function scrollTraceThreshold(devicePixelRatioValue: number | undefined = typeof devicePixelRatio === 'undefined' ? undefined : devicePixelRatio): number {
  return Math.max(SCROLL_TRACE_THRESHOLD_PX, (devicePixelRatioValue ?? 1) * 0.5)
}

/**
 * 判别一个 scroll 事件是程序化写入的反馈还是用户输入。
 * 表驱动可测：|scrollTop - trace.top| ≤ threshold → 程序化反馈；无迹或超阈值 → 用户。
 */
export function classifyScrollEvent(
  scrollTop: number,
  trace: ScrollWriteTrace | undefined,
  threshold: number = SCROLL_TRACE_THRESHOLD_PX,
): ScrollEventKind {
  if (trace === undefined) return 'user'
  return Math.abs(scrollTop - trace.top) <= threshold ? 'programmatic-feedback' : 'user'
}

/** 平滑滚动锁窗 / 即时滚动锁窗（smooth 动画时长内忽略用户滚动）。 */
export const SMOOTH_LOCK_MS = 500
export const INSTANT_LOCK_MS = 50
