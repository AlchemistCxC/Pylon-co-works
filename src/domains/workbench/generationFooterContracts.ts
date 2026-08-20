import type { SpinnerAppearanceSnapshot } from './appearance.ts'

export type GenerationPhase =
  | { kind: 'thinking' }
  | { kind: 'tool'; name: string }
  | { kind: 'responding' }

export interface GenerationSummary {
  elapsedMs: number
  tokenCount: number
  completedFrame: string
  reason: 'done' | 'cancelled' | 'error'
}

export interface GenerationFooterInput {
  running: boolean
  tokenCount: number
  startTime: number
  lastTokenAt?: number
  summary: GenerationSummary | null
  phase?: GenerationPhase
  thinkingStart?: number
  activeTaskContent?: string
  appearance: SpinnerAppearanceSnapshot
  reducedMotion?: boolean
  onStop?: () => void
}

export interface WorkbenchClock {
  now(): number
  setInterval(callback: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface GenerationFooterLifecycle {
  pause(): void
  resume(): void
  destroy(): void
}

export const browserWorkbenchClock: WorkbenchClock = {
  now: () => Date.now(),
  setInterval: (callback, intervalMs) => window.setInterval(callback, intervalMs),
  clearInterval: handle => window.clearInterval(handle as number),
  setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimeout: handle => window.clearTimeout(handle as number),
}
