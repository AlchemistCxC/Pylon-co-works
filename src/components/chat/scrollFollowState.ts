/**
 * scrollFollowState — 消息区滚动跟随状态机（纯函数）。
 *
 * 自动滚动锚定语义（参考 CC ScrollBox 的 sticky 概念，不照抄实现）：
 * - sticky：贴底，内容增长时自动滚到底部（跟随新消息）
 * - user_scrolled：用户上翻，不跟随
 *
 * 程序化滚动（回到底部）写 lockUntil 锁窗：锁内用户 scroll 事件不推翻 sticky，
 * 避免 smooth 动画期间被误判为 user_scrolled（CC 的 scrollToBottom 同样以
 * "置 sticky + 忽略滚动反馈"处理）。锁定与相位一起管理，杜绝"锁被单独遗忘"。
 */

export type ScrollFollowPhase = 'sticky' | 'user_scrolled'

export interface ScrollFollowState {
  phase: ScrollFollowPhase
  /** 程序化滚动锁到期时间戳（performance.now ms）；锁内 scroll 事件不更新 phase */
  lockUntil: number
}

/** 距底部多少 px 内视为"贴底"（跟随新消息） */
export const STICKY_THRESHOLD_PX = 48
/** 平滑滚动锁窗 / 即时滚动锁窗（smooth 动画时长内忽略用户滚动） */
export const SMOOTH_LOCK_MS = 500
export const INSTANT_LOCK_MS = 50

export function createScrollFollowState(now = 0): ScrollFollowState {
  return { phase: 'sticky', lockUntil: now }
}

/**
 * 用户滚动事件：锁外按距底距离判定 sticky/user_scrolled。
 * 相位不变时返回原引用（组件可跳过不必要的写入）。
 */
export function onUserScroll(
  state: ScrollFollowState,
  distanceFromBottom: number,
  now: number,
): ScrollFollowState {
  if (now < state.lockUntil) return state
  const phase: ScrollFollowPhase = distanceFromBottom <= STICKY_THRESHOLD_PX ? 'sticky' : 'user_scrolled'
  return phase === state.phase ? state : { ...state, phase }
}

/**
 * 程序化滚动到底部：置 sticky + 写锁窗（smooth 动画期间不被 scroll 事件推翻）。
 * 旧的 'jumping' 相位是死状态（同步置位立即被覆盖、从未被读），随本次纯化移除。
 */
export function beginProgrammaticScroll(now: number, smooth: boolean): ScrollFollowState {
  return { phase: 'sticky', lockUntil: now + (smooth ? SMOOTH_LOCK_MS : INSTANT_LOCK_MS) }
}

/** 内容增长时是否应自动滚动（贴底） */
export function shouldAutoScroll(state: ScrollFollowState): boolean {
  return state.phase === 'sticky'
}
