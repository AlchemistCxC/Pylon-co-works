import { For, Show } from 'solid-js'
import { stripAnsiControlSequences } from '../../../../domains/rendererContent/textContentContracts.ts'
import type { ContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'
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
  const files = () => Array.isArray(props.activity.files) ? (props.activity.files as unknown[]).filter(f => typeof f === 'string') : []
  const progress = () => props.activity.progress as { completed?: number; total?: number } | undefined

  const canCancel = () => props.commands?.canExecute?.('activity.cancel') === true
  const canRetry = () => props.commands?.canExecute?.('activity.retry') === true
  const dispatch = (type: string) => {
    const command: RenderSemanticCommand = { type, targetId: props.activity.id }
    void props.commands?.execute(command)
  }

  return (
    <section
      class="term-subagent-card"
      data-part-kind={props.activity.semanticKind ?? `activity.${props.activity.activityKind ?? 'subagent'}`}
      data-status={props.activity.status}
      data-depth={depth()}
      style={{ '--subagent-depth': String(depth()) }}
      data-density={compact()}
      data-reduced-motion={props.appearance?.reducedMotion === true ? 'true' : 'false'}
      role="status"
      aria-label={`子代理：${props.activity.title ?? props.activity.id}，${props.activity.status}`}
    >
      <header class="term-subagent-head">
        <strong class="term-subagent-title">{props.activity.title ?? props.activity.id}</strong>
        <span>{props.activity.status}</span>
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
      <Show when={progress()?.total !== undefined || progress()?.completed !== undefined}>
        <div class="term-subagent-stats">
          进度 {progress()?.completed ?? 0}/{progress()?.total ?? '?'}
        </div>
      </Show>
      <Show when={usage() || files().length > 0}>
        <div class="term-subagent-stats">
          <Show when={statsEnabled('usage') && usage()}>
            {u => <span>{[
              u().inputTokens !== undefined ? `${u().inputTokens} in` : undefined,
              u().outputTokens !== undefined ? `${u().outputTokens} out` : undefined,
              u().costUsd !== undefined ? `$${u().costUsd}` : undefined,
            ].filter(Boolean).join(' · ')}</span>}
          </Show>
          <Show when={statsEnabled('files') && files().length > 0}>
            <span>{files().length} 个文件</span>
          </Show>
        </div>
      </Show>
      <For each={parts()}>{part => part.kind === 'terminal'
        ? <SolidTerminalBlock part={part} appearance={props.appearance} />
        : part.kind === 'log'
          ? <SolidLogBlock part={part} appearance={props.appearance} />
          : <pre class="solid-content-unknown" data-content-kind={part.kind}>Unsupported subagent content: {stripAnsiControlSequences(String((part as Record<string, unknown>).summary ?? part.kind)).map(span => span.text).join('')}</pre>}
      </For>
      <Show when={props.activity.error}>
        {error => <div role="alert" class="term-subagent-error">{error().userSummary}</div>}
      </Show>
      <div class="term-subagent-stats">
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
    </section>
  )
}

export default SolidSubagentCard
