import { useEffect, useMemo, useState } from 'react'
import { Square } from 'lucide-react'
import { frameAt, resolveSpinnerMarker } from './spinnerFrames'
import { getSpinnerAssetPreset, getSpinnerVerbPreset } from './spinnerAssets'
import { normalizeSpinnerVerbs } from './spinnerVerbs'
import SpinnerGlimmer from './SpinnerGlimmer'
import { useStore } from '../../store'
import { useMinDisplayTime } from './useMinDisplayTime'

const IDIOMS = getSpinnerVerbPreset('zh').verbs
const GLIMMER_CYCLE_MS = 4600

export interface GenerationSummary {
  elapsedMs: number
  tokenCount: number
  completedFrame: string
  reason: 'done' | 'cancelled' | 'error'
}

function formatElapsed(elapsedMs: number) {
  const elapsed = Math.floor(elapsedMs / 1000)
  return elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`
}

function formatTokens(n: number) {
  if (n >= 1000) { const k = n / 1000; return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k` }
  return `${n}`
}

export type GenerationPhase =
  | { kind: 'thinking' }
  | { kind: 'tool'; name: string }
  | { kind: 'responding' }

export default function GenerationFooter({ running, frames, tokenCount, startTime, lastTokenAt, summary, phase, onStop }: {
  running: boolean
  frames: string[]
  tokenCount: number
  startTime: number
  lastTokenAt?: number
  summary: GenerationSummary | null
  phase?: GenerationPhase
  onStop?: () => void
}) {
  const spinnerColor = useStore(s => s.spinnerColor)
  const spinnerSize = useStore(s => s.spinnerSize)
  const spinnerVerbSet = useStore(s => s.spinnerVerbSet)
  const spinnerCustomVerbs = useStore(s => s.spinnerCustomVerbs)
  const spinnerDoneMarker = useStore(s => s.spinnerDoneMarker)
  const spinnerCancelledMarker = useStore(s => s.spinnerCancelledMarker)
  const spinnerErrorMarker = useStore(s => s.spinnerErrorMarker)
  const spinnerDoneMarkerMode = useStore(s => s.spinnerDoneMarkerMode)
  const spinnerCancelledMarkerMode = useStore(s => s.spinnerCancelledMarkerMode)
  const spinnerErrorMarkerMode = useStore(s => s.spinnerErrorMarkerMode)
  const spinnerIntervalMs = useStore(s => s.spinnerIntervalMs)
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  const verbPreset = getSpinnerVerbPreset(spinnerVerbSet)
  const verbs = spinnerVerbSet === 'custom'
    ? normalizeSpinnerVerbs(spinnerCustomVerbs, IDIOMS)
    : verbPreset.verbs
  const safeVerbs = verbs.length > 0 ? verbs : IDIOMS
  const randomVerb = useMemo(() => safeVerbs[Math.floor(Math.random() * safeVerbs.length)] || IDIOMS[0], [startTime, spinnerVerbSet, spinnerCustomVerbs])
  const frameAsset = getSpinnerAssetPreset(useStore.getState().spinnerFramePreset)
  const marker = summary
    ? resolveSpinnerMarker(
      frames,
      summary.reason === 'cancelled'
        ? spinnerCancelledMarkerMode
        : summary.reason === 'error'
          ? spinnerErrorMarkerMode
          : spinnerDoneMarkerMode,
      summary.reason === 'cancelled'
        ? spinnerCancelledMarker
        : summary.reason === 'error'
          ? spinnerErrorMarker
          : spinnerDoneMarker,
    )
    : ''
  const [, tick] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => tick(value => value + 1), Math.max(40, Math.min(1000, spinnerIntervalMs || 120)))
    return () => clearInterval(id)
  }, [running, spinnerIntervalMs])

  const now = Date.now()
  const idleMs = running && lastTokenAt ? Math.max(0, now - lastTokenAt) : running ? now - startTime : 0
  const activity = idleMs > 10000 ? 'stalled' : idleMs > 3000 ? 'waiting' : 'active'
  const tickIdx = Math.floor((now - startTime) / Math.max(40, Math.min(1000, spinnerIntervalMs || 120)))
  const phaseLabel = phase?.kind === 'thinking'
    ? '思考中'
    : phase?.kind === 'tool'
      ? `调用 ${phase.name}`
      : phase?.kind === 'responding'
        ? '正在回复'
        : null
  const verb = !running ? '' : activity === 'active'
    ? phaseLabel || randomVerb
    : activity === 'waiting' ? '等待响应' : '仍在等待后端响应'
  const displayVerb = useMinDisplayTime(verb, 1200)

  if (running) {
    const elapsedMs = now - startTime
    const parts = [formatElapsed(elapsedMs)]
    if (tokenCount > 0) parts.push(`↓ ${formatTokens(tokenCount)} tokens`)
    return (
      <div className="term-spinner-row">
        <div className="term-spinner" data-activity={activity} data-phase={phase?.kind || 'idle'}>
          <span className="spinner-frame" style={{ color: spinnerColor || undefined, fontSize: `${spinnerSize}px` }}>{frameAt(frames, elapsedMs, spinnerIntervalMs, reduceMotion ? 'static' : frameAsset.motion, frameAsset.direction)}</span>
          <SpinnerGlimmer text={displayVerb} elapsedMs={elapsedMs} activity={activity} reducedMotion={reduceMotion} color={spinnerColor} cycleMs={GLIMMER_CYCLE_MS} />
          <span className="spinner-meta">({parts.join(' · ')})</span>
          {activity !== 'active' && <span className="spinner-activity" aria-live="polite">…</span>}
        </div>
        {onStop && <button className="spinner-stop-btn" title="停止生成 (Esc / Ctrl+C)" onClick={onStop}>
          <Square size={11} /> 停止
        </button>}
      </div>
    )
  }

  if (!summary) return null
  return (
    <div className={`term-summary term-summary-${summary.reason}`}>
      <span className="term-summary-frame" style={{ fontSize: `${spinnerSize}px` }}>
        {marker}
      </span>
      <span>{summary.reason === 'cancelled' ? '已停止' : summary.reason === 'error' ? '处理失败' : '处理耗时'} {formatElapsed(summary.elapsedMs)}</span>
    </div>
  )
}
