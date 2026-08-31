import { useRef, useEffect, useState, useMemo, useId, Suspense, useSyncExternalStore, useLayoutEffect } from 'react'
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
import { resolveConnectorColor } from '../../domains/tool/toolPresentation'
import { buildToolPresentationModel, truncateToolSummary } from './toolPresentationModel'
import { normalizeToolStatus, toolStatePresentation } from '../../domains/tool/status.ts'
import { toolIndicatorMotionClass } from './toolIndicatorMotion'
import { resolveToolIndicatorAssetForTone } from './toolIndicatorAssets'
import { isPlainTextContent } from './markdownFastPath'
import { useMessageLocation } from './useMessageLocation'
import { MarkdownRenderer } from './markdownLazy'
import AgentEmptyState from './AgentEmptyState.tsx'
import { MessageRenderBoundary } from './MessageRenderBoundary'
import { createMockMessages } from './chatMockData'
import { messageStorageKey, parseMessageSnapshot } from './messagePersistence'
import DiffCard from './DiffCard'
import ToolConnector from './ToolConnector'
import TaskTree from './TaskTree'
import { useSessionLifecycle } from './useSessionLifecycle'
import { useScrollFollow } from './useScrollFollow'
import { useToolConnectors } from './useToolConnectors'
import { useMessageSearch } from './useMessageSearch'
import {
  getMessageRendererSnapshot,
  resolveFallbackMessageRendererEntry,
  resolveMessageRendererEntry,
  subscribeMessageRenderers,
} from '../../host/messageRendererResolver.ts'
import type { MessageRenderContext, MessageRendererInput } from '../../plugin-runtime/renderers/rendererTypes.ts'
import type {
  RenderAppearanceSnapshot,
  RenderCommandPort,
  RenderNodeSnapshot,
  RenderSurface,
} from '../../contracts/messageRenderer.ts'
import { usePresentationPreferenceStore } from '../../domains/presentation/presentationPreferenceStore.ts'
import CollapsibleRegion from './CollapsibleRegion.tsx'
import { useShallow } from 'zustand/react/shallow'
import { Bot, BrainCircuit, Check, Copy, FilePenLine, FileSearch, Search, Terminal, UserRound, Wrench } from 'lucide-react'
import { useInterfaceModeStore } from '../../domains/interface/interfaceModeStore.ts'
import { formatThoughtDuration } from '../../domains/rendererContent/reasoningPresentation.ts'

interface Props {
  sessionId: string | null
  workspaceKind?: string
  workspaceMode?: 'work' | 'chat'
  agentId?: string
  onSelectSession: (id: string) => void
  sidebarCollapsed?: boolean
  onExpandSidebar?: () => void
}

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

const ChatView = React.memo(function ChatView({ sessionId, workspaceKind = 'agent', workspaceMode, agentId, onSelectSession, sidebarCollapsed, onExpandSidebar }: Props) {
  recordRender('ChatView.render')
  const reduceMotion = useReducedMotion()
  const sessions = useIdentityStore(state => state.sessions)
  const chatViewRef = useRef<HTMLDivElement>(null)
  // Resolve the browser/demo snapshot only on mount.  The benchmark mode can
  // materialise up to 5,000 messages; evaluating it as a normal `useState`
  // argument rebuilt that array on every parent render even though React only
  // uses the value during the initial mount.
  const [messages, setMessages] = useState<Message[]>(() => (
    !IS_TAURI ? resolveInitialBrowserMessages() : []
  ))
  // 浏览器 demo：按会话恢复真实快照消息（搜索定位依赖快照内容；demo seed 已写 pylon-msgs-*）
  useEffect(() => {
    if (IS_TAURI || !sessionId) return
    const cached = parseMessageSnapshot<Message>(localStorage.getItem(messageStorageKey(sessionId)))
    setMessages(cached && cached.length > 0 ? cached : [])
  }, [sessionId])
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
  const { sessionRef, controllerHandleRef, recoveryFailure, replayIntegrity, retryRecovery, createFork } = useSessionLifecycle(sessionId, sessions, {
    setMessages, setStreamingText, setStreamingThinking, setGenerating, setGenerationPhase, setSummary, setLastTokenAt,
  }, onSelectSession)
  // A1-c P4：messages 表写入已停止；canonical_events 是前端唯一会话数据写入（见 chatEventController）。
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
  // M4：主 shell 只经 registry 查询 renderer 能力（零视觉变化；数据属性供测试与诊断）。
  const rendererSnapshot = useSyncExternalStore(
    subscribeMessageRenderers,
    getMessageRendererSnapshot,
    getMessageRendererSnapshot,
  )
  const messageRendererIds = rendererSnapshot.messageRenderers.map(entry => entry.value.renderer.rendererId)
  const preferredMessageRendererId = usePresentationPreferenceStore(state => state.messageRendererId)
  const rendererAppearance = useStore(useShallow(state => ({
    userName: state.userName,
    userPrefix: state.userPrefix,
    userColor: state.userColor,
    assistantDot: state.assistantDot,
    assistantDotGlyph: state.assistantDotGlyph,
    assistantDotImage: state.assistantDotImage,
    toolIndicator: state.toolIndicator,
    toolIndicatorRun: state.toolIndicatorRun,
    toolIndicatorOk: state.toolIndicatorOk,
    toolIndicatorErr: state.toolIndicatorErr,
    toolIndicatorGlow: state.toolIndicatorGlow,
    toolIndicatorGlowColor: state.toolIndicatorGlowColor,
  })))
  const sessionOwner = sessions.find(session => session.id === sessionId)?.agentId
  const rendererContext = useMemo<MessageRenderContext | undefined>(() => sessionId ? ({
    workspaceKind,
    ...(workspaceMode ? { workspaceMode } : {}),
    agentId: agentId || sessionOwner || '',
    sessionId,
  }) : undefined, [workspaceKind, workspaceMode, agentId, sessionOwner, sessionId])

  // 无会话（含切换 Profile 未指定会话）→ 品牌空态；有会话才渲染消息
  if (!sessionId) return <AgentEmptyState
    workspaceMode={workspaceMode ?? 'work'}
    sidebarCollapsed={sidebarCollapsed}
    onExpandSidebar={onExpandSidebar}
  />

  return (
    <div className="chat-view" ref={chatViewRef} data-message-renderer={messageRendererIds.join(',')} data-pylon-component="message-list">
      {/* W2-12：搜索 UI 迁右栏（AgentContextPanel 驱动同一 sessionUiState 状态，hook 行为不变） */}
      {locateError && <div className="chat-locate-error" role="status">{locateError}</div>}
      {recoveryFailure?.sessionId === sessionId && (
        <div className="chat-recovery-error" role="alert">
          <div>
            <strong>会话恢复失败，原远端绑定已保留。</strong>
            <span>{recoveryFailure.message}</span>
          </div>
          <div className="chat-recovery-actions">
            <button type="button" onClick={retryRecovery}>重试恢复</button>
            <button type="button" onClick={createFork}>创建分叉会话</button>
          </div>
        </div>
      )}
      {replayIntegrity?.sessionId === sessionId && (
        <div className="chat-replay-warning" role="status">
          <strong>远端重放不完整，本地 canonical 历史仍保留。</strong>
          <span>{replayIntegrity.metadata.truncated
            ? `仅保留最近 ${replayIntegrity.metadata.boundary.observedCount - replayIntegrity.metadata.droppedCount} 条，较早的 ${replayIntegrity.metadata.droppedCount} 条已超出回放上限。`
            : '后端未提供可验证的重放完整性元数据。'}</span>
        </div>
      )}
      <div className="term">
        {messages.length === 0 && !streamingText && !streamingThinking && !generating && (
          <div className="chat-empty agent-empty-state" data-empty-state="session" role="status" aria-label="会话为空">
            <h2 className="agent-empty-title">暂无消息</h2>
            <p className="agent-empty-description">发送一条消息开始当前会话。</p>
          </div>
        )}
        <AnimatePresence initial={false}>
          {rowDescriptors.map(desc => (
            <React.Fragment key={desc.key}>
              {desc.showConnector && <ToolConnector
                status={desc.connectorStatus || 'run'}
                visualState={normalizeToolStatus(desc.connectorVisualState)}
              />}
              <MessageRendererHost
                renderMessage={desc.renderMessage}
                reduceMotion={reduceMotion === true}
                isStatic={isMessageStatic(desc.renderMessage)}
                toolVisualState={desc.toolVisualState}
                rowRef={node => {
                  if (node) messageRefs.current.set(desc.key, node)
                  else messageRefs.current.delete(desc.key)
                }}
                highlighted={desc.isSearchMatch}
                rendererContext={rendererContext}
                rendererRevision={rendererSnapshot.revision}
                rendererId={preferredMessageRendererId === 'auto' ? undefined : preferredMessageRendererId}
                rendererAppearance={rendererAppearance}
              />
            </React.Fragment>
          ))}
        </AnimatePresence>
        {streamingThinking && (
          <div className="term-row term-row-reasoning" data-pylon-component="message" data-message-role="reasoning">
            <StreamingThinking text={streamingThinking} />
          </div>
        )}
        {streamingText && (
          <div className="term-row term-row-assistant" data-pylon-component="message" data-message-role="assistant">
            <StreamingAssistantText text={streamingText} />
          </div>
        )}
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

type MessageRowProps = {
  renderMessage: RenderMessage
  reduceMotion: boolean
  toolVisualState?: string
  rowRef?: (node: HTMLDivElement | null) => void
  highlighted?: boolean
  isStatic?: boolean
}

const MESSAGE_RENDER_COMMANDS: RenderCommandPort = Object.freeze({
  execute: () => undefined,
})

type MessageRendererHostProps = MessageRowProps & {
  rendererContext?: MessageRenderContext
  rendererRevision: number
  rendererId?: string
  rendererAppearance?: unknown
  rendererCommands?: RenderCommandPort
}

/**
 * Renderer hosts sit on the message-list hot path.  The parent renders again
 * for spinner ticks and streaming text, but those updates do not change a
 * settled message.  In particular, `rowRef` is intentionally ignored here:
 * ChatView creates the registration closure while mapping rows, and treating
 * that closure as semantic data would force every external surface to receive
 * a needless `update` on each parent render.
 */
export const MessageRendererHost = React.memo(function MessageRendererHost(props: MessageRendererHostProps) {
  const { rendererContext, rendererRevision, rendererId, rendererAppearance, rendererCommands, ...rowProps } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const mountedRef = useRef<{ surface: RenderSurface; handle: unknown; unsubscribeError: () => void } | null>(null)
  const nodeRevisionRef = useRef(0)
  const [failedContributionId, setFailedContributionId] = useState<string | null>(null)

  const input = useMemo<MessageRendererInput>(() => ({
    role: rowProps.renderMessage.message.role,
    ...(rendererId ? { rendererId } : {}),
    payload: rowProps.renderMessage.message,
    ...(rendererContext ? { context: rendererContext } : {}),
  }), [rowProps.renderMessage.message, rendererContext, rendererId])

  const selected = failedContributionId
    ? resolveFallbackMessageRendererEntry({ ...input, rendererId: undefined }, failedContributionId)
    : resolveMessageRendererEntry(input)
  const selectedId = selected?.contributionId

  const appearance = useMemo<RenderAppearanceSnapshot>(() => {
    const value = rendererAppearance && typeof rendererAppearance === 'object'
      ? rendererAppearance as Record<string, unknown>
      : {}
    return Object.isFrozen(value) ? value : Object.freeze({ ...value })
  }, [rendererAppearance])
  const semanticPayload = useMemo(() => Object.freeze({
    renderMessage: rowProps.renderMessage,
    reduceMotion: rowProps.reduceMotion,
    toolVisualState: rowProps.toolVisualState,
    rowRef: rowProps.rowRef,
    highlighted: rowProps.highlighted,
    isStatic: rowProps.isStatic,
  }), [
    rowProps.renderMessage, rowProps.reduceMotion, rowProps.toolVisualState,
    rowProps.rowRef, rowProps.highlighted, rowProps.isStatic,
  ])
  const semanticSnapshot = useMemo<RenderNodeSnapshot>(() => Object.freeze({
    nodeId: rowProps.renderMessage.message.id,
    kind: `message.${rowProps.renderMessage.message.role}`,
    revision: ++nodeRevisionRef.current,
    payload: semanticPayload,
  }), [rowProps.renderMessage.message.id, rowProps.renderMessage.message.role, semanticPayload])
  const latestMountRef = useRef({ input, semanticSnapshot, appearance, rowProps })
  latestMountRef.current = { input, semanticSnapshot, appearance, rowProps }

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container || !selected) return
    const initial = latestMountRef.current
    let surface: ReturnType<typeof selected.value.renderer.renderMessage> | undefined
    let handle: unknown
    let unsubscribeError = () => {}
    try {
      surface = selected.value.renderer.renderMessage(initial.rowProps)
      unsubscribeError = surface.on('error', error => {
        const decision = selected.value.onError?.(error, initial.input) ?? 'fallback'
        if (decision === 'rethrow') {
          console.error('Message renderer async error', error)
          return
        }
        setFailedContributionId(current => current ?? selected.contributionId)
      })
      handle = surface.mount(container, initial.semanticSnapshot, initial.appearance, rendererCommands ?? MESSAGE_RENDER_COMMANDS)
      mountedRef.current = { surface, handle, unsubscribeError }
    } catch (error) {
      unsubscribeError()
      const decision = selected.value.onError?.(error, initial.input) ?? 'fallback'
      if (decision === 'rethrow') throw error
      setFailedContributionId(selected.contributionId)
    }
    return () => {
      const mounted = mountedRef.current
      mountedRef.current = null
      if (!mounted) return
      mounted.unsubscribeError()
      try {
        mounted.surface.destroy(mounted.handle)
      } catch (error) {
        if (selected.value.onError?.(error, initial.input) === 'rethrow') throw error
      }
    }
  }, [selected, selectedId, rendererCommands]) // mount 只随 renderer identity/command port 变化；snapshot 由下方 update 推送

  useEffect(() => {
    const mounted = mountedRef.current
    if (!mounted) return
    try {
      mounted.surface.update(mounted.handle, semanticSnapshot, appearance)
    } catch (error) {
      const decision = selected?.value.onError?.(error, input) ?? 'fallback'
      if (decision === 'rethrow') throw error
      if (selected) setFailedContributionId(selected.contributionId)
    }
  }, [semanticSnapshot, appearance, input, selected])

  useEffect(() => {
    setFailedContributionId(null)
  }, [rendererRevision, rendererId, rendererContext?.workspaceKind, rendererContext?.workspaceMode, rendererContext?.agentId, rendererContext?.sessionId])

  if (!selected) return <MemoMessageRow {...rowProps} />
  return <div className="message-renderer-host" data-message-renderer={selected.value.renderer.rendererId} ref={containerRef} />
}, areMessageRendererHostPropsEqual)

function areMessageRendererHostPropsEqual(
  previous: MessageRendererHostProps,
  next: MessageRendererHostProps,
): boolean {
  return previous.renderMessage.message === next.renderMessage.message
    && previous.renderMessage.type === next.renderMessage.type
    && previous.reduceMotion === next.reduceMotion
    && previous.toolVisualState === next.toolVisualState
    && previous.highlighted === next.highlighted
    && previous.isStatic === next.isStatic
    && previous.rendererContext === next.rendererContext
    && previous.rendererRevision === next.rendererRevision
    && previous.rendererId === next.rendererId
    && previous.rendererAppearance === next.rendererAppearance
    && previous.rendererCommands === next.rendererCommands
}


export function MessageRow({ renderMessage, reduceMotion, toolVisualState, rowRef, highlighted, isStatic }: MessageRowProps) {
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
      data-pylon-component="message"
      data-message-role={msg.role}
      initial={skipEntrance ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.25, ease: [0.2, 0, 0, 1] }}
    >
      {toolModel && <ToolCard model={toolModel} />}
      {renderMessage.type === 'user' && <UserLine sender={msg.sender} content={msg.content} />}
      {renderMessage.type === 'reasoning' && <ReasoningBlock
        text={msg.content}
        running={msg.running === true}
        durationMs={msg.thoughtDurationMs}
        redacted={msg.redacted === true}
        redactedReason={msg.redactedReason}
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
  previous: MessageRowProps,
  next: MessageRowProps,
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

export function AssistantContent({ text }: { text: string }) {
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
  const { assistantDot, assistantDotGlyph, assistantDotImage } = useStore(useShallow(s => ({
    assistantDot: s.assistantDot,
    assistantDotGlyph: s.assistantDotGlyph,
    assistantDotImage: s.assistantDotImage,
  })))
  const modernGui = useInterfaceModeStore(state => state.interfaceMode === 'modern-gui')
  return (
    <div className={`term-assistant${assistantDot ? ' has-dot' : ''}`}>
      {assistantDot && (assistantDotImage
        ? <img className="term-assistant-dot-img" src={assistantDotImage} alt="" aria-hidden="true" />
        : <span className="term-assistant-dot" aria-hidden="true">{modernGui ? <Bot size={16} /> : (assistantDotGlyph || '●')}</span>)}
      <button className="copy-btn" onClick={copy} aria-label={copied ? '已复制' : '复制消息'}>{modernGui ? (copied ? <Check size={14} /> : <Copy size={14} />) : (copied ? '✓' : '⎘')}</button>
      <div className="term-assistant-body">
        {!isPlainTextContent(text) ? (
        <Suspense fallback={<p className="term-p term-plain-text">{text}</p>}>
          <MarkdownRenderer components={{
            // Keep the React fallback on the same block/whitespace contract as
            // the Solid Workbench renderer.  Without an explicit class the
            // global margin reset and HTML whitespace collapsing eat the blank
            // lines as soon as a stream becomes a committed Markdown message.
            p: props => <p className="term-p" {...props} />,
            li: props => <li className="term-li" {...props} />,
            // CSS-02：Markdown heading 显式 class contract（§5.15 step 3）——h1-h6 输出
            // term-h1~term-h6，配合 ChatView.css 限定 .term-assistant 内的层级规则。
            h1: props => <h1 className="term-h1" {...props} />,
            h2: props => <h2 className="term-h2" {...props} />,
            h3: props => <h3 className="term-h3" {...props} />,
            h4: props => <h4 className="term-h4" {...props} />,
            h5: props => <h5 className="term-h5" {...props} />,
            h6: props => <h6 className="term-h6" {...props} />,
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
  return <AssistantContent text={text} />
}

function StreamingThinking({ text }: { text: string }) {
  recordRender('streamingThinking.render')
  return <ReasoningBlock text={text} running />
}

function CodeBlock({ language, code }: { language?: string; code: string }) {
  recordRender('CodeBlock.render')
  const lines = code.split('\n')
  const isMultiLine = lines.length > 1
  const highlightKey = `${language || 'text'}\u0000${code}`
  const [highlighted, setHighlighted] = useState<{ html: string; key: string } | null>(null)

  useEffect(() => {
    // A CodeBlock instance is reused while a stream grows or changes language.
    // Invalidate the previous result immediately; otherwise the old HTML can
    // remain visible for one or more renders while the new grammar loads.
    setHighlighted(null)
    if (!isMultiLine) return
    let cancelled = false
    const lang = language || 'text'
    recordRender('highlightCode.call')
    recordMeasuredAsync('CodeBlock.highlight', highlightCode(lang, code)).then(html => {
      if (html && !cancelled) setHighlighted({ html, key: highlightKey })
    }).catch(error => {
      // 2026-08-02：失败不再完全静默——高亮库加载失败回退纯文本渲染（renderLines fallback），
      // 至少留一条日志便于排查；不弹横幅（单块降级不应打断用户）。
      if (!cancelled) console.warn('code highlight failed, falling back to plain text:', error)
    })
    return () => { cancelled = true }
  }, [language, code, highlightKey, isMultiLine])

  const currentHighlight = highlighted?.key === highlightKey ? highlighted : null

  // 高亮 HTML 的逐行清洗是高亮结果的纯函数：只在 highlight 落地/变化时重算。
  // 必须在 early return 之前调用——流式输出时同一实例 code 从单行变多行，
  // 条件性调用会改变 hook 数导致 "Rendered more hooks than during the previous render"。
  const sanitizedLines = useMemo(() => currentHighlight
    ? currentHighlight.html.split('\n').map(html => sanitizeHtml(html || '&nbsp;'))
    : null, [currentHighlight])

  // 单行 → 内联代码风格（无 gutter）
  if (!isMultiLine) {
    return <code className="term-inline-code">{code}</code>
  }

  // 多行 → │ gutter 风格（对齐 Peri TUI code_block_lines）
  // 将 starry-night 输出的 HTML 按 \n 拆行，每行包 gutter
  const renderLines = () => {
    if (!currentHighlight || !sanitizedLines) {
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

function ReasoningBlock({ text, running, durationMs, redacted, redactedReason }: { text: string; running: boolean; durationMs?: number; redacted?: boolean; redactedReason?: string }) {
  recordRender('ReasoningBlock.render')
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const modernGui = useInterfaceModeStore(state => state.interfaceMode === 'modern-gui')

  // C01 四态（React generic fallback）：running / complete / redacted(reason) / missing。
  // 卡面步骤5：至少显示"思考过程/内容已隐藏"与可见文本；redacted 不渲染正文、无展开按钮。
  const state = redacted ? 'redacted' : running ? 'running' : text.trim() ? 'complete' : 'missing'
  const label = redacted
    ? '推理已被隐藏'
    : running
      ? 'Thinking…'
      : text.trim() ? durationMs !== undefined ? formatThoughtDuration(durationMs) : '思考过程' : '暂无思考内容'
  if (state === 'redacted' || state === 'missing') {
    return (
      <div className="term-reasoning" data-state={state}>
        <div className="term-reasoning-head term-reasoning-static">
          <span className="term-reasoning-label">{label}</span>
          {state === 'redacted' && redactedReason && <span className="term-reasoning-reason">{redactedReason}</span>}
        </div>
      </div>
    )
  }
  return (
    <div className="term-reasoning" data-state={state}>
      <button className="term-reasoning-head" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={bodyId}>
        {modernGui && <BrainCircuit className="term-reasoning-icon" size={15} aria-hidden="true" />}
        <span className="term-reasoning-label">{label}</span>
        <span className="term-reasoning-toggle" aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      <CollapsibleRegion open={open} id={bodyId}>
        <div className="term-reasoning-body">{text.split('\n').map((line, i) => <div key={i} className="term-reasoning-line">{line || '\u00a0'}</div>)}</div>
      </CollapsibleRegion>
    </div>
  )
}

function ToolCard({ model }: { model: ReturnType<typeof buildToolPresentationModel> }) {
  recordRender('ToolCard.render')
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const {
    glow: rawGlow,
    glowColor: rawGlowColor,
    toolOk,
    toolRun,
    toolErr,
    connectorMode: rawConnectorMode,
    connectorColor: rawConnectorColor,
    toolIndicator,
    toolIndicatorRun,
    toolIndicatorOk,
    toolIndicatorErr,
  } = useStore(useShallow(s => ({
    glow: s.toolIndicatorGlow,
    glowColor: s.toolIndicatorGlowColor,
    toolOk: s.toolOk,
    toolRun: s.toolRun,
    toolErr: s.toolErr,
    connectorMode: s.toolConnectorMode,
    connectorColor: s.toolConnectorColor,
    toolIndicator: s.toolIndicator,
    toolIndicatorRun: s.toolIndicatorRun,
    toolIndicatorOk: s.toolIndicatorOk,
    toolIndicatorErr: s.toolIndicatorErr,
  })))
  const glow = rawGlow || 0
  const glowColor = rawGlowColor || ''
  const connectorMode = rawConnectorMode || 'none'
  const connectorColor = rawConnectorColor || 'rgba(0,0,0,0.12)'
  const modernGui = useInterfaceModeStore(state => state.interfaceMode === 'modern-gui')
  const status = toolStatePresentation(model.state, model.hasOutput).tone
  const indicatorAsset = resolveToolIndicatorAssetForTone(status, {
    toolIndicator,
    toolIndicatorRun,
    toolIndicatorOk,
    toolIndicatorErr,
  })
  const displaySummary = truncateToolSummary(model.summary)
  const glowCss = glow > 0
    ? { textShadow: `0 0 ${glow}px ${glowColor || (status === 'ok' ? toolOk : status === 'err' ? toolErr : toolRun) || 'currentColor'}` }
    : undefined
  const connCss: React.CSSProperties = {
    ['--tool-conn' as never]: resolveConnectorColor(connectorMode, status, { toolOk, toolRun, toolErr }, connectorColor),
  }
  // P1-10：语义 kind 判定（Hermes terminal 等 execute 类工具同样获得 ANSI 渲染，不再按 Peri 工具名碰运气）
  const isExecute = model.kind === 'execute'
  // isExecute = model.kind === 'execute'，kind 已在 deps（传递依赖）
  const outputHtml = useMemo(() => {
    if (!model.outputText || !isExecute) return ''
    return sanitizeHtml(new Anser().ansiToHtml(Anser.escapeForHtml(model.outputText)))
  }, [model.outputText, isExecute])
  return (
    <div className="term-tool" data-status={status} data-tool-state={model.state} data-kind={model.kind}
      data-status-label={model.statusLabel}
      data-pylon-component="tool-call"
      data-output-collapsible={model.canCollapseOutput ? 'true' : 'false'} style={connCss}>
      <button className="term-tool-head" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls={bodyId}>
        <span className={`term-tool-indicator ${status} ${toolIndicatorMotionClass(model.state)}`} style={glowCss} aria-label={indicatorAsset.ariaLabel[model.state]} role="img">{modernGui ? <ModernToolIcon name={model.name} /> : indicatorAsset.glyph}</span>
        <span className="term-tool-name">{model.name}</span>
        {displaySummary && <span className="term-tool-summary">({displaySummary})</span>}
        <span className="term-tool-state-label">— {model.statusLabel}</span>
      </button>
      {model.hasOutput && <CollapsibleRegion open={open} id={bodyId}>
        <div className="term-tool-body">
          <span className={`term-tool-label term-tool-label-output${model.errorText ? ' term-tool-label-error' : ''}`}>{model.errorText ? '错误' : '输出'}{model.outputLabel ? ` · ${model.outputLabel}` : ''}</span>
          {model.isDiffCandidate && <DiffCard output={model.outputText} payload={model.diffPayload} />}
          {isExecute && outputHtml
            ? <div className="term-ansi" dangerouslySetInnerHTML={{ __html: outputHtml }} />
            : <pre><code>{model.outputText}</code></pre>}
        </div>
      </CollapsibleRegion>}
    </div>
  )
}

function ModernToolIcon({ name }: { name: string }) {
  const normalized = name.toLowerCase()
  const Icon = normalized.includes('read') ? FileSearch
    : normalized.includes('grep') || normalized.includes('search') ? Search
      : normalized.includes('bash') || normalized.includes('shell') || normalized.includes('terminal') ? Terminal
        : normalized.includes('edit') || normalized.includes('write') ? FilePenLine
          : Wrench
  return <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
}

function UserLine({ sender, content }: { sender: string; content: string }) {
  const getUser = useIdentityStore(s => s.getUser)
  const { storeUser, rawPrefix, userColor } = useStore(useShallow(s => ({
    storeUser: s.userName,
    rawPrefix: s.userPrefix,
    userColor: s.userColor,
  })))
  const prefix = rawPrefix || '❯'
  const user = getUser(sender)
  const modernGui = useInterfaceModeStore(state => state.interfaceMode === 'modern-gui')
  const name = storeUser || user?.name || sender.replace(/^.*:/, '')
  return (
    <div className="term-user">
      {modernGui && <span className="term-user-avatar" aria-hidden="true"><UserRound size={15} /></span>}
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
