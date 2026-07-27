import { useRef, useEffect, useState, useMemo } from 'react'
import React from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../../store'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AnimatePresence, motion } from 'motion/react'
import Anser from 'anser'
import { Square } from 'lucide-react'
import { toHtml } from 'hast-util-to-html'
import { resolveLoadedMessages, serializeLoadedMessages, shouldStartLiveGeneration } from './replayState'
import { canPersistMessages } from './messagePersistence'
import { addGeneratingSource, removeGeneratingSource, updateSourceState } from './sessionEventState'
import { resolveToolVisualStatus } from './toolStatus'
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

/**
 * 从后端 configOptions 里提取 model 选项。
 * 实测 Peri 真实结构（2026-07）：
 *   { id:'model', type:'select', currentValue:'sonnet', options:[{id,name},...] }
 * 仍保留 key/value/choices 等兜底字段以防协议演进。
 */
function extractModelConfig(configOptions: any): { model?: string; models?: string[] } {
  if (!Array.isArray(configOptions)) return {}
  const opt = configOptions.find((o: any) => (o?.id || o?.key || o?.name) === 'model')
  if (!opt) return {}
  const model = opt.currentValue ?? opt.value ?? opt.current ?? opt.selected
  const rawList = opt.options ?? opt.choices ?? opt.values ?? opt.available
  let models: string[] | undefined
  if (Array.isArray(rawList)) {
    // 值用 id（后端以 id 匹配），字符串项直接用
    models = rawList.map((c: any) => (typeof c === 'string' ? c : (c?.id ?? c?.value ?? c?.name))).filter(Boolean)
  }
  return { model, models }
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

interface Props { sessionId: string | null }

interface Message {
  id: string; role: 'user' | 'assistant' | 'tool' | 'reasoning'
  sender: string; content: string; time: string
  toolName?: string; toolInput?: string; toolOutput?: string
  toolOutputLines?: number; running?: boolean
  toolStatus?: string
}

// dev/浏览器 mock：无 Tauri 后端时（预览调样式用）展示的演示对话
const IS_TAURI = typeof (window as any).__TAURI_INTERNALS__ !== 'undefined' || typeof (window as any).__TAURI__ !== 'undefined'
const MOCK_MESSAGES: Message[] = [
  { id: 'm1', role: 'user', sender: 'local:demo', content: '帮我看看 main.ts 有没有类型错误', time: '10:24' },
  { id: 'm2', role: 'reasoning', sender: 'peri', content: '先读源码定位类型问题，再跑一次 build 验证，然后修正。', time: '10:24' },
  { id: 'm3', role: 'tool', sender: 'tool:Read', content: '', toolName: 'Read', toolInput: 'src/main.ts', toolOutput: 'export function main(url: string) {\n  const r = await fetch(url)\n  return r.json()\n}', toolOutputLines: 4, time: '10:24' },
  { id: 'm4', role: 'tool', sender: 'tool:Grep', content: '', toolName: 'Grep', toolInput: 'async', toolOutput: 'src/main.ts:2:  const r = await fetch(url)', toolOutputLines: 1, time: '10:24' },
  { id: 'm5', role: 'tool', sender: 'tool:Edit', content: '', toolName: 'Edit', toolInput: 'src/main.ts', toolOutput: 'async function main', toolOutputLines: 1, time: '10:24' },
  { id: 'm6', role: 'assistant', sender: 'peri', content: '找到问题了：`main` 用了 `await` 却没标 `async`。\n\n```ts\nexport async function main(url: string) {\n  const r = await fetch(url)\n  return r.json()\n}\n```\n\n已修正，`build` 通过。', time: '10:25' },
]

const ChatView = React.memo(function ChatView({ sessionId }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [messages, setMessages] = useState<Message[]>(!IS_TAURI ? MOCK_MESSAGES : [])
  const [generating, setGenerating] = useState(false)
  const genStart = useRef(Date.now())
  const tokenCount = useRef(0)
  const [summary, setSummary] = useState('')
  const sessionRef = useRef<string | null>(null)
  const messageOwnerRef = useRef<string | null>(null)
  const messagesBySourceRef = useRef<Record<string, Message[]>>({})
  const generationStartRef = useRef<Record<string, number>>({})
  const replayingSourcesRef = useRef<Record<string, Message[]>>({})
  const loadGenerationRef = useRef<Record<string, number>>({})
  const prevSessionRef = useRef(sessionId)
  useEffect(() => {
    if (sessionId === prevSessionRef.current) return
    prevSessionRef.current = sessionId
    sessionRef.current = null
    messageOwnerRef.current = null
    setMessages([]); setGenerating(false); setSummary('')
    if (!sessionId) return

    const s = useStore.getState().sessions.find(s => s.id === sessionId)
    if (!s) return
    sessionRef.current = s.source  // set BEFORE async, so incoming events match
    messageOwnerRef.current = s.id

    const cached = messagesBySourceRef.current[s.source] ?? (() => {
      const stored = localStorage.getItem('pylon-msgs-' + s.id)
      if (!stored) return []
      try {
        return (JSON.parse(stored) as Message[]).map(message => ({ ...message, running: false }))
      } catch {
        return []
      }
    })()
    messagesBySourceRef.current[s.source] = cached
    setMessages(cached)
    const sourceGenerating = (useStore.getState().liveGeneratingSources || []).includes(s.source)
    setGenerating(sourceGenerating)
    if (sourceGenerating) genStart.current = generationStartRef.current[s.source] || Date.now()

    const profile = useStore.getState().profiles.find(p => p.id === s.profileId)
    const persona = profile?.persona || ''

    // new_session 返回可能是 string(periId) 或 { sessionId, configOptions } — 兼容处理
    const syncMode = (source: string, res: any) => {
      const configOptions = Array.isArray(res?.configOptions) ? res.configOptions : []
      const modeOption = configOptions.find((option: any) => (option?.id || option?.key) === 'mode')
      const configMode = modeOption?.currentValue ?? modeOption?.value
      const modes = res?.modes
      const currentMode = modes?.currentModeId ?? modes?.currentMode ?? modes?.current ?? configMode
      if (currentMode != null) useStore.getState().setSessionMode(source, String(currentMode))
    }

    const createSession = () => {
      invoke<any>('new_session', { source: s.source, persona, cwd: s.workdir || undefined }).then(res => {
        const periId = typeof res === 'string' ? res : (res?.sessionId ?? res?.periId)
        if (periId) useStore.getState().setSessionPeriId(s.id, periId)
        const cfg = extractModelConfig(res?.configOptions)
        if (cfg.model || cfg.models) useStore.getState().setSessionConfig(s.source, { ...cfg, raw: res?.configOptions })
        syncMode(s.source, res)
      }).catch(() => {})
    }

    if (s.periId) {
      const loadGeneration = (loadGenerationRef.current[s.source] || 0) + 1
      loadGenerationRef.current[s.source] = loadGeneration
      replayingSourcesRef.current[s.source] = []
      invoke<any>('load_persisted_session', { source: s.source, periId: s.periId, cwd: s.workdir || undefined }).then(res => {
        if (loadGenerationRef.current[s.source] !== loadGeneration) return
        const replayed = replayingSourcesRef.current[s.source] || []
        const resolved = resolveLoadedMessages({ loadSucceeded: true, cached, replayed })
        delete replayingSourcesRef.current[s.source]
        messagesBySourceRef.current[s.source] = resolved
        const serialized = serializeLoadedMessages(resolved)
        try {
          if (serialized) localStorage.setItem('pylon-msgs-' + s.id, serialized)
          else localStorage.removeItem('pylon-msgs-' + s.id)
        } catch {}
        if (sessionRef.current === s.source) setMessages(resolved)
        const cfg = extractModelConfig(res?.configOptions)
        if (cfg.model || cfg.models) useStore.getState().setSessionConfig(s.source, { ...cfg, raw: res?.configOptions })
        syncMode(s.source, res)
      }).catch(() => {
        if (loadGenerationRef.current[s.source] !== loadGeneration) return
        delete replayingSourcesRef.current[s.source]
        createSession()  // Fallback
      })
    } else {
      delete replayingSourcesRef.current[s.source]
      createSession()
    }
  }, [sessionId])

  useEffect(() => {
    const updateSourceMessages = (source: string, updater: (prev: Message[]) => Message[], replay = false) => {
      const next = replay
        ? updateSourceState(replayingSourcesRef.current, source, updater)
        : updateSourceState(messagesBySourceRef.current, source, updater)
      if (replay) return
      const session = useStore.getState().sessions.find(item => item.source === source)
      if (session) {
        try { localStorage.setItem('pylon-msgs-' + session.id, JSON.stringify(next)) } catch {}
      }
      if (sessionRef.current === source) setMessages(next)
    }
    const startGenerating = (source: string) => {
      const current = useStore.getState().liveGeneratingSources || []
      const next = addGeneratingSource(current, source)
      if (next !== current) {
        useStore.getState().setLiveStats({
          liveGeneratingSources: next,
          liveGenerating: source,
        })
      }
    }
    const stopGenerating = (source: string) => {
      const next = removeGeneratingSource(useStore.getState().liveGeneratingSources || [], source)
      useStore.getState().setLiveStats({
        liveGeneratingSources: next,
        liveGenerating: next[next.length - 1] || null,
      })
    }

    const unlisten = Promise.all([
      listen<{ source: string; content: string; replay?: boolean }>('peri:user', (event) => {
        const { source, content, replay = false } = event.payload
        const update = (prev: Message[]) => [
          ...prev.map(m => ({ ...m, running: false })),
          { id: 'user-' + Date.now(), role: 'user' as const, sender: source, content, time: new Date().toLocaleTimeString() },
        ]
        if (replay && !replayingSourcesRef.current[source]) replayingSourcesRef.current[source] = []
        updateSourceMessages(source, update, replay)
        if (!shouldStartLiveGeneration({ replay })) return
        generationStartRef.current[source] = Date.now()
        startGenerating(source)
        if (sessionRef.current === source) {
          genStart.current = generationStartRef.current[source]
          tokenCount.current = 0
          setGenerating(true)
          setSummary('')
        }

        const sessions = useStore.getState().sessions
        const s = sessions.find(s => s.source === source)
        if (s?.name.startsWith('session-')) {
          const autoName = content.slice(0, 30)
          const updated = sessions.map(ss => ss.id === s.id ? { ...ss, autoName, name: autoName } : ss)
          useStore.setState({ sessions: updated })
          localStorage.setItem('pylon-sessions', JSON.stringify(updated))
        }
      }),

      listen<any>('peri:update', (event) => {
        const source = event.payload.source
        const upd = event.payload?.update
        if (!source || !upd) return
        const variant = upd.sessionUpdate
        const replay = upd._meta?.periReplay === true
        if (replay && !replayingSourcesRef.current[source]) replayingSourcesRef.current[source] = []
        switch (variant) {
          case 'agent_message_chunk': {
            const text = upd.content?.text || ''
            if (!text) return
            updateSourceMessages(source, prev => {
              const last = prev[prev.length - 1]
              if (last?.role === 'assistant' && last.running) {
                return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: m.content + text } : m)
              }
              return [...prev, { id: 'msg-' + Date.now(), role: 'assistant', sender: 'peri', content: text, time: new Date().toLocaleTimeString(), running: !replay }]
            }, replay)
            break
          }
          case 'agent_thought_chunk': {
            const text = upd.content?.text || ''
            if (!text) return
            updateSourceMessages(source, prev => {
              const last = prev[prev.length - 1]
              if (last?.role === 'reasoning' && last.running) {
                return prev.map((m, i) => i === prev.length - 1 ? { ...m, content: m.content + text } : m)
              }
              return [...prev, { id: 'thought-' + Date.now(), role: 'reasoning', sender: 'peri', content: text, time: new Date().toLocaleTimeString(), running: !replay }]
            }, replay)
            break
          }
          case 'tool_call': {
            const rawInput = upd.rawInput
            const inputStr = formatToolInput(upd.title, rawInput) || (typeof rawInput === 'string' ? rawInput.slice(0, 80) : '')
            updateSourceMessages(source, prev => [...prev, {
              id: 'tool-' + upd.toolCallId, role: 'tool', sender: 'tool:' + (upd.title || '?'), content: '', time: new Date().toLocaleTimeString(),
              toolName: upd.title, toolInput: inputStr, running: true,
            }], replay)
            break
          }
          case 'tool_call_update': {
            const rawOutput = upd.rawOutput
            const outputStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2)
            const lines = outputStr ? outputStr.split(/\n/).filter((l: string) => l.trim()).length : 0
            updateSourceMessages(source, prev => prev.map(m => m.id === 'tool-' + upd.toolCallId && m.running
              ? { ...m, toolOutput: outputStr, toolOutputLines: lines, toolStatus: upd.status, running: false }
              : m), replay)
            break
          }
          case 'usage_update': {
            const used = upd.value || (upd._meta?.inputTokens || 0) + (upd._meta?.outputTokens || 0)
            const max = upd.size || 131072
            if (sessionRef.current === source) {
              tokenCount.current = used
              useStore.getState().setLiveStats({ liveTokensUsed: used, liveTokensMax: max, liveCacheReadTokens: upd._meta?.cacheReadTokens || 0 })
            }
            break
          }
          case 'available_commands_update':
            if (sessionRef.current === source) useStore.getState().setLiveStats({ liveCommands: upd.commands || [] } as any)
            break
          case 'config_option_update': {
            if (Array.isArray(upd.configOptions)) {
              const cfg = extractModelConfig(upd.configOptions)
              if (cfg.model || cfg.models) useStore.getState().setSessionConfig(source, { ...cfg, raw: upd.configOptions })
              const modeOption = upd.configOptions.find((option: any) => (option?.id || option?.key) === 'mode')
              const mode = modeOption?.currentValue ?? modeOption?.value
              if (mode != null) useStore.getState().setSessionMode(source, String(mode))
            } else {
              const key = upd.id ?? upd.key
              const val = upd.currentValue ?? upd.value
              if (key === 'model' && val != null) useStore.getState().setSessionConfig(source, { model: String(val) })
              if (key === 'mode' && val != null) useStore.getState().setSessionMode(source, String(val))
            }
            break
          }
        }
      }),

      listen<any>('peri:done', (event) => {
        const source = event.payload.source
        if (!source) return
        stopGenerating(source)
        if (sessionRef.current === source) {
          const start = generationStartRef.current[source] || genStart.current
          const elapsed = Math.floor((Date.now() - start) / 1000)
          const elapsedStr = elapsed >= 60 ? `${Math.floor(elapsed/60)}m ${elapsed%60}s` : `${elapsed}s`
          setSummary(`✻  处理耗时 ${elapsedStr}`)
          setGenerating(false)
        }
        updateSourceMessages(source, prev => prev.map(m => ({ ...m, running: false })))
      }),

      listen<{ source: string; error: string }>('peri:error', (event) => {
        const { source, error } = event.payload
        if (!source) return
        stopGenerating(source)
        updateSourceMessages(source, prev => [...prev.map(m => ({ ...m, running: false })), {
          id: 'err-' + Date.now(), role: 'assistant', sender: 'system', content: error, time: new Date().toLocaleTimeString(),
        }])
        if (sessionRef.current === source) setGenerating(false)
      }),
    ])

    const handleClear = () => {
      if (!sessionRef.current) return
      messagesBySourceRef.current[sessionRef.current] = []
      setMessages([])
      setSummary('')
    }
    window.addEventListener('peri:clear', handleClear)

    return () => {
      unlisten.then(fns => fns.forEach(f => f()))
      window.removeEventListener('peri:clear', handleClear)
    }
  }, [])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, generating])

  // 当前可见会话的消息同步到 localStorage；后台会话在事件入口直接持久化
  useEffect(() => {
    const ownerId = messageOwnerRef.current
    const source = sessionRef.current
    if (!canPersistMessages({ ownerId, source, renderedSessionId: sessionId }) || messages.length === 0) return
    const ownedSource = source as string
    const ownedSessionId = ownerId as string
    messagesBySourceRef.current[ownedSource] = messages
    try { localStorage.setItem('pylon-msgs-' + ownedSessionId, JSON.stringify(messages)) } catch {}
  }, [messages, sessionId])

  // dev/浏览器模式（无 Tauri）即使无 session 也渲染 mock 对话，方便调样式
  if (!sessionId && IS_TAURI) return (
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
              className={`term-row term-row-${msg.role}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: [0.2, 0, 0, 1] }}
            >
              {msg.role === 'tool' && <ToolCard name={msg.toolName!} input={msg.toolInput} output={msg.toolOutput} outputLines={msg.toolOutputLines} status={msg.toolStatus} />}
              {msg.role === 'user' && <UserLine sender={msg.sender} content={msg.content} />}
              {msg.role === 'reasoning' && <ReasoningBlock text={msg.content} />}
              {msg.role === 'assistant' && <AssistantContent text={msg.content} />}
            </motion.div>
          ))}
        </AnimatePresence>
        {generating && (
          <div className="term-spinner-row">
            <Spinner tokenCount={tokenCount.current} startTime={genStart.current} />
            <button className="spinner-stop-btn" title="停止生成 (Esc / Ctrl+C)"
              onClick={() => { if (sessionRef.current) invoke('cancel_prompt', { source: sessionRef.current }).catch(() => {}) }}>
              <Square size={11} /> 停止
            </button>
          </div>
        )}
        {!generating && summary && <div className="term-summary">{summary}</div>}
        <div ref={bottomRef} />
      </div>
      <button className="scroll-bottom-btn" onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
        title="回到底端">▼</button>
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
  const lines = code.split('\n')
  const isMultiLine = lines.length > 1
  const [highlighted, setHighlighted] = useState<{ html: string; lang: string } | null>(null)

  useEffect(() => {
    if (!isMultiLine) return
    let cancelled = false
    const lang = language || 'text'
    import('@wooorm/starry-night').then(async ({ common, createStarryNight }) => {
      const starry = await createStarryNight(common)
      const scope = starry.flagToScope(lang)
      if (scope && !cancelled) {
        // 整体高亮后用 CSS 拆行——避免逐行高亮丢失跨行 token 上下文
        const root = starry.highlight(code, scope)
        const html = toHtml(root as any)
        if (!cancelled) setHighlighted({ html, lang })
      }
    }).catch(() => {})
    return () => { cancelled = true }
  }, [language, code, isMultiLine])

  // 单行 → 内联代码风格（无 gutter）
  if (!isMultiLine) {
    return <code className="term-inline-code">{code}</code>
  }

  // 多行 → │ gutter 风格（对齐 Peri TUI code_block_lines）
  // 将 starry-night 输出的 HTML 按 \n 拆行，每行包 gutter
  const renderLines = () => {
    if (!highlighted) {
      return lines.map((line, i) => (
        <div key={i} className="term-code-line">
          <span className="term-code-gutter">│ </span>
          <span>{line || '\u00a0'}</span>
        </div>
      ))
    }
    // starry-night 输出的是完整 HTML 字符串，内含 \n 分隔各行
    const htmlLines = highlighted.html.split('\n')
    return htmlLines.map((html, i) => (
      <div key={i} className="term-code-line">
        <span className="term-code-gutter">│ </span>
        <span dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }} />
      </div>
    ))
  }

  return (
    <div className="term-code-block">
      {renderLines()}
    </div>
  )
}

function ReasoningBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="term-reasoning">
      <button className="term-reasoning-head" type="button" onClick={() => setOpen(!open)}>Thought for {text.length} chars</button>
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

function ToolCard({ name, input, output, outputLines, status: toolStatus }: { name: string; input?: string; output?: string; outputLines?: number; status?: string }) {
  const [open, setOpen] = useState(false)
  const indicator = useStore(s => s.toolIndicator) || '●'
  const glow = useStore(s => s.toolIndicatorGlow) || 0
  const glowColor = useStore(s => s.toolIndicatorGlowColor) || ''
  const toolOk = useStore(s => s.toolOk)
  const toolRun = useStore(s => s.toolRun)
  const toolErr = useStore(s => s.toolErr)
  const connectorMode = useStore(s => s.toolConnectorMode) || 'none'
  const connectorColor = useStore(s => s.toolConnectorColor) || 'rgba(0,0,0,0.12)'
  const done = toolStatus === 'completed' || toolStatus === 'failed' || toolStatus === 'error' || output !== undefined
  const status = resolveToolVisualStatus(toolStatus, output !== undefined)
  // 标志物辉光：颜色跟随状态色，或用户指定
  const statusColor = status === 'ok' ? toolOk : status === 'err' ? toolErr : toolRun
  const glowCss = glow > 0
    ? { textShadow: `0 0 ${glow}px ${glowColor || statusColor || 'currentColor'}` }
    : undefined
  // 竖线连接：none 关闭；fixed 固定色；follow 跟随本 tool 状态色
  const connCss: React.CSSProperties = connectorMode === 'none'
    ? { ['--tool-conn' as any]: 'transparent' }
    : { ['--tool-conn' as any]: connectorMode === 'follow' ? (statusColor || connectorColor) : connectorColor }
  let suffix = ''
  if (done && outputLines !== undefined && outputLines > 0) {
    if (name === 'Grep' || name === 'Glob') suffix = ` — ${outputLines} matches`
    else if (name === 'Read') suffix = ` — ${outputLines} lines`
    else if (name === 'Edit' || name === 'Write') suffix = ` — ${outputLines} lines changed`
  }
  const outputHtml = useMemo(() => {
    if (!output || name !== 'Bash') return ''
    return new Anser().ansiToHtml(Anser.escapeForHtml(output))
  }, [output, name])
  return (
    <div className="term-tool" data-status={status} style={connCss}>
      <button className="term-tool-head" type="button" onClick={() => setOpen(!open)}>
        <span className={`term-tool-indicator ${status}`} style={glowCss}>{indicator}</span>
        <span className="term-tool-name">{name}</span>
        {input && <span className="term-tool-summary"> ({input.length > 60 ? input.slice(0, 60) + '...' : input})</span>}
        {suffix && <span className="term-tool-suffix">{suffix}</span>}
      </button>
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
