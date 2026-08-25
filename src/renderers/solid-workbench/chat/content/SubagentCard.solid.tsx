import { For, Show } from 'solid-js'
import { stripAnsiControlSequences } from '../../../../domains/rendererContent/textContentContracts.ts'
import type { ContentPart, UnknownContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'
import type { RenderAppearanceSnapshot, RenderCommandPort, RenderSemanticCommand } from '../../../../contracts/messageRenderer.ts'
import { SolidLogBlock, SolidTerminalBlock } from './TerminalBlock.solid.tsx'
import type { WorkbenchActivityNode } from '../../../../domains/workbench/workbenchProjector.ts'

/**
 * C09：子代理/委派/团队活动卡（Solid）。
 *
 * 卡面规则：
 * - 层级只来自 identity 边（parentId/depth），缺失稳定降级为平铺卡，不从文本猜层级；
 * - rich 字段（role/model/provider/goal/usage/files/capabilities）全部来自 normalized 节点列；
 * - cancel/retry 动作仅 capability 允许时显示，经 command port；synthetic provenance 可见；
 * - parts 内嵌 terminal/log 复用 C07 渲染层。
 */

export function SolidSubagentCard(props: {
  activity: WorkbenchActivityNode
  appearance?: RenderAppearanceSnapshot
  commands?: RenderCommandPort
}) {
  const depth = () => typeof props.activity.depth === 'number' && Number.isFinite(props.activity.depth)
    ? Math.max(0, Math.floor(props.activity.depth))
    : 0
  const showIdentity = () => props.appearance?.showIdentity !== false
  const compact = () => props.appearance?.density === 'compact' ? 'compact' : 'comfortable'
  const viewMode = () => props.appearance?.viewMode === 'cards' ? 'cards' : 'tree'
  const treeLineStyle = () => props.appearance?.treeLineStyle === 'dashed' || props.appearance?.treeLineStyle === 'none'
    ? props.appearance.treeLineStyle : 'solid'
  const cardWidth = () => boundedNumber(props.appearance?.cardWidth, 240, 1600, 960)
  const indent = () => boundedNumber(props.appearance?.indent, 0, 80, 24)
  const treeLineColor = () => nonEmptyString(props.appearance?.treeLineColor) ?? 'var(--accent)'
  const marker = () => props.appearance?.identityMarker === 'none' ? undefined
    : props.appearance?.identityMarker === 'avatar' ? (props.activity.role ?? props.activity.title ?? props.activity.id).slice(0, 1).toUpperCase()
      : props.activity.activityKind === 'team' ? '◆' : props.activity.activityKind === 'delegation' ? '↗' : '◇'
  const showAggregate = () => props.appearance?.showAggregate !== false
  const defaultExpandedDepth = () => Math.floor(boundedNumber(props.appearance?.defaultExpandedDepth, 0, 12, 2))

  // C09 声明设置：stats multiselect（缺省/非法值时全部启用，与 kind default 对齐）
  const statsEnabled = (key: string) => {
    const value = props.appearance?.stats
    if (!Array.isArray(value)) return true
    return value.includes(key)
  }
  const parts = () => Array.isArray(props.activity.parts)
    ? props.activity.parts.filter((part): part is ContentPart => typeof part === 'object' && part !== null
      && !Array.isArray(part) && typeof (part as Record<string, unknown>).kind === 'string')
    : []

  const usage = () => props.activity.usage as { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined
  const fileSummary = () => {
    const files = props.activity.files
    if (Array.isArray(files)) {
      const count = files.filter(file => typeof file === 'string').length
      return count > 0 ? `${count} 个文件` : ''
    }
    if (!isRecord(files)) return ''
    return ([['read', '读取'], ['written', '写入'], ['touched', '触及']] as const)
      .map(([key, label]) => Array.isArray(files[key])
        ? `${label} ${(files[key] as unknown[]).filter(file => typeof file === 'string').length}` : undefined)
      .filter(Boolean).join(' · ')
  }
  const progress = () => props.activity.progress as { completed?: number; total?: number } | undefined
  const progressCompleted = () => nonNegativeNumber(progress()?.completed) ?? 0
  const progressTotal = () => Math.max(1, nonNegativeNumber(progress()?.total) ?? 1)
  const metricsSummary = () => {
    const metrics = isRecord(props.activity.metrics) ? props.activity.metrics : undefined
    const toolCount = finiteNumber(metrics?.toolCount)
      ?? (Array.isArray(props.activity.tools) ? props.activity.tools.length : undefined)
    const taskCount = finiteNumber(metrics?.taskCount)
      ?? (Array.isArray(props.activity.tasks) ? props.activity.tasks.length : undefined)
    return [
      toolCount !== undefined ? `${toolCount} tools` : undefined,
      taskCount !== undefined ? `${taskCount} tasks` : undefined,
      finiteNumber(metrics?.durationMs) !== undefined ? `${metrics?.durationMs} ms` : undefined,
      finiteNumber(metrics?.costUsd) !== undefined ? `$${metrics?.costUsd}` : undefined,
    ].filter(Boolean).join(' · ')
  }
  const executionSummary = () => {
    if (!isRecord(props.activity.execution)) return ''
    const execution = props.activity.execution
    return [
      nonEmptyString(execution.mode),
      execution.background === true ? 'background' : undefined,
      nonEmptyString(execution.worktree) ? `worktree ${execution.worktree}` : undefined,
      nonEmptyString(execution.team) ? `team ${execution.team}` : undefined,
    ].filter(Boolean).join(' · ')
  }
  const resultSummary = () => isRecord(props.activity.result) ? nonEmptyString(props.activity.result.summary) : undefined
  const hasActivityCapability = (action: string) => {
    const capabilities = props.activity.capabilities
    if (Array.isArray(capabilities)) return capabilities.includes(action) || capabilities.includes(`activity.${action}`)
    return isRecord(capabilities) && (capabilities[action] === true || capabilities[`activity.${action}`] === true)
  }

  const canCancel = () => hasActivityCapability('cancel') && props.commands?.canExecute?.('activity.cancel') === true
  const canRetry = () => hasActivityCapability('retry') && props.commands?.canExecute?.('activity.retry') === true
  const canToolAction = (action: string) => hasActivityCapability(action) && props.commands?.canExecute?.('tool.action') === true
  const dispatch = (type: string) => {
    const command: RenderSemanticCommand = { type, targetId: props.activity.id }
    void props.commands?.execute(command)
  }
  const dispatchToolAction = (action: string) => {
    void props.commands?.execute({ type: 'tool.action', targetId: props.activity.id, payload: { action } })
  }

  return (
    <section
      class="term-subagent-card"
      data-part-kind={props.activity.semanticKind ?? `activity.${props.activity.activityKind ?? 'subagent'}`}
      data-status={props.activity.status}
      data-palette={props.appearance?.statusPalette === 'mono' ? 'mono' : 'semantic'}
      data-depth={depth()}
      data-view-mode={viewMode()}
      data-tree-line={treeLineStyle()}
      style={{
        '--subagent-depth': String(depth()),
        '--subagent-card-width': `${cardWidth()}px`,
        '--subagent-indent': `${indent()}px`,
        '--subagent-tree-color': treeLineColor(),
        'max-width': `${cardWidth()}px`,
      }}
      data-density={compact()}
      data-reduced-motion={props.appearance?.reducedMotion === true ? 'true' : 'false'}
      data-active={['starting', 'running'].includes(props.activity.status) ? 'true' : 'false'}
      tabIndex={0}
      onKeyDown={handleActivityCardKeyDown}
      role="status"
      aria-label={`子代理：${props.activity.title ?? props.activity.id}，${props.activity.status}`}
    >
      <header class="term-subagent-head">
        <Show when={marker()}>{value => <span class="term-subagent-marker" aria-hidden="true">{value()}</span>}</Show>
        <span class="term-subagent-kind">{subagentKindLabel(props.activity.activityKind)}</span>
        <strong class="term-subagent-title">{props.activity.title ?? props.activity.id}</strong>
        <span class="term-activity-status" data-status={props.activity.status}>{props.activity.status}</span>
        <Show when={showIdentity() && props.activity.role}>
          <span class="term-subagent-meta">{props.activity.role}</span>
        </Show>
        <Show when={showIdentity() && (props.activity.model || props.activity.provider)}>
          <span class="term-subagent-meta">{[props.activity.model, props.activity.provider].filter(Boolean).join(' · ')}</span>
        </Show>
        <Show when={showIdentity() && props.activity.parentId}>
          <span class="term-subagent-meta">parent: {props.activity.parentId}</span>
        </Show>
      </header>
      <Show when={props.activity.goal}>
        {goal => <p class="term-subagent-goal">{goal()}</p>}
      </Show>
      <Show when={props.activity.description}>
        {description => <p class="term-subagent-goal">{description()}</p>}
      </Show>
      <Show when={showIdentity() && executionSummary()}>
        {execution => <small class="term-subagent-meta">{execution()}</small>}
      </Show>
      <Show when={statsEnabled('progress') && (progress()?.total !== undefined || progress()?.completed !== undefined)}>
        <div class="term-subagent-progress-row">
          <progress aria-label={`${props.activity.title ?? props.activity.id} 进度`}
            value={progressCompleted()} max={progressTotal()} />
          <span>进度 {progress()?.completed ?? 0}/{progress()?.total ?? '?'}</span>
        </div>
      </Show>
      <Show when={showAggregate() && (usage() || fileSummary() || metricsSummary())}>
        <div class="term-subagent-stats">
          <Show when={statsEnabled('usage') && usage()}>
            {u => <span>{[
              u().inputTokens !== undefined ? `${u().inputTokens} in` : undefined,
              u().outputTokens !== undefined ? `${u().outputTokens} out` : undefined,
              u().costUsd !== undefined ? `$${u().costUsd}` : undefined,
            ].filter(Boolean).join(' · ')}</span>}
          </Show>
          <Show when={statsEnabled('files') && fileSummary()}>
            {summary => <span>{summary()}</span>}
          </Show>
          <Show when={statsEnabled('metrics') && metricsSummary()}>
            {summary => <span>{summary()}</span>}
          </Show>
        </div>
      </Show>
      <Show when={resultSummary() || parts().length > 0}>
        <details class="term-subagent-output" open={depth() <= defaultExpandedDepth()}>
          <summary>输出</summary>
          <Show when={resultSummary()}>{summary => <p class="term-subagent-goal">{summary()}</p>}</Show>
          <For each={parts()}>{part => part.kind === 'terminal'
            ? <SolidTerminalBlock part={part} appearance={props.appearance} />
            : part.kind === 'log'
              ? <SolidLogBlock part={part} appearance={props.appearance} />
              : part.kind === 'text' || part.kind === 'markdown'
                ? <p class="term-subagent-goal" style={{ 'white-space': 'pre-wrap' }}>{part.text}</p>
                : part.kind === 'code'
                  ? <pre class="solid-content-unknown" data-content-kind="content.code"><code>{part.text}</code></pre>
                  : part.kind === 'unknown'
                    ? <SolidUnknownSubagentContent part={part} />
                    : <pre class="solid-content-unknown" data-content-kind={part.kind}>Unsupported subagent content: {stripAnsiControlSequences(String((part as Record<string, unknown>).summary ?? part.kind)).map(span => span.text).join('')}</pre>}
          </For>
        </details>
      </Show>
      <Show when={props.activity.error}>
        {error => <div role="alert" class="term-subagent-error">{error().userSummary}</div>}
      </Show>
      <div class="term-subagent-stats">
        <Show when={canToolAction('focus')}>
          <button type="button" class="term-file-action" title="聚焦此子代理" onClick={() => dispatchToolAction('focus')}>聚焦</button>
        </Show>
        <Show when={canToolAction('open')}>
          <button type="button" class="term-file-action" title="打开此子代理" onClick={() => dispatchToolAction('open')}>打开</button>
        </Show>
        <Show when={canToolAction('reconnect') && ['failed', 'interrupted', 'timeout', 'blocked'].includes(props.activity.status)}>
          <button type="button" class="term-file-action" title="重新连接此子代理" onClick={() => dispatchToolAction('reconnect')}>重连</button>
        </Show>
        <Show when={canCancel() && !['completed', 'failed', 'cancelled'].includes(props.activity.status)}>
          <button type="button" class="term-file-action" title="取消此子代理" onClick={() => dispatch('activity.cancel')}>取消</button>
        </Show>
        <Show when={canRetry() && ['failed', 'cancelled'].includes(props.activity.status)}>
          <button type="button" class="term-file-action" title="重试此子代理" onClick={() => dispatch('activity.retry')}>重试</button>
        </Show>
      </div>
      <Show when={props.activity.provenance?.synthetic}>
        {synthetic => <small class="term-subagent-provenance">合成生命周期：{synthetic().reason}</small>}
      </Show>
      <Show when={props.activity.provenance}>
        {provenance => <small class="term-subagent-provenance">来源：{[
          provenance().origin, provenance().trust, provenance().orderConfidence,
        ].filter(Boolean).join(' · ')}</small>}
      </Show>
    </section>
  )
}

function SolidUnknownSubagentContent(props: { part: UnknownContentPart }) {
  const raw = () => {
    try { return JSON.stringify(props.part.raw, null, 2) } catch { return '[unavailable]' }
  }
  return <section class="solid-content-unknown" data-content-kind="content.unknown"
    aria-label={`未知子代理内容：${props.part.originalType}`}>
    <strong>未知内容：{props.part.originalType}</strong>
    <span>{props.part.summary}</span>
    <details><summary>Raw 审计信息</summary><pre>{raw()}</pre></details>
    <Show when={props.part.truncation}>{truncation => <small>Raw 已截断，省略 {truncation().omittedBytes} bytes</small>}</Show>
  </section>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function subagentKindLabel(kind: WorkbenchActivityNode['activityKind']): string {
  return kind === 'delegation' ? '委派' : kind === 'team' ? '团队' : '子代理'
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

function handleActivityCardKeyDown(event: KeyboardEvent & { currentTarget: HTMLElement }): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const scope = event.currentTarget.closest('.solid-workbench-activities') ?? event.currentTarget.parentElement
  if (!scope) return
  const cards = [...scope.querySelectorAll<HTMLElement>('.term-subagent-card')]
  const current = cards.indexOf(event.currentTarget)
  if (current < 0 || cards.length === 0) return
  const target = event.key === 'Home' ? cards[0]
    : event.key === 'End' ? cards[cards.length - 1]
      : event.key === 'ArrowDown' ? cards[Math.min(cards.length - 1, current + 1)]
        : cards[Math.max(0, current - 1)]
  event.preventDefault()
  target.focus()
}

export default SolidSubagentCard
