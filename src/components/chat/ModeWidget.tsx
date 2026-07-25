import { useStore } from '../../store'

const MODES = ['default', 'edit', 'auto', 'bypass'] as const

export default function ModeWidget() {
  const mode = useStore(s => s.liveMode) || 'auto'

  const cycle = () => {
    const idx = MODES.indexOf(mode as typeof MODES[number])
    const next = MODES[(idx + 1) % MODES.length]
    useStore.getState().setLiveStats({ liveMode: next })
  }

  return (
    <div className="cc-mode-widget" onClick={e => { e.stopPropagation(); cycle() }}>
      <span className="mode-label">{mode}</span>
      <span className="mode-cycle">↻</span>
    </div>
  )
}
