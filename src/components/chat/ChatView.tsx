import { useRef, useEffect, useState, useMemo, useId, Suspense } from 'react'
import React from 'react'
import { useStore } from '../../store'
import { useIdentityStore } from '../../identityStore'
import { IS_TAURI } from '../../infrastructure/tauri/env'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import Anser from 'anser'
import GenerationFooter, { type GenerationPhase, type GenerationSummary } from './GenerationFooter'
import { resolveSpinnerFrames } from './spinnerFrames'
import { highlightCode } from './codeHighlight'
import { sanitizeHtml } from './htmlSanitizer'
import { recordMeasuredAsync, recordRender } from './renderMetrics'
import { prepareRenderableMessages, isMessageStatic } from './messagePipeline'
import type { Message as PipelineMessage, RenderMessage } from './messageTypes'
import { buildMessageLookups } from './messageLookups'
import { buildChatRowDescriptors } from './chatRowPipeline'
import { resolveConnectorColor } from './toolPresentation'
import { buildToolPresentationModel, truncateToolSummary } from './toolPresentationModel'
import { normalizeToolStatus, toolStatePresentation } from '../../domains/tool/status.ts'
import { toolIndicatorMotionClass } from './toolIndicatorMotion'
import { resolveToolIndicatorAsset } from './toolIndicatorAssets'
import { isPlainTextContent } from './markdownFastPath'
import { useMessageLocation } from './useMessageLocation'
import { MarkdownRenderer } from './markdownLazy'
import { MessageRenderBoundary } from './MessageRenderBoundary'
import { createMockMessages } from './chatMockData'
import DiffCard from './DiffCard'
import ToolConnector from './ToolConnector'
import TaskTree from './TaskTree'
import { useSessionLifecycle } from './useSessionLifecycle'
import { useScrollFollow } from './useScrollFollow'
import { useToolConnectors } from './useToolConnectors'
import { useMessageSearch } from './useMessageSearch'
import { useMessagePersistence } from './useMessagePersistence'
import './ChatView.css'

interface Props { sessionId: string | null }

type Message = PipelineMessage

// dev/浏览器 mock：无 Tauri 后端时（预览调样式用）展示的演示对话
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
  const [messages, setMessages] = useState<Message[]>(!IS_TAURI ? resolveInitialBrowserMessages() : [])
  const preparedMessages = useMemo(() => prepareRenderableMessages(messages), [messages])
  const messageLookups = useMemo(() => buildMessageLookups(messages), [messages])
  const [streamingText, setStreamingText] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const [generating, setGenerating] = useState(false)
  const [lastTokenAt, setLastTokenAt] = useState(0)
  const [summary, setSummary] = useState<GenerationSummary | null>(null)
  const [generationPhase, setGenerationPhase] = useState<GenerationPhase | null>(null)
  // CV-1：滚动跟随（状态机 + 监听 + 自动跟随 + 回底）抽入 useScrollFollow
  const { bottomRef, scrollToBottomRef } = useScrollFollow(chatViewRef, sessionId, messages, generating, streamingText, streamingThinking)
  // CV-2：Tool 连接线 DOM 测量（ResizeObserver 观察行元素）收敛为 hook
  useToolConnectors(chatViewRef, messages)
  const [mockPhaseIndex, setMockPhaseIndex] = useState(0)
  const mockGenerationStartRef = useRef(Date.now())
  // CV-3：搜索（状态/快捷键/匹配/索引/滚动定位/refs）收敛为 hook
  // W2-12：搜索 UI 迁右栏；hook 仍在此运行（共享 sessionUiState 状态，匹配/滚动定位行为不变），
  // ChatView 只消费高亮（searchMatches）与行注册（messageRefs）
  const { searchMatches, searchIndex, messageRefs } = useMessageSearch(sessionId, messages)
  // CV-4：会话生命周期（controller 挂接/切换/恢复/清理）收敛为 hook
  const { sessionRef, messageOwnerRef, controllerHandleRef } = useSessionLifecycle(sessionId, sessions, {
    setMessages, setStreamingText, setStreamingThinking, setGenerating, setGenerationPhase, setSummary, setLastTokenAt,
  })
  // CV-5：当前可见会话消息持久化收敛为 hook
  useMessagePersistence(sessionId, messages, { sessionRef, messageOwnerRef })
  // FE-AUD-003：跨会话搜索定位消费（hook 可测：scrollIntoView + 高亮 + 过期提示）
  const { locateId, locateError } = useMessageLocation(sessionId, messages, messageRefs)
  useEffect(() => {
    if (IS_TAURI) return
    const id = window.setInterval(() => setMockPhaseIndex(index => (index + 1) % MOCK_GENERATION_PHASES.length), 1800)
    return () => window.clearInterval(id)
  }, [])

  const browserMockPhase = !IS_TAURI ? MOCK_GENERATION_PHASES[mockPhaseIndex] : undefined
  const browserMockStart = mockGenerationStartRef.current
  const browserMockTokenCount = browserMockPhase?.kind === 'thinking' ? 320 : browserMockPhase?.kind === 'responding' ? 1480 : 860
  // 渲染编排（chatRowPipeline 纯函数）：preparedMessages + lookups + 搜索命中 →
  // 行描述符列表。输入引用不变则输出不变，行渲染由描述符驱动。
  const rowDescriptors = useMemo(
    () => {
      recordRender('messages.map')
      // locateId 并入搜索高亮（FE-AUD-003 定位目标同样高亮）
      return buildChatRowDescriptors(preparedMessages, messageLookups, searchMatches[searchIndex]?.id ?? locateId)
    },
    [preparedMessages, messageLookups, searchMatches, searchIndex, locateId],
  )

  // 当前可见会话的消息同步到 localStorage；后台会话在事件入口直接持久化
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
      {/* W2-12：搜索 UI 迁右栏（AgentContextPanel 驱动同一 sessionUiState 状态，hook 行为不变） */}
      {locateError && <div className="chat-locate-error" role="status">{locateError}</div>}
      <div className="term">
        <AnimatePresence initial={false}>
          {rowDescriptors.map(desc => (
            <React.Fragment key={desc.key}>
              {desc.showConnector && <ToolConnector
                status={desc.connectorStatus || 'run'}
                visualState={normalizeToolStatus(desc.connectorVisualState)}
              />}
              <MemoMessageRow
                renderMessage={desc.renderMessage}
                reduceMotion={reduceMotion === true}
                isStatic={isMessageStatic(desc.renderMessage)}
                toolVisualState={desc.toolVisualState}
                rowRef={node => {
                  if (node) messageRefs.current.set(desc.key, node)
                  else messageRefs.current.delete(desc.key)
                }}
                highlighted={desc.isSearchMatch}
              />
            </React.Fragment>
          ))}
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
          source={sessionRef.current}
          onStop={generating ? () => {
            if (!sessionRef.current) return
            controllerHandleRef.current?.requestCancel(sessionRef.current)
          } : undefined} />
        {/* P1-06：任务树在 spinner 下方、滚动锚点之前；无任务返回 null */}
        <TaskTree source={sessionRef.current} />
        <div ref={bottomRef} />
      </div>
      <button className="scroll-bottom-btn" onClick={() => scrollToBottomRef.current?.()}
        title="回到底端">▼</button>
    </div>
  )
})

// ── Sub-components ──


export function MessageRow({ renderMessage, reduceMotion, toolVisualState, rowRef, highlighted, isStatic }: { renderMessage: RenderMessage; reduceMotion: boolean; toolVisualState?: string; rowRef?: (node: HTMLDivElement | null) => void; highlighted?: boolean; isStatic?: boolean }) {
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

export function AssistantContent({ text, isStreaming = false }: { text: string; isStreaming?: boolean }) {
  recordRender('AssistantContent.render')
  recordRender('markdown.parse')
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  useEffect(() => () => {
    if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current)
  }, [])
  const copy = () => {
    // 剪贴板权限缺失时静默降级（避免 unhandled rejection）
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(true)
    if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current)
    copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000)
  }
  // CC 视觉还原：assistantDot 时助手消息左侧圆点（claude 预设启用）。
  // 结构同 CC AssistantTextMessage：flex row 圆点列 + 内容列，圆点与首行共享 line box 基线对齐；
  // 圆点列宽 --dot-col-width 与工具指示共列；颜色随消息文字（--msg-text 链，claude 预设为纯白）。
  // 单条消息一个圆点（多段落 markdown 共用一个，首块无上边距，圆点贴首行）。
  const assistantDot = useStore(s => s.assistantDot)
  const assistantDotGlyph = useStore(s => s.assistantDotGlyph)
  return (
    <div className={`term-assistant${assistantDot ? ' has-dot' : ''}`}>
      {assistantDot && <span className="term-assistant-dot" aria-hidden="true">{assistantDotGlyph || '●'}</span>}
      <button className="copy-btn" onClick={copy}>{copied ? '✓' : '⎘'}</button>
      <div className="term-assistant-body">
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

  // 高亮 HTML 的逐行清洗是高亮结果的纯函数：只在 highlight 落地/变化时重算。
  // 必须在 early return 之前调用——流式输出时同一实例 code 从单行变多行，
  // 条件性调用会改变 hook 数导致 "Rendered more hooks than during the previous render"。
  const sanitizedLines = useMemo(() => highlighted
    ? highlighted.html.split('\n').map(html => sanitizeHtml(html || '&nbsp;'))
    : null, [highlighted])

  // 单行 → 内联代码风格（无 gutter）
  if (!isMultiLine) {
    return <code className="term-inline-code">{code}</code>
  }

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
  const status = toolStatePresentation(model.state, model.hasOutput).tone
  const displaySummary = truncateToolSummary(model.summary)
  const displayStatus = model.state !== 'unknown' ? model.statusLabel : ''
  const glowCss = glow > 0
    ? { textShadow: `0 0 ${glow}px ${glowColor || (status === 'ok' ? toolOk : status === 'err' ? toolErr : toolRun) || 'currentColor'}` }
    : undefined
  const connCss: React.CSSProperties = {
    ['--tool-conn' as never]: resolveConnectorColor(connectorMode, status, { toolOk, toolRun, toolErr }, connectorColor),
  }
  // P1-10：语义 kind 判定（Hermes terminal 等 execute 类工具同样获得 ANSI 渲染，不再按 Peri 工具名碰运气）
  const isExecute = model.kind === 'execute'
  const suffix = model.state === 'completed' && model.outputLines > 0 ? ` — ${model.outputLabel}` : ''
  // isExecute = model.kind === 'execute'，kind 已在 deps（传递依赖）
  const outputHtml = useMemo(() => {
    if (!model.outputText || !isExecute) return ''
    return sanitizeHtml(new Anser().ansiToHtml(Anser.escapeForHtml(model.outputText)))
  }, [model.outputText, model.kind]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="term-tool" data-status={status} data-tool-state={model.state} data-kind={model.kind}
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
          {model.isDiffCandidate && <DiffCard output={model.outputText} payload={model.diffPayload} />}
          {isExecute && outputHtml
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
      <div className="term-user-content">
        <Suspense fallback={<span className="term-p term-plain-text">{content}</span>}>
          <MarkdownRenderer>{content}</MarkdownRenderer>
        </Suspense>
      </div>
    </div>
  )
}

export default ChatView
