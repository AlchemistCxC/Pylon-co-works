import { useStore } from '../../store'
import { setSessionMode } from './sessionMode'
import { nextSessionMode } from './sessionModeState'

/**
 * modeVariant 取值：
 *   - 'pill'    : 圆角胶囊背景，点击循环切模式（默认）
 *   - 'badge'   : 方括号包裹 [mode]
 *   - 'minimal' : 纯文本，仅颜色区分
 */
interface Props { sessionSource?: string }

export default function ModeWidget({ sessionSource }: Props) {
  const variant = useStore(s => s.modeVariant) || 'pill'
  const ccScale = useStore(s => (s.ccScale || {})['mode'] ?? 100)
  const mode = useStore(s => sessionSource ? (s.sessionModes[sessionSource] || 'auto') : 'auto')

  const cycle = () => {
    const next = nextSessionMode(mode)
    if (sessionSource) {
      setSessionMode(sessionSource, next).catch(error => {
        window.dispatchEvent(new CustomEvent('pylon:mode-error', { detail: String(error) }))
      })
    }
  }

  if (variant === 'badge') {
    return (
      <button className="cc-mode-badge" type="button" data-mode={mode} onClick={e => { e.stopPropagation(); cycle() }} title="点击切换"
        style={{ fontSize: `${ccScale}%` }}>
        [{mode}]
      </button>
    )
  }

  if (variant === 'minimal') {
    return (
      <button className="cc-mode-minimal" type="button" data-mode={mode} onClick={e => { e.stopPropagation(); cycle() }} style={{ fontSize: `${ccScale}%` }}>
        {mode}
      </button>
    )
  }

  // default: 'pill'
  return (
    <button className="cc-mode-widget" type="button" onClick={e => { e.stopPropagation(); cycle() }} title="点击切换" style={{ fontSize: `${ccScale}%` }}>
      <span className="mode-pill" data-mode={mode}>{mode}</span>
    </button>
  )
}