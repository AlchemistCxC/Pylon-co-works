import { useMemo, type CSSProperties } from 'react'
import { segmentGraphemes } from '../../utils/textWidth'

interface SpinnerGlimmerProps {
  text: string
  elapsedMs: number
  activity: 'active' | 'waiting' | 'stalled'
  reducedMotion: boolean
  color?: string
  cycleMs: number
}

export default function SpinnerGlimmer({ text, elapsedMs, activity, reducedMotion, color, cycleMs }: SpinnerGlimmerProps) {
  const graphemes = useMemo(() => segmentGraphemes(text), [text])
  const glimmerSpeedMs = Math.max(80, Math.floor(cycleMs / Math.max(1, graphemes.length + 20)))
  const cycleLength = graphemes.length + 20
  const cyclePosition = Math.floor((elapsedMs % cycleMs) / glimmerSpeedMs)
  const glimmerIndex = reducedMotion || activity !== 'active' || graphemes.length === 0
    ? -1
    : (cyclePosition % cycleLength) - 10

  return (
    <span className="spinner-verb" data-glimmer-active={glimmerIndex >= 0 ? 'true' : 'false'} style={{ '--spinner-glimmer-color': color || undefined } as CSSProperties}>
      {graphemes.map((grapheme, index) => {
        const distance = Math.abs(index - glimmerIndex)
        const intensity = distance === 0 ? 'core' : distance === 1 ? 'edge' : undefined
        return <span className={intensity ? `spinner-glimmer spinner-glimmer-${intensity}` : undefined} key={`${index}-${grapheme}`}>{grapheme}</span>
      })}
    </span>
  )
}
