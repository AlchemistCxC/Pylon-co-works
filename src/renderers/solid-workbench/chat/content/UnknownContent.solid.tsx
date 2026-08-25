import { Show } from 'solid-js'
import type { RenderCommandPort } from '../../../../contracts/messageRenderer.ts'
import type { UnknownContentPart } from '../../../../domains/workbench/content/contentPartSchema.ts'
import { ToolObjectInspector } from '../tool/ToolObjectInspector.solid.tsx'

export function SolidUnknownContent(props: {
  part: UnknownContentPart
  commands?: RenderCommandPort
  label?: string
}) {
  const redactions = () => props.part.redactions?.length ?? 0
  return <section class="solid-content-unknown solid-unknown-content" data-content-kind="content.unknown"
    data-original-type={props.part.originalType} data-truncated={props.part.truncated ? 'true' : 'false'}
    aria-label={`${props.label ?? '未知内容'}：${props.part.originalType}`}>
    <header class="solid-unknown-head">
      <span class="solid-unknown-icon" aria-hidden="true">?</span>
      <div>
        <strong>{props.label ?? '未知内容'}：{props.part.originalType}</strong>
        <span>{props.part.summary}</span>
      </div>
    </header>
    <Show when={props.part.truncated || redactions() > 0}>
      <div class="solid-unknown-flags">
        <Show when={props.part.truncated}><span>Raw 已截断</span></Show>
        <Show when={props.part.truncation?.omittedBytes !== undefined}>
          <span>省略 {props.part.truncation!.omittedBytes} bytes</span>
        </Show>
        <Show when={redactions() > 0}><span>{redactions()} 处敏感字段已隐藏</span></Show>
      </div>
    </Show>
    <details class="solid-unknown-details">
      <summary>结构化原始内容</summary>
      <ToolObjectInspector value={props.part.raw} commands={props.commands} />
    </details>
  </section>
}

export function isUnknownContentPart(value: unknown): value is UnknownContentPart {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.kind === 'unknown'
    && typeof record.originalType === 'string'
    && typeof record.summary === 'string'
    && typeof record.truncated === 'boolean'
    && record.raw !== undefined
}
