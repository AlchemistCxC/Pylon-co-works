import type { ReactNode } from 'react'
import { useStore } from '../../store'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { toAgentContextKey } from '../../agentContext'
import ModelWidget from '../chat/ModelWidget'
import ModeWidget from '../chat/ModeWidget'
import { useChatRuntimeSnapshot } from '../chat/useChatRuntimeSnapshot'
import { resolveTaskPill } from '../../domains/activity/taskPill.ts'
import { formatCacheReadTokens, formatTokenCount } from '../../tokenFormat'
import { emptySessionLiveStats } from '../chat/sessionRuntime'
import type { SessionLiveStats } from '../chat/sessionRuntime'
import type { CcWidgetId } from '../../domains/cc/widgetCatalog.ts'
import { BUILTIN_CC_WIDGET_CONTRIBUTIONS } from '../../domains/cc/widgetCatalog.ts'
import { Bot, FolderKanban, LoaderCircle, Radio } from 'lucide-react'
import { useWorkspaceEntityStore } from '../../workspaceEntityStore.ts'

export interface CcWidgetRenderProps {
  sessionId: string | null
}

export interface CcWidgetDef {
  id: CcWidgetId
  label: string
  category: 'input' | 'status' | 'context' | 'runtime' | 'action'
  naturalSize: boolean
  render?: (props: CcWidgetRenderProps) => ReactNode
}

const EMPTY_SESSION_LIVE_STATS = emptySessionLiveStats()

function useSessionLiveStats(sessionId: string | null): SessionLiveStats {
  // I01-W2：live stats 按 AgentContextKey（agentId+source）隔离读取。
  // selector 只返回 store 内对象引用（find 结果，稳定）；派生 context 在渲染内完成——
  // 避免 selector 每次返回新对象触发 useSyncExternalStore forceStoreRerender 循环（#185）
  const session = useIdentityStore(state =>
    sessionId ? state.sessions.find(item => item.id === sessionId) : undefined,
  )
  const context = session ? { agentId: session.agentId, source: session.source } : undefined
  return useRuntimeStore(state => context
    ? (state.sessionLiveStats[toAgentContextKey(context)] ?? EMPTY_SESSION_LIVE_STATS)
    : EMPTY_SESSION_LIVE_STATS)
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
  if (ccStyle === 'ring') return (
    <span className="cc-context-ring" role="img" aria-label={`上下文 ${pct}%`} title={`上下文 ${pct}%`} style={{ '--context-ring-color': color, '--context-ring-ratio': used, fontSize: `${ccScale}%` } as React.CSSProperties}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle className="cc-context-ring-track" cx="12" cy="12" r="9" pathLength="1" />
        <circle className="cc-context-ring-value" cx="12" cy="12" r="9" pathLength="1" />
      </svg>
      <span className="cc-context-ring-label">{pct}%</span>
    </span>
  )
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
  const ekgGreen = useStore(s => s.ekgGreen)
  return <span className="pill-mono" style={{ borderLeft: 'none', padding: 0, fontSize: `${ccScale}%` }}>
    {formatTokenCount(runtime.tokensUsed)}/{formatTokenCount(runtime.tokensMax)}
    {runtime.cacheReadTokens > 0 && <span style={{ color: ekgGreen || '#34d399', marginLeft: 4 }}>{formatCacheReadTokens(runtime.cacheReadTokens)}</span>}
  </span>
}

function ModelWidgetRenderer({ sessionId }: CcWidgetRenderProps) {
  // I01-W2：传 AgentContext（agentId+source），会话配置按 context 隔离。
  // selector 只返回 store 内对象引用（find 结果，稳定）；派生 context 在渲染内完成——
  // 避免 selector 每次返回新对象触发 useSyncExternalStore forceStoreRerender 循环（#185）
  const session = useIdentityStore(s => s.sessions.find(item => item.id === sessionId))
  const context = session ? { agentId: session.agentId, source: session.source } : undefined
  return <ModelWidget context={context} />
}

function ModeWidgetRenderer() {
  // P0-04：mode widget = 全局 approval mode（set_approval_mode 无 source），不读会话
  return <ModeWidget />
}

function TasksWidgetRenderer({ sessionId }: CcWidgetRenderProps) {
  // P1-07：任务 pill（§8.2）——横向订阅读当前 source 的 plan；点击跨区桥展开 TaskTree
  const sessionSource = useIdentityStore(s => s.sessions.find(item => item.id === sessionId)?.source)
  const { tasks } = useChatRuntimeSnapshot(sessionSource || null)
  const pill = resolveTaskPill(tasks)
  if (!pill.visible) return null
  return (
    <button type="button" className="cc-tasks-pill" title="任务列表（点击展开/收起）"
      onClick={() => window.dispatchEvent(new CustomEvent('pylon:tasks-toggle'))}>
      {pill.label}
    </button>
  )
}

function SessionWidgetRenderer({ sessionId }: CcWidgetRenderProps) {
  const session = useIdentityStore(state => sessionId ? state.sessions.find(item => item.id === sessionId) : undefined)
  const agent = useIdentityStore(state => session ? state.agents.find(item => item.id === session.agentId) : undefined)
  const label = session?.name || '未选择会话'
  return (
    <span className="cc-info-chip cc-session-chip" title={session ? `${agent?.name || session.agentId} · ${session.name}` : label}>
      <Bot size={12} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

function workspaceLabel(workdir: string): string {
  const trimmed = workdir.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || '无工作目录'
}

function WorkspaceWidgetRenderer({ sessionId }: CcWidgetRenderProps) {
  const session = useIdentityStore(state => sessionId ? state.sessions.find(item => item.id === sessionId) : undefined)
  const workspace = useWorkspaceEntityStore(state => session?.workspaceId ? state.workspaces.find(item => item.id === session.workspaceId) : undefined)
  const label = workspace?.name || workspaceLabel(session?.workdir || '')
  const title = workspace?.rootPath || session?.workdir || '当前会话没有工作目录'
  return (
    <span className="cc-info-chip cc-workspace-chip" title={title}>
      <FolderKanban size={12} aria-hidden="true" />
      <span>{label}</span>
    </span>
  )
}

function ActivityWidgetRenderer({ sessionId }: CcWidgetRenderProps) {
  const session = useIdentityStore(state => sessionId ? state.sessions.find(item => item.id === sessionId) : undefined)
  const generating = useRuntimeStore(state => !!session && state.liveGeneratingSources.includes(session.source))
  const Icon = generating ? LoaderCircle : Radio
  return (
    <span className="cc-info-chip cc-activity-chip" data-running={generating ? 'true' : 'false'} role="status" aria-live="polite">
      <Icon size={12} aria-hidden="true" />
      <span>{generating ? '生成中' : session ? '就绪' : '待命'}</span>
    </span>
  )
}

const HOST_RENDERERS: Record<string, (props: CcWidgetRenderProps) => ReactNode> = {
  session: props => <SessionWidgetRenderer {...props} />,
  workspace: props => <WorkspaceWidgetRenderer {...props} />,
  activity: props => <ActivityWidgetRenderer {...props} />,
  ekg: props => <EkgWidget {...props} />,
  pct: props => <PctWidget {...props} />,
  tokens: props => <TokensWidget {...props} />,
  model: props => <ModelWidgetRenderer {...props} />,
  mode: () => <ModeWidgetRenderer />,
  tasks: props => <TasksWidgetRenderer {...props} />,
}

export const CC_WIDGET_REGISTRY: readonly CcWidgetDef[] = BUILTIN_CC_WIDGET_CONTRIBUTIONS.map(entry => ({
  id: entry.id,
  label: entry.label,
  category: entry.category,
  naturalSize: entry.naturalSize,
  // input/send/attach 由 ControlCenter 特判渲染，贡献包只声明宿主 renderer 绑定。
  ...('render' in entry && entry.render?.kind === 'host-renderer' && HOST_RENDERERS[entry.render.rendererKey]
    ? { render: HOST_RENDERERS[entry.render.rendererKey] }
    : {}),
}))
