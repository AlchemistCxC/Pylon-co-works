import { useRef, useEffect, useState, useMemo, useCallback } from 'react'
import React from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../../store'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { createStarryNight, all } from '@wooorm/starry-night'
import { toHtml } from 'hast-util-to-html'
import { AnimatePresence, motion } from 'motion/react'
import Anser from 'anser'
import './ChatView.css'

// ── Peri spinner ──
const IDIOMS = [
  '格物致知','见微知著','大道至简','慎思明辨','融会贯通','温故知新','举一反三',
  '水滴石穿','千里之行','厚积薄发','锲而不舍','知行合一','日拱一卒','功不唐捐','学以致用',
  '精益求精','大巧若拙','返璞归真','独具匠心','无中生有',
  '上善若水','海纳百川','虚怀若谷','心无旁骛','宁静致远','道法自然',
  // extra
  '聚沙成塔','积微成著','抽丝剥茧','庖丁解牛','百川归海','星火燎原','闻一知十',
  '窥斑见豹','穷工极巧','妙手偶得','含英咀华','钩深致远','探赜索隐','研精覃思',
]

function fmtTokens(n: number) {
  if (n >= 1000) { const k = n / 1000; return k >= 10 ? `${Math.round(k)}k` : `${k.toFixed(1)}k` }
  return `${n}`
}

function Spinner({ tokenCount, startTime }: { tokenCount: number; startTime: number }) {
  const frames = (useStore(s => s.sparkles) || '✳✴✵✶✷✸✹✺✻✼❃❊').split('')
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick(t => t + 1), 120)
    return () => clearInterval(id)
  }, [])
  const tickIdx = Math.floor((Date.now() - startTime) / 120)
  const frame = frames[tickIdx % frames.length]
  // Rotate idiom every 8 ticks (~1s)
  const idiom = IDIOMS[Math.floor(tickIdx / 8) % IDIOMS.length]
  const elapsed = Math.floor((Date.now() - startTime) / 1000)
  const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed/60)}m ${elapsed%60}s` : `${elapsed}s`
  const parts = [elapsedStr]
  if (tokenCount > 0) parts.push(`↓ ${fmtTokens(tokenCount)} tokens`)
  return (
    <div className="term-spinner">
      <span className="spinner-frame">{frame}</span>
      <span className="spinner-verb">{idiom}</span>
      <span className="spinner-meta">({parts.join(' · ')})</span>
    </div>
  )
}

// ── starry-night ──
let snPromise: ReturnType<typeof createStarryNight> | null = null
function getStarryNight() { if (!snPromise) snPromise = createStarryNight(all); return snPromise }

interface Props { sessionId: string | null }

interface Message {
  id: string; role: 'user' | 'assistant' | 'tool' | 'reasoning'
  sender: string; content: string; time: string
  toolName?: string; toolInput?: string; toolOutput?: string
  toolOutputLines?: number; running?: boolean
}

const ChatView = React.memo(function ChatView({ sessionId }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [generating, setGenerating] = useState(false)
  const genStart = useRef(Date.now())
  const tokenCount = useRef(0)
  const [summary, setSummary] = useState('')
  const sessionRef = useRef<string | null>(null)
  const prevSessionRef = useRef(sessionId)
  useEffect(() => {
    const s = useStore.getState().sessions.find(s => s.id === sessionId)
    sessionRef.current = s?.source || null
    if (sessionId && sessionId !== prevSessionRef.current) { setMessages([]); setGenerating(false); setSummary('') }
    prevSessionRef.current = sessionId
  }, [sessionId])

  useEffect(() => {
    const unlisten = Promise.all([
      listen<{ source: string; content: string }>('peri:user', (event) => {
        if (event.payload.source !== sessionRef.current) return
        const { source, content } = event.payload
        // Auto-name: if session name is still default ID, use first 30 chars
        const sessions = useStore.getState().sessions
        const s = sessions.find(s => s.source === source)
        if (s?.name.startsWith('session-')) {
          const autoName = content.slice(0, 30)
          const updated = sessions.map(ss => ss.id === s.id ? { ...ss, autoName, name: autoName } : ss)
          useStore.setState({ sessions: updated })
          localStorage.setItem('pylon-sessions', JSON.stringify(updated))
        }
        // Clear running flags on all previous messages
        setMessages(prev => prev.map(m => ({ ...m, running: false })))
        setGenerating(true); genStart.current = Date.now(); tokenCount.current = 0; setSummary('')
        setMessages(prev => [...prev, {
          id: 'user-' + Date.now(), role: 'user', sender: source,
          content, time: new Date().toLocaleTimeString()
        }])
      }),

      listen<any>('peri:update', (event) => {
        if (event.payload.source !== sessionRef.current) return
        const upd = event.payload?.update
        if (!upd) return
        const variant = upd.sessionUpdate
        switch (variant) {
          case 'agent_message_chunk': {
            const text = upd.content?.text || ''
            if (!text) return
            setMessages(prev => {
              const last = prev[prev.length - 1]
              if (last?.role === 'assistant' && last.running) {
                return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: m.content + text } : m)
              }
              return [...prev, {
                id: 'msg-' + Date.now(), role: 'assistant', sender: 'peri',
                content: text, time: new Date().toLocaleTimeString(), running: true
              }]
            })
            break
          }
          case 'agent_thought_chunk': {
            const text = upd.content?.text || ''
            if (!text) return
            setMessages(prev => {
              const last = prev[prev.length - 1]
              if (last?.role === 'reasoning' && last.running) {
                return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: m.content + text } : m)
              }
              return [...prev, {
                id: 'thought-' + Date.now(), role: 'reasoning', sender: 'peri',
                content: text, time: new Date().toLocaleTimeString(), running: true
              }]
            })
            break
          }
          case 'tool_call': {
            const rawInput = upd.rawInput
            const inputStr = formatToolInput(upd.title, rawInput) || (typeof rawInput === 'string' ? rawInput.slice(0, 80) : '')
            setMessages(prev => [...prev, {
              id: 'tool-' + upd.toolCallId, role: 'tool', sender: 'tool:' + (upd.title || '?'),
              content: '', time: new Date().toLocaleTimeString(),
              toolName: upd.title,
              toolInput: inputStr,
              running: true
            }])
            break
          }
          case 'tool_call_update': {
            const rawOutput = upd.rawOutput
            const outputStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2)
            const lines = outputStr ? outputStr.split(/\n/).filter((l: string) => l.trim()).length : 0
            setMessages(prev => prev.map(m => {
              if (m.id === 'tool-' + upd.toolCallId && m.running) {
                return { ...m, toolOutput: outputStr, toolOutputLines: lines, running: false }
              }
              return m
            }))
            break
          }
          case 'usage_update': {
            console.log('[usage_update]', upd.value, upd.size)
            const used = upd.value || (upd._meta?.inputTokens || 0) + (upd._meta?.outputTokens || 0)
            const max = upd.size || 131072
            tokenCount.current = used
            useStore.getState().setLiveStats({
              liveTokensUsed: used,
              liveTokensMax: max,
              liveCacheHit: upd._meta?.cacheReadTokens || 0,
            })
            break
          }
          case 'available_commands_update': {
            const commands = upd.commands || []
            useStore.getState().setLiveStats({ liveCommands: commands } as any)
            break
          }
        }
      }),

      listen<any>('peri:done', (event) => {
        if (event.payload.source !== sessionRef.current) return
        const elapsed = Math.floor((Date.now() - genStart.current) / 1000)
        const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed/60)}m ${elapsed%60}s` : `${elapsed}s`
        setSummary(`✻  处理耗时 ${elapsedStr}`)
        setGenerating(false)
        setMessages(prev => prev.map(m => ({ ...m, running: false })))
      }),

      listen<any>('peri:error', (event) => {
        setGenerating(false)
        setMessages(prev => [...prev, {
          id: 'err-' + Date.now(), role: 'assistant', sender: 'system',
          content: '\u26a0\ufe0f ' + event.payload, time: new Date().toLocaleTimeString()
        }])
      }),

      // /clear listener (not a promise — outside Promise.all)
    ])

    const handleClear = () => { setMessages([]); setSummary('') }
    window.addEventListener('peri:clear', handleClear)

    return () => {
      unlisten.then(fns => fns.forEach(f => f()))
      window.removeEventListener('peri:clear', handleClear)
    }
  }, [])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, generating])

  if (!sessionId) return (
    <div className="chat-empty">
      <div className="empty-icon">◆</div>
      <div className="empty-title">Pylon</div>
      <div className="empty-sub">选择一个会话开始</div>
    </div>
  )

  return (
    <div className="chat-view">
      <div className="term">
        <AnimatePresence initial={false}>
          {messages.map((msg) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
            >
              {msg.role === 'tool' && <ToolCard name={msg.toolName!} input={msg.toolInput} output={msg.toolOutput} outputLines={msg.toolOutputLines} />}
              {msg.role === 'user' && <UserLine sender={msg.sender} content={msg.content} />}
              {msg.role === 'reasoning' && <ReasoningBlock text={msg.content} />}
              {msg.role === 'assistant' && <AssistantContent text={msg.content} />}
            </motion.div>
          ))}
        </AnimatePresence>
        {generating && <Spinner tokenCount={tokenCount.current} startTime={genStart.current} />}
        {!generating && summary && <div className="term-summary">{summary}</div>}
        <div ref={bottomRef} />
      </div>
      <button className="scroll-bottom-btn" onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
        style={{ opacity: messages.length > 4 ? 1 : 0 }}>↓</button>
    </div>
  )
})

// ── Sub-components ──


function AssistantContent({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="term-assistant">
      <button className="copy-btn" onClick={copy}>{copied ? '✓' : '⎘'}</button>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        code({ className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '')
          const code = String(children).replace(/\n$/, '')
          if (match) return <CodeBlock language={match[1]} code={code} />
          return <code className="term-inline-code" {...props}>{children}</code>
        },
        a({ href, children }) { return <a href={href} target="_blank" rel="noopener" className="term-link">{children}</a> },
        blockquote({ children }) { return <blockquote className="term-blockquote">{children}</blockquote> },
        table({ children }) { return <div className="term-table-wrap"><table className="term-table">{children}</table></div> },
      }}>{text}</ReactMarkdown>
    </div>
  )
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [html, setHtml] = useState('')
  useEffect(() => {
    let cancelled = false
    getStarryNight().then(sn => {
      if (cancelled) return
      const scope = language ? sn.flagToScope(language) : undefined
      const tree = sn.highlight(code, scope || '')
      setHtml(toHtml(tree))
    })
    return () => { cancelled = true }
  }, [language, code])
  return html ? <div className="term-code" dangerouslySetInnerHTML={{ __html: html }} /> : <div className="term-code"><pre><code>{code}</code></pre></div>
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="term-reasoning">
      <div className="term-reasoning-head" onClick={() => setOpen(!open)}>Thought for {text.length} chars</div>
      {open && <div className="term-reasoning-body">{text.split('\n').map((line, i) => <div key={i} className="term-reasoning-line">{line || '\u00a0'}</div>)}</div>}
    </div>
  )
}

function formatToolInput(name: string, rawInput: any): string {
  if (typeof rawInput !== 'object' || !rawInput) return ''
  // Extract the most meaningful field per tool type
  if (name === 'Bash') return rawInput.command || rawInput.cmd || ''
  if (name === 'Read' || name === 'Write' || name === 'Edit') return rawInput.path || rawInput.file_path || rawInput.filePath || ''
  if (name === 'Grep' || name === 'Glob') return rawInput.pattern || rawInput.regex || rawInput.glob || ''
  if (name === 'Task') return rawInput.description || rawInput.prompt || rawInput.goal || ''
  // Fallback: show first meaningful string value
  for (const v of Object.values(rawInput)) {
    if (typeof v === 'string' && v.length > 0 && v.length < 200) return v
  }
  return ''
}

function ToolCard({ name, input, output, outputLines }: { name: string; input?: string; output?: string; outputLines?: number }) {
  const [open, setOpen] = useState(false)
  const indicator = useStore(s => s.toolIndicator) || '●'
  const done = !!output
  const status = done ? 'ok' : 'run'
  let suffix = ''
  if (done && outputLines !== undefined && outputLines > 0) {
    if (name === 'Grep' || name === 'Glob') suffix = ` — ${outputLines} matches`
    else if (name === 'Read') suffix = ` — ${outputLines} lines`
    else if (name === 'Edit' || name === 'Write') suffix = ` — ${outputLines} lines changed`
  }
  const outputHtml = useMemo(() => {
    if (!output || name !== 'Bash') return ''
    return new Anser().ansiToHtml(output)
  }, [output, name])
  return (
    <div className="term-tool">
      <div className="term-tool-head" onClick={() => setOpen(!open)}>
        <span className={`term-tool-indicator ${status}`}>{indicator}</span>
        <span className="term-tool-name">{name}</span>
        {input && <span className="term-tool-summary"> ({input.length > 60 ? input.slice(0, 60) + '...' : input})</span>}
        {suffix && <span className="term-tool-suffix">{suffix}</span>}
      </div>
      {open && output && (
        <div className="term-tool-body">
          {name === 'Bash' && outputHtml
            ? <div className="term-ansi" dangerouslySetInnerHTML={{ __html: outputHtml }} />
            : <pre><code>{output}</code></pre>}
        </div>
      )}
    </div>
  )
}

function UserLine({ sender, content }: { sender: string; content: string }) {
  const getUser = useStore(s => s.getUser)
  const storeUser = useStore(s => s.userName)
  const prefix = useStore(s => s.userPrefix) || '❯'
  const userColor = useStore(s => s.userColor)
  const user = getUser(sender)
  const name = storeUser || user?.name || sender.replace(/^.*:/, '')
  return (
    <div className="term-user">
      <span className="term-user-prefix" style={userColor ? { color: userColor } : {}}>{prefix}</span>
      <span className="term-user-name" style={userColor ? { color: userColor } : {}}>{name}</span>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  )
}

export default ChatView
