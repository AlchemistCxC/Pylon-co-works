import { useId, useState } from 'react'
import { normalizeDiffPayload } from './diffPresentation'
import './DiffCard.css'

export default function DiffCard({ output }: { output: string }) {
  const payload = normalizeDiffPayload(output)
  const [open, setOpen] = useState(true)
  const bodyId = useId()
  if (!payload) return null

  return (
    <div className="term-diff-card">
      <button type="button" className="term-diff-head" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls={bodyId}>
        <span>变更预览</span>
        <span className="term-diff-count">{payload.lines.filter(line => line.kind === 'added').length} additions · {payload.lines.filter(line => line.kind === 'removed').length} deletions</span>
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