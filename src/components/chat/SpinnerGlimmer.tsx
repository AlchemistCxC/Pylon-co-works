import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { segmentGraphemes } from '../../utils/textWidth'
import { glimmerIntensity, resolveGlimmer } from './spinnerMachine'

interface SpinnerGlimmerProps {
  text: string
  /** P1-08：光扫时间由本组件持 tick 推进（热路径隔离到叶子） */
  running: boolean
  activity: 'active' | 'waiting' | 'stalled'
  reducedMotion: boolean
  color?: string
  cycleMs: number
}

export default function SpinnerGlimmer({ text, running, activity, reducedMotion, color, cycleMs }: SpinnerGlimmerProps) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setTick(value => value + 1), 120)
    return () => clearInterval(id)
  }, [running])
  const graphemes = useMemo(() => segmentGraphemes(text), [text])
  // CC 光扫状态机：±1 字符窗口（core + 两侧 edge）；elapsed = tick * 120 近似推进
  const { glimmerIndex } = resolveGlimmer(text, tick * 120, cycleMs)
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
