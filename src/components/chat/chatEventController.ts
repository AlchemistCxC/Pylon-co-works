import type React from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useStore } from '../../store'
import { useIdentityStore } from '../../identityStore'
import { useRuntimeStore } from '../../runtimeStore'
import { resolveSpinnerFrames } from './spinnerFrames'
import { extractUsage, extractPlanEntries, type ContentBlock, type PeriDonePayload, type PeriUpdatePayload } from '../../infrastructure/acp/chatContracts'
import { applySessionStateUpdate } from '../../domains/sessionState/sessionStateSync.ts'
import { normalizeRawEvent, type CanonicalNormalizeResult } from '../../domains/events/canonicalNormalizer'
import { toolFieldsFromCanonical } from '../../domains/events/toolProjection'
import { toCanonicalOwnerKey, type CanonicalEventOwner } from '../../domains/events/eventSchema'
import { IS_TAURI } from '../../infrastructure/tauri/env'
import { createCanonicalEventSink, type CanonicalEventSink } from '../../infrastructure/events/canonicalEventSink'
import { tauriCanonicalEventRepository, type CanonicalEventRow } from '../../infrastructure/events/canonicalEventRepository.ts'
import { CanonicalEventCursor } from '../../infrastructure/events/canonicalEventCursor.ts'
import { publishPluginEvent } from '../../infrastructure/events/pluginEventBus.ts'
import { createChatClient } from '../../infrastructure/acp/chatClient'
import { clearMessageStorage } from './messagePersistence'
import { addGeneratingSource, removeGeneratingSource } from './sessionEventState'
import { reportRuntimeError } from '../../runtimeError'
import { applyChatEvent, createSourceChatRuntime, type ChatEvent, type ChatRuntimeState, type SourceChatRuntime } from './sessionRuntimeStore.ts'
import type { Message } from './messageTypes.ts'
import type { GenerationPhase, GenerationSummary } from './GenerationFooter'
import type { GenerationActivitySnapshot } from '../../domains/workbench/generationFooterContracts.ts'
import type { PlanEntry } from '../../domains/tasks/planTypes.ts'
import { createHorizontalSubscription } from './horizontalSubscription.ts'
import { extractTouchedPath } from '../../infrastructure/acp/touchedFiles.ts'
import { useWorkspaceStore } from '../../workspaceStore'
import type { AgentContext, AgentContextKey } from '../../agentContext'
import { sessionContext, toAgentContextKey } from '../../agentContext'
import { detectChatIdentityCapabilities, extractExternalIdentity, reconcileIngressMessages, type ChatIdentityCapabilities } from './messageIdentity'
import { hasEnabledHooks, runHookPhase } from '../../host/hookPipeline.ts'
import type { HookContext, HookPhase } from '../../contracts/agentHook.ts'
import { runSessionBoundaryHook } from './hookRuntime.ts'
import { getHookRuntime } from '../../plugin-runtime/runtimeServices.ts'
import type { HookName } from '../../plugin-runtime/hooks/hookTypes.ts'

export interface ChatEventControllerRefs {
  sessionRef: React.RefObject<string | null>
  messageOwnerRef: React.RefObject<string | null>
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
  setStreamingText: React.Dispatch<React.SetStateAction<string>>
  setStreamingThinking: React.Dispatch<React.SetStateAction<string>>
  setGenerating: React.Dispatch<React.SetStateAction<boolean>>
  setGenerationPhase: React.Dispatch<React.SetStateAction<GenerationPhase | null>>
  setSummary: React.Dispatch<React.SetStateAction<GenerationSummary | null>>
  setLastTokenAt: React.Dispatch<React.SetStateAction<number>>
}

export interface ChatControllerHandle {
  /** 取消当前生成（footer 停止按钮）：begin-cancel → invoke → cancel-success/rejected */
  requestCancel: (source: string) => void
  /** 乐观渲染（方案 B）：发送即把用户消息写入 Chat runtime 并启动生成态；
   * 返回 clientMsgId 供去重。InputBar 发送时先调本方法再发 IPC。 */
  sendOptimisticUser: (source: string, content: string, clientMsgId: string, options?: { persistCanonical?: boolean }) => void
  /** 后端 pylon:user 到达：按 clientMsgId 确认乐观消息（去重）。 */
  confirmUser: (source: string, clientMsgId: string) => void
  /** 发送命令被 transport 拒绝：撤销 runtime-local 乐观行及其生成态。 */
  rejectOptimisticUser: (source: string, clientMsgId: string) => void
  /** 开始 source-scoped load，返回单调 generation。 */
  beginLoadLock: (source: string) => number
  /** 仅当前 generation 可以释放 source-scoped load lock。 */
  finishLoadLock: (source: string, generation: number) => void
  /** load 期间 prompt 必须排队，不与 replay 并发。 */
  isSendBlockedDuringLoad: (source: string) => boolean
  /** 会话切换/恢复：注入本地缓存消息，返回当前有效消息（controller 内已有则优先） */
  initSource: (source: string, cached: Message[], preserveRuntime?: boolean, baseFromCanonical?: boolean) => Message[]
  /** load_persisted_session 返回的完整 replay snapshot：解析并原子提交。
   * 必须持有同代 beginLoadLock 的 generation；调用方在 useSessionLifecycle。 */
  commitReplaySnapshot: (source: string, generation: number, replay: unknown[]) => Message[]
  /** Kernel journal 已导入/对账 replay 后，以同一 journal 的有效投影原子提交。 */
  commitCanonicalProjection: (source: string, generation: number, messages: Message[], canonicalRevision: number) => Message[]
  /** B1：Channel 流式帧入口——按 event 路由到与广播监听共用的处理体。 */
  handleStreamFrame: (frame: { event: string; payload: unknown }) => Promise<void>
  abortSessionLoad: (source: string, generation: number) => void
  /** load 失败 fallback：清 replay 状态，后续事件按 live 处理 */
  clearReplay: (source: string) => void
  /** 渲染期读取该 source 的 spinner 帧（user 事件后由接线层写入）；空时返回 undefined 让调用方回退主题帧 */
  getFrames: (source: string) => string[] | undefined
  /** 渲染期读取该 source 的 token 计数（usage-update 维护） */
  getTokenCount: (source: string) => number
  /** 渲染期读取该 source 的生成起点（elapsed 显示用） */
  getStartTime: (source: string) => number
  /** 横向订阅（D23）：订阅 source 状态变化，返回退订函数 */
  subscribe: (source: string, listener: () => void) => () => void
  /** 横向版本戳（useSyncExternalStore getSnapshot；source 状态变化即递增） */
  getSnapshot: (source: string) => number
  /** 横向读取：任务快照（planEntries） */
  getTasks: (source: string) => PlanEntry[]
  /** W2-12：消息快照访问器（右栏搜索消费；hook 行为不变） */
  getMessages: (source: string) => Message[]
  /** 渲染期读取该 source 的流式缓冲（切 sheet/会话后恢复 ChatView 本地流式态） */
  getStreamingState: (source: string) => { text: string; thinking: string }
  /** EVT-03：replay 归一化 unknown/malformed 条目（raw 已保留，不静默丢弃——§5.11） */
  getReplayMalformedEvents: () => Array<{ source: string; arrivalSeq: number; warning?: string; raw: unknown }>
  /** 横向读取：思考开始时间戳（thinking 时长显示用） */
  getThinkingStart: (source: string) => number | undefined
  getGenerating: (source: string) => boolean
  /** source-scoped 最近一次真实活动时间；切换会话后恢复迟滞计时基准。 */
  getLastActivityAt: (source: string) => number | undefined
  /** source-scoped 生成阶段；避免工具/思考阶段在切换后退化。 */
  getGenerationPhase: (source: string) => GenerationPhase | undefined
  /** 新活动轴；旧调用方可不实现，缺失时回退 generationPhase。 */
  getGenerationActivity?: (source: string) => GenerationActivitySnapshot | undefined
  /** 会话切换时恢复该 source 的完成态 footer。 */
  getSummary: (source: string) => GenerationSummary | undefined
  /** G1：重试注册失败的 listener，返回是否有新成功项（报告 8.5） */
  retryListeners: () => Promise<boolean>
  /** 会话集合变化后清理孤儿 source 状态（替代 clearChatSourceRefs） */
  pruneSources: (activeSources: readonly string[]) => void
  /** A1-c：flush 未落盘 canonical 事件（窗口关闭前调用）。 */
  flushCanonicalEvents: () => void
  /** A1-c：异步 flush 并等待在飞写完成（窗口关闭路径）。 */
  flushCanonicalEventsAsync: () => Promise<void>
  /** A1-c：丢弃该 owner 未落盘 canonical 事件（会话删除终态，不复活）。 */
  discardCanonicalEvents: (ownerKey: string) => void
  /** Kernel committed cursor：canonical 首屏读取后以已投影 revision 初始化。 */
  seedCanonicalCursor: (ownerKey: string, sequence: number) => void
  dispose: () => void
}

// 模块级单例：CC 里的 InputBar（不在 ChatView 子树内）经此访问统一的取消入口，
// 避免 InputBar 另持一套 cancelState（阶段 6.1 收敛：去重由 reducer begin-cancel 承担）
let activeController: ChatControllerHandle | null = null

export function registerChatController(handle: ChatControllerHandle | null): void {
  activeController = handle
}

export function getChatController(): ChatControllerHandle | null {
  return activeController
}

// G0：ChatRuntimeBridge 应用级宿主——controller 全局单例（listener 只注册一次），
// 渲染 refs 可重绑定（ChatView 重挂载复用，卸载不销毁 controller）
let currentRefs: ChatEventControllerRefs | null = null
let singletonController: ChatControllerHandle | null = null

// A1-c P2：测试可注入 fake sink；生产在 Tauri 下用真实 sink，非 Tauri 用 no-op。
let canonicalEventSinkFactory: (() => CanonicalEventSink) | null = null
export function setCanonicalEventSinkFactoryForTests(factory: (() => CanonicalEventSink) | null): void {
  canonicalEventSinkFactory = factory
}
const noopCanonicalEventSink: CanonicalEventSink = {
  offer: () => {},
  flushAll: () => {},
  flushAllAsync: async () => {},
  discard: () => {},
  dispose: () => {},
}

/** 重绑定当前渲染 refs（ChatView 重挂载时调用；controller 内部经此读最新 refs） */
export function bindChatControllerRefs(refs: ChatEventControllerRefs): void {
  currentRefs = refs
}


/**
 * FE-AUD-024：并行注册的 listener 用 allSettled 收敛——保留成功 stop handle
 * （不全丢弃），失败逐个回调报告（ErrorCenter），dispose 只清理成功项。
 */
export interface ListenerSettleResult<T> {
  fns: T[]
  /** G1：失败项（index/reason），供调用方重试注册（报告 8.5） */
  failures: Array<{ index: number; reason: unknown }>
}

/**
 * 回放合并（验收回归）：replay 权威历史 resolved + load 期间 live 增量。
 * 只按外部 identity（messageId/eventId/turnId/toolCallId）去重；无 identity 的
 * live 增量保守保留——相同正文仍可能是两条合法消息，不按内容签名猜测合并
 * （该行为由 replayE2E.test.ts 显式锁定）。
 * 不能用本地 id 去重：replay 以 seq:0 重建、live 沿用 runtime 的单调 seq，
 * 同一逻辑消息的两个副本 id 恒不同（user-3 vs user-7），id 去重是死代码。
 */
export function mergeReplayMessages<T extends { id: string; role?: string; sender?: string; content?: string; externalIdentity?: { messageId?: string; eventId?: string; turnId?: string; toolCallId?: string } }>(
  resolved: T[],
  liveAdditions: T[],
  capabilities: ChatIdentityCapabilities = {},
): T[] {
  return reconcileIngressMessages(resolved, liveAdditions, capabilities)
}

export function settleListeners<T>(
  listeners: Array<Promise<T>>,
  onRejected: (reason: unknown, index: number) => void,
): Promise<ListenerSettleResult<T>> {
  return Promise.allSettled(listeners).then(results => {
    const fns: T[] = []
    const failures: Array<{ index: number; reason: unknown }> = []
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        fns.push(result.value)
      } else {
        failures.push({ index, reason: result.reason })
        onRejected(result.reason, index)
      }
    })
    return { fns, failures }
  })
}

function stripReplayPersonaPrefix(content: string): string {
  const separator = '\n\n---\n\n'
  const index = content.indexOf(separator)
  if (index < 0) return content
  const stripped = content.slice(index + separator.length)
  return stripped || content
}

function canonicalTypedText(event: CanonicalEventRow): string | undefined {
  const text = (event.typedPayload as { text?: unknown } | undefined)?.text
  return typeof text === 'string' ? text : undefined
}

/** Match a load-buffered UI event to the canonical row that committed it. */
function canonicalRepresentsChatEvent(row: CanonicalEventRow, event: ChatEvent): boolean {
  if (row.owner.localSessionId !== event.source) return false
  const identity = row.identity
  switch (event.type) {
    case 'user':
      return row.eventType === 'user.message' && canonicalTypedText(row) === event.content
    case 'message-chunk':
      return row.eventType === 'assistant.text.delta'
        && canonicalTypedText(row) === event.text
        && (!event.externalIdentity?.messageId || identity?.messageId === event.externalIdentity.messageId)
    case 'thought-chunk':
      return row.eventType === 'assistant.thinking.delta'
        && canonicalTypedText(row) === event.text
        && (!event.externalIdentity?.turnId || identity?.turnId === event.externalIdentity.turnId)
    case 'tool-call':
      return row.eventType === 'tool.call.started'
        && (!event.toolCallId || identity?.toolCallId === event.toolCallId)
    case 'tool-call-update':
      return ['tool.call.updated', 'tool.call.completed', 'tool.call.failed'].includes(row.eventType)
        && (!event.toolCallId || identity?.toolCallId === event.toolCallId)
    case 'done':
      return row.eventType === 'turn.completed'
    case 'error':
      return row.eventType === 'turn.failed'
    default:
      return false
  }
}

function isRepresentedByCanonical(
  event: ChatEvent,
  canonicalEvents: readonly CanonicalEventRow[],
  consumed: Set<number>,
): boolean {
  const index = canonicalEvents.findIndex((row, rowIndex) =>
    !consumed.has(rowIndex) && canonicalRepresentsChatEvent(row, event),
  )
  if (index < 0) return false
  consumed.add(index)
  return true
}

function isRenderedSource(source: string, renderedSource: string | null): boolean {
  return source.length > 0 && renderedSource === source
}

/**
 * 缓存与内存态合并（load 开始前的首屏占位）。
 * 内存态优先（更新鲜）；仅当缓存中存在内存缺失的 id 时才补入，避免「每次切回
 * 都复制一遍」。completed 消息绝不因缓存陈旧而被丢弃——权威替换发生在
 * commitReplaySnapshot，而不是 initSource。
 */
function messagesRepresentSame(left: Message, right: Message): boolean {
  const leftIdentity = left.externalIdentity
  const rightIdentity = right.externalIdentity
  if (left.role === 'tool' && right.role === 'tool') {
    const leftToolCallId = leftIdentity?.toolCallId
    const rightToolCallId = rightIdentity?.toolCallId
    if (leftToolCallId && rightToolCallId) return leftToolCallId === rightToolCallId
  }
  for (const field of ['messageId', 'eventId', 'turnId'] as const) {
    const leftValue = leftIdentity?.[field]
    const rightValue = rightIdentity?.[field]
    if (leftValue && rightValue && leftValue === rightValue) return true
  }
  if (left.id === right.id) return true
  return left.role === right.role && left.content === right.content
}

function mergeBase(cached: Message[], live: Message[], preferCanonicalOrder = false): Message[] {
  if (preferCanonicalOrder) {
    // canonical 是切回会话时的权威投影：以其顺序重建并收敛历史 running 状态。
    // 内存中未被 canonical 表示的消息仍视作 load 期间新增，按原顺序保留在尾部。
    const unmatchedLive = [...live]
    const canonical = cached.map(message => {
      const matchedIndex = unmatchedLive.findIndex(candidate => messagesRepresentSame(message, candidate))
      if (matchedIndex >= 0) unmatchedLive.splice(matchedIndex, 1)
      return { ...message, running: false }
    })
    return unmatchedLive.length > 0 ? [...canonical, ...unmatchedLive] : canonical
  }
  const liveIds = new Set(live.map(message => message.id))
  // canonical 占位与 replay 重建同一条消息时 id 可能错位（占位含 thought 而
  // replay 不含时，后续 user-/msg- 序号整体偏移）。除 id 外再按 toolCallId 与
  // “role:content” 去重，避免同一条消息被当缺失追加导致重叠。
  const liveToolKeys = new Set<string>()
  const liveContentKeys = new Set<string>()
  for (const message of live) {
    if (message.role === 'tool') {
      const toolCallId = message.externalIdentity?.toolCallId
      if (toolCallId) liveToolKeys.add(`tool-call:${toolCallId}`)
    } else {
      liveContentKeys.add(`${message.role}:${message.content}`)
    }
  }
  const missing = cached
    .filter(message => {
      if (liveIds.has(message.id)) return false
      if (message.role === 'tool') {
        const toolCallId = message.externalIdentity?.toolCallId
        return toolCallId === undefined || !liveToolKeys.has(`tool-call:${toolCallId}`)
      }
      return !liveContentKeys.has(`${message.role}:${message.content}`)
    })
    .map(message => ({ ...message, running: false }))
  return missing.length > 0 ? [...live, ...missing] : live
}

function insertMissingMessageAtBasePosition(
  messages: Message[],
  baseMessages: Message[],
  missingMessage: Message,
): Message[] {
  const baseIndex = baseMessages.indexOf(missingMessage)
  if (baseIndex < 0) return [...messages, missingMessage]

  for (let index = baseIndex + 1; index < baseMessages.length; index += 1) {
    const nextAnchor = messages.findIndex(message => messagesRepresentSame(message, baseMessages[index]))
    if (nextAnchor >= 0) {
      const result = [...messages]
      result.splice(nextAnchor, 0, missingMessage)
      return result
    }
  }
  for (let index = baseIndex - 1; index >= 0; index -= 1) {
    const previousAnchor = messages.findIndex(message => messagesRepresentSame(message, baseMessages[index]))
    if (previousAnchor >= 0) {
      const result = [...messages]
      result.splice(previousAnchor + 1, 0, missingMessage)
      return result
    }
  }
  return [...messages, missingMessage]
}

/**
 * 事件控制器（阶段 2 收敛版）：Tauri listeners → sessionRuntimeStore 纯 reducer →
 * 副作用同步（渲染 setState / localStorage 持久化 / store live 状态 / frames / autoName）。
 * 行为等价源：收敛前的 refs 版控制器（commit 927f963 之前）。
 */
export function attachChatEventController(refs: ChatEventControllerRefs): ChatControllerHandle {
  // G0：首次创建（listener 注册一次）；重挂载复用并重绑定渲染 refs
  currentRefs = refs
  if (singletonController) return singletonController
  let runtimeState: ChatRuntimeState = {}
  // A1-c P2：每个 controller 实例持一个 canonical sink；非 Tauri（browser/tests）为 no-op。
  const canonicalSink = (canonicalEventSinkFactory ?? (() => (IS_TAURI ? createCanonicalEventSink() : noopCanonicalEventSink)))()
  const canonicalCursor = new CanonicalEventCursor(tauriCanonicalEventRepository())
  const canonicalSinkKeyByContext = new Map<string, string>()
  // M3：source → session（session.end hook 在 prune 时使用）。
  const hookSessionByKey = new Map<string, { agentId: string; source: string; id: string; hooks: string[] }>()
  // live wire 上明确携带的 identity 必须立即保留，不能依赖某次 replay 先完成能力探测。
  // capability 只决定 replay/live reconciliation 是否启用该字段，不决定是否采集 wire 字段。
  const explicitWireIdentityCapabilities: ChatIdentityCapabilities = {
    message: 'supported',
    event: 'supported',
    turn: 'supported',
    toolCall: 'supported',
  }
  const loadGenerations = new Map<string, number>()
  // Transaction tokens must never be reused within a controller lifetime. Reusing `1` after
  // finishLoadLock creates an ABA window where a previous load's late result can satisfy the
  // next load's source+generation check and overwrite the current snapshot.
  let loadGenerationSequence = 0
  const loadTransactions = new Map<string, {
    generation: number
    bufferedLiveEvents: ChatEvent[]
    bufferedCanonicalEvents: CanonicalEventRow[]
  }>()
  const detachedSources = new Set<string>()
  // EVT-03：replay 归一化中被归为 unknown/malformed 的原始条目（raw 保留，不静默丢弃——§5.11）。
  const malformedReplayEvents: Array<{ source: string; arrivalSeq: number; warning?: string; raw: unknown }> = []
  const knownSources = () => useIdentityStore.getState().sessions.map(session => session.source)
  const isActiveSource = (source: string) => source.length > 0 && knownSources().includes(source)
  const renderedSource = () => currentRefs!.sessionRef.current
  // I01-W2：事件/调用携带的 source → 归属 AgentContext（agentId+source）。
  // 同名 source 双 Agent：优先当前渲染会话的 owner（后端 active guard 只向活跃 owner 派发事件）；
  // 唯一命中直接确定；无法确定返回 null（保守丢弃，不串线）。
  const resolveContext = (source: string): AgentContext | null => {
    const sessions = useIdentityStore.getState().sessions.filter(session => session.source === source)
    if (sessions.length === 1) return sessionContext(sessions[0])
    if (sessions.length > 1) {
      const ownerId = currentRefs!.messageOwnerRef.current
      const rendered = ownerId ? sessions.find(session => session.id === ownerId) : undefined
      if (rendered) return sessionContext(rendered)
    }
    return null
  }
  const runtimeKey = (source: string): AgentContextKey | null => {
    const context = resolveContext(source)
    return context ? toAgentContextKey(context) : null
  }
  const runtimeAt = (source: string): SourceChatRuntime | undefined => {
    const key = runtimeKey(source)
    return key ? runtimeState[key] : undefined
  }
  // M3：hook 接线 helpers。无启用 hook 时返回 null，调用方保持原同步路径。
  const hookIdsForSource = (source: string): string[] | undefined => {
    const hooks = useIdentityStore.getState().sessions.find(session => session.source === source)?.hooks
    return hooks && hooks.length > 0 ? hooks : undefined
  }
  const maybeRunControllerHook = (
    phase: HookPhase,
    source: string,
    patch: Pick<HookContext, 'message' | 'payload' | 'toolCallId' | 'sessionId'> = {},
  ): Promise<{ blocked: boolean; message?: string; payload?: unknown; reason?: string }> | null => {
    const enabled = hookIdsForSource(source)
    if (!hasEnabledHooks(phase, enabled)) return null
    const context = resolveContext(source)
    return runHookPhase(phase, {
      phase,
      agentId: context?.agentId ?? '',
      source,
      sessionId: patch.sessionId ?? useIdentityStore.getState().sessions.find(session => session.source === source)?.id,
      message: patch.message,
      payload: patch.payload,
      toolCallId: patch.toolCallId,
      now: Date.now(),
    }, enabled).then(result => ({
      blocked: result.blocked,
      message: result.message,
      payload: result.payload,
      reason: result.reason,
    }))
  }
  const notifyHook = (hookName: HookName, source: string, event: Record<string, unknown>): void => {
    const enabled = hookIdsForSource(source)
    if (!getHookRuntime().hasEnabledHooks(hookName, enabled)) return
    void getHookRuntime().invoke(hookName, event, enabled)
  }
  // 横向订阅注册表（D23 方案 B）：dispatch 后对状态引用变化的 source 递增版本并通知
  const horizontal = createHorizontalSubscription()

  const dispatch = (event: ChatEvent, bypassLoadQueue = false) => {
    if (!bypassLoadQueue) {
      const tx = loadTransactions.get(event.source)
      const buffered = event.type === 'user' || event.type === 'message-chunk' || event.type === 'thought-chunk'
        || event.type === 'tool-call' || event.type === 'tool-call-update' || event.type === 'done' || event.type === 'error'
      if (tx && buffered) {
        tx.bufferedLiveEvents.push(event)
        return
      }
    }
    // I01-W2：接线层解析事件归属（agentId+source）；无法确定 owner 的 source 事件保守丢弃，不串线
    const context = event.agentId ? { agentId: event.agentId, source: event.source } : resolveContext(event.source)
    if (!context) return
    const fullEvent: ChatEvent & { agentId: string } = { ...event, agentId: context.agentId }
    const key = toAgentContextKey(context)
    const hookSession = useIdentityStore.getState().sessions.find(session => session.source === context.source)
    if (hookSession) {
      hookSessionByKey.set(key, { agentId: hookSession.agentId, source: hookSession.source, id: hookSession.id, hooks: hookSession.hooks })
    }
    const before = runtimeState
    const after = applyChatEvent(before, fullEvent, {
      knownSources: knownSources(),
      renderedSource: renderedSource(),
      now: Date.now(),
    })
    if (after === before) return
    runtimeState = after
    // 仅该事件 context 的状态引用变化才递增版本并通知（context A 不影响 B）
    horizontal.bump(event.source, after[key] !== before[key])
    syncSideEffects(before, after, fullEvent)
  }

  const beginLoadLock = (source: string): number => {
    detachedSources.delete(source)
    const generation = ++loadGenerationSequence
    loadGenerations.set(source, generation)
    loadTransactions.set(source, { generation, bufferedLiveEvents: [], bufferedCanonicalEvents: [] })
    return generation
  }

  const finishLoadLock = (source: string, generation: number): void => {
    if (loadGenerations.get(source) !== generation) return
    loadGenerations.delete(source)
    detachedSources.delete(source)
    if (loadTransactions.get(source)?.generation === generation) loadTransactions.delete(source)
    window.dispatchEvent(new CustomEvent('pylon:load-finished', { detail: { source, generation } }))
  }

  const abortSessionLoad = (source: string, generation: number): void => {
    if (loadGenerations.get(source) !== generation) return
    loadGenerations.delete(source)
    loadTransactions.delete(source)
    detachedSources.add(source)
  }

  const isSendBlockedDuringLoad = (source: string): boolean =>
    loadGenerations.has(source) || detachedSources.has(source)
  // load transaction 存续期间，该 source 的全局事件要么是 replay 广播（可能未标
  // periReplay），要么会在 commitReplaySnapshot 里按 snapshot 身份收敛。此时
  // 写 canonical 会把同一段历史双写一遍，重启后首屏投影出现整段重复。
  const isSourceLoading = (source: string): boolean => loadTransactions.has(source)

  /** 渲染态同步：rendered source 的消息/流式/生成态/summary 变化 → setState */
  const syncRendered = (prev: SourceChatRuntime | undefined, next: SourceChatRuntime | undefined) => {
    if (!next) return
    if (prev?.messages !== next.messages) currentRefs!.setMessages(next.messages)
    if ((prev?.streamingText ?? '') !== next.streamingText) currentRefs!.setStreamingText(next.streamingText)
    if ((prev?.streamingThinking ?? '') !== next.streamingThinking) currentRefs!.setStreamingThinking(next.streamingThinking)
    if ((prev?.generating ?? false) !== next.generating) currentRefs!.setGenerating(next.generating)
    if (prev?.lastActivityAt !== next.lastActivityAt && next.lastActivityAt !== undefined) currentRefs!.setLastTokenAt(next.lastActivityAt)
    if (prev?.generationPhase !== next.generationPhase) currentRefs!.setGenerationPhase(next.generationPhase ?? null)
    const prevSummary = prev?.lastSummary
    const nextSummary = next.lastSummary
    if (prevSummary !== nextSummary) {
      // 终态收敛（done/error/cancel-success 生成 summary）时同步清空阶段标记
      if (prevSummary === undefined && nextSummary !== undefined) currentRefs!.setGenerationPhase(null)
      currentRefs!.setSummary(nextSummary
        ? { elapsedMs: nextSummary.elapsedMs, tokenCount: nextSummary.tokenCount, completedFrame: '', reason: nextSummary.reason }
        : null)
    }
  }

  /** store 同步：generating 变化 → liveGeneratingSources 增删 */
  const syncGenerating = (source: string, prev: SourceChatRuntime | undefined, next: SourceChatRuntime | undefined) => {
    const prevGenerating = prev?.generating ?? false
    const nextGenerating = next?.generating ?? false
    if (prevGenerating === nextGenerating) return
    const store = useRuntimeStore.getState()
    if (nextGenerating) {
      const current = store.liveGeneratingSources || []
      const nextList = addGeneratingSource(current, source)
      if (nextList !== current) {
        store.setLiveStats({ liveGeneratingSources: nextList, liveGenerating: source })
      }
    } else {
      const nextList = removeGeneratingSource(store.liveGeneratingSources || [], source)
      store.setLiveStats({ liveGeneratingSources: nextList, liveGenerating: nextList[nextList.length - 1] || null })
    }
  }

  const syncSideEffects = (before: ChatRuntimeState, after: ChatRuntimeState, event: ChatEvent & { agentId: string }) => {
    const source = event.source
    const key = toAgentContextKey({ agentId: event.agentId, source })
    const prev = before[key]
    const next = after[key]
    if (isRenderedSource(source, renderedSource())) syncRendered(prev, next)
    syncGenerating(source, prev, next)
  }

  /** user 事件后接线层补充：spinner 帧（依赖主题域，reducer 不持有） */
  const resolveFrames = () => {
    const state = useStore.getState()
    return resolveSpinnerFrames(state.spinnerFramePreset, state.spinnerCustomFrames)
  }

  const requestCancel = (source: string) => {
    dispatch({ type: 'begin-cancel', source })
    // 2026-08-02 修复：begin-cancel 去重失败（非 generating/canceling 状态）时不白调后端。
    // 旧实现 dispatch 后无条件 invoke，footer 停止按钮/全局 Esc 在非生成态点击会发无效请求。
    if (runtimeAt(source)?.cancelState.status !== 'canceling') return
    // OWNER-02：cancel 目标 owner 从 Session 解析（resolveContext 保守返回 null 时
    // 不发送——owner 无法确定即保守丢弃，不串线）。
    const context = resolveContext(source)
    if (!context) return
    createChatClient({ invoke: (cmd, args) => invoke(cmd, args as Record<string, unknown> | undefined) }).cancelPrompt({ agentId: context.agentId, source }).then(() => {
      // 取消失败/成功均由 reducer 收敛；liveGenerating 清理走 syncGenerating
      dispatch({ type: 'cancel-success', source })
    }).catch(error => {
      dispatch({ type: 'cancel-rejected', source, error: error instanceof Error ? error.message : String(error) })
      reportRuntimeError('取消生成', error)
    })
  }

  const initSource = (source: string, cached: Message[], _preserveRuntime = false, baseFromCanonical = false): Message[] => {
    const key = runtimeKey(source)
    if (!key) return cached
    const existing = runtimeState[key]
    const maxSeq = cached.reduce((max, message) => {
      const n = /-(\d+)$/.exec(message.id)?.[1]
      return n ? Math.max(max, Number(n)) : max
    }, 0)
    if (existing) {
      // 会话切换回 source：开启新一轮 load。
      // - 清空 replayToolIds：上一轮 replay 的隔离重建状态随 commit 丢弃，主 runtime
      //   不再持有 replay 缓冲（U2-C 单一路径）。
      // - loadBaseMessageIds 标记「本轮 snapshot 将替换的 base」；内存态绝不因
      //   缓存长度不同而被丢弃——completed 消息必须保留到 commit 权威替换。
      // - preserveRuntime（sheet 切回重挂载）同样保留内存态。
      const mergedMessages = mergeBase(
        cached,
        existing.messages,
        baseFromCanonical && cached.length > 0,
      )
      // base = 本轮 replay 将权威替换的那批。缓存非空 → 缓存即 base；缓存为空 →
      // 内存态即 base（replay 完整时替换乐观副本，避免复读）。
      const baseIds = cached.length > 0
        ? cached.map(message => message.id)
        : existing.messages.map(message => message.id)
      runtimeState = {
        ...runtimeState,
        [key]: {
          ...existing,
          messages: mergedMessages,
          seq: existing.seq,
          loadBaseMessageIds: baseIds,
          loadBaseFromCache: cached.length > 0,
          // canonical 占位为空（读取失败/空会话）时不具备权威性，replay 仍为权威。
          loadBaseFromCanonical: baseFromCanonical && cached.length > 0,
          replayToolIds: [],
        },
      }
      return runtimeState[key].messages
    }
    // seq 从缓存推进：load 期间 live 消息与 replay 共用同一单调 seq，id 不撞缓存旧 id
    runtimeState = {
      ...runtimeState,
      [key]: {
        ...createSourceChatRuntime(source),
        messages: cached.map(message => ({ ...message, running: false })),
        seq: maxSeq,
        loadBaseMessageIds: cached.map(message => message.id),
        loadBaseFromCache: cached.length > 0,
        loadBaseFromCanonical: baseFromCanonical && cached.length > 0,
      },
    }
    return runtimeState[key].messages
  }

  // EVT-04：live/replay/restart 共用 canonical owner + generation 推导（§5.11 三路径投影深等；
  // owner/generation 为 session/binding 维，与 canonical 事件 owner 同一来源）。
  const canonicalToolContextFor = (source: string, agentId: string, key: AgentContextKey): { owner: CanonicalEventOwner; clientGeneration: number } => {
    const session = useIdentityStore.getState().sessions.find(s => s.source === source && s.agentId === agentId)
    return {
      // CWD-03：绑定 Workspace 时 owner 块携带 workspaceId（事件流还原 workdir 来源）。
      owner: { profileId: session?.profileId ?? '', agentId, localSessionId: source, ...(session?.workspaceId ? { workspaceId: session.workspaceId } : {}) },
      clientGeneration: useRuntimeStore.getState().bindingGenerations[key] ?? 0,
    }
  }
  // A1-c P2：live 会话事件 → canonical sink（replay 永不进入；终态/切会话 force）。
  const persistCanonicalEvent = (context: AgentContext, raw: unknown, force = false): void => {
    const key = toAgentContextKey(context)
    const { owner, clientGeneration } = canonicalToolContextFor(context.source, context.agentId, key)
    canonicalSinkKeyByContext.set(key, toCanonicalOwnerKey(owner))
    canonicalSink.offer({ owner, clientGeneration }, raw, force)
  }
  const applyRecoveredCanonicalEvent = (event: CanonicalEventRow): void => {
    const source = event.owner.localSessionId
    if (!isActiveSource(source)) return
    const identity = event.identity ? {
      ...(event.identity.messageId ? { messageId: event.identity.messageId } : {}),
      ...(event.identity.turnId ? { turnId: event.identity.turnId } : {}),
      ...(event.identity.toolCallId ? { toolCallId: event.identity.toolCallId } : {}),
    } : undefined
    const text = (event.typedPayload as { text?: unknown } | undefined)?.text
    switch (event.eventType) {
      case 'user.message':
        if (typeof text === 'string') dispatch({ type: 'user', source, content: text, eventReplay: false, externalIdentity: identity })
        break
      case 'assistant.text.delta':
        if (typeof text === 'string') dispatch({ type: 'message-chunk', source, text, replay: false, externalIdentity: identity })
        break
      case 'assistant.thinking.delta':
        if (typeof text === 'string') dispatch({ type: 'thought-chunk', source, text, replay: false, externalIdentity: identity })
        break
      case 'tool.call.started': {
        const tool = toolFieldsFromCanonical(event)
        dispatch({ type: 'tool-call', source, toolCallId: event.identity?.toolCallId, title: tool.title, toolKind: tool.kind, contentBlocks: tool.contentBlocks as ContentBlock[] | undefined, rawInput: tool.rawInput, clientGeneration: event.clientGeneration, replay: false })
        break
      }
      case 'tool.call.updated':
      case 'tool.call.completed':
      case 'tool.call.failed': {
        const tool = toolFieldsFromCanonical(event)
        dispatch({ type: 'tool-call-update', source, toolCallId: event.identity?.toolCallId, toolKind: tool.kind, contentBlocks: tool.contentBlocks as ContentBlock[] | undefined, rawOutput: tool.rawOutput, status: tool.status, clientGeneration: event.clientGeneration, replay: false })
        break
      }
      case 'turn.completed':
        dispatch({ type: 'done', source, replay: false })
        break
      case 'turn.failed': {
        const error = (event.typedPayload as { error?: unknown } | undefined)?.error
        dispatch({ type: 'error', source, error: typeof error === 'string' ? error : 'Agent turn failed', replay: false })
        break
      }
      default:
        break
    }
  }
  const processCommittedOrLegacy = async (
    value: unknown,
    processCurrent: (kernelCommitted: boolean) => void | Promise<void>,
  ): Promise<void> => {
    if (value === undefined) {
      await processCurrent(false)
      return
    }
    await canonicalCursor.accept(value, async (event, isCurrentNotification) => {
      publishPluginEvent(event)
      // Keep every canonical notification observed during a load, including rows that were
      // already covered by the initial canonical read.  A source may continue generating while
      // the user switches sessions; commit-time reconciliation needs this complete set to tell a
      // real in-flight event from a legacy uncommitted replay broadcast.
      const transaction = loadTransactions.get(event.owner.localSessionId)
      if (transaction) transaction.bufferedCanonicalEvents.push(event)
      if (isCurrentNotification) {
        await processCurrent(true)
      }
      else applyRecoveredCanonicalEvent(event)
    })
  }
  // EVT-04：live canonical 流内 sequence（仅归一化占位；不参与三路径投影字段深等）
  const liveCanonicalSequences = new Map<string, number>()
  const nextLiveCanonicalSeq = (source: string): number => {
    const next = (liveCanonicalSequences.get(source) ?? 0) + 1
    liveCanonicalSequences.set(source, next)
    return next
  }
  const commitReplaySnapshot = (source: string, generation: number, replay: unknown[]): Message[] => {
    const identityCapabilities = detectChatIdentityCapabilities(replay)
    const context = resolveContext(source)
    const key = context ? toAgentContextKey(context) : null
    const existing = key ? runtimeState[key] : undefined
    const transaction = loadTransactions.get(source)
    if (!context || !key || !existing) return []
    if (!transaction || transaction.generation !== generation || loadGenerations.get(source) !== generation) return []

    let replayState: ChatRuntimeState = {
      [key]: {
        ...createSourceChatRuntime(source),
        seq: 0,
      },
    }
    const replayContext = { knownSources: [source], renderedSource: null, now: Date.now() }
    const replayDispatch = (event: ChatEvent) => {
      replayState = applyChatEvent(replayState, event, replayContext)
    }

    // EVT-03：replay/restart 统一经 normalizeRawEvent 归一化（§5.11——不再自带 sessionUpdate switch）。
    const normalizedReplay: CanonicalNormalizeResult[] = []
    const canonicalCtx = canonicalToolContextFor(source, context.agentId, key)
    const bindingGeneration = canonicalCtx.clientGeneration
    for (const raw of replay) {
      const normalized = normalizeRawEvent(raw, {
        ...canonicalCtx,
        sequence: normalizedReplay.length + 1,
        receivedAt: new Date().toISOString(),
      })
      normalizedReplay.push(normalized)
      const canonical = normalized.event
      const upd = normalized.update
      switch (canonical.eventType) {
        case 'user.message': {
          const content = (canonical.typedPayload as { text?: string } | undefined)?.text
          if (typeof content === 'string' && content) {
            replayDispatch({ type: 'user', source, agentId: context.agentId, content: stripReplayPersonaPrefix(content), eventReplay: true, externalIdentity: extractExternalIdentity(upd?.content ?? upd, identityCapabilities) })
          }
          break
        }
        case 'assistant.text.delta': {
          const text = (canonical.typedPayload as { text?: string } | undefined)?.text
          if (typeof text === 'string' && text) replayDispatch({ type: 'message-chunk', source, agentId: context.agentId, text, replay: true, externalIdentity: extractExternalIdentity(upd?.content ?? upd, identityCapabilities) })
          break
        }
        case 'assistant.thinking.delta': {
          const text = (canonical.typedPayload as { text?: string } | undefined)?.text
          if (typeof text === 'string' && text) replayDispatch({ type: 'thought-chunk', source, agentId: context.agentId, text, replay: true, externalIdentity: extractExternalIdentity(upd?.content ?? upd, identityCapabilities) })
          break
        }
        case 'tool.call.started': {
          const tool = toolFieldsFromCanonical(canonical)
          replayDispatch({ type: 'tool-call', source, agentId: context.agentId, toolCallId: canonical.identity?.toolCallId, title: tool.title, toolKind: tool.kind, contentBlocks: tool.contentBlocks as ContentBlock[] | undefined, rawInput: tool.rawInput, clientGeneration: bindingGeneration, replay: true })
          break
        }
        case 'tool.call.updated':
        case 'tool.call.completed':
        case 'tool.call.failed': {
          const tool = toolFieldsFromCanonical(canonical)
          replayDispatch({ type: 'tool-call-update', source, agentId: context.agentId, toolCallId: canonical.identity?.toolCallId, toolKind: tool.kind, contentBlocks: tool.contentBlocks as ContentBlock[] | undefined, rawOutput: tool.rawOutput, status: tool.status, clientGeneration: bindingGeneration, replay: true })
          break
        }
        case 'turn.completed':
        case 'turn.failed':
          // 终态由循环末统一 done 收敛（保持既有行为，不在 replay 内逐条 dispatch）
          break
        default: {
          // usage/config/commands 的 replay 只经 canonical journal → WorkbenchProjector
          // 恢复；legacy controller 不再建立 journal 外第二份会话真值。
          if (normalized.malformed || canonical.eventType === 'unknown') {
            malformedReplayEvents.push({ source, arrivalSeq: normalized.event.sequence, warning: normalized.warning, raw })
          }
          break
        }
      }
    }
    replayDispatch({ type: 'done', source, agentId: context.agentId, replay: true, explicitReplay: true })
    const replayed = replayState[key]?.messages ?? []
    const queuedEvents = transaction?.bufferedLiveEvents ?? []
    const queuedIdentityKey = (event: ChatEvent): string | undefined => {
      if ((event.type === 'tool-call' || event.type === 'tool-call-update') && event.toolCallId) return `tool-call:${event.toolCallId}`
      if (!('externalIdentity' in event) || !event.externalIdentity) return undefined
      if (event.externalIdentity.messageId) return `message:${event.externalIdentity.messageId}`
      if (event.externalIdentity.eventId) return `event:${event.externalIdentity.eventId}`
      if (event.externalIdentity.turnId) return `turn:${event.externalIdentity.turnId}`
      return undefined
    }
    // loadBaseFromCanonical=true 表示 base 来自 canonical 首屏占位（唯一历史权威）。
    // 此时 agent replay 只作为 canonical 为空时的 legacy fallback；这里不再用
    // replay 覆盖 base，避免「replay 缺 user/thought 事件 → 丢用户消息 / 思考块错乱」。
    // load 期间到达的新 live 事件由下方 queuedEvents 循环按 identity 并入。
    // loadBaseFromCanonical=false（旧缓存 / 纯内存态）保留原 replay 权威路径。
    const liveAdditions = existing.messages.filter(message => !(existing.loadBaseMessageIds ?? []).includes(message.id))
    let nextMessages: Message[]
    if (existing.loadBaseFromCanonical) {
      nextMessages = existing.messages
    } else if (replayed.length === 0) {
      // 空 replay：base 来自旧缓存 → 清空陈旧缓存，只保留本轮新增 live；
      // base 来自内存 → 保留内存态（user + running tool）。
      nextMessages = existing.loadBaseFromCache ? liveAdditions : existing.messages
    } else {
      nextMessages = mergeReplayMessages(replayed, liveAdditions, identityCapabilities)
    }
    // replay 快照可能缺少工具事件（agent 尚未持久化 / 回放截断）。base 中已存在的
    // 工具卡有稳定 toolCallId：先按 identity 双向补齐——replay 缺整卡时补回 base 卡，
    // replay 只有 update（`tool:?` 占位）时把 base 的 title/kind/rawInput/contentBlocks
    // 补进占位卡，避免「切回会话工具卡消失 / 全部变成 ? tool」。
    const baseToolByKey = new Map<string, Message>()
    for (const message of existing.messages) {
      const toolCallId = message.role === 'tool' ? message.externalIdentity?.toolCallId : undefined
      if (toolCallId !== undefined) baseToolByKey.set(`tool-call:${toolCallId}`, message)
    }
    nextMessages = nextMessages.map(message => {
      if (message.role !== 'tool') return message
      const toolCallId = message.externalIdentity?.toolCallId
      const base = toolCallId ? baseToolByKey.get(`tool-call:${toolCallId}`) : undefined
      if (!base) return message
      return {
        ...message,
        toolName: message.toolName && message.toolName !== '?' ? message.toolName : base.toolName,
        sender: message.sender && message.sender !== 'tool:?' ? message.sender : base.sender,
        toolKind: message.toolKind ?? base.toolKind,
        rawInput: message.rawInput !== undefined ? message.rawInput : base.rawInput,
        toolInput: message.toolInput || base.toolInput,
        contentBlocks: message.contentBlocks ?? base.contentBlocks,
        rawOutput: message.rawOutput !== undefined ? message.rawOutput : base.rawOutput,
      }
    })
    const nextToolKeys = new Set(nextMessages.flatMap(message => {
      const toolCallId = message.role === 'tool' ? message.externalIdentity?.toolCallId : undefined
      return toolCallId ? [`tool-call:${toolCallId}`] : []
    }))
    const missingToolCards = existing.messages.filter(message => {
      const toolCallId = message.role === 'tool' ? message.externalIdentity?.toolCallId : undefined
      return toolCallId !== undefined && !nextToolKeys.has(`tool-call:${toolCallId}`)
    })
    if (missingToolCards.length > 0) {
      for (const missingToolCard of missingToolCards) {
        nextMessages = insertMissingMessageAtBasePosition(nextMessages, existing.messages, missingToolCard)
      }
    }
    const snapshotIdentityKeys = new Set(nextMessages.flatMap(message => {
      const identity = message.externalIdentity
      if (message.role === 'tool' && identity?.toolCallId) return [`tool-call:${identity.toolCallId}`]
      if (identity?.messageId) return [`message:${identity.messageId}`]
      if (identity?.eventId) return [`event:${identity.eventId}`]
      if (identity?.turnId) return [`turn:${identity.turnId}`]
      return []
    }))
    runtimeState = {
      ...runtimeState,
      [key]: {
        ...existing,
        replayToolIds: [],
        loadBaseMessageIds: undefined,
        // replay snapshot 是当前持久化历史的权威版本。切换会话时遗留在 runtime 的
        // streaming 缓冲可能已经包含在 snapshot 的末条 assistant/reasoning 消息中；
        // 若继续保留，迟到的 live done 会再次 flush 同一段文本，形成“回复 回复”。
        // snapshot 提交后只接收随后到达的新 chunk，因此这里必须原子清空旧缓冲。
        streamingText: '',
        streamingThinking: '',
        streamingIdentity: undefined,
        thinkingStart: undefined,
        messages: nextMessages,
      },
    }
    loadTransactions.delete(source)
    // canonical 权威路径：只丢弃已经由 canonical row 证明覆盖的 queued 事件。A 会话在
    // 用户切到 B 后仍可能继续生成；这些真实 in-flight chunks 不能因为 load snapshot
    // 恰好在中途读取而丢失。旧后端没有 committed rows 时仍保留 legacy 的保守策略。
    if (!existing.loadBaseFromCanonical) {
      let acceptedTranscriptEvent = false
      for (const event of queuedEvents) {
        const identityKey = queuedIdentityKey(event)
        // 无稳定身份的 late event 无法证明属于 snapshot 之后，保守丢弃。
        // done/error 本身通常无 identity；仅当前面确实接纳过 snapshot 后的新事件时收敛该 live 回合。
        if (!identityKey) {
          if (acceptedTranscriptEvent && (event.type === 'done' || event.type === 'error')) dispatch(event, true)
          continue
        }
        if (snapshotIdentityKeys.has(identityKey)) continue
        acceptedTranscriptEvent = true
        dispatch(event, true)
      }
    } else if (transaction.bufferedCanonicalEvents.length > 0) {
      const consumedCanonical = new Set<number>()
      for (const event of queuedEvents) {
        if (isRepresentedByCanonical(event, transaction.bufferedCanonicalEvents, consumedCanonical)) continue
        // No canonical counterpart means this event came from an older compatibility backend or
        // was produced after the journal read. Preserve it in the per-source runtime.
        dispatch(event, true)
      }
    }
    return runtimeState[key]?.messages ?? nextMessages
  }

  const commitCanonicalProjection = (
    source: string,
    generation: number,
    messages: Message[],
    canonicalRevision: number,
  ): Message[] => {
    const key = runtimeKey(source)
    const existing = key ? runtimeState[key] : undefined
    const transaction = loadTransactions.get(source)
    if (!key || !existing) return []
    if (!transaction || transaction.generation !== generation || loadGenerations.get(source) !== generation) return []

    const maxMessageSeq = messages.reduce((max, message) => {
      const value = /-(\d+)$/.exec(message.id)?.[1]
      return value ? Math.max(max, Number(value)) : max
    }, 0)
    // The optimistic user row can race the first canonical read: the prompt IPC may not have
    // reached the kernel yet, while the user already switched sessions. Keep that pending row in
    // the projected transcript until a durable user.message row catches up.
    let projectedMessages = messages.map(message => ({ ...message, running: false }))
    for (const pending of existing.messages.filter(message => message.role === 'user' && message.clientMsgId)) {
      if (projectedMessages.some(message => messagesRepresentSame(message, pending))) continue
      const firstTranscriptIndex = projectedMessages.findIndex(message => message.role !== 'user')
      const insertionIndex = firstTranscriptIndex < 0 ? projectedMessages.length : firstTranscriptIndex
      projectedMessages = [
        ...projectedMessages.slice(0, insertionIndex),
        { ...pending, running: false },
        ...projectedMessages.slice(insertionIndex),
      ]
    }
    runtimeState = {
      ...runtimeState,
      [key]: {
        ...existing,
        messages: projectedMessages,
        seq: Math.max(existing.seq, projectedMessages.reduce((max, message) => {
          const value = /-(\d+)$/.exec(message.id)?.[1]
          return value ? Math.max(max, Number(value)) : max
        }, maxMessageSeq)),
        replayToolIds: [],
        loadBaseMessageIds: undefined,
        loadBaseFromCache: false,
        loadBaseFromCanonical: true,
        streamingText: '',
        streamingThinking: '',
        streamingIdentity: undefined,
        thinkingStart: undefined,
      },
    }
    loadTransactions.delete(source)

    // A committed notification may race with the journal load used to build `messages`. Rows at
    // or below canonicalRevision are already projected; later rows are replayed once, in order.
    const lateCanonical = new Map<number, CanonicalEventRow>()
    for (const event of transaction.bufferedCanonicalEvents) {
      if (event.sequence > canonicalRevision) lateCanonical.set(event.sequence, event)
    }
    for (const event of [...lateCanonical.values()].sort((left, right) => left.sequence - right.sequence)) {
      applyRecoveredCanonicalEvent(event)
    }
    // Compatibility path for an older backend that emits transcript events without committed rows.
    if (transaction.bufferedCanonicalEvents.length === 0) {
      for (const event of transaction.bufferedLiveEvents) dispatch(event, true)
    }
    return runtimeState[key]?.messages ?? messages
  }

  const clearReplay = (source: string) => {
    // replay 已由 load_persisted_session command 收集并在 commitReplaySnapshot 原子提交。
    // 这里清理任何兼容旧路径残留，不再把 replay buffer 当权威历史。
    const key = runtimeKey(source)
    const existing = key ? runtimeState[key] : undefined
    if (!key || !existing) return
    runtimeState = {
      ...runtimeState,
      [key]: { ...existing, replayToolIds: [], loadBaseMessageIds: undefined },
    }
  }

  const getFrames = (source: string): string[] | undefined => {
    const frames = runtimeAt(source)?.generationFrames
    return frames && frames.length > 0 ? frames : undefined
  }

  const getTokenCount = (source: string): number => runtimeAt(source)?.tokenCount ?? 0

  const getStartTime = (source: string): number => runtimeAt(source)?.generationStart ?? Date.now()

  const pruneSources = (activeSources: readonly string[]) => {
    // I01-W2：runtime map 已按 AgentContextKey 键控——按活跃 source 解析出应保留的 context key 集合
    const activeKeys = new Set<AgentContextKey>()
    for (const source of activeSources) {
      const key = runtimeKey(source)
      if (key) activeKeys.add(key)
    }
    const next: ChatRuntimeState = {}
    let changed = false
    for (const [key, runtime] of Object.entries(runtimeState)) {
      if (activeKeys.has(key as AgentContextKey)) {
        next[key] = runtime
      } else {
        changed = true
        // session.closed：旧 session.end 经兼容桥执行，原生 v2 Hook 使用同一新 phase。
        const endedSession = hookSessionByKey.get(key)
        if (endedSession) void runSessionBoundaryHook('session.end', endedSession)
        hookSessionByKey.delete(key)
        // A1-c P2：孤儿 source 的未落盘 canonical 事件一并丢弃（不复活）。
        const ownerKey = canonicalSinkKeyByContext.get(key)
        if (ownerKey) {
          canonicalSink.discard(ownerKey)
          canonicalCursor.forget(ownerKey)
        }
        canonicalSinkKeyByContext.delete(key)
      }
    }
    if (changed) runtimeState = next
    const activeSourceSet = new Set(activeSources)
    for (const source of detachedSources) {
      if (!activeSourceSet.has(source)) detachedSources.delete(source)
    }
    horizontal.prune(activeSources)
  }

  // H1 + FE-AUD-024：listen 任一 reject（IPC 异常）不得产生 unhandled rejection；
  // allSettled 保留已成功注册的 stop handle（不全丢弃），失败逐个报告（ErrorCenter），
  // dispose 只清理成功 handle，不泄漏未注册监听器
  // G1：listener 工厂数组（重试注册失败项，报告 8.5）
  // B1：channel 帧路由表——各工厂注册时把处理函数挂到此处，handleStreamFrame
  // 按 StreamFrame.event 分发（处理体与广播监听逐字共用，单实现双入口）。
  const channelFrameHandlers: {
    user?: (event: { payload: { source: string; content: string; replay?: boolean; canonicalEvent?: unknown } }) => Promise<void>
    update?: (event: { payload: PeriUpdatePayload }) => Promise<void>
    done?: (event: { payload: PeriDonePayload }) => Promise<void>
    error?: (event: { payload: { source: string; error: string; cancelled?: boolean; replay?: boolean; canonicalEvent?: unknown } }) => Promise<void>
  } = {}
  const listenerFactories: Array<() => Promise<UnlistenFn>> = [
    () => {
      const handler = async (event: { payload: { source: string; content: string; replay?: boolean; canonicalEvent?: unknown } }) => {
      if (!isActiveSource(event.payload.source)) return
      const processCurrent = async (kernelCommitted: boolean) => {
      const { source, content, replay: eventReplay = false } = event.payload
      if (!isActiveSource(source)) return
      // 自动命名（会话名仍为 session- 时）：无论乐观渲染是否已显示消息，
      // pylon:user 到达即命名（乐观路径 sendOptimisticUser 也走此确认点）。
      const store = useIdentityStore.getState()
      const session = store.sessions.find(s => s.source === source)
      if (session?.name.startsWith('session-')) {
        const autoName = content.slice(0, 30)
        useIdentityStore.getState().updateSession(session.id, { autoName, name: autoName })
      }
      // replay history 不再走全局 Tauri 事件；若兼容旧后端仍发 replay 标记则直接忽略，
      // 权威历史只由 load_persisted_session response 原子提交。
      if (eventReplay) return
      // 方案 B 去重：pylon:user 是乐观消息的回显（或重复投递）时不得重复追加。
      // 1) 匹配第一条同内容的未确认乐观消息 → 按 clientMsgId 确认转普通消息；
      // 2) 否则若尾部已有同内容普通 user 消息 → 后端重复投递，直接跳过。
      const pendingOptimistic = (runtimeAt(source)?.messages ?? []).find(
        m => m.role === 'user' && m.clientMsgId !== undefined && m.content === content,
      )
      if (pendingOptimistic) {
        dispatch({ type: 'confirm-user', source, clientMsgId: pendingOptimistic.clientMsgId! })
        // 乐观消息已启动生成；确认后仍需补 frames/相位（与 user 分支一致）
        const next = runtimeAt(source)
        if (next?.generating) {
          const key = runtimeKey(source)
          if (key) runtimeState = { ...runtimeState, [key]: { ...next, generationFrames: resolveFrames() } }
          if (isRenderedSource(source, renderedSource())) {
            currentRefs!.setLastTokenAt(Date.now())
            currentRefs!.setGenerationPhase({ kind: 'thinking' })
          }
        }
        return
      }
      // lastUser 去重只针对 **live** 回显/重复投递；replay（load 历史重放）不得跳过——
      // replay 的 user 消息必须在 commit 的隔离 runtime 中重建，否则权威历史丢失。
      const lastUser = [...(runtimeAt(source)?.messages ?? [])]
        .reverse()
        .find(m => m.role === 'user')
      if (!eventReplay && lastUser && lastUser.content === content && lastUser.clientMsgId === undefined) {
        return
      }
      // A1-c P2：live user 事件归一后双写 canonical（replay 分支已在上面 return）。
      // load 期间到达的 user 事件不写 canonical——该 source 的历史正由 snapshot
      // 收敛，避免重放广播（未标 periReplay）把历史双写进 canonical_events。
      if (!isSourceLoading(source) && !kernelCommitted) {
        const userContext = resolveContext(source)
        if (userContext) {
          persistCanonicalEvent(userContext, { source, update: { sessionUpdate: 'user_message_chunk', content: { text: content } } })
        }
      }
      dispatch({
        type: 'user',
        source,
        content,
        eventReplay,
      })
      // reducer 已在 user 事件内启动生成（live）；接线层补 frames 与 UI 相位
      const next = runtimeAt(source)
      if (next?.generating) {
        const key = runtimeKey(source)
        if (key) runtimeState = { ...runtimeState, [key]: { ...next, generationFrames: resolveFrames() } }
        if (isRenderedSource(source, renderedSource())) {
          currentRefs!.setLastTokenAt(Date.now())
          currentRefs!.setGenerationPhase({ kind: 'thinking' })
        }
      }
      }
      await processCommittedOrLegacy(event.payload.canonicalEvent, processCurrent)
        .catch(error => reportRuntimeError('消费 Kernel committed user event', error))
      }
      channelFrameHandlers.user = handler
      // B1：user echo 后端已 Channel 优先（send_update_frame 单轨）；本广播
      // listen 保留为兜底——未注册 Channel（平台 ingest / 非 Tauri 测试）的来源。
      return listen('pylon:user', handler)
    },

    () => {
      const handler = async (event: { payload: PeriUpdatePayload }) => {
      if (!isActiveSource(event.payload.source)) return
      const processCurrent = async (kernelCommitted: boolean) => {
      const source = event.payload.source
      const upd = event.payload?.update
      if (!isActiveSource(source) || !source || !upd) return
      // Kernel-owned live events are durable before this notification is emitted. Publish the
      // committed canonical row to plugin consumers and never offer the raw payload to the old
      // WebView sink again (that would create a second sequence for the same event).
      const variant = upd.sessionUpdate
      // load 回放期间禁止通过全局事件把 live 事件写入历史重建缓冲；live 事件仍可
      // 正常写 messages，但本次 commit 以 snapshot 原子替换，避免污染 replay。
      const replay = upd._meta?.periReplay === true
      if (replay) return
      const loadActive = isSourceLoading(source)
      const rendered = isRenderedSource(source, renderedSource())
      switch (variant) {
        case 'agent_message_chunk': {
          let text = upd.content?.text || ''
          if (!text) return
          // M3：回合首个 assistant chunk 前跑 agent.turn.before（transform/gate）。
          if (!runtimeAt(source)?.generating) {
            const turnHook = maybeRunControllerHook('agent.turn.before', source, { message: text, payload: event.payload })
            if (turnHook) {
              const result = await turnHook
              if (result.blocked) return
              if (result.message !== undefined) text = result.message
            }
          }
          if (rendered) currentRefs!.setLastTokenAt(Date.now())
          if (!replay && rendered) currentRefs!.setGenerationPhase({ kind: 'responding' })
          if (!replay && !loadActive && !kernelCommitted) {
            const chunkContext = resolveContext(source)
            if (chunkContext) persistCanonicalEvent(chunkContext, event.payload)
          }
          dispatch({ type: 'message-chunk', source, text, replay, externalIdentity: extractExternalIdentity(upd.content ?? upd, explicitWireIdentityCapabilities) })
          break
        }
        case 'agent_thought_chunk': {
          let text = upd.content?.text || ''
          if (!text) return
          if (!runtimeAt(source)?.generating) {
            const turnHook = maybeRunControllerHook('agent.turn.before', source, { message: text, payload: event.payload })
            if (turnHook) {
              const result = await turnHook
              if (result.blocked) return
              if (result.message !== undefined) text = result.message
            }
          }
          if (rendered) currentRefs!.setLastTokenAt(Date.now())
          if (!replay && rendered) currentRefs!.setGenerationPhase({ kind: 'thinking' })
          if (!replay && !loadActive && !kernelCommitted) {
            const chunkContext = resolveContext(source)
            if (chunkContext) persistCanonicalEvent(chunkContext, event.payload)
          }
          dispatch({ type: 'thought-chunk', source, text, replay, externalIdentity: extractExternalIdentity(upd.content ?? upd, explicitWireIdentityCapabilities) })
          break
        }
        case 'tool_call': {
          // M3：tool.call.before（gate/transform payload）。
          const beforeHook = maybeRunControllerHook('tool.call.before', source, { payload: event.payload, toolCallId: upd.toolCallId })
          let hookPayload: unknown = event.payload
          if (beforeHook) {
            const result = await beforeHook
            if (result.blocked) return
            hookPayload = result.payload ?? event.payload
          }
          if (!replay && rendered) currentRefs!.setGenerationPhase({ kind: 'tool', name: upd.title || '?' })
          // W2-09 + I01-W3：touchedFiles 记录（kind 优先/工具名兼容；提取失败 null 不误记）——
          // 刷新跟随数据源；按 AgentContext（agentId+source）隔离记录
          const touchedSession = useIdentityStore.getState().sessions.find(session => session.source === source)
          const touchedPath = extractTouchedPath({ kind: upd.kind, title: upd.title, rawInput: upd.rawInput, cwd: touchedSession?.workdir })
          // EVT-04：live 工具路径与 replay 共用 normalizeRawEvent → canonical → toolFieldsFromCanonical
          // （§5.11 单一路径——live 不再直读 upd.toolCallId/upd.title 等 wire 字段）。
          const ctx = resolveContext(source)
          if (touchedPath && ctx) useWorkspaceStore.getState().recordTouchedFile(ctx, { path: touchedPath, toolKind: upd.kind || upd.title || '', at: Date.now() })
          const key = ctx ? toAgentContextKey(ctx) : null
          if (ctx && key) {
            const canonicalCtx = canonicalToolContextFor(source, ctx.agentId, key)
            const normalized = normalizeRawEvent(hookPayload, { ...canonicalCtx, sequence: nextLiveCanonicalSeq(source) })
            const canonical = normalized.event
            const tool = toolFieldsFromCanonical(canonical)
            dispatch({ type: 'tool-call', source, toolCallId: canonical.identity?.toolCallId, title: tool.title, toolKind: tool.kind, contentBlocks: tool.contentBlocks as ContentBlock[] | undefined, rawInput: tool.rawInput, clientGeneration: canonicalCtx.clientGeneration, replay })
            notifyHook('tool.started', source, { source, toolCallId: canonical.identity?.toolCallId, tool, canonical })
            if (!loadActive && !kernelCommitted) persistCanonicalEvent(ctx, hookPayload)
          }
          break
        }
        case 'tool_call_update': {
          // M3：终态 tool update 前跑 tool.call.after。
          if (upd.status === 'completed' || upd.status === 'failed' || upd.status === 'error') {
            const afterHook = maybeRunControllerHook('tool.call.after', source, { payload: event.payload, toolCallId: upd.toolCallId })
            if (afterHook && (await afterHook).blocked) return
          }
          const ctx = resolveContext(source)
          const key = ctx ? toAgentContextKey(ctx) : null
          if (ctx && key) {
            const canonicalCtx = canonicalToolContextFor(source, ctx.agentId, key)
            const normalized = normalizeRawEvent(event.payload, { ...canonicalCtx, sequence: nextLiveCanonicalSeq(source) })
            const canonical = normalized.event
            const tool = toolFieldsFromCanonical(canonical)
            dispatch({ type: 'tool-call-update', source, toolCallId: canonical.identity?.toolCallId, toolKind: tool.kind, contentBlocks: tool.contentBlocks as ContentBlock[] | undefined, rawOutput: tool.rawOutput, status: tool.status, clientGeneration: canonicalCtx.clientGeneration, replay })
            notifyHook(
              tool.status === 'failed' || tool.status === 'error' ? 'tool.failed' : 'tool.afterCall',
              source,
              { source, toolCallId: canonical.identity?.toolCallId, tool, canonical },
            )
            if (!loadActive && !kernelCommitted) persistCanonicalEvent(ctx, event.payload)
          }
          break
        }
        case 'usage_update': {
          const usage = extractUsage(upd)
          const ctx = resolveContext(source)
          if (ctx) applySessionStateUpdate(ctx, 'usage_update', upd)
          dispatch({ type: 'usage-update', source, tokensUsed: usage.tokensUsed })
          break
        }
        case 'session_info_update': {
          const ctx = resolveContext(source)
          if (ctx) applySessionStateUpdate(ctx, 'session_info_update', upd)
          break
        }
        case 'available_commands_update': {
          const ctx = resolveContext(source)
          if (ctx) applySessionStateUpdate(ctx, 'available_commands_update', upd)
          break
        }
        case 'config_option_update': {
          const ctx = resolveContext(source)
          if (ctx) applySessionStateUpdate(ctx, 'config_option_update', upd)
          break
        }
        case 'plan': {
          // D1 全量快照替换；entries 缺失（undefined）与空快照（[]）区分，交由 reducer 处理
          const entries = extractPlanEntries(upd)
          if (entries === undefined) break
          dispatch({ type: 'plan', source, entries, replay })
          break
        }
      }
      }
      await processCommittedOrLegacy(event.payload.canonicalEvent, processCurrent)
        .catch(error => reportRuntimeError('消费 Kernel committed update event', error))
      }
      channelFrameHandlers.update = handler
      // C2：广播旧轨已拆——handler 仅由 Channel 帧入口消费。
      return Promise.resolve(() => {})
    },

    () => {
      const handler = async (event: { payload: PeriDonePayload }) => {
      if (!isActiveSource(event.payload.source)) return
      const processCurrent = async (kernelCommitted: boolean) => {
      const source = event.payload.source
      if (!isActiveSource(source) || !source || event.payload.replay === true) return
      // M3：agent.reply.after（done）。
      const replyHook = maybeRunControllerHook('agent.reply.after', source, { payload: event.payload })
      if (replyHook && (await replyHook).blocked) return
      const doneContext = resolveContext(source)
      if (doneContext && !isSourceLoading(source) && !kernelCommitted) {
        persistCanonicalEvent(doneContext, { source, update: { sessionUpdate: 'done' } }, true)
      }
      const repliedSession = useIdentityStore.getState().sessions.find(session => session.source === source)
      if (repliedSession) useIdentityStore.getState().updateSession(repliedSession.id, { lastReplyAt: Date.now() })
      dispatch({ type: 'done', source, replay: false })
      notifyHook('message.agent.committed', source, { source, payload: event.payload })
      notifyHook('turn.completed', source, { source, status: 'completed', payload: event.payload })
      }
      await processCommittedOrLegacy(event.payload.canonicalEvent, processCurrent)
        .catch(error => reportRuntimeError('消费 Kernel committed done event', error))
      }
      channelFrameHandlers.done = handler
      // C2：广播旧轨已拆——handler 仅由 Channel 帧入口消费。
      return Promise.resolve(() => {})
    },

    () => {
      const handler = async (event: { payload: { source: string; error: string; cancelled?: boolean; replay?: boolean; canonicalEvent?: unknown } }) => {
      if (!isActiveSource(event.payload.source)) return
      const processCurrent = async (kernelCommitted: boolean) => {
      const { source, error } = event.payload
      if (!isActiveSource(source) || !source || event.payload.replay === true) return
      // M3：agent.reply.after（error；transform 可改错误文案）。
      const replyHook = maybeRunControllerHook('agent.reply.after', source, { message: error, payload: event.payload })
      let effectiveError = error
      if (replyHook) {
        const result = await replyHook
        if (result.blocked) return
        effectiveError = result.message ?? error
      }
      const errorContext = resolveContext(source)
      if (errorContext && !isSourceLoading(source) && !kernelCommitted) {
        persistCanonicalEvent(errorContext, { source, update: { sessionUpdate: 'error', error: effectiveError, cancelled: event.payload.cancelled === true } }, true)
      }
      dispatch({ type: 'error', source, error: effectiveError, cancelled: event.payload.cancelled === true, replay: false })
      notifyHook(event.payload.cancelled === true ? 'turn.cancelled' : 'turn.failed', source, {
        source,
        status: event.payload.cancelled === true ? 'cancelled' : 'failed',
        error: effectiveError,
        payload: event.payload,
      })
      }
      await processCommittedOrLegacy(event.payload.canonicalEvent, processCurrent)
        .catch(error => reportRuntimeError('消费 Kernel committed error event', error))
      }
      channelFrameHandlers.error = handler
      // C2：广播旧轨已拆——handler 仅由 Channel 帧入口消费。
      return Promise.resolve(() => {})
    },
  ]

  let stopFns: Array<() => void> = []
  let failedListenerFactories: Array<{ factory: () => Promise<UnlistenFn>; index: number }> = []
  void settleListeners(
    listenerFactories.map(factory => factory()),
    (reason, index) => {
      failedListenerFactories.push({ factory: listenerFactories[index], index })
      reportRuntimeError('注册聊天事件监听', reason)
    },
  ).then(result => {
    stopFns = result.fns
    return result.fns
  })

  // G1：重试注册失败的 listener；成功者并入 stopFns
  const retryListeners = async (): Promise<boolean> => {
    if (failedListenerFactories.length === 0) return false
    const pending = failedListenerFactories
    failedListenerFactories = []
    const result = await settleListeners(
      pending.map(p => p.factory()),
      (reason, index) => {
        failedListenerFactories.push(pending[index])
        reportRuntimeError('重试注册聊天事件监听', reason)
      },
    )
    stopFns.push(...result.fns)
    return result.fns.length > 0
  }

  const handleClear = () => {
    const source = currentRefs!.sessionRef.current
    const ownerId = currentRefs!.messageOwnerRef.current
    if (!source || !ownerId) return
    const session = useIdentityStore.getState().sessions.find(item => item.id === ownerId && item.source === source)
    if (!session) return
    clearMessageStorage(session.id, localStorage)
    dispatch({ type: 'clear', source })
  }
  window.addEventListener('peri:clear', handleClear)

  const handle: ChatControllerHandle = {
    retryListeners,
    requestCancel,
    sendOptimisticUser: (source, content, clientMsgId, options) => {
      if (!isActiveSource(source)) return
      // 乐观渲染也立即自动命名（与 pylon:user 确认点一致），首条消息即命名
      const store = useIdentityStore.getState()
      const session = store.sessions.find(s => s.source === source)
      if (session?.name.startsWith('session-')) {
        const autoName = content.slice(0, 30)
        useIdentityStore.getState().updateSession(session.id, { autoName, name: autoName })
      }
      // A1-c P2：乐观 user 也写 canonical；reducer 去重命中的同 clientMsgId 不再重复落盘。
      const alreadyOptimistic = runtimeAt(source)?.messages.some(
        m => m.role === 'user' && m.clientMsgId === clientMsgId,
      ) ?? false
      if (!alreadyOptimistic && options?.persistCanonical !== false) {
        const optimisticContext = resolveContext(source)
        // The optimistic row is durable even in Tauri.  The kernel may commit its own user echo
        // later; projection removes the temporary marker when that canonical row arrives.
        if (optimisticContext) {
          persistCanonicalEvent(optimisticContext, {
            source,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { text: content },
              _meta: { pylonOptimisticUser: true, requestId: clientMsgId },
            },
          })
        }
      }
      dispatch({ type: 'optimistic-user', source, content, clientMsgId })
      const next = runtimeAt(source)
      if (next?.generating) {
        const key = runtimeKey(source)
        if (key) runtimeState = { ...runtimeState, [key]: { ...next, generationFrames: resolveFrames() } }
        if (isRenderedSource(source, renderedSource())) {
          currentRefs!.setLastTokenAt(Date.now())
          currentRefs!.setGenerationPhase({ kind: 'thinking' })
        }
      }
    },
    confirmUser: (source, clientMsgId) => {
      if (!isActiveSource(source)) return
      dispatch({ type: 'confirm-user', source, clientMsgId })
    },
    rejectOptimisticUser: (source, clientMsgId) => {
      if (!isActiveSource(source)) return
      dispatch({ type: 'reject-optimistic-user', source, clientMsgId })
    },
    beginLoadLock,
    finishLoadLock,
    isSendBlockedDuringLoad,
    initSource,
    commitReplaySnapshot,
    commitCanonicalProjection,
    handleStreamFrame: async frame => {
      // B1：channel 帧 payload 与对应广播事件载荷同构；处理体逐字共用。
      const event = { payload: frame.payload as never }
      if (frame.event === 'pylon:update') {
        await channelFrameHandlers.update?.(event)
      } else if (frame.event === 'pylon:user') {
        await channelFrameHandlers.user?.(event)
      } else if (frame.event === 'pylon:done') {
        await channelFrameHandlers.done?.(event)
      } else if (frame.event === 'pylon:error') {
        await channelFrameHandlers.error?.(event)
      }
    },
    abortSessionLoad,
    clearReplay,
    getFrames,
    getTokenCount,
    getStartTime,
    subscribe: horizontal.subscribe,
    getSnapshot: horizontal.getSnapshot,
    getTasks: (source) => runtimeAt(source)?.planEntries ?? [],
    getMessages: (source) => runtimeAt(source)?.messages ?? [],
    getStreamingState: (source) => {
      const runtime = runtimeAt(source)
      return { text: runtime?.streamingText ?? '', thinking: runtime?.streamingThinking ?? '' }
    },
    getReplayMalformedEvents: () => malformedReplayEvents,
    getThinkingStart: (source) => runtimeAt(source)?.thinkingStart,
    getGenerating: (source) => runtimeAt(source)?.generating ?? false,
    getLastActivityAt: (source) => runtimeAt(source)?.lastActivityAt,
    getGenerationPhase: (source) => runtimeAt(source)?.generationPhase,
    getGenerationActivity: (source) => runtimeAt(source)?.generationActivity,
    getSummary: (source) => {
      const summary = runtimeAt(source)?.lastSummary
      return summary ? { ...summary, completedFrame: '' } : undefined
    },
    pruneSources,
    flushCanonicalEvents: () => canonicalSink.flushAll(),
    flushCanonicalEventsAsync: () => canonicalSink.flushAllAsync(),
    discardCanonicalEvents: (ownerKey) => {
      canonicalSink.discard(ownerKey)
      canonicalCursor.forget(ownerKey)
    },
    seedCanonicalCursor: (ownerKey, sequence) => canonicalCursor.seed(ownerKey, sequence),
    dispose: () => {
      canonicalSink.flushAll()
      stopFns.forEach(f => f())
      stopFns = []
      window.removeEventListener('peri:clear', handleClear)
      horizontal.dispose()
      hookSessionByKey.clear()
      canonicalSink.dispose()
      // G0：应用级 dispose 后重置单例，允许下次重新创建
      if (singletonController === handle) singletonController = null
      currentRefs = null
    },
  }
  singletonController = handle
  return handle
}
