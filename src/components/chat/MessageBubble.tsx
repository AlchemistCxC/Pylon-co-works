import { useState } from 'react'
import './MessageBubble.css'

interface Props {
  role: 'user' | 'assistant'
  sender: string
  content: string
  time: string
}

export default function MessageBubble({ role, sender, content, time }: Props) {
  const isUser = role === 'user'
  const [expanded, setExpanded] = useState(false)

  // 简单的 markdown 解析：代码块
  const parts = content.split(/(```[\s\S]*?```)/g)

  return (
    <div className={`bubble-row ${isUser ? 'user' : 'assistant'}`}>
      <div className={`bubble ${isUser ? 'bubble-user' : 'bubble-assistant'}`}>
        <div className="bubble-header">
          <span className="bubble-sender">{sender}</span>
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
                    <span className="code-lang">bash</span>
                    <button className="code-copy" onClick={() => navigator.clipboard.writeText(code)}>复制</button>
                  </div>
                  <pre><code>{preview}</code></pre>
                  {!expanded && lines.length > 8 && (
                    <button className="code-expand" onClick={() => setExpanded(true)}>
                      展开全部 ({lines.length} 行)
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
