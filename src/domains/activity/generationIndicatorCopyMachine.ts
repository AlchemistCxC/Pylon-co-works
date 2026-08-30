import type { GenerationLiveness } from '../workbench/generationFooterContracts.ts'

/** 主文案在同一轮生成中的最短可见时间。 */
export const DEFAULT_GENERATION_INDICATOR_MIN_DISPLAY_MS = 1_200

export type GenerationIndicatorCopyState =
  | { readonly status: 'idle'; readonly generationId?: string }
  | {
    readonly status: 'showing'
    readonly generationId: string
    readonly text: string
    readonly shownAt: number
  }
  | {
    readonly status: 'pending'
    readonly generationId: string
    /** 延迟期间仍保留在 DOM 中的旧词。 */
    readonly text: string
    /** 最短展示时间到期后要切入的新词。 */
    readonly nextText: string
    readonly shownAt: number
    readonly dueAt: number
  }

export type GenerationIndicatorCopyEvent =
  | {
    readonly type: 'start'
    readonly generationId: string
    readonly text: string
    readonly at: number
  }
  | {
    readonly type: 'liveness-change'
    readonly generationId: string
    readonly liveness: GenerationLiveness
    readonly text: string
    readonly at: number
  }
  | {
    /** 活动上下文变化只影响次级文案，不应重置主文案的计时。 */
    readonly type: 'context-change'
    readonly generationId: string
    readonly at: number
  }
  | {
    readonly type: 'preset-change'
    readonly generationId: string
    readonly text: string
    readonly at: number
  }
  | {
    readonly type: 'finish'
    readonly generationId?: string
    readonly at: number
  }
  | {
    /** 仅允许同一 generation 的定时器推进 pending 状态。 */
    readonly type: 'tick'
    readonly generationId: string
    readonly at: number
  }

const IDLE_STATE: GenerationIndicatorCopyState = Object.freeze({ status: 'idle' })

function idle(generationId?: string): GenerationIndicatorCopyState {
  return generationId
    ? Object.freeze({ status: 'idle' as const, generationId })
    : IDLE_STATE
}

function timestamp(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function displayDuration(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : DEFAULT_GENERATION_INDICATOR_MIN_DISPLAY_MS
}

function textValue(value: string): string {
  return value.trim()
}

function showing(
  generationId: string,
  text: string,
  at: number,
): GenerationIndicatorCopyState {
  return Object.freeze({
    status: 'showing' as const,
    generationId,
    text,
    shownAt: timestamp(at),
  })
}

function pending(
  generationId: string,
  visibleText: string,
  nextText: string,
  shownAt: number,
  dueAt: number,
): GenerationIndicatorCopyState {
  return Object.freeze({
    status: 'pending' as const,
    generationId,
    text: visibleText,
    nextText,
    shownAt,
    dueAt,
  })
}

function isCurrentGeneration(
  state: GenerationIndicatorCopyState,
  generationId: string,
): boolean {
  return state.generationId === generationId
}

/**
 * 从配置提供的候选词中稳定地挑选一条。随机函数只在“新回合/配置真正变化”
 * 时调用，活动阶段和时钟 tick 不会导致文案重新抽签。
 */
export function chooseGenerationIndicatorVerb(
  verbs: readonly string[],
  random: () => number = Math.random,
): string {
  const candidates = verbs.map(value => value.trim()).filter(Boolean)
  if (candidates.length === 0) return '思考中'
  const raw = random()
  const normalized = Number.isFinite(raw) ? Math.max(0, Math.min(0.999999, raw)) : 0
  return candidates[Math.floor(normalized * candidates.length)] ?? candidates[0]!
}

/** 当前状态应写入 DOM 的主文案；pending 仍显示旧词，直到 tick 到期。 */
export function generationIndicatorCopyText(state: GenerationIndicatorCopyState): string {
  return state.status === 'idle' ? '' : state.text
}

/** pending 是否需要一个定时器；由渲染层决定如何调度 tick。 */
export function generationIndicatorCopyDueAt(
  state: GenerationIndicatorCopyState,
): number | undefined {
  return state.status === 'pending' ? state.dueAt : undefined
}

function transitionToText(
  previous: GenerationIndicatorCopyState,
  generationId: string,
  text: string,
  at: number,
  immediate: boolean,
  minDisplayMs: number,
): GenerationIndicatorCopyState {
  const nextText = textValue(text)
  if (!nextText) return previous

  const now = timestamp(at)
  // 必须先经过 start；否则一个迟到的旧 liveness/preset 事件可能在 finish
  // 后把已经结束的 Footer 重新唤醒。
  if (previous.status === 'idle') return previous
  if (!isCurrentGeneration(previous, generationId)) return previous

  if (previous.status === 'pending') {
    // 抢占提示（waiting/stalled）立即显示；普通更新沿用首次显示的截止时间，
    // 不会因每次活动上下文变化而把“最短展示时间”不断往后推。
    if (immediate || now >= previous.dueAt) return showing(generationId, nextText, now)
    if (nextText === previous.text) {
      // 目标又回到当前可见词时取消 pending，但保留原 shownAt，避免
      // “A→B→A” 在短时间内重启计时或留下一个无意义的 timer。
      return showing(generationId, previous.text, previous.shownAt)
    }
    if (nextText === previous.nextText) return previous
    return pending(generationId, previous.text, nextText, previous.shownAt, previous.dueAt)
  }

  if (nextText === previous.text) return previous
  if (immediate) return showing(generationId, nextText, now)

  const dueAt = Math.max(previous.shownAt + minDisplayMs, now)
  if (now >= dueAt) return showing(generationId, nextText, now)
  return pending(generationId, previous.text, nextText, previous.shownAt, dueAt)
}

/**
 * 主文案展示状态机。
 *
 * - `start` 总是开启一个新的 generation，并立即显示其 preset；
 * - active 阶段/预设变更遵守最短展示时间；
 * - waiting/stalled 通过 liveness-change 抢占当前词；
 * - context-change 不触碰计时（次级上下文由 selector 单独渲染）；
 * - finish/tick 都带 generation 身份，旧回合的延迟回调无法清空或覆盖新回合。
 */
export function reduceGenerationIndicatorCopy(
  previous: GenerationIndicatorCopyState | undefined,
  event: GenerationIndicatorCopyEvent,
  minDisplayMs = DEFAULT_GENERATION_INDICATOR_MIN_DISPLAY_MS,
): GenerationIndicatorCopyState {
  const state = previous ?? IDLE_STATE
  const minimum = displayDuration(minDisplayMs)

  switch (event.type) {
    case 'start': {
      const text = textValue(event.text)
      return text ? showing(event.generationId, text, event.at) : idle(event.generationId)
    }
    case 'finish':
      // 没有 generationId 是兼容调用；带 id 时严格隔离旧回合。
      if (state.status === 'idle') {
        if (event.generationId !== undefined && state.generationId !== event.generationId) return state
        return state
      }
      if (event.generationId !== undefined && !isCurrentGeneration(state, event.generationId)) return state
      return idle(state.generationId)
    case 'tick':
      if (state.status !== 'pending' || state.generationId !== event.generationId) return state
      if (timestamp(event.at) < state.dueAt) return state
      return showing(state.generationId, state.nextText, event.at)
    case 'context-change':
      return state
    case 'liveness-change':
      return transitionToText(
        state,
        event.generationId,
        event.text,
        event.at,
        event.liveness === 'waiting' || event.liveness === 'stalled',
        minimum,
      )
    case 'preset-change':
      return transitionToText(state, event.generationId, event.text, event.at, false, minimum)
  }
}

export interface GenerationIndicatorCopyMachine {
  readonly getState: () => GenerationIndicatorCopyState
  readonly dispatch: (event: GenerationIndicatorCopyEvent) => GenerationIndicatorCopyState
}

/** 小型命令式外壳，供 Solid/其他渲染器持有状态；核心转移仍是纯 reducer。 */
export function createGenerationIndicatorCopyMachine(
  minDisplayMs = DEFAULT_GENERATION_INDICATOR_MIN_DISPLAY_MS,
  initial?: GenerationIndicatorCopyState,
): GenerationIndicatorCopyMachine {
  let state = initial ?? IDLE_STATE
  return {
    getState: () => state,
    dispatch(event) {
      state = reduceGenerationIndicatorCopy(state, event, minDisplayMs)
      return state
    },
  }
}
