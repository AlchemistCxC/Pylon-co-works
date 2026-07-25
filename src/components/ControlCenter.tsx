import { useStore } from '../store'
import InputBar from './chat/InputBar'
import StatusBar from './chat/StatusBar'
import './ControlCenter.css'

interface Props { sessionId: string | null }

export default function ControlCenter({ sessionId }: Props) {
  const ccHeight = useStore(s => s.ccHeight) || 120
  const ccBgHeight = useStore(s => s.ccBgHeight ?? ccHeight)
  const inputMode = useStore(s => s.inputMode)

  return (
    <div className={`control-center ${inputMode === 'cli' ? 'cli-mode' : ''}`}
      style={{
        '--cc-height': `${ccHeight}px`,
        '--cc-bg-height': `${ccBgHeight}px`,
      } as React.CSSProperties}>
      <div className="cc-bg" />
      <div className="cc-body">
        <InputBar sessionId={sessionId} />
        {sessionId && <StatusBar />}
      </div>
    </div>
  )
}
