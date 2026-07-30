import { useRef, useEffect, useState, useMemo } from 'react'
import React from 'react'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../../store'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AnimatePresence, motion } from 'motion/react'
import Anser from 'anser'
import GenerationFooter, { type GenerationSummary } from './GenerationFooter'
import { resolveSpinnerFrames } from './spinnerFrames'
import { isCurrentLoadGeneration, nextLoadGeneration, normalizeToolId, resolveLoadedMessages, resolveReplayEventMode, resolveTerminationScope, serializeLoadedMessages, settleReplayToolMessages, shouldAcceptToolCall, shouldStartLiveGeneration } from './replayState'
import { canPersistMessages, clearMessageStorage, messageStorageKey, persistMessageSnapshot } from './messagePersistence'
import { addGeneratingSource, isKnownSource, isRenderedSource, removeGeneratingSource, updateSourceState } from './sessionEventState'
import { resolveToolVisualStatus } from './toolStatus'
import { extractMode, extractModelConfig, extractUsage, sessionResponseObject, type PeriDonePayload, type PeriUpdatePayload, type SessionResponse } from './acpTypes'
import { highlightCode } from './codeHighlight'
import { sanitizeHtml } from './htmlSanitizer'
import { reportRuntimeError } from '../../runtimeError'
import { applyCancelEvent, beginCancel, createCancelState, rejectCancelCommand, resolveCancelCommand, type CancelState } from './cancelState'
import { clearChatSourceRefs } from './sessionCleanup'
import './ChatView.css'


interface Props { sessionId: string | null; rightOpen?: boolean; rightWidth?: number }

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

const ChatView = React.memo(function ChatView({ sessionId, rightOpen = false, rightWidth = 260 }: Props) {
  const sessions = useStore(state => state.sessions)
  const bottomRef = useRef<HTMLDivElement>(null)
  const [messages, setMessages] = useState<Message[]>(!IS_TAURI ? MOCK_MESSAGES : [])
  const [generating, setGenerating] = useState(false)
  const genStart = useRef(Date.now())
  const tokenCount = useRef(0)
  const [summary, setSummary] = useState<GenerationSummary | null>(null)
  const sessionRef = useRef<string | null>(null)
  const messageOwnerRef = useRef<string | null>(null)
  const messagesBySourceRef = useRef<Record<string, Message[]>>({})
  const generationStartRef = useRef<Record<string, number>>({})
  const generationFramesRef = useRef<Record<string, string[]>>({})
  const replayingSourcesRef = useRef<Record<string, Message[]>>({})
  const replayToolIdsRef = useRef<Record<string, string[]>>({})
  const loadGenerationRef = useRef<Record<string, number>>({})
  const cancelStateRef = useRef<Record<string, CancelState>>({})
  const prevSessionRef = useRef(sessionId)
  useEffect(() => {
    if (sessionId === prevSessionRef.current) return
    prevSessionRef.current = sessionId
    sessionRef.current = null
    messageOwnerRef.current = null
    setMessages([]); setGenerating(false); setSummary(null)
    if (!sessionId) return

    const s = useStore.getState().sessions.find(s => s.id === sessionId)
    if (!s) return
    sessionRef.current = s.source  // set BEFORE async, so incoming events match
    messageOwnerRef.current = s.id

    const cached = messagesBySourceRef.current[s.source] ?? (() => {
      const stored = localStorage.getItem(messageStorageKey(s.id))
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
    cancelStateRef.current[s.source] = sourceGenerating
      ? { source: s.source, status: 'generating' }
      : createCancelState(s.source)
    if (sourceGenerating) genStart.current = generationStartRef.current[s.source] || Date.now()

    const profile = useStore.getState().profiles.find(p => p.id === s.profileId)
    const persona = profile?.persona || ''

    // new_session 返回可能是 string(periId) 或 { sessionId, configOptions } — 兼容处理
    const syncMode = (source: string, res: ReturnType<typeof sessionResponseObject>) => {
      const currentMode = extractMode(res)
      if (currentMode != null) useStore.getState().setSessionMode(source, String(currentMode))
    }

    const createSession = () => {
      invoke<SessionResponse>('new_session', { source: s.source, persona, cwd: s.workdir || undefined }).then(response => {
        const res = sessionResponseObject(response)
        const periId = res.sessionId ?? res.periId
        if (periId) useStore.getState().setSessionPeriId(s.id, periId)
        const cfg = extractModelConfig(res?.configOptions)
        if (cfg.model || cfg.models) useStore.getState().setSessionConfig(s.source, { ...cfg, raw: res?.configOptions })
        syncMode(s.source, res)
      }).catch(error => reportRuntimeError('创建会话', error))
    }

    if (s.periId) {
      const loadGeneration = nextLoadGeneration(loadGenerationRef.current[s.source])
      loadGenerationRef.current[s.source] = loadGeneration
      replayingSourcesRef.current[s.source] = []
      replayToolIdsRef.current[s.source] = []
      invoke<SessionResponse>('load_persisted_session', { source: s.source, periId: s.periId, cwd: s.workdir || undefined }).then(response => {
        const res = sessionResponseObject(response)
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) return
        const replayed = replayingSourcesRef.current[s.source] || []
        const resolved = resolveLoadedMessages({ loadSucceeded: true, cached, replayed })
        delete replayingSourcesRef.current[s.source]
        delete replayToolIdsRef.current[s.source]
        messagesBySourceRef.current[s.source] = resolved
        const serialized = serializeLoadedMessages(resolved)
        try {
          if (serialized) localStorage.setItem(messageStorageKey(s.id), serialized)
          else clearMessageStorage(s.id, localStorage)
        } catch {}
        if (sessionRef.current === s.source) setMessages(resolved)
        const cfg = extractModelConfig(res?.configOptions)
        if (cfg.model || cfg.models) useStore.getState().setSessionConfig(s.source, { ...cfg, raw: res?.configOptions })
        syncMode(s.source, res)
      }).catch(error => {
        reportRuntimeError('恢复会话', error)
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) return
        delete replayingSourcesRef.current[s.source]
        createSession()  // Fallback
      })
    } else {
      delete replayingSourcesRef.current[s.source]
      createSession()
    }
  }, [sessionId])

  useEffect(() => {
    const activeSources = new Set(sessions.map(session => session.source))
    const knownSources = new Set([
      ...Object.keys(messagesBySourceRef.current),
      ...Object.keys(generationStartRef.current),
      ...Object.keys(generationFramesRef.current),
      ...Object.keys(loadGenerationRef.current),
      ...Object.keys(replayingSourcesRef.current),
      ...Object.keys(replayToolIdsRef.current),
      ...Object.keys(cancelStateRef.current),
    ])
    for (const source of knownSources) {
      if (!activeSources.has(source)) {
        clearChatSourceRefs({
          messagesBySource: messagesBySourceRef.current,
          generationStart: generationStartRef.current,
          generationFrames: generationFramesRef.current,
          loadGeneration: loadGenerationRef.current,
          replayingSources: replayingSourcesRef.current,
          replayToolIds: replayToolIdsRef.current,
          cancelState: cancelStateRef.current,
        }, source)
      }
    }
  }, [sessions, sessionId])

  useEffect(() => {
    const isActiveSource = (source: string) => isKnownSource(source, useStore.getState().sessions.map(session => session.source))
    const updateSourceMessages = (source: string, updater: (prev: Message[]) => Message[], replay = false) => {
      if (!isActiveSource(source)) return
      const next = replay
        ? updateSourceState(replayingSourcesRef.current, source, updater)
        : updateSourceState(messagesBySourceRef.current, source, updater)
      if (replay) return
      const session = useStore.getState().sessions.find(item => item.source === source)
      if (session) {
        persistMessageSnapshot(session.id, next, localStorage)
      }
      if (isRenderedSource(source, sessionRef.current)) setMessages(next)
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
        const { source, content, replay: eventReplay = false } = event.payload
        if (!isActiveSource(source)) return
        const replayMode = resolveReplayEventMode({
          eventReplay,
          loadInProgress: replayingSourcesRef.current[source] !== undefined,
        })
        const replay = replayMode !== 'live'
        const update = (prev: Message[]) => [
          ...prev.map(m => ({ ...m, running: false })),
          { id: 'user-' + Date.now(), role: 'user' as const, sender: source, content, time: new Date().toLocaleTimeString() },
        ]
        if (replay && !replayingSourcesRef.current[source]) replayingSourcesRef.current[source] = []
        updateSourceMessages(source, update, replay)
        if (!shouldStartLiveGeneration({ replay })) return
        generationStartRef.current[source] = Date.now()
        const spinnerState = useStore.getState()
        generationFramesRef.current[source] = resolveSpinnerFrames(spinnerState.spinnerFramePreset, spinnerState.spinnerCustomFrames)
        startGenerating(source)
        cancelStateRef.current[source] = { source, status: 'generating' }
        if (isRenderedSource(source, sessionRef.current)) {
          genStart.current = generationStartRef.current[source]
          tokenCount.current = 0
          setGenerating(true)
          setSummary(null)
        }

        const store = useStore.getState()
        const sessions = store.sessions
        const s = sessions.find(s => s.source === source)
        if (s?.name.startsWith('session-')) {
          const autoName = content.slice(0, 30)
          store.updateSession(s.id, { autoName, name: autoName })
        }
      }),

      listen<PeriUpdatePayload>('peri:update', (event) => {
        const source = event.payload.source
        if (!isActiveSource(source)) return
        const upd = event.payload?.update
        if (!source || !upd) return
        const variant = upd.sessionUpdate
        const replayMode = resolveReplayEventMode({
          eventReplay: upd._meta?.periReplay === true,
          loadInProgress: replayingSourcesRef.current[source] !== undefined,
        })
        const replay = replayMode !== 'live'
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
            const toolId = normalizeToolId(upd.toolCallId)
            if (replay && !shouldAcceptToolCall(toolId, replayToolIdsRef.current[source] || [])) break
            if (replay && toolId) replayToolIdsRef.current[source] = [...(replayToolIdsRef.current[source] || []), toolId]
            const title = upd.title || '?'
            const inputStr = formatToolInput(title, rawInput) || (typeof rawInput === 'string' ? rawInput.slice(0, 80) : '')
            updateSourceMessages(source, prev => [...prev, {
              id: 'tool-' + (toolId || `missing-${prev.length}`), role: 'tool', sender: 'tool:' + title, content: '', time: new Date().toLocaleTimeString(),
              toolName: title, toolInput: inputStr, running: true,
            }], replay)
            break
          }
          case 'tool_call_update': {
            const rawOutput = upd.rawOutput
            const toolId = normalizeToolId(upd.toolCallId)
            if (!toolId) break
            const outputStr = typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput, null, 2)
            const lines = outputStr ? outputStr.split(/\n/).filter((l: string) => l.trim()).length : 0
            updateSourceMessages(source, prev => prev.map(m => m.id === 'tool-' + toolId && m.running
              ? { ...m, toolOutput: outputStr, toolOutputLines: lines, toolStatus: upd.status, running: false }
              : m), replay)
            break
          }
          case 'usage_update': {
            const usage = extractUsage(upd)
            useStore.getState().setSessionLiveStats(source, usage)
            if (isRenderedSource(source, sessionRef.current)) tokenCount.current = usage.tokensUsed
            break
          }
          case 'available_commands_update':
            useStore.getState().setSessionLiveStats(source, { commands: upd.commands || [] })
            break
          case 'config_option_update': {
            if (Array.isArray(upd.configOptions)) {
              const cfg = extractModelConfig(upd.configOptions)
              if (cfg.model || cfg.models) useStore.getState().setSessionConfig(source, { ...cfg, raw: upd.configOptions })
              const modeOption = upd.configOptions.find(option => (option.id || option.key) === 'mode')
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

      listen<PeriDonePayload>('peri:done', (event) => {
        const source = event.payload.source
        if (!isActiveSource(source)) return
        if (!source) return
        const replay = replayingSourcesRef.current[source] !== undefined
        const terminationScope = resolveTerminationScope(replay, event.payload.replay === true)
        if (terminationScope === 'live') {
          stopGenerating(source)
          if (isRenderedSource(source, sessionRef.current)) {
            const start = generationStartRef.current[source] || genStart.current
            const elapsedMs = Date.now() - start
            setSummary({ elapsedMs, tokenCount: tokenCount.current, completedFrame: '', reason: 'done' })
            setGenerating(false)
          }
        }
        updateSourceMessages(source, prev => settleReplayToolMessages(prev.map(m => ({ ...m, running: false }))), replay)
      }),

      listen<{ source: string; error: string; cancelled?: boolean; replay?: boolean }>('peri:error', (event) => {
        const { source, error } = event.payload
        if (!isActiveSource(source)) return
        if (!source) return
        const replay = replayingSourcesRef.current[source] !== undefined
        const terminationScope = resolveTerminationScope(replay, event.payload.replay === true)
        const cancelState = cancelStateRef.current[source] || createCancelState(source)
        const cancellationFailed = terminationScope === 'live'
          && cancelState.status === 'canceling'
          && event.payload.cancelled !== true
        if (terminationScope === 'live') {
          cancelStateRef.current[source] = applyCancelEvent(
            source,
            event.payload.cancelled === true
              ? { kind: 'success' }
              : { kind: 'error', error },
            cancelState,
          )
          if (!cancellationFailed) stopGenerating(source)
        }
        updateSourceMessages(source, prev => [...settleReplayToolMessages(prev.map(m => ({ ...m, running: false }))), {
          id: 'err-' + Date.now(), role: 'assistant', sender: 'system', content: error, time: new Date().toLocaleTimeString(),
        }], replay)
        if (terminationScope === 'live' && !cancellationFailed && isRenderedSource(source, sessionRef.current)) {
          const start = generationStartRef.current[source] || genStart.current
          setSummary({ elapsedMs: Date.now() - start, tokenCount: tokenCount.current, completedFrame: '', reason: event.payload.cancelled === true ? 'cancelled' : 'error' })
          setGenerating(false)
        }
      }),
    ])

    const handleClear = () => {
      const source = sessionRef.current
      const ownerId = messageOwnerRef.current
      if (!source || !ownerId) return
      const session = useStore.getState().sessions.find(item => item.id === ownerId && item.source === source)
      if (!session) return
      messagesBySourceRef.current[source] = []
      clearMessageStorage(session.id, localStorage)
      setMessages([])
      setSummary(null)
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
    const renderedSource = sessionRef.current
    if (!canPersistMessages({ ownerId, source, renderedSessionId: sessionId, renderedSource }) || messages.length === 0) return
    const ownedSource = source as string
    const ownedSessionId = ownerId as string
    messagesBySourceRef.current[ownedSource] = messages
    try { persistMessageSnapshot(ownedSessionId, messages, localStorage) } catch {}
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
    <div className="chat-view" style={{ '--chat-right-offset': rightOpen ? `${rightWidth + 8}px` : '0px' } as React.CSSProperties}>
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
        <GenerationFooter running={generating}
          frames={generationFramesRef.current[sessionRef.current || ''] || resolveSpinnerFrames(useStore.getState().spinnerFramePreset, useStore.getState().spinnerCustomFrames)}
          tokenCount={tokenCount.current} startTime={genStart.current} summary={summary}
          onStop={generating ? () => {
            if (!sessionRef.current) return
            const source = sessionRef.current
            const currentCancelState = cancelStateRef.current[source] || { source, status: 'generating' as const }
            const begun = beginCancel(source, currentCancelState)
            if (!begun.shouldInvoke) return
            cancelStateRef.current[source] = begun.state
            invoke('cancel_prompt', { source }).then(() => {
              cancelStateRef.current[source] = resolveCancelCommand(source, cancelStateRef.current[source] || begun.state)
            }).catch(error => {
              cancelStateRef.current[source] = rejectCancelCommand(source, cancelStateRef.current[source] || begun.state, error)
              reportRuntimeError('取消生成', error)
            })
          } : undefined} />
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
    highlightCode(lang, code).then(html => {
      if (html && !cancelled) setHighlighted({ html, lang })
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
        <span dangerouslySetInnerHTML={{ __html: sanitizeHtml(html || '&nbsp;') }} />
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
      <button className="term-reasoning-head" type="button" onClick={() => setOpen(!open)} aria-expanded={open}>∴ Thinking…</button>
      {open && <div className="term-reasoning-body">{text.split('\n').map((line, i) => <div key={i} className="term-reasoning-line">{line || '\u00a0'}</div>)}</div>}
    </div>
  )
}

function formatToolInput(name: string, rawInput: unknown): string {
  if (typeof rawInput !== 'object' || !rawInput) return ''
  const input = rawInput as Record<string, unknown>
  // Extract the most meaningful field per tool type
  const firstString = (...values: unknown[]) => values.find((value): value is string => typeof value === 'string') || ''
  if (name === 'Bash') return firstString(input.command, input.cmd)
  if (name === 'Read' || name === 'Write' || name === 'Edit') return firstString(input.path, input.file_path, input.filePath)
  if (name === 'Grep' || name === 'Glob') return firstString(input.pattern, input.regex, input.glob)
  if (name === 'Task') return firstString(input.description, input.prompt, input.goal)
  // Fallback: show first meaningful string value
  for (const v of Object.values(input)) {
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
    return sanitizeHtml(new Anser().ansiToHtml(Anser.escapeForHtml(output)))
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
