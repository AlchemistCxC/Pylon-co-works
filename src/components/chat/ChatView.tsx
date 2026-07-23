import { useRef, useEffect } from 'react'
import MessageBubble from './MessageBubble'
import './ChatView.css'

interface Props { sessionId: string | null }

const messages = [
  { id: '1', role: 'user' as const, sender: '访客 14CE', content: '帮我查下 Prism 的日志', time: '10:32' },
  { id: '2', role: 'assistant' as const, sender: 'Riccati', content: '等一下，帮你查\n\n```bash\n$ grep error /tmp/prism.log\nfound 3 matches\n```', time: '10:32:05' },
  { id: '3', role: 'user' as const, sender: '访客 14CE', content: '好，看到了', time: '10:33' },
]

export default function ChatView({ sessionId }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  if (!sessionId) return (
    <div className="chat-empty">
      <div className="empty-icon">◆</div>
      <div className="empty-title">Prism Desktop</div>
      <div className="empty-sub">选择一个会话开始</div>
    </div>
  )

  return (
    <div className="chat-view">
      <div className="chat-toolbar">
        <button className="toolbar-btn">Prism: ON</button>
        <button className="toolbar-btn">v4-flash</button>
      </div>
      <div className="chat-messages">
        {messages.map(msg => <MessageBubble key={msg.id} {...msg} />)}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
