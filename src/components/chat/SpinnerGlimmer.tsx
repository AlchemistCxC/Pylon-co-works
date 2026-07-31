import { useMemo, type CSSProperties } from 'react'

interface SpinnerGlimmerProps {
  text: string
  elapsedMs: number
  activity: 'active' | 'waiting' | 'stalled'
  reducedMotion: boolean
  color?: string
  cycleMs: number
}

function splitGraphemes(value: string): string[] {
  type SegmenterConstructor = new (
    locales?: string | string[],
    options?: Intl.SegmenterOptions,
  ) => Intl.Segmenter

  const Segmenter = (Intl as typeof Intl & { Segmenter?: SegmenterConstructor }).Segmenter
  if (Segmenter) return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(value), item => item.segment)
  return Array.from(value)
}

export default function SpinnerGlimmer({ text, elapsedMs, activity, reducedMotion, color, cycleMs }: SpinnerGlimmerProps) {
  const graphemes = useMemo(() => splitGraphemes(text), [text])
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
