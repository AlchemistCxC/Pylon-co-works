import { useState } from 'react'
import { useStore } from '../../store'

interface Props {
  role: 'user' | 'assistant'
  sender: string          // openid: "qq:user:14CE" or "assistant:Riccati"
  content: string
  time: string
}

export default function MessageBubble({ role, sender, content, time }: Props) {
  const isSelf = role === 'user'
  const [expanded, setExpanded] = useState(false)
  const getUser = useStore(s => s.getUser)
  const user = sender.startsWith('qq:') || sender.startsWith('terminal:')
    ? getUser(sender)
    : undefined

  const displayName = user?.name || sender.replace(/^.*:/, '')
  const avatar = user?.avatar

  const parts = content.split(/(```[\s\S]*?```)/g)

  return (
    <div className={`bubble-row ${isSelf ? 'self' : 'assistant'}`}>
      <div className={`bubble ${isSelf ? 'bubble-self' : 'bubble-assistant'}`}>
        <div className="bubble-header">
          {avatar
            ? <div className="bubble-avatar"><img src={avatar} alt={displayName}/></div>
            : <div className="bubble-avatar no-img">{displayName[0]}</div>
          }
          <span className="bubble-sender">{displayName}</span>
          <span className="bubble-time">{time}</span>
        </div>
        <div className="bubble-body">
          {parts.map((part, i) => {
            if (part.startsWith('```')) {
              const code = part.replace(/```\w*\n?/, '').replace(/```$/, '')
              const lines = code.split('\n')
              const preview = lines.slice(0, expanded ? lines.length : 8).join('\n')
              return (
                <div key={i} className="code-block">
                  <div className="code-header">
                    <span className="code-lang">code</span>
                    <button className="code-copy" onClick={() => navigator.clipboard.writeText(code)}>Copy</button>
                  </div>
                  <pre><code>{preview}</code></pre>
                  {!expanded && lines.length > 8 && (
                    <button className="code-expand" onClick={() => setExpanded(true)}>
                      Show all ({lines.length} lines)
                    </button>
                  )}
                </div>
              )
            }
            return <p key={i} className="bubble-text">{part}</p>
          })}
        </div>
      </div>
    </div>
  )
}
