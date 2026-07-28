import { useEffect, useState } from 'react'
import { Square } from 'lucide-react'
import { frameAt } from './spinnerFrames'

const IDIOMS = [
  '格物致知','见微知著','大道至简','慎思明辨','融会贯通','温故知新','举一反三',
  '水滴石穿','千里之行','厚积薄发','锲而不舍','知行合一','日拱一卒','功不唐捐','学以致用',
  '精益求精','大巧若拙','返璞归真','独具匠心','无中生有','上善若水','海纳百川','虚怀若谷','心无旁骛','宁静致远','道法自然',
]

export interface GenerationSummary {
  elapsedMs: number
  tokenCount: number
  completedFrame: string
  reason: 'done' | 'cancelled'
}

function formatElapsed(elapsedMs: number) {
  const elapsed = Math.floor(elapsedMs / 1000)
  return elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`
}

function formatTokens(n: number) {
  if (n >= 1000) { const k = n / 1000; return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k` }
  return `${n}`
}

export default function GenerationFooter({ running, frames, tokenCount, startTime, summary, onStop }: {
  running: boolean
  frames: string[]
  tokenCount: number
  startTime: number
  summary: GenerationSummary | null
  onStop?: () => void
}) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => tick(value => value + 1), 120)
    return () => clearInterval(id)
  }, [running])

  if (running) {
    const elapsedMs = Date.now() - startTime
    const tickIdx = Math.floor(elapsedMs / 120)
    const parts = [formatElapsed(elapsedMs)]
    if (tokenCount > 0) parts.push(`↓ ${formatTokens(tokenCount)} tokens`)
    return (
      <div className="term-spinner-row">
        <div className="term-spinner">
          <span className="spinner-frame">{frameAt(frames, elapsedMs)}</span>
          <span className="spinner-verb">{IDIOMS[Math.floor(tickIdx / 8) % IDIOMS.length]}</span>
          <span className="spinner-meta">({parts.join(' · ')})</span>
        </div>
        {onStop && <button className="spinner-stop-btn" title="停止生成 (Esc / Ctrl+C)" onClick={onStop}>
          <Square size={11} /> 停止
        </button>}
      </div>
    )
  }

  if (!summary) return null
  return (
    <div className={`term-summary term-summary-${summary.reason}`}>
      <span className="term-summary-frame">{summary.completedFrame}</span>
      <span>{summary.reason === 'cancelled' ? '已停止' : '处理耗时'} {formatElapsed(summary.elapsedMs)}</span>
    </div>
  )
}
