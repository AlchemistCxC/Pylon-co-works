import type { SpinnerAppearanceSnapshot } from '../appearance/appearance.ts'
import type { PromptFailureMetadata } from '../../infrastructure/acp/chatContracts.ts'

export type GenerationPhase =
  | { kind: 'thinking' }
  | { kind: 'tool'; name: string }
  | { kind: 'responding' }

/** 生成器对后端活性的三档判断；活动轴与主文案状态机共享此类型。 */
export type GenerationLiveness = 'active' | 'waiting' | 'stalled'

/**
 * 生成期间的活动上下文。
 *
 * `GenerationPhase` 是旧的单值兼容投影；这里不把工具、阶段和文案
 * 混在一起。工具可同时存在，Footer 再根据本快照选择要展示的上下文。
 */
export type GenerationActivityKind = 'thinking' | 'tooling' | 'responding'

export interface GenerationToolActivity {
  readonly id: string
  readonly name: string
  readonly startedAt?: number
}

export interface GenerationActivitySnapshot {
  readonly kind: GenerationActivityKind
  readonly activeTools: readonly GenerationToolActivity[]
  /** 工具全部结束后应恢复的非工具活动。 */
  readonly resumeKind?: Exclude<GenerationActivityKind, 'tooling'>
}

export interface GenerationSummary {
  elapsedMs: number
  tokenCount: number
  completedFrame: string
  reason: 'done' | 'cancelled' | 'error'
  failure?: PromptFailureMetadata
  /** #442 Step1 增补 'turn-boundary'：后端权威 turnBoundary 两端推导的耗时。 */
  durationSource?: 'live-monotonic' | 'canonical-events' | 'turn-boundary' | 'provider' | 'unknown'
  durationAvailable?: boolean
  /**
   * Display-only restore: the summary was synthesized from the canonical
   * journal after a bind/refresh instead of being observed live. It must not
   * synthesize a terminal fence, or a later controller-driven generation
   * cannot restart the indicator without a turn-epoch advance.
   */
  displayOnly?: boolean
}

export interface GenerationFooterInput {
  running: boolean
  /**
   * Stable owner/session identity for the mounted footer.  A footer can stay
   * mounted while the host switches between two already-running sessions;
   * this key lets the renderer open a fresh local generation in that case
   * without treating every projected startTime write as a new turn.
   */
  generationKey?: string
  /**
   * #390：宿主持有的**回合身份**（runtime 快照的 `turnEpoch`，进程内单调、不落 wire）。
   * 每个真实回合恰好 +1（发送入口的乐观投影与 live user 起手各推进一次）。
   *
   * 渲染层此前自己铸号（`generation-N`）来判断「这是不是新回合」，与宿主对"回合"的
   * 认知可能漂移——一次多算的边沿会让最短展示计时重开、预设词重抽，用户看到的就是
   * 「状态混乱」。改为以宿主身份为准；`turnEpoch` 缺失时（预览/无主机的夹具）退回
   * 原有的 running 边沿判断。
   */
  turnId?: number
  tokenCount: number
  startTime: number
  lastTokenAt?: number
  summary: GenerationSummary | null
  phase?: GenerationPhase
  /** 新的活动上下文；缺失时由 Footer 从旧 phase 推导。 */
  activity?: GenerationActivitySnapshot
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
