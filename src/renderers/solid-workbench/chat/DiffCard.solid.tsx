/** @jsxImportSource solid-js */
import { For, Show, createMemo } from 'solid-js'
import {
  normalizeDiffPayload,
  wordDiff,
  type DiffLine,
  type DiffPayload,
  type DiffWordSegment,
} from '../../../domains/tool/diffPresentation.ts'
import { SolidCollapsibleRegion } from './CollapsibleRegion.solid.tsx'
import { createCollapsiblePresenter } from './CollapsiblePresenter.solid.tsx'
import { CODE_INHERIT, DIFF_BODY, DIFF_CARD, DIFF_COUNT, DIFF_HEAD, DIFF_LINE, DIFF_LINE_BG, DIFF_SIGN, DIFF_SIGN_TONE, WORD_BASE, WORD_TONE } from '../../../domains/chat/diffCardPresentation.ts'

export interface SolidDiffCardProps {
  output: string
  payload?: DiffPayload | null
}

export function SolidDiffCard(props: SolidDiffCardProps) {
  const payload = createMemo(() => props.payload ?? normalizeDiffPayload(props.output))
  const addedCount = createMemo(() => payload()?.lines.filter(line => line.kind === 'added').length ?? 0)
  const removedCount = createMemo(() => payload()?.lines.filter(line => line.kind === 'removed').length ?? 0)
  const collapse = createCollapsiblePresenter({ defaultOpen: () => true, idPrefix: 'solid-diff' })

  return (
    <Show when={payload()}>
      {resolved => (
        <div class={DIFF_CARD} data-diff-card="true">
          <button
            type="button"
            class={DIFF_HEAD}
            onClick={collapse.toggle}
            aria-expanded={collapse.open()}
            aria-controls={collapse.bodyId}
          >
            <span>变更预览</span>
            <span class={DIFF_COUNT}>{addedCount()} additions · {removedCount()} deletions</span>
          </button>
          <SolidCollapsibleRegion open={collapse.open()} id={collapse.bodyId}>
            <div class={DIFF_BODY} data-diff-body="true">
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
    <div class={`${DIFF_LINE} ${DIFF_LINE_BG[props.row.lineKind]}`}>
      <span class={`${DIFF_SIGN} ${DIFF_SIGN_TONE[props.row.lineKind]}`}>{props.row.lineKind === 'added' ? '+' : '-'}</span>
      <code class={CODE_INHERIT}>
        <For each={props.row.segments}>{segment => segment.kind === 'common'
          ? <span>{segment.text}</span>
          : <span data-diff-word={segment.kind} class={`${WORD_BASE} ${WORD_TONE[segment.kind]}`}>{segment.text}</span>}
        </For>
      </code>
    </div>
  )
}

function DiffLineRow(props: { line: DiffLine }) {
  const tone = props.line.kind === 'added' || props.line.kind === 'removed' ? DIFF_SIGN_TONE[props.line.kind] : ''
  return (
    <div class={`${DIFF_LINE} ${props.line.kind === 'context' ? '' : DIFF_LINE_BG[props.line.kind]}`}>
      <span class={`${DIFF_SIGN} ${tone}`}>{props.line.kind === 'added' ? '+' : props.line.kind === 'removed' ? '-' : ' '}</span>
      <code class={CODE_INHERIT}>{props.line.text || '\u00a0'}</code>
    </div>
  )
}
