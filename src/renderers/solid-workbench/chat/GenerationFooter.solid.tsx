import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js'
import { resolveActivityLine } from '../../../domains/activity/activityLine.ts'
import { resolveSpinnerMarker } from '../../../components/chat/spinnerFrames.ts'
import { glimmerIntensity, resolveActivity, resolveFrame, resolveGlimmer, resolveStallProgress } from '../../../components/chat/spinnerMachine.ts'
import { nextTokenCatchUp } from '../../../components/chat/tokenCatchUp.ts'
import { segmentGraphemes } from '../../../utils/textWidth.ts'
import {
  browserWorkbenchClock,
  type GenerationFooterInput,
  type GenerationFooterLifecycle,
  type WorkbenchClock,
} from '../../../domains/workbench/generationFooterContracts.ts'

const GLIMMER_CYCLE_MS = 4600
const HOT_TICK_MS = 120
const SLOW_TICK_MS = 1000
const MIN_VERB_DISPLAY_MS = 1200

export interface SolidGenerationFooterProps extends GenerationFooterInput {
  clock?: WorkbenchClock
  random?: () => number
  onLifecycleReady?: (lifecycle: GenerationFooterLifecycle) => void
}

export function SolidGenerationFooter(props: SolidGenerationFooterProps) {
  const clock = () => props.clock ?? browserWorkbenchClock
  const [now, setNow] = createSignal(clock().now())
  const [displayedTokens, setDisplayedTokens] = createSignal(0)
  const [displayedVerb, setDisplayedVerb] = createSignal('')
  const [paused, setPaused] = createSignal(false)
  let hotTimer: unknown | null = null
  let slowTimer: unknown | null = null
  let verbTimer: unknown | null = null
  let destroyed = false
  let lastVerbShownAt = 0

  const clearHotTimer = () => {
    if (hotTimer !== null) clock().clearInterval(hotTimer)
    hotTimer = null
  }
  const clearSlowTimer = () => {
    if (slowTimer !== null) clock().clearInterval(slowTimer)
    slowTimer = null
  }
  const clearVerbTimer = () => {
    if (verbTimer !== null) clock().clearTimeout(verbTimer)
    verbTimer = null
  }
  const syncTimers = () => {
    clearHotTimer()
    clearSlowTimer()
    if (destroyed || paused() || !props.running) return
    hotTimer = clock().setInterval(() => {
      setNow(clock().now())
      setDisplayedTokens(previous => nextTokenCatchUp(previous, props.tokenCount))
    }, Math.max(40, Math.min(1000, props.appearance.intervalMs || HOT_TICK_MS)))
    slowTimer = clock().setInterval(() => setNow(clock().now()), SLOW_TICK_MS)
  }

  const lifecycle: GenerationFooterLifecycle = {
    pause() {
      if (destroyed || paused()) return
      setPaused(true)
      clearHotTimer()
      clearSlowTimer()
      clearVerbTimer()
    },
    resume() {
      if (destroyed || !paused()) return
      setPaused(false)
      setNow(clock().now())
      syncTimers()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      clearHotTimer()
      clearSlowTimer()
      clearVerbTimer()
    },
  }

  onMount(() => {
    setNow(clock().now())
    syncTimers()
    props.onLifecycleReady?.(lifecycle)
  })
  onCleanup(() => lifecycle.destroy())

  createEffect(() => {
    const timerInputs = [props.running, props.appearance.intervalMs, paused()] as const
    if (timerInputs.length > 0) syncTimers()
  })

  createEffect(() => {
    const real = Math.max(0, props.tokenCount)
    if (!props.running) setDisplayedTokens(real)
    else if (displayedTokens() > real) setDisplayedTokens(real)
  })

  const fallbackVerb = createMemo(() => {
    const verbs = props.appearance.verbs.length > 0 ? props.appearance.verbs : ['思考中']
    const randomValue = Math.max(0, Math.min(0.999999, (props.random ?? Math.random)()))
    return verbs[Math.floor(randomValue * verbs.length)] ?? verbs[0]!
  })
  const idleMs = () => props.running
    ? Math.max(0, now() - (props.lastTokenAt ?? props.startTime))
    : 0
  const line = createMemo(() => resolveActivityLine({
    activeTaskContent: props.activeTaskContent,
    toolTitle: props.phase?.kind === 'tool' ? props.phase.name : undefined,
    phase: props.phase?.kind,
    thinkingStart: props.thinkingStart,
    now: now(),
    fallbackVerb: fallbackVerb(),
  }))
  const activity = () => line().stallSuppressed ? 'active' : resolveActivity(idleMs())
  const desiredVerb = () => {
    if (!props.running) return ''
    if (activity() === 'waiting') return '等待响应'
    if (activity() === 'stalled') return '仍在等待后端响应'
    return props.appearance.verbSet === 'cc' && !props.activeTaskContent
      ? fallbackVerb()
      : line().activity
  }

  createEffect(() => {
    const next = desiredVerb()
    clearVerbTimer()
    const elapsed = clock().now() - lastVerbShownAt
    if (!displayedVerb() || elapsed >= MIN_VERB_DISPLAY_MS) {
      lastVerbShownAt = clock().now()
      setDisplayedVerb(next)
      return
    }
    verbTimer = clock().setTimeout(() => {
      lastVerbShownAt = clock().now()
      setDisplayedVerb(next)
      verbTimer = null
    }, MIN_VERB_DISPLAY_MS - elapsed)
  })

  const elapsedMs = () => Math.max(0, now() - props.startTime)
  const frame = () => resolveFrame(
    [...props.appearance.frames],
    elapsedMs(),
    props.appearance.intervalMs,
    props.reducedMotion ? 'static' : props.appearance.motion,
    props.appearance.direction,
  ).char
  const stallProgress = () => resolveStallProgress(idleMs())
  const shownTokens = () => Math.min(displayedTokens(), Math.max(0, props.tokenCount))
  const summaryMarker = () => props.summary
    ? resolveSpinnerMarker(
      [...props.appearance.frames],
      props.summary.reason === 'cancelled'
        ? props.appearance.cancelledMarkerMode
        : props.summary.reason === 'error'
          ? props.appearance.errorMarkerMode
          : props.appearance.doneMarkerMode,
      props.summary.reason === 'cancelled'
        ? props.appearance.cancelledMarker
        : props.summary.reason === 'error'
          ? props.appearance.errorMarker
          : props.appearance.doneMarker,
    )
    : ''

  return (
    <Show when={props.running} fallback={<GenerationSummaryView input={props} marker={summaryMarker()} />}>
      <div class="term-spinner-row">
        <div
          class="term-spinner"
          data-activity={activity()}
          data-phase={props.appearance.framePreset === 'cc' ? undefined : props.phase?.kind || 'idle'}
          style={{ '--stall-progress': stallProgress().toFixed(3) }}
        >
          <span class="spinner-frame" style={{ color: props.appearance.color || undefined, 'font-size': `${props.appearance.size}px` }}>
            {frame()}
          </span>
          <SolidSpinnerGlimmer
            text={displayedVerb()}
            elapsedMs={elapsedMs()}
            active={activity() === 'active'}
            reducedMotion={props.reducedMotion === true}
            color={props.appearance.color}
          />
          <span class="spinner-meta">(
            <span>{formatElapsed(elapsedMs())}</span>
            <Show when={props.phase?.kind === 'thinking' && props.thinkingStart != null}>
              <span> · </span><span>思考 {formatElapsed(Math.max(0, now() - (props.thinkingStart ?? now())))}</span>
            </Show>
            <Show when={props.tokenCount > 0}>
              <span> · </span><span>↓ {formatTokens(shownTokens())} tokens</span>
            </Show>
          )</span>
          <Show when={activity() !== 'active'}><span class="spinner-activity" aria-live="polite">…</span></Show>
        </div>
        <Show when={props.onStop}>
          {onStop => <button class="spinner-stop-btn" type="button" title="停止生成 (Esc / Ctrl+C)" onClick={onStop()}>
            <span aria-hidden="true">■</span> 停止
          </button>}
        </Show>
      </div>
    </Show>
  )
}

function SolidSpinnerGlimmer(props: {
  text: string
  elapsedMs: number
  active: boolean
  reducedMotion: boolean
  color?: string
}) {
  const graphemes = () => segmentGraphemes(props.text)
  const activeIndex = () => props.reducedMotion || !props.active || graphemes().length === 0
    ? -1
    : resolveGlimmer(props.text, props.elapsedMs, GLIMMER_CYCLE_MS).glimmerIndex
  return (
    <span
      class="spinner-verb"
      data-glimmer-active={activeIndex() >= 0 ? 'true' : 'false'}
      style={{ '--spinner-glimmer-color': props.color || undefined }}
    >
      <For each={graphemes()}>{(grapheme, index) => {
        const intensity = () => glimmerIntensity(index(), activeIndex())
        const className = () => intensity() === 2
          ? 'spinner-glimmer spinner-glimmer-core'
          : intensity() === 1
            ? 'spinner-glimmer spinner-glimmer-edge'
            : undefined
        return <span class={className()}>{grapheme}</span>
      }}</For>
    </span>
  )
}

function GenerationSummaryView(props: { input: GenerationFooterInput; marker: string }) {
  return (
    <Show when={props.input.summary}>
      {summary => (
        <div class={`term-summary term-summary-${summary().reason}`}>
          <span class="term-summary-frame" style={{ 'font-size': `${props.input.appearance.size}px` }}>{props.marker}</span>
          <span>
            {summary().reason === 'cancelled' ? '已停止' : summary().reason === 'error' ? '处理失败' : '处理耗时'} {formatElapsed(summary().elapsedMs)}
          </span>
        </div>
      )}
    </Show>
  )
}

export function formatElapsed(elapsedMs: number): string {
  const elapsed = Math.floor(Math.max(0, elapsedMs) / 1000)
  return elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`
}

export function formatTokens(value: number): string {
  const n = Math.max(0, value)
  if (n >= 1000) {
    const thousands = n / 1000
    return thousands >= 10 ? `${Math.round(thousands)}k` : `${thousands.toFixed(1)}k`
  }
  return `${Math.floor(n)}`
}
