import { For, Show, createEffect, createMemo, createSignal, type JSX } from 'solid-js'
import type { PlanContentPayload, PlanEntryV2 } from '../../../../domains/workbench/plan/goalModel.ts'
import { selectPlanProgress } from '../../../../domains/workbench/plan/goalModel.ts'
import { SolidCollapsibleRegion } from '../CollapsibleRegion.solid.tsx'
import { SolidGoalCard } from '../GoalCard.solid.tsx'

export interface SolidPlanAppearance {
  foreground: string
  mutedForeground: string
  background: string
  borderColor: string
  pendingColor: string
  activeColor: string
  completedColor: string
  cancelledColor: string
  blockedColor: string
  unknownColor: string
  nodeGlyph: 'status' | 'dot' | 'none'
  connectorStyle: 'solid' | 'dashed' | 'none'
  connectorColor: string
  connectorWidth: number
  indent: number
  defaultExpanded: boolean
  collapseCompleted: boolean
  showPriority: boolean
  showBudget: boolean
  density: 'compact' | 'comfortable'
  reducedMotion: boolean
}

export interface SolidPlanGoalContentProps {
  payload: PlanContentPayload
  appearance?: Partial<SolidPlanAppearance>
}

const DEFAULT_APPEARANCE: SolidPlanAppearance = Object.freeze({
  foreground: 'var(--text)', mutedForeground: 'var(--text-dim)', background: 'transparent', borderColor: 'var(--border)',
  pendingColor: 'var(--text-dim)', activeColor: 'var(--accent)', completedColor: 'var(--tool-ok, var(--accent))',
  cancelledColor: 'var(--danger, #e5484d)', blockedColor: 'var(--warning, #d29922)', unknownColor: 'var(--text-dim)',
  nodeGlyph: 'status', connectorStyle: 'solid', connectorColor: 'var(--border)', connectorWidth: 1, indent: 20,
  defaultExpanded: false, collapseCompleted: true, showPriority: true, showBudget: true, density: 'comfortable',
  reducedMotion: false,
})

export function SolidPlanGoalContent(props: SolidPlanGoalContentProps) {
  const appearance = createMemo<SolidPlanAppearance>(() => ({ ...DEFAULT_APPEARANCE, ...props.appearance }))
  const configuredExpanded = createMemo(() => appearance().defaultExpanded)
  const configuredCollapseCompleted = createMemo(() => appearance().collapseCompleted)
  const [expanded, setExpanded] = createSignal(configuredExpanded())
  const [completedVisible, setCompletedVisible] = createSignal(!configuredCollapseCompleted())
  createEffect(() => setExpanded(configuredExpanded()))
  createEffect(() => setCompletedVisible(!configuredCollapseCompleted()))

  const progress = createMemo(() => selectPlanProgress(props.payload.entries))
  const completedCount = () => progress().completed
  const visibleEntries = createMemo(() => completedVisible()
    ? props.payload.entries
    : props.payload.entries.filter(entry => entry.status !== 'completed'))
  const style = (): JSX.CSSProperties => ({
    color: appearance().foreground,
    background: appearance().background,
    'border-color': appearance().borderColor,
    '--plan-connector-color': appearance().connectorColor,
    '--plan-connector-width': `${appearance().connectorWidth}px`,
    '--plan-indent': `${appearance().indent}px`,
  })

  return (
    <Show when={props.payload.entries.length > 0 || props.payload.goal !== undefined}>
      <section
        class="plan-goal-content"
        aria-label="计划与目标"
        data-density={appearance().density}
        data-connector-style={appearance().connectorStyle}
        data-node-glyph={appearance().nodeGlyph}
        data-reduced-motion={appearance().reducedMotion ? 'true' : 'false'}
        style={style()}
      >
        <SolidGoalCard
          goal={props.payload.goal}
          reducedMotion={appearance().reducedMotion}
          showBudget={appearance().showBudget}
          foreground={appearance().foreground}
          mutedForeground={appearance().mutedForeground}
          borderColor={appearance().borderColor}
          background={appearance().background}
        />
        <Show when={props.payload.entries.length > 0}>
          <div class="task-tree" data-expanded={expanded()} data-count={props.payload.entries.length}>
            <button type="button" class="task-tree-summary" onClick={() => setExpanded(value => !value)} aria-expanded={expanded()}>
              {planSummary(progress())}
            </button>
            <SolidCollapsibleRegion open={expanded()}>
              <ul class="task-tree-list" role="tree" aria-label="任务列表">
                <For each={visibleEntries()}>{entry => <PlanTreeItem entry={entry} appearance={appearance()} />}</For>
              </ul>
              <Show when={!completedVisible() && completedCount() > 0}>
                <button type="button" class="task-tree-completed-toggle" onClick={() => setCompletedVisible(true)}>
                  显示 {completedCount()} 个已完成任务
                </button>
              </Show>
            </SolidCollapsibleRegion>
          </div>
        </Show>
      </section>
    </Show>
  )
}

function PlanTreeItem(props: { entry: PlanEntryV2; appearance: SolidPlanAppearance }) {
  const entry = () => props.entry
  const display = () => entry().status === 'in_progress' && entry().activeForm ? entry().activeForm! : entry().content
  const status = () => entry().status === 'unknown' && entry().rawStatus
    ? `未知状态 ${entry().rawStatus}`
    : statusLabel(entry().status)
  const aria = () => [display(), status(), props.appearance.showPriority && entry().priority !== undefined ? `优先级 ${entry().priority}` : undefined]
    .filter(Boolean).join('，')
  const color = () => statusColor(entry().status, props.appearance)
  return (
    <li
      class="task-tree-item"
      role="treeitem"
      aria-label={aria()}
      aria-current={entry().status === 'in_progress' ? 'step' : undefined}
      data-status={entry().status}
      style={{ '--plan-status-color': color() }}
    >
      <Show when={props.appearance.nodeGlyph !== 'none'}>
        <span class="task-tree-status" aria-hidden="true">
          {props.appearance.nodeGlyph === 'dot' ? '•' : statusGlyph(entry().status)}
        </span>
      </Show>
      <span class="task-tree-content">
        <span>{display()}</span>
        <Show when={display() !== entry().content}><small>{entry().content}</small></Show>
        <Show when={entry().status === 'blocked' && entry().blockedReason}><small>{entry().blockedReason}</small></Show>
        <Show when={entry().status === 'unknown' && entry().rawStatus}><small>{entry().rawStatus}</small></Show>
      </span>
      <Show when={props.appearance.showPriority && entry().priority !== undefined}>
        <span class="task-tree-priority">P{entry().priority}</span>
      </Show>
      <Show when={entry().metadata !== undefined}>
        <details class="task-tree-metadata"><summary>未知字段</summary><pre>{JSON.stringify(entry().metadata, null, 2)}</pre></details>
      </Show>
    </li>
  )
}

function planSummary(progress: ReturnType<typeof selectPlanProgress>): string {
  const parts = [`⇅ ${progress.total} 任务`]
  if (progress.completed > 0) parts.push(`${progress.completed} 完成`)
  if (progress.active > 0) parts.push(`${progress.active} 进行中`)
  if (progress.blocked > 0) parts.push(`${progress.blocked} 阻塞`)
  if (progress.cancelled > 0) parts.push(`${progress.cancelled} 取消`)
  return parts.join(' · ')
}

function statusLabel(status: PlanEntryV2['status']): string {
  switch (status) {
    case 'pending': return '待处理'
    case 'in_progress': return '进行中'
    case 'completed': return '已完成'
    case 'cancelled': return '已取消'
    case 'blocked': return '已阻塞'
    default: return '未知状态'
  }
}

function statusGlyph(status: PlanEntryV2['status']): string {
  switch (status) {
    case 'in_progress': return '◐'
    case 'completed': return '✓'
    case 'cancelled': return '✕'
    case 'blocked': return '!'
    case 'unknown': return '?'
    default: return '○'
  }
}

function statusColor(status: PlanEntryV2['status'], appearance: SolidPlanAppearance): string {
  switch (status) {
    case 'in_progress': return appearance.activeColor
    case 'completed': return appearance.completedColor
    case 'cancelled': return appearance.cancelledColor
    case 'blocked': return appearance.blockedColor
    case 'unknown': return appearance.unknownColor
    default: return appearance.pendingColor
  }
}
