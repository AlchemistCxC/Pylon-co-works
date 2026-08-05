import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Square } from 'lucide-react'
import { resolveSpinnerMarker } from './spinnerFrames'
import { resolveActivity, resolveFrame, resolveStallProgress } from './spinnerMachine'
import { getSpinnerAssetPreset, getSpinnerVerbPreset } from './spinnerAssets'
import { normalizeSpinnerVerbs } from './spinnerVerbs'
import SpinnerGlimmer from './SpinnerGlimmer'
import { useStore } from '../../store'
import { useMinDisplayTime } from './useMinDisplayTime'
import { resolveActivityLine } from '../../domains/activity/activityLine.ts'
import { activeTask } from '../../domains/tasks/taskSelectors.ts'
import { useChatRuntimeSnapshot } from './useChatRuntimeSnapshot'
import { nextTokenCatchUp } from './tokenCatchUp.ts'
import type { SpinnerMotionKind } from './spinnerMotion'

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

// ── P1-08 热路径叶子：高频 tick 隔离到叶子，父级不随 40-120ms tick 重渲染 ──

/** 帧动画（elapsed 由本组件持 tick 推进） */
function SpinnerFrame({ frames, baseElapsedMs, intervalMs, motion, direction, color, fontSize, running, reduceMotion }: {
  frames: string[]
  baseElapsedMs: number
  intervalMs: number
  motion: SpinnerMotionKind
  direction?: 'forward' | 'reverse' | 'alternate'
  color?: string
  fontSize: number
  running: boolean
  reduceMotion: boolean
}) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setTick(value => value + 1), Math.max(40, Math.min(1000, intervalMs || 120)))
    return () => clearInterval(id)
  }, [running, intervalMs])
  const frame = resolveFrame(frames, baseElapsedMs + tick * (intervalMs || 120), intervalMs, reduceMotion ? 'static' : motion, direction)
  return <span className="spinner-frame" style={{ color: color || undefined, fontSize: `${fontSize}px` }}>{frame.char}</span>
}

/** token 追赶计数：显示值向真实值递增，永不超过真实值（P1-08） */
function TokenCounter({ real, running }: { real: number; running: boolean }) {
  const [displayed, setDisplayed] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setDisplayed(previous => nextTokenCatchUp(previous, real)), 120)
    return () => clearInterval(id)
  }, [running, real])
  const current = Math.min(displayed, real)
  return <span>↓ {formatTokens(current)} tokens</span>
}

/** 思考已持续时长（D30，1s tick 实时增长） */
function ThinkingDuration({ startedAt, running }: { startedAt: number; running: boolean }) {
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => forceTick(value => value + 1), 1000)
    return () => clearInterval(id)
  }, [running])
  return <span>思考 {formatElapsed(Math.max(0, Date.now() - startedAt))}</span>
}

/** 生成总耗时（1s tick） */
function ElapsedTimer({ startTime, running }: { startTime: number; running: boolean }) {
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => forceTick(value => value + 1), 1000)
    return () => clearInterval(id)
  }, [running])
  return <span>{formatElapsed(Math.max(0, Date.now() - startTime))}</span>
}

/** stalled 渐变红强度（P1-08）：把 --stall-progress 传给 .term-spinner 内的子树 */
function StallProbe({ idleMsBase, running, children }: { idleMsBase: number; running: boolean; children: React.ReactNode }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setTick(value => value + 1), 120)
    return () => clearInterval(id)
  }, [running])
  const progress = resolveStallProgress(idleMsBase + tick * 120)
  return (
    <span className="spinner-stall-probe" aria-hidden="true" style={{ '--stall-progress': progress.toFixed(3) } as CSSProperties}>
      {children}
    </span>
  )
}

export default function GenerationFooter({ running, frames, tokenCount, startTime, lastTokenAt, summary, phase, source, onStop }: {
  running: boolean
  frames: string[]
  tokenCount: number
  startTime: number
  lastTokenAt?: number
  summary: GenerationSummary | null
  phase?: GenerationPhase
  source: string | null
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
  const spinnerFramePreset = useStore(s => s.spinnerFramePreset)
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  const verbPreset = getSpinnerVerbPreset(spinnerVerbSet)
  const verbs = spinnerVerbSet === 'custom'
    ? normalizeSpinnerVerbs(spinnerCustomVerbs, IDIOMS)
    : verbPreset.verbs
  const safeVerbs = verbs.length > 0 ? verbs : IDIOMS
  // safeVerbs 由 spinnerVerbSet/spinnerCustomVerbs 推导，已在 deps 覆盖（传递依赖）
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const randomVerb = useMemo(() => safeVerbs[Math.floor(Math.random() * safeVerbs.length)] || IDIOMS[0], [startTime, spinnerVerbSet, spinnerCustomVerbs])
  const frameAsset = getSpinnerAssetPreset(spinnerFramePreset)
  // P1-08：横向订阅读当前 source 的 plan 与 thinkingStart（plan activeTask 覆盖链最高优先）
  const { tasks, thinkingStart } = useChatRuntimeSnapshot(source)
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
  const now = Date.now()
  const idleMs = running && lastTokenAt ? Math.max(0, now - lastTokenAt) : running ? now - startTime : 0
  // D5/D6：activityLine 覆盖链（plan → tool → thinking/responding → 随机）
  const activeTaskContent = activeTask(tasks)?.content
  const line = resolveActivityLine({
    activeTaskContent,
    toolTitle: phase?.kind === 'tool' ? phase.name : undefined,
    phase: phase?.kind === 'tool' ? 'tool' : phase?.kind === 'thinking' ? 'thinking' : phase?.kind === 'responding' ? 'responding' : undefined,
    thinkingStart,
    now,
    fallbackVerb: randomVerb,
  })
  // CC 对齐状态机：3s stalled（渐变红）、1.2s waiting（Pylon 两级）；D29 tool 阶段抑制 stall
  const activity = line.stallSuppressed ? 'active' : resolveActivity(idleMs)
  // CC 风格（cc 动词集）：显示幽默随机动词而非阶段文案（plan activeTask 覆盖仍最高优先）
  const ccVerbs = spinnerVerbSet === 'cc'
  const verb = !running ? '' : activity === 'active'
    ? (ccVerbs && !activeTaskContent ? randomVerb : line.activity)
    : activity === 'waiting' ? '等待响应' : '仍在等待后端响应'
  const displayVerb = useMinDisplayTime(verb, 1200)

  if (running) {
    return (
      <div className="term-spinner-row">
        {/* cc 帧：不设 data-phase（帧恒 spinnerColor，颜色不随阶段跳，对齐 CC 恒色） */}
        <div className="term-spinner" data-activity={activity} data-phase={spinnerFramePreset === 'cc' ? undefined : phase?.kind || 'idle'}>
          <StallProbe idleMsBase={idleMs} running={running}>
            <SpinnerFrame frames={frames} baseElapsedMs={now - startTime} intervalMs={spinnerIntervalMs || 120}
              motion={frameAsset.motion} direction={frameAsset.direction} color={spinnerColor}
              fontSize={spinnerSize} running={running} reduceMotion={reduceMotion} />
            <SpinnerGlimmer text={displayVerb} running={running} activity={activity} reducedMotion={reduceMotion} color={spinnerColor} cycleMs={GLIMMER_CYCLE_MS} />
          </StallProbe>
          <span className="spinner-meta">(
            <ElapsedTimer startTime={startTime} running={running} />
            {phase?.kind === 'thinking' && thinkingStart != null && <><span> · </span><ThinkingDuration startedAt={thinkingStart} running={running} /></>}
            {tokenCount > 0 && <><span> · </span><TokenCounter real={tokenCount} running={running} /></>}
          )</span>
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
