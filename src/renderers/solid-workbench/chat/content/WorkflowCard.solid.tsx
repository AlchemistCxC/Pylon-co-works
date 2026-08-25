import { For, Show } from 'solid-js'
import type { RenderAppearanceSnapshot, RenderCommandPort } from '../../../../contracts/messageRenderer.ts'
import { coalesceAdjacentDisplayTextParts } from '../../../../domains/workbench/content/contentPartSchema.ts'
import type { WorkbenchActivityNode } from '../../../../domains/workbench/workbenchProjector.ts'
import { ToolContentPart } from '../ToolInvocationCard.solid.tsx'

export function SolidWorkflowActivityCard(props: {
  activity: WorkbenchActivityNode
  appearance?: RenderAppearanceSnapshot
  commands?: RenderCommandPort
}) {
  const progress = () => props.activity.progress as { completed?: number; total?: number } | undefined
  const layout = () => props.appearance?.workflowLayout === 'lanes' || props.appearance?.workflowLayout === 'list'
    ? props.appearance.workflowLayout : 'timeline'
  const connector = () => props.appearance?.workflowConnector === false ? 'none' : 'visible'
  const motion = () => props.appearance?.animateProgress === false || props.appearance?.reducedMotion === true ? 'none' : 'animate'
  const indent = () => boundedNumber(props.appearance?.indent, 0, 80, 24)
  const shouldCollapse = () => props.activity.status === 'completed' && props.appearance?.collapseCompleted !== false
  const selectedStats = () => Array.isArray(props.appearance?.stats)
    ? props.appearance.stats.filter((item): item is string => typeof item === 'string')
    : ['usage', 'tools', 'duration']
  const usageTokens = () => nonNegativeNumber(isRecord(props.activity.usage) ? props.activity.usage.totalTokens : undefined)
  const toolCount = () => nonNegativeNumber(isRecord(props.activity.metrics) ? props.activity.metrics.toolCount : undefined)
  const durationMs = () => nonNegativeNumber(isRecord(props.activity.metrics) ? props.activity.metrics.durationMs : undefined)
  const stats = () => [
    selectedStats().includes('usage') && usageTokens() !== undefined ? `${usageTokens()} tokens` : undefined,
    selectedStats().includes('tools') && toolCount() !== undefined ? `${toolCount()} tools` : undefined,
    selectedStats().includes('duration') && durationMs() !== undefined ? formatDuration(durationMs()!) : undefined,
  ].filter((item): item is string => Boolean(item))
  const output = () => coalesceAdjacentDisplayTextParts(props.activity.output ?? [])
  const resultSummary = () => isRecord(props.activity.result) && typeof props.activity.result.summary === 'string'
    ? props.activity.result.summary : undefined
  const terminationSummary = () => [
    props.activity.killed === true ? '已终止' : undefined,
    props.activity.timeout === true ? '超时' : undefined,
  ].filter(Boolean).join(' · ')
  const hasCapability = (action: string) => {
    const capabilities = props.activity.capabilities
    if (Array.isArray(capabilities)) return capabilities.includes(action) || capabilities.includes(`activity.${action}`)
    return isRecord(capabilities) && (capabilities[action] === true || capabilities[`activity.${action}`] === true)
  }
  const canToolAction = (action: string) => hasCapability(action) && props.commands?.canExecute?.('tool.action') === true
  const canCancel = () => hasCapability('cancel') && props.commands?.canExecute?.('activity.cancel') === true
    && !['completed', 'failed', 'cancelled', 'timeout', 'interrupted'].includes(props.activity.status)
  const canRetry = () => hasCapability('retry') && props.commands?.canExecute?.('activity.retry') === true
    && ['failed', 'cancelled', 'timeout', 'interrupted'].includes(props.activity.status)
  const dispatchToolAction = (action: string) => {
    void props.commands?.execute({ type: 'tool.action', targetId: props.activity.id, payload: { action } })
  }
  const dispatchActivityAction = (type: 'activity.cancel' | 'activity.retry') => {
    void props.commands?.execute({ type, targetId: props.activity.id })
  }

  return <section class="term-workflow-card"
    data-part-kind={props.activity.semanticKind ?? `activity.${props.activity.activityKind ?? 'background-task'}`}
    data-status={props.activity.status}
    data-layout={layout()}
    data-connector={connector()}
    data-motion={motion()}
    data-density={props.appearance?.density === 'compact' ? 'compact' : 'comfortable'}
    data-palette={props.appearance?.statusPalette === 'mono' ? 'mono' : 'semantic'}
    data-active={['starting', 'running'].includes(props.activity.status) ? 'true' : 'false'}
    data-depth={props.activity.depth}
    style={{ '--workflow-indent': `${indent()}px`, '--workflow-depth': `${props.activity.depth ?? 0}` }}
    role="status"
    aria-label={`工作流活动：${props.activity.title ?? props.activity.id}，${props.activity.status}`}>
    <details class="term-workflow-details" open={!shouldCollapse()}>
      <summary class="term-workflow-head">
        <span class="term-workflow-kind">{workflowKindLabel(props.activity.activityKind)}</span>
        <strong>{props.activity.title ?? props.activity.id}</strong>
        <span class="term-activity-status" data-status={props.activity.status}>{props.activity.status}</span>
        <Show when={props.activity.parentId}>{parentId => <small>parent: {parentId()}</small>}</Show>
      </summary>
      <Show when={progress()?.total !== undefined || progress()?.completed !== undefined}>
        <div class="term-workflow-stats">
          <progress aria-label={`${props.activity.title ?? props.activity.id} 进度`}
            value={nonNegativeNumber(progress()?.completed) ?? 0}
            max={nonNegativeNumber(progress()?.total) ?? 1} />
          <span>进度 {progress()?.completed ?? 0}/{progress()?.total ?? '?'}</span>
        </div>
      </Show>
      <Show when={stats().length > 0}>
        <div class="term-workflow-stats"><For each={stats()}>{stat => <span>{stat}</span>}</For></div>
      </Show>
      <Show when={terminationSummary()}>{summary => <small class="term-workflow-termination">{summary()}</small>}</Show>
      <Show when={resultSummary()}>{summary => <p class="term-workflow-result">{summary()}</p>}</Show>
      <For each={output()}>{(part, index) => <ToolContentPart part={part} appearance={props.appearance}
        commands={props.commands} class="term-workflow-result" nodeId={`${props.activity.id}:output:${index()}`} />}</For>
      <Show when={props.activity.error}>
        {error => <div class="term-workflow-error" role="alert">{error().userSummary}</div>}
      </Show>
      <Show when={props.activity.provenance?.synthetic}>
        {synthetic => <small class="term-workflow-provenance">合成生命周期：{synthetic().reason}</small>}
      </Show>
    </details>
    <div class="term-workflow-actions">
      <Show when={canToolAction('detach') && ['starting', 'running', 'paused'].includes(props.activity.status)}>
        <button type="button" class="term-file-action" onClick={() => dispatchToolAction('detach')}>分离</button>
      </Show>
      <Show when={canToolAction('reconnect') && ['failed', 'interrupted', 'timeout', 'blocked'].includes(props.activity.status)}>
        <button type="button" class="term-file-action" onClick={() => dispatchToolAction('reconnect')}>重连</button>
      </Show>
      <Show when={canCancel()}>
        <button type="button" class="term-file-action" onClick={() => dispatchActivityAction('activity.cancel')}>取消</button>
      </Show>
      <Show when={canRetry()}>
        <button type="button" class="term-file-action" onClick={() => dispatchActivityAction('activity.retry')}>重试</button>
      </Show>
    </div>
  </section>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function formatDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${Number((durationMs / 1000).toFixed(1))}s`
}

function workflowKindLabel(kind: WorkbenchActivityNode['activityKind']): string {
  switch (kind) {
    case 'workflow-phase': return '阶段'
    case 'workflow-agent': return '代理'
    case 'background-task': return '后台任务'
    default: return '工作流'
  }
}

export default SolidWorkflowActivityCard
