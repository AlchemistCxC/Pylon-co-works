import { useId, useMemo, useState } from 'react'
import { normalizeDiffPayload } from './diffPresentation'
import './DiffCard.css'

export default function DiffCard({ output }: { output: string }) {
  // payload 解析（含 JSON.parse）与计数都是 output 的纯函数：只在 output 变化时重算
  const { payload, addedCount, removedCount } = useMemo(() => {
    const parsed = normalizeDiffPayload(output)
    return {
      payload: parsed,
      addedCount: parsed ? parsed.lines.filter(line => line.kind === 'added').length : 0,
      removedCount: parsed ? parsed.lines.filter(line => line.kind === 'removed').length : 0,
    }
  }, [output])
  const [open, setOpen] = useState(true)
  const bodyId = useId()
  if (!payload) return null

  return (
    <div className="term-diff-card">
      <button type="button" className="term-diff-head" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls={bodyId}>
        <span>变更预览</span>
        <span className="term-diff-count">{addedCount} additions · {removedCount} deletions</span>
      </button>
      {open && <div className="term-diff-body" id={bodyId}>
        {payload.lines.map((line, index) => (
          <div className={`term-diff-line term-diff-${line.kind}`} key={`${index}-${line.kind}`}>
            <span className="term-diff-sign">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}</span>
            <code>{line.text || '\u00a0'}</code>
          </div>
        ))}
      </div>}
    </div>
  )
}