import { useMemo, type CSSProperties } from 'react'
import { segmentGraphemes } from '../../utils/textWidth'
import { glimmerIntensity, resolveGlimmer } from './spinnerMachine'

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
  // CC 光扫状态机：±1 字符窗口（core + 两侧 edge）
  const { glimmerIndex } = resolveGlimmer(text, elapsedMs, cycleMs)
  const activeIndex = reducedMotion || activity !== 'active' || graphemes.length === 0
    ? -1
    : glimmerIndex

  return (
    <span className="spinner-verb" data-glimmer-active={activeIndex >= 0 ? 'true' : 'false'} style={{ '--spinner-glimmer-color': color || undefined } as CSSProperties}>
      {graphemes.map((grapheme, index) => {
        const intensity = glimmerIntensity(index, activeIndex)
        const cls = intensity === 2 ? 'core' : intensity === 1 ? 'edge' : undefined
        return <span className={cls ? `spinner-glimmer spinner-glimmer-${cls}` : undefined} key={`${index}-${grapheme}`}>{grapheme}</span>
      })}
    </span>
  )
}
