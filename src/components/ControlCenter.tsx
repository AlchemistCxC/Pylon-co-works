import { useStore } from '../store'
import InputBar from './chat/InputBar'
import StatusBar from './chat/StatusBar'
import './ControlCenter.css'

interface Props { sessionId: string | null }

export default function ControlCenter({ sessionId }: Props) {
  const ccHeight = useStore(s => s.ccHeight) || 120
  const ccBgHeight = useStore(s => s.ccBgHeight ?? ccHeight)
  const inputMode = useStore(s => s.inputMode)
  const layout = useStore(s => s.ccLayout || ['input', 'context', 'model', 'mode'])
  const hidden = useStore(s => s.ccHidden || [])

  const renderWidget = (id: string) => {
    if (hidden.includes(id)) return null
    switch (id) {
      case 'input': return <InputBar key="input" sessionId={sessionId} />
      case 'context': return sessionId ? <StatusBar key="context" /> : null
      case 'model': return null  // placeholder
      case 'mode': return null   // placeholder
      default: return null
    }
  }

  return (
    <div className={`control-center ${inputMode === 'cli' ? 'cli-mode' : ''}`}
      style={{
        '--cc-height': `${ccHeight}px`,
        '--cc-bg-height': `${ccBgHeight}px`,
      } as React.CSSProperties}>
      <div className="cc-bg" />
      <div className="cc-body">
        {layout.map(renderWidget)}
      </div>
    </div>
  )
}
