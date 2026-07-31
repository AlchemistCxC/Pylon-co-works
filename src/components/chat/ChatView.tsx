import { useRef, useEffect, useState, useMemo, useId, useCallback } from 'react'
import React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../../store'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import Anser from 'anser'
import GenerationFooter, { type GenerationSummary } from './GenerationFooter'
import { resolveSpinnerFrames } from './spinnerFrames'
import { isCurrentLoadGeneration, nextLoadGeneration, resolveLoadedMessages, serializeLoadedMessages } from './replayState'
import { canPersistMessages, clearMessageStorage, messageStorageKey, persistMessageSnapshot } from './messagePersistence'
import { isRenderedSource, removeGeneratingSource } from './sessionEventState'
import { extractMode, extractModelConfig, sessionResponseObject, type SessionResponse } from './acpTypes'
import { highlightCode } from './codeHighlight'
import { sanitizeHtml } from './htmlSanitizer'
import { reportRuntimeError } from '../../runtimeError'
import { applyCancelEvent, beginCancel, createCancelState, rejectCancelCommand, resolveCancelCommand, type CancelState } from './cancelState'
import { clearChatSourceRefs } from './sessionCleanup'
import { measureRender, recordMeasuredAsync, recordRender } from './renderMetrics'
import { prepareRenderableMessages, isMessageStatic } from './messagePipeline'
import type { Message as PipelineMessage, RenderMessage } from './messageTypes'
import { buildMessageLookups } from './messageLookups'
import { getToolSummary } from './toolPresentation'
import { buildToolPresentationModel, toolPresentationStatus, truncateToolSummary } from './toolPresentationModel'
import { normalizeToolStatus, type ToolVisualState } from './toolStatus'
import { isPlainTextContent } from './markdownFastPath'
import { MessageRenderBoundary } from './MessageRenderBoundary'
import { createMockMessages } from './chatMockData'
import DiffCard from './DiffCard'
import { messageMatchesQuery } from './messageSearchIndex'
import MessageSearchBar from './MessageSearchBar'
import { attachChatEventController, type ChatEventControllerRefs } from './chatEventController'
import './ChatView.css'

interface Props { sessionId: string | null }

type ScrollFollowState = 'sticky' | 'user_scrolled' | 'jumping'

type Message = PipelineMessage

// dev/浏览器 mock：无 Tauri 后端时（预览调样式用）展示的演示对话
const IS_TAURI = typeof (window as any).__TAURI_INTERNALS__ !== 'undefined' || typeof (window as any).__TAURI__ !== 'undefined'

function createBenchmarkMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => {
    const cycle = index % 4
    const time = `11:${String(index % 60).padStart(2, '0')}`
    if (cycle === 0) return { id: `benchmark-user-${index}`, role: 'user', sender: 'local:benchmark', content: `检查第 ${index} 个模块的状态`, time }
    if (cycle === 1) return { id: `benchmark-assistant-${index}`, role: 'assistant', sender: 'peri', content: `第 ${index} 个模块检查完成，状态正常。`, time }
    if (cycle === 2) return { id: `benchmark-reasoning-${index}`, role: 'reasoning', sender: 'peri', content: `分析第 ${index} 个模块的依赖关系。`, time }
    return { id: `benchmark-tool-${index}`, role: 'tool', sender: 'tool:Grep', content: '', toolName: 'Grep', toolInput: `module-${index}`, toolOutput: `module-${index}: status ok`, toolOutputLines: 1, toolStatus: 'completed', time }
  })
}

function resolveInitialBrowserMessages(): Message[] {
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search)
    if (params.has('pylon-benchmark')) {
      const requestedCount = Number(params.get('pylon-benchmark'))
      const count = Number.isFinite(requestedCount) && requestedCount > 0
        ? Math.min(Math.floor(requestedCount), 5000)
        : 1000
      return createBenchmarkMessages(count)
    }
  }
  return createMockMessages()
}

const ChatView = React.memo(function ChatView({ sessionId }: Props) {
  recordRender('ChatView.render')
  const reduceMotion = useReducedMotion()
  const sessions = useStore(state => state.sessions)
  const chatViewRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollFollowRef = useRef<ScrollFollowState>('sticky')
  const scrollRafRef = useRef<number | null>(null)
  const scrollLockUntilRef = useRef(0)
  const scrollToBottomRef = useRef<((behavior?: ScrollBehavior) => void) | null>(null)
  const [messages, setMessages] = useState<Message[]>(!IS_TAURI ? resolveInitialBrowserMessages() : [])
  const preparedMessages = useMemo(() => prepareRenderableMessages(messages), [messages])
  const messageLookups = useMemo(() => buildMessageLookups(messages), [messages])
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const streamingTextRef = useRef('')
  const streamingThinkingRef = useRef('')
  const streamingSourceRef = useRef<string | null>(null)
  const flushStreamingRef = useRef<((source: string) => void) | null>(null)
  const [generating, setGenerating] = useState(false)
  const [lastTokenAt, setLastTokenAt] = useState(0)
  const genStart = useRef(Date.now())
  const tokenCount = useRef(0)
  const [summary, setSummary] = useState<GenerationSummary | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const messageRefs = useRef(new Map<string, HTMLDivElement>())
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
    const onSearchShortcut = (event: globalThis.KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      setSearchOpen(true)
    }
    window.addEventListener('keydown', onSearchShortcut)
    return () => window.removeEventListener('keydown', onSearchShortcut)
  }, [])

  useEffect(() => {
    setSearchQuery('')
    setSearchIndex(0)
    setSearchOpen(false)
  }, [sessionId])

  const searchMatches = useMemo(() => {
    if (!searchQuery.trim()) return []
    return messages.filter(message => messageMatchesQuery(message, searchQuery))
  }, [messages, searchQuery])

  useEffect(() => {
    if (searchMatches.length === 0) {
      setSearchIndex(0)
      return
    }
    setSearchIndex(index => Math.min(index, searchMatches.length - 1))
  }, [searchMatches.length])

  const moveSearch = useCallback((direction: 1 | -1) => {
    if (searchMatches.length === 0) return
    setSearchIndex(index => (index + direction + searchMatches.length) % searchMatches.length)
  }, [searchMatches.length])

  useEffect(() => {
    const message = searchMatches[searchIndex]
    if (!message) return
    const node = messageRefs.current.get(message.id)
    if (!node) return
    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [searchMatches, searchIndex])

  useEffect(() => {
    if (sessionId === prevSessionRef.current) return
    prevSessionRef.current = sessionId
    sessionRef.current = null
    messageOwnerRef.current = null
    streamingSourceRef.current = null
    streamingTextRef.current = ''
    streamingThinkingRef.current = ''
    setStreamingText('')
    setStreamingThinking('')
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

  const eventControllerRefs = useRef<ChatEventControllerRefs | null>(null)
  if (!eventControllerRefs.current) {
    eventControllerRefs.current = {
      sessionRef,
      messageOwnerRef,
      messagesBySourceRef,
      generationStartRef,
      generationFramesRef,
      replayingSourcesRef,
      replayToolIdsRef,
      cancelStateRef,
      streamingSourceRef,
      streamingTextRef,
      streamingThinkingRef,
      flushStreamingRef,
      genStartRef: genStart,
      tokenCountRef: tokenCount,
      setMessages,
      setStreamingText,
      setStreamingThinking,
      setGenerating,
      setSummary,
      setLastTokenAt,
    }
  }
  const controllerRefs = eventControllerRefs.current
  useEffect(() => attachChatEventController(controllerRefs), [])

  useEffect(() => {
    const container = chatViewRef.current
    if (!container) return
    const updateFollowState = () => {
      scrollRafRef.current = null
      if (performance.now() < scrollLockUntilRef.current) return
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
      scrollFollowRef.current = distanceFromBottom <= 48 ? 'sticky' : 'user_scrolled'
    }
    const handleScroll = () => {
      if (scrollRafRef.current !== null) return
      scrollRafRef.current = requestAnimationFrame(updateFollowState)
    }
    container.addEventListener('scroll', handleScroll, { passive: true })
    updateFollowState()
    return () => {
      container.removeEventListener('scroll', handleScroll)
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    scrollFollowRef.current = 'jumping'
    scrollLockUntilRef.current = performance.now() + (behavior === 'smooth' ? 500 : 50)
    if (!bottomRef.current) return
    recordRender('scrollIntoView.call')
    bottomRef.current.scrollIntoView({ behavior })
    scrollFollowRef.current = 'sticky'
  }, [])
  scrollToBottomRef.current = scrollToBottom

  useEffect(() => {
    if (!bottomRef.current) return
    if (scrollFollowRef.current !== 'sticky') return
    scrollToBottomRef.current?.()
  }, [messages, generating, streamingText, streamingThinking])

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
    <div className="chat-view" ref={chatViewRef}>
      {searchOpen && <MessageSearchBar
        query={searchQuery}
        matchIndex={searchIndex}
        matchCount={searchMatches.length}
        onQueryChange={query => { setSearchQuery(query); setSearchIndex(0) }}
        onPrevious={() => moveSearch(-1)}
        onNext={() => moveSearch(1)}
        onClose={() => { setSearchOpen(false); setSearchQuery('') }}
      />}
      <div className="term">
        <AnimatePresence initial={false}>
          {measureRender('messages.map', () => {
            recordRender('messages.map')
            return preparedMessages.map((renderMessage) => (
              <MemoMessageRow
                key={renderMessage.message.id}
                renderMessage={renderMessage}
                reduceMotion={reduceMotion === true}
                isStatic={isMessageStatic(renderMessage)}
                toolVisualState={resolveRowToolVisualState(renderMessage.message, messageLookups)}
                rowRef={node => {
                  if (node) messageRefs.current.set(renderMessage.message.id, node)
                  else messageRefs.current.delete(renderMessage.message.id)
                }}
                highlighted={searchMatches[searchIndex]?.id === renderMessage.message.id}
              />
            ))
          })}
        </AnimatePresence>
        {streamingThinking && <StreamingThinking text={streamingThinking} />}
        {streamingText && <StreamingAssistantText text={streamingText} />}
        <GenerationFooter running={generating}
          frames={generationFramesRef.current[sessionRef.current || ''] || resolveSpinnerFrames(useStore.getState().spinnerFramePreset, useStore.getState().spinnerCustomFrames)}
          tokenCount={tokenCount.current} startTime={genStart.current} lastTokenAt={lastTokenAt} summary={summary}
          onStop={generating ? () => {
            if (!sessionRef.current) return
            const source = sessionRef.current
            const currentCancelState = cancelStateRef.current[source] || { source, status: 'generating' as const }
            const begun = beginCancel(source, currentCancelState)
            if (!begun.shouldInvoke) return
            cancelStateRef.current[source] = begun.state
            invoke('cancel_prompt', { source }).then(() => {
              cancelStateRef.current[source] = resolveCancelCommand(source, cancelStateRef.current[source] || begun.state)
              // cancel_prompt 的返回只表示请求已被后端接受；但 UI 不能继续显示已知已经取消的生成。
              // 后续 peri:error(cancelled=true) 到达时仍会再次收敛状态。
              cancelStateRef.current[source] = applyCancelEvent(source, { kind: 'success' }, cancelStateRef.current[source])
              const nextSources = removeGeneratingSource(useStore.getState().liveGeneratingSources || [], source)
              useStore.getState().setLiveStats({
                liveGeneratingSources: nextSources,
                liveGenerating: nextSources[nextSources.length - 1] || null,
              })
              if (isRenderedSource(source, sessionRef.current)) {
                flushStreamingRef.current?.(source)
                const start = generationStartRef.current[source] || genStart.current
                setSummary({ elapsedMs: Date.now() - start, tokenCount: tokenCount.current, completedFrame: '', reason: 'cancelled' })
                setGenerating(false)
              }
            }).catch(error => {
              cancelStateRef.current[source] = rejectCancelCommand(source, cancelStateRef.current[source] || begun.state, error)
              reportRuntimeError('取消生成', error)
            })
          } : undefined} />
        <div ref={bottomRef} />
      </div>
      <button className="scroll-bottom-btn" onClick={() => scrollToBottomRef.current?.()}
        title="回到底端">▼</button>
    </div>
  )
})

// ── Sub-components ──


function MessageRow({ renderMessage, reduceMotion, toolVisualState, rowRef, highlighted, isStatic }: { renderMessage: RenderMessage; reduceMotion: boolean; toolVisualState?: string; rowRef?: (node: HTMLDivElement | null) => void; highlighted?: boolean; isStatic?: boolean }) {
  recordRender('MessageRow.render')
  const msg = renderMessage.message
  const toolModel = msg.role === 'tool'
    ? buildToolPresentationModel(msg, toolVisualState ? normalizeToolStatus(toolVisualState) : undefined)
    : undefined
  const renderType = renderMessage.type
  const skipEntrance = reduceMotion || isStatic === true
  return (
    <MessageRenderBoundary message={msg}>
      <motion.div
      ref={rowRef}
      className={`term-row term-row-${msg.role}${highlighted ? ' term-row-search-active' : ''}`}
      data-render-type={renderType}
      initial={skipEntrance ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: [0.2, 0, 0, 1] }}
    >
      {toolModel && <ToolCard model={toolModel} />}
      {renderMessage.type === 'user' && <UserLine sender={msg.sender} content={msg.content} />}
      {renderMessage.type === 'reasoning' && <ReasoningBlock text={msg.content} running={msg.running === true} />}
      {renderMessage.type === 'assistant' && <AssistantContent text={msg.content} />}
      {(renderMessage.type === 'error' || renderMessage.type === 'system') && (
        <div className="term-row-error" role="alert">{msg.content || '系统消息'}</div>
      )}
      </motion.div>
    </MessageRenderBoundary>
  )
}

function areMessageRowPropsEqual(
  previous: { renderMessage: RenderMessage; reduceMotion: boolean; toolVisualState?: string; rowRef?: (node: HTMLDivElement | null) => void; highlighted?: boolean; isStatic?: boolean },
  next: { renderMessage: RenderMessage; reduceMotion: boolean; toolVisualState?: string; rowRef?: (node: HTMLDivElement | null) => void; highlighted?: boolean; isStatic?: boolean },
): boolean {
  if (previous.renderMessage.message !== next.renderMessage.message) return false
  if (previous.renderMessage.type !== next.renderMessage.type) return false
  if (previous.reduceMotion !== next.reduceMotion) return false
  if (previous.toolVisualState !== next.toolVisualState) return false
  if (previous.highlighted !== next.highlighted) return false
  if (previous.isStatic !== next.isStatic) return false
  if (previous.renderMessage.message.running || next.renderMessage.message.running) return false
  if (previous.renderMessage.message.role === 'tool' || next.renderMessage.message.role === 'tool') {
    if (previous.renderMessage.message.toolStatus !== next.renderMessage.message.toolStatus) return false
    if (previous.renderMessage.message.toolOutput !== next.renderMessage.message.toolOutput) return false
    if (previous.renderMessage.message.toolInput !== next.renderMessage.message.toolInput) return false
  }
  return true
}

const MemoMessageRow = React.memo(MessageRow, areMessageRowPropsEqual)

function resolveRowToolVisualState(message: Message, lookups: ReturnType<typeof buildMessageLookups>): string | undefined {
  if (message.role !== 'tool' || !message.id.startsWith('tool-')) return undefined
  const toolId = message.id.slice('tool-'.length)
  if (lookups.failedToolIds.has(toolId)) return 'failed'
  if (lookups.runningToolIds.has(toolId)) return 'running'
  if (lookups.resolvedToolIds.has(toolId)) return 'completed'
  return 'unknown'
}

function AssistantContent({ text, isStreaming = false }: { text: string; isStreaming?: boolean }) {
  recordRender('AssistantContent.render')
  recordRender('markdown.parse')
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true); setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="term-assistant">
      <button className="copy-btn" onClick={copy}>{copied ? '✓' : '⎘'}</button>
      {isStreaming || !isPlainTextContent(text) ? (
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
      ) : (
        <p className="term-p term-plain-text">{text}</p>
      )}
    </div>
  )
}

function StreamingAssistantText({ text }: { text: string }) {
  recordRender('streamingText.render')
  return <AssistantContent text={text} isStreaming />
}

function StreamingThinking({ text }: { text: string }) {
  recordRender('streamingThinking.render')
  return <ReasoningBlock text={text} running />
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  recordRender('CodeBlock.render')
  const lines = code.split('\n')
  const isMultiLine = lines.length > 1
  const [highlighted, setHighlighted] = useState<{ html: string; lang: string } | null>(null)

  useEffect(() => {
    if (!isMultiLine) return
    let cancelled = false
    const lang = language || 'text'
    recordRender('highlightCode.call')
    recordMeasuredAsync('CodeBlock.highlight', highlightCode(lang, code)).then(html => {
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

function ReasoningBlock({ text, running }: { text: string; running: boolean }) {
  recordRender('ReasoningBlock.render')
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const characterCount = Array.from(text).length
  const label = running ? 'Thinking…' : `Thought for ${characterCount} chars`
  return (
    <div className="term-reasoning">
      <button className="term-reasoning-head" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={bodyId}>{label}</button>
      {open && <div className="term-reasoning-body" id={bodyId}>{text.split('\n').map((line, i) => <div key={i} className="term-reasoning-line">{line || '\u00a0'}</div>)}</div>}
    </div>
  )
}

function ToolCard({ model }: { model: ReturnType<typeof buildToolPresentationModel> }) {
  recordRender('ToolCard.render')
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const indicator = useStore(s => s.toolIndicator) || '●'
  const glow = useStore(s => s.toolIndicatorGlow) || 0
  const glowColor = useStore(s => s.toolIndicatorGlowColor) || ''
  const toolOk = useStore(s => s.toolOk)
  const toolRun = useStore(s => s.toolRun)
  const toolErr = useStore(s => s.toolErr)
  const connectorMode = useStore(s => s.toolConnectorMode) || 'none'
  const connectorColor = useStore(s => s.toolConnectorColor) || 'rgba(0,0,0,0.12)'
  const status = toolPresentationStatus(model)
  const displaySummary = truncateToolSummary(model.summary)
  const displayStatus = model.state !== 'unknown' ? model.statusLabel : ''
  const glowCss = glow > 0
    ? { textShadow: `0 0 ${glow}px ${glowColor || (status === 'ok' ? toolOk : status === 'err' ? toolErr : toolRun) || 'currentColor'}` }
    : undefined
  const connCss: React.CSSProperties = connectorMode === 'none'
    ? { ['--tool-conn' as any]: 'transparent' }
    : { ['--tool-conn' as any]: connectorMode === 'follow' ? ((status === 'ok' ? toolOk : status === 'err' ? toolErr : toolRun) || connectorColor) : connectorColor }
  const suffix = model.state === 'completed' && model.outputLines > 0 ? ` — ${model.outputLabel}` : ''
  const outputHtml = useMemo(() => {
    if (!model.outputText || model.name !== 'Bash') return ''
    return sanitizeHtml(new Anser().ansiToHtml(Anser.escapeForHtml(model.outputText)))
  }, [model.outputText, model.name])
  return (
    <div className="term-tool" data-status={status} data-tool-state={model.state}
      data-output-collapsible={model.canCollapseOutput ? 'true' : 'false'} style={connCss}>
      <button className="term-tool-head" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={bodyId}>
        <span className={`term-tool-indicator ${status}`} style={glowCss}>{indicator}</span>
        <span className="term-tool-name">{model.name}</span>
        {displaySummary && <span className="term-tool-summary"> ({displaySummary})</span>}
        {displayStatus && <span className="term-tool-status"> · {displayStatus}</span>}
        {suffix && <span className="term-tool-suffix">{suffix}</span>}
      </button>
      {open && model.hasOutput && (
        <div className="term-tool-body" id={bodyId}>
          <span className={`term-tool-label${model.errorText ? ' term-tool-label-error' : ''}`}>
            {model.errorText ? '错误' : '输出'}{model.outputLabel ? ` · ${model.outputLabel}` : ''}
          </span>
          {model.isDiffCandidate && <DiffCard output={model.outputText} />}
          {model.name === 'Bash' && outputHtml
            ? <div className="term-ansi" dangerouslySetInnerHTML={{ __html: outputHtml }} />
            : <pre><code>{model.outputText}</code></pre>}
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
