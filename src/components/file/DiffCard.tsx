import { useId, useMemo, useState } from 'react'
import { normalizeDiffPayload, wordDiff, type DiffLine, type DiffPayload } from '../../domains/tool/diffPresentation.ts'
import CollapsibleRegion from './CollapsibleRegion.tsx'
import { DIFF_BODY, DIFF_CARD, DIFF_COUNT, DIFF_HEAD, DIFF_LINE, DIFF_LINE_BG, DIFF_SIGN, DIFF_SIGN_TONE, WORD_BASE, WORD_TONE } from '../../domains/chat/diffCardPresentation.ts'

/** 词级片段渲染（common 普通、added/removed 词色背景） */
function WordSegments({ segments }: { segments: ReturnType<typeof wordDiff> }) {
  return (
    <code className="[font:inherit]">
      {segments.map((segment, i) => segment.kind === 'common'
        ? <span key={i}>{segment.text}</span>
        : <span key={i} data-diff-word={segment.kind} className={`${WORD_BASE} ${WORD_TONE[segment.kind]}`}>{segment.text}</span>)}
    </code>
  )
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const tone = line.kind === 'added' || line.kind === 'removed' ? DIFF_SIGN_TONE[line.kind] : ''
  return (
    <div className={`${DIFF_LINE} ${DIFF_LINE_BG[line.kind] ?? ''}`}>
      <span className={`${DIFF_SIGN} ${tone}`}>{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
      <code className="[font:inherit]">{line.text || '\u00a0'}</code>
    </div>
  )
}

export default function DiffCard({ output, payload: payloadProp }: { output: string; payload?: DiffPayload | null }) {
  // payload 解析（含 JSON.parse）与计数都是 output 的纯函数：只在 output 变化时重算；
  // P1-10：调用方可直接传入已解析 payload（contentBlocks 的 tool_diff_content），免二次解析
  const { payload, addedCount, removedCount } = useMemo(() => {
    const parsed = payloadProp ?? normalizeDiffPayload(output)
    return {
      payload: parsed,
      addedCount: parsed ? parsed.lines.filter(line => line.kind === 'added').length : 0,
      removedCount: parsed ? parsed.lines.filter(line => line.kind === 'removed').length : 0,
    }
  }, [output, payloadProp])
  const [open, setOpen] = useState(true)
  const bodyId = useId()
  if (!payload) return null

  return (
    <div className={DIFF_CARD}>
      <button type="button" className={DIFF_HEAD} onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls={bodyId}>
        <span>变更预览</span>
        <span className={DIFF_COUNT}>{addedCount} additions · {removedCount} deletions</span>
      </button>
      <CollapsibleRegion open={open} id={bodyId}>
        <div className={DIFF_BODY}>
        {(() => {
          const rows: React.ReactNode[] = []
          for (let index = 0; index < payload.lines.length; index += 1) {
            const line = payload.lines[index]
            const next = payload.lines[index + 1]
            // 相邻 removed + added 对 → 词级 diff（CC 双层：整行背景 + 变更词背景）
            if (line.kind === 'removed' && next?.kind === 'added') {
              const segments = wordDiff(line.text, next.text)
              rows.push(
                <div className={`${DIFF_LINE} ${DIFF_LINE_BG.removed}`} key={`${index}-r`}>
                  <span className={`${DIFF_SIGN} ${DIFF_SIGN_TONE.removed}`}>-</span>
                  <WordSegments segments={segments.filter(s => s.kind !== 'added')} />
                </div>,
              )
              rows.push(
                <div className={`${DIFF_LINE} ${DIFF_LINE_BG.added}`} key={`${index}-a`}>
                  <span className={`${DIFF_SIGN} ${DIFF_SIGN_TONE.added}`}>+</span>
                  <WordSegments segments={segments.filter(s => s.kind !== 'removed')} />
                </div>,
              )
              index += 1
            } else {
              rows.push(<DiffLineRow line={line} key={`${index}-${line.kind}`} />)
            }
          }
          return rows
        })()}
        </div>
      </CollapsibleRegion>
    </div>
  )
}
