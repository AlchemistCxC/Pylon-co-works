import { useStore } from '../../store'
import { invoke } from '@tauri-apps/api/core'

const MODES = ['default', 'edit', 'auto', 'bypass'] as const

interface Props { sessionSource?: string }

export default function ModeWidget({ sessionSource }: Props) {
  const mode = useStore(s => s.liveMode) || 'auto'

  const cycle = () => {
    const idx = MODES.indexOf(mode as typeof MODES[number])
    const next = MODES[(idx + 1) % MODES.length]
    useStore.getState().setLiveStats({ liveMode: next })
    if (sessionSource) invoke('set_mode', { source: sessionSource, mode: next }).catch(() => {})
  }

  return (
    <div className="cc-mode-widget" onClick={e => { e.stopPropagation(); cycle() }}>
      <span className="mode-label" data-mode={mode}>{mode}</span>
      <span className="mode-cycle">↻</span>
    </div>
  )
}
