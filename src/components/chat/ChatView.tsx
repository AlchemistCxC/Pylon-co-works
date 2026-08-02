import { useRef, useEffect, useLayoutEffect, useState, useMemo, useId, useCallback, Suspense } from 'react'
import React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../../store'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import Anser from 'anser'
import GenerationFooter, { type GenerationPhase, type GenerationSummary } from './GenerationFooter'
import { resolveSpinnerFrames } from './spinnerFrames'
import { isCurrentLoadGeneration, nextLoadGeneration, resolveLoadedMessages, serializeLoadedMessages } from './replayState'
import { canPersistMessages, clearMessageStorage, messageStorageKey, persistMessageSnapshot } from './messagePersistence'
import { extractMode, extractModelConfig, sessionResponseObject, type SessionResponse } from './acpTypes'
import { highlightCode } from './codeHighlight'
import { sanitizeHtml } from './htmlSanitizer'
import { reportRuntimeError } from '../../runtimeError'
import { measureRender, recordMeasuredAsync, recordRender } from './renderMetrics'
import { prepareRenderableMessages, isMessageStatic } from './messagePipeline'
import type { Message as PipelineMessage, RenderMessage } from './messageTypes'
import { buildMessageLookups } from './messageLookups'
import { resolveConnectorColor } from './toolPresentation'
import { buildToolPresentationModel, toolPresentationStatus, truncateToolSummary } from './toolPresentationModel'
import { normalizeToolStatus, resolveToolVisualStatus } from './toolStatus'
import { toolIndicatorMotionClass } from './toolIndicatorMotion'
import { resolveToolIndicatorAsset } from './toolIndicatorAssets'
import { isPlainTextContent } from './markdownFastPath'
import { MarkdownRenderer } from './markdownLazy'
import { MessageRenderBoundary } from './MessageRenderBoundary'
import { createMockMessages } from './chatMockData'
import DiffCard from './DiffCard'
import { messageMatchesQuery } from './messageSearchIndex'
import MessageSearchBar from './MessageSearchBar'
import ToolConnector from './ToolConnector'
import { attachChatEventController, registerChatController, type ChatControllerHandle, type ChatEventControllerRefs } from './chatEventController'
import './ChatView.css'

interface Props { sessionId: string | null }

type ScrollFollowState = 'sticky' | 'user_scrolled' | 'jumping'

type Message = PipelineMessage

// dev/浏览器 mock：无 Tauri 后端时（预览调样式用）展示的演示对话
const IS_TAURI = typeof (window as any).__TAURI_INTERNALS__ !== 'undefined' || typeof (window as any).__TAURI__ !== 'undefined'
const MOCK_GENERATION_PHASES: GenerationPhase[] = [
  { kind: 'thinking' },
  { kind: 'tool', name: 'Read' },
  { kind: 'tool', name: 'Grep' },
  { kind: 'responding' },
]

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
  const sessions = useIdentityStore(state => state.sessions)
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
  const [generating, setGenerating] = useState(false)
  const [lastTokenAt, setLastTokenAt] = useState(0)
  const [summary, setSummary] = useState<GenerationSummary | null>(null)
  const [generationPhase, setGenerationPhase] = useState<GenerationPhase | null>(null)
  const [mockPhaseIndex, setMockPhaseIndex] = useState(0)
  const mockGenerationStartRef = useRef(Date.now())
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchIndex, setSearchIndex] = useState(0)
  const messageRefs = useRef(new Map<string, HTMLDivElement>())
  const sessionRef = useRef<string | null>(null)
  const messageOwnerRef = useRef<string | null>(null)
  const loadGenerationRef = useRef<Record<string, number>>({})
  const prevSessionRef = useRef(sessionId)
  const controllerHandleRef = useRef<ChatControllerHandle | null>(null)
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

  useEffect(() => {
    if (IS_TAURI) return
    const id = window.setInterval(() => setMockPhaseIndex(index => (index + 1) % MOCK_GENERATION_PHASES.length), 1800)
    return () => window.clearInterval(id)
  }, [])

  const browserMockPhase = !IS_TAURI ? MOCK_GENERATION_PHASES[mockPhaseIndex] : undefined
  const browserMockStart = mockGenerationStartRef.current
  const browserMockTokenCount = browserMockPhase?.kind === 'thinking' ? 320 : browserMockPhase?.kind === 'responding' ? 1480 : 860
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
    setStreamingText('')
    setStreamingThinking('')
    setMessages([]); setGenerating(false); setSummary(null); setGenerationPhase(null)
    if (!sessionId) return

    const s = useIdentityStore.getState().sessions.find(s => s.id === sessionId)
    if (!s) return
    sessionRef.current = s.source  // set BEFORE async, so incoming events match
    messageOwnerRef.current = s.id

    const cached = (() => {
      const stored = localStorage.getItem(messageStorageKey(s.id))
      if (!stored) return []
      try {
        return (JSON.parse(stored) as Message[]).map(message => ({ ...message, running: false }))
      } catch {
        return []
      }
    })()
    const messages = controllerHandleRef.current
      ? controllerHandleRef.current.initSource(s.source, cached)
      : cached
    setMessages(messages)
    const sourceGenerating = (useRuntimeStore.getState().liveGeneratingSources || []).includes(s.source)
    setGenerating(sourceGenerating)

    const profile = useIdentityStore.getState().profiles.find(p => p.id === s.profileId)
    const persona = profile?.persona || ''

    // new_session 返回可能是 string(periId) 或 { sessionId, configOptions } — 兼容处理
    const syncMode = (source: string, res: ReturnType<typeof sessionResponseObject>) => {
      const currentMode = extractMode(res)
      if (currentMode != null) useRuntimeStore.getState().setSessionMode(source, String(currentMode))
    }

    const createSession = () => {
      const loadGeneration = nextLoadGeneration(loadGenerationRef.current[s.source])
      loadGenerationRef.current[s.source] = loadGeneration
      invoke<SessionResponse>('new_session', { source: s.source, persona, cwd: s.workdir || undefined }).then(response => {
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) return
        const res = sessionResponseObject(response)
        const periId = res.sessionId ?? res.periId
        if (periId) useIdentityStore.getState().setSessionPeriId(s.id, periId)
        const cfg = extractModelConfig(res?.configOptions)
        if (cfg.model || cfg.models) useRuntimeStore.getState().setSessionConfig(s.source, { ...cfg, raw: res?.configOptions })
        syncMode(s.source, res)
      }).catch(error => {
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) return
        reportRuntimeError('创建会话', error)
      })
    }

    if (s.periId) {
      const loadGeneration = nextLoadGeneration(loadGenerationRef.current[s.source])
      loadGenerationRef.current[s.source] = loadGeneration
      invoke<SessionResponse>('load_persisted_session', { source: s.source, periId: s.periId, cwd: s.workdir || undefined }).then(response => {
        const res = sessionResponseObject(response)
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) return
        const resolved = controllerHandleRef.current
          ? controllerHandleRef.current.commitReplay(s.source, cached)
          : resolveLoadedMessages({ loadSucceeded: true, cached, replayed: [] })
        const serialized = serializeLoadedMessages(resolved)
        try {
          if (serialized) localStorage.setItem(messageStorageKey(s.id), serialized)
          else clearMessageStorage(s.id, localStorage)
        } catch {}
        if (sessionRef.current === s.source) setMessages(resolved)
        const cfg = extractModelConfig(res?.configOptions)
        if (cfg.model || cfg.models) useRuntimeStore.getState().setSessionConfig(s.source, { ...cfg, raw: res?.configOptions })
        syncMode(s.source, res)
      }).catch(error => {
        reportRuntimeError('恢复会话', error)
        if (!isCurrentLoadGeneration(loadGenerationRef.current[s.source], loadGeneration)) return
        controllerHandleRef.current?.clearReplay(s.source)
        createSession()  // Fallback
      })
    } else {
      controllerHandleRef.current?.clearReplay(s.source)
      createSession()
    }
  }, [sessionId])

  useEffect(() => {
    const activeSources = sessions.map(session => session.source)
    controllerHandleRef.current?.pruneSources(activeSources)
    for (const source of Object.keys(loadGenerationRef.current)) {
      if (!activeSources.includes(source)) delete loadGenerationRef.current[source]
    }
  }, [sessions, sessionId])

  const eventControllerRefs = useRef<ChatEventControllerRefs | null>(null)
  if (!eventControllerRefs.current) {
    eventControllerRefs.current = {
      sessionRef,
      messageOwnerRef,
      setMessages,
      setStreamingText,
      setStreamingThinking,
      setGenerating,
      setGenerationPhase,
      setSummary,
      setLastTokenAt,
    }
  }
  const controllerRefs = eventControllerRefs.current
  useEffect(() => {
    // 2026-08-02 修复：非 Tauri 环境（浏览器预览 mock）不挂接 controller——
    // @tauri-apps/api 的 listen() 在无后端时会 reject，此前每次挂载产生多个未处理
    // rejection 且 dispose 的 unlisten.then 永不执行。所有消费点（initSource/
    // commitReplay/clearReplay/pruneSources/requestCancel）均有可选链或 fallback。
    if (!IS_TAURI) return
    controllerHandleRef.current = attachChatEventController(controllerRefs)
    registerChatController(controllerHandleRef.current)
    return () => {
      registerChatController(null)
      controllerHandleRef.current?.dispose()
      controllerHandleRef.current = null
    }
  }, [])

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

  // 连续 Tool 连接线（真实 DOM 元素）：测量每对相邻 tool 行 head 中心间距，
  // 写入 connector 的 top/height。.chat-view 是 flex 固定高，行展开只改 scrollHeight
  // （overflow），观察容器 content-box 不触发 RO——必须观察行元素。
  // messages 变化时重跑绑定（新行挂上 RO）；Tool 或 reasoning body 展开、字号变化由行 RO 触发重测。
  useLayoutEffect(() => {
    const container = chatViewRef.current
    if (!container) return
    let raf = 0
    const measure = () => {
      raf = 0
      for (const connector of container.querySelectorAll<HTMLElement>('.term-tool-connector')) {
        const previousRow = connector.previousElementSibling as HTMLElement | null
        const row = connector.nextElementSibling as HTMLElement | null
        const previousHead = previousRow?.querySelector<HTMLElement>('.term-tool-head')
        const head = row?.querySelector<HTMLElement>('.term-tool-head')
        const connectorParent = connector.offsetParent as HTMLElement | null
        if (!previousRow || !row || !previousHead || !head || !connectorParent) continue
        // 展开 Tool body 也保持连接，线会自然跨过 body 延伸至下一项。
        connector.style.display = 'block'
        // 所有几何值都从 viewport rect 换算到 connector 的实际 offsetParent，
        // 不依赖 motion wrapper 的 offsetTop 坐标系，避免缩放/动画/嵌套定位导致偏移。
        const parentTop = connectorParent.getBoundingClientRect().top
        const previousRect = previousHead.getBoundingClientRect()
        const currentRect = head.getBoundingClientRect()
        const previousCenter = previousRect.top - parentTop + previousRect.height / 2
        const currentCenter = currentRect.top - parentTop + currentRect.height / 2
        connector.style.top = `${previousCenter}px`
        connector.style.height = `${Math.max(0, currentCenter - previousCenter)}px`
      }
    }
    const schedule = () => {
      if (raf !== 0) return
      raf = requestAnimationFrame(measure)
    }
    const observer = new ResizeObserver(schedule)
    const observedRows = new Set<Element>()
    const sync = () => {
      // reasoning 展开会推移其后的所有 Tool 行；因此必须观察所有消息行，
      // 而非只观察 Tool 行，才能让绝对定位 connector 重新按 viewport rect 测量。
      for (const row of container.querySelectorAll('.term-row')) {
        if (observedRows.has(row)) continue
        observer.observe(row)
        observedRows.add(row)
      }
    }
    sync()
    schedule()
    return () => {
      observer.disconnect()
      observedRows.clear()
      if (raf !== 0) cancelAnimationFrame(raf)
    }
  }, [messages])

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
    const ownedSessionId = ownerId as string
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
            return preparedMessages.map((renderMessage, index) => {
              const previous = preparedMessages[index - 1]
              const isToolRow = isToolRenderMessage(renderMessage)
              const hasPreviousTool = isToolRow && isToolRenderMessage(previous)
              const currentVisualState = resolveRowToolVisualState(renderMessage.message, messageLookups)
              // 连接线从上一个连续 Tool 延伸，因此 follow 色也取上一个 Tool 的状态。
              const previousConnectorStatus = hasPreviousTool
                ? resolveRowToolConnectorStatus(previous.message)
                : undefined
              const previousConnectorVisualState = hasPreviousTool
                ? resolveRowToolVisualState(previous.message, messageLookups)
                : undefined
              return (
                <React.Fragment key={renderMessage.message.id}>
                  {hasPreviousTool && <ToolConnector
                    status={previousConnectorStatus || 'run'}
                    visualState={normalizeToolStatus(previousConnectorVisualState)}
                  />}
                  <MemoMessageRow
                    renderMessage={renderMessage}
                    reduceMotion={reduceMotion === true}
                    isStatic={isMessageStatic(renderMessage)}
                    toolVisualState={currentVisualState}
                    rowRef={node => {
                      if (node) messageRefs.current.set(renderMessage.message.id, node)
                      else messageRefs.current.delete(renderMessage.message.id)
                    }}
                    highlighted={searchMatches[searchIndex]?.id === renderMessage.message.id}
                  />
                </React.Fragment>
              )
            })
          })}
        </AnimatePresence>
        {streamingThinking && <StreamingThinking text={streamingThinking} />}
        {streamingText && <StreamingAssistantText text={streamingText} />}
        <GenerationFooter running={generating || browserMockPhase !== undefined}
          frames={controllerHandleRef.current?.getFrames(sessionRef.current || '') || resolveSpinnerFrames(useStore.getState().spinnerFramePreset, useStore.getState().spinnerCustomFrames)}
          tokenCount={browserMockPhase ? browserMockTokenCount : (controllerHandleRef.current?.getTokenCount(sessionRef.current || '') ?? 0)}
          startTime={browserMockPhase ? browserMockStart : (controllerHandleRef.current?.getStartTime(sessionRef.current || '') ?? Date.now())}
          lastTokenAt={browserMockPhase ? Date.now() : lastTokenAt}
          summary={summary}
          phase={browserMockPhase || generationPhase || undefined}
          onStop={generating ? () => {
            if (!sessionRef.current) return
            controllerHandleRef.current?.requestCancel(sessionRef.current)
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
  // 展示模型是 message + 视觉状态的纯函数：props 未变时不重算（msg 引用不可变）
  const toolModel = useMemo(() => msg.role === 'tool'
    ? buildToolPresentationModel(msg, toolVisualState ? normalizeToolStatus(toolVisualState) : undefined)
    : undefined, [msg, toolVisualState])
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
      {renderMessage.type === 'reasoning' && <ReasoningBlock
        text={msg.content}
        running={msg.running === true}
        startedAt={msg.thoughtStartedAt}
        durationMs={msg.thoughtDurationMs}
      />}
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

function isToolRenderMessage(renderMessage: RenderMessage | undefined): renderMessage is RenderMessage {
  return renderMessage?.type === 'tool_call' || renderMessage?.type === 'tool_result'
}

function resolveRowToolVisualState(message: Message | undefined, lookups: ReturnType<typeof buildMessageLookups>): string | undefined {
  if (!message || message.role !== 'tool') return undefined
  if (message.id.startsWith('tool-')) {
    const toolId = message.id.slice('tool-'.length)
    if (lookups.failedToolIds.has(toolId)) return 'failed'
    if (lookups.runningToolIds.has(toolId)) return 'running'
    if (lookups.resolvedToolIds.has(toolId)) return 'completed'
  }
  if (message.running === true) return 'running'
  return normalizeToolStatus(message.toolStatus)
}

function resolveRowToolConnectorStatus(message: Message | undefined): 'ok' | 'err' | 'run' {
  if (!message || message.role !== 'tool') return 'run'
  return resolveToolVisualStatus(message.toolStatus, message.toolOutput !== undefined)
}

function AssistantContent({ text, isStreaming = false }: { text: string; isStreaming?: boolean }) {
  recordRender('AssistantContent.render')
  recordRender('markdown.parse')
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current)
  }, [])
  const copy = () => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="term-assistant">
      <button className="copy-btn" onClick={copy}>{copied ? '✓' : '⎘'}</button>
      {isStreaming || !isPlainTextContent(text) ? (
        <Suspense fallback={<p className="term-p term-plain-text">{text}</p>}>
          <MarkdownRenderer components={{
            code({ className, children, ...props }) {
              const match = /language-(\w+)/.exec(className || '')
              const code = String(children).replace(/\n$/, '')
              if (match) return <CodeBlock language={match[1]} code={code} />
              return <code className="term-inline-code" {...props}>{children}</code>
            },
            a({ href, children }) { return <a href={href} target="_blank" rel="noopener noreferrer" className="term-link">{children}</a> },
            blockquote({ children }) { return <blockquote className="term-blockquote">{children}</blockquote> },
            table({ children }) { return <div className="term-table-wrap"><table className="term-table">{children}</table></div> },
          }}>{text}</MarkdownRenderer>
        </Suspense>
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
  const [startedAt] = useState(() => Date.now())
  return <ReasoningBlock text={text} running startedAt={startedAt} />
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
    }).catch(error => {
      // 2026-08-02：失败不再完全静默——高亮库加载失败回退纯文本渲染（renderLines fallback），
      // 至少留一条日志便于排查；不弹横幅（单块降级不应打断用户）。
      if (!cancelled) console.warn('code highlight failed, falling back to plain text:', error)
    })
    return () => { cancelled = true }
  }, [language, code, isMultiLine])

  // 单行 → 内联代码风格（无 gutter）
  if (!isMultiLine) {
    return <code className="term-inline-code">{code}</code>
  }

  // 高亮 HTML 的逐行清洗是高亮结果的纯函数：只在 highlight 落地/变化时重算
  const sanitizedLines = useMemo(() => highlighted
    ? highlighted.html.split('\n').map(html => sanitizeHtml(html || '&nbsp;'))
    : null, [highlighted])

  // 多行 → │ gutter 风格（对齐 Peri TUI code_block_lines）
  // 将 starry-night 输出的 HTML 按 \n 拆行，每行包 gutter
  const renderLines = () => {
    if (!highlighted || !sanitizedLines) {
      return lines.map((line, i) => (
        <div key={i} className="term-code-line">
          <span className="term-code-gutter">│ </span>
          <span>{line || '\u00a0'}</span>
        </div>
      ))
    }
    return sanitizedLines.map((html, i) => (
      <div key={i} className="term-code-line">
        <span className="term-code-gutter">│ </span>
        <span dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    ))
  }

  return (
    <div className="term-code-block">
      {renderLines()}
    </div>
  )
}

function formatThoughtDuration(durationMs: number | undefined) {
  if (durationMs == null) return 'Thought complete'
  const seconds = Math.max(1, Math.round(durationMs / 1000))
  return `Thought for ${seconds}s`
}

function ReasoningBlock({ text, running, startedAt, durationMs }: { text: string; running: boolean; startedAt?: number; durationMs?: number }) {
  recordRender('ReasoningBlock.render')
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const bodyId = useId()

  useEffect(() => {
    if (!running) return
    const interval = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(interval)
  }, [running])

  const elapsedMs = running && startedAt ? Math.max(0, now - startedAt) : durationMs
  const label = running ? 'Thinking…' : formatThoughtDuration(elapsedMs)
  return (
    <div className="term-reasoning" data-state={running ? 'running' : 'complete'}>
      <button className="term-reasoning-head" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={bodyId}>
        <span className="term-reasoning-label">{label}</span>
        {running && elapsedMs != null && <span className="term-reasoning-elapsed">{Math.max(1, Math.floor(elapsedMs / 1000))}s</span>}
        <span className="term-reasoning-toggle" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="term-reasoning-body" id={bodyId}>{text.split('\n').map((line, i) => <div key={i} className="term-reasoning-line">{line || '\u00a0'}</div>)}</div>}
    </div>
  )
}

function ToolCard({ model }: { model: ReturnType<typeof buildToolPresentationModel> }) {
  recordRender('ToolCard.render')
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const indicatorAsset = resolveToolIndicatorAsset(useStore(s => s.toolIndicator))
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
  const connCss: React.CSSProperties = {
    ['--tool-conn' as never]: resolveConnectorColor(connectorMode, status, { toolOk, toolRun, toolErr }, connectorColor),
  }
  const suffix = model.state === 'completed' && model.outputLines > 0 ? ` — ${model.outputLabel}` : ''
  const outputHtml = useMemo(() => {
    if (!model.outputText || model.name !== 'Bash') return ''
    return sanitizeHtml(new Anser().ansiToHtml(Anser.escapeForHtml(model.outputText)))
  }, [model.outputText, model.name])
  return (
    <div className="term-tool" data-status={status} data-tool-state={model.state}
      data-output-collapsible={model.canCollapseOutput ? 'true' : 'false'} style={connCss}>
      <button className="term-tool-head" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={bodyId}>
        <span className={`term-tool-indicator ${status} ${toolIndicatorMotionClass(model.state)}`} style={glowCss} aria-label={indicatorAsset.ariaLabel[model.state]} role="img">{indicatorAsset.glyph}</span>
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
  const getUser = useIdentityStore(s => s.getUser)
  const storeUser = useStore(s => s.userName)
  const prefix = useStore(s => s.userPrefix) || '❯'
  const userColor = useStore(s => s.userColor)
  const user = getUser(sender)
  const name = storeUser || user?.name || sender.replace(/^.*:/, '')
  return (
    <div className="term-user">
      <span className="term-user-prefix" style={userColor ? { color: userColor } : {}}>{prefix}</span>
      <span className="term-user-name" style={userColor ? { color: userColor } : {}}>{name}</span>
      <Suspense fallback={<p className="term-p term-plain-text">{content}</p>}>
        <MarkdownRenderer>{content}</MarkdownRenderer>
      </Suspense>
    </div>
  )
}

export default ChatView
