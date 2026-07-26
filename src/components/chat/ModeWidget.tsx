import { useStore } from '../../store'
import { invoke } from '@tauri-apps/api/core'

const MODES = ['default', 'edit', 'auto', 'bypass'] as const

/**
 * modeVariant 取值：
 *   - 'pill'    : 圆角胶囊背景，点击循环切模式（默认）
 *   - 'badge'   : 方括号包裹 [mode]
 *   - 'minimal' : 纯文本，仅颜色区分
 */
interface Props { sessionSource?: string }

export default function ModeWidget({ sessionSource }: Props) {
  const variant = useStore(s => s.modeVariant) || 'pill'
  const mode = useStore(s => s.liveMode) || 'auto'

  const cycle = () => {
    const idx = MODES.indexOf(mode as typeof MODES[number])
    const next = MODES[(idx + 1) % MODES.length]
    useStore.getState().setLiveStats({ liveMode: next })
    if (sessionSource) invoke('set_mode', { source: sessionSource, mode: next }).catch(() => {})
  }

  if (variant === 'badge') {
    return (
      <span className="cc-mode-badge" data-mode={mode} onClick={e => { e.stopPropagation(); cycle() }} title="点击切换">
        [{mode}]
      </span>
    )
  }

  if (variant === 'minimal') {
    return (
      <span className="cc-mode-minimal" data-mode={mode} onClick={e => { e.stopPropagation(); cycle() }}>
        {mode}
      </span>
    )
  }

  // default: 'pill'
  return (
    <div className="cc-mode-widget" onClick={e => { e.stopPropagation(); cycle() }} title="点击切换">
      <span className="mode-pill" data-mode={mode}>{mode}</span>
    </div>
  )
}