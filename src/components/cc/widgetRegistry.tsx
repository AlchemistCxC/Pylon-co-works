import type { ReactNode } from 'react'
import { useStore } from '../../store'
import InputBar from '../chat/InputBar'
import ModelWidget from '../chat/ModelWidget'
import ModeWidget from '../chat/ModeWidget'
import SendWidget from '../chat/SendWidget'
import AttachWidget from '../chat/AttachWidget'
import { formatCacheReadTokens, formatTokenCount } from '../../tokenFormat'
import { emptySessionLiveStats } from '../chat/sessionRuntime'
import type { SessionLiveStats } from '../chat/sessionRuntime'
import type { CcSlot, CcWidgetId, CcWidgetPlacement } from '../../ccLayoutState'
import { resolveContextMeter } from '../../contextMeter'

export interface CcWidgetRenderProps {
  sessionId: string | null
}

export interface CcWidgetDef {
  id: CcWidgetId
  label: string
  category: 'input' | 'status' | 'context' | 'runtime' | 'action'
  defaultPlacement: CcWidgetPlacement
  naturalSize: boolean
  minWidth?: number
  minHeight?: number
  render: (props: CcWidgetRenderProps) => ReactNode
  renderPreview?: (props: CcWidgetRenderProps) => ReactNode
}

const EMPTY_SESSION_LIVE_STATS = emptySessionLiveStats()

function useSessionLiveStats(sessionId: string | null): SessionLiveStats {
  return useStore(state => {
    if (!sessionId) return EMPTY_SESSION_LIVE_STATS
    const source = state.sessions.find(session => session.id === sessionId)?.source
    return source ? (state.sessionLiveStats[source] ?? EMPTY_SESSION_LIVE_STATS) : EMPTY_SESSION_LIVE_STATS
  })
}

function EkgWidget({ sessionId }: CcWidgetRenderProps) {
  const runtime = useSessionLiveStats(sessionId)
  const tokensUsed = runtime.tokensUsed
  const tokensMax = runtime.tokensMax
  const used = Math.max(0, Math.min(1, tokensMax > 0 ? tokensUsed / tokensMax : 0))
  const pct = Math.round(used * 100)
  const barTrackColor = useStore(s => s.barTrackColor)
  const barFillColor = useStore(s => s.barFillColor)
  const barFillFollow = useStore(s => s.barFillFollow)
  const barHeight = useStore(s => s.barHeight) || 10
  const ekgGreen = useStore(s => s.ekgGreen)
  const ekgYellow = useStore(s => s.ekgYellow)
  const ekgRed = useStore(s => s.ekgRed)
  const color = used < 0.50 ? (ekgGreen || '#34d399') : used < 0.80 ? (ekgYellow || '#fbbf24') : (ekgRed || '#f87171')
  const barFill = (barFillFollow !== false) ? color : (barFillColor || color)
  const ccScale = useStore(s => (s.ccScale || {})['ekg'] ?? 100)
  const ccStyle = useStore(s => s.ccStyle) || 'bar'
  if (ccStyle === 'numeric') return <span className="ekg-pct" style={{ color, fontSize: `${ccScale}%` }}>{pct}%</span>
  if (ccStyle === 'bar') {
    return <div className="ekg-bar" style={{ '--bar-fill': `${pct}%`, '--bar-color': barFill, '--bar-track': barTrackColor || 'rgba(0,0,0,0.18)', '--bar-h': `${barHeight}px`, fontSize: `${ccScale}%` } as React.CSSProperties}>
      <div className="ekg-bar-track" /><div className="ekg-bar-fill" />
    </div>
  }
  return <svg viewBox="0 0 140 30" className="ekg-svg" preserveAspectRatio="none" style={{ fontSize: `${ccScale}%` } as React.CSSProperties}>
    <rect x={0} y={12} width={140 * (1 - used)} height={6} rx={3} fill={color} opacity={0.3} />
    <rect x={140 * (1 - used)} y={12} width={140 * used} height={6} rx={3} fill="var(--ekg-consumed,rgba(128,128,128,0.15))" />
  </svg>
}

function PctWidget({ sessionId }: CcWidgetRenderProps) {
  const runtime = useSessionLiveStats(sessionId)
  const ekgGreen = useStore(s => s.ekgGreen)
  const ekgYellow = useStore(s => s.ekgYellow)
  const ekgRed = useStore(s => s.ekgRed)
  const used = Math.max(0, Math.min(1, runtime.tokensMax > 0 ? runtime.tokensUsed / runtime.tokensMax : 0))
  const pct = Math.round(used * 100)
  const color = used < 0.50 ? (ekgGreen || '#34d399') : used < 0.80 ? (ekgYellow || '#fbbf24') : (ekgRed || '#f87171')
  const ccScale = useStore(s => (s.ccScale || {})['pct'] ?? 100)
  return <span className="ekg-pct" style={{ color, fontSize: `${ccScale}%` }}>{pct}%</span>
}

function TokensWidget({ sessionId }: CcWidgetRenderProps) {
  const runtime = useSessionLiveStats(sessionId)
  const ccScale = useStore(s => (s.ccScale || {})['tokens'] ?? 100)
  return <span className="pill-mono" style={{ borderLeft: 'none', padding: 0, fontSize: `${ccScale}%` }}>
    {formatTokenCount(runtime.tokensUsed)}/{formatTokenCount(runtime.tokensMax)}
    {runtime.cacheReadTokens > 0 && <span style={{ color: '#34d399', marginLeft: 4 }}>{formatCacheReadTokens(runtime.cacheReadTokens)}</span>}
  </span>
}

function ContextRingWidget({ sessionId }: CcWidgetRenderProps) {
  const runtime = useSessionLiveStats(sessionId)
  const ekgGreen = useStore(s => s.ekgGreen)
  const ekgYellow = useStore(s => s.ekgYellow)
  const ekgRed = useStore(s => s.ekgRed)
  const ccScale = useStore(s => (s.ccScale || {})['context-ring'] ?? 100)
  const meter = resolveContextMeter({
    used: runtime.tokensUsed,
    max: runtime.tokensMax,
    palette: { ok: ekgGreen, warning: ekgYellow, danger: ekgRed },
  })

  return (
    <span
      className="cc-context-ring"
      role="img"
      aria-label={meter.label}
      title={meter.label}
      style={{
        '--context-ring-color': meter.color,
        '--context-ring-ratio': meter.ratio,
        fontSize: `${ccScale}%`,
      } as React.CSSProperties}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="cc-context-ring-track" cx="12" cy="12" r="9" pathLength="1" />
        <circle className="cc-context-ring-value" cx="12" cy="12" r="9" pathLength="1" />
      </svg>
      <span className="cc-context-ring-label">{meter.percentage}%</span>
    </span>
  )
}

const placement = (slot: CcSlot, order: number): CcWidgetPlacement => ({ slot, order, offsetX: 0, offsetY: 0 })

export const CC_WIDGET_REGISTRY: readonly CcWidgetDef[] = [
  { id: 'input', label: '输入栏', category: 'input', defaultPlacement: placement('input', 0), naturalSize: false, render: ({ sessionId }) => <InputBar sessionId={sessionId} /> },
  { id: 'ekg', label: '用量条', category: 'context', defaultPlacement: placement('status-primary', 0), naturalSize: true, render: props => <EkgWidget {...props} /> },
  { id: 'pct', label: '百分比', category: 'context', defaultPlacement: placement('status-primary', 1), naturalSize: true, render: props => <PctWidget {...props} /> },
  { id: 'tokens', label: 'Token数', category: 'context', defaultPlacement: placement('status-primary', 2), naturalSize: true, render: props => <TokensWidget {...props} /> },
  { id: 'context-ring', label: '上下文环', category: 'context', defaultPlacement: placement('status-primary', 3), naturalSize: true, render: props => <ContextRingWidget {...props} /> },
  { id: 'model', label: '模型', category: 'runtime', defaultPlacement: placement('status-secondary', 0), naturalSize: true, render: ({ sessionId }) => {
    const session = useStore.getState().sessions.find(item => item.id === sessionId)
    return <ModelWidget sessionSource={session?.source} />
  } },
  { id: 'mode', label: '权限模式', category: 'runtime', defaultPlacement: placement('status-secondary', 1), naturalSize: true, render: ({ sessionId }) => {
    const session = useStore.getState().sessions.find(item => item.id === sessionId)
    return <ModeWidget sessionSource={session?.source} />
  } },
  { id: 'send', label: '发送按钮', category: 'action', defaultPlacement: placement('actions', 0), naturalSize: true, render: () => null },
  { id: 'attach', label: '附件按钮', category: 'action', defaultPlacement: placement('actions', 1), naturalSize: true, render: () => null },
]

export function getCcWidgetDef(id: string): CcWidgetDef | undefined {
  return CC_WIDGET_REGISTRY.find(widget => widget.id === id)
}
