import { For, Show, createMemo, createSignal } from 'solid-js'
import {
  normalizeDiffPayload,
  wordDiff,
  type DiffLine,
  type DiffPayload,
  type DiffWordSegment,
} from '../../../domains/tool/diffPresentation.ts'
import { SolidCollapsibleRegion } from './CollapsibleRegion.solid.tsx'

export interface SolidDiffCardProps {
  output: string
  payload?: DiffPayload | null
}

export function SolidDiffCard(props: SolidDiffCardProps) {
  const payload = createMemo(() => props.payload ?? normalizeDiffPayload(props.output))
  const addedCount = createMemo(() => payload()?.lines.filter(line => line.kind === 'added').length ?? 0)
  const removedCount = createMemo(() => payload()?.lines.filter(line => line.kind === 'removed').length ?? 0)
  const [open, setOpen] = createSignal(true)
  const bodyId = `solid-diff-${Math.random().toString(36).slice(2)}`

  return (
    <Show when={payload()}>
      {resolved => (
        <div class="term-diff-card">
          <button
            type="button"
            class="term-diff-head"
            onClick={() => setOpen(value => !value)}
            aria-expanded={open()}
            aria-controls={bodyId}
          >
            <span>变更预览</span>
            <span class="term-diff-count">{addedCount()} additions · {removedCount()} deletions</span>
          </button>
          <SolidCollapsibleRegion open={open()} id={bodyId}>
            <div class="term-diff-body">
              <For each={buildDiffRows(resolved().lines)}>{row => <DiffRow row={row} />}</For>
            </div>
          </SolidCollapsibleRegion>
        </div>
      )}
    </Show>
  )
}

type DiffRenderRow =
  | { kind: 'line'; key: string; line: DiffLine }
  | { kind: 'segments'; key: string; lineKind: 'added' | 'removed'; segments: readonly DiffWordSegment[] }

export function buildDiffRows(lines: readonly DiffLine[]): readonly DiffRenderRow[] {
  const rows: DiffRenderRow[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const next = lines[index + 1]
    if (line.kind === 'removed' && next?.kind === 'added') {
      const segments = wordDiff(line.text, next.text)
      rows.push({
        kind: 'segments',
        key: `${index}-removed`,
        lineKind: 'removed',
        segments: segments.filter(segment => segment.kind !== 'added'),
      })
      rows.push({
        kind: 'segments',
        key: `${index}-added`,
        lineKind: 'added',
        segments: segments.filter(segment => segment.kind !== 'removed'),
      })
      index += 1
      continue
    }
    rows.push({ kind: 'line', key: `${index}-${line.kind}`, line })
  }
  return rows
}

function DiffRow(props: { row: DiffRenderRow }) {
  if (props.row.kind === 'line') return <DiffLineRow line={props.row.line} />
  return (
    <div class={`term-diff-line term-diff-${props.row.lineKind}`}>
      <span class="term-diff-sign">{props.row.lineKind === 'added' ? '+' : '-'}</span>
      <code>
        <For each={props.row.segments}>{segment => segment.kind === 'common'
          ? <span>{segment.text}</span>
          : <span class={`term-diff-word term-diff-word-${segment.kind}`}>{segment.text}</span>}
        </For>
      </code>
    </div>
  )
}

function DiffLineRow(props: { line: DiffLine }) {
  return (
    <div class={`term-diff-line term-diff-${props.line.kind}`}>
      <span class="term-diff-sign">{props.line.kind === 'added' ? '+' : props.line.kind === 'removed' ? '-' : ' '}</span>
      <code>{props.line.text || '\u00a0'}</code>
    </div>
  )
}
