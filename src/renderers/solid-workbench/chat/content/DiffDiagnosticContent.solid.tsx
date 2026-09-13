import { For, Show } from 'solid-js'
import type { RenderAppearanceSnapshot, RenderCommandPort } from '../../../../contracts/messageRenderer.ts'
import type { DiffSnapshot } from '../../../../domains/workbench/diffSnapshot.ts'
import type { LspDiagnosticContentPart, LspRelatedInformation, TextRange } from '../../../../domains/workbench/content/contentPartSchema.ts'
import { wordDiff, type DiffWordSegment } from '../../../../domains/tool/diffPresentation.ts'
import { SolidCollapsibleRegion } from '../CollapsibleRegion.solid.tsx'
import { createCollapsiblePresenter } from '../CollapsiblePresenter.solid.tsx'

// 样式绞杀（P92 地基后机械翻译）：与 React DiffCard.tsx / DiffCard.solid.tsx
// 镜像同一组 utility 常量（原 DiffCard.css）。solid-diff-content 与
// solid-lsp-diagnostic 类名保留为 renderers 包 adaptive.css 残量规则的锚点。
const DIFF_CARD = 'mt-1 mb-1.5 rounded-none overflow-hidden border border-border bg-[var(--chat-code-bg,rgba(0,0,0,0.02))]'
const DIFF_HEAD = 'w-full flex justify-between gap-3 py-[5px] px-2 border-0 text-text bg-transparent [font:inherit] text-left cursor-pointer hover:bg-border'
const DIFF_COUNT = 'text-text-dim text-[0.85em]'
const DIFF_BODY = 'max-h-[320px] overflow-auto font-mono text-[0.9em] leading-[1.5]'
const DIFF_OPEN = 'mx-2 mb-1.5 mt-0 px-[7px] py-0.5 border border-border text-text bg-transparent [font:inherit] cursor-pointer enabled:hover:border-accent enabled:hover:text-accent disabled:text-text-dim disabled:cursor-not-allowed disabled:opacity-70'
const DIFF_LINE = 'flex min-w-max pr-2.5 whitespace-pre'
const DIFF_LINE_NUMBER = 'w-[4ch] shrink-0 basis-[4ch] px-1.5 text-text-dim text-right select-none border-r border-stroke-faint'
const DIFF_SIGN = 'w-6 shrink-0 pl-2 text-text-dim select-none'
const DIFF_LINE_BG: Partial<Record<'context' | 'added' | 'removed', string>> = {
  added: 'bg-[color-mix(in_srgb,var(--diff-added,#4EBA65)_14%,transparent)]',
  removed: 'bg-[color-mix(in_srgb,var(--diff-removed,#FF6B80)_14%,transparent)]',
}
const DIFF_SIGN_TONE: Partial<Record<'context' | 'added' | 'removed', string>> = {
  added: 'text-[var(--diff-added,#4EBA65)]',
  removed: 'text-[var(--diff-removed,#FF6B80)]',
}
const WORD_BASE = 'rounded-none'
const WORD_TONE: Record<'added' | 'removed', string> = {
  added: 'bg-[var(--diff-added-word,#3EA15E)] text-white',
  removed: 'bg-[var(--diff-removed-word,#E0556B)] text-white',
}
const DIFF_OMISSION = 'px-2 py-0.5 text-text-dim bg-stroke-faint italic'
const DIFF_RAW = 'border-t border-border px-2 py-1.5'
const MUTED_BLOCK = 'block m-0 p-2 text-text-dim'
const SPLIT = 'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] min-w-[640px] max-[720px]:min-w-0 max-[720px]:grid-cols-1'
const SPLIT_BEFORE = 'min-w-0 overflow-auto border-r border-border max-[720px]:border-r-0 max-[720px]:border-b max-[720px]:border-border'
const SPLIT_AFTER = 'min-w-0 overflow-auto'
const LSP = 'mt-1 mb-1.5 px-2.5 py-2 border border-l-[3px] text-text bg-[var(--chat-code-bg,rgba(0,0,0,.02))]'
const LSP_LOCATION = 'flex items-baseline gap-2 min-w-0'
const LSP_BTN = 'ml-auto border-0 px-1 py-0.5 text-accent bg-transparent [font:inherit] cursor-pointer disabled:text-text-dim disabled:cursor-not-allowed'

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
  const collapse = createCollapsiblePresenter({
    defaultOpen: () => booleanSetting(props.appearance, 'defaultExpanded', true),
    resetOnDefaultChange: true,
    bodyId: () => `solid-diff-${safeDomId(props.nodeId)}`,
  })

  return <section class={`solid-diff-content ${DIFF_CARD}`} role="region" aria-label={`Diff：${label()}`} data-content-kind="content.diff"
    data-view={view()} data-line-numbers={String(showLineNumbers())} data-word-diff={String(useWordDiff())}
    data-wrap={wrap()} data-reduced-motion={props.appearance.reducedMotion === true ? 'true' : 'false'}
    style={{
      '--diff-added': stringSetting(props.appearance, 'addedColor', '#4EBA65'),
      '--diff-removed': stringSetting(props.appearance, 'removedColor', '#FF6B80'),
      'border-color': stringSetting(props.appearance, 'borderColor', 'var(--border)'),
      background: stringSetting(props.appearance, 'background', 'var(--chat-code-bg, rgba(0,0,0,0.02))'),
      color: stringSetting(props.appearance, 'foreground', 'var(--text)'),
    }}>
    <button type="button" class={DIFF_HEAD} aria-expanded={collapse.open()} aria-controls={collapse.bodyId}
      onClick={collapse.toggle}>
      <strong>{label()}</strong>
      <Show when={props.snapshot.status}><span>{props.snapshot.status}</span></Show>
      <span class={DIFF_COUNT}>{additions()} additions · {deletions()} deletions</span>
    </button>
    <Show when={props.snapshot.path || props.snapshot.oldPath}>{path => <button
      type="button" class={DIFF_OPEN}
      aria-label={`打开 ${path()}`}
      disabled={props.commands.canExecute?.('resource.open') !== true}
      title={props.commands.canExecute?.('resource.open') === true ? undefined : '宿主未提供打开能力'}
      onClick={() => void props.commands.execute({ type: 'resource.open', payload: { path: path() } })}
    >打开文件</button>}</Show>
    <SolidCollapsibleRegion open={collapse.open()} id={collapse.bodyId}>
      <div class={DIFF_BODY} data-diff-body="true" style={{
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
          {metadata => <small class="text-text-dim">{metadata()}</small>}
        </Show>
        <Show when={booleanSetting(props.appearance, 'showRaw', false) && props.snapshot.rawPatch !== undefined}>
          <details class={DIFF_RAW}><summary>Raw 审计信息</summary><pre class="m-0 p-2 overflow-auto whitespace-pre [font:inherit]">{rawText(props.snapshot.rawPatch)}</pre></details>
        </Show>
      </div>
    </SolidCollapsibleRegion>
  </section>
}

function DiffNonLineContent(props: { snapshot: DiffSnapshot }) {
  if (props.snapshot.binary) return <p class={MUTED_BLOCK}>二进制文件发生变更</p>
  if (props.snapshot.unified) return <pre class="m-0 p-2 overflow-auto whitespace-pre [font:inherit]" data-diff-view="unified">{props.snapshot.unified}</pre>
  return <div class="grid gap-1 p-2 text-text-dim" data-diff-hunks="true"><For each={props.snapshot.hunks ?? []}>{hunk => <code>
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
    class={`solid-lsp-diagnostic ${LSP}`}
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
    <header class="mb-[3px]"><strong>{props.diagnostic.message}</strong></header>
    <Show when={booleanSetting(props.appearance, 'showCode', true) && props.diagnostic.code
      || booleanSetting(props.appearance, 'showSource', true) && props.diagnostic.source}>
      <small class="text-text-dim">{[
        booleanSetting(props.appearance, 'showCode', true) ? props.diagnostic.code : undefined,
        booleanSetting(props.appearance, 'showSource', true) ? props.diagnostic.source : undefined,
      ].filter(Boolean).join(' · ')}</small>
    </Show>
    <div class={LSP_LOCATION}>
      <code class="min-w-0 wrap-anywhere">{formatLocation(props.diagnostic.path, props.diagnostic.range)}</code>
      <button type="button" class={LSP_BTN} aria-label={`打开诊断位置 ${props.diagnostic.path}`}
        disabled={!canOpen()} title={canOpen() ? undefined : '宿主未提供打开能力'}
        onClick={() => open(props.diagnostic.path, props.diagnostic.range)}>打开</button>
    </div>
    <Show when={booleanSetting(props.appearance, 'showRelated', true) && props.diagnostic.related?.length}>
      <ul class="grid mt-2 gap-1 pl-5" aria-label="关联诊断位置">
        <For each={props.diagnostic.related}>{item => <LspRelatedItem item={item} canOpen={canOpen()} open={open} />}</For>
      </ul>
    </Show>
    <Show when={booleanSetting(props.appearance, 'showMetadata', true) && props.diagnostic.unknownFields?.length}>
      <small class="text-text-dim">unknown: {props.diagnostic.unknownFields?.join(', ')}</small>
    </Show>
  </section>
}

function LspRelatedItem(props: {
  item: LspRelatedInformation
  canOpen: boolean
  open(path: string, range?: TextRange): void
}) {
  return <li class={LSP_LOCATION}>
    <span>{props.item.message}</span>
    <code class="min-w-0 wrap-anywhere">{formatLocation(props.item.path, props.item.range)}</code>
    <button type="button" class={LSP_BTN} aria-label={`打开关联位置 ${props.item.path}`}
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
  return <div class={SPLIT}>
    <div class={SPLIT_BEFORE} aria-label="变更前">
      <For each={numbered().filter(line => line.kind !== 'added')}>{line => line.kind === 'omitted'
        ? <DiffOmission count={line.count} /> : <DiffLineRow {...line} {...props} />}</For>
    </div>
    <div class={SPLIT_AFTER} aria-label="变更后">
      <For each={numbered().filter(line => line.kind !== 'removed')}>{line => line.kind === 'omitted'
        ? <DiffOmission count={line.count} /> : <DiffLineRow {...line} {...props} />}</For>
    </div>
  </div>
}

function DiffOmission(props: { count: number }) {
  return <div class={DIFF_OMISSION} role="note">… {props.count} unchanged lines …</div>
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
  return <div class={`${DIFF_LINE} ${DIFF_LINE_BG[props.kind] ?? ''}`} style={{ 'white-space': props.wrap === 'soft' ? 'pre-wrap' : 'pre' }}>
    <Show when={props.lineNumbers}><span class={DIFF_LINE_NUMBER} aria-hidden="true">{number() ?? ''}</span></Show>
    <span class={`${DIFF_SIGN} ${DIFF_SIGN_TONE[props.kind] ?? ''}`} aria-hidden="true">{props.kind === 'added' ? '+' : props.kind === 'removed' ? '-' : ' '}</span>
    <code class="[font:inherit]">{props.text || '\u00a0'}</code>
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
  return <div class={`${DIFF_LINE} ${DIFF_LINE_BG[props.kind]}`} style={{ 'white-space': props.wrap === 'soft' ? 'pre-wrap' : 'pre' }}>
    <Show when={props.lineNumbers}><span class={DIFF_LINE_NUMBER} aria-hidden="true">{number() ?? ''}</span></Show>
    <span class={`${DIFF_SIGN} ${DIFF_SIGN_TONE[props.kind]}`} aria-hidden="true">{props.kind === 'added' ? '+' : '-'}</span>
    <code class="[font:inherit]"><For each={props.segments}>{segment => segment.kind === 'common'
      ? <span>{segment.text}</span>
      : <span data-diff-word={segment.kind} class={`${WORD_BASE} ${WORD_TONE[segment.kind]}`}>{segment.text}</span>}
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
