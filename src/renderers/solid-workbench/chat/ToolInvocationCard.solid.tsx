import { For, Show, createEffect, createMemo, createSignal } from 'solid-js'
import type { RenderAppearanceSnapshot } from '../../../contracts/messageRenderer.ts'
import { createUnknownContentPart, type ContentPart } from '../../../domains/workbench/content/contentPartSchema.ts'
import type { ToolInvocationSnapshot } from '../../../domains/workbench/workbenchProjector.ts'
import { normalizeToolStatus, toolStatePresentation } from '../../../domains/tool/status.ts'
import { MarkdownContent } from './MarkdownContent.solid.tsx'
import { SolidCodeBlock } from './CodeBlock.solid.tsx'
import { SolidAnsiBlock } from './AnsiBlock.solid.tsx'
import { SolidFileReferenceCard } from './content/FileReference.solid.tsx'
import { SolidMediaBlock } from './content/MediaBlock.solid.tsx'
import { BUILTIN_MEDIA_RESOLVER_OPTIONS } from '../mediaAssetAdapter.ts'

export function SolidToolInvocationCard(props: {
  snapshot: ToolInvocationSnapshot
  appearance: RenderAppearanceSnapshot
  renderKind: string
}) {
  const state = () => normalizeToolStatus(props.snapshot.status ?? props.snapshot.result?.status)
  const hasOutput = () => Boolean(props.snapshot.result && (
    props.snapshot.result.parts !== undefined
    || props.snapshot.result.rawOutput !== undefined
    || props.snapshot.result.error !== undefined
  ))
  const presentation = () => toolStatePresentation(state(), hasOutput())
  const displayName = () => props.snapshot.title
    || props.snapshot.canonicalName
    || props.snapshot.name
    || '未知工具'
  const [open, setOpen] = createSignal(!booleanSetting(props.appearance, 'defaultCollapsed', false))
  const bodyId = () => `solid-tool-snapshot-${safeDomId(props.snapshot.id)}`
  let currentSnapshotId = props.snapshot.id
  createEffect(() => {
    const nextSnapshotId = props.snapshot.id
    if (nextSnapshotId === currentSnapshotId) return
    currentSnapshotId = nextSnapshotId
    setOpen(!booleanSetting(props.appearance, 'defaultCollapsed', false))
  })
  const parts = createMemo<readonly ContentPart[]>(() => Array.isArray(props.snapshot.result?.parts)
    ? props.snapshot.result!.parts!.filter(isContentPart) as readonly ContentPart[]
    : [])
  const duration = () => booleanSetting(props.appearance, 'showDuration', true)
    ? formatDuration(props.snapshot.result?.durationMs)
    : ''

  return <article
    class="term-tool solid-tool-invocation"
    role="status"
    aria-label={`工具：${displayName()}，${presentation().label}`}
    data-content-kind={props.renderKind}
    data-tool-call-id={props.snapshot.id}
    data-tool-state={state()}
    data-status={presentation().tone}
    data-status-palette={stringSetting(props.appearance, 'statusPalette', 'semantic')}
    data-density={props.appearance.density === 'compact' ? 'compact' : 'comfortable'}
    data-reduced-motion={props.appearance.reducedMotion === true ? 'true' : 'false'}
    style={{
      color: stringSetting(props.appearance, 'foreground', 'var(--text)'),
      background: stringSetting(props.appearance, 'background', 'transparent'),
      'border-color': stringSetting(props.appearance, 'borderColor', 'var(--border)'),
      'max-width': `${numberSetting(props.appearance, 'maxWidth', 960)}px`,
    }}
  >
    <button class="term-tool-head" type="button" aria-expanded={open()} aria-controls={bodyId()}
      onClick={() => setOpen(value => !value)}>
      <Show when={stringSetting(props.appearance, 'indicator', 'glyph') !== 'none'}>
        <span class={`term-tool-indicator ${presentation().tone}`} aria-hidden="true">
          {indicatorGlyph(stringSetting(props.appearance, 'indicator', 'glyph'), presentation().tone)}
        </span>
      </Show>
      <span class="term-tool-name">{displayName()}</span>
      <Show when={props.snapshot.name && props.snapshot.name !== displayName()}>
        <span class="term-tool-summary"> ({props.snapshot.name})</span>
      </Show>
      <span class="term-tool-suffix"> — {presentation().label}</span>
      <Show when={duration()}>{value => <span class="term-tool-duration"> · {value()}</span>}</Show>
    </button>
    <Show when={open()}>
      <div id={bodyId()} class="term-tool-body" style={{ 'max-height': `${numberSetting(props.appearance, 'maxHeight', 420)}px`, overflow: 'auto' }}>
        <Show when={props.snapshot.input !== undefined}>
          <ToolField label="输入" value={props.snapshot.input} contentParts />
        </Show>
        <Show when={props.snapshot.progress !== undefined}>
          <ToolField label="进度" value={props.snapshot.progress} />
        </Show>
        <Show when={props.snapshot.locations !== undefined}>
          <ToolField label="位置" value={props.snapshot.locations} class="solid-tool-locations" />
        </Show>
        <Show when={parts().length > 0}>
          <section class="solid-tool-parts" aria-label="工具输出">
            <span class="term-tool-label">输出</span>
            <For each={parts()}>{part => <ToolContentPart part={part} />}</For>
          </section>
        </Show>
        <Show when={props.snapshot.result?.error}>
          {error => <ToolError error={error()} />}
        </Show>
        <Show when={booleanSetting(props.appearance, 'showMetadata', true) && metadata(props.snapshot)}>
          {value => <small class="solid-tool-metadata">{value()}</small>}
        </Show>
        <Show when={booleanSetting(props.appearance, 'showRaw', false) && (
          props.snapshot.rawInput !== undefined || props.snapshot.result?.rawOutput !== undefined
        )}>
          <details class="solid-tool-raw"><summary>Raw 审计信息</summary><pre>{safeRawSummary({
            ...(props.snapshot.rawInput !== undefined ? { input: props.snapshot.rawInput } : {}),
            ...(props.snapshot.result?.rawOutput !== undefined ? { output: props.snapshot.result.rawOutput } : {}),
          })}</pre></details>
        </Show>
      </div>
    </Show>
  </article>
}

function ToolField(props: { label: string; value: unknown; class?: string; contentParts?: boolean }) {
  const parts = () => props.contentParts ? contentParts(props.value) : undefined
  return <section class={`solid-tool-field${props.class ? ` ${props.class}` : ''}`}>
    <span class="term-tool-label">{props.label}</span>
    <Show when={parts()} fallback={<pre>{safeJson(props.value)}</pre>}>
      {items => <div data-tool-input-parts><For each={items()}>{part => <ToolContentPart part={part} />}</For></div>}
    </Show>
  </section>
}

function ToolContentPart(props: { part: ContentPart }) {
  if (props.part.kind === 'code' && 'text' in props.part && typeof props.part.text === 'string') {
    return <SolidCodeBlock code={props.part.text} language={props.part.language} />
  }
  if (props.part.kind === 'ansi' && 'text' in props.part && typeof props.part.text === 'string') {
    return <SolidAnsiBlock text={props.part.text} />
  }
  if ((props.part.kind === 'text' || props.part.kind === 'markdown') && 'text' in props.part && typeof props.part.text === 'string') {
    return <div data-tool-part-kind={props.part.kind}><MarkdownContent text={props.part.text} /></div>
  }
  if (props.part.kind === 'file-reference' || props.part.kind === 'file-selection' || props.part.kind === 'document' || props.part.kind === 'resource') {
    return <SolidFileReferenceCard part={props.part} />
  }
  if (props.part.kind === 'image' || props.part.kind === 'audio' || props.part.kind === 'video') {
    return <SolidMediaBlock part={props.part} resolverOptions={BUILTIN_MEDIA_RESOLVER_OPTIONS} />
  }
  if (props.part.kind === 'unknown') {
    return <details data-tool-part-kind="unknown"><summary>{props.part.summary}</summary><pre>{safeJson(props.part.raw)}</pre></details>
  }
  return <pre data-tool-part-kind={props.part.kind}>{safeJson(props.part)}</pre>
}

function ToolError(props: { error: NonNullable<NonNullable<ToolInvocationSnapshot['result']>['error']> }) {
  const hasTechnicalDetail = () => Boolean(props.error.technicalMessage && props.error.technicalMessage !== props.error.userSummary)
  return <section class="solid-tool-error" role="alert">
    <span class="term-tool-label term-tool-label-error">错误</span>
    <pre>{props.error.userSummary}</pre>
    <Show when={props.error.code}><small>code: {props.error.code}</small></Show>
    <Show when={hasTechnicalDetail()}>
      <details><summary>技术细节</summary><pre>{props.error.technicalMessage}</pre></details>
    </Show>
  </section>
}

function isContentPart(value: unknown): value is ContentPart {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).kind === 'string'
}

function contentParts(value: unknown): readonly ContentPart[] | undefined {
  if (isContentPart(value)) return [value]
  if (!Array.isArray(value) || value.length === 0 || !value.every(isContentPart)) return undefined
  return value
}

function metadata(snapshot: ToolInvocationSnapshot): string {
  return [
    snapshot.canonicalName ? `canonical: ${snapshot.canonicalName}` : undefined,
    snapshot.action ? `action: ${snapshot.action}` : undefined,
    snapshot.parentToolCallId ? `parent: ${snapshot.parentToolCallId}` : undefined,
    Array.isArray(snapshot.locations) && snapshot.locations.length > 0 ? `locations: ${snapshot.locations.length}` : undefined,
  ].filter(Boolean).join(' · ')
}

function safeRawSummary(value: unknown): string {
  const safe = createUnknownContentPart('tool.raw', value, { maxRawBytes: 8 * 1024 })
  return safeJson(safe.raw)
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) }
  catch { return '[unavailable]' }
}

function formatDuration(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return ''
  if (value < 1000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`
}

function indicatorGlyph(indicator: string, tone: 'run' | 'ok' | 'err'): string {
  if (indicator === 'dot') return '•'
  return tone === 'ok' ? '✓' : tone === 'err' ? '×' : '◌'
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, character => `%${character.charCodeAt(0).toString(16).padStart(4, '0')}%`)
}

function stringSetting(appearance: RenderAppearanceSnapshot, key: string, fallback: string): string {
  return typeof appearance[key] === 'string' ? appearance[key] as string : fallback
}

function numberSetting(appearance: RenderAppearanceSnapshot, key: string, fallback: number): number {
  return typeof appearance[key] === 'number' && Number.isFinite(appearance[key]) ? appearance[key] as number : fallback
}

function booleanSetting(appearance: RenderAppearanceSnapshot, key: string, fallback: boolean): boolean {
  return typeof appearance[key] === 'boolean' ? appearance[key] as boolean : fallback
}
