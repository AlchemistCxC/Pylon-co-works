import { For, Show, createEffect, createSignal } from 'solid-js'
import type { RenderAppearanceSnapshot, RenderCommandPort } from '../../../../contracts/messageRenderer.ts'
import type { DiffSnapshot } from '../../../../domains/workbench/diffSnapshot.ts'
import type { LspDiagnosticContentPart, LspRelatedInformation, TextRange } from '../../../../domains/workbench/content/contentPartSchema.ts'
import { wordDiff, type DiffWordSegment } from '../../../../domains/tool/diffPresentation.ts'
import { SolidCollapsibleRegion } from '../CollapsibleRegion.solid.tsx'

export function SolidDiffContent(props: {
  snapshot: DiffSnapshot
  nodeId: string
  appearance: RenderAppearanceSnapshot
  commands: RenderCommandPort
}) {
  const label = () => props.snapshot.path || props.snapshot.oldPath || '未命名文件'
  const additions = () => props.snapshot.additions
    ?? props.snapshot.lines?.filter(line => line.kind === 'added').length
    ?? 0
  const deletions = () => props.snapshot.deletions
    ?? props.snapshot.lines?.filter(line => line.kind === 'removed').length
    ?? 0
  const view = () => choiceSetting(props.appearance, 'view', ['unified', 'split'], 'unified')
  const showLineNumbers = () => booleanSetting(props.appearance, 'lineNumbers', true)
  const useWordDiff = () => booleanSetting(props.appearance, 'wordDiff', true)
  const wrap = () => choiceSetting(props.appearance, 'wrap', ['none', 'soft'], 'none')
  const contextLines = () => Math.max(0, Math.floor(numberSetting(props.appearance, 'contextLines', 3)))
  let appliedDefaultExpanded = booleanSetting(props.appearance, 'defaultExpanded', true)
  const [open, setOpen] = createSignal(appliedDefaultExpanded)
  createEffect(() => {
    const next = booleanSetting(props.appearance, 'defaultExpanded', true)
    if (next === appliedDefaultExpanded) return
    appliedDefaultExpanded = next
    setOpen(next)
  })
  const bodyId = () => `solid-diff-${safeDomId(props.nodeId)}`

  return <section class="term-diff-card solid-diff-content" role="region" aria-label={`Diff：${label()}`} data-content-kind="content.diff"
    data-view={view()} data-line-numbers={String(showLineNumbers())} data-word-diff={String(useWordDiff())}
    data-wrap={wrap()} data-reduced-motion={props.appearance.reducedMotion === true ? 'true' : 'false'}
    style={{
      '--diff-added': stringSetting(props.appearance, 'addedColor', '#4EBA65'),
      '--diff-removed': stringSetting(props.appearance, 'removedColor', '#FF6B80'),
      'border-color': stringSetting(props.appearance, 'borderColor', 'var(--border)'),
      background: stringSetting(props.appearance, 'background', 'var(--chat-code-bg, rgba(0,0,0,0.02))'),
      color: stringSetting(props.appearance, 'foreground', 'var(--text)'),
    }}>
    <button type="button" class="term-diff-head" aria-expanded={open()} aria-controls={bodyId()}
      onClick={() => setOpen(value => !value)}>
      <strong>{label()}</strong>
      <Show when={props.snapshot.status}><span>{props.snapshot.status}</span></Show>
      <span class="term-diff-count">{additions()} additions · {deletions()} deletions</span>
    </button>
    <Show when={props.snapshot.path || props.snapshot.oldPath}>{path => <button
      type="button" class="term-diff-open"
      aria-label={`打开 ${path()}`}
      disabled={props.commands.canExecute?.('resource.open') !== true}
      title={props.commands.canExecute?.('resource.open') === true ? undefined : '宿主未提供打开能力'}
      onClick={() => void props.commands.execute({ type: 'resource.open', payload: { path: path() } })}
    >打开文件</button>}</Show>
    <SolidCollapsibleRegion open={open()} id={bodyId()}>
      <div class="term-diff-body" style={{
        'max-height': `${numberSetting(props.appearance, 'maxHeight', 320)}px`,
        'font-size': `${numberSetting(props.appearance, 'fontSize', 13)}px`,
      }}>
        <Show when={(props.snapshot.lines?.length ?? 0) > 0} fallback={<DiffNonLineContent snapshot={props.snapshot} />}>
          <Show when={view() === 'split'} fallback={<UnifiedDiffLines
            lines={props.snapshot.lines ?? []} lineNumbers={showLineNumbers()} wrap={wrap()} wordDiff={useWordDiff()} contextLines={contextLines()} />}>
            <SplitDiffLines lines={props.snapshot.lines ?? []} lineNumbers={showLineNumbers()} wrap={wrap()} contextLines={contextLines()} />
          </Show>
        </Show>
        <Show when={booleanSetting(props.appearance, 'showMetadata', true) && diffMetadata(props.snapshot)}>
          {metadata => <small class="solid-diff-metadata">{metadata()}</small>}
        </Show>
        <Show when={booleanSetting(props.appearance, 'showRaw', false) && props.snapshot.rawPatch !== undefined}>
          <details class="solid-diff-raw"><summary>Raw 审计信息</summary><pre>{rawText(props.snapshot.rawPatch)}</pre></details>
        </Show>
      </div>
    </SolidCollapsibleRegion>
  </section>
}

function DiffNonLineContent(props: { snapshot: DiffSnapshot }) {
  if (props.snapshot.binary) return <p class="solid-diff-binary">二进制文件发生变更</p>
  if (props.snapshot.unified) return <pre class="solid-diff-unified-text">{props.snapshot.unified}</pre>
  return <div class="solid-diff-hunks"><For each={props.snapshot.hunks ?? []}>{hunk => <code>
    {`@@ -${hunk.oldStart ?? '?'},${hunk.oldLines ?? '?'} +${hunk.newStart ?? '?'},${hunk.newLines ?? '?'} @@`}
  </code>}</For></div>
}

export function SolidLspDiagnosticContent(props: {
  diagnostic: LspDiagnosticContentPart
  appearance: RenderAppearanceSnapshot
  commands: RenderCommandPort
}) {
  const severity = () => props.diagnostic.severity || 'unknown'
  const palette = () => choiceSetting(props.appearance, 'severityPalette', ['semantic', 'accent', 'neutral'], 'semantic')
  const canOpen = () => props.commands.canExecute?.('resource.open') === true
  const open = (path: string, range?: TextRange) => {
    void props.commands.execute({ type: 'resource.open', payload: { path, ...(range ? { range } : {}) } })
  }
  return <section
    class="solid-lsp-diagnostic"
    data-content-kind="diagnostic.lsp"
    role={severity() === 'error' ? 'alert' : 'status'}
    aria-label={`LSP ${severity()}：${props.diagnostic.message}`}
    data-severity={severity()}
    data-severity-palette={palette()}
    data-reduced-motion={props.appearance.reducedMotion === true ? 'true' : 'false'}
    style={{
      'max-height': `${numberSetting(props.appearance, 'maxHeight', 360)}px`,
      overflow: 'auto',
      '--lsp-accent': lspAccent(palette(), severity()),
      'border-color': 'var(--lsp-accent)',
    }}
  >
    <header><strong>{props.diagnostic.message}</strong></header>
    <Show when={booleanSetting(props.appearance, 'showCode', true) && props.diagnostic.code
      || booleanSetting(props.appearance, 'showSource', true) && props.diagnostic.source}>
      <small>{[
        booleanSetting(props.appearance, 'showCode', true) ? props.diagnostic.code : undefined,
        booleanSetting(props.appearance, 'showSource', true) ? props.diagnostic.source : undefined,
      ].filter(Boolean).join(' · ')}</small>
    </Show>
    <div class="solid-lsp-location">
      <code>{formatLocation(props.diagnostic.path, props.diagnostic.range)}</code>
      <button type="button" aria-label={`打开诊断位置 ${props.diagnostic.path}`}
        disabled={!canOpen()} title={canOpen() ? undefined : '宿主未提供打开能力'}
        onClick={() => open(props.diagnostic.path, props.diagnostic.range)}>打开</button>
    </div>
    <Show when={booleanSetting(props.appearance, 'showRelated', true) && props.diagnostic.related?.length}>
      <ul aria-label="关联诊断位置">
        <For each={props.diagnostic.related}>{item => <LspRelatedItem item={item} canOpen={canOpen()} open={open} />}</For>
      </ul>
    </Show>
    <Show when={booleanSetting(props.appearance, 'showMetadata', true) && props.diagnostic.unknownFields?.length}>
      <small class="solid-lsp-metadata">unknown: {props.diagnostic.unknownFields?.join(', ')}</small>
    </Show>
  </section>
}

function LspRelatedItem(props: {
  item: LspRelatedInformation
  canOpen: boolean
  open(path: string, range?: TextRange): void
}) {
  return <li>
    <span>{props.item.message}</span>
    <code>{formatLocation(props.item.path, props.item.range)}</code>
    <button type="button" aria-label={`打开关联位置 ${props.item.path}`}
      disabled={!props.canOpen} title={props.canOpen ? undefined : '宿主未提供打开能力'}
      onClick={() => props.open(props.item.path, props.item.range)}>打开</button>
  </li>
}

function formatLocation(path: string, range?: TextRange): string {
  if (!range) return path
  const start = `${range.start.line + 1}:${(range.start.character ?? 0) + 1}`
  if (!range.end) return `${path}:${start}`
  const end = `${range.end.line + 1}:${(range.end.character ?? 0) + 1}`
  return `${path}:${start}–${end}`
}

function lspAccent(palette: 'semantic' | 'accent' | 'neutral', severity: string): string {
  if (palette === 'accent') return 'var(--accent)'
  if (palette === 'neutral') return 'var(--text-dim)'
  if (severity === 'error') return 'var(--danger, #e5484d)'
  if (severity === 'warning') return 'var(--warning, #d29922)'
  if (severity === 'info') return 'var(--accent)'
  return 'var(--text-dim)'
}

function UnifiedDiffLines(props: {
  lines: NonNullable<DiffSnapshot['lines']>
  lineNumbers: boolean
  wrap: 'none' | 'soft'
  wordDiff: boolean
  contextLines: number
}) {
  return <div class="solid-diff-unified"><For each={wordDiffRows(limitContext(numberedLines(props.lines), props.contextLines), props.wordDiff)}>{line => (
    line.kind === 'omitted'
      ? <DiffOmission count={line.count} />
      : 'segments' in line
      ? <DiffWordRow {...line} lineNumbers={props.lineNumbers} wrap={props.wrap} />
      : <DiffLineRow {...line} lineNumbers={props.lineNumbers} wrap={props.wrap} />
  )}</For></div>
}

function SplitDiffLines(props: { lines: NonNullable<DiffSnapshot['lines']>; lineNumbers: boolean; wrap: 'none' | 'soft'; contextLines: number }) {
  const numbered = () => limitContext(numberedLines(props.lines), props.contextLines)
  return <div class="solid-diff-split">
    <div class="solid-diff-split-before" aria-label="变更前">
      <For each={numbered().filter(line => line.kind !== 'added')}>{line => line.kind === 'omitted'
        ? <DiffOmission count={line.count} /> : <DiffLineRow {...line} {...props} />}</For>
    </div>
    <div class="solid-diff-split-after" aria-label="变更后">
      <For each={numbered().filter(line => line.kind !== 'removed')}>{line => line.kind === 'omitted'
        ? <DiffOmission count={line.count} /> : <DiffLineRow {...line} {...props} />}</For>
    </div>
  </div>
}

function DiffOmission(props: { count: number }) {
  return <div class="term-diff-omission" role="note">… {props.count} unchanged lines …</div>
}

function DiffLineRow(props: {
  kind: 'context' | 'added' | 'removed'
  text: string
  oldLine?: number
  newLine?: number
  lineNumbers: boolean
  wrap: 'none' | 'soft'
}) {
  const number = () => props.kind === 'added' ? props.newLine : props.oldLine
  return <div class={`term-diff-line term-diff-${props.kind}`} style={{ 'white-space': props.wrap === 'soft' ? 'pre-wrap' : 'pre' }}>
    <Show when={props.lineNumbers}><span class="term-diff-line-number" aria-hidden="true">{number() ?? ''}</span></Show>
    <span class="term-diff-sign" aria-hidden="true">{props.kind === 'added' ? '+' : props.kind === 'removed' ? '-' : ' '}</span>
    <code>{props.text || '\u00a0'}</code>
  </div>
}

function DiffWordRow(props: {
  kind: 'added' | 'removed'
  segments: readonly DiffWordSegment[]
  oldLine?: number
  newLine?: number
  lineNumbers: boolean
  wrap: 'none' | 'soft'
}) {
  const number = () => props.kind === 'added' ? props.newLine : props.oldLine
  return <div class={`term-diff-line term-diff-${props.kind}`} style={{ 'white-space': props.wrap === 'soft' ? 'pre-wrap' : 'pre' }}>
    <Show when={props.lineNumbers}><span class="term-diff-line-number" aria-hidden="true">{number() ?? ''}</span></Show>
    <span class="term-diff-sign" aria-hidden="true">{props.kind === 'added' ? '+' : '-'}</span>
    <code><For each={props.segments}>{segment => segment.kind === 'common'
      ? <span>{segment.text}</span>
      : <span class={`term-diff-word term-diff-word-${segment.kind}`}>{segment.text}</span>}
    </For></code>
  </div>
}

type NumberedDiffLine = ReturnType<typeof numberedLines>[number]
type OmittedDiffLines = { readonly kind: 'omitted'; readonly count: number }
type VisibleDiffLine = NumberedDiffLine | OmittedDiffLines
type DiffRenderLine = VisibleDiffLine | (Omit<NumberedDiffLine, 'text' | 'kind'> & {
  kind: 'added' | 'removed'
  segments: readonly DiffWordSegment[]
})

function wordDiffRows(lines: readonly VisibleDiffLine[], enabled: boolean): readonly DiffRenderLine[] {
  if (!enabled) return lines
  const rows: DiffRenderLine[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const next = lines[index + 1]
    if (line.kind === 'removed' && next?.kind === 'added') {
      const segments = wordDiff(line.text, next.text)
      rows.push({ kind: 'removed', oldLine: line.oldLine, segments: segments.filter(segment => segment.kind !== 'added') })
      rows.push({ kind: 'added', newLine: next.newLine, segments: segments.filter(segment => segment.kind !== 'removed') })
      index += 1
    } else {
      rows.push(line)
    }
  }
  return rows
}

function limitContext(lines: readonly NumberedDiffLine[], count: number): readonly VisibleDiffLine[] {
  const changed = lines.flatMap((line, index) => line.kind === 'context' ? [] : [index])
  if (changed.length === 0) return lines
  const visible = new Set<number>()
  for (const index of changed) {
    for (let current = Math.max(0, index - count); current <= Math.min(lines.length - 1, index + count); current += 1) visible.add(current)
  }
  const output: VisibleDiffLine[] = []
  let omitted = 0
  const flush = () => {
    if (omitted > 0) output.push({ kind: 'omitted', count: omitted })
    omitted = 0
  }
  lines.forEach((line, index) => {
    if (!visible.has(index) && line.kind === 'context') {
      omitted += 1
      return
    }
    flush()
    output.push(line)
  })
  flush()
  return output
}

function numberedLines(lines: NonNullable<DiffSnapshot['lines']>) {
  let oldLine = 1
  let newLine = 1
  return lines.map(line => {
    const value = {
      ...line,
      ...(line.kind !== 'added' ? { oldLine } : {}),
      ...(line.kind !== 'removed' ? { newLine } : {}),
    }
    if (line.kind !== 'added') oldLine += 1
    if (line.kind !== 'removed') newLine += 1
    return value
  })
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

function choiceSetting<const Value extends string>(appearance: RenderAppearanceSnapshot, key: string, values: readonly Value[], fallback: Value): Value {
  const value = appearance[key]
  return typeof value === 'string' && values.includes(value as Value) ? value as Value : fallback
}

function safeDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, character => `%${character.charCodeAt(0).toString(16).padStart(4, '0')}%`)
}

function diffMetadata(snapshot: DiffSnapshot): string {
  return [
    snapshot.binary ? 'binary' : undefined,
    snapshot.truncated ? 'truncated' : undefined,
    snapshot.unknownFields?.length ? `unknown: ${snapshot.unknownFields.join(', ')}` : undefined,
  ].filter(Boolean).join(' · ')
}

function rawText(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value, null, 2) }
  catch { return '[unavailable]' }
}
