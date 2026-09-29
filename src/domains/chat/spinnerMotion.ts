export type SpinnerMotionKind = 'cycle' | 'bounce' | 'ping-pong' | 'pulse' | 'static'

function clampInterval(intervalMs: number): number {
  return Math.max(40, Math.min(1000, Number.isFinite(intervalMs) ? intervalMs : 120))
}

export interface FrameIndexOptions {
  frameCount: number
  elapsedMs: number
  intervalMs: number
  motion: SpinnerMotionKind
  direction?: 'forward' | 'reverse' | 'alternate'
}

export function resolveFrameIndex({ frameCount, elapsedMs, intervalMs, motion, direction = 'forward' }: FrameIndexOptions): number {
  if (frameCount <= 0) return 0
  if (motion === 'static' || motion === 'pulse') return 0

  const step = Math.floor(Math.max(0, elapsedMs) / clampInterval(intervalMs))
  const reverse = direction === 'reverse' || (direction === 'alternate' && step % 2 === 1)
  const indexInCycle = motion === 'bounce' || motion === 'ping-pong'
    ? step % Math.max(1, frameCount * 2 - 2)
    : step % frameCount
  const index = motion === 'bounce' || motion === 'ping-pong'
    ? indexInCycle >= frameCount ? frameCount * 2 - 2 - indexInCycle : indexInCycle
    : indexInCycle
  return reverse ? frameCount - 1 - index : index
}
