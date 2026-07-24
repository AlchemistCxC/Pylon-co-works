import { useRef, useEffect, useState } from 'react'
import { useStore } from '../../store'
import './ChatView.css'

interface Props { sessionId: string | null }

interface Message {
  id: string; role: 'user' | 'assistant' | 'tool'
  sender: string; content: string; time: string
  toolName?: string; toolInput?: string; toolOutput?: string
}

const messages: Message[] = [
  { id:'1', role:'user', sender:'qq:user:14CE', content:'帮我查下 Prism 的日志', time:'10:32' },
  { id:'2', role:'assistant', sender:'assistant:Riccati', content:'等一下，帮你查', time:'10:32:05' },
  { id:'2a',role:'tool', sender:'tool:read_file', content:'', time:'10:32:06',
    toolName:'read_file', toolInput:'/tmp/prism.log',
    toolOutput:'1| [2026-07-23 10:30] INFO Starting Prism v3\n2| [2026-07-23 10:31] ERROR connection refused\n...' },
  { id:'3', role:'assistant', sender:'assistant:Riccati',
    content:'找到 3 个匹配项：\n\n## 错误日志\n\n```bash\n$ grep error /tmp/prism.log\nfound 3 matches\n```\n\n- `connection refused`\n- `timeout`\n- `panic`',
    time:'10:32:08' },
  { id:'4', role:'user', sender:'qq:user:14CE', content:'好，看到了', time:'10:33' },
  { id:'5', role:'user', sender:'qq:user:self', content:'帮我看看 **那个错误**', time:'10:34' },
]

function ToolCard({ name, input, output }: { name:string; input?:string; output?:string }) {
  const [open, setOpen] = useState(false)
  const status = output ? 'ok' : 'run'
  return (
    <div className="term-tool">
      <div className="term-tool-head" onClick={() => setOpen(!open)}>
        <span className={`term-tool-indicator ${status}`}>●</span>
        <span className="term-tool-name">{name}</span>
        {input && <span className="term-tool-summary"> ({input.length > 60 ? input.slice(0,60)+'...' : input})</span>}
      </div>
      {open && output && (
        <div className="term-tool-body">
          <span className="term-tool-label">Output</span>
          <pre><code>{output}</code></pre>
        </div>
      )}
    </div>
  )
}

function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const els: JSX.Element[] = []
  let i = 0, key = 0, codeBuf: string[] = []

  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('```')) {
      codeBuf = []; i++
      while (i < lines.length && !lines[i].startsWith('```')) { codeBuf.push(lines[i]); i++ }
      i++
      els.push(<div key={++key} className="term-code"><pre><code>{codeBuf.join('\n')}</code></pre></div>)
      continue
    }
    if (line.startsWith('## ')) { els.push(<h3 key={++key} className="term-h3">{line.slice(3)}</h3>); i++; continue }
    if (line.startsWith('# ')) { els.push(<h2 key={++key} className="term-h2">{line.slice(2)}</h2>); i++; continue }
    if (line.match(/^[\-\*] /)) { els.push(<li key={++key} className="term-li">{inline(line.replace(/^[\-\*] /, ''))}</li>); i++; continue }
    if (line.trim() === '') { els.push(<br key={++key}/>); i++; continue }
    els.push(<p key={++key} className="term-p">{inline(line)}</p>); i++
  }
  return <>{els}</>
}

function inline(text: string): React.ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((p, i) => {
    if (p.startsWith('`') && p.endsWith('`')) return <code key={i} className="term-inline-code">{p.slice(1,-1)}</code>
    if (p.startsWith('**') && p.endsWith('**')) return <strong key={i}>{p.slice(2,-2)}</strong>
    return <span key={i}>{p}</span>
  })
}

export default function ChatView({ sessionId }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:'smooth' }) }, [messages])

  if (!sessionId) return (
    <div className="chat-empty">
      <div className="empty-icon">◆</div>
      <div className="empty-title">Prism Desktop</div>
      <div className="empty-sub">选择一个会话开始</div>
    </div>
  )

  return (
    <div className="chat-view">
      <div className="term">
        {messages.map(msg => msg.role === 'tool' ? (
          <ToolCard key={msg.id} name={msg.toolName!} input={msg.toolInput} output={msg.toolOutput} />
        ) : msg.role === 'user' ? (
          <UserLine key={msg.id} sender={msg.sender} content={msg.content} />
        ) : (
          <div key={msg.id} className="term-assistant"><Markdown text={msg.content}/></div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function UserLine({ sender, content }: { sender:string; content:string }) {
  const getUser = useStore(s => s.getUser)
  const user = getUser(sender)
  const name = user?.name || sender.replace(/^.*:/, '')
  return (
    <div className="term-user">
      <span className="term-user-tag">{name}&gt;</span>
      <Markdown text={content}/>
    </div>
  )
}
